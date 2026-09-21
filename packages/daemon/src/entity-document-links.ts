import { parseEntityRef, type DecisionRelationLinkResolver, type TaskProjection } from "@harness-anything/kernel";

/** Resolves one relation endpoint to the current canonical document path and a one-line label. */
export function decisionRelationLinkResolver(
  projection: Pick<TaskProjection, "readDecision" | "readFact" | "read">,
): DecisionRelationLinkResolver {
  const label = (text: string) => text.replace(/\s+/gu, " ").trim();
  return (ref) => {
    const parsed = parseEntityRef(ref);
    if (!parsed) return null;
    if (parsed.kind === "decision") {
      const decision = projection.readDecision(parsed.id).decision;
      return decision === null
        ? null
        : { path: `decisions/decision-${parsed.id}/decision.md`, label: label(decision.title) };
    }
    if (parsed.kind === "fact") {
      const fact = projection.readFact(parsed.id).fact;
      return fact === null ? null : { path: `facts/${parsed.id}.md`, label: label(fact.statement) };
    }
    if (parsed.kind === "task") {
      const read = projection.read(parsed.id);
      return read.packagePath === null || read.snapshot.task === null
        ? null
        : { path: `${read.packagePath}/INDEX.md`, label: label(read.snapshot.task.title) };
    }
    return null;
  };
}
