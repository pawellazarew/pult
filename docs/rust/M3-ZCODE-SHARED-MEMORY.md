# Общая память ZCode, Claude и Codex

Rust-демон передаёт ZCode тот же Backend памяти, который используют Claude и Codex.
Хранилище, версии записей, политика доступа и Inbox общие; каждый ход получает
отдельные ключ и lease. При выключенной памяти остаётся обычный Route A, при
включённой выбирается отдельный app-server и private MCP-конфигурация. Выбор
делается до отправки; неизвестный результат не переключает маршрут и не повторяет
реплику. Подробности: [Runtime](R3-ZCODE-MEMORY-RUNTIME.md),
[resources](M3-ZCODE-RESOURCES.md), [input admission](M3-INPUT-ADMISSION.md).

## Проверенный сценарий

`rust/tests/zcode_memory_compatibility.rs` запускает настоящий Rust-демон, holder
и memory MCP с контролируемыми native peers. Node-клиент использует обычные RPC.
Девять сценариев проверяют:

1. Создание сессий и память ZCode без установленных Claude/Codex.
2. Каталог и чтение через настоящий MCP, отказ доступа к другому проекту.
3. Отказ и подтверждение proposal с реальным ZCode source event/turn.
4. Backend ReadOnly и отдельное подтверждение записи даже в Full.
5. Чтение ZCode-записи последующими Claude и Codex без копирования данных.
6. Отложенную квитанцию очереди и чтение версии 2 обоими провайдерами.
7. Отмену ожидающего proposal без записи и оставшихся процессов.
8. Отзыв доступа у уже работающего helper без нового разрешения или записи.
9. Resume того же native SID с новым ключом и удалением ключа из журнала.

Проверяются точные source event/turn, завершение blocker перед очередью, PID
провайдеров/helper и очистка после демона. Все RPC теста имеют явные deadlines.
Внешний watchdog владеет отдельной группой Node/демона до reap. На macOS EPERM
принимается только после двух одинаковых zombie-only снимков с удержанным leader;
живые, неизвестные или неоднозначные участники не считаются очищенными.

Сборка требует Node-артефактов (`npm ci`, `npm run build`) и Rust-бинарей.
Основной тест — `cargo test --manifest-path rust/Cargo.toml --locked --test zcode_memory_compatibility`.
Первая проверка выявила ограничение тестового watchdog на macOS; исправление
не меняет production holder или доказательство очистки.

## Граница результата

Fake native peer вызывает helper напрямую. Это проверка нашего транспорта,
Backend и Broker, а не native permission policy, модели или установленной CLI.
По закреплённому исходнику стандартный Guarded допускает generic MCP, а Plan
может запросить native подтверждение чтения. Нынешний `DenyInteractions` отказывает;
для полного ReadOnly/Plan-паритета нужен типизированный native Broker bridge.
Native rules/hooks и версия установленной CLI также требуют отдельной приёмки.

Workspace/Edit, явные model/effort/service-tier/browser-настройки Route B пока
отклоняются. Окно памяти, purge, native permissions/questions, warm/background,
рабочий cutover, откат и длительное наблюдение остаются в общем плане. Этот шаг
не закрывает весь M3 и не переключает установленный Пульт.
