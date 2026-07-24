import type { TaskHolderExecutor } from "@harness-anything/application";
import type { AuthenticatedActor } from "../identity/types.ts";
import type { AuthorityConnectionDispatch } from "./connection-context.ts";
import type { DaemonRepoNamespace } from "./json-rpc-server.ts";

export interface DocSyncServiceContext {
  readonly actor?: AuthenticatedActor;
  readonly executor?: TaskHolderExecutor | null;
  readonly repo?: DaemonRepoNamespace;
  readonly authorityConnection?: AuthorityConnectionDispatch;
}
