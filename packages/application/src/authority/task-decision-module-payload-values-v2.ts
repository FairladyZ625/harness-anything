import { semanticAdmissionV2, semanticStringValueV2 } from "./semantic-authority-helpers-v2.ts";

export function taskDecisionModuleText(value: unknown): string {
  const result = semanticStringValueV2(value);
  if (!result || result.trim() !== result) throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  return result;
}

export function taskDecisionModuleNonBlank(value: unknown): string {
  const result = semanticStringValueV2(value);
  if (!result.trim()) throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  return result;
}

export function taskDecisionModuleTextList(value: unknown, code: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) throw semanticAdmissionV2(code);
  const values = value.map(taskDecisionModuleText);
  if (values.length === 0 || new Set(values).size !== values.length) throw semanticAdmissionV2(code);
  return values;
}

export function taskDecisionModuleRegistryKey(value: unknown): string {
  const result = taskDecisionModuleText(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(result)) throw semanticAdmissionV2("MODULE_KEY_INVALID");
  return result;
}
