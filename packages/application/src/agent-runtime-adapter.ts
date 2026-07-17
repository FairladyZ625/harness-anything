import type {
  RuntimeCapabilityName,
  RuntimeInstallation,
  RuntimeSession
} from "../../kernel/src/index.ts";

export type RuntimeCapabilityMatrix = Readonly<Record<RuntimeCapabilityName, boolean>>;

export interface RuntimeIdentifyResult {
  readonly installations: ReadonlyArray<RuntimeInstallation>;
  readonly sessions: ReadonlyArray<RuntimeSession>;
}

export interface RuntimeSpawnInput {
  readonly installationId: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly authenticationProfileKind: string;
  readonly resumeProviderSessionId?: string;
  readonly clientBinding?: RuntimeSession["clientBinding"];
}

export interface RuntimeSpawnResult {
  readonly runtimeSessionId: string;
}

export interface RuntimeAttachInput {
  readonly runtimeSessionId: string;
}

export interface RuntimeAdapterEvent {
  readonly kind: "provider-session" | "heartbeat" | "completed" | "failed";
  readonly observedAt: string;
  readonly providerSessionId?: string;
  readonly summary?: string;
}

export interface RuntimeAdapterTransport {
  readonly identify: () => Promise<RuntimeIdentifyResult>;
  readonly spawn: (input: RuntimeSpawnInput) => Promise<RuntimeSpawnResult>;
  readonly attach?: (input: RuntimeAttachInput) => Promise<RuntimeSpawnResult>;
  readonly events: (input: RuntimeAttachInput) => Promise<ReadonlyArray<RuntimeAdapterEvent>>;
}

export interface RuntimeAdapter {
  readonly kindId: string;
  readonly capabilities: () => RuntimeCapabilityMatrix;
  readonly identify: () => Promise<RuntimeIdentifyResult>;
  readonly spawn: (input: RuntimeSpawnInput) => Promise<RuntimeSpawnResult>;
  readonly attach: (input: RuntimeAttachInput) => Promise<RuntimeSpawnResult>;
  readonly events: (input: RuntimeAttachInput) => Promise<ReadonlyArray<RuntimeAdapterEvent>>;
}

export class RuntimeAdapterUnsupportedError extends Error {
  readonly code = "runtime_capability_unsupported";
  readonly kindId: string;
  readonly capability: RuntimeCapabilityName;

  constructor(kindId: string, capability: RuntimeCapabilityName) {
    super(`${kindId} does not support runtime capability: ${capability}`);
    this.name = "RuntimeAdapterUnsupportedError";
    this.kindId = kindId;
    this.capability = capability;
  }
}

export function makeRuntimeAdapter(options: {
  readonly kindId: string;
  readonly capabilities: RuntimeCapabilityMatrix;
  readonly transport: RuntimeAdapterTransport;
}): RuntimeAdapter {
  const requireCapability = <T>(name: RuntimeCapabilityName, operation: () => Promise<T>): Promise<T> => {
    if (!options.capabilities[name]) return Promise.reject(new RuntimeAdapterUnsupportedError(options.kindId, name));
    return operation();
  };
  return {
    kindId: options.kindId,
    capabilities: () => options.capabilities,
    identify: () => requireCapability("discover", options.transport.identify),
    spawn: (input) => requireCapability(input.resumeProviderSessionId ? "resume" : "spawn", () => options.transport.spawn(input)),
    attach: (input) => requireCapability("attach", () => {
      if (!options.transport.attach) throw new RuntimeAdapterUnsupportedError(options.kindId, "attach");
      return options.transport.attach(input);
    }),
    events: (input) => requireCapability("events", () => options.transport.events(input))
  };
}
