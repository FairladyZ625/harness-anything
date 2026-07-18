import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const host = readFileSync("dist/extension.cjs", "utf8");
const webview = readFileSync("dist/webview.js", "utf8");
if (!host.includes('require("vscode")')) throw new Error("extension host must externalize vscode");
if (/\brequire\(["'](?:node:|fs|path|net|crypto)/u.test(webview)) throw new Error("webview bundle contains a Node builtin");
if (/https?:\/\//u.test(webview)) throw new Error("webview bundle contains a CDN or remote URL");

const vsix = process.argv[2];
if (vsix) {
  const listing = spawnSync("unzip", ["-Z1", vsix], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error(listing.stderr || "cannot inspect VSIX");
  const entries = new Set(listing.stdout.trim().split(/\r?\n/u));
  for (const required of [
    "extension/package.json",
    "extension/dist/LICENSE.txt",
    "extension/dist/extension.cjs",
    "extension/dist/webview.js"
  ]) {
    if (!entries.has(required)) throw new Error(`VSIX missing ${required}`);
  }
}

console.log(vsix ? "VSIX artifact verification passed." : "VS Code dual-target artifact verification passed.");
