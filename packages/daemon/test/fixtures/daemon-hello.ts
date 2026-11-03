import { daemonBuildStamp } from "../../src/build-identity.ts";
import { currentDaemonProtocolVersion } from "../../src/protocol/version.ts";
export function fixtureDaemonHello() {
  return { ok: true, protocolVersion: currentDaemonProtocolVersion, build: { ...daemonBuildStamp() } };
}
