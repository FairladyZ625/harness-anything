import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { sha256Text, taskPackagePath } from "../../../kernel/src/index.ts";

export function createProductionCanonicalSemanticState(authoredRoot: string) {
  return {
    readEntityBase: async () => null,
    readHostedDocument: async (portablePath: string) => {
      const snapshot = hostedSnapshot(authoredRoot, portablePath);
      return snapshot ? { body: snapshot.body, epoch: snapshot.cas.expectedEpoch, revision: snapshot.cas.expectedRevision, blobDigest: snapshot.cas.expectedBlobDigest } : null;
    }
  };
}

export function hostedSnapshot(authoredRoot: string, portablePath: string): {
  readonly body: string;
  readonly cas: { readonly expectedEpoch: string; readonly expectedRevision: bigint; readonly expectedBlobDigest: Uint8Array };
} | null {
  const taskDocument = /^tasks\/([^/]+)\/(.+)$/u.exec(portablePath);
  const rootDir = path.dirname(authoredRoot);
  const absolute = taskDocument
    ? path.join(taskPackagePath({ rootDir, layoutOverrides: { authoredRoot: path.relative(rootDir, authoredRoot) } }, taskDocument[1]!), taskDocument[2]!)
    : path.join(authoredRoot, portablePath);
  if (!existsSync(absolute)) return null;
  const body = readFileSync(absolute, "utf8");
  return { body, cas: { expectedEpoch: sha256Text(body), expectedRevision: 0n, expectedBlobDigest: Buffer.from(sha256Text(body), "hex") } };
}
