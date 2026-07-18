export interface JsonRpcConnection {
  readonly write: (frame: unknown) => void;
  readonly onFrame: (listener: (frame: unknown) => void) => () => void;
  readonly onClose: (listener: (error?: Error) => void) => () => void;
  readonly close: () => Promise<void>;
}

export interface PersistentTransport {
  readonly open: (endpoint: string, signal?: AbortSignal) => Promise<JsonRpcConnection>;
}
