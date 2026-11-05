import { t } from '../lib/i18n.js'
/** Canonical WAV for whisper.cpp; clipping and channel mixing happen before encoding. */
export function pcmWav(channels: readonly Float32Array[]): Uint8Array {
  const length = channels[0]?.length ?? 0
  if (!channels.length || channels.some((c) => c.length !== length) || length > 16000 * 120) throw new Error(t('Некорректная длина записи'))
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, s: string): void => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, length * 2, true)
  for (let i = 0; i < length; i++) {
    let sample = 0
    for (const channel of channels) sample += channel[i] / channels.length
    sample = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0))
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
  }
  return new Uint8Array(buffer)
}
export function chooseMicrophone(devices: readonly { deviceId: string; label: string }[], preferred: string, never: string): string | null {
  const exact = devices.find((d) => d.label === preferred)
  if (exact) return exact.deviceId
  const fragments = never.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const allowed = devices.filter((d) => !fragments.some((f) => d.label.toLowerCase().includes(f)))
  // With exclusions, do not silently fall back to a forbidden system device.
  if (fragments.length) return (allowed.find((d) => d.deviceId !== 'default') ?? allowed[0])?.deviceId ?? null
  return 'default'
}
export function appendDictation(draft: string, spoken: string): string {
  return draft + (draft && !/\s$/.test(draft) ? ' ' : '') + spoken.trim()
}
