import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, sha256Bytes } from "@harness-anything/kernel";

import type { FleetBlob, FleetDescriptor, FleetTaskAction } from "./command-protocol.ts";
import { FleetFault, type FleetUploadWindow, type State, type Upload } from "./center-types.ts";

export function sameFleetBlob(left: FleetBlob, right: FleetBlob): boolean {
  return left.sha256 === right.sha256 && left.size === right.size && left.mediaType === right.mediaType;
}

export function sameFleetDescriptor(left: FleetDescriptor | null, right: FleetDescriptor): boolean {
  return left !== null && left.ref === right.ref && sameFleetBlob(left, right);
}

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
  return {
    limit: daemonProtocolFleetPolicy.defaultValue.fleet.uploadWindowLimit,
    receiving,
    staged,
    nodes: [...nodes.values()],
  };
}

export interface FleetLeaseClaimsContext {
  readonly state: State;
  readonly claimGenerations?: Record<string, number>;
  readonly persist: () => void;
  readonly FleetFault: typeof FleetFault;
  readonly safeLocal: (repoId: string, child: string) => string;
  readonly uploadPath: (uploadId: string, upload?: Upload) => string;
}

export function markClaimStaged(context: Pick<FleetLeaseClaimsContext, "claimGenerations">, uploadId: string): number {
  const next = claimGeneration(context, uploadId) + 1;
  if (context.claimGenerations) context.claimGenerations[uploadId] = next;
  return next;
}

export function claimGeneration(context: Pick<FleetLeaseClaimsContext, "claimGenerations">, uploadId: string): number {
  return context.claimGenerations && Object.hasOwn(context.claimGenerations, uploadId)
    ? (context.claimGenerations[uploadId] ?? 0)
    : 0;
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
    if (context.claimGenerations) delete context.claimGenerations[uploadId];
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
): ReadonlyMap<string, number> {
  const generations = new Map<string, number>();
  for (const change of changes) {
    const owned = findOwnedClaim(context, nodeId, repoId, change.candidate);
    if (!owned) throw new context.FleetFault("claim_not_owned", "Descriptor was not issued to this node.");
    generations.set(owned[0], claimGeneration(context, owned[0]));
  }
  return generations;
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
      sameFleetDescriptor(candidate.descriptor, descriptor),
  );
}

/**
 * One line for a claim miss: how many uploads this node holds for the repository and whether the
 * referenced claim file is still on disk. Together they separate a consumed claim from an upload
 * this node never staged, without needing the upload history that consumption already removed.
 */
export function describeClaimMiss(
  context: Pick<FleetLeaseClaimsContext, "state" | "safeLocal">,
  nodeId: string,
  repoId: string,
  descriptor: FleetDescriptor,
): string {
  const uploads = Object.values(context.state.uploads).filter(
      (upload) => upload.nodeId === nodeId && upload.repoId === repoId,
    ),
    claim = path.join(context.safeLocal(repoId, "doc-sync-claims"), path.basename(descriptor.ref));
  return [
    `node=${nodeId}`,
    `repo=${repoId}`,
    `nodeUploads=${uploads.length}`,
    `staged=${uploads.filter((upload) => upload.descriptor !== null).length}`,
    `claimFile=${existsSync(claim) ? "present" : "absent"}`,
  ].join(", ");
}

export function readOwnedRuntimeResultClaim(
  context: Pick<FleetLeaseClaimsContext, "state" | "claimGenerations" | "safeLocal" | "FleetFault">,
  nodeId: string,
  repoId: string,
  descriptor: FleetDescriptor,
): { readonly uploadId: string; readonly generation: number; readonly resultBody: string } {
  const owned = findOwnedClaim(context, nodeId, repoId, descriptor);
  if (!owned)
    throw new context.FleetFault(
      "claim_not_owned",
      `Runtime result descriptor was not issued to this node (${describeClaimMiss(context, nodeId, repoId, descriptor)}).`,
    );
  const uploadId = owned[0],
    generation = claimGeneration(context, uploadId),
    claim = path.join(context.safeLocal(repoId, "doc-sync-claims"), path.basename(descriptor.ref)),
    bytes = readFileSync(claim);
  if (bytes.byteLength !== descriptor.size || sha256Bytes(bytes) !== descriptor.sha256)
    throw new context.FleetFault("content_claim_mismatch", "Runtime result bytes do not match the staged descriptor.");
  return { uploadId, generation, resultBody: bytes.toString("utf8") };
}

export function verifyTaskCommandClaims(
  context: FleetLeaseClaimsContext,
  nodeId: string,
  repoId: string,
  frame: {
    readonly docChanges: readonly { readonly candidate: FleetDescriptor }[] | null;
    readonly artifact?: FleetDescriptor;
  },
  command: FleetTaskAction,
): {
  readonly command: FleetTaskAction;
  readonly docGenerations?: ReadonlyMap<string, number>;
  readonly handoffGenerations?: ReadonlyMap<string, number>;
  readonly artifactGenerations?: ReadonlyMap<string, number>;
} {
  const docGenerations =
    frame.docChanges !== null ? verifyOwnedClaims(context, nodeId, repoId, frame.docChanges) : undefined;
  let handoffGenerations: ReadonlyMap<string, number> | undefined;
  if (command.kind === "runtime-handoff-export") {
    const candidate = command.candidate as FleetDescriptor | undefined,
      owned = candidate ? findOwnedClaim(context, nodeId, repoId, candidate) : undefined;
    if (!owned)
      throw new context.FleetFault(
        "claim_not_owned",
        "Native checkpoint upload must belong to the authenticated source node.",
      );
    handoffGenerations = new Map([[owned[0], claimGeneration(context, owned[0])]]);
  }
  let resolved = command;
  let artifactGenerations: ReadonlyMap<string, number> | undefined;
  if (frame.artifact) {
    const owned = findOwnedClaim(context, nodeId, repoId, frame.artifact);
    if (command.kind !== "task-artifact-add" || command.source !== undefined || command.content !== undefined || !owned)
      throw new context.FleetFault("claim_not_owned", "Artifact must name this node's staged claim.");
    artifactGenerations = new Map([[owned[0], claimGeneration(context, owned[0])]]);
    resolved = {
      ...command,
      source: path.join(context.safeLocal(repoId, "doc-sync-claims"), path.basename(frame.artifact.ref)),
    };
  } else if (command.kind === "task-artifact-add")
    throw new context.FleetFault("claim_not_owned", "Edge artifacts require staged bytes.");
  return { command: resolved, docGenerations, handoffGenerations, artifactGenerations };
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
  expectedGenerations?: ReadonlyMap<string, number>,
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
    if (expectedGenerations?.has(uploadId) && claimGeneration(context, uploadId) !== expectedGenerations.get(uploadId))
      continue;
    try {
      const claim = path.join(
        context.safeLocal(upload.repoId, "doc-sync-claims"),
        path.basename(upload.descriptor.ref),
      );
      if (existsSync(claim)) /* @gate-identity state-store/document.fleet-claim-cleanup */ unlinkSync(claim);
    } catch (error) {
      consumeKnownError(error);
    }
    try {
      const part = context.uploadPath(uploadId, upload);
      if (existsSync(part)) /* @gate-identity state-store/document.fleet-claim-cleanup */ unlinkSync(part);
    } catch (error) {
      consumeKnownError(error);
    }
    delete context.state.uploads[uploadId];
    if (context.claimGenerations) delete context.claimGenerations[uploadId];
    released = true;
  }
  if (released) context.persist();
}

export function discardSubmittedClaims(
  context: Pick<FleetLeaseClaimsContext, "state" | "claimGenerations" | "persist">,
  completed: readonly (readonly [string, number])[],
): void {
  const matched = completed.filter(([uploadId, generation]) => claimGeneration(context, uploadId) === generation);
  if (matched.length === 0) return;
  for (const [uploadId] of matched) {
    delete context.state.uploads[uploadId];
    if (context.claimGenerations) delete context.claimGenerations[uploadId];
  }
  context.persist();
}
