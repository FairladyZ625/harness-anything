// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CiRunObservationEventV3 } from "../../kernel/src/index.ts";
import type { RepoCellOperationalContext } from "../src/repo-cell-action-context.ts";
import { fetchCiObservations, ingestCiObservations } from "../src/ci-observation-actions.ts";
import { readLatestCiEvidence } from "../src/repo-cell-task-progress.ts";
import { projectionReady } from "../src/repo-cell-settlement.ts";

const actor = { principal: { personId: "person-synthesis" }, executor: null } as const;
const cellSettings = { closeout: { profile: "standard" }, ci: { workflows: ["ci"] } };

function git(root: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    encoding: "utf8",
  }).trim();
}

function initMainRepo(root: string): string {
  git(root, "init", "-q", "-b", "main");
  writeFileSync(path.join(root, "README.md"), "peer repo\n");
  git(root, "add", "README.md");
  git(root, "commit", "-q", "-m", "delivered");
  return git(root, "rev-parse", "HEAD");
}

function ingestCell(rootDir: string, events: CiRunObservationEventV3[]) {
  let revision = 0;
  return {
    rootDir,
    settings: { read: () => cellSettings, readRepository: () => cellSettings },
    now: () => "2026-09-12T00:00:00.000Z",
    cellCodedError: (_code: string, message: string) => new Error(message),
    store: {
      readHead: () => (revision === 0 ? null : { revision }),
      readEvent: (opId: string) => events.find((event) => event.opId === opId),
      append: ({ event: observed }: { event: CiRunObservationEventV3 }) => {
        revision += 1;
        events.push(observed);
        return { revision };
      },
    },
    projection: { apply: () => undefined, readCiRunObservations: () => ({ watermark: events.length }) },
  };
}

const noArtifactRunGh = (delivered: string) =>
  (async (_command: string, args: readonly string[]) => {
    if (args[1] === "list")
      return JSON.stringify([{ databaseId: 900, headBranch: "main", createdAt: "2026-09-12T00:00:00Z" }]);
    if (args[1] === "view")
      return JSON.stringify({
        workflowName: "ci",
        headSha: delivered,
        headBranch: "main",
        status: "completed",
        conclusion: "success",
        attempt: 1,
      });
    assert.equal(args[1], "download");
    // A workflow that uploads no ci-observation-* artifacts fails the pattern download.
    throw new Error("no valid artifacts found to download");
  }) as never;

test("an artifact-less green main run synthesizes a passing observation from its run summary", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-ci-no-artifacts-")),
    events: CiRunObservationEventV3[] = [],
    cell = ingestCell(rootDir, events);
  try {
    const delivered = initMainRepo(rootDir);
    const receipt = ingestCiObservations(
      cell as never,
      { actor, source: "local" },
      await fetchCiObservations(cell as never, { kind: "ci-observe-pull", limit: 5 }, noArtifactRunGh(delivered)),
    );
    assert.equal(JSON.parse(receipt.evidence).imported, 1);
    assert.equal(events.length, 1);
    const observed = events[0]!;
    assert.deepEqual(observed.payload.tests, []);
    assert.deepEqual(observed.payload.gates, []);
    assert.deepEqual(observed.payload.verification, {
      source: "github-actions",
      workflow: "ci",
      runId: "900",
      attempt: 1,
      headSha: delivered,
      conclusion: "success",
    });
    const submitted = {
      schema: "execution/v1",
      executionId: "execution",
      iteration: 0,
      submission: { commitSha: delivered, deliverables: [], outputs: [], verificationNotes: [], knownGaps: [] },
    } as never;
    const evidence = readLatestCiEvidence(
      {
        rootDir,
        projectionReady,
        settings: { read: () => cellSettings, readRepository: () => cellSettings },
        projection: {
          readCiRunObservations: () => ({
            status: "ready",
            events,
            watermark: events.length,
            sourceRevision: events.length,
          }),
        },
        cellCodedError: (_code: string, message: string) => new Error(message),
      } as unknown as RepoCellOperationalContext,
      submitted,
    );
    assert.equal(evidence?.result, "pass");
    assert.equal(evidence?.provenance.runId, "900.1");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
