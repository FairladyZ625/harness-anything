import { ENTITY_ID_PATTERN, entityTypeContracts, type EntityIdentityContract, type EntityKind } from "./base-entity.ts";

export { ENTITY_ID_PATTERN };
export type EntityKindRefAuthority<K extends EntityKind = EntityKind> = EntityIdentityContract<K> & {
  readonly kind: K;
};
/** A built-in kind, or the type identity of a vertical Artifact kind compiled at load time. */
export type EntityRefKind = string;

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

/** The identity prefix a vertical declares for its Artifact kind (`vertical-definition/v1`). */
const artifactIdPrefixPattern = "[A-Z][A-Z0-9]{0,15}",
  artifactIdSuffixPattern = "-[a-f0-9]{32}";

/** The stable opaque identity every declared Artifact kind is addressed by. */
export const ENTITY_KIND_ID_PATTERN = "KND-[0-9a-f]{32}";
export const ENTITY_KIND_REF_PATTERN = `entity-kind/${ENTITY_KIND_ID_PATTERN}`;

const entityKindIdPattern = new RegExp(`^${ENTITY_KIND_ID_PATTERN}$`, "u");

export function entityKindRef(kindId: string): string {
  if (!entityKindIdPattern.test(kindId)) throw new Error(`${kindId} is not a valid entity kind identity.`);
  return `entity-kind/${kindId}`;
}

/** The id pattern an Artifact kind contract carries, so kind compilation and ref parsing share one grammar. */
export function artifactEntityIdPattern(idPrefix: string): string {
  return `^${idPrefix}${artifactIdSuffixPattern}$`;
}
/**
 * Vertical Artifact kinds are compiled from a vertical definition when the daemon loads it, so they
 * cannot be static rows in `entityTypeContracts`. Their ref body is fixed by the compiler: the kind's
 * stable opaque identity `entity-kind/KND-<128 bit>` names the kind, then the entity id. The
 * `entity-kind/` segment is what separates it from every built-in kind, none of which carries one.
 * The kind's schema version is deliberately absent: publishing a version or renaming the kind must
 * not move a single existing reference. Parsing stays syntactic: whether the kind is registered stays
 * the direction registry's answer, and whether the entity exists stays the projection's.
 */
function artifactRefBodyPattern(capture: boolean): string {
  const kind = ENTITY_KIND_REF_PATTERN,
    id = `${artifactIdPrefixPattern}${artifactIdSuffixPattern}`;
  return capture ? `(?<kind>${kind})/(?<id>${id})` : `(?:${kind})/(?:${id})`;
}
const artifactRefPattern = new RegExp(`^${artifactRefBodyPattern(true)}$`, "u");

/**
 * The built-in ref grammar, compiled once on first use: this module sits in an import cycle
 * (entity-ref → base-entity → write-chain.contract → receipt-domain-registry → entity-ref), so the
 * table may only be built once `entityTypeContracts` has actually initialized. Afterwards every
 * parse reuses one table instead of rebuilding a RegExp per authority per call.
 */
interface CompiledRefAuthority {
  readonly authority: EntityKindRefAuthority;
  readonly parse: RegExp;
  readonly identity: RegExp;
}
let compiledRefGrammar: {
  readonly byOrder: readonly CompiledRefAuthority[];
  readonly authorityByKind: ReadonlyMap<string, EntityKindRefAuthority>;
  readonly identityByKind: ReadonlyMap<string, RegExp>;
} | null = null;

function refGrammar() {
  if (compiledRefGrammar === null) {
    const authorities = entityTypeContracts.map(({ kind, id }) => Object.freeze({ kind, ...id }));
    const compiled = authorities.map((authority) => ({
      authority,
      parse: new RegExp(`^${compileRefBodyPattern(authority, true)}$`, "u"),
      identity: new RegExp(authority.refPattern ?? authority.pattern, "u"),
    }));
    compiledRefGrammar = {
      byOrder: compiled,
      authorityByKind: new Map(authorities.map((authority) => [authority.kind, authority])),
      identityByKind: new Map(compiled.map(({ authority, identity }) => [authority.kind, identity])),
    };
  }
  return compiledRefGrammar;
}

export function parseEntityRef(value: string): ParsedEntityRef | null {
  const prefix = value.match(entityRefPrefixPattern),
    body = prefix?.groups?.body;
  if (!body) return null;
  const harnessAlias = prefix.groups?.alias;

  for (const { authority, parse } of refGrammar().byOrder) {
    const match = body.match(parse),
      id = match?.groups?.id;
    if (!id) continue;
    return {
      raw: value,
      kind: authority.kind,
      id,
      ...(match.groups?.anchor ? { anchor: match.groups.anchor } : {}),
      ...(match.groups?.execution ? { ownerExecutionId: match.groups.execution } : {}),
      ...(harnessAlias ? { harnessAlias } : {}),
      externalHarness: Boolean(harnessAlias),
    };
  }
  const artifact = body.match(artifactRefPattern)?.groups;
  if (!artifact?.kind || !artifact.id) return null;
  return {
    raw: value,
    kind: artifact.kind,
    id: artifact.id,
    ...(harnessAlias ? { harnessAlias } : {}),
    externalHarness: Boolean(harnessAlias),
  };
}

export function requireEntityKindRefAuthority(kind: string): EntityKindRefAuthority {
  const authority = refGrammar().authorityByKind.get(kind);
  if (!authority) throw new Error(`Entity kind ${kind} has no ref authority.`);
  return authority;
}

export function formatEntityRef(kind: string, id: string): EntityRef {
  const identity = refGrammar().identityByKind.get(kind);
  if (!identity) throw new Error(`Entity kind ${kind} has no ref authority.`);
  if (!identity.test(id)) throw new Error(`${id} is not a valid ${kind} ref identity.`);
  return requireEntityKindRefAuthority(kind).refTemplate.replace("{id}", id);
}

function compileRefBodyPattern(contract: EntityKindRefAuthority, capture: boolean): string {
  const segments = contract.refTemplate.split("/").map((segment) => {
    const token = segment.match(templateTokenPattern)?.groups?.kind;
    if (!token) return escapeRegExp(segment);
    const source: EntityKindRefAuthority | undefined =
      token === "id" ? contract : refGrammar().authorityByKind.get(token);
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
