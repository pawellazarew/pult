# Очередь реплик и Codex steering

Этот слой переносит существующие `agent.prompt` режимы `queue`, `interrupt`,
`steer` и `agent.queue.send/resume/remove/move`. Metadata хранится в прежнем
`sessions.json`; UI и CLI используют прежние RPC и previews. Это не перенос
асинхронного `question.answer`, фоновых provider turns или Claude Worker.
Каталог содержит прежние 98 методов: 27 foundation и 10 partial методов.

## Поведение

- FIFO: busy-сессия и непустая неприостановленная очередь принимают enqueue;
  idle-сессия отправляет сразу, оставляя paused backlog на месте.
- 20 элементов, 50 000 Unicode codepoints на текст, 256 KiB текста и metadata
  attachments. Preview — 200 codepoints; edit hold возвращает полный текст.
- Правка сохраняет ID, timestamp, attachments и порядок. В журнал идёт только
  `queue.updated {id}`. Hold действует 10 минут; disconnect освобождает только
  holds своего соединения. Held head не обходится следующими репликами.
- Успешный Driver Finished после cleanup будит очередь. Failure/interrupt/stop
  приостанавливают её; административный status не является сигналом dispatch.
- Interrupt-and-send ждёт cleanup предыдущего Ticket до 10 секунд. При timeout
  новая реплика не отправляется. Selected send удаляет только принятый элемент,
  сохраняя конкурентные изменения остальных элементов.
- Steering использует только подтверждённый private native turn ID и
  `turn/steer {threadId, expectedTurnId, input}`. Нет fallback в turn/start или
  interrupt. Fresh gate и first-poll enqueue составляют один blocking шаг.
  Отзыв scope сериализован с enqueue. Caller drop не бросает native IO/receipt.
- `message.user` steering и queue receipt пишутся после native acknowledgement;
  Driver остаётся единственным владельцем terminal status.

## Crash/restart и rollback

В отличие от Node auto-drain, Rust не удаляет голову до отправки. Перед native IO
он сохраняет `queueDispatch: {id,at}` и paused-состояние, сохраняя полный элемент.
Accepted durable receipt `{queueItemId,queueItemAt}` позволяет удалить ровно эту
пару. Restart удаляет только подтверждённые пары, остальные очереди paused.

Unknown delivery не повторяется автоматически и не теряется: marker остаётся,
preview содержит `Delivery unknown; Send now may duplicate`, Resume возвращает
`send_unknown`. Пользователь может явно Send now после cleanup (возможен дубль),
изменить или удалить элемент. Это **не exactly-once гарантия**.

Node reader сохраняет marker; Node recovery сравнивает структурные пары, а
Node drain/Resume также запрещают автоматический retry неизвестной отправки.
Таким образом rollback не снимает защиту. Edit/remove очищают marker только
для выбранного элемента; reorder/hold не являются разрешением повторить send.

Legacy UTF-16 raw values сохраняются при изменении других элементов. Если
legacy input невозможно представить текущим Value-based native/RPC путём,
он остаётся paused с `invalid_params`, без receipt и global storage fault.
Общий RPC parser для новых lone-surrogate строк — отдельный baseline gap.

## Проверка

Локальный Python app-server не выполняет модели и не использует реальные
аккаунты. Built Node24 client проходит настоящий Rust socket и журнал:
steering/rejection, FIFO receipts, selected send, edit/reorder/remove, paused
backlog, interrupt, connection holds, потеря ACK, Node rollback reader и restart.
Дополнительно проверяются Worker/Driver/RPC/Process/Runtime suites и Node queue
сценарии. Итоговые proof logs перечисляются в отчёте PR.
