// @slice-activation PLT-Boundary W1 exposes this module through the package root API.
import type { ExecutionRecord } from "../domain/execution.ts";
import { sha256Text, stableStringify } from "./stable-hash.ts";

export const executionConsentPinAlgorithm = "execution-consent-pin/v1" as const;

export function canonicalizeExecutionConsentContent(execution: ExecutionRecord): string {
  return stableStringify({
    schema: executionConsentPinAlgorithm,
    execution
  });
}

export function computeExecutionConsentPin(execution: ExecutionRecord): `sha256:${string}` {
  return `sha256:${sha256Text(canonicalizeExecutionConsentContent(execution))}`;
}
