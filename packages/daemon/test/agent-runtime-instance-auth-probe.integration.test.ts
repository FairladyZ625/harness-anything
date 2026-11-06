// harness-test-tier: integration
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { launchArgs, isolatedEnvironment } from "../src/agent-runtime-launch-config.ts";
import type { RuntimeInstanceConfig } from "../src/agent-runtime-instance-types.ts";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instances.ts";
import { runProcessExitAsync } from "../src/process-port.ts";
import { observed } from "./agent-runtime-instance-environment.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const fakeToken = "agt_code_fake_probe_token";

interface ProviderResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

interface Scenario {
  readonly root: string;
  readonly server: Server;
  readonly providerUrl: string;
  readonly requests: CapturedRequest[];
  readonly store: ReturnType<typeof openRuntimeInstanceStore>;
  readonly config: RuntimeInstanceConfig;
  readonly executablePath: string;
  readonly executableScript: string;
  readonly instanceRoot: string;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

test("Codex probe distinguishes a 401 invalid_api_key from a locally present login", async (context) => {
  const scenario = await makeScenario({
    status: 401,
    body: {
      error: {
        message: `Incorrect API key provided: ${fakeToken}`,
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    },
  });
  try {
    const dispatch = await runProviderCall(scenario),
      readiness = await scenario.store.authStatus("codex-probe");
    context.diagnostic(
      `fake provider returned HTTP 401 invalid_api_key (Incorrect API key provided: [FAKE_TOKEN]); ` +
        `pre-fix probe=${readiness.status}/${readiness.code ?? "null"}; dispatchExit=${dispatch.exitCode}`,
    );
    assert.equal(dispatch.exitCode, 1);
    assert.equal(readiness.code, "runtime_authentication_failed");
    assert.doesNotMatch(readiness.hint ?? "", /agt_code_fake_probe_token/u);
    assert.deepEqual(
      scenario.requests.map(({ method, url }) => [method, url]),
      [
        ["POST", "/v1/responses"],
        ["POST", "/v1/responses"],
      ],
    );
  } finally {
    await scenario.close();
  }
});

test("Codex probe distinguishes exhausted quota from login metadata", async (context) => {
  const scenario = await makeScenario({
    status: 429,
    body: {
      error: {
        message: "You exceeded your current quota.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    },
  });
  try {
    const dispatch = await runProviderCall(scenario),
      readiness = await scenario.store.authStatus("codex-probe");
    context.diagnostic(
      `fake provider returned HTTP 429 insufficient_quota; ` +
        `pre-fix probe=${readiness.status}/${readiness.code ?? "null"}; dispatchExit=${dispatch.exitCode}`,
    );
    assert.equal(dispatch.exitCode, 1);
    assert.equal(readiness.code, "runtime_quota_unavailable");
    assert.match(readiness.hint ?? "", /quota/u);
    assert.deepEqual(
      scenario.requests.map(({ method, url }) => [method, url]),
      [
        ["POST", "/v1/responses"],
        ["POST", "/v1/responses"],
      ],
    );
  } finally {
    await scenario.close();
  }
});

test("Codex probe distinguishes an invalid refresh token", async (context) => {
  const scenario = await makeScenario(
    { status: 200, body: { id: "response-fake", status: "completed" } },
    "fake-invalid-refresh",
  );
  try {
    const dispatch = await runProviderCall(scenario),
      readiness = await scenario.store.authStatus("codex-probe");
    context.diagnostic(
      `fake Codex emitted turn.failed code=invalid_refresh_token; ` +
        `pre-fix probe=${readiness.status}/${readiness.code ?? "null"}; dispatchExit=${dispatch.exitCode}`,
    );
    assert.equal(dispatch.exitCode, 1);
    assert.equal(readiness.code, "runtime_refresh_token_invalid");
    assert.match(readiness.hint ?? "", /runtime instance login/u);
    assert.equal(scenario.requests.length, 0);
  } finally {
    await scenario.close();
  }
});

test("Codex probe stays ready after a successful provider response", async () => {
  const scenario = await makeScenario({ status: 200, body: { id: "response-fake", status: "completed" } });
  try {
    const dispatch = await runProviderCall(scenario),
      readiness = await scenario.store.authStatus("codex-probe");
    assert.equal(dispatch.exitCode, 0);
    assert.deepEqual(readiness, { status: "ready", code: null, hint: null });
    assert.deepEqual(
      scenario.requests.map(({ method, url }) => [method, url]),
      [
        ["POST", "/v1/responses"],
        ["POST", "/v1/responses"],
      ],
    );
    assert.ok(scenario.requests.every(({ authorization }) => authorization === `Bearer ${fakeToken}`));
  } finally {
    await scenario.close();
  }
});

async function makeScenario(response: ProviderResponse, refreshToken = "fake-refresh-token"): Promise<Scenario> {
  const root = mkdtempSync(path.join(tmpdir(), "ha-codex-auth-probe-")),
    operatorHome = path.join(root, "operator-home"),
    operatorCodexHome = path.join(operatorHome, ".codex"),
    userRoot = path.join(root, "daemon-state"),
    instanceRoot = path.join(userRoot, "runtime-instances", "codex-probe"),
    requests: CapturedRequest[] = [];
  mkdirSync(operatorCodexHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(operatorCodexHome, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: fakeToken, refresh_token: refreshToken, id_token: "fake-id-token" },
      last_refresh: "2026-11-07T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  const server = createServer((request, outgoing) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
    });
    request.resume();
    request.on("end", () => {
      outgoing.writeHead(response.status, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake provider server has no TCP address");
  const providerUrl = `http://127.0.0.1:${String(address.port)}/v1`,
    executableScript = path.join(root, "codex-fake.mjs"),
    executablePath = writeProviderExecutable(executableScript, fakeCodexBody),
    installation = { ...observed, installationId: "codex-probe-installation", executablePath },
    sourceEnvironment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: operatorHome,
      CODEX_HOME: operatorCodexHome,
      TMPDIR: root,
    },
    config: RuntimeInstanceConfig = {
      schemaVersion: 2,
      instanceId: "codex-probe",
      name: "Codex probe",
      kindId: "codex",
      installationId: installation.installationId,
      providerId: "codex_local_access",
      models: ["gpt-6-sol"],
      defaultModel: "gpt-6-sol",
      enabled: true,
      isolationState: "enforced",
      auth: { mode: "subscription" },
      codex: { baseUrl: providerUrl, wireApi: "responses", requiresOpenAiAuth: true },
    },
    store = openRuntimeInstanceStore({ userRoot, discover: () => [installation], env: sourceEnvironment });
  store.create(config);
  return {
    root,
    server,
    providerUrl,
    requests,
    store,
    config,
    executablePath,
    executableScript,
    instanceRoot,
    sourceEnvironment,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function runProviderCall(scenario: Scenario) {
  const env = isolatedEnvironment(scenario.sourceEnvironment, scenario.instanceRoot, "codex", process.platform),
    args = launchArgs(
      scenario.config,
      scenario.config.defaultModel,
      "Reply with exactly READY. Do not use tools or inspect files.",
      undefined,
      null,
      "read-only",
      false,
      undefined,
      process.platform,
    );
  return runProcessExitAsync(
    process.execPath,
    [scenario.executableScript, ...args],
    scenario.instanceRoot,
    env,
    "Reply with exactly READY. Do not use tools or inspect files.\n",
  );
}

const fakeCodexBody = `
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME;
const auth = JSON.parse(readFileSync(codexHome + "/auth.json", "utf8"));
if (args[0] === "login" && args[1] === "status") {
  if (auth.tokens?.refresh_token) console.error("Logged in using ChatGPT");
  else process.exitCode = 1;
} else if (args[0] === "exec") {
  if (auth.tokens?.refresh_token === "fake-invalid-refresh") {
    console.log(JSON.stringify({ type: "turn.failed", error: { code: "invalid_refresh_token", message: "invalid_refresh_token" } }));
    process.exitCode = 1;
  } else {
    const config = readFileSync(codexHome + "/config.toml", "utf8");
    const baseUrl = /^base_url = "([^"\\n]+)"/mu.exec(config)?.[1];
    if (!baseUrl) throw new Error("generated provider config has no base_url");
    const response = await fetch(baseUrl.replace(/\\/$/u, "") + "/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + auth.tokens.access_token },
      body: JSON.stringify({ model: "gpt-6-sol", input: "probe" })
    });
    const body = await response.json();
    if (response.ok) console.log(JSON.stringify({ type: "turn.completed" }));
    else console.log(JSON.stringify({ type: "turn.failed", error: {
      http_status: response.status,
      code: body.error?.code,
      message: body.error?.message
    } }));
    process.exitCode = response.ok ? 0 : 1;
  }
} else process.exitCode = 2;
`;
