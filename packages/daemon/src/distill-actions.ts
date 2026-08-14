import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, type WriteReceipt } from "../../kernel/src/index.ts";

export interface DistillCandidateArtifactV1 {
  readonly schema: "distill-candidate/v1";
  readonly candidateId: string;
  readonly taskId: string;
  readonly command: "ha distill candidate";
  readonly factState: "candidate";
  readonly inputPath: string;
  readonly inputSha256: string;
  readonly suggestedClaim: string;
  readonly createdAt: string;
}

export function prepareDistillCandidate(input: { readonly rootDir: string; readonly action: Readonly<Record<string, unknown>>; readonly opId: string; readonly revision: number; readonly now: () => string }): { readonly outputPath: string; readonly relativePath: string; readonly body: string; readonly receipt: WriteReceipt } {
  const taskId = required(input.action.taskId, "taskId"), source = workspaceFile(input.rootDir, required(input.action.inputPath, "inputPath")), bytes = readFileSync(source.absolutePath), candidateId = `distill_${createHash("sha256").update(input.opId).digest("hex").slice(0, 24)}`, artifact: DistillCandidateArtifactV1 = { schema: "distill-candidate/v1", candidateId, taskId, command: "ha distill candidate", factState: "candidate", inputPath: source.relativePath, inputSha256: createHash("sha256").update(bytes).digest("hex"), suggestedClaim: suggestedClaim(bytes.toString("utf8")), createdAt: input.now() }, layout = resolveHarnessLayout({ rootDir: input.rootDir }), output = path.join(layout.generatedRoot, "distill", taskId, `${candidateId}.json`), relative = portable(path.relative(input.rootDir, output)), body = `${JSON.stringify(artifact, null, 2)}\n`;
  return { outputPath: output, relativePath: relative, body, receipt: { outcome: "applied", opId: input.opId, revision: input.revision, evidence: JSON.stringify({ schema: "distill-cli-report/v1", taskId, candidateId, candidatePath: relative, inputPath: source.relativePath, inputSha256: artifact.inputSha256, factState: "candidate", factWrite: false, suggestedClaim: artifact.suggestedClaim }), visibility: "center", proof: { committedRevision: input.revision, appliedCut: input.revision, durable: true, canonicalVisible: true, worktreeVisible: true } } };
}

export function distillPromotionAction(rootDir: string, action: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> & { readonly kind: "fact-record" } {
  const taskId = required(action.taskId, "taskId"), candidate = workspaceFile(rootDir, required(action.candidatePath, "candidatePath")); let parsed: unknown; try { parsed = JSON.parse(readFileSync(candidate.absolutePath, "utf8")); } catch { throw coded("invalid_command", "Candidate must be a readable UTF-8 distill-candidate/v1 artifact."); } if (!isCandidate(parsed) || parsed.taskId !== taskId) throw coded("invalid_command", `Candidate must be distill-candidate/v1 in candidate state for task ${taskId}.`);
  return { kind: "fact-record", taskId, statement: required(action.statement, "statement"), evidenceSource: ["ha distill promote", `candidate=${candidate.relativePath}`, `input=${parsed.inputPath}`, `inputSha256=${parsed.inputSha256}`].join("; "), ...(typeof action.observedAt === "string" ? { observedAt: action.observedAt } : {}), confidence: action.confidence, memoryClass: action.memoryClass, memoryTags: action.memoryTags, ...(typeof action.factId === "string" ? { factId: action.factId } : {}) };
}

function workspaceFile(rootDir: string, requested: string): { readonly absolutePath: string; readonly relativePath: string } { const root = realpathSync(rootDir), lexical = path.resolve(root, requested); if (lexical === root || !lexical.startsWith(`${root}${path.sep}`)) throw coded("invalid_command", `Path must stay inside the workspace: ${requested}`); let absolutePath: string; try { absolutePath = realpathSync(lexical); } catch { throw coded("invalid_command", `Path does not exist: ${requested}`); } if (!absolutePath.startsWith(`${root}${path.sep}`) || !statSync(absolutePath).isFile()) throw coded("invalid_command", `Path must be a workspace file: ${requested}`); return { absolutePath, relativePath: portable(path.relative(root, absolutePath)) }; }
function isCandidate(value: unknown): value is DistillCandidateArtifactV1 { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const row = value as Readonly<Record<string, unknown>>; return Object.keys(row).sort().join("\0") === ["candidateId", "command", "createdAt", "factState", "inputPath", "inputSha256", "schema", "suggestedClaim", "taskId"].sort().join("\0") && row.schema === "distill-candidate/v1" && row.command === "ha distill candidate" && row.factState === "candidate" && [row.candidateId, row.taskId, row.inputPath, row.suggestedClaim, row.createdAt].every((field) => typeof field === "string" && field.length > 0) && typeof row.inputSha256 === "string" && /^[0-9a-f]{64}$/u.test(row.inputSha256); }
function suggestedClaim(input: string): string { const line = input.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean) ?? "Distill candidate requires an explicit promotion claim."; return line.length > 240 ? `${line.slice(0, 237)}...` : line; }
function portable(value: string): string { return value.split(path.sep).join("/"); }
function required(value: unknown, name: string): string { if (typeof value === "string" && value.trim()) return value; throw coded("invalid_command", `${name} is required.`); }
function coded(code: string, message: string): Error { const error = new Error(message) as Error & { code: string }; error.code = code; return error; }
