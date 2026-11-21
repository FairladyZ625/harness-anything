// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CredentialPort } from "../src/daemon-host/agent-runtime-credential-port.ts";
import { openDecisionProviderService } from "../src/daemon-host/decision-provider.ts";
import { validTaskDispatchRow } from "../src/daemon-host/protocol/daemon-protocol-validate-relation-query.ts";

test("Decisions provider CRUD, probe, and port keep credentials private and return advisory distributions", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-")),
    credentials = new Map<string, string>(),
    references: string[] = [],
    vault: CredentialPort = {
      issue: () => {
        const reference = `credential:v1:key-${references.length + 1}`;
        references.push(reference);
        return reference;
      },
      store: async (reference, secret) => void credentials.set(reference, secret),
      resolve: async (reference) => {
        const secret = credentials.get(reference);
        if (!secret) throw Object.assign(new Error("unavailable"), { code: "runtime_credential_unavailable" });
        return secret;
      },
      remove: async (reference) => void credentials.delete(reference),
    };
  let invocation: unknown = null,
    probeKey: string | null = null,
    probeServerUrl: string | undefined;
  const service = openDecisionProviderService({
    userRoot: parent,
    vault,
    now: () => "2026-10-19T00:00:00.000Z",
    invokeDecision: async (input) => {
      if (input.question.type === "noul") {
        probeKey = input.apiKey;
        probeServerUrl = input.serverURL;
      } else {
        invocation = input;
      }
      return {
        model: "openrouter/model-resolved",
        provider: "route-a",
        usage: { inputTokens: 21, outputTokens: 4, cost: 0.002 },
        answers: {
          decision: { type: "choice", choice: "accept", probabilities: { accept: 0.82, reject: 0.18 } },
        },
      };
    },
  });
  const secret = "provider-secret-that-must-not-be-returned";
  try {
    const created = await service.command({
      kind: "provider-create",
      type: "decisions",
      providerId: "review-choice",
      name: "Review choice",
      model: "openrouter/model-requested",
      apiKey: `  ${secret}  `,
    });
    assert.equal((created.provider as { auth: { credentialRef: string } }).auth.credentialRef, references[0]);
    assert.equal(JSON.stringify(created).includes(secret), false);
    const file = readFileSync(path.join(parent, "decision-providers.json"), "utf8");
    assert.equal(file.includes(secret), false);
    assert.equal(statSync(path.join(parent, "decision-providers.json")).mode & 0o777, 0o600);

    const probed = await service.command({ kind: "provider-probe", providerId: "review-choice" });
    assert.equal(probeKey, secret);
    // No configured base URL means "let the SDK's Decisions operation default apply".
    assert.equal(probeServerUrl, undefined);
    assert.deepEqual((probed.provider as { probe: unknown }).probe, {
      state: "ready",
      checkedAt: "2026-10-19T00:00:00.000Z",
    });
    assert.equal(JSON.stringify(probed).includes(secret), false);

    const request = {
      subjectRef: "task/review-1",
      providerId: "review-choice",
      questionSetVersion: "review/v1",
      state: ["A commit changes the GUI provider catalog."] as const,
      question: {
        type: "choice" as const,
        prompt: "Should this change be accepted?",
        options: [
          { id: "accept", text: "Accept" },
          { id: "reject", text: "Reject" },
        ],
        criteria: { accept: "The behavior meets the task contract.", reject: "The change breaks a required boundary." },
      },
    };
    const result = await service.port.decide(request);
    assert.deepEqual(invocation, {
      apiKey: secret,
      serverURL: undefined,
      model: "openrouter/model-requested",
      state: request.state,
      question: {
        type: "choice",
        instructions: request.question.prompt,
        criteria: {
          accept: { label: "Accept", criterion: request.question.criteria.accept },
          reject: { label: "Reject", criterion: request.question.criteria.reject },
        },
      },
    });
    assert.deepEqual(result.distribution, { accept: 0.82, reject: 0.18 });
    assert.equal(result.result.type, "choice");
    assert.equal(result.result.selected, "accept");
    assert.equal(result.authoritative, false);
    assert.equal(result.disposition, "advisory");
    assert.equal(result.subjectRef, request.subjectRef);
    assert.equal(result.provider.resolvedModel, "openrouter/model-resolved");
    assert.equal(result.usage.inputTokens, 21);
    assert.equal(typeof result.__advisoryDecisionBrand, "symbol");

    const updated = await service.command({ kind: "provider-update", providerId: "review-choice", enabled: false });
    assert.equal((updated.provider as { enabled: boolean }).enabled, false);
    await assert.rejects(
      service.port.decide(request),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "provider_disabled",
    );
    const deleted = await service.command({ kind: "provider-delete", providerId: "review-choice" });
    assert.equal(deleted.deletedProviderId, "review-choice");
    assert.equal(credentials.has(references[0]!), false);
    assert.deepEqual(service.list(), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Decisions provider probe exercises the same decisions endpoint as a real decision", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-endpoint-")),
    requests: { readonly method: string; readonly url: string }[] = [],
    vault: CredentialPort = {
      issue: () => "credential:v1:probe-key",
      store: async () => undefined,
      resolve: async () => "probe-key",
      remove: async () => undefined,
    },
    decisionsBody = {
      model: "openrouter/model-resolved",
      usage: { input_tokens: 3, output_tokens: 1 },
      answers: { decision: { type: "noul", noul: 0.75 } },
    };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const request = input instanceof Request ? input : new Request(input),
      url = request.url,
      path = new URL(url).pathname;
    requests.push({ method: request.method, url });
    if (request.method === "POST" && path === "/api/alpha/decisions")
      return new Response(JSON.stringify(decisionsBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return new Response(JSON.stringify({ error: { code: 404, message: "Invalid URL" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });
  const service = openDecisionProviderService({
    userRoot: parent,
    vault,
    now: () => "2026-10-23T00:00:00.000Z",
  });
  try {
    await service.command({
      kind: "provider-create",
      type: "decisions",
      providerId: "default-endpoint",
      name: "Default endpoint",
      model: "openrouter/model-requested",
      credentialRef: "credential:v1:probe-key",
    });
    const probed = await service.command({ kind: "provider-probe", providerId: "default-endpoint" });
    assert.deepEqual((probed.provider as { probe: unknown }).probe, {
      state: "ready",
      checkedAt: "2026-10-23T00:00:00.000Z",
    });

    const result = await service.port.decide({
      subjectRef: "task/endpoint",
      providerId: "default-endpoint",
      questionSetVersion: "review/v1",
      state: ["A commit changes the GUI provider catalog."],
      question: {
        type: "noul",
        prompt: "Should this change be accepted?",
        criteria: { true: "It meets the contract.", false: "It breaks a boundary." },
      },
    });
    assert.equal(result.result.type, "noul");
    // The probe and the real decision must address the same SDK operation path.
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`),
      ["POST /api/alpha/decisions", "POST /api/alpha/decisions"],
    );

    await service.command({
      kind: "provider-create",
      type: "decisions",
      providerId: "v1-endpoint",
      name: "V1 endpoint",
      model: "openrouter/model-requested",
      baseUrl: "https://openrouter.ai/api/v1",
      credentialRef: "credential:v1:probe-key",
    });
    requests.length = 0;
    await assert.rejects(service.command({ kind: "provider-probe", providerId: "v1-endpoint" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, "decision_transport");
      assert.match(error.message, /HTTP 404/u);
      assert.match(error.message, /NotFoundResponseError/u);
      assert.match(error.message, /Invalid URL/u);
      assert.equal(error.message.match(/HTTP 404/gu)?.length, 1);
      return true;
    });
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`),
      ["POST /api/v1/api/alpha/decisions"],
    );
    assert.deepEqual(service.list().find(({ providerId }) => providerId === "v1-endpoint")?.probe, {
      state: "failed",
      checkedAt: "2026-10-23T00:00:00.000Z",
      code: "decision_transport",
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Decisions provider returns an empty list only when its file is absent", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-read-"));
  try {
    const missing = openDecisionProviderService({ userRoot: parent });
    assert.deepEqual(missing.read(), []);

    writeFileSync(path.join(parent, "decision-providers.json"), "not-json");
    const corrupt = openDecisionProviderService({ userRoot: parent });
    assert.throws(() => corrupt.read(), SyntaxError);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Decisions provider maps credential unavailability and propagates other vault failures", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-vault-"));
  let resolveFailure: Error = Object.assign(new Error("unavailable"), { code: "runtime_credential_unavailable" });
  const vault: CredentialPort = {
      issue: () => "credential:v1:test-key",
      store: async () => undefined,
      resolve: async () => {
        throw resolveFailure;
      },
      remove: async () => undefined,
    },
    service = openDecisionProviderService({ userRoot: parent, vault });
  try {
    await service.command({
      kind: "provider-create",
      type: "decisions",
      providerId: "decision-a",
      name: "Decision A",
      model: "model-a",
      credentialRef: "credential:v1:test-key",
    });
    await assert.rejects(
      service.command({ kind: "provider-probe", providerId: "decision-a" }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "provider_credential_unavailable",
    );
    assert.equal(service.list()[0]?.probe.state, "failed");

    const unexpected = new Error("vault implementation failed");
    resolveFailure = unexpected;
    await assert.rejects(
      service.port.decide({
        subjectRef: "task/a",
        providerId: "decision-a",
        questionSetVersion: "choice/v1",
        state: ["text"],
        question: {
          type: "choice",
          prompt: "Choose",
          options: [
            { id: "yes", text: "Yes" },
            { id: "no", text: "No" },
          ],
          criteria: { yes: "yes", no: "no" },
        },
      }),
      (error: unknown) => error === unexpected,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("DecisionPort rejects malformed distributions as protocol failures", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-invalid-")),
    vault: CredentialPort = {
      issue: () => "credential:v1:test-key",
      store: async () => undefined,
      resolve: async () => "test-key",
      remove: async () => undefined,
    },
    service = openDecisionProviderService({
      userRoot: parent,
      vault,
      invokeDecision: async () => ({
        model: "model-a",
        usage: { inputTokens: 1, outputTokens: 1 },
        answers: { decision: { type: "choice", choice: "yes", probabilities: { yes: 1 } } },
      }),
    });
  try {
    await service.command({
      kind: "provider-create",
      type: "decisions",
      providerId: "decision-a",
      name: "Decision A",
      model: "model-a",
      credentialRef: "credential:v1:test-key",
    });
    await assert.rejects(
      service.port.decide({
        subjectRef: "task/a",
        providerId: "decision-a",
        questionSetVersion: "choice/v1",
        state: ["text"],
        question: {
          type: "choice",
          prompt: "Choose",
          options: [
            { id: "yes", text: "Yes" },
            { id: "no", text: "No" },
          ],
          criteria: { yes: "yes", no: "no" },
        },
      }),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "decision_protocol_invalid",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("DecisionPort retries a transient rate limit and returns the later real decision", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-rate-limit-retry-")),
    calls: number[] = [],
    delays: number[] = [],
    vault: CredentialPort = {
      issue: () => "credential:v1:test-key",
      store: async () => undefined,
      resolve: async () => "test-key",
      remove: async () => undefined,
    },
    service = openDecisionProviderService({
      userRoot: parent,
      vault,
      sleep: async (delayMs) => void delays.push(delayMs),
      invokeDecision: async () => {
        calls.push(calls.length + 1);
        if (calls.length === 1) throw Object.assign(new Error("rate limited"), { code: "decision_rate_limited" });
        return {
          model: "model-a",
          usage: { inputTokens: 1, outputTokens: 1 },
          answers: { decision: { type: "noul", noul: 0.75 } },
        };
      },
    });
  try {
    await service.command({
      kind: "provider-create",
      type: "decisions",
      providerId: "decision-a",
      name: "Decision A",
      model: "model-a",
      credentialRef: "credential:v1:test-key",
    });
    const result = await service.port.decide({
      subjectRef: "dispatch/rate-limit",
      providerId: "decision-a",
      questionSetVersion: "noul/v1",
      state: ["text"],
      question: {
        type: "noul",
        prompt: "Choose",
        criteria: { true: "yes", false: "no" },
      },
    });
    assert.equal(result.result.type, "noul");
    assert.equal(calls.length, 2);
    assert.deepEqual(delays, [250]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("DecisionPort exhausts transient retries without hiding the rate-limit reason", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-rate-limit-exhausted-")),
    calls: number[] = [],
    delays: number[] = [],
    vault: CredentialPort = {
      issue: () => "credential:v1:test-key",
      store: async () => undefined,
      resolve: async () => "test-key",
      remove: async () => undefined,
    },
    service = openDecisionProviderService({
      userRoot: parent,
      vault,
      sleep: async (delayMs) => void delays.push(delayMs),
      invokeDecision: async () => {
        calls.push(calls.length + 1);
        throw Object.assign(new Error("rate limited"), { code: "decision_rate_limited" });
      },
    });
  try {
    await service.command({
      kind: "provider-create",
      type: "decisions",
      providerId: "decision-a",
      name: "Decision A",
      model: "model-a",
      credentialRef: "credential:v1:test-key",
    });
    await assert.rejects(
      service.port.decide({
        subjectRef: "dispatch/rate-limit",
        providerId: "decision-a",
        questionSetVersion: "noul/v1",
        state: ["text"],
        question: {
          type: "noul",
          prompt: "Choose",
          criteria: { true: "yes", false: "no" },
        },
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "decision_rate_limited" &&
        "retries" in error &&
        error.retries === 3 &&
        error instanceof Error &&
        error.message.includes("重试 3 次后仍限流"),
    );
    assert.equal(calls.length, 4);
    assert.deepEqual(delays, [250, 500, 1_000]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("DecisionPort reports the HTTP status, SDK error class, and provider message of terminal failures", async (t) => {
  const scenarios = [
    {
      label: "unauthorized",
      status: 401,
      name: "UnauthorizedResponseError",
      code: "provider_credential_unavailable",
      providerMessage: "No auth credentials found",
    },
    {
      label: "payment required",
      status: 402,
      name: "PaymentRequiredResponseError",
      code: "decision_transport",
      providerMessage: "Insufficient credits to run this request",
    },
    {
      label: "unsupported endpoint",
      status: 404,
      name: "NotFoundResponseError",
      code: "decision_transport",
      providerMessage: "Invalid URL",
    },
  ] as const;
  for (const scenario of scenarios) {
    await t.test(scenario.label, async () => {
      const parent = mkdtempSync(path.join(tmpdir(), `ha-decision-provider-${scenario.label.replaceAll(" ", "-")}-`)),
        calls: number[] = [],
        vault: CredentialPort = {
          issue: () => "credential:v1:test-key",
          store: async () => undefined,
          resolve: async () => "test-key",
          remove: async () => undefined,
        },
        service = openDecisionProviderService({
          userRoot: parent,
          vault,
          sleep: async () => undefined,
          invokeDecision: async () => {
            calls.push(calls.length + 1);
            const providerErrorBody = { error: { code: scenario.status, message: scenario.providerMessage } };
            throw Object.assign(new Error(scenario.providerMessage), {
              name: scenario.name,
              statusCode: scenario.status,
              error: providerErrorBody.error,
              data$: { ...providerErrorBody, body$: JSON.stringify(providerErrorBody) },
            });
          },
        });
      try {
        await service.command({
          kind: "provider-create",
          type: "decisions",
          providerId: "decision-a",
          name: "Decision A",
          model: "baseten/elephant-1:free",
          credentialRef: "credential:v1:test-key",
        });
        await assert.rejects(
          service.port.decide({
            subjectRef: "dispatch/terminal-failure",
            providerId: "decision-a",
            questionSetVersion: "noul/v1",
            state: ["text"],
            question: { type: "noul", prompt: "Choose", criteria: { true: "yes", false: "no" } },
          }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal((error as Error & { code?: string }).code, scenario.code);
            assert.equal((error as Error & { retries?: number }).retries, 0);
            assert.match(error.message, new RegExp(`HTTP ${String(scenario.status)}`, "u"));
            assert.ok(error.message.includes(scenario.name), error.message);
            assert.ok(error.message.includes(scenario.providerMessage), error.message);
            return true;
          },
        );
        // 401/402/404 are terminal: the underlying cause must be visible, and nothing may be retried.
        assert.equal(calls.length, 1);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });
  }
});

test("a model removed from the free tier is a configuration fault with an operator command", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-model-removed-")),
    calls: number[] = [],
    providerMessage =
      "This model is unavailable for free. The paid version is available now - use this slug instead: baseten/elephant-1",
    vault: CredentialPort = {
      issue: () => "credential:v1:test-key",
      store: async () => undefined,
      resolve: async () => "test-key",
      remove: async () => undefined,
    },
    service = openDecisionProviderService({
      userRoot: parent,
      vault,
      now: () => "2026-11-01T00:00:00.000Z",
      sleep: async () => {
        throw new Error("a model-unavailable 404 must not be retried");
      },
      invokeDecision: async () => {
        calls.push(calls.length + 1);
        const providerErrorBody = { error: { code: 404, message: providerMessage } };
        throw Object.assign(new Error(providerMessage), {
          name: "NotFoundResponseError",
          statusCode: 404,
          error: providerErrorBody.error,
          data$: { ...providerErrorBody, body$: JSON.stringify(providerErrorBody) },
        });
      },
    });
  try {
    await service.command({
      kind: "provider-create",
      type: "decisions",
      providerId: "decision-a",
      name: "Decision A",
      model: "baseten/elephant-1:free",
      credentialRef: "credential:v1:test-key",
    });
    await assert.rejects(
      service.port.decide({
        subjectRef: "dispatch/model-removed",
        providerId: "decision-a",
        questionSetVersion: "noul/v1",
        state: ["text"],
        question: { type: "noul", prompt: "Choose", criteria: { true: "yes", false: "no" } },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, "decision_model_unavailable");
        assert.equal((error as Error & { retries?: number }).retries, 0);
        assert.match(error.message, /HTTP 404/u);
        assert.match(error.message, /baseten\/elephant-1:free/u);
        assert.match(error.message, /ha provider update decision-a --model/u);
        assert.match(error.message, /unavailable for free/u);
        assert.doesNotMatch(error.message, /test-key/u);
        return true;
      },
    );
    assert.equal(calls.length, 1, "a removed model is terminal and must not be retried");
    const expectedProbe = {
      state: "failed",
      checkedAt: "2026-11-01T00:00:00.000Z",
      code: "decision_model_unavailable",
    };
    assert.deepEqual(service.read()[0]?.probe, expectedProbe);
    const persisted = JSON.parse(readFileSync(path.join(parent, "decision-providers.json"), "utf8")) as {
      providers: { readonly probe: unknown }[];
    };
    assert.deepEqual(persisted.providers[0]?.probe, expectedProbe);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a provider model update changes the model the next decision sends", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-model-update-")),
    models: string[] = [],
    vault: CredentialPort = {
      issue: () => "credential:v1:test-key",
      store: async () => undefined,
      resolve: async () => "test-key",
      remove: async () => undefined,
    },
    service = openDecisionProviderService({
      userRoot: parent,
      vault,
      invokeDecision: async (input) => {
        models.push(input.model);
        return {
          model: input.model,
          usage: { inputTokens: 1, outputTokens: 1 },
          answers: { decision: { type: "noul", noul: 0.5 } },
        };
      },
    });
  const request = {
    subjectRef: "dispatch/model-update",
    providerId: "decision-a",
    questionSetVersion: "noul/v1",
    state: ["text"] as const,
    question: { type: "noul" as const, prompt: "Choose", criteria: { true: "yes", false: "no" } },
  };
  try {
    await service.command({
      kind: "provider-create",
      type: "decisions",
      providerId: "decision-a",
      name: "Decision A",
      model: "model-a",
      credentialRef: "credential:v1:test-key",
    });
    await service.port.decide(request);
    const updated = await service.command({ kind: "provider-update", providerId: "decision-a", model: "model-b" });
    assert.equal((updated.provider as { model: string }).model, "model-b");
    assert.deepEqual((updated.provider as { probe: unknown }).probe, { state: "unknown" });
    await service.port.decide(request);
    assert.deepEqual(models, ["model-a", "model-b"]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a decision failure does not mark a newer provider configuration as failed", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-model-race-")),
    providerMessage = "This model is unavailable for free. Use this slug instead: baseten/elephant-1",
    vault: CredentialPort = {
      issue: () => "credential:v1:test-key",
      store: async () => undefined,
      resolve: async () => "test-key",
      remove: async () => undefined,
    };
  const service = openDecisionProviderService({
    userRoot: parent,
    vault,
    invokeDecision: async () => {
      // The operator changes the model while the old model's request is in flight.
      await service.command({ kind: "provider-update", providerId: "decision-a", model: "model-b" });
      throw Object.assign(new Error(providerMessage), { name: "NotFoundResponseError", statusCode: 404 });
    },
  });
  try {
    await service.command({
      kind: "provider-create",
      type: "decisions",
      providerId: "decision-a",
      name: "Decision A",
      model: "model-a",
      credentialRef: "credential:v1:test-key",
    });
    await assert.rejects(
      service.port.decide({
        subjectRef: "dispatch/model-race",
        providerId: "decision-a",
        questionSetVersion: "noul/v1",
        state: ["text"],
        question: { type: "noul", prompt: "Choose", criteria: { true: "yes", false: "no" } },
      }),
      (error: unknown) =>
        error instanceof Error && (error as Error & { code?: string }).code === "decision_model_unavailable",
    );
    const current = service.read()[0];
    assert.equal(current?.model, "model-b");
    assert.deepEqual(current?.probe, { state: "unknown" });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a failure from a deleted configuration does not overwrite a recreated provider's probe", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-recreate-race-")),
    providerMessage = "This model is unavailable for free. Use this slug instead: baseten/elephant-1",
    vault: CredentialPort = {
      issue: () => "credential:v1:test-key",
      store: async () => undefined,
      resolve: async () => "test-key",
      remove: async () => undefined,
    };
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  const service = openDecisionProviderService({
    userRoot: parent,
    vault,
    now: () => "2026-11-01T00:00:00.000Z",
    invokeDecision: async (input) => {
      if (input.model !== "model-a")
        return {
          model: "model-b-resolved",
          provider: "route-b",
          usage: { inputTokens: 3, outputTokens: 1, cost: 0 },
          answers: { decision: { type: "noul", noul: 0.9 } },
        };
      // The operator deletes this configuration and recreates the same provider id with another
      // model while the old model's request is still in flight.
      requestStarted();
      await failureGate;
      throw Object.assign(new Error(providerMessage), { name: "NotFoundResponseError", statusCode: 404 });
    },
  });
  try {
    await service.command({
      kind: "provider-create",
      type: "decisions",
      providerId: "decision-a",
      name: "Decision A",
      model: "model-a",
      credentialRef: "credential:v1:test-key",
    });
    const settledFailure = service.port
      .decide({
        subjectRef: "dispatch/recreate-race",
        providerId: "decision-a",
        questionSetVersion: "noul/v1",
        state: ["text"],
        question: { type: "noul", prompt: "Choose", criteria: { true: "yes", false: "no" } },
      })
      .then(
        () => {
          throw new Error("The stale configuration's failing decision unexpectedly resolved.");
        },
        (error: unknown) => error,
      );
    await started;
    await service.command({ kind: "provider-delete", providerId: "decision-a" });
    await service.command({
      kind: "provider-create",
      type: "decisions",
      providerId: "decision-a",
      name: "Decision A",
      model: "model-b",
      credentialRef: "credential:v1:test-key",
    });
    const probed = await service.command({ kind: "provider-probe", providerId: "decision-a" });
    assert.deepEqual((probed.provider as { probe: unknown }).probe, {
      state: "ready",
      checkedAt: "2026-11-01T00:00:00.000Z",
    });

    releaseFailure();
    const failure = await settledFailure;
    assert.equal((failure as { code?: string }).code, "decision_model_unavailable");
    const current = service.read()[0];
    assert.equal(current?.model, "model-b");
    assert.deepEqual(current?.probe, { state: "ready", checkedAt: "2026-11-01T00:00:00.000Z" });
  } finally {
    releaseFailure();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("DecisionPort retries only failures with transient evidence and never echoes the API key", async (t) => {
  const apiKey = "sk-test-secret-value-12345",
    vault: CredentialPort = {
      issue: () => "credential:v1:test-key",
      store: async () => undefined,
      resolve: async () => apiKey,
      remove: async () => undefined,
    };
  await t.test("a 5xx response retries and keeps the final cause", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-5xx-retry-")),
      calls: number[] = [],
      delays: number[] = [],
      service = openDecisionProviderService({
        userRoot: parent,
        vault,
        sleep: async (delayMs) => void delays.push(delayMs),
        invokeDecision: async () => {
          calls.push(calls.length + 1);
          throw Object.assign(new Error("upstream unavailable"), {
            name: "ServiceUnavailableResponseError",
            statusCode: 503,
          });
        },
      });
    try {
      await service.command({
        kind: "provider-create",
        type: "decisions",
        providerId: "decision-a",
        name: "Decision A",
        model: "model-a",
        credentialRef: "credential:v1:test-key",
      });
      await assert.rejects(
        service.port.decide({
          subjectRef: "dispatch/server-failure",
          providerId: "decision-a",
          questionSetVersion: "noul/v1",
          state: ["text"],
          question: { type: "noul", prompt: "Choose", criteria: { true: "yes", false: "no" } },
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("HTTP 503") &&
          error.message.includes("ServiceUnavailableResponseError") &&
          error.message.includes("Retried 3 time(s)"),
      );
      assert.equal(calls.length, 4);
      assert.deepEqual(delays, [250, 500, 1_000]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  await t.test("a decision_transport error without transient evidence is not retried", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-terminal-transport-")),
      calls: number[] = [],
      service = openDecisionProviderService({
        userRoot: parent,
        vault,
        sleep: async () => undefined,
        invokeDecision: async () => {
          calls.push(calls.length + 1);
          throw Object.assign(new Error("upstream rejected the request"), { code: "decision_transport" });
        },
      });
    try {
      await service.command({
        kind: "provider-create",
        type: "decisions",
        providerId: "decision-a",
        name: "Decision A",
        model: "model-a",
        credentialRef: "credential:v1:test-key",
      });
      await assert.rejects(
        service.port.decide({
          subjectRef: "dispatch/terminal-transport",
          providerId: "decision-a",
          questionSetVersion: "noul/v1",
          state: ["text"],
          question: { type: "noul", prompt: "Choose", criteria: { true: "yes", false: "no" } },
        }),
        (error: unknown) =>
          error instanceof Error &&
          (error as Error & { code?: string }).code === "decision_transport" &&
          !error.message.includes("Retried"),
      );
      assert.equal(calls.length, 1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  await t.test("the provider message never echoes the API key", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-key-redaction-")),
      service = openDecisionProviderService({
        userRoot: parent,
        vault,
        sleep: async () => undefined,
        invokeDecision: async () => {
          throw Object.assign(new Error(`Incorrect API key provided: ${apiKey}.`), {
            name: "UnauthorizedResponseError",
            statusCode: 401,
          });
        },
      });
    try {
      await service.command({
        kind: "provider-create",
        type: "decisions",
        providerId: "decision-a",
        name: "Decision A",
        model: "model-a",
        credentialRef: "credential:v1:test-key",
      });
      await assert.rejects(
        service.port.decide({
          subjectRef: "dispatch/key-redaction",
          providerId: "decision-a",
          questionSetVersion: "noul/v1",
          state: ["text"],
          question: { type: "noul", prompt: "Choose", criteria: { true: "yes", false: "no" } },
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("[redacted]") &&
          !error.message.includes(apiKey) &&
          error.message.includes("HTTP 401"),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

async function startLoopbackMockServer(
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>,
): Promise<{ readonly server: Server; readonly baseUrl: string; readonly close: () => Promise<void> }> {
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
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

test("openai-compatible DecisionProvider validates vendor/baseUrl, keeps legacy openrouter files compatible, and passes loopback probe + noul/choice/score decisions", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-openai-")),
    credentials = new Map<string, string>(),
    secret = "sk-private-gateway-secret-9999",
    vault: CredentialPort = {
      issue: () => `credential:v1:openai-${String(credentials.size + 1)}`,
      store: async (reference, value) => void credentials.set(reference, value),
      resolve: async (reference) => {
        const value = credentials.get(reference);
        if (!value) throw Object.assign(new Error("unavailable"), { code: "runtime_credential_unavailable" });
        return value;
      },
      remove: async (reference) => void credentials.delete(reference),
    };
  const seenRequests: {
    readonly path: string;
    readonly auth: string | undefined;
    readonly body: Record<string, unknown>;
  }[] = [];
  let nextReply: () => { readonly status: number; readonly body: string } = () => ({
    status: 200,
    body: JSON.stringify({
      model: "deepseek-r1-resolved",
      provider: "intranet-vllm",
      usage: { prompt_tokens: 18, completion_tokens: 7, total_tokens: 25, cost: 0.0004 },
      choices: [{ message: { role: "assistant", content: JSON.stringify({ type: "noul", noul: 0.91 }) } }],
    }),
  });
  const mock = await startLoopbackMockServer((req, body, res) => {
    seenRequests.push({
      path: req.url ?? "",
      auth: req.headers.authorization,
      body: JSON.parse(body) as Record<string, unknown>,
    });
    const reply = nextReply();
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(reply.body);
  });
  t.after(async () => {
    await mock.close();
    rmSync(parent, { recursive: true, force: true });
  });

  // Legacy decision-providers.json without a vendor field stays 100% readable as openrouter.
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

  // Validation negative cases: missing baseUrl, non-loopback HTTP baseUrl, unknown vendor.
  await assert.rejects(
    service.command({
      kind: "provider-create",
      type: "decisions",
      vendor: "openai-compatible",
      providerId: "missing-url",
      name: "Missing URL",
      model: "qwen-max",
      apiKey: secret,
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_base_url",
  );
  assert.equal(credentials.size, 0, "rejected create must not store credentials");

  await assert.rejects(
    service.command({
      kind: "provider-create",
      type: "decisions",
      vendor: "openai-compatible",
      providerId: "cleartext-remote",
      name: "Cleartext Remote",
      model: "qwen-max",
      baseUrl: "http://gateway.internal.example/v1",
      apiKey: secret,
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_base_url",
  );

  await assert.rejects(
    service.command({
      kind: "provider-create",
      type: "decisions",
      vendor: "unsupported-vendor",
      providerId: "bad-vendor",
      name: "Bad Vendor",
      model: "qwen-max",
      baseUrl: mock.baseUrl,
      apiKey: secret,
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_provider",
  );

  const createdHttps = await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "openai-compatible",
    providerId: "corp-https",
    name: "Corp HTTPS Gateway",
    model: "qwen-max",
    baseUrl: "https://gateway.internal.example/v1/",
    apiKey: secret,
  });
  assert.equal((createdHttps.provider as { vendor: string }).vendor, "openai-compatible");
  assert.equal((createdHttps.provider as { baseUrl: string }).baseUrl, "https://gateway.internal.example/v1");

  const created = await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "openai-compatible",
    providerId: "local-vllm",
    name: "Local vLLM",
    model: "deepseek-r1",
    baseUrl: `${mock.baseUrl}/`,
    apiKey: secret,
  });
  assert.equal((created.provider as { vendor: string }).vendor, "openai-compatible");
  assert.equal((created.provider as { baseUrl: string }).baseUrl, mock.baseUrl);
  assert.equal(JSON.stringify(created).includes(secret), false);

  const shown = await service.command({ kind: "provider-show", providerId: "local-vllm" });
  assert.match(String(shown.summary), /vendor:openai-compatible/u);
  assert.match(
    String(shown.summary),
    new RegExp(`baseUrl:${mock.baseUrl.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
  );

  // Clearing baseUrl on an openai-compatible provider must be rejected.
  await assert.rejects(
    service.command({ kind: "provider-update", providerId: "local-vllm", baseUrl: "" }),
    (error: unknown) => (error as { code?: string }).code === "invalid_base_url",
  );

  // Probe exercises POST ${baseUrl}/chat/completions with Bearer auth.
  const probed = await service.command({ kind: "provider-probe", providerId: "local-vllm" });
  assert.deepEqual(probed.probe, { state: "ready", checkedAt: "2026-11-21T00:00:00.000Z" });
  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0]?.path, "/v1/chat/completions");
  assert.equal(seenRequests[0]?.auth, `Bearer ${secret}`);
  assert.equal(seenRequests[0]?.body.model, "deepseek-r1");
  assert.deepEqual(seenRequests[0]?.body.response_format, { type: "json_object" });

  // 1) noul decision
  const noul = await service.port.decide({
    subjectRef: "task/openai-noul",
    providerId: "local-vllm",
    questionSetVersion: "noul/v1",
    state: ["The diff passes every required check."],
    question: {
      type: "noul",
      prompt: "Is the diff ready?",
      criteria: { true: "All checks pass.", false: "Checks are missing." },
    },
  });
  assert.equal(noul.questionType, "noul");
  assert.equal(noul.result.type, "noul");
  assert.equal(noul.result.value, 0.91);
  assert.equal(noul.distribution.true, 0.91);
  assert.ok(Math.abs(noul.distribution.false - 0.09) < 1e-9);
  assert.equal(noul.provider.vendor, "openai-compatible");
  assert.equal(noul.provider.resolvedModel, "deepseek-r1-resolved");
  assert.equal(noul.provider.providerRoute, "intranet-vllm");
  assert.deepEqual(noul.usage, { inputTokens: 18, outputTokens: 7, reportedCost: 0.0004 });

  // 2) choice decision (including fenced JSON output)
  nextReply = () => ({
    status: 200,
    body: JSON.stringify({
      model: "deepseek-r1",
      usage: { prompt_tokens: 42, completion_tokens: 11 },
      choices: [
        {
          message: {
            role: "assistant",
            content:
              '```json\n{"type":"choice","choice":"resume","probabilities":{"resume":0.85,"escalate":0.15}}\n```',
          },
        },
      ],
    }),
  });
  const choice = await service.port.decide({
    subjectRef: "dispatch/openai-choice",
    providerId: "local-vllm",
    questionSetVersion: "choice/v1",
    state: ["Transient failure observed."],
    question: {
      type: "choice",
      prompt: "Choose disposition",
      options: [
        { id: "resume", text: "Resume" },
        { id: "escalate", text: "Escalate" },
      ],
      criteria: { resume: "Transient failure", escalate: "Needs human input" },
    },
  });
  assert.equal(choice.questionType, "choice");
  assert.equal(choice.result.type, "choice");
  assert.equal(choice.result.selected, "resume");
  assert.deepEqual(choice.distribution, { resume: 0.85, escalate: 0.15 });
  assert.equal(choice.provider.vendor, "openai-compatible");
  assert.deepEqual(choice.usage, { inputTokens: 42, outputTokens: 11, reportedCost: null });

  // 3) score decision
  nextReply = () => ({
    status: 200,
    body: JSON.stringify({
      model: "deepseek-r1",
      usage: { input_tokens: 30, output_tokens: 9 },
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({
              type: "score",
              score: 0.78,
              probabilities: { low: 0.05, medium: 0.25, high: 0.7 },
            }),
          },
        },
      ],
    }),
  });
  const score = await service.port.decide({
    subjectRef: "task/openai-score",
    providerId: "local-vllm",
    questionSetVersion: "score/v1",
    state: ["Comprehensive test evidence attached."],
    question: {
      type: "score",
      prompt: "Rate confidence",
      levels: [
        { id: "low", text: "Low" },
        { id: "medium", text: "Medium" },
        { id: "high", text: "High" },
      ],
      criteria: { low: "Weak", medium: "Moderate", high: "Strong" },
    },
  });
  assert.equal(score.questionType, "score");
  assert.equal(score.result.type, "score");
  assert.equal(score.result.value, 0.78);
  assert.deepEqual(score.distribution, { low: 0.05, medium: 0.25, high: 0.7 });
  assert.deepEqual(score.usage, { inputTokens: 30, outputTokens: 9, reportedCost: null });

  // Wire validator accepts openai-compatible advisories and rejects unknown vendors.
  const baseRow = {
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
        distribution: choice.distribution,
        options: [
          { id: "resume", text: "Resume" },
          { id: "escalate", text: "Escalate" },
        ],
        provider: choice.provider,
        usage: choice.usage,
        latencyMs: 12,
      },
    ],
  };
  assert.equal(validTaskDispatchRow(baseRow), true);
  assert.equal(
    validTaskDispatchRow({
      ...baseRow,
      advisories: [{ ...baseRow.advisories[0], provider: { ...choice.provider, vendor: "unknown-vendor" } }],
    }),
    false,
  );
});

test("openai-compatible DecisionProvider fails closed on disconnect, timeout, 5xx/429/401/404, and malformed JSON", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-decision-provider-openai-fail-")),
    secret = "sk-fail-closed-secret-4321",
    vault: CredentialPort = {
      issue: () => "credential:v1:openai-fail",
      store: async () => undefined,
      resolve: async () => secret,
      remove: async () => undefined,
    };
  let mode: "hang" | "500" | "429-once" | "401" | "404-model" | "bad-outer-json" | "bad-inner-json" | "unknown-option" =
      "500",
    hits = 0;
  const openSockets = new Set<import("node:net").Socket>();
  const mock = await startLoopbackMockServer((req, _body, res) => {
    hits += 1;
    if (mode === "hang") {
      if (req.socket) openSockets.add(req.socket);
      return;
    }
    if (mode === "500") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Internal gateway error", code: "internal_error" } }));
      return;
    }
    if (mode === "429-once") {
      if (hits === 1) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Too many requests", code: "rate_limit_exceeded" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "deepseek-r1",
          usage: { prompt_tokens: 5, completion_tokens: 2 },
          choices: [{ message: { content: JSON.stringify({ type: "noul", noul: 0.6 }) } }],
        }),
      );
      return;
    }
    if (mode === "401") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Invalid API key: ${secret}` } }));
      return;
    }
    if (mode === "404-model") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "The model `removed-model` does not exist", code: "model_not_found" },
        }),
      );
      return;
    }
    if (mode === "bad-outer-json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{broken-json");
      return;
    }
    if (mode === "bad-inner-json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "deepseek-r1", choices: [{ message: { content: "definitely yes" } }] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "deepseek-r1",
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: "choice",
                choice: "fabricated_option",
                probabilities: { yes: 0.5, no: 0.5 },
              }),
            },
          },
        ],
      }),
    );
  });

  // Allocate and immediately close a loopback port to deterministically produce ECONNREFUSED.
  const closedMock = await startLoopbackMockServer((_req, _body, res) => res.end());
  const closedBaseUrl = closedMock.baseUrl;
  await closedMock.close();

  t.after(async () => {
    for (const socket of openSockets) socket.destroy();
    await mock.close();
    rmSync(parent, { recursive: true, force: true });
  });

  const delays: number[] = [];
  const service = openDecisionProviderService({
    userRoot: parent,
    vault,
    now: () => "2026-11-21T00:00:00.000Z",
    sleep: async (delayMs) => void delays.push(delayMs),
    requestTimeoutMs: 60,
  });
  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "openai-compatible",
    providerId: "local-gw",
    name: "Local GW",
    model: "deepseek-r1",
    baseUrl: mock.baseUrl,
    credentialRef: "credential:v1:openai-fail",
  });
  await service.command({
    kind: "provider-create",
    type: "decisions",
    vendor: "openai-compatible",
    providerId: "offline-gw",
    name: "Offline GW",
    model: "deepseek-r1",
    baseUrl: closedBaseUrl,
    credentialRef: "credential:v1:openai-fail",
  });

  const noulRequest = (providerId: string) => ({
    subjectRef: "dispatch/fail-closed",
    providerId,
    questionSetVersion: "noul/v1",
    state: ["test state"] as const,
    question: { type: "noul" as const, prompt: "Ready?", criteria: { true: "yes", false: "no" } },
  });

  // 1) Connection refused -> bounded retries -> decision_transport
  delays.length = 0;
  await assert.rejects(service.port.decide(noulRequest("offline-gw")), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, "decision_transport");
    assert.equal((error as { retries?: number }).retries, 3);
    assert.match(error.message, /OpenAI-compatible endpoint/u);
    assert.doesNotMatch(error.message, /OpenRouter/u);
    return true;
  });
  assert.deepEqual(delays, [250, 500, 1_000]);

  // 2) Timeout -> bounded retries -> decision_timeout
  mode = "hang";
  hits = 0;
  delays.length = 0;
  await assert.rejects(service.port.decide(noulRequest("local-gw")), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, "decision_timeout");
    assert.equal((error as { retries?: number }).retries, 3);
    return true;
  });
  assert.equal(hits, 4);
  assert.deepEqual(delays, [250, 500, 1_000]);

  // 3) HTTP 500 -> bounded retries -> decision_transport
  mode = "500";
  hits = 0;
  delays.length = 0;
  await assert.rejects(service.port.decide(noulRequest("local-gw")), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, "decision_transport");
    assert.equal((error as { retries?: number }).retries, 3);
    assert.match(error.message, /HTTP 500/u);
    assert.match(error.message, /OpenAI-compatible endpoint/u);
    return true;
  });
  assert.equal(hits, 4);
  assert.deepEqual(delays, [250, 500, 1_000]);

  // 4) Transient 429 then 200 -> succeeds on retry
  mode = "429-once";
  hits = 0;
  delays.length = 0;
  const recovered = await service.port.decide(noulRequest("local-gw"));
  assert.equal(recovered.result.type, "noul");
  assert.equal(recovered.result.value, 0.6);
  assert.equal(hits, 2);
  assert.deepEqual(delays, [250]);

  // 5) HTTP 401 -> terminal, redacts secret, marks probe failed
  mode = "401";
  hits = 0;
  delays.length = 0;
  await assert.rejects(service.port.decide(noulRequest("local-gw")), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, "provider_credential_unavailable");
    assert.equal((error as { retries?: number }).retries, 0);
    assert.equal(error.message.includes(secret), false);
    assert.match(error.message, /\[redacted\]/u);
    return true;
  });
  assert.equal(hits, 1);
  assert.deepEqual(delays, []);
  assert.equal(service.list().find(({ providerId }) => providerId === "local-gw")?.probe.state, "failed");

  // 6) HTTP 404 model_not_found -> terminal decision_model_unavailable + probe failed
  mode = "404-model";
  hits = 0;
  delays.length = 0;
  await assert.rejects(service.port.decide(noulRequest("local-gw")), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, "decision_model_unavailable");
    assert.equal((error as { retries?: number }).retries, 0);
    assert.match(error.message, /ha provider update local-gw --model/u);
    return true;
  });
  assert.equal(hits, 1);
  assert.deepEqual(service.list().find(({ providerId }) => providerId === "local-gw")?.probe, {
    state: "failed",
    checkedAt: "2026-11-21T00:00:00.000Z",
    code: "decision_model_unavailable",
  });

  // 7) Malformed outer JSON, non-JSON content, and fabricated choice option -> terminal decision_protocol_invalid
  for (const invalidMode of ["bad-outer-json", "bad-inner-json"] as const) {
    mode = invalidMode;
    hits = 0;
    await assert.rejects(service.port.decide(noulRequest("local-gw")), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "decision_protocol_invalid");
      assert.equal((error as { retries?: number }).retries, 0);
      return true;
    });
    assert.equal(hits, 1);
  }

  mode = "unknown-option";
  hits = 0;
  await assert.rejects(
    service.port.decide({
      subjectRef: "dispatch/unknown-option",
      providerId: "local-gw",
      questionSetVersion: "choice/v1",
      state: ["test"],
      question: {
        type: "choice",
        prompt: "Choose",
        options: [
          { id: "yes", text: "Yes" },
          { id: "no", text: "No" },
        ],
        criteria: { yes: "yes", no: "no" },
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === "decision_protocol_invalid" &&
      (error as { retries?: number }).retries === 0,
  );
  assert.equal(hits, 1);
});
