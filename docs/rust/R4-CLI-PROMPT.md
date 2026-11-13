# R4 bare prompt CLI format

`agent prompt` и `session prompt` без `--wait` печатают started receipt:

```text
PULT_LANG=en pultd-rust --home /absolute/private-scratch agent prompt chat hello world
Turn turn-A started

PULT_LANG=ru pultd-rust --home /absolute/private-scratch session prompt chat 'hello world'
ход turn-A запущен

pultd-rust --home /absolute/private-scratch agent prompt chat hello --json
{"turnId":"turn-A","waiting":false}
```

Источник: `src/cli/main.ts:625–649` и `src/i18n/cli.en.ts:73` в исходном
`84e963329f32c5ebb5ce489671dea92174f727fa`. Bare JSON выбирает только turnId и
waiting:false; неизвестные поля start ACK в этот объект не попадают. Ответ
`queued` сохраняет весь receipt при `--json`, либо прежний локализованный текст.
Queued receipt никогда не вызывает agent.wait, в том числе с `--wait`.

Слова после имени объединяются одним пробелом, как Node positional.slice(3).join(' ').
Кавычки сохраняют пробелы внутри отдельного аргумента. `--` завершает разбор flags:
`prompt chat hello -- --queue second` отправляет текст `hello --queue second`.
Существующие Rust attachments и взаимное исключение queue/interrupt/steer сохраняются.
Пустой text вместе с attachments остаётся допустимым CLI input; Node trim rejection
в этот slice не переносится. Generic permissive TS flag parser не заменяет Clap.

Все prompt paths используют прежний OwnerClient и общий bounded emit. Prompt ACK
сохраняет ordinary response deadline 3 s; только последующий agent.wait получает
wait response policy. Нет отдельного auth/framing/stdout implementation, autostart
или retry. Scoped credentials отвергаются до чтения owner home/token/config/socket.
RPC errors сохраняют typed exits: timeout=2, blocked_network=4,
provider_unavailable/limited=5, остальные=1. Успешный ACK/queued receipt даёт 0.
Exit 3 остаётся результатом human-blocked wait; bare prompt не придумывает этот status.

Непустой string turnId обязателен для started ACK до любого success output или
последующего wait. Missing, null, number, object и empty string дают статическую
invalid_response ошибку и exit 1. Это сознательная malformed-ACK граница: Node
incidental behavior при missing turnId печатает `{"waiting":false}` с exit 0;
она отдельно зафиксирована actual oracle и не считается действительным start.
Queued ACK не является started и этого поля не требует.

## Qualification

Новый fake-socket oracle запускает actual Node CLI из freshly compiled dist и
Rust executable, проверяя формат, RU/EN, JSON, очередь, positional words, literal
`--` и RPC errors. Test-only Node --import preload блокирует child_process
spawn/exec/fork; это fail-fast fixture guard, не security sandbox. Перед запуском
socket уже слушает, HOME и PULT_HOME указывают в private scratch, все inherited
PULT_* path/credential overrides очищены. Настоящие daemon/service/provider и
аккаунты не запускаются.
Для Rust protected PULT_HOME отделён от explicit --home внутри того же scratch;
production home guard сохраняется. Каталоги home/run имеют права 0700.

Oracle требует Node 24 и compiled TS dist, как существующий rust-core CI:
`npm ci --ignore-scripts`, затем `node node_modules/typescript/bin/tsc -p tsconfig.json`
(или обычный CI npm build). Отсутствие prerequisite даёт failure, не skip. Локальный
npm использует отдельные пустые user/global config и persistent cache; глобальные
пакеты и пользовательские config не нужны.

Конкретные executed checks, hashes и результаты находятся в persistent handoff.
На macOS прошли 15 actual CLI wait/prompt tests (включая 14 paired Node/Rust
oracle cases и отдельное Node malformed-ACK наблюдение), 7 events-tail, 9 local-CLI
и 4 argument-parser regression cases. All-targets Clippy с -D warnings, fmt и
diff-check также прошли.
Этот slice не активирует agent.wait, не меняет catalog/backend и не квалифицирует
provider parity, installed service или cutover.
