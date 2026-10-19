---
name: gate-customization
description: Define domain completion sources and task gates in vertical and preset packages, including artifact-only command checks, JSON Schema predicates, artifact bindings, closeout defaults, manual witnesses, validation, and submit/reject/repair behavior. Use when adding a domain completion gate or diagnosing a completion blocker.
---

# Completion Gate Customization

Use this skill to define a domain completion contract. The package declaration
names what must be checked; an installed command entrypoint, an authorized
external runner, or a human provides the witness. The task profile selects gate ids. Submit freezes
the selected source definitions and gate rules with the accepted submission.

```text
vertical/preset completion declaration
  sources[sourceId] ── gate.source ──> gates[gateId]
                                           │
profile.completionGates ───────────────────┘
                                           │ task submit freezes this cut
                                           ▼
                   command / external / manual witness → schema + bindings → complete
```

New domain gates belong in the package `completion` object, not in
`harness.yaml settings.gates`. A completion source does not grant runner
permissions or let the task executor supply its own pass result.

## Declaration model

The vertical owns completion rules shared by its presets. A preset may add
sources or gates when they are specific to that preset. The runtime merges both
declarations and rejects duplicate source ids, duplicate gate ids, undeclared
gate sources, and profile selections that do not resolve. Keep each declaration
in one package; a profile only lists gate ids.

`completion` has three fields:

| Field | Meaning |
| --- | --- |
| `sources` | A record keyed by a domain-owned source id. Every source has `kind`, `predicateType`, and a JSON Schema `resultSchema`. |
| `gates` | A record keyed by a gate id. Each gate selects a source and an `appliesTo` scope; it may select subjects and bind predicate fields to submitted artifacts. |
| `closeoutDefaults` | Domain fallbacks for `review`, `consent`, `factDisposition`, and `codeDoc`. Explicit repository and task-profile choices take precedence. |

The current source contract has three execution routes: `command`, `external`,
and `manual`. Hosted CI source kinds are retained only when reading frozen
history; new vertical and preset declarations reject them. CI status is read
from the hosting platform's pull request checks and is not copied into task
completion.
`external` declares a runner role and optional run-artifact outputs; declaring
it does not install a runner or grant a node permission. Use an external source
only when the target repository already has its authorized execution path.

Gate `appliesTo` is one of `submission`, `code`, or `artifacts`. Use `artifacts`
for an artifact-only delivery. The optional `subjects` value is
`"all-artifacts"` or a list of logical artifact paths. `bindings` maps a
predicate field to a JSON Pointer in an accepted artifact. The predicate value
must equal the value at that pointer in the frozen submission.

`resultSchema` validates the witness `predicate` object. Use JSON Schema
`required` and property types for the fields that must be present. A
`predicateType` names the meaning of that object; it is part of the frozen
source contract. Do not use a prose anchor list or a second result registry.

## Define an artifact-only research gate

This example checks a submitted CSV, PNG, and experiment metadata file without
a code commit. The vertical declares the source and gate. The `research-checks`
preset provides the command and selects the gate.

```text
verticals/research/vertical.json
verticals/research/template-catalog.json
verticals/research/capabilities.json
presets/research-checks/preset.json
presets/research-checks/scripts/anchors.mjs
```

The vertical root also requires `template-catalog.json` and
`capabilities.json`, even when its template catalog is empty. Register the
command's `completion-witness` provider in the latter so the declared preset
capability can produce the witness payload:

```json
{
  "schema": "preset-capabilities/v1",
  "providers": [
    {
      "id": "completion-witness",
      "kind": "checker",
      "version": "1",
      "actionKind": "completion-witness",
      "payloadFields": ["result", "subjects", "predicateType", "predicate", "diagnostic"]
    }
  ]
}
```

For a vertical without templates, use a `template-catalog/v2` document with a
valid `package` record and `"documents": []`. See
[vertical-creator](../vertical-creator/SKILL.md) for the complete vertical
package shape.

Add this `completion` object to the vertical package:

```json
{
  "sources": {
    "research/anchor-check": {
      "kind": "command",
      "entrypoint": "research-checks/anchors",
      "predicateType": "research/version-pinned/v1",
      "resultSchema": {
        "type": "object",
        "required": ["seed"],
        "additionalProperties": false,
        "properties": { "seed": { "type": "integer" } }
      }
    }
  },
  "gates": {
    "version-pinned": {
      "source": "research/anchor-check",
      "appliesTo": "artifacts",
      "subjects": "all-artifacts",
      "bindings": {
        "seed": {
          "artifact": "artifacts/experiment.json",
          "pointer": "/seed"
        }
      }
    }
  },
  "closeoutDefaults": {
    "review": false,
    "consent": false,
    "factDisposition": false,
    "codeDoc": false
  }
}
```

The four `false` values keep this small fixture focused on the custom gate;
choose review and consent defaults that fit the real domain. Do not use a
domain default to weaken an explicit repository or task requirement.

The preset profile selects that gate. The entrypoint id `anchors` is addressed
as `research-checks/anchors` from the source declaration:

```json
{
  "schema": "preset-manifest/v3",
  "id": "research-checks",
  "title": "Research checks",
  "vertical": "research/experiments",
  "version": "1.0.0",
  "kind": "process-action",
  "outputShape": "task-package-artifact",
  "kernelVersionRange": { "min": "1.0.0" },
  "capabilityImports": [
    { "id": "completion-witness", "kind": "checker", "version": "1", "required": true }
  ],
  "entrypoints": {
    "anchors": {
      "type": "script",
      "intent": "Check frozen experiment inputs",
      "inputs": [{ "name": "witnessInput", "type": "string", "required": true }],
      "requires": [],
      "produces": [{ "id": "completion-witness", "kind": "checker", "version": "1" }],
      "sideEffects": [],
      "command": "scripts/anchors.mjs"
    }
  },
  "profiles": [
    {
      "id": "experiment",
      "title": "Experiment",
      "completionGates": ["version-pinned"],
      "templateSelections": []
    }
  ],
  "defaultProfile": "experiment"
}
```

The script reads the frozen witness input and the files exposed for this
submission. It returns exactly the accepted subjects and a typed predicate:

```js
import { readFileSync } from "node:fs";

const inputFile = JSON.parse(process.env.HA_PRESET_INPUT).witnessInput;
const input = JSON.parse(readFileSync(inputFile, "utf8"));
if (input.code !== null) throw new Error("Expected an artifact-only submission");

const metadataFile = input.subjects.find((item) => item.path.endsWith("/experiment.json"));
const metadata = JSON.parse(readFileSync(metadataFile.file, "utf8"));
const csvFile = input.subjects.find((item) => item.path.endsWith("/data.csv"));
const chartFile = input.subjects.find((item) => item.path.endsWith("/chart.png"));
if (readFileSync(csvFile.file, "utf8") !== "x,y\n1,2\n") throw new Error("Unexpected CSV bytes");
if (
  readFileSync(chartFile.file).toString("base64") !==
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
) throw new Error("Unexpected PNG bytes");

const subjects = input.subjects.map(({ file, ...identity }) => identity);
const hasSeed = Number.isInteger(metadata.seed);
console.log(JSON.stringify({
  schema: "preset-script-result/v1",
  produces: [{
    capabilityId: "completion-witness",
    payload: {
      result: hasSeed ? "pass" : "fail",
      subjects,
      predicateType: "research/version-pinned/v1",
      predicate: metadata,
      diagnostic: hasSeed ? "Seed and submitted inputs verified" : "gates.version-pinned.predicate.seed: required"
    }
  }]
}));
```

The task package contains `artifacts/data.csv`, `artifacts/chart.png`, and
`artifacts/experiment.json`. The initial JSON is `{}`; after fixing the failed
submission it is `{"seed":42}`. The PNG is a one-pixel fixture so the example
can verify binary artifact reads without a large asset.

Validate the packages, install the preset, then validate the combined catalog:

```sh
ha preset validate --source ./presets/research-checks --json
ha preset install --source ./presets/research-checks --dry-run --json
ha preset install --source ./presets/research-checks
ha vertical validate --source ./verticals/research --preset research-checks
```

Create a task using the declared vertical and profile, start it, add the three
artifacts, then submit the task package and execution:

```sh
ha task create --title "Reproducible experiment" --vertical research/experiments --preset research-checks --profile experiment
ha task start <task-id>
ha task artifact add <task-id> --source ./data.csv --destination artifacts/data.csv
ha task artifact add <task-id> --source ./chart.png --destination artifacts/chart.png
ha task artifact add <task-id> --source ./experiment.json --destination artifacts/experiment.json
ha doc sync --submit --task <task-id>
ha task submit <task-id> --execution-id <execution-id>
ha task complete <task-id> --execution-id <execution-id>
```

The command source runs against the submitted artifact cut. With the seed
missing, submit is accepted but the gate stays blocked; complete is rejected
with `gate_witness_missing`. The result schema reports the missing field and
the binding reports that `artifacts/experiment.json/seed` is absent. The task
stays submitted so the owner can repair the input.

Edit the task package's `artifacts/experiment.json` to `{"seed":42}`, submit
that document update, then amend and complete:

```sh
ha doc sync --submit --task <task-id>
ha task submit <task-id> --execution-id <execution-id> --amend
ha task complete <task-id> --execution-id <execution-id>
```

The new command witness must return `predicate: {"seed":42}`. The result
schema requires an integer, and the binding requires that value to equal the
accepted JSON artifact. A pass for the wrong seed, a stale artifact revision,
or an incomplete subject set does not satisfy the frozen gate.

## Other source routes

| Source kind | Use |
| --- | --- |
| `command` | A declared preset entrypoint checks frozen inputs and emits a `completion-witness`. It is not a shell string in repository settings. |
| `manual` | A human provides the witness through `ha task attest <task-id> --gate <gate-id> --result pass`. A runtime executor cannot attest as a person. |
| `external` | Declares a runner role and optional accepted run-artifact outputs. The declaration alone does not configure or authorize an external node. |

Do not add hosted CI results as task witnesses. Review pull request checks on the
hosting platform, where merge protection makes that result authoritative.

Optional gate fields include `mandatorySignoff`, `allowOverride`, and
`independentNode`. Use them only for a requirement that is part of the actual
task contract; they do not replace source authorization or submit-time
freezing. When an owner explicitly reruns a failed command gate, use the current
run id and a reason:

```sh
ha task witness-rerun <task-id> --execution-id <execution-id> --gate <gate-id> --run-id <run-id> --reason "Recheck corrected submitted artifacts"
```

## Observed result

This output is from the real isolated integration scenario at
`packages/daemon/test/completion-command-source.integration.test.ts`. With
`experiment.json` equal to `{}`, submit completed but the gate was blocked:

```text
"warnings":["gates.version-pinned.predicate.seed: required; gates.version-pinned.predicate.seed: should have required property 'seed'; gates.version-pinned.predicate.seed: missing artifacts/experiment.json/seed"]
"outcome":"op_rejected","code":"gate_witness_missing"
```

After the accepted artifact was amended to `{"seed":42}`, the witness and
completion result were:

```text
"predicate":{"seed":42}
"result":"pass"
"status":"accepted_durable"
"gateChecks":[{"gate":"version-pinned","status":"pass","witnessRef":"event:op_62e33e850d10f8e7de9320f50c49e08c9d0938d25c8cfea96ab79aa9f1c7389d"}]
```

The complete unabridged run log belongs to the task evidence; this skill keeps
only the short result needed to show the documented behavior.

## Validate and troubleshoot

1. Run `ha preset validate --source <preset-directory> --json` and require
   `valid: true` with no issues.
2. Install the preset, then run
   `ha vertical validate --source <vertical-directory> --preset <preset-id>`.
3. Check that every profile gate id exists and each gate's source id exists in
   the merged declaration.
4. Check that a command source's `<preset-id>/<entrypoint-id>` resolves and
   that the entrypoint both imports and produces the `completion-witness`
   checker capability.
5. Check that each binding names a submitted artifact and a JSON Pointer in
   that artifact. Required schema fields belong under `resultSchema.required`.
6. On a blocked submitted task, read `ha task show <task-id>` and follow the
   owner action for the current gate run. Do not treat an accepted submit as a
   passing gate.

| Symptom | Meaning and next step |
| --- | --- |
| `Gate <id> references undeclared source <source>` | The gate source id is missing from the merged vertical/preset source declarations. |
| `entrypoint_not_found` | The command source's preset id or entrypoint id does not resolve to an installed package. |
| `missing_provider` | The command entrypoint does not declare the required `completion-witness` capability in both package imports and `produces`. |
| `missing_gate` | A selected profile gate id is absent from the merged declaration. |
| `gates.<id>.predicate.<field>` | The witness predicate failed its JSON Schema or an artifact binding. Check the submitted bytes and the result fields. |
| `gate_witness_missing` | The submitted task does not have a passing witness for this frozen gate. Repair the input and amend, or have the owner explicitly rerun the current gate. |

## Contract boundaries

- `packages/kernel/src/domain/completion-source.ts` owns source, gate, and
  closeout-default types; `packages/kernel/src/schemas/completion-source.ts`
  validates their exact shape.
- `packages/kernel/src/schemas/completion-predicate.ts` validates the
  predicate schema and JSON Pointer bindings against the frozen artifact
  inputs.
- `packages/preset/src/preset-runtime.ts` merges vertical and preset
  declarations, resolves profile gate ids, and checks command entrypoints.
- `packages/daemon/src/repo-cell-command-witness.ts` runs command witnesses
  against accepted submission artifacts, not the mutable working directory.
- `packages/kernel/src/domain/settings-closeout.ts` resolves domain defaults
  under repository and task-profile overrides.
- Keep domain fields such as `seed`, model version, and dataset version in the
  domain predicate. Do not add domain-specific branches to the kernel or CLI.
