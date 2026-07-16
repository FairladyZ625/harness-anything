import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

export interface DaemonArtifactIdentity {
  readonly artifactRoot: string;
  readonly identity: string;
  readonly fileCount: number;
  readonly elapsedMs: number;
}

const includedExtensions = new Set([".js", ".json", ".mjs", ".cjs"]);

export function calculateDaemonArtifactIdentity(entrypoint: string): DaemonArtifactIdentity {
  const started = process.hrtime.bigint();
  const artifactRoot = resolveDaemonArtifactRoot(entrypoint);
  const files = artifactFiles(artifactRoot);
  const digest = createHash("sha256");
  for (const relativePath of files) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    const content = readFileSync(path.join(artifactRoot, ...relativePath.split("/")));
    const framing = Buffer.allocUnsafe(12);
    framing.writeUInt32BE(pathBytes.length, 0);
    framing.writeBigUInt64BE(BigInt(content.length), 4);
    digest.update(framing.subarray(0, 4));
    digest.update(pathBytes);
    digest.update(framing.subarray(4));
    digest.update(content);
  }
  return {
    artifactRoot,
    identity: `sha256:${digest.digest("hex")}`,
    fileCount: files.length,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000
  };
}

export function resolveDaemonArtifactRoot(entrypoint: string): string {
  const resolvedEntrypoint = realpathSync(entrypoint);
  let current = path.dirname(resolvedEntrypoint);
  while (true) {
    if (path.basename(current) === "dist") return current;
    const parent = path.dirname(current);
    if (parent === current) return path.dirname(resolvedEntrypoint);
    current = parent;
  }
}

function artifactFiles(root: string): ReadonlyArray<string> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !includedExtensions.has(path.extname(entry.name))) continue;
      files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
    }
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  return files;
}
