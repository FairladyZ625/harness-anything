// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CredentialPort } from "../src/daemon-host/agent-runtime-credential-port.ts";
import { localUserDaemonEndpoint } from "../src/daemon-host/client/local-daemon-target.ts";
import {
  createJsonRpcProtocolServer,
  createUnixSocketTransportServer,
  openDaemonHost,
} from "../src/daemon-host/index.ts";

function createMemoryVault(): CredentialPort {
  const store = new Map<string, string>();
  let sequence = 0;
  return {
    issue: () => `credential:v1:cli-e2e-${String(++sequence)}`,
    store: async (reference, value) => void store.set(reference, value),
    resolve: async (reference) => {
      const value = store.get(reference);
      if (!value) throw Object.assign(new Error("unavailable"), { code: "runtime_credential_unavailable" });
      return value;
    },
    remove: async (reference) => void store.delete(reference),
  };
}

function runCliJson(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  const cli = path.resolve("packages/cli/src/index.ts");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "--json", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("HA10-06: real CLI provider create/probe flows through isolated daemon RPC to loopback HTTP endpoints", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-dp-cli-e2e-"));
  const userRoot = path.join(parent, "user");
  const daemonId = "dp-cli-e2e";
  mkdirSync(userRoot, { recursive: true, mode: 0o700 });
  const socketPath = localUserDaemonEndpoint(userRoot, daemonId);
  const vault = createMemoryVault();

  const apiKey = "sk-cli-e2e-loopback-secret-4242";
  const apiKeyFile = path.join(parent, "provider.key");
  writeFileSync(apiKeyFile, `${apiKey}\n`, { mode: 0o600 });

  const seen: {
    readonly path: string;
    readonly auth: string | undefined;
    readonly googKey: string | string[] | undefined;
  }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const reqPath = req.url ?? "";
      seen.push({ path: reqPath, auth: req.headers.authorization, googKey: req.headers["x-goog-api-key"] });
      if (reqPath === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: "deepseek-r1",
            usage: { prompt_tokens: 8, completion_tokens: 4 },
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ type: "noul", noul: 0.95 }) } }],
          }),
        );
        return;
      }
      if (reqPath === "/v1beta/decisions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gemini-decision-1",
            usage: { total_input_tokens: 12, total_output_tokens: 0 },
            answers: { decision: { type: "noul", noul: 0.99 } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  const host = await openDaemonHost({
    userRoot,
    daemonId,
    runtimeDiscover: () => [],
    runtimeCredentialPort: vault,
  });
  await host.attachmentsSettled();
  const transport = createUnixSocketTransportServer({
    daemonId,
    socketPath,
    createProtocolServer: (authContext, emit) =>
      createJsonRpcProtocolServer({
        host,
        build: { commit: null },
        authContext,
        emit,
      }),
  });
  await transport.start();

  t.after(async () => {
    await transport.stop();
    await host.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    rmSync(parent, { recursive: true, force: true });
  });

  const cliEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: daemonId,
    HARNESS_DAEMON_ENDPOINT: socketPath,
    HARNESS_DAEMON_AUTOSTART: "0",
  };
  delete cliEnv.HARNESS_DAEMON_RELAY;

  // 1) Real CLI create + probe for openai-compatible
  const createOai = await runCliJson(
    [
      "provider",
      "create",
      "--type",
      "decisions",
      "--vendor",
      "openai-compatible",
      "--id",
      "cli-oai",
      "--name",
      "CLI OpenAI",
      "--model",
      "deepseek-r1",
      "--base-url",
      `${origin}/v1`,
      "--api-key-file",
      apiKeyFile,
    ],
    cliEnv,
  );
  assert.equal(createOai.status, 0, createOai.stderr || createOai.stdout);
  assert.equal(createOai.stdout.includes(apiKey), false, "CLI create stdout must not leak API key");
  const createOaiJson = JSON.parse(createOai.stdout) as { ok: boolean; provider: { vendor: string; baseUrl: string } };
  assert.equal(createOaiJson.ok, true);
  assert.equal(createOaiJson.provider.vendor, "openai-compatible");
  assert.equal(createOaiJson.provider.baseUrl, `${origin}/v1`);

  const probeOai = await runCliJson(["provider", "probe", "cli-oai"], cliEnv);
  assert.equal(probeOai.status, 0, probeOai.stderr || probeOai.stdout);
  const probeOaiJson = JSON.parse(probeOai.stdout) as { ok: boolean; probe: { state: string } };
  assert.equal(probeOaiJson.ok, true);
  assert.equal(probeOaiJson.probe.state, "ready");
  assert.equal(seen[0]?.path, "/v1/chat/completions");
  assert.equal(seen[0]?.auth, `Bearer ${apiKey}`);

  // 2) Real CLI create + probe for google native Decisions API
  const createGoogle = await runCliJson(
    [
      "provider",
      "create",
      "--type",
      "decisions",
      "--vendor",
      "google",
      "--id",
      "cli-google",
      "--name",
      "CLI Google",
      "--model",
      "gemini-decision-1",
      "--base-url",
      `${origin}/v1beta`,
      "--api-key-file",
      apiKeyFile,
    ],
    cliEnv,
  );
  assert.equal(createGoogle.status, 0, createGoogle.stderr || createGoogle.stdout);

  const probeGoogle = await runCliJson(["provider", "probe", "cli-google"], cliEnv);
  assert.equal(probeGoogle.status, 0, probeGoogle.stderr || probeGoogle.stdout);
  const probeGoogleJson = JSON.parse(probeGoogle.stdout) as { ok: boolean; probe: { state: string } };
  assert.equal(probeGoogleJson.ok, true);
  assert.equal(probeGoogleJson.probe.state, "ready");
  assert.equal(seen[1]?.path, "/v1beta/decisions");
  assert.equal(seen[1]?.googKey, apiKey);

  // 3) Negative CLI path: decisions-http without --base-url rejected cleanly via daemon RPC
  const badHttp = await runCliJson(
    [
      "provider",
      "create",
      "--type",
      "decisions",
      "--vendor",
      "decisions-http",
      "--id",
      "cli-bad-http",
      "--name",
      "Missing URL",
      "--model",
      "decider-1",
      "--api-key-file",
      apiKeyFile,
    ],
    cliEnv,
  );
  assert.notEqual(badHttp.status, 0);
  assert.match(badHttp.stdout + badHttp.stderr, /invalid_base_url/u);
});
