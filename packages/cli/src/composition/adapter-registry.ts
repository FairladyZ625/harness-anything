import {
  localAdapterProviderMetadata,
  buildLocalTaskCreateWrites,
  createDaemonRuntime,
  createMultiRepoDaemonRuntime,
  makeLocalLifecycleEngine,
  makeLocalWriteCoordinator,
  runLedgerMaterializer
} from "@harness-anything/adapter-local";
import { multicaAdapterProviderMetadata } from "@harness-anything/adapter-multica";
import {
  makeGithubIssuesLifecycleEngine,
  type GithubCredentialResolver,
  type GithubHttpRequest,
  type GithubHttpResponse,
  type GithubIssuesLifecycleEngine,
  type GithubIssuesProviderOptions,
  type GithubTransport,
  type GithubTransportError
} from "@harness-anything/adapter-github-issues";
import type { HarnessLayoutInput } from "@harness-anything/kernel";
import { makeMarkdownArtifactStore } from "@harness-anything/kernel";
import type {
  LocalLifecycleOptions,
  LocalWriteCoordinatorOptions
} from "@harness-anything/adapter-local";
import type { MaterializerCommandReport } from "../cli/types.ts";

export type AdapterCapability =
  | "task.lifecycle"
  | "task.read"
  | "task.write"
  | "decision.write"
  | "fact.write"
  | "runtime-event.write"
  | "daemon.runtime"
  | "materializer.run"
  | "task.snapshot";

export interface AdapterProviderRegistryEntry {
  readonly id: string;
  readonly capabilities: ReadonlyArray<AdapterCapability | string>;
  readonly readonly: boolean;
  readonly writable: boolean;
  readonly defaultProvider?: boolean;
}

export interface CliCompositionAdapterProvider {
  readonly metadata: AdapterProviderRegistryEntry;
  readonly createLifecycleEngine: typeof makeLocalLifecycleEngine;
  readonly createArtifactStore: typeof makeMarkdownArtifactStore;
  readonly createWriteCoordinator: typeof makeLocalWriteCoordinator;
  readonly createDaemonRuntime: typeof createDaemonRuntime;
  readonly createMultiRepoDaemonRuntime: typeof createMultiRepoDaemonRuntime;
  readonly buildLocalTaskCreateWrites: typeof buildLocalTaskCreateWrites;
  readonly runLedgerMaterializer: (rootInput: HarnessLayoutInput, options: {
    readonly dryRun?: boolean;
    readonly sessionId?: string;
  }) => MaterializerCommandReport;
}

const localProvider = {
  metadata: localAdapterProviderMetadata,
  createLifecycleEngine: (options: LocalLifecycleOptions) => makeLocalLifecycleEngine(options),
  createArtifactStore: (options) => makeMarkdownArtifactStore(options),
  createWriteCoordinator: (options: LocalWriteCoordinatorOptions) => makeLocalWriteCoordinator(options),
  createDaemonRuntime: (options) => createDaemonRuntime(options),
  createMultiRepoDaemonRuntime: (options) => createMultiRepoDaemonRuntime(options),
  buildLocalTaskCreateWrites: (input, createdAt, provenance) => buildLocalTaskCreateWrites(input, createdAt, provenance),
  runLedgerMaterializer
} satisfies CliCompositionAdapterProvider;

const readonlyProviderMetadata = [
  multicaAdapterProviderMetadata
] as const satisfies ReadonlyArray<AdapterProviderRegistryEntry>;

export const adapterProviderRegistry = [
  localProvider.metadata,
  ...readonlyProviderMetadata
] as const satisfies ReadonlyArray<AdapterProviderRegistryEntry>;

export function defaultCliAdapterProvider(): CliCompositionAdapterProvider {
  return localProvider;
}

export function selectCliAdapterProvider(capability: AdapterCapability): CliCompositionAdapterProvider {
  if (localProvider.metadata.capabilities.some((registered) => registered === capability)) return localProvider;
  throw new Error(`No CLI adapter provider registered for capability: ${capability}`);
}

export function createGithubIssuesReadProvider(options: GithubIssuesProviderOptions = {}) {
  return makeGithubIssuesLifecycleEngine(options);
}

export type {
  GithubCredentialResolver,
  GithubHttpRequest,
  GithubHttpResponse,
  GithubIssuesLifecycleEngine,
  GithubIssuesProviderOptions,
  GithubTransport,
  GithubTransportError
};
