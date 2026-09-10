import type { PresetResolverOptions } from "./preset-resolver-types.ts";
import { createRuntime } from "./preset-runtime.ts";
import type { CanonicalPresetResolver } from "./preset.contract.ts";

export function createCanonicalPresetResolver(options: PresetResolverOptions): CanonicalPresetResolver {
  return createRuntime(options).resolver;
}
