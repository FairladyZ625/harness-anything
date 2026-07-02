import { Effect } from "effect";
import path from "node:path";
import { makeLocalWriteCoordinator } from "../../../adapters/local/src/index.ts";
import { makeMulticaAdoptionService, makeMulticaLifecycleEngine, type MulticaClient, type MulticaRawIssue } from "../../../adapters/multica/src/index.ts";
import type { ArtifactStoreError, EngineError, ExternalRef, TaskId, WriteError } from "../../../kernel/src/domain/index.ts";
import type { HarnessLayoutInput } from "../../../kernel/src/layout/index.ts";
import { resolveHarnessLayout, taskPackagePath } from "../../../kernel/src/layout/index.ts";
import type { CliResult } from "../cli/types.ts";

export interface AdoptMulticaAction {
  readonly kind: "adopt-multica";
  readonly taskId: string;
  readonly ref: string;
  readonly title: string;
  readonly status: string;
  readonly url: string;
}

export interface SnapshotMulticaAction {
  readonly kind: "snapshot-multica";
  readonly ref: string;
  readonly title: string;
  readonly status: string;
  readonly url: string;
}

export function runAdoptMultica(
  rootInput: HarnessLayoutInput,
  action: AdoptMulticaAction
): Effect.Effect<CliResult, ArtifactStoreError | EngineError | WriteError> {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const layoutOverrides = typeof rootInput === "string" ? undefined : rootInput.layoutOverrides;
  const service = makeMulticaAdoptionService({
    rootDir,
    layoutOverrides,
    client: fixtureClient(action),
    coordinator: makeLocalWriteCoordinator({
      rootDir,
      layoutOverrides,
      actor: { kind: "agent", id: "adopt-multica-cli" }
    })
  });

  return service.adopt({ taskId: action.taskId as TaskId, ref: action.ref as ExternalRef }).pipe(
    Effect.map((result): CliResult => ({
      ok: true,
      command: "adopt-multica",
      taskId: result.taskId,
      path: path.relative(rootDir, taskPackagePath(rootInput, result.taskId)).split(path.sep).join("/"),
      report: {
        schema: "harness-adopt-report/v1",
        engine: result.engine,
        ref: result.ref,
        writeBoundary: "local-authored-task-package",
        externalWrites: false
      }
    }))
  );
}

export function runSnapshotMultica(action: SnapshotMulticaAction): Effect.Effect<CliResult, EngineError | WriteError> {
  const engine = makeMulticaLifecycleEngine({ client: fixtureClient(action) });
  return engine.snapshot({ engine: "multica", ref: action.ref as ExternalRef }).pipe(
    Effect.map((snapshot): CliResult => ({
      ok: true,
      command: "snapshot-multica",
      report: {
        schema: "harness-snapshot-report/v1",
        snapshot,
        externalWrites: false
      }
    }))
  );
}

function fixtureClient(input: { readonly ref: string; readonly title: string; readonly status: string; readonly url: string }): MulticaClient {
  const issue: MulticaRawIssue = {
    ref: input.ref as ExternalRef,
    title: input.title,
    status: input.status,
    url: input.url.length > 0 ? input.url : undefined
  };
  return {
    fetchIssue: (ref) => ref === issue.ref
      ? Effect.succeed(issue)
      : Effect.fail({ _tag: "RefNotFound", ref } satisfies EngineError),
    listIssues: () => Effect.succeed([issue])
  };
}
