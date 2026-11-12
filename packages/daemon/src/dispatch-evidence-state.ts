import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { DispatchEvidenceState } from "@harness-anything/kernel/internal/domain/operational-status.ts";
import { consumeKnownError, resolveHarnessLayout } from "@harness-anything/kernel";
import { removeFileDurably, writeFileDurably } from "../../storage/src/durable-file.ts";

export type { DispatchEvidenceState };

const stateSchema = "dispatch-evidence-state/v1" as const;

/**
 * The one durable disposition of a dispatch's evidence copy. It is a small sidecar beside the
 * stream, not a second artifact write path: bounded stream summaries can miss a marker when a
 * large terminal body fills the tail window, while this file is read whole and stays O(1).
 */
export function dispatchEvidenceStatePath(rootDir: string, dispatchId: string): string {
  if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) throw new Error("dispatch id is invalid");
  return path.join(
    resolveHarnessLayout(rootDir).localRoot,
    "runtime",
    "dispatches",
    `${dispatchId}.evidence-state.json`,
  );
}

/** A missing or unreadable sidecar is `null`; new streams treat that as fail-closed. */
export function readDispatchEvidenceState(rootDir: string, dispatchId: string): DispatchEvidenceState | null {
  const file = dispatchEvidenceStatePath(rootDir, dispatchId);
  if (!existsSync(file)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (value === null || typeof value !== "object") return null;
    const state = (value as { readonly state?: unknown }).state;
    return state === "pending" || state === "stored" || state === "not-required" ? state : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

export function writeDispatchEvidenceState(
  rootDir: string,
  dispatchId: string,
  state: DispatchEvidenceState,
  reason?: string,
): void {
  writeFileDurably(
    dispatchEvidenceStatePath(rootDir, dispatchId),
    `${JSON.stringify({
      schema: stateSchema,
      dispatchId,
      state,
      reason: reason ?? null,
      updatedAt: new Date().toISOString(),
    })}\n`,
    0o600,
  );
}

export function removeDispatchEvidenceState(rootDir: string, dispatchId: string): void {
  const file = dispatchEvidenceStatePath(rootDir, dispatchId);
  if (statSync(file, { throwIfNoEntry: false })?.isFile()) removeFileDurably(file);
}
