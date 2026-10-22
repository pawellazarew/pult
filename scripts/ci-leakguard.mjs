#!/usr/bin/env node
// ci-leakguard.mjs — страж утечек. Читает список файлов со stdin (по одному в строке),
// печатает `файл:строка: <правило> — <фрагмент>` по каждому попаданию и выходит 1, если их есть.
//
//   git ls-files | node scripts/ci-leakguard.mjs
//
// Все шаблоны живут ЗДЕСЬ, по одному комментарию на правило. Шаблоны написаны так, чтобы не
// ловить сами себя: после литерала (`sk-ant-`, `ghp_`, `eyJ`) в исходнике идёт `[`, который
// не входит ни в один из классов символов, — поэтому файл страж-скрипта проверяется наравне
// со всеми остальными и никаких исключений для него нет.
//
// Чего страж НЕ делает: он не разбирает base64 и не считает энтропию — это дало бы поток
// ложных срабатываний на логах спайка. Он ловит ФОРМЫ известных секретов.

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Пути, которые не сканируем, и почему:
//   spike/codex/schema/** — два сводных файла протокола Codex по ~0.6–0.9 МБ каждый:
//       машинно сгенерированы, человек их не пишет, а построчный проход по ним — самая
//       дорогая часть проверки.
// Файлы ресёрча раньше тоже пропускались; при подготовке к открытому коду (14.10.2026) они были вычищены,
// а в M9 вовсе ушли из публичного дерева (scripts/public-exclude.txt).
const SKIP = [
  /^spike\/codex\/schema\//,
]

// Почтовые адреса, которые разрешены в репозитории.
const EMAIL_ALLOW = [
  /^noreply@anthropic\.com$/i,          // подпись соавтора в коммитах и документах
  // RFC 2606 — example.com/org/net и любые их поддомены зарезервированы под примеры
  // (`password@proxy.example.com` из цитаты чужой документации — законный адрес-пример).
  /@(?:[A-Za-z0-9-]+\.)*example\.(com|org|net)$/i,
  /@(localhost|invalid|test)$/i,
  // RFC 2606 — зарезервированные домены верхнего уровня: `pult-test@example.invalid` в тестах.
  /@(?:[A-Za-z0-9-]+\.)+(?:invalid|test|example|localhost)$/i,
  // Внутренние имена машин-заглушки (`user@host.local`, `.internal`, `.lan`): в интернете таких ящиков нет.
  /@(?:[A-Za-z0-9-]+\.)+(?:local|internal|lan|localdomain)$/i,
]
// Домен верхнего уровня — ЛЮБОЙ: до 14.10.2026 список был закрытым, и адрес на `.tech` или `.kz`
// проходил мимо. Ложные срабатывания открытого шаблона разобраны узко, по форме, а не по «расширению»
// (`.md`, `.zip` — настоящие домены верхнего уровня):
//   * ретина-картинка `trayTemplate@2x.png` — `@<цифра>x.<расширение картинки>`;
//   * имя MCP-плагина `plugins.codex-app-tools@openai-bundled.mcp` из записанного спайком Codex списка процессов;
//   * версия пакета `pkg@1.0.0-beta.foo` — после `@` идёт semver.
const EMAIL_FALSE = [
  /@[1-9]x\.(?:png|jpe?g|gif|svg|webp|avif|heic|pdf|ico|icns)$/i,
  /@openai-bundled\.mcp$/,
  /@v?\d+\.\d+\.\d+/,
]

// Логины, для которых `/Users/<логин>`, `/home/<логин>` и их кодировка в именах папок проектов
// Claude (`-Users-<логин>-…`) — не утечка. Только заглушки: настоящий логин владельца в
// репозитории — такая же утечка, как любой другой (до 14.10.2026 он был в этом списке).
//   user/USER/you — заглушки в документации, тестах и вычищенных записях;
//   runner/ubuntu/root — служебные домашние папки раннеров CI;
//   Shared — общая папка macOS `/Users/Shared`, не логин (в ней кадры README держат папки сцены).
const HOME_ALLOW = ['runner', 'ubuntu', 'root', 'user', 'USER', 'you', 'Shared']

const RULES = [
  {
    name: 'email',
    // Любой почтовый адрес, кроме разрешённых выше: чужой ящик в репозитории — утечка.
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}\b/g,
    // Исключение по месту: строка `"deprecated": …` в package-lock.json — это публичное объявление
    // автора пакета из реестра npm (у glob@7 — адрес для платной поддержки), а не наша утечка.
    // Lock-файлы пишет npm, руками их не правят, поэтому разрешаем ровно эту форму строки.
    // Второе исключение по месту (M9): автор единственного коммита публичного дерева в scripts/public-tree.mjs —
    // строка `const AUTHOR = …`, и только она. Этот адрес и так публичен в метаданных коммита.
    ok: (hit, ctx) => EMAIL_ALLOW.some((a) => a.test(hit))
      || EMAIL_FALSE.some((a) => a.test(hit))
      || (/(^|\/)package-lock\.json$/.test(ctx.path) && /^\s*"deprecated":\s*"/.test(ctx.line))
      || (ctx.path === 'scripts/public-tree.mjs' && /^const AUTHOR = \{/.test(ctx.line)),
  },
  {
    name: 'anthropic-key',
    // Ключ Anthropic API: префикс sk-ant- и длинный хвост.
    re: /sk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    name: 'generic-sk-key',
    // Ключ в стиле OpenAI и совместимых: sk- и >= 20 символов хвоста.
    re: /\bsk-[A-Za-z0-9]{20,}/g,
  },
  {
    name: 'github-token',
    // Токены GitHub: классический ghp_/gho_/ghs_/ghr_ и новый github_pat_.
    re: /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  },
  {
    name: 'bearer',
    // Заголовок Authorization: Bearer с длинным значением.
    re: /Bearer[ \t]+[A-Za-z0-9._~+/-]{20,}=*/g,
  },
  {
    name: 'basic-auth',
    // Заголовок Authorization: Basic с длинным base64.
    re: /Authorization[ \t]*:[ \t]*Basic[ \t]+[A-Za-z0-9+/]{16,}=*/gi,
  },
  {
    name: 'jwt',
    // JWT: три сегмента base64url через точку; первый почти всегда начинается с eyJ.
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    name: 'credentials-content',
    // СОДЕРЖИМОЕ ~/.claude/.credentials.json и ~/.codex/auth.json, а не упоминание их имён:
    // ловим пару «ключ токена: непустая строка». Имя файла в документации проходит свободно.
    re: /"(?:access_?Token|refresh_?Token|id_?Token|client_?Secret|api_?Key|OPENAI_API_KEY|ANTHROPIC_API_KEY)"\s*:\s*"[^"]{8,}"/gi,
  },
  {
    name: 'foreign-home',
    // Абсолютный домашний путь настоящего пользователя — любой логин, кроме заглушек выше.
    re: /\/(?:Users|home)\/([A-Za-z0-9._-]+)/g,
    ok: (hit) => HOME_ALLOW.includes(hit.split('/')[2]),
  },
  {
    name: 'encoded-home',
    // Тот же путь в кодировке Claude Code: папка проекта `~/.claude/projects/-Users-<логин>-…`
    // (`/`, `.` и `_` заменены на `-`). Попадает в записанные потоки (`memory_paths`). Перед `-` — не буква,
    // не цифра и не `-` (`--home-bg-color` и флаг `--home-dir` — не путь); после логина — конец имени.
    re: /(?<![A-Za-z0-9-])-(?:Users|home)-([A-Za-z0-9]+)(?=[-/"'\s]|$)/g,
    ok: (hit) => HOME_ALLOW.includes(hit.split('-')[2]),
  },
  {
    name: 'macos-user-tmp',
    // Личная временная папка macOS `/var/folders/<2 знака>/<~30 знаков>/…` (или её кодировка через `-`),
    // с `/T` и без (`/C`, `/0` — кэш и прочее): случайная часть постоянна для пользователя машины — это
    // его отпечаток. Заглушка — нули и `gn`: `/var/folders/xy/0000000000000000000000000000gn/T`.
    // Случайная часть — два куска через `_` (в кодировке — `-`): `8nprsd6n…_qgx7…0000gp`; синтетика тестов
    // вида `-var-folders-xy-T-pult-…` под шаблон не попадает.
    re: /var[/-]folders[/-][A-Za-z0-9_]{2}[/-][A-Za-z0-9]{8,}[_-][A-Za-z0-9]{8,}/g,
    ok: (hit) => /^var[/-]folders[/-][A-Za-z0-9_]{2}[/-]0+gn(?:[/-]|$)/.test(hit),
  },
  {
    name: 'claude-artifact',
    // Ссылка на страницу claude.ai — артефакт аккаунта владельца (`claude.ai/artifact/<id>`,
    // `claude.ai/code/artifact/<uuid>`): снаружи она не открывается, а её адрес — личный след аккаунта.
    // Решение владельца 20.10.2026: в репозиторий не кладём, выводы со страницы переносим текстом.
    re: /claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]{6,}/g,
  },
]

// Правило `denied-token`: запрещённые слова хранятся ТОЛЬКО как sha256 в scripts/leak-deny.sha256 рядом
// со скриптом (сами слова в репозиторий не попадают). Тест-шов: PULT_LEAKGUARD_EXTRA_SHA256 — дайджесты
// через запятую, добавляются к файлу. Файла нет — стража нельзя считать работающим, выходим с ошибкой.
const DENY = new Set()
{
  const file = join(dirname(fileURLToPath(import.meta.url)), 'leak-deny.sha256')
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch {
    process.stderr.write('ci-leakguard: нет scripts/leak-deny.sha256\n')
    process.exit(1)
  }
  for (const l of raw.split('\n')) {
    const t = l.trim().toLowerCase()
    if (/^[0-9a-f]{64}$/.test(t)) DENY.add(t)
  }
  for (const t of (process.env.PULT_LEAKGUARD_EXTRA_SHA256 ?? '').split(',')) {
    const x = t.trim().toLowerCase()
    if (/^[0-9a-f]{64}$/.test(x)) DENY.add(x)
  }
}
const sha = (s) => createHash('sha256').update(s).digest('hex')
const TOKEN_RE = /[a-z0-9][a-z0-9.-]*[a-z0-9]/g
// Кандидаты из строки: максимальный токен и любой непрерывный отрезок его частей, разделённых `.`/`-`
// (покрывает точечные суффиксы `b.c.d` и отдельные метки). Возвращает множество дайджестов-попаданий.
function deniedDigests(line) {
  const found = new Set()
  for (const tok of line.toLowerCase().match(TOKEN_RE) ?? []) {
    const parts = tok.split(/([.-])/) // чётные — части, нечётные — разделители
    const n = (parts.length + 1) >> 1
    if (n > 64) { const d = sha(tok); if (DENY.has(d)) found.add(d); continue }
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const d = sha(parts.slice(2 * i, 2 * j + 1).join(''))
        if (DENY.has(d)) found.add(d)
      }
    }
  }
  return found
}

function readStdinList() {
  let raw = ''
  try { raw = readFileSync(0, 'utf8') } catch { raw = '' }
  return raw.split('\n').map((s) => s.trim()).filter(Boolean)
}

const files = readStdinList()
if (!files.length) {
  process.stderr.write('ci-leakguard: пустой список файлов\n')
  process.exit(1)
}

let scanned = 0
let skipped = 0
const hits = []

for (const path of files) {
  if (SKIP.some((re) => re.test(path))) { skipped++; continue }
  let buf
  try { buf = readFileSync(path) } catch { skipped++; continue }
  try { if (statSync(path).size === 0) { scanned++; continue } } catch { /* всё равно просканируем */ }
  // Двоичные файлы (tgz с заглушечными пакетами) пропускаем: искать в них строки бессмысленно.
  if (buf.subarray(0, 4096).includes(0)) { skipped++; continue }
  scanned++
  const lines = buf.toString('utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      let m
      while ((m = rule.re.exec(lines[i])) !== null) {
        const hit = m[0]
        if (rule.ok && rule.ok(hit, { path, line: lines[i] })) continue
        hits.push({ path, line: i + 1, rule: rule.name, hit: hit.slice(0, 120) })
      }
    }
    for (const d of deniedDigests(lines[i])) {
      hits.push({ path, line: i + 1, rule: 'denied-token', hit: `denied token (sha256 prefix ${d.slice(0, 8)})` })
    }
  }
}

if (hits.length) {
  process.stderr.write(`ci-leakguard: ПОПАДАНИЙ ${hits.length}\n`)
  for (const h of hits) process.stderr.write(`   ${h.path}:${h.line}: ${h.rule} — ${h.hit}\n`)
  process.exit(1)
}

process.stdout.write(`   ${scanned} файлов просканировано (${skipped} пропущено), ${RULES.length + 1} правил — чисто\n`)
