# ZCode: ресурс provider config в установленном приложении

16.11.2026. Проверка стабильного Node backend обнаружила конкретный startup failure до первого provider frame: CLI0.17.1 искал `glm/provider/zcode-builtin.json`, хотя приложение содержит `Resources/config/provider/zcode-builtin.json`. Статус был `failed/internal`; это не доказательство отсутствия входа в аккаунт.

Адаптер передаёт fallback `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` только из выбранного absolute CLI: symlink разрешается, ожидается app-bundle layout и regular resource. Явная конфигурация сохраняет приоритет. Для обычного PATH CLI, отсутствующего ресурса или каталога fallback отсутствует. Общий список разрешённых parent env не расширяется; credential/token values не читаются и не копируются. CLI сам выбирает свой active cache и personal config обычным кодом.

Регрессионный тест воспроизводит startup failure на действительно запускаемом controlled app CLI без config env, затем проверяет завершение и переданный путь. Дополнительные controls: symlink CLI, explicit override, secret exclusion, missing/directory resource. Исходный17-case adapter suite прошёл после исправления.

На настоящем установленном0.17.1 до исправления три коротких диагностических запуска завершались до provider frames; после исправления один read-only prompt дал `RELEASE_SMOKE_OK`, `message.done`, usage и idle, без tool calls. Claude и Codex отдельно дали тот же sentinel через Node backend. У каждого daemon-home/cwd были одноразовые каталоги; рабочая служба Пульта не переключалась. Это ограниченная проверка ответа, не полная R5-приёмка прав/resume/rollback или Rust ZCode backend.
