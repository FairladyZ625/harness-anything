import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { sha256Text } from "@harness-anything/kernel";

type ScriptSyntaxResult = { readonly ok: true } | { readonly ok: false; readonly hint: string };

const scriptSyntaxCache = new Map<string, ScriptSyntaxResult>();
const maximumScriptSyntaxCacheEntries = 128;

export function cachedScriptSyntaxCheck(scriptPath: string, manifestRoot: string): ScriptSyntaxResult {
  const realScriptPath = realpathSync.native(scriptPath);
  const cacheKey = `${process.version}:${sha256Text(readFileSync(realScriptPath, "utf8"))}`;
  const cached = scriptSyntaxCache.get(cacheKey);
  if (cached) return cached;
  const syntax = spawnSync(process.execPath, ["--check", realScriptPath], {
    cwd: manifestRoot,
    encoding: "utf8",
    env: {}
  });
  const result = syntax.status === 0
    ? { ok: true as const }
    : {
      ok: false as const,
      hint: (syntax.stderr || syntax.stdout || "syntax check failed").trim()
    };
  if (scriptSyntaxCache.size >= maximumScriptSyntaxCacheEntries) {
    const oldest = scriptSyntaxCache.keys().next().value;
    if (oldest !== undefined) scriptSyntaxCache.delete(oldest);
  }
  scriptSyntaxCache.set(cacheKey, result);
  return result;
}
