# {{title}}

Task Contract: harness-task v1

## Brief

State the task's goal and scope in one line, plus the deliverable's shape and landing point.

## Context

Record inputs, known facts, and constraints: relevant code and document paths, out-of-bounds areas, stop conditions.

## Verification

List acceptance: the targeted tests and checks that must go green, and the stop point; add a negative control when the task repairs a defect.

## Recurrence Gate

Required for `--kind fix` tasks; other kinds may delete this section. Answer every line; do not leave it empty or keep these four prompt lines:
① Criterion: which class of code or plan wording would let this defect recur (name the mechanism, not this symptom).
② Gate: extend an existing gate first; name the gate and its file. The current gate list is `tools/gate-manifest.json`.
③ Positive control: an input sample or minimal command the gate rejects, plus the expected rejection result.
④ If no gate is possible, state the reason and the substitute verification (for example a behavior contract test), and which failure that substitute covers.
