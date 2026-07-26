import {
  requestLocalDaemonJsonRpcForTarget,
  type JsonObject,
  type LocalDaemonTarget
} from "@harness-anything/daemon";

/** Recovery is explicit: observe an existing daemon without starting one. */
export function requestMaterializerRecovery(
  target: LocalDaemonTarget,
  payload: JsonObject
): Promise<JsonObject> {
  return requestLocalDaemonJsonRpcForTarget(target, "repo.command.run", {
    repo: { repoId: target.repoId },
    payload
  }, 200);
}
