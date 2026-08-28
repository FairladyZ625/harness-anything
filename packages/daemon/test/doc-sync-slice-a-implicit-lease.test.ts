// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, type TaskProjection } from "../../kernel/src/index.ts";
import { runDocAction } from "../src/doc-sync-actions.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

import { actor, git, initRepo, rows, write } from "./doc-sync-slice-a.fixtures.ts";
test("implicit submit applies eligible prose and reports an unrelated blocked row as skipped", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-partial-blocked-"));
  initRepo(rootDir);
  const repoId = workspaceId("partial-blocked"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "partial-blocked-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    write(rootDir, "context/blocked.md", "# Stable\n\nbase\n");
    assert.equal((await cell.run({ kind: "doc-submit", paths: ["context/blocked.md"] }, binding)).outcome, "applied");
    write(rootDir, "context/blocked.md", "# Renamed\n\nbase\n");
    write(rootDir, "context/eligible.md", "# Eligible\n\nship me\n");
    const submitted = (await cell.run({ kind: "doc-submit", paths: [] }, binding)) as Record<string, unknown>;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.match(
      String(submitted.summary),
      /doc-submit: applied[\s\S]*context\/eligible\.md[\s\S]*skipped:[\s\S]*context\/blocked\.md\tblocked\tbase region is missing: "# Stable"/u,
    );
    const event = makeTaskEventStore({ repoId, rootDir }).readEvent(String(submitted.opId));
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1")
      assert.deepEqual(
        event.payload.changes.map((change) => change.path),
        ["context/eligible.md"],
      );
    assert.equal(readFileSync(path.join(rootDir, "harness/context/eligible.md"), "utf8"), "# Eligible\n\nship me\n");
    assert.equal(readFileSync(path.join(rootDir, "harness/context/blocked.md"), "utf8"), "# Renamed\n\nbase\n");
    const settledHead = git(rootDir, "rev-parse", "HEAD"),
      skippedOnly = (await cell.run({ kind: "doc-submit", paths: [] }, binding)) as Record<string, unknown>;
    assert.equal(skippedOnly.outcome, "op_rejected", JSON.stringify(skippedOnly));
    assert.equal(skippedOnly.code, "preview_blocked");
    assert.match(
      String(skippedOnly.nextAction),
      /resolve context\/blocked\.md through refresh-region-policy: base region is missing: "# Stable"/u,
    );
    assert.doesNotMatch(String(skippedOnly.nextAction), /ha doc status/u);
    assert.equal(
      git(rootDir, "rev-parse", "HEAD"),
      settledHead,
      "a blocked-only implicit submit must reject without publishing an event",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("implicit submit applies eligible prose and reports an unrelated deletion as skipped", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-partial-deletion-"));
  initRepo(rootDir);
  const repoId = workspaceId("partial-deletion"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "partial-deletion-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    write(rootDir, "context/deleted.md", "# Retained\n");
    assert.equal((await cell.run({ kind: "doc-submit", paths: ["context/deleted.md"] }, binding)).outcome, "applied");
    rmSync(path.join(rootDir, "harness/context/deleted.md"));
    write(rootDir, "context/eligible.md", "# Eligible\n");
    const submitted = (await cell.run({ kind: "doc-submit", paths: [] }, binding)) as Record<string, unknown>;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.match(
      String(submitted.summary),
      /doc-submit: applied[\s\S]*context\/eligible\.md[\s\S]*skipped:[\s\S]*context\/deleted\.md\tdeletion\tcanonical document is missing from the worktree/u,
    );
    const event = makeTaskEventStore({ repoId, rootDir }).readEvent(String(submitted.opId));
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1")
      assert.deepEqual(
        event.payload.changes.map((change) => change.path),
        ["context/eligible.md"],
      );
    assert.equal(existsSync(path.join(rootDir, "harness/context/deleted.md")), false);
    assert.equal(readFileSync(path.join(rootDir, "harness/context/eligible.md"), "utf8"), "# Eligible\n");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a runtime session with multiple matching held executions rejects with exact retry commands", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-runtime-routes-"));
  initRepo(rootDir);
  const runtimeActor = {
      principal: { personId: "person-owner" },
      executor: { kind: "agent", id: "runtime-session:runtime-routes" },
    } as const,
    source = "local" as const,
    now = "2026-08-23T00:00:00.000Z",
    paths = ["tasks/task-route-a-a/artifacts/a.md", "tasks/task-route-b-b/artifacts/b.md"] as const;
  try {
    for (const target of paths) write(rootDir, target, `# ${target}\n`);
    const lease = (taskId: string, executionId: string) =>
        ({
          schema: "lease/v1",
          taskId,
          executionId,
          actor: {
            principal: { personId: "person-owner" },
            executor: { kind: "agent", id: "dispatch-holder" },
          },
          source,
          phase: "held",
          expiresAt: "2026-08-23T01:00:00.000Z",
          ttlMs: 3_600_000,
          version: 1,
        }) as const,
      leases = [lease("task-route-a", "exec-route-a"), lease("task-route-b", "exec-route-b")],
      projection = {
        taskIdForDocumentPath: (target: string) =>
          target.includes("task-route-a-a")
            ? "task-route-a"
            : target.includes("task-route-b-b")
              ? "task-route-b"
              : null,
        currentLeaseForExecution: (executionId: string) =>
          leases.find((value) => value.executionId === executionId) ?? null,
        readRuntimeSession: () => ({
          runtimeSessionId: "runtime-routes",
          instanceId: "codex",
          installationId: "installation",
          kindId: "codex",
          definitionSnapshotRef: "artifact:runtime-definition/test",
          providerSessionId: "provider",
          transcriptRef: "provider:codex/provider",
          launchGeneration: 1,
          liveness: "live",
          attachable: true,
          taskBindings: leases.map(({ taskId, executionId }) => ({
            taskId,
            executionId,
            providerSessionId: "provider",
            transcriptRef: "provider:codex/provider",
            boundAt: now,
          })),
          outcome: null,
          exitCode: null,
          resultRef: null,
          lastObservedAt: now,
        }),
        readDocument: () => ({
          status: "ready",
          watermark: 0,
          sourceRevision: 0,
          document: null,
        }),
      } as unknown as TaskProjection,
      store = makeTaskEventStore({ repoId: "runtime-routes", rootDir });
    const rejected = await runDocAction({
      action: { kind: "doc-submit", paths: [] },
      binding: { actor: runtimeActor, source },
      workspaceId: workspaceId("runtime-routes"),
      rootDir,
      store,
      projection,
      now: () => now,
    });
    assert.equal(rejected.outcome, "op_rejected");
    assert.equal(rejected.code, "lease_conflict");
    assert.match(rejected.nextAction ?? "", /run the task command for the matching execution/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// The scanner used to pin a single-task selection to that task's CURRENT lease
// regardless of who held it, so `ha doc sync --submit --path <p>` reported
// lease_conflict for a legal repository-prose write whenever the task was
// leased by a dispatched runtime — while an implicit submit escaped only when
// the dirty set happened to span two task packages. Both shapes must now ride
// the prose channel for a non-holder.
test("path and implicit submits ride the repository prose channel when the task lease is held by another executor", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-path-prose-"));
  initRepo(rootDir);
  const repoId = workspaceId("path-prose"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "path-prose-daemon",
    });
  const person = {
      actor: {
        principal: { personId: "person-owner" },
        executor: { kind: "agent", id: "codex" },
      },
      source: "local" as const,
    },
    holder = {
      actor: {
        principal: { personId: "person-owner" },
        executor: { kind: "agent", id: "runtime-session:lease-holder" },
      },
      source: "local" as const,
    },
    taskId = "task_PATHPR0SE000000000000AAAAA";
  try {
    const created = (await cell.run({ kind: "task-create", taskId, title: "path submit prose channel" }, person)) as {
        packagePath?: string;
      },
      packagePath = created.packagePath!;
    assert.equal(
      (await cell.run({ kind: "task-start", taskId, executionId: "exec-path-prose" }, holder)).outcome,
      "applied",
    );
    write(rootDir, `${packagePath}/artifacts/reports/leased.md`, "# Leased task report\n");
    write(rootDir, "context/shared.md", "# Shared\n");
    const status = await cell.run(
      {
        kind: "doc-status",
        paths: [`${packagePath}/artifacts/reports/leased.md`],
      },
      person,
    );
    assert.deepEqual(
      rows(status.evidence).map((row) => [row.path, row.state]),
      [[`${packagePath}/artifacts/reports/leased.md`, "eligible"]],
      JSON.stringify(status.evidence),
    );
    const scoped = await cell.run(
      {
        kind: "doc-submit",
        paths: [`${packagePath}/artifacts/reports/leased.md`],
      },
      person,
    );
    assert.equal(scoped.outcome, "applied", JSON.stringify(scoped));
    const event = makeTaskEventStore({ repoId, rootDir }).readEvent(scoped.opId);
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1") {
      assert.equal(
        event.payload.executionId,
        null,
        "a non-holder rides the lease-free prose channel, not the foreign lease",
      );
      assert.deepEqual(
        event.payload.changes.map((change) => change.path),
        [`${packagePath}/artifacts/reports/leased.md`],
      );
    }
    // A dirty set confined to the leased task package must not regress to the old single-task lease pin either.
    write(rootDir, "context/shared.md", "# Shared\nsynced\n");
    assert.equal((await cell.run({ kind: "doc-submit", paths: ["context/shared.md"] }, person)).outcome, "applied");
    write(rootDir, `${packagePath}/artifacts/reports/second.md`, "# Second\n");
    const implicit = (await cell.run({ kind: "doc-submit", paths: [] }, person)) as Record<string, unknown>;
    assert.equal(implicit.outcome, "applied", JSON.stringify(implicit));
    assert.match(String(implicit.summary), new RegExp(`applied:\\n${packagePath}/artifacts/reports/second\\.md`, "u"));
    // Naming the foreign execution explicitly still refuses — and the receipt names the exit that works.
    write(rootDir, `${packagePath}/artifacts/reports/third.md`, "# Third\n");
    const explicit = (await cell.run(
      {
        kind: "doc-submit",
        executionId: "exec-path-prose",
        paths: [`${packagePath}/artifacts/reports/third.md`],
      },
      person,
    )) as { outcome?: string; code?: string; nextAction?: string };
    assert.equal(explicit.outcome, "op_rejected");
    assert.equal(explicit.code, "lease_conflict");
    assert.match(
      explicit.nextAction ?? "",
      /execution exec-path-prose is not held by this principal; rerun ha doc sync --submit to submit through the repository prose channel/u,
    );
    const unnamed = (await cell.run(
      {
        kind: "doc-submit",
        paths: [`${packagePath}/artifacts/reports/third.md`],
      },
      person,
    )) as Record<string, unknown>;
    assert.equal(unnamed.outcome, "applied", JSON.stringify(unnamed));
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// A runtime actor whose lease lapsed must be told the same release+re-enter
// recovery `ha task progress append` names — not a rerun of the refused
// command shape.
test("a runtime actor with a lapsed lease is told the release and re-enter recovery", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-lapsed-recovery-"));
  initRepo(rootDir);
  const repoId = workspaceId("lapsed-recovery"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "lapsed-recovery-daemon",
    });
  const person = {
      actor: {
        principal: { personId: "person-owner" },
        executor: { kind: "agent", id: "codex" },
      },
      source: "local" as const,
    },
    worker = {
      actor: {
        principal: { personId: "person-owner" },
        executor: { kind: "agent", id: "runtime-session:lapsed-worker" },
      },
      source: "local" as const,
    },
    taskId = "task_REENTER00000000000000AAAAA";
  try {
    const created = (await cell.run(
        { kind: "task-create", taskId, title: "lapsed lease recovery receipt" },
        person,
      )) as { packagePath?: string },
      report = `${created.packagePath}/artifacts/reports/r.md`;
    write(rootDir, report, "# R\n\nship me\n");
    assert.ok(
      ["applied", "pending"].includes(
        String(
          (
            (await cell.run(
              {
                kind: "task-start",
                taskId,
                executionId: "exec-lapsed",
                ttlMs: 1,
              },
              worker,
            )) as { outcome?: string }
          ).outcome,
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rejected = (await cell.run({ kind: "doc-submit", paths: [report] }, worker)) as {
      outcome?: string;
      code?: string;
      nextAction?: string;
      detail?: { nextAction?: string };
    };
    assert.equal(rejected.outcome, "op_rejected");
    assert.equal(rejected.code, "lease_conflict");
    const recipe = new RegExp(
      `the lease for execution exec-lapsed lapsed at [^;]+; run ha task release ${taskId}, then re-enter the round with ha task start ${taskId} --execution-id exec-lapsed`,
      "u",
    );
    assert.match(rejected.nextAction ?? "", recipe);
    assert.match(rejected.detail?.nextAction ?? "", recipe);
    // The named recovery is real: same-execution re-entry restores a held lease this principal holds.
    const released = (await cell.run({ kind: "task-release", taskId }, worker)) as { outcome?: string },
      reentered = (await cell.run({ kind: "task-start", taskId, executionId: "exec-lapsed" }, worker)) as {
        outcome?: string;
      };
    assert.ok(["applied", "pending"].includes(String(released.outcome)), JSON.stringify(released));
    assert.ok(["applied", "pending"].includes(String(reentered.outcome)), JSON.stringify(reentered));
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// …and the named recovery terminates for a session that is actually bound:
// flipping the same lease back to held (what release+start does) makes the
// identical submit apply.
test("the named release-and-re-enter recovery terminates for a bound runtime session", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-recovery-terminates-"));
  initRepo(rootDir);
  const runtimeActor = {
      principal: { personId: "person-owner" },
      executor: { kind: "agent", id: "runtime-session:recovery" },
    } as const,
    source = "local" as const,
    now = "2026-08-23T00:00:00.000Z",
    logical = "tasks/task-recover-x/artifacts/r.md";
  try {
    write(rootDir, logical, "# Recoverable\n");
    let phase: "held" | "orphaned" = "orphaned";
    const lease = {
      schema: "lease/v1",
      taskId: "task-recover",
      executionId: "exec-recover",
      actor: {
        principal: { personId: "person-owner" },
        executor: { kind: "agent", id: "codex" },
      },
      source,
      get phase() {
        return phase;
      },
      expiresAt: "2026-08-23T00:30:00.000Z",
      ttlMs: 1_800_000,
      version: 1,
    } as const;
    const documents = new Map<string, { readonly path: string; readonly blobSha256: string }>();
    let watermark = 0;
    const projection = {
        taskIdForDocumentPath: (target: string) => (target.startsWith("tasks/task-recover-x/") ? "task-recover" : null),
        currentLease: (taskId: string) => (taskId === "task-recover" ? lease : null),
        currentLeaseForExecution: (executionId: string) => (executionId === "exec-recover" ? lease : null),
        readRuntimeSession: () => ({
          runtimeSessionId: "recovery",
          liveness: "live",
          taskBindings: [{ taskId: "task-recover", executionId: "exec-recover" }],
        }),
        readDocument: (target: string) => ({
          status: "ready",
          watermark,
          sourceRevision: watermark,
          document: documents.get(target) ?? null,
        }),
        apply: (event: {
          readonly workspaceRevision: number;
          readonly payload: {
            readonly changes: readonly {
              readonly path: string;
              readonly candidate: { readonly sha256: string } | null;
            }[];
          };
        }) => {
          watermark = event.workspaceRevision;
          for (const change of event.payload.changes)
            if (change.candidate)
              documents.set(change.path, {
                path: change.path,
                blobSha256: change.candidate.sha256,
              });
        },
        read: (taskId: string) => ({
          snapshot: {
            task: {
              taskId,
              title: "recovery terminates",
              status: "active",
              currentNode: "implementation",
              iteration: 0,
            },
            executions: [
              {
                schema: "execution/v1",
                executionId: "exec-recover",
                taskId,
                nodeId: "implementation",
                iteration: 0,
                state: "active",
                actor: {
                  principal: { personId: "person-owner" },
                  executor: null,
                },
                claimedAt: now,
                submittedAt: null,
                closedAt: null,
                submission: null,
              },
            ],
            lease: null,
          },
          watermark: 0,
          sourceRevision: 0,
        }),
      } as unknown as TaskProjection,
      store = makeTaskEventStore({ repoId: "recovery-terminates", rootDir });
    const rejected = (await runDocAction({
      action: { kind: "doc-submit", paths: [logical] },
      binding: { actor: runtimeActor, source },
      workspaceId: workspaceId("recovery-terminates"),
      rootDir,
      store,
      projection,
      now: () => now,
    })) as { outcome?: string; code?: string; nextAction?: string };
    assert.equal(rejected.outcome, "op_rejected");
    assert.equal(rejected.code, "lease_conflict");
    assert.match(
      rejected.nextAction ?? "",
      new RegExp(
        `run ha task release task-recover, then re-enter the round with ha task start task-recover --execution-id exec-recover`,
        "u",
      ),
    );
    phase = "held";
    const recovered = (await runDocAction({
      action: { kind: "doc-submit", paths: [logical] },
      binding: { actor: runtimeActor, source },
      workspaceId: workspaceId("recovery-terminates"),
      rootDir,
      store,
      projection,
      now: () => now,
    })) as { outcome?: string; opId?: string };
    assert.equal(recovered.outcome, "applied", JSON.stringify(recovered));
    assert.equal(
      makeTaskEventStore({ repoId: "recovery-terminates", rootDir }).readEvent(String(recovered.opId))?.schema,
      "doc-event/v1",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
