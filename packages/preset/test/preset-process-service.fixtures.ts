import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INITIAL_SETTINGS_V1 } from "../../kernel/src/index.ts";
import {
  createPresetProcessService as createProjectedPresetProcessService,
  type PresetProcessServiceOptions,
} from "../src/index.ts";

export const createPresetProcessService = (options: Omit<PresetProcessServiceOptions, "readSettings">) =>
  createProjectedPresetProcessService({
    ...options,
    readSettings: () => INITIAL_SETTINGS_V1,
  });

export function write(target: string, body: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

export async function waitFor<T>(description: string, read: () => T, done: (value: T) => boolean): Promise<T> {
  let last: T;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    last = read();
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}; last observed: ${JSON.stringify(last!)}`);
}
