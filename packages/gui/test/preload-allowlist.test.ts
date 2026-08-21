// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { daemonGuiActionMethods, daemonGuiReadMethods, daemonGuiStreamFacets } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { HARNESS_PRELOAD_API, assertPreloadPayload, getPreloadApiCapability, isAllowedPreloadApiMethod,
  localMainPreloadMethods, preloadAllowlist, shippedPreloadMethods } from "../src/index.ts";
import { deriveEmptyRepoMethods, deriveRepoScopedMethods } from "../src/preload/allowlist.ts";
import { buildRuntimeInstanceCreatePayload, type CreateInstanceFormState } from "../src/renderer/runtime-instance-form.ts";

const runtimeCreateForm: CreateInstanceFormState = { instanceId: "claude-one", name: "Claude one", kindId: "claude", installationId: "claude-install", providerId: "anthropic", model: "claude-opus", reasoningEffort: "", baseUrl: "", authMode: "subscription", apiKey: "", wireApi: "", requiresOpenAiAuth: false, permissionMode: "bypass", isolation: "operator-environment" };

test("preload exposes only the approved API methods", () => {
  const approved = [...[...daemonGuiReadMethods, ...daemonGuiActionMethods, ...daemonGuiStreamFacets].map(({ guiBridgeMethod }) => guiBridgeMethod), ...localMainPreloadMethods];
  assert.equal(HARNESS_PRELOAD_API, "harness");
  assert.deepEqual(preloadAllowlist, approved);
  assert.deepEqual(shippedPreloadMethods, approved);
  assert.equal(isAllowedPreloadApiMethod("getTasks"), true);
  assert.equal(isAllowedPreloadApiMethod("getTaskDetail"), false);
  assert.throws(() => assertPreloadPayload("readFile", {}), /not allowed/u);
  assert.throws(() => assertPreloadPayload("getTasks", []), /object or null/u);
  assert.throws(() => assertPreloadPayload("getTasks", null), /repoId/u);
  assert.throws(() => assertPreloadPayload("getTasks", {}), /repoId/u);
  assert.throws(() => assertPreloadPayload("getTasks", { repoId: "" }), /repoId/u);
  assert.equal(assertPreloadPayload("getTasks", { repoId: "repo-a" }), true);
  assert.equal(assertPreloadPayload("getTasks", { repoId: "repo-a", status: "active", limit: 50 }), true);
  assert.equal(assertPreloadPayload("getRelationGraph", { repoId: "repo-a", updatedAfter: "2026-08-01T00:00:00.000Z", cursor: "eAo" }), true);
  assert.equal(assertPreloadPayload("getTaskDispatches", { repoId: "repo-a", taskId: "task-a" }), true);
  assert.equal(assertPreloadPayload("getTaskDispatches", { repoId: "repo-a", taskIds: ["task-a", "task-b"], limit: 2 }), true);
  assert.throws(() => assertPreloadPayload("getTaskDispatches", { repoId: "repo-a", taskId: "task-a", taskIds: ["task-b"] }), /invalid/u);
  assert.throws(() => assertPreloadPayload("getTaskDispatches", { repoId: "repo-a", taskIds: ["task-a", "task-a"] }), /invalid/u);
  assert.throws(() => assertPreloadPayload("getTasks", { repoId: "repo-a", limit: 0 }), /query facets are invalid/u);
  assert.throws(() => assertPreloadPayload("getRelationGraph", { repoId: "repo-a", updatedBefore: "not-a-date" }), /query facets are invalid/u);
  assert.throws(() => assertPreloadPayload("getTasks", { repoId: "repo-a", status: "edge_retired" }), /query facets are invalid/u);
  assert.throws(() => assertPreloadPayload("getRelationGraph", { repoId: "repo-a", status: "blocked" }), /query facets are invalid/u);
  assert.equal(assertPreloadPayload("updateRuntimeInstance", { instanceId: "codex-review", enabled: false }), true);
  assert.equal(assertPreloadPayload("updateRuntimeInstance", { instanceId: "codex-review", permissionMode: "read-only" }), true);
  assert.equal(assertPreloadPayload("updateRuntimeInstance", { instanceId: "claude-review", isolationState: "enforced" }), true);
  assert.throws(() => assertPreloadPayload("updateRuntimeInstance", { instanceId: "codex-review", enabled: false, authMode: "api-key" }), /invalid/u);
  assert.throws(() => assertPreloadPayload("getTasks", { repoId: "repo-a", staleRepoId: "repo-b" }), /not allowed/u);
  assert.throws(() => assertPreloadPayload("getSystemStatus", { repoId: "repo-a" }), /not allowed/u);
  assert.equal(getPreloadApiCapability("getTasks").status, "shipped");
  assert.equal(daemonGuiActionMethods.length, 21); assert.equal(daemonGuiActionMethods.some(({ method }) => method === "repo.task.run"), false); assert.equal(daemonGuiActionMethods.some(({ method }) => method === "repo.agentRuntime.cancel"), true); assert.equal(daemonGuiActionMethods.some(({ method }) => method === "repo.agent.entity.write"), true); assert.equal(daemonGuiActionMethods.some(({ method }) => method === "repo.squad.entity.write"), true); assert.equal(preloadAllowlist.includes("daemon.agentRuntime.credentials.bind" as never), false); assert.equal(preloadAllowlist.includes("startTask"), true); assert.equal(preloadAllowlist.includes("showReceipt"), true);
});

test("repo and empty scopes are derived when a GUI contract grows", () => {
  const facets = [{ guiBridgeMethod: "futureRepoRead", requiresRepo: true, inputSchemaId: "gui.empty/v1" }, { guiBridgeMethod: "futureRepoReadWithInput", requiresRepo: true, inputSchemaId: "gui.future/v1" }];
  assert.equal(deriveRepoScopedMethods(facets).has("futureRepoRead"), true);
  assert.equal(deriveRepoScopedMethods(facets).has("futureRepoReadWithInput"), true);
  assert.equal(deriveEmptyRepoMethods(facets).has("futureRepoRead"), true);
  assert.equal(deriveEmptyRepoMethods(facets).has("futureRepoReadWithInput"), false);
});

// The Agent/Squad detail reads are contract-derived with their own input schema:
// they must stay payload-open (repoId + entity id) while true empty-schema reads
// stay closed to repoId only. Replayed against the real contract facets, not
// synthetic ones, so a derivation regression cannot hide behind a fixture.
test("Agent and Squad detail payload paths stay open on the real contract", () => {
  assert.equal(assertPreloadPayload("showAgent", { repoId: "repo-a", agentId: "fable" }), true);
  assert.equal(assertPreloadPayload("showSquad", { repoId: "repo-a", squadId: "core-squad" }), true);
  assert.equal(assertPreloadPayload("listAgents", { repoId: "repo-a" }), true);
  assert.equal(assertPreloadPayload("listSquads", { repoId: "repo-a" }), true);
  assert.throws(() => assertPreloadPayload("listAgents", { repoId: "repo-a", agentId: "fable" }), /not allowed/u);
});

test("Agent and Squad writes stay on the daemon allowlist and reject secret-shaped declaration keys", () => {
  const agent = { repoId: "repo-a", declaration: { schema: "agent-declaration/v1", id: "fable", name: "Fable", instructions: "Review.", runtime_type: "any" } };
  const squad = { repoId: "repo-a", declaration: { schema: "squad-declaration/v1", id: "blue-squad", name: "Blue", leader: "fable", workers: [], roster: "# Blue\n" } };
  assert.equal(assertPreloadPayload("saveAgent", agent), true); assert.equal(assertPreloadPayload("saveSquad", squad), true);
  assert.throws(() => assertPreloadPayload("saveAgent", { ...agent, declaration: { ...agent.declaration, apiKey: "no" } }), /secret-like key/u);
});

// The only tolerated secret payload is the user-typed create-form key, and only
// on createRuntimeInstance in api-key mode: nowhere else, never nested, never on
// a subscription create.
test("the create-form API key carve-out is a single method and a single field", () => {
  const create = (overrides: Record<string, unknown>): Record<string, unknown> => ({ instanceId: "codex-sidecar", name: "Codex sidecar", kindId: "codex", installationId: "codex-install", providerId: "codex_local_access", models: ["gpt-5.6-terra"], codex: { baseUrl: "http://localhost:50818/v1", wireApi: "responses", requiresOpenAiAuth: true }, authMode: "api-key", apiKey: "sk-typed-by-user", ...overrides });
  assert.equal(assertPreloadPayload("createRuntimeInstance", create()), true);
  assert.throws(() => assertPreloadPayload("createRuntimeInstance", create({ authMode: "subscription" })), /invalid/u);
  assert.throws(() => assertPreloadPayload("createRuntimeInstance", create({ apiKey: "  " })), /invalid/u);
  assert.throws(() => assertPreloadPayload("createRuntimeInstance", create({ codex: { apiKey: "nested-forbidden" } })), /secret-like key/u);
  assert.throws(() => assertPreloadPayload("showRuntimeInstance", { instanceId: "codex-sidecar", apiKey: "wrong-method" }), /secret-like key/u);
  assert.throws(() => assertPreloadPayload("spawnAgentRuntime", { repoId: "repo-a", nested: { apiKey: "wrong-path" } }), /secret-like key/u);
});

test("preload accepts the renderer's codex create payload", () => {
  const payload = buildRuntimeInstanceCreatePayload({ ...runtimeCreateForm, instanceId: "codex-sidecar", name: "Codex sidecar", kindId: "codex", providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", permissionMode: "workspace-write", isolation: "enforced" }, "codex-install");
  assert.deepEqual(Object.keys(payload).sort(), ["authMode", "codex", "installationId", "instanceId", "isolationState", "kindId", "models", "name", "permissionMode", "providerId"]);
  assert.equal(assertPreloadPayload("createRuntimeInstance", payload), true);
});

test("preload accepts the renderer's claude create payload", () => {
  const payload = buildRuntimeInstanceCreatePayload(runtimeCreateForm, "claude-install");
  assert.deepEqual(Object.keys(payload).sort(), ["authMode", "claude", "installationId", "instanceId", "isolationState", "kindId", "models", "name", "permissionMode", "providerId"]);
  assert.equal(assertPreloadPayload("createRuntimeInstance", payload), true);
});

test("preload accepts the renderer's agy create payload", () => {
  const payload = buildRuntimeInstanceCreatePayload({ ...runtimeCreateForm, instanceId: "agy-one", name: "agy one", kindId: "agy", providerId: "google", model: "gemini-3.1-pro-low", reasoningEffort: "medium", permissionMode: undefined }, "agy-install");
  assert.deepEqual(Object.keys(payload).sort(), ["agy", "authMode", "installationId", "instanceId", "kindId", "models", "name", "providerId"]);
  assert.equal(assertPreloadPayload("createRuntimeInstance", payload), true);
});

test("runtime create rejection names an unknown field and the allowed expectation", () => {
  const payload = buildRuntimeInstanceCreatePayload(runtimeCreateForm, "claude-install");
  assert.throws(() => assertPreloadPayload("createRuntimeInstance", { ...payload, unexpectedField: true }), /unexpectedField.*expected only/u);
});

test("runtime create rejection names invalid models and the expected shape", () => {
  const payload = buildRuntimeInstanceCreatePayload(runtimeCreateForm, "claude-install");
  assert.throws(() => assertPreloadPayload("createRuntimeInstance", { ...payload, models: [] }), /models.*non-empty array.*non-blank strings/u);
});

test("runtime create rejection names invalid permission mode and its enum", () => {
  const payload = buildRuntimeInstanceCreatePayload(runtimeCreateForm, "claude-install");
  assert.throws(() => assertPreloadPayload("createRuntimeInstance", { ...payload, permissionMode: "admin" }), /permissionMode.*bypass, workspace-write, or read-only/u);
});

test("runtime create rejection names invalid isolation state and its enum", () => {
  const payload = buildRuntimeInstanceCreatePayload(runtimeCreateForm, "claude-install");
  assert.throws(() => assertPreloadPayload("createRuntimeInstance", { ...payload, isolationState: "disabled" }), /isolationState.*enforced or operator-environment/u);
});
