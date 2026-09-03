// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const binding = withRoleBinding(
  {
    actor: {
      principal: { personId: "person-task-read-set" },
      executor: { kind: "agent", id: "agent-task-read-set" },
    },
    source: "local" as const,
  },
  "repo-write",
);

interface ReadSetEvidence {
  readonly schema: string;
  readonly taskRef: string;
  readonly entries: readonly {
    readonly entityRef: string;
    readonly required: boolean;
    readonly authority: string;
    readonly freshness: string;
    readonly locator: string | null;
    readonly whyIncluded: { readonly source: string; readonly relationId: string; readonly type: string };
  }[];
  readonly blocked: boolean;
  readonly blockedReasons: readonly { readonly code: string }[];
  readonly projectionCut: { readonly status: string; readonly watermark: number; readonly sourceRevision: number };
}

/** Byte-level content of the ledger's task packages, so a read that writes is visible. */
function taskPackageFingerprint(rootDir: string): readonly string[] {
  const base = path.join(rootDir, "harness", "tasks");
  return readdirSync(base, { recursive: true, encoding: "utf8" })
    .filter((entry) => statSync(path.join(base, entry)).isFile())
    .sort()
    .map(
      (entry) =>
        `${entry}:${createHash("sha256")
          .update(readFileSync(path.join(base, entry)))
          .digest("hex")}`,
    );
}

test("task read-set derives one ordered projection per cut and never writes back", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-read-set-"));
  initRepo(rootDir);
  const repoId = workspaceId("task-read-set"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "task-read-set-test" });
  try {
    for (const [taskId, title] of [
      ["task_read_set_host", "Read set host"],
      ["task_read_set_required", "Required dependency"],
      ["task_read_set_related", "Related sibling"],
      ["task_read_set_late", "Late sibling"],
      ["task_read_set_isolated", "Isolated task"],
    ] as const)
      assert.equal((await cell.run({ kind: "task-create", taskId, title }, binding)).outcome, "applied");

    for (const [targetRef, relationType, rationale] of [
      ["task/task_read_set_required", "depends-on", "The host waits for the required dependency."],
      ["task/task_read_set_related", "relates", "The sibling shares the same surface."],
    ] as const)
      assert.equal(
        (
          await cell.run(
            {
              kind: "relation-relate",
              sourceRef: "task/task_read_set_host",
              targetRef,
              relationType,
              direction: "directed",
              origin: "declared",
              rationale,
              expectedVersion: 0,
            },
            binding,
          )
        ).outcome,
        "applied",
      );

    const readSet = async (taskId: string) => await cell.run({ kind: "task-read-set", taskId }, binding),
      warmed = await readSet("task_read_set_host");
    assert.equal(warmed.outcome, "applied", JSON.stringify(warmed));

    const fingerprintBefore = taskPackageFingerprint(rootDir),
      eventsBefore = makeTaskEventReader({ repoId, rootDir }).read().events.length,
      first = JSON.parse(String((await readSet("task_read_set_host")).evidence)) as ReadSetEvidence,
      second = JSON.parse(String((await readSet("task_read_set_host")).evidence)) as ReadSetEvidence;

    // (1) Two resolutions at the same cut agree field by field.
    assert.deepEqual(first, second);
    assert.equal(first.schema, "read-set/v1");
    assert.deepEqual(
      first.entries.map(({ entityRef, required, authority, whyIncluded }) => [
        entityRef,
        required,
        authority,
        whyIncluded.type,
      ]),
      [
        ["task/task_read_set_required", true, "historical", "depends-on"],
        ["task/task_read_set_related", false, "historical", "relates"],
      ],
    );
    assert.match(String(first.entries[0]?.locator), /^tasks\/task_read_set_required/u);
    assert.equal(first.entries[0]?.freshness, "current");
    assert.equal(first.entries[0]?.whyIncluded.source, "task-relation");
    assert.equal(first.blocked, false);
    assert.deepEqual(first.blockedReasons, []);

    // (3) Resolving wrote nothing: no ledger event, no byte changed in any task package.
    assert.deepEqual(taskPackageFingerprint(rootDir), fingerprintBefore);
    assert.equal(makeTaskEventReader({ repoId, rootDir }).read().events.length, eventsBefore);

    // (2) The answer is bound to the cut, not to who ran first.
    assert.equal(
      (
        await cell.run(
          {
            kind: "relation-relate",
            sourceRef: "task/task_read_set_host",
            targetRef: "task/task_read_set_late",
            relationType: "relates",
            direction: "directed",
            origin: "declared",
            rationale: "A late edge must appear in the next cut, not the previous one.",
            expectedVersion: 0,
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    const third = JSON.parse(String((await readSet("task_read_set_host")).evidence)) as ReadSetEvidence;
    assert.ok(
      third.projectionCut.sourceRevision > first.projectionCut.sourceRevision,
      `${third.projectionCut.sourceRevision} must advance past ${first.projectionCut.sourceRevision}`,
    );
    assert.deepEqual(
      third.entries.map(({ entityRef }) => entityRef),
      ["task/task_read_set_required", "task/task_read_set_late", "task/task_read_set_related"],
    );

    // Negative control: no active edges yields an empty set, not an error or a filename search.
    const isolated = JSON.parse(String((await readSet("task_read_set_isolated")).evidence)) as ReadSetEvidence;
    assert.deepEqual(isolated.entries, []);
    assert.equal(isolated.blocked, false);
    assert.equal(isolated.taskRef, "task/task_read_set_isolated");

    // Negative control: an unknown task id fails with the standard read command code.
    const missing = await readSet("task_read_set_absent");
    assert.equal(missing.outcome, "op_rejected", JSON.stringify(missing));
    assert.equal(missing.code, "task_not_found", JSON.stringify(missing));
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
