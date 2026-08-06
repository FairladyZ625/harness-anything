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
import { readDaemonRegistry, resolveHarnessLayout, type DaemonRegistryRepo } from "@harness-anything/kernel";
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
  formatRepoWriteFailureDiagnostic,
  formatRepoWriteTimeoutDiagnostic
} from "../runtime/repo-write-stall-diagnostic.ts";
import {
  RepoWriteProcessSupervisor
} from "../runtime/repo-write-process-supervisor.ts";
import {
  prepareProductionRepoLocks,
  startProductionRepoWriteSupervisors
} from "../runtime/production-repo-lock-topology.ts";
import {
  encodeRepoWriteChildLaunchConfig,
  repoWriteChildLaunchConfigSchema
} from "../runtime/repo-write-child-launch-config.ts";
import {
  createProvenanceCapacityTelemetryTrigger
} from "../observability/provenance-capacity-trigger.ts";
import { scheduleProvenanceCapacityLog } from "../observability/provenance-capacity-log.ts";
import {
  formatDaemonFailure,
  repoWriteGracefulFailureLog
} from "./daemon-failure-diagnostic.ts";
import { daemonRootLifetimeGuard } from "./daemon-root-lifetime.ts";
import { waitForDaemonStopSignal } from "./daemon-stop-signal.ts";

export type DaemonServeRepo = DaemonRepoNamespace & Pick<DaemonRegistryRepo, "displayName" | "authorityManifestPath">;

export interface DaemonServeHooks {
  readonly onStarted?: (status: Record<string, unknown>) => void;
  readonly onStop?: () => Promise<void>;
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
  readonly expectedRootIdentity?: string;
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
    const rootLifetime = daemonRootLifetimeGuard(rootDir, input.expectedRootIdentity);
    try {
      rootLifetime.assertAvailable();
      // Endpoint ownership is already published, while connections remain
      // deferred. Replacement control can therefore observe a live owner
      // during this potentially expensive non-RPC startup scan.
      const loadedBuild = calculateDaemonArtifactIdentity(input.entrypoint);
      const connections = { active: 0, total: 0 };
      const authorityLifecycle = hooks.authorityLifecycle ?? (
        authorityManifest && !productionChildCutover
        ? serveHostServices.createAuthorityLifecycle({
          manifestPath: authorityManifest,
          daemonLogService,
          backgroundRecovery: true,
          userRoot,
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
      rootLifetime.assertAvailable();
      const registry = readDaemonRegistry({ userRoot });
      const priorGeneration = registry.machineId !== undefined && registry.daemonGeneration !== undefined
        ? { machineId: registry.machineId, daemonGeneration: registry.daemonGeneration }
        : undefined;
      const generation = prepareDaemonGenerationForServe({
        userRoot,
        endpointIdentity: endpoint,
        daemonInstanceId: `ha-${process.pid}`,
        ...(priorGeneration ? { priorGeneration } : {}),
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
      if (productionChildCutover) {
        prepareProductionRepoLocks({
          repos: activeServeRepos,
          userRoot,
          endpoint,
          lockTtlMs: runtimePolicy.write.lockTtlMs,
          ...(layoutOverrides ? { layoutOverrides } : {})
        });
      }
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
          lockProvenance: {
            repoId: repo.repoId,
            canonicalRoot: repo.canonicalRoot,
            userRoot,
            endpoint
          },
          ...(layoutOverrides ? { layoutOverrides } : {})
        }))
      });
      const startStatus = await runtime.start();
      rootLifetime.assertAvailable();
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
          const provenanceCapacityTrigger = createProvenanceCapacityTelemetryTrigger();
          const authoredGitRoot = resolveHarnessLayout({
            rootDir: repo.canonicalRoot,
            ...(layoutOverrides ? { layoutOverrides } : {})
          }).authoredRoot;
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
            }),
            onTelemetry: (frame) => {
              const capacitySignal = provenanceCapacityTrigger.observe(frame);
              void daemonLogService.append({
                level: "debug",
                source: "daemon",
                component: "repo-write-child",
                event: "repo-write.request.telemetry",
                message: JSON.stringify({
                  schema: "repo-write-request-telemetry/v1",
                  requestId: frame.requestId,
                  ...(frame.opId ? { opId: frame.opId } : {}),
                  phase: frame.phase,
                  elapsedMs: frame.elapsedMs,
                  ...(frame.details ? { details: frame.details } : {})
                }),
                requestId: frame.requestId
              }, { repo }).catch(() => undefined);
              if (capacitySignal) {
                scheduleProvenanceCapacityLog(
                  daemonLogService,
                  { repo },
                  authoredGitRoot,
                  capacitySignal
                );
              }
            },
            onDiagnostic: (frame) => {
              const rejected = frame.kind === "recovery-rejected";
              void daemonLogService.append({
                level: "error",
                source: "daemon",
                component: "repo-write-child",
                event: rejected
                  ? "repo-write.historical-recovery.rejected"
                  : "repo-write.historical-recovery.deferred",
                message: rejected
                  ? `Permanently rejected repo-write historical recovery for outerOpId=${frame.outerOpId}: ${frame.diagnostic} Next: ${frame.next}`
                  : `Deferred repo-write historical recovery for outerOpId=${frame.outerOpId}: ${frame.diagnostic}`,
                errorCode: frame.code,
                requestId: frame.outerOpId
              }, { repo }).catch(() => undefined);
            },
            onRequestTimeout: (diagnostic) => {
              void daemonLogService.append({
                level: "error",
                source: "daemon",
                component: "repo-write-child",
                event: "repo-write.request.timeout",
                message: formatRepoWriteTimeoutDiagnostic(diagnostic),
                errorCode: "REPO_WRITE_REQUEST_TIMEOUT",
                requestId: diagnostic.requestId
              }, { repo }).catch(() => undefined);
            },
            onRequestFailure: (diagnostic) => {
              void daemonLogService.append({
                level: "error",
                source: "daemon",
                component: "repo-write-child",
                event: "repo-write.request.failure",
                message: formatRepoWriteFailureDiagnostic(diagnostic),
                errorCode: diagnostic.code,
                requestId: diagnostic.requestId
              }, { repo }).catch(() => undefined);
            },
            onGracefulStopFailure: async (error) => {
              await daemonLogService.append(repoWriteGracefulFailureLog(error), { repo });
            }
          });
          repoWriteSupervisors.set(repo.repoId, supervisor);
        }
        await startProductionRepoWriteSupervisors({
          supervisors: repoWriteSupervisors,
          repos: activeServeRepos,
          userRoot,
          endpoint,
          ...(layoutOverrides ? { layoutOverrides } : {})
        });
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
      if (hooks.onStop) serviceHost.onStop(hooks.onStop);
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
      const trigger = await rootLifetime.waitForStop(waitForDaemonStopSignal(), serviceHost.waitForStopRequest());
      terminalReason = rootLifetime.terminalReason(trigger);
      terminalClean = true;
    } catch (error) {
      failure = error;
      terminalReason = `unexpected-error:${error instanceof Error ? error.name : "unknown"}`;
      terminalMessage = `Daemon service terminated after an unexpected error: ${formatDaemonFailure(error)}`;
    }
    rootLifetime.stop();
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
      const cleanupTrigger = terminalReason ?? "unknown stop trigger";
      terminalClean = false;
      terminalReason = `shutdown-error:${error instanceof Error ? error.name : "unknown"}`;
      terminalMessage = `Daemon service cleanup after ${cleanupTrigger} failed: ${formatDaemonFailure(error)}`;
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

function realpathOrResolvedServeRoot(input: string): string {
  try {
    return realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}
