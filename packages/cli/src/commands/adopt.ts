import { Effect } from "effect";
import path from "node:path";
import { makeMulticaAdoptionService, makeMulticaLifecycleEngine, type MulticaClient, type MulticaRawIssue } from "@harness-anything/adapter-multica";
import type { ArtifactStoreError, EngineError, ExternalRef, OperationalActor, TaskId, WriteCoordinator, WriteError } from "@harness-anything/kernel";
import type { HarnessLayoutInput } from "@harness-anything/kernel";
import { resolveHarnessLayout, taskPackagePath } from "@harness-anything/kernel";
import type { CliResult } from "../cli/types.ts";
import { resolveMulticaStaleTtlMs } from "./project-policy-settings.ts";

export interface AdoptMulticaAction {
  readonly kind: "adopt-multica";
  readonly taskId: string;
  readonly ref: string;
  readonly title: string;
  readonly status: string;
  readonly url: string;
}

export interface SnapshotMulticaAction {
  readonly kind: "external-snapshot";
  readonly provider: "multica";
  readonly ref: string;
  readonly title: string;
  readonly status: string;
  readonly url: string;
}

export function runAdoptMultica(
  rootInput: HarnessLayoutInput,
  action: AdoptMulticaAction,
  makeWriteCoordinator: (actor: OperationalActor) => WriteCoordinator
): Effect.Effect<CliResult, ArtifactStoreError | EngineError | WriteError> {
  const staleTtl = resolveMulticaStaleTtlMs(rootInput, process.env, action.kind);
  if (!staleTtl.ok) return Effect.succeed(staleTtl.result);
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const layoutOverrides = typeof rootInput === "string" ? undefined : rootInput.layoutOverrides;
  const service = makeMulticaAdoptionService({
    rootDir,
    layoutOverrides,
    client: fixtureClient(action),
    staleTtlMs: staleTtl.ttlMs,
    coordinator: makeWriteCoordinator({ scope: "operational", kind: "agent", id: "adopt-multica-cli" })
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

export function runSnapshotMultica(rootInput: HarnessLayoutInput, action: SnapshotMulticaAction): Effect.Effect<CliResult, EngineError | WriteError> {
  const staleTtl = resolveMulticaStaleTtlMs(rootInput, process.env, action.kind);
  if (!staleTtl.ok) return Effect.succeed(staleTtl.result);
  const engine = makeMulticaLifecycleEngine({ client: fixtureClient(action), staleTtlMs: staleTtl.ttlMs });
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
