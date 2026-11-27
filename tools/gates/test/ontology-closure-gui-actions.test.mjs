// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadGateAllowlist } from "../../gate-allowlists/load-gate-allowlist.mjs";
import { loadOntologyClosureSnapshot } from "../ontology-gate-lib.mjs";
import { auditOntologyClosure } from "../ontology-closure-audit.mjs";
import { scanOntologyText } from "../ontology-closure-scan.mjs";
import { evaluateOntologyClosure } from "../ontology-closure.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const empty = { actions: [], kinds: [] };
const debt = (candidate) => ({
  id: candidate.id,
  category: candidate.category,
  owner: "approval",
  status: "legacy-to-remove",
  replacementRef: "entity-kind:approval",
  removalSlice: "S1",
  ref: "dec_7E44897ECDCAEF2B92EC66A260",
  reason: candidate.reason,
});

function audit(candidates, options = {}) {
  return auditOntologyClosure({ candidates, baseline: [], previous: [], snapshot: empty, ...options });
}

// dec_7E44897ECDCAEF2B92EC66A260/CH1: every non-main packages/gui action candidate
// (renderer, preload, browser, public, scripts) resolves to an explicit ActionDeclaration
// source contract, leaving zero non-main GUI migration debt and failing closed on new calls.
test("dec_7E44897ECDCAEF2B92EC66A260/CH1: non-main packages/gui action candidates remain at zero migration debt", () => {
  const isNonMainGuiPath = (targetPath) =>
    targetPath.startsWith("packages/gui/") && !targetPath.startsWith("packages/gui/src/main/");
  const baseline = loadGateAllowlist("ontology-closure", {
    allowlistRoot: path.join(repoRoot, "tools/gate-allowlists"),
    report: false,
  }).candidates;
  assert.deepEqual(
    baseline.filter((row) => row.owner === "packages/gui" && !row.path.startsWith("packages/gui/src/main/")),
    [],
  );
  assert.deepEqual(
    baseline.filter((row) => isNonMainGuiPath(row.path)),
    [],
  );

  const result = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" });
  assert.deepEqual(
    result.findings.filter((row) => row.file && isNonMainGuiPath(row.file)),
    [],
  );
  const nonMainGuiActions = result.classified.filter((row) => row.category === "action" && isNonMainGuiPath(row.file));
  // dec_89D06D7360CBEC09795F7B12EC unifies the routes: 27 net client sites and
  // two net daemon-local-state sites raise the registered census from 343 to 372.
  // dec_4276A0CEACD4D402F122295925/CH1 (+4 -> 376); dec_AAEC26DBB6F23BDF80876ABB2C/CH5 (+3 -> 379); dec_166C5D2EAB57F8BCA3F15107E2/CH2,CH4 (+3 -> 382).
  // task_211789c20aee8c48a40535b9ac adds five registered Resident CEO GUI actions (382 -> 387);
  // task_0c21f32136a93ca9edd13b16e5 adds four Resident CEO history/proposals/approve/reject GUI actions (387 -> 391).
  assert.equal(nonMainGuiActions.length, 391);
  assert.deepEqual(
    nonMainGuiActions.filter((row) => row.status !== "registered"),
    [],
  );
  const nonMainGuiAll = result.classified.filter((row) => isNonMainGuiPath(row.file));
  assert.deepEqual(
    nonMainGuiAll.filter((row) => row.status !== "registered"),
    [],
  );

  // F1 regression: GUI business RPCs and preload IPC channels bind their owning business
  // ActionDeclaration rather than collapsing into daemon-local-state or cli-local-effects.
  const declOf = (fragment) => {
    const matches = nonMainGuiActions.filter((row) => row.id.includes(fragment));
    assert.equal(matches.length, 1, `expected unique non-main GUI candidate for ${fragment}`);
    return matches[0].declarationRef;
  };
  assert.equal(
    declOf("TaskMaterializationControl.tsx#TaskMaterializationControl.materialize.mutationFn.receipt:"),
    "action:doc-materialize",
  );
  assert.equal(
    declOf("TaskMaterializationControl.tsx#TaskMaterializationControl.availability.queryFn.result:"),
    "action:repository-read",
  );
  assert.equal(declOf("api-client.ts#harnessClient.acceptDecision:"), "action:decision-accept");
  assert.equal(declOf("api-client.ts#harnessClient.submitTask:"), "action:task-submit");
  assert.equal(declOf("todos-client.ts#todosClient.add:"), "action:todo-add");
  assert.equal(declOf("entity-locator-client.ts#importEntity:"), "action:entity-import");
  assert.equal(declOf("entity-locator-client.ts#updateEntity:"), "action:entity-update");
  assert.equal(declOf("entity-locator-client.ts#archiveEntity:"), "action:entity-archive");
  assert.equal(declOf("entity-locator-client.ts#deleteEntity:"), "action:entity-delete");
  assert.equal(declOf("access-admin-preload.ts#accessAdminPreloadApi.ask:"), "action:access-manage");
  assert.equal(declOf("schedules-client.ts#schedulesClient.create:"), "action:schedule-create");
  assert.equal(declOf("schedules-client.ts#schedulesClient.update:"), "action:schedule-update");
  assert.equal(declOf("schedules-client.ts#schedulesClient.delete:"), "action:schedule-delete");
  assert.equal(declOf("schedules-client.ts#schedulesClient.enable:"), "action:schedule-enable");
  assert.equal(declOf("schedules-client.ts#schedulesClient.disable:"), "action:schedule-disable");
  assert.equal(declOf("schedules-client.ts#schedulesClient.runNow:"), "action:schedule-run-now");
  assert.equal(declOf("fleet-client.ts#fleetClient.overview.result:"), "action:fleet-overview-read");
  for (const [fn, ref] of [
    ["centerSwitch:", "action:daemon-fleet-center-switch"],
    ["promoteFromEdge:", "action:daemon-fleet-center-promote-from-edge"],
    ["edgeLocalState:", "action:repository-read"],
  ])
    assert.equal(declOf(`center-settings-preload.ts#centerSettingsPreloadApi.${fn}`), ref);
  assert.equal(declOf("electron-preload.ts#invoke:"), "action:repository-read");
  assert.equal(
    declOf("decision-review-actions.ts#useDecisionReviewActions.run.receipt:"),
    "action:decision-respond-review",
  );
  assert.equal(
    declOf("decision-actions.ts#useDecisionActions.once.promise:973c6c969683351bc4fdb5c8534d57f0"),
    "action:decision-propose",
  );
  assert.equal(
    declOf("task-actions.ts#useTaskActions.once.promise:973c6c969683351bc4fdb5c8534d57f0"),
    "action:task-start",
  );
  assert.equal(
    declOf("TodosView.tsx#TodosView.mutation.mutationFn:973c6c969683351bc4fdb5c8534d57f0"),
    "action:todo-add",
  );
  assert.deepEqual(
    nonMainGuiActions
      .filter((row) => row.id.includes("useRuntimeWorkspace.ts#useProviderWorkspace.authInstance:"))
      .map((row) => row.declarationRef)
      .sort(),
    ["action:runtime-instance-login", "action:runtime-instance-logout"],
  );
  assert.deepEqual(
    nonMainGuiActions.filter((row) => row.declarationRef === "action:cli-local-effects"),
    [],
  );
  const guiLocalState = nonMainGuiActions.filter((row) => row.declarationRef === "action:daemon-local-state");
  assert.equal(guiLocalState.length, 113);
  assert.deepEqual(
    guiLocalState.filter((row) =>
      /api-client\.ts|todos-client\.ts|schedules-client\.ts|entity-locator-client\.ts|fleet-client\.ts|access-admin-preload\.ts/u.test(
        row.file,
      ),
    ),
    [],
  );

  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  for (const [target, snippet, expectedSymbol] of [
    [
      "packages/gui/src/preload/electron-preload.ts",
      'function undeclaredPreloadBridge() { return ipcRenderer.invoke("harness:undeclared", null); }',
      "undeclaredPreloadBridge",
    ],
    [
      "packages/gui/src/renderer/api-client-invoke.ts",
      "function undeclaredRendererInvoke() { dispatch(); }",
      "undeclaredRendererInvoke",
    ],
    [
      "packages/gui/src/renderer/task-actions.ts",
      "function undeclaredRendererTaskAction() { dispatch(); }",
      "undeclaredRendererTaskAction",
    ],
  ]) {
    const source = readFileSync(path.join(repoRoot, target), "utf8");
    const original = scanOntologyText(target, source);
    assert.deepEqual(audit(original, { snapshot }).findings, [], target);

    const mutated = scanOntologyText(target, `${source}\n${snippet}\n`);
    const undeclaredResult = audit(mutated, { snapshot });
    assert.equal(undeclaredResult.findings.length, 1, target);
    assert.equal(undeclaredResult.findings[0].code, "ONTOLOGY_ACTION_UNDECLARED", target);
    assert.equal(undeclaredResult.findings[0].symbol, expectedSymbol, target);

    const addedCandidate = mutated.find((row) => row.id === undeclaredResult.findings[0].id);
    assert.ok(addedCandidate, target);
    assert.deepEqual(
      audit(mutated, { snapshot, baseline: [debt(addedCandidate)], previous: [] }).findings.map((row) => row.code),
      ["ONTOLOGY_BASELINE_GROWTH"],
      target,
    );
  }
});
