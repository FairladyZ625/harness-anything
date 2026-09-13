// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { explainEntityKind, getExecutableEntityAction } from "../../src/domain/entity-kind-registry.ts";
import { SettingsActionError, settingsUpdateInputFields } from "../../src/domain/settings-action-contract.ts";
import { repositorySettingsActionValues } from "../../src/domain/settings-action-values.ts";
import { assertSettingsEventInputs } from "../../src/domain/settings-event.ts";
import { effectiveCloseoutGates } from "../../src/domain/settings-closeout.ts";
import { readSettingsFacet, repositorySettings } from "../../src/domain/settings.ts";

const documentBody = [
  "schema: harness-anything/v1",
  "name: settings-action-test",
  "layout:",
  "  authoredRoot: harness",
  "settings:",
  "  defaultVertical: software/coding",
  "  defaultPreset: standard-task",
  "  defaultProfile: baseline",
  "  scaffolds:",
  "    task: governance/task-scaffold.json",
  "    repository: governance/repository-scaffold.json",
  "",
].join("\n");
const current = repositorySettings(readSettingsFacet(documentBody));

test("closeout profiles default consistently and task gates can only tighten", () => {
  assert.deepEqual(effectiveCloseoutGates({ profile: "standard" }), {
    review: false,
    consent: false,
    factDisposition: false,
    codeDoc: false,
  });
  assert.equal(effectiveCloseoutGates({ profile: "standard", overrides: { review: true } }).review, true);
  assert.equal(
    effectiveCloseoutGates({ profile: "standard", overrides: { codeDoc: false } }, ["code-doc-reconciliation"]).codeDoc,
    true,
  );
  assert.equal(effectiveCloseoutGates({ profile: "strict", overrides: { consent: false } }).consent, false);
});

test("Settings exposes executable singleton read and update contracts", () => {
  const explanation = explainEntityKind("settings"),
    byId = new Map(explanation.transitions.actions.map((action) => [action.id, action])),
    update = getExecutableEntityAction("settings-update");
  assert.deepEqual(explanation.transitions.available, ["read", "update"]);
  assert.equal(update?.execution?.implementation, "catalog-runtime");
  assert.equal(update?.execution?.targetIdField, "settingsId");
  assert.equal(byId.get("update")?.concurrency.expectedVersion.conflict, "revision_conflict");
  assert.equal(byId.get("update")?.concurrency.expectedVersion.arbitration, "center-single-write-queue");
  assert.equal(byId.get("update")?.concurrency.idempotency.retry, "canonical-event-replay");
  assert.equal(byId.get("update")?.concurrency.artifactOwnership.repositoryDocument, "harness.yaml");
});

test("Settings update compiles the existing audit event with actor and parent document", () => {
  const draft = compile({ defaultPreset: "docs-task", expectedVersion: 7 });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") return;
  assert.equal(draft.result.bundle.event.type, "settings_changed");
  assert.equal(draft.result.bundle.event.entity.id, "repository");
  assert.deepEqual(draft.result.bundle.event.actor, {
    principal: { personId: "person-settings-action" },
    executor: { kind: "agent", id: "settings-action-test" },
  });
  assert.equal(draft.result.bundle.event.payload.settings.defaultPreset, "docs-task");
  assert.equal(Object.hasOwn(draft.result.bundle.event.payload.settings, "locale"), false);
  assert.match(draft.result.bundle.blobs[0].body, /defaultPreset: docs-task/u);
});

test("Settings update persists principal review independence through the existing event", () => {
  const draft = compile({ reviewIndependence: "principal" });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") return;
  assert.equal(draft.result.bundle.event.payload.settings.reviewIndependence, "principal");
  assert.match(draft.result.bundle.blobs[0].body, /reviewIndependence: principal/u);
  assertSettingsEventInputs(draft.result.bundle.event, draft.result.bundle.plan, draft.result.bundle.blobs);
});

test("Settings pins a configured reviewer through its canonical event and authored facet", () => {
  const draft = compile({ defaultReviewer: "audit-reviewer" });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.equal(draft.result.bundle.event.payload.settings.defaultReviewer, "audit-reviewer");
  assert.equal(readSettingsFacet(draft.result.bundle.blobs[0].body).defaultReviewer, "audit-reviewer");
  assertSettingsEventInputs(draft.result.bundle.event, draft.result.bundle.plan, draft.result.bundle.blobs);
});

test("Settings update hydrates the default when the projected event predates review independence", () => {
  const { reviewIndependence: _legacyMissing, ...legacyCurrent } = current;
  const draft = compile(
    { reviewIndependence: "principal" },
    {
      currentEntity: legacyCurrent,
      currentDocumentBody: documentBody,
    },
  );
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") return;
  assert.equal(draft.result.bundle.event.payload.settings.reviewIndependence, "principal");
});

test("Settings update writes the repository CI workflow names through the canonical event", () => {
  const draft = compile({ ciWorkflows: ["ci", "nightly"] });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.deepEqual(draft.result.bundle.event.payload.settings.ci.workflows, ["ci", "nightly"]);
  assert.equal(readSettingsFacet(draft.result.bundle.blobs[0].body).ci.workflows.join(","), "ci,nightly");
  assertSettingsEventInputs(draft.result.bundle.event, draft.result.bundle.plan, draft.result.bundle.blobs);
});

test("Settings update clears CI witnessing through an empty workflow list", () => {
  const draft = compile({ ciWorkflows: [] }, witnessed());
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.deepEqual(draft.result.bundle.event.payload.settings.ci.workflows, []);
  assert.deepEqual(readSettingsFacet(draft.result.bundle.blobs[0].body).ci.workflows, []);
  assertSettingsEventInputs(draft.result.bundle.event, draft.result.bundle.plan, draft.result.bundle.blobs);
});

test("Settings update maps the CLI none sentinel to the CI-witnessing opt-out", () => {
  const draft = compile({ ciWorkflows: ["none"] }, witnessed());
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.deepEqual(draft.result.bundle.event.payload.settings.ci.workflows, []);
  assert.deepEqual(readSettingsFacet(draft.result.bundle.blobs[0].body).ci.workflows, []);
  assertSettingsEventInputs(draft.result.bundle.event, draft.result.bundle.plan, draft.result.bundle.blobs);
});

test("Settings update persists closeout profile and individual overrides", () => {
  const draft = compile({ closeoutProfile: "strict", closeoutReview: false, closeoutCodeDoc: true });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.deepEqual(draft.result.bundle.event.payload.settings.closeout, {
    profile: "strict",
    overrides: { review: false, codeDoc: true },
  });
  assert.deepEqual(readSettingsFacet(draft.result.bundle.blobs[0].body).closeout, {
    profile: "strict",
    overrides: { review: false, codeDoc: true },
  });
});

test("Settings update rejects malformed CI workflow name lists", () => {
  for (const ciWorkflows of [["ci", "ci"], ["ci.yml"], ["ci.yaml"], [""]]) {
    assert.throws(
      () => compile({ ciWorkflows }),
      (error: unknown) => error instanceof SettingsActionError && error.code === "invalid_command",
      JSON.stringify(ciWorkflows),
    );
  }
});

test("Settings expectedVersion rejects a stale edge update with a typed error", () => {
  assert.throws(
    () => compile({ walFlushEvents: 512, expectedVersion: 6 }),
    (error: unknown) => error instanceof SettingsActionError && error.code === "revision_conflict",
  );
  assert.throws(
    () => compile({ locale: "zh-CN", expectedVersion: 1.5 }),
    (error: unknown) => error instanceof SettingsActionError && error.code === "invalid_command",
  );
});

test("Settings locale remains outside the canonical event compiler", () => {
  const draft = compile({ locale: "zh-CN", expectedVersion: 0 });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings") return;
  assert.deepEqual(draft.result, { kind: "no-changes", settings: current, revision: 7 });
});

function compile(
  action: Readonly<Record<string, unknown>>,
  base: { readonly currentEntity: unknown; readonly currentDocumentBody: string } = {
    currentEntity: current,
    currentDocumentBody: documentBody,
  },
) {
  const compiler = getExecutableEntityAction("settings-update")?.execution?.compile;
  assert.ok(compiler);
  return compiler({
    action,
    actor: {
      principal: { personId: "person-settings-action" },
      executor: { kind: "agent", id: "settings-action-test" },
    },
    source: "local",
    session: { kind: "unavailable", reason: "contract-test" },
    opId: "settings-action-contract",
    occurredAt: "2026-09-01T00:00:00.000Z",
    workspaceRevision: 8,
    currentEntity: base.currentEntity,
    entityRevision: 7,
    currentDocumentBody: base.currentDocumentBody,
  });
}

test("settings update field surface has one source: the catalog input is the exported field list", () => {
  const update = getExecutableEntityAction("settings-update");
  // input() 会重建外层数组,这里断言逐项相等(内层条目即单源里的同一批冻结对象)。
  assert.deepEqual(update?.input.fields, settingsUpdateInputFields);
  // 单源完整性:仓库字段(除 locale/expectedVersion/idempotencyKey 的机械项)都在清单里。
  const names = settingsUpdateInputFields.map(({ field }) => field);
  for (const expected of [
    "defaultVertical",
    "defaultPreset",
    "defaultProfile",
    "defaultReviewer",
    "reviewIndependence",
    "reviewReturnBudget",
    "taskScaffold",
    "repositoryScaffold",
    "walFlushAdaptive",
    "walFlushEvents",
    "walFlushBytes",
    "walFlushMilliseconds",
    "ciWorkflows",
    "closeoutProfile",
    "closeoutReview",
    "closeoutConsent",
    "closeoutFactDisposition",
    "closeoutCodeDoc",
    "restoreDrillRetention",
  ])
    assert.ok(names.includes(expected), `${expected} missing from settingsUpdateInputFields`);
});

test("repositorySettingsActionValues covers every repository field for a fully populated settings", () => {
  const populated = repositorySettings(
    readSettingsFacet(
      `${documentBody}  defaultReviewer: arch-reviewer\n  ci:\n    workflows: [ci]\n  restoreDrillRetention: 5\n`,
    ),
  );
  const values = repositorySettingsActionValues(populated),
    names = new Set(settingsUpdateInputFields.map(({ field }) => field));
  for (const key of Object.keys(values)) assert.ok(names.has(key), `${key} is not an action field`);
  const repositoryFields = settingsUpdateInputFields
    .map(({ field }) => field)
    .filter((field) => !["locale", "expectedVersion", "idempotencyKey"].includes(field));
  for (const field of repositoryFields) assert.ok(Object.hasOwn(values, field), `${field} has no flat action value`);
  // closeout 门布尔承载生效值:strict 基线即无覆写时的值。
  assert.equal(repositorySettingsActionValues(current).closeoutReview, false);
  assert.equal(repositorySettingsActionValues({ ...current, closeout: { profile: "strict" } }).closeoutConsent, true);
  assert.equal(
    repositorySettingsActionValues({ ...current, closeout: { profile: "strict", overrides: { consent: false } } })
      .closeoutConsent,
    false,
  );
});

/** Clearing is only a change for a repository that already witnesses CI runs. */
function witnessed(): { readonly currentEntity: unknown; readonly currentDocumentBody: string } {
  const body = `${documentBody}  ci:\n    workflows: [ci]\n`;
  return { currentEntity: repositorySettings(readSettingsFacet(body)), currentDocumentBody: body };
}
