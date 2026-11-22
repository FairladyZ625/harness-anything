---
name: gate-customization
description: Author, dry-run simulate, and troubleshoot declarative completion sources, JSON Schema predicates, and artifact bindings in vertical and preset packages using `ha vertical init`, `ha preset init`, and `ha vertical simulate`.
---

# Completion Gate Customization (FDE Declarative Gate Workflow)

Define domain completion contracts declaratively inside `vertical.json` or `preset.json` (`completion: { sources, gates, closeoutDefaults }`), never in `harness.yaml settings.gates` or hardcoded CLI branches. Task profiles only select gate ids; `ha task submit` freezes the selected sources, bindings, and command scripts with the accepted submission cut.

```text
completion.sources[sourceId] ── gate.source ──▶ completion.gates[gateId] ◀── profile.completionGates
                                                        │
                     ha vertical simulate (sandbox) ────┴──── ha task submit (frozen cut)
                                                        ▼
                      command / external / manual witness ─▶ JSON Schema + JSON Pointer bindings
```

## Source Routes & Gate Fields

| Source `kind` | Witness producer | When to use |
| --- | --- | --- |
| `command` | Declared preset script (`<preset-id>/<entrypoint-id>`) emitting `preset-script-result/v1` with `completion-witness` | Deterministic verification of submitted artifacts (JSON/CSV/Markdown/hashes) |
| `manual` | Human testimony via `ha task attest <task-id> --gate <gate-id> --result pass` | Human sign-off gates (runtime executors cannot attest) |
| `external` | Pre-authorized external runner role | External execution systems already configured on the repository |

- **Scope**: set `appliesTo` to `artifacts` (non-code delivery), `code`, or `submission`.
- **Subjects**: `"all-artifacts"` or an explicit list of logical paths under `artifacts/`.
- **Bindings**: map predicate fields to `{ artifact: "artifacts/<file>", pointer: "/<rfc6901>" }`. At verification time, `completionPredicateIssues` enforces both `resultSchema` (JSON Schema) and exact equality against the frozen artifact bytes.
- **Retired**: do not use hosted CI source kinds or `checkerProfile` (rejected by schema validation).

## Fast FDE Authoring & Probe Loop

1. **Scaffold a working gate baseline**:
   - New vertical: `ha vertical init <domain>/<name>` creates `deliverable-contract` in `vertical.json`, `checks/verify-deliverable.mjs` in the default preset, and `samples/deliverable-contract/{positive,negative}.json`.
   - Additional preset gate: `ha preset init <preset-id> --vertical <domain>/<name>` creates a self-contained `<preset-id>-contract` gate, checker script, and positive/negative sample fixtures.
2. **Tailor the contract**:
   - Tighten `resultSchema` (`required`, `properties`, `const`/`enum`, `additionalProperties: false`) and `bindings` to match your domain artifact.
   - Update `checks/verify-deliverable.mjs`: read `JSON.parse(process.env.HA_PRESET_INPUT).witnessInput`, inspect frozen files via `witnessInput.subjects`, preserve subject identities (`{ file, ...identity }`), and emit `{ schema: "preset-script-result/v1", produces: [{ capabilityId: "completion-witness", payload: { result, subjects, predicateType, predicate, diagnostic } }] }`.
   - Update `samples/<gate-id>/positive.json` (valid payload) and `samples/<gate-id>/negative.json` (intentionally defective payload).
3. **Run positive & negative probes in zero-side-effect sandbox**:
   ```sh
   ha vertical simulate --source <domain>/<name> --preset <preset-id> --json
   ```
   Confirm `gates[].positive.ok === true` (`result: "pass"`, `predicateIssues: []`) and `gates[].negative.ok === true` (`result: "fail"`, `blockerCode: "gate_witness_missing"`).
4. **Live task verification & repair loop**:
   - On a live submitted task, a failing gate blocks `ha task complete` with `gate_witness_missing`.
   - Repair the submitted artifact, run `ha doc sync --submit --task <task-id>`, then `ha task submit <task-id> --execution-id <exec-id> --amend` (or `ha task witness-rerun <task-id> --execution-id <exec-id> --gate <gate-id> --run-id <run-id> --reason "..."`).

## Troubleshooting Matrix

| Symptom | Root cause & remediation |
| --- | --- |
| `Gate <id> references undeclared source` | Declare `source` in merged `vertical.json` / `preset.json` `completion.sources`. |
| `entrypoint_not_found` | Check `<preset-id>/<entrypoint-id>` matches an installed or vertical-bundled preset entrypoint. |
| `missing_provider` | Ensure `capabilities.json` declares `completion-witness` (`checker` v1) and the preset both imports and `produces` it. |
| `missing_gate` | Ensure every id in `profiles[].completionGates` exists in merged `completion.gates`. |
| `gates.<id>.predicate.<field>` | Witness predicate failed `resultSchema` or did not match the bound JSON Pointer in the frozen artifact. |
| `unknown field "checkerProfile"` | Legacy manifest blocked in user layer; run `ha preset uninstall <id>` or migrate to `completion.sources`/`gates`. |
| `gate_witness_missing` | No passing witness for current submission digest; repair artifact + amend submit, or rerun gate. |

## Contract Boundaries

- Schema & predicate validation: `packages/kernel/src/schemas/completion-source.ts`, `packages/kernel/src/schemas/completion-predicate.ts`.
- Resolution & sandbox simulation: `packages/preset/src/preset-runtime.ts`, `packages/preset/src/vertical-simulate.ts`.
- Live witness execution: `packages/daemon/src/daemon-host/repo-cell-command-witness.ts`.
