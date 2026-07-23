import type { ReplicaChangeRecord } from "@harness-anything/application";
import { RemoteReadDownSession } from "./remote-read-down-session.ts";
import type { CanonicalSnapshot, CanonicalSnapshotSource } from "./types.ts";

export class RemoteCanonicalSnapshotSource implements CanonicalSnapshotSource {
  private readonly session: RemoteReadDownSession;

  constructor(session: RemoteReadDownSession) {
    this.session = session;
  }

  snapshotAt(change: ReplicaChangeRecord): Promise<CanonicalSnapshot> {
    return this.session.snapshotAt(change);
  }
}
