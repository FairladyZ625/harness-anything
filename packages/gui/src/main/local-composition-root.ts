import path from "node:path";
import { makeLocalLifecycleEngine } from "../../../adapters/local/src/index.ts";
import { makeLocalControllerService } from "../../../application/src/index.ts";
import { createGuiServiceBridgeForService } from "../api/service-bridge.ts";
import type { GuiServiceBridge } from "../api/service-bridge.ts";

export function createLocalGuiServiceBridge(rootDir: string): GuiServiceBridge {
  const resolvedRootDir = path.resolve(rootDir);
  return createGuiServiceBridgeForService(
    resolvedRootDir,
    makeLocalControllerService({
      rootDir: resolvedRootDir,
      taskWriter: makeLocalLifecycleEngine({ rootDir: resolvedRootDir })
    })
  );
}
