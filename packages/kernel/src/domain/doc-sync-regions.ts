import { sha256Text } from "../integrity/stable-hash.ts";
import { type PortableDocumentPath } from "../layout/portable-path.ts";
import { DOC_CODEC_ID, DOC_POLICY_ID, RegionProof } from "./doc-sync-types.ts";
import type {
  DocSyncDifference,
  DocSyncUnresolvedTouch,
} from "./receipt-domain-registry.ts";

export function touch(
  path: PortableDocumentPath,
  regionId: string | null,
  reason: string,
  requiredRoute: string,
): DocSyncUnresolvedTouch {
  return {
    path,
    regionId,
    anchor: regionId,
    reason,
    requiredRoute,
    policy: DOC_POLICY_ID,
  };
}

interface Region {
  readonly id: string;
  readonly mode: "additive" | "equal";
  readonly body: string;
  readonly offset: number;
}

export function additiveProof(
  path: PortableDocumentPath,
  base: string,
  candidate: string,
  mediaType: string,
  creating: boolean,
): {
  readonly proofs: readonly RegionProof[];
  readonly differences: readonly DocSyncDifference[];
  readonly unresolved: readonly DocSyncUnresolvedTouch[];
} {
  const left =
      base === ""
        ? { regions: [] as readonly Region[], error: null }
        : regions(base, mediaType),
    right = regions(candidate, mediaType);
  if (left.error || right.error)
    return {
      proofs: [],
      differences: [],
      unresolved: [
        touch(
          path,
          null,
          left.error ?? right.error ?? "ambiguous region",
          "refresh-region-policy",
        ),
      ],
    };
  const rightById = new Map(right.regions.map((region) => [region.id, region])),
    indexed = left.regions.map((region) => ({
      region,
      next: rightById.get(region.id),
      nextOrder: right.regions.findIndex(
        (candidateRegion) => candidateRegion.id === region.id,
      ),
    })),
    missing = indexed.filter(({ next }) => !next).map(({ region }) => region),
    reordered = new Map<string, Region>();
  let order = -1,
    orderedAfter: Region | null = null;
  for (const entry of indexed) {
    if (!entry.next) continue;
    if (entry.nextOrder < order) reordered.set(entry.region.id, orderedAfter!);
    else {
      order = entry.nextOrder;
      orderedAfter = entry.region;
    }
  }
  const missingReason =
      missing.length === 1
        ? `base region is missing: ${regionLabel(missing[0]!)}`
        : `base regions are missing: ${missing.map(regionLabel).join(", ")}`,
    reorderedReason = `base regions are reordered: ${[...reordered]
      .map(([regionId, after]) => {
        const region = left.regions.find(
          (candidateRegion) => candidateRegion.id === regionId,
        )!;
        return `candidate places ${regionLabel(region)} before ${regionLabel(after)}; expected ${regionLabel(after)} before ${regionLabel(region)}`;
      })
      .join("; ")}`,
    proofs: RegionProof[] = [],
    differences: DocSyncDifference[] = [],
    unresolved: DocSyncUnresolvedTouch[] = [];
  for (const { region, next } of indexed) {
    if (!next) {
      unresolved.push(
        touch(path, region.id, missingReason, "refresh-region-policy"),
      );
      continue;
    }
    if (reordered.has(region.id)) {
      unresolved.push(
        touch(path, region.id, reorderedReason, "refresh-region-policy"),
      );
      continue;
    }
    const result = compareRegion(path, region, next);
    proofs.push(result.proof);
    if (result.difference) differences.push(result.difference);
    if (!result.allowed)
      unresolved.push(
        touch(
          path,
          region.id,
          "machine region changed",
          machineWriterRoute(path),
        ),
      );
  }
  for (const region of right.regions)
    if (
      !left.regions.some((candidateRegion) => candidateRegion.id === region.id)
    ) {
      if (region.mode === "equal" && !creating)
        unresolved.push(
          touch(
            path,
            region.id,
            "new machine region is forbidden",
            machineWriterRoute(path),
          ),
        );
      else proofs.push(proof(region.id, "", region.body));
    }
  return { proofs, differences, unresolved };
}

function regionLabel(region: Region): string {
  return JSON.stringify(
    /^#{1,6} +.*$/mu.exec(region.body)?.[0]?.trim() ?? region.id,
  );
}

export function opaqueProof(): {
  readonly proofs: readonly RegionProof[];
  readonly differences: readonly DocSyncDifference[];
  readonly unresolved: readonly DocSyncUnresolvedTouch[];
} {
  return { proofs: [], differences: [], unresolved: [] };
}

function regions(
  body: string,
  mediaType: string,
): { readonly regions: readonly Region[]; readonly error: string | null } {
  if (mediaType === "text/plain")
    return {
      regions: [{ id: "prose/*", mode: "additive", body, offset: 0 }],
      error: null,
    };
  const result: Region[] = [];
  let prose = body,
    offset = 0;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end < 0) return { regions: [], error: "unterminated frontmatter" };
    const length = end + 5;
    result.push({
      id: "machine/frontmatter",
      mode: "equal",
      body: body.slice(0, length),
      offset: 0,
    });
    prose = body.slice(length);
    offset = length;
  }
  const matches = [...prose.matchAll(/^#{1,6} +(.+)$/gmu)];
  const ids = matches.map(
    (match) => `heading/${match[1]!.trim().toLowerCase()}`,
  );
  if (new Set(ids).size !== ids.length)
    return { regions: [], error: "duplicate heading anchor" };
  if (!matches.length)
    result.push({ id: "prose/*", mode: "additive", body: prose, offset });
  else {
    if ((matches[0]!.index ?? 0) > 0)
      result.push({
        id: "prose/*",
        mode: "additive",
        body: prose.slice(0, matches[0]!.index),
        offset,
      });
    matches.forEach((match, index) => {
      const start = match.index ?? 0,
        end = matches[index + 1]?.index ?? prose.length;
      result.push({
        id: ids[index]!,
        mode: "additive",
        body: prose.slice(start, end),
        offset: offset + start,
      });
    });
  }
  return { regions: result, error: null };
}

function compareRegion(
  path: PortableDocumentPath,
  base: Region,
  candidate: Region,
): {
  readonly allowed: boolean;
  readonly proof: RegionProof;
  readonly difference: DocSyncDifference | null;
} {
  const left = Buffer.from(base.body),
    right = Buffer.from(candidate.body),
    allowed = base.mode === "equal" ? left.equals(right) : true;
  if (left.equals(right))
    return {
      allowed,
      proof: proof(base.id, base.body, candidate.body),
      difference: null,
    };
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  )
    suffix += 1;
  const leftChanged = left.length - prefix - suffix,
    rightChanged = right.length - prefix - suffix,
    replaced = Math.min(leftChanged, rightChanged);
  return {
    allowed,
    proof: proof(base.id, base.body, candidate.body),
    difference: {
      path,
      regionId: base.id,
      insertBytes: rightChanged - replaced,
      deleteBytes: leftChanged - replaced,
      replaceBytes: replaced,
      firstChange: {
        baseOffset: base.offset + prefix,
        candidateOffset: candidate.offset + prefix,
      },
    },
  };
}

function proof(regionId: string, base: string, candidate: string): RegionProof {
  return {
    regionId,
    policyId: DOC_POLICY_ID,
    codecId: DOC_CODEC_ID,
    baseSha256: sha256Text(base),
    candidateSha256: sha256Text(candidate),
    insertBytes: Math.max(
      0,
      Buffer.byteLength(candidate) - Buffer.byteLength(base),
    ),
  };
}

export function decisionDocumentPath(value: PortableDocumentPath): boolean {
  return /^decisions\/decision-[^/]+\/decision\.md$/u.test(value);
}

function machineWriterRoute(value: PortableDocumentPath): string {
  return decisionDocumentPath(value)
    ? "ha decision --help"
    : "typed-machine-writer";
}
