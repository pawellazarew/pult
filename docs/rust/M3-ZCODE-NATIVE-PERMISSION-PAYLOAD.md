# M3: untrusted native permission payload, slice A

Status: inactive data-only preparation. Native permission approvals, Inbox wiring,
post-acceptance reply gates and Plan parity are not enabled by this slice.

Source base: Pult `def6b4ec258227125500bc741af6d31ae561254c`.
Native schema reference: zai-org/ZCode
`c5904686ea8341826b3affe5d993d06a134fa779`,
`packages/shared/src/zcode-protocol/index.ts` requestPermission and
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts`.
These are constructed fixtures and cached source references, not native CLI captures.

## Contract

`ReverseRequest::Permission` now owns `NativePermissionPayload`:

- `Retained(NativePermissionData)` holds one immutable original params backing.
- `ConservativeOnly(RetentionBudget)` explicitly records that the complete valid
  payload cannot be retained under the host budget. No partial input is exposed.

Both secret-bearing public types have no Clone, Debug, Serialize or Deserialize.
Private temporary borrowed parser views implement Deserialize only to extract raw
subvalues after validation; they cannot mint public candidates or consent.

The original complete strict decoder runs first: NDJSON framing, frame/depth/node/
string limits, duplicate keys at every nesting level, envelope and permission shape,
option responses and origins all retain their existing checks. Only after success
are borrowed RawValue views extracted. Validating through RawValue alone would be
insufficient and is not supported.

One `Box<RawValue>` preserves the original params bytes, including numeric spellings,
escapes, field order and internal whitespace. Fixed checked ranges identify fields
inside that exact immutable backing. There is no unsafe code, self-reference, parsed
Value retention or separate copy of input/options/origin. Raw getters borrow the
original token; string getters decode bounded text on demand. Caller-created strings
and copies are not stored in the candidate. Input remains arbitrary JSON: objects,
arrays, strings, numbers, booleans and null are not coerced to another shape.

`untrusted_*` means exactly that: tool name, tool call, reason, risk, optional turn ID,
origin, offered options/response and the whole params are native claims. Missing TID
remains None. A low-risk label, a memory-looking tool name, offered allow/modified
input or persistent permission rules provide no host authority. No approval,
execution source, Owner/Driver receipt or reply permit is constructed here.

## Retention budget

`MAX_PERMISSION_RETENTION_BYTES = 256 * 1024` bounds the logical retained candidate
storage before allocating the raw copy. Its formula is:

```
raw_params_bytes
+ size_of::<ReverseRequest>()
+ decoded_outer_RPC_string_bytes (0 for integer RPC id)
+ decoded_session_id_bytes
+ decoded_request_id_bytes
```

The fixed size includes the payload/ranges/enum and existing String metadata. The
three string contents are counted even though these correlation copies existed
before this slice. The raw backing already contains the original input, options,
origin and original correlation fields, so none are counted as a hidden extra copy.
Allocator bookkeeping and temporary strict-decoder storage are not a process RSS
claim. This is a per-candidate logical storage cap, not a new aggregate Inbox budget.

At the boundary, the complete candidate is retained; one byte beyond it yields the
explicit ConservativeOnly state. Correlation metadata remains under the prior small
ID limits. Large payloads still undergo all strict validation before that state can
be returned. The independent transport cap remains 16 MiB; exceeding the host
retention budget does not truncate input or relax transport validation.

## Conservative behavior and boundaries

`default_deny` is unchanged. Every retained/over-budget permission still returns the
same bytes with the original RPC id and static decision deny; options and original
input never influence it. Runtime-preference defaults and UserInput cancellation are
also unchanged. Existing Worker interactions move the opaque candidate and keep the
conservative response behavior.

No Worker, Runtime, Owner, Broker, launch, route, config, MCP process or memory-backend
source changes are part of this slice. No native provider/account/real CLI is used.
A future approval bridge needs exact accepted source and original RPC/params binding,
a one-use human receipt, a current-policy post-acceptance reply gate and owned
cancel/drain handling. This payload alone cannot close the native Plan approval gap.

## Qualification

Pure codec tests cover all fields, optional TID, arbitrary input shapes, original
lexical params/input/options identity, exact conservative reply bytes, complete budget
boundary accounting, larger valid conservative-only payloads, and strict validation
before budget fallback. Public compile-fail tests independently reject Clone, Debug,
Serialize and Deserialize on each secret-bearing type. Existing conservative
app-server Worker regressions remain required. Exact tested commit, counts, command
logs and file hashes are recorded in the external migration handoff.
