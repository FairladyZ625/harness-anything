// harness-test-tier: integration
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore } from "../src/daemon-host/agent-runtime-instances.ts";
import type { RuntimeInstallationWitness } from "../src/daemon-host/agent-runtime-instance-types.ts";
import { openRuntimeProviderHealthStore } from "../src/runtime-engine/runtime-provider-health.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

interface HttpStub {
  readonly baseUrl: string;
  readonly requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string | string[] | undefined>;
  }>;
  close(): Promise<void>;
}

async function startLoopbackServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<HttpStub> {
  const requests: HttpStub["requests"] = [];
  const server: Server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: { ...req.headers },
    });
    void Promise.resolve(handler(req, res));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Server has no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function witness(
  kindId: RuntimeInstallationWitness["kindId"],
  executablePath: string,
  version = "2.2.0",
): RuntimeInstallationWitness {
  return {
    installationId: `${kindId}-install`,
    kindId,
    executablePath,
    version,
    observedAt: "2026-11-21T10:00:00.000Z",
    models: ["default-model"],
    defaultModel: "default-model",
  };
}

test("AGY quota probe parses multi-group buckets, caches for O(1) list/show, cools down on 0% and recovers on >0%", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-agy-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    modeFile = path.join(root, "mode.txt"),
    traceFile = path.join(root, "trace.log"),
    resetFuture = "2026-11-22T06:00:00.000Z";
  mkdirSync(bin, { recursive: true });
  writeFileSync(modeFile, "exhausted");
  writeFileSync(traceFile, "");
  const agyBin = writeProviderExecutable(
    path.join(bin, "agy"),
    `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(traceFile)}, args.join(" ") + "\\n");
      if (args[0] === "models") {
        console.log("gemini-4-hydrogen-low\\tmodel");
        process.exit(0);
      }
      if (args[0] === "-p" && args[1] === "/quota") {
        const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
        console.log(JSON.stringify({
          command: {
            data: {
              plan: "Ultra",
              groups: [
                {
                  group_id: "gemini",
                  display_name: "Gemini",
                  buckets: [
                    { bucket_id: "gemini-5h", display_name: "5h", remaining_fraction: mode === "exhausted" ? 0 : 0.85, reset_time: ${JSON.stringify(resetFuture)} },
                    { bucket_id: "disabled-bucket", display_name: "Disabled", remaining_fraction: 0, disabled: true, reset_time: "2026-11-30T00:00:00.000Z" }
                  ]
                },
                {
                  group_id: "claude",
                  display_name: "Claude/GPT",
                  buckets: [
                    { bucket_id: "claude-7d", display_name: "7d", remaining_fraction: 0.62, reset_time: "2026-11-28T00:00:00.000Z" }
                  ]
                }
              ]
            }
          }
        }));
        process.exit(0);
      }
      process.exit(1);
    `,
  );
  try {
    let clock = "2026-11-21T10:00:00.000Z";
    const health = openRuntimeProviderHealthStore(userRoot),
      store = openRuntimeInstanceStore({
        userRoot,
        platform: "darwin",
        env: { PATH: bin, HOME: path.join(root, "home") },
        discover: () => [witness("agy", agyBin, "1.2.2")],
        providerHealth: health,
        now: () => clock,
      });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "agy-main",
      name: "AGY Main",
      kindId: "agy",
      installationId: "agy-install",
      providerId: "google",
      models: ["gemini-4-hydrogen-low"],
      authMode: "subscription",
      credentialSource: "instance",
    });

    const probed = await store.command({ kind: "runtime-instance-show", instanceId: "agy-main", probe: true });
    const instance = probed.instance as Record<string, unknown>;
    assert.equal((instance.authReadiness as Record<string, unknown>).status, "ready");
    const quota = instance.quota as {
      readonly source: string;
      readonly plan: string | null;
      readonly windows: ReadonlyArray<{
        readonly id: string;
        readonly remainingFraction: number;
        readonly resetsAt: string | null;
      }>;
    };
    assert.equal(quota.source, "agy-cli");
    assert.equal(quota.plan, "Ultra");
    assert.equal(quota.windows.length, 2);
    assert.equal(quota.windows[0]?.remainingFraction, 0);
    assert.equal(quota.windows[1]?.remainingFraction, 0.62);
    assert.equal(health.get("agy-main").reason, "quota_exhausted");
    assert.equal(health.get("agy-main").cooldownUntil, resetFuture);

    // Non-probe list and show read cached quota in O(1) with ZERO subprocess calls.
    const traceBeforeRead = readFileSync(traceFile, "utf8");
    const listed = await store.command({ kind: "runtime-instance-list" });
    const shown = await store.command({ kind: "runtime-instance-show", instanceId: "agy-main" });
    assert.equal(readFileSync(traceFile, "utf8"), traceBeforeRead);
    assert.match(String(listed.summary), /\tQUOTA\n/u);
    assert.match(String(listed.summary), /Ultra/u);
    assert.match(String(shown.summary), /quota: \[Ultra\] Gemini · 5h 0%/u);
    assert.match(String(shown.summary), /Claude\/GPT · 7d 62%/u);

    // When quota recovers > 0%, providerHealth cooldown clears cleanly.
    writeFileSync(modeFile, "healthy");
    clock = "2026-11-21T10:05:00.000Z";
    const recovered = await store.command({ kind: "runtime-instance-show", instanceId: "agy-main", probe: true });
    assert.equal(health.get("agy-main").cooldownUntil, null);
    assert.equal(health.get("agy-main").failureStreak, 0);
    assert.equal(
      ((recovered.instance as Record<string, unknown>).quota as typeof quota).windows[0]?.remainingFraction,
      0.85,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex quota probe supports native app-server JSON-RPC account/rateLimits/read", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-codex-rpc-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    resetPrimary = "2026-11-21T15:00:00.000Z",
    resetWeekly = "2026-11-28T00:00:00.000Z";
  mkdirSync(bin, { recursive: true });
  const codexBin = writeProviderExecutable(
    path.join(bin, "codex"),
    `
      const readline = require("node:readline");
      const args = process.argv.slice(2);
      if (args[0] === "login" && args[1] === "status") {
        console.log("Logged in");
        process.exit(0);
      }
      if (args[0] === "exec") {
        console.log(JSON.stringify({ type: "turn.completed" }));
        process.exit(0);
      }
      if (args[0] === "app-server") {
        const rl = readline.createInterface({ input: process.stdin });
        rl.on("line", (line) => {
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "codex-stub" } } }));
          } else if (msg.method === "model/list") {
            console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { data: [{ model: "gpt-6-sol", isDefault: true }], nextCursor: null } }));
          } else if (msg.method === "account/rateLimits/read") {
            console.log(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                rateLimits: {
                  planType: "plus",
                  primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: ${JSON.stringify(resetPrimary)} },
                  secondary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: ${JSON.stringify(resetWeekly)} },
                  credits: { hasCredits: true, unlimited: false, balance: "42.5" }
                }
              }
            }));
          }
        });
        return;
      }
      process.exit(1);
    `,
  );
  try {
    const health = openRuntimeProviderHealthStore(userRoot),
      store = openRuntimeInstanceStore({
        userRoot,
        platform: "darwin",
        env: { PATH: bin, HOME: path.join(root, "home") },
        discover: () => [witness("codex", codexBin, "0.165.0")],
        providerHealth: health,
        now: () => "2026-11-21T10:00:00.000Z",
      });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-rpc",
      name: "Codex RPC",
      kindId: "codex",
      installationId: "codex-install",
      providerId: "openai",
      models: ["gpt-6-sol"],
      authMode: "subscription",
      credentialSource: "operator",
      isolationState: "operator-environment",
    });

    const probed = await store.command({ kind: "runtime-instance-show", instanceId: "codex-rpc", probe: true });
    const quota = (probed.instance as Record<string, unknown>).quota as {
      readonly source: string;
      readonly plan: string | null;
      readonly windows: ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly remainingFraction: number;
        readonly resetsAt: string | null;
      }>;
      readonly credits?: { readonly remaining: number | null; readonly unlimited: boolean };
    };
    assert.equal(quota.source, "codex-app-server");
    assert.equal(quota.plan, "plus");
    assert.equal(quota.windows.length, 2);
    assert.equal(quota.windows[0]?.label, "5h");
    assert.equal(quota.windows[0]?.remainingFraction, 0);
    assert.equal(quota.windows[1]?.label, "7d");
    assert.equal(quota.windows[1]?.remainingFraction, 0.65);
    assert.equal(quota.credits?.remaining, 42.5);
    assert.equal(health.get("codex-rpc").reason, "quota_exhausted");
    assert.equal(health.get("codex-rpc").cooldownUntil, resetPrimary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex OAuth wham/usage honors config.toml chatgpt_base_url (ignoring # comments) and never mutates auth.json", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-codex-oauth-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    codexHome = path.join(root, "codex-home"),
    secretToken = "codex_fake_oauth_secret_token_999";
  mkdirSync(bin, { recursive: true });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const server = await startLoopbackServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1795273200 },
          secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: 1795860000 },
        },
        credits: { has_credits: true, unlimited: true, balance: null },
      }),
    );
  });
  const authPath = path.join(codexHome, "auth.json"),
    authRaw = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: secretToken, account_id: "acct_codex_123" },
    });
  writeFileSync(authPath, authRaw, { mode: 0o600 });
  writeFileSync(
    path.join(codexHome, "config.toml"),
    [
      '# chatgpt_base_url = "https://commented.out.invalid/backend-api"',
      `chatgpt_base_url = "${server.baseUrl}/backend-api" # inline comment`,
      "",
      "[model_providers.other]",
      'chatgpt_base_url = "https://inside-table.invalid"',
    ].join("\n"),
    { mode: 0o600 },
  );
  const statBefore = statSync(authPath);
  const codexBin = writeProviderExecutable(
    path.join(bin, "codex"),
    `
      const args = process.argv.slice(2);
      if (args[0] === "login" && args[1] === "status") { console.log("ok"); process.exit(0); }
      if (args[0] === "exec") { console.log(JSON.stringify({ type: "turn.completed" })); process.exit(0); }
      process.exit(2);
    `,
  );
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      platform: "darwin",
      env: { PATH: bin, HOME: path.join(root, "home"), CODEX_HOME: codexHome },
      discover: () => [witness("codex", codexBin, "0.165.0")],
      now: () => "2026-11-21T10:00:00.000Z",
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-oauth",
      name: "Codex OAuth",
      kindId: "codex",
      installationId: "codex-install",
      providerId: "openai",
      models: ["gpt-6-sol"],
      authMode: "subscription",
      credentialSource: "operator",
      isolationState: "operator-environment",
    });
    const probed = await store.command({ kind: "runtime-instance-show", instanceId: "codex-oauth", probe: true });
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]?.url, "/backend-api/wham/usage");
    assert.equal(server.requests[0]?.headers.authorization, `Bearer ${secretToken}`);
    assert.equal(server.requests[0]?.headers["chatgpt-account-id"], "acct_codex_123");
    const quota = (probed.instance as Record<string, unknown>).quota as {
      readonly source: string;
      readonly plan: string | null;
      readonly windows: ReadonlyArray<{ readonly remainingFraction: number }>;
      readonly credits?: { readonly unlimited: boolean };
    };
    assert.equal(quota.source, "codex-oauth");
    assert.equal(quota.plan, "pro");
    assert.equal(quota.windows[0]?.remainingFraction, 0.75);
    assert.equal(quota.windows[1]?.remainingFraction, 0.5);
    assert.equal(quota.credits?.unlimited, true);
    // auth.json must remain byte-for-byte identical and untouched.
    assert.equal(readFileSync(authPath, "utf8"), authRaw);
    assert.equal(statSync(authPath).mtimeMs, statBefore.mtimeMs);
    assert.doesNotMatch(JSON.stringify(probed), new RegExp(secretToken, "u"));

    // A truncated auth.json degrades cleanly after bounded read retries without mutating the file.
    const partialBody = '{"auth_mode":';
    writeFileSync(authPath, partialBody, { mode: 0o600 });
    const truncated = await store.command({ kind: "runtime-instance-show", instanceId: "codex-oauth", probe: true });
    assert.equal(readFileSync(authPath, "utf8"), partialBody);
    assert.equal(
      ((truncated.instance as Record<string, unknown>).authReadiness as Record<string, unknown>).status,
      "ready",
    );
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude OAuth probe sends anthropic-beta header, parses windows, and degrades gracefully on 429 without breaking authReadiness", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-claude-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    claudeConfigDir = path.join(root, "claude-config"),
    secretToken = "sk-ant-oat01-fake-claude-secret-token-777";
  mkdirSync(bin, { recursive: true });
  mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
  const credsPath = path.join(claudeConfigDir, ".credentials.json"),
    credsRaw = JSON.stringify({
      claudeAiOauth: { accessToken: secretToken, subscriptionType: "max" },
    });
  writeFileSync(credsPath, credsRaw, { mode: 0o600 });
  let mode: "ok" | "rate-limit" = "ok";
  const server = await startLoopbackServer((_req, res) => {
    if (mode === "rate-limit") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "120" });
      res.end(JSON.stringify({ error: { message: `Rate limited for token ${secretToken}` } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        five_hour: { utilization: 18, resets_at: "2026-11-21T15:00:00.000Z" },
        seven_day: { utilization: 45, resets_at: "2026-11-27T00:00:00.000Z" },
        seven_day_sonnet: { utilization: 10, resets_at: "2026-11-27T00:00:00.000Z" },
        extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 23.5, utilization: 23.5 },
      }),
    );
  });
  const claudeBin = writeProviderExecutable(
    path.join(bin, "claude"),
    `
      const args = process.argv.slice(2);
      if (args[0] === "auth" && args[1] === "status") {
        console.log(JSON.stringify({ loggedIn: true }));
        process.exit(0);
      }
      if (args.includes("--print")) {
        console.log(JSON.stringify({
          type: "control_response",
          response: { request_id: "models", subtype: "success", response: { models: [{ value: "claude-opus-5-5" }] } }
        }));
        process.exit(0);
      }
      process.exit(0);
    `,
  );
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      platform: "darwin",
      env: {
        PATH: bin,
        HOME: path.join(root, "home"),
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        ANTHROPIC_BASE_URL: server.baseUrl,
      },
      discover: () => [witness("claude", claudeBin, "2.1.300")],
      now: () => "2026-11-21T10:00:00.000Z",
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "claude-pro",
      name: "Claude Pro",
      kindId: "claude",
      installationId: "claude-install",
      providerId: "anthropic",
      models: ["claude-opus-5-5"],
      authMode: "subscription",
      credentialSource: "operator",
      isolationState: "operator-environment",
    });

    const first = await store.command({ kind: "runtime-instance-show", instanceId: "claude-pro", probe: true });
    assert.equal(server.requests[0]?.url, "/api/oauth/usage");
    assert.equal(server.requests[0]?.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(server.requests[0]?.headers.authorization, `Bearer ${secretToken}`);
    const firstQuota = (first.instance as Record<string, unknown>).quota as {
      readonly source: string;
      readonly plan: string | null;
      readonly windows: ReadonlyArray<{
        readonly id: string;
        readonly remainingFraction: number;
        readonly usedPercent: number;
      }>;
      readonly credits?: { readonly remaining: number | null; readonly limit: number | null };
    };
    assert.equal(firstQuota.source, "claude-oauth");
    assert.equal(firstQuota.plan, "max");
    assert.equal(firstQuota.windows.length, 3);
    assert.equal(firstQuota.windows[0]?.id, "five_hour");
    assert.equal(firstQuota.windows[0]?.remainingFraction, 0.82);
    assert.equal(firstQuota.credits?.remaining, 76.5);
    assert.equal(firstQuota.credits?.limit, 100);
    assert.equal(readFileSync(credsPath, "utf8"), credsRaw);

    // HTTP 429 must keep authReadiness === ready, preserve prior cached quota, and never leak token.
    mode = "rate-limit";
    const rateLimited = await store.command({ kind: "runtime-instance-show", instanceId: "claude-pro", probe: true });
    const instance = rateLimited.instance as Record<string, unknown>;
    assert.equal((instance.authReadiness as Record<string, unknown>).status, "ready");
    assert.deepEqual(instance.quota, firstQuota);
    assert.doesNotMatch(JSON.stringify(rateLimited), new RegExp(secretToken, "u"));
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Copilot quota probe parses quota_snapshots and triggers exhaustion cooldown", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-copilot-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    home = path.join(root, "home"),
    secretToken = "gho_fake_copilot_token_1234567890",
    resetDate = "2026-12-01T00:00:00.000Z";
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(home, ".copilot"), { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(home, ".copilot", "hosts.json"),
    JSON.stringify({ "github.com": { oauth_token: secretToken } }),
    { mode: 0o600 },
  );
  const server = await startLoopbackServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        copilot_plan: "individual_pro",
        quota_reset_date_utc: resetDate,
        quota_snapshots: {
          premium_interactions: { percent_remaining: 0, remaining: 0, entitlement: 300, unlimited: false },
          chat: { percent_remaining: 100, unlimited: true },
        },
      }),
    );
  });
  const copilotBin = writeProviderExecutable(path.join(bin, "copilot"), `console.log("copilot 1.0.0");\n`);
  try {
    const health = openRuntimeProviderHealthStore(userRoot),
      store = openRuntimeInstanceStore({
        userRoot,
        platform: "darwin",
        env: { PATH: bin, HOME: home, GITHUB_API_URL: server.baseUrl },
        discover: () => [witness("copilot", copilotBin, "1.0.0")],
        providerHealth: health,
        now: () => "2026-11-21T10:00:00.000Z",
      });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "copilot-main",
      name: "Copilot Main",
      kindId: "copilot",
      installationId: "copilot-install",
      providerId: "github",
      models: ["gpt-5"],
      authMode: "subscription",
      credentialSource: "operator",
      isolationState: "operator-environment",
    });

    const probed = await store.command({ kind: "runtime-instance-show", instanceId: "copilot-main", probe: true });
    assert.equal(server.requests[0]?.url, "/copilot_internal/user");
    assert.equal(server.requests[0]?.headers.authorization, `token ${secretToken}`);
    const quota = (probed.instance as Record<string, unknown>).quota as {
      readonly source: string;
      readonly plan: string | null;
      readonly windows: ReadonlyArray<{
        readonly id: string;
        readonly remainingFraction: number;
        readonly resetsAt: string | null;
      }>;
    };
    assert.equal(quota.source, "copilot-oauth");
    assert.equal(quota.plan, "individual_pro");
    assert.equal(quota.windows.length, 2);
    assert.equal(quota.windows[0]?.id, "premium_interactions");
    assert.equal(quota.windows[0]?.remainingFraction, 0);
    assert.equal(quota.windows[1]?.id, "chat");
    assert.equal(quota.windows[1]?.remainingFraction, 1);
    assert.equal(health.get("copilot-main").reason, "quota_exhausted");
    assert.equal(health.get("copilot-main").cooldownUntil, resetDate);
    assert.doesNotMatch(JSON.stringify(probed), new RegExp(secretToken, "u"));
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Security & concurrency fences: rejects HTTP 302 redirects, redacts leaked tokens, and drops stale probes after delete/recreate", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-security-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    claudeDir = path.join(root, "claude-dir"),
    secretToken = "sk-ant-oat01-must-never-leak-anywhere-888";
  mkdirSync(bin, { recursive: true });
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(claudeDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: secretToken } }),
    { mode: 0o600 },
  );
  let redirectTargetHit = false;
  const redirectTarget = await startLoopbackServer((_req, res) => {
    redirectTargetHit = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  let serverMode: "redirect" | "error-leak" | "slow-exhausted" = "redirect";
  let releaseSlow: (() => void) | null = null;
  let slowStarted: (() => void) | null = null;
  const slowStartedPromise = new Promise<void>((resolve) => {
    slowStarted = resolve;
  });
  const server = await startLoopbackServer(async (_req, res) => {
    if (serverMode === "redirect") {
      res.writeHead(302, { location: `${redirectTarget.baseUrl}/steal` });
      res.end();
      return;
    }
    if (serverMode === "error-leak") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`upstream failed with Authorization: Bearer ${secretToken}`);
      return;
    }
    slowStarted?.();
    await new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ five_hour: { utilization: 100, resets_at: "2026-11-22T00:00:00.000Z" } }));
  });
  const claudeBin = writeProviderExecutable(
    path.join(bin, "claude"),
    `
      const args = process.argv.slice(2);
      if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
      if (args.includes("--print")) {
        console.log(JSON.stringify({
          type: "control_response",
          response: { request_id: "models", subtype: "success", response: { models: [{ value: "claude-opus-5-5" }] } }
        }));
        process.exit(0);
      }
      process.exit(0);
    `,
  );
  try {
    const health = openRuntimeProviderHealthStore(userRoot),
      store = openRuntimeInstanceStore({
        userRoot,
        platform: "darwin",
        env: {
          PATH: bin,
          HOME: path.join(root, "home"),
          CLAUDE_CONFIG_DIR: claudeDir,
          ANTHROPIC_BASE_URL: server.baseUrl,
        },
        discover: () => [witness("claude", claudeBin, "2.1.300")],
        providerHealth: health,
        now: () => "2026-11-21T10:00:00.000Z",
      });
    const createPayload = {
      kind: "runtime-instance-create",
      instanceId: "claude-sec",
      name: "Claude Sec",
      kindId: "claude",
      installationId: "claude-install",
      providerId: "anthropic",
      models: ["claude-opus-5-5"],
      authMode: "subscription",
      credentialSource: "operator",
      isolationState: "operator-environment",
    };
    store.command(createPayload);

    // 1. HTTP 302 redirect is refused without following redirectTarget.
    const redirected = await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec", probe: true });
    assert.equal(redirectTargetHit, false);
    assert.equal(
      ((redirected.instance as Record<string, unknown>).authReadiness as Record<string, unknown>).status,
      "ready",
    );
    assert.equal((redirected.instance as Record<string, unknown>).quota, undefined);

    // 2. Upstream error body with secret token never leaks into DTO, CLI summary, or persisted store.
    serverMode = "error-leak";
    const errored = await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec", probe: true });
    const persistedJson = readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8");
    assert.doesNotMatch(
      `${JSON.stringify(errored)}\n${String(errored.summary)}\n${persistedJson}`,
      new RegExp(secretToken, "u"),
    );

    // 3. Concurrent delete + recreate with same instanceId invalidates in-flight quota probe via runtimeInstanceAccountCutMatches.
    serverMode = "slow-exhausted";
    const inflight = store.authStatus("claude-sec");
    await slowStartedPromise;
    store.command({ kind: "runtime-instance-delete", instanceId: "claude-sec" });
    store.command(createPayload);
    releaseSlow?.();
    await assert.rejects(
      inflight,
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_instance_probe_stale",
    );
    const fresh = (await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec" })).instance as Record<
      string,
      unknown
    >;
    assert.equal(fresh.quota, undefined);
    assert.equal(health.get("claude-sec").cooldownUntil, null);
  } finally {
    await Promise.all([server.close(), redirectTarget.close()]);
    rmSync(root, { recursive: true, force: true });
  }
});
