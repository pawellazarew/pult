# Preserve typed event metadata during redaction

The Codex normalizer now applies secret filtering at the Node mapper's actual
field boundaries. Message/question/live/error text is filtered as strings; tool
inputs and stripped result content are filtered as complete untrusted subtrees.
Typed counters, structural IDs and model/status metadata are not generic secret
objects. Otherwise the production secret-key rule turns inputTokens into a
string, and the token rule merges distinct hexadecimal tool IDs.

The injected Redactor accepts arbitrary JSON roots and must preserve the root
type. Panic/error discards the complete batch; final event/batch budgets and
question-label validation remain enforced. Runtime reentry tests exercise the
string boundary as well as the earlier object boundary.

Both production-filter regressions were confirmed failing before the fix.
Twenty-two normalizer tests include eight streams compared with the actual
built Node mapper; worker tests verify the changed callback contract composes
with real process ownership and cancellation. No provider/account is contacted.
