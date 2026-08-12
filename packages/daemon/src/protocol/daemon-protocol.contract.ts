import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { isJsonObject, type JsonObject } from "./json-rpc-types.ts";
declare const safePathBrand: unique symbol, canonicalRootBrand: unique symbol, endpointIdentityBrand: unique symbol, workspaceIdBrand: unique symbol;
export type SafePath = string & { readonly [safePathBrand]: true }; export type CanonicalRoot = SafePath & { readonly [canonicalRootBrand]: true };
export type EndpointIdentity = string & { readonly [endpointIdentityBrand]: true }; export type WorkspaceId = string & { readonly [workspaceIdBrand]: true };
export function safePath(value: string): SafePath { return path.resolve(value) as SafePath; }
export function canonicalRoot(value: string, allowMissing = false): CanonicalRoot { const resolved = path.resolve(value); if (existsSync(resolved)) return realpathSync.native(resolved) as CanonicalRoot;
  const parent = path.dirname(resolved); if (!allowMissing || !existsSync(parent)) throw new DaemonProtocolContractError("invalid_root", `Canonical root does not exist: ${resolved}`);
  return path.join(realpathSync.native(parent), path.basename(resolved)) as CanonicalRoot; }
export function endpointIdentity(value: string): EndpointIdentity { if (!value.trim()) throw new DaemonProtocolContractError("invalid_endpoint", "Endpoint identity is required."); return value as EndpointIdentity; }
export function workspaceId(value: string): WorkspaceId { if (!/^[a-z][a-z0-9-]{0,62}$/u.test(value)) throw new DaemonProtocolContractError("invalid_workspace", "Workspace id is invalid."); return value as WorkspaceId; }

export const daemonProtocolCommands = Object.freeze([
  { id: "repo-bootstrap", phase: "W3", path: ["init"], usage: "ha init --repo-id <id> --person-id <id> --display-name <name>", summary: "Initialize and register a workspace through the explicit daemon.", method: "daemon.repo.bootstrap" }, { id: "task-create", phase: "W3", path: ["task", "create"], usage: "ha task create --title <title> [--task-id <id>] [--completion-gate <id>]", summary: "Create a task.", method: "repo.task.run" },
  { id: "task-start", phase: "W3", path: ["task", "start"], usage: "ha task start <task-id> --execution-id <id>", summary: "Acquire the task execution lease.", method: "repo.task.run" }, { id: "task-submit", phase: "W3", path: ["task", "submit"], usage: "ha task submit <task-id> --execution-id <id> --claim <text> --commit-sha <sha>", summary: "Submit leased execution evidence.", method: "repo.task.run" },
  { id: "task-review-execution", phase: "W3", path: ["task", "review-execution"], usage: "ha task review-execution <task-id> --execution-id <id> --kind <kind> --verdict <verdict> --review-id <id> --reason <text> --commit-sha <sha> --iteration <0|1>", summary: "Record an execution review.", method: "repo.task.run" }, { id: "task-complete", phase: "W3", path: ["task", "complete"], usage: "ha task complete <task-id> --execution-id <id> [--gate-receipt <gate-id>:<receipt-ref>]", summary: "Complete a leased task.", method: "repo.task.run" },
  { id: "task-show", phase: "W3", path: ["task", "show"], usage: "ha task show <task-id>", summary: "Read the task projection.", method: "repo.task.run" }, { id: "receipt-show", phase: "W3", path: ["receipt", "show"], usage: "ha receipt show <op-id>", summary: "Read a write receipt.", method: "repo.task.run" },
  { id: "daemon-repo-register", phase: "W3", path: ["daemon", "repo", "register"], usage: "ha daemon repo register --repo-id <id> --root <path>", summary: "Register an initialized workspace.", method: "daemon.repo.register" }, { id: "daemon-repo-unregister", phase: "W3", path: ["daemon", "repo", "unregister"], usage: "ha daemon repo unregister --repo-id <id>", summary: "Disable a registered workspace.", method: "daemon.repo.unregister" },
  { id: "daemon-start", phase: "W3", path: ["daemon", "start"], usage: "ha daemon start --service", summary: "Explicitly start the resident daemon.", method: "protocol.hello" }, { id: "daemon-status", phase: "W3", path: ["daemon", "status"], usage: "ha daemon status", summary: "Show daemon and RepoCell status.", method: "daemon.status" },
  { id: "daemon-stop", phase: "W3", path: ["daemon", "stop"], usage: "ha daemon stop", summary: "Stop the resident daemon.", method: "protocol.hello" }
] as const);
export const thinCliCommands = Object.freeze(daemonProtocolCommands.map(({ usage, summary }) => ({ usage, summary })));
export function resolveThinCliCommand(args: readonly string[]): (typeof daemonProtocolCommands)[number] | undefined { return daemonProtocolCommands.find((entry) => entry.path.every((token, index) => args[index] === token)); }

type RpcShape = { readonly fields: Readonly<Record<string, "string" | "number" | RpcShape>>; readonly open?: boolean };
const shape = (fields: RpcShape["fields"], open = false): RpcShape => ({ fields, open });
export const daemonProtocolMethods = Object.freeze([
  { id: "protocol.hello", phase: "W3", method: "protocol.hello", requiresRepo: false, params: shape({ protocolVersion: "number" }) }, { id: "daemon.status", phase: "W3", method: "daemon.status", requiresRepo: false, params: shape({}) },
  { id: "daemon.repo.bootstrap", phase: "W3", method: "daemon.repo.bootstrap", requiresRepo: false, params: shape({ rootDir: "string", repoId: "string", personId: "string", displayName: "string" }) }, { id: "daemon.repo.register", phase: "W3", method: "daemon.repo.register", requiresRepo: false, params: shape({ rootDir: "string", repoId: "string" }) }, { id: "daemon.repo.unregister", phase: "W3", method: "daemon.repo.unregister", requiresRepo: false, params: shape({ repoId: "string" }) },
  { id: "repo.task.run", phase: "W3", method: "repo.task.run", requiresRepo: true, params: shape({ repo: shape({ repoId: "string" }), payload: shape({ action: shape({ kind: "string" }, true) }) }) }
] as const);
export const jsonRpcMethodContracts = Object.freeze(daemonProtocolMethods.map(({ method, requiresRepo }) => ({ method, requiresRepo })));
export function validateDaemonRpcCall(value: unknown): readonly string[] { if (!isJsonObject(value) || typeof value.method !== "string") return ["RPC method is required"]; const method = daemonProtocolMethods.find((entry) => entry.method === value.method); if (!method) return ["RPC method is not contracted"];
  return validateShape(value.params === undefined ? {} : value.params, method.params, "params"); }
export function parseDaemonRpcParams(method: string, params: unknown): { readonly ok: true; readonly params: JsonObject } | { readonly ok: false; readonly errors: readonly string[] } { const candidateParams = params === undefined ? {} : params, errors = validateDaemonRpcCall({ method, params: candidateParams });
  return errors.length ? { ok: false, errors } : { ok: true, params: candidateParams as JsonObject }; }
function validateShape(value: unknown, expected: RpcShape, prefix: string): string[] { if (!isJsonObject(value)) return [`${prefix} must be an object`]; const errors: string[] = []; if (!expected.open) for (const field of Object.keys(value)) if (!Object.hasOwn(expected.fields, field)) errors.push(`${prefix}.${field} is not allowed`);
  for (const [field, rule] of Object.entries(expected.fields)) { const item = value[field]; if (rule === "string" || rule === "number") { if (typeof item !== rule || (rule === "string" && !item)) errors.push(`${prefix}.${field} must be ${rule}`); }
    else errors.push(...validateShape(item, rule, `${prefix}.${field}`)); } return errors; }
export const DAEMON_RPC_SCHEMA = Object.freeze({ id: "w3-daemon-rpc/v1", methods: daemonProtocolMethods.map(({ method, params }) => ({ method, params })) });
export function serializeDaemonRpcCall(value: unknown): string { const errors = validateDaemonRpcCall(value); if (errors.length) throw new DaemonProtocolContractError("invalid_rpc", errors.join("; ")); return `${JSON.stringify(value)}\n`; }
export class DaemonProtocolContractError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = "DaemonProtocolContractError"; this.code = code; } }

export default Object.freeze({ id: "w3-daemon-protocol", phases: Object.freeze(["W3"]), commands: daemonProtocolCommands, methods: daemonProtocolMethods, gates: Object.freeze([]), guards: Object.freeze([]), schemas: Object.freeze([{ id: DAEMON_RPC_SCHEMA.id,
    schema: "packages/daemon/src/protocol/daemon-protocol.contract.ts#DAEMON_RPC_SCHEMA", parser: "packages/daemon/src/protocol/daemon-protocol.contract.ts#validateDaemonRpcCall", writer: "packages/daemon/src/protocol/daemon-protocol.contract.ts#serializeDaemonRpcCall", error: "packages/daemon/src/protocol/daemon-protocol.contract.ts#DaemonProtocolContractError",
    negativeFixtures: Object.freeze(["packages/daemon/fixtures/contracts/w3-daemon-rpc-invalid.json"]) }]) });
