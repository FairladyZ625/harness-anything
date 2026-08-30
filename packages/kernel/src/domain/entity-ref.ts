import { ENTITY_ID_PATTERN, entityTypeContracts, type EntityIdentityContract, type EntityKind } from "./base-entity.ts";

export { ENTITY_ID_PATTERN };
export type EntityKindRefAuthority<K extends EntityKind = EntityKind> = EntityIdentityContract<K> & {
  readonly kind: K;
};
export type EntityRefKind = EntityKind;

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
const templateTokenPattern = /^\{(?<kind>[a-z-]+)\}$/u;

export function parseEntityRef(value: string): ParsedEntityRef | null {
  const prefix = value.match(entityRefPrefixPattern),
    body = prefix?.groups?.body;
  if (!body) return null;
  const harnessAlias = prefix.groups?.alias;

  for (const contract of refAuthorities()) {
    const parse = new RegExp(`^${compileRefBodyPattern(contract, true)}$`, "u");
    const match = body.match(parse),
      id = match?.groups?.id;
    if (!id) continue;
    return {
      raw: value,
      kind: contract.kind,
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
  return [...body.matchAll(entityRefSearchPattern())]
    .map((match) => parseEntityRef(match[0]))
    .filter((ref): ref is ParsedEntityRef => ref !== null);
}

export function requireEntityKindRefAuthority(kind: string): EntityKindRefAuthority {
  const authority = refAuthorities().find((candidate) => candidate.kind === kind);
  if (!authority) throw new Error(`Entity kind ${kind} has no ref authority.`);
  return authority;
}

export function formatEntityRef(kind: string, id: string): EntityRef {
  const authority = requireEntityKindRefAuthority(kind);
  if (!new RegExp(authority.refPattern ?? authority.pattern, "u").test(id))
    throw new Error(`${id} is not a valid ${kind} ref identity.`);
  return authority.refTemplate.replace("{id}", id);
}

function compileRefBodyPattern(contract: EntityKindRefAuthority, capture: boolean): string {
  const segments = contract.refTemplate.split("/").map((segment) => {
    const token = segment.match(templateTokenPattern)?.groups?.kind;
    if (!token) return escapeRegExp(segment);
    const source: EntityKindRefAuthority | undefined =
      token === "id" ? contract : refAuthorities().find(({ kind }) => kind === token);
    if (!source) throw new Error(`Entity ref template ${contract.refTemplate} names unknown kind ${token}.`);
    const pattern = unanchored(source.refPattern ?? source.pattern);
    return capture ? `(?<${token}>${pattern})` : `(?:${pattern})`;
  });
  const anchorPattern = contract.anchorPattern ? unanchored(contract.anchorPattern) : "",
    anchor = contract.anchorPattern ? `(?:/${capture ? `(?<anchor>${anchorPattern})` : `(?:${anchorPattern})`})?` : "";
  return `${segments.join("/")}${anchor}`;
}

function refAuthorities(): readonly EntityKindRefAuthority[] {
  return entityTypeContracts.map(({ kind, id }) => Object.freeze({ kind, ...id }));
}

function entityRefSearchPattern(): RegExp {
  const bodies = refAuthorities().map((contract) => compileRefBodyPattern(contract, false));
  return new RegExp(String.raw`(?<![A-Za-z0-9_/-])(?:[A-Za-z][A-Za-z0-9_-]*:)?(?:${bodies.join("|")})\b(?!\/)`, "gu");
}

function unanchored(pattern: string): string {
  return pattern.replace(/^\^/u, "").replace(/\$$/u, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
