# Read-only runtime bootstrap

The trusted host loads its existing configuration and resolves executables before
creating a Codex runtime. No CLI, provider, credential file or network request is
opened by this step. Child environment is rebuilt from the existing base allowlist;
ambient tokens, loader hooks, proxies and memory authority are not inherited.

Configuration is an owned private regular file without links, opened with
NOFOLLOW/NONBLOCK and bounded to 1 MiB plus an overflow byte. Descriptor/path
identity and metadata are checked before and after reading. Missing files use the
normal defaults; syntax/encoding/lone-surrogate errors and unsafe/changed files
reject startup. Valid JSON values retain the existing parser's warning/default
semantics. Diagnostics contain fixed codes rather than file or environment data.

Codex comes from a trusted absolute override or an absolute PATH entry; cwd and
relative PATH entries are skipped. The fixed prefix is `app-server`, never shell
text. The worker holder defaults to a sibling of the supplied current executable,
and curl to `/usr/bin/curl`. Holder/curl fixture overrides require exact PULT_TEST=1
and are removed from the child environment. Selected binaries are canonical
regular executable files; system-owned executables are supported.

Validation: 14 integration tests and two deterministic file-race tests, with no
subprocess or network calls. The caller must hold the same home's daemon lease.
These are checked startup snapshots, not immutable handles preventing a trusted
same-user process from replacing an executable after validation.
