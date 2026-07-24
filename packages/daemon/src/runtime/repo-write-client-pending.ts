import type {
  RepoWriteCommandDto,
  RepoWriteJsonObject,
  RepoWriteOperationLookupResult
} from "./repo-write-protocol.ts";

export interface PendingSubmit {
  readonly requestId: string;
  readonly command: RepoWriteCommandDto;
  readonly resolve: (receipt: RepoWriteJsonObject) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  phase: "queued" | "submitted" | "prepared" | "proceeded";
  opId?: string;
}

export interface PendingLookup {
  readonly requestId: string;
  readonly opId: string;
  readonly resolve: (result: RepoWriteOperationLookupResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  phase: "queued" | "sent";
}

export interface PendingShutdown {
  readonly requestId: string;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  sent: boolean;
}

export interface PendingReady {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}
