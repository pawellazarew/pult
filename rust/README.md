# Rust-ядро Пульта, начало R2

В этом crate находятся сервер Unix socket и CLI для протокола Пульта версии 1.
Текущий TypeScript-клиент проходит интеграционный тест с настоящим Rust-сервером.
Пока перенесены `daemon.status`, `daemon.stop` и `protocol.catalog`.

Полный список методов берётся из `../protocol/methods.json`. В `hello_ok` и статусе
публикуются `capabilities.experimental` и `supportedMethods`. Каталог отмечает остальные
методы как `unported`, их вызов возвращает `not_implemented`. Неизвестное имя возвращает
`not_found`. Ключи вопросов и runtime отвергаются до переноса их области доступа.

## Сборка и проверки

Из корня репозитория, с установленными Node >= 22 и Rust toolchain из `rust-toolchain.toml`:

```sh
npm ci
npm run build
node scripts/generate-rpc-catalog.mjs --check
cargo fmt --manifest-path rust/Cargo.toml --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
cargo build --manifest-path rust/Cargo.toml --release --locked
```

Node нужен интеграционному тесту текущего клиента. Если `dist/cli/client.js` отсутствует,
тест завершается с инструкцией собрать TypeScript. CI выполняет весь порядок на macOS
и Linux. Проверка охватывает реальный сокет, токен, ошибки wire-протокола, повторный запуск,
SIGKILL/restart, медленного читателя и отказы при опасных путях. Сам каталог проверяется
отдельно от маршрутов Rust, вызовами всех трёх реализованных методов.

## Изолированный запуск

Выбрать новый scratch-каталог с коротким абсолютным путём. Права каталога — 0700.

```sh
scratch=$(mktemp -d)
./rust/target/release/pultd-rust --home "$scratch" daemon serve
```

Во втором терминале использовать тот же абсолютный путь:

```sh
./rust/target/release/pultd-rust --home /absolute/scratch daemon status
./rust/target/release/pultd-rust --home /absolute/scratch catalog
./rust/target/release/pultd-rust --home /absolute/scratch daemon stop
./rust/target/release/pultd-rust --skill
```

Сервер создаёт `run/pultd.sock`, `run/token` и `run/pultd.lock` в формате текущего Пульта.
Токен — 32 случайных байта в hex, новый на каждый успешный запуск. Он публикуется после
проверки владения listener. Файлы имеют права 0600, каталог `run` — 0700. При отказе
из-за уже живого endpoint его токен и сокет сохраняются.

JSON lock содержит PID и время старта процесса, совместимое с проверкой TypeScript.
Для Rust-процессов дополнительно удерживается advisory-lock `run/rust-owner.guard`.
После падения следующий запуск проверяет владельца и освобождает устаревший сокет.
При нормальном выходе удаляются только собственные socket/lock/token.

Максимум кадра — 1 MiB, соединений — 64. Рукопожатие ограничено двумя секундами,
запись ответа — одной, клиентское подключение и ответ — тремя. Медленный клиент
теряет соединение, другие клиенты продолжают работу. `daemon.stop` сначала отправляет
ответ своему авторизованному клиенту, затем закрывает listener и остальные соединения.

`--home` обязателен. Сервер проверяет канонический путь и отвергает production `~/.pult`,
настроенный `PULT_HOME`, их родителей и вложенные каталоги. Он также отвергает существующие
`config.json`, `sessions.json`, `events`, symlink-home и общедоступные каталоги. Статус
возвращает канонический home. Перенос журнала, сессий, подписок и провайдеров идёт следующими
шагами R2/R3 с проверкой совместимости данных.
