# Cold-start evaluation pipeline v1

This directory turns the controlled cold-start evaluation method into an append-only, repeatable run pipeline. It does not run a real model and it does not provide trend storage or an HTML dashboard.

## Run the scripted subject

Build the CLI, then give the driver a new absolute directory. The driver refuses to overwrite an existing run directory and seals completed evidence read-only.

```sh
npm run build -w @harness-anything/cli
node tools/coldstart-bench/driver.mjs \
  --run-dir /absolute/path/to/coldstart-run \
  --seed 104729
```

The scripted subject in `fake-subject.mjs` emits a fixed action sequence. It never invokes the CLI itself. The driver executes each declared CLI action, so `evidence/driver-invocations.jsonl` is the source of truth rather than subject self-report or runtime telemetry.

To prove fail-closed reconciliation, copy a completed run and physically remove one channel:

```sh
node tools/coldstart-bench/negative-control.mjs \
  --source-run-dir /absolute/path/to/coldstart-run \
  --run-dir /absolute/path/to/coldstart-run-missing-receipts \
  --omit cliReceipts
```

The negative record remains schema-valid but has `status: "incomplete"`, `outcome: "unknown"`, and `validity.status: "invalid"`.

## Blindness and isolation

The driver creates a disposable seed Git repository and a linked subject worktree. HOME, TMP, XDG runtime, Git config, daemon user root, daemon ID, and session IDs are isolated. The daemon root is outside the subject worktree. Before subject actions start, the driver scans the worktree and stops if evaluator, scorer, historical subject-log, or benchmark-report paths are present.

Evaluator access detection consumes the normalized subject action log. Provider adapters must declare that log complete. A read or shell action naming an evaluator file marks the run `contaminated`; it is not rerun. An adapter that cannot provide complete tool/action logs makes the run invalid. The scripted adapter is complete because its protocol only permits the driver to execute declared actions.

## Three-way reconciliation

Every valid run requires these independently stored channels:

1. `driver-invocations.jsonl`: driver-observed invocation source of truth.
2. `cli-receipts.jsonl`: captured CLI stdout, stderr, parse state, and structured receipt.
3. `durable-state.json`: driver readback from the task package plus `task show` correlation.

`subject-actions.json` and fixture setup evidence are also required for blindness and infrastructure attribution. `runtime-events.json` is read-only ancillary evidence. Its absence or content never changes the benchmark verdict; `reconciliation.runtimeEventsUsedForVerdict` is mechanically fixed to `false`.

## Schema fields

`run.schema.json` is JSON Schema draft 2020-12. Top-level fields are:

- identity and disposition: `schemaVersion`, `runId`, `recordedAt`, `appendOnly`, `status`, `outcome`, `control`;
- reproducibility: `provenance` with source commit/dirty bit, CLI build hash, runner version, schema version/hash, scenario hash, and prompt hash;
- subject and isolation: `subject`, `environment`, `randomSeed`;
- evaluation contract: `scenario.commandOpportunities`, theoretical minimum, and driver verification IDs;
- validity: `contamination`, `evidence`, `reconciliation`, `validity`;
- measurements: `metrics`.

The metric denominators are explicit:

- invocation rate: invoked applicable opportunities / declared applicable opportunities;
- first-attempt correctness: opportunities correct on their first invocation / invoked opportunities;
- post-invocation success: opportunities with any successful invocation / invoked opportunities;
- driver verification completion: passed durable checks / declared checks;
- command inflation: subject CLI commands / declared theoretical minimum;
- bypass rate: non-CLI file, Git, SQLite, or other alternative actions / all subject actions;
- alternative path share: alternative-route invocations / all primary-or-alternative route invocations.

Help calls, capabilities calls, and recovery steps are counts. Recovery steps count extra attempts after an initial failure until the first success. Unknown fields are rejected, and semantic checks keep rate arithmetic, completeness, contamination, and validity internally consistent.

## Storage boundary

Runs are content-addressable evidence bundles suitable for later import into `harness/context/benchmark/coldstart/runs/`. That destination is append-only. During worker implementation, runs should first be written to the task package `artifacts/` directory for the coordinator to archive. SQLite and HTML are deliberately outside v1.
