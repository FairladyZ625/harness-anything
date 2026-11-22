import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import type { AgentRuntimeEventV1 } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import type { RuntimeInstallationWitness } from "../src/daemon-host/agent-runtime-instances.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { waitForDurableCondition } from "../../../tools/fixtures/event-arrival.ts";

export const repoId = "lease-repo";
export const secondRepoId = "second-repo";

export function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

export function createObservableCodexProviderScript(
  dir: string,
  name: string,
  tracePath: string,
  threadId: string,
  options?: {
    readonly credentialDumpPath?: string;
    readonly resumeStartedFile?: string;
    readonly resumeGateFile?: string;
  },
): string {
  const scriptPath = path.join(dir, `${name}.mjs`);
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      'if (process.argv.includes("login") || process.argv.includes("doctor") || process.argv.includes("--version")) {',
      '  process.stdout.write("Logged in\\n");',
      "  process.exit(0);",
      "}",
      'if (process.argv.includes("--skip-git-repo-check")) {',
      '  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");',
      "  process.exit(0);",
      "}",
      `const tracePath = ${JSON.stringify(tracePath)};`,
      `const threadId = ${JSON.stringify(threadId)};`,
      `const credentialDumpPath = ${JSON.stringify(options?.credentialDumpPath ?? null)};`,
      `const resumeStartedFile = ${JSON.stringify(options?.resumeStartedFile ?? null)};`,
      `const resumeGateFile = ${JSON.stringify(options?.resumeGateFile ?? null)};`,
      "if (credentialDumpPath && process.env.HARNESS_EXECUTION_CREDENTIAL) {",
      "  fs.writeFileSync(credentialDumpPath, process.env.HARNESS_EXECUTION_CREDENTIAL);",
      "}",
      'let prompt = "";',
      "for await (const chunk of process.stdin) prompt += chunk;",
      'const isResume = process.argv.includes("resume");',
      'fs.appendFileSync(tracePath, JSON.stringify({ isResume, args: process.argv.slice(2), prompt }) + "\\n");',
      'if (isResume && prompt.includes("[REJECT_STEER]")) {',
      '  process.stderr.write("provider rejected steered prompt\\n");',
      "  process.exit(1);",
      "}",
      'const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
      'if (isResume && prompt.includes("[REJECT_AFTER_THREAD_STARTED]")) {',
      '  emit({ type: "thread.started", thread_id: threadId });',
      '  emit({ type: "turn.failed", error: { message: "turn rejected after thread start" } });',
      "  process.exit(1);",
      "}",
      "if (isResume && resumeStartedFile) {",
      '  fs.writeFileSync(resumeStartedFile, "resumed");',
      "}",
      "if (isResume && resumeGateFile) {",
      "  while (!fs.existsSync(resumeGateFile)) await new Promise((resolve) => setTimeout(resolve, 25));",
      "}",
      'emit({ type: "thread.started", thread_id: threadId });',
      'if (isResume) emit({ type: "turn.started" });',
      'if (prompt.includes("[HOLD_TOOL]")) {',
      '  emit({ type: "item.started", item: { id: "tool-hold", type: "command_execution" } });',
      "}",
      'process.on("SIGINT", () => process.exit(0));',
      'process.on("SIGTERM", () => process.exit(0));',
      "setInterval(() => undefined, 1000);",
    ].join("\n") + "\n",
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

export function readProviderTrace(tracePath: string): Array<{
  readonly isResume: boolean;
  readonly args: readonly string[];
  readonly prompt: string;
}> {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { isResume: boolean; args: string[]; prompt: string });
}

export async function setupEdgeNode(
  t: TestContext,
  f: Awaited<ReturnType<typeof fleetNodeClaimFixture>>,
  originRemote: string,
  branch: string,
  nodeId: string,
  name: string,
  codexExecutablePath: string,
) {
  const codexInstallation: RuntimeInstallationWitness = {
    installationId: `${nodeId}-codex-install`,
    kindId: "codex",
    executablePath: codexExecutablePath,
    version: "1.0.0",
    observedAt: "2026-11-21T00:00:00.000Z",
  };
  const zcodeInstallation: RuntimeInstallationWitness = {
    installationId: `${nodeId}-zcode-install`,
    kindId: "zcode",
    executablePath: codexExecutablePath,
    version: "1.0.0",
    observedAt: "2026-11-21T00:00:00.000Z",
  };
  const edge = await fleetEdgeHostFixture(t, f, {
    name,
    nodeId,
    personId: "person-one",
    runtimeDiscover: () => [codexInstallation, zcodeInstallation],
    beforeOpen: (root) => {
      git(root, "remote", "add", "origin", originRemote);
      git(root, "fetch", "-q", "origin");
      git(root, "branch", "--set-upstream-to", `origin/${branch}`);
      git(root, "reset", "--hard", `origin/${branch}`);
    },
  });
  const localAuth = localAuthFixture();
  for (const instance of [
    {
      instanceId: `${nodeId}-codex`,
      name: `${nodeId} Codex`,
      kindId: "codex",
      installationId: codexInstallation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      authMode: "subscription",
      enabled: true,
    },
    {
      instanceId: `${nodeId}-zcode`,
      name: `${nodeId} ZCode`,
      kindId: "zcode",
      installationId: zcodeInstallation.installationId,
      providerId: "zai",
      models: ["glm-5"],
      defaultModel: "glm-5",
      authMode: "subscription",
      enabled: true,
    },
  ]) {
    const created = await edge.host.runtimeInstance("daemon.runtimeInstance.create", instance, localAuth, repoId);
    assert.equal(created.ok, true, JSON.stringify(created));
  }
  await catchUpReplica({
    ...f.peer(nodeId),
    ca: readFileSync(path.join(f.root, "tls.crt")),
    viewRoot: edge.viewRoot,
    diskQuotaBytes: 64 * 1024 * 1024,
  });
  return { edge };
}

export function readRuntimeControlEvents(repoRoot: string, targetRepoId: string, runtimeSessionId?: string) {
  return makeTaskEventReader({ repoId: targetRepoId, rootDir: repoRoot })
    .read()
    .events.filter(
      (event): event is AgentRuntimeEventV1 =>
        event.schema === "agent-runtime-event/v1" &&
        (event.type === "runtime_cancel_requested" ||
          event.type === "runtime_steer_requested" ||
          (event.type === "runtime_session_liveness_changed" && event.payload.controlRequest !== undefined)) &&
        (runtimeSessionId === undefined || event.payload.runtimeSessionId === runtimeSessionId),
    );
}

export async function waitForProviderBound(
  host: Awaited<ReturnType<typeof fleetNodeClaimFixture>>["host"],
  runtimeSessionId: string,
  auth: ReturnType<typeof localAuthFixture>,
): Promise<void> {
  await waitForDurableCondition(async () => {
    const read = await host.read(repoId, "repo.agentRuntime.sessions.read", { runtimeSessionId }, auth);
    return Boolean(read.session?.providerSessionId);
  });
}

const allowedEdgeInstanceIds = ["node-one-codex", "node-one-zcode", "node-two-codex", "node-two-zcode"] as const;

export async function allowEdgeRuntimeInstances(
  host: Awaited<ReturnType<typeof fleetNodeClaimFixture>>["host"],
): Promise<void> {
  const receipt = await host.run(
    repoId,
    { kind: "settings-update", runtimeAllowedInstances: [...allowedEdgeInstanceIds] },
    localAuthFixture(),
  );
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
}
