import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import type { FleetAssignmentRecord } from "../src/fleet/center.ts";

export const definition: AgentDefinitionSnapshot = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "codex-schedule",
  installationId: "installation-schedule",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  fast: true,
  baseUrl: null,
  authMode: "subscription",
};

export function scheduleRuntimePorts() {
  return {
    runtimeInstances: () => [
      {
        schemaVersion: 2 as const,
        instanceId: definition.instanceId,
        name: "Schedule Codex",
        kindId: definition.kindId,
        installationId: definition.installationId,
        providerId: definition.providerId,
        models: [definition.model],
        defaultModel: definition.model,
        enabled: true,
        permissionMode: "workspace-write" as const,
        codex: {},
        authMode: definition.authMode,
        authState: "configured" as const,
        authReadiness: { status: "ready" as const, code: null, hint: null },
        isolationState: "enforced" as const,
      },
    ],
    prepareRuntimeLaunch: async (_instanceId: string, request: { cwd: string; prompt: string }) => ({
      definition,
      installation: {
        installationId: definition.installationId,
        kindId: definition.kindId,
        executablePath: "/opt/test/codex",
        version: "1.0.0",
        observedAt: "2026-08-26T00:00:00.000Z",
      },
      executablePath: "/opt/test/codex",
      args: [],
      env: {},
      cwd: request.cwd,
      prompt: request.prompt,
    }),
    prepareWorkerGitEnvironment: async () => null,
  };
}

export async function pullScheduleView(
  edge: { assignment: FleetAssignmentRecord; workspaceRoot: string; viewRoot: string },
  port: number,
  ca: Buffer,
): Promise<void> {
  const pulled = await runFleetReplicaPullClient({
    port,
    ca,
    servername: "localhost",
    nodeId: edge.assignment.nodeId,
    credential: `credential-${edge.assignment.nodeId}`,
    assignmentId: edge.assignment.assignmentId,
    viewRoot: edge.viewRoot,
    diskQuotaBytes: 64 * 1024 * 1024,
  });
  assert.equal(
    applyFleetMirrorCut(edge.viewRoot, edge.assignment.repoId, edge.workspaceRoot, "pull", {
      viewId: pulled.replica.viewId,
    }).outcome,
    "applied",
  );
}

export function initHarnessRepo(root: string, name: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Schedule Test");
  git(root, "config", "user.email", "schedule@example.invalid");
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${name}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  git(root, "add", "harness");
  git(root, "commit", "-qm", "base");
}

export async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
