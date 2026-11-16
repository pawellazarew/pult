# R4: local browser status

The Rust preview implements the existing Node browser **status** command:

```sh
pultd-rust --home /absolute/private/scratch browser
pultd-rust --home /absolute/private/scratch browser status --json
```

It observes the local pinned Playwright MCP package, Chrome executable metadata
and optional `daemon.status.browser`. It never calls a `browser.status` RPC,
starts a daemon, installs a package, launches Chrome, starts a provider or probes
the network. `browser install`, doctor and browser execution capabilities are
not implemented by this slice. No RPC catalog or installed-service change is
included. Legacy text advice remains the pinned Node text; it does not enable
automatic installation in the Rust runtime.

All four scoped purposes (`PULT_ASK_KEY`, `PULT_RUNTIME_KEY`, `PULT_MEMORY_KEY`,
`PULT_MEMORY_TURN_KEY`), including empty/mixed values, fail before filesystem,
display-config, owner-token, socket or browser discovery. Existing private
scratch/production-home validation and typed owner authentication remain shared
with `OwnerClient::status`. Local validation failures are fatal; unavailable,
malformed-framing or timed-out daemon RPC becomes `daemon:null` without retry.

## Command contract

The oracle is `src/cli/main.ts:1045–1073`, `src/mcp/browser.ts:53–55,86–120` and
`src/mcp/doctor.ts:23–57` at base
`93cacc2f5331202185e21631b5b55d806682bfe0`.

JSON is `{installed,version,path,chrome,daemon}`. Version is the actual source
pin `0.0.84`; path is `PULT_HOME/mcp/playwright-mcp-0.0.84`. Installed requires
both cli.js presence and the exact package.json version. An ordinary missing or
malformed package is false, with exit 0. Optional daemon browser data is retained
as bounded raw JSON, including unknown fields and JS UTF-16 strings. Numeric
spellings such as `0e0` remain raw in JSON; text applies JavaScript numeric-zero
truthiness and uses the disk fallback. Node JSON.stringify may canonicalize such
an unusual incoming spelling; the Rust representation is semantically equal and
preserves the received data.

Text prints the same two RU/EN MCP/Chrome lines as Node, including daemon
installed/installing/failed/unknown-state precedence, wanted session counts and
the first failure-message line. Empty failure strings remain empty; absent/null
uses the localized fallback. A missing browser or Chrome is an observation,
not a command failure. Malformed known text fields fail with a static error.

## Explicit filesystem and test profiles

- Rust status creates no layout or installation directories. Node cmdBrowser
  calls ensureLayout first. A separate before/after test records this difference;
  ordinary paired-output fixtures preinitialize layout. Missing package paths
  still report false. No global HOME or user configuration is changed.
- Package directories, package.json and cli.js must be regular paths without
  symlinks. Package JSON has a 1 MiB read limit, including a growing-file bound.
  FIFO/directory/symlink/unsafe-parent/oversize cases give static errors rather
  than hanging or silently looking uninstalled. File bytes use UTF-8 replacement
  as Node does. cli.js is metadata-only: it is not read or executed and has no
  arbitrary binary-size/executable-bit requirement.
- Production Chrome discovery keeps the pinned platform candidates and uses
  regular-file metadata plus access(X_OK), following legitimate executable
  symlinks like Node. It reads no executable content and never executes the
  candidate. It does not read provider account/configuration files.
- `PULT_TEST=1` never falls back to real Chrome discovery. An explicit test-only
  `PULT_TEST_BROWSER_CHROME_FILE` must stay under the admitted scratch home and
  passes strict no-symlink regular metadata checks. An absent fake is null.
  This strict fake-file seam is distinct from production executable metadata.

One SIGINT listener covers the read-only status RPC and output. Ctrl-C closes
only this observation socket and exits 130; no stop/mutation/replay is sent.
The shared writer has its existing 2-second output bound. Status exits explicitly
after bounded output/error handling, including a blocked cloned-FD write, so
Runtime drop cannot hold the process open. As with other streaming output,
nonzero exit does not claim that a partially written JSON object was delivered.

## Qualification

Actual public Node CLI baseline ran before the Rust formatter, with a test-only
preload already installed. It denies child execution, blocks system Chrome
metadata lookup and supplies a private virtual Darwin discovery context on
either CI OS. Forty initial cases cover disk/daemon/state/locale/JSON/text; two
additional actual numeric-zero text cases cover the review counterexample.
These 42 cases are compared exactly with the Rust executable. Separate actual
Node Chrome-symlink observations and a Rust actual-filesystem production helper
test prove the matching candidate behavior; they do not pretend the strict
fake-file seam is production discovery.

Actual executable cases also cover all scoped purposes before invalid home and
FIFO inputs, static unsafe-file errors, no real test fallback, unknown/lone-UTF16
browser JSON, raw numeric spellings, wrong-id/EOF/oversize/ordinary deadline,
SIGINT socket closure, blocked stdout with timeout/SIGINT, truthful status-only
help and installer refusal. Pure tests cover pin/version/filesystem/text rules.
Neighboring service/events/wait/prompt/local/scoped CLI regressions are required.

Oracle prerequisites: Node 24 (`24.21.0` in the recorded run), isolated
`npm ci --ignore-scripts`, then
`node node_modules/typescript/bin/tsc -p tsconfig.json`. Task-only empty npm
config files keep this separate from user config; dependency registry fetches
are prerequisites, not diagnostic network qualification. All feature tests use
scratch homes, synthetic credentials and controlled peers. No actual Chrome,
provider/account, OS service manager or diagnostic network probe is exercised.

The full doctor proposal remains in the migration workspace at
`STATE/R4-DOCTOR-IMPLEMENTATION-PROPOSAL.md`; this command does not satisfy its
complete offline-plus-network gate or activate `doctor.run`.

Unknown UTF-16 keys in package metadata, daemon status and browser state preserve the pinned version and known display fields. Whole browser JSON remains opaque. Three additional actual Node/Rust scenarios add twelve RU/EN/text/JSON comparisons.
