import {
  ManagedSemanticDiffError,
  sha256Text,
  stablePayloadHash,
  type EntityId,
  type SemanticDiffCandidateTree,
  type SemanticDiffDocumentPolicy,
  type WriteOp,
  type WriteOpKind
} from "@harness-anything/kernel";
import { canonicalPayloadDigestV2 } from "./fact-relation-command-v2.ts";
import {
  bytesEqual,
  type AuthoritySemanticCompilerV2,
  type ContentValueV2,
  type SemanticMutationEnvelopeV2,
  type TransparentFileCandidateV2
} from "./semantic-mutation-envelope-v2.ts";
import {
  compileManagedCandidateTreeV2,
  managedSemanticDiffRegistrationsV2,
  semanticAdmissionV2,
  type ManagedSemanticDiffRegistrationV2
} from "./semantic-authority-helpers-v2.ts";

export interface TransparentDocumentSnapshotV2 {
  readonly body: string;
  readonly epoch: string;
  readonly revision: bigint;
  readonly blobDigest: Uint8Array;
}

export interface TransparentSemanticDiffCompilerV2Options {
  readonly operationKind: Extract<WriteOpKind, "doc_sync_submit" | "script_ingest">;
  readonly readDocument: (path: string) => Promise<TransparentDocumentSnapshotV2 | null>;
  readonly resolveDocumentPolicy: (input: {
    readonly path: string;
    readonly baseBody: string;
    readonly candidateBody: string;
    readonly candidateTree: SemanticDiffCandidateTree;
  }) => SemanticDiffDocumentPolicy | null;
  readonly loadContent?: (value: Extract<ContentValueV2, { readonly kind: "cas" }>) => Promise<Uint8Array>;
  readonly registrations?: ReadonlyArray<ManagedSemanticDiffRegistrationV2>;
  readonly reportSemanticDiffTiming?: (sample: {
    readonly durationNs: bigint;
    readonly fileCount: number;
    readonly decodedBytes: bigint;
  }) => void;
}

interface VerifiedTransparentFile {
  readonly wire: TransparentFileCandidateV2;
  readonly baseBody: string;
  readonly candidateBody: string;
}

export function makeTransparentSemanticDiffCompilerV2(
  options: TransparentSemanticDiffCompilerV2Options
): AuthoritySemanticCompilerV2 {
  const registrations = options.registrations ?? managedSemanticDiffRegistrationsV2;
  return {
    compile: async (envelope) => {
      if (envelope.intent.kind !== "transparent-file") throw semanticAdmissionV2("SEMANTIC_DIFF_REQUIRED");
      const files = await Promise.all(envelope.intent.files.map((file) => verifyTransparentFile(options, file)));
      const contextDocuments = await loadTaskIdentityContexts(options, files);
      const baseTree: SemanticDiffCandidateTree = {
        documents: [
          ...files.map((file) => ({ path: file.wire.path, body: file.baseBody })),
          ...contextDocuments.map((document) => ({ path: document.path, body: document.body }))
        ]
      };
      const candidateTree: SemanticDiffCandidateTree = {
        documents: [
          ...files.map((file) => ({ path: file.wire.path, body: file.candidateBody })),
          ...contextDocuments.map((document) => ({ path: document.path, body: document.body }))
        ]
      };
      const documentPolicies = files.map((file) => options.resolveDocumentPolicy({
        path: file.wire.path,
        baseBody: file.baseBody,
        candidateBody: file.candidateBody,
        candidateTree
      }));
      if (documentPolicies.some((policy) => policy === null)) throw semanticAdmissionV2("SEMANTIC_DIFF_REQUIRED");

      let mutationPlan;
      const semanticDiffStartedAt = process.hrtime.bigint();
      try {
        mutationPlan = compileManagedCandidateTreeV2(
          baseTree,
          candidateTree,
          documentPolicies as ReadonlyArray<SemanticDiffDocumentPolicy>,
          registrations
        );
      } catch (error) {
        throw normalizeSemanticDiffError(error);
      } finally {
        options.reportSemanticDiffTiming?.({
          durationNs: process.hrtime.bigint() - semanticDiffStartedAt,
          fileCount: files.length,
          decodedBytes: files.reduce((total, file) => total + BigInt(Buffer.byteLength(file.baseBody) + Buffer.byteLength(file.candidateBody)), 0n)
        });
      }
      if (envelope.intent.interpretation === "host-prose-only"
        && mutationPlan.mutations.some((intent) => intent.entityKind === "fact" || intent.entityKind === "relation")) {
        throw semanticAdmissionV2("SEMANTIC_DIFF_AMBIGUOUS", "host-prose-only cannot mask entity-bearing changes");
      }
      return {
        mutationPlan,
        operation: transparentOperation(envelope, options.operationKind, files),
        decodedBytes: files.reduce((total, file) => total + BigInt(Buffer.byteLength(file.baseBody) + Buffer.byteLength(file.candidateBody)), 0n)
      };
    }
  };
}

async function verifyTransparentFile(
  options: TransparentSemanticDiffCompilerV2Options,
  file: TransparentFileCandidateV2
): Promise<VerifiedTransparentFile> {
  const [baseBytes, candidateBytes] = await Promise.all([
    contentBytes(options, file.base.bytes),
    contentBytes(options, file.candidate.bytes)
  ]);
  assertContentDigest(baseBytes, file.base.bytes.size, file.base.blobDigest);
  assertContentDigest(candidateBytes, file.candidate.bytes.size, file.candidate.blobDigest);
  const snapshot = await options.readDocument(file.path);
  if (!snapshot || snapshot.epoch !== file.base.workspaceEpoch || snapshot.revision !== file.base.revision
    || !bytesEqual(snapshot.blobDigest, file.base.blobDigest) || !bytesEqual(Buffer.from(snapshot.body), baseBytes)) {
    throw semanticAdmissionV2("BASE_CAS_CONFLICT");
  }
  return {
    wire: file,
    baseBody: Buffer.from(baseBytes).toString("utf8"),
    candidateBody: Buffer.from(candidateBytes).toString("utf8")
  };
}

async function contentBytes(
  options: TransparentSemanticDiffCompilerV2Options,
  value: ContentValueV2
): Promise<Uint8Array> {
  if (value.kind === "inline") return value.bytes;
  if (!options.loadContent) throw semanticAdmissionV2("SEMANTIC_DIFF_REQUIRED", "authority CAS loader is unavailable");
  return options.loadContent(value);
}

function assertContentDigest(bytes: Uint8Array, declaredSize: bigint, declaredDigest: Uint8Array): void {
  if (BigInt(bytes.length) !== declaredSize || !bytesEqual(canonicalPayloadDigestV2(bytes), declaredDigest)) {
    throw semanticAdmissionV2("REQUEST_DIGEST_MISMATCH");
  }
}

async function loadTaskIdentityContexts(
  options: TransparentSemanticDiffCompilerV2Options,
  files: ReadonlyArray<VerifiedTransparentFile>
): Promise<ReadonlyArray<{ readonly path: string; readonly body: string }>> {
  const changedPaths = new Set(files.map((file) => file.wire.path));
  const indexPaths = [...new Set(files.flatMap((file) => {
    const match = /^(tasks\/[^/]+)\//u.exec(file.wire.path);
    return match?.[1] ? [`${match[1]}/INDEX.md`] : [];
  }))].filter((filePath) => !changedPaths.has(filePath)).sort(compareUtf8);
  const output = [];
  for (const indexPath of indexPaths) {
    const snapshot = await options.readDocument(indexPath);
    if (!snapshot) throw semanticAdmissionV2("SEMANTIC_DIFF_REQUIRED", `task identity context missing: ${indexPath}`);
    output.push({ path: indexPath, body: snapshot.body });
  }
  return output;
}

function transparentOperation(
  envelope: SemanticMutationEnvelopeV2,
  kind: Extract<WriteOpKind, "doc_sync_submit" | "script_ingest">,
  files: ReadonlyArray<VerifiedTransparentFile>
): WriteOp {
  const writes = files.map((file) => ({
    path: file.wire.path,
    body: file.candidateBody,
    baseBlobSha256: sha256Text(file.baseBody)
  }));
  const entityId = `entity/${kind === "doc_sync_submit" ? "doc-sync" : "script-run"}/${stablePayloadHash(writes).slice(0, 32)}` as EntityId;
  return {
    opId: "authority-overrides-this",
    entityId,
    kind,
    payload: { writes }
  };
}

function normalizeSemanticDiffError(error: unknown): Error {
  if (error instanceof ManagedSemanticDiffError) {
    return semanticAdmissionV2(error.code, error.message);
  }
  return error instanceof Error ? error : semanticAdmissionV2("SEMANTIC_DIFF_AMBIGUOUS");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}
