// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const binding = {
  actor: { principal: { personId: "person-agent-action" }, executor: null },
  source: "local" as const,
};
const declaration = {
  schema: "agent-declaration/v1",
  id: "unified-agent",
  name: "Unified Agent",
  instructions: "Execute the assigned mission through the canonical action route.",
  runtime_type: "codex",
};

test("Agent install uses the executable catalog with CAS, replay, readiness, and ActionResult", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-action-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("agent-action"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "agent-action-test",
  });
  try {
    const packageSource = path.join(rootDir, "source", declaration.id);
    mkdirSync(packageSource, { recursive: true });
    writeFileSync(path.join(packageSource, "agent.json"), `${JSON.stringify(declaration, null, 2)}\n`);
    const preview = await cell.run(
      {
        kind: "agent-install",
        packageSource,
        dryRun: true,
        expectedVersion: 0,
        idempotencyKey: "agent-action-preview",
      },
      binding,
    );
    assert.equal(preview.outcome, "pending");
    assert.equal(preview.proof?.durable, false);
    assert.deepEqual(preview.effects, []);
    assert.equal(preview.updatedProjection, null);

    const install = {
        kind: "agent-install",
        packageSource,
        expectedVersion: 0,
        idempotencyKey: "agent-action-install",
      },
      created = await cell.run(install, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    assert.deepEqual(created.effects, ["entity-event/entity_upserted"]);
    assert.deepEqual(created.updatedProjection, {
      kind: "agent",
      ref: "agent/unified-agent",
      revision: created.revision,
    });
    assert.equal(created.detail?.kind, "entity_upsert");
    assert.equal(created.detail?.entityKind, "agent");

    const replayed = await cell.run(install, binding);
    assert.equal(replayed.outcome, "applied", JSON.stringify(replayed));
    assert.equal(replayed.opId, created.opId);
    assert.equal(replayed.revision, created.revision);

    const stale = await cell.run(
      {
        kind: "agent-install",
        declaration: { ...declaration, name: "Stale Agent" },
        expectedVersion: 0,
        idempotencyKey: "agent-action-stale",
      },
      binding,
    );
    assert.equal(stale.outcome, "op_rejected");
    assert.equal(stale.code, "revision_conflict");
    assert.deepEqual(stale.unmetCriteria, [
      {
        ref: "agent/entity-revision",
        failureCode: "revision_conflict",
        explain: "When supplied, expectedVersion must match the latest Agent entity revision.",
      },
    ]);

    const placeholder = await cell.run(
      {
        kind: "agent-install",
        declaration: {
          ...declaration,
          id: "placeholder-agent",
          instructions: "(To be written: this text becomes the agent's system prompt verbatim.)",
        },
        expectedVersion: 0,
        idempotencyKey: "agent-action-placeholder",
      },
      binding,
    );
    assert.equal(placeholder.outcome, "op_rejected");
    assert.equal(placeholder.code, "instructions_placeholder");
    assert.deepEqual(placeholder.unmetCriteria, [
      {
        ref: "agent/instructions-ready",
        failureCode: "instructions_placeholder",
        explain: "Agent instructions must contain authored content rather than the declaration scaffold.",
      },
    ]);

    const inspected = await cell.run({ kind: "agent-inspect", agentId: declaration.id }, binding);
    assert.equal(JSON.parse(String(inspected.evidence)).agent.id, declaration.id);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
