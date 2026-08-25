export type EntityRefKind =
  | "task"
  | "decision"
  | "fact"
  | "execution"
  | "review"
  | "agent"
  | "runtime-session"
  | "policy"
  | "relation";

export interface ParsedEntityRef {
  readonly raw: string;
  readonly kind: EntityRefKind;
  readonly id: string;
  readonly anchor?: string;
  readonly ownerTaskId?: string;
  readonly harnessAlias?: string;
  readonly externalHarness: boolean;
}
export type EntityRef = ParsedEntityRef["raw"];

const entityRefPrefixPattern = /^(?:(?<alias>[A-Za-z][A-Za-z0-9_-]*):)?(?<body>.+)$/u;
const taskOrDecisionRefPattern = /^(?<kind>task|decision)\/(?<id>[A-Za-z0-9_-]+)(?:\/(?<anchor>[A-Za-z0-9_-]+))?$/u;
const executionRefPattern = /^execution\/(?<ownerTaskId>[A-Za-z0-9_-]+)\/(?<executionId>[A-Za-z0-9_-]+)$/u;
const reviewRefPattern = /^review\/(?<ownerExecutionId>[A-Za-z0-9_-]+)\/(?<reviewId>[A-Za-z0-9_-]+)$/u;
const phaseOneEntityRefPattern = /^(?<kind>execution|review|agent|runtime-session|policy)\/(?<id>[A-Za-z0-9_-]+)$/u;
const factRefPattern = /^fact\/(?<ownerTaskId>[A-Za-z0-9_-]+)\/(?<factId>[A-Za-z0-9_-]+)$/u;
const relationRefPattern = /^relation\/(?<relationId>rel_[a-f0-9]{16})$/u;
const entityRefSearchPattern = new RegExp(
  String.raw`(?<![A-Za-z0-9_/-])(?:[A-Za-z][A-Za-z0-9_-]*:)?(?:fact\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+|` +
    String.raw`relation\/rel_[a-f0-9]{16}|(?:execution|review)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+|` +
    String.raw`(?:task|decision)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?|` +
    String.raw`(?:execution|review|agent|runtime-session|policy)\/[A-Za-z0-9_-]+)\b(?!\/)`,
  "gu",
);

function isPlausibleTaskRefId(id: string): boolean {
  return id.startsWith("task_") || id.includes("-");
}

function isPlausibleDecisionRefId(id: string): boolean {
  return id.startsWith("dec_") || id.includes("-");
}

function isPlausibleFactRefId(id: string): boolean {
  return id.startsWith("F-");
}

function isPlausibleRelationRefId(id: string): boolean {
  return /^rel_[a-f0-9]{16}$/u.test(id);
}

export function parseEntityRef(value: string): ParsedEntityRef | null {
  const prefix = value.match(entityRefPrefixPattern);
  const body = prefix?.groups?.body;
  if (!body) return null;
  const harnessAlias = prefix.groups?.alias;

  const fact = body.match(factRefPattern);
  if (fact?.groups?.ownerTaskId && fact.groups.factId) {
    if (!isPlausibleTaskRefId(fact.groups.ownerTaskId) || !isPlausibleFactRefId(fact.groups.factId)) return null;
    return {
      raw: value,
      kind: "fact",
      id: fact.groups.factId,
      ownerTaskId: fact.groups.ownerTaskId,
      ...(harnessAlias ? { harnessAlias } : {}),
      externalHarness: Boolean(harnessAlias),
    };
  }

  const relation = body.match(relationRefPattern);
  if (relation?.groups?.relationId) {
    if (!isPlausibleRelationRefId(relation.groups.relationId)) return null;
    return {
      raw: value,
      kind: "relation",
      id: relation.groups.relationId,
      ...(harnessAlias ? { harnessAlias } : {}),
      externalHarness: Boolean(harnessAlias),
    };
  }

  const execution = body.match(executionRefPattern);
  if (execution?.groups?.ownerTaskId && execution.groups.executionId) {
    if (!isPlausibleTaskRefId(execution.groups.ownerTaskId)) return null;
    return {
      raw: value,
      kind: "execution",
      id: execution.groups.executionId,
      ownerTaskId: execution.groups.ownerTaskId,
      ...(harnessAlias ? { harnessAlias } : {}),
      externalHarness: Boolean(harnessAlias),
    };
  }

  const review = body.match(reviewRefPattern);
  if (review?.groups?.ownerExecutionId && review.groups.reviewId) {
    return {
      raw: value,
      kind: "review",
      id: review.groups.reviewId,
      ownerTaskId: review.groups.ownerExecutionId,
      ...(harnessAlias ? { harnessAlias } : {}),
      externalHarness: Boolean(harnessAlias),
    };
  }

  const phaseOneEntity = body.match(phaseOneEntityRefPattern);
  if (phaseOneEntity?.groups?.kind && phaseOneEntity.groups.id) {
    return {
      raw: value,
      kind: phaseOneEntity.groups.kind as Exclude<EntityRefKind, "task" | "decision" | "fact" | "relation">,
      id: phaseOneEntity.groups.id,
      ...(harnessAlias ? { harnessAlias } : {}),
      externalHarness: Boolean(harnessAlias),
    };
  }

  const entity = body.match(taskOrDecisionRefPattern);
  const kind = entity?.groups?.kind;
  const id = entity?.groups?.id;
  if ((kind !== "task" && kind !== "decision") || !id) return null;
  if (kind === "task" && !isPlausibleTaskRefId(id)) return null;
  if (kind === "decision" && !isPlausibleDecisionRefId(id)) return null;
  const anchor = entity.groups?.anchor;
  return {
    raw: value,
    kind,
    id,
    ...(anchor ? { anchor } : {}),
    ...(harnessAlias ? { harnessAlias } : {}),
    externalHarness: Boolean(harnessAlias),
  };
}

export function findEntityRefs(body: string): ReadonlyArray<ParsedEntityRef> {
  return [...body.matchAll(entityRefSearchPattern)]
    .map((match) => parseEntityRef(match[0]))
    .filter((ref): ref is ParsedEntityRef => ref !== null);
}
