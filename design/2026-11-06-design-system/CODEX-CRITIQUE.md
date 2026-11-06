# Критика Codex и решения по ней

Вторая модель — Codex CLI (`codex exec`, модель `gpt-6.1-sol`, песочница read-only). Два прохода, 06.11.2026.

- **Проход 1** — атака черновика v0.1. На входе: `DESIGN-SYSTEM.md`, `tokens.css`, `AUDIT.md`, `repro/proposal.css`,
  CSS и разметка приложения. Картинки: `repro/repro-current.png`, `repro/repro-proposed.png` (v0.1) и снимок
  настоящего окна `design/2026-11-05-paseo-ui-preview/preview-A-pult-light.png`.
- **Проход 2** — сверка v0.2 с находками прохода 1. Картинка: новый `repro/repro-proposed.png`.

Ниже — решения по каждой находке, потом сырые ответы без правок.

## Решения по проходу 1

| # | Суть находки | Решение | Где в v0.2 |
|---|---|---|---|
| 1 | `.queue-item > * { flex: none }` ломает тело правки | **принято** | §8.1, `proposal.css` |
| 2 | панель ввода сворачивается по viewport, «◔» один во 2-м ряду | **принято**: группы неделимы, контейнер `composer-box`; viewport-правила удаляются в PR 1 | §11.6, §13 PR 1 |
| 3 | ящик 80 ниже затемнения 85; поповеры заперты в контекстах наложения | **принято**: scrim 80 < drawer 90, слой `--z-portal` 120, сначала порталы | §10, `tokens.css` |
| 4 | «`full` не обрезается» спорит с иконкой без подписи | **принято**: доступ всегда сохраняет текст (≥ 12ch) | §8.5, §11.3 |
| 5 | каркас окна задают `WorkspaceLayout.tsx` и `panelSizes.ts`, а не только CSS | **принято**: отдельный PR 8 вместе с моделью размеров | §7.7, §13 |
| 6 | лента меряется от скроллпорта, полоса прокрутки сдвигает край; `.parent-callout` не ребёнок `.conv` | **принято частично**: класс `.column-block` вместо общей DOM-обёртки, `scrollbar-gutter: stable both-edges`; на узкой колонке допуск — ширина полосы. Общую DOM-обёртку не берём: она перестраивает flex-колонку `.conv` ради нескольких пикселей при классической полосе | §7.2, §7.4 |
| 7 | паддинг поля ≠ отступ текста; «ручка занимает отступ» не выравнивает | **принято**: три направляющие, обязателен только внешний край; правило 3 удалено; класс колонки — на обёртку, не на рамку | §7 |
| 8 | вне контракта — черновик, временный чат, вложения, диктовка | **принято**: три поля ввода в одной спецификации, состояния диктовки | §11.6 |
| 9 | сайдбар, Inbox, меню, вкладки, баннеры — свои приоритеты переполнения | **принято**: таблица приоритетов, правило для смешанного содержимого | §8.10, §11.9 |
| 10 | внутреннее кольцо исчезает на залитой кнопке; `outline: none` у textarea | **принято**: на залитых кольцо всегда внешнее; textarea — санкционированное исключение с рамкой `--accent` | §9 |
| 11 | проверки вычисленного `--ink` мало; слой проигрывает правилам без слоя | **принято**: владение объявлениями, удаление в том же PR, цвета по отрисовке, тема против системной | §1, §12.3, §13 |
| 12 | 1.13 : 1 ещё не доказывает неразличимость `--faint` | **принято**: `--faint` сохранён (CANDIDATE), слияние — по снимкам | §2, `tokens.css` |
| 13 | «почти без изменений» неверно: альфа diff и геометрия тёмной тени | **принято**: PR 3 — строгий паритет; diff-заливки и тёмная тень вернулись к прежним значениям | §1, `tokens.css` |
| 14 | база 20 не учтена; фиксированная высота не держит крупный шрифт | **принято**: высоты контролов вычисляются от `--text-sm` (24/28/32 при 14, 30/34/38 при 20). **Отклонено** «высота по содержимому, где нужно» для однострочных контролов в ряду: тогда правило одной высоты снова теряется. Исключение — только многострочные | §3, §6 |
| 15 | `pointer: coarse` описывает лишь основной указатель | **принято**: сенсорные размеры убраны из черновика | §6, `tokens.css` |
| 16 | правила противоречат себе: 6 px между блоками, радиус 16 − 12, высота строки 32 | **принято частично**: между блоками 8, радиус — ориентир, высота строки 34 с расчётом. **Отклонено** «не гнаться за числовой чистотой»: запрет полушагов между блоками сохраняется, иначе шкала снова расползётся | §4, §5, §7.6, §11.5 |
| 17 | `repro/` не покрывает `.feed`, шрифты, вложения, правку, 320 px | **принято частично**: в `repro/` добавлены `.feed`, строка в правке, `full` и 320 px. Доказательство — e2e на настоящих компонентах с матрицей ширин, шрифтов и режимов. `repro/` остаётся иллюстрацией | §12.1, §14 |
| 18 | `elementFromPoint` попадает в SVG; суммарные счётчики пропускают подмену | **принято**: `button.contains(hit)`; храповик по списку конкретных мест | §12 |
| 19 | превью PR 1 меняет фокус и радиусы, а план откладывает их | **принято**: из `proposal.css` убраны фокус и радиус; чистка — в каждом PR, храповик — вторым PR | §13, `proposal.css` |
| 20 | неточности в аудите: действующее кольцо — сплошной акцент; 11 импортов в `main.tsx`; `queue.css` при 700 только уменьшает кегль; WCAG 2.4.11 — про перекрытие фокуса | **принято**, аудит исправлен. Находка про кольцо 1.89 : 1 переформулирована: раннее правило — мёртвый код | `AUDIT.md` §1–3, §9 |

## Решения по проходу 2

Codex признал закрытыми 1, 5, 9, 11, 13, 15, 20; остальные — частично. Что сделано после прохода 2:

- **2, 4** — в PR 1 явно удаляются viewport-правила `≤ 760 / 700 px` для поля и очереди, которые прятали подпись доступа (§13).
- **3** — добавлен слой `--z-portal` 120 над диалогами для меню, вынесенных порталом (§10).
- **7** — класс колонки ставится на обёртку, паддинг рамки сохраняется (§7.2).
- **10** — рамка поля в фокусе: сплошной `--accent` 5.81 : 1 вместо `--accent-edge` 1.89 : 1 (§9).
- **12** — формулировка аудита про `--faint` смягчена: решают снимки.
- **14** — текст исправлен: при базе 12 совпадают три ступени, а не две.
- **16** — комментарий о радиусе в `tokens.css` переписан как ориентир.
- **18** — ключ записи храповика: `файл · селектор · свойство · значение · №`.
- Новая находка про снимок, обрезанный на 1700 px, — снимки пересняты в высоту 2300 px.

**Оставлено открытым** (осознанно, вне черновика):
- **6** — на узкой колонке при классической полосе прокрутки допускается расхождение на её ширину.
  Выровнять точно можно только замером в JS, а в macOS по умолчанию полоса накладывается поверх и места не занимает.
- **8** — полная спецификация AttachmentStrip и бюджеты роста по высоте — v0.3.
- **17** — доказательство на настоящих компонентах появится в PR 1, черновик его не даёт.
- **19** — `repro-proposed.html` берёт имена из `tokens.css`. В PR 1 те же значения станут локальными переменными;
  на результат замеров это не влияет.
- На колонке 320 px подпись модели сжимается до «c…», пока доступ держит 12ch. Минимальную ширину подписи модели
  (около 6ch) стоит задать в PR 1.

## Сырой ответ, проход 1

1. [severity: high] PR 1, `repro/proposal.css:27` — `.queue-item > * { flex: none }` overrides `.queue-edit-body { flex: 1 }`, recreating overflow during editing — Restrict fixed sizing to buttons/numbers; explicitly preserve flexible message **and editor** bodies.

2. [severity: high] PR 1, `proposal.css:38–55` — Toolbar heights change, but responsive behavior remains viewport-based. `.chat-status` still inherits `flex-wrap: wrap` (`styles.css:385`); the information indicator remains stranded in the proposed 620px image — Implement the promised container-based sizing and indivisible settings/actions groups.

3. [severity: high] DESIGN-SYSTEM §10 — Drawer 80 sits **below scrim 85**. Popover 40 also cannot reliably escape isolated components to appear above drawers/dialogs — Put scrims below their associated surface; define overlay ownership, portal placement, and stacking contexts before renumbering.

4. [severity: high] §§8.5/11.3 — “Never truncate `full`” contradicts hiding the access label below 600px. Generic shield plus danger color does not identify the selected permission mode — Preserve a compact textual access value. Define separate collapse rules for permission actions, where scope must remain understandable.

5. [severity: high] §7/PR 6 — Shell sizing is controlled by `WorkspaceLayout.tsx:37–42` and `model/panelSizes.ts:17–21`, including inline grid columns and the 1050 breakpoint. CSS breakpoint cleanup alone cannot implement the proposal — Update the sizing model alongside CSS; cover saved widths, Files, Inbox, Expanded, and the 64px Focus rail.

6. [severity: med] §7 — Equal formulas do not guarantee equal coordinates: `.feed-inner` measures against the scrollport, while the composer measures against `.conv`. Classic scrollbars change available width. `.parent-callout` is actually inside `.subagent-view` — Share a column wrapper/utility across nested hosts and explicitly reconcile scrollbar space.

7. [severity: med] §7.3 — Composer padding is not its text inset: `workspace.css:88` adds textarea padding and the box adds a border. “Handle occupies that inset” cannot align queue text after handle, number, and gaps — Define distinct outer, content, and text alignment guides; avoid removing component padding through blanket column rules.

8. [severity: high] §11.8 — Deferral leaves parallel composers (`draft.css`, temporary chat), attachments, recording/transcribing notices, background counts, and legacy footer fallbacks outside the contract — Specify their width budgets, loading/error states, and vertical growth before global control migration.

9. [severity: med] §11.8 — Sidebar rows, Inbox filters/cards, permission forms, menus, tabs, and banners need different overflow priorities. Subagent tabs mix text nodes and icons, so generic ellipsis is insufficient — Give each an explicit shrinkable label region, protected metadata, and narrow-layout behavior.

10. [severity: high] §9/`proposal.css:58–59` — An inset accent outline disappears against the accent-filled Send button. Existing `.composer textarea { outline: none }` also outranks the generic replacement — Add component-specific focus rules and contrasting/two-color rings; verify focused controls visually.

11. [severity: med] §§1/13 — The palette-removal warning is correct, but testing computed `--ink` alone misses native controls, foreground overrides, and residual selectors. Unlayered normal declarations outrank layered ones. [Cascade rules](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@layer) — Establish declaration ownership now; test rendered colors with explicit themes opposing OS preference.

12. [severity: med] §2 — A 1.13:1 comparison does not establish that tertiary and secondary text are indistinguishable. Global aliasing changes hierarchy across 96 uses — Preserve the tertiary role initially; assess representative surfaces before consolidation.

13. [severity: med] `tokens.css:93–115`/PR 2 — “Almost no visual changes” misses altered diff-fill opacity and dark shadow geometry, beyond acknowledged surface aliases — Separate exact token extraction from visual changes; maintain a value-parity checklist.

14. [severity: med] §§3/6 — At base 12, three text tiers collapse to 10px; supported base **20** is omitted from the proposal’s range/tests (`appearance.ts:21`). Fixed heights, `line-height: 1`, and “no exceptions” ignore alternate font metrics — Validate 12–20 and every font; allow content-driven heights where necessary.

15. [severity: med] §6/`tokens.css:212` — `pointer: coarse` changes control widths and layout budgets without adapting breakpoints; it also describes the primary pointer, not every input on hybrid devices — Treat touch sizing as a tested density/input policy, with separate visual and hit-target dimensions.

16. [severity: low] §§4/5/11.5 — Rules contradict themselves: 6px between column blocks violates the half-step restriction; nested radius 16−12 gives 4, yet specifies 6; bordered queue rows require 34px, not 32 — Document deliberate exceptions and border-box arithmetic instead of enforcing numerical purity.

17. [severity: high] §12/`repro/build.py` — The reproduction omits `.feed`, bundled font-face declarations, resize handles, attachments, editing, and Codex speed/steer combinations. Tests stop at 430 although the sizing model permits 320 — Test mounted production components at minimum widths, breakpoint boundaries, large fonts, short windows, and active/error states.

18. [severity: med] §12 — `elementFromPoint(...) === button` fails when an SVG child receives the hit; aggregate literal counts allow new violations to replace deleted ones — Use `button.contains(hit)`, inspect bounds and focus visibility, and ratchet an occurrence-level allowlist with parsed declarations.

19. [severity: med] §13 — PR 1’s preview imports all tokens and changes global focus/radius, while its delivery plan promises local variables and defers focus. Cleanup comes after multiple overlapping migrations — Make preview match the actual patch; remove superseded component rules during each migration and enable enforcement before subsequent PRs.

20. [severity: low] AUDIT §§1–3 — Several claims are incorrect: the global ring already uses solid accent (`styles.css:869`); `queue.css` at 700 only reduces font/padding; `main.tsx` imports 11 stylesheets; Electron 45.2.3 uses Chromium 156, not 142. [Electron release](https://releases.electronjs.org/release/v45.2.3) — Re-audit the resolved cascade; correct WCAG 2.4.11, which concerns [focus obstruction](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum).

Things you agree with:

- Fixing the direct flex child’s minimum width.
- Container-based component responsiveness.
- Retaining established semantic names such as `--ink` and `--mut`.
- Separating provider identity from status.
- Small migration PRs backed by geometry assertions.

## Сырой ответ, проход 2

References below use v0.2 [DS](design/2026-11-06-design-system/DESIGN-SYSTEM.md) and [AUDIT](design/2026-11-06-design-system/AUDIT.md).

1. RESOLVED — DS §8.1; `proposal.css:28–30` preserves flexible message and editor bodies.
2. PARTIAL — DS §11.6 adds container queries and indivisible groups; legacy viewport overrides still apply.
3. PARTIAL — DS §10 fixes scrim ordering; body portals at z40 remain below drawers/dialogs at z90/100.
4. PARTIAL — DS §§8.5/11.3 preserves access text conceptually; inherited ≤760px rules still hide it.
5. RESOLVED — DS §7.7/§13 PR8 includes the sizing model and saved widths; §12 covers modes/Files.
6. PARTIAL — DS §7.4 centers the scrollport but tolerates unequal edges instead of reconciling available width.
7. PARTIAL — DS §7 distinguishes guides; §7.1–2 still forbids horizontal padding on directly classified draft/temporary boxes.
8. PARTIAL — DS §11.6 expands coverage; §11.8 still defers attachments, with incomplete growth budgets and footer fallbacks.
9. RESOLVED — DS §§8.10/11.8 specifies mixed-content label wrappers, protected metadata, and component-specific overflow priorities.
10. PARTIAL — DS §9 fixes filled-button rings; its textarea exception retains low-contrast `accent-edge`/`accent-soft` focus.
11. RESOLVED — DS §§1/12/13 establishes declaration ownership, immediate cleanup, and rendered-color tests against OS preference.
12. PARTIAL — DS §2 preserves `--faint`; AUDIT §3 still claims indistinguishability from contrast ratios alone.
13. RESOLVED — DS §§1/2/13 separates parity from visual changes; diff opacity and dark-shadow geometry are restored.
14. PARTIAL — DS §§3/6 includes 20px/fonts; three tiers still become 10px at base 12, despite claiming two.
15. RESOLVED — DS §6 removes automatic coarse-pointer sizing and explicitly defers touch density policy.
16. PARTIAL — DS §§5/7/11.5 corrects exceptions/arithmetic; `tokens.css:176` retains the contradictory strict radius formula.
17. PARTIAL — DS §§12/14 adds 320/editing and a production matrix; mounted evidence, short windows, errors, and 420/520 boundaries remain absent.
18. PARTIAL — DS §12 fixes SVG hit-testing; allowlist keys cannot distinguish repeated selector/property occurrences.
19. PARTIAL — DS §13 fixes cleanup/enforcement order; `build.py:101` still imports all tokens into the PR1 preview.
20. RESOLVED — AUDIT §§1–3 corrects cascade/import claims; DS §9 correctly distinguishes [focus obstruction](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum).

New:

- **[med]** DS §14’s 1700px screenshot cuts off the new 320px queue, composer, and metrics. Capture full height or separate frames.