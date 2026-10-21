#!/bin/sh
# ci-check.sh — единственная команда проверки репозитория Пульта.
#
#   ./scripts/ci-check.sh
#
# Её же дословно запускает .github/workflows/ci.yml: то, что видит человек локально, и то, что
# видит CI, — одно и то же. Зависимостей нет: только git, node >= 22, npm и /bin/sh.
#
# Разделы:
#   A СИНТАКСИС      node --check по всем .mjs, sh -n по всем скриптам оболочки, shellcheck если есть
#   B ДАННЫЕ         все .json и .jsonl разбираются, plist XML-целый
#   D ОФЛАЙН-ТЕСТЫ   четыре теста без агентских CLI, без сети провайдеров, без секретов
#   E ПАКЕТ          npm ci, tsc (пакет и ui/), сборка dist/ и dist/ui, node --test (пакет и юнит интерфейса)
#   H ОКНО           shell/: npm ci, типы, юнит-тесты оболочки; e2e Electron — по PULT_E2E (см. раздел)
#   C ФАЙЛЫ СЛУЖБ    спайковые и СГЕНЕРИРОВАННЫЕ `pult daemon install --print`: systemd-analyze verify
#                    --user на Linux, plutil -lint на macOS (идёт после E: файлы рисует собранный CLI)
#   F СТРАЖ УТЕЧЕК   почта, токены, содержимое файлов кредов, чужие домашние пути
#   G ГЕРМЕТИЧНОСТЬ  git status до и после прогона обязан совпадать
#
# Чего этот CI НЕ делает и почему (осознанно, а не по забывчивости):
#   * не запускает spike/claude/run-all.sh и ни одну из проверок b1…b6 / s1 / s3 / s5 / s7 —
#     им нужен залогиненный `claude`, сеть до api.anthropic.com и квота подписки;
#   * не запускает spike/claude/offline/probe-flags.mjs и probe-notloggedin.mjs — они спавнят
#     настоящий бинарь `claude`, которого на раннере нет;
#   * не запускает spike/env/capture-env.mjs, locate-cli.mjs, claude-deadport.mjs — они меряют
#     конкретную машину владельца (её PATH, её CLI, её прокси); на раннере ответ бессмысленный;
#   * не запускает spike/codex/** и spike/opencode/** — им нужны `codex` и `opencode`;
#   * не загружает службы: launchctl bootstrap и systemctl --user enable остаются ручными
#     шагами (spike/env/HUMAN-STEPS.md).

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/pult-ci.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

header() { printf '\n== %s ==\n' "$1"; }
fail()   { printf '\nci-check: ПРОВАЛ — %s\n' "$1" >&2; exit 1; }

command -v git  >/dev/null 2>&1 || fail 'нет git'
command -v node >/dev/null 2>&1 || fail 'нет node'
# npm нужен ровно одному офлайн-тесту — test-update.mjs ставит заглушечный tgz с --offline.
# Проверяем заранее: без этого тест падает стеком ENOENT readlink '.pult/current', по которому
# настоящая причина («npm не найден») не читается.
command -v npm  >/dev/null 2>&1 || fail 'нет npm (его требует офлайн-тест spike/env/test-update.mjs)'
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail 'запускать только внутри git-репозитория'

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || fail "нужен node >= 22, найден $(node -v)"
printf 'ci-check: %s · node %s · %s\n' "$ROOT" "$(node -v)" "$(uname -s)"

# Слепок состояния дерева ДО прогона. В конце сверяем с таким же слепком: проверка обязана
# быть герметичной, и тест, который начал писать в рабочее дерево, должен ронять CI, а не
# молча портить checkout (ровно так вёл себя test-launch.mjs, пока не переехал в mkdtemp).
# Сверяем именно ДО/ПОСЛЕ, а не «пусто/непусто»: у человека дерево может быть грязным и без нас.
git status --porcelain > "$TMP/status-before"

# Списки файлов берём из git: проверяем ровно то, что лежит в репозитории, и ничего лишнего.
git ls-files > "$TMP/tracked"
# ...но для СИНТАКСИСА этого мало: новый .mjs со сломанным разбором, который ещё не попал под
# `git add`, локально прошёл бы мимо проверки и дал ложное «OK» прямо перед коммитом. Поэтому
# синтаксис смотрим и по неотслеживаемым файлам (кроме игнорируемых .gitignore).
git ls-files --others --exclude-standard > "$TMP/untracked"
cat "$TMP/tracked" "$TMP/untracked" > "$TMP/all"
UNTRACKED_N=$(wc -l < "$TMP/untracked" | tr -d ' ')

grep -E '\.mjs$'   "$TMP/all"     > "$TMP/mjs"   || true
grep -E '\.json$'  "$TMP/tracked" > "$TMP/json"  || true
grep -E '\.jsonl$' "$TMP/tracked" > "$TMP/jsonl" || true
# Скрипты оболочки: *.sh плюс файлы без расширения — лаунчеры службы (спайковый и продуктовый), лаунчер
# команды `service/pult` и заглушки node, которые pultd-launch запускает как /bin/sh-скрипты.
{
  grep -E '\.sh$' "$TMP/all" || true
  grep -E '^spike/env/service/pultd-launch$' "$TMP/all" || true
  grep -E '^service/pultd-launch$' "$TMP/all" || true
  grep -E '^service/pult$' "$TMP/all" || true
  grep -E '^spike/env/stubs/' "$TMP/all" || true
} > "$TMP/sh"

MJS_N=$(wc -l < "$TMP/mjs" | tr -d ' ')
JSON_N=$(wc -l < "$TMP/json" | tr -d ' ')
JSONL_N=$(wc -l < "$TMP/jsonl" | tr -d ' ')
SH_N=$(wc -l < "$TMP/sh" | tr -d ' ')

# ---------------------------------------------------------------- A. СИНТАКСИС
header "A. СИНТАКСИС ($MJS_N mjs, $SH_N sh)"

while IFS= read -r f; do
  [ -n "$f" ] || continue
  node --check "$f" || fail "node --check: $f"
done < "$TMP/mjs"
printf '   node --check: %s файлов — чисто\n' "$MJS_N"

while IFS= read -r f; do
  [ -n "$f" ] || continue
  sh -n "$f" || fail "sh -n: $f"
done < "$TMP/sh"
printf '   sh -n: %s файлов — чисто\n' "$SH_N"
if [ "$UNTRACKED_N" -gt 0 ]; then
  printf '   (в синтаксис попали и неотслеживаемые файлы, всего их %s)\n' "$UNTRACKED_N"
fi

# Утилита shellcheck необязательна: её отсутствие не должно ронять сборку, но если она есть,
# ошибки уровня error мы смотрим. Осторожно: комментарий, начинающийся со слова shellcheck,
# считается директивой самого линтера и роняет его с SC1073 — поэтому строка начата иначе.
if command -v shellcheck >/dev/null 2>&1; then
  # shellcheck disable=SC2046
  shellcheck --severity=error --shell=sh $(cat "$TMP/sh") || fail 'shellcheck --severity=error'
  printf '   shellcheck --severity=error: чисто\n'
else
  printf '   shellcheck: не установлен — пропущено (это не ошибка)\n'
fi

# ------------------------------------------------------------------- B. ДАННЫЕ
header "B. ДАННЫЕ ($JSON_N json, $JSONL_N jsonl)"

node scripts/ci-data.mjs json  < "$TMP/json"  || fail 'json не разбирается'
node scripts/ci-data.mjs jsonl < "$TMP/jsonl" || fail 'jsonl не разбирается'

PLIST=spike/env/service/dev.pult.daemon.plist
node scripts/ci-data.mjs plist "$PLIST" </dev/null || fail 'plist не well-formed'
printf '   plist well-formed: %s\n' "$PLIST"

# ------------------------------------------------------------ D. ОФЛАЙН-ТЕСТЫ
# Ни один из них не трогает агентские CLI, сеть провайдеров, секреты и рабочее дерево:
# всё состояние — во временных папках, которые тесты сами за собой сносят.
TESTS='spike/claude/offline/test-mcp-stub.mjs spike/env/test-socket.mjs spike/env/test-launch.mjs spike/env/test-update.mjs'
TESTS_N=$(printf '%s\n' $TESTS | wc -l | tr -d ' ')
header "D. ОФЛАЙН-ТЕСТЫ ($TESTS_N)"

for t in $TESTS; do
  name=$(basename "$t")
  printf '   %-22s ' "$name"
  if node "$t" > "$TMP/$name.out" 2>&1; then
    printf 'ok — %s\n' "$(tail -n 1 "$TMP/$name.out" | cut -c1-120)"
  else
    printf 'ПРОВАЛ\n'
    tail -n 40 "$TMP/$name.out" >&2
    fail "офлайн-тест $t"
  fi
done

# ------------------------------------------------------------------ E. ПАКЕТ
# Пакет `pult` (Ф1): установка ровно по lock-файлу, проверка типов, сборка, тесты.
# ПОЧЕМУ `npm ci`, а не `npm install`: ci ставит строго то, что записано в package-lock.json,
# и падает, если lock разошёлся с package.json, — именно этого мы от проверки и хотим.
# ПОЧЕМУ условие на существование файла: до Ф1 в репозитории пакета не было, и секция должна
# так же молча пропускаться, если однажды пакет из дерева уедет.
# ГЕРМЕТИЧНОСТЬ: node_modules/, dist/ и dist-test/ перечислены в .gitignore, поэтому секция G
# после этой секции видит то же дерево, что и до неё. Тесты пакета держат своё состояние в
# mkdtemp под TMPDIR и настоящий ~/.pult не трогают.
if [ -f package.json ]; then
  header 'E. ПАКЕТ'
  npm ci --no-audit --no-fund > "$TMP/npm-ci.out" 2>&1 || {
    tail -n 40 "$TMP/npm-ci.out" >&2
    fail 'npm ci'
  }
  printf '   npm ci: %s\n' "$(grep -Eo 'added [0-9]+ package[s]?' "$TMP/npm-ci.out" | head -n 1 || echo 'готово')"
  npm run typecheck > "$TMP/typecheck.out" 2>&1 || { tail -n 40 "$TMP/typecheck.out" >&2; fail 'npm run typecheck'; }
  printf '   npm run typecheck: чисто\n'
  npm run build > "$TMP/build.out" 2>&1 || { tail -n 40 "$TMP/build.out" >&2; fail 'npm run build'; }
  printf '   npm run build: dist и dist-test собраны\n'
  # При провале печатаем КАЖДЫЙ непрошедший тест с его YAML-блоком, а не слепой хвост:
  # `tail` показывал последние ОК-тесты и счётчики, но ни одного имени `not ok`, и диагноз
  # «# cancelled 2» приходилось добывать вторым прогоном вслепую. Хвост остался запасным
  # выходом на случай, когда на входе не TAP (процесс умер раньше вывода).
  npm test > "$TMP/test.out" 2>&1 || {
    node scripts/ci-test-report.mjs "$TMP/test.out" || tail -n 60 "$TMP/test.out" >&2
    fail 'npm test'
  }
  printf '   npm test: %s\n' "$(grep -Eo '(tests|pass|fail) [0-9]+' "$TMP/test.out" | tr '\n' ' ')"
else
  header 'E. ПАКЕТ'
  printf '   package.json нет — секция пропущена\n'
fi

# ------------------------------------------------------------------ H. ОКНО
# Оболочка Electron (Ф2, docs/12): отдельный пакет shell/ со своим lock-файлом — Electron и его
# инструменты живут только там, у пакета pult рантайм-зависимостей нет.
# Типы и юнит-тесты оболочки — всегда. e2e (настоящий Electron на фальшивых CLI) — по PULT_E2E:
#   1 — гонять, 0 — пропустить, auto (по умолчанию) — гонять только на macOS.
# ПОЧЕМУ не на Linux: окно — macOS-приложение владельца, а Electron на раннере ubuntu требует
# X-сервер (xvfb) ради проверки, которая ничего не добавит к маковской. CI решает сам:
# workflow ставит PULT_E2E=1 на ноге macos, только когда менялись ui/, shell/ или src/.
# `npm ci` бинарь Electron не качает (с Electron 44 он докачивается при первом require) —
# поэтому нога без e2e не платит за ~100 МБ загрузки.
if [ -f shell/package.json ]; then
  header 'H. ОКНО (shell/)'
  (cd shell && npm ci --no-audit --no-fund) > "$TMP/shell-ci.out" 2>&1 || { tail -n 40 "$TMP/shell-ci.out" >&2; fail 'shell: npm ci'; }
  printf '   npm ci: %s\n' "$(grep -Eo 'added [0-9]+ package[s]?' "$TMP/shell-ci.out" | head -n 1 || echo 'готово')"
  (cd shell && npm run typecheck) > "$TMP/shell-tc.out" 2>&1 || { tail -n 40 "$TMP/shell-tc.out" >&2; fail 'shell: npm run typecheck'; }
  printf '   npm run typecheck: чисто\n'
  (cd shell && npm test) > "$TMP/shell-test.out" 2>&1 || {
    node scripts/ci-test-report.mjs "$TMP/shell-test.out" || tail -n 60 "$TMP/shell-test.out" >&2
    fail 'shell: npm test'
  }
  printf '   npm test (юнит оболочки): %s\n' "$(grep -Eo '(tests|pass|fail) [0-9]+' "$TMP/shell-test.out" | tr '\n' ' ')"
  E2E=${PULT_E2E:-auto}
  if [ "$E2E" = auto ]; then
    if [ "$(uname -s)" = Darwin ]; then E2E=1; else E2E=0; fi
  fi
  if [ "$E2E" = 1 ]; then
    (cd shell && npm run e2e) > "$TMP/shell-e2e.out" 2>&1 || {
      node scripts/ci-test-report.mjs "$TMP/shell-e2e.out" || tail -n 80 "$TMP/shell-e2e.out" >&2
      # Полный вывод (с call log Playwright, который выжимка режет) — рядом с кадрами и логами
      # прогона: CI выкладывает shell/test-results/ артефактом.
      mkdir -p shell/test-results && cp "$TMP/shell-e2e.out" shell/test-results/e2e-output.txt
      fail 'shell: npm run e2e'
    }
    # Размер окна, в котором шёл прогон: на раннере CI экран меньше, чем у разработчика.
    printf '   %s\n' "$(grep -Eo 'e2e [^ ]+: окно .*' "$TMP/shell-e2e.out" | head -n 1)"
    printf '   npm run e2e (Electron): %s\n' "$(grep -Eo '(tests|pass|fail) [0-9]+' "$TMP/shell-e2e.out" | tr '\n' ' ')"
  else
    printf '   e2e Electron: пропущено (PULT_E2E=%s, %s)\n' "${PULT_E2E:-auto}" "$(uname -s)"
  fi
fi

# ------------------------------------------------------------- C. ФАЙЛЫ СЛУЖБ
UNIT=spike/env/service/pultd.service
header 'C. ФАЙЛЫ СЛУЖБ'


# ЧТО здесь проверяется:
#   Linux — systemd-analyze verify --user на КОПИИ юнита, в которой подставлены спецификаторы:
#           %h -> временный домашний каталог, а ExecStart -> реально существующий исполняемый
#           файл (иначе verify справедливо ругается на несуществующую программу). Это первая
#           настоящая проверка юнита: спайк делался на macOS, где systemd нет, и S9c честно
#           записал «unit verdict partial» (spike/env/validate-service.mjs).
#   macOS — plutil -lint на plist.
# ЧЕГО здесь НЕТ: служба не загружается (ни launchctl bootstrap, ни systemctl --user enable),
# юнит не проверяется на той машине, где он реально будет жить, и содержательные ключи plist
# (KeepAlive, ThrottleInterval, ProcessType) на Linux не смотрятся — там нет plutil.
case "$(uname -s)" in
  Linux)
    if command -v systemd-analyze >/dev/null 2>&1; then
      FAKE_HOME="$TMP/home"
      FAKE_EXEC="$FAKE_HOME/.pult/bin/pultd-launch"
      mkdir -p "$FAKE_HOME/.pult/bin" "$FAKE_HOME/.pult/logs"
      printf '#!/bin/sh\nexit 0\n' > "$FAKE_EXEC"
      chmod 755 "$FAKE_EXEC"
      sed -e "s|%h|$FAKE_HOME|g" "$UNIT" > "$TMP/pultd.service"
      if systemd-analyze --user verify "$TMP/pultd.service" > "$TMP/systemd.out" 2>&1; then
        # ПОЧЕМУ мало кода возврата: опечатку в имени директивы systemd считает не ошибкой,
        # а поводом для предупреждения «Unknown key name …, ignoring» — и выходит 0. Такой
        # юнит собирается, но делает не то, что написано, поэтому предупреждения о разборе
        # мы приравниваем к провалу. Остальной вывод (если он есть) просто показываем.
        if grep -Eq 'Unknown key|Unknown lvalue|Unknown section|Failed to parse|Invalid section' "$TMP/systemd.out"; then
          sed 's/^/   | /' "$TMP/systemd.out" >&2
          fail "systemd-analyze --user verify: юнит разобран с предупреждениями — $UNIT"
        fi
        printf '   systemd-analyze --user verify: чисто\n'
        if [ -s "$TMP/systemd.out" ]; then sed 's/^/   | /' "$TMP/systemd.out"; fi
      else
        sed 's/^/   | /' "$TMP/systemd.out" >&2
        fail "systemd-analyze --user verify: $UNIT"
      fi
    else
      printf '   systemd-analyze: не установлен — юнит не проверен\n'
    fi
    ;;
  Darwin)
    plutil -lint "$PLIST" || fail "plutil -lint: $PLIST"
    printf '   systemd-analyze: на macOS его нет — юнит проверяется на ветке ubuntu\n'
    ;;
  *)
    printf '   неизвестная ОС — файлы служб не проверены\n'
    ;;
esac

# СГЕНЕРИРОВАННЫЕ файлы службы (В4, docs/08 §9). Спайковые файлы выше — улика спайка, а служба
# владельца ставится из того, что рисует `pult daemon install`. Поэтому проверяем именно его вывод:
# `--print --json` на обе платформы (шов PULT_SERVICE_PLATFORM работает только при PULT_TEST=1),
# с PULT_HOME, в котором есть пробел, `&` и `%`, — ровно то, что ломает XML и спецификаторы systemd.
# Раздел идёт ПОСЛЕ E: файлы рисует собранный dist/cli/main.js.
# `--print` обязан ничего не писать — это тоже проверяется: PULT_HOME после него не существует.
if [ -f dist/cli/main.js ]; then
  GEN_USERHOME="$TMP/genhome"
  GEN_HOME="$TMP/gen home & 100%/.pult"
  mkdir -p "$GEN_USERHOME"
  for plat in darwin linux; do
    HOME="$GEN_USERHOME" PULT_TEST=1 PULT_SERVICE_PLATFORM=$plat PULT_HOME="$GEN_HOME" \
      node dist/cli/main.js daemon install --print --json > "$TMP/gen-$plat.json" 2> "$TMP/gen-$plat.err" || {
        cat "$TMP/gen-$plat.err" >&2
        fail "pult daemon install --print ($plat)"
      }
    node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).content)' \
      "$TMP/gen-$plat.json" > "$TMP/gen-$plat.out" || fail "вывод --print --json не разобран ($plat)"
  done
  [ ! -e "$GEN_HOME" ] || fail 'pult daemon install --print создал PULT_HOME — он обязан ничего не писать'
  cp "$TMP/gen-darwin.out" "$TMP/gen.plist"
  node scripts/ci-data.mjs plist "$TMP/gen.plist" </dev/null || fail 'сгенерированный plist не well-formed'
  printf '   сгенерированный plist well-formed (PULT_HOME с пробелом, & и %%)\n'

  case "$(uname -s)" in
    Darwin)
      plutil -lint "$TMP/gen.plist" > "$TMP/gen-plutil.out" 2>&1 || { cat "$TMP/gen-plutil.out" >&2; fail 'plutil -lint: сгенерированный plist'; }
      printf '   plutil -lint (сгенерированный plist): OK\n'
      ;;
    Linux)
      if command -v systemd-analyze >/dev/null 2>&1; then
        # Юнит ссылается на лаунчер и журнал внутри PULT_HOME — verify справедливо ругается на
        # несуществующую программу, поэтому кладём исполняемую заглушку по тому же пути.
        # Спецификаторов в сгенерированном юните нет (PULT_HOME абсолютный), кроме `%%` — его
        # systemd разрешает сам; копия нужна только ради имени файла `*.service`.
        mkdir -p "$GEN_HOME/bin" "$GEN_HOME/logs" "$TMP/gen-unit"
        printf '#!/bin/sh\nexit 0\n' > "$GEN_HOME/bin/pultd-launch"
        chmod 755 "$GEN_HOME/bin/pultd-launch"
        cp "$TMP/gen-linux.out" "$TMP/gen-unit/pultd.service"
        systemd-analyze --user verify "$TMP/gen-unit/pultd.service" > "$TMP/gen-systemd.out" 2>&1 || {
          sed 's/^/   | /' "$TMP/gen-systemd.out" >&2
          fail 'systemd-analyze --user verify: сгенерированный юнит'
        }
        # Код 0 ничего не доказывает: на неизвестную директиву verify пишет «Unknown key name …,
        # ignoring» и выходит с 0. Читаем вывод — но только строки про НАШ файл: раннер несёт свои
        # системные юниты, и их предупреждения к нам отношения не имеют.
        if grep -F 'pultd.service' "$TMP/gen-systemd.out" \
             | grep -Eqi 'unknown|failed|invalid|ignoring|not executable|bad-setting|missing'; then
          sed 's/^/   | /' "$TMP/gen-systemd.out" >&2
          fail 'systemd-analyze --user verify: сгенерированный юнит разобран с предупреждениями'
        fi
        printf '   systemd-analyze --user verify (сгенерированный юнит): чисто\n'
        if [ -s "$TMP/gen-systemd.out" ]; then sed 's/^/   | /' "$TMP/gen-systemd.out"; fi
      else
        printf '   systemd-analyze: не установлен — сгенерированный юнит не проверен\n'
      fi
      ;;
  esac
else
  printf '   dist/cli/main.js нет — сгенерированные файлы служб не проверены\n'
fi

# ----------------------------------------------------------- F. СТРАЖ УТЕЧЕК
header 'F. СТРАЖ УТЕЧЕК'
node scripts/ci-leakguard.mjs < "$TMP/tracked" || fail 'страж утечек нашёл попадания'

# --------------------------------------------------------- G. ГЕРМЕТИЧНОСТЬ
header 'G. ГЕРМЕТИЧНОСТЬ'
git status --porcelain > "$TMP/status-after"
if ! diff -u "$TMP/status-before" "$TMP/status-after" > "$TMP/status.diff" 2>&1; then
  sed 's/^/   | /' "$TMP/status.diff" >&2
  fail 'прогон изменил рабочее дерево (см. разницу git status выше)'
fi
printf '   git status до и после прогона совпадает\n'

printf '\nci-check: OK (%s mjs, %s json, %s jsonl, %s офлайн-тестов)\n' \
  "$MJS_N" "$JSON_N" "$JSONL_N" "$TESTS_N"
