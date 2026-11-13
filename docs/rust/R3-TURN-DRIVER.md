# R3: owned driver и durable-журнал

`turn_driver` соединяет Coordinator с асинхронным Worker и настоящим EventStore через
`turn_journal::JournalSink`. Это библиотечный путь **обычной реплики**, пока без RPC/State,
настоящих CLI провайдеров, очереди, ответов на вопросы, вложений и memory injection.
Каталог остаётся 27/98, `agent.prompt` и полный R3 ещё не перенесены.

## Кто владеет работой

Driver.start синхронно проверяет вход и бронирует имя через Coordinator, затем запускает
собственную задачу. Handle клиента содержит только результат начала и наблюдение за
прогрессом. Удаление Handle не останавливает worker и не освобождает бронь.

Host обязан заранее разрешить effective consent/access и проверить папку, вложения,
удаление сессии, holdTurns и сеть. TurnSnapshot из Record хранит desired-настройки,
которые сами по себе не доказывают согласия. В driver нет произвольного spawn или
повышения прав; Worker — доверенный адаптер, а не команда клиента.

Worker.start и Worker.close должны быть неблокирующими, cancellation-safe futures.
После drop/abort future все ресурсы остаются у Worker, а close(ticket) закрывает
**именно эту попытку**, включая частичный старт. Он не должен останавливать соседние
треды общего Codex app-server. Done сообщает foreground outcome; close дополнительно
должен подтвердить quiescence принадлежащей попытке работы и фоновых задач.
Эти обязательства проверяются controlled Worker, не являются доказательством OS cleanup.

## Порядок обычной реплики

1. Проверить исходный текст (непустой, до 65536 UTF-8-байт) и подготовить public text
   обязательным Redactor. Снимок валидируется до брони.
2. Записать `message.user` через настоящий EventStore. Receipt возвращается только
   после durable append; worker ещё не вызывался. Drop клиента не отменяет запись.
3. Получить sealed snapshot через dispatch_start и передать его в Worker.start.
   Начало имеет таймаут 30 секунд по умолчанию.
4. Проверить ответ адаптера и отмену; выдать Accepted {turn_id,user_event_id}.
   Это начало, а не завершение. Провайдер уже может вернуть неуспешный outcome.
5. Дождаться done либо отмены. После отмены abort + join соответствующего future
   предшествуют close. Panic start/done также приводит к cleanup.
6. Подтвердить close, записать terminal `status.changed`, затем освободить бронь
   и выдать Terminal. Успех не выдаётся до закрытия worker и durable terminal append.

Terminal-события используют status idle/failed/interrupted и turnId,
если start был подтверждён. `idle` означает конец успешного хода; явное закрытие
разговора и восстановленный `done` сохраняются. Обычная реплика остаётся в истории при отказе старта.
Queue/question receipt имеет другой порядок; этот API их намеренно не принимает.
Нельзя подменять очередь обычным start и считать её контракт перенесённым.

## Неизвестные результаты и карантин

Ошибка или panic EventSink, а также невалидный receipt включают глобальный storage latch.
Новые start отвергаются; все уже допущенные jobs получают cancel. Начальная ошибка
не запускает worker. Ошибка terminal append происходит после cleanup и не выдаётся
за успешный итог. Запись могла успеть сохраниться до потери подтверждения: нужна
проверка журнала после восстановления, автоматического повтора команды здесь нет.

Driver не прерывает начатый durable append по cancel. Если клиент отменил реплику
во время записи, driver ждёт известного результата; после успешного commit пишет
interrupted и не запускает worker. Зависший IO может задержать shutdown; таймаут
shutdown не превращает неизвестный результат в успех.

Ошибка, panic или таймаут close сохраняют бронь и Worker в Progress::Quarantined.
Handle.wait возвращает CleanupUnconfirmed. Повторный cancel переводит прогресс в
Closing до сигнала retry: последующий wait ждёт новый результат, а не старую ошибку.
Публикация ошибки сериализована с cancel: запрос, пришедший во время close,
не перезаписывается старым Quarantined. Если новая очистка опять не подтверждена, карантин остаётся. Начальный close timeout —
5 секунд; future abort + join не заменяют подтверждение очистки самой попытки.

shutdown закрывает admission, отменяет jobs и ждёт освобождения всех броней.
Таймаут возвращает CleanupUnconfirmed. Drop Driver только сигнализирует shutdown,
не является подтверждением cleanup; host обязан использовать awaited shutdown.

EventSink возвращает завершённый результат append, даже при ошибке. Неуправляемая
фоновая запись после завершения его future нарушает контракт. Реальный JournalSink
выполняет append в spawn_blocking и сохраняет владение задачей. Commit watch
публикуется после ack, только с возрастающим ID, без вложения store/watch locks.
Окончание shutdown означает закрытие jobs, а не доказательство здоровья истории:
storage_failed остаётся latched до восстановления новым host/store.

## Публичные данные и panic

Исходный текст получает Worker; журнал — только public text. Обязательный Redactor
также обрабатывает code/message ошибок; опубликованное сообщение ограничено 4096
Unicode code points. TurnId, изменённый redactor, отвергается как небезопасный ответ.
Panic payload и исходный SinkError не становятся публичной ошибкой driver.

Catch/JoinError сами по себе не защищают stderr: стандартный panic hook печатает
payload до перехвата. Поэтому Rust-бинарь устанавливает процессную panic-политику
при старте: hook ничего не печатает и не блокируется на stderr. Безопасный код
worker_panic остаётся в результате driver и terminal-записи. Library host должен вызвать
panic_guard::install до worker-задач. Это не временная смена глобального hook вокруг
одного driver. Worker/Sink по-прежнему обязаны не печатать приватный raw-текст сами.

## Проверки и следующий шаг

Тесты вызывают настоящий Driver с настоящим EventStore и управляемыми worker-futures.
Oneshot/Notify задают порядок без sleeps; watchdog ограничивает зависшие тесты.
Проверяются fsync-before-start, redaction, ошибка до и после фактического commit,
потеря клиента, start/done panic, cancel, quarantine/retry, shutdown и остановка
соседней сессии при storage fault. Отдельный дочерний процесс проверяет panic-policy.

Далее — production host/guard, worker supervision с доказательством остановки дерева,
queue/question receipts, registry decorations и broker. Только затем native Codex,
Claude/ZCode, передача memory credential и приёмка RPC. Общий Codex app-server не должен
получать session key в глобальном окружении; уже загруженный MCP также требует
отдельного проверенного контракта обновления credentials.


## Fresh pre-dispatch gate

`Driver::start_checked` accepts a synchronous `DispatchGate` that runs after
the durable user append and before dispatch seals, with no intervening await.
It can allow, narrow approval using Coordinator rules, or deny. An attempted
expansion or callback panic fails closed as static `AccessDenied`. Denial
does not start or close a worker that was never touched. Cancellation before
the check skips it; cancellation during the check is observed again at seal.
The old `start` remains a trusted-host library entry point for compatibility.

The callback and Coordinator dispatch seal run in one owned blocking step,
with no await between them. Cancellation remains responsive on Tokio workers;
the step rechecks cancellation before sealing, and the Driver retains the ticket
until any blocking check finishes. A stuck policy read cannot produce a late
dispatch or a false successful cleanup. Provider preparation stays outside the
callback. The host must still refresh access
after asynchronous provider preparation and retire already running Full
processes when consent changes. This seam does not itself supply those facts
or make provider reuse safe. Hosts install the silent panic policy before
calling external callbacks.

Four additional scenarios cover durable consent revocation/hold during a
blocked journal append, exact narrowed worker settings, denied expansion or
panic, and cancellation before dispatch. There are now 20 driver scenarios.


## Input metadata and deferred acceptance

`start_input` freezes typed Input/InputMetadata before awaiting. The trusted
host must validate attachment ownership and pass the same frozen metadata to
the worker facade. The journal receives only text and attachment metadata,
not provider image blocks. Attachment-only input is allowed. Admission bounds
the complete serialized draft before external send.

Ordinary input retains append-before-start. Queue/question input delays the
message.user receipt until Started validation and an owned first-poll
completion checkpoint. Immediate failure, interruption or panic leaves no
receipt, so the item/question can be retried. Pending or successful completion
permits append; Accepted still requires the durable receipt and a fresh
cancellation/storage check. Unknown sends are never automatically repeated.

Cancellation and append failure abort and join the completion task before
Worker::close. The append itself is owned through its known/unknown outcome.
A storage fault latches admission and cancels siblings. Queue ID/timestamp
strings are paired and bounded to 1024 UTF-8 bytes; timestamp is opaque and
kept exactly, including legacy empty strings. Question IDs are positive
JavaScript-safe event IDs. The host validates that the referenced question
or queue item actually belongs to this session.

There are now 35 driver scenarios, including metadata-only input, blocked
start/append, first-poll failure/panic/interruption, storage uncertainty,
dropped callers, no resend, and exact JavaScript whitespace behavior.

This is a bounded library input seam, not an RPC migration. Queue ownership,
question routing and their protocol handlers remain unported; the trusted host
must validate these identities before calling it. The public method catalogue
remains 27 implemented methods out of 98.
