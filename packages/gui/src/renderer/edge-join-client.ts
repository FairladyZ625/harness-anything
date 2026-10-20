import type {
  EdgeJoinDeviceLogin,
  EdgeJoinJoined,
  EdgeJoinProgress,
  EdgeJoinRejection,
} from "../api/edge-join-entry-contract.ts";
import { guiHostBridge } from "./gui-transport.ts";
import { isRendererRecord, rendererReadError } from "./result-validation.ts";

/** The joiner's typed channel to the daemon's existing edge join; the wizard is its only consumer. */
type EdgeJoinBridge = {
  readonly begin: (input: { readonly link: string }) => Promise<unknown>;
  readonly poll: () => Promise<unknown>;
  readonly progress: () => Promise<unknown>;
  readonly openLogin: () => Promise<unknown>;
  readonly onJoinLink: (listener: (link: string) => void) => () => void;
};

function edgeJoinBridge(): EdgeJoinBridge {
  const bridge = guiHostBridge() as unknown as { readonly edgeJoin?: EdgeJoinBridge } | undefined;
  if (!bridge?.edgeJoin) throw new Error("Edge join bridge is unavailable.");
  return bridge.edgeJoin;
}

/** Subscribe to OS protocol activations (`harness-edge://join/...`); browser shell has none. */
export function onEdgeJoinLink(listener: (link: string) => void): () => void {
  const edgeJoin = (guiHostBridge() as unknown as { readonly edgeJoin?: Partial<EdgeJoinBridge> } | undefined)
    ?.edgeJoin;
  // A renderer can meet an older preload during an upgrade; a missing subscription is not a failure.
  return typeof edgeJoin?.onJoinLink === "function" ? edgeJoin.onJoinLink(listener) : () => undefined;
}

export async function openEdgeJoinLogin(): Promise<void> {
  await edgeJoinBridge().openLogin();
}

export async function pollEdgeJoinLogin(): Promise<
  { readonly pending: true; readonly interval?: number } | { readonly pending: false } | EdgeJoinRejection
> {
  const value = await edgeJoinBridge().poll();
  if (isRendererRecord(value) && value.ok === false) return readRejection(value);
  if (!isRendererRecord(value)) throw rendererReadError(value, "Edge join login poll returned an invalid result.");
  if (value.pending !== true) return { pending: false };
  return { pending: true, ...(typeof value.interval === "number" ? { interval: value.interval } : {}) };
}

export async function readEdgeJoinProgress(): Promise<EdgeJoinProgress> {
  const value = await edgeJoinBridge().progress();
  if (!isRendererRecord(value) || value.ok !== true || !Array.isArray(value.repositories))
    throw rendererReadError(value, "Edge join progress returned an invalid result.");
  return { repositories: value.repositories.map(readProgressRepository) };
}

function readProgressRepository(value: unknown): EdgeJoinProgress["repositories"][number] {
  const phases = ["workspace", "register", "sync", "synced", "failed"] as const;
  if (
    !isRendererRecord(value) ||
    typeof value.repoId !== "string" ||
    !phases.includes(value.phase as (typeof phases)[number])
  )
    throw rendererReadError(value, "Edge join progress returned an invalid repository row.");
  return { repoId: value.repoId, phase: value.phase as (typeof phases)[number] };
}

/** Calls the daemon's edge join once: without a session it returns the device login, with one the joined receipt. */
export async function beginEdgeJoin(link: string): Promise<EdgeJoinDeviceLogin | EdgeJoinJoined | EdgeJoinRejection> {
  const value = await edgeJoinBridge().begin({ link });
  if (isRendererRecord(value) && value.ok === false) return readRejection(value);
  if (isRendererRecord(value) && value.pending === true) {
    if (
      typeof value.verificationUri !== "string" ||
      typeof value.userCode !== "string" ||
      typeof value.interval !== "number" ||
      typeof value.expiresAt !== "number"
    )
      throw rendererReadError(value, "Edge join sign-in returned an invalid result.");
    return {
      pending: true,
      verificationUri: value.verificationUri,
      userCode: value.userCode,
      interval: value.interval,
      expiresAt: value.expiresAt,
    };
  }
  return readJoined(value);
}

export function readJoined(value: unknown): EdgeJoinJoined {
  if (
    !isRendererRecord(value) ||
    value.ok !== true ||
    typeof value.joinId !== "string" ||
    (value.state !== "synced" && value.state !== "partial") ||
    !Array.isArray(value.repoIds) ||
    !value.repoIds.every((repoId) => typeof repoId === "string") ||
    !Array.isArray(value.repositories)
  )
    throw rendererReadError(value, "Edge join returned an invalid result.");
  return {
    ok: value.ok === true,
    joinId: value.joinId,
    state: value.state,
    repoIds: value.repoIds as string[],
    repositories: value.repositories.map((repository) => {
      if (!isRendererRecord(repository) || typeof repository.repoId !== "string" || typeof repository.ok !== "boolean")
        throw rendererReadError(repository, "Edge join returned an invalid repository outcome.");
      return {
        repoId: repository.repoId,
        ok: repository.ok,
        ...(typeof repository.code === "string" ? { code: repository.code } : {}),
        ...(typeof repository.error === "string" ? { error: repository.error } : {}),
      };
    }),
    ...(typeof value.nodeId === "string" ? { nodeId: value.nodeId } : {}),
    ...(typeof value.personId === "string" ? { personId: value.personId } : {}),
  };
}

export function readRejection(value: unknown): EdgeJoinRejection {
  if (!isRendererRecord(value) || value.ok !== false || typeof value.code !== "string")
    throw rendererReadError(value, "Edge join returned an invalid refusal.");
  const hint = isRendererRecord(value.error) && typeof value.error.hint === "string" ? value.error.hint : undefined;
  return {
    ok: false,
    code: value.code,
    ...(typeof value.rejectionExplanation === "string"
      ? { rejectionExplanation: value.rejectionExplanation }
      : hint !== undefined
        ? { rejectionExplanation: hint }
        : {}),
  };
}
