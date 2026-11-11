// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NODE_AUTO_CLAIM_POLICY,
  parseNodeAutoClaimPolicy,
  writeNodeAutoClaimPolicy,
} from "../src/node-auto-claim-config.ts";
import {
  decideNodeAutoClaim,
  nodeAutoClaimLeaseKey,
  openNodeAutoClaimLoop,
  parseNodeAutoClaimCandidates,
  parseNodeAutoClaimSnapshot,
} from "../src/node-auto-claim.ts";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const assignment = {
  taskId: "task-a",
  workspaceRevision: 1,
  expiresAt: "2026-11-03T00:00:00.000Z",
  assignedByPersonId: "person-a",
  assignedByTeamIds: ["team-a"],
} as const;
const policy = {
  ...DEFAULT_NODE_AUTO_CLAIM_POLICY,
  enabled: true,
  allowedAgentIds: ["sol"],
  maxConcurrent: 2,
} as const;

test("Fleet auto-claim candidate witnesses must match their task and assignment revision", () => {
  const candidate = {
    schema: "node-auto-claim-candidates/v2",
    activeTaskIds: ["task-active"],
    candidates: [
      {
        taskId: "task-a",
        autoAssignment: {
          ...assignment,
          workspaceRevision: 5,
        },
      },
    ],
  };
  assert.equal(parseNodeAutoClaimCandidates(candidate)[0]?.autoAssignment?.taskId, "task-a");
  assert.deepEqual(parseNodeAutoClaimSnapshot(candidate).activeTaskIds, ["task-active"]);
  assert.throws(() => parseNodeAutoClaimSnapshot({ ...candidate, activeTaskIds: ["", 2] }), /snapshot is invalid/u);
  assert.throws(
    () =>
      parseNodeAutoClaimCandidates({
        ...candidate,
        candidates: [
          {
            ...candidate.candidates[0],
            autoAssignment: { ...candidate.candidates[0].autoAssignment, taskId: "task-b" },
          },
        ],
      }),
    /assignment witness is invalid/u,
  );
  assert.throws(
    () =>
      parseNodeAutoClaimCandidates({
        ...candidate,
        candidates: [
          {
            ...candidate.candidates[0],
            autoAssignment: { ...candidate.candidates[0].autoAssignment, workspaceRevision: 1.5 },
          },
        ],
      }),
    /assignment witness is invalid/u,
  );
  assert.throws(
    () =>
      parseNodeAutoClaimCandidates({
        ...candidate,
        candidates: [{ taskId: "task-a", autoAssignment: undefined }],
      }),
    /assignment witness is invalid/u,
  );
});

test("same owner is allowed while another person is denied", () => {
  assert.deepEqual(
    decideNodeAutoClaim({
      policy,
      assignment,
      ownerPersonId: "person-a",
      now: "2026-11-02T00:00:00.000Z",
      agentId: "sol",
      activeCount: 0,
    }),
    { accepted: true, reason: "accepted" },
  );
  assert.deepEqual(
    decideNodeAutoClaim({
      policy,
      assignment,
      ownerPersonId: "person-b",
      now: "2026-11-02T00:00:00.000Z",
      agentId: "sol",
      activeCount: 0,
    }),
    { accepted: false, reason: "source_not_allowed" },
  );
});

test("active lease accounting only counts work owned by the scanning node", () => {
  const lease = (nodeId: string) => ({ phase: "held", source: { kind: "node", nodeId } });
  assert.equal(
    nodeAutoClaimLeaseKey({ repoId: "repo-a", taskId: "task-a", nodeId: "node-a", lease: lease("node-a") }),
    "repo-a:task-a",
  );
  assert.equal(
    nodeAutoClaimLeaseKey({ repoId: "repo-a", taskId: "task-a", nodeId: "node-b", lease: lease("node-a") }),
    null,
  );
  assert.equal(
    nodeAutoClaimLeaseKey({
      repoId: "repo-a",
      taskId: "task-a",
      nodeId: "node-a",
      lease: { ...lease("node-a"), phase: "released" },
    }),
    null,
  );
});

test("person/team authorization, expiry, agent allowlist and concurrency are fail-closed", () => {
  const explicit = { ...policy, allowedSources: { personIds: ["person-a"], teamIds: ["team-b"] } };
  assert.equal(
    decideNodeAutoClaim({
      policy: explicit,
      assignment: { ...assignment, assignedByPersonId: "person-c" },
      ownerPersonId: "person-b",
      now: "2026-11-02T00:00:00.000Z",
      agentId: "sol",
      activeCount: 0,
    }).accepted,
    false,
  );
  assert.equal(
    decideNodeAutoClaim({
      policy: explicit,
      assignment: { ...assignment, assignedByPersonId: "person-c", assignedByTeamIds: ["team-b"] },
      ownerPersonId: "person-b",
      now: "2026-11-02T00:00:00.000Z",
      agentId: "sol",
      activeCount: 0,
    }).accepted,
    true,
  );
  assert.equal(
    decideNodeAutoClaim({
      policy: explicit,
      assignment,
      ownerPersonId: "person-a",
      now: "2026-11-03T00:00:00.000Z",
      agentId: "sol",
      activeCount: 0,
    }).reason,
    "expired",
  );
  assert.equal(
    decideNodeAutoClaim({
      policy: explicit,
      assignment,
      ownerPersonId: "person-a",
      now: "2026-11-02T00:00:00.000Z",
      agentId: "other",
      activeCount: 0,
    }).reason,
    "agent_not_allowed",
  );
  assert.equal(
    decideNodeAutoClaim({
      policy: explicit,
      assignment,
      ownerPersonId: "person-a",
      now: "2026-11-02T00:00:00.000Z",
      agentId: "sol",
      activeCount: 2,
    }).reason,
    "concurrency_limit",
  );
});

test("policy parser rejects unknown fields and normalizes identifiers", () => {
  assert.deepEqual(
    parseNodeAutoClaimPolicy({
      schema: "node-auto-claim/v1",
      enabled: true,
      allowedSources: { personIds: ["b", "a", "a"], teamIds: [] },
      allowedAgentIds: ["sol"],
      maxConcurrent: 1,
    }),
    {
      schema: "node-auto-claim/v1",
      enabled: true,
      allowedSources: { personIds: ["a", "b"], teamIds: [] },
      allowedAgentIds: ["sol"],
      maxConcurrent: 1,
    },
  );
  assert.throws(() => parseNodeAutoClaimPolicy({ ...policy, extra: true }), /unknown policy field/u);
  assert.throws(() => parseNodeAutoClaimPolicy({ ...policy, maxConcurrent: 0 }), /maxConcurrent/u);
});

test("loop bounds concurrent starts, de-duplicates in-flight tasks, and rescans after offline attach", async () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-node-auto-claim-loop-"));
  try {
    writeNodeAutoClaimPolicy(userRoot, { ...policy, maxConcurrent: 1 });
    const allowed = { id: "task-allowed", assignedBy: "owner", expiresAt: assignment.expiresAt },
      queued = { id: "task-queued", assignedBy: "owner", expiresAt: assignment.expiresAt };
    let online = false;
    let candidateReads = 0;
    let allowedRevision = 1;
    let fourthCandidateRead!: () => void;
    const fourthCandidateScan = new Promise<void>((resolve) => {
      fourthCandidateRead = resolve;
    });
    let release!: () => void;
    const runGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    let queuedStarted!: () => void;
    const queuedRun = new Promise<void>((resolve) => {
      queuedStarted = resolve;
    });
    const loop = openNodeAutoClaimLoop({
      userRoot,
      now: () => "2026-11-02T00:00:00.000Z",
      ownerPersonIdFor: async () => "owner",
      repos: () => (online ? ["repo-a"] : []),
      repoIdOf: (repo) => repo,
      candidates: async () => {
        candidateReads += 1;
        if (candidateReads >= 4) fourthCandidateRead();
        return [allowed, queued];
      },
      taskIdOf: (candidate) => candidate.id,
      assignmentOf: async (candidate) => ({
        taskId: candidate.id,
        workspaceRevision: candidate.id === allowed.id ? allowedRevision : 2,
        expiresAt: candidate.expiresAt,
        assignedByPersonId: candidate.assignedBy,
        assignedByTeamIds: [],
      }),
      activeTaskKeys: async () => [],
      agentIds: () => ["sol"],
      claimAndRun: async (_repo, candidate) => {
        started.push(candidate.id);
        if (candidate.id === queued.id) queuedStarted();
        await runGate;
      },
    });
    await loop.trigger("offline");
    assert.deepEqual(started, []);
    online = true;
    const first = loop.trigger("attach");
    const second = loop.trigger("replica");
    await Promise.all([first, second]);
    assert.deepEqual(started, ["task-allowed"]);
    assert.equal(candidateReads, 2);
    assert.equal(
      loop.diagnostics().some((row) => row.reason === "concurrency_limit"),
      true,
    );
    assert.equal(
      loop.diagnostics().some((row) => row.reason === "accepted" && row.agentId === "sol"),
      true,
    );
    release();
    await queuedRun;
    await fourthCandidateScan;
    await loop.trigger("external-wake");
    assert.deepEqual(started, ["task-allowed", "task-queued"]);
    allowedRevision = 3;
    await loop.trigger("assignment-reassigned");
    await loop.close();
    assert.deepEqual(started, ["task-allowed", "task-queued", "task-allowed"]);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("concurrency slots include local runs missing from the runtime projection", async () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-node-auto-claim-slots-"));
  try {
    writeNodeAutoClaimPolicy(userRoot, { ...policy, maxConcurrent: 2 });
    const first = { id: "task-first" },
      second = { id: "task-second" },
      third = { id: "task-third" };
    let candidates = [first],
      activeTaskKeys: readonly string[] = [];
    let release!: () => void;
    const runGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const loop = openNodeAutoClaimLoop({
      userRoot,
      now: () => "2026-11-02T00:00:00.000Z",
      ownerPersonIdFor: async () => "owner",
      repos: () => ["repo-a"],
      repoIdOf: (repo) => repo,
      candidates: async () => candidates,
      taskIdOf: (candidate) => candidate.id,
      assignmentOf: async (candidate) => ({
        taskId: candidate.id,
        workspaceRevision: 3,
        expiresAt: assignment.expiresAt,
        assignedByPersonId: "owner",
        assignedByTeamIds: [],
      }),
      activeTaskKeys: async () => activeTaskKeys,
      agentIds: () => ["sol"],
      claimAndRun: async (_repo, candidate) => {
        started.push(candidate.id);
        await runGate;
      },
    });
    await loop.trigger("first-candidate");
    candidates = [second, third];
    activeTaskKeys = ["repo-a:existing-runtime"];
    await loop.trigger("projection-lag");
    assert.deepEqual(started, ["task-first"]);
    assert.equal(loop.diagnostics().filter((row) => row.reason === "concurrency_limit").length, 2);
    release();
    await loop.close();
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a failed candidate is suppressed during refill while a later candidate proceeds", async () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-node-auto-claim-failure-"));
  try {
    writeNodeAutoClaimPolicy(userRoot, { ...policy, maxConcurrent: 1 });
    const failed = { id: "task-fails-before-start" },
      next = { id: "task-next" };
    const attempts = new Map<string, number>();
    let nextStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      nextStarted = resolve;
    });
    let finishNext!: () => void;
    const nextGate = new Promise<void>((resolve) => {
      finishNext = resolve;
    });
    const loop = openNodeAutoClaimLoop({
      userRoot,
      now: () => "2026-11-02T00:00:00.000Z",
      ownerPersonIdFor: async () => "owner",
      repos: () => ["repo-a"],
      repoIdOf: (repo) => repo,
      candidates: async () => [failed, next],
      taskIdOf: (candidate) => candidate.id,
      assignmentOf: async (candidate) => ({
        taskId: candidate.id,
        workspaceRevision: candidate.id === failed.id ? 10 : 11,
        expiresAt: assignment.expiresAt,
        assignedByPersonId: "owner",
        assignedByTeamIds: [],
      }),
      activeTaskKeys: async () => [],
      agentIds: () => ["sol"],
      claimAndRun: async (_repo, candidate) => {
        attempts.set(candidate.id, (attempts.get(candidate.id) ?? 0) + 1);
        if (candidate.id === failed.id) throw new Error("git preflight rejected");
        nextStarted();
        await nextGate;
      },
    });
    await loop.trigger("replica-confirmed");
    await started;
    assert.equal(attempts.get(failed.id), 1);
    assert.equal(attempts.get(next.id), 1);
    assert.equal(
      loop.diagnostics().some((row) => row.taskId === failed.id && row.reason === "claim_failed"),
      true,
    );
    finishNext();
    await loop.close();
    assert.equal(attempts.get(failed.id), 1, "runtime settlement does not recursively retry the failed assignment");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a terminal task frees its concurrency slot before its claim run returns", async () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-node-auto-claim-release-"));
  try {
    writeNodeAutoClaimPolicy(userRoot, { ...policy, maxConcurrent: 1 });
    const first = { id: "task-first" },
      successor = { id: "task-successor" };
    let candidates = [first];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let successorStarted!: () => void;
    const successorRun = new Promise<void>((resolve) => {
      successorStarted = resolve;
    });
    const started: string[] = [];
    const loop = openNodeAutoClaimLoop({
      userRoot,
      now: () => "2026-11-02T00:00:00.000Z",
      ownerPersonIdFor: async () => "owner",
      repos: () => ["repo-a"],
      repoIdOf: (repo) => repo,
      candidates: async () => candidates,
      taskIdOf: (candidate) => candidate.id,
      assignmentOf: async (candidate) => ({
        taskId: candidate.id,
        workspaceRevision: 1,
        expiresAt: assignment.expiresAt,
        assignedByPersonId: "owner",
        assignedByTeamIds: [],
      }),
      activeTaskKeys: async () => [],
      agentIds: () => ["sol"],
      claimAndRun: async (_repo, candidate) => {
        started.push(candidate.id);
        if (candidate.id === first.id) await firstGate;
        else successorStarted();
      },
    });
    await loop.trigger("first-candidate");
    candidates = [first, successor];
    // The predecessor's claim run is still parked on its detached session wait; only the
    // terminal event releases its slot.
    await loop.trigger("runtime-terminal");
    assert.deepEqual(started, ["task-first"]);
    assert.equal(
      loop.diagnostics().some((row) => row.taskId === successor.id && row.reason === "concurrency_limit"),
      true,
    );
    await loop.trigger("runtime-terminal", { repoId: "repo-a", taskId: first.id });
    await successorRun;
    assert.deepEqual(started, ["task-first", "task-successor"]);
    releaseFirst();
    await loop.close();
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
test("a disabled auto-claim loop never opens the owner replica and closes cleanly", async () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-disabled-claim-"));
  let ownerReads = 0;
  const loop = openNodeAutoClaimLoop({
    userRoot,
    now: () => "2026-11-02T00:00:00.000Z",
    repos: () => ["repo-unavailable"],
    repoIdOf: (repo: string) => repo,
    ownerPersonIdFor: async () => {
      ownerReads++;
      throw Object.assign(new Error("The edge replica generation is unavailable."), { code: "replica_unavailable" });
    },
    candidates: async () => [] as string[],
    taskIdOf: (taskId: string) => taskId,
    assignmentOf: async () => null,
    activeTaskKeys: async () => [],
    agentIds: () => [],
    claimAndRun: async () => {
      throw new Error("disabled loop attempted a claim");
    },
  });
  try {
    await loop.trigger("replica-confirmed");
    await loop.close();
    assert.equal(ownerReads, 0);
    assert.equal(loop.diagnostics()[0]?.reason, "disabled");
  } finally {
    await loop.close();
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("auto-claim close absorbs the daemon lifetime abort but keeps a real scan failure", async () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-node-auto-claim-close-"));
  try {
    writeNodeAutoClaimPolicy(userRoot, policy);
    const gatedScan = (signal?: AbortSignal) => {
      let started!: () => void;
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      let releaseCandidate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseCandidate = resolve;
      });
      const loop = openNodeAutoClaimLoop({
        userRoot,
        now: () => "2026-11-02T00:00:00.000Z",
        ...(signal ? { signal } : {}),
        ownerPersonIdFor: async () => "owner",
        repos: () => ["repo-a"],
        repoIdOf: (repo) => repo,
        candidates: async () => {
          started();
          await gate;
          if (signal?.aborted) throw signal.reason;
          throw new Error("scan failed for another reason");
        },
        taskIdOf: (candidate: string) => candidate,
        assignmentOf: async () => null,
        activeTaskKeys: async () => [],
        agentIds: () => ["sol"],
        claimAndRun: async () => undefined,
      });
      return { loop, reading, releaseCandidate, scan: loop.trigger("scan").catch(() => undefined) };
    };

    const lifetime = new AbortController(),
      cancelled = gatedScan(lifetime.signal);
    await cancelled.reading;
    lifetime.abort(new Error("daemon closed"));
    const closingCancelled = cancelled.loop.close();
    cancelled.releaseCandidate();
    await closingCancelled;
    await cancelled.scan;

    const failed = gatedScan();
    await failed.reading;
    const closingFailed = failed.loop.close();
    failed.releaseCandidate();
    await assert.rejects(closingFailed, /scan failed for another reason/u);
    await failed.scan;
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
