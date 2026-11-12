# Preserve typed event metadata during redaction

The Codex normalizer now applies secret filtering at the Node mapper's actual
field boundaries. Message/question/live/error text is filtered as strings; tool
inputs and stripped result content are filtered as complete untrusted subtrees.
Typed counters, structural IDs and model/status metadata are not generic secret
objects. Otherwise the production secret-key rule turns inputTokens into a
string, and the token rule merges distinct hexadecimal tool IDs.

The injected Redactor accepts arbitrary JSON roots and must preserve the root
type. Panic/error discards the complete batch. Per-event and accumulated-text
budgets and question-label validation remain enforced. Text/question and tool
payload tests exercise the string and subtree callback boundaries.

Both production-filter regressions were confirmed failing before the fix.
Twenty-two normalizer tests include eight streams compared with the actual
built Node mapper. Provider-worker integration is tracked by the later runtime
slice. This publication uses local fixtures without provider/account access.
