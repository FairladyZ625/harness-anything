import { sha256Text } from "@harness-anything/kernel";

export async function historicalPublicationEvidence(input: {
  readonly opId: string;
  readonly publication: {
    readonly commitSha: string;
    readonly pipelineGeneratedPaths: ReadonlyArray<string>;
  };
  readonly readAtCommit: (commitSha: string, path: string) => Promise<Buffer>;
}): Promise<{ readonly commitSha: string; readonly semanticDigest: string }> {
  const eventPath = `attribution-events/${sha256Text(input.opId)}.jsonl`;
  if (!input.publication.pipelineGeneratedPaths.includes(eventPath)) {
    throw new Error(`AUTHORITY_HISTORICAL_PUBLICATION_EVENT_MISSING:${input.opId}`);
  }
  const eventBytes = await input.readAtCommit(input.publication.commitSha, eventPath);
  return {
    commitSha: input.publication.commitSha,
    semanticDigest: historicalPublicationSemanticDigest(eventBytes, input.opId)
  };
}

function historicalPublicationSemanticDigest(bytes: Buffer, opId: string): string {
  const lines = bytes.toString("utf8").trim().split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error(`AUTHORITY_HISTORICAL_PUBLICATION_EVENT_INVALID:${opId}`);
  const event = JSON.parse(lines[0]!) as unknown;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error(`AUTHORITY_HISTORICAL_PUBLICATION_EVENT_INVALID:${opId}`);
  }
  const record = event as Record<string, unknown>;
  const integrity = record.authorityIntegrity;
  if (record.schema !== "attribution-event/v1"
    || record.opId !== opId
    || !integrity
    || typeof integrity !== "object"
    || Array.isArray(integrity)) {
    throw new Error(`AUTHORITY_HISTORICAL_PUBLICATION_EVENT_INVALID:${opId}`);
  }
  const semanticDigest = (integrity as Record<string, unknown>).semanticRequestDigest;
  if (typeof semanticDigest !== "string" || !/^[a-f0-9]{64}$/u.test(semanticDigest)) {
    throw new Error(`AUTHORITY_HISTORICAL_PUBLICATION_SEMANTIC_DIGEST_INVALID:${opId}`);
  }
  return semanticDigest;
}
