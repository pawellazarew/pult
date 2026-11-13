# Общая память ходов Claude и Codex

Claude подключается к тому же `State.memory_turns` и SQLite-хранилищу, которые
использует Codex. Подготовка Claude не требует установленного Codex. Политика
остаётся явной: owner RPC `memory.configure` либо `agent.start` задаёт
`memory: {read: true, write: "ask"}`; по умолчанию память выключена.

## Контекст и доступ

Для каждого Ticket Factory готовит отдельный `pult-memory` stdio server с новым
`mt_` ключом. Сервер вопросов `pult` использует другой `pa_` ключ. Ни один из них
не становится owner credential. Конфигурация памяти содержит только
`command/args/env`; Codex-specific `default_tools_approval_mode` в неё не входит.

Каталог передаётся отдельным native text block рядом с вложениями и контекстом
режима. Он ограничен общим backend: 4000 UTF-16 units и 16000 UTF-8 bytes.
Исходная реплика для native Claude остаётся прежней, а каталог не добавляется в
`message.user`. Журнал продолжает применять обычную фильтрацию секретов, включая
32-hex строки в пользовательском тексте. Для slash-команды без вложений lookup
и добавление каталога пропускаются, сохраняя измеренный контракт одного блока.

После кодирования input Worker повторно проверяет scope перед первым input poll.
Отозванный scope или panic проверки запрещают отправку. Сохраняются старые
`ScopedMcp` implementations: default catalog — `None`, default check — `true`.
Actual Factory проверяет точные Ticket/generation и действующий memory control.

ReadOnly запрещает запись и на backend, независимо от видимости инструмента.
`control.writable` фиксирует права подготовленного хода; последующее расширение
прав записи или прямой scoped RPC не расширяют старый ключ. Full access также
не отменяет отдельное owner-подтверждение `memory_propose`.

## Происхождение записи и завершение

Proposal ждёт actual Driver Running с совпавшим public turn ID и durable user
event. Для очереди квитанция появляется только после native acceptance;
сохранённая заметка ссылается на event выбранного queued input. Следующий Codex
turn читает ту же запись и версию через общий backend.

При cancel/terminal Factory отзывает оба scope, дожидается late preparation и
точных ask/memory drains, затем удаляет private config. Повторный prepare того
же Ticket с другой generation отвергается до выдачи ключей. Stale-generation
revoke/cleanup не затрагивает действующий scope. Неизвестное завершение IO не
выдаётся за cleanup; отмена после commit seal не обещает откат записанных данных.

## Проверка и оставшаяся приёмка

`claude_memory_compatibility.rs` запускает настоящий daemon, holder, Node-клиент
и Rust memory MCP с синтетическими Claude/Codex. Семь сценариев проверяют:
выключенную память и отсутствующий Codex binary; каталог/get; deny и allow с
Claude provenance; чтение из Codex; queued update с lazy receipt и новой версией;
ReadOnly и отдельный вопрос в Full; отзыв уже подготовленного helper.

Отдельный counterfactual raw-RPC тест воспроизводит попытку записи из captured
ReadOnly при Driver/record Full: без immutable writable guard появляется durable
вопрос Broker, с guard запрос отклоняется до вопроса и записи. Layer tests также
покрывают Inherit narrowing, stale generation, held preparation/encoding и panic.

Fake provider не квалифицирует поведение настоящего Claude CLI: native MCP tool
может запросить обычное разрешение до отдельного подтверждения записи памяти.
Auto-allow rules этим шагом не добавляются. Нужны отдельные реальные smoke-тесты,
ZCode MCP delivery, UI управления памятью и окончательное удаление её данных.
Рабочее переключение и откат остаются в R5.
