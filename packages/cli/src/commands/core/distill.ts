import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { FactWriteRejected } from "../../../../application/src/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/layout/index.ts";
import type { WriteError } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";

type DistillCandidateAction = Extract<ParsedCommand["action"], { readonly kind: "distill-candidate" }>;
type DistillCommitAction = Extract<ParsedCommand["action"], { readonly kind: "distill-commit" }>;

interface DistillCandidateArtifact {
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

export const runDistillCommand: CommandRunner = (context, command) => {
  if (command.action.kind === "distill-candidate") return Effect.succeed(runCandidate(context, command.action));
  return runCommit(context, command.action as DistillCommitAction);
};

function runCandidate(context: Parameters<CommandRunner>[0], action: DistillCandidateAction): CliResult {
  const layout = resolveHarnessLayout(context.layoutInput);
  const input = resolveRootRelativeFile(layout.rootDir, action.inputPath);
  if (!input.ok) {
    return distillFailure("distill-candidate", action.taskId, CliErrorCode.ArtifactReadFailed, input.reason);
  }
  const inputBytes = readFileSync(input.absolutePath);
  const candidateId = `distill_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const artifact: DistillCandidateArtifact = {
    schema: "distill-candidate/v1",
    candidateId,
    taskId: action.taskId,
    command: "ha distill candidate",
    factState: "candidate",
    inputPath: input.relativePath,
    inputSha256: createHash("sha256").update(inputBytes).digest("hex"),
    suggestedClaim: suggestedClaim(inputBytes.toString("utf8")),
    createdAt: new Date().toISOString()
  };
  const outputPath = path.join(layout.generatedRoot, "distill", action.taskId, `${candidateId}.json`);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const relativeOutputPath = toPortablePath(path.relative(layout.rootDir, outputPath));
  return {
    ok: true,
    command: "distill-candidate",
    taskId: action.taskId,
    path: relativeOutputPath,
    report: {
      schema: "distill-cli-report/v1",
      candidateId,
      candidatePath: relativeOutputPath,
      inputPath: artifact.inputPath,
      inputSha256: artifact.inputSha256,
      factState: artifact.factState,
      factWrite: false,
      suggestedClaim: artifact.suggestedClaim
    }
  };
}

function runCommit(context: Parameters<CommandRunner>[0], action: DistillCommitAction) {
  const layout = resolveHarnessLayout(context.layoutInput);
  const candidate = readCandidateArtifact(layout.rootDir, action);
  if (!candidate.ok) {
    return Effect.succeed(distillFailure("distill-commit", action.taskId, CliErrorCode.ArtifactReadFailed, candidate.reason));
  }
  return context.factWriteService.record({
    ownerTaskId: action.taskId,
    factId: action.factId,
    statement: action.claim,
    source: [
      "ha distill promote",
      `candidate=${candidate.relativePath}`,
      `input=${candidate.artifact.inputPath}`,
      `inputSha256=${candidate.artifact.inputSha256}`
    ].join("; "),
    observedAt: action.observedAt,
    confidence: action.confidence,
    memoryClass: action.memoryClass,
    memoryTags: action.memoryTags,
    opIdPrefix: "distill-fact"
  }).pipe(
    Effect.match({
      onFailure: (error): CliResult => distillFactFailure(action, error),
      onSuccess: (result): CliResult => ({
        ok: true,
        command: "distill-commit",
        taskId: result.taskId,
        factId: result.factId,
        factRef: result.ref,
        path: result.path,
        report: {
          schema: "distill-cli-report/v1",
          candidatePath: candidate.relativePath,
          inputPath: candidate.artifact.inputPath,
          inputSha256: candidate.artifact.inputSha256,
          factWrite: true,
          ref: result.ref
        }
      })
    })
  );
}

function readCandidateArtifact(rootDir: string, action: DistillCommitAction):
  | { readonly ok: true; readonly artifact: DistillCandidateArtifact; readonly relativePath: string }
  | { readonly ok: false; readonly reason: string } {
  const candidatePath = resolveRootRelativeFile(rootDir, action.candidatePath);
  if (!candidatePath.ok) return candidatePath;
  try {
    const artifact = JSON.parse(readFileSync(candidatePath.absolutePath, "utf8")) as Partial<DistillCandidateArtifact>;
    if (artifact.schema !== "distill-candidate/v1") return { ok: false, reason: "candidate artifact schema must be distill-candidate/v1" };
    if (artifact.factState !== "candidate") return { ok: false, reason: "candidate artifact must still be in candidate state" };
    if (artifact.taskId !== action.taskId) return { ok: false, reason: `candidate task ${artifact.taskId ?? "(missing)"} does not match ${action.taskId}` };
    if (!artifact.candidateId || !artifact.inputPath || !artifact.inputSha256) return { ok: false, reason: "candidate artifact is missing required input evidence" };
    return {
      ok: true,
      artifact: artifact as DistillCandidateArtifact,
      relativePath: candidatePath.relativePath
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "candidate artifact could not be read" };
  }
}

function resolveRootRelativeFile(rootDir: string, inputPath: string):
  | { readonly ok: true; readonly absolutePath: string; readonly relativePath: string }
  | { readonly ok: false; readonly reason: string } {
  const absolutePath = path.resolve(rootDir, inputPath);
  const relativePath = path.relative(rootDir, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return { ok: false, reason: `path must stay within the harness root: ${inputPath}` };
  }
  if (!existsSync(absolutePath)) return { ok: false, reason: `path does not exist: ${inputPath}` };
  if (!statSync(absolutePath).isFile()) return { ok: false, reason: `path must be a file: ${inputPath}` };
  return { ok: true, absolutePath, relativePath: toPortablePath(relativePath) };
}

function suggestedClaim(input: string): string {
  const line = input.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean) ?? "Distill candidate requires an explicit commit claim.";
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

function toPortablePath(input: string): string {
  return input.split(path.sep).join("/");
}

function distillFactFailure(action: DistillCommitAction, error: FactWriteRejected | WriteError): CliResult {
  const reason = "_tag" in error && error._tag === "FactWriteRejected" ? error.reason : JSON.stringify(error);
  return distillFailure("distill-commit", action.taskId, CliErrorCode.FactWriteRejected, reason);
}

function distillFailure(command: "distill-candidate" | "distill-commit", taskId: string, code: CliErrorCode, reason: string): CliResult {
  return {
    ok: false,
    command,
    taskId,
    error: cliError(code, reason)
  };
}
