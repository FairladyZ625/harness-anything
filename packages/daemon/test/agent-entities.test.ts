// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readAgentEntityGuiProjection, resolveSquadDispatchTarget, runAgentEntityAction } from "../src/agent-entities.ts";
import { validateAgentDeclarationV1 } from "../src/agent-entities.contract.ts";

const agent = { schema: "agent-declaration/v1", id: "terra", name: "Terra", instructions: "Review precisely.", runtime_type: "codex", model: "gpt-5.6-terra", skills: ["review"], prompts: ["prompt://review"], preset: "standard-task" }, squad = { schema: "squad-declaration/v1", id: "core-squad", name: "Core Squad", leader: "terra", workers: ["terra"], roster: "# Core Squad\n\nTerra leads review." };

test("Agent and Squad entities install, list, inspect, and reinstall through their own store outside the preset system", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-entities-")), source = path.join(rootDir, "source");
  try {
    writeEntity(source, "terra", "agent", agent); writeEntity(source, "core-squad", "squad", squad);
    assert.equal((run({ rootDir, kind: "agent-validate", packageSource: path.join(source, "terra") }) as { valid: boolean }).valid, true);
    assert.equal((run({ rootDir, kind: "squad-validate", packageSource: path.join(source, "core-squad") }) as { valid: boolean }).valid, true);
    run({ rootDir, kind: "agent-install", packageSource: path.join(source, "terra") }); run({ rootDir, kind: "squad-install", packageSource: path.join(source, "core-squad") });
    assert.equal(readFileSync(path.join(rootDir, ".harness/agents/terra.json"), "utf8"), `${JSON.stringify(agent, null, 2)}\n`);
    assert.deepEqual((run({ rootDir, kind: "agent-list" }) as { agents: Array<{ id: string; runtime_type: string; layer: string; validity: string }> }).agents.map(({ id, runtime_type, layer, validity }) => ({ id, runtime_type, layer, validity })), [{ id: "terra", runtime_type: "codex", layer: "user", validity: "valid" }]);
    assert.deepEqual((run({ rootDir, kind: "squad-list" }) as { squads: Array<{ id: string; leader: string; workers: string[]; validity: string }> }).squads.map(({ id, leader, workers, validity }) => ({ id, leader, workers, validity })), [{ id: "core-squad", leader: "terra", workers: ["terra"], validity: "valid" }]);
    assert.deepEqual((run({ rootDir, kind: "agent-inspect", agentId: "terra" }) as { agent: unknown }).agent, agent);
    assert.equal((run({ rootDir, kind: "squad-inspect", squadId: "core-squad" }) as { squad: { roster: string } }).squad.roster, squad.roster);
    const edited = { ...squad, roster: "# Core Squad\n\nTerra leads; humans can edit this roster." }; writeEntity(source, "core-squad", "squad", edited);
    run({ rootDir, kind: "squad-install", packageSource: path.join(source, "core-squad") });
    assert.equal((run({ rootDir, kind: "squad-inspect", squadId: "core-squad" }) as { squad: { roster: string } }).squad.roster, edited.roster);
    assert.throws(() => run({ rootDir, kind: "agent-inspect", agentId: "unknown" }), (error: unknown) => (error as { code?: string }).code === "agent_not_found");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("runtime_type is an open identifier: third-party runtimes validate while traversal and whitespace stay rejected", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-runtime-type-")), source = path.join(rootDir, "source");
  try {
    for (const runtime_type of ["any", "opencode", "dsh", "grok", "kiro", "glm"]) assert.deepEqual(validateAgentDeclarationV1({ ...agent, id: "worker", runtime_type }), [], runtime_type);
    for (const runtime_type of ["../etc/passwd", "claude codex", " ", "Claude", "claude/../../bin", ""]) assert.match(validateAgentDeclarationV1({ ...agent, id: "worker", runtime_type }).join("\n"), /runtime_type.*lowercase runtime identifier/u, runtime_type);
    const opencode = { ...agent, id: "opencode-worker", name: "Opencode Worker", runtime_type: "opencode" }; writeEntity(source, "opencode-worker", "agent", opencode);
    const report = run({ rootDir, kind: "agent-validate", packageSource: path.join(source, "opencode-worker") }) as { valid: boolean; entity?: { id: string } };
    assert.deepEqual({ valid: report.valid, entity: report.entity }, { valid: true, entity: { id: "opencode-worker" } });
    run({ rootDir, kind: "agent-install", packageSource: path.join(source, "opencode-worker") });
    assert.equal((run({ rootDir, kind: "agent-inspect", agentId: "opencode-worker" }) as { agent: { runtime_type: string } }).agent.runtime_type, "opencode");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("agent model is optional but must be non-empty when declared", () => {
  assert.deepEqual(validateAgentDeclarationV1({ ...agent, model: undefined }), []);
  for (const model of ["", " ", 42, []]) assert.match(validateAgentDeclarationV1({ ...agent, model }).join("\n"), /model.*non-empty string/u);
});

test("entity validation names every malformed manifest and refuses squads that reference missing agents", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-errors-")), source = path.join(rootDir, "source");
  try {
    writeEntity(source, "missing-runtime", "agent", { schema: "agent-declaration/v1", id: "missing-runtime", name: "Missing Runtime", instructions: "Review precisely." });
    const missing = run({ rootDir, kind: "agent-validate", packageSource: path.join(source, "missing-runtime") }) as { valid: boolean; issues: Array<{ message: string }> };
    assert.equal(missing.valid, false); assert.match(missing.issues.map(({ message }) => message).join("\n"), /missing required field "runtime_type"/u);
    writeEntity(source, "wrong-kind", "squad", squad);
    const mismatch = run({ rootDir, kind: "agent-validate", packageSource: path.join(source, "wrong-kind") }) as { valid: boolean; issues: Array<{ message: string }> };
    assert.equal(mismatch.valid, false); assert.match(mismatch.issues.map(({ message }) => message).join("\n"), /missing agent\.json/u);
    writeEntity(source, "orphan-squad", "squad", { ...squad, id: "orphan-squad", leader: "ghost" });
    run({ rootDir, kind: "squad-install", packageSource: path.join(source, "orphan-squad") });
    assert.throws(() => run({ rootDir, kind: "squad-inspect", squadId: "orphan-squad" }), (error: unknown) => (error as { code?: string }).code === "squad_agent_not_found");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

// The GUI read contract (repo.agent.entities.list / repo.agent.entity.read and
// the squad twins) consumes exactly this closed projection; keep its shape fixed.
test("the GUI entity projection lists closed rows and reads closed declarations", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-entities-gui-")), source = path.join(rootDir, "source");
  try {
    writeEntity(source, "terra", "agent", agent); writeEntity(source, "core-squad", "squad", squad);
    run({ rootDir, kind: "agent-install", packageSource: path.join(source, "terra") }); run({ rootDir, kind: "squad-install", packageSource: path.join(source, "core-squad") });
    const agentRows = readAgentEntityGuiProjection({ rootDir, kind: "agent-list" }), squadRows = readAgentEntityGuiProjection({ rootDir, kind: "squad-list" });
    assert.equal(agentRows.schema, "agent-entity-catalog/v1"); assert.equal(agentRows.ok, true);
    assert.deepEqual(agentRows.agents.map(({ id, runtimeType, layer, validity }) => ({ id, runtimeType, layer, validity })), [{ id: "terra", runtimeType: "codex", layer: "user", validity: "valid" }]);
    assert.deepEqual(Object.keys(agentRows.agents[0]!).sort(), ["id", "issues", "layer", "name", "runtimeType", "validity"]);
    assert.equal(squadRows.schema, "squad-entity-catalog/v1"); assert.equal(squadRows.ok, true);
    assert.deepEqual(squadRows.squads.map(({ id, leader, workers }) => ({ id, leader, workers })), [{ id: "core-squad", leader: "terra", workers: ["terra"] }]);
    const agentDetail = readAgentEntityGuiProjection({ rootDir, kind: "agent-inspect", entityId: "terra" }), squadDetail = readAgentEntityGuiProjection({ rootDir, kind: "squad-inspect", entityId: "core-squad" });
    assert.equal(agentDetail.ok, true); assert.equal(squadDetail.ok, true);
    assert.deepEqual(agentDetail.agent, { id: "terra", name: "Terra", runtimeType: "codex", instructions: "Review precisely.", skills: ["review"], prompts: ["prompt://review"], preset: "standard-task" });
    assert.deepEqual(squadDetail.squad, { id: "core-squad", name: "Core Squad", leader: "terra", workers: ["terra"], roster: squad.roster });
    assert.throws(() => readAgentEntityGuiProjection({ rootDir, kind: "agent-inspect", entityId: "unknown" }), (error: unknown) => (error as { code?: string }).code === "agent_not_found");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("Squad dispatch resolution selects one declared worker and rejects outsiders or ambiguous lineage", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-dispatch-")), source = path.join(rootDir, "source"), fable = { ...agent, id: "fable", name: "Fable" }, luna = { ...agent, id: "luna", name: "Luna" }, outsider = { ...agent, id: "outsider", name: "Outsider" };
  try {
    for (const declaration of [fable, luna, outsider]) { writeEntity(source, declaration.id, "agent", declaration); run({ rootDir, kind: "agent-install", packageSource: path.join(source, declaration.id) }); }
    writeEntity(source, "core-squad", "squad", { ...squad, leader: "fable", workers: ["luna"] }); run({ rootDir, kind: "squad-install", packageSource: path.join(source, "core-squad") });
    assert.deepEqual(resolveSquadDispatchTarget({ rootDir, leaderId: "fable", workerId: "luna" }), { squadId: "core-squad", leader: fable, worker: luna });
    assert.throws(() => resolveSquadDispatchTarget({ rootDir, leaderId: "fable", workerId: "outsider" }), (error: unknown) => (error as { code?: string }).code === "squad_member_not_found");
    writeEntity(source, "other-squad", "squad", { ...squad, id: "other-squad", name: "Other Squad", leader: "fable", workers: ["luna"] }); run({ rootDir, kind: "squad-install", packageSource: path.join(source, "other-squad") });
    assert.throws(() => resolveSquadDispatchTarget({ rootDir, leaderId: "fable", workerId: "luna" }), (error: unknown) => (error as { code?: string }).code === "squad_member_ambiguous");
    writeFileSync(path.join(rootDir, ".harness/squads/broken.json"), "{not-json\n");
    assert.throws(() => resolveSquadDispatchTarget({ rootDir, leaderId: "fable", workerId: "luna" }), (error: unknown) => (error as { code?: string }).code === "invalid_squad_roster");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

function run(input: { readonly rootDir: string; readonly kind: string; readonly packageSource?: string; readonly agentId?: string; readonly squadId?: string }): unknown { return runAgentEntityAction({ rootDir: input.rootDir, action: { kind: input.kind, ...(input.packageSource ? { packageSource: input.packageSource } : {}), ...(input.agentId ? { agentId: input.agentId } : {}), ...(input.squadId ? { squadId: input.squadId } : {}) } }); }
function writeEntity(source: string, id: string, kind: "agent" | "squad", declaration: Record<string, unknown>): void { const target = path.join(source, id); mkdirSync(target, { recursive: true }); writeFileSync(path.join(target, kind === "agent" ? "agent.json" : "squad.json"), `${JSON.stringify(declaration, null, 2)}\n`); }
