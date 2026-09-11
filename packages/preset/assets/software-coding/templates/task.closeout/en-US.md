# Closeout

Replace this file's placeholder content before closeout; `ha task complete` rejects placeholder text. Closeout summarizes the verdict, but it does not replace the fact ledger or decision/relation records.

## Summary

Summarize the completed behavior change.

## Verification

List passing applicable checks, the Review result, and any explicitly promoted
`F-...` Facts. CI belongs here only when the resolved completion contract
declares it; Facts remain optional `0..N` promotions (dec_mrg3z1we/CH4;
ADR-0027 D7).

## Residual Risk

Record accepted non-blocking risks; if a risk affects later choices, create or relate a decision.

## Same Mechanism Elsewhere

State what this task found as one sentence about a **mechanism**, with the
caller, the resource type, and the symptom stripped out. Then search the
repository for that sentence and write down what came back.

A defect named after where it surfaced only ever finds itself. "The first paint
is slow" searches the interface code and stops there. The same defect named
after its mechanism — "one read request's downstream call count grows with the
size of its result set" — finds the sibling sitting in the server.

Answer all three parts: the mechanism sentence, how you searched for it, and
what you found. "Nothing else" is a valid answer when it is the honest one, and
it is worth more than silence because it says the search happened. If this task
changed no behavior, say why the question does not apply here instead of
deleting the section.

This is a question, not a checkbox. Answering it with a tick mark defeats the
only thing it is for.
