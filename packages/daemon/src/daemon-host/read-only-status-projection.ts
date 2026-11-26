import { projectRuntimeProviderHealth } from "@harness-anything/kernel";
import { scrubSecretText } from "../runtime-engine/secret-scrub.ts";
import type { FleetFieldState, FleetOverviewResult } from "./fleet/fleet-overview-read.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { executionCredentialRejected } from "./runtime-execution-credential.ts";

const credentialRefPattern = /\b(?:credential:v1:[a-z0-9-]+|keychain:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\b/giu;
const fileUrlPattern = /\bfile:\/\/[^\s"'`,;)}\]]+/giu;
const urlQueryPattern = /(https?:\/\/[^\s"'`,;)}\]?]+)\?[^\s"'`,;)}\]]+/giu;
const windowsAbsPathPattern = /\b[A-Za-z]:(?:\\|\/)[^\s"'`,;)}\]]+/gu;
const homeRelativePathPattern = /(^|[\s"'`=:(,])~\/[^\s"'`,;)}\]]+/gu;
const posixAbsPathPattern = /(^|[\s"'`=:(,])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/gu;
const posixTopPathPattern =
  /(^|[\s"'`=:(,])\/(?:Users|home|var|tmp|private|etc|opt|srv|root|Volumes|mnt|proc|sys|run|Library|Applications|usr|bin|sbin|dev|System)(?:\/[^\s"'`,;)}\]]*)?/gu;

function sanitizeReadOnlyText(text: string): string {
  return scrubSecretText(text)
    .replace(credentialRefPattern, "[REDACTED]")
    .replace(fileUrlPattern, "[REDACTED_PATH]")
    .replace(urlQueryPattern, "$1?[REDACTED]")
    .replace(windowsAbsPathPattern, "[REDACTED_PATH]")
    .replace(homeRelativePathPattern, "$1[REDACTED_PATH]")
    .replace(posixTopPathPattern, "$1[REDACTED_PATH]")
    .replace(posixAbsPathPattern, "$1[REDACTED_PATH]");
}

function sanitizeOptionalText(value: unknown): string | null {
  return typeof value === "string" ? sanitizeReadOnlyText(value) : null;
}

function sanitizeFieldState(state: FleetFieldState): FleetFieldState {
  if (state.kind === "value") return { kind: "value", text: sanitizeReadOnlyText(state.text) };
  if (state.kind === "redacted") return { kind: "redacted", reason: sanitizeReadOnlyText(state.reason) };
  return { kind: "unavailable", reason: sanitizeReadOnlyText(state.reason) };
}

function projectReadOnlyConfiguration(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>,
    projected: Record<string, unknown> = {};
  if (source.effort === null || typeof source.effort === "string") projected.effort = source.effort;
  if (source.reasoningEffort === null || typeof source.reasoningEffort === "string")
    projected.reasoningEffort = source.reasoningEffort;
  if (typeof source.fast === "boolean") projected.fast = source.fast;
  if (typeof source.webSearch === "string") projected.webSearch = source.webSearch;
  if (typeof source.baseUrlConfigured === "boolean") projected.baseUrlConfigured = source.baseUrlConfigured;
  return projected;
}

function projectReadOnlyRuntimeInstance(
  row: Record<string, unknown>,
  nodeId: string,
  now: string,
): Record<string, unknown> {
  const rawReadiness =
      row.authReadiness !== null && typeof row.authReadiness === "object" && !Array.isArray(row.authReadiness)
        ? (row.authReadiness as Record<string, unknown>)
        : {},
    rawHealth =
      row.providerHealth !== null && typeof row.providerHealth === "object" && !Array.isArray(row.providerHealth)
        ? (row.providerHealth as Record<string, unknown>)
        : {},
    stringField = (value: unknown): string | null => (typeof value === "string" ? value : null),
    optionalNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined),
    optionalNullableString = (value: unknown): string | null | undefined =>
      value === null || typeof value === "string" ? value : undefined,
    tierValue = optionalNumber(row.tier),
    mcpSetting = optionalNullableString(row.mcpPolicy),
    projectedHealth = projectRuntimeProviderHealth(
      {
        frozen: rawHealth.frozen === true,
        cooldownUntil: stringField(rawHealth.cooldownUntil),
        frozenUntil: stringField(rawHealth.frozenUntil),
        quotaExhaustedUntil: stringField(rawHealth.quotaExhaustedUntil),
        reason: stringField(rawHealth.reason),
      },
      now,
    );
  return {
    schemaVersion: 2,
    instanceId: String(row.instanceId ?? ""),
    name: sanitizeReadOnlyText(String(row.name ?? "")),
    kindId: String(row.kindId ?? ""),
    providerId: String(row.providerId ?? ""),
    models: Array.isArray(row.models) ? row.models.filter((entry): entry is string => typeof entry === "string") : [],
    ...(Array.isArray(row.availableModels)
      ? { availableModels: row.availableModels.filter((entry): entry is string => typeof entry === "string") }
      : {}),
    defaultModel: typeof row.defaultModel === "string" ? row.defaultModel : "",
    enabled: row.enabled === true,
    ...(tierValue !== undefined ? { tier: tierValue } : {}),
    authMode: row.authMode === "api-key" ? "api-key" : "subscription",
    authState: typeof row.authState === "string" ? row.authState : "unknown",
    authReadiness: {
      status: typeof rawReadiness.status === "string" ? rawReadiness.status : "unavailable",
      code: typeof rawReadiness.code === "string" ? rawReadiness.code : null,
      hint: null,
      ...(rawReadiness.basis === "metadata" || rawReadiness.basis === "provider" ? { basis: rawReadiness.basis } : {}),
    },
    ...(row.permissionMode === null || typeof row.permissionMode === "string"
      ? { permissionMode: row.permissionMode }
      : {}),
    ...(mcpSetting !== undefined ? { mcpPolicy: mcpSetting } : {}),
    ...(typeof row.isolationState === "string" ? { isolationState: row.isolationState } : {}),
    ...(row.quota !== undefined ? { quota: row.quota } : {}),
    configuration: projectReadOnlyConfiguration(row.configuration),
    providerHealth: {
      nodeId: typeof rawHealth.nodeId === "string" ? rawHealth.nodeId : nodeId,
      status: projectedHealth.status,
      failureStreak: typeof rawHealth.failureStreak === "number" ? rawHealth.failureStreak : 0,
      cooldownUntil: stringField(rawHealth.cooldownUntil),
      frozen: rawHealth.frozen === true,
      frozenUntil: stringField(rawHealth.frozenUntil),
      reason: sanitizeOptionalText(rawHealth.reason),
      lastFailureAt: stringField(rawHealth.lastFailureAt),
      lastResetAt: stringField(rawHealth.lastResetAt),
      ...(rawHealth.quotaExhaustedUntil !== undefined
        ? { quotaExhaustedUntil: stringField(rawHealth.quotaExhaustedUntil) }
        : {}),
      ...(rawHealth.quotaObservedAt !== undefined ? { quotaObservedAt: stringField(rawHealth.quotaObservedAt) } : {}),
    },
  };
}

function formatReadOnlyRuntimeInstanceListSummary(instances: readonly Record<string, unknown>[], now: string): string {
  return [
    "NODE\tID\tNAME\tKIND\tPROVIDER\tDEFAULT MODEL\tMODELS\tENABLED\tHEALTH\tREASON\tRECOVER AT",
    ...instances.map((row) => {
      const health = row.providerHealth as Record<string, unknown>,
        stringField = (value: unknown): string | null => (typeof value === "string" ? value : null),
        projected = projectRuntimeProviderHealth(
          {
            frozen: health.frozen === true,
            cooldownUntil: stringField(health.cooldownUntil),
            frozenUntil: stringField(health.frozenUntil),
            quotaExhaustedUntil: stringField(health.quotaExhaustedUntil),
            reason: stringField(health.reason),
          },
          now,
        );
      return [
        String(health.nodeId ?? ""),
        String(row.instanceId ?? ""),
        String(row.name ?? ""),
        String(row.kindId ?? ""),
        String(row.providerId ?? ""),
        String(row.defaultModel ?? ""),
        Array.isArray(row.models) ? row.models.join(",") : "",
        row.enabled === true ? "enabled" : "disabled",
        projected.status,
        projected.reason ?? "-",
        projected.recoverAt ?? "-",
      ].join("\t");
    }),
  ].join("\n");
}

/** Strict server-side allowlist projection for read-only `daemon.runtimeInstance.list`. */
export function projectReadOnlyRuntimeInstanceList(input: {
  readonly instances: readonly Record<string, unknown>[];
  readonly nodeId: string;
  readonly now: string;
}): JsonObject {
  const instances = input.instances.map((row) => projectReadOnlyRuntimeInstance(row, input.nodeId, input.now));
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "runtime-instance-list",
    outcome: "applied",
    opId: "runtime-instance-list:all",
    nodeId: input.nodeId,
    instances,
    evidence: JSON.stringify({ nodeId: input.nodeId, instances }),
    summary: formatReadOnlyRuntimeInstanceListSummary(instances, input.now),
  } as JsonObject;
}

function sanitizeRedactableRows<T>(
  rows: readonly T[] | { readonly redacted: string },
  mapRow: (row: T) => T,
): readonly T[] | { readonly redacted: string } {
  return "redacted" in rows ? { redacted: sanitizeReadOnlyText(rows.redacted) } : rows.map(mapRow);
}

/** Strict server-side repo-bound sanitization for read-only `repo.fleet.overview.read`. */
export function projectReadOnlyFleetOverview(overview: FleetOverviewResult, boundRepoId: string): FleetOverviewResult {
  if (overview.repoId !== boundRepoId) throw executionCredentialRejected();
  const nodes = overview.nodes
    .filter((node) => node.role === "center" || node.replica === null || node.replica.repoId === boundRepoId)
    .map((node) => ({
      nodeId: node.nodeId,
      role: node.role,
      owner: sanitizeFieldState(node.owner),
      build: sanitizeFieldState(node.build),
      online: sanitizeFieldState(node.online),
      leases: sanitizeRedactableRows(node.leases, (lease) => ({
        ...lease,
        title: lease.title === null ? null : sanitizeReadOnlyText(lease.title),
      })),
      ...(node.recentTasks === undefined
        ? {}
        : {
            recentTasks: sanitizeRedactableRows(node.recentTasks, (task) => ({
              ...task,
              title: task.title === null ? null : sanitizeReadOnlyText(task.title),
            })),
          }),
      ...(node.recentDispatches === undefined
        ? {}
        : {
            recentDispatches: sanitizeRedactableRows(node.recentDispatches, (dispatch) => ({
              ...dispatch,
              taskTitle: dispatch.taskTitle === null ? null : sanitizeReadOnlyText(dispatch.taskTitle),
            })),
          }),
      ...(node.recentEvents === undefined
        ? {}
        : {
            recentEvents: sanitizeRedactableRows(node.recentEvents, (event) => ({
              ...event,
              title: event.title === null ? null : sanitizeReadOnlyText(event.title),
            })),
          }),
      replica:
        node.replica === null
          ? null
          : {
              ...node.replica,
              syncFailure:
                node.replica.syncFailure === null
                  ? null
                  : {
                      ...node.replica.syncFailure,
                      message: sanitizeReadOnlyText(node.replica.syncFailure.message),
                    },
            },
      replicaReason: sanitizeReadOnlyText(node.replicaReason),
      watch: sanitizeFieldState(node.watch),
      lastFailure: sanitizeFieldState(node.lastFailure),
    }));
  const allowedNodeIds = new Set(nodes.map((node) => node.nodeId));
  return {
    schema: overview.schema,
    ok: true,
    repoId: boundRepoId,
    mode: overview.mode,
    ...(overview.effectiveMode === undefined ? {} : { effectiveMode: overview.effectiveMode }),
    generatedAt: overview.generatedAt,
    center: {
      nodeId: overview.center.nodeId,
      daemonId: overview.center.daemonId,
      startedAt: overview.center.startedAt,
      version: overview.center.version,
      commitSha: overview.center.commitSha,
    },
    centerRevision: overview.centerRevision,
    nodes,
    links: overview.links.filter((link) => allowedNodeIds.has(link.nodeId)),
    events: overview.events.map((event) => ({
      ...event,
      title: event.title === null ? null : sanitizeReadOnlyText(event.title),
    })),
    ...(overview.versionWarning === undefined ? {} : { versionWarning: overview.versionWarning }),
    notes: [...overview.notes],
    warnings: overview.warnings.map(sanitizeReadOnlyText),
  };
}
