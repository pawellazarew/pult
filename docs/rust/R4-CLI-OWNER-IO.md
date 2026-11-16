# Owner CLI: bounded token и display config

Исправлен локальный ввод общего owner transport (`cli_client`): `daemon status`,
`agent wait`/prompt wait и event subscriptions больше не блокируются на FIFO вместо
`run/token`. Это отдельный IO fix перед managed Node runtime status; новые команды,
provider probes, service lifecycle и production cutover сюда не входят.

## Договор чтения

Purpose guard всех четырёх scoped credentials остаётся до owner home/config/token
доступа; private scratch `checked_home` и существующие handshake/RPC deadlines не меняются.
`owner_private_file.rs` — private source, используемый отдельно binary transport
и core locale reader. Он открывает home/relative parents через directory descriptors,
NOFOLLOW/NONBLOCK/CLOEXEC, затем leaf без следования symlink. Regular-file metadata
проверяется до чтения; byte cap действует до и во время чтения; descriptor identity,
size, permissions и timestamps проверяются после чтения. Чтение не создаёт файлов.

У token остаётся существующее правило содержимого: ровно64 ASCII hex bytes, без
trim. Обычный readable regular token `0644` и стабильный hardlink принимаются;
новых требований uid/private-mode/nlink к token нет. Missing/empty/короткий/неhex
regular token даёт прежний offline status. FIFO/directory/symlink parent или leaf,
IO error, изменение во время чтения и превышение64bytes — явная локальная ошибка,
а не offline-отчёт. Error text статический, bytes токена и OS error contents не печатаются.
Socket/hello/RPC failure после успешного local read по-прежнему может дать offline.

У CLI locale **только `config.json`** имеет предел1MiB. Private config policy
сохраняет regular/private mode и nlink1 без нового требования uid. Missing config, ordinary malformed
JSON, неobject root и неизвестный language сохраняют Auto; язык затем выбирается
существующим PULT_LANG/system-locale правилом. Unsafe filesystem/IO/изменение/превышение
лимита больше не скрываются как Auto, в том числе при явном PULT_LANG override.
`Registry::read_private`, registry transactions, sessions и их размеры не менялись.

## Проверка настоящим CLI

На исходном `fe1d9202ac4c91a6416cf0413e5f30972c2fdbde` fresh binary в отдельном target
завис на private0700 marked scratch home с600config и600FIFO `run/token`.
После2s внешний watchdog сделал SIGKILL process group и дождался child: stdout/stderr
пусты. После исправления тот же harness завершился exit1 без watchdog, stdout пуст,
stderr `Error: daemon connection or response failed`. Это воспроизведение настоящего
owner status path, не модель reader.

`rust/tests/cli_owner_io.rs` запускает настоящий executable с очищенной средой,
synthetic HOME/PULT_HOME, пустым scratch service directory и fake Unix peer.
Он проверяет FIFO/parent+leaf symlink/directory/caps, token0644/hardlink compatibility,
exact owner handshake, Auto fallback и unsafe config error,1MiB boundary, purpose
guard до hostile files, wait/event transport reuse. Watchdog всегда kill+wait/join,
он не объявляется успешным завершением CLI. Провайдеры, реальные account/home и
настоящие service managers не вызываются.

```sh
cargo test --manifest-path rust/Cargo.toml --locked --test cli_owner_io
```

Обычные CLI/service/wait/event и registry regressions нужны наряду с этой проверкой.
Этот fix не переносит managed runtime status/install/update и не устраняет отдельные
исторические raw CLI request paths вне общего `cli_client` transport.
