export type EntityRefKind = "task" | "decision" | "fact";

export interface ParsedEntityRef {
  readonly raw: string;
  readonly kind: EntityRefKind;
  readonly id: string;
  readonly anchor?: string;
  readonly ownerTaskId?: string;
  readonly harnessAlias?: string;
  readonly externalHarness: boolean;
}

const entityRefPrefixPattern = /^(?:(?<alias>[A-Za-z][A-Za-z0-9_-]*):)?(?<body>.+)$/u;
const taskOrDecisionRefPattern = /^(?<kind>task|decision)\/(?<id>[A-Za-z0-9_-]+)(?:\/(?<anchor>[A-Za-z0-9_-]+))?$/u;
const factRefPattern = /^fact\/(?<ownerTaskId>[A-Za-z0-9_-]+)\/(?<factId>[A-Za-z0-9_-]+)$/u;
const entityRefSearchPattern = /(?<![A-Za-z0-9_/-])(?:[A-Za-z][A-Za-z0-9_-]*:)?(?:fact\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+|(?:task|decision)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?)\b(?!\/)/gu;

function isPlausibleTaskRefId(id: string): boolean {
  return id.startsWith("task_") || id.includes("-");
}

function isPlausibleDecisionRefId(id: string): boolean {
  return id.startsWith("dec_") || id.includes("-");
}

function isPlausibleFactRefId(id: string): boolean {
  return id.startsWith("F-");
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
      externalHarness: Boolean(harnessAlias)
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
    externalHarness: Boolean(harnessAlias)
  };
}

export function findEntityRefs(body: string): ReadonlyArray<ParsedEntityRef> {
  return [...body.matchAll(entityRefSearchPattern)]
    .map((match) => parseEntityRef(match[0]))
    .filter((ref): ref is ParsedEntityRef => ref !== null);
}
