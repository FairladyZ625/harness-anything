// harness-test-tier: integration
import assert from "node:assert/strict";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventReader,
  makeTaskEventStore,
  makeTaskProjection,
  validateReceiptAcceptance,
} from "@harness-anything/kernel";
import { WRITE_RECEIPT_SCHEMA } from "@harness-anything/kernel/internal/domain/receipt-domain-registry";
import { validateWriteReceipt } from "../../storage/test/store/canonical-generation.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { settingsLastChanged } from "../src/repo-cell-settings-state.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const actor = { principal: { personId: "settings-owner" }, executor: null } as const,
  agentActor = {
    principal: { personId: "settings-owner" },
    executor: { kind: "agent", id: "runtime-session:settings-test" },
  } as const;

test("settings writes reject catalog-inconsistent vertical, preset, and profile selections", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-settings-catalog-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("settings-catalog"),
      rootDir: canonicalRoot(root),
      ownerId: "settings-catalog-test",
    });
    const binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
      configPath = path.join(root, "harness/harness.yaml"),
      before = readFileSync(configPath, "utf8");
    const read = await cell.run({ kind: "settings-read" }, binding);
    assert.equal(read.outcome, "applied", JSON.stringify(read));
    const catalogSettings = (
        read as typeof read & {
          readonly settings?: Readonly<Record<string, unknown>>;
        }
      ).settings,
      initialRevision = read.revision!;
    assert.equal(catalogSettings?.locale, "en-US");
    assert.equal(Object.hasOwn(catalogSettings ?? {}, "ci"), false);
    // The seeded bootstrap settings_changed event is the only change so far, and its provenance
    // (fixture actor, not the reader) surfaces on the read receipt.
    assert.deepEqual(read.lastChanged, {
      occurredAt: "2026-08-27T00:00:00.000Z",
      actor: "person:fixture",
      revision: 1,
    });
    // dec_9DFDC635180975FDFC0CDB33D7/CH1: repository and bundled verticals share
    // resolution; an unknown vertical fails there before preset/profile selection.
    for (const [selection, code] of [
      [
        { defaultVertical: "software/coding", defaultPreset: "standard-task", defaultProfile: "prose" },
        "invalid_settings_catalog_selection",
      ],
      [
        { defaultVertical: "software/coding", defaultPreset: "unknown-preset", defaultProfile: "baseline" },
        "invalid_settings_catalog_selection",
      ],
      [
        { defaultVertical: "other/vertical", defaultPreset: "standard-task", defaultProfile: "baseline" },
        "missing_vertical",
      ],
    ] as const) {
      const rejected = await cell.run(
        {
          kind: "settings-update",
          ...selection,
          idempotencyKey: `reject-${selection.defaultVertical}-${selection.defaultPreset}-${selection.defaultProfile}`,
        },
        binding,
      );
      assert.equal(rejected.outcome, "op_rejected");
      assert.equal(rejected.code, code);
      assert.equal(readFileSync(configPath, "utf8"), before);
      const unchanged = await cell.run({ kind: "settings-read" }, binding);
      assert.equal(unchanged.revision, initialRevision);
      assert.deepEqual(unchanged.settings, catalogSettings);
    }

    const repositoryUpdate = {
        kind: "settings-update",
        defaultVertical: "software/coding",
        defaultPreset: "docs-task",
        defaultProfile: "baseline",
        expectedVersion: initialRevision,
        idempotencyKey: "valid-settings-selection",
      } as const,
      [applied, stale] = await Promise.all([
        cell.run(repositoryUpdate, binding),
        cell.run(
          {
            kind: "settings-update",
            reviewReturnBudget: 9,
            expectedVersion: initialRevision,
            idempotencyKey: "stale-settings-update",
          },
          binding,
        ),
      ]);
    assert.equal(applied.outcome, "applied", JSON.stringify({ applied, cellStatus: cell.status() }));
    assert.equal(applied.status, "accepted_durable");
    const receiptFields = new Set([...WRITE_RECEIPT_SCHEMA.required, ...WRITE_RECEIPT_SCHEMA.optional]);
    assert.deepEqual(
      validateWriteReceipt(Object.fromEntries(Object.entries(applied).filter(([key]) => receiptFields.has(key)))),
      [],
    );
    assert.deepEqual(applied.updatedProjection, {
      kind: "settings",
      ref: "settings/repository",
      revision: applied.revision,
    });
    assert.equal(stale.outcome, "op_rejected");
    assert.equal(stale.code, "revision_conflict");
    assert.deepEqual(stale.unmetCriteria, [
      {
        ref: "settings/singleton-revision",
        failureCode: "revision_conflict",
        explain: "When supplied, expectedVersion matches the current Settings singleton revision.",
      },
    ]);
    const visible = await cell.run(
      { kind: "receipt-show", opId: applied.opId, waitFor: ["worktree_visible"], timeoutMs: 5000 },
      binding,
    );
    assert.equal(visible.wait?.state, "satisfied", JSON.stringify(visible));
    assert.deepEqual(validateReceiptAcceptance(visible as unknown as Record<string, unknown>), []);
    assert.match(readFileSync(configPath, "utf8"), /defaultPreset: docs-task[\s\S]*defaultProfile: baseline/u);
    const eventStore = makeTaskEventReader({ repoId: "settings-catalog", rootDir: root }),
      audited = eventStore.readEvent(applied.opId);
    assert.equal(audited?.schema, "settings-event/v1");
    if (audited?.schema === "settings-event/v1") {
      assert.deepEqual(audited.actor, actor);
      assert.equal(audited.payload.settings.defaultPreset, "docs-task");
    }

    const eventCount = eventStore.read().events.filter((event) => event.schema === "settings-event/v1").length,
      replayed = await cell.run(repositoryUpdate, binding);
    assert.equal(replayed.outcome, "applied", JSON.stringify(replayed));
    assert.equal(replayed.opId, applied.opId);
    assert.equal(replayed.revision, applied.revision);
    assert.equal(eventStore.read().events.filter((event) => event.schema === "settings-event/v1").length, eventCount);

    // After the write, the attribution line follows the latest settings_changed event rather than
    // the bootstrap seed: principal actor and the event's own workspace revision.
    const attributed = await cell.run({ kind: "settings-read" }, binding);
    assert.equal(attributed.outcome, "applied", JSON.stringify(attributed));
    assert.deepEqual(attributed.lastChanged, {
      occurredAt: audited!.occurredAt,
      actor: "person:settings-owner",
      revision: applied.revision,
    });
    const guiRead = (await cell.read("repo.settings.read")) as { readonly lastChanged: unknown };
    assert.deepEqual(guiRead.lastChanged, attributed.lastChanged);

    const currentRevision = applied.revision!,
      unchanged = await cell.run(
        {
          kind: "settings-update",
          defaultPreset: "docs-task",
          expectedVersion: currentRevision,
          idempotencyKey: "unchanged-settings-selection",
        },
        binding,
      ),
      budgetApplied = await cell.run(
        {
          kind: "settings-update",
          reviewReturnBudget: 5,
          agendaPinLimit: 12,
          expectedVersion: currentRevision,
          idempotencyKey: "budget-settings",
        },
        binding,
      );
    assert.equal(unchanged.outcome, "no_changes", JSON.stringify(unchanged));
    assert.equal(unchanged.code, "no_changes");
    assert.equal(unchanged.origin, "daemon");
    assert.equal(budgetApplied.outcome, "applied", JSON.stringify(budgetApplied));
    const settings = (await cell.read("repo.settings.read")) as {
      readonly settings: Readonly<Record<string, unknown>>;
      readonly values: Readonly<Record<string, unknown>>;
    };
    assert.equal(settings.settings.reviewReturnBudget, 5);
    // The fixture document still carries the retired walFlush block; it is not a setting anymore.
    assert.equal(Object.hasOwn(settings.settings, "walFlush"), false);
    // settings read 附带 kernel 拍平的 action 值面:键 = 动作契约字段,GUI 设置表单据此回填。
    assert.equal(settings.values.reviewReturnBudget, 5);
    assert.equal(settings.values.agendaPinLimit, 12);
    assert.equal(Object.hasOwn(settings.values, "walFlushEvents"), false);
    assert.equal(typeof settings.values.defaultVertical, "string");
    const flushed = await cell.run(
      { kind: "receipt-show", opId: budgetApplied.opId, waitFor: ["worktree_visible"], timeoutMs: 5000 },
      binding,
    );
    assert.equal(flushed.wait?.state, "satisfied", JSON.stringify(flushed));
    const written = readFileSync(configPath, "utf8");
    assert.match(written, /reviewReturnBudget: 5/u);
    // A save leaves the retired block's lines exactly where the older repository had them.
    assert.match(
      written,
      /  walFlush:\n    adaptive: true\n    events: 256\n    bytes: 8388608\n    milliseconds: 2000\n/u,
    );

    const beforeLocalRevision = eventStore.readHead()!.revision,
      localApplied = await cell.run(
        { kind: "settings-update", locale: "zh-CN", idempotencyKey: "local-settings-update" },
        binding,
      );
    assert.equal(localApplied.outcome, "applied", JSON.stringify(localApplied));
    assert.equal(eventStore.readHead()!.revision, beforeLocalRevision);
    assert.deepEqual(localApplied.effects, ["settings-local/locale_changed"]);
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("settings update --gates-from-document mints authored harness.yaml gate mappings into the entity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-settings-gates-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("settings-gates"),
      rootDir: canonicalRoot(root),
      ownerId: "settings-gates-test",
    });
    const binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
      configPath = path.join(root, "harness/harness.yaml"),
      before = await cell.run({ kind: "settings-read" }, binding);
    assert.equal(before.outcome, "applied", JSON.stringify(before));
    assert.deepEqual(
      (before as typeof before & { readonly settings?: { readonly gates?: unknown } }).settings?.gates,
      [],
    );

    // The authored document is the user-facing declaration surface: editing harness.yaml and
    // running the write path is how an already-initialized repository declares gates.
    writeFileSync(
      configPath,
      `${readFileSync(configPath, "utf8")}  gates:\n    lint:\n      adapter: research/check\n` +
        "      appliesTo: code\n    contract: none\n",
    );
    const applied = await cell.run(
      { kind: "settings-update", gatesFromDocument: true, idempotencyKey: "gates-import" },
      binding,
    );
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    const after = await cell.run({ kind: "settings-read" }, binding);
    assert.deepEqual((after as typeof after & { readonly settings?: { readonly gates?: unknown } }).settings?.gates, [
      {
        gateId: "lint",
        adapter: "research/check",
        appliesTo: "code",
      },
      { gateId: "contract", adapter: "none" },
    ]);
    // The facet write is symmetric: the canonical writer renders the block it parsed.
    assert.match(
      readFileSync(configPath, "utf8"),
      /  gates:\n    lint:\n      adapter: research\/check\n[\s\S]*    contract: none\n/u,
    );

    // An unreadable gates block is a typed rejection, never a partial write.
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}    lint: research/check\n`);
    const rejected = await cell.run(
      { kind: "settings-update", gatesFromDocument: true, idempotencyKey: "gates-import-bad" },
      binding,
    );
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "invalid_command");
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("settings update gatesDraft splices the declared facet into the authored document and mints it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-settings-gates-draft-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("settings-gates-draft"),
      rootDir: canonicalRoot(root),
      ownerId: "settings-gates-draft-test",
    });
    const binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
      configPath = path.join(root, "harness/harness.yaml"),
      before = await cell.run({ kind: "settings-read" }, binding);
    assert.equal(before.outcome, "applied", JSON.stringify(before));
    assert.deepEqual(
      (before as typeof before & { readonly settings?: { readonly gates?: unknown } }).settings?.gates,
      [],
    );

    // The structured edit surface declares a draft of the authored settings.gates facet; the
    // ingress splices it into harness.yaml and mints the entity value from the document — same
    // provenance as --gates-from-document, with the facet bytes supplied instead of edited on disk.
    const gatesDraft = [
        {
          gateId: "lint",
          adapter: "research/check",
          appliesTo: "code",
          mandatorySignoff: true,
        },
        { gateId: "contract", adapter: "none" },
      ],
      applied = await cell.run({ kind: "settings-update", gatesDraft, idempotencyKey: "gates-draft" }, binding);
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    const after = await cell.run({ kind: "settings-read" }, binding);
    assert.deepEqual(
      (after as typeof after & { readonly settings?: { readonly gates?: unknown } }).settings?.gates,
      gatesDraft,
    );
    const visible = await cell.run(
      { kind: "receipt-show", opId: applied.opId, waitFor: ["worktree_visible"], timeoutMs: 5000 },
      binding,
    );
    assert.equal(visible.wait?.state, "satisfied", JSON.stringify(visible));
    assert.match(
      readFileSync(configPath, "utf8"),
      /  gates:\n    lint:\n      adapter: research\/check\n[\s\S]*mandatorySignoff: true\n[\s\S]*    contract: none\n/u,
    );

    // An unchanged draft compiles to no-changes.
    const unchanged = await cell.run(
      { kind: "settings-update", gatesDraft, idempotencyKey: "gates-draft-unchanged" },
      binding,
    );
    assert.equal(unchanged.outcome, "no_changes", JSON.stringify(unchanged));

    // Combinations the document cannot carry are typed rejections, never silent rewrites.
    for (const [idempotencyKey, action] of [
      [
        "gates-draft-governance",
        {
          kind: "settings-update",
          gatesDraft: [{ gateId: "lint", adapter: "manual-attest", appliesTo: "submission", allowOverride: "true" }],
          idempotencyKey: "gates-draft-governance",
        },
      ],
      [
        "gates-draft-none-fields",
        {
          kind: "settings-update",
          gatesDraft: [{ gateId: "lint", adapter: "none", appliesTo: "code" }],
          idempotencyKey: "gates-draft-none-fields",
        },
      ],
      [
        "gates-draft-both",
        { kind: "settings-update", gatesFromDocument: true, gatesDraft, idempotencyKey: "gates-draft-both" },
      ],
      ["gates-draft-shape", { kind: "settings-update", gatesDraft: "ci", idempotencyKey: "gates-draft-shape" }],
    ] as const) {
      const rejected = await cell.run(action, binding);
      assert.equal(rejected.outcome, "op_rejected", `${idempotencyKey}: ${JSON.stringify(rejected)}`);
      assert.equal(rejected.code, "invalid_command", idempotencyKey);
    }
    const stable = await cell.run({ kind: "settings-read" }, binding);
    assert.deepEqual(
      (stable as typeof stable & { readonly settings?: { readonly gates?: unknown } }).settings?.gates,
      gatesDraft,
    );
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("settings update commits an authored harness.yaml that drifted from the ledger with equal settings", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-settings-authored-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("settings-authored"),
      rootDir: canonicalRoot(root),
      ownerId: "settings-authored-test",
    });
    const binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
      configPath = path.join(root, "harness/harness.yaml"),
      authored = readFileSync(configPath, "utf8"),
      // Same settings, different text: the kind of drift that left the ledger permanently dirty.
      diverged = authored.replace("  walFlush:", "  # operator note\n  walFlush:");
    writeFileSync(configPath, diverged);
    assert.equal(
      execFileSync("git", ["-C", root, "status", "--short", "--", "harness/harness.yaml"], {
        encoding: "utf8",
      }).trim(),
      "M harness/harness.yaml",
    );

    const applied = await cell.run({ kind: "settings-update", idempotencyKey: "authored-absorb" }, binding);
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    const visible = await cell.run(
      { kind: "receipt-show", opId: applied.opId, waitFor: ["worktree_visible"], timeoutMs: 5000 },
      binding,
    );
    assert.equal(visible.wait?.state, "satisfied", JSON.stringify(visible));
    // The authored bytes are now the committed document: worktree unchanged and clean.
    assert.equal(readFileSync(configPath, "utf8"), diverged);
    assert.equal(
      execFileSync("git", ["-C", root, "status", "--short", "--", "harness/harness.yaml"], {
        encoding: "utf8",
      }).trim(),
      "",
    );
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("settings writes from a runtime executor are refused and must escalate to the principal", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-settings-principal-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("settings-principal"),
      rootDir: canonicalRoot(root),
      ownerId: "settings-principal-test",
    });
    const agent = withPolicyGroup({ actor: agentActor, source: "local" as const }, "admin"),
      configPath = path.join(root, "harness/harness.yaml"),
      before = readFileSync(configPath, "utf8");
    // Reads stay open to runtime actors; only the write path is principal-gated.
    const read = await cell.run({ kind: "settings-read" }, agent);
    assert.equal(read.outcome, "applied", JSON.stringify(read));

    const eventStore = makeTaskEventReader({ repoId: "settings-principal", rootDir: root }),
      settingsEvents = () => eventStore.read().events.filter((event) => event.schema === "settings-event/v1").length,
      refused = await cell.run(
        { kind: "settings-update", defaultPreset: "docs-task", idempotencyKey: "agent-settings-update" },
        agent,
      );
    assert.equal(refused.outcome, "op_rejected", JSON.stringify(refused));
    assert.equal(refused.code, "settings_write_requires_principal");
    assert.match(refused.rejectionExplanation ?? "", /dispatching principal/u);
    assert.equal(readFileSync(configPath, "utf8"), before);
    assert.equal(settingsEvents(), 1, "the refused write must not append a settings_changed event");

    // The same write from the principal (no executor) still applies.
    const applied = await cell.run(
      { kind: "settings-update", defaultPreset: "docs-task", idempotencyKey: "principal-settings-update" },
      withPolicyGroup({ actor, source: "local" as const }, "admin"),
    );
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function initRepo(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    [
      "schema: harness-anything/v1",
      "name: settings-catalog-test",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      "settings:",
      "  defaultVertical: software/coding",
      "  defaultPreset: standard-task",
      "  defaultProfile: baseline",
      // What init wrote before walFlush was retired; older repositories still carry these lines.
      "  walFlush:",
      "    adaptive: true",
      "    events: 256",
      "    bytes: 8388608",
      "    milliseconds: 2000",
      "  locale: en-US",
      "  scaffolds:",
      "    task: governance/task-scaffold.json",
      "    repository: governance/repository-scaffold.json",
      "",
    ].join("\n"),
  );
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Settings Test");
  git(root, "config", "user.email", "settings@example.invalid");
  git(root, "add", "harness/harness.yaml");
  git(root, "commit", "--quiet", "-m", "fixture");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
}

test("settingsLastChanged uses the canonical projection cut without scanning the store", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-settings-last-changed-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("settings-perf"),
      rootDir: canonicalRoot(root),
      ownerId: "settings-perf-test",
    });
    const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
    // Trigger an update so we have a distinct settings_changed event
    await cell.run(
      {
        kind: "settings-update",
        defaultPreset: "standard-task",
        defaultProfile: "baseline",
        expectedVersion: 1,
        idempotencyKey: "settings-perf-test-update",
      },
      binding,
    );
    const read = (await cell.read("repo.settings.read")) as { readonly lastChanged: unknown };
    assert.ok(read.lastChanged);

    // 1. Projection-assisted fast lookup
    const store = makeTaskEventStore({ repoId: workspaceId("settings-perf"), rootDir: canonicalRoot(root) });
    const projection = makeTaskProjection({ rootDir: canonicalRoot(root), eventStore: store });
    try {
      const fastAttribution = settingsLastChanged(projection);
      assert.deepEqual(fastAttribution, read.lastChanged);

      // An uninitialized projection has no settings event.
      assert.equal(settingsLastChanged({ readSettingsEvent: () => null }), "initial");
    } finally {
      projection.close();
    }
  } finally {
    cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// GUI 修订令牌契约(task_abfd845f39b26fc9da3d8ca9e9):repo.settings.read 携带与写路径
// 同源的 Settings singleton 行修订,GUI 以它作 expectedVersion。三类行为都在 cell 层锁定:
// 非 settings 事件不移动令牌、写后令牌前进且链式提交成功、陈旧令牌仍被拒。
test("repo.settings.read carries the write-path singleton revision as the GUI optimistic token", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-settings-token-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("settings-token"),
      rootDir: canonicalRoot(root),
      ownerId: "settings-token-test",
    });
    const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
    const readToken = async (): Promise<number> => {
      const read = (await cell.read("repo.settings.read")) as {
        readonly revision: number;
        readonly lastChanged: { readonly revision: number } | "initial";
      };
      assert.ok(Number.isSafeInteger(read.revision));
      return read.revision;
    };

    // 非 settings 事件(决策提案)落在最后一次 settings 变更之后,令牌不动:
    // 拿事件前读到的 revision 仍能保存——事件修订(attribution)与行修订(令牌)不再互相冒充。
    const before = await readToken();
    const proposed = await cell.run(decisionProposal(), binding);
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    assert.equal(await readToken(), before);
    const first = await cell.run(
      {
        kind: "settings-update",
        reviewReturnBudget: 5,
        expectedVersion: before,
        idempotencyKey: "settings-token-first",
      },
      binding,
    );
    assert.equal(first.outcome, "applied", JSON.stringify(first));

    // 连续两次快速提交:GUI 在回执后立即用回执修订顶新缓存,第二次提交带新令牌;
    // 写后的 read.revision 就是那份新令牌。带写前旧令牌的提交仍然被拒(真并发保护)。
    const afterFirst = await readToken();
    assert.equal(afterFirst, first.revision);
    const second = await cell.run(
      {
        kind: "settings-update",
        reviewReturnBudget: 6,
        expectedVersion: afterFirst,
        idempotencyKey: "settings-token-second",
      },
      binding,
    );
    assert.equal(second.outcome, "applied", JSON.stringify(second));
    const stale = await cell.run(
      {
        kind: "settings-update",
        reviewReturnBudget: 7,
        expectedVersion: before,
        idempotencyKey: "settings-token-stale",
      },
      binding,
    );
    assert.equal(stale.outcome, "op_rejected");
    assert.equal(stale.code, "revision_conflict");
  } finally {
    cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function decisionProposal() {
  return {
    kind: "decision-propose",
    body: "# Settings token behavior\n\n## 背景\n\nNon-settings events must not move the settings token.\n\n## 权衡\n\nRow revision versus event attribution.\n\n## 结论\n\nThe token stays on the singleton row revision.\n",
    jsonInput: JSON.stringify({
      title: "Settings token stays on the singleton row",
      question: "Do non-settings events move the settings optimistic token?",
      riskTier: "medium",
      urgency: "low",
      vertical: "default",
      preset: "default",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "The token does not move" }],
      rejected: [{ id: "RJ1", text: "The token follows every event", whyNot: "It would reject every save" }],
      claims: [],
      fulfillments: [],
    }),
  } as const;
}

// 评审 review-dispatch_e3e70b3b ①:harness.yaml 被其他写入改动后(台账侧的 doc 写与
// 文件侧的操作者/工具改动),用改动前读到的令牌保存设置不报 revision_conflict——
// 令牌只跟 settings singleton 行修订走,与文档世界的其他变化解耦。
test("settings saves keep their token across doc writes and harness.yaml edits by other writers", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-settings-foreign-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("settings-foreign"),
      rootDir: canonicalRoot(root),
      ownerId: "settings-foreign-test",
    });
    const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
    const readToken = async (): Promise<number> => {
      const read = (await cell.read("repo.settings.read")) as { readonly revision: number };
      assert.ok(Number.isSafeInteger(read.revision));
      return read.revision;
    };

    const token = await readToken();
    // 台账侧的「其他写入」:task plan/closeout 同族的 doc 写落在 harness 树的其他文档上
    // (harness.yaml 本身归 workspace-config 路由,doc 通道不能认领——改动后 dry-run 即拦)。
    mkdirSync(path.join(root, "harness/context"), { recursive: true });
    writeFileSync(path.join(root, "harness/context/notes.md"), "# Notes\n\nforeign write\n");
    const docSubmitted = await cell.run({ kind: "doc-submit", paths: ["context/notes.md"] }, binding);
    assert.equal(docSubmitted.outcome, "applied", JSON.stringify(docSubmitted));
    // 文件侧的「其他写入」:操作者/工具直接改 authored harness.yaml(等值漂移,非 settings
    // 事件);doc 通道拒绝认领它,这份改动只能经 settings 入口进账。
    const configPath = path.join(root, "harness/harness.yaml");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace("  walFlush:", "  # operator note\n  walFlush:"),
    );
    const workspaceDryRun = await cell.run({ kind: "doc-dry-run", paths: ["harness.yaml"] }, binding);
    assert.match(String(workspaceDryRun.evidence), /"path":"harness\.yaml"/u);
    assert.match(String(workspaceDryRun.evidence), /path is owned by workspace-config/u);
    // 两类其他写入都不移动 singleton 行修订:改动前的令牌照常保存,文件漂移由编译器吸收。
    assert.equal(await readToken(), token);
    const applied = await cell.run(
      {
        kind: "settings-update",
        reviewReturnBudget: 5,
        expectedVersion: token,
        idempotencyKey: "settings-foreign-token",
      },
      binding,
    );
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
