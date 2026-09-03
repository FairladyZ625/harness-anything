import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  resolveHarnessLayout,
  type ArtifactDescriptor,
  type RelationType,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";

interface ProjectionCut {
  readonly watermark: number;
  readonly sourceRevision: number;
}
interface DistillSourceEdge {
  readonly relationId: string;
  readonly type: RelationType;
  readonly peerRef: string;
  readonly revision: number;
  readonly freshness: "current" | "suspect" | "orphaned";
}
type DistillSubject =
  | {
      readonly kind: "workspace-file";
      readonly ref: string;
      readonly contentSha256: string;
      readonly projectionCut: ProjectionCut;
    }
  | {
      readonly kind: "artifact-entity";
      readonly ref: string;
      readonly title: string;
      readonly locator: ArtifactDescriptor["locator"];
      readonly contentVersion: string;
      readonly source: string;
      readonly edges: readonly DistillSourceEdge[];
      readonly projectionCut: ProjectionCut;
    };

export interface DistillCandidateArtifactV1 {
  readonly schema: "distill-candidate/v1";
  readonly candidateId: string;
  readonly taskId: string;
  readonly command: "ha distill candidate";
  readonly factState: "candidate";
  readonly subject: DistillSubject;
  readonly suggestedClaim: string;
  readonly createdAt: string;
}
export interface DistillEntityRead {
  readonly descriptor: ArtifactDescriptor;
  readonly edges: readonly DistillSourceEdge[];
  readonly projectionCut: ProjectionCut;
}

export function artifactDescriptorFromProjection(value: Readonly<Record<string, unknown>>): ArtifactDescriptor {
  if (
    !exactFields(value, ["schema", "typeIdentity", "entityId", "title", "locator", "contentVersion", "source"]) ||
    ![value.schema, value.typeIdentity, value.entityId, value.title, value.contentVersion, value.source].every(
      nonEmptyString,
    ) ||
    !isLocator(value.locator)
  )
    throw distillActionError("invalid_command", "Distill entity must be a governed artifact descriptor.");
  return value as unknown as ArtifactDescriptor;
}

export function prepareDistillCandidate(input: {
  readonly rootDir: string;
  readonly action: Readonly<Record<string, unknown>>;
  readonly opId: string;
  readonly revision: number;
  readonly now: () => string;
  readonly readEntity: (entityRef: string) => DistillEntityRead;
}): {
  readonly outputPath: string;
  readonly relativePath: string;
  readonly body: string;
  readonly receipt: WriteReceipt;
} {
  const taskId = requiredDistillText(input.action.taskId, "taskId"),
    subject = distillSubject(input),
    candidateId = `distill_${createHash("sha256").update(input.opId).digest("hex").slice(0, 24)}`,
    artifact: DistillCandidateArtifactV1 = {
      schema: "distill-candidate/v1",
      candidateId,
      taskId,
      command: "ha distill candidate",
      factState: "candidate",
      subject,
      suggestedClaim:
        subject.kind === "artifact-entity"
          ? truncateClaim(subject.title)
          : suggestedClaimFromWorkspaceFile(input.rootDir, subject.ref),
      createdAt: input.now(),
    },
    layout = resolveHarnessLayout({ rootDir: input.rootDir }),
    output = path.join(layout.generatedRoot, "distill", taskId, `${candidateId}.json`),
    relative = portableDistillPath(path.relative(input.rootDir, output));
  return {
    outputPath: output,
    relativePath: relative,
    body: `${JSON.stringify(artifact, null, 2)}\n`,
    receipt: {
      outcome: "pending",
      opId: input.opId,
      revision: input.revision,
      evidence: JSON.stringify({
        schema: "distill-cli-report/v1",
        taskId,
        candidateId,
        candidatePath: relative,
        subject,
        factState: "candidate",
        factWrite: false,
        suggestedClaim: artifact.suggestedClaim,
      }),
      visibility: "center",
      proof: {
        committedRevision: input.revision,
        appliedCut: input.revision,
        durable: true,
        canonicalVisible: false,
        worktreeVisible: true,
      },
    },
  };
}

export function distillPromotionAction(
  rootDir: string,
  action: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> & { readonly kind: "fact-record" } {
  const taskId = requiredDistillText(action.taskId, "taskId"),
    candidate = workspaceFile(rootDir, requiredDistillText(action.candidatePath, "candidatePath"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(candidate.absolutePath, "utf8"));
  } catch {
    throw distillActionError("invalid_command", "Candidate must be a readable UTF-8 distill-candidate/v1 artifact.");
  }
  if (!isCandidate(parsed) || parsed.taskId !== taskId)
    throw distillActionError(
      "invalid_command",
      `Candidate must be distill-candidate/v1 in candidate state for task ${taskId}.`,
    );
  return {
    kind: "fact-record",
    taskId,
    statement: requiredDistillText(action.statement, "statement"),
    evidenceSource: [
      "ha distill promote",
      `candidate=${candidate.relativePath}`,
      `provenance=${JSON.stringify(parsed.subject)}`,
    ].join("; "),
    ...(typeof action.observedAt === "string" ? { observedAt: action.observedAt } : {}),
    confidence: action.confidence,
    memoryClass: action.memoryClass,
    memoryTags: action.memoryTags,
    ...(typeof action.factId === "string" ? { factId: action.factId } : {}),
  };
}

function distillSubject(input: {
  readonly rootDir: string;
  readonly action: Readonly<Record<string, unknown>>;
  readonly revision: number;
  readonly readEntity: (entityRef: string) => DistillEntityRead;
}): DistillSubject {
  if (typeof input.action.entityRef === "string") {
    const entityRef = requiredDistillText(input.action.entityRef, "entityRef"),
      resolved = input.readEntity(entityRef);
    return {
      kind: "artifact-entity",
      ref: entityRef,
      title: resolved.descriptor.title,
      locator: resolved.descriptor.locator,
      contentVersion: resolved.descriptor.contentVersion,
      source: resolved.descriptor.source,
      edges: resolved.edges,
      projectionCut: resolved.projectionCut,
    };
  }
  const source = workspaceFile(input.rootDir, requiredDistillText(input.action.inputPath, "inputPath")),
    bytes = readFileSync(source.absolutePath);
  return {
    kind: "workspace-file",
    ref: source.relativePath,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    projectionCut: { watermark: input.revision, sourceRevision: input.revision },
  };
}

function workspaceFile(
  rootDir: string,
  requested: string,
): { readonly absolutePath: string; readonly relativePath: string } {
  const root = realpathSync(rootDir),
    lexical = path.resolve(root, requested);
  if (lexical === root || !lexical.startsWith(`${root}${path.sep}`))
    throw distillActionError("invalid_command", `Path must stay inside the workspace: ${requested}`);
  let absolutePath: string;
  try {
    absolutePath = realpathSync(lexical);
  } catch {
    throw distillActionError("invalid_command", `Path does not exist: ${requested}`);
  }
  if (!absolutePath.startsWith(`${root}${path.sep}`) || !statSync(absolutePath).isFile())
    throw distillActionError("invalid_command", `Path must be a workspace file: ${requested}`);
  return { absolutePath, relativePath: portableDistillPath(path.relative(root, absolutePath)) };
}

function isCandidate(value: unknown): value is DistillCandidateArtifactV1 {
  if (!isRecord(value)) return false;
  return (
    exactFields(value, [
      "candidateId",
      "command",
      "createdAt",
      "factState",
      "schema",
      "subject",
      "suggestedClaim",
      "taskId",
    ]) &&
    value.schema === "distill-candidate/v1" &&
    value.command === "ha distill candidate" &&
    value.factState === "candidate" &&
    [value.candidateId, value.taskId, value.suggestedClaim, value.createdAt].every(nonEmptyString) &&
    isSubject(value.subject)
  );
}
function isSubject(value: unknown): value is DistillSubject {
  if (!isRecord(value)) return false;
  if (value.kind === "workspace-file")
    return (
      exactFields(value, ["kind", "ref", "contentSha256", "projectionCut"]) &&
      nonEmptyString(value.ref) &&
      typeof value.contentSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(value.contentSha256) &&
      isProjectionCut(value.projectionCut)
    );
  return (
    value.kind === "artifact-entity" &&
    exactFields(value, ["kind", "ref", "title", "locator", "contentVersion", "source", "edges", "projectionCut"]) &&
    [value.ref, value.title, value.contentVersion, value.source].every(nonEmptyString) &&
    isLocator(value.locator) &&
    Array.isArray(value.edges) &&
    value.edges.every(isEdge) &&
    isProjectionCut(value.projectionCut)
  );
}
function isEdge(value: unknown): value is DistillSourceEdge {
  if (!isRecord(value)) return false;
  return (
    exactFields(value, ["relationId", "type", "peerRef", "revision", "freshness"]) &&
    [value.relationId, value.type, value.peerRef, value.freshness].every(nonEmptyString) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0
  );
}
function isLocator(value: unknown): value is ArtifactDescriptor["locator"] {
  return (
    isRecord(value) &&
    exactFields(value, ["kind", "value"]) &&
    nonEmptyString(value.kind) &&
    nonEmptyString(value.value)
  );
}
function isProjectionCut(value: unknown): value is ProjectionCut {
  return (
    isRecord(value) &&
    exactFields(value, ["watermark", "sourceRevision"]) &&
    Number.isSafeInteger(value.watermark) &&
    Number(value.watermark) >= 0 &&
    Number.isSafeInteger(value.sourceRevision) &&
    Number(value.sourceRevision) >= 0
  );
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactFields(row: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return Object.keys(row).sort().join("\0") === [...fields].sort().join("\0");
}
function suggestedClaimFromWorkspaceFile(rootDir: string, relativePath: string): string {
  return truncateClaim(readFileSync(path.join(rootDir, relativePath), "utf8"));
}
function truncateClaim(input: string): string {
  const line =
    input
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find(Boolean) ?? "Distill candidate requires an explicit promotion claim.";
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function portableDistillPath(value: string): string {
  return value.split(path.sep).join("/");
}
function requiredDistillText(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw distillActionError("invalid_command", `${name} is required.`);
}
function distillActionError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
