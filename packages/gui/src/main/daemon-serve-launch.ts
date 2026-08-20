import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonLaunchSpec } from "@harness-anything/daemon/client/daemon-autostart";

export interface DaemonServeTarget { readonly userRoot: string; readonly daemonId: string }
export interface PackagedRuntime { readonly resourcesPath: string }
// Main-process-only seam: resolves how a trusted local main process launches
// `daemon serve` (packaged runtime node + dist entry, or the dev checkout node +
// source entry with ELECTRON_RUN_AS_NODE). The renderer never reaches this.
export function daemonServeLaunch(target: DaemonServeTarget, packaged?: PackagedRuntime): DaemonLaunchSpec {
  const node = packaged ? path.join(packaged.resourcesPath, "node", `${process.platform}-${process.arch}`, process.platform === "win32" ? "node.exe" : "node") : process.execPath;
  const entry = packaged ? path.join(packaged.resourcesPath, "app", "packages/cli/dist/index.js") : fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url));
  return { command: node, args: [entry, "daemon", "serve", "--user-root", target.userRoot, "--daemon-id", target.daemonId], env: daemonServeEnvironment(!packaged && Boolean(process.versions.electron)) };
}
export function daemonServeEnvironment(electronAsNode: boolean): NodeJS.ProcessEnv { const env: NodeJS.ProcessEnv = {}; for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key]; if (electronAsNode) env.ELECTRON_RUN_AS_NODE = "1"; return env; }
