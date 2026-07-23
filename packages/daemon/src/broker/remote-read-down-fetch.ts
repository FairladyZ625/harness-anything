import type { ReplicaChangeRecord } from "@harness-anything/application";
import type { AuthorityChangesAfterResult } from "../authority/protocol.ts";
import { AuthorityTransportDisconnectedError } from "../transport/persistent-ssh-authority-client.ts";
import {
  type ActiveSnapshot,
  type RemoteReadDownBackoff
} from "./remote-read-down-contract.ts";
import { isResyncError, validateChanges } from "./remote-read-down-content.ts";
import { asRemoteReadDownError } from "./remote-read-down-failure.ts";
import {
  advanceRemoteReadDownBackoff,
  createRemoteResyncError
} from "./remote-read-down-state.ts";

export async function fetchRemoteChanges(input: {
  readonly active: ActiveSnapshot;
  readonly revision: number;
  readonly workspaceId: string;
  readonly backoff: RemoteReadDownBackoff;
  readonly request: (
    active: ActiveSnapshot,
    revision: number
  ) => Promise<AuthorityChangesAfterResult>;
  readonly assertCurrent: (active: ActiveSnapshot) => void;
  readonly storeChange: (active: ActiveSnapshot, change: ReplicaChangeRecord) => void;
  readonly invalidate: (active: ActiveSnapshot) => void;
  readonly ready: () => Promise<ActiveSnapshot>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly stopped: () => boolean;
}): Promise<ReadonlyArray<ReplicaChangeRecord>> {
  let current = input.active;
  let delay = input.backoff.initialMs;
  for (;;) {
    try {
      input.assertCurrent(current);
      const result = await input.request(current, input.revision);
      input.assertCurrent(current);
      validateChanges(result.changes, input.revision, input.workspaceId);
      for (const change of result.changes) input.storeChange(current, change);
      return result.changes;
    } catch (error) {
      if (input.stopped()) throw asRemoteReadDownError(error);
      if (isResyncError(error)) {
        input.invalidate(current);
        throw createRemoteResyncError(await input.ready(), error.message);
      }
      if (!(error instanceof AuthorityTransportDisconnectedError)) throw error;
      input.invalidate(current);
      await input.sleep(delay);
      delay = advanceRemoteReadDownBackoff(delay, input.backoff);
      current = await input.ready();
      if (current.resyncReason) {
        throw createRemoteResyncError(current, current.resyncReason);
      }
      if (input.revision < current.reservation.cut.revision) {
        throw createRemoteResyncError(
          current,
          `CURSOR_PRECEDES_RECONNECTED_CUT:${input.revision}:${current.reservation.cut.revision}`
        );
      }
    }
  }
}
