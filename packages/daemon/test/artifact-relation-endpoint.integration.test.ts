// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveRelationId, makeTaskEventReader, makeTaskProjection } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const kind = "software/coding/architecture-decision-record@1",
  binding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-artifact-relation" },
        executor: { kind: "agent" as const, id: "artifact-relation-edge" },
      },
      source: "local" as const,
    },
    "repo-write",
  );

test("A vertical artifact entity is a relation endpoint for its declared triple only", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-relation-")),
    sourcePath = "docs/adr-0001.md",
    repoId = workspaceId("artifact-relation");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    writeFileSync(path.join(rootDir, sourcePath), "# Adopt the event ledger\n\nFirst observation.\n");
    git(rootDir, "add", sourcePath);
    git(rootDir, "commit", "-qm", "add artifact source");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "artifact-relation-center",
      now: monotonicClock(),
    });
    const imported = await cell.run(
      { kind: "entity-import", entityKind: kind, locator: sourcePath, expectedVersion: 0 },
      binding,
    );
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    const entityRef = `${kind}/${String((imported as { readonly entityId?: string }).entityId)}`,
      proposed = await cell.run(proposal("Artifact relation endpoint"), binding),
      decisionId = String(receiptJson(proposed).decisionId);
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));

    const declared = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: entityRef,
        targetRef: `decision/${decisionId}`,
        relationType: "relates",
        rationale: "The architecture decision record relates to the decision it records.",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(declared.outcome, "applied", JSON.stringify(declared));

    const undeclared = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: entityRef,
        targetRef: `decision/${decisionId}`,
        relationType: "derives",
        rationale: "An undeclared triple must be refused by the direction registry.",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(undeclared.outcome, "op_rejected", JSON.stringify(undeclared));
    assert.equal(undeclared.code, "relation_triple_undeclared", JSON.stringify(undeclared));

    await cell.close();
    cell = undefined;
    const relationId = deriveRelationId({
        source: entityRef,
        target: `decision/${decisionId}`,
        type: "relates",
        direction: "directed",
      }),
      rebuildStore = makeTaskEventReader({ repoId, rootDir }),
      rebuilt = makeTaskProjection({ rootDir, eventStore: rebuildStore, now: () => "2026-09-04T00:01:00.000Z" });
    try {
      rebuilt.rebuild();
      const edge = rebuilt.readRelationTruth().edges.find((row) => row.relationId === relationId);
      assert.equal(edge?.sourceRef, entityRef, "the artifact edge must survive a cold rebuild");
      assert.equal(edge?.state, "active");
    } finally {
      rebuilt.close();
    }
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function proposal(title: string) {
  return {
    kind: "decision-propose",
    jsonInput: JSON.stringify({
      title,
      question: "Should artifact entities be relation endpoints?",
      riskTier: "medium",
      urgency: "high",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Yes, through the compiled direction registry" }],
      rejected: [{ id: "RJ1", text: "Special-case artifact refs", whyNot: "It forks ref parsing" }],
      claims: [{ id: "C1", text: "The record documents this decision.", loadBearing: true }],
      fulfillments: [],
    }),
  } as const;
}
function receiptJson(receipt: { readonly evidence?: string }): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}
function monotonicClock(): () => string {
  let second = 0;
  return () => `2026-09-04T00:00:${String(second++).padStart(2, "0")}.000Z`;
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Artifact Relation Test");
  git(rootDir, "config", "user.email", "artifact-relation@example.invalid");
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git(rootDir, "add", ".");
  git(rootDir, "commit", "-qm", "base");
}
function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" });
}
