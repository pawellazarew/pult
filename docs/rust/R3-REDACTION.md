# Runtime secret filtering

`redaction::redact_string` and `redaction::redact` preserve the current
`src/core/log.ts` rules and replacement order. The Rust implementation retains
ECMAScript ASCII word boundaries and case folding, exact URL whitespace,
case-insensitive secret field names, and the depth-eight limit. It accepts JSON
values; real JavaScript Error objects and unpaired UTF-16 require their separate
host decoding/normalization boundaries.

Email addresses remain visible in ordinary text and nested values. Known tokens,
secret-named field values and URL credentials continue to be filtered. Repository
privacy checks keep their existing email and credential rules.

Twelve interoperability tests compare a bounded synthetic adversarial corpus
against the actual Node source functions and regex rules, including lengths,
Unicode adjacency, URL credentials, ordering, nested keys and prototype fields.
The turn-memory `mt_` plus 64-hex format is also hidden with embedded prefixes
and ASCII upper-case representations; credential-shaped object property names
conceal their values. Typed journal metadata uses the same explicit-format
filter without hiding ordinary opaque IDs.
The oracle has a ten-second watchdog and bounded input/output; no live secrets,
provider login or network calls are involved.

This module filters known secret patterns. Its existence does not authorize raw
provider data to bypass typed routing, storage budgets or permission redaction.
