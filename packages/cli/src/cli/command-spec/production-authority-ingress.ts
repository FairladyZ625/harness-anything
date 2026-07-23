import type { AuthorityIngressAdapter } from "@harness-anything/application";
import type { CommandSpecDefinition } from "./types.ts";

export const productionAuthorityIngressDecisionRef =
  "decision/dec_01KXSWKWTEXB751A30TRRCQWDG" as const;

export type ProductionAuthorityIngressAdapter = AuthorityIngressAdapter;

export type ProductionAuthorityIngressDisposition =
  | {
      readonly status: "typed-v2";
      readonly adapter: ProductionAuthorityIngressAdapter;
      readonly excludedVariants?: Readonly<Record<string, {
        readonly decisionRef: typeof productionAuthorityIngressDecisionRef;
        readonly reason: string;
      }>>;
    }
  | {
      readonly status: "excluded";
      readonly decisionRef: typeof productionAuthorityIngressDecisionRef;
      readonly reason: string;
    };

export type CommandSpecWithProductionAuthorityIngress<Spec extends CommandSpecDefinition = CommandSpecDefinition> = Spec & {
  readonly productionAuthorityIngress?: ProductionAuthorityIngressDisposition;
};

const typed = (
  adapter: ProductionAuthorityIngressAdapter,
  excludedVariants?: Readonly<Record<string, { readonly decisionRef: typeof productionAuthorityIngressDecisionRef; readonly reason: string }>>
): ProductionAuthorityIngressDisposition => ({ status: "typed-v2", adapter, ...(excludedVariants ? { excludedVariants } : {}) });

const excluded = (reason: string): ProductionAuthorityIngressDisposition => ({
  status: "excluded",
  decisionRef: productionAuthorityIngressDecisionRef,
  reason
});

const dispositions = {
  "new-task": typed("generic"),
  "task-claim": typed("task-claim"),
  "status-set": typed("generic"),
  "progress-append": typed("generic"),
  "task-code-doc-reconcile": typed("generic"),
  "task-consent-record": typed("generic"),
  "task-review-execution": typed("generic"),
  "task-complete": typed("generic"),
  "decision-propose": typed("generic"),
  "decision-transition": typed("decision-transition"),
  "decision-relate": typed("generic"),
  "record-fact": typed("generic"),
  "fact-invalidate": typed("generic"),
  "session-export": typed("generic"),
  "module-register": typed("generic"),

  "init": excluded("repository bootstrap writes precede production authority attachment"),
  "task-release": excluded("lease release mutates daemon-private holder state in the operational domain"),
  "task-start": excluded("CLI facade decomposes into separately admitted task-claim and status-set commands; a raw composite daemon action is rejected"),
  "task-submit": excluded("CLI facade decomposes into separately admitted task-code-doc-reconcile and status-set commands; a raw composite daemon action is rejected"),
  "task-closeout": excluded("CLI facade decomposes into separately admitted status-set, task-review-execution, task-code-doc-reconcile, and task-complete commands; a raw composite daemon action is rejected"),
  "task-amend": typed("observed-write"),
  "task-contract-migrate": excluded("task contract migration is an explicit local migration write road"),
  "task-archive": typed("observed-write"),
  "task-supersede": typed("observed-write"),
  "task-delete": typed("observed-write", {
    hard: {
      decisionRef: productionAuthorityIngressDecisionRef,
      reason: "production path does not offer hard delete; use task archive or task supersede after distilling evidence"
    }
  }),
  "task-reopen": typed("observed-write"),
  "task-review": excluded("legacy task review is superseded by typed execution review"),
  "task-relate": typed("observed-write"),
  "decision-repin": excluded("decision repin is restricted to the migration write road"),
  "decision-amend": typed("observed-write"),
  "decision-reckon": excluded("decision reckoning is a local derived-write workflow"),
  "decision-relation-retire": typed("observed-write"),
  "decision-relation-replace": typed("observed-write"),
  "distill-candidate": excluded("distillation candidates use the local derived-memory write road"),
  "distill-commit": excluded("distillation commit uses the local derived-memory write road"),
  "runtime-event-append": excluded("runtime events use the operational flush domain"),
  "materializer-run": excluded("materializer control is daemon-local orchestration"),
  "session-backfill": excluded("session backfill is an explicit migration workflow"),
  "session-sync": excluded("session sync has no production command adapter despite a typed semantic vocabulary"),
  "governance-rebuild": excluded("governance rebuild is an explicit local derived-write workflow"),
  "adopt-multica": excluded("multi-CA adoption is an explicit migration workflow"),
  "migrate-structure": excluded("structure migration uses the migration write road"),
  "migrate-anchors": excluded("anchor migration uses the migration write road"),
  "migrate-fact-execution": excluded("fact execution migration uses the migration write road"),
  "migrate-retired-attribution-fields": excluded("attribution migration uses the migration write road"),
  "migrate-provenance": excluded("provenance migration uses the migration write road"),
  "migrate-run": excluded("generic migration execution uses the migration write road"),
  "legacy-intake-plan": excluded("legacy intake planning writes migration-local artifacts"),
  "legacy-copy-safe-docs": excluded("legacy document copy uses the migration write road"),
  "legacy-index": excluded("legacy indexing uses the migration write road"),
  "git-diff": excluded("git diff writes only local diagnostic artifacts"),
  "worktree-create": excluded("worktree creation is repository orchestration outside authored authority"),
  "graph": excluded("graph generation writes derived local presentation artifacts"),
  "preset-install": excluded("preset installation mutates local extension state"),
  "preset-seed": excluded("preset seeding mutates local extension state"),
  "preset-uninstall": excluded("preset removal mutates local extension state"),
  "preset-entrypoint": excluded("preset entrypoints delegate to separately admitted command write roads"),
  "script-run": excluded("script execution uses declared script scopes rather than canonical typed ingress"),
  "module-scaffold": excluded("module scaffolding writes local source and template assets"),
  "module-unregister": typed("generic"),
  "module-step": typed("generic"),
  "gui": excluded("GUI launch is client-local process orchestration and does not author a canonical entity")
} as const satisfies Readonly<Record<string, ProductionAuthorityIngressDisposition>>;

export function attachProductionAuthorityIngress<const Specs extends ReadonlyArray<CommandSpecDefinition>>(
  specs: Specs
): { readonly [Index in keyof Specs]: CommandSpecWithProductionAuthorityIngress<Specs[Index]> } {
  const specKinds = new Set(specs.map((spec) => spec.kind));
  const unknownKinds = Object.keys(dispositions).filter((kind) => !specKinds.has(kind));
  if (unknownKinds.length > 0) {
    throw new Error(`PRODUCTION_AUTHORITY_INGRESS_UNKNOWN_COMMAND\n${unknownKinds.join("\n")}`);
  }
  return specs.map((spec) => ({
    ...spec,
    ...(spec.kind in dispositions
      ? { productionAuthorityIngress: dispositions[spec.kind as keyof typeof dispositions] }
      : {})
  })) as { readonly [Index in keyof Specs]: CommandSpecWithProductionAuthorityIngress<Specs[Index]> };
}

export function assertProductionAuthorityIngressCompleteness(
  specs: ReadonlyArray<CommandSpecWithProductionAuthorityIngress>,
  classify: (kind: string) => string | undefined
): void {
  const errors: string[] = [];
  for (const spec of specs) {
    const commandClass = classify(spec.kind);
    const requiresDisposition = commandClass === "repo-write" || commandClass === "arbiter";
    const disposition = spec.productionAuthorityIngress;
    if (requiresDisposition && !disposition) {
      errors.push(`${spec.kind}: ${commandClass} command lacks productionAuthorityIngress`);
      continue;
    }
    if (!requiresDisposition && disposition) {
      errors.push(`${spec.kind}: ${commandClass ?? "unclassified"} command must not declare productionAuthorityIngress`);
      continue;
    }
    if (disposition?.status === "excluded" && (!disposition.reason.trim() || !/^decision\/dec_[A-Z0-9]+$/u.test(disposition.decisionRef))) {
      errors.push(`${spec.kind}: excluded ingress requires a reason and decision reference`);
    }
    if (disposition?.status === "typed-v2" && disposition.excludedVariants) {
      for (const [variant, exclusion] of Object.entries(disposition.excludedVariants)) {
        if (!variant.trim() || !exclusion.reason.trim() || !/^decision\/dec_[A-Z0-9]+$/u.test(exclusion.decisionRef)) {
          errors.push(`${spec.kind}: excluded ingress variant requires a name, reason, and decision reference`);
        }
      }
    }
  }
  if (errors.length > 0) throw new Error(`PRODUCTION_AUTHORITY_INGRESS_INCOMPLETE\n${errors.join("\n")}`);
}
