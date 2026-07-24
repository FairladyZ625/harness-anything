import type {
  RepoWriteCommandDto,
  RepoWriteJsonObject
} from "./repo-write-protocol.ts";
import type { RepoWriteTerminalOutcomeV1 } from "./repo-write-outcome-schema.ts";
import type { RepoWriteCanonicalLookupResult } from "./repo-write-child-lookup.ts";
import type { RepoWriteChildTransport } from "./repo-write-child-response-writer.ts";
import type { RepoWriteExecutionSequencer } from "./repo-write-execution-sequencer.ts";
import type { RepoWriteDirectInput } from "./repo-write-child-direct.ts";

export interface RepoWritePrepareInput {
  readonly repoId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly command: RepoWriteCommandDto;
}

export interface RepoWritePreparedOperation {
  readonly opId: string;
  readonly execute: () => RepoWriteTerminalOutcomeV1 | Promise<RepoWriteTerminalOutcomeV1>;
}

export interface RepoWriteLookupInput {
  readonly repoId: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly opId: string;
}

export interface RepoWriteShutdownInput {
  readonly repoId: string;
  readonly workspaceId: string;
  readonly generation: number;
}

export interface RepoWriteChildHostHooks {
  readonly prepare: (
    input: RepoWritePrepareInput
  ) => RepoWritePreparedOperation | Promise<RepoWritePreparedOperation>;
  readonly direct?: (
    input: RepoWriteDirectInput
  ) => RepoWriteJsonObject | Promise<RepoWriteJsonObject>;
  readonly lookup: (
    input: RepoWriteLookupInput
  ) => RepoWriteCanonicalLookupResult | Promise<RepoWriteCanonicalLookupResult>;
  readonly shutdown: (input: RepoWriteShutdownInput) => void | Promise<void>;
}

export interface RepoWriteChildHostLimits {
  readonly maxAdmissions: number;
  readonly maxRetainedOperations: number;
  readonly maxControlRequests: number;
  readonly shutdownTimeoutMs: number;
}

export interface RepoWriteChildHostOptions {
  readonly repoId: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly artifactIdentity: string;
  readonly transport: RepoWriteChildTransport;
  readonly hooks: RepoWriteChildHostHooks;
  readonly executionSequencer?: RepoWriteExecutionSequencer;
  readonly limits?: Partial<RepoWriteChildHostLimits>;
}
