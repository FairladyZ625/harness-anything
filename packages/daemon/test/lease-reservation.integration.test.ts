// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeTaskEventStore, type AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";

const definition: AgentDefinitionSnapshot = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "codex-lease-worker",
  installationId: "installation-codex-lease-worker",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  baseUrl: "https://api.example.test/",
  authMode: "subscription",
};
test("task-bound spawn exit keeps its released execution visible after a v12 cache restart", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-lease-reservation-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "lease-reservation",
    taskId = "task-lease-reservation",
    executionId = "exec-lease-reservation",
    uid = process.getuid?.() ?? 0,
    installation: RuntimeInstallationWitness = {
      installationId: definition.installationId,
      kindId: definition.kindId,
      executablePath: writeProviderExecutable(path.join(parent, "codex-stub.mjs"), "process.exit(0);\n"),
      version: "1.0.0",
      observedAt: "2026-08-25T00:00:00.000Z",
    },
    auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const;
  initRepo(root, uid);
  registerDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });

  const open = async (daemonId: string) => {
    const host = await openDaemonHost({
      daemonId,
      userRoot,
      runtimeDiscover: () => [installation],
      runtimeLaunch: () => ({
        pid: 9538,
        onOutput: (listener) => {
          queueMicrotask(() =>
            listener(
              [
                { type: "thread.started", thread_id: "provider-lease-reservation" },
                { type: "item.completed", item: { id: "done", type: "agent_message", text: "done" } },
                { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
              ]
                .map((event) => JSON.stringify(event))
                .join("\n") + "\n",
            ),
          );
        },
        onErrorOutput: () => undefined,
        onExit: (listener) => {
          queueMicrotask(() => listener(0));
        },
        terminate: () => undefined,
      }),
    });
    await host.attachmentsSettled();
    return host;
  };

  let host = await open("lease-reservation-before");
  try {
    await host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: definition.instanceId,
        name: "Codex Lease Worker",
        kindId: definition.kindId,
        installationId: definition.installationId,
        providerId: definition.providerId,
        models: [definition.model],
        codex: { reasoningEffort: definition.reasoningEffort },
        authMode: definition.authMode,
      },
      auth,
    );
    assert.equal(
      (await host.run(repoId, { kind: "task-create", taskId, title: "Lease reservation" }, auth)).outcome,
      "applied",
    );
    assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId }, auth)).outcome, "applied");
    const spawned = await host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Finish the task-bound runtime session.",
        taskId,
        idempotencyKey: "lease-reservation-spawn",
      },
      auth,
    );
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    await eventually(() =>
      makeTaskEventStore({ repoId, rootDir: root })
        .read()
        .events.some(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.runtimeSessionId === spawned.runtimeSessionId,
        ),
    );
  } finally {
    await host.close();
  }

  const cache = path.join(root, ".harness/cache/task.sqlite"),
    stale = new DatabaseSync(cache);
  stale.exec("UPDATE projection_meta SET schema_version = 12 WHERE singleton = 1");
  stale.prepare("DELETE FROM entity_projection WHERE entity_kind = 'execution' AND task_id = ?").run(taskId);
  stale.close();

  host = await open("lease-reservation-after");
  try {
    const released = await host.run(repoId, { kind: "task-release", taskId }, auth);
    assert.equal(released.outcome, "op_rejected", JSON.stringify(released));
    assert.equal(released.code, "lease_not_found", JSON.stringify(released));
    const events = makeTaskEventStore({ repoId, rootDir: root }).read().events,
      sequence = events.map((event) => event.type),
      started = sequence.indexOf("execution_started"),
      bound = sequence.indexOf("runtime_session_task_bound"),
      release = sequence.indexOf("lease_released"),
      outcome = sequence.indexOf("runtime_session_outcome_observed");
    assert.ok(started >= 0 && started < bound, sequence.join(" -> "));
    assert.ok(bound < release && release < outcome, sequence.join(" -> "));

    const rebuilt = new DatabaseSync(cache, { readOnly: true }),
      version = rebuilt.prepare("SELECT schema_version FROM projection_meta WHERE singleton = 1").get() as {
        readonly schema_version: number;
      },
      execution = rebuilt
        .prepare("SELECT entity_id FROM entity_projection WHERE entity_kind = 'execution' AND task_id = ?")
        .get(taskId) as { readonly entity_id: string } | undefined;
    rebuilt.close();
    assert.equal(version.schema_version, 14); // taskProjectionSchemaVersion in kernel projection-schema.ts
    assert.equal(execution?.entity_id, executionId);
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

function initRepo(root: string, uid: number): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Lease Test");
  git(root, "config", "user.email", "lease@example.invalid");
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: lease-reservation\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `${JSON.stringify(
      {
        schema: "harness-people/v1",
        people: [
          {
            personId: "owner",
            displayName: "Owner",
            roles: ["owner"],
            credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }],
          },
        ],
        roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write"] }],
      },
      null,
      2,
    )}\n`,
  );
  git(root, "add", "harness");
  git(root, "commit", "-qm", "fixture");
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("runtime session did not settle");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args]);
}
