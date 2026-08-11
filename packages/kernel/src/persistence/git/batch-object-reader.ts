export interface GitObjectAtRef {
  readonly exists: boolean;
  readonly blobBytes?: Buffer;
}

export function readGitObjectsAtRef(
  repoRoot: string,
  ref: string,
  relativePaths: ReadonlyArray<string>,
  runBatch: (repoRoot: string, input: Uint8Array, ...args: ReadonlyArray<string>) => Uint8Array
): ReadonlyMap<string, GitObjectAtRef> {
  const uniquePaths = [...new Set(relativePaths)];
  if (uniquePaths.length === 0) return new Map();
  const input = Buffer.from(`${uniquePaths.map((relativePath) => `${ref}:${relativePath}`).join("\0")}\0`, "utf8");
  const output = Buffer.from(runBatch(repoRoot, input, "cat-file", "--batch", "-Z"));
  const objects = new Map<string, GitObjectAtRef>();
  let offset = 0;
  for (const relativePath of uniquePaths) {
    const headerEnd = output.indexOf(0, offset);
    if (headerEnd < 0) throw new Error("GIT_BATCH_OBJECT_HEADER_TRUNCATED");
    const header = output.subarray(offset, headerEnd).toString("utf8");
    offset = headerEnd + 1;
    if (header.endsWith(" missing")) {
      objects.set(relativePath, { exists: false });
      continue;
    }
    const match = /^([0-9a-f]{40,64}) ([a-z]+) ([0-9]+)$/u.exec(header);
    if (!match) throw new Error("GIT_BATCH_OBJECT_HEADER_INVALID");
    const objectType = match[2];
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size >= output.length) {
      throw new Error("GIT_BATCH_OBJECT_BODY_TRUNCATED");
    }
    const body = output.subarray(offset, offset + size);
    offset += size;
    if (output[offset] !== 0) throw new Error("GIT_BATCH_OBJECT_BODY_TERMINATOR_INVALID");
    offset += 1;
    objects.set(relativePath, {
      exists: true,
      ...(objectType === "blob" ? { blobBytes: Buffer.from(body) } : {})
    });
  }
  return objects;
}
