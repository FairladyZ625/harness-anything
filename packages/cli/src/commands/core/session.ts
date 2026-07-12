import path from "node:path";
import { Effect } from "effect";
import type { CurrentSessionRef, FlushReport, SessionManifest, WriteError } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout, writeSessionEntity } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, SessionExportRuntime, SessionExportSource } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { runSessionSync } from "./session-cutover.ts";

type SessionAction = Extract<Parameters<CommandRunner>[1]["action"], {
  readonly kind: "session-export" | "session-backfill" | "session-sync";
}>;

export const runSessionCommand: CommandRunner = (context, command) => {
  const action = command.action as SessionAction;
  if (action.kind === "session-sync") return runSessionSync(context, action, (manifests) => writeCutoverSessionEntities(context, manifests));
  if (action.kind === "session-backfill") {
    return context.provenanceSessionExporter.backfillRuntimeSessions({
      ...(action.runtime ? { runtime: action.runtime } : {}),
      ...(action.limit ? { limit: action.limit } : {})
    }).pipe(
      Effect.map((result) => {
        const paths = result.exported.map((entry) => entry.path);
        const git = journalGitReport(paths.length > 0, paths, paths.length > 0);
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
  const exportOptions = action.transcriptFile ? { transcriptFile: action.transcriptFile } : undefined;
  const exportEffect = action.sessionId
    ? context.provenanceSessionExporter.exportSession(toExplicitSession(action), exportOptions)
    : context.provenanceSessionExporter.exportCurrentSession(exportOptions);
  return exportEffect.pipe(
    Effect.map((result) => {
      const git = journalGitReport(true, [result.path], true);
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

function rootRelativeSessionPath(rootInput: Parameters<CommandRunner>[0]["layoutInput"], authoredRelative: string): string {
  const layout = resolveHarnessLayout(rootInput);
  return path.relative(layout.rootDir, path.join(layout.authoredRoot, authoredRelative)).split(path.sep).join("/");
}

function writeCutoverSessionEntities(
  context: Parameters<CommandRunner>[0],
  manifests: ReadonlyArray<SessionManifest>
): Effect.Effect<FlushReport, WriteError> {
  const coordinator = context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "session-sync" });
  return Effect.gen(function* () {
    for (const [index, manifest] of manifests.entries()) {
      yield* writeSessionEntity(coordinator, context.layoutInput, manifest, {
        flush: false,
        opIdPrefix: `session-sync-${index}`
      });
    }
    return yield* coordinator.flush("explicit");
  });
}

function journalGitReport(
  attempted: boolean,
  paths: ReadonlyArray<string>,
  committed: boolean,
  flush?: FlushReport
): {
  readonly attempted: boolean;
  readonly committed: boolean;
  readonly coordinator: "write-journal";
  readonly paths: ReadonlyArray<string>;
  readonly reason?: string;
  readonly flush?: FlushReport;
} {
  return {
    attempted,
    committed,
    coordinator: "write-journal",
    paths,
    ...(!attempted ? { reason: "no_paths" } : {}),
    ...(flush ? { flush } : {})
  };
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

function sessionError(command: string, message: string): CliResult {
  return {
    ok: false,
    command,
    error: cliError(CliErrorCode.SessionExportFailed, message)
  } satisfies CliResult;
}
