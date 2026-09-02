import { isRendererRecord } from "./result-validation.ts";

export interface GuiConnectionInfo {
  readonly kind: "local" | "ssh";
  /** The endpoint the GUI actually uses, never the private key or SSH command. */
  readonly endpoint: string;
  readonly user?: string;
  readonly hostKeyAlias?: string;
}

export function isGuiConnectionInfo(value: unknown): value is GuiConnectionInfo {
  return (
    isRendererRecord(value) &&
    ["local", "ssh"].includes(String(value.kind)) &&
    typeof value.endpoint === "string" &&
    (value.user === undefined || typeof value.user === "string") &&
    (value.hostKeyAlias === undefined || typeof value.hostKeyAlias === "string")
  );
}
