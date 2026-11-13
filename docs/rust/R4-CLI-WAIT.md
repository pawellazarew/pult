# R4: private agent wait CLI composition

Этот slice готовит CLI protocol-1 composition и форматирование. **Backend `agent.wait`
ещё не квалифицирован:** команда скрыта из обычной help, public catalog/capabilities
остаются без изменений. Успех fake-daemon теста не означает, что установленный daemon
поддерживает wait. Не меняются daemon, State, Driver, Runtime, Worker и service/cutover.

Приватные preview-вызовы для последующей backend qualification:

```sh
pultd-rust --home /absolute/private-scratch agent wait chat --until idle,blocked,done --timeout 600000 --json
pultd-rust --home /absolute/private-scratch session wait chat
pultd-rust --home /absolute/private-scratch agent prompt chat 'task' --wait --json
```

## CLI contract

Параметры `agent.wait` — только `{name, until?, timeoutMs?}`. `--until` делится по
запятым, очищается ECMAScript trim; пустые элементы убираются, пустой список не
отправляется. Регистр, повторы и неизвестные aliases сохраняются для backend; CLI
не подменяет неизвестный список default-списком. Без `--timeout` поле не передаётся.

`--timeout` использует TS decimal parseInt и fallback 600000: `12ms` → 12,
`1.9` → 1, `0` → 0, bare/empty/invalid/overflow → 600000. Нет u64/min/max clamp.
Сохранено различие generic TS parser: `--timeout=-5` → -5, а
`--timeout -5` → bare timeout/fallback 600000. Последний неиспользуемый numeric short
flag нормализуется до Clap parsing. Другие неизвестные/повторные flags остаются ошибкой Clap,
что является существующей preview CLI границей относительно permissive TS parser.

`prompt --wait` посылает прежний `agent.prompt`, сохраняя attachments и
queue/interrupt/steer flags. Если ответ содержит queued receipt, он сразу печатается
(JSON или локализованным текстом), exit 0; `agent.wait` не вызывается. Иначе wait
посылается по **имени сессии**, без скрытого turnId pin и без дополнительного prompt.
Смена активного хода/queue auto-drain остаётся ответственностью backend контракта.

Bare prompt без `--wait` сохраняет прежний Rust preview JSON reply. Он не стал
полностью эквивалентен TS строке `Turn … started` / `{turnId,waiting:false}`.
`--until`/`--timeout` без `--wait` не добавляют полей в prompt RPC и не вызывают wait.
Эта отдельная разница формата сохранена явно, а не названа закрытой parity.

## Result / exit / locale

Источник поведения — TS `src/cli/main.ts` cmdAgent/printWait и
`src/i18n/cli.en.ts`. Сначала при `--json` печатается весь result одной строкой,
включая неизвестные bounded extensions; лишь затем выбирается exit:

| Приоритет | Условие | Exit |
| --- | --- | --- |
| 1 | reason=timeout | 2 |
| 2 | blocked_permission / blocked_question | 3 |
| 3 | ok=false либо errorCode — любая строка, включая пустую | timeout=2; blocked_network=4; provider_unavailable/limited=5; прочие=1 |
| 4 | successful/status-only result | 0 |

В JSON-режиме result exits 1–5 не добавляют текстовый stderr. RPC error — отдельный
typed error, не result: JSON не выдумывается; stderr сохраняет `code — message`
и ту же exit map. EOF/invalid correlation/framing дают статическую ошибку exit 1,
без отражения raw frame или request data. Локальные deadline errors дают exit 2.

Без JSON success text идёт в stdout, timeout/human/failure — в stderr. При failure
приоритет `message ?? text ?? ''`, затем локализованный fallback, если выбранная
строка пуста. RU/EN соответствуют TS; newline не дублируется. String coercion
из printWait реализован итеративно, включая array join / null / plain object;
object с собственным toString отвергается. RawValue сохраняет lone UTF-16 escapes
в JSON, terminal display использует существующий lossy UTF-16 decoder.

## Transport, authority и lifetime

Существующий private `cli_client` теперь делит один owner handshake/auth/line parser
между events tail и wait-клиентом. Private response policy без response deadline
допускается **только** для `agent.wait`; prompt ACK сохраняет 3 s response deadline,
прочие команды используют прежний путь и deadlines. Connect/hello/write ограничены
существующими 10 s bounds клиента. Вход/выход сохраняют protocol-1 frame budget.
Расширившееся при String coercion отображение каждого поля ограничено MAX_LINE; overflow —
явная capacity error, без усечения. Текст не обещает unlimited Node resource parity.

`PULT_MEMORY_KEY`, `PULT_MEMORY_TURN_KEY`, `PULT_ASK_KEY`, `PULT_RUNTIME_KEY` отклоняются
до проверки home, чтения config/token и socket connect. Пустое значение также
считается scoped credential. Нет owner fallback, autostart или новой authority.

Disconnect, EOF и Ctrl-C закрывают wait socket; не посылают agent.stop и не повторяют
prompt. Ctrl-C возвращает 130. Клиент не отменяет уже принятый daemon prompt.
Перед rendering socket уже закрыт. Output использует существующий bounded writer
с cloned FD, без удержания global stdout lock. CLI завершает процесс после завершения
этого локального пути, чтобы blocked output worker не задерживал Runtime Drop;
daemon/storage/provider cleanup этим кодом не управляются.

## Verification boundary

`rust/tests/cli_wait.rs` запускает настоящий CLI против контролируемого Unix socket:
long wait >3 s, обычный deadline, flags/coercions, JSON/exit precedence, RU/EN,
typed RPC errors, EOF/wrong-ID/malformed/oversized responses, queue receipt без wait,
один prompt + wait по имени, scoped credential priority и Ctrl-C/socket close.
Regression suite events tail проверяет общий handshake/output путь отдельно.

Это CLI qualification. Public backend acceptance ещё должна доказать actual
Driver cleanup/outcomes/answer projection, statuses, remembered latest outcome,
incarnation protection, queue races, permissions и bounded concurrent waits.
Ни native provider, ни реальный аккаунт/installed service в этом slice не используются.
