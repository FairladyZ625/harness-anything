export const ENTITY_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";

export interface EntityKindRefAuthority {
  readonly kind: string;
  readonly field: string;
  readonly pattern: string;
  readonly refTemplate: string;
  readonly refPattern?: string;
  readonly anchorPattern?: string;
}

export const entityKindRefAuthorities = Object.freeze([
  {
    kind: "task",
    field: "task_id",
    pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    refTemplate: "task/{id}",
    refPattern: "^(?:task_[A-Za-z0-9_-]+|[A-Za-z0-9][A-Za-z0-9_-]*-[A-Za-z0-9_-]+)$",
  },
  {
    kind: "fact",
    field: "factId",
    pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    refTemplate: "fact/{id}",
    refPattern: "^F-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
  },
  {
    kind: "decision",
    field: "decisionId",
    pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    refTemplate: "decision/{id}",
    refPattern: "^(?:dec_[A-Za-z0-9_-]+|[A-Za-z0-9][A-Za-z0-9_-]*-[A-Za-z0-9_-]+)$",
    anchorPattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
  },
  { kind: "agent", field: "id", pattern: ENTITY_ID_PATTERN, refTemplate: "agent/{id}" },
  { kind: "squad", field: "id", pattern: ENTITY_ID_PATTERN, refTemplate: "squad/{id}" },
  { kind: "policy", field: "id", pattern: ENTITY_ID_PATTERN, refTemplate: "policy/{id}" },
  {
    kind: "execution",
    field: "executionId",
    pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    refTemplate: "execution/{id}",
  },
  {
    kind: "review",
    field: "reviewId",
    pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    refTemplate: "review/{id}",
  },
  {
    kind: "runtime-session",
    field: "runtimeSessionId",
    pattern: "^runtime_[a-z0-9]+$",
    refTemplate: "runtime-session/{id}",
  },
  { kind: "schedule", field: "scheduleId", pattern: ENTITY_ID_PATTERN, refTemplate: "schedule/{id}" },
  { kind: "settings", field: "settingsId", pattern: "^repository$", refTemplate: "settings/{id}" },
  {
    kind: "person",
    field: "personId",
    pattern: "^[A-Za-z][A-Za-z0-9_-]{0,62}$",
    refTemplate: "person/{id}",
  },
] as const satisfies readonly EntityKindRefAuthority[]);

export type EntityRefKind = (typeof entityKindRefAuthorities)[number]["kind"] | "relation";

export interface ParsedEntityRef {
  readonly raw: string;
  readonly kind: EntityRefKind;
  readonly id: string;
  readonly anchor?: string;
  readonly ownerExecutionId?: string;
  readonly harnessAlias?: string;
  readonly externalHarness: boolean;
}
export type EntityRef = ParsedEntityRef["raw"];

const entityRefPrefixPattern = /^(?:(?<alias>[A-Za-z][A-Za-z0-9_-]*):)?(?<body>.+)$/u;
const relationRefPattern = /^relation\/(?<id>rel_[a-f0-9]{16})$/u;
const templateTokenPattern = /^\{(?<kind>[a-z-]+)\}$/u;
const kindRefPatterns = entityKindRefAuthorities.map((contract) => ({
  contract,
  parse: new RegExp(`^${compileRefBodyPattern(contract, true)}$`, "u"),
}));
const entityRefSearchPattern = new RegExp(
  String.raw`(?<![A-Za-z0-9_/-])(?:[A-Za-z][A-Za-z0-9_-]*:)?(?:relation\/rel_[a-f0-9]{16}|${entityKindRefAuthorities
    .map((contract) => compileRefBodyPattern(contract, false))
    .join("|")})\b(?!\/)`,
  "gu",
);

export function parseEntityRef(value: string): ParsedEntityRef | null {
  const prefix = value.match(entityRefPrefixPattern),
    body = prefix?.groups?.body;
  if (!body) return null;
  const harnessAlias = prefix.groups?.alias,
    relation = body.match(relationRefPattern);
  if (relation?.groups?.id)
    return {
      raw: value,
      kind: "relation",
      id: relation.groups.id,
      ...(harnessAlias ? { harnessAlias } : {}),
      externalHarness: Boolean(harnessAlias),
    };

  for (const { contract, parse } of kindRefPatterns) {
    const match = body.match(parse),
      id = match?.groups?.id;
    if (!id) continue;
    return {
      raw: value,
      kind: contract.kind as Exclude<EntityRefKind, "relation">,
      id,
      ...(match.groups?.anchor ? { anchor: match.groups.anchor } : {}),
      ...(match.groups?.execution ? { ownerExecutionId: match.groups.execution } : {}),
      ...(harnessAlias ? { harnessAlias } : {}),
      externalHarness: Boolean(harnessAlias),
    };
  }
  return null;
}

export function findEntityRefs(body: string): ReadonlyArray<ParsedEntityRef> {
  return [...body.matchAll(entityRefSearchPattern)]
    .map((match) => parseEntityRef(match[0]))
    .filter((ref): ref is ParsedEntityRef => ref !== null);
}

export function requireEntityKindRefAuthority(kind: string): EntityKindRefAuthority {
  const authority = entityKindRefAuthorities.find((candidate) => candidate.kind === kind);
  if (!authority) throw new Error(`Entity kind ${kind} has no ref authority.`);
  return authority;
}

export function deriveEntityKindIdentity(
  kind: string,
): Pick<EntityKindRefAuthority, "field" | "pattern" | "refTemplate"> {
  const { field, pattern, refTemplate } = requireEntityKindRefAuthority(kind);
  return Object.freeze({ field, pattern, refTemplate });
}

function compileRefBodyPattern(contract: EntityKindRefAuthority, capture: boolean): string {
  const segments = contract.refTemplate.split("/").map((segment) => {
    const token = segment.match(templateTokenPattern)?.groups?.kind;
    if (!token) return escapeRegExp(segment);
    const source: EntityKindRefAuthority | undefined =
      token === "id" ? contract : entityKindRefAuthorities.find(({ kind }) => kind === token);
    if (!source) throw new Error(`Entity ref template ${contract.refTemplate} names unknown kind ${token}.`);
    const pattern = unanchored(source.refPattern ?? source.pattern);
    return capture ? `(?<${token}>${pattern})` : `(?:${pattern})`;
  });
  const anchorPattern = contract.anchorPattern ? unanchored(contract.anchorPattern) : "",
    anchor = contract.anchorPattern ? `(?:/${capture ? `(?<anchor>${anchorPattern})` : `(?:${anchorPattern})`})?` : "";
  return `${segments.join("/")}${anchor}`;
}

function unanchored(pattern: string): string {
  return pattern.replace(/^\^/u, "").replace(/\$$/u, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
