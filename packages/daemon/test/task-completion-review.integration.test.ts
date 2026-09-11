// harness-test-tier: integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, type AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { readDispatchStream, readDispatchStreamHeaders } from "../src/dispatch-stream.ts";
import { binding as transportBinding } from "../src/daemon-host-binding.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetCenterOptions } from "../src/fleet/center.ts";
import { runFleetTaskCommandClient } from "../src/fleet/edge.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import type { RuntimeProcess } from "../src/runtime-spawn-types.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const owner = withRoleBinding(
  {
    actor: { principal: { personId: "completion-owner" }, executor: { kind: "agent" as const, id: "implementer" } },
    source: "local" as const,
  },
  "repo-write",
);
const taskId = "task-completion-review",
  executionId = "execution-completion-review";
const installation = {
  installationId: "installation-review",
  kindId: "codex" as const,
  executablePath: "/fixture/reviewer",
  version: "1.0.0",
  observedAt: "2026-09-12T00:00:00.000Z",
};
function instance(instanceId: string): RuntimeInstanceSummary {
  return {
    schemaVersion: 2,
    instanceId,
    name: instanceId,
    kindId: "codex",
    installationId: installation.installationId,
    providerId: "openai",
    models: ["review-model"],
    defaultModel: "review-model",
    enabled: true,
    permissionMode: "read-only",
    codex: {
      reasoningEffort: null,
      fast: false,
      baseUrl: null,
      baseUrlConfigured: false,
      wire_api: null,
      requires_openai_auth: null,
      http_headers: null,
    },
    authMode: "subscription",
    authState: "configured",
    authReadiness: { status: "ready", code: null, hint: null },
    isolationState: "enforced",
  };
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function fixture(failProvider = false, available = true) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-review-")),
    repoId = workspaceId("completion-review");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Completion Review Test");
  git(root, "config", "user.email", "review@example.invalid");
  writeFileSync(path.join(root, "README.md"), "# Reviewed delivery\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "docs: fixture delivery");
  const launches: { prompt: string; instanceId: string }[] = [];
  const open = () =>
    openRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: "completion-review",
      runtimeDaemonRoute: {
        userRoot: path.join(root, "user"),
        daemonId: "fixture",
        endpoint: path.join(root, "user.sock"),
      },
      runtimeInstances: () => [
        { ...instance("ambient-first"), models: ["flash-model"], defaultModel: "flash-model" },
        ...(available ? [instance("review-first"), instance("review-second")] : []),
      ],
      prepareRuntimeLaunch: (instanceId, request) => ({
        definition: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId,
          installationId: installation.installationId,
          kindId: "codex",
          providerId: "openai",
          model: "review-model",
          reasoningEffort: null,
          fast: false,
          baseUrl: null,
          authMode: "subscription",
        } satisfies AgentDefinitionSnapshot,
        installation,
        executablePath: installation.executablePath,
        args: ["exec", "--json", "-"],
        env: {},
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: (prepared): RuntimeProcess => {
        launches.push({ prompt: prepared.prompt, instanceId: prepared.definition.instanceId });
        let output: ((chunk: string) => void) | undefined;
        return {
          pid: 987650 + launches.length,
          onOutput: (listener) => {
            output = listener;
          },
          onErrorOutput: () => undefined,
          terminate: () => undefined,
          onExit: (listener) => {
            if (failProvider)
              setImmediate(() => {
                output?.(
                  JSON.stringify({
                    type: "turn.failed",
                    error: { http_status: 429, code: "rate_limit", message: "HTTP 429 fixture capacity exhausted" },
                  }) + "\n",
                );
                listener(1);
              });
          },
        };
      },
    });
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n" +
      "settings:\n  defaultVertical: software/coding\n  defaultPreset: standard-task\n  defaultProfile: baseline\n",
  );
  let cell = await open();
  const run = (action: Parameters<typeof cell.run>[0]) => cell.run(action, owner);
  const created = await run({ kind: "task-create", taskId, title: "Completion Review", presetId: "docs-task" });
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFixturePublication(cell, created.opId, owner);
  const packagePath = String((created as Record<string, unknown>).packagePath);
  await realizeTaskPlanFixture(root, packagePath, (planPath) => run({ kind: "doc-submit", paths: [planPath] }));
  assert.equal((await run({ kind: "task-start", taskId, executionId })).outcome, "applied");
  assert.equal(
    (
      await run({
        kind: "fact-record",
        taskId,
        statement: "README contains the reviewed delivery.",
        evidenceSource: "README.md",
        confidence: "high",
        memoryClass: "episodic",
        memoryTags: [],
      })
    ).outcome,
    "applied",
  );
  writeFileSync(
    path.join(root, "harness", packagePath, "closeout.md"),
    "# Closeout\n\n## Summary\n\nReviewed delivery.\n\n## Verification\n\nREADME bytes checked.\n\n" +
      "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nReview dispatch retry.\n",
  );
  assert.equal((await run({ kind: "task-submit", taskId, executionId })).outcome, "applied");
  const events = () => makeTaskEventReader({ repoId, rootDir: root }).read().events;
  return {
    root,
    packagePath,
    launches,
    run,
    events,
    cell: () => cell,
    complete: (consent = false) => run({ kind: "task-complete", taskId, executionId, ...(consent ? { consent } : {}) }),
    install: async () => {
      const installed = await run({
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "closeout-reviewer",
          name: "Independent reviewer",
          instructions: "Inspect submitted bytes and record your independent verdict.",
          runtime_type: "codex",
          role: "worker",
          model: "review-model",
          fallback: { providerPriority: ["review-first", "review-second"], backoff: { baseMs: 1, maxMs: 2 } },
        },
      });
      assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    },
    reopen: async () => {
      await cell.close();
      cell = await open();
    },
    review: async (runtimeSessionId: string, reviewId: string) => {
      // Controlled reviewer inspects the actual submitted file before entering the real RecordReview path.
      const submitted = events()
        .filter((event) => event.type === "execution_submitted")
        .at(-1);
      assert.ok(submitted?.type === "execution_submitted" && submitted.payload.execution.submission);
      const reviewedCommit = submitted.payload.execution.submission.commitSha;
      assert.equal(git(root, "show", `${reviewedCommit}:README.md`), "# Reviewed delivery");
      assert.match(
        readFileSync(path.join(root, "harness", packagePath, "closeout.md"), "utf8"),
        /README bytes checked/u,
      );
      const packet = `${packagePath}/artifacts/reports/${reviewId}.json`;
      mkdirSync(path.dirname(path.join(root, "harness", packet)), { recursive: true });
      writeFileSync(
        path.join(root, "harness", packet),
        JSON.stringify({
          verdict: "approved",
          reason: "Independently inspected committed README and submitted closeout.",
          evidenceChecked: [`${reviewedCommit}:README.md`, "closeout.md"],
        }),
      );
      return cell.run(
        { kind: "task-review-execution", taskId, executionId, reviewId, fromFile: `harness/${packet}` },
        {
          actor: {
            principal: owner.actor.principal,
            executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
          },
          source: "local",
        },
      );
    },
    close: async () => {
      await cell.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test(
  "completion selects install guidance, reuses the cut dispatch after a lost response/reopen, and requires later owner consent",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    try {
      const missing = await f.complete(true);
      assert.equal(missing.code, "review_missing", JSON.stringify(missing));
      assert.match(JSON.stringify((missing as Record<string, unknown>).next), /ha agent install --source/u);
      assert.equal(f.launches.length, 0);
      await f.install();
      const configured = await f.run({ kind: "settings-update", defaultReviewer: "selected-reviewer" });
      assert.equal(configured.outcome, "applied", JSON.stringify(configured));
      const selectedMissing = await f.complete();
      assert.equal(selectedMissing.code, "review_missing", JSON.stringify(selectedMissing));
      assert.match(JSON.stringify((selectedMissing as Record<string, unknown>).next), /selected-reviewer/u);
      assert.match(JSON.stringify((selectedMissing as Record<string, unknown>).next), /--default-reviewer/u);
      assert.equal(f.launches.length, 0);
      const restored = await f.run({ kind: "settings-update", defaultReviewer: "closeout-reviewer" });
      assert.equal(restored.outcome, "applied", JSON.stringify(restored));
      const first = (await f.complete(true)) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      assert.equal(f.launches.length, 1);
      assert.equal(f.launches[0]!.instanceId, "review-first");
      assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 0);
      assert.match(f.launches[0]!.prompt, /RecordReview/u);
      assert.match(f.launches[0]!.prompt, new RegExp(`artifacts/reports/${String(first.dispatchId)}`));
      // Provider has not exited: this independent queue write must nevertheless finish.
      const write = await f.run({
        kind: "fact-record",
        taskId,
        statement: "Queue accepts writes while reviewer runs.",
        evidenceSource: "test:pending-reviewer",
        confidence: "high",
        memoryClass: "episodic",
        memoryTags: [],
      });
      assert.equal(write.outcome, "applied", JSON.stringify(write));
      const retry = (await f.complete()) as Record<string, unknown>;
      assert.equal(retry.dispatchId, first.dispatchId);
      assert.equal(f.launches.length, 1);
      await f.reopen();
      const recovered = (await f.complete()) as Record<string, unknown>;
      assert.equal(recovered.dispatchId, first.dispatchId);
      assert.equal(recovered.runtimeSessionId, first.runtimeSessionId);
      assert.equal(f.launches.length, 1);
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 1);
      const reviewed = await f.review(String(first.runtimeSessionId), "review-current");
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const additional = await f.review(String(first.runtimeSessionId), "review-additional");
      assert.equal(additional.outcome, "applied", JSON.stringify(additional));
      const noConsent = await f.complete();
      assert.equal(noConsent.code, "consent_missing", JSON.stringify(noConsent));
      assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 0);
      const completed = await f.complete(true);
      assert.equal(completed.outcome, "applied", JSON.stringify(completed));
      assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 1);
      const consent = f.events().find((event) => event.type === "review_consent_recorded");
      assert.ok(consent?.type === "review_consent_recorded");
      assert.equal(consent.payload.consent.reviewId, "review-additional");
      assert.equal(f.events().filter((event) => event.type === "task_completed").length, 1);
    } finally {
      await f.close();
    }
  },
);

test("completion requires a declared reviewer model instead of selecting the ambient default", async () => {
  const f = await fixture();
  try {
    // Omit model entirely, as in an unconstrained runtime_type=any declaration.
    const installed = await f.run({
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: "closeout-reviewer",
        name: "Unconstrained reviewer",
        instructions: "Review the submitted delivery.",
        runtime_type: "any",
      },
    });
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    const result = await f.complete();
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    assert.match(JSON.stringify((result as Record<string, unknown>).next), /model/u);
    assert.equal(f.launches.length, 0, "an unconfigured reviewer must not launch the ambient model");
  } finally {
    await f.close();
  }
});

test(
  "completion provider fallback keeps reviewer role and exhausts once without launching another root dispatch",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(true);
    try {
      await f.install();
      const first = (await f.complete()) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      const exhausted = () =>
        readDispatchStreamHeaders(f.root).some(
          (header) => readDispatchStream(f.root, header.dispatchId)?.fallbackState === "exhausted",
        );
      for (let attempt = 0; attempt < 500 && !exhausted(); attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(exhausted(), true, "fallback must durably settle exhaustion");
      assert.equal(f.launches.length, 2);
      for (let retry = 0; retry < 3; retry += 1)
        assert.equal(((await f.complete()) as Record<string, unknown>).dispatchId, first.dispatchId);
      const dispatches = f.events().filter((event) => event.type === "runtime_dispatch_requested");
      assert.equal(dispatches.length, 2);
      assert.deepEqual(
        readDispatchStreamHeaders(f.root).map((header) => header.role),
        ["reviewer", "reviewer"],
      );
      assert.equal(dispatches.filter((event) => !event.payload.idempotencyKey.includes(":fallback:")).length, 1);
      assert.equal(f.launches.length, 2);
      assert.equal(f.events().filter((event) => event.type === "review_recorded").length, 0);
      assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "two fleet TLS assignments completing one cut receive the same canonical reviewer dispatch",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    let center: Awaited<ReturnType<typeof listenFleetTls>> | undefined;
    try {
      await f.install();
      const keyFile = path.join(f.root, "tls.key"),
        certFile = path.join(f.root, "tls.crt");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyFile,
          "-out",
          certFile,
          "-subj",
          "/CN=localhost",
          "-days",
          "1",
          "-addext",
          "subjectAltName=DNS:localhost",
        ],
        { stdio: "ignore" },
      );
      const cert = readFileSync(certFile),
        writerEpochStateRoot = path.join(f.root, ".harness", "fixture-writer-epochs"),
        authority = openPersistentWriterEpoch({ stateRoot: writerEpochStateRoot });
      const lease = authority.current("completion-review");
      authority.close();
      assert.ok(lease);
      const assignments: FleetAssignmentRecord[] = ["edge-one", "edge-two"].map((nodeId) => ({
        nodeId,
        assignmentId: `assignment-${nodeId}`,
        repoId: "completion-review",
        viewId: `view-${nodeId}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
        actor: owner.actor,
        scope: { kind: "task", taskId, executionId, paths: [f.packagePath] },
      }));
      const host: FleetCenterOptions["host"] = {
        run: async (repoId, action, auth) => {
          assert.equal(repoId, "completion-review");
          return f.cell().run(action, await transportBinding(f.root, auth));
        },
        read: async () => {
          throw new Error("Unexpected read route");
        },
        runtimeIngress: async () => {
          throw new Error("Unexpected runtime ingress route");
        },
        replica: () => f.cell().replica,
        settleMaterialization: async (_repoId, context) => f.cell().settlePendingMaterialization(context),
        status: () => ({ repos: [f.cell().status()] }) as ReturnType<FleetCenterOptions["host"]["status"]>,
      };
      center = await listenFleetTls({
        host,
        stateRoot: path.join(f.root, "fleet-center"),
        writerEpochStateRoot,
        writerEpochLease: () => lease,
        key: readFileSync(keyFile),
        cert,
        authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
        resolveAssignment: (id) => assignments.find((assignment) => assignment.assignmentId === id) ?? null,
      });
      const results = await Promise.all(
        assignments.map((assignment) =>
          runFleetTaskCommandClient({
            port: center!.port,
            ca: cert,
            servername: "localhost",
            nodeId: assignment.nodeId,
            credential: `secret-${assignment.nodeId}`,
            assignmentId: assignment.assignmentId,
            opId: randomUUID(),
            repoId: assignment.repoId,
            taskId,
            action: { kind: "task-complete", taskId, executionId },
            waitMs: 5_000,
          }),
        ),
      );
      for (const result of results) assert.equal(result.code, "review_missing", JSON.stringify(result));
      assert.equal(results[0]!.receipt?.dispatchId, results[1]!.receipt?.dispatchId);
      assert.equal(typeof results[0]!.receipt?.dispatchId, "string");
      assert.equal(f.launches.length, 1);
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 1);
    } finally {
      await center?.close();
      await f.close();
    }
  },
);

test(
  "an amended submitted cut rejects the old canonical reviewer and dispatches a fresh reviewer",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    try {
      await f.install();
      const first = (await f.complete()) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      const closeoutPath = path.join(f.root, "harness", f.packagePath, "closeout.md");
      writeFileSync(
        closeoutPath,
        readFileSync(closeoutPath, "utf8").replace("Reviewed delivery.", "Amended reviewed delivery."),
      );
      let amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      for (let attempt = 0; amended.outcome === "pending" && attempt < 4; attempt += 1) {
        await waitForFixturePublication(f.cell(), amended.opId, owner);
        amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      }
      assert.equal(amended.outcome, "applied", JSON.stringify(amended));
      const stale = await f.review(String(first.runtimeSessionId), "review-stale");
      assert.equal(stale.code, "invalid_proof", JSON.stringify(stale));
      assert.match(stale.rejectionExplanation ?? "", /earlier submission cut/u);
      const second = (await f.complete()) as Record<string, unknown>;
      assert.equal(second.code, "review_missing", JSON.stringify(second));
      assert.notEqual(second.dispatchId, first.dispatchId);
      assert.equal(f.launches.length, 2);
      assert.equal(f.events().filter((event) => event.type === "review_recorded").length, 0);
    } finally {
      await f.close();
    }
  },
);
test("completion with an unavailable declared model returns guidance without launching an ambient instance", async () => {
  const f = await fixture(false, false);
  try {
    await f.install();
    const result = await f.complete();
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    assert.match(JSON.stringify((result as Record<string, unknown>).next), /ready compatible instance/u);
    assert.deepEqual(result.diagnostic, { kind: "failure", code: "agent_model_unavailable" });
    assert.match(result.rejectionExplanation ?? "", /No enabled runtime instance declares model review-model/u);
    assert.equal(f.launches.length, 0);
    assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 0);
  } finally {
    await f.close();
  }
});
