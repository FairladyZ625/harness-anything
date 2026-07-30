import type { RegistryEntityRefV2 } from "./semantic-mutation-envelope-v2.ts";

const registryVersion = 1;

export function taskDecisionModulePath(taskId: string, documentPath: string): string {
  return `tasks/${taskId}/${documentPath}`;
}

export function taskDecisionModuleEntityRef(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion, entityKind, canonicalRef };
}
