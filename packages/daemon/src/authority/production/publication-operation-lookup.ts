export function createUniquePublicationOperationLookup<Anchor, Evidence extends {
  readonly commitSha: string;
}>(input: {
  readonly anchors: (opId: string) => Promise<ReadonlyArray<Anchor>>;
  readonly inspect: (anchor: Anchor) => Promise<Evidence>;
  readonly notFound: (opId: string) => Error;
}): (opId: string) => Promise<Evidence> {
  return async (opId) => findUniquePublication(opId, await input.anchors(opId), input);
}

export async function findUniquePublication<Anchor, Evidence extends { readonly commitSha: string }>(
  opId: string,
  anchors: ReadonlyArray<Anchor>,
  input: {
    readonly inspect: (anchor: Anchor) => Promise<Evidence>;
    readonly notFound: (opId: string) => Error;
  }
): Promise<Evidence> {
  const matches = await Promise.all(anchors.map(input.inspect));
  if (matches.length === 0) throw input.notFound(opId);
  if (matches.length !== 1) {
    throw new Error(
      `AUTHORITY_CANONICAL_PUBLICATION_NOT_UNIQUE:expectedOpId=${opId};matches=${matches.map((entry) => entry.commitSha).join(",") || "none"}`
    );
  }
  return matches[0]!;
}
