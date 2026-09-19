// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { explainEntityKind, getExecutableEntityAction } from "../../src/domain/entity-kind-registry.ts";
import { SettingsActionError, settingsUpdateInputFields } from "../../src/domain/settings-action-contract.ts";
import { repositorySettingsActionValues } from "../../src/domain/settings-action-values.ts";
import { assertSettingsEventInputs } from "../../src/domain/settings-event.ts";
import { effectiveCloseoutGates } from "../../src/domain/settings-closeout.ts";
import { readSettingsFacet, repositorySettings } from "../../src/domain/settings.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";

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
    fact: true,
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

test("task-level closeout overrides take precedence over repository settings", () => {
  assert.deepEqual(effectiveCloseoutGates({ profile: "strict" }, [], { review: false, consent: false }), {
    review: false,
    consent: false,
    fact: true,
    factDisposition: true,
    codeDoc: true,
  });
  // `fact` is task-bound only: a repository cannot switch off Fact production, and its settings
  // facet rejects the key instead of accepting an inert value.
  assert.equal(effectiveCloseoutGates({ profile: "standard", overrides: { fact: false } }).fact, true);
  assert.throws(
    () => readSettingsFacet(`${documentBody}  closeout:\n    profile: standard\n    overrides:\n      fact: false\n`),
    /additionalProperties|fact/u,
  );
  // A task override wins over a repository override on the same key.
  assert.equal(
    effectiveCloseoutGates({ profile: "standard", overrides: { review: true } }, [], { review: false }).review,
    false,
  );
  // An absent task key falls through to the repository override, then the profile baseline.
  assert.equal(
    effectiveCloseoutGates({ profile: "standard", overrides: { review: true } }, [], { consent: false }).review,
    true,
  );
  // The task completion gate contract still forces codeDoc on even when the task disables it.
  assert.equal(
    effectiveCloseoutGates({ profile: "standard" }, ["code-doc-reconciliation"], { codeDoc: false }).codeDoc,
    true,
  );
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

test("Settings update mints gate mappings into the entity and rewrites the authored gates facet", () => {
  const gates = [
      {
        gateId: "ci",
        adapter: "github-actions",
        appliesTo: "code",
        branch: "main",
        event: "push",
        coverage: "descendant",
        selection: "newest",
      },
      { gateId: "code-doc-reconciliation", adapter: "none" },
    ],
    draft = compile({ gatesFromDocument: true, gates });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.deepEqual(draft.result.bundle.event.payload.settings.gates, gates);
  const body = draft.result.bundle.blobs[0].body;
  assert.match(body, /  gates:\n    ci:\n      adapter: github-actions\n/u);
  assert.match(body, /    code-doc-reconciliation: none\n/u);
  assert.deepEqual(readSettingsFacet(body).gates, gates);
  assertSettingsEventInputs(draft.result.bundle.event, draft.result.bundle.plan, draft.result.bundle.blobs);
});

test("Settings update removes the authored gates block when the minted mapping list empties", () => {
  const gated = gatedFixture(),
    draft = compile({ gatesFromDocument: true, gates: [] }, gated);
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.deepEqual(draft.result.bundle.event.payload.settings.gates, []);
  const body = draft.result.bundle.blobs[0].body;
  assert.doesNotMatch(body, /^  gates:/mu);
  assert.deepEqual(readSettingsFacet(body).gates, []);
});

test("Settings update commits a diverged-but-equal authored document through the event", () => {
  // Same settings, different text: key order churn and comments are committed verbatim so the
  // authored file stops sitting dirty with no sanctioned write path.
  const authoredBody = documentBody.replace(
      "  defaultVertical: software/coding\n",
      "  # Operator annotation\n  defaultVertical: software/coding\n",
    ),
    draft = compile({ authoredDocumentBody: authoredBody });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.equal(draft.result.bundle.blobs[0].body, authoredBody);
  assert.equal(draft.result.bundle.event.payload.baseDocumentSha256, sha256Text(authoredBody));
  assertSettingsEventInputs(draft.result.bundle.event, draft.result.bundle.plan, draft.result.bundle.blobs);
});

test("Settings update applies flags on top of a diverged-but-equal authored document", () => {
  const authoredBody = documentBody.replace(
      "  defaultVertical: software/coding\n",
      "  # Operator annotation\n  defaultVertical: software/coding\n",
    ),
    draft = compile({ authoredDocumentBody: authoredBody, defaultPreset: "docs-task" });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  // The authored file's settings equal the current settings, so the flag delta is applied on top
  // of its bytes and the whole authored document is committed by the event.
  assert.equal(draft.result.bundle.event.payload.baseDocumentSha256, sha256Text(authoredBody));
  assert.match(draft.result.bundle.blobs[0].body, /  # Operator annotation\n/u);
  assert.match(draft.result.bundle.blobs[0].body, /defaultPreset: docs-task/u);
});

test("Settings update ignores an authored document whose settings diverge from the result", () => {
  const authoredBody = documentBody.replace("  defaultPreset: standard-task", "  defaultPreset: docs-task"),
    draft = compile({ authoredDocumentBody: authoredBody, walFlushEvents: 512 });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.equal(draft.result.bundle.event.payload.baseDocumentSha256, sha256Text(documentBody));
  assert.match(draft.result.bundle.blobs[0].body, /defaultPreset: standard-task/u);
});

test("Settings update falls back to the committed document when the authored one does not parse", () => {
  const draft = compile({ authoredDocumentBody: "settings:\n  gates: [", walFlushEvents: 512 });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.equal(draft.result.bundle.event.payload.baseDocumentSha256, sha256Text(documentBody));
});

test("Settings update rejects gatesFromDocument without a daemon-minted gates array", () => {
  assert.throws(
    () => compile({ gatesFromDocument: true }),
    (error: unknown) => error instanceof SettingsActionError && error.code === "invalid_command",
  );
});

test("Settings update rejects gatesDraft that bypassed the ingress minting", () => {
  assert.throws(
    () => compile({ gatesDraft: [{ gateId: "ci", adapter: "none" }] }),
    (error: unknown) => error instanceof SettingsActionError && error.code === "invalid_command",
  );
});

test("Settings update rejects malformed gate mappings", () => {
  for (const gates of [
    "ci",
    ["ci"],
    [{ gateId: "ci", adapter: "bogus-adapter" }],
    [{ gateId: "ci", adapter: "github-actions" }],
  ]) {
    assert.throws(
      () => compile({ gates }),
      (error: unknown) => error instanceof SettingsActionError && error.code === "invalid_command",
      JSON.stringify(gates),
    );
  }
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
    "gatesFromDocument",
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
    // locale/expectedVersion/idempotencyKey 是机械项;gatesFromDocument 与 gatesDraft 是
    // 写侧草稿命令——经 ingress 铸造进 authored 文档,不产生扁平读值。
    .filter(
      (field) => !["locale", "expectedVersion", "idempotencyKey", "gatesFromDocument", "gatesDraft"].includes(field),
    );
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

/** A repository whose authored document already declares a github-actions mapping for `ci`. */
function gatedFixture(): { readonly currentEntity: unknown; readonly currentDocumentBody: string } {
  const body =
    `${documentBody}  ci:\n    workflows: [ci]\n` +
    "  gates:\n    ci:\n      adapter: github-actions\n      appliesTo: code\n      branch: main\n" +
    "      event: push\n      coverage: descendant\n      selection: newest\n";
  return { currentEntity: repositorySettings(readSettingsFacet(body)), currentDocumentBody: body };
}
