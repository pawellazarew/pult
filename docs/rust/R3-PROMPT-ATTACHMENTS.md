# R3 — prompt attachment boundary

`prompt_attachments` validates the current metadata format and builds provider
input. Files must be copied under the exact session/day/file boundary in
PULT_HOME/attachments, with real non-symlink attachment directories and file.
A canonical alias of home is allowed. Directory attachments remain explicit
references to real non-symlink directories and are never opened/read here.

Limits match Node: at most 20 attachments, 25 MiB per file, UTF-16 length limits
for path/name/MIME, zero-byte directory metadata with inode/directory MIME.
Native PNG/JPEG/GIF/WebP input is opened with NOFOLLOW/NONBLOCK, checked using
fstat, read with a size+1 bound and matched to its content signature.
Codex receives localImage references; Claude receives provider-only base64
blocks. Image bytes must never be appended to the visible user journal.

Prompt context uses the existing Node-compatible JSON string encoder and the
existing Russian attachment heading. Errors and Debug omit names, paths and
content. Unlike accidental Node coercion, kind must be a string. Unsupported
UTF-16 strings cannot be represented in the typed input and fail closed.

This preserves the current boundary, not a filesystem snapshot. Parent
replacement between validation and open, same-size content edits and Codex
reopening localImage retain the current Node TOCTOU limitations. There is no
new promise of protection from malicious processes running as the same user.

14 filesystem/provider-input integration tests and one deterministic
grow/shrink read unit test cover scope, symlinks, FIFO, metadata limits,
directories, MIME, Unicode, prompt escaping and native inputs. The module
is not yet connected to execution RPC, journal metadata or provider adapters.
