import { isCloseoutPlaceholderMarkdown, type TaskDocumentPlaceholderPolicy } from "./task-lifecycle-gates.ts";

export type CompletionPrerequisiteDecisionRef = `dec_${string}/${string}`;

export type CompletionPrerequisiteEnforcementSurface =
  | { readonly kind: "task-authority"; readonly stage: "complete" }
  | {
      readonly kind: "ci-only";
      readonly gateId: string;
      readonly reason: string;
      readonly decisionRef: CompletionPrerequisiteDecisionRef;
    }
  | {
      readonly kind: "audit-only";
      readonly profile: string;
      readonly reason: string;
      readonly decisionRef: CompletionPrerequisiteDecisionRef;
    };

export interface TaskCompletionPrerequisiteSnapshot {
  readonly documentPlaceholderPolicy: TaskDocumentPlaceholderPolicy;
}

export interface TaskCompletionPrerequisiteInput {
  readonly taskId: string;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  readonly completionGates: ReadonlyArray<string>;
  readonly ciGate: "passed" | "failed" | "not-applicable" | null;
  readonly snapshot: TaskCompletionPrerequisiteSnapshot;
}

export type TaskCompletionPrerequisiteResult<Id extends string = string> =
  | {
      readonly id: Id;
      readonly ok: true;
      readonly disposition: "passed" | "not-applicable";
    }
  | {
      readonly id: Id;
      readonly ok: false;
      readonly errorCode: string;
    };

interface TaskAuthorityCompletionPrerequisite<Id extends string> {
  readonly id: Id;
  readonly surface: { readonly kind: "task-authority"; readonly stage: "complete" };
  readonly evaluate: (input: TaskCompletionPrerequisiteInput) => TaskCompletionPrerequisiteResult<Id>;
}

interface ExternallyEnforcedCompletionPrerequisite<Id extends string> {
  readonly id: Id;
  readonly surface: Extract<CompletionPrerequisiteEnforcementSurface, { readonly kind: "ci-only" | "audit-only" }>;
  readonly evaluatorRef: string;
}

type AnyCompletionPrerequisiteCatalogEntry<Id extends string = string> =
  | TaskAuthorityCompletionPrerequisite<Id>
  | ExternallyEnforcedCompletionPrerequisite<Id>;

function defineCompletionPrerequisiteCatalog<
  const Catalog extends ReadonlyArray<AnyCompletionPrerequisiteCatalogEntry>
>(catalog: Catalog): Catalog {
  return catalog;
}

export const completionPrerequisiteCatalog = defineCompletionPrerequisiteCatalog([{
  id: "closeout-substantive",
  surface: { kind: "task-authority", stage: "complete" },
  evaluate: evaluateCloseoutSubstantive
}, {
  id: "ci-passed",
  surface: { kind: "task-authority", stage: "complete" },
  evaluate: evaluateCiPassed
}, {
  id: "milestone-dossier",
  surface: {
    kind: "ci-only",
    gateId: "ha-check/milestone-dossier",
    reason: "Milestone dossier validity is a repository-wide merge prerequisite, not a task lifecycle transition prerequisite.",
    decisionRef: "dec_mr5ukw8f/CH1"
  },
  evaluatorRef: "packages/cli/src/commands/check.ts#checkMilestoneDossier"
}, {
  id: "task-contract-marker",
  surface: {
    kind: "audit-only",
    profile: "strict",
    reason: "The marker is strict-profile hardening and is not declared as a universal task completion prerequisite.",
    decisionRef: "dec_01KZ9C6R2SQ1E46D1TVRK2AHE2/CH1"
  },
  evaluatorRef: "packages/cli/src/commands/check.ts#task_contract_marker_missing"
}, {
  id: "visual-phase-table",
  surface: {
    kind: "audit-only",
    profile: "strict",
    reason: "The visual phase table is strict-profile hardening for tasks that carry a visual map.",
    decisionRef: "dec_01KZ9C6R2SQ1E46D1TVRK2AHE2/CH1"
  },
  evaluatorRef: "packages/cli/src/commands/check.ts#visual_phase_table_missing"
}, {
  id: "worker-authorization-resolved",
  surface: {
    kind: "audit-only",
    profile: "strict",
    reason: "Worker authorization prose is a strict-profile audit until a decision promotes it to lifecycle authority.",
    decisionRef: "dec_01KZ9C6R2SQ1E46D1TVRK2AHE2/CH1"
  },
  evaluatorRef: "packages/cli/src/commands/check.ts#worker_authorization_pending"
}, {
  id: "lesson-candidates-substantive",
  surface: {
    kind: "audit-only",
    profile: "strict",
    reason: "Lesson routing remains optional strict-profile hardening and does not determine task completion eligibility.",
    decisionRef: "dec_01KZ9C6R2SQ1E46D1TVRK2AHE2/CH1"
  },
  evaluatorRef: "packages/cli/src/commands/check.ts#lesson_placeholder"
}] as const);

export type CompletionPrerequisiteCatalogEntry = typeof completionPrerequisiteCatalog[number];
export type TaskAuthorityCompletionPrerequisiteEntry = Extract<
  CompletionPrerequisiteCatalogEntry,
  { readonly surface: { readonly kind: "task-authority" } }
>;
export type TaskAuthorityCompletionPrerequisiteId = TaskAuthorityCompletionPrerequisiteEntry["id"];

export const taskAuthorityCompletionPrerequisites: ReadonlyArray<TaskAuthorityCompletionPrerequisiteEntry> =
  completionPrerequisiteCatalog.filter(
    (entry): entry is TaskAuthorityCompletionPrerequisiteEntry => entry.surface.kind === "task-authority"
  );

function evaluateCloseoutSubstantive(
  input: TaskCompletionPrerequisiteInput
): TaskCompletionPrerequisiteResult<"closeout-substantive"> {
  const closeout = input.documents.find((document) => document.path === "closeout.md")?.body;
  if (!closeout?.trim()) {
    return {
      id: "closeout-substantive",
      ok: false,
      errorCode: "AUTHORITY_TASK_COMPLETE_CLOSEOUT_REQUIRED"
    };
  }
  if (!isCloseoutPlaceholderMarkdown(
    closeout,
    input.snapshot.documentPlaceholderPolicy.closeoutPlaceholderFingerprints
  )) {
    return { id: "closeout-substantive", ok: true, disposition: "passed" };
  }
  return {
    id: "closeout-substantive",
    ok: false,
    errorCode: "AUTHORITY_TASK_COMPLETE_CLOSEOUT_PLACEHOLDER"
  };
}

function evaluateCiPassed(
  input: TaskCompletionPrerequisiteInput
): TaskCompletionPrerequisiteResult<"ci-passed"> {
  if (!input.completionGates.includes("ci")) {
    return { id: "ci-passed", ok: true, disposition: "not-applicable" };
  }
  return input.ciGate === "passed"
    ? { id: "ci-passed", ok: true, disposition: "passed" }
    : {
        id: "ci-passed",
        ok: false,
        errorCode: `AUTHORITY_TASK_COMPLETE_CI_GATE_REQUIRED:${input.ciGate ?? "missing"}`
      };
}
