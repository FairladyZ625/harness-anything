import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProjectionSourceFence } from "@harness-anything/kernel";

export async function spawnJournalOnlyDaemon(rootDir: string): Promise<void> {
  const childScript = `
    import { Effect } from "effect";
    import { makeJournaledWriteCoordinator, createHarnessRuntimeContext, resolveHarnessLayout, taskEntityId } from "./packages/kernel/src/index.ts";
    import { acquireDaemonGlobalLock } from "./packages/kernel/src/write-coordination/journal/locks.ts";
    const rootDir = ${JSON.stringify(rootDir)};
    const runtimeContext = createHarnessRuntimeContext(rootDir);
    const layout = resolveHarnessLayout(runtimeContext);
    const lock = acquireDaemonGlobalLock(rootDir, runtimeContext, layout.journalPath, { scope: "operational", kind: "system", id: "daemon-runtime" }, 60_000);
    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      attribution: {
        actor: { principal: { kind: "person", personId: "person_test" }, executor: { kind: "agent", id: "test" } },
        principalSource: { kind: "local-configured", authority: "harness.yaml", authoritySha256: "sha256:test" },
        executorSource: "client-asserted"
      },
      heldGlobalLock: lock,
      autoMaterialize: false
    });
    Effect.runSync(coordinator.enqueue({
      opId: "op-crash-recovery",
      entityId: taskEntityId("task-crash"),
      kind: "doc_write",
      payload: { path: "recovered.md", body: "recovered" }
    }));
    console.log("journaled");
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 5);
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let sawJournaled = false;
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("journaled")) sawJournaled = true;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (_code, signal) => {
      if (signal === "SIGKILL" && sawJournaled) {
        resolve();
        return;
      }
      reject(new Error(`journal child did not die as expected: signal=${signal ?? "none"} stderr=${stderr}`));
    });
  });
}

export function daemonAttribution(personId: string, executorId: string, credentialFingerprint: string) {
  return {
    actor: {
      principal: { kind: "person" as const, personId },
      executor: { kind: "agent" as const, id: executorId }
    },
    principalSource: {
      kind: "daemon-authenticated" as const,
      providerId: "test-provider",
      credentialFingerprint
    },
    executorSource: "client-asserted" as const
  };
}

export function writeExecutionEvidenceFixture(rootDir: string, title: string): void {
  const taskId = "task_01KXDG00000000000000000001";
  const executionId = "exe_01KXDG00000000000000000001";
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: in_review",
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-07-13T00:00:00.000Z",
    `  bindingFingerprint: sha256:${"0".repeat(64)}`,
    "packageDisposition: active",
    "vertical: software/coding",
    "preset: standard-task",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"));
  writeFileSync(path.join(taskRoot, "executions", `${executionId}.md`), `${JSON.stringify({
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: {
      principal: { personId: "person_test" },
      executor: { kind: "agent", id: "codex" },
      responsibleHuman: "person_test"
    },
    claimed_at: "2026-07-13T00:00:00.000Z",
    submitted_at: "2026-07-13T00:01:00.000Z",
    closed_at: null,
    session_bindings: [],
    outputs: [{
      evidence_id: "ev_daemon_generation",
      execution_ref: `execution/${taskId}/${executionId}`,
      locator: { substrate: "inline", text: "Evidence" }
    }],
    submission: null
  }, null, 2)}\n`);
}

export function initAuthoredGit(rootDir: string): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  execFileSync("git", ["-C", harnessRoot, "init", "-b", "master"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Harness Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "harness@example.test"], { stdio: "ignore" });
  writeFileSync(path.join(harnessRoot, ".gitkeep"), "", "utf8");
  execFileSync("git", ["-C", harnessRoot, "add", "--", ".gitkeep"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "seed"], { stdio: "ignore" });
}

export function commitAuthoredFixture(rootDir: string): void {
  git(rootDir, "add", "-A");
  git(rootDir, "commit", "-m", "fixture");
}

export function stableProjectionFence(
  identity: string,
  headOid: string,
  changedPaths: ReadonlyArray<string>
): ProjectionSourceFence {
  return {
    kind: "stable",
    identity: `sha256:${identity}`,
    headOid,
    dirty: changedPaths.length > 0,
    changedPaths
  };
}

export function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

export function readGitFile(rootDir: string, relativePath: string): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), "show", `master:${relativePath}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
