import type { CommandSpecDefinition } from "./types.ts";

export const productionAuthorityIngressDecisionRef =
  "decision/dec_01KXSWKWTEXB751A30TRRCQWDG" as const;

export type ProductionAuthorityIngressAdapter = "generic" | "decision-transition" | "task-claim";

export type ProductionAuthorityIngressDisposition =
  | {
      readonly status: "typed-v2";
      readonly adapter: ProductionAuthorityIngressAdapter;
    }
  | {
      readonly status: "excluded";
      readonly decisionRef: typeof productionAuthorityIngressDecisionRef;
      readonly reason: string;
    };

export type CommandSpecWithProductionAuthorityIngress<Spec extends CommandSpecDefinition = CommandSpecDefinition> = Spec & {
  readonly productionAuthorityIngress?: ProductionAuthorityIngressDisposition;
};

const typed = (adapter: ProductionAuthorityIngressAdapter): ProductionAuthorityIngressDisposition => ({
  status: "typed-v2",
  adapter
});

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
  "task-amend": excluded("task extension amendment has no production typed semantic compiler"),
  "task-contract-migrate": excluded("task contract migration is an explicit local migration write road"),
  "task-archive": excluded("task archival has no production typed semantic compiler"),
  "task-supersede": excluded("task supersession has no production typed semantic compiler"),
  "task-delete": excluded("task deletion has no production typed semantic compiler"),
  "task-reopen": excluded("task reopen has no production typed semantic compiler"),
  "task-review": excluded("legacy task review is superseded by typed execution review"),
  "task-relate": excluded("task-hosted relation writes have no production typed semantic compiler"),
  "decision-repin": excluded("decision repin is restricted to the migration write road"),
  "decision-amend": excluded("decision amendment has no production typed semantic compiler"),
  "decision-reckon": excluded("decision reckoning is a local derived-write workflow"),
  "decision-relation-retire": excluded("relation retirement has no production typed semantic compiler"),
  "decision-relation-replace": excluded("relation replacement has no production typed semantic compiler"),
  "distill-candidate": excluded("distillation candidates use the local derived-memory write road"),
  "distill-commit": excluded("distillation commit uses the local derived-memory write road"),
  "runtime-event-append": excluded("runtime events use the operational flush domain"),
  "materializer-run": excluded("materializer control is daemon-local orchestration"),
  "session-backfill": excluded("session backfill is an explicit migration workflow"),
  "session-sync": excluded("session sync has no production command adapter despite a typed semantic vocabulary"),
  "governance-rebuild": excluded("governance rebuild is an explicit local derived-write workflow"),
  "lesson-promote": excluded("lesson promotion has no production typed semantic compiler"),
  "lesson-sediment": excluded("lesson sedimentation has no production typed semantic compiler"),
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
  "module-unregister": excluded("module removal has no production typed semantic compiler"),
  "module-step": excluded("module step mutation has no production typed semantic compiler"),
  "gui": excluded("GUI launch is daemon orchestration and does not author a canonical entity")
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
  }
  if (errors.length > 0) throw new Error(`PRODUCTION_AUTHORITY_INGRESS_INCOMPLETE\n${errors.join("\n")}`);
}
