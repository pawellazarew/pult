# ZCode: явное восстановление после missing native session

Этот шаг добавляет Worker/Runtime consumers типизированного Owner proof. RPC и UI подтверждения подключаются отдельно. Это не доказательство отсутствия выполнения и не полный parity/recovery после перезапуска.

## Когда появляется предложение

Runtime резервирует один из 256 recovery slots только для согласованного сохранённого resume ID, до Driver start. Обычный новый чат не занимает slot и продолжает работать при заполненном cache. На spawn boundary фактический Attempt должен соответствовать captured resume ID. Slots не вытесняются молча.

Worker наблюдает matching native `turn.started` **до** любого identity/accept IO. Missing proof возможен только для resumed Attempt без такого наблюдения, при native missing diagnostic, естественном stdout EOF до stop, подтверждённом `Process::output_finished_cleanly()` после stop, завершённом private stderr и известных завершениях Store/Sink. Затем Owner retire и joined proof связывают capability с точным Attempt. Receiver None сам по себе не считается доказательством clean EOF. Recovering JSONL может отбросить malformed line: clean completion не означает, что байты или работа отсутствовали.

Runtime извлекает one-shot capability только после exact `Progress::Finished(Ok(Terminal))`, до удаления Worker, включая synchronous reap из busy/query/submit/reset/shutdown. Storage failure оставляет `unconfirmed`, без права сбросить привязку. `pending_recovery` читает существующий cache без инициализации provider/account; descriptor содержит opaque recovery ID, incarnation и `mayHaveExecuted=true`, но не native authority.

## Подтверждение владельцем

Crate-private `OwnerRecoveryAction::from_authenticated_owner` предназначен для host RPC boundary после аутентификации явного действия. Model/scoped-MCP JSON не создаёт этот token. Подтверждение резервирует same-name Recovering entry и сохраняет его до окончания owned IO, даже если вызывающий future удалён.

Порядок:

1. Durable `session.configured` notice `recovery.phase=requested`: возможное предыдущее выполнение, без `changes` и без утверждения успеха.
2. Owner проверяет exact proof/terminal/warning bindings, issuing Owner, incarnation, текущую policy/cwd/consent, marker и resume ID; локальный seal предшествует metadata CAS.
3. CAS удаляет только `providerSessionId` и `zcodePendingInput`, устанавливает `queuePaused=true`. Очередь, `queueDispatch`, история и остальные поля сохраняются.
4. Отдельный durable `committed` notice либо `failed` notice. Возвращаются requested/committed event IDs, `mayHaveExecuted=true`.

Никаких prompt, автоматического повторения, queue pop/resume или model calls. Следующий явно отправленный input проходит обычные свежие policy/network gates и начинает новый native conversation. После cancel до seal сброса нет; после seal отмена не объявляется rollback. Stop/auth cancellation синхронно отзывает permit. Shutdown не возвращает Stopped при pending owned IO: известная незавершённая попытка остаётся quarantined, после её завершения можно повторить cleanup. Callback panic/неизвестное IO публикует storage fault и сохраняет permanent quarantine, поскольку trusted completion seam для произвольного внешнего IO отсутствует.

## Границы и проверка

Proof существует только в текущем Owner/Runtime lifetime. После cold restart marker остаётся блокирующим; capability нельзя восстановить из JSON/regex. Нужны отдельные manual inspection/import/recovery semantics; произвольный установленный старый Node backend не объявляется совместимым с новыми markers. Existing source-controlled Node rollback guard сохраняется.

Tests используют настоящий holder, синтетический Route A, Registry/Consent/Driver/Journal: missing proof, native-started exclusion, discarded-line distinction, metadata-only confirmation, raw UTF-16 queue preservation, wrong selector, caller drop, blocked warning cancellation/neighbor isolation, shutdown quarantine/drain, storage Finished error и bounded cache admission. Process clean-output и Owner capability contracts покрыты отдельными dependency suites. Реальные CLI, аккаунты, модели и сеть не вызывались.
