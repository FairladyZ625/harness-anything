import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import {
  privateTextScannerVersion,
  readFrontmatter,
  readSessionEntityDocument,
  readScalar,
  removeContentAddressedBlob,
  resolveHarnessLayout,
  scanPrivateText,
  writeContentAddressedBlobWithDisposition,
  type ContentAddressedBlobWriteResult,
  type FlushReport,
  type SessionManifest,
  type WriteError
} from "@harness-anything/kernel";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { authoredRelativePath } from "./authored-git.ts";
import { scanLegacyHolders, scanRuntimeExecutionCandidates } from "./session-cutover-candidates.ts";

type SyncAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "session-sync" }>;

export function runSessionSync(
  context: Parameters<CommandRunner>[0],
  action: SyncAction,
  writeManifests: (manifests: ReadonlyArray<SessionManifest>) => Effect.Effect<FlushReport, WriteError>
) {
  return Effect.gen(function* () {
    const paths = listCutoverSessionPaths(context.layoutInput);
    const runtimeScan = scanRuntimeExecutionCandidates(context.layoutInput);
    const holderBackfill = scanLegacyHolders(context.layoutInput);
    const documents = paths.map((entry) => {
      const body = readFileSync(path.join(resolveHarnessLayout(context.layoutInput).authoredRoot, entry), "utf8");
      return { entry, body, kind: sessionDocumentKind(body) };
    });
    const legacy = documents.filter((entry) => entry.kind === "legacy");
    const manifests = documents.filter((entry) => entry.kind === "manifest");
    const displayPaths = legacy.map((entry) => cutoverDisplayPath(context.layoutInput, entry.entry));
    const prepared = action.mode === "apply"
      ? legacy.map((entry) => prepareLegacySessionManifest(context.layoutInput, entry.body))
      : [];
    const flush = prepared.length > 0
      ? yield* writeManifests(prepared.map((entry) => entry.manifest)).pipe(
          Effect.tapError(() => Effect.sync(() => cleanupRejectedCutoverBodies(context.layoutInput, prepared)))
        )
      : undefined;
    return {
      ok: true,
      command: "session-sync",
      rows: legacy.length,
      path: displayPaths[0],
      report: {
        schema: "session-cutover-report/v1",
        mode: action.mode,
        sessionsRoot: "sessions",
        paths: displayPaths,
        sessions: {
          scanned: paths.length,
          needsBackfill: legacy.length,
          alreadyPresent: manifests.length,
          ignored: paths.length - legacy.length - manifests.length,
          applied: action.mode === "apply" ? legacy.length : 0
        },
        executionCandidates: runtimeScan.candidates,
        holderBackfill,
        warnings: runtimeScan.warnings,
        git: cutoverGitReport(action.mode === "apply" && legacy.length > 0, legacy.map((entry) => entry.entry), flush)
      }
    } satisfies CliResult;
  });
}

function prepareLegacySessionManifest(
  rootInput: Parameters<CommandRunner>[0]["layoutInput"],
  body: string
): { readonly manifest: SessionManifest; readonly bodyWrite: ContentAddressedBlobWriteResult } {
  const frontmatter = readFrontmatter(body);
  if (!frontmatter || readScalar(frontmatter, "schema", { required: true }) !== "provenance-session/v1") {
    throw new Error("session cutover only accepts provenance-session/v1 markdown");
  }
  const sessionId = readScalar(frontmatter, "sessionId", { required: true });
  const runtime = readScalar(frontmatter, "runtime", { required: true });
  if (!isSessionRuntime(runtime)) throw new Error(`unsupported session runtime: ${runtime}`);
  const source = readScalar(frontmatter, "source", { required: true });
  if (source !== "runtime" && source !== "manual") throw new Error(`unsupported session source: ${source}`);
  const exportedAt = readScalar(frontmatter, "exportedAt", { required: true });
  const findings = scanPrivateText(body, "snapshot.body");
  const user = readScalar(frontmatter, "user");
  const bodyWrite = writeContentAddressedBlobWithDisposition(rootInput, body, "text/markdown; charset=utf-8");
  return {
    bodyWrite,
    manifest: {
      schema: "session-entity/v1",
      sessionId,
      lifecycle: "sealed",
      archiveStatus: "complete",
      runtime,
      source,
      detectedAt: readScalar(frontmatter, "detectedAt", { required: true }),
      exportedAt,
      ...(user ? { user } : {}),
      bodyRef: {
        store: "authored-cas/v1",
        ref: bodyWrite.ref,
        sha256: bodyWrite.sha256,
        size: bodyWrite.size,
        mediaType: bodyWrite.mediaType
      },
      snapshot: {
        capturedAt: exportedAt,
        completeness: "complete",
        captureRange: { messageCount: [...body.matchAll(/^### (?:User|Assistant|Summary)(?: \(|$)/gmu)].length },
        privacyScan: {
          scannerVersion: privateTextScannerVersion,
          passed: findings.every((finding) => finding.severity !== "error"),
          findings
        }
      }
    }
  };
}

function cleanupRejectedCutoverBodies(
  rootInput: Parameters<CommandRunner>[0]["layoutInput"],
  prepared: ReadonlyArray<{ readonly manifest: SessionManifest; readonly bodyWrite: ContentAddressedBlobWriteResult }>
): void {
  for (const entry of prepared) {
    if (!entry.bodyWrite.created) continue;
    try {
      const existing = readSessionEntityDocument(rootInput, entry.manifest.sessionId);
      if (existing.manifest.bodyRef.ref === entry.bodyWrite.ref) continue;
    } catch {
      // The source is a known legacy document, so a decode failure is not a
      // committed Session Entity reference to the newly prepared body.
    }
    try {
      removeContentAddressedBlob(rootInput, entry.bodyWrite);
    } catch {
      // Preserve the coordinator rejection; `ha cas gc` can inspect leftovers.
    }
  }
}

function isSessionRuntime(value: string): value is SessionManifest["runtime"] {
  return value === "human" || value === "claude-code" || value === "codex" || value === "zcode" || value === "antigravity";
}

function sessionDocumentKind(body: string): "legacy" | "manifest" | "ignored" {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("---")) {
    const frontmatter = readFrontmatter(body);
    return frontmatter && readScalar(frontmatter, "schema") === "provenance-session/v1" ? "legacy" : "ignored";
  }
  if (!trimmed.startsWith("{")) return "ignored";
  try {
    return (JSON.parse(trimmed) as { readonly schema?: unknown }).schema === "session-entity/v1" ? "manifest" : "ignored";
  } catch {
    return "ignored";
  }
}

function listCutoverSessionPaths(rootInput: Parameters<CommandRunner>[0]["layoutInput"]): ReadonlyArray<string> {
  const paths: string[] = [];
  collectMarkdown(resolveHarnessLayout(rootInput).sessionsRoot, paths);
  return paths.map((absolutePath) => authoredRelativePath(rootInput, absolutePath)).sort((left, right) => left.localeCompare(right, "en-US"));
}

function collectMarkdown(dir: string, paths: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) collectMarkdown(absolutePath, paths);
    else if (entry.endsWith(".md")) paths.push(absolutePath);
  }
}

function cutoverDisplayPath(rootInput: Parameters<CommandRunner>[0]["layoutInput"], authoredRelative: string): string {
  const layout = resolveHarnessLayout(rootInput);
  return path.relative(layout.rootDir, path.join(layout.authoredRoot, authoredRelative)).split(path.sep).join("/");
}

function cutoverGitReport(attempted: boolean, paths: ReadonlyArray<string>, flush?: FlushReport) {
  return {
    attempted,
    committed: flush?.committed ?? false,
    coordinator: "write-journal" as const,
    paths,
    ...(!attempted ? { reason: "no_paths" } : {}),
    ...(flush ? { flush } : {})
  };
}
