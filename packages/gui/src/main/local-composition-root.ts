import path from "node:path";
import { makeLocalLifecycleEngine } from "../../../adapters/local/src/index.ts";
import { makeLocalControllerService } from "../../../application/src/index.ts";
import type { HarnessLayoutOverrides } from "../../../kernel/src/index.ts";
import { createHarnessRuntimeContext, resolveHarnessRuntimeContext } from "../../../kernel/src/index.ts";
import { createGuiServiceBridgeForService } from "../api/service-bridge.ts";
import type { GuiServiceBridge } from "../api/service-bridge.ts";

export function createLocalGuiServiceBridge(rootDir: string, layoutOverrides?: HarnessLayoutOverrides): GuiServiceBridge {
  const runtimeContext = resolveHarnessRuntimeContext(createHarnessRuntimeContext(path.resolve(rootDir), layoutOverrides));
  const resolvedRootDir = runtimeContext.rootDir;
  return createGuiServiceBridgeForService(
    resolvedRootDir,
    makeLocalControllerService({
      rootDir: resolvedRootDir,
      layoutOverrides,
      taskWriter: makeLocalLifecycleEngine({ rootDir: resolvedRootDir, layoutOverrides })
    }),
    layoutOverrides
  );
}
