# Narrow replay comparison

After building the final release binary, with other local builds stopped:

```sh
node spike/rust/compare/replay-benchmark.mjs \
  --rust /absolute/checkout/spike/rust/target/release/pult-r1 \
  --out /tmp/unused-replay-results.json
```

Defaults: ten trials per runtime, alternating order, 10 000 records with 256 ASCII payload bytes.
Each run gets a fresh mode-0700 home and byte-identical mode-0600 complete journal. Both peers must
reject corruption and sequence gaps, then produce the same byte count, record count and SHA-256.
The Node peer checks file/record limits and sequence, validates all records before emitting output.
It ignores an incomplete tail; Rust repairs it. Only complete journals are benchmarked. The peer
does not reproduce Rust's writer lock or arbitrary JSON canonicalization/u64 range: there are no
concurrent writers, complex values or large sequence numbers in this fixed fixture.

Wall time spans process startup through final stdout close, including validation, serialization,
pipe transfer and sampling overhead. This is filesystem-cache-warm repetition, not a cold-disk test.
The harness samples each process with the same `ps` command every 20 ms. Short processes may have
few/no samples: null means unobserved, and sampled RSS is not a guaranteed peak. The harness,
`ps` itself and unrelated processes are excluded; this replay path creates no provider processes.

This measures replay of one shared fixture, not Pult performance, provider turn latency, durability,
permissions, socket throughput or ACK semantics. It cannot pass R1's overall migration gate or
justify the plan's 25% daemon-memory target. Keep raw results and their commit/binary hashes.
