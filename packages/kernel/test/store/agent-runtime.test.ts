// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { eventFromProviderWitness, type ProviderWitnessV1 } from "../../src/agent-runtime/provider-witness.ts";
import { reduceRuntimeSession, runtimeEventContentClaims, validateCurrentAgentRuntimeEvent, type AgentRuntimeEventType, type AgentRuntimeEventV1 } from "../../src/domain/agent-runtime.ts";
import { serializeCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { eventObjectRelativePath } from "../../src/layout/ledger-object-layout.ts";
import { makeTaskProjection } from "../../src/projection/task-projection.ts";
import { CANONICAL_EVENT_REF, canonicalEventWritePlan, makeTaskEventStore, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

type Fixture = { readonly schema: string; readonly profile: string; readonly witnesses: readonly ProviderWitnessV1[] };
const claude = fixture("claude-compatible.json"), codex = fixture("codex.json");
const actor = { principal: { personId: "person-runtime" }, executor: null } as const;
const envelope = (revision: number, source: AgentRuntimeEventV1["source"] = "local") => ({ eventId: `event-runtime-${revision}`, workspaceRevision: revision,
  opId: `op-runtime-${revision}`, actor, source, occurredAt: `2026-08-12T00:00:0${revision}.000Z`, hostRef: "host:local" });

test("Claude-compatible wrapper and Codex hook fixtures reuse one safe structured witness shape", () => {
  assert.equal(claude.witnesses.length, codex.witnesses.length);
  for (const [index, left] of claude.witnesses.entries()) {
    const right = codex.witnesses[index]!;
    assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort());
    assert.deepEqual(Object.keys(left.payload).sort(), Object.keys(right.payload).sort());
  }
  for (const fixtureValue of [claude, codex]) assert.deepEqual(forbiddenKeys(fixtureValue), []);
});

test("runtime events use the canonical envelope, head, store, and the shared projection transaction", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir); const store = makeTaskEventStore({ repoId: "test-repo", rootDir }), projection = makeTaskProjection({ rootDir, eventStore: store });
    const events = claude.witnesses.map((witness, index) => eventFromProviderWitness(witness, envelope(index + 1))).filter((event): event is AgentRuntimeEventV1 => event !== null);
    events.push(eventFromProviderWitness({ ...claude.witnesses[0]!, payload: { ...claude.witnesses[0]!.payload, version: "1.1.0" } }, envelope(events.length + 1))!);
    for (const event of events) { const receipt = store.append(bundle(event)); assert.deepEqual(projection.apply(event).metrics, { sqliteTransactions: 1, reducedItems: 1 }); assert.equal(receipt.revision, event.workspaceRevision); }
    assert.equal(store.readHead()?.revision, events.length); assert.deepEqual(store.readEvent(events.at(-1)!.opId), events.at(-1));
    assert.equal(git(rootDir, "show", `${CANONICAL_EVENT_REF}:harness/${eventObjectRelativePath(events[0]!.opId)}`), serializeCanonicalEvent(events[0]!).trimEnd());
    assert.deepEqual(projection.readRuntimeInstallation("installation-claude"), { installationId: "installation-claude", kindId: "claude-compatible", protocolFamily: "claude-compatible", hostRef: "host:local", version: "1.1.0", discoverySource: "wrapper", effectiveCapabilities: ["structured_witness", "resume"], lastObservedAt: "2026-08-12T00:00:09.000Z" });
    const session = projection.readRuntimeSession("runtime-session-claude"); assert.equal(session?.providerSessionId, "provider-session-claude");
    const dispatch = projection.readRuntimeDispatch("runtime-session-claude", session!.definitionSnapshotRef); assert.equal(dispatch?.type, "runtime_dispatch_requested"); assert.equal(dispatch?.payload.runtimeSessionId, session?.runtimeSessionId); assert.equal(projection.readRuntimeDispatch("runtime-session-claude", "artifact:runtime-definitions/missing"), null);
    const db = new DatabaseSync(projection.path, { readOnly: true }); try { const plan = db.prepare("EXPLAIN QUERY PLAN SELECT event_json FROM event_index WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1' AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested' AND json_extract(event_json, '$.payload.runtimeSessionId') = ? AND json_extract(event_json, '$.payload.definitionSnapshotRef') = ? ORDER BY workspace_revision LIMIT 1").all("runtime-session-claude", session!.definitionSnapshotRef) as readonly { readonly detail: string }[]; assert.match(plan.map(({ detail }) => detail).join("\n"), /SEARCH event_index USING INDEX event_index_runtime_dispatch_lookup/u); } finally { db.close(); }
    assert.deepEqual(session?.taskBindings.map(({ taskId, executionId, transcriptRef }) => ({ taskId, executionId, transcriptRef })), [{ taskId: "task-runtime", executionId: "execution-claude", transcriptRef: "file:runtime-transcripts/claude/session.jsonl" }]);
    assert.deepEqual(projection.readRuntimeSessionsForTask("task-runtime").map((value) => value.runtimeSessionId), ["runtime-session-claude"]);
  });
});

test("raw heartbeat is operational only while a threshold liveness witness appends canonically", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir); const store = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const heartbeat = claude.witnesses.at(-1)!; assert.equal(heartbeat.type, "heartbeat"); assert.equal(eventFromProviderWitness(heartbeat, envelope(1)), null); assert.equal(store.read().revision, 0);
    const changed = eventFromProviderWitness({ ...heartbeat, type: "runtime_session_liveness_changed", payload: { runtimeSessionId: "runtime-session-claude", liveness: "stale" } }, envelope(1));
    assert.notEqual(changed, null); if (changed !== null) store.append(bundle(changed)); assert.equal(store.read().revision, 1);
  });
});

test("witness provenance is envelope-bound and local or assignment provenance reduces identically", () => {
  const startedWitness = witness("runtime_session_started"), local = eventFromProviderWitness(startedWitness, envelope(1, "local"))!, assignment = eventFromProviderWitness(startedWitness,
    envelope(1, { kind: "assignment", nodeId: "implementation", assignmentId: "assignment-1" }))!;
  assert.notDeepEqual(local.source, assignment.source); assert.deepEqual(local.payload, assignment.payload);
  assert.deepEqual(reduceRuntimeSession(null, local), reduceRuntimeSession(null, assignment));
  for (const selfReported of [{ actor }, { source: "local" }, { workspaceId: "workspace-client" }, { occurredAt: "2026-08-12T00:00:00.000Z" }])
    assert.throws(() => eventFromProviderWitness({ ...startedWitness, ...selfReported } as unknown as ProviderWitnessV1, envelope(1)), /witness/iu);
  for (const selfReported of [{ actor }, { source: "local" }, { workspaceId: "workspace-client" }, { occurredAt: "2026-08-12T00:00:00.000Z" }])
    assert.throws(() => eventFromProviderWitness({ ...startedWitness, payload: { ...startedWitness.payload, ...selfReported } }, envelope(1)), /payload/iu);
  assert.match(validateCurrentAgentRuntimeEvent({ ...local, payload: { ...local.payload, occurredAt: local.occurredAt } }).join("\n"), /payload/iu);
});

test("agent runtime source has no per-session store or legacy JSONL ledger", () => {
  const layout = readFileSync(new URL("../../src/layout/index.ts", import.meta.url), "utf8"), adapter = readFileSync(new URL("../../src/agent-runtime/provider-witness.ts", import.meta.url), "utf8"), domain = readFileSync(new URL("../../src/domain/agent-runtime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(layout, /runtimeEventLedger|runtime-events/iu); assert.doesNotMatch(`${adapter}\n${domain}`, /DatabaseSync|writeFile|appendFile|sqlite|jsonl/iu);
});

test("projection reopen and rebuild project nonterminal sessions unknown before reads without growing the canonical log", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir); const store = makeTaskEventStore({ repoId: "test-repo", rootDir }), original = makeTaskProjection({ rootDir, eventStore: store });
    const started = eventFromProviderWitness(witness("runtime_session_started"), envelope(1))!;
    const exitedStarted = { ...started, eventId: "event-runtime-2", opId: "op-runtime-2", workspaceRevision: 2, payload: { ...started.payload, runtimeSessionId: "runtime-session-exited" } } as AgentRuntimeEventV1;
    const exited = eventFromProviderWitness({ ...witness("runtime_session_exited"), payload: { runtimeSessionId: "runtime-session-exited" } }, envelope(3))!;
    for (const event of [started, exitedStarted, exited]) { store.append(bundle(event)); original.apply(event); }
    assert.equal(original.readRuntimeSession("runtime-session-claude")?.liveness, "live"); assert.equal(original.readRuntimeSession("runtime-session-exited")?.liveness, "exited"); const before = store.read().revision;
    const reopened = makeTaskProjection({ rootDir, eventStore: store });
    assert.deepEqual(runtimeState(reopened, "runtime-session-claude"), { liveness: "unknown", attachable: false }); assert.deepEqual(runtimeState(reopened, "runtime-session-exited"), { liveness: "exited", attachable: false }); assert.equal(store.read().revision, before);
    const rebuilt = reopened.rebuild(); assert.equal(rebuilt.metrics.sqliteTransactions, 2); assert.deepEqual(runtimeState(reopened, "runtime-session-claude"), { liveness: "unknown", attachable: false }); assert.deepEqual(runtimeState(reopened, "runtime-session-exited"), { liveness: "exited", attachable: false }); assert.equal(store.read().revision, before);
    const adopted = eventFromProviderWitness({ ...witness("heartbeat"), type: "runtime_session_liveness_changed", payload: { runtimeSessionId: "runtime-session-claude", liveness: "live" } }, envelope(4))!; store.append(bundle(adopted)); reopened.apply(adopted); assert.deepEqual(runtimeState(reopened, "runtime-session-claude"), { liveness: "live", attachable: true });
    assert.equal(reopened.read("task-runtime").snapshot.task, null);
  });
});

test("dispatch requested and outcome unknown round-trip without retry or session fabrication", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir); const store = makeTaskEventStore({ repoId: "test-repo", rootDir }), projection = makeTaskProjection({ rootDir, eventStore: store });
    const requested = eventFromProviderWitness(witness("runtime_dispatch_requested"), envelope(1))!, unknown = eventFromProviderWitness(witness("runtime_dispatch_outcome_unknown"), envelope(2))!;
    for (const event of [requested, unknown]) { store.append(bundle(event)); assert.deepEqual(projection.apply(event).metrics, { sqliteTransactions: 1, reducedItems: 1 }); assert.deepEqual(store.readEvent(event.opId), event); }
    assert.equal(store.readHead()?.revision, 2); assert.deepEqual(store.read().events.map((event) => event.type), ["runtime_dispatch_requested", "runtime_dispatch_outcome_unknown"]); assert.equal(projection.readRuntimeSession("runtime-session-claude"), null);
    projection.rebuild(); assert.equal(projection.readRuntimeSession("runtime-session-claude"), null); assert.equal(store.read().revision, 2);
    assert.throws(() => eventFromProviderWitness({ ...witness("runtime_dispatch_requested"), payload: { ...witness("runtime_dispatch_requested").payload, definitionSnapshotRef: "https://unsafe.example/definition" } }, envelope(3)), /payload/iu);
    assert.throws(() => eventFromProviderWitness({ ...witness("runtime_dispatch_outcome_unknown"), payload: { ...witness("runtime_dispatch_outcome_unknown").payload, retry: true } }, envelope(3)), /payload/iu);
  });
});

test("session outcome and exit round-trip while exited remains terminal", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir); const store = makeTaskEventStore({ repoId: "test-repo", rootDir }), projection = makeTaskProjection({ rootDir, eventStore: store });
    const events = [witness("runtime_session_started"), witness("runtime_session_outcome_observed"), witness("runtime_session_exited")].map((value, index) => eventFromProviderWitness(value, envelope(index + 1))!);
    for (const event of events) { store.append(bundle(event)); assert.deepEqual(projection.apply(event).metrics, { sqliteTransactions: 1, reducedItems: 1 }); assert.deepEqual(store.readEvent(event.opId), event); }
    assert.equal(store.readHead()?.revision, 3); assert.deepEqual(projection.readRuntimeSession("runtime-session-claude"), { runtimeSessionId: "runtime-session-claude", instanceId: "claude-fixture", installationId: "installation-claude", kindId: "claude", definitionSnapshotRef: "artifact:runtime-definitions/claude/v1", providerSessionId: null, transcriptRef: null, launchGeneration: 1, liveness: "exited", attachable: false, taskBindings: [], outcome: "succeeded", exitCode: 0, resultRef: "artifact:runtime-result/sha256/bc4e5d54eb57cccf71e6b1e926ea7fe979ee04cdc883ba550ac827f576e89787", lastObservedAt: "2026-08-12T00:00:03.000Z" });
    const liveness = eventFromProviderWitness({ ...witness("heartbeat"), type: "runtime_session_liveness_changed", payload: { runtimeSessionId: "runtime-session-claude", liveness: "live" } }, envelope(4))!;
    assert.throws(() => projection.apply(liveness), /already exited/iu); assert.equal(projection.readRuntimeSession("runtime-session-claude")?.liveness, "exited"); assert.equal(store.read().revision, 3);
    assert.throws(() => eventFromProviderWitness({ ...witness("runtime_session_outcome_observed"), payload: { ...witness("runtime_session_outcome_observed").payload, resultRef: "inline result" } }, envelope(4)), /payload/iu);
    assert.throws(() => eventFromProviderWitness({ ...witness("runtime_session_exited"), payload: { ...witness("runtime_session_exited").payload, reason: "client supplied" } }, envelope(4)), /payload/iu);
  });
});

test("runtime schema rejects credential, transcript body, tool/cost stream, and non-reference transcript data", () => {
  const bound = eventFromProviderWitness(witness("runtime_session_task_bound"), envelope(1))!;
  for (const forbidden of [
    { credential: "secret" }, { transcript: "full conversation" }, { tool: { name: "shell" } }, { cost: { amount: 1 } }
  ]) assert.match(validateCurrentAgentRuntimeEvent({ ...bound, payload: { ...bound.payload, ...forbidden } }).join("\n"), /payload/iu);
  assert.throws(() => serializeCanonicalEvent({ ...bound, payload: { ...bound.payload, transcriptRef: "full\nconversation" } } as AgentRuntimeEventV1), /transcript ref|payload/iu);
  const dispatch = witness("runtime_dispatch_requested"); assert.throws(() => eventFromProviderWitness({ ...dispatch, payload: { ...dispatch.payload, definitionSnapshot: { ...(dispatch.payload.definitionSnapshot as Record<string, unknown>), credentialRef: "keychain:forbidden" } } }, envelope(2)), /payload/iu);
  assert.deepEqual(forbiddenKeys(bound), []);
});

function fixture(name: string): Fixture { return JSON.parse(readFileSync(new URL(`../fixtures/agent-runtime-witness/${name}`, import.meta.url), "utf8")) as Fixture; }
function witness(type: AgentRuntimeEventType | "heartbeat"): ProviderWitnessV1 { const value = claude.witnesses.find((candidate) => candidate.type === type); if (value === undefined) throw new Error(`missing ${type} witness`); return value; }
function runtimeState(projection: ReturnType<typeof makeTaskProjection>, runtimeSessionId: string): { readonly liveness: string; readonly attachable: boolean } | null { const session = projection.readRuntimeSession(runtimeSessionId); return session === null ? null : { liveness: session.liveness, attachable: session.attachable }; }
const FIXTURE_RESULT_TEXT = "fixture result"; // sha256 bc4e5d54eb57cccf71e6b1e926ea7fe979ee04cdc883ba550ac827f576e89787, matches both fixtures' runtime_session_outcome_observed.payload.result
function bundle(event: AgentRuntimeEventV1): CanonicalWriteBundle { return { event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: runtimeEventContentClaims(event).map((claim) => ({ ...claim, body: FIXTURE_RESULT_TEXT })) }; }
function forbiddenKeys(value: unknown, found: string[] = []): string[] { if (Array.isArray(value)) { for (const item of value) forbiddenKeys(item, found); return found; } if (typeof value !== "object" || value === null) return found;
  for (const [key, nested] of Object.entries(value)) { if (["credential", "transcript", "transcriptBody", "tool", "cost", "stdout", "stderr"].includes(key)) found.push(key); forbiddenKeys(nested, found); } return found; }
function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Runtime Test"); git(rootDir, "config", "user.email", "runtime@example.invalid"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
