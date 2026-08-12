export interface AdapterProviderMetadata { readonly id: string; readonly capabilities: ReadonlyArray<string>;
  readonly readonly: boolean; readonly writable: boolean; readonly defaultProvider?: boolean }
