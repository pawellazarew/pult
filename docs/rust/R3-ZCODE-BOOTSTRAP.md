# Selected ZCode bootstrap

`runtime_bootstrap::load_zcode` is read-only startup work under the caller's
Pult-home ownership lease. It returns checked Pult configuration, BASE-only
`parent`, canonical holder/ZCode/curl paths, empty `prefix_args`, actual filtered
`child_home`, and a **separate** `extra_env` containing the seven explicit ZCode
configuration values from `zcode_launch::ENV_PASS`.

The loader calls `zcode_launch::extra_env(raw_parent)` before BASE filtering.
Empty config values are omitted; NUL or aggregate values exceeding 65536 bytes
are rejected without truncation. Unicode bytes are preserved. These values can
contain private paths or endpoint configuration and must not be logged. The
snapshot's Debug prints counts only. Ambient credentials, loader hooks, proxies,
Pult capabilities and bootstrap overrides do not enter either environment map.
The later checked controller must combine approved config values with its
selected NetworkGuard route and validate the final child environment budget.

Only ZCode is resolved. An explicit trusted-host `PULT_ZCODE_BIN` must be absolute,
available and executable; any failure refuses bootstrap instead of falling back
to PATH. Without it, lookup skips empty/relative PATH entries and resolves
executable aliases. Codex/Claude executables and overrides are irrelevant.
Holder/curl fixture overrides require exact `PULT_TEST=1`, matching the existing
loaders. No executable is run, including version/login probes.

The actual filtered HOME must be present and absolute. Its source bytes and
aliases are preserved; the directory need not exist. The loader does not read
native settings, provider config files, managed Claude settings or account/auth
files, and does not list native directories. Pult configuration uses the existing
private-file/snapshot checks and typed warning policy. Errors are static.
Existing `load` and `load_claude` bodies remain unchanged.

Tests use fake executable files and private temporary directories only. They
cover selected resolution, absent other providers, strict overrides, PATH/HOME,
all seven config values, filtering/privacy, bounds, unsafe config and warnings.
Marker scripts prove no CLI execution occurred. This is a bootstrap component;
State/router/Runtime/Worker/Driver wiring and R3 execution are not delivered here.
