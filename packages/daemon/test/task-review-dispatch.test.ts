// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { historicalReadConclusions, type ExecutionV1 } from "@harness-anything/kernel";
import { reviewPacket } from "../src/repo-cell-packets.ts";
import { reviewFindingScopePrompt } from "../src/review-prompt-guidance.ts";
import { decisionReviewDispatchPrompt, dispatchTaskReview, reviewDispatchPrompt } from "../src/task-review-dispatch.ts";
import { taskExecutionPlacement } from "../src/task-execution-placement.ts";
import { openNodeAutoDispatchLoop, parseNodeAutoDispatchSnapshot } from "../src/node-auto-dispatch.ts";
import { nodeReworkDispatchCandidate } from "../src/task-return-dispatch.ts";
import { readLastExecutionWorkerDispatch } from "../src/dispatch-read.ts";

const sha256 = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");

test("review prompts reference the frozen submission without inlining artifacts or their anchors", () => {
  const packagePath = "tasks/task-review-prompt-bounds",
    bigBody = `REVIEW-ARTIFACT-HEAD\n${"raw evidence line\n".repeat(2000)}REVIEW-ARTIFACT-TAIL\n`,
    smallBody = "REVIEW-SMALL-ARTIFACT-FULL-BODY\n",
    execution = {
      executionId: "exe_review_bounds",
      iteration: 1,
      deliveryBaseline: { kind: "commit", commitSha: "b".repeat(40) },
      submission: {
        artifacts: [
          { path: "artifacts/raw-evidence.txt", revision: 1, blobSha256: sha256(bigBody) },
          { path: "artifacts/report.md", revision: 1, blobSha256: sha256(smallBody) },
        ],
      },
    } as unknown as ExecutionV1;
  const prompt = reviewDispatchPrompt({
    taskId: "task_review_bounds",
    packagePath,
    dispatchId: "dispatch_reviewbounds000001",
    execution,
    gates: [],
  });
  assert.match(prompt, /Independently review task task_review_bounds/u);
  assert.match(prompt, /JSON required fields: verdict, reason, evidenceChecked, findings/u);
  assert.match(prompt, /verdict: approved\|changes_requested\|dismissed/u);
  assert.doesNotMatch(prompt, /Owner adjudication context/u);
  assert.match(prompt, /execution-frozen delivery baseline.*b{40}/u);
  assert.match(prompt, /comparison cut frozen at execution start, before the first submission/u);
  assert.match(prompt, /not the delivery head/u);
  assert.match(prompt, /--amend never refreshes it/u);
  assert.match(prompt, /delivered head is the submission's commitSha/u);
  assert.match(prompt, /Read the G33 production-delta result/u);
  assert.match(prompt, /shared Kernel readSubmissionFacts result/u);
  assert.ok(prompt.includes(historicalReadConclusions[0]!.conclusion));
  assert.doesNotMatch(prompt, /REVIEW-ARTIFACT|REVIEW-SMALL-ARTIFACT|bodyTruncatedFromChars/u);
  assert.doesNotMatch(prompt, /raw-evidence\.txt|"artifacts":/u);
  assert.match(prompt, /ha task show task_review_bounds --json/u);
  assert.match(prompt, /reviewAttribution index/u);
  assert.match(prompt, /Implementation node: canonical-local\. Reviewer node: canonical-local/u);
  assert.match(prompt, /ha event list --entity task\/task_review_bounds --cursor/u);
  assert.match(prompt, /ha task dispatches task_review_bounds --json/u);
  assert.match(prompt, /Owner read-only API activity must not be attributed to the worker/u);
  assert.match(prompt, /worker's action is not excused by sharing the owner's principal/u);
  assert.match(prompt, /unknown actors remain asserted\/unverified/u);
  assert.match(prompt, /model\/agent name never establishes executor identity or permission/u);
  assert.match(prompt, /constraints\/authorization at that time/u);
  assert.match(prompt, /Mark the item `unverified`/u);
  assert.match(prompt, /same-node, same-cut evidence/u);
  assert.doesNotMatch(prompt, /For every artifact anchor in that submission/u);
  assert.doesNotMatch(prompt, /registered anchors at their frozen revisions/u);
  assert.match(prompt, /first review.*every blocking finding visible/u);
  assert.doesNotMatch(prompt, /previous report at/u);
});

test("execution placement follows the last lease holder's dispatch source", () => {
  const implementationLease = {
      executionId: "exe-placement",
      acquiredRevision: 1,
      holder: {
        source: { kind: "node", nodeId: "node-current" },
        actor: { executor: { id: "runtime-session:current" } },
      },
    },
    dispatch = (runtimeSessionId: string, source: unknown) => ({
      event: {
        source,
        payload: { role: "worker", runtimeSessionId },
      },
    }),
    cell = {
      projection: {
        readLatestLeaseIntervalForExecution: () => implementationLease,
        readRuntimeDispatchesByTaskExecution: () => [
          dispatch("older", { kind: "node", nodeId: "node-old" }),
          dispatch("current", { kind: "node", nodeId: "node-current" }),
        ],
      },
    } as unknown as Parameters<typeof taskExecutionPlacement>[0];
  assert.deepEqual(taskExecutionPlacement(cell, "task-placement", "exe-placement"), {
    kind: "node",
    nodeId: "node-current",
  });
});

test("execution placement uses the requested execution lease after a later execution starts", () => {
  const cell = {
    projection: {
      readLatestLeaseIntervalForExecution: (_taskId: string, executionId: string) =>
        executionId === "exe-submitted"
          ? {
              executionId: "exe-submitted",
              acquiredRevision: 10,
              holder: {
                source: { kind: "node", nodeId: "node-laptop" },
                actor: { executor: { id: "runtime-session:submitted" } },
              },
            }
          : {
              executionId: "exe-next-round",
              acquiredRevision: 20,
              holder: { source: "local", actor: { executor: { id: "owner" } } },
            },
      readRuntimeDispatchesByTaskExecution: () => [
        {
          event: {
            source: { kind: "node", nodeId: "node-laptop" },
            payload: { role: "worker", runtimeSessionId: "submitted" },
          },
        },
      ],
    },
  } as unknown as Parameters<typeof taskExecutionPlacement>[0];
  assert.deepEqual(taskExecutionPlacement(cell, "task-placement", "exe-submitted"), {
    kind: "node",
    nodeId: "node-laptop",
  });
});

test("execution placement does not infer a physical node from non-portable sources", () => {
  const cell = {
    projection: {
      readLatestLeaseIntervalForExecution: () => ({
        executionId: "exe-placement",
        acquiredRevision: 1,
        holder: {
          source: "remote_direct",
          actor: { executor: { id: "runtime-session:current" } },
        },
      }),
      readRuntimeDispatchesByTaskExecution: () => [
        { event: { source: "remote_direct", payload: { role: "worker", runtimeSessionId: "current" } } },
      ],
    },
  } as unknown as Parameters<typeof taskExecutionPlacement>[0];
  assert.deepEqual(taskExecutionPlacement(cell, "task-placement", "exe-placement"), {
    kind: "unresolved",
    reason: "the implementation lease holder has no portable node source",
  });
});

test("explicit review dispatch stays pending when its execution source cannot be resolved", async () => {
  const taskId = "task-review-placement-unresolved",
    executionId = "execution-review-placement-unresolved",
    snapshot = {
      task: {
        schema: "task/v2",
        taskId,
        title: "Unresolved review placement",
        taskClass: "standard",
        status: "in_review",
        graph: { nodes: [], edges: [] },
        currentNode: "review",
        iteration: 0,
        createdBy: { principal: { kind: "person", id: "owner" } },
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned: false,
      },
      revision: 2,
      executions: [{ schema: "execution/v1", executionId, iteration: 0, state: "submitted", submission: {} }],
      reviews: [],
      edgesTaken: [],
      lease: null,
    },
    cell = {
      input: { repoId: "repo-review-placement-unresolved" },
      projection: {
        read: () => ({ snapshot, packagePath: "tasks/review-placement-unresolved", watermark: 2, sourceRevision: 2 }),
        readLatestLeaseIntervalForExecution: () => ({
          taskId,
          executionId,
          acquiredRevision: 1,
          holder: { source: "remote_direct", actor: { executor: null } },
        }),
        readRuntimeDispatchesByTaskExecution: () => [],
      },
      settings: { readRepository: () => ({ roles: { defaultReviewer: "default-reviewer" } }) },
      store: { readHead: () => ({ revision: 2 }) },
      operationId: () => "op-review-placement-unresolved",
    } as unknown as Parameters<typeof dispatchTaskReview>[0];
  const result = await dispatchTaskReview(
    cell,
    { kind: "task-dispatch-review", taskIds: [taskId], agentId: "selected-reviewer" } as never,
    { actor: { principal: { personId: "owner" }, executor: null }, source: "local" } as never,
  );
  const step = (result.dispatches as readonly Record<string, unknown>[])[0];
  assert.equal(result.outcome, "pending", JSON.stringify(result));
  assert.equal(step?.outcome, "pending", JSON.stringify(step));
  assert.equal(step?.agentId, "selected-reviewer");
  assert.match(String(result.warnings), /no runtime dispatch was created/u);
});

test("execution placement uses a portable lease source without inventing a runtime dispatch", () => {
  for (const [source, expected] of [
    ["local", { kind: "local" }],
    [
      { kind: "node", nodeId: "node-laptop" },
      { kind: "node", nodeId: "node-laptop" },
    ],
  ] as const) {
    const cell = {
      projection: {
        readLatestLeaseIntervalForExecution: () => ({
          executionId: "exe-placement",
          acquiredRevision: 1,
          holder: { source, actor: { executor: { id: "implementer" } } },
        }),
      },
    } as unknown as Parameters<typeof taskExecutionPlacement>[0];
    assert.deepEqual(taskExecutionPlacement(cell, "task-placement", "exe-placement"), expected);
  }
});

test("execution placement rejects a dispatch source that disagrees with the implementation lease", () => {
  const cell = {
    projection: {
      readLatestLeaseIntervalForExecution: () => ({
        executionId: "exe-placement",
        acquiredRevision: 1,
        holder: {
          source: { kind: "node", nodeId: "node-laptop" },
          actor: { executor: { id: "runtime-session:current" } },
        },
      }),
      readRuntimeDispatchesByTaskExecution: () => [
        {
          event: {
            source: { kind: "node", nodeId: "node-center" },
            payload: { role: "worker", runtimeSessionId: "current" },
          },
        },
      ],
    },
  } as unknown as Parameters<typeof taskExecutionPlacement>[0];
  assert.deepEqual(taskExecutionPlacement(cell, "task-placement", "exe-placement"), {
    kind: "unresolved",
    reason: "the implementation dispatch source conflicts with its lease holder",
  });
});

test("node auto-dispatch deduplicates a pending key and accepts a new canonical attempt", async () => {
  const candidate = {
      repoId: "repo-node-dispatch",
      taskId: "task-node-dispatch",
      executionId: "exe-node-dispatch",
      kind: "review" as const,
      requiredNodeId: "node-laptop",
      dispatchKey: "review:first",
      payload: { taskId: "task-node-dispatch" },
    },
    snapshot = parseNodeAutoDispatchSnapshot({
      schema: "node-auto-dispatch-candidates/v1",
      candidates: [{ ...candidate, fallbackPayload: { taskId: "task-node-dispatch", dispatchKey: "review:fresh" } }],
    });
  assert.equal(snapshot.candidates[0]?.fallbackPayload?.dispatchKey, "review:fresh");
  let candidates = [candidate];
  const launched: string[] = [],
    loop = openNodeAutoDispatchLoop({
      read: async () => candidates,
      spawn: async (value) => {
        launched.push(value.dispatchKey);
      },
    });
  await loop.trigger("first-wake");
  await loop.trigger("duplicate-wake");
  assert.deepEqual(launched, ["review:first"]);
  candidates = [{ ...candidate, dispatchKey: "review:retry" }];
  await loop.trigger("next-canonical-attempt");
  assert.deepEqual(launched, ["review:first", "review:retry"]);
  await loop.close();
});

test("node rework candidate waits for the submitting worker to settle", () => {
  let settled = false;
  const taskId = "task-node-rework-settle",
    executionId = "exe-node-rework-settle",
    dispatchEvent = {
      schema: "agent-runtime-event/v1",
      type: "runtime_dispatch_requested",
      eventId: "event-dispatch-node-rework-settle",
      opId: "op-dispatch-node-rework-settle",
      workspaceRevision: 3,
      taskId,
      source: { kind: "node", nodeId: "node-laptop" },
      occurredAt: "2026-11-07T00:00:00.000Z",
      payload: {
        dispatchId: "dispatch_node_rework_settle_000000000001",
        runtimeSessionId: "worker-live",
        taskId,
        executionId,
        role: "worker",
        agentId: "worker",
        instanceId: "instance",
        provider: { instance: "instance", model: "model" },
        startedAt: "2026-11-07T00:00:00.000Z",
      },
    },
    task = {
      schema: "task/v2",
      taskId,
      title: "Node rework settle",
      taskClass: "standard",
      status: "active",
      graph: { nodes: [], edges: [] },
      currentNode: "implementation",
      iteration: 1,
      createdBy: { principal: { kind: "person", id: "owner" } },
      completionGateIds: [],
      presetSnapshotDigest: null,
      pinned: {},
    },
    snapshot = {
      task,
      revision: 4,
      executions: [
        {
          schema: "execution/v1",
          executionId,
          iteration: 0,
          state: "changes_requested",
          submission: {
            completionClaim: "Implementation complete.",
            verificationNotes: [],
            knownGaps: [],
            residualRisks: [],
          },
        },
      ],
      reviews: [
        {
          executionId,
          verdict: "changes_requested",
          reviewId: "review",
          reviewedAt: "2026-11-07T00:01:00.000Z",
          reason: "changes",
        },
      ],
      lease: null,
    },
    cell = {
      input: { repoId: "repo-node-rework-settle" },
      rootDir: "/tmp/repo-node-rework-settle",
      projection: {
        read: () => ({ snapshot, packagePath: "tasks/node-rework-settle" }),
        readLeaseIntervals: () => [
          {
            executionId,
            acquiredRevision: 2,
            holder: {
              source: { kind: "node", nodeId: "node-laptop" },
              actor: { executor: { id: "runtime-session:worker-live" } },
            },
          },
        ],
        readLatestLeaseIntervalForExecution: () => ({
          executionId,
          acquiredRevision: 2,
          holder: {
            source: { kind: "node", nodeId: "node-laptop" },
            actor: { executor: { id: "runtime-session:worker-live" } },
          },
        }),
        readRuntimeDispatchesByTaskExecution: () => [{ event: dispatchEvent }],
        readRuntimeDispatchByDispatchKey: () => null,
        readRuntimeSession: () =>
          settled
            ? { liveness: "settled", outcome: "succeeded", lastObservedAt: "2026-11-07T00:02:00.000Z" }
            : { liveness: "live", outcome: null, lastObservedAt: "2026-11-07T00:01:00.000Z" },
        readRuntimeSessionEventsByType: () => [],
        readDocument: () => ({ document: null }),
        readRuntimeDispatchByResumeSource: () => null,
        readRuntimeDispatchesByAttemptGroup: () => [],
        readTaskRelationsBySources: () => [],
      },
      settings: { readRepository: () => ({ roles: { defaultWorker: "worker" } }) },
    } as unknown as Parameters<typeof nodeReworkDispatchCandidate>[0];
  assert.deepEqual(taskExecutionPlacement(cell, taskId, executionId), { kind: "node", nodeId: "node-laptop" });
  assert.equal(
    readLastExecutionWorkerDispatch(cell.projection, {
      taskId,
      executionId,
      workerExecutorIds: new Set(["runtime-session:worker-live"]),
    })?.status,
    "running",
  );
  assert.equal(nodeReworkDispatchCandidate(cell, { taskId, requiredNodeId: "node-laptop" }), null);
  settled = true;
  assert.equal(
    readLastExecutionWorkerDispatch(cell.projection, {
      taskId,
      executionId,
      workerExecutorIds: new Set(["runtime-session:worker-live"]),
    })?.status,
    "succeeded",
  );
  const candidate = nodeReworkDispatchCandidate(cell, { taskId, requiredNodeId: "node-laptop" });
  assert.equal(candidate?.kind, "rework");
  assert.equal(candidate?.requiredNodeId, "node-laptop");
});

test("node auto-dispatch close cancels an in-flight candidate read", async () => {
  let readStarted!: () => void,
    observedAbort = false;
  const started = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const loop = openNodeAutoDispatchLoop({
    read: (signal) =>
      new Promise((resolve) => {
        readStarted();
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve([]);
          },
          { once: true },
        );
      }),
    spawn: async () => {
      assert.fail("a closed scan must not spawn candidates");
    },
  });
  const scan = loop.trigger("read-pending");
  await started;
  await loop.close();
  await scan;
  assert.equal(observedAbort, true);
});

test("re-review prompt does not require resolution bookkeeping", () => {
  const prompt = reviewDispatchPrompt({
    taskId: "task_review_resolution_guidance",
    packagePath: "tasks/task-review-resolution-guidance",
    dispatchId: "dispatch_reviewresolution1",
    execution: {
      executionId: "exe_review_resolution_guidance",
      iteration: 2,
      submission: {},
    } as unknown as ExecutionV1,
    gates: [],
  });
  assert.doesNotMatch(prompt, /exactly one resolution|Previous resolutions|prior-round finding/u);
  assert.match(prompt, /previous registered reviews and reports/u);
  assert.match(prompt, /frozen reviewResponses and their referenced attribution evidence/u);
  assert.match(prompt, /current authorized implementation identity/u);
});

test("a reviewer in its own checkout writes and registers through the canonical artifact root", () => {
  const artifactRoot = path.join(path.sep, "canonical", "harness"),
    packagePath = "tasks/task-review-artifact-root",
    prompt = reviewDispatchPrompt({
      taskId: "task_review_artifact_root",
      packagePath,
      dispatchId: "dispatch_artifactroot0001",
      execution: { executionId: "exe_artifact_root", iteration: 0, submission: {} } as unknown as ExecutionV1,
      gates: [],
      artifactRoot,
    }),
    packet = path.join(artifactRoot, packagePath, "artifacts", "reports", "dispatch_artifactroot0001.json");
  assert.ok(prompt.includes(packet), "the registration packet is absolute, not cwd-relative");
  assert.ok(prompt.includes(`--from-file ${packet}`), "registration names the canonical packet");
  assert.ok(
    prompt.includes(path.join(artifactRoot, packagePath, "artifacts", "reports", "dispatch_artifactroot0001.md")),
    "the report path is absolute too",
  );
});

test("a node reviewer receives a portable authored-root path", () => {
  const prompt = reviewDispatchPrompt({
    taskId: "task_portable_review",
    packagePath: "tasks/task-portable-review",
    dispatchId: "dispatch_portable_review",
    execution: {
      executionId: "exe_portable_review",
      iteration: 1,
      submission: {},
    } as unknown as ExecutionV1,
    gates: [],
    artifactPrefix: "project/harness",
    implementationNodeId: "node-laptop",
    reviewerNodeId: "node-laptop",
  });
  assert.match(
    prompt,
    /project\/harness\/tasks\/task-portable-review\/artifacts\/reports\/dispatch_portable_review\.md/u,
  );
  assert.match(prompt, /Implementation node: node-laptop\. Reviewer node: node-laptop/u);
  assert.doesNotMatch(prompt, /Write this execution's review report to \/(?:Users|srv|home)\//u);
});

test("decision review prompts hand the reviewer the exact registration identity fields", () => {
  const decisionId = "dec_REVIEWIDENTITY01",
    digest = `sha256:${"a".repeat(64)}`,
    dispatchId = "dispatch_reviewidentity1",
    prompt = decisionReviewDispatchPrompt({ decisionId, digest, dispatchId });
  assert.match(prompt, /Independently review Decision dec_REVIEWIDENTITY01/u);
  assert.ok(prompt.includes(`reviewId review-${dispatchId}`), "the exact dispatch-bound reviewId");
  assert.ok(prompt.includes(`reviewContentDigest ${digest}`), "the exact content digest");
  assert.ok(
    prompt.includes(`reportRef harness/decisions/decision-${decisionId}/artifacts/reports/${dispatchId}.md`),
    "the exact reportRef",
  );
  assert.match(prompt, /actor_unauthorized/u);
  assert.match(
    prompt,
    /JSON required fields: reviewId, reviewContentDigest, verdict, reason, findings, evidenceChecked, reportRef/u,
  );
  assert.match(
    prompt,
    new RegExp(
      `ha decision review ${decisionId} --from-file ` +
        `harness/decisions/decision-${decisionId}/artifacts/reports/${dispatchId}\\.json`,
      "u",
    ),
    "the exact registration command",
  );
  assert.match(prompt, /Author only verdict, reason, findings, and evidenceChecked yourself/u);
});

test("re-review guidance keeps a newly found invariant or production-path defect blocking", () => {
  const reReview = reviewFindingScopePrompt("re-review");
  assert.match(reReview, /verify each previous finding/u);
  assert.match(reReview, /breaks a current invariant or the production path is blocking/u);
  assert.match(reReview, /any other new finding is a non-blocking follow-up/u);
  assert.doesNotMatch(reReview, /Do not reopen|record it as non-blocking follow-up/u);
  // The first-review and re-review rules live in one module, so a dispatch path cannot quote a
  // different rule than the one the reviewer contract states.
  assert.notEqual(reviewFindingScopePrompt("first"), reReview);
  assert.match(reviewFindingScopePrompt("first"), /^On the first review,/u);
});

test("review prompt size is independent of evidence bytes and artifact count", () => {
  const packagePath = "tasks/task-bounds",
    body = "frozen evidence\n".repeat(2000),
    input = {
      taskId: "task-bounds",
      packagePath,
      dispatchId: "dispatch-bounds",
      gates: [],
    },
    promptFor = (count: number) =>
      reviewDispatchPrompt({
        ...input,
        execution: {
          executionId: "execution-bounds",
          iteration: 1,
          submission: {
            artifacts: Array.from({ length: count }, (_, i) => ({
              path: `${packagePath}/artifacts/evidence-${i % 80}.log`,
              revision: 1,
              blobSha256: sha256(body),
            })),
          },
        } as unknown as ExecutionV1,
      });
  assert.ok(Buffer.byteLength(body) * 80 > 1_048_576, "fixture exceeds the observed provider limit");
  const small = promptFor(1),
    large = promptFor(80),
    many = promptFor(10000);
  assert.equal(large.length, small.length);
  assert.equal(many.length, small.length);
  assert.ok(large.length < 10000, `reference prompt has ${large.length} characters`);
  assert.doesNotMatch(large, /frozen evidence/u);
});

test("review input accepts the dispatched field contract and rejects persisted-record metadata", () => {
  const value = {
    verdict: "approved",
    reason: "Checked the frozen delivery.",
    evidenceChecked: ["closeout.md"],
    findings: [],
    resolutions: [],
  };
  assert.deepEqual(
    reviewPacket("/unused", { kind: "task-review-execution", jsonInput: JSON.stringify(value) }).value,
    value,
  );
  for (const field of ["findings"] as const) {
    const missing = { ...value };
    delete missing[field];
    assert.throws(
      () => reviewPacket("/unused", { kind: "task-review-execution", jsonInput: JSON.stringify(missing) }),
      /Review JSON requires exactly/u,
    );
  }
  const withoutResolutions = { ...value };
  delete withoutResolutions.resolutions;
  assert.deepEqual(
    reviewPacket("/unused", { kind: "task-review-execution", jsonInput: JSON.stringify(withoutResolutions) }).value,
    withoutResolutions,
  );
  for (const metadata of [{ schema: "review/v1" }, { taskId: "task_1" }, { executionId: "exe_1" }])
    assert.throws(
      () =>
        reviewPacket("/unused", {
          kind: "task-review-execution",
          jsonInput: JSON.stringify({ ...value, ...metadata }),
        }),
      /Review JSON requires exactly/u,
    );
  assert.deepEqual(
    reviewPacket("/unused", {
      kind: "task-review-execution",
      jsonInput: JSON.stringify({ ...value, findings: [], resolutions: [] }),
    }).value,
    value,
  );
});

test("resolved fleet review packets preserve the local packet validation and digest", () => {
  const value = {
    verdict: "approved",
    reason: "Checked the wire cut.",
    evidenceChecked: ["tests"],
    findings: [],
    resolutions: [],
  };
  const resolved = { kind: "task-review-execution", taskId: "task_one", reviewId: "review_one", ...value };
  assert.deepEqual(
    reviewPacket("/unused", resolved),
    reviewPacket("/unused", {
      kind: "task-review-execution",
      jsonInput: JSON.stringify(value),
    }),
  );
  assert.throws(() => reviewPacket("/unused", { ...resolved, principal: "client" }), /Review JSON requires exactly/u);
  const { evidenceChecked: _evidence, ...missing } = resolved;
  assert.throws(() => reviewPacket("/unused", missing), /Review JSON requires exactly/u);
});
