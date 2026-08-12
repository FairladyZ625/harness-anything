import type { AdapterProviderMetadata } from "./types.ts";
export type { AdapterProviderMetadata } from "./types.ts";
export const localAdapterProviderMetadata = {
  id: "local", capabilities: ["git-diff.read"], readonly: true, writable: false, defaultProvider: true
} as const satisfies AdapterProviderMetadata;
