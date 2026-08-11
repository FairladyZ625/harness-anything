import type { HarnessLayoutOverrides } from "../../../kernel/src/index.ts";

export interface LocalJournalActor {
  readonly kind: "agent" | "human" | "system";
  readonly id: string;
}

export interface LocalWriteCoordinatorOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly actor?: LocalJournalActor;
  readonly sessionId?: string;
  readonly autoMaterialize?: boolean;
  readonly commitAuthor?: {
    readonly name: string;
    readonly email: string;
  };
}

export interface AdapterProviderMetadata {
  readonly id: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly readonly: boolean;
  readonly writable: boolean;
  readonly defaultProvider?: boolean;
}
