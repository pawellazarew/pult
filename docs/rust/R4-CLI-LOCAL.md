# R4: локальные version/logs и alias session

Этот шаг добавляет локальные команды Rust preview CLI. Он не устанавливает службу,
не запускает daemon по требованию, не переключает production launcher и не меняет
Worker/Runtime/RPC catalog.

```sh
pultd-rust --version
pultd-rust -v
pultd-rust version
pultd-rust --home /absolute/private-scratch daemon logs
pultd-rust --home /absolute/private-scratch daemon logs -n 100
pultd-rust --home /absolute/private-scratch daemon logs --lines 100
pultd-rust --home /absolute/private-scratch session list
```

Все три version-формы печатают только `CARGO_PKG_VERSION` и newline. Они не требуют
`--home`, не читают filesystem/config/account и доступны даже при scoped credentials.
Это версия Rust crate, которая может отличаться от версии установленного TS launcher.

`session` — alias того же Clap `AgentAction`, с теми же аргументами, проверками и RPC,
что `agent`. Alias не расширяет partial execution contract и не включает провайдеры,
которые текущий Rust runtime не поддерживает.

`--home` остаётся обязательным для команд работы с состоянием. Без subcommand при
явном `--home` сохранён прежний `daemon status`. Production-home guard остаётся в
`checked_home`; новый log reader не читает `~/.pult` автоматически.

## daemon logs

Команда читает только `logs/pultd.log` в проверенном scratch home. Она не соединяется
с daemon, не читает owner token/display config и не создаёт `run`/логи/каталоги.
Отсутствующий лог — ошибка. `PULT_MEMORY_KEY`, `PULT_MEMORY_TURN_KEY`, `PULT_ASK_KEY`
или `PULT_RUNTIME_KEY`, включая пустое значение, отклоняются статической ошибкой
**до** `checked_home` и чтения состояния. Версия остаётся безвредным исключением.

Сохранена семантика `src/cli/main.ts` (`cmdDaemonLogs`, `num`, `out`):

- По умолчанию последние 50 непустых строк; пустота определяется ECMAScript trim,
  включая BOM. Исходные пробелы, CR и содержимое непустой строки сохраняются.
- Значение разбирается как decimal `parseInt`: `2junk`/`2.9` дают 2; отсутствие
  значения, invalid или infinity после overflow дают 50.
- `0` печатает все непустые строки (`slice(-0)`); `-2` пропускает первые две
  непустые строки (`slice(2)`); слишком большой skip печатает пустую строку.
- `-n`/`--n` имеет приоритет над `--lines`, если указаны оба. Отрицательное значение
  принимается и как `-n -2`, и как `--lines=-2`. Rust также принимает `--lines -2`;
  TS parser в этой отдельной форме воспринимает значение как flag и использует 50.
- UTF-8 decoding заменяет повреждённые последовательности на U+FFFD, как Node UTF-8
  read. Вывод заканчивается newline; пустой результат также печатает один newline.

Rust parser отклоняет неизвестные flags, лишние positional args и повтор одного
flag. Это явная граница относительно permissive TS parser. Нет passthrough в Node.

## Границы чтения

Reader фиксирует end offset из открытого файла и идёт с конца блоками 64 KiB;
новые append после этой точки относятся к следующему вызову. Большой файл с коротким
tail не загружается целиком. Read range ограничен 16 MiB, выбранный UTF-8 output —
4 MiB вместе с newline. Большие числа строк не вызывают allocation по величине N.
Буферы ограничены scan size и UTF-8 replacement expansion, а не полным размером файла.

Если для точного результата не хватает scan/output budget, возвращается ненулевой
exit и статическая ошибка **без частичного stdout**. В частности, `0`/negative могут
потребовать полного scan и честно отказать для большого файла. Reader не выбрасывает
молча длинную/неполную строку и не начинает читать с середины UTF-8 строки. Если файл
обрезан во время чтения, short read даёт явную ошибку; atomic snapshot при произвольной
параллельной перезаписи содержимого не обещается.

Home и `logs` открываются как directory FD; `openat` + NOFOLLOW защищает final file
и `logs` component от symlink escape. Final open имеет NONBLOCK; затем проверяется
regular-file metadata, поэтому FIFO/device/directory не читаются как лог.
Разрешён только безопасный API существующей `rustix`, без unsafe и новых зависимостей.

## Проверка

`rust/tests/cli_local_parity.rs` запускает настоящий executable: version без home,
scoped credential priority на invalid home, default/filter/count/UTF-8 contract,
missing/unsafe homes, unknown flags, symlink components/FIFO, 64 MiB sparse file tail,
scan/output limits без частичного stdout. Alias проверяется через настоящий local
Rust daemon и `agent.list`; provider не запускается. Изменений installed service,
аккаунтов и пользовательской конфигурации нет. Результаты конкретного прогона
публикуются отдельно в migration handoff.
