# R5: проверка зависимостей упаковки

16.11.2026. Эта проверка относится к arm64-пакету нынешнего React/Electron окна. Она не подтверждает завершение Rust-миграции или рабочее переключение backend.

## Изменение

Для `@electron/universal` и `app-builder-lib` добавлены version-scoped overrides: только `minimatch >=7 <11.0.1` заменяется на закреплённый `11.0.1`. Исходные ветки `9.0.9` и `10.2.6` затронуты [GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).

Последние опубликованные electron-builder/app-builder-lib 26.18.0 всё ещё требуют старые major ranges; обновление родителя само по себе не решает этот пункт. В PR #155 версии родителей и Electron остались прежними; последующее обновление runtime описано ниже. Major3/5 в legacy callable потребителях остаются на прежних версиях; blanket override недопустим, поскольку их API отличается. Новый minimatch поддерживает Node18/20/>=22, что включает обе CI-линии проекта.

## Локальная проверка

- Воспроизводимый `npm ci` в корне и shell, `npm ls minimatch` без invalid dependencies. `npm audit` shell: 0 известных advisories на момент проверки. Это не инвентаризация встроенных компонентов Electron.
- 143808 сравнений на 1284 файлах/каталогах: для пяти действительных packaging patterns расхождений нет; legacy callable major3 сохранён. Найдены 14 отличий только в дополнительном исследовательском `**/.*` + matchBase + partial directory corpus. Общая семантическая эквивалентность всех globs не заявляется; эти отличия не скрыты и данный шаблон не используется в package configuration.
- TypeScript root/UI/shell, shell unit suite и настоящая `dist:mac` arm64-упаковка со свежесобранным pinned whisper.cpp прошли.
- Живой `check-app --launch` прошёл при внешнем `PULT_LANG=en`: fixture фиксирует RU для собственных RU log assertions. Первый прогон выявил три locale-only несовпадения и сохранён; production logging не менялся. Проверены настоящий запуск, package/bridge/tray, закрытие окна при живом демоне, блокировки Node/inspect/DYLD и отказ при подменённом app.asar.
- `check-app` подтверждает ad-hoc hardened-runtime подпись, fuses, arm64, protocol/icon/ATS и точный состав app.asar: package.json, два main/preload файла и две tray-картинки с каталогами.

## Инвентаризация компонентов

Сборка использует проверенный локальный Electron45.2.3 из закреплённого dependency. Его executable сообщает Chromium156.0.8078.80, встроенный Node24.22.2 и undici7.30.1. Это отличается от самостоятельного managed Node из runtime.env. npm override не обновляет встроенный runtime.

minimatch применяется сборщиком; app.asar не содержит node_modules. Это не доказательство отсутствия всех runtime-рисков: shell main/preload и код установленного Node-пакета остаются самостоятельными потребителями, Rust CLI ещё experimental. Финальный релиз должен повторить packaging/smoke на объединённом exact commit, проверить совместимый Node rollback и остальные пункты #110.


## Обновление runtime для 0.3.22

Shell закрепляет [Electron45.3.3](https://github.com/electron/electron/releases/tag/v45.3.3). Настоящий executable сообщает Chromium156.0.8078.100, Node24.22.3 и undici7.30.2. В upstream45.3.2 исправлена потеря недавно записанных cookies при выходе; обновление45.3.3 включает новый Node. Встроенные версии проверяются отдельно от npm audit.

`runtime.env` закрепляет [Node24.22.3](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases/) и четыре суммы из официального [SHASUMS256.txt](https://nodejs.org/dist/v24.22.3/SHASUMS256.txt). Временная установка настоящего arm64-архива проверяет отказ при неверной сумме с сохранением старого указателя, установку/запуск24.22.3, повторное использование без скачивания и возврат указателя к настоящему24.21.0. Это проверка managed Node, не рабочий Rust cutover.

На новом Electron повторены10 browser E2E при DPR1/2,715 UI/shell unit-проверок, типы и сборка; проверены сами координаты native/CDP. Оконный capture основного renderer не включает native child view: он не считается доказательством композитного снимка. Крупные observer PNG просмотрены отдельно. Полный договор — [фиксированный viewport](../21-BROWSER-FIXED-VIEWPORT.md).

Root/shell `npm ls --all` и audit проходят; запрос Dependabot16.11.2026 возвращает0 открытых alerts. Финальный release gate по-прежнему собирает и проверяет arm64-артефакт из опубликованного exact commit. Эти результаты не закрывают полный Rust-паритет, перенос окна и24h/7day приёмку.
