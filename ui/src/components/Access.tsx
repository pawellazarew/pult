// Быстрый старт, шаг A: диалог согласия на полный доступ (один раз на всех провайдеров, кадр 04) и раздел
// «Настройки → Доступ» (отзыв). Текст сверен с кодом: Claude — src/adapters/claude/argv.ts (`bypassPermissions`,
// правила Пульта на PULT_HOME/run), Codex — `codexThreadPolicy` (`danger-full-access` + `never`; вопрос, который Codex
// всё же задаст, адаптер отдаёт брокеру — в Inbox, сам не разрешает), ZCode — src/adapters/zcode/argv.ts (`--mode yolo`;
// канала вопросов у маршрута A нет, режим в потоке CLI не называет), браузер — src/mcp/browser.ts
// `approvalBrowserRefusal` (выключается только встроенный браузер Пульта; свои MCP-серверы и shell — нет).

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Icon, Kbd } from './common.js'
import { consentLine } from '../model/access.js'
import type { ConsentView } from '../model/access.js'

export function ConsentDialog({ onGrant, onKeep, busy = false, error = null }: {
  /** «Разрешить полный доступ»: окно зовёт `access.grantFull`; ответ демона — в `error`. */
  onGrant(): void
  /** «Оставить как было» (и Esc, и клик мимо): уровень не меняется. */
  onKeep(): void
  busy?: boolean
  error?: string | null
}): ReactElement {
  const keep = useRef<HTMLButtonElement>(null)
  // Фокус — на «Оставить как было»: поток «⌘N, текст, ↵» не должен давать полный доступ случайным Enter (§3.6).
  useEffect(() => { keep.current?.focus() }, [])
  // Esc — «Оставить как было», и только он: диалог может стоять поверх «Новой сессии», а горячие клавиши окна закрыли
  // бы Esc-ом её целиком. Захват на window — раньше обработчиков окна и React.
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      onKeep()
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [onKeep])
  return (
    <div className="scrim scrim-top" onMouseDown={(e) => { if (e.target === e.currentTarget) onKeep() }}>
      <div className="dlg consent" role="alertdialog" aria-modal="true" aria-labelledby="consent-h" aria-describedby="consent-lead" data-testid="consent-dialog">
        <div className="dlg-h"><span className="consent-icon" aria-hidden="true"><Icon name="shield" /></span><h2 id="consent-h">Полный доступ: Claude, Codex и ZCode</h2></div>
        <div className="dlg-b">
          <p id="consent-lead" className="consent-lead">Агент перестаёт спрашивать разрешения: правит и удаляет файлы где угодно, ставит пакеты, ходит в сеть
            и запускает команды с твоими правами на этом Mac. Песочницы нет.</p>
          <dl className="consent-prov">
            <dt className="who-claude">Claude</dt>
            <dd><code>bypassPermissions</code>. Спросит или откажет только по твоим правилам ask/deny в настройках Claude и по собственным
              проверкам Claude. Папку с ключами Пульта агент не читает ни в каком режиме.</dd>
            <dt className="who-codex">Codex</dt>
            <dd><code>danger-full-access</code> + <code>never</code>: песочницы нет, разрешений не просит. Если Codex всё же потребует
              подтверждение (например, для части MCP-вызовов), Пульт его сам не даст — оно придёт в Inbox.</dd>
            <dt className="who-zcode">ZCode</dt>
            <dd><code>--mode yolo</code>: что угодно без вопросов. Вопросов в Inbox у ZCode нет вовсе, а свой режим он не сообщает —
              метка у его чата «не подтверждено».</dd>
          </dl>
          <ul className="consent-list">
            <li>Встроенный браузер Пульта в этом режиме выключен. Твои MCP-серверы и shell — нет.</li>
            <li>Разрешение одно на всех провайдеров. Дальше не спрашиваю: чаты с полным доступом помечены красным.</li>
            <li>Сам он не включается: ссылка <span className="mono">pult://new</span> его не даёт — только твой выбор.</li>
            <li>Вернуть — другой доступ в меню чата, со следующего хода. Отозвать разрешение — Настройки → Доступ.</li>
          </ul>
          {error && <span className="err" role="alert" data-testid="consent-error">{error}</span>}
        </div>
        <div className="dlg-f">
          <span className="note">Спрашиваю один раз</span>
          <span className="grow" />
          <button ref={keep} type="button" className="btn" onClick={onKeep} data-testid="consent-keep">Оставить как было <Kbd>Esc</Kbd></button>
          <button type="button" className="btn btn-danger" onClick={onGrant} disabled={busy} data-testid="consent-grant">
            {busy ? 'Записываю…' : 'Разрешить полный доступ'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** «Настройки → Доступ»: согласие на полный доступ словами и «Отозвать» (действует сразу, мимо «Сохранить»). */
export function AccessSection({ consent, onRevoke }: {
  consent: ConsentView | null
  /** `null` — отозвано; строка — отказ демона. */
  onRevoke(): Promise<string | null>
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const revoke = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setErr(null)
    const e = await onRevoke()
    setBusy(false)
    if (e) setErr(e)
  }
  return (
    <section className="settings-sec" aria-labelledby="settings-access-h" data-testid="settings-access">
      <h3 id="settings-access-h">Доступ</h3>
      <div className="upd-state">
        <span className="grow" data-testid="access-consent-line">{consentLine(consent)}</span>
        {consent?.granted && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void revoke()} data-testid="access-revoke">
          {busy ? 'Отзываю…' : 'Отозвать'}</button>}
      </div>
      <span className="note">Одно разрешение на Claude, Codex и ZCode; его проверяет демон на каждом ходу. После отзыва идущий ход доживает с красной
        меткой, следующий ход любой сессии с полным доступом идёт в «Спрашивать». Разовое <span className="mono">--yes</span> из терминала
        действует только на свою сессию и сюда не пишется.</span>
      {err && <span className="err" role="alert" data-testid="access-error">{err}</span>}
    </section>
  )
}
