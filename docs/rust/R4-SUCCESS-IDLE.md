# Successful turns become idle

The Driver now commits `status.changed {status:"idle", turnId}` after a successful
turn. This matches the actual public Node Claude, Codex and ZCode adapters. A
successful reply ends the turn and makes the conversation available for another
input; it does not close the conversation.

Only the Outcome::Success terminal-status leaf changes. Start/acceptance, exact
Ticket and public turn, durable user/queue/question receipts, native IO, close
acknowledgement, quarantine, terminal journal append and slot-release ordering
are unchanged. Successful idle is still unavailable until owned cleanup and the
terminal append have completed. Failure, limit and interruption policy is outside
this slice.

Explicit `done` remains a valid status. Node explicit adapter.close still emits
it, and the Rust reducer still accepts explicit status.changed done and
session.ended. Historical/recovered/archived done records are not rewritten.
No snapshot, registry migration, catalog, CLI, State or provider Worker change is
introduced.

The independent `rust/tests/success-idle-node-oracle.mjs` imports actual compiled
public Node adapters, starts their explicit repository fake executables, and
plays prerecorded simple native streams. It injects network/schema checks and
uses a temporary fake HOME. It does not construct a private SDK, extract/eval a
finish function, run a provider CLI/account, or inspect a model response on the
network. It verifies successful outcome/turn identity and working->idle, then
explicit close->done, actual fake PID exit and adapter shutdown for all three
providers. Compiled Node output is rebuilt from this worktree before the oracle.

The new Rust regression uses real Driver/Registry/journal and a controlled
no-process Worker for three provider snapshots. It blocks close and checks that
no successful availability event or free slot appears early; after release it
checks the same receipt IDs, public turn, exact outcome, single close, terminal
commit and idle projection. A separate test preserves explicit/recovered archived
done. This is outcome/projection parity, not installed-native qualification.

Existing test adaptations change only successful-turn status predicates/defaults.
The quarantine negative assertion retains done and also rejects premature idle;
a general terminal helper adds idle while retaining done/failed/interrupted.
Receipt, privacy, queue, approval, native PID and cleanup assertions remain.
The independently qualified ZCode shared-memory acceptance is retained. Its two
success predicates now expect idle; all nine memory scenarios and their receipt,
provenance, approval, revocation and PID-cleanup checks remain unchanged.

Wait remains unported. This corrects one prerequisite for future agent.wait;
it does not add WaitHub, answer-outcome storage, long polling, native approval
Broker parity or production cutover.
