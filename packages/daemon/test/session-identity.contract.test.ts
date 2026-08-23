// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { runtimeProtocolFamilies, type RuntimeProtocolFamily, type SessionIdentity } from "../../kernel/src/index.ts";
import { resolveSessionIdentity, resolveWriteSessionIdentity, sessionIdentityResolverFor, transcriptRefForSessionIdentity } from "../src/session-identity/index.ts";

interface FixtureMeta { readonly fixture: "captured-provider-session-identity/v1"; readonly protocolFamily: RuntimeProtocolFamily; readonly runtime: string; readonly sourceDispatchId: string; readonly capturePolicy: string; readonly expectedSessionId: string; readonly expectedTranscriptReachability: SessionIdentity["transcriptReachability"]; readonly environmentSnapshot?: Readonly<Record<string, string>> }
type FixtureRecord = FixtureMeta | Readonly<Record<string, unknown>>;

test("every protocol family owns a resolver and a real captured provider fixture", () => {
  for (const family of runtimeProtocolFamilies) {
    const fixtureUrl = new URL(`./fixtures/session-identity/${family}.jsonl`, import.meta.url);
    assert.equal(existsSync(fixtureUrl), true, `missing real provider fixture for ${family}`);
    const records = readFileSync(fixtureUrl, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line) as FixtureRecord), meta = records[0] as FixtureMeta, events = records.slice(1), header = events.find((record) => record.kind === "dispatch"), binding = events.find((record) => record.kind === "provider_binding");
    assert.equal(meta.fixture, "captured-provider-session-identity/v1"); assert.equal(meta.protocolFamily, family); assert.match(meta.capturePolicy, /real dispatch/u); assert.equal(typeof meta.sourceDispatchId, "string");
    assert.ok(header && typeof header.eventStreamRef === "string"); assert.ok(binding && typeof binding.providerSessionId === "string");
    assert.equal(typeof sessionIdentityResolverFor(family).resolve, "function");
    const identity = resolveSessionIdentity(family, { runtime: meta.runtime, dispatchEvents: events, providerBinding: { sessionId: binding.providerSessionId, transcriptRef: header.eventStreamRef } });
    assert.deepEqual(identity, { runtime: meta.runtime, sessionId: meta.expectedSessionId, transcriptReachability: meta.expectedTranscriptReachability });
    assert.equal(transcriptRefForSessionIdentity(identity, header.eventStreamRef), family === "claude-compatible" ? `provider:${meta.runtime}/${meta.expectedSessionId}` : header.eventStreamRef);
  }
});

test("unresolved identity is explicit for every family and never fabricates a surrogate", () => {
  for (const family of runtimeProtocolFamilies) assert.deepEqual(resolveSessionIdentity(family, { runtime: family }), { runtime: family, sessionId: null, transcriptReachability: "unavailable" });
});

test("Claude uses the transcript session variable and never the host session trap", () => {
  const meta = fixtureMeta("claude-compatible"), env = meta.environmentSnapshot!;
  assert.deepEqual(resolveSessionIdentity("claude-compatible", { runtime: "claude", env }), { runtime: "claude", sessionId: env.CLAUDE_CODE_SESSION_ID, transcriptReachability: "by_session_id" });
  assert.deepEqual(resolveSessionIdentity("claude-compatible", { runtime: "claude", env: { CLAUDE_CODE_HOST_SESSION_ID: env.CLAUDE_CODE_HOST_SESSION_ID } }), { runtime: "claude", sessionId: null, transcriptReachability: "unavailable" });
});

test("Codex accepts only thread.started identity equal to provider binding", () => {
  const meta = fixtureMeta("codex"), mismatched = resolveSessionIdentity("codex", { runtime: "codex", dispatchEvents: [{ type: "thread.started", thread_id: meta.expectedSessionId }], providerBinding: { sessionId: "not-the-thread-id", transcriptRef: "file:.harness/runtime/dispatches/mismatch.jsonl" } });
  assert.deepEqual(mismatched, { runtime: "codex", sessionId: null, transcriptReachability: "unavailable" });
  assert.deepEqual(resolveSessionIdentity("codex", { runtime: "codex", dispatchEvents: [{ session_id: "rollout-shaped-but-not-thread-started" }] }), { runtime: "codex", sessionId: null, transcriptReachability: "unavailable" });
});

test("interactive Codex identity comes only from its family-owned session variables", () => {
  const expected = { runtime: "codex", sessionId: "codex-interactive-thread", transcriptReachability: "by_session_id" };
  assert.deepEqual(resolveSessionIdentity("codex", { runtime: "codex", env: { CODEX_THREAD_ID: expected.sessionId } }), expected);
  assert.deepEqual(resolveSessionIdentity("codex", { runtime: "codex", env: { CODEX_SESSION_ID: expected.sessionId } }), expected);
  assert.deepEqual(resolveSessionIdentity("codex", { runtime: "codex", env: { CODEX_THREAD_ID: expected.sessionId, CODEX_SESSION_ID: expected.sessionId } }), expected);
  assert.deepEqual(resolveSessionIdentity("codex", { runtime: "codex", env: { CODEX_THREAD_ID: expected.sessionId, CODEX_SESSION_ID: "different-session" } }), { runtime: "codex", sessionId: null, transcriptReachability: "unavailable" });
});

test("interactive writes resolve one family or fail closed without fabricating identity", () => {
  const binding = (sessionEnvironment?: Readonly<Record<string, string>>) => ({ actor: { principal: { personId: "person-human" }, executor: null }, sessionEnvironment }), projection = { readRuntimeSession: () => null, readRuntimeInstallation: () => null } as never;
  assert.deepEqual(resolveWriteSessionIdentity(binding({ CLAUDE_CODE_SESSION_ID: "claude-interactive", CLAUDE_CODE_HOST_SESSION_ID: "local-wrong" }), projection), { runtime: "claude", sessionId: "claude-interactive", transcriptReachability: "by_session_id" });
  assert.deepEqual(resolveWriteSessionIdentity(binding({ CLAUDE_CODE_HOST_SESSION_ID: "local-wrong" }), projection), { runtime: "unavailable", sessionId: null, transcriptReachability: "unavailable" });
  assert.deepEqual(resolveWriteSessionIdentity(binding({ CODEX_THREAD_ID: "codex-interactive" }), projection), { runtime: "codex", sessionId: "codex-interactive", transcriptReachability: "by_session_id" });
  assert.deepEqual(resolveWriteSessionIdentity(binding({ CLAUDE_CODE_SESSION_ID: "claude-interactive", CODEX_THREAD_ID: "codex-interactive" }), projection), { runtime: "unavailable", sessionId: null, transcriptReachability: "unavailable" });
  assert.deepEqual(resolveWriteSessionIdentity(binding(), projection), { runtime: "unavailable", sessionId: null, transcriptReachability: "unavailable" });
});

test("Agy binds only its observed init conversation_id", () => {
  const meta = fixtureMeta("agy");
  assert.deepEqual(resolveSessionIdentity("agy", { runtime: "agy", dispatchEvents: [{ event: "result", result: { conversation_id: meta.expectedSessionId } }] }), { runtime: "agy", sessionId: null, transcriptReachability: "unavailable" });
  assert.deepEqual(resolveSessionIdentity("agy", { runtime: "agy", dispatchEvents: [{ event: "init", conversation_id: meta.expectedSessionId }] }), { runtime: "agy", sessionId: meta.expectedSessionId, transcriptReachability: "dispatch_stream_only" });
});

function fixtureMeta(family: RuntimeProtocolFamily): FixtureMeta { return JSON.parse(readFileSync(new URL(`./fixtures/session-identity/${family}.jsonl`, import.meta.url), "utf8").split(/\r?\n/u)[0]!) as FixtureMeta; }
