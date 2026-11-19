# Exact integration notes — 2026-11-19

SDK revision is in upstream-revision. Sources: Exact README, docs/start-here.md,
docs/contract-grammar.md and scripts/app-shells.mjs at that revision.

- An external app without app.ts still chooses generated JS shells unless rust.data
  names a local crate. For HTTP-only Contract sources, supply an empty DataSource:
  the runner owns the HTTP reads. This avoids the offline Hermes bundle prerequisite.
- Canonicalize EXACT_CHECKOUT before emitting Cargo path dependencies. On macOS,
  /tmp and /private/tmp spelling differences caused a lockfile collision for exact-canvas.
- Contract source calls must repeat the declared result shape name, not a structurally
  identical name. The compiler reported type-source-declared with a useful location.
- Initial setup and full generated Apple workspace compile consume several GiB.
  Avoid concurrently compiling a second copy of the SDK merely to run Contract checks.

Verified: bridge unit tests; authenticated reads against the installed daemon; Contract
build --json --errors-only returns []. Native window verification is recorded in README.
