// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { OPAQUE_TEXTUAL_POLICY_ID } from "../../src/domain/artifact-text-classification.ts";
import { DOC_POLICY_ID, decideDocWrite, documentPath, type DocumentState } from "../../src/domain/doc-sync.contract.ts";
import { resolveTaskBoundRuntimeBinding, taskIsDescendantOf } from "../../src/domain/task-bound-runtime-authority.ts";
import { validateWriteReceipt } from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";

import {
  actor,
  authorizeDocWrite,
  baseLedgerSha,
  claim,
  currentLedgerSha,
  decide,
  lease,
  opaqueClaim,
  state,
} from "./doc-sync.fixtures.ts";
test("a task-bound runtime may write only its assigned task artifacts subtree while its execution lease is held", () => {
  const runtimeActor = {
      principal: actor.principal,
      executor: { kind: "agent", id: "runtime-session:runtime-doc" },
    } as const,
    runtimeBinding = {
      runtimeSessionId: "runtime-doc",
      taskId: lease.taskId,
      executionId: lease.executionId,
    },
    body = "runtime report\n";
  const run = (path: string, resolvedTaskId: string | null, overrides: Record<string, unknown> = {}) =>
    decideDocWrite({
      intent: {
        schema: "doc-write-intent/v1",
        executionId: lease.executionId,
        baseLedgerSha,
        changes: [
          {
            path: documentPath(path),
            baseBlobSha256: null,
            policyId: OPAQUE_TEXTUAL_POLICY_ID,
            candidate: opaqueClaim(body),
          },
        ],
      },
      opId: "runtime-doc-op",
      eventId: "runtime-doc-event",
      workspaceRevision: 3,
      actor: runtimeActor,
      source: "local",
      occurredAt: "2026-08-12T11:00:00.000Z",
      currentLedgerSha,
      lease,
      authorizationDecision: authorizeDocWrite(runtimeActor, runtimeBinding),
      runtimeBinding,
      documents: [null],
      claims: [Buffer.from(body)],
      resolvedTaskIds: [resolvedTaskId],
      ...overrides,
    });
  const accepted = run("tasks/task-owner-docs/artifacts/report.md", lease.taskId);
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  const delegated = run("tasks/task-child-docs/task_plan.md", "task-child", {
    runtimeDelegatedTaskId: "task-child",
  });
  assert.equal(delegated.accepted, true, JSON.stringify(delegated));
  for (const [name, result, code] of [
    [
      "canonical binding required",
      run("tasks/task-owner-docs/artifacts/unbound.md", lease.taskId, {
        runtimeBinding: undefined,
        authorizationDecision: authorizeDocWrite(runtimeActor),
      }),
      "lease_conflict",
    ],
    ["assigned task required", run("tasks/task-other-docs/artifacts/report.md", "task-other"), "unresolved_touch"],
    ["artifacts subtree required", run("tasks/task-owner-docs/task_plan.md", lease.taskId), "unresolved_touch"],
    [
      "delegation remains task specific",
      run("tasks/task-other-docs/task_plan.md", "task-other", { runtimeDelegatedTaskId: "task-child" }),
      "unresolved_touch",
    ],
  ] as const) {
    assert.equal(result.accepted, false, name);
    if (!result.accepted) assert.equal(result.code, code, name);
  }

  const session = {
    runtimeSessionId: "runtime-doc",
    instanceId: "codex",
    installationId: "installation",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definition/test",
    providerSessionId: "provider",
    transcriptRef: "provider:codex/provider",
    launchGeneration: 1,
    liveness: "live",
    attachable: true,
    taskBindings: [
      {
        taskId: lease.taskId,
        executionId: lease.executionId,
        providerSessionId: "provider",
        transcriptRef: "provider:codex/provider",
        boundAt: "2026-08-12T10:00:00.000Z",
      },
    ],
    outcome: null,
    exitCode: null,
    resultRef: null,
    lastObservedAt: "2026-08-12T10:00:00.000Z",
  } as const;
  assert.deepEqual(resolveTaskBoundRuntimeBinding(session, lease.taskId, lease.executionId), runtimeBinding);
  assert.deepEqual(
    resolveTaskBoundRuntimeBinding({ ...session, liveness: "unknown" }, lease.taskId, lease.executionId),
    runtimeBinding,
  );
  assert.equal(resolveTaskBoundRuntimeBinding(session, lease.taskId, "another-execution"), null);
  const parents = new Map([
    ["task-child", lease.taskId],
    ["task-grandchild", "task-child"],
    ["task-cycle-a", "task-cycle-b"],
    ["task-cycle-b", "task-cycle-a"],
  ]);
  assert.equal(
    taskIsDescendantOf("task-grandchild", lease.taskId, (taskId) => parents.get(taskId) ?? null),
    true,
  );
  assert.equal(
    taskIsDescendantOf("task-other", lease.taskId, (taskId) => parents.get(taskId) ?? null),
    false,
  );
  assert.equal(
    taskIsDescendantOf("task-cycle-a", lease.taskId, (taskId) => parents.get(taskId) ?? null),
    false,
  );
});

test("a canonical runtime occurrence archives only its dispatch artifacts without an execution lease", () => {
  const runtimeActor = {
      principal: actor.principal,
      executor: { kind: "agent", id: "runtime-session:runtime-archive" },
    } as const,
    scope = {
      dispatchId: "dispatch_0123456789abcdef01234567",
      runtimeSessionId: "runtime-archive",
      taskId: "task-owner",
      executionId: "execution-1",
      packagePath: "tasks/task-owner-docs",
    },
    bodies = ["{}\n", "Runtime result\n"],
    paths = [
      `tasks/task-owner-docs/artifacts/dispatches/${scope.dispatchId}.json`,
      `tasks/task-owner-docs/artifacts/reports/${scope.dispatchId}.md`,
    ],
    run = (overrides: Record<string, unknown> = {}) =>
      decideDocWrite({
        intent: {
          schema: "doc-write-intent/v1",
          executionId: null,
          baseLedgerSha,
          changes: [
            {
              path: documentPath(paths[0]!),
              baseBlobSha256: null,
              policyId: OPAQUE_TEXTUAL_POLICY_ID,
              candidate: opaqueClaim(bodies[0]!, "application/json"),
            },
            {
              path: documentPath(paths[1]!),
              baseBlobSha256: null,
              policyId: DOC_POLICY_ID,
              candidate: claim(bodies[1]!),
            },
          ],
        },
        opId: "runtime-archive-op",
        eventId: "runtime-archive-event",
        workspaceRevision: 3,
        actor: runtimeActor,
        source: "local",
        occurredAt: "2026-08-12T11:00:00.000Z",
        currentLedgerSha,
        lease: null,
        authorizationDecision: authorizeDocWrite(runtimeActor),
        runtimeArchive: scope,
        documents: [null, null],
        claims: bodies.map((body) => Buffer.from(body)),
        resolvedTaskIds: [scope.taskId, scope.taskId],
        ...overrides,
      });
  const accepted = run();
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  if (accepted.accepted) assert.equal(accepted.event.payload.executionId, null);
  for (const [name, result, code] of [
    ["occurrence proof required", run({ runtimeArchive: undefined }), "lease_conflict"],
    ["settlement authorization required", run({ authorizationDecision: null }), "authorization_denied"],
    [
      "matching runtime actor required",
      run({ actor: { ...runtimeActor, executor: { kind: "agent", id: "runtime-session:other" } } }),
      "lease_conflict",
    ],
    ["matching task paths required", run({ resolvedTaskIds: [scope.taskId, "task-other"] }), "lease_conflict"],
  ] as const) {
    assert.equal(result.accepted, false, name);
    if (!result.accepted) assert.equal(result.code, code, name);
  }
});

test("an opaque artifact write reclassifies an existing prose record without a policy upgrade", () => {
  const base = "---\ntitle: Legacy report\n---\n\n# Same\n\n# Same\n",
    candidate = "---\ntitle: Rewritten report\n---\n\n# Same\n\n# Same\n\nAll bytes are opaque.\n",
    path = documentPath("tasks/task-owner/artifacts/report.md"),
    document: DocumentState = { ...state(base), path, policyId: DOC_POLICY_ID };
  const result = decide(
    {
      path,
      baseBlobSha256: sha256Text(base),
      policyId: OPAQUE_TEXTUAL_POLICY_ID,
      candidate: opaqueClaim(candidate, "text/markdown"),
    },
    document,
    Buffer.from(candidate),
  );
  assert.equal(result.accepted, true, JSON.stringify(result));
  if (!result.accepted) return;
  const change = result.event.payload.changes[0]!;
  assert.equal(change.policyId, OPAQUE_TEXTUAL_POLICY_ID);
  assert.equal(change.candidate.mediaType, "text/markdown");
  assert.deepEqual(change.regionProofs, []);
  assert.equal("policyUpgrade" in change, false);
});

test("mixed body-replaceable rejection produces a valid typed receipt", () => {
  const shorterBase = "# Notes\nA much longer original sentence.\n",
    shorter = "# Notes\nShort.\n";
  const protectedBase = "---\nowner: owner\n---\n# Protected\nBody\n",
    protectedEdit = "---\nowner: other\n---\n# Protected\nBody\n";
  const changes = [
    {
      path: "context/notes.md",
      baseBlobSha256: sha256Text(shorterBase),
      policyId: DOC_POLICY_ID,
      candidate: claim(shorter),
    },
    {
      path: "context/protected.md",
      baseBlobSha256: sha256Text(protectedBase),
      policyId: DOC_POLICY_ID,
      candidate: claim(protectedEdit),
    },
  ] as const;
  const documents = [
    { ...state(shorterBase), path: documentPath("context/notes.md") },
    { ...state(protectedBase), path: documentPath("context/protected.md") },
  ];
  const result = decideDocWrite({
    intent: {
      schema: "doc-write-intent/v1",
      executionId: "execution-1",
      baseLedgerSha,
      changes,
    },
    opId: "doc-op",
    eventId: "doc-event",
    workspaceRevision: 3,
    actor,
    source: "local",
    occurredAt: "2026-08-12T11:00:00.000Z",
    currentLedgerSha,
    lease,
    authorizationDecision: authorizeDocWrite(),
    documents,
    claims: [Buffer.from(shorter), Buffer.from(protectedEdit)],
  });
  assert.equal(result.accepted, false);
  if (result.accepted) return;
  assert.equal(result.code, "unresolved_touch");
  assert.equal("plan" in result, false);
  for (const difference of result.detail.differences)
    for (const count of [difference.insertBytes, difference.deleteBytes, difference.replaceBytes])
      assert.equal(Number.isSafeInteger(count) && count >= 0, true, JSON.stringify(difference));
  const receipt = {
    outcome: "op_rejected",
    opId: "doc-op",
    code: result.code,
    origin: "doc-sync-contract",
    evidence: `contract-rejection:${result.code}`,
    diagnostic: { kind: "failure", code: result.code },
    detail: result.detail,
    authorizationDecision: result.authorizationDecision!,
  };
  assert.deepEqual(validateWriteReceipt(receipt), []);
});

test("Decision documents admit body-only sync and route new or frontmatter edits to typed commands", () => {
  const path = documentPath("decisions/decision-dec_IMPORTED_E12_ALPHA/decision.md"),
    base = "---\ndecision_id: dec_IMPORTED_E12_ALPHA\nstate: proposed\n---\n# Decision\n\nCanonical prose.\n",
    bodyOnly = base.replace("Canonical prose.", "Updated prose."),
    frontmatter = base.replace("state: proposed", "state: active"),
    mixed = frontmatter.replace("Canonical prose.", "Updated prose."),
    document = { ...state(base), path };
  const run = (candidate: string, current: DocumentState | null) =>
    decide(
      {
        path,
        baseBlobSha256: current?.blobSha256 ?? null,
        policyId: DOC_POLICY_ID,
        candidate: claim(candidate),
      },
      current,
      Buffer.from(candidate),
    );
  const accepted = run(bodyOnly, document);
  assert.equal(accepted.accepted, true);
  for (const [name, result] of [
    ["new", run("# Unregistered\n", null)],
    ["frontmatter", run(frontmatter, document)],
    ["mixed", run(mixed, document)],
  ] as const) {
    assert.equal(result.accepted, false, name);
    if (!result.accepted) {
      assert.equal(result.code, "unresolved_touch");
      assert.equal(result.detail.unresolvedTouches[0]?.requiredRoute, "ha decision --help");
    }
  }
});
