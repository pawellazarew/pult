# Rust runtime configuration

The `runtime_config` module parses the existing Node configuration document into
explicit runtime settings. It performs no filesystem access, provider probes or
configuration writes. The host must retain the original document for surgical
updates and reject file decoding failures before invoking the parser.

The parser preserves Node defaults and `configToFile` output, including all four
network profiles, fail-closed malformed explicit guard rules, legacy guard country
strings, provider-specific new-session defaults, and finite nonnegative timer
values (including zero and fractions). Parsing a timer does not establish that a
consumer has implemented the corresponding timer semantics.

Diagnostics contain fixed warning codes and known field paths. Debug output hides
configured command, proxy, model, URL and legacy country contents. A normalized
`to_file()` value is private configuration data, not a diagnostic payload.

Validation: 20 focused Rust tests and two interoperability/privacy tests. The
interoperability test runs the actual built Node implementation on 30 inputs and
compares its serialized output. Use Node 24, `npm ci --ignore-scripts`, and
`npm run build` before running the interoperability tests. No credentials or
network access are required.

This slice does not enable provider execution, change installed configuration, or
implement persistent settings updates. The eventual host must serialize writes
and use the established owned atomic-storage contracts.
