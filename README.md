# Pult

**English** · [Русский](README.ru.md)

**Run several Claude Code and Codex agents in the background and answer all their permission questions in one place.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/hero-light.png">
  <img alt="The Pult window: conversations grouped by project on the left, a Claude conversation in the middle and collapsed tool activity" src="docs/images/hero-light.png" width="100%">
</picture>

> [!NOTE]
> **The window and the CLI messages are in Russian for now.** Commands and flags are English, and this README
> explains what the important messages mean. The screenshots show the Russian interface.

## What it does

- **Agents keep working when you walk away.** Start a Claude Code or Codex agent in a project folder; it keeps
  working after you close the terminal or the window, and its conversation survives a reboot (a turn that was running
  at that moment is interrupted).
- **One Inbox for every question.** Whenever any agent wants to run a command or edit a file it asks about, the
  question lands in one list. Answer from the window or from the terminal.
- **Your own CLIs and subscriptions.** Pult starts the `claude` and `codex` you already installed and logged into.
  It has no account and no server, and it never reads your tokens.
- **A window and a CLI over the same agents.** Everything you do in the window you can script with `pult …`.

## How it works

```
you ──▶ pult (CLI) or Pult.app (window) ──▶ pultd (background daemon) ──▶ your own claude / codex processes
```

`pultd` is a small background process that starts the agents, keeps their conversations and collects their questions.
Everything it does is written to an event journal in `~/.pult`, so the CLI and the window always show the same state.

### Words used below

| term | meaning |
|---|---|
| **session** (also *agent*) | one conversation with Claude or Codex, tied to a folder. `pult session …` and `pult agent …` are the same command. |
| **turn** | one message from you and everything the agent does until it answers. |
| **daemon** | `pultd`, the background process. Any command starts it when needed. |
| **Inbox** | the list of questions waiting for your decision. |
| **approval mode** | how much a session may do without asking you (table [below](#inbox-and-approval-modes)). |
| **model / effort** | which model the CLI uses and how hard it thinks (`low` … `max`); passed to the CLI as is. |
| **warm** | `--warm` keeps the `claude` process alive between messages (1–2 s faster per message). |
| **worktree** | a separate git working copy on its own branch, so two agents don't edit the same files. |

## Requirements

- **macOS on Apple Silicon** (daemon, CLI and window) **or Linux** (daemon and CLI; there is no window on Linux).
- `git`.
- At least one CLI installed **and logged in**: `claude` (Claude Code; log in with `claude /login`) or `codex`
  (Codex CLI; `codex login`). You don't need both. Pult never shows a login form: you always log in yourself, in a
  terminal.
- Node.js is optional: if there is no `node` 22 or newer in `PATH`, the installer downloads the official nodejs.org
  build pinned in the package, checks its sha256 and keeps it inside `~/.pult/runtime`.
- Be ready for a **Russian interface** (see the note above).

## Install

### 1. The CLI and the daemon

The installer is a plain POSIX `sh` script. Download it, read it, then run it:

```sh
curl -q --proto '=https' -fsSLO https://github.com/pawellazarew/pult/releases/latest/download/install.sh
less install.sh
sh install.sh --from https://github.com/pawellazarew/pult/releases/latest/download/pult.tgz
```

It installs into `~/.pult` (change with `--home`), links `~/.local/bin/pult` (`--bin-dir`), installs a user service
(launchd on macOS, `systemd --user` on Linux; skip it with `--no-service`) and runs `pult doctor --no-net`. It does not
use sudo, does not install Node system-wide and does not edit your shell profile.

**`pult: command not found`?** `~/.local/bin` is not in your `PATH`. Add it and open a new terminal:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc     # bash: ~/.bashrc
```

**What a good result looks like.** The last line of `pult doctor` counts the checks, for example
`итог: ok 18 · warn 3 · fail 0` ("total"). A few `[warn]` lines are normal on a fresh install, e.g.
`[warn] Демон pultd: не отвечает (это нормально: демон поднимается по требованию)` — "daemon not running yet; it starts
on demand". A line that needs action is followed by `почини:` ("fix:") and the exact command to run.

### 2. The window (macOS, Apple Silicon)

Install the CLI first: `Pult.app` does not bundle Pult itself, it uses the copy in `~/.pult`. Then:

```sh
curl -q --proto '=https' -fsSLO https://github.com/pawellazarew/pult/releases/latest/download/Pult-arm64.zip
ditto -x -k Pult-arm64.zip /Applications
pult ui
```

Or download [`Pult-arm64.zip`](https://github.com/pawellazarew/pult/releases/latest/download/Pult-arm64.zip) in a
browser, unzip it, move `Pult.app` to `/Applications` and run `pult ui` (or open the app from Launchpad).

Since 0.3.16 the window has the same version number as Pult, and `Pult-arm64.zip` from the latest release always
matches the latest Pult; after that, the window updates together with Pult (see [Updates](#updates)). If `pult ui` finds no `Pult.app` in `/Applications` or `~/Applications`, it exits with code 1 and
prints how to build the window from source.

**If macOS refuses to open it.** `Pult.app` is ad-hoc signed and **not notarized** (there is no Apple Developer
certificate behind it). A zip downloaded with `curl` usually opens without a prompt, because curl does not mark files as
downloaded from the internet; a browser download does, and macOS may block the first launch ("Apple could not
verify…"). In that case:

1. Try to open `Pult.app` once and close the warning.
2. Open **System Settings → Privacy & Security**, scroll down to the message about Pult and click **Open Anyway**
   (the button only appears after a blocked attempt), then confirm.

You may have to do this again for each new window version.

### From source

```sh
git clone https://github.com/pawellazarew/pult.git && cd pult
npm ci && npm run build
node dist/cli/main.js doctor                 # the CLI from this checkout
cd shell && npm ci && npm start              # the window from this checkout (macOS)
```

How Pult is built and tested: [`docs/DEV.md`](docs/DEV.md) (in Russian).

## Quick start

Pick a project folder — a git repository is recommended, so you can review and undo what the agent changed. It can't
be `PULT_HOME` (`~/.pult`) or a folder above it such as `~`: an agent that edits files without asking would be able to
rewrite Pult's own `config.json`. If your `PULT_HOME` lives elsewhere and you pick your home folder anyway, Pult warns
you: the agent could change `~/.claude`, `~/.codex`, `~/.zshrc` and the like without asking.

```sh
pult doctor                                                   # everything in place?
pult agent start w --kind claude --cwd ~/code/app             # a session named "w"; --kind codex for Codex
pult agent prompt w "fix the failing test" --wait             # send a message and wait until the turn ends
pult agent read w                                             # what the agent said
```

Session names are short Latin keys (`w`, `fix-login`); a human-readable title can be set later with
`pult agent rename w "Fix the login test"`.

**When the agent needs you.** `--wait` exits with code **3** when the turn stops at a question (for example, the agent
wants to run a command outside its folder). Then:

```sh
pult perm list                                                # id, session, tool and what exactly it wants to do
pult perm approve <id>                                        # or: pult perm deny <id> --reason "not on prod"
pult agent wait w                                             # wait for the rest of the turn
```

**Same session in the window.** Run `pult ui`: the session shows up under its project folder on the left, with the
whole conversation. Closing the window does not stop the agent. While a turn runs, one live line under your last message says what
it is doing right now, with a seconds counter — starting, thinking, writing, running `Bash npm test`, or waiting for
you (with a link to the Inbox card); reasoning text, when the provider streams it, sits under a collapsed
"Размышления". The line is never written to the event journal.

The sidebar groups chats inside expandable projects. Click a project to open its conversations; project order
stays fixed. A chat moves to the top once, when you send it a message (from the window, the queue or the CLI), and
then stays put while the turn runs, after it ends and while background tasks report in. Long lists have a “Show more” button, keeping the selected
and busy chats visible. “Working” and “Waiting” filters narrow the project tree. Collapsed projects show activity
and attention counts; each project has its own new-chat button and menu.
Recent conversations remain below the projects. Drag their separator, use its arrow keys, or double-click to
reset the size; the split and collapsed projects survive reopening the window. Search matches chat titles,
projects and providers. Selecting an old conversation from Recent reveals it inside its project.
⌘1…9 selects the first nine conversations in the visible list. Technical connection details are under the
connection indicator. ⌘K focuses conversation search; ⌘B hides or shows the sidebar. Model, effort and
approval mode sit in the composer. Context, subscription usage and session details open from its info button.
When reading older messages, “К последним” returns to the latest reply. Drag the project sidebar, right panel,
file-tree and composer boundaries to resize them. Diagnostics has adjustable width and height. Arrow keys resize,
double-click resets, and sizes persist. Narrow windows retain room for the conversation.

Errors explain the failure and suggest a next step; original output remains under Technical details. Exit code 1
is a generic failure, not a specific diagnosis. Explicit login, network, quota and access errors get their own
explanations. A `grep`/`rg` search returning code 1 is explained as no matches.

Local PNG, JPEG, GIF and WebP references appear as previews. Click to zoom, save a copy or open the file.
New MCP screenshots and Codex image-generation results are stored separately from the journal and survive
restarts. Images are limited to 20 MB and read only from the project, Codex generation folder or this session's
image store. Remote images stay links. Older screenshot blobs already discarded by previous versions cannot
be recovered. Routine tool calls collapse into groups; errors, permission requests and images stay visible.

**Files beside the conversation.** Click **Files** or press **Cmd+P** for the project tree and file tabs.
Read code, Markdown, images and PDFs inside Pult; PDFs support page navigation, zoom and selectable text.
On narrow windows the viewer fills the workspace; Esc returns to the conversation and keeps your draft.
Codex output-file citations and local Markdown links open the same viewer. Files outside the project are
available only when explicitly linked in the conversation. Use the toolbar to open externally or reveal in Finder.
Unsupported formats have an explicit fallback; missing files show an error. Older windows retain external opening.

More: `pult agent list`, `pult agent stop w` (stop the current turn), `pult agent rm w`, `pult usage` (your 5-hour and
7-day subscription windows), `pult --help` for everything.

## Inbox and approval modes

Every question from every session goes to the Inbox (⌘I in the window, `pult perm list` in the terminal).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/inbox-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/inbox-light.png">
  <img alt="The Inbox panel on the right: a Codex session asks to run npm test outside its sandbox (buttons Allow, Always for commands starting with npm test, Deny), and a Claude session asks a multiple-choice question" src="docs/images/inbox-light.png" width="720">
</picture>

**Answering a question** (`pult perm approve <id> [--session | --rule]`, or the buttons on the card):

- **Once** — the default. "Разрешить" ("Allow"), ⌘Enter in the window and a bare `pult perm approve` allow exactly this
  one action.
- **In this session** (`--session`) — only when Codex offers it for this request: it won't ask about the same kind of
  action until the session ends.
- **Always** (`--rule`) — only when Codex offers it. "Always: commands starting with `<prefix>`" adds a Codex rule:
  that command, with any arguments, then runs **outside the sandbox and without a question in all Codex sessions**, not
  only Pult's. The same works for network access to a host. These rules are written to `~/.codex/rules/default.rules`.
  Pult marks the line it caused with a `# pult: rule=…` comment; marked rules are listed (date, source session) in
  Settings → «Правила „Всегда“» (Always rules) and by `pult perm rules`, and can be revoked there or with `pult perm rules revoke <id>` —
  only the marker and that line are removed, a running turn is not interrupted. Codex reads rules only at start-up, so
  after a revoke Pult restarts its Codex: at once if it is idle, otherwise when turns, background work and questions
  finish (until then the rule still applies there); conversations resume where they were, but "this session" approvals
  of every Codex session are reset. A codex running outside Pult (terminal, IDE) keeps the rule until it restarts. On
  Linux the file is edited without codex's lock (on macOS under it). Pult also tells you if other lines still
  allow the same thing. Unmarked lines are never touched.
- **Claude** doesn't offer reusable rules to Pult today, so Claude cards only offer "once".
- **A card says when it shows less than will run.** The secret filter masks e-mails, tokens and URL credentials on
  the card (`<email>`, `<token>`, `<redacted>`), and Codex fields are clipped; the ORIGINAL command still runs, so
  `ssh root@prod.example.com` shows as `ssh <email>`. Such a card is marked "Показано не всё" ("not everything is
  shown") and `pult perm list` prints `ВНИМАНИЕ: показано не всё`; if unsure, deny. ⌘Enter only approves a card you can
  see: the open session's own request or one in the open Inbox. Pressed in a session's reply box, it only approves that
  session's own request — never a card of another session.
- **A dead agent's question goes away.** If the `claude` process that asked dies, its card leaves the Inbox as "deny".
- **Silence is a no.** Nobody answered within 10 minutes, the daemon went away, the agent was stopped — the answer is
  "deny".

**Approval mode** is chosen when a session is created (`--approval`, or the "Подтверждения" field in "Новая сессия"):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/new-session-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/new-session-light.png">
  <img alt="The New session dialog: provider (claude or codex), session name, project folder, optional worktree branch, browser for the agent, approval mode, model and effort" src="docs/images/new-session-light.png" width="720">
</picture>

**Attachments in the composer** (window 0.1.21). Drop files, paste files copied in Finder, paste a screenshot,
or use the **＋** button. Cards show names, sizes, remove buttons and PNG/JPEG thumbnails; your text stays in
the input. You can send an attachment without text. A screenshot without a disk file needs no manual saving.

Pult immediately saves file copies under `~/.pult/attachments/<session>/<date>/`, so deleting the original temporary
file does not break the attachment. Limits: 20 files per message, 25 MB per file and 1 GB per day. Copies expire
after 30 days; originals remain unchanged. Removing a card only removes it from the draft, keeping copies used by
messages. Draft attachments survive reopening; saved files are checked before sending. In New session you can
attach files before choosing a name; creation copies them into the final session's folder. Directories remain
explicitly labelled references rather than recursive copies. Dropping a folder outside the prompt selects the
session folder. Pasting text from Office still pastes text.

Older windows retain path insertion. Update the window (Settings → Updates → «Перезапустить и обновить», Restart and
update) for cards and memory-backed files. Each Claude session receives only its own attachment directory; Codex uses its normal sandbox access rules.

| mode (window label) | Claude | Codex |
|---|---|---|
| `read-only` ("Только чтение") | no edits; every command asks | `read-only` sandbox; anything wider asks |
| `ask` ("Спрашивать", default) | your own Claude settings; its questions go to the Inbox | `workspace-write` sandbox; anything wider asks |
| `workspace` ("Правки в папке без вопросов") | `acceptEdits` | `workspace-write`, no questions |
| `full` ("Полный доступ") | `bypassPermissions` | `danger-full-access`, no questions |

Every turn includes an explanation of the selected mode, including after a live mode change. For Codex,
`workspace` rejects requests to leave the sandbox; switch the session to `ask` and repeat the request when that access
is needed. Nested CLIs inherit the sandbox, so `Not logged in` there alone does not establish that the terminal login
has expired. Claude's `acceptEdits` follows its own permission rules for other tools.

`full` means no sandbox and no questions: the agent can do anything your user can. It needs an explicit confirmation
(`--yes` in the CLI).

## Changing a session later

Model, effort and approval mode of a live session can be changed at any time: click "model · effort · mode" in the
composer, or run `pult agent set <name> [--model M] [--effort E] [--approval A] [--yes]`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/settings-menu-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/settings-menu-light.png">
  <img alt="The composer menu of a session: model (haiku, sonnet, opus, fable), effort (low to max) and approval mode, with a note that changes apply from the next turn" src="docs/images/settings-menu-light.png" width="720">
</picture>

- The change applies from the next turn; the running turn and pending Inbox questions are untouched.
- The first turn after a model change costs more: each model has its own prompt cache.
- Defaults for new sessions live in Settings (⌘,). `pult agent start` uses only the defaults of the provider given by
  `--kind` (`config.json` → `newSession.defaults`), never the window's "last choice", so scripts stay predictable.

## Updates

**In the window: Settings (⌘,) → Обновления (Updates).** Pult and its window share one version number, and one button
updates both: «Перезапустить и обновить» (Restart and update) in Settings, «Перезапустить» (Restart) in the banner. The
section shows the installed version («Пульт 0.3.16»; the window's own number only when it differs), the channel status
and when the channel was last checked; «Проверить сейчас» (Check now) checks right away. The toggle «Проверять
обновления автоматически» (check automatically) is `updates.check` in `config.json`.

How an update goes:

1. A check (every 6 hours, when the window comes back after an hour, or «Проверить сейчас») finds a newer signed
   release, and Pult downloads and verifies it in the background right away: the package into `PULT_HOME/versions/<v>`
   without switching to it, the window (macOS, Apple Silicon) into `PULT_HOME/apps/ready-<v>`. This happens only with
   automatic checks on or after you pressed «Проверить сейчас». The banner stays empty meanwhile; Settings says
   «скачиваю в фоне…» (downloading in the background). A failed download stays quiet and is retried later; the button
   downloads it anyway.
2. When everything is ready, the banner says «Пульт X готов · Что нового · Перезапустить» (Pult X is ready · What's new ·
   Restart).
3. «Перезапустить» lets running turns finish first: «Обновлю до X после окончания ходов (N идут) · Сейчас» — «Сейчас»
   (Now) means don't wait. New messages wait until the restart («Пульт обновляется — отправь после перезапуска»), the
   text stays in the box. Then the daemon switches to the new version and restarts, and the new daemon closes the
   window, swaps `Pult.app` and opens the new window. The banner says «Перезапускаю…» (Restarting…). Agents keep their
   sessions; unsent text in the message box survives.
4. A failure is shown with «Повторить» (Retry). A daemon that fails its start-up check is rolled back, a window that
   does not come up within 60 seconds is put back, and a window replaced while it was closed can be put back with
   «Вернуть <version>» (Put back) if its first start fails.

If the channel already has an even newer version when you press the button, that one is installed, and Pult says so.

**Updating from 0.3.15 (window 0.1.21): one extra click, once.** 0.3.15 updates itself to 0.3.16 the old way, and the
window keeps showing the 0.3.15 interface. After the restart that window offers «Доступно новое окно 0.3.16 · Обновить
окно» (New window available · Update window) in the banner and in Settings — press it once. From then on the single
button does both.

In the terminal:

```sh
pult update              # check, download, verify, install, restart the daemon
pult update --check      # only check: exit 0 — up to date, 10 — an update is available
pult update --stage      # download and prepare the new version without switching (the daemon does this itself)
pult update --list       # versions on disk
pult update --to <ver>   # switch back to a version from `pult update --list`
pult update --app        # update only the window (Pult.app, macOS) from the same channel
pult update --app --rollback   # put the previous window back if the new one failed on its first start
```

- `pult update` from the terminal updates the package only. The window then offers «Пульт X готов · Перезапустить»,
  which replaces or restarts the window; `pult update --app` does the same from the terminal.
- `pult update` (also `--from`, `--to`) restarts the daemon, so it refuses while turns are running
  («идут ходы: N … дождись или --force»); `--force` updates anyway and cuts them off. If the daemon is preparing an
  update in the background at that moment, `pult update` waits for it (up to 10 minutes) instead of refusing.
- `latest.json` of the latest GitHub release is signed with Ed25519 (the public key is built into Pult); the package
  and the window zip must match the size and sha256 in the signed manifest. Anything else is refused and nothing is
  installed. A version prepared in the background is not downloaded again; without network, `pult update` can still
  switch to the version the window asked for if it was prepared earlier.
- The daemon checks a minute after start, then every 6 hours, and when the window comes back to the screen if the last
  check is older than an hour (at most once per 10 minutes). Running turns are not cut off, and a version that fails
  its start-up check is rolled back automatically.
- **The window (macOS, Apple Silicon).** The daemon checks the window zip's size and sha256 against the signed manifest,
  then the bundle id, version, architecture and code signature, puts the new bundle next to the old one, closes the
  window, swaps `Pult.app` in place with two renames and opens the new one. If the new window is not up and working
  within 60 seconds, the old one is put back and reopened, and that version is not offered again
  (`pult update --app --force` retries it). If the daemon is stopped mid-swap, the next start finishes or rolls back.
  If the window was closed during the update, the previous window is kept until the new one has started once. Another
  open window (a second copy of `Pult.app`, a development window) has to be closed first; Settings says which. If the
  window folder is not writable (for example, a non-admin user and `/Applications`), the bundle is not touched and
  Settings tells you how to replace the window by hand (download `Pult-arm64.zip` as in
  [Install](#2-the-window-macos-apple-silicon)); the button still restarts the window so it shows the new interface.

## Network & privacy

Pult has no telemetry. Besides your agents' own traffic, it makes these requests:

- **Exit-country check.** Providers don't serve some regions, and a request from there can put your account at risk.
  So before an agent's first turn, and before any turn after more than 60 s of idle time, Pult checks the exit country
  along the same path the agent will use (`https://api.anthropic.com/cdn-cgi/trace`, fallback
  `https://cloudflare.com/cdn-cgi/trace`). If the country is unknown or in the guard list (`RU, BY, CN, IR, KP, SY, CU`
  — Pult's own conservative list, not an official one), it refuses to start the turn (exit code 4) rather than risk
  your account. See [Network guard](#network-guard) to change the list or allow only chosen countries.
- **Session titles.** An untitled session names itself from your first message with one cheap `haiku` request on your
  Claude subscription. Turn it off with `"autoTitle": false` in `config.json`.
- **Update check.** One `GET` of `latest.json` from github.com every 6 hours (and when the window returns after an hour
  or more, at most once per 10 minutes), with the header `user-agent: pult/<version>` and no identifiers. Turn it off in
  Settings (⌘,) → Обновления or with `{ "updates": { "check": false } }`; «Проверить сейчас» still works. A newer
  package and window are downloaded right after a check finds them (only with automatic checks on, or after «Проверить
  сейчас») and installed only when you press the button.

After editing `~/.pult/config.json`, run `pult daemon stop`; the next command starts the daemon with the new settings.

### Network guard

One rule for all providers decides which exit countries may run turns. Change it in Settings (⌘,) → «Страж сети»,
with `pult net guard`, or in `config.json`:

- **Deny** (default) — refuse a turn when the exit country is in the list: «Запрещать страны из списка».
- **Allow** — refuse unless the exit country is in the list: «Разрешать только страны из списка». An empty list is not
  accepted.
- An unknown exit country is refused in both modes.

```sh
pult net guard                    # show the rule
pult net guard --allow DE,FI      # only these exit countries (ISO 3166-1 codes)
pult net guard --deny RU,BY       # every exit country except these
```

```json
{ "network": { "guard": { "mode": "allow", "countries": ["DE", "FI"] } } }
```

The countries above are only examples. The window shows each provider's last known exit country and whether the new rule
would let it through; «Проверить сеть» checks again. A change made in the window or with `pult net guard` applies from
the next turn of every session, without restarting the daemon; a running turn is not interrupted. The old top-level
`guardCountries` list still works as a deny list; if `network.guard` is present, it wins, and saving the rule from the
window or `pult net guard` removes the old key. `pult doctor` shows the rule. If `config.json` has allow mode with no
valid country, or a `network.guard` Pult cannot read, every turn is refused until you fix it. Deny mode with an empty
list turns the guard off (doctor warns).

**Proxy.** By default there is none: agents and the country check go out directly. To send a provider through a local
proxy, set `network.<provider>.proxy` (the address below is only an example):

```json
{
  "version": 1,
  "network": {
    "claude": { "mode": "auto", "proxy": "http://127.0.0.1:10808" },
    "codex":  { "mode": "auto", "proxy": "http://127.0.0.1:10808" }
  }
}
```

- `auto` tries the proxy with a real request and goes direct if it is dead (the country check still applies);
  `required` never goes direct — a dead proxy, or no `proxy` at all, blocks the turn; `off` (the default) is direct only.
- The agent gets the proxy as `HTTPS_PROXY` (Codex also `ALL_PROXY`), with `NO_PROXY` for localhost.
- Services that must bypass the proxy (say, a work tracker behind a company VPN) go to `network.<provider>.noProxy`:
  `"noProxy": [".corp.example", "10.0.0.0/8"]`. Write domains as `.domain`.
- `pult doctor` shows the chosen path per provider.

## Security

Pult runs agents as your user. Its daemon listens on a unix socket in `~/.pult/run` (mode 0600), and whoever holds the
token in `~/.pult/run/token` controls every session. What Pult does about that, and what it can't do:

**What Pult protects**

- **A sandboxed Codex can't reach the daemon.** Codex `workspace-write` and `read-only` without network block even the
  connection to the socket (not in `full`, which has no sandbox). `pult doctor` warns when your Codex config opens it:
  `sandbox_workspace_write.network_access = true` (also in the selected `profile`), or a permission profile that allows
  unix sockets.
- **Ask keys instead of the token.** The permission helper of each `claude` process (`pult mcp-ask`) gets its own key,
  bound to one session and revoked when that process exits. With it, the helper can only ask questions for its session;
  it never reads the token file. The token can't ask questions on an agent's behalf.
- **Claude's Read and Edit tools are denied for Pult's run folder.** Every Claude session gets `deny` rules for `Read` and
  `Edit` on `~/.pult/run`; Claude applies deny before your own allow rules, and it also refuses simple Bash reads of that
  folder such as `cat ~/.pult/run/token`. **Bash is not covered as a whole:** an allowed interpreter
  (`Bash(python3:*)`) or an allowed recursive search over a parent folder (`grep -r ~/.pult`) can still read the token.
  In `read-only`, every Bash command asks, even if your settings allow it.
- **An approval can't swap the command.** Approving a card runs exactly the request the agent made; `perm.resolve`
  refuses a replaced input. The journal records which client answered (`shell#3`, `cli#7`).
- **Cards say when they hide something** (masked secrets, clipped fields), and ⌘Enter approves only a card you can see.
- **Session folders can't cover `~/.pult`**, so an agent with write access to its folder can't rewrite Pult's config.
- **Pasted images live outside the run folder.** `~/.pult/attachments` is a sibling of `~/.pult/run`, not inside it:
  `--add-dir` opens to each Claude session only the images pasted into that session, and the deny rules on the run folder
  stay as they are.
- **Network guard.** Turns don't start from refused exit countries (see [Network guard](#network-guard)).

**What Pult doesn't protect**

- **Code running as your user can do anything Pult can:** read the token, connect to the socket, or edit `~/.pult`
  directly. Any command an agent runs outside a sandbox is such code.
- **One approved escalation is full control.** Approving a command outside the sandbox (or a Claude Bash command) gives
  the agent everything your user has, including Pult. Read commands before approving them.
- **Don't allow interpreters or recursive readers in Claude allow rules** (`Bash(python3:*)`, `Bash(node:*)`,
  `Bash(sh:*)`, `Bash(grep:*)`, `Bash(find:*)`): in `ask` and `workspace` they run without a question and can read the token.
- **Keep Codex network off** in the sandbox unless you need it.
- **`--yes` / `confirm: true` for `full` guards against typos, not against an attacker.** It is not a second factor.

## Where data lives

Everything Pult keeps is in `~/.pult` (or `PULT_HOME`), readable only by you:

| path | what |
|---|---|
| `events/` | the event journal: every message, answer, tool call and question |
| `sessions.json`, `projects.json` | your sessions and the project folders in the window |
| `config.json` | settings (network, updates, defaults for new sessions) |
| `versions/`, `current` | installed Pult versions and the active one |
| `runtime/` | Pult's own Node.js, if the installer downloaded it |
| `worktrees/` | git worktrees created with `--worktree` |
| `exports/` | conversations exported to Markdown |
| `logs/` | daemon logs (`pult daemon logs`) |
| `browser/`, `mcp/` | the optional browser for agents: per-session profile and the Playwright MCP server |

Your conversations with Claude and Codex are also stored by those CLIs themselves, as usual.
To try Pult without touching your real state: `PULT_HOME=$(mktemp -d) pult …`.

## Uninstall

```sh
pult daemon stop
pult daemon uninstall          # remove the launchd / systemd service
rm ~/.local/bin/pult
rm -rf ~/.pult                 # all sessions, journals, settings and installed versions
rm -rf /Applications/Pult.app
```

Codex "always" rules you allowed stay in `~/.codex/rules/default.rules`. Revoke the ones Pult marked first
(`pult perm rules`, then `pult perm rules revoke <id>`); remove unmarked lines by hand.

## FAQ

**Does it work with my Claude Pro / Max / Team subscription?** Yes: Pult uses whatever `claude` and `codex` are
logged into. `pult doctor` shows exactly which subscription Pult's agents will spend, in the lines starting with
`Подписка` ("Subscription"). To switch, log the terminal CLI into another account (`claude /logout`, `claude /login`).

**Does it cost anything extra?** No. Pult is free; agent turns count against your existing subscription limits
(`pult usage` shows them).

**Do I need both `claude` and `codex`?** No, one is enough.

**Can I use it without the window?** Yes. Everything works from the CLI, and on Linux the CLI is the only interface.

**Windows? Intel Mac?** No. Windows is not supported; the window is built for Apple Silicon only, and the daemon and
CLI are tested on Apple Silicon Macs and Linux.

**What happens on reboot or when the laptop sleeps?** The service starts the daemon again, and every conversation
resumes on your next message. A turn that was running when the machine went down is interrupted; send the message
again (the window offers "retry").

**Is it safe?** By default (`ask`), anything outside the agent's own settings or sandbox waits for your answer, and an
unanswered question is a "no". `workspace` lets the agent edit files in its folder without asking; `full` removes the
sandbox and all questions and requires an explicit confirmation. Pult runs everything locally, as your user.

## Known limits

- No `opencode` adapter yet; it comes in a later release.
- The exit-country check runs **before** a turn. If your VPN drops mid-turn, traffic may go direct until the next
  check; a kill switch in the VPN client prevents that.
- "In this session" and "always" answers exist only for Codex, and only when Codex offers them.
- Claude Code's auto-memory (`~/.claude/projects/…/memory/`) is written by the CLI itself and does not go through the
  Inbox.
- Codex sandbox-widening requests, model questions to a human and MCP elicitation are not handled yet: they get an
  error, and the turn usually still finishes.
- The event journal is not rotated.
- The window updates itself only on macOS with Apple Silicon; on Linux the window runs from a working copy.
- The Linux service is checked against the unit file only; it has not been run under a real systemd in CI.

## Troubleshooting

Start with **`pult doctor`** (`--json` for scripts, `--no-net` to skip network checks). It checks Node, where `claude`,
`codex` and `git` live, whether you are logged in, which subscription will be spent, the network and exit country per
provider, permissions of `~/.pult`, the daemon, the active version and the service — and prints a fix command under
every `[fail]`.

- **Not logged in** (`Вход claude` / `Вход codex` is red). Run `claude /login` or `codex login` in a terminal, then
  `pult doctor` again.
- **Exit code 4, "сеть заблокирована стражем" ("network blocked by the guard").** Your exit country is unknown or refused
  by the guard rule (see [Network guard](#network-guard)). Connect a VPN or proxy and send the message again;
  `pult doctor` shows the detected country per provider.
- **The window says the daemon is not running** ("демон недоступен"). Click "запустить" ("start") in the banner, or
  run `pult daemon stop && pult daemon start`. The reason is in `pult daemon logs`.
- **Permission questions don't appear.** Check the session's approval mode in the composer: in `workspace`
  and `full` there are no questions by design. In `ask`, Claude follows your own Claude settings, so actions those
  settings already allow won't ask. `pult perm list` shows what is waiting right now.
- **macOS asks "“node” would like to access files in your Desktop folder".** Click "Allow": the agent works in a folder
  inside `~/Desktop`, `~/Documents` or `~/Downloads`.
- **Linux: the daemon stops when you log out.** `systemd --user` needs lingering: `pult daemon install` enables it, or
  prints `sudo loginctl enable-linger <user>` if it can't.

**Exit codes** (`pult agent prompt --wait` and other commands):

| code | meaning |
|---|---|
| 0 | done |
| 1 | error |
| 2 | timeout |
| 3 | waiting for you — see `pult perm list` |
| 4 | network blocked by the exit-country guard |
| 5 | provider unavailable or subscription limit reached |
| 10 | an update is available (`pult update --check` only) |

More cases (VPN and tunnels, Codex moving after a ChatGPT.app update, service messages) are in the Russian manual,
section [«Неполадки»](README.ru.md#неполадки).

## Terms & providers

*As of Oct 2026. This is not legal advice.*

- Pult runs **your own, unmodified** `claude` and `codex`, logged into **your own** accounts, on **your own** machine.
  It never reads or stores your tokens and proxies nothing.
- Whether many agents in parallel still count as "ordinary, individual usage" is not defined by the providers; if a
  provider decides otherwise, enforcement would hit **your** account. You are responsible for following their terms.
- Pult is not affiliated with or endorsed by Anthropic or OpenAI.

<details>
<summary>The exact provider terms and how Pult fits them</summary>

**Anthropic.** The [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) prohibits
third-party developers from offering Claude.ai login in their products, from routing requests through Free, Pro or Max
plan credentials on behalf of their users, and from collecting or storing users' tokens. The same page draws an explicit
line: «Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude
subscription». It also says that Pro and Max limits «assume ordinary, individual usage», and that Anthropic «may
[enforce] without prior notice». And on products built around Claude Code: «Unless we've mutually agreed otherwise,
preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent
infrastructure) requires agreeing to our Commercial Terms of Service…». That point is about products that host or ship
Claude Code for their customers. Pult hosts nothing and neither preinstalls nor downloads Claude Code: it launches the
copy you installed and logged into, on your own machine.

**How Pult fits.**

- It runs your own, unmodified `claude` and `codex` binaries, which you installed and logged into yourself. Pult does
  not download Claude Code for you.
- It never reads `~/.claude/.credentials.json`, the macOS keychain or `~/.codex/auth.json`. From `claude auth status` it
  takes only the plan type and login method; your email and organization never reach its reports or logs.
- No proxying of requests, no server, no accounts: everything runs on your machine, as your user.
- Its name and logo contain no Claude, Anthropic or Codex branding; it only says, in plain text, that it runs these CLIs.

**The honest risk.** Whether many agents running in parallel still count as «ordinary, individual usage» is not defined
anywhere. If a provider decides it is not, enforcement would hit **your** account, not Pult. You are responsible for
complying with your provider's terms. Pult is not affiliated with or endorsed by Anthropic or OpenAI.

**OpenAI.** We found no specific terms about third-party apps driving `codex app-server` with a ChatGPT login. The
ChatGPT Terms of Use apply to your login.

</details>

## Contributing & issues

- **Bugs and ideas:** [GitHub Issues](https://github.com/pawellazarew/pult/issues). Please include the output of
  `pult doctor` (it never prints tokens, emails or organization names, but it does show local paths — trim what you
  don't want to share) and what you expected to happen.
- **Security issues:** please don't open a public issue — use private vulnerability reporting on the
  [Security tab](https://github.com/pawellazarew/pult/security) ("Report a vulnerability").
- **Code:** the one check for every change is `./scripts/ci-check.sh` (the same as CI). Architecture and tests are
  described in [`docs/DEV.md`](docs/DEV.md) (in Russian).

## License

Pult is [MIT](LICENSE)-licensed. The window bundles third-party parts under their own MIT-compatible licenses: the
Geologica, Onest and JetBrains Mono fonts (SIL OFL 1.1, see [`ui/fonts/LICENSES.md`](ui/fonts/LICENSES.md)); React,
react-dom and scheduler (MIT); Electron (MIT, with the Chromium licenses that electron-builder ships inside the app).
