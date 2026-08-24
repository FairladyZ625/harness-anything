import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, openEntityStore, type EntityStore } from "../../kernel/src/index.ts";
import {
  entitySlug,
  parseAgentDeclarationV1,
  parseSquadDeclarationV1,
  validateAgentDeclarationV1,
  validateSquadDeclarationV1,
  type AgentDeclarationV1,
  type AgentEntityKind,
  type SquadDeclarationV1,
} from "./agent-entities.contract.ts";

export type AgentCatalogRow = Omit<AgentDeclarationV1, "instructions"> & {
  readonly layer: "user";
  readonly source: string;
  readonly validity: "valid" | "blocked";
  readonly issues: readonly { readonly code: string; readonly message: string }[];
};
export type SquadCatalogRow = Omit<SquadDeclarationV1, "roster"> & {
  readonly layer: "user";
  readonly source: string;
  readonly validity: "valid" | "blocked";
  readonly issues: readonly { readonly code: string; readonly message: string }[];
};
export interface AgentEntityGuiRow {
  readonly id: string;
  readonly name: string;
  readonly runtimeType: string;
  readonly role: "worker" | "commander";
  readonly layer: string;
  readonly validity: "valid" | "blocked";
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}
export interface SquadEntityGuiRow {
  readonly id: string;
  readonly name: string;
  readonly leader: string;
  readonly workers: readonly string[];
  readonly layer: string;
  readonly validity: "valid" | "blocked";
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}
export interface AgentEntityGuiDetail {
  readonly id: string;
  readonly name: string;
  readonly runtimeType: string;
  readonly role: "worker" | "commander";
  readonly instructions: string;
  readonly model: string | null;
  readonly skills: readonly { readonly id: string; readonly path: string }[];
  readonly prompts: readonly string[];
  readonly preset: string | null;
}
export interface AgentSkillGuiRead {
  readonly schema: "agent-skill-catalog/v1";
  readonly ok: true;
  readonly skills: readonly { readonly id: string; readonly path: string; readonly source: "user" | "project" }[];
}
export interface SquadEntityGuiDetail {
  readonly id: string;
  readonly name: string;
  readonly leader: string;
  readonly workers: readonly string[];
  readonly roster: string;
}
export type AgentEntityGuiRead =
  | { readonly schema: "agent-entity-catalog/v1"; readonly ok: true; readonly agents: readonly AgentEntityGuiRow[] }
  | { readonly schema: "squad-entity-catalog/v1"; readonly ok: true; readonly squads: readonly SquadEntityGuiRow[] }
  | { readonly schema: "agent-entity-detail/v1"; readonly ok: true; readonly agent: AgentEntityGuiDetail }
  | { readonly schema: "squad-entity-detail/v1"; readonly ok: true; readonly squad: SquadEntityGuiDetail };
export interface EntityValidationReport {
  readonly schema: "entity-validate-report/v1";
  readonly valid: boolean;
  readonly source: string;
  readonly kind?: AgentEntityKind;
  readonly entity?: { readonly id: string };
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}
export interface PreparedAgentEntityInstall {
  readonly kind: AgentEntityKind;
  readonly declaration: AgentDeclarationV1 | SquadDeclarationV1;
  readonly body: string;
  readonly report: {
    readonly schema: "agent-install-report/v1" | "squad-install-report/v1";
    readonly entityId: string;
    readonly mode: "dry-run" | "apply";
    readonly changed: boolean;
    readonly source: string;
    readonly generated: boolean;
    readonly issues: readonly unknown[];
  };
}

const manifestName = { agent: "agent.json", squad: "squad.json" } as const;
export function runAgentEntityAction(input: {
  readonly rootDir: string;
  readonly entityStore?: EntityStore;
  readonly action: Readonly<Record<string, unknown>> & { readonly kind: string };
  readonly runtimeInstances?: readonly {
    readonly kindId: string;
    readonly models: readonly string[];
    readonly enabled: boolean;
  }[];
}): unknown {
  const action = input.action,
    kind = entityKind(action.kind);
  if (action.kind.endsWith("-validate"))
    return validateEntityDeclarationSource({ source: declarationSource(action), kind });
  if (action.kind.endsWith("-install"))
    throw entityError(
      "coordinated_write_required",
      "Agent and squad declarations must be installed through the repository write coordinator.",
    );
  const entityStore = input.entityStore ?? openEntityStore(input.rootDir);
  if (action.kind === "agent-list")
    return { schema: "agent-list/v1", agents: listStoredEntities(input.rootDir, "agent", entityStore) };
  if (action.kind === "squad-list")
    return { schema: "squad-list/v1", squads: listStoredEntities(input.rootDir, "squad", entityStore) };
  return kind === "agent"
    ? {
        schema: "agent-inspection/v1",
        agent: readAgentDeclaration({
          rootDir: input.rootDir,
          agentId: requiredEntityText(action.agentId, "agentId"),
          entityStore,
        }),
      }
    : {
        schema: "squad-inspection/v1",
        squad: readSquadDeclaration({
          rootDir: input.rootDir,
          squadId: requiredEntityText(action.squadId, "squadId"),
          entityStore,
        }),
      };
}
export function readAgentEntityGuiProjection<
  const K extends "agent-list" | "squad-list" | "agent-inspect" | "squad-inspect",
>(input: {
  readonly rootDir: string;
  readonly kind: K;
  readonly entityId?: string;
  readonly entityStore?: EntityStore;
}): K extends "agent-list"
  ? Extract<AgentEntityGuiRead, { readonly schema: "agent-entity-catalog/v1" }>
  : K extends "squad-list"
    ? Extract<AgentEntityGuiRead, { readonly schema: "squad-entity-catalog/v1" }>
    : K extends "agent-inspect"
      ? Extract<AgentEntityGuiRead, { readonly schema: "agent-entity-detail/v1" }>
      : Extract<AgentEntityGuiRead, { readonly schema: "squad-entity-detail/v1" }> {
  const action = input.kind.endsWith("-inspect")
      ? {
          kind: input.kind,
          [input.kind === "agent-inspect" ? "agentId" : "squadId"]: requiredEntityText(input.entityId, "entityId"),
        }
      : { kind: input.kind },
    evidence = agentEntityRecord(
      runAgentEntityAction({ rootDir: input.rootDir, entityStore: input.entityStore, action }),
    );
  if (input.kind === "agent-list")
    return {
      schema: "agent-entity-catalog/v1",
      ok: true,
      agents: Array.isArray(evidence.agents) ? evidence.agents.map(agentEntityRecord).map(agentEntityRow) : [],
    } as never;
  if (input.kind === "squad-list")
    return {
      schema: "squad-entity-catalog/v1",
      ok: true,
      squads: Array.isArray(evidence.squads) ? evidence.squads.map(agentEntityRecord).map(squadEntityRow) : [],
    } as never;
  if (input.kind === "agent-inspect") {
    const agent = agentEntityRecord(evidence.agent);
    return {
      schema: "agent-entity-detail/v1",
      ok: true,
      agent: {
        id: entityText(agent.id),
        name: entityText(agent.name),
        runtimeType: entityText(agent.runtime_type),
        role: entityAgentRole(agent.role),
        instructions: entityText(agent.instructions),
        model: agent.model === undefined ? null : entityText(agent.model),
        skills: entitySkills(agent.skills),
        prompts: entityStrings(agent.prompts),
        preset: agent.preset === undefined ? null : entityText(agent.preset),
      },
    } as never;
  }
  const squad = agentEntityRecord(evidence.squad);
  return {
    schema: "squad-entity-detail/v1",
    ok: true,
    squad: {
      id: entityText(squad.id),
      name: entityText(squad.name),
      leader: entityText(squad.leader),
      workers: entityStrings(squad.workers),
      roster: entityText(squad.roster),
    },
  } as never;
}
export function readAgentDeclaration(input: {
  readonly rootDir: string;
  readonly agentId: string;
  readonly entityStore?: EntityStore;
}): AgentDeclarationV1 {
  return parseAgentDeclarationV1(readStoredDeclaration(input.rootDir, "agent", input.agentId, input.entityStore));
}
export function readSquadDeclaration(input: {
  readonly rootDir: string;
  readonly squadId: string;
  readonly entityStore?: EntityStore;
}): SquadDeclarationV1 {
  const entityStore = input.entityStore ?? openEntityStore(input.rootDir),
    squad = parseSquadDeclarationV1(readStoredDeclaration(input.rootDir, "squad", input.squadId, entityStore)),
    missing = [squad.leader, ...squad.workers].filter((id) => {
      try {
        readAgentDeclaration({ rootDir: input.rootDir, agentId: id, entityStore });
        return false;
      } catch (error) {
        consumeKnownError(error);
        return true;
      }
    });
  if (missing.length)
    throw entityError(
      "squad_agent_not_found",
      `Squad ${squad.id} references unavailable agents: ${[...new Set(missing)].join(", ")}.`,
    );
  return squad;
}
export interface SquadDispatchTarget {
  readonly squadId: string;
  readonly leader: AgentDeclarationV1;
  readonly worker: AgentDeclarationV1;
}
export function resolveSquadDispatchTarget(input: {
  readonly rootDir: string;
  readonly leaderId: string;
  readonly workerId: string;
  readonly entityStore?: EntityStore;
}): SquadDispatchTarget {
  const entityStore = input.entityStore ?? openEntityStore(input.rootDir),
    matches: SquadDispatchTarget[] = [];
  for (const { id: squadId, value } of entityStore.list<SquadDeclarationV1>("squad")) {
    const squad = parseSquadDeclarationV1(value);
    if (squad.leader !== input.leaderId || !squad.workers.includes(input.workerId)) continue;
    const leader = readAgentDeclaration({ rootDir: input.rootDir, agentId: squad.leader, entityStore }),
      worker = readAgentDeclaration({ rootDir: input.rootDir, agentId: input.workerId, entityStore });
    readSquadDeclaration({ rootDir: input.rootDir, squadId, entityStore });
    matches.push({ squadId, leader, worker });
  }
  if (matches.length === 0)
    throw entityError(
      "squad_member_not_found",
      `Agent ${input.workerId} is not a declared worker for leader ${input.leaderId}.`,
    );
  if (matches.length > 1)
    throw entityError(
      "squad_member_ambiguous",
      `Agent ${input.workerId} is declared in multiple squads for leader ${input.leaderId}: ${matches
        .map(({ squadId }) => squadId)
        .join(", ")}.`,
    );
  return matches[0]!;
}
export function validateEntityPackage(input: {
  readonly source: string;
  readonly kind: AgentEntityKind;
}): EntityValidationReport {
  const source = path.resolve(input.source),
    decoded = decodeSourcePackage(source, input.kind);
  return validateEntityDeclarationSource({
    source: "issues" in decoded ? { ...decoded, source } : { ...decoded, source },
    kind: input.kind,
  });
}
function validateEntityDeclarationSource(input: {
  readonly source:
    | { readonly declaration: AgentDeclarationV1 & SquadDeclarationV1 }
    | { readonly issues: readonly { readonly code: string; readonly message: string }[]; readonly source?: string };
  readonly kind: AgentEntityKind;
}): EntityValidationReport {
  const source = "source" in input.source && input.source.source ? input.source.source : "runtime-result",
    decoded = input.source;
  if ("issues" in decoded) return { schema: "entity-validate-report/v1", valid: false, source, issues: decoded.issues };
  return {
    schema: "entity-validate-report/v1",
    valid: true,
    source,
    kind: input.kind,
    entity: { id: decoded.declaration.id },
    issues: [],
  };
}
export function prepareAgentEntityInstall(input: {
  readonly action: Readonly<Record<string, unknown>> & { readonly kind: string };
  readonly rootDir: string;
  readonly entityStore?: EntityStore;
  readonly runtimeInstances?: readonly {
    readonly kindId: string;
    readonly models: readonly string[];
    readonly enabled: boolean;
  }[];
}): PreparedAgentEntityInstall {
  const kind = entityKind(input.action.kind);
  if (!input.action.kind.endsWith("-install"))
    throw entityError("invalid_command", "Only an entity install action can prepare a declaration write.");
  const decoded = declarationSource(input.action),
    source = decoded.source ?? "runtime-result";
  if ("issues" in decoded)
    throw entityError(
      decoded.issues[0]?.code ?? "invalid_entity_package",
      decoded.issues[0]?.message ?? "Entity package is invalid.",
    );
  if (input.action.generatedOnly === true && input.action.validated !== true)
    throw entityError(
      "agent_validation_required",
      "Generated Agent output must pass ha agent validate before install; rerun ha agent create so the harness can validate the structured declaration.",
    );
  const declaration = decoded.declaration,
    current = (input.entityStore ?? openEntityStore(input.rootDir)).get(kind, declaration.id);
  if (input.action.generatedOnly === true && current) throw generatedAgentConflict(declaration.id);
  if (input.action.generatedOnly === true && kind === "agent")
    admitGeneratedAgent(declaration as AgentDeclarationV1, input.runtimeInstances);
  const body = `${JSON.stringify(declaration, null, 2)}\n`,
    changed = current === null || `${JSON.stringify(current.value, null, 2)}\n` !== body;
  return {
    kind,
    declaration,
    body,
    report: {
      schema: `${kind}-install-report/v1`,
      entityId: declaration.id,
      mode: input.action.dryRun === true ? "dry-run" : "apply",
      changed,
      source,
      generated: input.action.generatedOnly === true,
      issues: [],
    },
  };
}
function declarationSource(
  action: Readonly<Record<string, unknown>>,
):
  | { readonly declaration: AgentDeclarationV1 & SquadDeclarationV1; readonly source?: string }
  | { readonly issues: readonly { readonly code: string; readonly message: string }[]; readonly source?: string } {
  if (Object.hasOwn(action, "declaration"))
    return decodeDeclaration(
      action.declaration,
      entityKind(String(action.kind)),
      typeof action.declarationSource === "string" ? action.declarationSource : "runtime-result",
    );
  const source = path.resolve(requiredEntityText(action.packageSource, "packageSource")),
    decoded = decodeSourcePackage(source, entityKind(String(action.kind)));
  return "issues" in decoded ? { ...decoded, source } : { ...decoded, source };
}
function listStoredEntities(
  rootDir: string,
  kind: AgentEntityKind,
  entityStore = openEntityStore(rootDir),
): readonly (AgentCatalogRow | SquadCatalogRow)[] {
  return entityStore
    .list<AgentDeclarationV1 & SquadDeclarationV1>(kind)
    .map(({ value: declaration, documentPath: source }) => {
      const { instructions: _instructions, roster: _roster, ...row } = declaration;
      return { ...row, layer: "user" as const, source, validity: "valid" as const, issues: [] as const };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
function agentEntityRow(value: Record<string, unknown>): AgentEntityGuiRow {
  return {
    id: entityText(value.id),
    name: entityText(value.name),
    runtimeType: entityText(value.runtime_type),
    role: entityAgentRole(value.role),
    layer: entityText(value.layer),
    validity: value.validity === "blocked" ? "blocked" : "valid",
    issues: entityIssues(value.issues),
  };
}
function squadEntityRow(value: Record<string, unknown>): SquadEntityGuiRow {
  return {
    id: entityText(value.id),
    name: entityText(value.name),
    leader: entityText(value.leader),
    workers: entityStrings(value.workers),
    layer: entityText(value.layer),
    validity: value.validity === "blocked" ? "blocked" : "valid",
    issues: entityIssues(value.issues),
  };
}
function entityIssues(value: unknown): readonly { readonly code: string; readonly message: string }[] {
  return Array.isArray(value)
    ? value
        .map(agentEntityRecord)
        .filter((issue) => issue.code || issue.message)
        .map((issue) => ({ code: entityText(issue.code), message: entityText(issue.message) }))
    : [];
}
function entityStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function entitySkills(value: unknown): readonly { readonly id: string; readonly path: string }[] {
  return Array.isArray(value)
    ? value
        .map(agentEntityRecord)
        .map((skill) => ({ id: entityText(skill.id), path: entityText(skill.path) }))
        .filter((skill) => skill.id && skill.path)
    : [];
}
function entityAgentRole(value: unknown): "worker" | "commander" {
  return value === "commander" ? "commander" : "worker";
}
function entityText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function agentEntityRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function decodeSourcePackage(
  source: string,
  kind: AgentEntityKind,
):
  | { readonly declaration: AgentDeclarationV1 & SquadDeclarationV1 }
  | { readonly issues: readonly { readonly code: string; readonly message: string }[] } {
  if (!existsSync(source) || !lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink())
    return { issues: [{ code: "invalid_package", message: `Entity package ${source} is not a regular directory.` }] };
  const manifest = path.join(source, manifestName[kind]);
  if (!existsSync(manifest) || !lstatSync(manifest).isFile() || lstatSync(manifest).isSymbolicLink())
    return {
      issues: [
        {
          code: "missing_manifest",
          message: `Entity package is missing ${manifestName[kind]}; expected a ${kind}-declaration/v1 JSON manifest.`,
        },
      ],
    };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return { issues: [{ code: "invalid_manifest", message: `${manifestName[kind]} is not valid JSON.` }] };
  }
  const issues = kind === "agent" ? validateAgentDeclarationV1(value) : validateSquadDeclarationV1(value);
  return issues.length
    ? { issues: issues.map((message) => ({ code: "invalid_manifest", message })) }
    : { declaration: value as AgentDeclarationV1 & SquadDeclarationV1 };
}
function decodeDeclaration(
  value: unknown,
  kind: AgentEntityKind,
  source: string,
):
  | { readonly declaration: AgentDeclarationV1 & SquadDeclarationV1; readonly source: string }
  | { readonly issues: readonly { readonly code: string; readonly message: string }[]; readonly source: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {
      issues: [{ code: "invalid_manifest", message: `${kind}-declaration/v1 output must be one JSON object.` }],
      source,
    };
  const issues = kind === "agent" ? validateAgentDeclarationV1(value) : validateSquadDeclarationV1(value);
  return issues.length
    ? { issues: issues.map((message) => ({ code: "invalid_manifest", message })), source }
    : { declaration: value as AgentDeclarationV1 & SquadDeclarationV1, source };
}
function readStoredDeclaration(rootDir: string, kind: AgentEntityKind, id: string, entityStore?: EntityStore): unknown {
  if (!entitySlug(id)) throw entityError(`${kind}_not_found`, `${id} is not a valid ${kind} id.`);
  const stored = (entityStore ?? openEntityStore(rootDir)).get(kind, id);
  if (!stored) throw entityError(`${kind}_not_found`, `${id} is not an installed ${kind}.`);
  return stored.value;
}
function entityKind(actionKind: string): AgentEntityKind {
  if (!/^(?:agent|squad)-(?:list|inspect|validate|install)$/u.test(actionKind))
    throw entityError("unsupported_command", `No entity lifecycle contract exists for ${actionKind}.`);
  return actionKind.startsWith("agent-") ? "agent" : "squad";
}
function requiredEntityText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw entityError("invalid_command", `${field} is required.`);
  return value;
}
function entityError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
function generatedAgentConflict(id: string): Error & { readonly code: string } {
  return entityError(
    "agent_id_conflict",
    `Agent ${id} already exists; run ha agent inspect ${id}, choose a different id, and retry ha agent create.`,
  );
}
function admitGeneratedAgent(
  agent: AgentDeclarationV1,
  runtimeInstances:
    | readonly { readonly kindId: string; readonly models: readonly string[]; readonly enabled: boolean }[]
    | undefined,
): void {
  const available = (runtimeInstances ?? []).filter((instance) => instance.enabled),
    compatible = available.filter((instance) => agent.runtime_type === "any" || instance.kindId === agent.runtime_type);
  if (compatible.length === 0)
    throw entityError(
      "agent_runtime_type_unavailable",
      `Agent ${agent.id} requires runtime_type ${
        agent.runtime_type
      }, but no enabled instance provides it; run ha runtime instance list, change runtime_type to any or a listed kind, and retry ha agent create.`,
    );
  if (agent.model !== undefined && !compatible.some((instance) => instance.models.includes(agent.model!)))
    throw entityError(
      "agent_model_unavailable",
      `Agent ${agent.id} requests model ${
        agent.model
      }, but no compatible enabled instance supports it; run ha runtime instance list, remove model to use the instance default or choose a listed model, and retry ha agent create.`,
    );
}
