# R3 — network route guard

`NetworkGuard` ports the profile/exit-country decision to Rust. Required with
no proxy or a dead proxy never falls back to Direct. Auto may fall back, but
the direct exit must pass the same country rule. Unknown location and partial
nonzero-exit traces cannot authorize a route. Probes use the two existing
HTTPS trace endpoints; TCP port availability is never used as proof.

Curl runs with -q first, an explicit -x value (empty for Direct), an eight
second deadline and a freshly constructed environment. Stdout is bounded to
64 KiB; stderr is drained/counted without retaining its content. At most eight
owned jobs hold process/permit ownership through cancellation and kill/wait.
Dropping the caller cancels the probe; its owned task continues only cleanup.
Shutdown closes admission, cancels active probes and supports drain. Runtime
destruction has only kill-on-drop fallback and is not claimed as cleanup proof.

The 64-entry cache uses monotonic 60-second TTL and a structured key including
provider/profile/guard/noProxy. Settings invalidation increments generation.
An old in-flight probe cannot repopulate or return success after invalidation.
The host must invalidate on profile changes and compare generation again
immediately before actual dispatch/reuse. A Check is trusted host data, not an
unforgeable authorization object or a client-supplied RPC parameter.

`worker_environment` applies the checked route to the existing environment
allowlist. Codex Proxy receives both HTTPS_PROXY and ALL_PROXY: its WebSocket
transport needs ALL_PROXY and HTTPS fallback needs HTTPS_PROXY. Claude/ZCode
receive only HTTPS_PROXY. Direct removes both old/ambient proxy values.
NO_PROXY is replaced with base localhost entries plus deduplicated profile
extras, matching existing policy. The guard probes trace endpoints; configured
NO_PROXY destination exceptions retain the current Node policy. Explicit
extras may contain a scoped memory key for a dedicated worker, but never put
a session memory key into a shared Codex app-server's global environment.

Strict country-rule parsing uses the existing 250-code table including XK.
Location parsing preserves JavaScript multiline separators; invalid UTF-8
trace bodies fail closed instead of Node's replacement decoding.

21 injected/fake-curl tests cover profiles, rule semantics, truncation, cache
TTL/key/generation races, stdout/stderr bounds, cancellation/reaping, shutdown
and route-to-environment behavior. Unicode line-separator and missing Codex
ALL_PROXY regressions were confirmed RED before fixing. Three worker-env
unit tests verify ambient authority is not inherited. No test needs network.
This library still needs settings/doctor/provider/driver integration.
