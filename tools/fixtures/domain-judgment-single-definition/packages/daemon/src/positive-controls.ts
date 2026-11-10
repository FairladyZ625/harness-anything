export function canAdoptRuntime(
  context: { readonly processes: Map<string, unknown> },
  runtimeSessionId: string,
): boolean {
  if (context.processes.has(runtimeSessionId)) return false;
  return true;
}
