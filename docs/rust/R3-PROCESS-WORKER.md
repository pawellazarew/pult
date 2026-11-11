# R3: транспорт процесса и отдельный наблюдатель

`worker_process` запускает доверенно выбранный CLI через `pult-worker-holder`.
Это внутренний транспорт; клиентский RPC не получает возможность произвольного spawn.
Конкретные протоколы Codex/Claude/ZCode и подключение к production host следуют отдельно.

Launch содержит абсолютные holder/program/cwd, аргументы и заранее построенное
окружение. Запуск очищает ambient env. `worker_env::from_parent` переносит только
HOME/USER/PATH/LANG/TERM/TMPDIR; network/profile и scoped memory credential допускаются
лишь явными overrides. Owner token, переменные других агентов и loader hooks не
наследуются. Это совместимый с Node базовый allowlist, а не очистка по blacklist.
Общий Codex app-server не должен получать ключ одной сессии через этот общий env.

Holder устанавливает обработчики до старта CLI, проверяет владельца и создаёт
отдельную process group. При остановке или исчезновении родителя он завершает
принадлежащую ему группу и дожидается очистки. Drop транспортного объекта посылает
TERM наблюдателю; успешной очисткой считается только awaited stop с подтверждением.
Неизвестный результат сохраняется как ошибка, которую driver обязан держать в карантине.

Перед group cleanup нельзя освобождать PID лидера: освобождённый PID может быть переиспользован.
Поэтому holder наблюдает завершение через waitid(NOWAIT), сохраняет PID до TERM/KILL
группы и только потом вызывает wait. Безопасный rustix API используется и на macOS,
где nix 0.30 не экспортирует waitid. Linux subreaper дополнительно собирает потомков.
На macOS сигнал zombie-only группе может вернуть EPERM. Это не игнорируется:
при удерживаемом zombie-лидере требуются два одинаковых снимка состава группы,
и каждый участник должен быть zombie. Используются только PID/PGID/stat из
/bin/ps, без аргументов процессов; общий deadline 1 секунда и лимит вывода 2 MiB.
Любой живой/неоднозначный/исчезнувший участник или ошибка проверки даёт 125.

Process group не является песочницей против процесса, намеренно уходящего в другую
session/group: такой случай требует отдельного договора адаптера/OS containment.

Framing ограничен 1 MiB; stdout — JSON lines, очередь — 16 записей. stderr дренируется
в счётчик без сохранения текста. Startup ack исходит от holder до stdout CLI. Неверный
JSON, чрезмерный кадр и частичная/неизвестная отправка не выдаются за успешный обмен.
Реальный адаптер должен сохранить raw provider errors в безопасной диагностике,
не превращая stdout/stderr в неограниченный журнал секретов.

Проверки используют реальные subprocess fixtures: Unicode, ошибки framing, stderr
нагрузку, естественное завершение, остановку группы и исчезновение владельца.
Они не выполняют платные ходы и не запускают пользовательские Claude/Codex сессии.
Каталог RPC пока остаётся 27/98.

Код 125 зарезервирован для неподтверждённой очистки/доставки вывода; совпадающий
нативный exit code тоже трактуется консервативно. Остальные естественные exit codes
сохраняются. Это транспорт, а не перезапуск команд и не готовая sandbox policy.


## Codex framing profile

The default strict JSON-lines profile remains bounded to 1 MiB and fails on
malformed input. `Framing::codex()` explicitly permits up to 16 MiB of JSON
plus LF, matching the native app-server client. It drains oversized lines,
discards malformed/non-object JSON and unterminated tails, and resumes at the
next LF. Only a discard counter is exposed; raw bad lines are not logged.
The reader queue is one frame, with one additional frame potentially waiting
for enqueue. Allocation and decoding overhead are additional to wire bytes.

`take_output()` transfers the single receiver to a reader task while Process
retains the writer and cleanup guard. A second transfer or direct recv then
fails. Shutdown still bounds/aborts blocked reader tasks, including a held or
full transferred receiver; dropping Process still signals the holder.
This profile supplies transport plumbing, not a native Codex handshake,
thread authorization, permission broker or execution RPC.

Three real-process tests cover malformed/oversized recovery followed by large
Unicode replies and natural exit 7, and a 2 MiB roundtrip through a transferred
receiver, plus cleanup with a full or dropped receiver. A fragmented-reader test verifies oversized drain and truncated
EOF recovery. The previous process lifecycle tests remain required.
