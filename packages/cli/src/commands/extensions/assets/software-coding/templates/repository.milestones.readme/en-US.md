# Milestones

## 用途

This folder holds **milestones and the roadmap**: delivery routes, product-line grouping, milestone status, and each milestone's charter/exit records. It answers "what do we deliver in what order, and where are we now".

## 怎么用 (How to use)

- The top level holds the global view: the roadmap table, the decision-ledger index (`00-decision-ledger.md`), artifact-contract templates, parity / implementation-status matrices. The full roadmap body lives in `00-roadmap.md` in this folder.
- One subdirectory per product line (e.g. `foundation/ platform/ gui/ product/ commercial/`); each milestone gets its own folder inside the matching product-line directory.
- Advancing milestones is an **orchestration/planning activity**, not a load-bearing architecture choice. For load-bearing choices, open a decision (`../decisions/`) and point to it from the milestone docs — do not restate decision content here.

## 放什么 / 不放什么 (What goes here / what does not)

- ✅ Put: the roadmap, milestone status and exit-gate records, cross-milestone parity/status matrices, product-line grouping.
- ❌ Do not put: the full argument for a single decision (→ `../decisions/` + `../adr/`), day-to-day task progress (→ task package), the technical-architecture source of truth (→ `../context/architecture/`).

## 相关命令 (Related commands)

Milestones are currently maintained as authored documents; land cross-milestone load-bearing choices with `ha decision propose ...` and reference them from here by pointer.
