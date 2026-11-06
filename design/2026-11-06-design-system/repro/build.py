"""Собирает repro-current.html и repro-proposed.html: статичная копия колонки беседы (пилюля субагентов, очередь,
поле ввода) на настоящем CSS из ui/src. Запуск: python3 -I build.py; снимок: см. README в DESIGN-SYSTEM.md §10."""
import pathlib

here = pathlib.Path(__file__).parent
CSS = ['styles.css', 'projects.css', 'media.css', 'files.css', 'pdf.css', 'resize.css', 'attachments.css', 'draft.css',
       'appearance.css', 'workspace.css', 'components/user-attachments.css', 'components/queue.css', 'components/dictation.css']
ic = lambda d, cls='ic': f'<svg class="{cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">{d}</svg>'
I = dict(
    drag='<path d="M3 4h10M3 8h10M3 12h10"/>', send='<path d="M2 8l12-5-4 12-2-5z"/>', x='<path d="M4 4l8 8M12 4l-8 8"/>',
    agents='<circle cx="5" cy="5" r="2"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M1.5 13v-1a3.5 3.5 0 0 1 7 0v1M10 9a3 3 0 0 1 4 3v1"/>',
    chev='<path d="M4 6l4 4 4-4"/>', gauge='<path d="M3 11a5 5 0 1 1 10 0M8 11l3-3"/>', shield='<path d="M8 2l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6V4z"/>',
    stop='<rect x="4" y="4" width="8" height="8" rx="1"/>', mic='<rect x="6" y="2" width="4" height="8" rx="2"/><path d="M4 8a4 4 0 0 0 8 0M8 12v2"/>',
)
LONG = ('Проверь ещё раз, что миграция схемы не ломает старые сессии: прогони npm test, потом открой окно на 60 сессиях '
        'и посмотри, не прыгает ли лента при подгрузке истории, а потом сравни снимки до и после')


def queue_item(n, text, proposed):
    lab = (lambda s: f'<span class="label">{s}</span>') if proposed else (lambda s: s)
    return f'''<li class="queue-item" data-testid="queue-item">
  <button type="button" class="btn btn-ghost btn-sm queue-drag-handle{' icon-only' if proposed else ''}" aria-label="Переместить реплику">{ic(I['drag'])}</button>
  <span class="n mono">{n}</span>
  <span class="queue-message"><span class="txt" title="{text}">{text}</span></span>
  <button type="button" class="btn btn-ghost btn-sm" data-testid="queue-edit" aria-label="Изменить реплику">{ic('<path d="M3 13l1-3 7-7 2 2-7 7z"/>') if proposed else ''}{lab('Изменить')}</button>
  <button type="button" class="btn btn-ghost btn-sm queue-send-now" data-testid="queue-send" aria-label="Отправить сейчас">{ic(I['send'])}{lab('Отправить сейчас')}</button>
  <button type="button" class="btn btn-ghost btn-sm{' icon-only' if proposed else ''}" data-testid="queue-remove" aria-label="Убрать из очереди">{ic(I['x'])}</button>
</li>'''


def column(width, proposed):
    full = width <= 430  # узкие колонки показывают режим full: он не должен теряться при сворачивании
    full_cls, full_txt = (' t-fail', 'full · без подтверждений') if full else ('', 'по запросу')
    return f'''<div class="frame" style="width:{width}px" data-w="{width}">
<div class="cap">колонка беседы {width} px</div>
<section class="conv" data-testid="conversation">
  <div class="feed-wrap"><div class="feed" data-testid="feed"><div class="feed-inner"><div class="it it-model"><div class="body"><div class="md"><p data-testid="msg">Ответ модели: левый край текста ленты.</p></div></div></div></div></div></div>
  <div class="subagent-track"><button type="button" class="subagent-pill" data-testid="subagents-open">{ic(I['agents'])}3 субагента</button></div>
  <div class="queue" data-testid="queue"><ol class="queue-list">
    {queue_item(1, LONG, proposed)}
    {queue_item(2, 'короткая', proposed)}
    <li class="queue-item queue-item-edit" data-testid="queue-item-edit"><span class="n mono">3</span><div class="queue-edit-body"><textarea rows="2">{LONG}</textarea></div><button type="button" class="btn btn-sm btn-primary">Сохранить</button><button type="button" class="btn btn-sm btn-ghost">Отмена</button></li>
  </ol></div>
  <div class="composer resizable-composer"><div class="box{' access-full' if full else ''}">
    <textarea rows="2" placeholder="Реплика в сессию" data-testid="composer"></textarea>
    <div class="composer-toolbar">
      <div class="chat-status"><span class="composer-preferences">
        <button type="button" class="settings model-picker" data-testid="conv-settings"><span class="provider-icon" data-provider="claude">{ic('<circle cx="8" cy="8" r="5"/>', '')}</span><span data-testid="conv-model">claude-opus-4-5-20251101</span>{ic(I['chev'])}</button>
        <button type="button" class="settings effort-picker" data-testid="conv-effort">{ic(I['gauge'])}<span>high</span>{ic(I['chev'])}</button>
        <button type="button" class="settings approval-picker" data-testid="conv-access">{ic(I['shield'])}<span class="approval{full_cls}">{full_txt}</span>{ic(I['chev'])}</button>
      </span>
      <details class="chat-info" data-testid="chat-info"><summary><svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="6.5" fill="none" stroke="var(--line)" stroke-width="2"/></svg></summary></details></div>
      <div class="composer-actions">
        <div class="dictation"><button type="button" class="btn dictation-mic" data-testid="mic">{ic(I['mic'])}</button><button type="button" class="btn dictation-options" data-testid="mic-opts">⌄</button></div>
        <button type="button" class="btn attach-picker" data-testid="attach">＋</button>
        <button type="button" class="btn btn-danger composer-stop" data-testid="stop-turn">{ic(I['stop'])}Стоп</button>
        <button type="button" class="btn btn-primary" data-testid="send">{ic(I['send'])}В очередь</button>
      </div>
    </div>
  </div></div>
</section>
<pre class="metrics"></pre>
</div>'''


MEASURE = r'''<script>
addEventListener('load', () => {
  const all = []
  for (const f of document.querySelectorAll('.frame')) {
    const q = (s) => f.querySelector(s), R = (el) => el.getBoundingClientRect()
    const box = R(q('.composer .box'))
    const x0 = box.left
    const m = { column: +f.dataset.w, boxLeft: 0, boxRight: Math.round(box.right - x0) }
    m.msgLeft = Math.round(R(q('[data-testid="msg"]')).left - x0)
    m.pillLeft = Math.round(R(q('.subagent-pill')).left - x0)
    const items = [...f.querySelectorAll('.queue-item:not(.queue-item-edit)')]
    m.editOverflowPx = [...f.querySelectorAll('.queue-item-edit')].map((li) => li.scrollWidth - li.clientWidth)
    const tb = q('.composer-toolbar')
    m.toolbarRows = new Set([...tb.querySelectorAll('button, summary')].map((b) => Math.round(R(b).top))).size
    m.toolbarOverflowPx = tb.scrollWidth - tb.clientWidth
    m.accessText = q('.approval').textContent
    m.queueLeft = Math.round(R(items[0]).left - x0)
    m.queueRight = Math.round(R(items[0]).right - x0)
    m.queueOverflowPx = items.map((li) => li.scrollWidth - li.clientWidth)
    m.queueLastChildRight = items.map((li) => Math.round(R(li.lastElementChild).right - x0))
    const ids = ['conv-settings', 'conv-effort', 'conv-access', 'mic', 'mic-opts', 'attach', 'stop-turn', 'send']
    m.toolbarHeights = Object.fromEntries(ids.map((id) => [id, Math.round(R(q(`[data-testid="${id}"]`)).height)]))
    m.toolbarHeights['chat-info'] = Math.round(R(q('.chat-info > summary')).height)
    m.queueBtnHeights = [...items[0].querySelectorAll('button')].map((b) => Math.round(R(b).height))
    f.querySelector('.metrics').textContent = JSON.stringify(m)
    all.push(m)
  }
  document.body.dataset.metrics = JSON.stringify(all)
})
</script>'''


def page(proposed):
    links = '\n'.join(f'<link rel="stylesheet" href="../../../ui/src/{c}">' for c in CSS)
    if proposed:
        links += '\n<link rel="stylesheet" href="../tokens.css">\n<link rel="stylesheet" href="proposal.css">'
    title = 'ПРЕДЛОЖЕНИЕ (PR 1)' if proposed else 'ТЕКУЩЕЕ (origin/main 862859f)'
    return f'''<!doctype html><html lang="ru" data-theme="light"><head><meta charset="utf-8"><title>{title}</title>
{links}
<style>
  html, body {{ height: auto; overflow: visible; }}
  body {{ padding: 12px; background: #E8E8E4; }}
  h1 {{ font: 600 14px var(--body); margin: 0 0 8px; }}
  .frame {{ margin: 0 0 14px; background: var(--ground); outline: 1px dashed #b99; }}
  .cap {{ font: 11px var(--mono); color: #955; padding: 2px 6px; }}
  .conv {{ display: flex; flex-direction: column; }}
  .feed-wrap {{ position: relative; }}
  .feed-inner {{ min-height: 0; padding-block: 10px; }}
  .metrics {{ font: 10px/1.35 var(--mono); white-space: pre-wrap; margin: 0; padding: 4px 6px; color: #444; background: #fff8; }}
</style></head><body>
<h1>{title}: колонка беседы на 900 / 620 / 430 / 320 px</h1>
{''.join(column(w, proposed) for w in (900, 620, 430, 320))}
{MEASURE}
</body></html>'''


(here / 'repro-current.html').write_text(page(False))
(here / 'repro-proposed.html').write_text(page(True))
print('ok')
