import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import { sha256Bytes } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";

export interface AuthoredNode {
  readonly isFile: boolean;
  readonly mode: "100644" | "120000";
  readonly body: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly size: number;
}

/** Read a single authored file or symbolic link directly without spawning Git. */
export function readAuthoredNode(target: string): AuthoredNode | null {
  try {
    const info = lstatSync(target),
      mode = info.isSymbolicLink() ? ("120000" as const) : info.isFile() ? ("100644" as const) : null;
    if (mode === null) return null;
    const bytes = mode === "120000" ? readlinkSync(target, { encoding: "buffer" }) : readFileSync(target);
    return {
      isFile: info.isFile(),
      mode,
      get body() {
        return bytes.toString("utf8");
      },
      bytes,
      sha256: sha256Bytes(bytes),
      size: bytes.byteLength,
    };
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

/** Stable fingerprint of an authored filesystem node, or "missing" when absent. */
export function authoredNodeFingerprint(node: AuthoredNode | null): string {
  return node === null ? "missing" : `${node.mode}:${node.sha256}:${node.size}`;
}
