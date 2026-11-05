import { t } from './i18n.js'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile, open } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SpeechStatus } from './contract.js'

const MODEL_BYTES = 147951465
const MODEL_HASH = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin'
export const MAX_SPEECH_SECONDS = 120

/** Only canonical mono PCM16 / 16 kHz WAV produced by the recorder crosses IPC. */
export function speechWav(raw: unknown): Buffer {
  if (!(raw instanceof Uint8Array)) throw new Error(t('Некорректная запись'))
  const b = Buffer.from(raw)
  if (b.length < 3244 || b.length > 44 + 32000 * MAX_SPEECH_SECONDS || b.length % 2 !== 0
    || b.toString('ascii', 0, 4) !== 'RIFF' || b.readUInt32LE(4) !== b.length - 8
    || b.toString('ascii', 8, 16) !== 'WAVEfmt ' || b.readUInt32LE(16) !== 16
    || b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1 || b.readUInt32LE(24) !== 16000
    || b.readUInt32LE(28) !== 32000 || b.readUInt16LE(32) !== 2 || b.readUInt16LE(34) !== 16
    || b.toString('ascii', 36, 40) !== 'data' || b.readUInt32LE(40) !== b.length - 44) throw new Error(t('Нужна запись PCM16, mono, 16 kHz, от 0,1 до 120 секунд'))
  return b
}
async function checksum(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Local-only speech service. Renderer chooses neither executable nor file paths. */
export class LocalSpeech {
  private ready: Promise<boolean> | null = null
  private installing: Promise<void> | null = null
  private received = 0
  private job: AbortController | null = null
  private download: AbortController | null = null
  private readonly model: string
  constructor(private readonly binary: string, private readonly directory: string) { this.model = join(directory, 'ggml-base.bin') }
  async status(): Promise<SpeechStatus> {
    this.ready ??= stat(this.model).then(async (s) => s.size === MODEL_BYTES && await checksum(this.model) === MODEL_HASH).catch(() => false)
    return { runtime: existsSync(this.binary), ready: await this.ready, downloading: this.installing !== null, received: this.received, total: MODEL_BYTES }
  }
  async install(): Promise<void> {
    if (!existsSync(this.binary)) throw new Error(t('В этой сборке нет распознавания. Обнови приложение Пульта.'))
    if (this.installing) return this.installing
    if ((await this.status()).ready) return
    // Recheck after awaiting status: two windows must not write the same partial file.
    if (this.installing) return this.installing
    this.installing = this.downloadModel().finally(() => { this.installing = null; this.download = null })
    return this.installing
  }
  private async downloadModel(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const part = `${this.model}.part`
    this.received = 0
    const controller = new AbortController()
    this.download = controller
    const timeout = setTimeout(() => controller.abort(), 15 * 60_000)
    try {
      const response = await fetch(MODEL_URL, { signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(t`Скачивание модели: HTTP ${response.status}`)
      const hash = createHash('sha256')
      const file = await open(part, 'w', 0o600)
      try {
        const reader = response.body.getReader()
        while (true) {
          const { done, value: chunk } = await reader.read()
          if (done) break
          this.received += chunk.length
          if (this.received > MODEL_BYTES) throw new Error(t('Размер модели не совпал'))
          hash.update(chunk)
          await file.writeFile(chunk)
        }
      } finally { await file.close() }
      if (this.received !== MODEL_BYTES || hash.digest('hex') !== MODEL_HASH) throw new Error(t('Проверка модели не прошла. Скачай её ещё раз.'))
      await rename(part, this.model)
      await chmod(this.model, 0o600)
      this.ready = Promise.resolve(true)
    } finally { clearTimeout(timeout); await rm(part, { force: true }) }
  }
  cancel(): void { this.job?.abort() }
  close(): void { this.cancel(); this.download?.abort() }
  async transcribe(raw: unknown, language: unknown): Promise<string> {
    const wav = speechWav(raw)
    if (language !== 'ru' && language !== 'en' && language !== 'auto') throw new Error(t('Неизвестный язык диктовки'))
    if (this.job) throw new Error(t('Предыдущая запись ещё распознаётся'))
    if (!(await this.status()).ready || !existsSync(this.binary)) throw new Error(t('Сначала скачай модель диктовки'))
    if (this.job) throw new Error(t('Предыдущая запись ещё распознаётся'))
    const controller = new AbortController()
    this.job = controller
    let dir: string | undefined
    try {
      dir = await mkdtemp(join(tmpdir(), 'pult-speech-'))
      const input = join(dir, 'recording.wav')
      await writeFile(input, wav, { mode: 0o600 })
      const output = join(dir, 'transcript')
      await new Promise<void>((resolve, reject) => {
        execFile(this.binary, ['-m', this.model, '-f', input, '-l', language, '-t', '4', '-otxt', '-of', output, '-np', '-nt'],
          { timeout: 180_000, maxBuffer: 512 * 1024, signal: controller.signal, cwd: dir }, (error) => error ? reject(new Error(controller.signal.aborted ? t('Диктовка отменена') : t('Не удалось распознать запись. Попробуй ещё раз.'))) : resolve())
      })
      return (await readFile(`${output}.txt`, 'utf8')).trim().slice(0, 32_000)
    } finally { this.job = null; if (dir) await rm(dir, { recursive: true, force: true }) }
  }
}
