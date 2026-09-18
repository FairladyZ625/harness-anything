// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, validateReceiptAcceptance, WRITE_RECEIPT_SCHEMA } from "../../kernel/src/index.ts";
import { validateWriteReceipt } from "../../kernel/test/store/canonical-generation.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
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
    const binding = { actor, source: "local" as const },
      configPath = path.join(root, "harness/harness.yaml"),
      before = readFileSync(configPath, "utf8");
    const read = await cell.run({ kind: "settings-read" }, binding);
    assert.equal(read.outcome, "applied", JSON.stringify(read));
    const catalogSettings = (
        read as typeof read & {
          readonly settings?: { readonly locale?: string; readonly ci?: { readonly workflows: readonly string[] } };
        }
      ).settings,
      initialRevision = read.revision!;
    assert.equal(catalogSettings?.locale, "en-US");
    assert.deepEqual(catalogSettings?.ci?.workflows, ["ci"]);
    // The seeded bootstrap settings_changed event is the only change so far, and its provenance
    // (fixture actor, not the reader) surfaces on the read receipt.
    assert.deepEqual(read.lastChanged, {
      occurredAt: "2026-08-27T00:00:00.000Z",
      actor: "person:fixture",
      revision: 1,
    });
    for (const selection of [
      { defaultVertical: "software/coding", defaultPreset: "standard-task", defaultProfile: "prose" },
      { defaultVertical: "other/vertical", defaultPreset: "standard-task", defaultProfile: "baseline" },
    ]) {
      const rejected = await cell.run(
        { kind: "settings-update", ...selection, idempotencyKey: `reject-${selection.defaultVertical}` },
        binding,
      );
      assert.equal(rejected.outcome, "op_rejected");
      assert.equal(rejected.code, "invalid_settings_catalog_selection");
      assert.equal(readFileSync(configPath, "utf8"), before);
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
            walFlushEvents: 1024,
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
      flushApplied = await cell.run(
        {
          kind: "settings-update",
          walFlushAdaptive: false,
          walFlushEvents: 4096,
          walFlushBytes: 16_777_216,
          walFlushMilliseconds: 30_000,
          expectedVersion: currentRevision,
          idempotencyKey: "wal-flush-settings",
        },
        binding,
      );
    assert.equal(unchanged.outcome, "no_changes", JSON.stringify(unchanged));
    assert.equal(unchanged.code, "no_changes");
    assert.equal(unchanged.origin, "daemon");
    assert.equal(flushApplied.outcome, "applied", JSON.stringify(flushApplied));
    const settings = (await cell.read("repo.settings.read")) as {
      readonly settings: { readonly walFlush: unknown };
      readonly values: Readonly<Record<string, unknown>>;
    };
    assert.deepEqual(settings.settings.walFlush, {
      adaptive: false,
      events: 4096,
      bytes: 16_777_216,
      milliseconds: 30_000,
    });
    // settings read 附带 kernel 拍平的 action 值面:键 = 动作契约字段,GUI 设置表单据此回填。
    assert.equal(settings.values.walFlushAdaptive, false);
    assert.equal(settings.values.walFlushMilliseconds, 30_000);
    assert.equal(typeof settings.values.defaultVertical, "string");
    const flushed = await cell.run(
      { kind: "receipt-show", opId: flushApplied.opId, waitFor: ["worktree_visible"], timeoutMs: 5000 },
      binding,
    );
    assert.equal(flushed.wait?.state, "satisfied", JSON.stringify(flushed));
    assert.match(readFileSync(configPath, "utf8"), /walFlush:[\s\S]*adaptive: false[\s\S]*events: 4096/u);

    const ciApplied = await cell.run(
      {
        kind: "settings-update",
        ciWorkflows: ["ci", "nightly"],
        expectedVersion: flushApplied.revision,
        idempotencyKey: "ci-workflows-settings",
      },
      binding,
    );
    assert.equal(ciApplied.outcome, "applied", JSON.stringify(ciApplied));
    const ciSettings = (await cell.read("repo.settings.read")) as {
      readonly settings: { readonly ci: { readonly workflows: readonly string[] } };
    };
    assert.deepEqual(ciSettings.settings.ci.workflows, ["ci", "nightly"]);
    const ciFlushed = await cell.run(
      { kind: "receipt-show", opId: ciApplied.opId, waitFor: ["worktree_visible"], timeoutMs: 5000 },
      binding,
    );
    assert.equal(ciFlushed.wait?.state, "satisfied", JSON.stringify(ciFlushed));
    assert.match(readFileSync(configPath, "utf8"), /ci:\n    workflows: \[ci, nightly\]/u);

    const ciCleared = await cell.run(
      {
        kind: "settings-update",
        ciWorkflows: [],
        expectedVersion: ciApplied.revision,
        idempotencyKey: "ci-workflows-clear",
      },
      binding,
    );
    assert.equal(ciCleared.outcome, "applied", JSON.stringify(ciCleared));
    const clearedSettings = (await cell.read("repo.settings.read")) as {
      readonly settings: { readonly ci: { readonly workflows: readonly string[] } };
    };
    assert.deepEqual(clearedSettings.settings.ci.workflows, []);
    const clearFlushed = await cell.run(
      { kind: "receipt-show", opId: ciCleared.opId, waitFor: ["worktree_visible"], timeoutMs: 5000 },
      binding,
    );
    assert.equal(clearFlushed.wait?.state, "satisfied", JSON.stringify(clearFlushed));

    const ciReconfigured = await cell.run(
      {
        kind: "settings-update",
        ciWorkflows: ["ci"],
        expectedVersion: ciCleared.revision,
        idempotencyKey: "ci-workflows-reconfigure",
      },
      binding,
    );
    assert.equal(ciReconfigured.outcome, "applied", JSON.stringify(ciReconfigured));
    const noneCleared = await cell.run(
      {
        kind: "settings-update",
        ciWorkflows: ["none"],
        expectedVersion: ciReconfigured.revision,
        idempotencyKey: "ci-workflows-none",
      },
      binding,
    );
    assert.equal(noneCleared.outcome, "applied", JSON.stringify(noneCleared));
    const noneSettings = (await cell.read("repo.settings.read")) as {
      readonly settings: { readonly ci: { readonly workflows: readonly string[] } };
    };
    assert.deepEqual(noneSettings.settings.ci.workflows, []);
    const noneFlushed = await cell.run(
      { kind: "receipt-show", opId: noneCleared.opId, waitFor: ["worktree_visible"], timeoutMs: 5000 },
      binding,
    );
    assert.equal(noneFlushed.wait?.state, "satisfied", JSON.stringify(noneFlushed));
    assert.match(readFileSync(configPath, "utf8"), /ci:\n    workflows: \[\]/u);

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
    const binding = { actor, source: "local" as const },
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
      `${readFileSync(configPath, "utf8")}  gates:\n    ci:\n      adapter: github-actions\n` +
        "      appliesTo: code\n      branch: main\n      event: push\n      coverage: descendant\n" +
        "      selection: newest\n    code-doc-reconciliation: none\n",
    );
    const applied = await cell.run(
      { kind: "settings-update", gatesFromDocument: true, idempotencyKey: "gates-import" },
      binding,
    );
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    const after = await cell.run({ kind: "settings-read" }, binding);
    assert.deepEqual((after as typeof after & { readonly settings?: { readonly gates?: unknown } }).settings?.gates, [
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
    ]);
    // The facet write is symmetric: the canonical writer renders the block it parsed.
    assert.match(
      readFileSync(configPath, "utf8"),
      /  gates:\n    ci:\n      adapter: github-actions\n[\s\S]*    code-doc-reconciliation: none\n/u,
    );

    // An unreadable gates block is a typed rejection, never a partial write.
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}    lint: github-actions\n`);
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
    const binding = { actor, source: "local" as const },
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
          gateId: "ci",
          adapter: "github-actions",
          appliesTo: "code",
          branch: "main",
          event: "push",
          coverage: "descendant",
          selection: "newest",
          mandatorySignoff: true,
        },
        { gateId: "code-doc-reconciliation", adapter: "none" },
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
      /  gates:\n    ci:\n      adapter: github-actions\n[\s\S]*mandatorySignoff: true\n[\s\S]*    code-doc-reconciliation: none\n/u,
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
          gatesDraft: [{ gateId: "lint", adapter: "manual-attest", appliesTo: "submission", allowOverride: true }],
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
    const binding = { actor, source: "local" as const },
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
    const agent = { actor: agentActor, source: "local" as const },
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
      { actor, source: "local" as const },
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
      "  walFlush:",
      "    adaptive: true",
      "    events: 256",
      "    bytes: 8388608",
      "    milliseconds: 2000",
      "  locale: en-US",
      "  ci:",
      "    workflows: [ci]",
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
