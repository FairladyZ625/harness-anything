# Gate Architecture Retrospective Analysis Scaffold

> This is the editorial scaffold. Write the final report to `artifacts/gate-retro.analysis.md`; keep this scaffold as source guidance.

<!-- gate-retro:ground-truth-warning -->
## Ground-Truth Rule

Every architecture-rot accusation must include reproducible evidence: command plus output. Pure impressions are forbidden. The 171-to-162 baseline correction is the standing warning: a number copied from memory is not evidence.

Use `artifacts/gate-retro.snapshot.json` as machine context, then verify claims with commands before writing findings.

<!-- gate-retro:snapshot-summary -->
## Snapshot Summary

- Snapshot: `artifacts/gate-retro.snapshot.json`
- Gate surface command: `node tools/check-gate-surface.mjs`
- PR approximation command: `npm run check:pr`
- Full command: `npm run check`
- Previous snapshot used:
- New files/modules since previous snapshot:
- check:pr vs check difference:

<!-- gate-retro:adr-checklist -->
## ADR-0022 D6 Checklist

For every finding, answer all four questions.

| Question | Answer | Evidence ref |
| --- | --- | --- |
| Boundary gate or local-consistency only? |  |  |
| Was an AST import layer, import graph, or equivalent graph tool used for graph invariants? |  |  |
| Is the authority external to the gate implementation? |  |  |
| Does the boundary claim have a documented bypass fixture? |  |  |

ADR-0023 D4 reminder: architecture review may cite boundary, release-policy, and meta-governance evidence. Local-consistency gates do not prove architecture boundaries.

<!-- gate-retro:defect-patterns -->
## Defect Pattern Attribution

Classify each confirmed friction into one or more ADR-0022 patterns.

| Pattern | Applies? | Evidence ref |
| --- | --- | --- |
| Regex guarding a graph invariant |  |  |
| Self-referential authority |  |  |
| Authority rewritable in the same PR |  |  |
| ADR text without enforcement code |  |  |
| Enforcement surface drift |  |  |

<!-- gate-retro:evidence-ledger -->
## Reproducible Evidence Ledger

Use one evidence block per claim. Do not report a rot finding without a block like this.

<!-- finding:start -->
### Finding: Replace with claim title

- Severity: local / boundary / load-bearing
- ADR-0022 D6 category: boundary / local-consistency
- ADR-0022 defect pattern:
- ADR-0023 D4 evidence class:
- Claim:

Command:

```sh
# command run from repository root
```

Output:

```text
# paste relevant output; do not paraphrase the only evidence
```

Interpretation:

Decision/ADR projection:

- If load-bearing, run `ha decision propose ...` and cite the decision ref here.
- If not load-bearing, state why no decision is required.
<!-- finding:end -->

<!-- gate-retro:decision-projection -->
## Decision / ADR Projection Gate

| Load-bearing issue | Decision proposed? | Decision ref | ADR projection needed? | Owner |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

The report is incomplete if a load-bearing problem is only described here. It must become a decision first, then project into ADR work when appropriate.

<!-- gate-retro:verdict -->
## Verdict

- Overall status: no new rot / monitor / decision proposed / blocked
- Required follow-up tasks:
- Residual risk:

