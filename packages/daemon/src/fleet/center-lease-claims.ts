import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";

import type { FleetDescriptor } from "./command-protocol.ts";
import { FleetFault, type FleetUploadWindow, type State, type Upload } from "./center-types.ts";

/** Only durable prefixes still being received occupy the recovery window. */
export function uploadWindow(state: State): FleetUploadWindow {
  const nodes = new Map<string, { nodeId: string; receiving: number; staged: number }>();
  let receiving = 0,
    staged = 0;
  for (const upload of Object.values(state.uploads)) {
    const node = nodes.get(upload.nodeId) ?? { nodeId: upload.nodeId, receiving: 0, staged: 0 };
    if (upload.descriptor === null) {
      receiving += 1;
      node.receiving += 1;
    } else {
      staged += 1;
      node.staged += 1;
    }
    nodes.set(upload.nodeId, node);
  }
  return { limit: 64, receiving, staged, nodes: [...nodes.values()] };
}

export interface FleetLeaseClaimsContext {
  readonly state: State;
  readonly persist: () => void;
  readonly FleetFault: typeof FleetFault;
  readonly safeLocal: (repoId: string, child: string) => string;
  readonly uploadPath: (uploadId: string, upload?: Upload) => string;
}

/** Consumption may have removed a claim before a crash persisted its metadata deletion.
 * Keep staged claims that still exist: they prove ownership and make finish replay idempotent.
 * Unfinished uploads are never reclaimed here, including a rename interrupted before persistence.
 */
export function reclaimConsumedClaims(context: FleetLeaseClaimsContext, repoId: string): void {
  let released = false;
  for (const [uploadId, upload] of Object.entries(context.state.uploads)) {
    if (upload.repoId !== repoId || !upload.descriptor) continue;
    const claim = path.join(context.safeLocal(repoId, "doc-sync-claims"), path.basename(upload.descriptor.ref));
    if (existsSync(claim)) continue;
    delete context.state.uploads[uploadId];
    released = true;
  }
  if (released) context.persist();
}

export function verifyOwnedClaims(
  context: FleetLeaseClaimsContext,
  nodeId: string,
  repoId: string,
  changes: readonly {
    readonly candidate: FleetDescriptor;
  }[],
): void {
  for (const change of changes) {
    const owned = findOwnedClaim(context, nodeId, repoId, change.candidate);
    if (!owned) throw new context.FleetFault("claim_not_owned", "Descriptor was not issued to this node.");
  }
}

export function findOwnedClaim(
  context: Pick<FleetLeaseClaimsContext, "state">,
  nodeId: string,
  repoId: string,
  descriptor: FleetDescriptor,
): [string, Upload] | undefined {
  return Object.entries(context.state.uploads).find(
    ([, candidate]) =>
      candidate.nodeId === nodeId &&
      candidate.repoId === repoId &&
      JSON.stringify(candidate.descriptor) === JSON.stringify(descriptor),
  );
}

export function discardOwnedClaims(
  context: FleetLeaseClaimsContext,
  nodeId: string,
  repoId: string,
  changes: readonly {
    readonly candidate: {
      readonly ref: string;
    };
  }[],
): void {
  let released = false;
  for (const [uploadId, upload] of Object.entries(context.state.uploads)) {
    if (
      upload.nodeId !== nodeId ||
      upload.repoId !== repoId ||
      !upload.descriptor ||
      !changes.some((change) => change.candidate.ref === upload.descriptor?.ref)
    )
      continue;
    try {
      const claim = path.join(
        context.safeLocal(upload.repoId, "doc-sync-claims"),
        path.basename(upload.descriptor.ref),
      );
      if (existsSync(claim)) unlinkSync(claim);
    } catch (error) {
      consumeKnownError(error);
    }
    try {
      const part = context.uploadPath(uploadId, upload);
      if (existsSync(part)) unlinkSync(part);
    } catch (error) {
      consumeKnownError(error);
    }
    delete context.state.uploads[uploadId];
    released = true;
  }
  if (released) context.persist();
}
