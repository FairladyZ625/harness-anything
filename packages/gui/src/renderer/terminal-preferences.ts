import { consumeKnownError } from "../api/error-consumption.ts";
import { isRendererRecord } from "./result-validation.ts";

const schema = "terminal-preferences/v1",
  storageKey = "harness:gui:terminal-preferences";

export interface TerminalPreferences {
  readonly backend: "direct-pty" | "tmux";
  readonly dockPosition: "bottom" | "right";
  readonly bottomHeight: number;
  readonly rightWidth: number;
}

export const defaultTerminalPreferences: TerminalPreferences = {
  backend: "direct-pty",
  dockPosition: "bottom",
  bottomHeight: 352,
  rightWidth: 560,
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
      !["direct-pty", "tmux"].includes(String(parsed.backend)) ||
      !["bottom", "right"].includes(String(parsed.dockPosition)) ||
      !positiveSize(parsed.bottomHeight) ||
      !positiveSize(parsed.rightWidth)
    )
      return { ...defaultTerminalPreferences };
    return {
      backend: parsed.backend as TerminalPreferences["backend"],
      dockPosition: parsed.dockPosition as TerminalPreferences["dockPosition"],
      bottomHeight: Number(parsed.bottomHeight),
      rightWidth: Number(parsed.rightWidth),
    };
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

function positiveSize(value: unknown): boolean {
  return Number.isFinite(value) && Number(value) > 0;
}
