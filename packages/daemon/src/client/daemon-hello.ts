import type { ContractVersion, CoreDomainError } from "@harness-anything/kernel";
import { currentDaemonProtocolVersion } from "../protocol/version.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";

/**
 * protocol.hello is the first frame, so the client cannot negotiate: the previous daemon validates
 * this object against its own closed schema and rejects any field it does not already declare.
 * A new hello field therefore strands every current CLI against the previous release (#4279 sent
 * `buildCommit`, which no daemon reads). Add a parameter here only when the previous release
 * tolerates it; `test/protocol-hello-window-roundtrip.test.ts` freezes that boundary.
 */
export function daemonHelloParams(params: JsonObject = {}): JsonObject {
  return { protocolVersion: currentDaemonProtocolVersion, ...params };
}

export function daemonHelloMismatch(
  protocol: unknown,
  supported: ContractVersion = currentDaemonProtocolVersion,
): { readonly code: string; readonly message: string } | null {
  const version = record(protocol);
  if (
    version?.major !== supported.major ||
    !Number.isInteger(version.minor) ||
    (version.minor !== supported.minor && version.minor !== supported.minor - 1) ||
    Number(version.minor) < 0
  ) {
    const mismatch = {
      _tag: "ProtocolVersionMismatchError",
      code: "incompatible_protocol_version",
      message: `Daemon protocol is outside the current/previous window: local ${JSON.stringify(supported)}, peer ${JSON.stringify(protocol)}. Use the CLI installed with the daemon release, or select an isolated development/test daemon.`,
    } satisfies Extract<CoreDomainError, { readonly _tag: "ProtocolVersionMismatchError" }>;
    return mismatch;
  }
  return null;
}

export function assertDaemonHello(value: unknown): asserts value is JsonObject {
  const hello = record(value),
    error = record(hello?.error);
  if (hello?.ok !== true)
    throw new DaemonHelloError(
      typeof hello?.code === "string" ? hello.code : "daemon_hello_rejected",
      String(error?.hint ?? hello?.rejectionExplanation ?? "Daemon rejected protocol.hello; use its release CLI."),
    );
  // The previous release's diagnostics worker answered hello with a bare `{ ok: true }`. Every
  // main-daemon hello has carried protocolVersion since long before the window, so absence is that
  // one legacy reply shape; refusing it makes `ha daemon status --diagnostics` unusable against the
  // previous daemon. Remove with the 1.0 window: by 2026-12-04 or when the current minor becomes 1.1.
  if (hello.protocolVersion !== undefined) {
    const mismatch = daemonHelloMismatch(hello.protocolVersion);
    if (mismatch) throw new DaemonHelloError(mismatch.code, mismatch.message);
  }
}
function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

class DaemonHelloError extends Error {
  readonly daemonHello = true;
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export function daemonHelloFailureCode(error: unknown): string | null {
  const failure = record(error);
  return failure?.daemonHello === true && typeof failure.code === "string" ? failure.code : null;
}
