import { hash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { checkServerIdentity, connect as tlsConnect, type DetailedPeerCertificate, type TLSSocket } from "node:tls";
import { evaluateEdgeAutoRepointTarget } from "@harness-anything/kernel/internal/domain/center-switchover.ts";
import { openSqliteEventStore, type CenterMovedDetails } from "@harness-anything/storage";
import { readReplicaGeneration } from "../fleet-sync/fleet/replica-generation.ts";
import { recordReplicaHealth, replicaFailure } from "../fleet-sync/fleet/replica-health.ts";
import {
  FleetEdgeConfigError,
  fleetEdgeConfigDir,
  readFleetEdgeConfig,
  readFleetEdgePendingRepoint,
  removeFleetEdgePinnedCaCert,
  writeFleetEdgePinnedCaCert,
  type FleetEdgeConfig,
} from "./client/fleet-edge-config.ts";
import {
  repointFleetEdgeMirrorFenced,
  type FleetEdgeRepointStreamHooks,
  type FleetEdgeSyncConfigFence,
} from "./fleet-center-admission.ts";
import { failFleetReplicaSync } from "./fleet/replica-sync.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";
import { tlsPeerIdentityOptions } from "./tls-ca-certificate.ts";

const DETERMINISTIC_AUTO_REPOINT_REFUSAL_CODES = new Set([
  "center_moved_repo_mismatch",
  "center_moved_invalid_target",
  "center_moved_epoch_not_advanced",
  "center_moved_no_trust_anchors",
  "center_moved_untrusted_target",
  "lineage_tip_mismatch",
  "lineage_generation_mismatch",
  "writer_epoch_not_advanced",
  "replication_sequence_behind",
  "replication_resume_unavailable",
  "authorization_denied",
  "authentication_failed",
  "pin_mismatch",
  "fleet_edge_config_invalid",
  "writer_epoch_unknown",
  "replica_unavailable",
  "invalid_field",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function isDeterministicAutoRepointRefusal(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  return code !== null && DETERMINISTIC_AUTO_REPOINT_REFUSAL_CODES.has(code);
}

export interface AutoRepointOnCenterMovedInput {
  readonly userRoot: string;
  readonly workspaceRoot: string;
  readonly repoId: string;
  readonly centerMoved: CenterMovedDetails;
  readonly repointStream?: FleetEdgeRepointStreamHooks;
  readonly readAccessToken?: () => Promise<string | undefined>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AutoRepointOnCenterMovedResult {
  readonly matchedTrustAnchorKind: "ca_path" | "spki_pin";
  readonly receipt: Record<string, unknown>;
}

/**
 * Controlled CENTER_MOVED auto-repoint inside an already-acquired `withReplicaSyncFence(repoId)`.
 * Enforces dec_AAEC26DBB6F23BDF80876ABB2C CH4/RJ3:
 * - Pre-provisioned local `trustAnchors` (`caPaths` / `spkiSha256`) are the sole trust root.
 * - `CENTER_MOVED.spkiSha256` is NEVER trusted on its own.
 * - Auto-repoint strictly forbids silent basebackup (`allowBasebackup: false`).
 * - Any refusal leaves `fleet-edge.json` byte-for-byte unchanged and cleans up staged files.
 */
export async function autoRepointFleetEdgeOnCenterMovedInsideFence(
  input: AutoRepointOnCenterMovedInput,
): Promise<AutoRepointOnCenterMovedResult> {
  const config = readFleetEdgeConfig(input.userRoot, input.repoId);
  if (!config || config.repoId !== input.repoId)
    throw new FleetEdgeConfigError(
      "fleet_edge_config_invalid",
      "A matching fleet-edge.json is required before auto-repoint.",
    );
  const viewRoot = path.isAbsolute(config.viewRoot)
      ? config.viewRoot
      : path.resolve(input.workspaceRoot, config.viewRoot),
    viewDir = path.join(viewRoot, "repos", input.repoId, "views", config.nodeId),
    generation = readReplicaGeneration(viewDir);
  if (!generation)
    throw new FleetEdgeConfigError(
      "replica_unavailable",
      "The edge has no durable replica cut for controlled auto-repoint.",
    );
  const ledger = openSqliteEventStore({
    databasePath: generation.ledgerPath,
    repoId: input.repoId,
    generation: generation.metadata.ledgerGeneration,
    readOnly: true,
  });
  let ledgerEpoch: number;
  try {
    ledgerEpoch = ledger.writerFence()?.epoch ?? 0;
  } finally {
    ledger.close();
  }
  const configWriterEpoch = config.writerEpoch ?? 0,
    localWriterEpoch = Math.max(configWriterEpoch, ledgerEpoch);
  if (localWriterEpoch === 0)
    throw new FleetEdgeConfigError(
      "writer_epoch_unknown",
      "The edge has no recorded writer epoch. Sync or repoint manually.",
    );
  const persistedPending = readFleetEdgePendingRepoint(input.userRoot, input.repoId),
    pendingRepointTarget =
      persistedPending !== null &&
      persistedPending.repoId === config.repoId &&
      persistedPending.nodeId === config.nodeId &&
      persistedPending.ledgerGeneration === generation.metadata.ledgerGeneration &&
      configWriterEpoch < persistedPending.targetWriterEpoch &&
      ledgerEpoch === persistedPending.targetWriterEpoch
        ? {
            host: persistedPending.host,
            port: persistedPending.port,
            spkiSha256: persistedPending.spkiSha256,
            previousWriterEpoch: persistedPending.previousWriterEpoch,
            targetWriterEpoch: persistedPending.targetWriterEpoch,
          }
        : null;

  const routing = {
    repoId: input.repoId,
    newExternalUrl: input.centerMoved.newExternalUrl,
    newLoginUrl: input.centerMoved.newLoginUrl,
    newEpoch: input.centerMoved.newEpoch,
    spkiSha256: input.centerMoved.spkiSha256,
  };
  const precheck = evaluateEdgeAutoRepointTarget({
    expectedRepoId: input.repoId,
    localWriterEpoch,
    trustAnchors: config.trustAnchors,
    centerMoved: routing,
    pendingRepointTarget,
  });
  if (!precheck.ok) throw new FleetEdgeConfigError(precheck.code, precheck.detail);

  const edgeDir = fleetEdgeConfigDir(input.userRoot, input.repoId),
    timeoutMs = input.timeoutMs ?? 15_000,
    probe = await probeTargetAgainstLocalTrustAnchors({
      host: precheck.targetHost,
      port: precheck.targetPort,
      caPaths: config.trustAnchors?.caPaths ?? [],
      edgeDir,
      timeoutMs,
      signal: input.signal,
    });

  const verdict = evaluateEdgeAutoRepointTarget({
    expectedRepoId: input.repoId,
    localWriterEpoch,
    trustAnchors: config.trustAnchors,
    centerMoved: routing,
    pendingRepointTarget,
    tlsEvidence: {
      verifiedByCaPath: probe.verifiedByCaPath,
      observedPeerSpkiSha256: probe.observedPeerSpkiSha256,
    },
  });
  if (!verdict.ok) throw new FleetEdgeConfigError(verdict.code, verdict.detail);

  let stagedPinnedCaPath: string | null = null,
    effectiveCaPath: string,
    spkiPinOnly = false;
  if (verdict.matchedTrustAnchorKind === "ca_path" && probe.resolvedVerifiedCaPath !== null) {
    effectiveCaPath = probe.resolvedVerifiedCaPath;
  } else if (probe.resolvedVerifiedCaPath !== null) {
    effectiveCaPath = probe.resolvedVerifiedCaPath;
  } else {
    if (!probe.peerCertificateChainPem)
      throw new FleetEdgeConfigError(
        "center_moved_untrusted_target",
        "Auto-repoint refused: target presented no certificate material matching the pre-provisioned SPKI pin.",
      );
    const previousResolvedCaPath = path.isAbsolute(config.caPath)
      ? path.resolve(config.caPath)
      : path.resolve(edgeDir, config.caPath);
    const candidatePinnedPath = writeFleetEdgePinnedCaCert(
      input.userRoot,
      input.repoId,
      verdict.normalizedTargetSpkiSha256,
      probe.peerCertificateChainPem,
    );
    if (path.resolve(candidatePinnedPath) !== previousResolvedCaPath) stagedPinnedCaPath = candidatePinnedPath;
    effectiveCaPath = candidatePinnedPath;
    spkiPinOnly = true;
  }

  try {
    const receipt = await repointFleetEdgeMirrorFenced(
      {
        userRoot: input.userRoot,
        workspaceRoot: input.workspaceRoot,
        payload: {
          host: verdict.targetHost,
          port: verdict.targetPort,
          caPath: effectiveCaPath,
          servername: verdict.targetHost,
          spkiSha256: verdict.normalizedTargetSpkiSha256,
          spkiPinOnly,
          nodeId: config.nodeId,
          credential: config.credential,
          repoId: input.repoId,
          timeoutMs: input.timeoutMs ?? 30_000,
          allowBasebackup: false,
        },
      },
      input.readAccessToken,
      input.repointStream,
      input.signal,
    );
    return {
      matchedTrustAnchorKind: verdict.matchedTrustAnchorKind,
      receipt,
    };
  } catch (error) {
    // Only remove a newly staged PEM that is NOT referenced by the intact previous fleet-edge.json.
    if (stagedPinnedCaPath !== null) removeFleetEdgePinnedCaCert(stagedPinnedCaPath);
    throw error;
  }
}

interface TlsTrustAnchorProbeResult {
  readonly verifiedByCaPath: string | null;
  readonly resolvedVerifiedCaPath: string | null;
  readonly observedPeerSpkiSha256: string | null;
  readonly peerCertificateChainPem: string | null;
}

async function probeTargetAgainstLocalTrustAnchors(input: {
  readonly host: string;
  readonly port: number;
  readonly caPaths: readonly string[];
  readonly edgeDir: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<TlsTrustAnchorProbeResult> {
  for (const configuredCaPath of input.caPaths) {
    const resolvedCaPath = path.isAbsolute(configuredCaPath)
      ? configuredCaPath
      : path.resolve(input.edgeDir, configuredCaPath);
    if (!existsSync(resolvedCaPath)) continue;
    const verified = await connectTlsProbe({
      host: input.host,
      port: input.port,
      ca: readFileSync(resolvedCaPath),
      rejectUnauthorized: true,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    if (verified.ok) {
      return {
        verifiedByCaPath: configuredCaPath,
        resolvedVerifiedCaPath: resolvedCaPath,
        observedPeerSpkiSha256: verified.spkiSha256,
        peerCertificateChainPem: verified.chainPem,
      };
    }
    if (isTransientNetworkProbeError(verified.error)) throw verified.error;
  }
  const observed = await connectTlsProbe({
    host: input.host,
    port: input.port,
    rejectUnauthorized: false,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (!observed.ok) throw observed.error;
  return {
    verifiedByCaPath: null,
    resolvedVerifiedCaPath: null,
    observedPeerSpkiSha256: observed.spkiSha256,
    peerCertificateChainPem: observed.chainPem,
  };
}

function isTransientNetworkProbeError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  return (
    code !== null &&
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ABORT_ERR"].includes(code)
  );
}

function extractPeerChainPem(peer: DetailedPeerCertificate): {
  readonly spkiSha256: string | null;
  readonly chainPem: string | null;
} {
  if (!peer.raw) return { spkiSha256: null, chainPem: null };
  const leaf = new X509Certificate(peer.raw),
    spkiSha256 = hash("sha256", leaf.publicKey.export({ type: "spki", format: "der" }), "hex"),
    pems: string[] = [leaf.toString()],
    seen = new Set<string>([peer.fingerprint256]);
  let current: DetailedPeerCertificate | undefined = peer.issuerCertificate;
  while (current && current.raw && !seen.has(current.fingerprint256)) {
    seen.add(current.fingerprint256);
    pems.push(new X509Certificate(current.raw).toString());
    current = current.issuerCertificate;
  }
  return { spkiSha256, chainPem: `${pems.join("\n")}\n` };
}

type TlsProbeOutcome =
  | { readonly ok: true; readonly spkiSha256: string | null; readonly chainPem: string | null }
  | { readonly ok: false; readonly error: Error };

function connectTlsProbe(input: {
  readonly host: string;
  readonly port: number;
  readonly ca?: Buffer;
  readonly rejectUnauthorized: boolean;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<TlsProbeOutcome> {
  if (input.signal?.aborted) {
    return Promise.resolve({
      ok: false,
      error: input.signal.reason instanceof Error ? input.signal.reason : new Error("Auto-repoint TLS probe aborted."),
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const socket: TLSSocket = tlsConnect({
      host: input.host,
      port: input.port,
      ...(input.ca ? { ca: input.ca } : {}),
      ...tlsPeerIdentityOptions(input.host),
      rejectUnauthorized: input.rejectUnauthorized,
    });
    const finish = (outcome: TlsProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("error", onError);
      socket.removeListener("secureConnect", onSecureConnect);
      input.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(outcome);
    };
    const onError = (error: Error) => finish({ ok: false, error });
    const onAbort = () =>
      finish({
        ok: false,
        error:
          input.signal?.reason instanceof Error ? input.signal.reason : new Error("Auto-repoint TLS probe aborted."),
      });
    const onSecureConnect = () => {
      const peer = socket.getPeerCertificate(true);
      if (!input.rejectUnauthorized && peer.raw) {
        const leaf = new X509Certificate(peer.raw),
          now = Date.now(),
          validFrom = Date.parse(leaf.validFrom),
          validTo = Date.parse(leaf.validTo);
        if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom || now > validTo) {
          finish({
            ok: false,
            error: new FleetEdgeConfigError("CERT_HAS_EXPIRED", "Target center certificate is expired or not valid."),
          });
          return;
        }
        const identityError = checkServerIdentity(input.host.replace(/^\[|\]$/gu, ""), peer);
        if (identityError) {
          finish({ ok: false, error: identityError });
          return;
        }
      }
      const extracted = extractPeerChainPem(peer);
      finish({ ok: true, spkiSha256: extracted.spkiSha256, chainPem: extracted.chainPem });
    };
    const timer = setTimeout(
      () => {
        finish({
          ok: false,
          error: new FleetEdgeConfigError(
            "ETIMEDOUT",
            `Auto-repoint TLS probe to ${input.host}:${String(input.port)} timed out.`,
          ),
        });
      },
      Math.max(1, input.timeoutMs),
    );
    timer.unref?.();
    socket.once("error", onError);
    socket.once("secureConnect", onSecureConnect);
    input.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Host-owned coordinator for resident edge `CENTER_MOVED` auto-repoint.
 * Serializes every attempt through `withReplicaSyncFence(repoId)`, latches deterministic refusals
 * so the stream does not spin-reconnect against a retired center, and drains in-flight work on close.
 */
export function createFleetEdgeAutoRepointCoordinator(input: {
  readonly userRoot: string;
  readonly closeSignal: AbortSignal;
  readonly isClosing: () => boolean;
  readonly withReplicaSyncFence: <T>(repoId: string, operation: () => Promise<T>) => Promise<T>;
  readonly repointStreamHooks: (repoId: string) => FleetEdgeRepointStreamHooks;
  readonly startReplicaSyncs: (admittedRepoId?: string) => void;
  readonly refreshEdgeReplicaStatus: (repoId: string) => void;
  readonly recordLifecycle?: DaemonLifecycleRecorder;
}) {
  const inFlight = new Set<Promise<void>>(),
    latched = new Map<string, string>(),
    retryTimers = new Map<string, ReturnType<typeof setTimeout>>(),
    handedOffTargets = new Map<
      string,
      { readonly viewRoot: string; readonly repoId: string; readonly nodeId: string }
    >();

  const clearRetryTimer = (repoId: string): void => {
    const timer = retryTimers.get(repoId);
    if (timer) {
      clearTimeout(timer);
      retryTimers.delete(repoId);
    }
  };

  const failHandedOff = (repoId: string, error: unknown): void => {
    const target = handedOffTargets.get(repoId);
    if (!target) return;
    handedOffTargets.delete(repoId);
    failFleetReplicaSync(target, error instanceof Error ? error : new Error(String(error)));
  };

  const triggerFromReplicaStream = (params: {
    readonly repoId: string;
    readonly nodeId: string;
    readonly workspaceRoot: string;
    readonly viewRoot: string;
    readonly connectionKey: string;
    readonly centerMoved: CenterMovedDetails;
  }): void => {
    const viewDir = path.join(params.viewRoot, "repos", params.repoId, "views", params.nodeId);
    handedOffTargets.set(params.repoId, {
      viewRoot: params.viewRoot,
      repoId: params.repoId,
      nodeId: params.nodeId,
    });
    if (input.isClosing() || input.closeSignal.aborted) {
      failHandedOff(params.repoId, new Error("Daemon host is closing."));
      return;
    }
    if (latched.get(params.repoId) === params.connectionKey) {
      failHandedOff(params.repoId, new Error("Auto-repoint is latched for this connection."));
      return;
    }
    clearRetryTimer(params.repoId);
    const task = Promise.resolve()
      .then(async () => {
        if (input.isClosing() || input.closeSignal.aborted) {
          failHandedOff(params.repoId, new Error("Daemon host is closing."));
          return;
        }
        const attempt = await input.withReplicaSyncFence<
          { readonly ok: true } | { readonly ok: false; readonly error: unknown }
        >(params.repoId, async () => {
          try {
            await autoRepointFleetEdgeOnCenterMovedInsideFence({
              userRoot: input.userRoot,
              workspaceRoot: params.workspaceRoot,
              repoId: params.repoId,
              centerMoved: params.centerMoved,
              repointStream: input.repointStreamHooks(params.repoId),
              signal: input.closeSignal,
            });
            handedOffTargets.delete(params.repoId);
            latched.delete(params.repoId);
            input.refreshEdgeReplicaStatus(params.repoId);
            return { ok: true };
          } catch (error) {
            // Latch before withReplicaSyncFence's finally calls startReplicaSyncs() so a refusal
            // does not immediately reopen a stream to the retired center and clobber replica-health.json.
            latched.set(params.repoId, params.connectionKey);
            return { ok: false, error };
          }
        });
        if (attempt.ok) return;
        const { error } = attempt;
        if (input.isClosing() || input.closeSignal.aborted) {
          failHandedOff(params.repoId, error);
          return;
        }
        if (isDeterministicAutoRepointRefusal(error)) {
          const failure = replicaFailure(error, "center_moved_untrusted_target");
          recordReplicaHealth(viewDir, { syncFailure: failure, syncProgress: null });
          failHandedOff(params.repoId, error);
          input.refreshEdgeReplicaStatus(params.repoId);
          input.recordLifecycle?.({
            event: "replica_sync_failed",
            repoId: params.repoId,
            code: failure.code,
            error: failure.message,
          });
          return;
        }
        const failure = replicaFailure(error, "replica_sync_failed");
        recordReplicaHealth(viewDir, { syncFailure: failure, syncProgress: null });
        input.refreshEdgeReplicaStatus(params.repoId);
        input.recordLifecycle?.({
          event: "replica_sync_failed",
          repoId: params.repoId,
          code: failure.code,
          error: failure.message,
        });
        if (!input.isClosing() && !input.closeSignal.aborted) {
          const timer = setTimeout(() => {
            retryTimers.delete(params.repoId);
            if (latched.get(params.repoId) === params.connectionKey) latched.delete(params.repoId);
            if (!input.isClosing() && !input.closeSignal.aborted) input.startReplicaSyncs();
          }, 250);
          timer.unref?.();
          retryTimers.set(params.repoId, timer);
        }
      })
      .catch((error: unknown) => {
        failHandedOff(params.repoId, error);
        if (
          input.isClosing() ||
          input.closeSignal.aborted ||
          (typeof error === "object" && error !== null && "code" in error && error.code === "repoint_in_progress")
        ) {
          return;
        }
        input.recordLifecycle?.({
          event: "replica_sync_failed",
          repoId: params.repoId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  };

  return {
    triggerFromReplicaStream,
    onCenterMovedFor:
      (repoId: string, nodeId: string, workspaceRoot: string, viewRoot: string, connectionKey: string) =>
      (centerMoved: CenterMovedDetails) =>
        triggerFromReplicaStream({ repoId, nodeId, workspaceRoot, viewRoot, connectionKey, centerMoved }),
    isLatched: (repoId: string, connectionKey: string) => latched.get(repoId) === connectionKey,
    clearLatch: (repoId: string) => {
      latched.delete(repoId);
      clearRetryTimer(repoId);
    },
    close: async () => {
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      await Promise.allSettled([...inFlight]);
      for (const repoId of [...handedOffTargets.keys()]) {
        failHandedOff(repoId, new Error("Daemon host closed."));
      }
    },
  };
}

/**
 * Shared repo-level transition controls bridging staged repoint stream validation and
 * concurrent manual sync preflight/commit fencing (F-26862501 / F-26862502).
 */
export function createFleetEdgeTransitionControls(input: {
  readonly replicaSyncFences: ReadonlySet<string>;
  readonly abortRunningReplicaSync: (repoId: string) => Promise<void>;
  readonly startReplicaSyncs: (admittedRepoId?: string) => void;
  readonly clearAutoRepointLatch: (repoId: string) => void;
}): {
  readonly stagedConfigFor: (repoId: string) => FleetEdgeConfig | undefined;
  readonly clearStagedConfig: (repoId: string) => void;
  readonly bumpTransitionSeq: (repoId: string) => void;
  readonly repointStreamHooks: (repoId: string) => FleetEdgeRepointStreamHooks;
  readonly edgeSyncConfigFence: FleetEdgeSyncConfigFence;
} {
  const stagedReplicaConfigs = new Map<string, FleetEdgeConfig | undefined>(),
    replicaTransitionSeq = new Map<string, number>();
  return {
    stagedConfigFor: (repoId) => stagedReplicaConfigs.get(repoId),
    clearStagedConfig: (repoId) => {
      stagedReplicaConfigs.set(repoId, undefined);
    },
    bumpTransitionSeq: (repoId) => {
      replicaTransitionSeq.set(repoId, (replicaTransitionSeq.get(repoId) ?? 0) + 1);
    },
    repointStreamHooks: (repoId) => ({
      startStagedStream: (config) => {
        stagedReplicaConfigs.set(repoId, config);
        input.startReplicaSyncs(repoId);
      },
      abortStagedStream: async () => {
        stagedReplicaConfigs.set(repoId, undefined);
        await input.abortRunningReplicaSync(repoId);
      },
      commitStagedStream: () => {
        stagedReplicaConfigs.set(repoId, undefined);
        input.startReplicaSyncs(repoId);
      },
    }),
    edgeSyncConfigFence: {
      begin: (repoId) => {
        if (input.replicaSyncFences.has(repoId))
          throw new FleetEdgeConfigError(
            "repoint_in_progress",
            `A replica stream transition for ${repoId} is already active.`,
          );
        return replicaTransitionSeq.get(repoId) ?? 0;
      },
      commit: (repoId, token, writeAndAdmit) => {
        if (input.replicaSyncFences.has(repoId))
          throw new FleetEdgeConfigError(
            "repoint_in_progress",
            `A replica stream transition for ${repoId} is already active.`,
          );
        if ((replicaTransitionSeq.get(repoId) ?? 0) !== token)
          throw new FleetEdgeConfigError(
            "replica_cut_changed",
            "The edge configuration changed during sync preflight. Retry sync against the active center.",
          );
        writeAndAdmit();
        input.clearAutoRepointLatch(repoId);
      },
    },
  };
}
