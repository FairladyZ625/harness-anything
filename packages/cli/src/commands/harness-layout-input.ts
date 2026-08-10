import type { HarnessLayoutInput, HarnessLayoutOverrides } from "@harness-anything/kernel";

export function layoutOverridesFromInput(rootInput: HarnessLayoutInput): HarnessLayoutOverrides | undefined {
  return typeof rootInput === "string" ? undefined : rootInput.layoutOverrides;
}
