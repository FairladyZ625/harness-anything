import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startBrowserGuiBroker } from "../src/cli/gui-browser-broker.ts";

export function startBrowserGuiFixture(guiPackageRoot: string, repoRoot: string, indexHtml: string) {
  const dist = path.join(guiPackageRoot, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, "index.html"), indexHtml);
  return startBrowserGuiBroker(guiPackageRoot, repoRoot);
}
