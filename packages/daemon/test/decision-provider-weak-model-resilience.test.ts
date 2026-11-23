// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import type { CredentialPort } from "../src/daemon-host/agent-runtime-credential-port.ts";
import { openDecisionProviderService } from "../src/daemon-host/decision-provider.ts";
import {
  decodeStructuredDecisionJson,
  MAX_STRUCTURED_DECISION_CHARS,
  sanitizeStructuredDecisionText,
} from "../src/daemon-host/decision-providers/normalize.ts";
import { MAX_DECISION_RESPONSE_BYTES } from "../src/daemon-host/decision-providers/transport.ts";
import type { DecisionProviderQuestion } from "../src/daemon-host/decision-providers/types.ts";

const choiceWithAbstain: DecisionProviderQuestion = {
  type: "choice",
  instructions: "Select the incident disposition.",
  criteria: {
    resume: { label: "Resume", criterion: "Continue the same session." },
    rerun: { label: "Rerun", criterion: "Launch a fresh attempt." },
    needs_attention: { label: "Needs attention", criterion: "Escalate to the owner." },
  },
  abstainOptionId: "needs_attention",
};

const choiceWithoutAbstain: DecisionProviderQuestion = {
  type: "choice",
  instructions: "Select the incident disposition.",
  criteria: {
    resume: { label: "Resume", criterion: "Continue the same session." },
    needs_attention: { label: "Needs attention", criterion: "Escalate to the owner." },
  },
};

function createMemoryVault(): CredentialPort {
  const store = new Map<string, string>();
  let seq = 0;
  return {
    issue: () => `credential:v1:weak-${String(++seq)}`,
    store: async (ref, secret) => void store.set(ref, secret),
    resolve: async (ref) => {
      const value = store.get(ref);
      if (!value) throw Object.assign(new Error("unavailable"), { code: "runtime_credential_unavailable" });
      return value;
    },
    remove: async (ref) => void store.delete(ref),
  };
}

async function startServer(
  handler: (reqCount: number, res: import("node:http").ServerResponse) => void,
): Promise<{ readonly origin: string; readonly close: () => Promise<void>; readonly hits: () => number }> {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits += 1;
    handler(hits, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(addr.port)}`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

test("G11-1: deterministic sanitizer strips <think>/<thinking>/<reasoning> prefixes and rejects unclosed reasoning tags", () => {
  // Positive: Qwen/DeepSeek-R1 style <think> prefix + valid JSON
  const withThink = `<think>\nThe worker exited after a transient network error.\nMaybe {"draft": true} inside think should be ignored.\n</think>\n{"type":"choice","choice":"resume","probabilities":{"resume":0.85,"rerun":0.05,"needs_attention":0.1}}`;
  const decoded = decodeStructuredDecisionJson(withThink, choiceWithAbstain, "OpenAI-compatible endpoint");
  assert.equal(decoded.type, "choice");
  assert.equal(decoded.choice, "resume");
  assert.equal(decoded.probabilities.resume, 0.85);
  assert.equal(Object.getPrototypeOf(decoded.probabilities), null);

  // Positive: <reasoning> + <THINKING> case-insensitive blocks
  const withReasoning = `<REASONING>Check evidence.</REASONING><thinking>Confirm resume.</thinking>{"type":"choice","choice":"rerun","probabilities":{"resume":0.1,"rerun":0.8,"needs_attention":0.1}}`;
  const decodedReasoning = decodeStructuredDecisionJson(withReasoning, choiceWithAbstain, "OpenAI-compatible endpoint");
  assert.equal(decodedReasoning.type, "choice");
  assert.equal(decodedReasoning.choice, "rerun");
  const jsonStringContainingReasoningTags = '{"note":"<think>literal text</think>"}';
  assert.equal(sanitizeStructuredDecisionText(jsonStringContainingReasoningTags), jsonStringContainingReasoningTags);

  const jsonStringContainingFence = '{"note":"literal ```json {not a delimiter}``` text"}';
  assert.equal(sanitizeStructuredDecisionText(jsonStringContainingFence), jsonStringContainingFence);

  // Negative: unclosed <think> tag degrades honestly to abstainOptionId (and throws when undeclared)
  const unclosedThink = `<think>still reasoning about resume... {"type":"choice","choice":"resume","probabilities":{"resume":1,"rerun":0,"needs_attention":0}}`;
  const abstained = decodeStructuredDecisionJson(unclosedThink, choiceWithAbstain, "OpenAI-compatible endpoint");
  assert.equal(abstained.type, "choice");
  assert.equal(abstained.choice, "needs_attention");
  assert.equal(abstained.probabilities.needs_attention, 1);
  assert.equal(abstained.probabilities.resume, 0);
  assert.throws(
    () => decodeStructuredDecisionJson(unclosedThink, choiceWithoutAbstain, "OpenAI-compatible endpoint"),
    (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
  );
});

test("G11-2: deterministic sanitizer extracts outer Markdown fences with trailing commas and rejects ambiguous multi-fence outputs", () => {
  // Positive: prose + fenced JSON + trailing commas
  const fencedWithTrailingComma = [
    "根据日志分析，建议继续执行：",
    "```json",
    "{",
    '  "type": "choice",',
    '  "choice": "resume",',
    '  "probabilities": {',
    '    "resume": 0.75,',
    '    "rerun": 0.15,',
    '    "needs_attention": 0.10,',
    "  },",
    "}",
    "```",
    "以上为结论。",
  ].join("\n");
  const decoded = decodeStructuredDecisionJson(
    fencedWithTrailingComma,
    choiceWithAbstain,
    "OpenAI-compatible endpoint",
  );
  assert.equal(decoded.type, "choice");
  assert.equal(decoded.choice, "resume");
  assert.equal(decoded.probabilities.resume, 0.75);

  // Negative: multiple competing fences are ambiguous -> honestly degrade to abstainOptionId
  const multiFence = [
    "```json",
    '{"type":"choice","choice":"resume","probabilities":{"resume":0.9,"rerun":0.05,"needs_attention":0.05}}',
    "```",
    "or alternatively:",
    "```json",
    '{"type":"choice","choice":"rerun","probabilities":{"resume":0.1,"rerun":0.8,"needs_attention":0.1}}',
    "```",
  ].join("\n");
  const abstained = decodeStructuredDecisionJson(multiFence, choiceWithAbstain, "OpenAI-compatible endpoint");
  assert.equal(abstained.type, "choice");
  assert.equal(abstained.choice, "needs_attention");
  assert.equal(abstained.probabilities.needs_attention, 1);
  assert.throws(
    () => decodeStructuredDecisionJson(multiFence, choiceWithoutAbstain, "OpenAI-compatible endpoint"),
    (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
  );

  const outsideAndInsideFence = [
    '{"draft":true}',
    "```json",
    '{"type":"choice","choice":"resume","probabilities":{"resume":0.9,"rerun":0.05,"needs_attention":0.05}}',
    "```",
  ].join("\n");
  assert.equal(
    decodeStructuredDecisionJson(outsideAndInsideFence, choiceWithAbstain, "OpenAI-compatible endpoint").choice,
    "needs_attention",
  );

  const insideAndOutsideCandidates = [
    "```json",
    '{"draft":true}',
    "```",
    '{"type":"choice","choice":"resume","probabilities":{"resume":0.9,"rerun":0.05,"needs_attention":0.05}}',
  ].join("\n");
  assert.equal(
    decodeStructuredDecisionJson(insideAndOutsideCandidates, choiceWithAbstain, "OpenAI-compatible endpoint").choice,
    "needs_attention",
  );

  // Positive: outer Markdown fence wrapping valid JSON whose string literals contain triple backticks and reasoning tags
  const choiceWithBacktickOption: DecisionProviderQuestion = {
    type: "choice",
    instructions: "Select the incident disposition.",
    criteria: {
      "resume```": { label: "Resume", criterion: "Continue the same session." },
      needs_attention: { label: "Needs attention", criterion: "Escalate to the owner." },
    },
    abstainOptionId: "needs_attention",
  };
  const fencedWithBacktickLiteral = [
    "```json",
    '{"type":"choice","choice":"resume```","probabilities":{"resume```":1,"needs_attention":0}}',
    "```",
  ].join("\n");
  const decodedBacktickLiteral = decodeStructuredDecisionJson(
    fencedWithBacktickLiteral,
    choiceWithBacktickOption,
    "OpenAI-compatible endpoint",
  );
  assert.equal(decodedBacktickLiteral.type, "choice");
  assert.equal(decodedBacktickLiteral.choice, "resume```");
  assert.equal(decodedBacktickLiteral.probabilities["resume```"], 1);
  assert.equal(decodedBacktickLiteral.probabilities.needs_attention, 0);

  const thinkAndFencedWithBacktickAndTagLiterals = [
    "<think>Evaluating option containing ``` and <think> tags.</think>",
    "```json",
    '{"type":"choice","choice":"resume```","probabilities":{"resume```":0.9,"needs_attention":0.1,},"note":"<think>keep```</think>",}',
    "```",
  ].join("\n");
  const decodedCombo = decodeStructuredDecisionJson(
    thinkAndFencedWithBacktickAndTagLiterals,
    choiceWithBacktickOption,
    "OpenAI-compatible endpoint",
  );
  assert.equal(decodedCombo.type, "choice");
  assert.equal(decodedCombo.choice, "resume```");
  assert.equal(decodedCombo.probabilities["resume```"], 0.9);

  // Negative: unclosed outer fence with triple backticks inside JSON string must still abstain / fail
  const unclosedOuterFenceWithInnerBackticks = [
    "```json",
    '{"type":"choice","choice":"resume```","probabilities":{"resume```":1,"needs_attention":0}}',
  ].join("\n");
  assert.equal(
    decodeStructuredDecisionJson(
      unclosedOuterFenceWithInnerBackticks,
      choiceWithBacktickOption,
      "OpenAI-compatible endpoint",
    ).choice,
    "needs_attention",
  );
  assert.throws(
    () =>
      decodeStructuredDecisionJson(
        unclosedOuterFenceWithInnerBackticks,
        {
          type: "choice",
          instructions: "Select the incident disposition.",
          criteria: choiceWithBacktickOption.criteria,
        },
        "OpenAI-compatible endpoint",
      ),
    (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
  );

  // Negative: competing object outside fence + fenced object with backticks inside JSON string must abstain
  const competingOutsideWithInnerBackticks = [
    '{"draft":true}',
    "```json",
    '{"type":"choice","choice":"resume```","probabilities":{"resume```":1,"needs_attention":0}}',
    "```",
  ].join("\n");
  assert.equal(
    decodeStructuredDecisionJson(
      competingOutsideWithInnerBackticks,
      choiceWithBacktickOption,
      "OpenAI-compatible endpoint",
    ).choice,
    "needs_attention",
  );

  // Negative: unsupported fence language tag must abstain
  const unsupportedLanguageFence = [
    "```python",
    '{"type":"choice","choice":"resume","probabilities":{"resume":0.9,"rerun":0.05,"needs_attention":0.05}}',
    "```",
  ].join("\n");
  assert.equal(
    decodeStructuredDecisionJson(unsupportedLanguageFence, choiceWithAbstain, "OpenAI-compatible endpoint").choice,
    "needs_attention",
  );
});

test("G11-3: extracts single JSON object wrapped in leading/trailing prose and rejects ambiguous multiple JSON objects", () => {
  // Positive: prose before and after JSON (and braces inside a JSON string do not confuse scanner)
  const wrappedProse =
    '结论如下：{"type":"choice","choice":"rerun","probabilities":{"resume":0.1,"rerun":0.85,"needs_attention":0.05},} 请按此执行。';
  const decoded = decodeStructuredDecisionJson(wrappedProse, choiceWithAbstain, "OpenAI-compatible endpoint");
  assert.equal(decoded.type, "choice");
  assert.equal(decoded.choice, "rerun");
  assert.equal(decoded.probabilities.rerun, 0.85);

  // Negative: two top-level JSON objects -> ambiguous -> degrade to abstainOptionId (never guess)
  const twoObjects =
    '{"draft":1} {"type":"choice","choice":"resume","probabilities":{"resume":0.9,"rerun":0.05,"needs_attention":0.05}}';
  const abstained = decodeStructuredDecisionJson(twoObjects, choiceWithAbstain, "OpenAI-compatible endpoint");
  assert.equal(abstained.type, "choice");
  assert.equal(abstained.choice, "needs_attention");
  assert.equal(abstained.probabilities.needs_attention, 1);
  assert.throws(
    () => decodeStructuredDecisionJson(twoObjects, choiceWithoutAbstain, "OpenAI-compatible endpoint"),
    (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
  );
});

test("G11-4: truncated JSON and oversized outputs enforce hard bounds and degrade honestly to abstainOptionId", () => {
  // Truncated JSON (unclosed object)
  const truncatedJson = '{"type":"choice","choice":"resume","probabilities":{"resume":0.9,"rerun":0.1';
  const fromTruncated = decodeStructuredDecisionJson(truncatedJson, choiceWithAbstain, "OpenAI-compatible endpoint");
  assert.equal(fromTruncated.type, "choice");
  assert.equal(fromTruncated.choice, "needs_attention");
  assert.equal(fromTruncated.probabilities.needs_attention, 1);
  assert.throws(
    () => decodeStructuredDecisionJson(truncatedJson, choiceWithoutAbstain, "OpenAI-compatible endpoint"),
    (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
  );

  // Oversized malformed response (> MAX_STRUCTURED_DECISION_CHARS)
  const oversized = `${"x".repeat(MAX_STRUCTURED_DECISION_CHARS + 1)}{"type":"choice","choice":"resume"}`;
  assert.throws(
    () => sanitizeStructuredDecisionText(oversized, "OpenAI-compatible endpoint"),
    (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
  );
  const fromOversized = decodeStructuredDecisionJson(oversized, choiceWithAbstain, "OpenAI-compatible endpoint");
  assert.equal(fromOversized.type, "choice");
  assert.equal(fromOversized.choice, "needs_attention");
});

test("G11-5: illegal enum values and missing semantic fields honestly degrade to abstainOptionId without fabricating options", () => {
  const cases = [
    // Out-of-enum choice id
    JSON.stringify({
      type: "choice",
      choice: "auto_merge_immediately",
      probabilities: { resume: 0.5, rerun: 0.3, needs_attention: 0.2 },
    }),
    // Missing required probabilities field
    JSON.stringify({ type: "choice", choice: "resume" }),
    // Missing choice field
    JSON.stringify({ type: "choice", probabilities: { resume: 0.8, rerun: 0.1, needs_attention: 0.1 } }),
    // Probabilities do not sum to 1
    JSON.stringify({
      type: "choice",
      choice: "resume",
      probabilities: { resume: 0.9, rerun: 0.9, needs_attention: 0.1 },
    }),
    // Wrong question type
    JSON.stringify({ type: "noul", noul: 0.9 }),
  ];
  for (const sample of cases) {
    const degraded = decodeStructuredDecisionJson(sample, choiceWithAbstain, "OpenAI-compatible endpoint");
    assert.equal(degraded.type, "choice");
    assert.equal(degraded.choice, "needs_attention", `expected honest abstain for sample: ${sample}`);
    assert.equal(degraded.probabilities.needs_attention, 1);
    assert.equal(degraded.probabilities.resume, 0);
    assert.equal(degraded.probabilities.rerun, 0);
    assert.throws(
      () => decodeStructuredDecisionJson(sample, choiceWithoutAbstain, "OpenAI-compatible endpoint"),
      (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
    );
  }
});

test("G11-6: slow intranet gateway 502/429 recovery, jittered backoff, <=2 retry budget, timeout propagation, and finish_reason=length abstain over loopback HTTP", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-g11-weak-model-"));
  const vault = createMemoryVault();
  let scenario: "502-429-recover" | "502-exhaust" | "length-truncated" | "oversized-body" = "502-429-recover";
  const mock = await startServer((hit, res) => {
    if (scenario === "502-429-recover") {
      if (hit === 1) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("Bad Gateway");
        return;
      }
      if (hit === 2) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "gateway busy" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "qwen-72b-int4",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content:
                  '<think>72B quantized analysis</think>\n结果如下：\n```json\n{"type":"choice","choice":"resume","probabilities":{"resume":0.8,"needs_attention":0.2,},}\n```',
              },
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 22 },
        }),
      );
      return;
    }
    if (scenario === "502-exhaust") {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("Bad Gateway");
      return;
    }
    if (scenario === "length-truncated") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "qwen-72b-int4",
          choices: [
            {
              finish_reason: "length",
              message: { role: "assistant", content: "<think>cut off mid-generation..." },
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 512 },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("x".repeat(MAX_DECISION_RESPONSE_BYTES + 1024));
  });
  t.after(async () => {
    await mock.close();
    removeTempRepository(parent);
  });

  const delays: number[] = [];
  const randomDraws = [0.4, 0.75, 0.5, 0.5];
  let drawIndex = 0;
  const service = openDecisionProviderService({
    userRoot: parent,
    vault,
    now: () => "2026-11-22T06:00:00.000Z",
    random: () => randomDraws[drawIndex++ % randomDraws.length]!,
    sleep: async (ms) => void delays.push(ms),
  });

  // Rejects maxRetries > 2 and out-of-range requestTimeoutMs on provider-create
  await assert.rejects(
    service.command({
      kind: "provider-create",
      type: "decisions",
      vendor: "openai-compatible",
      providerId: "bad-retry",
      name: "Bad Retry",
      model: "qwen-72b-int4",
      baseUrl: `${mock.origin}/v1`,
      apiKey: "sk-intranet-test",
      maxRetries: 3,
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_provider",
  );
  await assert.rejects(
    service.command({
      kind: "provider-create",
      type: "decisions",
      vendor: "openai-compatible",
      providerId: "bad-timeout",
      name: "Bad Timeout",
      model: "qwen-72b-int4",
      baseUrl: `${mock.origin}/v1`,
      apiKey: "sk-intranet-test",
      requestTimeoutMs: 500,
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_provider",
  );

  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "openai-compatible",
    providerId: "intranet-qwen72b",
    name: "Intranet Qwen 72B Int4",
    model: "qwen-72b-int4",
    baseUrl: `${mock.origin}/v1`,
    apiKey: "sk-intranet-test",
    requestTimeoutMs: 90_000,
    maxRetries: 2,
  });

  const requestWithAbstain = {
    subjectRef: "dispatch/weak-model",
    providerId: "intranet-qwen72b",
    questionSetVersion: "incident/v1",
    state: ["Worker exited cleanly without commit."],
    question: {
      type: "choice" as const,
      prompt: "Pick action",
      options: [
        { id: "resume", text: "Resume" },
        { id: "needs_attention", text: "Needs attention" },
      ],
      criteria: { resume: "Continue", needs_attention: "Escalate" },
      abstainOptionId: "needs_attention",
    },
  };

  // Validate undeclared abstainOptionId is rejected fail-closed
  await assert.rejects(
    service.port.decide({
      ...requestWithAbstain,
      question: { ...requestWithAbstain.question, abstainOptionId: "nonexistent_option" },
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_decision_request",
  );

  // 1) Recovers from 502 -> 429 -> quantized <think>+fence+trailing-comma output within 2 retries with jitter
  const recovered = await service.port.decide(requestWithAbstain);
  assert.equal(recovered.result.type, "choice");
  assert.equal(recovered.result.selected, "resume");
  assert.equal(recovered.distribution.resume, 0.8);
  assert.deepEqual(delays, [101, 376], "full-jitter backoff delays must reflect exponentialBackoffMs");

  // 2) Persistent 502 exhausts at strictly 2 retries (3 total calls, never >2 retries)
  scenario = "502-exhaust";
  delays.length = 0;
  const hitsBeforeExhaust = mock.hits();
  await assert.rejects(service.port.decide(requestWithAbstain), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "decision_transport");
    assert.equal((error as { retries?: number }).retries, 2);
    return true;
  });
  assert.equal(mock.hits() - hitsBeforeExhaust, 3);
  assert.equal(delays.length, 2);

  // 3) finish_reason="length" honestly degrades to abstainOptionId without retrying
  scenario = "length-truncated";
  delays.length = 0;
  const hitsBeforeTrunc = mock.hits();
  const truncated = await service.port.decide(requestWithAbstain);
  assert.equal(truncated.result.type, "choice");
  assert.equal(truncated.result.selected, "needs_attention");
  assert.equal(truncated.distribution.needs_attention, 1);
  assert.equal(mock.hits() - hitsBeforeTrunc, 1);
  assert.deepEqual(delays, []);

  // 4) Oversized raw HTTP body (> MAX_DECISION_RESPONSE_BYTES) aborts with decision_protocol_invalid and is NOT retried
  scenario = "oversized-body";
  const hitsBeforeOversize = mock.hits();
  await assert.rejects(
    service.port.decide({
      ...requestWithAbstain,
      question: {
        type: "noul",
        prompt: "Ready?",
        criteria: { true: "yes", false: "no" },
      },
    }),
    (error: unknown) => (error as { code?: string }).code === "decision_protocol_invalid",
  );
  assert.equal(mock.hits() - hitsBeforeOversize, 1);
});

test("G11-6b: single-request total timeout budget propagates shrinking timeoutMs and stops retrying before exceeding deadline", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-g11-deadline-"));
  const vault = createMemoryVault();
  let clockMs = 10_000;
  const seenTimeouts: number[] = [];
  const slept: number[] = [];
  const service = openDecisionProviderService({
    userRoot: parent,
    vault,
    nowMs: () => clockMs,
    random: () => 0.999999,
    requestTimeoutMs: 1_000,
    maxRetries: 2,
    sleep: async (ms) => {
      slept.push(ms);
      clockMs += ms;
    },
    invokeDecision: async (req) => {
      seenTimeouts.push(req.timeoutMs ?? -1);
      // Attempt 1 consumes 400ms; Attempt 2 consumes 400ms -> only 100ms left (< 500ms second backoff)
      clockMs += 400;
      throw Object.assign(new Error("gateway 502"), { statusCode: 502, code: "decision_transport" });
    },
  });
  try {
    await service.command({
      kind: "provider-create",
      type: "decisions",
      vendor: "openai-compatible",
      providerId: "slow-gw",
      name: "Slow GW",
      model: "qwen-72b-int4",
      apiKey: "sk-slow-test",
    });
    await assert.rejects(
      service.port.decide({
        subjectRef: "dispatch/deadline",
        providerId: "slow-gw",
        questionSetVersion: "noul/v1",
        state: ["slow gateway"],
        question: { type: "noul", prompt: "Proceed?", criteria: { true: "yes", false: "no" } },
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === "decision_transport" &&
        (error as { retries?: number }).retries === 1 &&
        error.message.includes("total timeout budget exhausted"),
    );
    // Attempt 1 gets 1000ms, sleeps 250ms (remaining 350ms), Attempt 2 gets 350ms, then stops because remaining (-50ms) <= 500ms!
    assert.deepEqual(seenTimeouts, [1_000, 350]);
    assert.deepEqual(slept, [250]);
  } finally {
    removeTempRepository(parent);
  }
});
