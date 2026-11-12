# R3 — реестр и восстановление сессий

Rust читает `sessions.json`, выполняет миграцию доступа и восстанавливает записи при запуске.
Добавлены `agent.rename`, `agent.archive`, `agent.seen` и соответствующие команды CLI.
Каталог содержит 13 реализованных методов из 86. Работа продолжается в отдельном scratch-home.

## Восстановление

Нормализация сохраняет нынешние поля сессии, контекст, worktree, browser, настройки доступа,
очередь и вложения. Строки сохраняют JavaScript UTF-16, включая непарные surrogate.
Неизвестный режим доступа становится `read-only`. Дубликаты имён сохраняют порядок,
операция по имени изменяет первую подходящую запись, как в нынешнем реестре Node.

При запуске статусы, кроме `cold`, `done` и `failed`, переходят в `cold`.
Отсутствующая или опережающая журнал отметка прочтения получает последний ID общего журнала.
Начало последнего хода восстанавливается из последней реплики человека в файле сессии,
затем из последнего события, затем из времени создания записи.

Из очереди удаляются уже принятые реплики. Сопоставление использует пару `id` и `at`.
Подтверждения объединяются из общего журнала и файла сессии. Это сохраняет подтверждённую
отправку при потере обновления файла сессии. Остаток очереди ставится на паузу.
Восстановленные записи сохраняются перед публикацией сокета и токена демона.

У Node сравнение receipt строится конкатенацией с двоеточием. Для ручных данных возможна
коллизия, при которой исчезает ожидающая реплика. Rust сравнивает два строковых поля
отдельно. Receipt с отсутствующим или нестроковым `at` сохраняет ожидающую реплику.

## Миграция доступа

Версия 1 переводит прежние Claude-записи без явного режима в `inherit`.
При существующем `config.migrations.accessLevels.at` мигрируют только записи,
созданные строго раньше маркера. Новые записи сохраняют режим подтверждений.
Первая копия `sessions.json.bak-v1` сохраняется перед миграцией. Существующая копия
проверяется и повторно синхронизируется. Другие поля config сохраняются.

Поддержаны стандартные ISO-даты, RFC и распространённые legacy-формы. Грамматика V8
Date.parse поддержана частично. Неоднозначные короткие годы в legacy-формах исключаются из миграции. Нераспознанная дата существующего маркера останавливает
запуск с ошибкой. Повреждённые файлы, неподдерживаемая версия и небезопасные пути также
останавливают запуск. Исходные данные остаются доступными для исправления и повторной проверки.
Частично записанная первая backup-копия требует проверки перед следующей миграцией.

## Сохранение и команды

Сохранение создаёт приватный временный файл рядом с реестром, записывает и синхронизирует
данные, выполняет rename и синхронизирует каталог. Новый список публикуется в памяти после
успешного сохранения. Ошибка до rename сохраняет прежнее состояние памяти и файла.
Ошибка после rename имеет неизвестный исход и блокирует дальнейшие изменения до повторного
открытия реестра. Наблюдаемая внешняя правка файла вызывает ошибку вместо перезаписи.

`agent.rename` нормализует название и проверяет предел 60 Unicode code points.
Пустое название удаляет поле. `agent.archive` устанавливает или снимает признак архива.
`agent.seen` поддерживает ручную отметку непрочитанного и монотонный курсор прочтения.
При неизменной отметке повторный вызов завершается без записи на диск.
Ответ содержит превью очереди до 200 code points, полный текст остаётся в реестре.

Команды используют owner-токен и действуют через тот же RPC.

```sh
pultd-rust --home /absolute/scratch agent rename chat --title 'Починить сборку'
pultd-rust --home /absolute/scratch agent archive chat
pultd-rust --home /absolute/scratch agent unarchive chat
pultd-rust --home /absolute/scratch agent seen chat --unread
```

Глубина массивов при преобразовании имени ограничена 64 уровнями. Слишком большой ответ
возвращает явную ошибку с указанием, что изменение уже сохранено, и сохраняет соединение.

## Проверка и следующий шаг

`cargo test` проверяет отказы записи, fsync и rename, неизвестный исход после замены,
сохранность памяти, повторное открытие и обработку внешних правок.
`rust/tests/registry-interop.mjs` сравнивает восстановление и команды с настоящими
Node `createRegistry` и `createManager`. Проверяются миграции, повтор после отката,
UTF-16, очередь, CLI, испорченные данные, опасные пути и отсутствующая проекция receipt.

Далее переносятся запуск и начало хода, очередь исполнения, разрешения и адаптеры.
`agent.list` получит поля фактического доступа, фаз и внимания вместе с менеджером сессий.
Рабочее переключение и приёмка отката проходят по R5.


## Trusted lifecycle transactions

The public owner library API now offers insert, replace_checked,
update_checked, remove_checked and raw records(). This is not execution
authorization or the public agent.list projection. The host serializes one
writer, assigns a fresh SessionKey incarnation on creation, validates consent
and filesystem policy, and quiesces/revokes the old incarnation before removal.

replace_checked compares both the SessionKey and the exact prior metadata
snapshot, so delayed callbacks cannot restore older titles, approval, model
or queue fields. update_checked applies a synchronous patch to freshly read
metadata. Provider, cwd and creation identity cannot change through replacement.
Escaped ASCII names are canonicalized before duplicate detection/persistence.
A record is bounded below the RPC frame budget before writing.

All lifecycle writes share the existing atomic commit implementation and
post-rename poisoning. External edits remain untouched on conflict. Mutation
panics discard the patch without poisoning the caller's owner mutex; the host
installs panic_guard first to suppress panic-hook payloads. Record Debug shows
counts only, and malformed raw name access returns an empty name instead of
panicking. Stored names still require the validated canonical grammar.

12 registry tests include durable insertion, stale/recreated identities,
escaped duplicate names, external edits, callback failure/panic, privacy and
refusal to restore Full after a newer ReadOnly selection. The stale full-record
overwrite was reproduced RED before adding the metadata CAS.
