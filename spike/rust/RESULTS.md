# R1 local evidence — 2026-11-10

Status: **initial experiment, R1 acceptance incomplete**. No production backend was replaced.
Platform: macOS 26.6.2, arm64. Rust/Cargo 1.99.1, local minimal toolchain in a temporary directory;
no shell profile changes. Source build starts from Pult `6346ddd` (0.3.21).

## Verification

From `spike/rust`:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --release --locked
```

Local test result: 1 real-IO journal failure test and 10 integration tests passed. The integration
suite includes 100 real process lifecycle/replay cycles, writer exclusion, Unicode framing,
oversized stdout, 2 MB stderr flooding, a backed-up consumer, permission checks, SIGTERM,
quit/broken stdout with caller stdin still open, and SIGKILL after an acknowledged journal event.
The last local integration suite completed in 3.64 seconds; this is test duration, not product latency.
Linux/macOS CI runs the same tests; its result must be read on the PR rather than inferred here.

Review exposed and fixed three lifecycle problems before publication: a write/fsync failure could
leave the journal usable, stdout broken-pipe panic could skip awaited cleanup, and Tokio's blocking
stdin reader could prevent process exit until caller EOF. The current writer is poisoned after
uncertain write/sync failure; control errors enter cleanup; stdin uses a dedicated bounded reader thread.
Journal/lock files are mode 0600 and a new scratch home is 0700; accessible existing homes are rejected.

## Live Codex

Existing CLI: `codex-cli 0.167.0-alpha.3.2`. Two fresh scratch homes and work directories, existing
CLI account/configuration. Raw transcripts are retained only in private local temporary directories.

1. `pult-r1 --home <scratch> codex --bin <existing-codex> --cwd <scratch-cwd>`:
   initialized app-server, created a read-only thread and stopped/reaped the process; exit 0,
   observed wall time 0.851 s on the debug executable. No model turn requested.
2. Same command with explicit `--prompt 'Reply with the single word OK. Do not use tools or read files.'`:
   turn status `completed`, final agent message `OK`, exit 0; observed wall time 8.4 s. The private
   experiment journal contained 33 records and ended with `session.stopped`. One subscription turn.

These smoke observations preceded the final transport/error-handling hardening; the full deterministic
suite was rerun after those changes. They establish initial protocol viability, not full adapter parity
or sustained reliability. Provider startup includes the user's configured MCP integrations.

## Remaining gates

- SIGKILL of the prototype can orphan the provider process group. The crash test explicitly cleans
  it up. There is no supervisor/holder yet; this is **not** a full R1 crash-cleanup pass.
- A slow control stdout reader can block synchronous reply writes. Memory remains bounded, but
  responsive stop/TERM under this condition requires a nonblocking control transport.
- No matched Node/Rust memory/latency comparison, disk-full qualification, power-loss guarantees,
  descendant reaping qualification or long-running soak. R0 production baseline is a separate workload.
- The experiment does not implement Pult's production protocol, authentication, network guard,
  permission broker, questions, queue/steer, provider resume, UI or migration/rollback.

Next: close supervisor/control-output gaps, extend fault scenarios, then compare matched workloads
against R0 before deciding whether to start R2.

## Продолжение R1

Исправлены уборка управляемой группы после SIGKILL владельца и остановка при непрочитанном
stdout. Владелец группы вынесен в отдельный pult-r1-holder. Его готовность проверяется перед
успешным start. Последние строки естественно завершившегося провайдера сохраняются, а ошибки
запуска и forwarding приводят к отказу. Код 125 зарезервирован для ошибки наблюдателя.

Проверены 19 тестов с учётом отдельной проверки Unicode replay, включая 100 циклов,
TERM-игнорирующего провайдера с ребёнком, SIGKILL владельца, переполненный stdout,
несуществующую программу и естественный exit 7. Исходный бинарь проваливал новые проверки
SIGKILL и медленного вывода. Исправленный проходит их без вспомогательной уборки до вердикта.

Ограничения гарантии перечислены в README. Дочерние процессы с собственной группой через
setsid и принудительное убийство самого наблюдателя требуют отдельного решения. Таймаут
вывода равен одной секунде на ответ или batch. Для replay batch имеет целевой размер 64 KiB,
отдельная крупная запись допускается в пределах лимита 1 MiB.

В первой версии writer подтверждал каждую строку отдельно. Replay имел медиану 178 мс у Rust
и 99 мс у Node. Пакетирование при той же проверке данных дало 38 и 75 мс соответственно.
Медиана наблюдаемого RSS составила около 17 MiB у Rust и 72 MiB у Node. Сохранены оба
набора данных с hash бинаря и скриптов. Это измерение одной операции на фиксированной
ASCII-фикстуре, с ограничениями сравнения из compare/README.md.

- [Исходный replay](evidence/replay-before-batching.json)
- [Пакетированный replay](evidence/replay-batched.json)
- [Сборка и размеры бинарей](evidence/build-metrics.json)
- [Окно Electron и демон с подставными агентами](evidence/window-node24.json)

Release-сборка в новом target с уже скачанными зависимостями заняла 24,50 с,
повторная сборка без изменения кода 0,16 с. Два бинаря занимают 2 171 664 и 1 076 768 байт.
Замер окна с Node 24 показал 531–558 MiB суммарного RSS дерева процессов в последовательных
сценариях 0/1/10 тредов. Различия между сценариями включают прогрев и освобождение памяти.

Решение о полном переходе на Rust принято Павлом следующим сообщением. R2 начинается с
совместимого транспорта и каталога команд. Для переключения рабочего backend остаются
обязательными паритет поведения, корректность данных, права и откат по общему плану.
