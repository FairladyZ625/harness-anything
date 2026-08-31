export interface EntityActionExplanationRenderInput {
  readonly mode: "catalog" | "object" | "failure";
  readonly evaluatedAtCut: string | null;
  readonly subjects: readonly {
    readonly ref: string | null;
    readonly revision: number | null;
    readonly failure: null | {
      readonly code: string;
      readonly message: string;
      readonly nextActions: readonly string[];
    };
    readonly actions: readonly {
      readonly action: { readonly id: string; readonly explain: string; readonly syntax: { readonly usage: string } };
      readonly available: boolean | null;
      readonly unmetCriteria: readonly {
        readonly ref: string;
        readonly failureCode: string;
        readonly explain: string;
      }[];
      readonly authorizationDecision: null | {
        readonly outcome: "allowed" | "denied";
        readonly reasonCodes: readonly string[];
      };
      readonly nextActions: readonly string[];
    }[];
  }[];
}

export function renderEntityActionExplanation(value: EntityActionExplanationRenderInput): string {
  const heading =
      value.mode === "catalog"
        ? "Task actions (catalog; availability is not evaluated without an object):"
        : `Task action explanation at ${String(value.evaluatedAtCut)}:`,
    subjects = value.subjects.flatMap((subject) => {
      if (subject.failure)
        return [
          `${subject.ref ?? "invalid ref"}: ${subject.failure.code} — ${subject.failure.message}`,
          ...subject.failure.nextActions.map((next) => `  next: ${next}`),
        ];
      const subjectHeading = subject.ref ? `${subject.ref} @ revision ${String(subject.revision)}` : "task catalog",
        actions = subject.actions.flatMap((row) => {
          const state = row.available === null ? "not evaluated" : row.available ? "available" : "unavailable";
          return [
            `  ${row.action.id}: ${state} — ${row.action.explain}`,
            `    usage: ${row.action.syntax.usage}`,
            ...row.unmetCriteria.map(
              (criterion) => `    unmet: ${criterion.ref} [${criterion.failureCode}] — ${criterion.explain}`,
            ),
            ...(row.authorizationDecision?.outcome === "denied"
              ? [`    authorization: denied (${row.authorizationDecision.reasonCodes.join(", ")})`]
              : []),
            ...row.nextActions.map((next) => `    next: ${next}`),
          ];
        });
      return [subjectHeading, ...actions];
    });
  return [heading, ...subjects].join("\n");
}
