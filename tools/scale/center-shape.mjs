import { DatabaseSync } from "node:sqlite";
import { resolveHarnessLayout } from "../../packages/kernel/src/layout/index.ts";

// Count JSON string escaping without allocating another copy of a 286 MB document.
export function projectedBodyBytes(body) {
  let bytes = Buffer.byteLength(body);
  for (const match of body.matchAll(/["\\\u0000-\u001f]/gu)) bytes += /["\\\b\f\n\r\t]/u.test(match[0]) ? 1 : 5;
  return bytes;
}

export function projectedRowBytes(claim, workspaceRevision, bodyBytes) {
  return (
    Buffer.byteLength(
      JSON.stringify({
        path: claim.path,
        blobSha256: claim.sha256,
        body: "",
        size: claim.size,
        mediaType: claim.mediaType,
        policyId: claim.policyId,
        workspaceRevision,
      }),
    ) + bodyBytes
  );
}

// Deliberately supports only the two document-producing event forms emitted by this generator.
export function documentShapeTracker() {
  const contents = new Map(),
    rows = new Map();
  let total = 0;
  return {
    accept({ event, blobs }) {
      for (const blob of blobs) {
        const body = typeof blob.body === "string" ? blob.body : new TextDecoder().decode(blob.body);
        contents.set(blob.sha256, projectedBodyBytes(body));
      }
      const claims =
        event.payload.initialDocumentClaims ??
        (event.type === "documents_written"
          ? event.payload.changes.map((change) => ({
              path: change.path,
              ...change.candidate,
              policyId: change.policyId,
            }))
          : []);
      for (const claim of claims) {
        const bodyBytes = contents.get(claim.sha256);
        if (bodyBytes === undefined) throw new Error(`missing synthetic content: ${claim.sha256}`);
        const bytes = projectedRowBytes(claim, event.workspaceRevision, bodyBytes);
        total += bytes - (rows.get(claim.path) ?? 0);
        rows.set(claim.path, bytes);
      }
    },
    get bytes() {
      return total;
    },
  };
}

export function readProjectionShape(rootDir) {
  const db = new DatabaseSync(resolveHarnessLayout(rootDir).taskProjectionPath, { readOnly: true });
  try {
    const document = db
      .prepare(
        `SELECT COUNT(*) AS count,
      SUM(LENGTH(CAST(value_json AS BLOB))) AS jsonBytes,
      MAX(LENGTH(CAST(value_json AS BLOB))) AS largestJsonBytes FROM document`,
      )
      .get();
    const event = db
      .prepare(
        `SELECT COUNT(*) AS count,
      SUM(LENGTH(CAST(event_json AS BLOB))) AS jsonBytes,
      AVG(LENGTH(CAST(event_json AS BLOB))) AS averageJsonBytes FROM event_index`,
      )
      .get();
    return { document: { ...document }, event: { ...event }, includesFixtureSettings: true };
  } finally {
    db.close();
  }
}
