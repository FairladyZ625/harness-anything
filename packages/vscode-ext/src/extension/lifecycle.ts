export interface ExtensionDisposable {
  readonly dispose: () => void | Promise<void>;
}

const resources = new Set<ExtensionDisposable>();

export function registerExtensionResource(resource: ExtensionDisposable): ExtensionDisposable {
  resources.add(resource);
  return { dispose: () => { resources.delete(resource); } };
}

export async function disposeExtensionResources(timeoutMs = 1_000): Promise<void> {
  const pending = [...resources];
  resources.clear();
  await Promise.race([
    Promise.allSettled(pending.map((resource) => resource.dispose())).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}
