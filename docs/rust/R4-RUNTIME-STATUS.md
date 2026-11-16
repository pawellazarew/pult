# Managed Node: `runtime [status] [--json]`

Команда наблюдает свой Node Пульта и Node работающего daemon. Это не provider
runtime и не Preview `runtime.*`. `runtime` и `runtime status` — один путь;
`--json` возвращает compact report, иначе печатаются прежние RU/EN строки.
Runtime install/update, downloads, pointer writes, service restart и production
cutover сюда не входят.

## Отчёт и эффекты

JSON keys в прежнем порядке:

```json
{"platform":"darwin-arm64","key":"darwin-arm64","pinned":"24.21.0","active":null,"activeVersion":null,"installed":[],"daemon":null}
```

`platform` использует имена Node (`darwin`, `x64`, `arm64`); `key` поддерживает
darwin/linux × arm64/x64, иначе null. `active` — trim первой строки
`PULT_HOME/runtime/active`; последующие строки игнорируются. Для существующего
regular executable применяется X_OK и запускается только `active -v` с allowlist
HOME/USER/PATH/LANG/TERM/TMPDIR. Пустой PATH получает прежний fallback. Shell,
provider lookup, login, npm/curl и manager query не вызываются.

Executable может быть внешним, relative или обычным executable symlink: это
сохраняет диагностику перенесённого home и старого Homebrew Node. Проверка имени
каталога/платформы, semver stdout и хеширование executable здесь отсутствуют,
как и в Node status. Проверка metadata + X_OK не обещает inode-pinned exec при
одновременной замене executable пользователем.

`activeVersion` — UTF-8 replacement stdout с JS trim. Spawn/nonzero/empty/timeout
или превышение **combined stdout+stderr1MiB** даёт null после подтверждённого
cleanup. stderr executable не печатается. Operation deadline —60s, не180s
install first-run timeout. Source oracle подтвердил combined предел отдельно:
600KiB stdout +600KiB stderr уже дают null.

`installed` — только имена runtime entries с prefix `node-v`, без substring
`.partial-`/`~old-`, сортировка по JS UTF-16 units. Тип entry, package metadata,
version и содержимое не проверяются; symlink/file names тоже попадают в список.
Затем вызывается один `daemon.status` с отдельными2s handshake/request deadlines,
без retry/autostart. `daemon` — весь bounded raw `status.node` с unknown fields и
JS UTF-16 strings, либо null. Поля running/service и весь daemon status не добавляются.

Text сохраняет source branch order: unsupported platform → missing pin → missing
active → неотвечающий active → версия/путь с optional pin mismatch hint; затем
daemon line (offline / old daemon / dead binary / own / system) и optional
`на диске`/`On disk`. Display использует существующий bounded JS coercion.
Offline/missing/broken/mismatching Node — exit0, локальная ошибка —1, SIGINT —130
после owned cleanup. Cleanup-unconfirmed имеет приоритет над cancellation/observations.

Status не создаёт layout, не пишет state, не меняет permissions и не устанавливает
Node. До/после actual CLI corpus сравниваются content/layout/modes scratch home;
единственные fixture writes самого fake executable — заранее заданный calls log
вне home. Произвольный пользовательский executable может иметь собственные эффекты.

## Embedded pin и safety profile preview

По решению migration Root pin включён через `include_str!("../../runtime.env")`.
Это pin **собранного binary**, без cwd/PATH/current/package-root discovery или
ambient override. В Node pin читался из изменяемого runtime.env вызывающего пакета;
отличие принято явно. Удаление/порча source runtime.env после сборки не меняет Rust
report. Missing build input — compile error; malformed embedded text — явная
validation error до child/RPC. Parser проверяет version и все известные checksums,
игнорирует unknown keys/platforms, сохраняет last valid duplicate; сам status
checksums executable не вычисляет. Parser tests покрывают malformed text, BOM/CRLF,
unknown/duplicate keys и unsupported platform. Это не mutable-package byte parity.

Все4 scoped purposes запрещены по presence до FS. Существующий explicit private
scratch `checked_home` сохраняется; production home guard не ослаблен. Active
**data file** читается bounded regular NOFOLLOW/NONBLOCK reader, parent directories
descriptor-anchored NOFOLLOW. Исполняемый target наблюдается отдельно по Node
metadata semantics. Private config/token reader — [R4-CLI-OWNER-IO](R4-CLI-OWNER-IO.md).

Bounds: active16KiB; runtime≤4096entries/1MiB raw name bytes; pin64KiB; rendered
report≤4MiB; child env≤64KiB. Unsafe data files/FIFO/symlink parents/oversize/read errors дают static
local error, не ложные missing/offline/empty. Это safety deltas от lenient Node reads.
Публичная grammar ограничена status; install/update и permissive unknown flags
Node не объявляются implemented. Новый public pin/layout flag не добавлен.

`PULT_TEST=1` разрешает version query только с explicit matching
`PULT_TEST_RUNTIME_EXEC`; отсутствующий fake selector не падает в настоящий Node.
Он не передаётся child. Этот test seam не меняет production выбор executable.

## Owned runner и проверки

`cli_owned_query` — binary-private shared lifecycle закрытых host queries.
`Kind::Service` сохраняет20s, per-pipe1MiB, manager argv/env и прежние error strings.
`Kind::NodeVersion` фиксирует60s и combined1MiB. Интерфейс не доступен model/RPC/core.
Source service lifecycle перенесён без дублирования: process group, WNOWAIT leader,
signals до reap, macOS bounded all-zombie proof, оба reader tasks drain/join.
Caller не outer-cancel-ит query owner. После SIGINT новый status RPC не отправляется.

`rust/tests/cli-runtime-status-oracle.mjs` запускает настоящую public Node CLI на
private homes/fake `-v`/Unix peer; preload запрещает все прочие child calls и
проверяет точный Node child env allowlist. Тот же corpus сравнивает Rust JSON/text,
RU/EN, exit и filesystem snapshots:80 paired cases, включая внешний/relative/
symlink executable, foreign-platform имя, version mismatch, stderr и combined cap,
old/dead/own/system daemon, unknown fields и isolated UTF-16 surrogates.

Actual Rust tests дополнительно проверяют fork с retained pipes и с ранним EOF,
overflow/nonzero, настоящий60s deadline, SIGINT во время query и blocked stdout,
bounded blocked-pipe exit, отдельные2s transport phases, unsafe data/caps,
no-layout/missing directory, mixed/non-UTF8 purpose denial и zero real-fallback.
Fakes не используют реальные accounts/providers/network/service managers.
Watchdogs kill/reap CLI; known fake query cleanup проверяется отдельно.

```sh
cargo test --manifest-path rust/Cargo.toml --locked --test cli_runtime_status
cargo test --manifest-path rust/Cargo.toml --locked --bin pultd-rust cli_runtime_status
```

Помимо этих проверок нужны existing service/browser/agent/owner/wait/events CLI
regressions и all-targets Clippy/fmt. Перенос runtime install/update остаётся следующим
самостоятельным functional slice.
