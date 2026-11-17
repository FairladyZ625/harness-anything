import { daemonBuildStamp } from "../../src/daemon-host/build-identity.ts";
import { currentDaemonProtocolVersion } from "../../src/daemon-host/protocol/version.ts";
export function fixtureDaemonHello() {
  return { ok: true, protocolVersion: currentDaemonProtocolVersion, build: { ...daemonBuildStamp() } };
}
