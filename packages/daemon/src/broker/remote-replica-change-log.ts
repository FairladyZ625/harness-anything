import type {
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "@harness-anything/application";
import { RemoteReadDownSession, type RemoteReadDownSessionOptions } from "./remote-read-down-session.ts";

export class RemoteReplicaChangeLog implements ReplicaChangeLog {
  readonly session: RemoteReadDownSession;
  private readonly workspaceId: string;

  constructor(options: RemoteReadDownSessionOptions | RemoteReadDownSession) {
    this.session = options instanceof RemoteReadDownSession ? options : new RemoteReadDownSession(options);
    this.workspaceId = options instanceof RemoteReadDownSession ? options.workspaceId : options.workspaceId;
  }

  async append(_record: Parameters<ReplicaChangeLog["append"]>[0]): Promise<void> {
    throw new Error("REMOTE_REPLICA_CHANGE_LOG_READ_DOWN_ONLY");
  }

  latest(workspaceId: string): Promise<ReplicaChangeRecord | undefined> {
    this.assertWorkspace(workspaceId);
    return this.session.latest();
  }

  getByOperation(workspaceId: string, opId: string): Promise<ReplicaChangeRecord | undefined> {
    this.assertWorkspace(workspaceId);
    return this.session.getByOperation(opId);
  }

  changesAfter(workspaceId: string, revision: number): Promise<ReadonlyArray<ReplicaChangeRecord>> {
    this.assertWorkspace(workspaceId);
    return this.session.changesAfter(revision);
  }

  subscribe(workspaceId: string, listener: (change: ReplicaChangeRecord) => void): () => void {
    this.assertWorkspace(workspaceId);
    return this.session.subscribe(listener);
  }

  close(): Promise<void> {
    return this.session.close();
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspaceId) throw new Error("remote replica log belongs to another workspace");
  }
}
