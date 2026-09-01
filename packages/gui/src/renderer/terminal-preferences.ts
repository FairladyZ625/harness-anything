import { consumeKnownError } from "../api/error-consumption.ts";
import { isRendererRecord } from "./result-validation.ts";

const schema = "terminal-preferences/v1",
  storageKey = "harness:gui:terminal-preferences";

/** 终端页本地偏好。dock 停靠位置/尺寸随底部 dock 一并撤销(PLT-TerminalWorkspace W0)。 */
export interface TerminalPreferences {
  readonly backend: "direct-pty" | "tmux";
}

export const defaultTerminalPreferences: TerminalPreferences = {
  backend: "direct-pty",
};

export interface TerminalPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readTerminalPreferences(storage: Pick<TerminalPreferenceStorage, "getItem">): TerminalPreferences {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    if (
      !isRendererRecord(parsed) ||
      parsed.schema !== schema ||
      !["direct-pty", "tmux"].includes(String(parsed.backend))
    )
      return { ...defaultTerminalPreferences };
    return { backend: parsed.backend as TerminalPreferences["backend"] };
  } catch (cause) {
    consumeKnownError(cause);
    return { ...defaultTerminalPreferences };
  }
}

export function writeTerminalPreferences(
  storage: Pick<TerminalPreferenceStorage, "setItem">,
  preferences: TerminalPreferences,
): void {
  try {
    storage.setItem(storageKey, JSON.stringify({ schema, ...preferences }));
  } catch (cause) {
    consumeKnownError(cause);
  }
}
