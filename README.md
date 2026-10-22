# Pult

**English** · [Русский](README.ru.md)

**Run several Claude Code and Codex agents in the background and answer all their permission questions in one place.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/hero-light.png">
  <img alt="The Pult window: projects with their sessions on the left (two of them waiting for you), a Claude conversation in the middle with the tool calls it made, subscription limits for Claude and Codex at the top" src="docs/images/hero-light.png" width="100%">
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

The window has its own version number (0.1.x), separate from Pult's (0.3.x); `Pult-arm64.zip` from the latest release
always matches the latest Pult, and the window tells you if it is too old for the installed Pult. If `pult ui` finds no `Pult.app` in `/Applications` or `~/Applications`, it exits with code 1 and
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

Pick a project folder — a git repository is recommended, so you can review and undo what the agent changed.

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
whole conversation. Closing the window does not stop the agent.

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
  only Pult's. The same works for network access to a host. These rules are written to `~/.codex/rules/default.rules`;
  Pult never removes them for you.
- **Claude** doesn't offer reusable rules to Pult today, so Claude cards only offer "once".
- **Silence is a no.** Nobody answered within 10 minutes, the daemon went away, the agent was stopped — the answer is
  "deny".

**Approval mode** is chosen when a session is created (`--approval`, or the "Подтверждения" field in "+ Сессия"):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/new-session-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/new-session-light.png">
  <img alt="The New session dialog: provider (claude or codex), session name, project folder, optional worktree branch, browser for the agent, approval mode, model and effort" src="docs/images/new-session-light.png" width="720">
</picture>

In the dialog, drop a folder onto the form to use it as the session folder; files dropped into the first message, or
copied in Finder and pasted with ⌘V, become their full paths (quoted when they contain spaces), as in the chat input.

| mode (window label) | Claude | Codex |
|---|---|---|
| `read-only` ("Только чтение") | no edits; every command asks | `read-only` sandbox; anything wider asks |
| `ask` ("Спрашивать", default) | your own Claude settings; its questions go to the Inbox | `workspace-write` sandbox; anything wider asks |
| `workspace` ("Правки в папке без вопросов") | `acceptEdits` | `workspace-write`, no questions |
| `full` ("Полный доступ") | `bypassPermissions` | `danger-full-access`, no questions |

`full` means no sandbox and no questions: the agent can do anything your user can. It needs an explicit confirmation
(`--yes` in the CLI).

## Changing a session later

Model, effort and approval mode of a live session can be changed at any time: click "model · effort · mode" in the
conversation footer, or run `pult agent set <name> [--model M] [--effort E] [--approval A] [--yes]`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/settings-menu-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/settings-menu-light.png">
  <img alt="The footer menu of a session: model (haiku, sonnet, opus, fable), effort (low to max) and approval mode, with a note that changes apply from the next turn" src="docs/images/settings-menu-light.png" width="720">
</picture>

- The change applies from the next turn; the running turn and pending Inbox questions are untouched.
- The first turn after a model change costs more: each model has its own prompt cache.
- Defaults for new sessions live in Settings (⌘,). `pult agent start` uses only the defaults of the provider given by
  `--kind` (`config.json` → `newSession.defaults`), never the window's "last choice", so scripts stay predictable.

## Updates

**In the window: Settings (⌘,) → Обновления (Updates) → «Проверить сейчас» (Check now) / «Обновить до X» (Update to X).**
The section shows the installed package and window versions, the channel status (up to date, a new version with a
«Что нового» (What's new) link, or the error) and when the channel was last checked. «Обновить» works like the banner at the top
of the window: running turns finish first (or press «Сейчас» to not wait), then the daemon updates and restarts, and the
window reconnects by itself. The toggle «Проверять обновления автоматически» (check automatically) is
`updates.check` in `config.json`.

In the terminal:

```sh
pult update              # check, download, verify, install, restart the daemon
pult update --check      # only check: exit 0 — up to date, 10 — an update is available
pult update --list       # versions on disk
pult update --to <ver>   # switch back to a version from `pult update --list`
pult update --app        # update the window (Pult.app, macOS) from the same channel
```

- `latest.json` of the latest GitHub release is signed with Ed25519 (the public key is built into Pult); the package
  must match the size and sha256 in the signed manifest. Anything else is refused and nothing is installed.
- The daemon checks a minute after start, then every 6 hours, and when the window comes back to the screen if the last
  check is older than an hour (at most once per 10 minutes). In the window a new version shows up as a quiet line at the
  top. Running turns are not cut off, and a version that fails its start-up check is rolled back automatically.
- **The window updates itself (macOS, Apple Silicon).** When the release has a newer window, Settings → Обновления shows
  «Окно: 0.1.15 → доступно 0.1.16 · Обновить окно» (Update window), and the banner says so too. The daemon downloads
  the window zip, checks its size and sha256 against the same signed manifest, the bundle id, version, architecture and
  code signature, puts the new bundle next to the old one, then closes the window, swaps `Pult.app` in place with two
  renames and opens the new one. If the new window is not up and working within 60 seconds, the old one is put back
  and reopened, and that version is not offered again (`pult update --app --force` retries it). If the daemon is
  stopped mid-swap, the next start finishes or rolls back. Another open window (a second copy of `Pult.app`, a
  development window) has to be closed first; the button is shown only in the installed window. Agents keep working the whole time; unsent text in the message box survives
  the restart. If the window folder is not writable (for example, a non-admin user and `/Applications`), nothing is
  touched and Pult tells you how to replace the window by hand (download `Pult-arm64.zip` as in
  [Install](#2-the-window-macos-apple-silicon)). If a new Pult needs a newer window, the window says so.

## Network & privacy

Pult has no telemetry. Besides your agents' own traffic, it makes these requests:

- **Exit-country check.** Providers don't serve some regions, and a request from there can put your account at risk.
  So before an agent's first turn, and before any turn after more than 60 s of idle time, Pult checks the exit country
  along the same path the agent will use (`https://api.anthropic.com/cdn-cgi/trace`, fallback
  `https://cloudflare.com/cdn-cgi/trace`). If the country is unknown or in the guard list (`RU, BY, CN, IR, KP, SY, CU`
  — Pult's own conservative list, not an official one), it refuses to start the turn (exit code 4) rather than risk
  your account. The list is `guardCountries` in `~/.pult/config.json`.
- **Session titles.** An untitled session names itself from your first message with one cheap `haiku` request on your
  Claude subscription. Turn it off with `"autoTitle": false` in `config.json`.
- **Update check.** One `GET` of `latest.json` from github.com every 6 hours (and when the window returns after an hour
  or more, at most once per 10 minutes), with the header `user-agent: pult/<version>` and no identifiers. Turn it off in
  Settings (⌘,) → Обновления or with `{ "updates": { "check": false } }`; «Проверить сейчас» still works. The package and
  the window are downloaded only when you update them.

After editing `~/.pult/config.json`, run `pult daemon stop`; the next command starts the daemon with the new settings.

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
  `required` never goes direct — a dead proxy blocks the turn; `off` (the default) is direct only.
- The agent gets the proxy as `HTTPS_PROXY` (Codex also `ALL_PROXY`), with `NO_PROXY` for localhost.
- Services that must bypass the proxy (say, a work tracker behind a company VPN) go to `network.<provider>.noProxy`:
  `"noProxy": [".corp.example", "10.0.0.0/8"]`. Write domains as `.domain`.
- `pult doctor` shows the chosen path per provider.

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

Codex "always" rules you allowed stay in `~/.codex/rules/default.rules`; remove those lines by hand if you want them gone.

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
- **Exit code 4, "сеть заблокирована стражем" ("network blocked by the guard").** Your exit country is unknown or in
  the guard list (see [Network & privacy](#network--privacy)). Connect a VPN or proxy and send the message again;
  `pult doctor` shows the detected country per provider.
- **The window says the daemon is not running** ("демон недоступен"). Click "запустить" ("start") in the banner, or
  run `pult daemon stop && pult daemon start`. The reason is in `pult daemon logs`.
- **Permission questions don't appear.** Check the session's approval mode in the conversation footer: in `workspace`
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
