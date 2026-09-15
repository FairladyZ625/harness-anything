export type ActionExecutionClass = "repo-write" | "arbiter" | "admin";
export type ActionResidency =
  | { readonly scope: "canonical"; readonly writer: "center-repo-cell" }
  | { readonly scope: "runtime-local"; readonly writer: "runtime-host" }
  | { readonly scope: "host-local"; readonly writer: "daemon-host" };
export type ReceiptSettlementClass = "canonical-acceptance" | "none";

/** The six stable facets shared by policy, protocol, receipt settlement, and entity catalogs. */
export interface ActionDeclaration {
  readonly kind: string;
  readonly catalogId: string | null;
  readonly executionClass: ActionExecutionClass;
  readonly policyAction: string | null;
  readonly residency: ActionResidency;
  readonly receiptSettlement: ReceiptSettlementClass;
}

const canonicalResidency = Object.freeze({ scope: "canonical" as const, writer: "center-repo-cell" as const }),
  runtimeResidency = Object.freeze({ scope: "runtime-local" as const, writer: "runtime-host" as const }),
  hostResidency = Object.freeze({ scope: "host-local" as const, writer: "daemon-host" as const });

const canonical = (
  kind: string,
  catalogId: string | null,
  executionClass: ActionExecutionClass,
  receiptSettlement: ReceiptSettlementClass = "canonical-acceptance",
): ActionDeclaration =>
  Object.freeze({
    kind,
    catalogId,
    executionClass,
    policyAction: kind,
    residency: canonicalResidency,
    receiptSettlement,
  });

const local = (
  kind: string,
  executionClass: ActionExecutionClass,
  residency: Exclude<ActionResidency, { readonly scope: "canonical" }>,
): ActionDeclaration =>
  Object.freeze({ kind, catalogId: null, executionClass, policyAction: null, residency, receiptSettlement: "none" });

/**
 * The built-in non-read action inventory. Protocol descriptors are checked against these rows;
 * policy, entity-catalog bindings, and receipt settlement are projections of the declarations.
 */
export const actionDeclarations = Object.freeze([
  canonical("agent-create", null, "repo-write"),
  canonical("agent-delete", "agent/delete", "repo-write"),
  canonical("agent-install", "agent/install", "repo-write"),
  local("agent-run", "repo-write", runtimeResidency),
  canonical("ci-observe-pull", null, "repo-write", "none"),
  local("daemon-connection-add", "admin", hostResidency),
  local("daemon-connection-probe", "admin", hostResidency),
  local("daemon-connection-remove", "admin", hostResidency),
  local("daemon-connection-update", "admin", hostResidency),
  canonical("daemon-control-request", null, "admin"),
  canonical("daemon-fleet-center-start", null, "admin"),
  canonical("daemon-fleet-edge-sync", null, "admin"),
  canonical("daemon-repo-register", null, "admin"),
  canonical("repo-purge", null, "admin"),
  canonical("repo-unbind", null, "admin"),
  local("daemon-repo-update", "admin", hostResidency),
  canonical("daemon-start", null, "admin"),
  canonical("daemon-stop", null, "admin"),
  canonical("decision-accept", "decision/accept", "arbiter"),
  canonical("decision-amend", "decision/amend", "repo-write"),
  canonical("decision-claim-add", "decision/declare-claim", "repo-write"),
  canonical("decision-claim-fulfill", "decision/fulfill-claim", "repo-write"),
  canonical("decision-defer", "decision/defer", "arbiter"),
  canonical("decision-propose", "decision/propose", "repo-write"),
  canonical("decision-reckon", "decision/reckon", "repo-write"),
  canonical("decision-reject", "decision/reject", "arbiter"),
  canonical("decision-repin", "decision/repin", "repo-write"),
  canonical("decision-retire", "decision/retire", "repo-write"),
  canonical("decision-supersede", "decision/supersede", "repo-write"),
  canonical("decision-transition", "decision/transition", "repo-write"),
  canonical("distill-candidate", null, "repo-write"),
  canonical("distill-promote", null, "repo-write"),
  canonical("doc-conflict-discard-local", null, "repo-write"),
  canonical("doc-conflict-overwrite-center", null, "repo-write"),
  canonical("doc-conflict-resolve", null, "repo-write"),
  canonical("doc-materialize", null, "repo-write", "none"),
  canonical("doc-retire", null, "repo-write"),
  canonical("doc-submit", null, "repo-write"),
  canonical("entity-archive", null, "repo-write"),
  canonical("entity-delete", null, "repo-write"),
  canonical("entity-import", null, "repo-write"),
  canonical("entity-update", null, "repo-write"),
  canonical("fact-reclassify", "fact/reclassify", "repo-write"),
  canonical("fact-record", "fact/record", "repo-write"),
  canonical("fact-type-register", "fact/type-register", "repo-write"),
  canonical("migrate-import", null, "repo-write"),
  canonical("people-add", "person/add", "admin"),
  canonical("people-bind", "person/bind", "admin"),
  canonical("people-delegate", "person/delegate", "admin"),
  canonical("people-remove", "person/remove", "admin"),
  canonical("people-revoke-delegation", "person/revoke-delegation", "admin"),
  canonical("people-set-role", "person/set-role", "admin"),
  canonical("preset-install", null, "repo-write"),
  canonical("preset-run-start", null, "repo-write"),
  canonical("preset-seed", null, "repo-write"),
  canonical("preset-uninstall", null, "repo-write"),
  canonical("preset-upgrade", null, "repo-write"),
  canonical("projection-rebuild", null, "repo-write", "none"),
  canonical("relation-reconfirm", "relation/reconfirm", "repo-write"),
  canonical("relation-relate", "relation/relate", "repo-write"),
  canonical("relation-unrelate", "relation/unrelate", "repo-write"),
  canonical("repo-bootstrap", null, "admin"),
  canonical("runtime-batch", null, "repo-write"),
  canonical("runtime-cancel", null, "repo-write"),
  canonical("runtime-instance-create", null, "admin"),
  canonical("runtime-instance-delete", null, "admin"),
  canonical("runtime-instance-github-credential-set", null, "admin"),
  canonical("runtime-instance-github-credential-unset", null, "admin"),
  canonical("runtime-instance-list", null, "admin"),
  canonical("runtime-instance-login", null, "repo-write"),
  canonical("runtime-instance-logout", null, "repo-write"),
  canonical("runtime-instance-show", null, "admin"),
  canonical("runtime-instance-update", null, "admin"),
  canonical("runtime-run", null, "repo-write"),
  canonical("runtime-spawn", null, "repo-write"),
  canonical("schedule-claim", "schedule/claim", "repo-write"),
  canonical("schedule-create", "schedule/create", "repo-write"),
  canonical("schedule-delete", "schedule/delete", "repo-write"),
  canonical("schedule-disable", "schedule/disable", "repo-write"),
  canonical("schedule-dispatch-link", "schedule/link", "repo-write"),
  canonical("schedule-enable", "schedule/enable", "repo-write"),
  canonical("schedule-missed", "schedule/record-missed", "repo-write"),
  canonical("schedule-run-now", "schedule/run-now", "repo-write"),
  canonical("schedule-settle", "schedule/settle", "repo-write"),
  canonical("schedule-update", "schedule/update", "repo-write"),
  canonical("script-run", null, "repo-write"),
  canonical("settings-update", "settings/update", "repo-write"),
  canonical("squad-cancel", "squad/cancel", "repo-write"),
  canonical("squad-delete", "squad/delete", "repo-write"),
  canonical("squad-install", "squad/install", "repo-write"),
  canonical("squad-run", "squad/run", "repo-write"),
  canonical("task-amend", "task/amend", "repo-write"),
  canonical("task-annotate", null, "repo-write"),
  canonical("task-archive", "task/archive", "repo-write"),
  canonical("task-artifact-add", null, "repo-write"),
  canonical("task-code-doc-reconcile", "task/reconcile", "repo-write"),
  canonical("task-code-doc-repoint", "task/repoint", "repo-write"),
  canonical("task-complete", "task/complete", "repo-write"),
  canonical("task-contract-migrate", "task/contract-migrate", "repo-write"),
  canonical("task-create", "task/create", "repo-write"),
  canonical("task-declare-executor", null, "repo-write"),
  canonical("task-delete", "task/delete", "repo-write"),
  canonical("task-pin", null, "repo-write"),
  canonical("task-progress-append", null, "repo-write"),
  canonical("task-release", "task/release", "repo-write"),
  canonical("task-reopen", "task/reopen", "repo-write"),
  canonical("task-review-consent", "task/consent", "repo-write"),
  canonical("task-review-execution", "task/review", "arbiter"),
  canonical("task-start", "task/start", "repo-write"),
  canonical("task-submit", "task/submit", "repo-write"),
  canonical("task-supersede", "task/supersede", "repo-write"),
  canonical("task-transition", "task/transition", "repo-write"),
  canonical("task-unpin", null, "repo-write"),
  canonical("terminal-input", null, "repo-write"),
  canonical("terminal-resize", null, "repo-write"),
  canonical("terminal-spawn", null, "repo-write"),
  canonical("terminal-terminate", null, "repo-write"),
  canonical("vertical-declaration-migrate", null, "repo-write"),
  canonical("vertical-kind-publish-schema", null, "repo-write"),
  canonical("vertical-kind-retire", null, "repo-write"),
  canonical("vertical-kind-upsert", null, "repo-write"),
] as const satisfies readonly ActionDeclaration[]);

const actionKinds = new Set(actionDeclarations.map(({ kind }) => kind)),
  actionDeclarationByCatalogId = new Map(
    actionDeclarations.flatMap((declaration) =>
      declaration.catalogId === null ? [] : ([[declaration.catalogId, declaration]] as const),
    ),
  );

if (actionKinds.size !== actionDeclarations.length) throw new Error("Action declaration kinds must be unique.");
if (actionDeclarationByCatalogId.size !== actionDeclarations.filter(({ catalogId }) => catalogId !== null).length)
  throw new Error("Action declaration catalog ids must be unique.");

export function getActionDeclarationByCatalogId(catalogId: string): ActionDeclaration | undefined {
  return actionDeclarationByCatalogId.get(catalogId);
}
