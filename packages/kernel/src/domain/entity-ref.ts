export type EntityRefKind = "task";

export interface ParsedEntityRef {
  readonly raw: string;
  readonly kind: EntityRefKind;
  readonly id: string;
  readonly harnessAlias?: string;
  readonly externalHarness: boolean;
}

const entityRefPattern = /^(?:(?<alias>[A-Za-z][A-Za-z0-9_-]*):)?(?<kind>task)\/(?<id>[A-Za-z0-9_-]+)$/u;
const entityRefSearchPattern = /\b(?:(?<alias>[A-Za-z][A-Za-z0-9_-]*):)?(?<kind>task)\/(?<id>[A-Za-z0-9_-]+)\b/gu;

export function parseEntityRef(value: string): ParsedEntityRef | null {
  const match = value.match(entityRefPattern);
  const kind = match?.groups?.kind;
  const id = match?.groups?.id;
  if (kind !== "task" || !id) return null;
  const harnessAlias = match.groups?.alias;
  return {
    raw: value,
    kind,
    id,
    ...(harnessAlias ? { harnessAlias } : {}),
    externalHarness: Boolean(harnessAlias)
  };
}

export function findEntityRefs(body: string): ReadonlyArray<ParsedEntityRef> {
  return [...body.matchAll(entityRefSearchPattern)]
    .map((match) => parseEntityRef(match[0]))
    .filter((ref): ref is ParsedEntityRef => ref !== null);
}
