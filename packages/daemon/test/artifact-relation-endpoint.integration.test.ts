// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveRelationId, makeTaskEventReader, makeTaskProjection } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const kind = "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94",
  externalIssueKind = "entity-kind/KND-2a6d1b8f0c4e5d7b9f3a1c2e4d6b8f05",
  binding = withPolicyGroup(
    {
      actor: {
        principal: { personId: "person-artifact-relation" },
        executor: { kind: "agent" as const, id: "artifact-relation-edge" },
      },
      source: "local" as const,
      sourceNodeId: "node-artifact-relation",
    },
    "contributor",
  );

test("A vertical artifact entity is a relation endpoint for its declared triple only", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-relation-")),
    repoId = workspaceId("artifact-relation");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "artifact-relation-center",
      now: monotonicClock(),
    });
    const imported = await cell.run(
      {
        kind: "entity-import",
        entityKind: kind,
        locator: "/Users/example/ZeYu-AI-Brain/meeting-minutes.md",
        locatorKind: "local-path",
        mode: "reference",
        contentVersion: "sha256:declared-meeting-version",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    const importEvidence = receiptJson(imported) as {
        readonly mode: string;
        readonly contentState: string;
        readonly message: string;
        readonly preview: { readonly entityId: string };
      },
      entityId = importEvidence.preview.entityId,
      entityRef = `${kind}/${entityId}`;
    assert.equal(importEvidence.mode, "reference");
    assert.equal(importEvidence.contentState, "unobserved");
    assert.equal(importEvidence.message, "Reference registered; content not fetched.");
    assert.equal(imported.proof?.worktreeVisible, false);

    const listed = await cell.run({ kind: "entity-list", entityKind: kind }, binding),
      entities = (JSON.parse(String(listed.evidence)) as { readonly entities: readonly { readonly id: string }[] })
        .entities;
    assert.equal(listed.outcome, "applied", JSON.stringify(listed));
    assert.deepEqual(
      entities.map(({ id }) => id),
      [entityId],
    );

    const proposed = await cell.run(proposal("Artifact relation endpoint"), binding),
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

    const reversed = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: `decision/${decisionId}`,
        targetRef: entityRef,
        relationType: "relates",
        rationale: "The declared artifact direction must be discoverable.",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(reversed.code, "relation_direction_invalid", JSON.stringify(reversed));
    assert.match(JSON.stringify(reversed.diagnostic), /next: ha relation relate --source-ref/u);

    const invalidTarget = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: `decision/${decisionId}`,
        targetRef: entityRef,
        relationType: "refines",
        rationale: "Decision refines accepts a Decision target only.",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(invalidTarget.code, "relation_target_kind_invalid", JSON.stringify(invalidTarget));
    assert.match(JSON.stringify(invalidTarget.diagnostic), /decision --refines-->.*decision/u);

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

    assert.deepEqual(JSON.parse(JSON.stringify(undeclared)).diagnostic.allowedTriples, [
      { sourceKind: kind, type: "relates", targetKind: "decision" },
    ]);
    assert.equal(reversed.diagnostic?.kind, "validation");
    assert.equal("allowedTriples" in (reversed.diagnostic ?? {}), false);
    assert.equal("allowedTriples" in (invalidTarget.diagnostic ?? {}), false);

    const related = await cell.run({ kind: "relation-list", entity: entityRef }, binding),
      relatedRows = (
        JSON.parse(String(related.evidence)) as {
          readonly rows: readonly { readonly sourceRef: string; readonly targetRef: string; readonly state: string }[];
        }
      ).rows;
    assert.equal(related.outcome, "applied", JSON.stringify(related));
    assert.deepEqual(
      relatedRows.map(({ sourceRef, targetRef, state }) => ({ sourceRef, targetRef, state })),
      [{ sourceRef: entityRef, targetRef: `decision/${decisionId}`, state: "active" }],
    );

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
      const edge = rebuilt.readRelationEdge(relationId),
        record = rebuilt.getEntity(kind, entityId);
      assert.equal(edge?.sourceRef, entityRef, "the artifact edge must survive a cold rebuild");
      assert.equal(edge?.state, "active");
      assert.equal(record?.value.locator.kind, "local-path");
      assert.equal(record?.value.contentVersion, null);
      assert.equal(record?.value.observationMode, "reference");
      assert.equal(record?.value.contentState, "unobserved");
      assert.equal(record?.value.declaredContentVersion, "sha256:declared-meeting-version");
      assert.equal(record?.value.source.includes("node-artifact-relation"), true);
    } finally {
      rebuilt.close();
    }
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("URL, local-path, and local-kb references are queryable and relate to Work", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-reference-relations-")),
    repoId = workspaceId("artifact-reference-relations");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "artifact-reference-center",
      now: monotonicClock(),
    });
    const workId = "task-reference-work",
      work = await cell.run({ kind: "task-create", taskId: workId, title: "External documents Work" }, binding);
    assert.equal(work.outcome, "applied", JSON.stringify(work));

    const otherEdge = withPolicyGroup(
      {
        actor: binding.actor,
        source: "local" as const,
        sourceNodeId: "node-artifact-reference-second-edge",
      },
      "contributor",
    );
    const missingMode = await cell.run(
      {
        kind: "entity-import",
        entityKind: externalIssueKind,
        locator: "https://feishu.example/docs/meeting?id=42",
        locatorKind: "url",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(missingMode.code, "invalid_command", JSON.stringify(missingMode));
    assert.match(JSON.stringify(missingMode), /Choose an explicit import mode/u);
    assert.match(JSON.stringify(missingMode), /--mode reference --expected-version 0/u);
    assert.match(JSON.stringify(missingMode), /--mode snapshot --expected-version 0/u);

    const urlRequest = {
        kind: "entity-import",
        entityKind: externalIssueKind,
        locator: "https://feishu.example/docs/meeting?id=42",
        locatorKind: "url",
        mode: "reference",
        contentVersion: "revision-42",
        expectedVersion: 0,
      },
      [urlFirst, urlRetry] = await Promise.all([cell.run(urlRequest, binding), cell.run(urlRequest, otherEdge)]);
    assert.deepEqual(
      [urlFirst.outcome, urlRetry.outcome].sort(),
      ["applied", "no_changes"],
      JSON.stringify({ urlFirst, urlRetry }),
    );
    assert.equal(urlFirst.opId, urlRetry.opId);
    assert.equal(urlFirst.entityId, urlRetry.entityId);
    const changedVersion = await cell.run({ ...urlRequest, contentVersion: "revision-43" }, otherEdge);
    assert.equal(changedVersion.code, "revision_conflict", JSON.stringify(changedVersion));
    const urlReceipt = urlFirst.outcome === "applied" ? urlFirst : urlRetry;
    t.diagnostic(`sample-reference-receipt=${JSON.stringify(urlReceipt)}`);

    const references = [
      urlReceipt,
      await cell.run(
        {
          kind: "entity-import",
          entityKind: externalIssueKind,
          locator: "/Users/example/ZeYu-AI-Brain/meeting-minutes.md",
          locatorKind: "local-path",
          mode: "reference",
          contentVersion: "sha256:brain-version-42",
          expectedVersion: 0,
        },
        binding,
      ),
      await cell.run(
        {
          kind: "entity-import",
          entityKind: externalIssueKind,
          locator: "local-kb:brain:minutes/2026-10-28",
          locatorKind: "external-key",
          mode: "reference",
          expectedVersion: 0,
        },
        binding,
      ),
    ];
    const entityIds = references.map((receipt) => {
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      assert.equal(receipt.proof?.worktreeVisible, false);
      return String(receipt.entityId);
    });
    assert.equal(new Set(entityIds).size, 3);

    const listed = await cell.run({ kind: "entity-list", entityKind: externalIssueKind }, binding),
      entities = (JSON.parse(String(listed.evidence)) as { readonly entities: readonly { readonly id: string }[] })
        .entities;
    assert.equal(listed.outcome, "applied", JSON.stringify(listed));
    assert.deepEqual(entities.map(({ id }) => id).sort(), [...entityIds].sort());

    for (const entityId of entityIds) {
      const entityRef = `${externalIssueKind}/${entityId}`,
        related = await cell.run(
          {
            kind: "relation-relate",
            sourceRef: entityRef,
            targetRef: `task/${workId}`,
            relationType: "relates",
            rationale: "The external source supports this Work.",
            expectedVersion: 0,
          },
          binding,
        );
      assert.equal(related.outcome, "applied", JSON.stringify(related));
      const relationList = await cell.run({ kind: "relation-list", entity: entityRef }, binding),
        rows = (
          JSON.parse(String(relationList.evidence)) as {
            readonly rows: readonly {
              readonly sourceRef: string;
              readonly targetRef: string;
              readonly state: string;
            }[];
          }
        ).rows;
      assert.equal(relationList.outcome, "applied", JSON.stringify(relationList));
      assert.deepEqual(
        rows.map(({ sourceRef, targetRef, state }) => ({ sourceRef, targetRef, state })),
        [{ sourceRef: entityRef, targetRef: `task/${workId}`, state: "active" }],
      );
    }

    await cell.close();
    cell = undefined;
    const rebuildStore = makeTaskEventReader({ repoId, rootDir }),
      rebuilt = makeTaskProjection({ rootDir, eventStore: rebuildStore, now: () => "2026-09-04T00:02:00.000Z" });
    try {
      rebuilt.rebuild();
      for (const entityId of entityIds) {
        const record = rebuilt.getEntity(externalIssueKind, entityId);
        assert.equal(record?.value.observationMode, "reference");
        assert.equal(record?.value.contentState, "unobserved");
        assert.equal(record?.value.contentVersion, null);
      }
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
    body: "# Artifact relation endpoint\n\n## 背景\n\nArtifacts need canonical graph relationships.\n\n## 权衡\n\nCompare the registry with special-case parsing.\n\n## 结论\n\nUse the compiled direction registry.\n",
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
