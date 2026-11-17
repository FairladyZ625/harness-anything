import { guiHostBridge } from "../gui-transport.ts";

/** Desktop IPC owns host admission. The browser surface has no preload or shell capability. */
export async function openExternalUrl(url: string): Promise<void> {
  const bridge = guiHostBridge();
  if (bridge) {
    if (!bridge.externalUrl) throw new Error("External URL bridge is unavailable.");
    await bridge.externalUrl.open(url);
    return;
  }
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:")
    throw new Error("External URL must be an HTTP(S) address.");
  window.open(url, "_blank", "noopener,noreferrer");
}
