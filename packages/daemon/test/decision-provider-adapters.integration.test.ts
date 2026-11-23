// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decisionProviderVendors } from "@harness-anything/kernel";
import type { CredentialPort } from "../src/daemon-host/agent-runtime-credential-port.ts";
import { openDecisionProviderService } from "../src/daemon-host/decision-provider.ts";
import { decisionProviderAdapterRegistry, redactDecisionSecret } from "../src/daemon-host/decision-providers/index.ts";
import { validTaskDispatchRow } from "../src/daemon-host/protocol/daemon-protocol-validate-relation-query.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

async function startLoopbackServer(
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>,
): Promise<{ readonly server: Server; readonly origin: string; readonly close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void Promise.resolve(handler(req, Buffer.concat(chunks).toString("utf8"), res));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function createMemoryVault(): { readonly vault: CredentialPort; readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  let sequence = 0;
  return {
    store,
    vault: {
      issue: () => `credential:v1:mem-${String(++sequence)}`,
      store: async (reference, value) => void store.set(reference, value),
      resolve: async (reference) => {
        const value = store.get(reference);
        if (!value) throw Object.assign(new Error("unavailable"), { code: "runtime_credential_unavailable" });
        return value;
      },
      remove: async (reference) => void store.delete(reference),
    },
  };
}

test("multi-vendor DecisionProvider adapter registry covers google, perplexity, decisions-http, openai-compatible, and anthropic over loopback HTTP", async (t) => {
  assert.deepEqual(Object.keys(decisionProviderAdapterRegistry).sort(), [...decisionProviderVendors].sort());
  const parent = mkdtempSync(path.join(tmpdir(), "ha-dp-multi-vendor-"));
  const { vault } = createMemoryVault();
  const captured: CapturedRequest[] = [];
  let googleUsageMode: "totals" | "metadata" = "totals";
  let anthropicStopReason: "end_turn" | "stop_sequence" = "end_turn";

  const mock = await startLoopbackServer((req, body, res) => {
    const parsed = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
    const reqPath = req.url ?? "";
    captured.push({ method: req.method ?? "", path: reqPath, headers: req.headers, body: parsed });

    if (reqPath === "/v1beta/decisions") {
      const q = (parsed.questions as { decision: { type: string } }).decision;
      const answer =
        q.type === "noul"
          ? { type: "noul", noul: 0.88 }
          : q.type === "choice"
            ? { type: "choice", choice: "ship", probabilities: { ship: 0.8, hold: 0.2 } }
            : { type: "score", score: 0.92, probabilities: { low: 0.05, high: 0.95 } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          googleUsageMode === "totals"
            ? {
                model: "gemini-decision-1",
                usage: { total_input_tokens: 120, total_output_tokens: 0 },
                answers: { decision: answer },
              }
            : {
                model: "gemini-decision-1",
                usageMetadata: { promptTokenCount: 64 },
                answers: { decision: answer },
              },
        ),
      );
      return;
    }

    if (reqPath === "/v1/decisions" || reqPath === "/custom/decisions") {
      const q = (parsed.questions as { decision: { type: string } }).decision;
      const answer =
        q.type === "noul"
          ? { type: "noul", noul: 0.77 }
          : q.type === "choice"
            ? { type: "choice", choice: "approve", probabilities: { approve: 0.75, reject: 0.25 } }
            : { type: "score", score: 0.65, probabilities: { s0: 0.3, s1: 0.7 } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: String(parsed.model ?? "decider"),
          provider: reqPath === "/v1/decisions" ? "perplexity-local" : "clef-local",
          usage: { input_tokens: 45, output_tokens: 2, cost: 0.0002 },
          answers: { decision: answer },
        }),
      );
      return;
    }

    if (reqPath === "/v1/chat/completions") {
      const sys = String(((parsed.messages as { content: string }[])[0] ?? {}).content ?? "");
      const payload = sys.includes('"type":"noul"')
        ? JSON.stringify({ type: "noul", noul: 0.91 })
        : sys.includes('"type":"choice"')
          ? '```json\n{"type":"choice","choice":"resume","probabilities":{"resume":0.85,"escalate":0.15}}\n```'
          : JSON.stringify({ type: "score", score: 0.78, probabilities: { low: 0.05, medium: 0.25, high: 0.7 } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "deepseek-r1-resolved",
          provider: "intranet-vllm",
          usage: { prompt_tokens: 18, completion_tokens: 7, cost: 0.0004 },
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: payload } }],
        }),
      );
      return;
    }

    if (reqPath === "/v1/messages") {
      const sys = String(parsed.system ?? "");
      const payload = sys.includes('"type":"noul"')
        ? JSON.stringify({ type: "noul", noul: 0.84 })
        : sys.includes('"type":"choice"')
          ? JSON.stringify({ type: "choice", choice: "merge", probabilities: { merge: 0.9, rework: 0.1 } })
          : JSON.stringify({ type: "score", score: 0.81, probabilities: { low: 0.1, high: 0.9 } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "claude-sonnet-4-6",
          stop_reason: anthropicStopReason,
          usage: { input_tokens: 55, output_tokens: 14 },
          content: [{ type: "text", text: payload }],
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });

  t.after(async () => {
    await mock.close();
    removeTempRepository(parent);
  });

  // Legacy decision-providers.json without `vendor` remains readable as `openrouter`.
  writeFileSync(
    path.join(parent, "decision-providers.json"),
    `${JSON.stringify(
      {
        schema: "decision-providers/v1",
        providers: [
          {
            schema: "decision-provider/v1",
            providerId: "legacy-or",
            name: "Legacy OpenRouter",
            providerType: "decisions",
            model: "openrouter/legacy-model",
            baseUrl: null,
            auth: { mode: "api-key", credentialRef: "credential:v1:legacy" },
            enabled: true,
            configurationRevision: 1,
            configurationId: "legacy-config-1",
            probe: { state: "unknown" },
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const service = openDecisionProviderService({
    userRoot: parent,
    vault,
    now: () => "2026-11-21T00:00:00.000Z",
    sleep: async () => undefined,
  });
  assert.equal(service.list().find(({ providerId }) => providerId === "legacy-or")?.vendor, "openrouter");

  // 1) Google Gemini native Decisions API (`x-goog-api-key`, `input`, `/v1beta/decisions`, zero output tokens)
  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "google",
    providerId: "google-decider",
    name: "Google Gemini Decisions",
    model: "gemini-decision-1",
    baseUrl: `${mock.origin}/v1beta/`,
    apiKey: "goog-test-secret-1111",
  });
  const googleProbe = await service.command({ kind: "provider-probe", providerId: "google-decider" });
  assert.deepEqual(googleProbe.probe, { state: "ready", checkedAt: "2026-11-21T00:00:00.000Z" });
  assert.equal(captured.at(-1)?.path, "/v1beta/decisions");
  assert.equal(captured.at(-1)?.headers["x-goog-api-key"], "goog-test-secret-1111");
  assert.equal(captured.at(-1)?.headers.authorization, undefined);
  assert.equal(captured.at(-1)?.body.input, "probe");

  const googleNoul = await service.port.decide({
    subjectRef: "task/google-noul",
    providerId: "google-decider",
    questionSetVersion: "noul/v1",
    state: ["All gates passed."],
    question: { type: "noul", prompt: "Ship?", criteria: { true: "ready", false: "blocked" } },
  });
  assert.equal(googleNoul.result.type, "noul");
  assert.equal(googleNoul.result.value, 0.88);
  assert.equal(googleNoul.provider.vendor, "google");
  assert.deepEqual(googleNoul.usage, { inputTokens: 120, outputTokens: 0, reportedCost: null });

  googleUsageMode = "metadata";
  const googleChoice = await service.port.decide({
    subjectRef: "task/google-choice",
    providerId: "google-decider",
    questionSetVersion: "choice/v1",
    state: ["Review clean."],
    question: {
      type: "choice",
      prompt: "Action?",
      options: [
        { id: "ship", text: "Ship" },
        { id: "hold", text: "Hold" },
      ],
      criteria: { ship: "clean", hold: "issues" },
    },
  });
  assert.equal(googleChoice.result.type, "choice");
  assert.equal(googleChoice.result.selected, "ship");
  assert.equal(Object.getPrototypeOf(googleChoice.distribution), null);
  assert.deepEqual(googleChoice.usage, { inputTokens: 64, outputTokens: 0, reportedCost: null });

  const googleScore = await service.port.decide({
    subjectRef: "task/google-score",
    providerId: "google-decider",
    questionSetVersion: "score/v1",
    state: ["High confidence."],
    question: {
      type: "score",
      prompt: "Confidence",
      levels: [
        { id: "low", text: "Low" },
        { id: "high", text: "High" },
      ],
      criteria: { low: "weak", high: "strong" },
    },
  });
  assert.equal(googleScore.result.type, "score");
  assert.equal(googleScore.result.value, 0.92);
  assert.equal(Object.getPrototypeOf(googleScore.distribution), null);

  // 2) Perplexity native Decisions API (`/v1/decisions`, Bearer, loopback override)
  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "perplexity",
    providerId: "pplx-local",
    name: "Local Perplexity Decider",
    model: "pplx-decider-v1.3",
    baseUrl: `${mock.origin}/v1`,
    apiKey: "pplx-test-secret-2222",
  });
  await service.command({ kind: "provider-probe", providerId: "pplx-local" });
  assert.equal(captured.at(-1)?.path, "/v1/decisions");
  assert.equal(captured.at(-1)?.headers.authorization, "Bearer pplx-test-secret-2222");
  const pplxChoice = await service.port.decide({
    subjectRef: "task/pplx-choice",
    providerId: "pplx-local",
    questionSetVersion: "choice/v1",
    state: ["Diff verified."],
    question: {
      type: "choice",
      prompt: "Verdict",
      options: [
        { id: "approve", text: "Approve" },
        { id: "reject", text: "Reject" },
      ],
      criteria: { approve: "pass", reject: "fail" },
    },
  });
  assert.equal(pplxChoice.result.type, "choice");
  assert.equal(pplxChoice.result.selected, "approve");
  assert.equal(pplxChoice.provider.vendor, "perplexity");
  assert.equal(pplxChoice.provider.providerRoute, "perplexity-local");

  // 3) Generic `decisions-http` (`baseUrl` required; `/decisions` with Bearer)
  await assert.rejects(
    service.command({
      kind: "provider-create",
      type: "decisions",
      vendor: "decisions-http",
      providerId: "missing-http-url",
      name: "Missing URL",
      model: "decider-1",
      apiKey: "clef-secret-3333",
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_base_url",
  );
  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "decisions-http",
    providerId: "clef-local",
    name: "Clef Local",
    model: "clef-v1",
    baseUrl: `${mock.origin}/custom`,
    apiKey: "clef-secret-3333",
  });
  await assert.rejects(
    service.command({ kind: "provider-update", providerId: "clef-local", baseUrl: "" }),
    (error: unknown) => (error as { code?: string }).code === "invalid_base_url",
  );
  const clefScore = await service.port.decide({
    subjectRef: "task/clef-score",
    providerId: "clef-local",
    questionSetVersion: "score/v1",
    state: ["Ready."],
    question: {
      type: "score",
      prompt: "Score",
      levels: [
        { id: "s0", text: "Low" },
        { id: "s1", text: "High" },
      ],
      criteria: { s0: "low", s1: "high" },
    },
  });
  assert.equal(captured.at(-1)?.path, "/custom/decisions");
  assert.equal(clefScore.result.type, "score");
  assert.equal(clefScore.result.value, 0.65);
  assert.equal(clefScore.provider.vendor, "decisions-http");

  // 4) `openai-compatible` (default baseUrl allowed; custom loopback `/v1/chat/completions`, finish_reason === "stop")
  const openaiDefault = await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "openai-compatible",
    providerId: "openai-default",
    name: "OpenAI Default",
    model: "gpt-4.1-mini",
    apiKey: "sk-default-4444",
  });
  assert.equal((openaiDefault.provider as { baseUrl: string | null }).baseUrl, null);
  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "openai-compatible",
    providerId: "local-vllm",
    name: "Local vLLM",
    model: "deepseek-r1",
    baseUrl: `${mock.origin}/v1`,
    apiKey: "sk-vllm-5555",
  });
  const openaiChoice = await service.port.decide({
    subjectRef: "dispatch/openai-choice",
    providerId: "local-vllm",
    questionSetVersion: "choice/v1",
    state: ["Transient failure."],
    question: {
      type: "choice",
      prompt: "Choose",
      options: [
        { id: "resume", text: "Resume" },
        { id: "escalate", text: "Escalate" },
      ],
      criteria: { resume: "retry", escalate: "human" },
    },
  });
  assert.equal(captured.at(-1)?.path, "/v1/chat/completions");
  assert.equal(openaiChoice.result.type, "choice");
  assert.equal(openaiChoice.result.selected, "resume");
  assert.equal(openaiChoice.provider.vendor, "openai-compatible");
  assert.deepEqual(openaiChoice.usage, { inputTokens: 18, outputTokens: 7, reportedCost: 0.0004 });

  // 5) `anthropic` (`/v1/messages`, `x-api-key` + `anthropic-version: 2023-06-01`, stop_reason end_turn & stop_sequence)
  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "anthropic",
    providerId: "anthropic-local",
    name: "Anthropic Local",
    model: "claude-sonnet-4-6",
    baseUrl: `${mock.origin}/v1`,
    apiKey: "sk-ant-secret-6666",
  });
  const antNoul = await service.port.decide({
    subjectRef: "task/ant-noul",
    providerId: "anthropic-local",
    questionSetVersion: "noul/v1",
    state: ["Checks green."],
    question: { type: "noul", prompt: "Accept?", criteria: { true: "yes", false: "no" } },
  });
  assert.equal(captured.at(-1)?.path, "/v1/messages");
  assert.equal(captured.at(-1)?.headers["x-api-key"], "sk-ant-secret-6666");
  assert.equal(captured.at(-1)?.headers["anthropic-version"], "2023-06-01");
  assert.equal(antNoul.result.type, "noul");
  assert.equal(antNoul.result.value, 0.84);
  assert.deepEqual(antNoul.usage, { inputTokens: 55, outputTokens: 14, reportedCost: null });

  anthropicStopReason = "stop_sequence";
  const antScore = await service.port.decide({
    subjectRef: "task/ant-score",
    providerId: "anthropic-local",
    questionSetVersion: "score/v1",
    state: ["Good coverage."],
    question: {
      type: "score",
      prompt: "Quality",
      levels: [
        { id: "low", text: "Low" },
        { id: "high", text: "High" },
      ],
      criteria: { low: "poor", high: "strong" },
    },
  });
  assert.equal(antScore.result.type, "score");
  assert.equal(antScore.result.value, 0.81);

  // Wire validator accepts all 6 vendors and rejects unknown vendors.
  for (const vendor of decisionProviderVendors) {
    assert.equal(
      validTaskDispatchRow({
        dispatchId: "dispatch_0123456789abcdef01234567",
        taskId: "task_1",
        executionId: "exe_1",
        runtimeSessionId: "runtime_1",
        instanceId: "inst_1",
        attemptGroupId: "grp_1",
        attemptIndex: 0,
        provider: { instance: "inst_1", model: "model-a" },
        classification: null,
        reason: null,
        fallbackState: null,
        nextDispatchId: null,
        providerSessionId: null,
        eventStreamRef: null,
        startedAt: "2026-11-21T00:00:00.000Z",
        endedAt: null,
        outcome: null,
        status: "running",
        advisories: [
          {
            evaluatedAt: "2026-11-21T00:00:00.000Z",
            pointId: "dispatch-stop-reason",
            questionVersion: "choice/v1",
            selected: "resume",
            distribution: openaiChoice.distribution,
            options: [
              { id: "resume", text: "Resume" },
              { id: "escalate", text: "Escalate" },
            ],
            provider: { ...openaiChoice.provider, vendor },
            usage: openaiChoice.usage,
            latencyMs: 12,
          },
        ],
      }),
      true,
      `wire validator must accept vendor ${vendor}`,
    );
  }
  assert.equal(
    validTaskDispatchRow({
      dispatchId: "dispatch_0123456789abcdef01234567",
      taskId: "task_1",
      executionId: "exe_1",
      runtimeSessionId: "runtime_1",
      instanceId: "inst_1",
      attemptGroupId: "grp_1",
      attemptIndex: 0,
      provider: { instance: "inst_1", model: "model-a" },
      classification: null,
      reason: null,
      fallbackState: null,
      nextDispatchId: null,
      providerSessionId: null,
      eventStreamRef: null,
      startedAt: "2026-11-21T00:00:00.000Z",
      endedAt: null,
      outcome: null,
      status: "running",
      advisories: [
        {
          evaluatedAt: "2026-11-21T00:00:00.000Z",
          pointId: "dispatch-stop-reason",
          questionVersion: "choice/v1",
          selected: "resume",
          distribution: openaiChoice.distribution,
          options: [
            { id: "resume", text: "Resume" },
            { id: "escalate", text: "Escalate" },
          ],
          provider: { ...openaiChoice.provider, vendor: "unknown-vendor" },
          usage: openaiChoice.usage,
          latencyMs: 12,
        },
      ],
    }),
    false,
  );
});

test("HA10-01: all HTTP adapters (including openrouter) reject 302/307 redirects without issuing a second hop or retrying", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-dp-redirect-"));
  const { vault } = createMemoryVault();
  let targetHits = 0;
  let sourceHits = 0;
  let redirectStatus = 302;

  const targetServer = await startLoopbackServer((_req, _body, res) => {
    targetHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const redirectServer = await startLoopbackServer((_req, _body, res) => {
    sourceHits += 1;
    res.writeHead(redirectStatus, { location: `${targetServer.origin}/stolen` });
    res.end();
  });

  t.after(async () => {
    await redirectServer.close();
    await targetServer.close();
    removeTempRepository(parent);
  });

  const delays: number[] = [];
  const service = openDecisionProviderService({
    userRoot: parent,
    vault,
    now: () => "2026-11-21T00:00:00.000Z",
    sleep: async (ms) => void delays.push(ms),
  });

  for (const [vendor, status] of [
    ["openai-compatible", 302],
    ["google", 307],
    ["anthropic", 302],
    ["decisions-http", 307],
    ["openrouter", 307],
  ] as const) {
    redirectStatus = status;
    sourceHits = 0;
    delays.length = 0;
    const id = `redir-${vendor}`;
    await service.command({
      kind: "provider-create",
      type: "decisions",
      vendor,
      providerId: id,
      name: `Redirect ${vendor}`,
      model: "test-model",
      baseUrl: `${redirectServer.origin}/v1`,
      apiKey: "sk-redirect-secret-9999",
    });
    await assert.rejects(service.command({ kind: "provider-probe", providerId: id }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "decision_transport");
      assert.equal((error as { retries?: number }).retries, 0);
      assert.match(error.message, /redirect/iu);
      return true;
    });
    assert.equal(sourceHits, 1, `${vendor} probe must not retry redirects`);
    assert.equal(targetHits, 0, `${vendor} probe must never follow redirect to second hop`);
    assert.deepEqual(delays, []);

    sourceHits = 0;
    await assert.rejects(
      service.port.decide({
        subjectRef: `task/redir-${vendor}`,
        providerId: id,
        questionSetVersion: "noul/v1",
        state: ["Sensitive decision payload that must not be redirected."],
        question: { type: "noul", prompt: "Proceed?", criteria: { true: "yes", false: "no" } },
      }),
      (error: unknown) => (error as { code?: string }).code === "decision_transport",
    );
    assert.equal(sourceHits, 1);
    assert.equal(targetHits, 0, `${vendor} decide must never follow redirect to second hop`);
  }
});

test("HA10-02: upstream error bodies with short keys, partial keys, or echoed context never leak into receipts", async (t) => {
  // Unit verify redactDecisionSecret for short keys without mangling English words + redaction before truncation.
  assert.equal(
    redactDecisionSecret("The model is unavailable; key=ab rejected.", "ab"),
    "The model is unavailable; key=[redacted] rejected.",
  );
  const longText = `${"x".repeat(450)} secret=sk-long-tail-9876`;
  const redactedLong = redactDecisionSecret(longText, "sk-long-tail-9876");
  assert.equal(redactedLong.includes("sk-long-tail-9876"), false);

  const parent = mkdtempSync(path.join(tmpdir(), "ha-dp-error-redaction-"));
  const { vault } = createMemoryVault();
  const shortKey = "k1";
  const echoedContext = "CONFIDENTIAL_CUSTOMER_CONTEXT_9981";
  const partialSecret = "sk-part-777";
  const sensitiveUpstreamCode = "SECRET_TENANT_ERR_42";
  const sensitiveUpstreamType = "INTERNAL_SECRET_TYPE_88";
  const sensitiveUpstreamStatus = "PRIVATE_UPSTREAM_STATUS_77";
  let mode: "401-raw" | "401-json-sensitive" | "404-google" | "500-html" | "429-once" | "hang" = "401-raw";
  let hits = 0;
  const openSockets = new Set<Socket>();

  const mock = await startLoopbackServer((req, _body, res) => {
    hits += 1;
    if (mode === "hang") {
      if (req.socket) openSockets.add(req.socket);
      return;
    }
    if (mode === "401-raw") {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end(
        `${"padding-".repeat(60)} Unauthorized short=${shortKey} partial=${partialSecret} context=${echoedContext}`,
      );
      return;
    }
    if (mode === "401-json-sensitive") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: sensitiveUpstreamCode,
            type: sensitiveUpstreamType,
            status: sensitiveUpstreamStatus,
            message: `Rejected key=${shortKey} partial=${partialSecret} context=${echoedContext}`,
          },
        }),
      );
      return;
    }
    if (mode === "404-google") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: sensitiveUpstreamCode,
            status: sensitiveUpstreamStatus,
            message: `models/gemini-decision-999 is not found while inspecting ${echoedContext} key=${shortKey}`,
          },
        }),
      );
      return;
    }
    if (mode === "500-html") {
      res.writeHead(500, { "content-type": "text/html" });
      res.end(`<html><body>500 crash echoing ${echoedContext} and ${shortKey}</body></html>`);
      return;
    }
    if (hits === 1) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "rate_limit_exceeded", message: `Rate limited ${echoedContext}` } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "gemini-decision-1",
        usage: { total_input_tokens: 10, total_output_tokens: 0 },
        answers: { decision: { type: "noul", noul: 0.6 } },
      }),
    );
  });

  const closedMock = await startLoopbackServer((_req, _body, res) => res.end());
  const closedOrigin = closedMock.origin;
  await closedMock.close();

  t.after(async () => {
    for (const socket of openSockets) socket.destroy();
    await mock.close();
    removeTempRepository(parent);
  });

  const delays: number[] = [];
  const service = openDecisionProviderService({
    userRoot: parent,
    vault,
    now: () => "2026-11-21T00:00:00.000Z",
    sleep: async (ms) => void delays.push(ms),
    requestTimeoutMs: 60,
  });

  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "google",
    providerId: "goog-err",
    name: "Google Err",
    model: "gemini-decision-999",
    baseUrl: `${mock.origin}/v1beta`,
    apiKey: shortKey,
  });
  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "openrouter",
    providerId: "or-err",
    name: "OpenRouter Err",
    model: "perplexity/pplx-decider-v1.3",
    baseUrl: `${mock.origin}/api/alpha`,
    apiKey: shortKey,
  });
  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "openai-compatible",
    providerId: "offline-gw",
    name: "Offline GW",
    model: "deepseek-r1",
    baseUrl: `${closedOrigin}/v1`,
    apiKey: shortKey,
  });

  const req = (providerId: string) => ({
    subjectRef: "dispatch/ha10-02",
    providerId,
    questionSetVersion: "noul/v1",
    state: [echoedContext] as const,
    question: { type: "noul" as const, prompt: "Ready?", criteria: { true: "yes", false: "no" } },
  });

  // 401 raw text with short key + partial key + echoed context -> zero pass-through
  mode = "401-raw";
  await assert.rejects(service.port.decide(req("goog-err")), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, "provider_credential_unavailable");
    assert.equal((error as { retries?: number }).retries, 0);
    assert.match(error.message, /HTTP 401/u);
    assert.match(error.message, /code=http_401/u);
    assert.match(error.message, /Google Gemini Decisions API/u);
    assert.equal(error.message.includes(shortKey), false);
    assert.equal(error.message.includes(partialSecret), false);
    assert.equal(error.message.includes(echoedContext), false);
    return true;
  });

  // 401 JSON with compact sensitive upstream code/type/status/message -> zero leakage on BOTH google and openrouter
  mode = "401-json-sensitive";
  for (const pid of ["goog-err", "or-err"] as const) {
    await assert.rejects(service.port.decide(req(pid)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_credential_unavailable");
      assert.match(error.message, /HTTP 401/u);
      assert.match(error.message, /code=http_401/u);
      for (const forbidden of [
        sensitiveUpstreamCode,
        sensitiveUpstreamType,
        sensitiveUpstreamStatus,
        shortKey,
        partialSecret,
        echoedContext,
      ]) {
        assert.equal(error.message.includes(forbidden), false, `${pid} leaked ${forbidden}: ${error.message}`);
      }
      return true;
    });
  }

  // 404 Google model unavailable -> decision_model_unavailable + operator command + zero upstream code/status/message
  mode = "404-google";
  await assert.rejects(service.port.decide(req("goog-err")), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, "decision_model_unavailable");
    assert.match(error.message, /ha provider update goog-err --model/u);
    assert.match(error.message, /code=model_unavailable/u);
    assert.equal(error.message.includes(sensitiveUpstreamCode), false);
    assert.equal(error.message.includes(sensitiveUpstreamStatus), false);
    assert.equal(error.message.includes(echoedContext), false);
    assert.equal(error.message.includes(shortKey), false);
    return true;
  });

  // 500 HTML -> retried 3 times, zero HTML / echoed context leaked
  mode = "500-html";
  hits = 0;
  delays.length = 0;
  await assert.rejects(service.port.decide(req("goog-err")), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, "decision_transport");
    assert.equal((error as { retries?: number }).retries, 3);
    assert.match(error.message, /HTTP 500/u);
    assert.equal(error.message.includes("<html>"), false);
    assert.equal(error.message.includes(echoedContext), false);
    return true;
  });
  assert.equal(hits, 4);
  assert.deepEqual(delays, [250, 500, 1_000]);

  // 429 transient recovery
  mode = "429-once";
  hits = 0;
  delays.length = 0;
  const recovered = await service.port.decide(req("goog-err"));
  assert.equal(recovered.result.type, "noul");
  assert.equal(hits, 2);
  assert.deepEqual(delays, [250]);

  // Timeout + ECONNREFUSED
  mode = "hang";
  hits = 0;
  delays.length = 0;
  await assert.rejects(service.port.decide(req("goog-err")), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "decision_timeout");
    assert.equal((error as { retries?: number }).retries, 3);
    return true;
  });
  assert.equal(hits, 4);

  delays.length = 0;
  await assert.rejects(service.port.decide(req("offline-gw")), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "decision_transport");
    assert.equal((error as { retries?: number }).retries, 3);
    return true;
  });
  assert.deepEqual(delays, [250, 500, 1_000]);
});

test("HA10-03 & HA10-04: rejects bad probability sums, truncated completions, invalid persisted URLs on update/probe, and preserves constructor/__proto__ option keys", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-dp-ha10-03-04-"));
  const { vault } = createMemoryVault();
  let replyBody: Record<string, unknown> = {};

  const mock = await startLoopbackServer((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(replyBody));
  });

  t.after(async () => {
    await mock.close();
    removeTempRepository(parent);
  });

  const service = openDecisionProviderService({
    userRoot: parent,
    vault,
    now: () => "2026-11-21T00:00:00.000Z",
    sleep: async () => undefined,
  });

  // HA10-04: reject bare ?, bare #, query, fragment, credentials, cleartext remote HTTP on create
  for (const badUrl of [
    "https://gateway.example/v1?",
    "https://gateway.example/v1#",
    "https://gateway.example/v1?x=1",
    "https://gateway.example/v1#frag",
    "https://user:pass@gateway.example/v1",
    "http://gateway.example/v1",
  ]) {
    await assert.rejects(
      service.command({
        kind: "provider-create",
        type: "decisions",
        vendor: "openai-compatible",
        providerId: "bad-url",
        name: "Bad URL",
        model: "deepseek-r1",
        baseUrl: badUrl,
        apiKey: "sk-test-1234",
      }),
      (error: unknown) => (error as { code?: string }).code === "invalid_base_url",
      `create must reject ${badUrl}`,
    );
  }

  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "openai-compatible",
    providerId: "oai",
    name: "OAI",
    model: "deepseek-r1",
    baseUrl: `${mock.origin}/v1`,
    apiKey: "sk-test-1234",
  });
  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "anthropic",
    providerId: "ant",
    name: "ANT",
    model: "claude-sonnet-4-6",
    baseUrl: `${mock.origin}/v1`,
    apiKey: "sk-ant-1234",
  });

  const choiceReq = (providerId: string) => ({
    subjectRef: "dispatch/ha10-03",
    providerId,
    questionSetVersion: "choice/v1",
    state: ["Evaluate."],
    question: {
      type: "choice" as const,
      prompt: "Pick",
      options: [
        { id: "yes", text: "Yes" },
        { id: "no", text: "No" },
      ],
      criteria: { yes: "y", no: "n" },
    },
  });

  // HA10-03: sum != 1 rejected (0.8 + 0.8 = 1.6 and 0.2 + 0.2 = 0.4)
  for (const badProbs of [
    { yes: 0.8, no: 0.8 },
    { yes: 0.2, no: 0.2 },
  ]) {
    replyBody = {
      model: "deepseek-r1",
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify({ type: "choice", choice: "yes", probabilities: badProbs }) },
        },
      ],
    };
    await assert.rejects(
      service.port.decide(choiceReq("oai")),
      (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
    );
  }

  // HA10-03: truncated / filtered / missing finish_reason rejected even with valid JSON content
  for (const badFinish of ["length", "content_filter", undefined]) {
    replyBody = {
      model: "deepseek-r1",
      choices: [
        {
          ...(badFinish === undefined ? {} : { finish_reason: badFinish }),
          message: { content: JSON.stringify({ type: "choice", choice: "yes", probabilities: { yes: 0.7, no: 0.3 } }) },
        },
      ],
    };
    await assert.rejects(
      service.port.decide(choiceReq("oai")),
      (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
      `openai-compatible must reject finish_reason=${String(badFinish)}`,
    );
  }

  // HA10-03: Anthropic truncated/filtered stop_reason rejected
  for (const badStop of ["max_tokens", "refusal", undefined]) {
    replyBody = {
      model: "claude-sonnet-4-6",
      ...(badStop === undefined ? {} : { stop_reason: badStop }),
      content: [
        { type: "text", text: JSON.stringify({ type: "choice", choice: "yes", probabilities: { yes: 0.7, no: 0.3 } }) },
      ],
    };
    await assert.rejects(
      service.port.decide(choiceReq("ant")),
      (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
      `anthropic must reject stop_reason=${String(badStop)}`,
    );
  }

  // HA10-03: special JS property names (`constructor`, `toString`, `__proto__`) preserved safely in null-proto distribution
  replyBody = {
    model: "deepseek-r1",
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            type: "choice",
            choice: "constructor",
            probabilities: { constructor: 0.7, toString: 0.3 },
          }),
        },
      },
    ],
  };
  const specialChoice = await service.port.decide({
    subjectRef: "dispatch/constructor-key",
    providerId: "oai",
    questionSetVersion: "choice/v1",
    state: ["Verify constructor option key."],
    question: {
      type: "choice",
      prompt: "Choose key",
      options: [
        { id: "constructor", text: "Constructor" },
        { id: "toString", text: "ToString" },
      ],
      criteria: { constructor: "use constructor", toString: "use toString" },
    },
  });
  assert.equal(specialChoice.result.type, "choice");
  assert.equal(specialChoice.result.selected, "constructor");
  assert.equal(Object.getPrototypeOf(specialChoice.distribution), null);
  assert.equal(Object.hasOwn(specialChoice.distribution, "constructor"), true);
  assert.equal(specialChoice.distribution.constructor, 0.7);
  assert.equal(specialChoice.distribution.toString, 0.3);

  // Missing `constructor` in response must be rejected (not fooled by Object.prototype.constructor)
  replyBody = {
    model: "deepseek-r1",
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            type: "choice",
            choice: "toString",
            probabilities: { toString: 1.0 },
          }),
        },
      },
    ],
  };
  await assert.rejects(
    service.port.decide({
      subjectRef: "dispatch/constructor-missing",
      providerId: "oai",
      questionSetVersion: "choice/v1",
      state: ["Verify missing constructor fails."],
      question: {
        type: "choice",
        prompt: "Choose key",
        options: [
          { id: "constructor", text: "Constructor" },
          { id: "toString", text: "ToString" },
        ],
        criteria: { constructor: "use constructor", toString: "use toString" },
      },
    }),
    (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
  );

  // HA10-04: corrupted persisted baseUrl on disk is rejected on update (inherited), probe, and decide
  const configPath = path.join(parent, "decision-providers.json");
  const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
    schema: string;
    providers: Record<string, unknown>[];
  };
  rawConfig.providers[0]!.baseUrl = "https://gateway.example/v1?";
  writeFileSync(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, { mode: 0o600 });

  const reloaded = openDecisionProviderService({
    userRoot: parent,
    vault,
    now: () => "2026-11-21T00:00:00.000Z",
    sleep: async () => undefined,
  });
  await assert.rejects(
    reloaded.command({ kind: "provider-update", providerId: "oai", model: "deepseek-v3" }),
    (error: unknown) => (error as { code?: string }).code === "invalid_base_url",
  );
  await assert.rejects(
    reloaded.command({ kind: "provider-probe", providerId: "oai" }),
    (error: unknown) => (error as { code?: string }).code === "invalid_base_url",
  );
  assert.equal(reloaded.list().find(({ providerId }) => providerId === "oai")?.probe.state, "failed");

  // Repairing baseUrl via provider-update succeeds cleanly
  const repaired = await reloaded.command({
    kind: "provider-update",
    providerId: "oai",
    baseUrl: `${mock.origin}/v1`,
  });
  assert.equal((repaired.provider as { baseUrl: string }).baseUrl, `${mock.origin}/v1`);
});

test("HA10-03 & HA10-07: openrouter uses the shared direct HTTP pipeline for URL determinism, stop_reason rejection, probe validation, and __proto__/constructor preservation", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-dp-openrouter-unified-"));
  const { vault } = createMemoryVault();
  const seenPaths: string[] = [];
  const seenAuths: (string | undefined)[] = [];
  let replyRawJson = "";

  const mock = await startLoopbackServer((req, _body, res) => {
    seenPaths.push(req.url ?? "");
    seenAuths.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(replyRawJson);
  });

  t.after(async () => {
    await mock.close();
    removeTempRepository(parent);
  });

  const service = openDecisionProviderService({
    userRoot: parent,
    vault,
    now: () => "2026-11-21T00:00:00.000Z",
    sleep: async () => undefined,
  });

  // HA10-07: legacy root loopback origin resolves to `/api/alpha/decisions`, while custom
  // non-default `/api/alpha` paths keep the exact legacy SDK suffix (`/api/alpha/api/alpha/decisions`)
  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "openrouter",
    providerId: "or-legacy-root",
    name: "OR Legacy Root",
    model: "perplexity/pplx-decider-v1.3",
    baseUrl: mock.origin,
    apiKey: "sk-or-test-key",
  });
  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "openrouter",
    providerId: "or-custom-alpha",
    name: "OR Custom Alpha",
    model: "perplexity/pplx-decider-v1.3",
    baseUrl: `${mock.origin}/api/alpha`,
    apiKey: "sk-or-test-key",
  });

  replyRawJson = JSON.stringify({
    model: "perplexity/pplx-decider-v1.3",
    provider: "Perplexity",
    stop_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 0, cost: 0.0001 },
    answers: { decision: { type: "noul", noul: 0.85 } },
  });

  for (const [pid, expectedPath] of [
    ["or-legacy-root", "/api/alpha/decisions"],
    ["or-custom-alpha", "/api/alpha/api/alpha/decisions"],
  ] as const) {
    seenPaths.length = 0;
    seenAuths.length = 0;
    const probe = await service.command({ kind: "provider-probe", providerId: pid });
    assert.equal((probe.provider as { probe: { state: string } }).probe.state, "ready");
    assert.deepEqual(seenPaths, [expectedPath]);
    assert.deepEqual(seenAuths, ["Bearer sk-or-test-key"]);
  }

  // HA10-03: openrouter preserves BOTH `constructor` and `__proto__` probability keys via shared null-proto decoding
  replyRawJson =
    '{"model":"perplexity/pplx-decider-v1.3","stop_reason":"stop","usage":{"input_tokens":14,"output_tokens":0},"answers":{"decision":{"type":"choice","choice":"__proto__","probabilities":{"constructor":0.3,"__proto__":0.7}}}}';
  const protoCriteria = Object.setPrototypeOf({}, null) as Record<string, string>;
  protoCriteria.constructor = "choose constructor";
  Object.defineProperty(protoCriteria, "__proto__", {
    value: "choose proto",
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const protoResult = await service.port.decide({
    subjectRef: "dispatch/openrouter-proto-keys",
    providerId: "or-legacy-root",
    questionSetVersion: "choice/v1",
    state: ["Evaluate special keys."],
    question: {
      type: "choice",
      prompt: "Pick key",
      options: [
        { id: "constructor", text: "Constructor" },
        { id: "__proto__", text: "Proto" },
      ],
      criteria: protoCriteria,
    },
  });
  assert.equal(protoResult.result.type, "choice");
  assert.equal(protoResult.result.selected, "__proto__");
  assert.equal(Object.getPrototypeOf(protoResult.distribution), null);
  assert.equal(Object.hasOwn(protoResult.distribution, "constructor"), true);
  assert.equal(Object.hasOwn(protoResult.distribution, "__proto__"), true);
  assert.equal(protoResult.distribution.constructor, 0.3);
  assert.equal(protoResult.distribution["__proto__"], 0.7);

  // HA10-03: openrouter rejects abnormal stop_reason (`max_tokens`, `content_filter`) and mixed
  // termination fields (e.g. normal finish_reason paired with abnormal stop_reason/stopReason)
  // on BOTH probe AND decide
  for (const termination of [
    { stop_reason: "max_tokens" },
    { stop_reason: "content_filter" },
    { finish_reason: "stop", stop_reason: "max_tokens" },
    { finishReason: "STOP", stopReason: "content_filter" },
    { finish_reason: "content_filter", stop_reason: "stop" },
  ]) {
    const label = JSON.stringify(termination);
    replyRawJson = JSON.stringify({
      model: "perplexity/pplx-decider-v1.3",
      ...termination,
      usage: { input_tokens: 3, output_tokens: 0 },
      answers: { decision: { type: "noul", noul: 0.9 } },
    });
    await assert.rejects(
      service.command({ kind: "provider-probe", providerId: "or-legacy-root" }),
      (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
      `openrouter probe must reject termination=${label}`,
    );
    assert.deepEqual(service.list().find(({ providerId }) => providerId === "or-legacy-root")?.probe, {
      state: "failed",
      checkedAt: "2026-11-21T00:00:00.000Z",
      code: "decision_protocol_invalid",
    });

    const terminationFields = Object.entries(termination)
      .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
      .join(",");
    replyRawJson = `{"model":"perplexity/pplx-decider-v1.3",${terminationFields},"usage":{"input_tokens":3,"output_tokens":0},"answers":{"decision":{"type":"choice","choice":"constructor","probabilities":{"constructor":0.7,"__proto__":0.3}}}}`;
    await assert.rejects(
      service.port.decide({
        subjectRef: `dispatch/openrouter-bad-stop-${Object.values(termination).join("-")}`,
        providerId: "or-legacy-root",
        questionSetVersion: "choice/v1",
        state: ["Evaluate stop_reason."],
        question: {
          type: "choice",
          prompt: "Pick key",
          options: [
            { id: "constructor", text: "Constructor" },
            { id: "__proto__", text: "Proto" },
          ],
          criteria: protoCriteria,
        },
      }),
      (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
      `openrouter decide must reject termination=${label}`,
    );
  }

  // HA10-03 positive control: multiple normal termination fields together still succeed
  replyRawJson = JSON.stringify({
    model: "perplexity/pplx-decider-v1.3",
    finish_reason: "stop",
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 0 },
    answers: { decision: { type: "noul", noul: 0.8 } },
  });
  const dualNormalProbe = await service.command({ kind: "provider-probe", providerId: "or-legacy-root" });
  assert.equal((dualNormalProbe.provider as { probe: { state: string } }).probe.state, "ready");

  // HA10-03: openrouter probe rejects invalid/missing `answers.decision` and out-of-range noul with decision_protocol_invalid
  for (const badProbeBody of [
    JSON.stringify({
      model: "perplexity/pplx-decider-v1.3",
      usage: { input_tokens: 1, output_tokens: 0 },
      answers: {},
    }),
    JSON.stringify({
      model: "perplexity/pplx-decider-v1.3",
      usage: { input_tokens: 1, output_tokens: 0 },
      answers: { decision: { type: "noul", noul: 1.5 } },
    }),
  ]) {
    replyRawJson = badProbeBody;
    await assert.rejects(
      service.command({ kind: "provider-probe", providerId: "or-legacy-root" }),
      (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
    );
  }
});

test("HA10-07: persisted legacy OpenRouter custom proxy prefixes (including /gateway and /proxy/api/alpha) preserve exact historical SDK routes on probe and decide", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-dp-openrouter-proxy-"));
  const { vault } = createMemoryVault();
  const seenPaths: string[] = [];

  // Serve ONLY the historical `@openrouter/sdk` routes (`<baseUrl>/api/alpha/decisions`) and 404
  // every rewritten path (including `/gateway/decisions` and `/proxy/api/alpha/decisions`).
  const allowedPaths = new Set(["/gateway/api/alpha/decisions", "/proxy/api/alpha/api/alpha/decisions"]);
  const mock = await startLoopbackServer((req, _body, res) => {
    const pathname = req.url ?? "";
    seenPaths.push(pathname);
    if (req.method === "POST" && allowedPaths.has(pathname)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "perplexity/pplx-decider-v1.3",
          provider: "Perplexity",
          usage: { input_tokens: 8, output_tokens: 0 },
          answers: { decision: { type: "noul", noul: 0.91 } },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: 404, message: "Not Found" } }));
  });

  t.after(async () => {
    await mock.close();
    removeTempRepository(parent);
  });

  const credRef = vault.issue();
  await vault.store(credRef, "sk-or-proxy-key");

  // Seed persisted pre-upgrade decision-providers.json records (without `vendor` field)
  writeFileSync(
    path.join(parent, "decision-providers.json"),
    `${JSON.stringify(
      {
        schema: "decision-providers/v1",
        providers: [
          {
            schema: "decision-provider/v1",
            providerId: "or-legacy-gateway",
            name: "Legacy Gateway",
            providerType: "decisions",
            model: "perplexity/pplx-decider-v1.3",
            baseUrl: `${mock.origin}/gateway`,
            auth: { mode: "api-key", credentialRef: credRef },
            enabled: true,
            configurationRevision: 1,
            configurationId: "legacy-gateway-1",
            probe: { state: "unknown" },
          },
          {
            schema: "decision-provider/v1",
            providerId: "or-legacy-proxy-alpha",
            name: "Legacy Proxy Ending In Alpha",
            providerType: "decisions",
            model: "perplexity/pplx-decider-v1.3",
            baseUrl: `${mock.origin}/proxy/api/alpha`,
            auth: { mode: "api-key", credentialRef: credRef },
            enabled: true,
            configurationRevision: 1,
            configurationId: "legacy-proxy-alpha-1",
            probe: { state: "unknown" },
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const service = openDecisionProviderService({
    userRoot: parent,
    vault,
    now: () => "2026-11-21T00:00:00.000Z",
    sleep: async () => undefined,
  });

  for (const [providerId, expectedPath] of [
    ["or-legacy-gateway", "/gateway/api/alpha/decisions"],
    ["or-legacy-proxy-alpha", "/proxy/api/alpha/api/alpha/decisions"],
  ] as const) {
    seenPaths.length = 0;
    const probe = await service.command({ kind: "provider-probe", providerId });
    assert.equal((probe.provider as { probe: { state: string } }).probe.state, "ready");
    const decision = await service.port.decide({
      subjectRef: `dispatch/${providerId}`,
      providerId,
      questionSetVersion: "noul/v1",
      state: ["Verify legacy proxy path compatibility."],
      question: {
        type: "noul",
        prompt: "Does the legacy proxy accept this request?",
        criteria: { true: `It reaches ${expectedPath}.`, false: "It misses the route." },
      },
    });
    assert.equal(decision.result.type, "noul");
    assert.equal(decision.result.value, 0.91);
    assert.deepEqual(seenPaths, [expectedPath, expectedPath]);
  }
});
