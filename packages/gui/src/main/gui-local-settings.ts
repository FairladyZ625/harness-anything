import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_GUI_CONNECT_TIMEOUT_MS,
  DEFAULT_GUI_REQUEST_TIMEOUT_MS,
  parseLocalSettings,
  SETTINGS_LOCAL_PATH,
} from "@harness-anything/kernel";

/** This machine's GUI request deadlines: the local settings file, with the declared defaults as fallback. */
export interface GuiRequestTimeouts {
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export { DEFAULT_GUI_CONNECT_TIMEOUT_MS, DEFAULT_GUI_REQUEST_TIMEOUT_MS };

// The daemon's settings action writes `.harness/settings.local.json` under the repository root; this
// reader opens it with the same kernel parser, so raising the two deadlines a person actually tunes
// (connect 75ms→2s; default read 200ms→2s→10s→30s, 泽宇 2026-09-01/02 三次亲裁调高) is a settings change
// instead of a source edit and a release. Like the registry reader in repo-scoped-target.ts, this is a
// main-process read of a daemon-owned machine-local file. A value picked up at first use stays for the
// app's life, like any other startup configuration.
const guiTimeoutsByRoot = new Map<string, GuiRequestTimeouts>();

export function guiRequestTimeouts(rootDir: string): GuiRequestTimeouts {
  const cached = guiTimeoutsByRoot.get(rootDir);
  if (cached) return cached;
  // A root with no local settings file is the normal state before the first settings update; the
  // declared defaults govern. A file that exists but is broken fails naming it — the person who owns
  // the machine sees which file to repair instead of silently reading the defaults.
  const file = path.join(rootDir, ...SETTINGS_LOCAL_PATH.split("/"));
  let value: GuiRequestTimeouts = {
    connectTimeoutMs: DEFAULT_GUI_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: DEFAULT_GUI_REQUEST_TIMEOUT_MS,
  };
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8"); // a filesystem error names this path itself
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (error) {
      // A JSON syntax error alone does not say which file is corrupt; rethrow so it does. Nothing is substituted.
      throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    const parsed = parseLocalSettings(document);
    if (!parsed) throw new Error(`${file} does not hold a valid settings-local/v1 document.`);
    value = { connectTimeoutMs: parsed.gui.connectTimeoutMs, requestTimeoutMs: parsed.gui.requestTimeoutMs };
  }
  guiTimeoutsByRoot.set(rootDir, value);
  return value;
}
