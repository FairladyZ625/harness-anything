// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { eventFromProviderWitness, type ProviderWitnessV1 } from "../../src/agent-runtime/provider-witness.ts";
import { markRuntimeSessionUnknown, reduceRuntimeSession, type AgentRuntimeEventV1 } from "../../src/domain/agent-runtime.ts";
import { serializeCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { makeTaskProjection } from "../../src/projection/task-projection.ts";
import { CANONICAL_EVENT_REF, makeTaskEventStore } from "../../src/store/task-event-store.ts";
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
    events.push(eventFromProviderWitness({ ...claude.witnesses[0]!, payload: { ...claude.witnesses[0]!.payload, version: "1.1.0", authState: "invalid" } }, envelope(events.length + 1))!);
    for (const event of events) { const receipt = store.append(event); assert.deepEqual(projection.apply(event).metrics, { sqliteTransactions: 1, reducedItems: 1 }); assert.equal(receipt.revision, event.workspaceRevision); }
    assert.equal(store.readHead()?.revision, events.length); assert.deepEqual(store.readEvent(events.at(-1)!.opId), events.at(-1));
    assert.equal(git(rootDir, "show", `${CANONICAL_EVENT_REF}:harness/events/${events[0]!.opId}.json`), serializeCanonicalEvent(events[0]!).trimEnd());
    assert.deepEqual(projection.readRuntimeInstallation("installation-claude"), { installationId: "installation-claude", kindId: "claude-compatible", protocolFamily: "claude-compatible", hostRef: "host:local", version: "1.1.0", discoverySource: "wrapper", effectiveCapabilities: ["structured_witness", "resume"], authState: "invalid", lastObservedAt: "2026-08-12T00:00:05.000Z" });
    const session = projection.readRuntimeSession("runtime-session-claude"); assert.equal(session?.providerSessionId, "provider-session-claude");
    assert.deepEqual(session?.taskBindings.map(({ taskId, executionId, transcriptRef }) => ({ taskId, executionId, transcriptRef })), [{ taskId: "task-runtime", executionId: "execution-claude", transcriptRef: "file:runtime-transcripts/claude/session.jsonl" }]);
    assert.deepEqual(projection.readRuntimeSessionsForTask("task-runtime").map((value) => value.runtimeSessionId), ["runtime-session-claude"]);
  });
});

test("raw heartbeat is operational only while a threshold liveness witness appends canonically", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir); const store = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const heartbeat = claude.witnesses.at(-1)!; assert.equal(heartbeat.type, "heartbeat"); assert.equal(eventFromProviderWitness(heartbeat, envelope(1)), null); assert.equal(store.read().revision, 0);
    const changed = eventFromProviderWitness({ ...heartbeat, type: "runtime_session_liveness_changed", payload: { runtimeSessionId: "runtime-session-claude", liveness: "stale" } }, envelope(1));
    assert.notEqual(changed, null); if (changed !== null) store.append(changed); assert.equal(store.read().revision, 1);
  });
});

test("witness provenance is envelope-bound and local or assignment provenance reduces identically", () => {
  const startedWitness = claude.witnesses[1]!, local = eventFromProviderWitness(startedWitness, envelope(1, "local"))!, assignment = eventFromProviderWitness(startedWitness,
    envelope(1, { kind: "assignment", nodeId: "implementation", assignmentId: "assignment-1" }))!;
  assert.notDeepEqual(local.source, assignment.source); assert.deepEqual(local.payload, assignment.payload);
  assert.deepEqual(reduceRuntimeSession(null, local), reduceRuntimeSession(null, assignment));
  for (const selfReported of [{ actor }, { source: "local" }, { workspaceId: "workspace-client" }, { occurredAt: "2026-08-12T00:00:00.000Z" }])
    assert.throws(() => eventFromProviderWitness({ ...startedWitness, ...selfReported } as unknown as ProviderWitnessV1, envelope(1)), /witness/iu);
  for (const selfReported of [{ actor }, { source: "local" }, { workspaceId: "workspace-client" }, { occurredAt: "2026-08-12T00:00:00.000Z" }])
    assert.throws(() => eventFromProviderWitness({ ...startedWitness, payload: { ...startedWitness.payload, ...selfReported } }, envelope(1)), /payload/iu);
  assert.throws(() => serializeCanonicalEvent({ ...local, payload: { ...local.payload, occurredAt: local.occurredAt } } as AgentRuntimeEventV1), /payload/iu);
});

test("agent runtime source has no per-session store or legacy JSONL ledger", () => {
  const layout = readFileSync(new URL("../../src/layout/index.ts", import.meta.url), "utf8"), adapter = readFileSync(new URL("../../src/agent-runtime/provider-witness.ts", import.meta.url), "utf8"), domain = readFileSync(new URL("../../src/domain/agent-runtime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(layout, /runtimeEventLedger|runtime-events/iu); assert.doesNotMatch(`${adapter}\n${domain}`, /DatabaseSync|writeFile|appendFile|sqlite|jsonl/iu);
});

test("restart projects nonterminal session liveness to unknown without changing task lifecycle or the canonical log", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir); const store = makeTaskEventStore({ repoId: "test-repo", rootDir }), projection = makeTaskProjection({ rootDir, eventStore: store });
    const started = eventFromProviderWitness(claude.witnesses[1]!, envelope(1))!; store.append(started); projection.apply(started);
    assert.equal(projection.readRuntimeSession("runtime-session-claude")?.liveness, "live"); const before = store.read().revision;
    assert.equal(projection.markRuntimeSessionsUnknown(), 1); assert.equal(projection.readRuntimeSession("runtime-session-claude")?.liveness, "unknown"); assert.equal(store.read().revision, before);
    assert.equal(markRuntimeSessionUnknown({ ...projection.readRuntimeSession("runtime-session-claude")!, liveness: "exited" }).liveness, "exited");
    assert.equal(projection.read("task-runtime").snapshot.task, null);
  });
});

test("runtime schema rejects credential, transcript body, tool/cost stream, and non-reference transcript data", () => {
  const bound = eventFromProviderWitness(claude.witnesses[3]!, envelope(1))!;
  for (const forbidden of [
    { credential: "secret" }, { transcript: "full conversation" }, { tool: { name: "shell" } }, { cost: { amount: 1 } }
  ]) assert.throws(() => serializeCanonicalEvent({ ...bound, payload: { ...bound.payload, ...forbidden } } as AgentRuntimeEventV1), /payload/iu);
  assert.throws(() => serializeCanonicalEvent({ ...bound, payload: { ...bound.payload, transcriptRef: "full\nconversation" } } as AgentRuntimeEventV1), /transcript ref|payload/iu);
  assert.deepEqual(forbiddenKeys(bound), []);
});

function fixture(name: string): Fixture { return JSON.parse(readFileSync(new URL(`../fixtures/agent-runtime-witness/${name}`, import.meta.url), "utf8")) as Fixture; }
function forbiddenKeys(value: unknown, found: string[] = []): string[] { if (Array.isArray(value)) { for (const item of value) forbiddenKeys(item, found); return found; } if (typeof value !== "object" || value === null) return found;
  for (const [key, nested] of Object.entries(value)) { if (["credential", "transcript", "transcriptBody", "tool", "cost", "stdout", "stderr"].includes(key)) found.push(key); forbiddenKeys(nested, found); } return found; }
function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Runtime Test"); git(rootDir, "config", "user.email", "runtime@example.invalid"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
