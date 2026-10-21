# Pult

**English** · [Русский](README.ru.md)

Pult is a background daemon, a CLI and a desktop window that run **your own** installed `claude` (Claude Code) and
`codex` (Codex CLI) as long-lived agents. Agents keep working in the background: they survive closing the terminal,
closing the window and restarting the daemon. Every permission question from every agent lands in one Inbox, where you
answer it once, for the session, or (when the provider offers it) always. Pult spends your own subscriptions through the
CLIs you already logged into: it has no account and no server of its own, and it never reads your tokens.

<!-- TODO: screenshot of the window (sessions tree, conversation, Inbox) — add before publishing. -->

**Status:** 0.3. Daemon and CLI: macOS (Apple Silicon) and Linux. Window (`Pult.app`): macOS on Apple Silicon
only. The interface and CLI messages are in Russian for now. An `opencode` adapter comes in a later release.

The full manual is in Russian: [README.ru.md](README.ru.md). How Pult is built and tested:
[`docs/DEV.md`](docs/DEV.md).

## Requirements

- macOS on Apple Silicon, or Linux (daemon and CLI only);
- `git`;
- at least one logged-in CLI: `claude` (log in with `claude /login`) or `codex` (`codex login`). Pult never shows a login
  form and never handles keys: you always log in yourself, in a terminal.

Node.js is optional. If there is no `node` >= 22 in `PATH`, the installer downloads the official nodejs.org tarball of the
version pinned in the package, checks its sha256 before unpacking and keeps it inside `~/.pult/runtime`.

## Install

The installer is POSIX `sh`. Read it before you run it:

```sh
curl -q --proto '=https' -fsSLO https://github.com/pawellazarew/pult/releases/latest/download/install.sh
less install.sh
sh install.sh --from https://github.com/pawellazarew/pult/releases/latest/download/pult.tgz
```

It installs into `~/.pult` (`--home`), links `~/.local/bin/pult` (`--bin-dir`), installs a user service (launchd on
macOS, `systemd --user` on Linux; skip it with `--no-service`) and prints `pult doctor`. It does not use sudo, does not
install Node system-wide and does not edit your shell profile or `PATH`; it only tells you what to add.

**The window (macOS, Apple Silicon).** Install the CLI first: `Pult.app` does not bundle the package, it loads it from
`~/.pult`. Then take `Pult-<app-version>-arm64.zip` from the [latest release](https://github.com/pawellazarew/pult/releases/latest),
unpack it and move `Pult.app` to `/Applications`.

The app is **ad-hoc signed and not notarized**: there is no Apple Developer certificate behind it. What macOS does
depends on how the zip reached your disk:

- **Downloaded in a browser** — the zip carries the quarantine flag, and the first launch is refused ("Apple could not
  verify…"). Open **System Settings → Privacy & Security**, scroll to the message about Pult and click
  **Open Anyway**, then confirm. You do this once per app version.
- **Downloaded with `curl`** — curl does not set the quarantine flag, so there is no prompt:

  ```sh
  curl -q --proto '=https' -fsSLO https://github.com/pawellazarew/pult/releases/download/v<version>/Pult-<app-version>-arm64.zip
  ditto -x -k Pult-<app-version>-arm64.zip /Applications
  ```

`pult ui` opens the window (or tells you how to get it). Closing the window does not stop your agents.

**From source:** `npm ci && npm run build`, then `node dist/cli/main.js …`; the window from source —
`cd shell && npm ci && npm start`. Details: [`docs/DEV.md`](docs/DEV.md).

## Quick start

```sh
pult doctor                                                   # is everything in place? prints a fix for every red line
pult agent start w --kind claude --cwd ~/code/app             # start an agent (a session); --kind codex for Codex
pult agent prompt w "fix the failing test" --wait             # send a message and wait for the answer
pult perm list                                                # what is waiting for your decision
pult perm approve <id>                                        # or: pult perm deny <id> --reason "not on prod"
```

Also: `pult agent list|read|wait|stop|rm`, `pult usage` (5-hour and 7-day subscription windows), `pult ui`,
`pult --help`. In the window, agents are called sessions, and `pult session …` is a synonym for `pult agent …`.

## Updates

```sh
pult update              # check the release channel, download, verify, install, restart the daemon
pult update --check      # only check: exit 0 — up to date, 10 — an update is available
pult update --to 0.2.28  # go back to a version that is already on disk
```

- **What is checked.** `latest.json` of the latest GitHub release. It is signed with Ed25519; the public key is built
  into Pult. The tarball must match the size and sha256 from the signed manifest. A wrong signature, a wrong hash or
  plain http — refused, nothing is installed. The channel never moves you to an older version.
- **When.** The daemon checks one minute after it starts and then once a day. In the window a new version shows up as a
  quiet line at the top: "available X · what's new · update". Running turns are not cut off: the update waits for them
  unless you choose "now". A version that fails its start-up probe is rolled back automatically.
- **What goes over the network.** One `GET` of `latest.json` from github.com (plus GitHub's redirect to
  `objects.githubusercontent.com`) with the header `user-agent: pult/<version>`. No identifiers, no telemetry. The
  tarball is downloaded only when you click "update" or run `pult update`.
- **Turning it off** — in `~/.pult/config.json`, then `pult daemon stop` (the next command starts it with the new
  settings):

  ```json
  { "updates": { "check": false } }
  ```

- `Pult.app` is not replaced by the channel yet: take the new zip from the release page (automatic replacement is
  planned for 0.3.1). If a package needs a newer window, the window says so.

**Other network traffic.** Before an agent's first turn and before any turn after more than 60 s of idle time, Pult
checks the exit country along the same path the agent will use: `https://api.anthropic.com/cdn-cgi/trace` (fallback
`https://cloudflare.com/cdn-cgi/trace`). If the country is unknown or in the guard list (`RU, BY, CN, IR, KP, SY, CU` —
Pult's own conservative list, not an official one), the turn does not start (exit code 4); the list is `guardCountries`
in `config.json`. An untitled session names itself from your first message with one cheap `haiku` request on your
subscription (`"autoTitle": false` turns it off).

**Proxy.** By default there is none: agents and the exit-country check go out directly. To send a provider through a
local proxy, set `network.<provider>.proxy` in `~/.pult/config.json` (fields you leave out keep their defaults), then
`pult daemon stop`. For example, a local mixed HTTP/SOCKS port — the address is only an example, use your own:

```json
{
  "version": 1,
  "network": {
    "claude": { "mode": "auto", "proxy": "http://127.0.0.1:10808" },
    "codex":  { "mode": "auto", "proxy": "http://127.0.0.1:10808" }
  }
}
```

`auto` tries the proxy with a real request and falls back to the direct path if it is dead (the guard still applies);
`required` never goes direct — a dead proxy blocks the turn; `off` (the default) is direct only. A proxy without a mode
means `auto`. The agent gets the proxy as `HTTPS_PROXY` (Codex also `ALL_PROXY`) with `NO_PROXY` for localhost.
`pult doctor` shows the chosen path per provider.

Some services only accept you from another exit, say a work JIRA or git behind the company VPN. List them in
`network.<provider>.noProxy` and the agent and its tools reach them around the proxy:
`"noProxy": [".corp.example", "10.0.0.0/8"]`. Write domains as `.domain`; `*.domain` is turned into `.domain`
because Python and requests do not understand the wildcard. Entries with commas or spaces are dropped with a warning.

## Approval modes and Inbox

Each session gets an approval mode when it is created (`--approval`, or the field in "+ Session"):

| mode | Claude | Codex |
|---|---|---|
| `read-only` | no edits; every command asks | `read-only` sandbox; anything wider asks |
| `ask` (default) | your own Claude settings; questions go to the Inbox | `workspace-write` sandbox; anything wider asks |
| `workspace` | `acceptEdits` | `workspace-write`, no questions |
| `full` | `bypassPermissions` | `danger-full-access`, no questions |

`full` means no sandbox and no questions; it needs an explicit confirmation (`--yes` in the CLI).

The model, effort and approval mode of a live session can be changed later — click "model · effort · mode" in the
conversation footer, or `pult agent set <name> [--model M] [--effort E] [--approval A] [--yes]`. The change applies from
the next turn (the running turn and pending Inbox questions are untouched). Defaults for new sessions and "remember my
last choice" live in Settings (⌘,); `pult agent start` uses only the model/effort/mode/browser defaults of the provider
given by `--kind` (`config.json` → `newSession.defaults`) — never a different provider or `--warm`.

**Answering a question** (`pult perm approve <id> [--session | --rule]`, or the buttons on the Inbox card):

- **Once** — the default. "Allow", ⌘Enter in the window and a bare `pult perm approve` allow exactly this one action.
- **In this session** — only when the provider offered it for this request: Codex will not ask about the same kind of
  action until the session ends.
- **Always** — only when Codex offered it for this request. "Always: commands starting with `<prefix>`" adds a Codex
  execpolicy **prefix** rule: that command with any further arguments then runs **outside the sandbox and without a
  question in all Codex sessions**, not only Pult's. "Always allow network access to `<host>`" works the same way for the
  network. Both rules are written to `~/.codex/rules/default.rules`, and Pult never removes them for you.
- **Claude** sends Pult no rule suggestions (measured with Claude Code 2.1.303), so Claude cards only offer "once".
- **Silence is a no.** Nobody answered within 10 minutes, the daemon went away, the agent was stopped — the answer is
  "deny".

## Troubleshooting

Start with `pult doctor` (`--json` for machines, `--no-net` to skip network checks). It checks Node, where `claude`,
`codex`, `git` and friends live, whether you are logged in, **which subscription Pult's agents will spend**, the Codex
protocol schema, the network and exit country per provider, permissions of `~/.pult`, the daemon, the active version and
the service, and prints the exact command to fix each red line. More cases (VPN dropping mid-turn, macOS folder access
prompts, Codex moving after a ChatGPT.app update) are in the Russian manual, section «Неполадки».

## Terms & providers

*As of Oct 2026. This is not legal advice.*

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

## License

Pult is [MIT](LICENSE)-licensed. The window bundles third-party parts under their own MIT-compatible licenses: the
Geologica, Onest and JetBrains Mono fonts (SIL OFL 1.1, see [`ui/fonts/LICENSES.md`](ui/fonts/LICENSES.md)); React,
react-dom and scheduler (MIT); Electron (MIT, with the Chromium licenses that electron-builder ships inside the app).
