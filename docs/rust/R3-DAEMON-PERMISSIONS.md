# Daemon-owned permissions, separate from provider lifetime

State owns one shared Broker. Its lazy initializer reads only the checked Pult
configuration; it does not discover Codex, Claude, a worker holder or curl.
Provider bootstrap receives this Broker through CodexRuntime::new_daemon.
Standalone library constructors preserve their previous ownership behavior.

Memory and scoped Claude questions, owner perm.list/resolve and session pending
counts use the same facade. Existing host/test construction can adopt the
already-created standalone runtime Broker, preserving pending cards instead
of accidentally creating a second Inbox. No new owner/ask authority is granted.

Provider-local daemon shutdown cancels and joins its exact owned Tickets and
processes; it cannot close the global Driver, Broker or a shared network guard.
The daemon seals global admission, closes the shared Broker, joins initializer
work and provider cleanup, drains permission IO, then joins Driver/host jobs
before releasing its ownership lease. Journal uncertainty still closes global
execution admission intentionally.

Initializer freshness is checked after waiting for runtime_init, before either
cached return or configuration IO. Broker creation and random generation happen
outside execution_admission. The final stop/fault check and publication share
that bounded in-memory gate with shutdown; an unpublished rejected Broker drops
its admission owner and closes. Shutdown also repeats Broker close after the
initializer barrier. No filesystem operation or callback runs under admission.

Tests cover initialization with no provider runtime, owner resolution of the
same Inbox, invalid config, global storage failure, independent Driver lifetime,
and three deterministic shutdown races. The previous implementation fails all
three race regressions. This is fixture verification, with no model/account
calls or installed service changes.

This facade does not by itself wire Claude/ZCode provider dispatch into the
stock daemon. Selected-provider bootstrap/router, full provider parity and
working-install cutover remain separate acceptance steps.
