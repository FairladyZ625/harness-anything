// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { explainEntityKind, getExecutableEntityAction } from "../../src/domain/entity-kind-registry.ts";
import { SettingsActionError, settingsUpdateInputFields } from "../../src/domain/settings-action-contract.ts";
import { repositorySettingsActionValues } from "../../src/domain/settings-action-values.ts";
import { assertSettingsEventInputs, validateCurrentSettingsEvent } from "../../src/domain/settings-event.ts";
import { effectiveCloseoutGates } from "../../src/domain/settings-closeout.ts";
import {
  SETTINGS_FIELD_DECLARATIONS,
  createSettingsDeclarationRuntime,
  defineSettingsField,
  readSettingsFacet,
  repositorySettings,
  settingsFieldPresentationFromDeclarations,
  writeRepositorySettingsFacet,
} from "../../src/domain/settings.ts";
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

test("Settings updates preserve unrelated authored YAML bytes", () => {
  const authoredBody = [
      "schema: harness-anything/v1",
      "name: settings-byte-fidelity",
      "layout:",
      "  authoredRoot: harness",
      "settings:",
      "  ci:",
      "    workflows: [rewrite-ci]",
      '  defaultVertical: "software/coding"',
      "  defaultPreset: standard-task",
      "  defaultProfile: baseline",
      "",
      "",
    ].join("\n"),
    settings = repositorySettings(readSettingsFacet(authoredBody)),
    written = writeRepositorySettingsFacet(authoredBody, { ...settings, defaultPreset: "docs-task" });
  assert.equal(written, authoredBody.replace("defaultPreset: standard-task", "defaultPreset: docs-task"));
});

test("Settings updates populate an empty settings mapping", () => {
  const authoredBody = "schema: harness-anything/v1\nsettings:\n",
    settings = repositorySettings(readSettingsFacet(authoredBody)),
    written = writeRepositorySettingsFacet(authoredBody, { ...settings, agenda: { pinLimit: 3 } });
  assert.equal(readSettingsFacet(written).agenda.pinLimit, 3);
  assert.match(written, /^settings:\n  agenda:\n    pinLimit: 3$/mu);
});

test("Settings arrays are written in their declared YAML sequence styles", () => {
  const settings = repositorySettings(readSettingsFacet(documentBody)),
    written = writeRepositorySettingsFacet(documentBody, {
      ...settings,
      ci: { workflows: ["ci", "nightly"] },
      worktree: { setup: ["node-modules", "run: npm run build"] },
    });
  assert.match(written, /workflows: \[ci, nightly\]/u);
  assert.match(written, /setup:\n      - node-modules\n      - run: npm run build/u);
});

test("one temporary declaration reaches update, YAML read/write, CLI help metadata, and GUI field data", () => {
  const temporary = defineSettingsField({
      path: ["temporary", "contractLimit"],
      ownership: "repository",
      valueKind: "integer",
      defaultValue: 7,
      minimum: 1,
      description: "Contract-only limit used to prove declaration propagation.",
      effect: "Contract-only effect sentence used to prove declaration propagation.",
      group: "capacity-agenda",
      action: { field: "temporaryContractLimit", type: "number" },
      cli: { name: "--temporary-contract-limit", kind: "single", regex: "^[1-9][0-9]*$" },
    }),
    runtime = createSettingsDeclarationRuntime([...SETTINGS_FIELD_DECLARATIONS, temporary]),
    candidate = runtime.applyRepositoryAction(runtime.read(documentBody), { temporaryContractLimit: 9 }),
    written = runtime.writeRepository(documentBody, candidate),
    reread = runtime.read(written) as { readonly temporary: { readonly contractLimit: number } };
  assert.equal(reread.temporary.contractLimit, 9);
  assert.equal(
    runtime.actionInputFields.some(({ field }) => field === "temporaryContractLimit"),
    true,
  );
  assert.deepEqual(
    runtime.cliInputFields.find(({ name }) => name === "--temporary-contract-limit"),
    {
      field: "temporaryContractLimit",
      description: "Contract-only limit used to prove declaration propagation.",
      effect: "Contract-only effect sentence used to prove declaration propagation.",
      group: "capacity-agenda",
      name: "--temporary-contract-limit",
      kind: "single",
      regex: "^[1-9][0-9]*$",
      projection: "number",
    },
  );
  assert.deepEqual(settingsFieldPresentationFromDeclarations([temporary]), [
    {
      field: "temporaryContractLimit",
      group: "capacity-agenda",
      effect: "Contract-only effect sentence used to prove declaration propagation.",
      defaultValue: 7,
    },
  ]);
  assert.equal(runtime.actionValues(candidate).temporaryContractLimit, 9);
});

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
  const draft = compile({ roles: { defaultReviewer: "audit-reviewer" } });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.equal(draft.result.bundle.event.payload.settings.roles?.defaultReviewer, "audit-reviewer");
  assert.equal(readSettingsFacet(draft.result.bundle.blobs[0].body).roles?.defaultReviewer, "audit-reviewer");
  assertSettingsEventInputs(draft.result.bundle.event, draft.result.bundle.plan, draft.result.bundle.blobs);
});

test("role deltas preserve other edge preferences and null clears only the selected role", () => {
  const first = compile({ roles: { defaultReviewer: "audit-reviewer", defaultWorker: "dev-worker" } });
  assert.equal(first.kind, "settings");
  if (first.kind !== "settings" || first.result.kind !== "event") throw new Error("missing settings event");
  const next = compile(
    { roles: { defaultCommander: "lead", defaultWorker: null } },
    {
      currentEntity: first.result.bundle.event.payload.settings,
      currentDocumentBody: first.result.bundle.blobs[0].body,
    },
  );
  if (next.kind !== "settings" || next.result.kind !== "event") throw new Error("missing settings event");
  assert.deepEqual(next.result.bundle.event.payload.settings.roles, {
    defaultReviewer: "audit-reviewer",
    defaultCommander: "lead",
  });
  assertSettingsEventInputs(next.result.bundle.event, next.result.bundle.plan, next.result.bundle.blobs);
});

test("role delta rejects unknown roles and malformed ids and current events reject the retired root", () => {
  for (const roles of [
    [],
    null,
    "reviewer",
    { reviewer: "audit" },
    { defaultReviewer: "" },
    { defaultWorker: 3 },
    { defaultCommander: "bad id" },
  ]) {
    assert.throws(
      () => compile({ roles }),
      (error: unknown) => error instanceof SettingsActionError && error.code === "invalid_command",
    );
  }
  const draft = compile({ roles: { defaultReviewer: "audit-reviewer" } });
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  const event = draft.result.bundle.event;
  assert.notDeepEqual(
    validateCurrentSettingsEvent({
      ...event,
      payload: { ...event.payload, settings: { ...event.payload.settings, defaultReviewer: "retired-reviewer" } },
    }),
    [],
  );
});

test("a new roles write removes the retired YAML root while preserving the normalized preference", () => {
  const draft = compile(
    { roles: { defaultCommander: "lead" } },
    {
      currentEntity: { ...current, roles: { defaultReviewer: "legacy-reviewer" } },
      currentDocumentBody: `${documentBody}  defaultReviewer: legacy-reviewer\n`,
    },
  );
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.doesNotMatch(draft.result.bundle.blobs[0].body, /^  defaultReviewer:/mu);
  assert.deepEqual(readSettingsFacet(draft.result.bundle.blobs[0].body).roles, {
    defaultReviewer: "legacy-reviewer",
    defaultCommander: "lead",
  });
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
    draft = compile({ authoredDocumentBody: authoredBody, reviewReturnBudget: 5 });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.equal(draft.result.bundle.event.payload.baseDocumentSha256, sha256Text(documentBody));
  assert.match(draft.result.bundle.blobs[0].body, /defaultPreset: standard-task/u);
});

test("Settings update falls back to the committed document when the authored one does not parse", () => {
  const draft = compile({ authoredDocumentBody: "settings:\n  gates: [", reviewReturnBudget: 5 });
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
    [{ gateId: "ci", adapter: "" }],
    [{ gateId: "ci", adapter: "github-actions", selection: "oldest" }],
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
    () => compile({ reviewReturnBudget: 5, expectedVersion: 6 }),
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
  const names = new Set(settingsUpdateInputFields.map(({ field }) => field)),
    declared = new Set(
      SETTINGS_FIELD_DECLARATIONS.flatMap(({ action }) =>
        action && !("internal" in action && action.internal) ? [action.field] : [],
      ),
    );
  for (const expected of declared) assert.ok(names.has(expected), `${expected} missing from settingsUpdateInputFields`);
  assert.ok(names.has("agendaPinLimit"));
  assert.ok(names.has("wipLimit"));
  assert.ok(names.has("rootThreshold"));
  assert.ok(names.has("worktreeSetup"));
});

test("Settings update writes positive task WIP and root thresholds", () => {
  const draft = compile({ wipLimit: 12, rootThreshold: 4 });
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.deepEqual(draft.result.bundle.event.payload.settings.tasks, {
    wipLimit: 12,
    rootThreshold: 4,
    assignmentTtlMs: 86_400_000,
  });
  assert.match(draft.result.bundle.blobs[0].body, /^  tasks:\n    wipLimit: 12\n    rootThreshold: 4$/mu);
  for (const field of [{ wipLimit: 0 }, { rootThreshold: 0 }])
    assert.throws(
      () => compile(field),
      (error: unknown) => error instanceof SettingsActionError && error.code === "invalid_command",
    );
});

test("Settings update writes the schedule admission window the scheduler reads back from the facet", () => {
  const draft = compile({ scheduleAdmissionWindowMs: 600_000 });
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.deepEqual(draft.result.bundle.event.payload.settings.schedule, { admissionWindowMs: 600_000 });
  const written = draft.result.bundle.blobs[0].body;
  assert.match(written, /^  schedule:\n    admissionWindowMs: 600000$/mu);
  assert.equal(readSettingsFacet(written).schedule.admissionWindowMs, 600_000);
  assert.throws(
    () => compile({ scheduleAdmissionWindowMs: 999 }),
    (error: unknown) => error instanceof SettingsActionError && error.code === "invalid_command",
  );
});

test("Settings update records ordered worktree setup steps and clears them with none", () => {
  const draft = compile({ worktreeSetup: ["node-modules", " run: pip install -e . "] });
  if (draft.kind !== "settings" || draft.result.kind !== "event") throw new Error("missing settings event");
  assert.deepEqual(draft.result.bundle.event.payload.settings.worktree.setup, [
    "node-modules",
    "run: pip install -e .",
  ]);
  assert.match(draft.result.bundle.blobs[0].body, /^  worktree:\n    setup:\n      - node-modules\n      - run: pip/mu);
  assert.deepEqual(readSettingsFacet(draft.result.bundle.blobs[0].body).worktree.setup, [
    "node-modules",
    "run: pip install -e .",
  ]);
  const cleared = compile(
    { worktreeSetup: ["none"] },
    {
      currentEntity: draft.result.bundle.event.payload.settings,
      currentDocumentBody: draft.result.bundle.blobs[0].body,
    },
  );
  if (cleared.kind !== "settings" || cleared.result.kind !== "event") throw new Error("missing cleared settings event");
  assert.deepEqual(cleared.result.bundle.event.payload.settings.worktree.setup, []);
  assert.doesNotMatch(cleared.result.bundle.blobs[0].body, /worktree:/u);
});

test("Settings update rejects invalid or duplicate worktree setup steps", () => {
  for (const worktreeSetup of [["npm"], ["run:"], ["node-modules", "node-modules"], "node-modules"])
    assert.throws(
      () => compile({ worktreeSetup }),
      (error: unknown) => error instanceof SettingsActionError && error.code === "invalid_command",
      JSON.stringify(worktreeSetup),
    );
});

test("repositorySettingsActionValues covers every repository field for a fully populated settings", () => {
  const populated = repositorySettings(
    readSettingsFacet(
      `${documentBody}  closeout:\n    profile: standard\n  roles:\n    defaultReviewer: arch-reviewer\n  ci:\n    workflows: [ci]\n  restoreDrillRetention: 5\n`,
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
