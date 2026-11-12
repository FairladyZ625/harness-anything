import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { waitForArrival, watchDirectoryArrival } from "../../../../../tools/fixtures/event-arrival.ts";
import { readDispatchEvidenceState } from "../../../src/dispatch-evidence-state.ts";
import { readDispatchStreamSummary } from "../../../src/dispatch-stream.ts";
import { readRuntimeExecutionPrincipal } from "../../../src/runtime-execution-principal-store.ts";

interface LocalIdentityInput {
  readonly rootDir: string;
  readonly dispatchId: string;
  readonly credential: string;
  readonly expiresAt: string;
}

/** Read the actual identity carrier; canonical terminal visibility does not retire it. */
export function readLocalIdentity(input: LocalIdentityInput) {
  const live = path.join(
      resolveHarnessLayout(input.rootDir).localRoot,
      "runtime/dispatches",
      `${input.dispatchId}.jsonl`,
    ),
    archived = path.join(path.dirname(live), "archive", path.basename(live)),
    summary = readDispatchStreamSummary(input.rootDir, input.dispatchId),
    principal = readRuntimeExecutionPrincipal(input.rootDir, input.credential);
  return {
    liveExists: existsSync(live),
    archiveExists: existsSync(archived),
    principalReadable: principal !== null,
    principalDispatchId: principal?.dispatchId ?? null,
    unexpired: Date.parse(input.expiresAt) > Date.now(),
    evidenceSidecar: readDispatchEvidenceState(input.rootDir, input.dispatchId),
    evidenceSummary: summary?.evidenceState ?? null,
    localTerminal: summary?.terminalOutcome?.payload.outcome ?? null,
  };
}

/** Pending evidence may keep the stream live. Only real retirement satisfies this wait. */
export function waitForLocalIdentityRetirement(
  input: LocalIdentityInput,
  observe: (state: ReturnType<typeof readLocalIdentity>) => void,
) {
  let previous: string | undefined;
  return waitForArrival(() => {
    const state = readLocalIdentity(input),
      encoded = JSON.stringify(state);
    if (encoded !== previous) observe(state);
    previous = encoded;
    assert.equal(state.unexpired, true, "identity retirement must precede credential expiry");
    return !state.liveExists && state.archiveExists && !state.principalReadable ? state : null;
  }, watchDirectoryArrival(input.rootDir));
}
