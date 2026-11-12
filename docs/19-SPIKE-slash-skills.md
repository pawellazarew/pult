# 19. Спайк: «/» в поле ввода — скиллы и команды чата

Задача: набрал `/` в поле ввода — над полем список скиллов и команд, которые для провайдера и папки этого чата
видят харнесс и модель, как в Claude Code, Codex CLI и Paseo. Ниже — что измерено 06.11.2026 (Claude Code 2.1.318,
codex-cli 0.166.0-alpha.6) на пустой папке `/tmp/pult-slash` с тестовыми скиллами и на папке владельца с 118 скиллами,
и как это легло в код.

## Claude

**Список до первого хода.** `claude -p --input-format stream-json --output-format stream-json --verbose` принимает
управляющий запрос `{"type":"control_request","request_id":…,"request":{"subtype":"initialize"}}` и отвечает
`control_response` со списком `commands`: `name`, `description`, `argumentHint`, у встроенных `builtin: true`, у части
`aliases`. Модель не вызывается, токенов ноль, ответ за 1,2–3,9 с (87 команд в пустой папке, 174 — в папке
владельца). Файл разговора в `~/.claude/projects` не заводится. С `--strict-mcp-config` без `--mcp-config` и
`--permission-prompts none` ответ тот же — серверы MCP владельца ради списка не поднимаются.

Что в ответе:

- скиллы пользователя, папки и плагинов; у скилла с `disable-model-invocation: true` (`summary`, `teach`, `grill-me`)
  строка есть — вручную их звать можно;
- команды из `.claude/commands/*.md` — без отличия от скиллов: и у тех и у других описание кончается на `(project)`
  или `(user)`. Отличить можно по файлу в `.claude/commands`;
- команды плагинов (`engineering:debug`) — описание начинается с `(engineering)`;
- встроенные (`compact`, `context`, `usage`, `clear`…) — `builtin: true`;
- скиллы claude.ai — без префикса (`pdf`), а в `system/init` те же имена идут как `anthropic-skills:pdf`.

**`system/init` каждого хода** несёт только имена: `slash_commands`, `skills` и `terminal_slash_commands`
(`doctor`, `color`, `focus`, `reload-plugins`). Описаний нет — поэтому список снимается через `initialize`, а `init`
лишь сверяет его.

**Что исполняется в `-p` / stream-json** (реплика `/имя аргументы`):

| Команда | Итог |
|---|---|
| скилл `/hello-pult abc` | тело скилла развёрнуто CLI, ответ из него |
| команда `.claude/commands` `/pult-cmd xyz` | `$ARGUMENTS` подставлен, ответ из неё |
| `/compact` | `status: compacting` → `compact_boundary`, работает |
| `/context`, `/usage` (`/cost`), `/mcp`, `/config`, `/import` | ответ текстом, `num_turns: 0` (кроме `/import`) |
| `/clear` | `conversation_reset` и **новый** `session_id` — Пульт возобновлял бы старый разговор |
| `/focus` | «isn't available here yet» |
| `/color red` | работает, но смысл только в терминале |
| `/model sonnet` | «for this session only» — спорит с моделью из подвала |
| `/heapdump` | пишет снимок кучи на Рабочий стол |
| `/rename x` | `session_title_changed` — имя чата держит Пульт |

**Скрыты в Пульте:** `clear` (`reset`, `new`), `focus`, `color`, `doctor`, `reload-plugins` и всё из
`terminal_slash_commands`, `model`, `effort`, `fast`, `rename`, `output-style`, `heapdump`, `auto-mode-setup`,
`usage-credits`, `extra-usage`, `workflow-launch-exec`, имена на `__`, а также строки с описанием «(removed)» и
«Renamed to». Список — `CLAUDE_HIDDEN` в `src/commands/catalog.ts`.

**Грабля: второй текстовый блок.** Пульт добавляет к каждой реплике Claude блок с контекстом режима доступа. С ним CLI
команду **не разворачивает**: `/context` уходит модели простым текстом, а скилл модель зовёт сама инструментом `Skill`.
Поэтому реплика, которая начинается с `/имя` и идёт без вложений, отправляется одним блоком, без контекста режима
(`isSlashCommandTurn`, `src/adapters/claude/argv.ts`). Проверено в окне на настоящем CLI: `/hello-pult abc` — ответ
из тела скилла без вызова `Skill`, `/context` — таблица расхода контекста.

**`/имя` посреди текста** (`Please do this: /hello-pult abc`) CLI не разворачивает, но модель зовёт скилл сама
(`Skill {"skill":"hello-pult"}`). Для скиллов с `disable-model-invocation` так не выйдет, для встроенных — тоже.
Поэтому посреди текста список показывает только скиллы.

## Codex

app-server (`codex app-server generate-ts`) отдаёт скиллы методом `skills/list {cwds, forceReload?}` →
`{data: [{cwd, skills: [{name, description, shortDescription?, interface?, path, scope, enabled, pluginId}], errors}]}`.
`scope` — `user | repo | system | admin`. Папки: `<repo>/.agents/skills`, `~/.agents/skills`, `~/.codex/skills`
(`.system`), кэш плагинов `~/.codex/plugins/cache`. Есть уведомление `skills/changed` — сигнал перечитать список.
Метода со списком «/»-команд TUI (`/compact`, `/review`, `/init`) нет: у app-server для этого отдельные методы
(`thread/compact/start`, `review/start`), а текстом `/compact` уходит модели. Поэтому у Codex в списке только скиллы.

**Как вызывается скилл** (реплика с тестовым скиллом, ответ которого есть только в теле `SKILL.md`):

| Ввод | Итог |
|---|---|
| текст `$codex-hello abc` | ответ из тела скилла, файл не читался — сервер вложил тело сам |
| текст + элемент `{type: "skill", name, path}` | то же |
| текст `/codex-hello qqq` | модель догадалась и прочла `SKILL.md` через shell — медленнее и требует чтения файлов |

Пульт вставляет `$имя ` — это работает без новых полей в реплике и в очереди.

## Paseo (0.15.1, бандл приложения)

- Триггер — `/` в начале или после пробела; запрос — от `/` до каретки без пробелов и кавычек (`findActiveSlashCommand`).
- В начале реплики видны все команды; посреди текста — только скиллы провайдера (`filterInlineSkillCommandEntries`).
- Ранжирование — по имени и алиасам ступенями: точное, слово целиком, начало, начало слова, подстрока, подпоследовательность;
  при равенстве — по имени. Пустой запрос — исходный порядок.
- Строка: `/name`, подсказка аргументов, описание. Список у демона (`list_commands_request` по агенту, у черновика — по
  настройкам), вид `command | skill`. Свои команды клиента (`/exit`, `/clear` — архив агента и новый черновик)
  исполняются в окне.
- Выбор подставляет `/name` и пробел, если команда в конце текста.

Пульт взял то же поведение и добавил поиск по описанию нижними ступенями.

## Как устроено

- `src/commands/catalog.ts` — разбор `initialize` и `skills/list`, сверка с `init`, кэш по
  `(провайдер, папка, --setting-sources)`: 10 минут, одновременные запросы — один снимок, ошибка — прежний список с
  текстом. Codex `skills/changed` сбрасывает кэш Codex.
- `src/commands/claudeProbe.ts` — короткий процесс `claude` с `initialize`, через страж сети (как автоназвание).
- Codex — `listSkills` адаптера: живой общий app-server, иначе страж сети и подъём процесса, как перед ходом.
- Метод демона `agent.commands {name}` (чат) или `{provider, cwd}` (черновик проекта) или `{provider, scope: "general"}` (общий черновик без проекта; каталог из нейтральной папки разговоров, сессия не создаётся), `force` — снять заново. В белом
  списке моста (`shell/src/contract.ts`). Старая оболочка отвечает `method_not_allowed` — список говорит «после
  обновления Pult».
- Окно: `ui/src/model/slash.ts` (где набирается команда, отбор, подстановка), `ui/src/components/SlashMenu.tsx`
  (список и `useSlashMenu`), `slash.css`. ↑↓ — выбор, Enter/Tab — вставить, Esc — закрыть, мышь — наведение и щелчок.
  Пустой результат — слова, Enter тогда отправляет набранное как есть.

## Чего нет

- Черновик нового чата (`Draft.tsx`) списка пока не показывает; метод демона для него готов (`{provider, cwd}`).
- Встроенные команды Codex TUI — нет способа вызвать их текстом.
- Скилл и команда `.claude/commands` из глобальной папки плагина различаются только по файлу в
  `<папка>/.claude/commands` и `~/.claude/commands`.
- ZCode списка не даёт.
