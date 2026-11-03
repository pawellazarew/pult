import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { createLogger } from '../dist/core/log.js'
import { createDiskMonitor } from '../dist/core/disk.js'

it('журнал ротируется во время работы и сохраняет ограниченное число валидных JSONL файлов', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pult-log-'))
  try {
    const file = join(dir, 'pultd.log')
    writeFileSync(file, 'старый журнал\n'.repeat(100))
    const log = createLogger(file, { maxBytes: 256, backups: 2 })
    for (let i = 0; i < 30; i++) log.info(`entry ${i}`, { token: 'sensitive-value' })
    log.info('x'.repeat(1024))
    log.close()
    log.info('after close')
    const files = readdirSync(dir)
    assert.deepEqual(files.sort(), ['pultd.log', 'pultd.log.1', 'pultd.log.2'])
    for (const f of files) {
      assert.ok(statSync(join(dir, f)).size <= 256)
      const text = readFileSync(join(dir, f), 'utf8')
      assert.ok(!text.includes('sensitive-value'))
      assert.ok(!text.includes('after close'))
      for (const line of text.trim().split('\n')) JSON.parse(line)
    }
    assert.match(readFileSync(file, 'utf8'), /truncated/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('проверка диска предупреждает один раз до восстановления и допускает ошибку statfs', () => {
  const records: string[] = []
  let bytes = 10
  const log = { log() {}, debug() {}, error() {}, close() {}, warn: (s: string) => records.push(s), info: (s: string) => records.push(s) } as ReturnType<typeof createLogger>
  const check = createDiskMonitor('/', log, { thresholdBytes: 100, availableBytes: () => { if (bytes < 0) throw new Error('statfs'); return bytes } })
  check(); check()
  assert.equal(records.length, 1)
  bytes = -1; check()
  assert.equal(records.length, 1)
  bytes = 200; check()
  bytes = 5; check()
  assert.equal(records.length, 3)
})
