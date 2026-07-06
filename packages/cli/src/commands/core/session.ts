import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { CurrentSessionRef } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, SessionExportRuntime, SessionExportSource } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { authoredRelativePath, commitAuthoredPaths } from "./authored-git.ts";

type SessionAction = Extract<Parameters<CommandRunner>[1]["action"], {
  readonly kind: "session-export" | "session-backfill" | "session-sync";
}>;

export const runSessionCommand: CommandRunner = (context, command) => {
  const action = command.action as SessionAction;
  if (action.kind === "session-sync") return runSessionSync(context.layoutInput);
  if (action.kind === "session-backfill") {
    return context.provenanceSessionExporter.backfillRuntimeSessions({
      ...(action.runtime ? { runtime: action.runtime } : {}),
      ...(action.limit ? { limit: action.limit } : {})
    }).pipe(
      Effect.map((result) => {
        const paths = result.exported.map((entry) => entry.path);
      const git = commitAuthoredPaths(context.layoutInput, paths, `session(backfill): ${paths.length} sessions`);
      const displayPaths = paths.map((entry) => rootRelativeSessionPath(context.layoutInput, entry));
      return {
        ok: true,
        command: "session-backfill",
        rows: result.exported.length,
        path: displayPaths[0],
        warnings: result.warnings,
        report: {
          schema: "session-backfill-report/v1",
          runtime: action.runtime,
          limit: action.limit,
            exported: result.exported,
            git
          }
        } satisfies CliResult;
      }),
      Effect.catchAll((error) => Effect.succeed(sessionError("session-backfill", error.reason)))
    );
  }
  return runSessionExport(context, action);
};

function runSessionExport(
  context: Parameters<CommandRunner>[0],
  action: Extract<SessionAction, { readonly kind: "session-export" }>
) {
  if (action.sessionId && !action.runtime) {
    return Effect.succeed(sessionError("session-export", "Use session export --session <id> --runtime <runtime>."));
  }
  const exportEffect = action.sessionId
    ? context.provenanceSessionExporter.exportSession(toExplicitSession(action))
    : context.provenanceSessionExporter.exportCurrentSession();
  return exportEffect.pipe(
    Effect.map((result) => {
      const git = commitAuthoredPaths(context.layoutInput, [result.path], `session(export): ${result.session.sessionId}`);
      const displayPath = rootRelativeSessionPath(context.layoutInput, result.path);
      return {
        ok: true,
        command: "session-export",
        rows: 1,
        path: displayPath,
        report: {
          schema: "session-export-report/v1",
          session: result.session,
          path: displayPath,
          git
        }
      } satisfies CliResult;
    }),
    Effect.catchAll((error) => Effect.succeed(sessionError("session-export", error.reason)))
  );
}

function runSessionSync(rootInput: Parameters<CommandRunner>[0]["layoutInput"]) {
  return Effect.sync(() => {
    const paths = listSessionMarkdownPaths(rootInput);
    const displayPaths = paths.map((entry) => rootRelativeSessionPath(rootInput, entry));
    const git = commitAuthoredPaths(rootInput, paths, `session(sync): ${paths.length} sessions`);
    return {
      ok: true,
      command: "session-sync",
      rows: paths.length,
      path: displayPaths[0],
      report: {
        schema: "session-sync-report/v1",
        sessionsRoot: "sessions",
        paths: displayPaths,
        git
      }
    } satisfies CliResult;
  });
}

function rootRelativeSessionPath(rootInput: Parameters<CommandRunner>[0]["layoutInput"], authoredRelative: string): string {
  const layout = resolveHarnessLayout(rootInput);
  return path.relative(layout.rootDir, path.join(layout.authoredRoot, authoredRelative)).split(path.sep).join("/");
}

function toExplicitSession(action: Extract<SessionAction, { readonly kind: "session-export" }>): CurrentSessionRef {
  return {
    sessionId: action.sessionId ?? "",
    runtime: action.runtime as SessionExportRuntime,
    source: (action.source ?? "manual") as SessionExportSource,
    detectedAt: action.detectedAt ?? new Date().toISOString(),
    ...(action.user ? { user: action.user } : {})
  };
}

function listSessionMarkdownPaths(rootInput: Parameters<CommandRunner>[0]["layoutInput"]): ReadonlyArray<string> {
  const layout = resolveHarnessLayout(rootInput);
  const root = layout.sessionsRoot;
  const paths: string[] = [];
  collectMarkdown(root, paths);
  return paths
    .map((absolutePath) => authoredRelativePath(rootInput, absolutePath))
    .sort((left, right) => left.localeCompare(right, "en-US"));
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
    if (stat.isDirectory()) {
      collectMarkdown(absolutePath, paths);
    } else if (entry.endsWith(".md")) {
      paths.push(absolutePath);
    }
  }
}

function sessionError(command: string, message: string): CliResult {
  return {
    ok: false,
    command,
    error: cliError(CliErrorCode.SessionExportFailed, message)
  } satisfies CliResult;
}
