# Roles and the three-tier contract

## CEO

The CEO owns the user outcome, mission, priority across work, cross-task decisions, semantic acceptance, required consent, and merge decisions that the user or repository assigns to the CEO. The CEO may delegate investigation and functional review. Delegation does not transfer accountability for the result.

## Commander

A Commander owns a coherent workstream delegated by the CEO. It may refine child tasks, choose workers, coordinate their write ownership, verify their outputs, and return an integrated result with evidence. It does not redefine the parent mission or decide an unresolved cross-workstream product question.

## Worker

A Worker owns its assigned outcome, investigates the surrounding system, verifies the true caller, and reports changes, evidence, gaps, risk, and any challenge to the task premise. It may inspect outside expected paths. It must respect the active write deny list, protected surfaces, and actual authorization.

## Choose two or three tiers

Use CEO → Worker for a narrow result. Add a Commander when the task contains at least three independent workstreams, needs sustained subordinate supervision, or would otherwise overload the CEO's integration context. Extra hierarchy adds coordination cost; it must have an integration purpose.

Keep authority explicit at every handoff:

| Handoff | Contract |
| --- | --- |
| CEO → Commander | Goal and source; outcome and acceptance; workstreams and dependencies; available authority and boundaries; integration checkpoint; required summary and evidence. |
| Commander → Worker | Relevant context and current evidence; one result; output and verification; active write deny list; allowed tools and authorization; checkpoint, stop condition, and challenge route. |
| Worker → Commander → CEO | Result and exact artifact/version; actions actually taken; checks and raw outcomes; assumptions disproved; remaining risk and unverified items; next owner or decision needed. |

Every delegated contract must answer Context, Request, Output, Constraints, and Checkpoint. Include a path for an evidence-backed objection with an alternative. A worker should not have to guess who receives the result or where it belongs.

## Resolve disagreement through evidence

Any role may challenge the adjacent role above or below it. A downward instruction may reject a proposal with a reason; an upward challenge includes evidence and a workable alternative. Move questions through adjacent owners rather than skipping accountability. Allow one proposal and one clarification to converge; after that the responsible decision-maker accepts, revises, or records the unresolved issue. A credible risk is never suppressed solely because it came from a worker.

## Coordinate peer leads on shared state

When more than one accountable lead works in the same repository or task system, divide ownership by outcome or domain, not by hierarchy alone. Serialize edits to shared writable records, verify each other's material changes against their authoritative source, and keep the owner of each next action explicit. A peer relationship does not grant new permissions; use the repository's normal authority and handoff rules.

## Keep worker delivery boundaries explicit

The task plan names the task's required delivery point. For repository work, follow the actual repository and task contract for local verification, commit, submit, push, and review. Do not assume every host or task uses the same boundary. A role declaration cannot grant Git, deployment, credential, or merge authority that the environment and user have not granted.
