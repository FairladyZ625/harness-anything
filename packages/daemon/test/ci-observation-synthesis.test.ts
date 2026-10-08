// harness-test-tier: contract
import { decodeCiObservation } from "../../kernel/test/fixtures/ci-observation.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { FrozenGateRequirement } from "@harness-anything/kernel";
import type { CiRunObservationEventV3 } from "../../kernel/test/fixtures/ci-observation.ts";
import type { RepoCellOperationalContext } from "../src/repo-cell-action-context.ts";
import {
  fetchCiObservations as fetchCiObservationsRaw,
  ingestCiObservations,
  privateLedgerCiObservations,
} from "../src/ci-observation-actions.ts";
import { githubActionsWitnessEvidence } from "../src/repo-cell-ci-evidence.ts";
import { projectionReady } from "../src/repo-cell-settlement.ts";

const actor = { principal: { personId: "person-synthesis" }, executor: null } as const;
const cellSettings = { closeout: { profile: "standard" }, ci: { workflows: ["ci"] } };
const ciRequirement: FrozenGateRequirement = {
  gateId: "ci",
  appliesTo: "code",
  witness: {
    adapterId: "github-actions",
    adapterOptions: {
      workflows: ["ci"],
      branch: "main",
      event: "push",
      coverage: "descendant",
      selection: "newest",
    },
  },
};

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
        event: "push",
      });
    assert.ok(args.includes("--paginate") && args.includes("--slurp"));
    return JSON.stringify([{ artifacts: [] }]);
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
    assert.equal(observed.payload.scope, "workflow");
    assert.equal(observed.payload.testSummary, null);
    assert.deepEqual(observed.payload.gates, []);
    assert.deepEqual(observed.payload.verification, {
      source: "github-actions",
      workflow: "ci",
      runId: "900",
      attempt: 1,
      headSha: delivered,
      conclusion: "success",
      event: "push",
    });
    const submitted = {
      schema: "execution/v1",
      executionId: "execution",
      iteration: 0,
      submission: { commitSha: delivered, deliverables: [], outputs: [], verificationNotes: [], knownGaps: [] },
    } as never;
    const evidence = githubActionsWitnessEvidence(
      {
        rootDir,
        projectionReady,
        settings: { read: () => cellSettings, readRepository: () => cellSettings },
        projection: {
          readCiRunObservations: () => ({
            status: "ready",
            events: events.map(decodeCiObservation),
            watermark: events.length,
            sourceRevision: events.length,
          }),
        },
        cellCodedError: (_code: string, message: string) => new Error(message),
      } as unknown as RepoCellOperationalContext,
      ciRequirement,
      submitted,
    );
    assert.equal(evidence?.result, "pass");
    assert.equal(evidence?.provenance.runId, "900.1");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("reimport authenticates an unconfigured run without letting it shadow configured CI", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-ci-workflow-provenance-")),
    events: CiRunObservationEventV3[] = [],
    cell = ingestCell(rootDir, events);
  try {
    const delivered = initMainRepo(rootDir),
      fetched = await fetchCiObservations(cell as never, { kind: "ci-observe-pull", runs: [901, 900] }, (async (
        _command: string,
        args: readonly string[],
      ) => {
        if (args[1] === "view")
          return JSON.stringify({
            workflowName: args[2] === "901" ? "other-ci" : "ci",
            headSha: delivered,
            headBranch: "main",
            status: "completed",
            conclusion: "success",
            attempt: 1,
            event: "push",
          });
        assert.ok(args.includes("--paginate") && args.includes("--slurp"));
        return JSON.stringify([{ artifacts: [] }]);
      }) as never),
      artifact = {
        run: {
          runId: "901.1",
          job: "other-ci",
          sha: delivered,
          branch: "main",
          prNumber: null,
          wallclockMs: 0,
          runner: "github-actions",
        },
      },
      oldDigest = createHash("sha256")
        .update(`verified-v3\u0000${artifact.run.runId}\u0000${artifact.run.job}`)
        .digest("hex");
    // The previous importer permanently omitted provenance for unconfigured workflows.
    cell.store.append({
      event: {
        schema: "ci-run-observation/v3",
        eventId: `event-${oldDigest}`,
        workspaceRevision: 1,
        opId: `ci-observation-${oldDigest}`,
        type: "ci_run_observed",
        actor,
        source: "local",
        occurredAt: cell.now(),
        payload: { run: artifact.run, tests: [], gates: [], verification: null },
      },
    });
    const receipt = ingestCiObservations(cell as never, { actor, source: "local" }, fetched);
    assert.equal(JSON.parse(receipt.evidence).imported, 2);
    assert.equal(events[0]!.payload.verification, null, "accepted history is not rewritten");
    assert.equal(events[1]!.payload.verification?.workflow, "other-ci");
    assert.equal(
      JSON.parse(ingestCiObservations(cell as never, { actor, source: "local" }, fetched).evidence).duplicate,
      2,
    );
    const evidence = githubActionsWitnessEvidence(
      {
        ...cell,
        projectionReady,
        projection: {
          readCiRunObservations: () => ({
            status: "ready",
            events: [...events].reverse(),
            watermark: events.length,
            sourceRevision: events.length,
          }),
        },
      } as unknown as RepoCellOperationalContext,
      ciRequirement,
      { submission: { commitSha: delivered }, iteration: 0, executionId: "execution" } as never,
    );
    assert.equal(evidence?.result, "pass");
    assert.equal(evidence?.provenance.runId, "900.1");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function fetchCiObservations(
  cell: Parameters<typeof fetchCiObservationsRaw>[0],
  action: Parameters<typeof fetchCiObservationsRaw>[1],
  runner: NonNullable<Parameters<typeof fetchCiObservationsRaw>[2]>,
) {
  const summaries = new Map<string, Record<string, unknown>>();
  return fetchCiObservationsRaw(cell, action, async (command, args, options) => {
    const match = args[0] === "api" ? /actions\/runs\/(\d+)\/attempts\/(\d+)$/u.exec(args[1] ?? "") : null;
    if (!match) {
      const result = await runner(command, args, options);
      if (args[1] === "view") summaries.set(args[2]!, JSON.parse(result));
      return result;
    }
    const summary = summaries.get(match[1]!)!;
    return JSON.stringify({
      run_attempt: Number(match[2]),
      head_sha: summary.headSha,
      head_branch: summary.headBranch,
      conclusion: summary.conclusion,
      event: summary.event,
      path: `.github/workflows/${summary.workflowName}.yml`,
      workflow_id: 1,
      name: summary.workflowName,
      repository: { full_name: "fixture/repository" },
    });
  });
}

test("distinct private ledger commits keep distinct observation identities and replay once", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-ci-private-ledger-")),
    ledger = path.join(rootDir, "harness"),
    events: CiRunObservationEventV3[] = [],
    cell = ingestCell(rootDir, events);
  try {
    initMainRepo(rootDir);
    mkdirSync(ledger);
    initMainRepo(ledger);
    for (const body of ["first private ledger cut", "second private ledger cut"]) {
      writeFileSync(path.join(ledger, "README.md"), body);
      git(ledger, "add", "README.md");
      git(ledger, "commit", "-qm", body);
      const fetched = privateLedgerCiObservations(cell);
      assert.equal(fetched.runs.length, 1);
      const accepted = ingestCiObservations(cell as never, { actor, source: "local" }, fetched);
      assert.equal(JSON.parse(accepted.evidence).imported, 1);
      const replay = ingestCiObservations(cell as never, { actor, source: "local" }, fetched);
      assert.equal(JSON.parse(replay.evidence).duplicate, 1);
    }
    assert.equal(events.length, 2);
    assert.notEqual(events[0]!.opId, events[1]!.opId);
    assert.notEqual(events[0]!.payload.run.sha, events[1]!.payload.run.sha);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
