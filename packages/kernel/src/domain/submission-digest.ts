import type { SubmissionV1 } from "./execution.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";

export type SubmissionDigest = `sha256:${string}`;

export function submissionDigest(value: SubmissionV1): SubmissionDigest {
  return `sha256:${sha256Text(stableStringify(value))}`;
}

export function isNativeCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}
