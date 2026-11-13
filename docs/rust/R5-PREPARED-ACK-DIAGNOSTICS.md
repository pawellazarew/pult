# Prepared ACK failure qualification

Issue [#144](https://github.com/pawellazarew/pult/issues/144) tracks a Linux CI
failure in `invalid_ack_with_term_before_exit_has_confirmed_cleanup`. The
original panic guard hid its assertion location, so the failing phase is unknown.
The test uses its own Python bad-holder and does not run the production Rust
holder. A shared cause with the separate holder drain failures is not established.

The original acceptance remains: an invalid ACK retains its process owner; TERM
produces a confirmed signal exit, expires the stop handle and joins an empty
private stderr stream. The 12-second watchdog, executable fixture, success path
and assertions are unchanged. Only failure branches report static phases:
prepare, ACK, stop, exit code, expired stop handle, stderr receipt and stderr size.
No launch arguments, paths, native frames, error messages or stderr bytes print.

`SpawnFailure::io_error_code()` exposes an optional OS number to the trusted host.
Actual spawn errors retain only this number alongside the existing sanitized
error; their contextual message is still discarded. Debug output remains limited
to whether a process owner was retained. This adds no spawn retry, fallback,
permission change, new process signal or cleanup authority.

An actual executable removed after preparation verifies a before-PID failure,
the ENOENT number and omission of the private fixture name from Debug. Local
macOS qualification of the original test, including 20 default-concurrency runs
of the previous 12-case binary, did not reproduce the Linux failure. Passing
those 240 cases is evidence about the local fixture, not a root-cause fix.

The next occurrence must identify its phase and support a controlled reproducer
before #144 is closed. These diagnostics do not qualify production cutover or
replace R5 observation.
