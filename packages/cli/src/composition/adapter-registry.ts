import {
  localAdapterProviderMetadata,
  createDaemonRuntime,
  makeLocalLifecycleEngine,
  makeLocalWriteCoordinator,
  runLedgerMaterializer
} from "../../../adapters/local/src/index.ts";
import { multicaAdapterProviderMetadata } from "../../../adapters/multica/src/index.ts";
import type { HarnessLayoutInput } from "../../../kernel/src/index.ts";
import type {
  LocalLifecycleOptions,
  LocalWriteCoordinatorOptions
} from "../../../adapters/local/src/index.ts";
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
  readonly createWriteCoordinator: typeof makeLocalWriteCoordinator;
  readonly createDaemonRuntime: typeof createDaemonRuntime;
  readonly runLedgerMaterializer: (rootInput: HarnessLayoutInput, options: { readonly dryRun?: boolean }) => MaterializerCommandReport;
}

const localProvider = {
  metadata: localAdapterProviderMetadata,
  createLifecycleEngine: (options: LocalLifecycleOptions) => makeLocalLifecycleEngine(options),
  createWriteCoordinator: (options: LocalWriteCoordinatorOptions) => makeLocalWriteCoordinator(options),
  createDaemonRuntime: (options) => createDaemonRuntime(options),
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
