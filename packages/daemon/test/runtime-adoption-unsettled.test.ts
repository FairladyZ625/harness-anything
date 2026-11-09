// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  importedRuntimeSessionProjection,
  sameImportedRuntimeSessionProjection,
} from "../src/runtime-imported-settlement.ts";

test("a recovered imported session still reconciles with its replayed source at a later observation stamp", () => {
  const source = {
      runtimeSessionId: "runtime_imported_reconcile",
      instanceId: "codex",
      installationId: "installation",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/reconcile",
      providerSessionId: null,
      transcriptRef: null,
      launchGeneration: 1,
      liveness: "live" as const,
      attachable: true,
      taskBindings: [],
      outcome: null,
      exitCode: null,
      resultRef: null,
      lastObservedAt: "2026-08-24T03:06:09.253Z",
    },
    recovered = {
      ...importedRuntimeSessionProjection(source),
      lastObservedAt: "2026-11-05T00:00:00.000Z",
    };
  assert.equal(
    sameImportedRuntimeSessionProjection(recovered, source),
    true,
    "the settlement observation stamp is not entity identity",
  );
  assert.equal(
    sameImportedRuntimeSessionProjection({ ...recovered, outcome: "succeeded" }, source),
    false,
    "a different terminal outcome is not the replayed terminal",
  );
});
