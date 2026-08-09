import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { CurrentSessionRef, HarnessLayoutInput } from "@harness-anything/kernel";
import { resolveHarnessLayout, sha256Text, taskPackagePath } from "@harness-anything/kernel";
import type { DocSyncSubmitRequestV1 } from "@harness-anything/application";
import type { JsonObject } from "@harness-anything/daemon";
import { CliErrorCode, cliError } from "../cli/error-codes.ts";
import type { CommandFailureReceipt, CommandReceipt } from "../cli/receipt.ts";
import { toCommandReceipt } from "../cli/receipt.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { readAuthoredGitText } from "../commands/core/authored-git.ts";

export class ArtifactIngestError extends Error {
  readonly code: "artifact_read_failed" | "artifact_write_rejected";

  constructor(code: ArtifactIngestError["code"], message: string) {
    super(message);
    this.name = "ArtifactIngestError";
    this.code = code;
  }
}

export interface ArtifactIngestPlan {
  readonly request: DocSyncSubmitRequestV1 | null;
  readonly taskId: string;
  readonly targetPaths: ReadonlyArray<string>;
  readonly submittedPaths: ReadonlyArray<string>;
  readonly reusedPaths: ReadonlyArray<string>;
  readonly skippedEvidence: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  readonly facade: "artifact-add" | "progress-append";
  readonly progressCommand?: ParsedCommand;
  readonly originalProgressCommand?: ParsedCommand;
}

export function buildArtifactIngestPlan(input: {
  readonly command: ParsedCommand;
  readonly repoId: string;
  readonly executor?: DocSyncSubmitRequestV1["executor"];
  readonly session?: CurrentSessionRef;
  readonly cwd?: string;
}): ArtifactIngestPlan | null {
  const action = input.command.action;
  const artifactFacade = action.kind === "artifact-add" ? action : undefined;
  const evidence = action.kind === "progress-append" && !action.dryRun ? action.evidence : undefined;
  if (!artifactFacade && (!evidence || evidence.length === 0)) return null;

  const rootInput: HarnessLayoutInput = {
    rootDir: input.command.rootDir,
    ...(input.command.layoutOverrides ? { layoutOverrides: input.command.layoutOverrides } : {})
  };
  const layout = resolveHarnessLayout(rootInput);
  const taskId = artifactFacade?.taskId ?? (action.kind === "progress-append" ? action.taskId : "");
  const taskRoot = taskPackagePath(rootInput, taskId);
  if (!existsSync(path.join(taskRoot, "INDEX.md"))) throw readFailure(`Task package not found for ${taskId}.`);
  const taskArtifactRoot = path.join(taskRoot, "artifacts");
  const sourceInputs = artifactFacade?.sourcePaths ?? evidence!.map((entry) => entry.path);
  const classified: ReturnType<typeof classifySource>[] = [];
  const skippedEvidence: Array<{ path: string; reason: string }> = [];
  for (const sourceInput of sourceInputs) {
    try {
      classified.push(classifySource({
        sourceInput,
        cwd: input.cwd ?? process.cwd(),
        rootDir: layout.rootDir,
        authoredRoot: layout.authoredRoot
      }));
    } catch (error) {
      if (!artifactFacade && error instanceof ArtifactIngestError) {
        skippedEvidence.push({ path: sourceInput, reason: error.message });
        continue;
      }
      throw error;
    }
  }
  const names = new Set<string>();
  const targetPaths: string[] = [];
  const submittedPaths: string[] = [];
  const reusedPaths: string[] = [];
  const changes: DocSyncSubmitRequestV1["payload"]["changes"][number][] = [];
  const rewrittenByInput = new Map<string, string>();
  for (const source of classified) {
    try {
      if (source.tracked && !isWithin(taskArtifactRoot, source.absolutePath)) {
        if (artifactFacade) {
          throw writeFailure(`Artifact add is for untracked evidence files; ${source.sourceInput} is already version-controlled. Keep it as a source pointer instead.`);
        }
        continue;
      }
      if (source.tracked) {
        const portable = portablePathRelative(layout.authoredRoot, source.absolutePath);
        rewrittenByInput.set(source.sourceInput, portable);
        targetPaths.push(portable);
        const publishedBody = gitBlob(layout.authoredRoot, portable);
        // Being under version control means the path was published once, not that the
        // current content was. Republish whenever the working tree diverges from HEAD;
        // a body of null is a non-UTF-8 artifact this text-only route cannot resubmit.
        if (source.body === null || publishedBody === source.body) {
          reusedPaths.push(portable);
          continue;
        }
        changes.push(docSyncChange(portable, source.body, publishedBody === null ? null : sha256Text(publishedBody)));
        submittedPaths.push(portable);
        continue;
      }
      const name = path.basename(source.absolutePath);
      if (names.has(name)) throw writeFailure(`Artifact destination collision: more than one input is named ${name}. Rename one input and retry.`);
      names.add(name);
      const targetPath = `${portablePathRelative(layout.authoredRoot, taskRoot)}/artifacts/${name}`;
      const targetAbsolute = path.join(layout.authoredRoot, targetPath);
      const headBody = gitBlob(layout.authoredRoot, targetPath);
      if (headBody !== null) {
        if (headBody !== source.body) throw writeFailure(`Artifact destination already exists with different content: ${targetPath}. Rename the source and retry.`);
        reusedPaths.push(targetPath);
      } else {
        if (existsSync(targetAbsolute) && path.resolve(targetAbsolute) !== path.resolve(source.absolutePath)
          && readUtf8(targetAbsolute, targetPath) !== source.body) {
          throw writeFailure(`Artifact destination already exists with different unsubmitted content: ${targetPath}. Resolve that file first.`);
        }
        changes.push(docSyncChange(targetPath, source.body));
        submittedPaths.push(targetPath);
      }
      targetPaths.push(targetPath);
      rewrittenByInput.set(source.sourceInput, targetPath);
    } catch (error) {
      if (!artifactFacade && error instanceof ArtifactIngestError) {
        skippedEvidence.push({ path: source.sourceInput, reason: error.message });
        continue;
      }
      throw error;
    }
  }

  if (action.kind === "progress-append" && changes.length === 0 && rewrittenByInput.size === 0 && skippedEvidence.length === 0) return null;
  const rewrittenEvidence = evidence?.map((entry) => ({ ...entry, path: rewrittenByInput.get(entry.path) ?? entry.path }));
  const request = changes.length === 0 ? null : artifactRequest({
    repoId: input.repoId,
    baseLedgerSha: gitRequired(layout.authoredRoot, ["rev-parse", "HEAD"], "Doc sync requires an initialized authored Git repository."),
    changes,
    executor: input.executor,
    session: input.session
  });
  return {
    request,
    taskId,
    targetPaths,
    submittedPaths,
    reusedPaths,
    skippedEvidence,
    facade: action.kind === "progress-append" ? "progress-append" : "artifact-add",
    ...(action.kind === "progress-append" ? {
      progressCommand: { ...input.command, action: { ...action, evidence: rewrittenEvidence } },
      originalProgressCommand: input.command
    } : {})
  };
}

export function progressRetryCommand(plan: ArtifactIngestPlan): string | undefined {
  const action = plan.originalProgressCommand?.action ?? plan.progressCommand?.action;
  if (!action || action.kind !== "progress-append") return undefined;
  const parts = ["ha", "task", "progress", "append", quoteShellArgument(action.taskId), "--text", quoteShellArgument(action.text)];
  for (const entry of action.evidence ?? []) {
    parts.push("--evidence", quoteShellArgument(`${entry.type}:${entry.path}:${entry.summary}`));
  }
  return parts.join(" ");
}

export function artifactIngestPreviewRejected(command: ParsedCommand, error: unknown): CommandFailureReceipt {
  const code = error instanceof ArtifactIngestError && error.code === "artifact_read_failed"
    ? CliErrorCode.ArtifactReadFailed
    : CliErrorCode.ArtifactWriteRejected;
  const receipt = toCommandReceipt({
    ok: false,
    command: command.action.kind === "progress-append" ? "progress-append" : "artifact-add",
    error: cliError(code, error instanceof Error ? error.message : String(error))
  });
  if (receipt.ok) throw new Error("artifact ingest preview rejection unexpectedly succeeded");
  return receipt;
}

export function normalizeArtifactSubmitFailure(response: JsonObject, plan: ArtifactIngestPlan): CommandFailureReceipt {
  const receipt = response as unknown as CommandFailureReceipt;
  const originalError = receipt.error ?? cliError(CliErrorCode.ArtifactWriteRejected, "Artifact doc-sync submit failed.");
  return {
    ...receipt,
    command: plan.facade,
    action: plan.facade,
    error: {
      ...originalError,
      hint: `Artifact ingestion failed before the evidence pointer was written. progress.md was not changed. ${originalError.hint}`.trim()
    },
    details: {
      ...(receipt.details ?? {}),
      data: {
        ...((receipt.details?.data ?? {}) as Record<string, unknown>),
        pointerRecorded: false,
        artifactsCommitted: []
      }
    }
  };
}

export function artifactAddSuccess(plan: ArtifactIngestPlan, docSync: unknown): CommandReceipt {
  const receipt = toCommandReceipt({
    ok: true,
    command: "artifact-add",
    taskId: plan.taskId,
    path: plan.targetPaths[0],
    report: {
      schema: "task-artifact-add/v1",
      artifacts: plan.targetPaths,
      submitted: plan.submittedPaths,
      reused: plan.reusedPaths,
      skipped: plan.skippedEvidence,
      docSync
    }
  });
  if (!receipt.ok) throw new Error(receipt.error?.hint ?? "artifact add receipt failed");
  return receipt;
}

export function normalizeProgressAfterArtifact(
  receipt: CommandReceipt | CommandFailureReceipt,
  plan: ArtifactIngestPlan,
  docSync: unknown
): CommandReceipt | CommandFailureReceipt {
  const artifactData = {
    schema: "progress-artifact-ingest/v1",
    artifacts: plan.targetPaths,
    submitted: plan.submittedPaths,
    reused: plan.reusedPaths,
    skipped: plan.skippedEvidence,
    docSync
  };
  const warnings = artifactSkipWarnings(plan);
  if (receipt.ok) {
    return {
      ...receipt,
      ...(warnings.length > 0 ? { warnings: [...(receipt.warnings ?? []), ...warnings] } : {}),
      details: {
        ...(receipt.details ?? {}),
        data: { ...((receipt.details?.data ?? {}) as Record<string, unknown>), artifactIngest: artifactData }
      }
    };
  }
  if (plan.targetPaths.length === 0) {
    return {
      ...receipt,
      ...(warnings.length > 0 ? { warnings: [...(receipt.warnings ?? []), ...warnings] } : {}),
      details: {
        ...(receipt.details ?? {}),
        data: { ...((receipt.details?.data ?? {}) as Record<string, unknown>), artifactIngest: artifactData }
      }
    };
  }
  const paths = plan.targetPaths.join(", ");
  const originalError = receipt.error ?? cliError(CliErrorCode.ArtifactWriteRejected, "Progress append failed.");
  if (originalError.code === "repo_write_outcome_unknown"
    || originalError.code === CliErrorCode.DaemonRequestOutcomeUnknown) {
    return {
      ...receipt,
      ...(warnings.length > 0 ? { warnings: [...(receipt.warnings ?? []), ...warnings] } : {}),
      command: "progress-append",
      action: "progress-append",
      error: {
        ...originalError,
        hint: `Artifact ingestion succeeded at ${paths}. The progress append outcome is unknown; first check progress.md for the evidence pointer before deciding whether to rerun. Only rerun or record the pointer if it is absent. Cause: ${originalError.hint}`
      },
      details: {
        ...(receipt.details ?? {}),
        data: {
          ...((receipt.details?.data ?? {}) as Record<string, unknown>),
          artifactIngest: artifactData,
          pointerRecorded: "unknown",
          outcome: "unknown"
        }
      }
    };
  }
  const retryCommand = progressRetryCommand(plan);
  return {
    ...receipt,
    ...(warnings.length > 0 ? { warnings: [...(receipt.warnings ?? []), ...warnings] } : {}),
    command: "progress-append",
    action: "progress-append",
    error: {
      ...originalError,
      hint: `Artifact ingestion succeeded at ${paths}, but the evidence pointer was not written to progress.md. The committed artifact was kept. ${retryCommand ? `Retry or record the pointer with: ${retryCommand}.` : "Retry the progress append."} Cause: ${originalError.hint}`
    },
    details: {
      ...(receipt.details ?? {}),
      data: {
        ...((receipt.details?.data ?? {}) as Record<string, unknown>),
        artifactIngest: artifactData,
        pointerRecorded: false,
        retryCommand
      }
    }
  };
}

export function remoteArtifactSafetyReceipt(command: ParsedCommand, repoId: string): CommandFailureReceipt | undefined {
  if (command.action.kind !== "artifact-add"
    && !(command.action.kind === "progress-append" && !command.action.dryRun && (command.action.evidence?.length ?? 0) > 0)) return undefined;
  if (command.action.kind === "progress-append") {
    try {
      const plan = buildArtifactIngestPlan({ command, repoId });
      if (plan === null) return undefined;
      if (plan.request === null) return undefined;
    } catch (error) {
      if (error instanceof ArtifactIngestError && /does not exist/u.test(error.message)) return undefined;
      return artifactIngestPreviewRejected(command, error);
    }
  }
  const receipt = toCommandReceipt({
    ok: false,
    command: command.action.kind === "progress-append" ? "progress-append" : "artifact-add",
    error: cliError(
      CliErrorCode.ArtifactReadFailed,
      "This evidence names a local untracked UTF-8 artifact, so ingestion currently requires local daemon mode. No artifact or progress pointer was written. Run the same command from the canonical checkout with local daemon mode; version-controlled source pointers continue to work in remote mode."
    )
  });
  if (receipt.ok) throw new Error("remote artifact ingest rejection unexpectedly succeeded");
  return receipt;
}

type ClassifiedArtifactSource =
  | { readonly sourceInput: string; readonly absolutePath: string; readonly tracked: true; readonly body: string | null }
  | { readonly sourceInput: string; readonly absolutePath: string; readonly tracked: false; readonly body: string };

function classifySource(input: { readonly sourceInput: string; readonly cwd: string; readonly rootDir: string; readonly authoredRoot: string }): ClassifiedArtifactSource {
  const absolutePath = resolveSource(input.sourceInput, input.cwd, input.rootDir, input.authoredRoot);
  if (!existsSync(absolutePath)) throw readFailure(`Evidence file does not exist: ${input.sourceInput}.`);
  let sourceStat: ReturnType<typeof statSync>;
  try { sourceStat = statSync(absolutePath); }
  catch (error) { throw readFailure(`Evidence file could not be inspected: ${input.sourceInput}. Cause: ${error instanceof Error ? error.message : String(error)}`); }
  if (!sourceStat.isFile()) throw readFailure(`Evidence path must name a regular file: ${input.sourceInput}.`);
  if (!isHarnessInternal(absolutePath, input.rootDir)) {
    throw readFailure(`Evidence artifact is outside this harness repository: ${input.sourceInput}. Move it into the repository or task package before retrying.`);
  }
  return isGitTracked(absolutePath)
    ? { sourceInput: input.sourceInput, absolutePath, tracked: true, body: optionalUtf8(absolutePath) }
    : { sourceInput: input.sourceInput, absolutePath, tracked: false, body: readUtf8(absolutePath, input.sourceInput) };
}

function optionalUtf8(absolutePath: string): string | null {
  try { return readUtf8(absolutePath, absolutePath); }
  catch { return null; }
}

function readUtf8(absolutePath: string, displayPath: string): string {
  let bytes: Buffer;
  try { bytes = readFileSync(absolutePath); }
  catch (error) { throw readFailure(`Evidence file could not be read: ${displayPath}. Cause: ${error instanceof Error ? error.message : String(error)}`); }
  let body: string;
  try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw readFailure(`Unsupported binary artifact: ${displayPath}. This convenience route accepts UTF-8 text only; keep the file outside this flow until a binary/CAS route is available.`); }
  if (body.includes("\0")) throw readFailure(`Unsupported binary artifact: ${displayPath}. This convenience route accepts UTF-8 text only; NUL bytes are not allowed.`);
  return body;
}

function artifactRequest(input: {
  readonly repoId: string;
  readonly baseLedgerSha: string;
  readonly changes: DocSyncSubmitRequestV1["payload"]["changes"];
  readonly executor?: DocSyncSubmitRequestV1["executor"];
  readonly session?: CurrentSessionRef;
}): DocSyncSubmitRequestV1 {
  const intentMaterial = JSON.stringify({
    baseLedgerSha: input.baseLedgerSha,
    changes: input.changes.map(({ path: changePath, baseBlobSha256, newBlobSha256 }) => ({ path: changePath, baseBlobSha256, newBlobSha256 }))
  });
  return {
    repo: { repoId: input.repoId },
    ...(input.executor !== undefined ? { executor: input.executor } : {}),
    ...(input.session ? { session: input.session } : {}),
    payload: {
      baseLedgerSha: input.baseLedgerSha,
      intentId: `intent_${sha256Text(intentMaterial).slice(0, 24)}`,
      declaredIntent: "manual-artifact",
      changes: input.changes
    }
  };
}

function docSyncChange(
  portablePath: string,
  body: string,
  baseBlobSha256: string | null = null
): DocSyncSubmitRequestV1["payload"]["changes"][number] {
  return {
    path: portablePath,
    baseBlobSha256,
    newBlobSha256: sha256Text(body),
    mediaType: mediaTypeFor(portablePath),
    size: Buffer.byteLength(body),
    declaredBearing: "task-document",
    declaredZoneClass: "task-authored-prose-or-stage",
    declaredPathClass: "doc-sync-allowed",
    content: { kind: "inline", body }
  };
}

function resolveSource(sourceInput: string, cwd: string, rootDir: string, authoredRoot: string): string {
  if (path.isAbsolute(sourceInput)) return path.normalize(sourceInput);
  const candidates = [path.resolve(cwd, sourceInput), path.resolve(rootDir, sourceInput), path.resolve(authoredRoot, sourceInput)];
  return candidates.find(existsSync) ?? candidates[0]!;
}

function isHarnessInternal(absolutePath: string, rootDir: string): boolean {
  if (isWithin(rootDir, absolutePath)) return true;
  const rootCommon = gitOptional(rootDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const sourceCommon = gitOptional(path.dirname(absolutePath), ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return rootCommon !== null && sourceCommon !== null && safeRealpath(rootCommon) === safeRealpath(sourceCommon);
}

function isGitTracked(absolutePath: string): boolean {
  const discoveredTop = gitOptional(path.dirname(absolutePath), ["rev-parse", "--show-toplevel"]);
  if (!discoveredTop) return false;
  const top = safeRealpath(discoveredTop);
  const relativePath = portableGitPathRelative(top, safeRealpath(absolutePath));
  if (relativePath === null || relativePath === "") return false;
  return gitOptional(top, ["ls-files", "--error-unmatch", "--", relativePath]) !== null;
}

function gitBlob(authoredRoot: string, portablePath: string): string | null {
  return gitOptional(authoredRoot, ["show", `HEAD:${portablePath}`], false);
}

function gitRequired(cwd: string, args: ReadonlyArray<string>, message: string): string {
  const value = gitOptional(cwd, args);
  if (value === null) throw writeFailure(message);
  return value;
}

function gitOptional(cwd: string, args: ReadonlyArray<string>, trim = true): string | null {
  try {
    return readAuthoredGitText(cwd, args, trim);
  } catch { return null; }
}

function mediaTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".md") return "text/markdown";
  if (extension === ".json") return "application/json";
  if (extension === ".html") return "text/html";
  return "text/plain";
}

function portablePathRelative(from: string, to: string): string { return path.relative(safeRealpath(from), safeRealpath(to)).split(path.sep).join("/"); }
export function portableGitPathRelative(repositoryRoot: string, candidatePath: string): string | null {
  const pathApi = isWindowsPathShape(repositoryRoot) || isWindowsPathShape(candidatePath) ? path.win32 : path.posix;
  const relative = pathApi.relative(pathApi.normalize(repositoryRoot), pathApi.normalize(candidatePath));
  if (relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) return null;
  return relative.split(pathApi.sep).join("/");
}
function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(safeRealpath(parent), safeRealpath(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function isWindowsPathShape(value: string): boolean { return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\"); }
function safeRealpath(value: string): string { try { return realpathSync.native(value); } catch { return path.resolve(value); } }
function quoteShellArgument(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }
function artifactSkipWarnings(plan: ArtifactIngestPlan) {
  return plan.skippedEvidence.map((entry) => ({
    code: "artifact_ingest_skipped",
    message: `Evidence pointer ${entry.path} was recorded without artifact ingestion: ${entry.reason} Use 'ha task artifact add ${plan.taskId} <path>' to request strict ingestion explicitly.`
  }));
}
function readFailure(message: string): ArtifactIngestError { return new ArtifactIngestError("artifact_read_failed", message); }
function writeFailure(message: string): ArtifactIngestError { return new ArtifactIngestError("artifact_write_rejected", message); }
