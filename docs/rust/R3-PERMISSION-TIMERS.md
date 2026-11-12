# Permission timer compatibility

Permission expiry uses Node 24 timer semantics for the existing configuration.
`Options::from_timeout_ms` accepts finite nonnegative milliseconds, checks the
original value against 2,147,483,647 ms, then truncates valid fractional values.
Zero, sub-millisecond and overflowing values become 1 ms. Duration-based callers
receive the same normalization. The default remains 600 seconds; longer valid
timeouts are accepted. Checked deadline arithmetic cannot panic on huge inputs.

Validation covers 26 broker integration tests (23 existing durability, cancellation
and early-resolution cases plus three timer regressions), two timer-oracle suite
tests and one Duration/factory consistency unit test. The oracle suite compares
the actual Node 24 timer-list buckets and checks invalid floats/defaults. It clears
every timer immediately and has a 10-second watchdog. Local runs require the
pinned Node 24 in PATH, matching the Rust CI workflow. No provider, credential or network calls occur.
