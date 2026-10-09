import type { FleetPeer } from "./edge.ts";

/** One watch response is either a published checkpoint or an unchanged progress hint. */
export async function watchReplicaHead(
  session: FleetPeer,
  repoId: string,
  afterRevision: number,
  timeoutMs: number | null,
) {
  const messageId = session.messageId();
  session.send({ schema: "fleet.replica.watch/v1", messageId, repoId, afterRevision });
  const hint = await session.next(timeoutMs);
  if (hint.schema !== "fleet.replica.head-hint/v1" || hint.inReplyTo !== messageId)
    throw new Error("replica head hint expected");
  return hint;
}

/** Progress hints never move the command's target or reset its waiting deadline. */
export async function waitForReplicaCheckpoint(session: FleetPeer, repoId: string, target: number, deadline: number) {
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Fleet checkpoint response timeout");
    const hint = await watchReplicaHead(session, repoId, target - 1, remaining);
    if (hint.cut.revision >= target) return;
  }
}
