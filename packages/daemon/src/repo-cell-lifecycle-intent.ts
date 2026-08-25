import type { TaskLifecycleCommand } from "../../kernel/src/index.ts";

type TaskLifecycleIntentId = Exclude<TaskLifecycleCommand["type"], "CreateReplayTask">;

const lifecycleIntentByIngress: Readonly<Record<string, TaskLifecycleIntentId>> = Object.freeze({
  "task-start": "StartExecution",
  "task-transition": "TransitionTask",
  "task-submit": "SubmitExecution",
  "task-review-execution": "RecordReview",
  "task-review-consent": "RecordReviewConsent",
  "task-code-doc-reconcile": "ReconcileCodeDoc",
  "task-code-doc-repoint": "RepointCodeDoc",
  "task-complete": "CompleteTask",
});

export type TaskLifecycleIntentResolution =
  | {
      readonly type: "participant";
      readonly ingressKind: string;
      readonly intentId: TaskLifecycleIntentId;
    }
  | {
      readonly type: "non-participant";
      readonly ingressKind: string;
    }
  | {
      readonly type: "unknown";
      readonly ingressKind: null;
    };

export function resolveTaskLifecycleIntent(
  ingress: Readonly<{ readonly kind?: unknown }>,
): TaskLifecycleIntentResolution {
  if (typeof ingress.kind !== "string") return { type: "unknown", ingressKind: null };
  const intentId = lifecycleIntentByIngress[ingress.kind];
  return intentId === undefined
    ? { type: "non-participant", ingressKind: ingress.kind }
    : { type: "participant", ingressKind: ingress.kind, intentId };
}

export function resolveUniqueCatalogActionByIntent<Action extends { readonly intentId: string }>(
  actions: readonly Action[],
  intentId: string,
) {
  const matches = actions.filter((action) => action.intentId === intentId);
  if (matches.length === 0) return { type: "missing", intentId } as const;
  if (matches.length > 1) return { type: "ambiguous", intentId, matches: matches.length } as const;
  return { type: "matched", intentId, action: matches[0]! } as const;
}
