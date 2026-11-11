# Permission timer compatibility

Permission expiry uses Node 24 timer semantics for the existing configuration.
`Options::from_timeout_ms` accepts finite nonnegative milliseconds, checks the
original value against 2,147,483,647 ms, then truncates valid fractional values.
Zero, sub-millisecond and overflowing values become 1 ms. Duration-based callers
receive the same normalization. The default remains 600 seconds; longer valid
timeouts are accepted. Checked deadline arithmetic cannot panic on huge inputs.

Validation: 22 broker tests (19 existing durability/cancellation cases plus three
timer regressions), two actual Node 24 timer-oracle tests, and one Duration/factory
consistency unit test. The oracle clears every timer immediately and has a
10-second watchdog. Local runs require the pinned Node 24 in PATH, matching the
Rust CI workflow. No provider, credential or network calls occur.
