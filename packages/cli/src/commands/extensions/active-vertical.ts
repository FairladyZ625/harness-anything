import type { HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import type { CliResult } from "../../cli/types.ts";
import { customVerticalGateResult, readProjectHarnessSettings } from "../settings.ts";
import {
  bundledVerticalDefinitionEntry,
  type BundledVerticalDefinitionEntry
} from "./bundled.ts";

export const DEFAULT_ACTIVE_VERTICAL_ID = "software/coding";

export type ActiveVerticalResolution = {
  readonly ok: true;
  readonly id: string;
  readonly definition: BundledVerticalDefinitionEntry;
} | {
  readonly ok: false;
  readonly result: CliResult;
};

export function resolveActiveVertical(
  rootInput: HarnessLayoutInput,
  command: string
): ActiveVerticalResolution {
  const settings = readProjectHarnessSettings(rootInput, command);
  if (!settings.ok) return settings;

  const id = settings.settings.defaultVertical ?? DEFAULT_ACTIVE_VERTICAL_ID;
  const definition = bundledVerticalDefinitionEntry(id);
  if (definition) return { ok: true, id, definition };

  return {
    ok: false,
    result: customVerticalGateResult(rootInput, command, settings.settings)
  };
}
