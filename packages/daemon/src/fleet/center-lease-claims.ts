import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "../../../kernel/src/index.ts";

import type { FleetCenterOptions, Upload } from "./center-types.ts";

// A carried task-document bundle lands only through the lease-brokered task
// command; once the cell applies it, the staged claim uploads are consumed.
// The wrapper sits on the execution path only — an opId replay returns the
// stored receipt without re-running, so a re-staged claim survives a replay.
export function brokerHost(context: any, host: FleetCenterOptions["host"]): FleetCenterOptions["host"] {
  return {
    ...host,
    run: async (repoId, action, transport) => {
      const receipt = await host.run(repoId, action, transport);
      const binding = transport.assignmentBinding,
        changes = (
          action as {
            readonly docChanges?: unknown;
          }
        ).docChanges;
      if (receipt.outcome === "applied" && binding && Array.isArray(changes)) {
        let released = false;
        for (const uploadId of Object.keys(context.state.uploads)) {
          const upload = context.state.uploads[uploadId]!;
          if (
            upload.nodeId === binding.nodeId &&
            upload.assignmentId === binding.assignmentId &&
            changes.some(
              (change) =>
                typeof change === "object" &&
                change !== null &&
                (
                  change as {
                    readonly candidate?: {
                      readonly ref?: unknown;
                    };
                  }
                ).candidate?.ref === upload.descriptor?.ref,
            )
          ) {
            delete context.state.uploads[uploadId];
            released = true;
          }
        }
        if (released) context.persist();
      }
      return receipt;
    },
  };
}

export function verifyOwnedClaims(
  context: any,
  nodeId: string,
  assignmentId: string,
  changes: readonly {
    readonly candidate: {
      readonly ref: string;
    };
  }[],
): void {
  for (const change of changes) {
    const owned = Object.entries(context.state.uploads as Record<string, Upload>).some(
      ([, candidate]) =>
        candidate.nodeId === nodeId &&
        candidate.assignmentId === assignmentId &&
        candidate.descriptor?.ref === change.candidate.ref,
    );
    if (!owned) throw new context.FleetFault("claim_not_owned", "Descriptor was not issued to this assignment.");
  }
}

export function discardOwnedClaims(
  context: any,
  nodeId: string,
  assignmentId: string,
  changes: readonly {
    readonly candidate: {
      readonly ref: string;
    };
  }[],
): void {
  let released = false;
  for (const [uploadId, upload] of Object.entries(context.state.uploads as Record<string, Upload>)) {
    if (
      upload.nodeId !== nodeId ||
      upload.assignmentId !== assignmentId ||
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
