import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDaemonRegistry, type DaemonRepoMode } from "@harness-anything/kernel/daemon-registry";
import { localRuntimeStateFileSystem } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import {
  exportCenterRelocation,
  importCenterRelocation,
  openSqliteEventStore,
  publishPendingSqliteGitOutbox,
  promoteFromEdge,
  retireCenter,
  stageCenterRelocation,
  writeFileDurably,
  type ExportCenterRelocationRbacContext,
  type ImportCenterRelocationRbacContext,
} from "@harness-anything/storage";
import { daemonIdFromEnv, localUserDaemonEndpoint } from "../client/local-daemon-target.ts";
import { readFleetEdgeConfig } from "../client/fleet-edge-config.ts";
import { requestDaemonJsonRpcAt } from "../client/local-json-rpc-client.ts";
import { acquireDaemonSingleton, daemonSocketProbe } from "../daemon-singleton.ts";
import { localSystemBinding } from "../daemon-host-binding.ts";
import { requireAuthorizedHostAction } from "../host-action-authorization.ts";
import {
  rbacBackupStatuses,
  type RbacBackupStatus,
} from "@harness-anything/kernel/internal/domain/status-vocabulary.ts";
import { parseFleetCenterExternalUrl, readFleetCenterConfig, saveFleetCenterConfig } from "../fleet-center-config.ts";
import { readReplicaGeneration } from "../../fleet-sync/fleet/replica-generation.ts";
import { readReplicaHealth } from "../../fleet-sync/fleet/replica-health.ts";
import { switchFleetCenter, type FleetCenterSwitchoverHooks } from "./center-switchover-command.ts";

export interface EdgeLocalStateSnapshot {
  readonly ok: true;
  readonly mode: DaemonRepoMode | null;
  readonly repoId: string;
  readonly nodeId: string | null;
  readonly configuredCenter: { readonly host: string; readonly port: number } | null;
  readonly localRevision: number | null;
  readonly localSequence: number | null;
  readonly writerEpoch: number | null;
  readonly syncFailureCode: string | null;
  readonly canPromote: boolean;
}

/**
 * Purely local read-only summary of an edge repository's local mirror state.
 * Never dials or forwards to the configured center, and never exposes machine credentials.
 */
export function readFleetEdgeLocalState(input: {
  readonly userRoot: string;
  readonly repoId: string;
}): EdgeLocalStateSnapshot {
  const userRoot = path.resolve(input.userRoot),
    repoId = input.repoId,
    repo = readDaemonRegistry({ userRoot }).repos.find((entry) => entry.repoId === repoId),
    mode: DaemonRepoMode | null = repo?.mode ?? null,
    canonicalRoot: string | null = repo?.canonicalRoot ?? null,
    edge = readFleetEdgeConfig(userRoot, repoId, canonicalRoot ?? undefined);
  if (!edge || edge.repoId !== repoId) {
    return {
      ok: true,
      mode,
      repoId,
      nodeId: null,
      configuredCenter: null,
      localRevision: null,
      localSequence: null,
      writerEpoch: null,
      syncFailureCode: "fleet_edge_config_missing",
      canPromote: false,
    };
  }
  const configuredCenter = { host: edge.host, port: edge.port },
    writerEpoch = edge.writerEpoch ?? null;
  if (!canonicalRoot) {
    return {
      ok: true,
      mode,
      repoId,
      nodeId: edge.nodeId,
      configuredCenter,
      localRevision: null,
      localSequence: null,
      writerEpoch,
      syncFailureCode: "repo_canonical_root_missing",
      canPromote: false,
    };
  }
  const viewRoot = path.isAbsolute(edge.viewRoot) ? edge.viewRoot : path.resolve(canonicalRoot, edge.viewRoot),
    viewDir = path.join(viewRoot, "repos", repoId, "views", edge.nodeId),
    health = readReplicaHealth(viewDir),
    generation = readReplicaGeneration(viewDir);
  let localRevision: number | null = null,
    localSequence: number | null = null,
    hasValidGeneration = false;
  if (generation && generation.metadata.repoId === repoId && existsSync(generation.ledgerPath)) {
    hasValidGeneration = true;
    const ledger = openSqliteEventStore({
      databasePath: generation.ledgerPath,
      repoId,
      generation: generation.metadata.ledgerGeneration,
      readOnly: true,
    });
    try {
      localRevision = ledger.revision();
      localSequence = ledger.replicationPosition().sequence;
    } finally {
      ledger.close();
    }
  }
  const syncFailureCode =
    health.modelFailure?.code ?? health.syncFailure?.code ?? (hasValidGeneration ? null : "replica_unavailable");
  return {
    ok: true,
    mode,
    repoId,
    nodeId: edge.nodeId,
    configuredCenter,
    localRevision,
    localSequence,
    writerEpoch,
    syncFailureCode,
    canPromote: mode === "remote-edge" && hasValidGeneration,
  };
}

export interface FleetCenterRelocationOutcome {
  readonly receipt: Record<string, unknown>;
  readonly exitCode: number;
}

export interface FleetCenterRelocationHooks {
  readonly freezeAndDrain?: (context: {
    readonly repoId: string;
    readonly rootDir: string;
    readonly userRoot: string;
    readonly daemonId: string;
  }) => void | Promise<void>;
  readonly exportRbacBundle?: (context: ExportCenterRelocationRbacContext) => void | Promise<void>;
  readonly importRbacBundle?: (context: ImportCenterRelocationRbacContext) => void | Promise<void>;
  readonly switchover?: FleetCenterSwitchoverHooks;
}

export interface CenterRelocationRoutingV1 {
  readonly schema: "center-routing/v1";
  readonly repoId: string;
  readonly externalUrl?: string;
  readonly loginUrl?: string;
  readonly writerEpoch: number;
  readonly updatedAt: string;
}

export function centerRelocationRoutingPath(stateRoot: string, repoId: string): string {
  return path.join(path.resolve(stateRoot), "center-routing", `${repoId}.json`);
}

export function readCenterRelocationRouting(stateRoot: string, repoId: string): CenterRelocationRoutingV1 | null {
  const file = centerRelocationRoutingPath(stateRoot, repoId);
  if (!localRuntimeStateFileSystem.exists(file)) return null;
  const parsed = JSON.parse(localRuntimeStateFileSystem.readText(file)) as Partial<CenterRelocationRoutingV1>;
  if (parsed.schema !== "center-routing/v1" || parsed.repoId !== repoId || !Number.isSafeInteger(parsed.writerEpoch))
    return null;
  return parsed as CenterRelocationRoutingV1;
}

function parseCenterLoginUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Fleet center --login-url must be a valid HTTP or HTTPS URL.");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username !== "" || parsed.password !== "")
    throw new Error("Fleet center --login-url must use http:// or https:// without embedded credentials.");
  return parsed.toString().replace(/\/$/u, "");
}

export function rebindCenterRelocationRouting(input: {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly stateRoot: string;
  readonly repoId: string;
  readonly writerEpoch: number;
  readonly externalUrl?: string;
  readonly loginUrl?: string;
}): CenterRelocationRoutingV1 {
  const previous = readCenterRelocationRouting(input.stateRoot, input.repoId),
    externalUrl = input.externalUrl ?? previous?.externalUrl,
    loginUrl = input.loginUrl ?? previous?.loginUrl,
    routing: CenterRelocationRoutingV1 = {
      schema: "center-routing/v1",
      repoId: input.repoId,
      ...(externalUrl ? { externalUrl } : {}),
      ...(loginUrl ? { loginUrl } : {}),
      writerEpoch: input.writerEpoch,
      updatedAt: new Date().toISOString(),
    };
  writeFileDurably(
    centerRelocationRoutingPath(input.stateRoot, input.repoId),
    `${JSON.stringify(routing, null, 2)}\n`,
    0o600,
  );
  if (externalUrl) {
    const existingCenterConfig = readFleetCenterConfig(input.userRoot, input.daemonId);
    if (existingCenterConfig) {
      saveFleetCenterConfig(input.userRoot, input.daemonId, {
        ...existingCenterConfig,
        repoId: input.repoId,
        stateRoot: path.resolve(input.stateRoot),
        externalUrl,
      });
    }
  }
  if (loginUrl) {
    const rbacConfigFile = path.join(path.resolve(input.userRoot), "rbac", "config.json");
    if (localRuntimeStateFileSystem.exists(rbacConfigFile)) {
      const current = JSON.parse(localRuntimeStateFileSystem.readText(rbacConfigFile)) as Record<string, unknown>;
      writeFileDurably(rbacConfigFile, `${JSON.stringify({ ...current, url: loginUrl }, null, 2)}\n`, 0o600);
    }
  }
  return routing;
}

export async function drainLocalDaemonRepoQueue(userRoot: string, daemonId: string, repoId: string): Promise<boolean> {
  const endpoint = localUserDaemonEndpoint(userRoot, daemonId);
  if (!(await daemonSocketProbe(endpoint))) return false;
  for (let step = 0; step < 80; step += 1) {
    if (!(await daemonSocketProbe(endpoint))) return true;
    const current = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 75, 75, undefined, true),
      repos = Array.isArray(current.repos) ? current.repos : [],
      row = repos.find(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry) && entry.repoId === repoId,
      ),
      depth = typeof row?.queueDepth === "number" ? row.queueDepth : 0;
    if (depth === 0) return true;
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  throw new Error(
    `Center repository ${repoId} still has queued writes during CENTER_MIGRATING drain; wait and rerun export.`,
  );
}

export async function relocateFleetCenter(
  argv: readonly string[],
  defaultUserRoot: string = path.join(os.homedir(), ".harness"),
  hooks?: FleetCenterRelocationHooks,
): Promise<FleetCenterRelocationOutcome> {
  const centerIndex = argv.indexOf("center"),
    operation = centerIndex < 0 ? undefined : argv[centerIndex + 1];
  if (operation === "export") return await exportBundle(argv, defaultUserRoot, hooks);
  if (operation === "import") return await importBundle(argv, defaultUserRoot, hooks);
  if (operation === "retire") return retireOldCenter(argv, defaultUserRoot);
  if (operation === "promote-from-edge") return await promoteEdge(argv, defaultUserRoot);
  if (operation === "switch")
    return await switchFleetCenter(argv, defaultUserRoot, hooks?.switchover, {
      drainLocalDaemonRepoQueue,
      rebindCenterRelocationRouting,
    });
  return failureOutcome(
    "fleet-center",
    "unsupported_command",
    "Use ha fleet center export|import|retire|switch with the operation flags.",
  );
}

async function promoteEdge(argv: readonly string[], defaultUserRoot: string): Promise<FleetCenterRelocationOutcome> {
  // Check confirmations before resolving paths or opening storage. Missing either flag is a
  // zero-side-effect refusal, which keeps accidental shell retries harmless.
  if (!argv.includes("--force-new-epoch") || !argv.includes("--confirm-possible-tail-loss"))
    return failureOutcome(
      "fleet-center-promote-from-edge",
      "missing_confirmation",
      "Break-glass promotion requires both --force-new-epoch and --confirm-possible-tail-loss.",
    );
  const missing = missingFlags(argv, ["--root", "--repo", "--state-root"]);
  if (missing.length > 0)
    return failureOutcome(
      "fleet-center-promote-from-edge",
      "missing_field",
      `Add ${missing.join(" ")} to promote the edge replica.`,
    );
  const userRoot = path.resolve(flagValue(argv, "--user-root") ?? defaultUserRoot),
    daemonId = flagValue(argv, "--daemon-id") ?? daemonIdFromEnv();
  const rbacStatus = flagValue(argv, "--rbac-backup-status");
  if (rbacStatus !== undefined && !(rbacBackupStatuses as readonly string[]).includes(rbacStatus))
    return failureOutcome(
      "fleet-center-promote-from-edge",
      "invalid_field",
      "--rbac-backup-status must be verified, unavailable, or unknown.",
    );
  const rootInput = path.resolve(flagValue(argv, "--root")!),
    repoId = flagValue(argv, "--repo")!,
    edge = readFleetEdgeConfig(userRoot, repoId);
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(repoId)) throw new Error("--repo must be a valid repository id");
  if (!edge || edge.repoId !== repoId)
    throw new Error("The user root must contain fleet-edge.json for the requested repository");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(edge.nodeId))
    throw new Error("fleet-edge.json nodeId is invalid for a replica view path");
  const ownership = await requireAuthorizedHostAction({
    kind: "daemon-fleet-center-promote-from-edge",
    binding: localSystemBinding(rootInput),
    actionId: `center-promote-from-edge:${repoId}`,
    evaluatedAtCut: "host-local:current",
    repoId,
  });
  const singleton = await acquireDaemonSingleton({
    userRoot,
    daemonId,
    endpoint: localUserDaemonEndpoint(userRoot, daemonId),
  });
  if (singleton.claim === "incumbent")
    return failureOutcome(
      "fleet-center-promote-from-edge",
      "edge_daemon_running",
      "Stop the edge daemon before promotion so its receiver cannot replace or collect the published replica generation.",
    );
  try {
    const replicaRoot = path.resolve(rootInput, edge.viewRoot, "repos", repoId, "views", edge.nodeId),
      replica = readReplicaGeneration(replicaRoot);
    if (!replica || replica.metadata.repoId !== repoId)
      throw new Error(`edge replica generation is unavailable for repository ${repoId} and node ${edge.nodeId}`);
    const result = await promoteFromEdge({
      rootInput,
      repoId,
      replicaDatabasePath: replica.ledgerPath,
      replicaGeneration: replica.metadata.ledgerGeneration,
      replicaPosition: replica.metadata.position,
      stateRoot: path.resolve(flagValue(argv, "--state-root")!),
      ...(flagValue(argv, "--holder-id") ? { holderId: flagValue(argv, "--holder-id") } : {}),
      forceNewEpoch: true,
      confirmPossibleTailLoss: true,
      ...(edge.writerEpoch === undefined ? {} : { observedWriterEpoch: edge.writerEpoch }),
      rbacBackupStatus: rbacStatus as RbacBackupStatus | undefined,
    });
    return appliedOutcome({
      command: "fleet-center-promote-from-edge",
      outcome: "applied",
      event: "center_emergency_promoted",
      ...result,
      authorizationDecision: ownership,
      summary: `fleet-center-promote-from-edge: promoted ${result.repoId} at epoch ${String(result.newEpoch)}`,
      nextAction:
        result.rbacBackupStatus === "verified"
          ? "Start the new center and repoint edges explicitly."
          : "Verify or restore the RBAC backup before admitting edge writes, then repoint edges explicitly.",
    });
  } finally {
    singleton.release();
  }
}

async function exportBundle(
  argv: readonly string[],
  defaultUserRoot: string,
  hooks?: FleetCenterRelocationHooks,
): Promise<FleetCenterRelocationOutcome> {
  const missing = missingFlags(argv, ["--root", "--bundle", "--repo", "--writer-epoch"]);
  if (missing.length > 0)
    return failureOutcome(
      "fleet-center-export",
      "missing_field",
      `Add ${missing.join(" ")} to export the center bundle.`,
    );
  const writerEpoch = nonnegativeIntFlag(argv, "--writer-epoch");
  if (writerEpoch === null || writerEpoch < 1)
    return failureOutcome("fleet-center-export", "invalid_field", "--writer-epoch must be a positive safe integer.");
  const resolvedRoot = path.resolve(flagValue(argv, "--root")!),
    resolvedBundle = path.resolve(flagValue(argv, "--bundle")!),
    repoId = flagValue(argv, "--repo")!,
    userRoot = path.resolve(flagValue(argv, "--user-root") ?? defaultUserRoot),
    stateRoot = path.resolve(flagValue(argv, "--state-root") ?? path.join(userRoot, "fleet")),
    daemonId = flagValue(argv, "--daemon-id") ?? daemonIdFromEnv(),
    slots = flagValue(argv, "--slots");
  const exportRbacBundle = hooks?.exportRbacBundle ?? (await defaultRbacExportHook(userRoot, daemonId)),
    // Phase 1 (outside CENTER_MIGRATING write freeze): pre-stage blobs and working tree.
    stage = stageCenterRelocation({ rootInput: resolvedRoot, bundleDir: resolvedBundle }),
    exported = await exportCenterRelocation({
      rootInput: resolvedRoot,
      bundleDir: resolvedBundle,
      repoId,
      writerEpoch,
      userRoot,
      stateRoot,
      stage,
      ...(slots ? { replicationSlotsPath: path.resolve(slots) } : {}),
      ...(exportRbacBundle ? { exportRbacBundle } : {}),
      freezeAndDrain: async () => {
        if (hooks?.freezeAndDrain) {
          await hooks.freezeAndDrain({ repoId, rootDir: resolvedRoot, userRoot, daemonId });
          return;
        }
        const drainedLiveDaemon = await drainLocalDaemonRepoQueue(userRoot, daemonId, repoId);
        if (
          !drainedLiveDaemon &&
          localRuntimeStateFileSystem.exists(path.join(resolvedRoot, ".git")) &&
          localRuntimeStateFileSystem.exists(
            path.join(resolvedRoot, ".harness", "store", "generations", "3", "ledger.sqlite"),
          )
        ) {
          await publishPendingSqliteGitOutbox({ rootDir: resolvedRoot, repoId });
        }
      },
    });
  return appliedOutcome({
    command: "fleet-center-export",
    manifest: exported.manifest,
    bundleDir: resolvedBundle,
    summary: `fleet-center-export: exported ${repoId} at revision ${String(exported.manifest.finalRevision)}`,
    nextAction: "Run ha fleet center retire after the final edge acknowledgement, then import on the new center.",
  });
}

async function importBundle(
  argv: readonly string[],
  defaultUserRoot: string,
  hooks?: FleetCenterRelocationHooks,
): Promise<FleetCenterRelocationOutcome> {
  const missing = missingFlags(argv, ["--bundle", "--destination"]);
  if (missing.length > 0)
    return failureOutcome(
      "fleet-center-import",
      "missing_field",
      `Add ${missing.join(" ")} to import the center bundle.`,
    );
  const rawExternalUrl = flagValue(argv, "--external-url"),
    rawLoginUrl = flagValue(argv, "--login-url");
  let externalUrl: string | undefined, loginUrl: string | undefined;
  if (rawExternalUrl !== undefined) {
    externalUrl = parseFleetCenterExternalUrl(rawExternalUrl);
  } else if (argv.includes("--external-url")) {
    return failureOutcome("fleet-center-import", "missing_field", "Add an HTTPS origin after --external-url.");
  }
  if (rawLoginUrl !== undefined) {
    loginUrl = parseCenterLoginUrl(rawLoginUrl);
  } else if (argv.includes("--login-url")) {
    return failureOutcome("fleet-center-import", "missing_field", "Add an HTTP(S) URL after --login-url.");
  }
  const hasExpectedRevisionFlag = argv.includes("--expected-final-revision"),
    expectedFinalRevision = hasExpectedRevisionFlag ? nonnegativeIntFlag(argv, "--expected-final-revision") : undefined;
  if (hasExpectedRevisionFlag && expectedFinalRevision === null)
    return failureOutcome(
      "fleet-center-import",
      "invalid_field",
      "--expected-final-revision must be a nonnegative safe integer.",
    );
  const expectedTipHash = flagValue(argv, "--expected-tip-hash");
  if (argv.includes("--expected-tip-hash") && expectedTipHash === undefined)
    return failureOutcome("fleet-center-import", "missing_field", "Add a tip digest after --expected-tip-hash.");

  const bundle = flagValue(argv, "--bundle")!,
    destination = flagValue(argv, "--destination")!,
    userRoot = path.resolve(flagValue(argv, "--user-root") ?? defaultUserRoot),
    daemonId = flagValue(argv, "--daemon-id") ?? daemonIdFromEnv(),
    stateRoot = path.resolve(flagValue(argv, "--state-root") ?? path.join(userRoot, "fleet")),
    slots = flagValue(argv, "--slots"),
    expectedRepoId = flagValue(argv, "--repo"),
    importRbacBundle = hooks?.importRbacBundle ?? defaultRbacImportHook(userRoot, daemonId, loginUrl),
    imported = await importCenterRelocation({
      bundleDir: path.resolve(bundle),
      destinationRoot: path.resolve(destination),
      stateRoot,
      ...(slots ? { replicationSlotsPath: path.resolve(slots) } : {}),
      ...(expectedRepoId ? { expectedRepoId } : {}),
      ...(expectedFinalRevision !== undefined && expectedFinalRevision !== null ? { expectedFinalRevision } : {}),
      ...(expectedTipHash ? { expectedTipHash } : {}),
      importRbacBundle,
    }),
    routing = rebindCenterRelocationRouting({
      userRoot,
      daemonId,
      stateRoot,
      repoId: imported.manifest.repoId,
      writerEpoch: imported.newEpoch,
      ...(externalUrl ? { externalUrl } : {}),
      ...(loginUrl ? { loginUrl } : {}),
    });
  return appliedOutcome({
    command: "fleet-center-import",
    repoId: imported.manifest.repoId,
    finalRevision: imported.manifest.finalRevision,
    tipHash: imported.manifest.tipHash,
    oldEpoch: imported.manifest.writerEpoch,
    newEpoch: imported.newEpoch,
    restoredRoot: imported.restoredRoot,
    ...(routing.externalUrl ? { externalUrl: routing.externalUrl } : {}),
    ...(routing.loginUrl ? { loginUrl: routing.loginUrl } : {}),
    summary: `fleet-center-import: restored ${imported.manifest.repoId} at epoch ${String(imported.newEpoch)}`,
    nextAction:
      `Run ha edge repoint --external-url ${routing.externalUrl ?? "<new-url>"} ` +
      `--login-url ${routing.loginUrl ?? "<new-login-url>"} --epoch ${String(imported.newEpoch)}.`,
  });
}

function retireOldCenter(argv: readonly string[], defaultUserRoot: string): FleetCenterRelocationOutcome {
  const missing = missingFlags(argv, [
    "--repo",
    "--old-epoch",
    "--final-revision",
    "--tip-hash",
    "--new-external-url",
    "--new-login-url",
    "--spki-sha256",
  ]);
  if (missing.length > 0)
    return failureOutcome("fleet-center-retire", "missing_field", `Add ${missing.join(" ")} to retire the old center.`);
  const oldEpoch = nonnegativeIntFlag(argv, "--old-epoch"),
    finalRevision = nonnegativeIntFlag(argv, "--final-revision");
  if (oldEpoch === null || oldEpoch < 1 || finalRevision === null)
    return failureOutcome(
      "fleet-center-retire",
      "invalid_field",
      "--old-epoch must be positive and --final-revision must be a nonnegative safe integer.",
    );
  const userRoot = flagValue(argv, "--user-root") ?? defaultUserRoot,
    tombstone = retireCenter({
      userRoot,
      repoId: flagValue(argv, "--repo")!,
      oldEpoch,
      finalRevision,
      tipHash: flagValue(argv, "--tip-hash")!,
      newExternalUrl: flagValue(argv, "--new-external-url")!,
      newLoginUrl: flagValue(argv, "--new-login-url")!,
      spkiSha256: flagValue(argv, "--spki-sha256")!,
    });
  return appliedOutcome({
    command: "fleet-center-retire",
    tombstone,
    summary: `fleet-center-retire: fenced ${tombstone.repoId} epoch ${String(tombstone.oldEpoch)} -> ${String(tombstone.newEpoch)}`,
    nextAction:
      `Old-center writes are fenced. Run ha edge repoint --external-url ${tombstone.newExternalUrl} ` +
      `--login-url ${tombstone.newLoginUrl} --epoch ${String(tombstone.newEpoch)}.`,
  });
}

async function defaultRbacExportHook(
  userRoot: string,
  daemonId: string,
): Promise<FleetCenterRelocationHooks["exportRbacBundle"] | undefined> {
  const { readProviderMode } = await import("../authorization-provider.ts"),
    mode = readProviderMode(userRoot);
  if (mode === "builtin" || mode === "external") return undefined;
  return async ({ payloadRbacDir }) => {
    await runManagedRbacRelocationOperation(userRoot, daemonId, {
      operation: "relocation-export",
      backupDir: payloadRbacDir,
    });
  };
}

function defaultRbacImportHook(
  userRoot: string,
  daemonId: string,
  loginUrl: string | undefined,
): NonNullable<FleetCenterRelocationHooks["importRbacBundle"]> {
  return async ({ payloadRbacDir, manifest }) => {
    if (!manifest.files.some(({ path: file }) => file === "rbac/manifest.json")) return;
    if (!loginUrl) throw new Error("Relocation import requires --login-url when the bundle contains managed RBAC.");
    const { readProviderMode } = await import("../authorization-provider.ts"),
      mode = readProviderMode(userRoot);
    if (mode === "builtin")
      throw new Error("Configure the target managed RBAC service before importing this relocation bundle.");
    if (mode === "external")
      throw new Error("Managed RBAC relocation cannot import into an external identity provider.");
    await runManagedRbacRelocationOperation(userRoot, daemonId, {
      operation: "relocation-import",
      backupDir: payloadRbacDir,
      loginUrl,
    });
  };
}

async function runManagedRbacRelocationOperation(
  userRoot: string,
  daemonId: string,
  payload:
    | { readonly operation: "relocation-export"; readonly backupDir: string }
    | {
        readonly operation: "relocation-import";
        readonly backupDir: string;
        readonly loginUrl: string;
      },
): Promise<void> {
  const result = await requestDaemonJsonRpcAt(
    localUserDaemonEndpoint(userRoot, daemonId),
    "daemon.rbac.manage",
    payload,
    5_000,
    600_000,
  );
  if (result.ok !== true)
    throw new Error(
      `Managed RBAC ${payload.operation} failed: ${String(result.message ?? result.code ?? "unknown failure")}`,
    );
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag),
    value = index < 0 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function missingFlags(argv: readonly string[], flags: readonly string[]): readonly string[] {
  return flags.filter((flag) => flagValue(argv, flag) === undefined);
}

function nonnegativeIntFlag(argv: readonly string[], flag: string): number | null {
  const raw = flagValue(argv, flag);
  if (raw === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function appliedOutcome(receipt: Record<string, unknown>): FleetCenterRelocationOutcome {
  return {
    receipt: { schema: "command-receipt/v2", ok: true, outcome: "applied", ...receipt },
    exitCode: 0,
  };
}

function failureOutcome(command: string, code: string, hint: string): FleetCenterRelocationOutcome {
  return {
    receipt: {
      schema: "command-receipt/v2",
      ok: false,
      command,
      outcome: "op_rejected",
      code,
      error: { code, hint },
    },
    exitCode: 2,
  };
}
