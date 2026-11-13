# R4 agent.wait — private backend qualification

Этот backend slice пока **не рекламируется** через supportedMethods/catalog и не
открывает скрытый CLI. Он не включает provider parity, native permission/account
qualification, service installation или cutover. До reviewed completion-carrier
composition и actual acceptance код не считается build/test qualified.

## Контракт запроса

Protocol 1 и прежний метод `agent.wait` сохраняются. Params: `name`, optional `until`
и `timeoutMs`; неизвестные поля игнорируются. RPC применяет JS String к name и
элементам массива until через существующий iterative RawValue helper. Некорректный
params object и non-finite numeric timeout дают статическую invalid_params ошибку.
До lookup не вводится новый enum-validator для aliases.

Missing/null name становится пустой строкой и не находит сессию. Until, не являющийся
массивом, и пустой массив означают default idle/blocked/done. Непустой список только
из неизвестных tokens не означает default. RPC сам не trim-ит, не меняет регистр и
не делит строку по запятым: `["idle,blocked"]` — один неизвестный token.

Числовой timeout по умолчанию 600000 ms; fractional/zero/negative допустимы.
Другой тип использует default. Non-finite numbers не входят в текущий wire profile.
Один Instant фиксируется перед ожиданием, elapsed сравнивается с конечным f64;
огромные значения не передаются в Duration/Instant addition и не вызывают overflow.

## Evaluation order

1. Текущий pending PermissionBroker override имеет приоритет над cached status.
   Human status с выбранным blocked возвращает status-only matched.
2. Для settled Driver outcome eligibility вычисляется по typed disposition:
   matching current status либо неуспешный outcome. Только eligible result читает
   qualified durable completion ref. Answer.ok обязан совпадать с disposition.
3. При healthy no-entry matching cache status допускает status-only matched;
   remembered outcome из истории при этом не реконструируется. Pending, Closing и
   Quarantined не становятся success по cached idle/done.
4. Match имеет приоритет над deadline, включая zero/negative. Иначе ответ —
   status-only timeout, либо ожидание следующего изменения.

Completed успешный ход с `until:["UNKNOWN"],timeoutMs:0` возвращает status-only
timeout **без completion read**, даже если answer unavailable/oversize. Неуспешный
eligible ход без qualified answer возвращает явную unavailable ошибку; старый текст
или прежний outcome вместо неё не выбираются.

Registry/cache читаются try-lock snapshot без удержания mutex через await. Если до
deadline невозможно получить свежий snapshot из-за contention, возвращается
существующая RPC ошибка timeout, без выдуманного status/incarnation. Это явная
ограниченная resource-edge квалификация относительно синхронного Node lookup.

## Identity, IO и connection lifetime

Сессия пинится по exact SessionKey (name + createdAt), не по начальному turnId.
Удаление/пересоздание имени даёт not_found вместо чтения соседней incarnation.
Driver latest_progress выбирает текущую daemon-epoch entry атомарно при reservation;
новый Ticket заменяет прежний. Driver closed/storage fault — unavailable/closed,
а не здоровое отсутствие entry. Ожидание не инициализирует native runtime/provider.

Большой answer хранится только в durable completion backing. Wait использует
Driver-owned read_completion; admitted Store IO и его отдельный read budget остаются
owned до настоящего завершения даже при disconnect. После IO заново проверяются
SessionKey/current Ticket/Finished ref/status. B, начавшийся во время чтения A,
заставляет цикл наблюдать B; invalid ref не становится fallback к A.

Idle wait не держит host_jobs, mutation gate или отдельный observer. Watch по journal
commit/progress и 40 ms fallback принадлежат только живому connection wait. Закрытый
progress sender не создаёт busy loop. Daemon stop прерывает ожидание сразу.

Границы host profile: 128 глобальных waits и 8 на соединение, отдельные от 16
mutation response futures. Дополнительное admission даёт capacity. Scoped roles
отвергают owner wait до этой ветки. Disconnect/writer close abort/join только waits;
уже принятая execution не отменяется. Store read продолжает владеться carrier seam.

Completion задачи не участвуют в select, который читает следующий входной кадр:
существующий read_line consume-ит prefix в локальный Vec и не cancellation-safe
для продолжения чтения. Завершённые waits reap-ятся перед следующим admission;
JoinSet остаётся ограниченным восемью слотами. Это сохраняет partial-next-frame
после асинхронного завершения wait.

Ответ содержит name/status/reason и только для qualified eligible completion —
turnId/ok и непустые errorCode/text/message. Никакой history concatenation или native
raw JSON не возвращается. Wire overflow — явная capacity error без усечения.

## Acceptance status

Новые pure policy/raw-param cases и actual State/socket scenarios подготовлены:
recovered status без outcome, pending cache suppression, closed/storage fault,
UNKNOWN zero без answer read, held Registry/cache deadlines, partial-next-frame
во время wait completion, same-socket stop/resolve, global/per-connection caps,
disconnect/shutdown recovery, pending Broker override stale idle, exact reusable
Normalizer answer и replacement Ticket во время заблокированного Store load.
Они используют private scratch State и fake owned Worker; внешние
CLI/аккаунты/провайдеры не нужны.

Все эти сценарии, native-specific completion projection и read-budget drain
требуют composed carrier acceptance. Конкретные executed checks и hashes публикуются отдельно в handoff;
наличие этого файла не означает PASS или public activation.
