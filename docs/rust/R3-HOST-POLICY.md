# R3 — host access policy and consent

This library slice does not expose execution RPC or authorize process launch.
The production host must refresh these facts immediately before dispatch and
connect them to the driver, provider retirement and settings RPC.

## Access decisions

`host_policy` separates desired and effective approval. Full without consent,
including Claude inherited bypass, becomes explicit Ask with a revision-keyed
notice. Unknown Inherit is not guessed to be Full. Consent covers only listed
providers and requires a recognized grant date, supported version and no
revocation. The legacy `cli-once` grant lasts for the session, as in Node.

Selection validates source even on configure no-ops. Shell cannot request a
CLI grant. Full requires confirmation; stale consent revisions fail before
coverage checks. An allowed no-op cannot install a new grant. An actual mode
change clears the previous grant unless explicitly renewed.

## Durable consent

`ConsentStore` reads the existing `consent.json` wire format, refreshes on every
read and preserves a revision high-water mark across deletion or corruption.
It requires an owned 0700 home and an owned 0600 regular file without symlinks
or hardlinks. Reads and writes are bounded to 64 KiB. Replacement uses a
private random temporary file, file sync, rename and directory sync.
Identity/content checks reject observed external edits. This is a single-writer
host contract, not a cross-process locking protocol. An uncertain commit after
rename poisons the store until reopening; no successful grant is inferred.

Rust supports a subset of V8 date grammar. Any unrecognized revocation string
(including unrepresentable UTF-16 strings) blocks Full and is presented as a non-grant to consumers. This intentionally
stricter behavior prevents an unfamiliar Node-valid date from restoring access.
An explicit new grant or revoke resolves the ambiguity with a higher revision.
Debug output hides raw date strings.

## Workspace guards

`host_paths` rejects a working directory that is PULT_HOME or an ancestor,
using canonical paths with a lexical absolute fallback for unavailable paths.
General workspaces must be the exact owned session directory under
`conversations/<name>-<six ASCII alphanumeric characters>`. Symlink roots,
foreign session names, traversal and non-private directories fail without
filesystem repair. Requiring mode 0700 is stricter than Node validation; Node
already creates managed directories with that mode.

## Verification and remaining integration

21 policy, 15 filesystem and 15 consent integration cases cover selection
ordering, grants, aliases, permissions, wire parsing and revocation. Three
private failure-injection tests cover pre-rename retry, external edits and
post-rename uncertainty. These do not replace live execution parity checks.
Attachments, network routing, questions, queue acceptance and fresh pre-send
checks remain required before enabling production execution. RPC stays 27/98.
