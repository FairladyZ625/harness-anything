import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { type AgentDefinitionSnapshot } from "../../../kernel/src/index.ts";
import { type RuntimeInstallationWitness } from "../../src/agent-runtime-instances.ts";
import { openDaemonHost } from "../../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../../src/protocol/version.ts";
import { writeProviderExecutable } from "./runtime-stub.ts";

export const cli = path.resolve("packages/cli/src/index.ts");
export const definition: AgentDefinitionSnapshot = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "codex-review",
  installationId: "installation-codex",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  fast: false,
  baseUrl: "https://api.example.test/",
  authMode: "api-key",
};
export const installation: RuntimeInstallationWitness = {
  installationId: definition.installationId,
  kindId: definition.kindId,
  executablePath: "/opt/witnessed/codex",
  version: "1.0.0",
  observedAt: "2026-08-14T00:00:00.000Z",
};

export function initIngressRepo(root: string, uid: number): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Spawn Test");
  git(root, "config", "user.email", "spawn@example.invalid");
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: runtime-spawn-ingress\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "owner", displayName: "Owner", roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }] }], roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write"] }] }, null, 2)}\n`,
  );
  git(root, "add", "harness");
  git(root, "commit", "-qm", "fixture");
}
export async function rpc(
  host: Awaited<ReturnType<typeof openDaemonHost>>,
  auth: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2],
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = createJsonRpcProtocolServer({
    host,
    build: { commit: null },
    authContext: auth,
    emit: async () => undefined,
  });
  try {
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion },
    });
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method,
      params,
    });
    assert.ok(response && !Array.isArray(response) && "result" in response);
    return (response as { result: Record<string, unknown> }).result;
  } finally {
    server.close();
  }
}
export async function rpcAttach(
  host: Awaited<ReturnType<typeof openDaemonHost>>,
  auth: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2],
  repoId: string,
  runtimeSessionId: string,
  frames: Record<string, unknown>[],
): Promise<{ readonly close: () => void }> {
  const server = createJsonRpcProtocolServer({
    host,
    build: { commit: null },
    authContext: auth,
    emit: async (_method, params) => {
      frames.push(params);
    },
  });
  await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion },
  });
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "repo.agentRuntime.attach",
    params: {
      repo: { repoId },
      payload: { runtimeSessionId, afterCursor: "stream:0" },
    },
  });
  assert.ok(response && !Array.isArray(response) && "result" in response);
  const result = (
    response as {
      result: { ok: boolean; events?: readonly Record<string, unknown>[] };
    }
  ).result;
  assert.equal(result.ok, true, JSON.stringify(response));
  if (Array.isArray(result.events)) frames.push(...result.events);
  return { close: server.close };
}
export async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  await eventuallyValue(async () => ((await check()) ? true : null));
}
export async function eventuallyValue<T>(read: () => T | null | Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("runtime provider event did not arrive");
}
export function writeProviderStub(
  target: string,
  kindId: "claude" | "codex",
  argsTarget?: string,
  lineDelayMs = 40,
): string {
  const lines =
    kindId === "claude"
      ? [
          {
            type: "system",
            subtype: "init",
            session_id: "claude-provider-session",
          },
          {
            type: "assistant",
            session_id: "claude-provider-session",
            message: {
              content: [
                { type: "text", text: "claude live content" },
                {
                  type: "tool_use",
                  id: "write-1",
                  name: "Write",
                  input: { file_path: "result.txt", content: "written" },
                },
              ],
            },
          },
          {
            type: "user",
            session_id: "claude-provider-session",
            tool_use_result: { type: "create", filePath: "result.txt" },
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "write-1",
                  content: "created",
                },
              ],
            },
          },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "claude-provider-session",
            result: "claude final result",
            permission_denials: [],
          },
        ]
      : [
          { type: "thread.started", thread_id: "codex-provider-session" },
          {
            type: "item.completed",
            item: {
              id: "item-1",
              type: "agent_message",
              text: "codex live content",
              credentialRef: "credential-secret",
              executablePath: "/provider/private",
              apiToken: "sk-provider-secret",
            },
          },
          {
            type: "item.completed",
            item: {
              id: "write-1",
              type: "file_change",
              changes: [{ path: "result.txt", kind: "add" }],
              status: "completed",
            },
          },
          {
            type: "item.completed",
            item: {
              id: "item-2",
              type: "agent_message",
              text: "codex final result",
            },
          },
          {
            type: "turn.completed",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        ];
  const structuredFlag =
    kindId === "claude"
      ? `process.argv.includes("--output-format") && process.argv.includes("stream-json") && process.argv.includes("--verbose")`
      : `process.argv[2] === "exec" && process.argv.includes("--json")`;
  const recordArgs = argsTarget
    ? `fs.writeFileSync(${JSON.stringify(argsTarget)}, JSON.stringify(process.argv.slice(2)));\n`
    : "";
  return writeProviderExecutable(
    target,
    `import fs from "node:fs";\nconst auth = process.argv[2] === "auth" || process.argv[2] === "login";\nif (auth) process.exit(0);\n${recordArgs}if (!(${structuredFlag})) process.exit(9);\nconst prompt = fs.readFileSync(0, "utf8"), secret = "sk-runtime-secret-1234567890";\nif (prompt === "failure:empty") process.exit(1);\nelse if (prompt === "failure:secret") process.stderr.write("OPENAI_API_KEY=" + secret + "\\n", () => process.exit(1));\nelse if (prompt === "failure:structured") process.stdout.write([JSON.stringify({ type: "thread.started", thread_id: "codex-provider-session" }), JSON.stringify({ type: "turn.failed", error: { message: "structured provider failure", apiToken: secret } })].join("\\n") + "\\n", () => process.exit(1));\nelse if (prompt === "permission-denied") process.stdout.write([JSON.stringify({ type: "system", subtype: "init", session_id: "claude-provider-session" }), JSON.stringify({ type: "assistant", session_id: "claude-provider-session", message: { content: [{ type: "tool_use", id: "denied-write", name: "Write", input: { file_path: "/tmp/outside", content: "denied" } }] } }), JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "claude-provider-session", result: "write denied", permission_denials: [{ tool_name: "Write", tool_use_id: "denied-write" }] })].join("\\n") + "\\n");\nelse { let emitted = ${JSON.stringify(lines)}; if (prompt === "read-only") emitted = [{ type: "thread.started", thread_id: "codex-provider-session" }, { type: "item.completed", item: { id: "inspect", type: "command_execution", command: "git status --short", aggregated_output: "", exit_code: 0, status: "completed" } }, { type: "item.completed", item: { id: "message", type: "agent_message", text: "read-only final result" } }, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]; else if (prompt === "no-action") emitted = [{ type: "thread.started", thread_id: "codex-provider-session" }, { type: "item.completed", item: { id: "message", type: "agent_message", text: "no-action final result" } }, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]; else if (prompt === "no-write") emitted.splice(1, 0, { type: "item.completed", item: { id: "inspect", type: "command_execution", command: "git status --short", aggregated_output: "", exit_code: 0, status: "completed" } }, { type: "item.updated", item: { id: "plan", type: "todo_list", items: [{ text: "locate cause", status: "completed" }, { text: "write fix", status: "in_progress" }] } }); emitted.forEach((line, index) => setTimeout(() => console.log(JSON.stringify(line)), index * ${lineDelayMs})); }\n`,
  );
}
export function installationFixture(kindId: "claude" | "codex", executablePath: string): RuntimeInstallationWitness {
  return {
    installationId: `installation-${kindId}`,
    kindId,
    executablePath,
    version: "1.0.0",
    observedAt: "2026-08-19T00:00:00.000Z",
  };
}
export function spawnCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}
export function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args]);
}
