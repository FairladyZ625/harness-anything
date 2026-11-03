import type { ContractVersion, CoreDomainError } from "@harness-anything/kernel";
import { daemonBuildStamp } from "../build-identity.ts";
import { currentDaemonProtocolVersion } from "../protocol/version.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";

/** Every hello producer uses the identity of its loaded installation, independent of cwd and PATH. */
export function daemonHelloParams(params: JsonObject = {}): JsonObject {
  return { protocolVersion: currentDaemonProtocolVersion, buildCommit: daemonBuildStamp().commit, ...params };
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
  const mismatch = daemonHelloMismatch(hello.protocolVersion);
  if (mismatch) throw new DaemonHelloError(mismatch.code, mismatch.message);
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
