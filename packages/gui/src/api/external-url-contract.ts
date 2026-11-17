export const EXTERNAL_URL_OPEN_CHANNEL = "harness:externalUrl:open";

/** A user-selected HTTP(S) address, never a file or an arbitrary shell target. */
export interface ExternalUrlApi {
  readonly open: (url: string) => Promise<void>;
}
