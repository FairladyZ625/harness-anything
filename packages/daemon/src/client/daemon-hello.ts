import type { CoreDomainError } from "@harness-anything/kernel";
import { daemonBuildStamp, type DaemonBuildStamp } from "../build-identity.ts";
import { currentDaemonProtocolVersion } from "../protocol/version.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";

/** Every hello producer uses the identity of its loaded installation, independent of cwd and PATH. */
export function daemonHelloParams(params: JsonObject = {}): JsonObject {
  return { protocolVersion: currentDaemonProtocolVersion, buildCommit: daemonBuildStamp().commit, ...params };
}

export function daemonHelloMismatch(
  protocol: unknown,
  build: unknown,
  own: DaemonBuildStamp = daemonBuildStamp(),
): { readonly code: string; readonly message: string } | null {
  const version = record(protocol),
    peer = record(build)?.commit;
  if (version?.major !== currentDaemonProtocolVersion.major || version.minor !== currentDaemonProtocolVersion.minor) {
    const mismatch = {
      _tag: "ProtocolVersionMismatchError",
      code: "incompatible_protocol_version",
      message: `Daemon protocol must match exactly: local ${JSON.stringify(currentDaemonProtocolVersion)}, peer ${JSON.stringify(protocol)}. Use the CLI installed with the daemon release, or select an isolated development/test daemon.`,
    } satisfies Extract<CoreDomainError, { readonly _tag: "ProtocolVersionMismatchError" }>;
    return mismatch;
  }
  if (peer !== own.commit || (peer !== null && typeof peer !== "string"))
    return {
      code: "daemon_version_mismatch",
      message: `Daemon release must match exactly: local ${own.commit ?? "unknown"}, peer ${String(peer ?? "unknown")}. Use the CLI installed with the daemon release, or select an isolated development/test daemon with --user-root and --daemon-id. No command was sent.`,
    };
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
  const mismatch = daemonHelloMismatch(hello.protocolVersion, hello.build);
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
