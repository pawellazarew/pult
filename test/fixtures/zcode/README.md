# Фикстуры ZCode — сырые потоки `zcode -p --output-format stream-json`

Что это. Каждый `*.jsonl` — **дословный stdout** настоящего `zcode` (CLI 0.17.1), строка = одно
событие конверта `{eventId, seq, sessionId, turnId, timestamp, type, payload}` либо итоговая
компактная строка `{"type":"result", …}`. Проигрывает их `test/fakes/fake-zcode.mjs`.

- CLI: **ZCode 0.17.1** (`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`, GLM-5.3).
- Дата записи: **02.11.2026**, live-захваты в одноразовой папке: `01` и `02` — свежие сессии,
  `03` — второй ход той же сессии через `--resume` (ответ 420 помнит число 42 из хода `02`),
  `04` — ход, снятый SIGINT: `turn.completed {resultType:"cancelled"}`, exit 130, строки
  `result` НЕТ (замер: SIGINT печатает `Error: Turn was cancelled.` в stderr).
- Редакция: домашний путь — `/Users/you`, папка записи — `/tmp/pult-zcode`; из `session.updated`
  с `model_request_*` вырезаны `requestHeaders`/`responseHeaders` (килобайты заголовков, для
  адаптера не значимы). Остальное — как прислал CLI.
- Форма потока и выводы замеров — `docs/17-SPIKE-zcode.md` и шапка `src/adapters/zcode/mapper.ts`.

Ошибка входа/квоты/`--resume` без разговора фикстурами не записаны: они приходят только в stderr
(`Error: <код>` + exit 1), и `fake-zcode.mjs` воспроизводит их сам, сценариев файл не требует.
