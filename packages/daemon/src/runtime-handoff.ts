import { randomUUID } from "node:crypto";
import { sha256Bytes } from "@harness-anything/kernel";
import { prepareRuntimeHandoff } from "./runtime-handoff-native.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import type { RuntimeHandoffCheckpoint } from "./runtime-handoff-store.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";

/** CLI and GUI call this same node-local orchestration; every authority check stays at the center. */
export async function runRuntimeHandoff(input: {
  readonly rootDir: string;
  readonly payload: JsonObject;
  readonly command: (action: JsonObject, body?: Uint8Array) => Promise<JsonObject>;
  readonly spawn: (
    checkpoint: RuntimeHandoffCheckpoint,
    payload: JsonObject,
    rollout: Uint8Array,
  ) => Promise<JsonObject>;
}): Promise<JsonObject> {
  const { operation, dispatchId } = input.payload;
  if (!["export", "claim", "revoke"].includes(String(operation)) || typeof dispatchId !== "string")
    throw runtimeSpawnError("invalid_field", "Choose export, claim or revoke and a source dispatch.");
  const idempotencyKey = input.payload.idempotencyKey ?? `handoff-${randomUUID()}`;
  const action: JsonObject = {
    kind: `runtime-handoff-${operation}`,
    dispatchId,
    ...(operation === "claim" ? { idempotencyKey } : {}),
  };
  if (operation === "export") {
    const exported = await prepareRuntimeHandoff(input.rootDir, dispatchId);
    return publicResult(await input.command({ ...action, commit: exported.commit }, exported.body));
  }
  if (operation === "revoke") return publicResult(await input.command(action));
  const { runtimeInstanceId, prompt } = input.payload;
  if (typeof runtimeInstanceId !== "string" || typeof prompt !== "string" || !prompt.trim())
    throw runtimeSpawnError("invalid_field", "Claim requires a target Codex instance and a continuation prompt.");
  const accepted = await input.command(action);
  if (!["applied", "no_changes"].includes(String(accepted.outcome))) return publicResult(accepted);
  if (accepted.replayed === true && typeof accepted.dispatchId === "string") return publicResult(accepted);
  const checkpoint = accepted.checkpoint as unknown as RuntimeHandoffCheckpoint;
  if (!checkpoint || checkpoint.dispatchId !== dispatchId)
    throw runtimeSpawnError("runtime_handoff_payload_invalid", "The center omitted its checkpoint binding.");
  const parts: Buffer[] = [];
  let offset = 0;
  // Each response advances the byte offset; only the reader's explicit done ends the download.
  for (;;) {
    const chunk = await input.command({ ...action, offset });
    if (!["applied", "no_changes"].includes(String(chunk.outcome))) return publicResult(chunk);
    if (typeof chunk.dataBase64 !== "string" || typeof chunk.done !== "boolean")
      throw runtimeSpawnError("runtime_handoff_payload_invalid", "The private payload chunk is invalid.");
    const bytes = Buffer.from(chunk.dataBase64, "base64");
    if (
      chunk.nextOffset !== offset + bytes.length ||
      chunk.nextOffset > checkpoint.blob.size ||
      (!chunk.done && bytes.length === 0)
    )
      throw runtimeSpawnError(
        "runtime_handoff_payload_invalid",
        "The private payload reader did not advance within its declared size.",
      );
    parts.push(bytes);
    offset += bytes.length;
    if (chunk.done) break;
  }
  const body = Buffer.concat(parts);
  if (body.length !== checkpoint.blob.size || sha256Bytes(body) !== checkpoint.blob.sha256)
    throw runtimeSpawnError("content_claim_mismatch", "The downloaded rollout differs from the accepted checkpoint.");
  // The verified bytes travel to the launch: the spawner installs them into the directory the
  // prepared target launch resolves, immediately before that process starts.
  const resumed = await input.spawn(checkpoint, { runtimeInstanceId, prompt, idempotencyKey }, body);
  if (resumed.replayed === true) return publicResult(await input.command(action));
  return { ...resumed, handoffResumed: true };
}

function publicResult(receipt: JsonObject): JsonObject {
  return {
    ...receipt,
    schema: "command-receipt/v2",
    command: "runtime-handoff",
    ok: ["applied", "no_changes"].includes(String(receipt.outcome)),
  };
}
