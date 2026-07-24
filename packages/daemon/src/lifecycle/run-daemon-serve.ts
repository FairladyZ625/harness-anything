// @slice-activation PLT-Boundary W2 daemon serve root is invoked by the CLI daemon-serve route.
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  makeDaemonLogService,
  type DaemonHostCommand,
  type DaemonHostCommandResult,
  type DaemonServeHostServices,
  type DaemonServiceHostServices
} from "@harness-anything/application";
import { makeLocalProjectionSourceFenceReader } from "@harness-anything/adapter-local";
import { readDaemonRegistry, type DaemonRegistryRepo } from "@harness-anything/kernel";
import { createMultiRepoDaemonRuntime, type HarnessDaemonRuntime } from "../runtime/repo-runtime.ts";
import type { AuthenticatedActor } from "../identity/types.ts";
import type { AuthorityRepoLifecycleController } from "../authority/authority-lifecycle.ts";
import type { DaemonRepoNamespace } from "../protocol/json-rpc-server.ts";
import {
  authorityManifestServeRepos,
  persistAuthorityManifestPointer
} from "../authority/production/authority-manifest-registry.ts";
import { loadAuthorityProductionManifest } from "../authority/production/authority-production-state.ts";
import { createDaemonLaunchConfiguration, type DaemonLaunchConfiguration } from "../client/local-json-rpc-client.ts";
import { calculateDaemonArtifactIdentity } from "../protocol/daemon-artifact-identity.ts";
import { createDaemonServiceHost } from "../service/service-host.ts";
import { createDaemonLocalTransport, withDaemonSocketOwnership } from "../transport/local-service-transport.ts";
import { makeDaemonLogFileStore } from "./daemon-log-file-store.ts";
import { makeDaemonReservationReconciler } from "./reservation-reconciler.ts";
import { recordDaemonStarted, recordDaemonTerminated } from "./daemon-lifecycle.ts";
import { prepareDaemonGenerationForServe } from "./daemon-generation.ts";
import { resolveDaemonRuntimePolicy, type DaemonRuntimePolicy } from "../runtime/runtime-policy.ts";
import {
  forkRepoWriteProcess
} from "../runtime/repo-write-child-process-transport.ts";
import {
  RepoWriteProcessSupervisor
} from "../runtime/repo-write-process-supervisor.ts";
import {
  encodeRepoWriteChildLaunchConfig,
  repoWriteChildLaunchConfigSchema
} from "../runtime/repo-write-child-launch-config.ts";

export type DaemonServeRepo = DaemonRepoNamespace & Pick<DaemonRegistryRepo, "displayName" | "authorityManifestPath">;

export interface DaemonServeHooks {
  readonly onStarted?: (status: Record<string, unknown>) => void;
  readonly authorityLifecycle?: AuthorityRepoLifecycleController;
}

export interface DaemonServeInput {
  readonly rootDir: string;
  readonly authoredRoot?: string;
  readonly layoutOverrides?: { readonly authoredRoot?: string };
  readonly userRoot: string;
  readonly endpoint: string;
  readonly requestedRepoId: string;
  readonly requestedAuthorityManifest?: string;
  readonly entrypoint: string;
  readonly idleMs: number;
  readonly preflightReplacement: (configuration: DaemonLaunchConfiguration) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly runtimePolicy?: DaemonRuntimePolicy;
  readonly admissionMaxBytes?: number;
}

export async function runDaemonServe<
  Command extends DaemonHostCommand,
  Result extends DaemonHostCommandResult,
  PresentedControlError extends object,
  Identity extends {
    readonly mode: "local" | "remote";
    readonly personRegistry?: import("../identity/types.ts").PersonRegistry;
    readonly identityProvider?: import("../identity/types.ts").IdentityProvider;
    readonly identityAdminSnapshot?: import("../identity/types.ts").IdentityAdminSnapshot;
  }
>(
  input: DaemonServeInput,
  serviceHostServices: DaemonServiceHostServices<Command, Result, AuthenticatedActor, HarnessDaemonRuntime, Identity, PresentedControlError>,
  serveHostServices: DaemonServeHostServices<DaemonLaunchConfiguration, AuthorityRepoLifecycleController>,
  hooks: DaemonServeHooks = {}
): Promise<void> {
  const { rootDir, layoutOverrides, userRoot, endpoint } = input;
  const { serveRepos, authorityManifest, defaultRepoId, lifecycleRepo } = resolveDaemonServeConfiguration(input);
  const loadedBuild = calculateDaemonArtifactIdentity(input.entrypoint);
  const startedAt = new Date().toISOString();
  const runtimePolicy = input.runtimePolicy ?? resolveDaemonRuntimePolicy();
  const productionChildCutover = authorityManifest !== undefined
    && hooks.authorityLifecycle === undefined;
  const cutoverManifest = productionChildCutover && authorityManifest
    ? loadAuthorityProductionManifest(authorityManifest)
    : undefined;
  const activeServeRepos = cutoverManifest
    ? serveRepos.filter((repo) => cutoverManifest.repos.some((configured) =>
      configured.repoId === repo.repoId))
    : serveRepos;
  if (!activeServeRepos.some((repo) => repo.repoId === defaultRepoId)) {
    throw new Error(`REPO_WRITE_CHILD_REPO_NOT_CONFIGURED:${defaultRepoId}`);
  }

  return withDaemonSocketOwnership(endpoint, async () => {
    const daemonLogService = makeDaemonLogService({ store: makeDaemonLogFileStore({ userRoot }) });
    let runtime: ReturnType<typeof createMultiRepoDaemonRuntime> | undefined;
    let serviceHost: Awaited<ReturnType<typeof createDaemonServiceHost<Command, Result, Identity, PresentedControlError>>> | undefined;
    let transport: ReturnType<typeof createDaemonLocalTransport> | undefined;
    let transportStarted = false;
    let lifecycleStarted = false;
    let writerChildrenOwnedByHost = false;
    const repoWriteSupervisors =
      new Map<string, RepoWriteProcessSupervisor>();
    let terminalReason: string | undefined;
    let terminalClean = false;
    let terminalMessage: string | undefined;
    let failure: unknown;
    try {
      const connections = { active: 0, total: 0 };
      const authorityLifecycle = hooks.authorityLifecycle ?? (
        authorityManifest && !productionChildCutover
        ? serveHostServices.createAuthorityLifecycle({
          manifestPath: authorityManifest,
          daemonLogService,
          backgroundRecovery: true,
          ...(layoutOverrides ? { layoutOverrides } : {})
        })
        : undefined);
      transport = createDaemonLocalTransport({
        daemonId: `ha-${process.pid}`,
        endpoint,
        acceptSshForcedCommand: (frame) => serviceHost?.acceptsSshForcedCommand(frame.canonicalRoot) ?? false,
        ...(authorityLifecycle ? {
          authorityWireIngress: (request) => {
            if (!serviceHost) throw new Error("daemon service host is not ready");
            return serviceHost.authorityWireIngress(request);
          }
        } : {}),
        createProtocolServer: (authContext, acceptedConnection, notificationSink) => {
          if (!serviceHost) throw new Error("daemon service host is not ready");
          return serviceHost.createProtocolServer(authContext, acceptedConnection, notificationSink);
        },
        onConnection: () => {
          connections.active += 1;
          connections.total += 1;
          serviceHost?.onConnectionStart();
        },
        onConnectionClosed: () => {
          connections.active = Math.max(0, connections.active - 1);
          serviceHost?.onConnectionSettled();
        },
        deferConnectionsUntilActivated: true
      });
      await transport.start();
      transportStarted = true;
      const generation = prepareDaemonGenerationForServe({
        userRoot,
        endpointIdentity: endpoint,
        daemonInstanceId: `ha-${process.pid}`,
        ...(input.platform ? { platform: input.platform } : {})
      });
      if (generation.mode === "legacy") {
        try {
          await daemonLogService.append({
            level: "warn",
            source: "daemon",
            component: "daemon.generation",
            event: "daemon.generation.legacy-mode",
            message: "Durable daemon generation publication is unavailable; continuing with legacy daemon semantics.",
            errorCode: generation.diagnostic,
            hint: "Generation-aware status, control, and terminal receipt fencing remain unavailable on this platform."
          }, { repo: lifecycleRepo });
        } catch {
          // Operational diagnostics must not block legacy-compatible daemon startup.
        }
      }
      const launchConfiguration = createDaemonLaunchConfiguration({
        target: { canonicalRoot: rootDir, repoId: defaultRepoId, socketPath: endpoint, userRoot },
        entrypoint: input.entrypoint,
        idleExitMs: input.idleMs,
        ...(input.authoredRoot !== undefined ? { authoredRoot: input.authoredRoot } : {}),
        ...(authorityManifest ? { authorityManifest } : {}),
        launchOptionsResolved: true,
        ...(generation.mode === "generation" ? {
          machineId: generation.machineId,
          daemonGeneration: generation.daemonGeneration
        } : {})
      });
      runtime = createMultiRepoDaemonRuntime({
        ...(productionChildCutover ? { writeOwnership: "reader" as const } : {}),
        projectionSourceFenceFactory: makeLocalProjectionSourceFenceReader,
        lockTtlMs: runtimePolicy.write.lockTtlMs,
        interactiveMicroBatchMs: runtimePolicy.write.interactiveMicroBatchMs,
        maxInteractiveOpsPerCommit: runtimePolicy.write.maxInteractiveOpsPerCommit,
        materializerPollMs: runtimePolicy.materializer.pollMs,
        materializerMaxBranchesPerBatch: runtimePolicy.materializer.maxBranchesPerBatch,
        projectionReconcileIntervalMs: runtimePolicy.projection.reconcileIntervalMs,
        ...(input.admissionMaxBytes === undefined ? {} : { admissionMaxBytes: input.admissionMaxBytes }),
        ...(generation.mode === "legacy" ? {
          generationCapability: { mode: "legacy", platform: "win32", diagnostic: generation.diagnostic }
        } : {}),
        ...(generation.mode === "generation" ? {
          generationAxes: {
            machineId: generation.machineId,
            daemonGeneration: generation.daemonGeneration
          },
          generationWitness: generation.witness
        } : {}),
        reservationReconciler: async (rootInput) => {
          const canonicalRoot = typeof rootInput === "string" ? rootInput : rootInput.rootDir;
          const repoId = activeServeRepos.find((repo) =>
            repo.canonicalRoot === canonicalRoot)?.repoId;
          return makeDaemonReservationReconciler(rootInput, repoId ? runtime?.getRepoRuntime(repoId) : undefined)();
        },
        repos: activeServeRepos.map((repo) => ({
          repoId: repo.repoId,
          rootDir: repo.canonicalRoot,
          displayName: repo.displayName,
          ...(layoutOverrides ? { layoutOverrides } : {})
        }))
      });
      const startStatus = await runtime.start();
      if (startStatus.repoCount > 0 && startStatus.attachedCount === 0 && startStatus.unavailableCount > 0) {
        throw new Error(`daemon did not attach any registered repo: ${startStatus.repos.map((repo) => `${repo.repoId}:${repo.lastError ?? repo.state}`).join("; ")}`);
      }
      if (productionChildCutover) {
        if (generation.mode !== "generation" || !authorityManifest) {
          throw new Error(
            "REPO_WRITE_CHILD_REQUIRES_DURABLE_DAEMON_GENERATION"
          );
        }
        for (const repo of activeServeRepos) {
          const configured = cutoverManifest?.repos.find((candidate) =>
            candidate.repoId === repo.repoId);
          if (!configured) {
            throw new Error(
              `REPO_WRITE_CHILD_REPO_NOT_CONFIGURED:${repo.repoId}`
            );
          }
          const supervisor = new RepoWriteProcessSupervisor({
            repoId: repo.repoId,
            generation: generation.daemonGeneration,
            expectedArtifactIdentity: loadedBuild.identity,
            spawn: () => forkRepoWriteProcess({
              modulePath: input.entrypoint,
              args: [
                "__repo-write-child",
                encodeRepoWriteChildLaunchConfig({
                  schema: repoWriteChildLaunchConfigSchema,
                  repoId: repo.repoId,
                  canonicalRoot: repo.canonicalRoot,
                  ...(layoutOverrides?.authoredRoot ? {
                    authoredRoot: layoutOverrides.authoredRoot
                  } : {}),
                  authorityManifest,
                  userRoot,
                  endpointIdentity: endpoint,
                  machineId: generation.machineId,
                  generation: generation.daemonGeneration,
                  entrypointArtifactIdentity: loadedBuild.identity,
                  runtimePolicy,
                  ...(input.admissionMaxBytes === undefined ? {} : {
                    admissionMaxBytes: input.admissionMaxBytes
                  })
                })
              ],
              cwd: repo.canonicalRoot,
              env: {
                ...process.env,
                HARNESS_DAEMON_SERVER_HOST: "1"
              }
            })
          });
          repoWriteSupervisors.set(repo.repoId, supervisor);
        }
        await Promise.all(
          [...repoWriteSupervisors.values()].map((supervisor) =>
            supervisor.start())
        );
      }
      serviceHost = await createDaemonServiceHost(
        runtime,
        activeServeRepos,
        defaultRepoId,
        layoutOverrides,
        input.idleMs,
        endpoint,
        connections,
        userRoot,
        {
          entrypoint: input.entrypoint,
          loadedIdentity: loadedBuild.identity,
          startedAt,
          launchConfiguration,
          preflightReplacement: input.preflightReplacement,
          ...(generation.mode === "generation" ? {
            machineId: generation.machineId,
            daemonGeneration: generation.daemonGeneration
          } : {})
        },
        serviceHostServices,
        authorityLifecycle,
        daemonLogService,
        productionChildCutover ? repoWriteSupervisors : undefined
      );
      writerChildrenOwnedByHost = productionChildCutover;
      await transport.activate();
      serviceHost.onStop(async () => {
        if (!transportStarted || !transport) return;
        transportStarted = false;
        await transport.stop();
      });
      if (input.requestedAuthorityManifest) {
        persistAuthorityManifestPointer(input.requestedAuthorityManifest, userRoot);
      }
      serveHostServices.persistLaunchConfiguration(userRoot, launchConfiguration, {
        ...(authorityManifest ? { authorityManifest } : {}),
        ...(input.authoredRoot ? { authoredRoot: input.authoredRoot } : {})
      });
      if (!productionChildCutover) {
        serviceHost.startRegistryReconcile(
          userRoot,
          runtimePolicy.registry.reconcileIntervalMs
        );
      }
      await recordDaemonStarted({
        userRoot,
        logService: daemonLogService,
        repo: lifecycleRepo,
        instanceId: serviceHost.daemonId,
        pid: process.pid,
        startedAt
      });
      lifecycleStarted = true;
      hooks.onStarted?.(serveHostServices.projectStartedStatus(serviceHost.status()));
      serviceHost.scheduleIdleExit();
      const trigger = await Promise.race([waitForStopSignal(), serviceHost.waitForStopRequest()]);
      terminalReason = trigger.reason === "signal"
        ? `signal:${trigger.signal}`
        : trigger.reason === "control"
          ? `control:${trigger.kind}`
          : "idle-timeout";
      terminalClean = true;
    } catch (error) {
      failure = error;
      terminalReason = `unexpected-error:${error instanceof Error ? error.name : "unknown"}`;
      terminalMessage = `Daemon service terminated after an unexpected error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
    }
    try {
      let stoppedByHost = false;
      try {
        if (serviceHost) {
          await serviceHost.stop();
          stoppedByHost = true;
        } else if (runtime) {
          await runtime.stop();
        }
      } finally {
        if (!stoppedByHost && serviceHost && runtime) await runtime.stop();
        if (!writerChildrenOwnedByHost && repoWriteSupervisors.size > 0) {
          await Promise.allSettled(
            [...repoWriteSupervisors.values()].map((supervisor) =>
              supervisor.stop())
          );
        }
        if (transportStarted && transport) {
          transportStarted = false;
          await transport.stop();
        }
      }
    } catch (error) {
      failure ??= error;
      terminalClean = false;
      terminalReason = `shutdown-error:${error instanceof Error ? error.name : "unknown"}`;
      terminalMessage = `Daemon service cleanup failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
    }
    if (lifecycleStarted && serviceHost) {
      try {
        await recordDaemonTerminated({
          userRoot,
          logService: daemonLogService,
          repo: lifecycleRepo,
          instanceId: serviceHost.daemonId,
          pid: process.pid,
          startedAt,
          reason: terminalReason ?? "unexpected-error:unknown",
          clean: terminalClean,
          ...(terminalMessage ? { message: terminalMessage } : {})
        });
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  });
}

export function checkDaemonServeConfiguration(
  input: Pick<DaemonServeInput, "rootDir" | "layoutOverrides" | "userRoot" | "endpoint" | "requestedRepoId" | "requestedAuthorityManifest">
): void {
  resolveDaemonServeConfiguration(input);
}

function resolveDaemonServeConfiguration(
  input: Pick<DaemonServeInput, "rootDir" | "layoutOverrides" | "userRoot" | "endpoint" | "requestedRepoId" | "requestedAuthorityManifest">
): {
  readonly serveRepos: ReadonlyArray<DaemonServeRepo>;
  readonly authorityManifest?: string;
  readonly defaultRepoId: string;
  readonly lifecycleRepo: DaemonServeRepo;
} {
  const serveRepos = input.requestedAuthorityManifest
    ? authorityManifestServeRepos(input.requestedAuthorityManifest, input.userRoot)
    : daemonServeRepos(input.rootDir, input.layoutOverrides, input.requestedRepoId, input.userRoot);
  const authorityManifest = input.requestedAuthorityManifest ?? authorityManifestFromRegistry(serveRepos);
  if (authorityManifest) loadAuthorityProductionManifest(authorityManifest);
  const defaultRepoId = defaultDaemonServeRepoId(serveRepos, input.rootDir, input.requestedRepoId);
  const lifecycleRepo = serveRepos.find((repo) => repo.repoId === defaultRepoId) ?? serveRepos[0];
  if (!lifecycleRepo) throw new Error("daemon lifecycle requires at least one registered repository");
  return {
    serveRepos,
    ...(authorityManifest ? { authorityManifest } : {}),
    defaultRepoId,
    lifecycleRepo
  };
}

function daemonServeRepos(
  rootDir: string,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  requestedRepoId: string,
  userRoot: string
): ReadonlyArray<DaemonServeRepo> {
  const enabledRepos = readDaemonRegistry({ userRoot }).repos.filter((repo) => repo.state === "enabled");
  if (enabledRepos.length > 0) {
    return enabledRepos.map((repo) => ({
      repoId: repo.repoId,
      canonicalRoot: repo.canonicalRoot,
      displayName: repo.displayName,
      ...(repo.authorityManifestPath ? { authorityManifestPath: repo.authorityManifestPath } : {})
    }));
  }
  return [{ repoId: requestedRepoId, canonicalRoot: rootDir, displayName: layoutOverrides?.authoredRoot ?? requestedRepoId }];
}

export function authorityManifestFromRegistry(repos: ReadonlyArray<DaemonServeRepo>): string | undefined {
  const pointers = [...new Set(repos.flatMap((repo) => repo.authorityManifestPath ? [repo.authorityManifestPath] : []))];
  if (pointers.length > 1) {
    throw new Error("AUTHORITY_MANIFEST_REGISTRY_CONFLICT: registered repositories require different authority manifests; start separate daemon user roots or pass --authority-manifest explicitly");
  }
  const protectedRepos = repos.filter((repo) => repo.authorityManifestPath);
  if (protectedRepos.length > 0 && protectedRepos.length !== repos.length) {
    throw new Error("AUTHORITY_MANIFEST_REGISTRY_INCOMPLETE: authority-protected and classic repositories cannot share a daemon without an explicit manifest covering every repo");
  }
  return pointers[0];
}

function defaultDaemonServeRepoId(repos: ReadonlyArray<DaemonServeRepo>, rootDir: string, requestedRepoId: string): string {
  if (repos.some((repo) => repo.repoId === requestedRepoId)) return requestedRepoId;
  const matchingRoot = repos.find((repo) => realpathOrResolvedServeRoot(repo.canonicalRoot) === realpathOrResolvedServeRoot(rootDir));
  return matchingRoot?.repoId ?? repos[0]?.repoId ?? requestedRepoId;
}

function waitForStopSignal(): Promise<{ readonly reason: "signal"; readonly signal: "SIGINT" | "SIGTERM" }> {
  return new Promise((resolve) => {
    const stop = (signal: "SIGINT" | "SIGTERM") => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve({ reason: "signal", signal });
    };
    const onSigint = () => stop("SIGINT");
    const onSigterm = () => stop("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  });
}

function realpathOrResolvedServeRoot(input: string): string {
  try {
    return realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}
