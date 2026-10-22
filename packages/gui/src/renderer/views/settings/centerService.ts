import type { CenterStartInput } from "../../../api/center-settings-contract.ts";

/**
 * Whether the daemon's fleet TLS center is serving, from `harness:center:settings` →
 * `fleet-status`. Only a definite `ok: true` answer classifies; anything else — transport
 * failure, a refusal, a shape we do not recognize — is `unknown`, which must not block the
 * invite form: the daemon's own create refusal names the real problem instead of a guess.
 */
export type CenterServiceState =
  | { readonly state: "running" }
  | { readonly state: "stopped" }
  | { readonly state: "unknown" };

export function centerServiceState(reply: unknown): CenterServiceState {
  if (typeof reply !== "object" || reply === null) return { state: "unknown" };
  const record = reply as { readonly ok?: unknown; readonly running?: unknown };
  if (record.ok !== true) return { state: "unknown" };
  return record.running === true ? { state: "running" } : { state: "stopped" };
}

export const centerDefaultPort = 7545,
  centerMirrorQuotaBytes = 50 * 1024 * 1024 * 1024;

/**
 * The one-click start parameters, derived so the invite entry never asks for a certificate:
 * the saved configuration first, then one unambiguous local repository and the login
 * listener's hostname (the reused certificate names it). Returns null when the authority
 * repository is ambiguous — that case sends the operator to the center panel instead of
 * guessing, because starting on the wrong repository anchors the whole fleet.
 */
export function centerStartDefaults(input: {
  readonly status: unknown;
  readonly loginHostname: string | null;
  readonly localRepoIds: readonly string[];
}): CenterStartInput | null {
  if (typeof input.status !== "object" || input.status === null) return null;
  const record = input.status as {
    readonly ok?: unknown;
    readonly port?: unknown;
    readonly bind?: unknown;
    readonly externalUrl?: unknown;
    readonly repoId?: unknown;
    readonly quotaBytes?: unknown;
  };
  if (record.ok !== true) return null;
  const savedRepoId = typeof record.repoId === "string" ? record.repoId : null,
    repoId = savedRepoId
      ? input.localRepoIds.includes(savedRepoId)
        ? savedRepoId
        : null
      : input.localRepoIds.length === 1
        ? input.localRepoIds[0]!
        : null;
  if (repoId === null) return null;
  const port =
      Number.isInteger(record.port) && Number(record.port) >= 1 && Number(record.port) <= 65535
        ? Number(record.port)
        : centerDefaultPort,
    bind = record.bind === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0",
    quotaBytes =
      Number.isSafeInteger(record.quotaBytes) && Number(record.quotaBytes) > 0
        ? Number(record.quotaBytes)
        : centerMirrorQuotaBytes,
    savedExternalUrl = typeof record.externalUrl === "string" && record.externalUrl !== "" ? record.externalUrl : null,
    externalUrl =
      savedExternalUrl ?? (input.loginHostname !== null ? `https://${input.loginHostname}:${String(port)}` : null);
  return { port, repoId, quotaBytes, bind, ...(externalUrl !== null ? { externalUrl } : {}) };
}
