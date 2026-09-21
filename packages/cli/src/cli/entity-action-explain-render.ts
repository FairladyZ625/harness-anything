import type { DaemonGuiReadResultMap } from "@harness-anything/daemon/internal/protocol/daemon-protocol-gui-types";
import { renderCliGuidance } from "./guidance-plane.ts";

export type EntityActionExplanationRenderInput = DaemonGuiReadResultMap["repo.entity.actions.explain"];

export function renderEntityActionExplanation(
  value: EntityActionExplanationRenderInput,
  requestRefs?: readonly string[],
): string {
  assertRenderableExplanation(value);
  const heading =
      value.mode === "catalog"
        ? `${title(value.subjects[0]?.kind)} actions (catalog; availability is not evaluated without an object):`
        : `Entity action explanation at ${String(value.evaluatedAtCut)}:`,
    subjects = value.subjects.flatMap((subject, index) => {
      if (subject.failure)
        return [
          `${subject.ref ?? requestRefAt(requestRefs, index)}: ${subject.failure.code}`,
          `  message: ${subject.failure.message}`,
          `  evaluated cut: ${String(value.evaluatedAtCut)}`,
          ...subject.failure.nextActions.map((action) => `  next: ${action}`),
        ];
      const subjectHeading = subject.ref
          ? `${subject.ref} @ revision ${String(subject.revision)}`
          : `${subject.kind ?? "entity"} catalog`,
        actions = subject.actions.flatMap((row) => {
          const state = row.available === null ? "not evaluated" : row.available ? "available" : "unavailable";
          return [
            `  ${row.action.id}: ${state} — ${row.action.explain}`,
            `    usage: ${row.action.syntax.usage}`,
            `    evaluated cut: ${row.evaluatedAtCut ?? "not evaluated"}`,
            ...row.unmetCriteria.map(
              (criterion) => `    unmet: ${criterion.ref} [${criterion.failureCode}] — ${criterion.explain}`,
            ),
            ...row.criteria
              .filter((criterion) => criterion.status === "invocation-required")
              .map((criterion) => `    invocation input: ${criterion.ref} — ${criterion.explain}`),
            ...(row.authorizationDecision?.outcome === "denied"
              ? [
                  `    authorization: denied by ${row.authorizationDecision.policyRef} ` +
                    `(${row.authorizationDecision.reasonCodes.join(", ")})`,
                ]
              : []),
            ...(row.available === false
              ? [
                  `    next: ${renderCliGuidance("explain-action-remedy", {
                    usage: row.action.syntax.usage,
                  })}`,
                ]
              : []),
          ];
        });
      return [subjectHeading, ...actions];
    });
  return [heading, ...subjects].join("\n");
}

function title(value: string | null | undefined): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : "Entity";
}

// Failure subjects for invalid refs carry ref: null by contract, so their label must come from the
// positionally aligned explain request; without it the user's input would be unrenderable.
function requestRefAt(requestRefs: readonly string[] | undefined, index: number): string {
  const ref = requestRefs?.[index];
  if (typeof ref !== "string" || ref.length === 0)
    throw new TypeError("Entity Action explanation failure subject is missing its request-side ref.");
  return ref;
}

function assertRenderableExplanation(value: EntityActionExplanationRenderInput): void {
  assertFields(value, ["mode", "subjects", "evaluatedAtCut"], "explanation set");
  if (!Array.isArray(value.subjects)) throw new TypeError("Entity Action explanation subjects are missing.");
  for (const subject of value.subjects) {
    assertFields(subject, ["ref", "revision", "actions", "failure"], "explanation subject");
    if (!Array.isArray(subject.actions)) throw new TypeError("Entity Action explanation actions are missing.");
    if (subject.failure !== null) {
      assertFields(subject.failure, ["code", "message", "nextActions"], "explanation failure");
      if (!Array.isArray(subject.failure.nextActions))
        throw new TypeError("Entity Action explanation failure next actions are missing.");
    }
    for (const row of subject.actions) {
      assertFields(
        row,
        ["action", "available", "criteria", "unmetCriteria", "authorizationDecision", "nextActions", "evaluatedAtCut"],
        "explanation action row",
      );
      assertFields(row.action, ["id", "explain", "syntax"], "explanation action");
      assertFields(row.action.syntax, ["usage"], "explanation action syntax");
      if (!Array.isArray(row.criteria) || !Array.isArray(row.unmetCriteria) || !Array.isArray(row.nextActions))
        throw new TypeError("Entity Action explanation row arrays are missing.");
      if (row.authorizationDecision !== null)
        assertFields(
          row.authorizationDecision,
          ["policyRef", "outcome", "reasonCodes", "nextActions", "evaluatedAtCut"],
          "explanation authorization decision",
        );
    }
  }
}

function assertFields(value: object, fields: readonly string[], label: string): void {
  if (fields.some((field) => !Object.hasOwn(value, field)))
    throw new TypeError(`Entity Action ${label} is missing required fields.`);
}
