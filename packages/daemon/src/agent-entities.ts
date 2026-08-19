import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, resolveHarnessLayout } from "../../kernel/src/index.ts";
import { entitySlug, parseAgentDeclarationV1, parseSquadDeclarationV1, validateAgentDeclarationV1, validateSquadDeclarationV1, type AgentDeclarationV1, type AgentEntityKind, type SquadDeclarationV1 } from "./agent-entities.contract.ts";

export type AgentCatalogRow = Omit<AgentDeclarationV1, "instructions"> & { readonly layer: "user"; readonly source: string; readonly validity: "valid" | "blocked"; readonly issues: readonly { readonly code: string; readonly message: string }[] };
export type SquadCatalogRow = Omit<SquadDeclarationV1, "roster"> & { readonly layer: "user"; readonly source: string; readonly validity: "valid" | "blocked"; readonly issues: readonly { readonly code: string; readonly message: string }[] };
export interface EntityValidationReport { readonly schema: "entity-validate-report/v1"; readonly valid: boolean; readonly source: string; readonly kind?: AgentEntityKind; readonly entity?: { readonly id: string }; readonly issues: readonly { readonly code: string; readonly message: string }[] }

const manifestName = { agent: "agent.json", squad: "squad.json" } as const;
export function runAgentEntityAction(input: { readonly rootDir: string; readonly action: Readonly<Record<string, unknown>> & { readonly kind: string } }): unknown {
  const action = input.action, kind = entityKind(action.kind);
  if (action.kind.endsWith("-validate")) return validateEntityPackage({ source: requiredEntityText(action.packageSource, "packageSource"), kind });
  if (action.kind.endsWith("-install")) return installEntityPackage({ source: requiredEntityText(action.packageSource, "packageSource"), kind, rootDir: input.rootDir, dryRun: action.dryRun === true });
  if (action.kind === "agent-list") return { schema: "agent-list/v1", agents: listStoredEntities(input.rootDir, "agent") };
  if (action.kind === "squad-list") return { schema: "squad-list/v1", squads: listStoredEntities(input.rootDir, "squad") };
  return kind === "agent" ? { schema: "agent-inspection/v1", agent: readAgentDeclaration({ rootDir: input.rootDir, agentId: requiredEntityText(action.agentId, "agentId") }) } : { schema: "squad-inspection/v1", squad: readSquadDeclaration({ rootDir: input.rootDir, squadId: requiredEntityText(action.squadId, "squadId") }) };
}
export function readAgentDeclaration(input: { readonly rootDir: string; readonly agentId: string }): AgentDeclarationV1 { return parseAgentDeclarationV1(readStoredDeclaration(input.rootDir, "agent", input.agentId)); }
export function readSquadDeclaration(input: { readonly rootDir: string; readonly squadId: string }): SquadDeclarationV1 {
  const squad = parseSquadDeclarationV1(readStoredDeclaration(input.rootDir, "squad", input.squadId)), missing = [squad.leader, ...squad.workers].filter((id) => { try { readAgentDeclaration({ rootDir: input.rootDir, agentId: id }); return false; } catch (error) { consumeKnownError(error); return true; } });
  if (missing.length) throw entityError("squad_agent_not_found", `Squad ${squad.id} references unavailable agents: ${[...new Set(missing)].join(", ")}.`);
  return squad;
}
export function validateEntityPackage(input: { readonly source: string; readonly kind: AgentEntityKind }): EntityValidationReport {
  const source = path.resolve(input.source), decoded = decodeSourcePackage(source, input.kind);
  if ("issues" in decoded) return { schema: "entity-validate-report/v1", valid: false, source, issues: decoded.issues };
  return { schema: "entity-validate-report/v1", valid: true, source, kind: input.kind, entity: { id: decoded.declaration.id }, issues: [] };
}
export function installEntityPackage(input: { readonly source: string; readonly kind: AgentEntityKind; readonly rootDir: string; readonly dryRun?: boolean }) {
  const source = path.resolve(input.source), decoded = decodeSourcePackage(source, input.kind);
  if ("issues" in decoded) throw entityError(decoded.issues[0]?.code ?? "invalid_entity_package", decoded.issues[0]?.message ?? "Entity package is invalid.");
  const declaration = decoded.declaration, body = `${JSON.stringify(declaration, null, 2)}\n`, target = entityPath(input.rootDir, input.kind, declaration.id), changed = !existsSync(target) || readFileSync(target, "utf8") !== body, report = { schema: `${input.kind}-install-report/v1` as const, entityId: declaration.id, mode: input.dryRun ? "dry-run" as const : "apply" as const, changed, source, issues: [] as readonly unknown[] };
  if (input.dryRun) return report;
  const store = path.dirname(target), temporary = path.join(store, `.install-${declaration.id}-${process.hrtime.bigint().toString(36)}`);
  mkdirSync(store, { recursive: true });
  try { writeFileSync(temporary, body, { mode: 0o644 }); renameSync(temporary, target); } finally { if (existsSync(temporary)) rmSync(temporary, { force: true }); }
  return report;
}
function listStoredEntities(rootDir: string, kind: AgentEntityKind): readonly (AgentCatalogRow | SquadCatalogRow)[] {
  const store = entityStore(rootDir, kind);
  if (!existsSync(store) || !lstatSync(store).isDirectory()) return [];
  return readdirSync(store, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json")).map((entry) => {
    const source = path.join(store, entry.name), fallbackId = entry.name.replace(/\.json$/u, "");
    let value: unknown; try { value = JSON.parse(readFileSync(source, "utf8")); } catch { return blockedRow(kind, fallbackId, source, "invalid_manifest", `${entry.name} is not valid JSON.`); }
    const issues = kind === "agent" ? validateAgentDeclarationV1(value) : validateSquadDeclarationV1(value);
    if (issues.length) return blockedRow(kind, fallbackId, source, "invalid_manifest", issues.join("; "));
    const declaration = value as AgentDeclarationV1 & SquadDeclarationV1, { instructions: _instructions, roster: _roster, ...row } = declaration;
    return { ...row, layer: "user" as const, source, validity: "valid" as const, issues: [] as const };
  }).sort((left, right) => left.id.localeCompare(right.id));
}
function blockedRow(kind: AgentEntityKind, id: string, source: string, code: string, message: string): AgentCatalogRow & SquadCatalogRow { return { id, name: id, ...(kind === "agent" ? { runtime_type: "" } : { leader: "", workers: [] }), layer: "user", source, validity: "blocked", issues: [{ code, message }] } as unknown as AgentCatalogRow & SquadCatalogRow; }
function decodeSourcePackage(source: string, kind: AgentEntityKind): { readonly declaration: AgentDeclarationV1 & SquadDeclarationV1 } | { readonly issues: readonly { readonly code: string; readonly message: string }[] } {
  if (!existsSync(source) || !lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) return { issues: [{ code: "invalid_package", message: `Entity package ${source} is not a regular directory.` }] };
  const manifest = path.join(source, manifestName[kind]);
  if (!existsSync(manifest) || !lstatSync(manifest).isFile() || lstatSync(manifest).isSymbolicLink()) return { issues: [{ code: "missing_manifest", message: `Entity package is missing ${manifestName[kind]}; expected a ${kind}-declaration/v1 JSON manifest.` }] };
  let value: unknown; try { value = JSON.parse(readFileSync(manifest, "utf8")); } catch { return { issues: [{ code: "invalid_manifest", message: `${manifestName[kind]} is not valid JSON.` }] }; }
  const issues = kind === "agent" ? validateAgentDeclarationV1(value) : validateSquadDeclarationV1(value);
  return issues.length ? { issues: issues.map((message) => ({ code: "invalid_manifest", message })) } : { declaration: value as AgentDeclarationV1 & SquadDeclarationV1 };
}
function readStoredDeclaration(rootDir: string, kind: AgentEntityKind, id: string): unknown {
  if (!entitySlug(id)) throw entityError(`${kind}_not_found`, `${id} is not a valid ${kind} id.`);
  const target = entityPath(rootDir, kind, id);
  if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) throw entityError(`${kind}_not_found`, `${id} is not an installed ${kind}.`);
  return JSON.parse(readFileSync(target, "utf8"));
}
function entityPath(rootDir: string, kind: AgentEntityKind, id: string): string { return path.join(entityStore(rootDir, kind), `${id}.json`); }
function entityStore(rootDir: string, kind: AgentEntityKind): string { return path.join(resolveHarnessLayout(rootDir).localRoot, `${kind}s`); }
function entityKind(actionKind: string): AgentEntityKind { if (!/^(?:agent|squad)-(?:list|inspect|validate|install)$/u.test(actionKind)) throw entityError("unsupported_command", `No entity lifecycle contract exists for ${actionKind}.`); return actionKind.startsWith("agent-") ? "agent" : "squad"; }
function requiredEntityText(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw entityError("invalid_command", `${field} is required.`); return value; }
function entityError(code: string, message: string): Error & { readonly code: string } { return Object.assign(new Error(message), { code }); }
