import type { RepoWriteProtocolLimits } from "./repo-write-protocol.ts";
import {
  repoWriteStartupProgressPhases,
  type RepoWriteStartupProgressFrame,
  type RepoWriteStartupProgressPhase
} from "./repo-write-startup-protocol.ts";
import {
  invalidRepoWriteProtocol as invalid,
  limitRepoWriteProtocol as limit
} from "./repo-write-protocol-errors.ts";

type StartupFrameRecord = Record<string, unknown> & { readonly kind: string };
type StartupBaseFields = Pick<
  RepoWriteStartupProgressFrame,
  "protocol" | "repoId" | "generation"
>;

export function decodeRepoWriteStartupProgress(
  frame: StartupFrameRecord,
  limits: RepoWriteProtocolLimits,
  baseFields: StartupBaseFields
): RepoWriteStartupProgressFrame {
  assertExactStartupKeys(frame);
  if (!repoWriteStartupProgressPhases.includes(frame.phase as RepoWriteStartupProgressPhase)) {
    invalid("$.phase", "startup progress phase");
  }
  return {
    ...baseFields,
    kind: "startup-progress",
    phase: frame.phase as RepoWriteStartupProgressPhase,
    workUnit: startupIdentifier(frame.workUnit, "$.workUnit", limits)
  };
}

function assertExactStartupKeys(frame: Record<string, unknown>): void {
  const required = ["protocol", "repoId", "generation", "kind", "phase", "workUnit"];
  if (required.some((key) => !Object.hasOwn(frame, key))
    || Object.keys(frame).some((key) => !required.includes(key))) {
    invalid("$", "exact message fields");
  }
}

function startupIdentifier(
  value: unknown,
  path: string,
  limits: RepoWriteProtocolLimits
): string {
  if (typeof value !== "string") invalid(path, "string");
  const maximumBytes = Math.min(limits.maxStringBytes, 4_096);
  const actualBytes = Buffer.byteLength(value, "utf8");
  if (actualBytes > maximumBytes) {
    limit(path, "string byte length", actualBytes, maximumBytes);
  }
  if (!value.trim()) invalid(path, "non-empty identifier");
  return value;
}
