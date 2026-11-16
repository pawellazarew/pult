# R4: локальный CLI doctor

Rust CLI поддерживает `--home <private-scratch> doctor [--json] [--no-net]`.
`--no-net` пропускает только свежие `net.*` пробы: CLI versions, вход, подписки,
схема Codex, файлы, демон и служба проверяются в обоих режимах.

Это полный набор локальных CLI-проверок в ограниченном диагностическом профиле.
`doctor.run` RPC, установленный launcher/service cutover и production-home admission
остаются отдельными задачами. Диагностика не запускает демон, не устанавливает и не
обновляет программы, не исполняет fix/fixCmd, не создаёт provider session.

## Привязки

- Login-shell PATH: кэш 24 часа, иначе чистый `/usr/bin/env -i … $SHELL -ilc 'env -0'`.
  В кэш попадают PATH и имена переменных; значения остальных переменных не сохраняются.
  Обновление кэша: private create_new temp, bounded write, sync, проверка исходного
  inode и atomic rename через descriptor домашнего каталога. Hardlink, symlink и FIFO
  для кэша отвергаются; старый файл не открывается с truncate.
- Tool inventory: claude, codex, opencode, zcode, git, gh, node, npm, порядок кандидатов
  и version argv из Node source. Восемь version jobs запускаются параллельно.
- Claude `auth status --json`: stdout читается и при exit 1, leading noise допускается;
  неизвестный формат отличается от logged-out. Наружу идут только boolean входа и
  короткие subscriptionType/authMethod. Codex: stdout/stderr fallback и redaction.
  Эти два запроса и генерация схемы Codex идут параллельно.
- Codex schema: настоящий вызов `app-server generate-json-schema --out <owned dir>`;
  SHA256 каждого файла, затем SHA256 отсортированного bundle. `sha2 = 0.10.9` закреплён
  lockfile; используется RustCrypto Digest API, без внешнего shasum.
- Codex TOML: profile overrides, разрешения unix sockets, строки/массивы/inline tables;
  ZCode credentials: только наличие подходящего ключа; OpenCode: presence-only login.
- Fresh network: отдельный DiagnosticProvider4, все четыре профиля параллельно;
  два trace URL по порядку, успешный exit и loc обязательны, direct fallback только auto.
  Execution Provider3, Driver, Factory и provider execution не расширены.
- Права home, один read-only daemon.status, действительные daemon.node/update поля,
  current/package/update-state compatibility layout, browser/Chrome/MCP/bypass,
  service launcher/state/last exit/node-path и Linux linger.

## Владение и отмена

Пять purpose credentials (`PULT_MEMORY_KEY`, `PULT_MEMORY_TURN_KEY`, `PULT_ASK_KEY`,
`PULT_RUNTIME_KEY`, `PULT_CODEX_MEMORY_KEY`) отвергаются по присутствию, включая пустые
значения, до любого доступа к home. Требуется помеченный private Rust scratch home.
`ensureLayout` не вызывается. Каталог run/schema создаётся только для нужного schema job.

Одна SIGINT-подписка действует от начала проверок до вывода. Executor использует общий
watch cancellation и Semaphore(8). До запуска проверяются отмена и sticky cleanup fault.
Начатые jobs не отбрасываются: их process groups и bounded pipe readers проходят cleanup/join.
Версии/schema/curl используют base allowlist, auth — captured PATH; saved-node
использует base allowlist как safety delta к наследованию полного env в Node.
Сигнал группе отправляется до reap лидера. Если очистка не подтверждена, итог — fatal 1,
в том числе при SIGINT; schema scratch сохраняется. При подтверждённой отмене — 130.
Обычные завершившиеся schema directories удаляются после joined cleanup и полного
ограниченного inventory. Удаление идёт по сохранённому descriptor manifest снизу вверх,
без повторного recursive walk. Root attachment проверяется до/после чтения и перед
каждым unlink; перенос целого root или подмена его имени останавливает дальнейшую очистку.
При превышении бюджета, нечитаемом или изменившемся
дереве scratch сохраняется; JSON сообщает `scratchRetained`/`retainedReason`, отменённый
CLI печатает статическое предупреждение. Маленькое дерево после SIGINT очищается только
после подтверждённого join и полного ограниченного inventory.

| Класс | Deadline | Предел вывода |
|---|---:|---:|
| Login shell | 3 s | 4 MiB на поток |
| Tool version | 30 s | 4 MiB на поток |
| Claude/Codex auth | 20 s | 4 MiB на поток |
| Schema generator | 30 s | 4 MiB на поток |
| Saved service Node | 10 s | 4 MiB на поток |
| Network attempt | 8 s | 64 KiB на поток |
| Existing service/linger query | 20 s | 1 MiB на поток |
| Existing runtime NodeVersion | 60 s | 1 MiB суммарно |

Последние два прежних класса и их error projection сохранены. Overflow не становится
успешной auth/schema/net проверкой. Наблюдённый reader overflow имеет приоритет над
одновременным query timeout: partial auth JSON разрешён только при timeout без
capture failure. Interrupted/ownership/cleanup остаются fatal; Service/NodeVersion
сохраняют прежнее отображение ошибок. Version overflow отдельно даёт cli.* warn,
`data.state: output_limit` и явный detail; обычная source presence-проверка не меняется. Partial stdout после обычного timeout сохраняет
Node-семантику auth; incomplete/overflow output не подтверждает вход.

## Явные отличия профиля

1. У Rust нет `process.version`. `node.version` проверяет Node dependency: пригодный
   managed active Node (exit 0 и major >= 22), иначе located Node. `data.path` и
   `data.source: managed-active|located` показывают выбор. Current/runtime/node-path
   читаются как существующий Node compatibility layout.
2. Config, cache и обычные diagnostic JSON/TOML/package/dotfiles ограничены 1 MiB;
   runtime/active и node-path — 16 KiB; environment — 64 KiB. Opaque config/auth/daemon
   extension fields не должны сбрасывать известные поля. Превышение decode budget в
   известном structured config value — fatal capacity, а не malformed/defaults.
   Private scratch/config/cache и service/package reads используют соответствующие
   safe readers. User dotfiles, current dev layout, runtime/active и node-path следуют
   обычным symlink semantics по source; FIFO не открывается блокирующим способом.
3. TOML: максимум 64 сегмента полного пути, 64 уровня value nesting и 65 536 значений;
   превышение — `codex.network` warn с parsed:false. Это ограничивает создание и
   уничтожение дерева. Bare-value regex кэшируется. Schema: 8192 посещённых entries всех
   типов, 4096 файлов, depth <= 32, 8 MiB на файл, 64 MiB на bundle (metadata и реальные
   прочитанные байты); schema descriptor reader допускает до 32 компонентов (прежний
   ordinary owner reader остаётся на восьми). Выход за пределы даёт unavailable,
   не совпавшую схему.
4. Malformed config сохраняет defaults и предупреждение, но причина стандартизована
   как `invalid JSON`: V8 error snippets могут содержать секрет из файла. Валидационные
   предупреждения сверяются с Node, включая literal JSON.stringify escaped UTF-16 в
   непригодных значениях; raw values проходят redaction.
5. Для динамических диагностических строк из входного JSON непарные UTF-16 единицы
   отображаются через UTF-8 replacement. Это ограниченный display profile; он не
   меняет opaque RPC/registry/history. Paired oracle применяет замену только к явно
   указанным detail/data полям соответствующих fixtures. Корректные emoji остаются
   неизменными. Обрезка native Codex login line на 160 UTF-16 units реализована точно:
   если она разрезала пару, JSON сохраняет lone surrogate, terminal text — replacement.

## Проверка и границы доказательств

`rust/tests/cli_doctor.rs` запускает настоящий Rust CLI с частными fake executables,
файлами, protocol-1 socket и явными PULT_TEST selectors. Без fake PATH/shell, curl или
manager нет системного fallback. Провайдерские CLI, настоящие аккаунты, shell rc,
OS managers и внешняя сеть не вызываются.

Differential oracle `cli-doctor-oracle.mjs` сравнивает JSON, текст, counts/exit,
fix/fixCmd/data и config stderr с настоящим Node runDoctor и Node file/schema/service
helpers. Candidate discovery, daemon status и network probe подставлены; это не запуск
production Node CLI bindings. GeneratedAt/network duration нормализуются; D1 metadata,
malformed reason и конкретные UTF-8 display fields проверяются отдельными profiles.

Отдельные actual-CLI тесты проверяют no-net/default four providers, class-specific PATH, purpose guards,
обычные symlinks, managed Node selection, bounded deep TOML, overflow auth, private
cache/hardlink/swap/FIFO/capacity, реальные 3 s и параллельные 30 s deadlines,
SIGINT с заблокированными auth/schema потомками, настоящий blocked stdout
(SIGINT и output deadline) и удаление schema после join.
`cleanup-schema` — закрытый test-only seam: неопределённость классификации вводится
после настоящего group/reader join. Это не доказательство реального OS permission denial.

Независимые тяжёлые CLI fixtures сериализованы; восемь jobs внутри doctor остаются
параллельными. Предыдущий нагруженный прогон сохранил fail-closed timeout/cleanup faults;
сам по себе он не доказывает причину сбоя OS cleanup. Service/runtime/browser regressions
проверяются отдельно, включая прежние 20 s/60 s классы и blocked stdout.


## Квалификация 0e0 (R1/R2)

- Полный actual-CLI набор: 22 passed, включая 84 RU/EN парных whole-report случая.
- CLI unit set: 47 passed, включая Timeout + joined Overflow, оба порядка reader
  failures, timeout-only partial-auth control и пять schema inventory/cleanup controls.
- Общие регрессии: browser 12, runtime 12, service 19 passed; прежние 20 s/60 s
  query classes и output projection сохранены.
- fmt и Clippy `--all-targets -- -D warnings` проверены на этом production source.

RED-логи сохранены отдельно: partial auth ошибочно подтверждался при Timeout +
Overflow; 8193 пустых каталога проходили schema limits; после переноса root cleanup
удалял файл через старый FD. GREEN проверяет те же предикаты, плюс nonzero/SIGINT
большие деревья, root move на следующем checkpoint и сохранность replacement.
R1 использует детерминированный classifier/projector seam с настоящим auth model,
а не заявляет пойманную естественную timing race. R2 запускает настоящий CLI и
частные filesystem fixtures. Исходные 70c source/logs/binary сохранены неизменными.
Полную проверку скомпонованного source выполняет следующий gate; здесь нет
утверждения об установленном production CLI или завершённом doctor.run RPC.
Файлы логов и их SHA256 передаются отдельно.
Коммитимые pin reference files — только две агрегированные схемы (1 358 692 байта),
не весь native набор из 318 файлов; production generation остаётся квалификацией R5.


## Узкое исправление Query EPERM

Darwin EPERM может наблюдаться до waitability того же owned unreaped leader.
Query повторяет NOWAIT check каждые 5 ms в прежнем бюджете proof 1 s; обе прежние
zombie snapshots получают этот же deadline. До успешного proof leader не reaped;
живой leader, ошибка snapshot и несовпавшие zombie sets остаются unconfirmed.
Это эквивалент merged holder fix; class deadlines, byte caps, error projection и
ownership checks не расширены.

Детерминированный RED/GREEN использует настоящий owned child с закрываемым stdin
gate и настоящие NOWAIT/две `/bin/ps` snapshots. Только результат SIGKILL (`EPERM`)
подставлен в private decision seam; production-переменной для инъекции нет.
Первый Pending разрешает child exit; старый immediate check возвращал ошибку,
новый ждёт waitability. Контроли удерживают child живым и вводят ошибку второй
snapshot; оба не дают cleanup confirmation. Это не наблюдение естественной
Query EPERM race. Логи narrow follow-up и неизменённые 0e0 proofs передаются отдельно;
полный composed gate выполняет Root.

Narrow source квалифицирован отдельно: 50 binary units (в том числе три waitability
контроля), shared browser/runtime/service 43, doctor cancellation/overflow два focused
теста, Clippy all-targets -D warnings и fmt — PASS. Полный CLI набор с 84 парными
случаями относится к сохранённому 0e0 выше; в этом follow-up он не повторялся.
