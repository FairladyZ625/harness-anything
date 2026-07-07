import { Effect } from "effect";
import {
  bindCreateProvenance,
  makeDecisionWriteService,
  makeEnvironmentCurrentSessionProbe,
  makeFactWriteService,
  makeProvenanceSessionExporter,
  makeRuntimeEventLedgerService,
  type ProvenanceSessionExporterRejected,
  type ProvenanceSessionExportResult
} from "../../../application/src/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/index.ts";
import { createHarnessRuntimeContext, findConflictMarkerWarnings } from "../../../kernel/src/index.ts";
import { toCliError } from "../cli/error-mapper.ts";
import { actionTaskId } from "../cli/parse-args.ts";
import { requiresConflictMarkerPreflight, runRegisteredCommand } from "../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";
import { commitAuthoredPaths } from "../commands/core/authored-git.ts";
import {
  defaultCliAdapterProvider,
  type CliCompositionAdapterProvider
} from "./adapter-registry.ts";

export interface ParsedCommandExecutionOptions {
  readonly provider?: CliCompositionAdapterProvider;
  readonly makeWriteCoordinator?: (actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) => WriteCoordinator;
}

export async function runRegisteredCommandWithCliComposition(
  command: ParsedCommand,
  options: ParsedCommandExecutionOptions = {}
): Promise<CliResult> {
  const provider = options.provider ?? defaultCliAdapterProvider();
  const layoutInput = {
    rootDir: command.rootDir,
    layoutOverrides: command.layoutOverrides
  };
  let currentSessionProbe: ReturnType<typeof makeEnvironmentCurrentSessionProbe> | undefined;
  const getCurrentSessionProbe = () => {
    currentSessionProbe ??= makeEnvironmentCurrentSessionProbe();
    return currentSessionProbe;
  };
  let sessionBranchResolved = false;
  let sessionBranchId: string | undefined;
  const getSessionBranchId = () => {
    if (!sessionBranchResolved) {
      const session = Effect.runSync(getCurrentSessionProbe().currentSession);
      sessionBranchId = session.source === "runtime" ? session.sessionId : undefined;
      sessionBranchResolved = true;
    }
    return sessionBranchId;
  };
  const makeSessionExporter = () => makeProvenanceSessionExporter({
    rootInput: layoutInput,
    currentSessionProbe: getCurrentSessionProbe()
  });
  const syncExportedSession = (result: ProvenanceSessionExportResult): Effect.Effect<void, ProvenanceSessionExporterRejected> => Effect.try({
    try: () => {
      try {
        commitAuthoredPaths(layoutInput, [result.path], `session(export): ${result.session.sessionId}`);
      } catch (error) {
        if (error instanceof Error && error.message === "authored root is ignored by Git but is not a nested Git repository") return;
        throw error;
      }
    },
    catch: (error) => ({
      _tag: "ProvenanceSessionExporterRejected" as const,
      sessionId: result.session.sessionId,
      reason: error instanceof Error ? error.message : "session git commit failed"
    })
  }).pipe(Effect.asVoid);

  const rawMakeWriteCoordinator = options.makeWriteCoordinator ?? ((actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) =>
    provider.createWriteCoordinator({
      rootDir: command.rootDir,
      layoutOverrides: command.layoutOverrides,
      actor,
      sessionId: getSessionBranchId()
    }));
  const makeWriteCoordinator = requiresConflictMarkerPreflight(command.action)
    ? (actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) => withConflictMarkerFlushRecheck(rawMakeWriteCoordinator(actor), layoutInput)
    : rawMakeWriteCoordinator;

  return Effect.runPromise(runRegisteredCommand(command, () => provider.createLifecycleEngine({
    rootDir: command.rootDir,
    layoutOverrides: command.layoutOverrides,
    coordinator: makeWriteCoordinator({ kind: "agent", id: "local-lifecycle" }),
    bindCreateProvenance: (boundAt) => bindCreateProvenance({
      currentSessionProbe: getCurrentSessionProbe(),
      provenanceSessionExporter: makeSessionExporter(),
      syncExportedSession
    }, boundAt)
  }), getCurrentSessionProbe, makeSessionExporter, syncExportedSession, makeWriteCoordinator, () => makeDecisionWriteService({
    rootInput: layoutInput,
    coordinator: makeWriteCoordinator({ kind: "agent", id: "decision-cli" }),
    currentSessionProbe: getCurrentSessionProbe(),
    provenanceSessionExporter: makeSessionExporter(),
    syncExportedSession
  }), () => makeFactWriteService({
    rootInput: layoutInput,
    coordinator: makeWriteCoordinator({ kind: "agent", id: "fact-cli" }),
    currentSessionProbe: getCurrentSessionProbe(),
    provenanceSessionExporter: makeSessionExporter(),
    syncExportedSession
  }), () => makeRuntimeEventLedgerService({
    rootInput: layoutInput
  }), provider.runLedgerMaterializer).pipe(
    Effect.match({
      onFailure: (error): CliResult => ({
        ok: false,
        command: command.action.kind,
        taskId: actionTaskId(command.action),
        error: toCliError(error)
      }),
      onSuccess: (value) => value
    })
  ));
}

export function commandRootInput(command: ParsedCommand): ReturnType<typeof createHarnessRuntimeContext> {
  return createHarnessRuntimeContext(command.rootDir, command.layoutOverrides);
}

function withConflictMarkerFlushRecheck(
  coordinator: WriteCoordinator,
  rootInput: ReturnType<typeof createHarnessRuntimeContext>
): WriteCoordinator {
  return {
    enqueue: coordinator.enqueue,
    recover: coordinator.recover,
    flush: (reason) => Effect.try({
      try: () => findConflictMarkerWarnings(rootInput)[0],
      catch: (cause) => ({ _tag: "JournalUnavailable" as const, cause })
    }).pipe(
      Effect.flatMap((warning) => warning
        ? Effect.fail({
          _tag: "WriteRejected" as const,
          taskId: "preflight",
          reason: warning.message
        })
        : coordinator.flush(reason))
    )
  };
}
