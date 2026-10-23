// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CredentialPort } from "../src/agent-runtime-credential-port.ts";
import { openDecisionProviderService } from "../src/decision-provider.ts";

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
    return new Response(JSON.stringify({ error: { code: 404, message: "Not Found" } }), {
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
    await assert.rejects(
      service.command({ kind: "provider-probe", providerId: "v1-endpoint" }),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "decision_transport",
    );
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
