#!/usr/bin/env node
/**
 * Repository-wide Prettier gate.
 *
 * Until this existed, `prettier` was only reachable through the lint-staged pre-commit
 * hook, which formats just the files a contributor happened to stage. Files nobody
 * touched therefore drifted from prettier.config.mjs and stayed drifted: `main` had 71
 * unformatted source and test files when this gate landed.
 *
 * The range is the lint-staged range, widened to the whole tree. `tools/check-format.test.mjs`
 * asserts that parity, so adding a new extension to the hook without widening this gate
 * fails a test instead of silently leaving that extension ungated.
 *
 * `--end-of-line auto` is deliberate: `.gitattributes` keeps source convertible, so a
 * Windows (core.autocrlf=true) checkout holds CRLF bytes for the same clean content. The
 * formatting assertion is about layout, not about which newline the checkout wrote; judging
 * the checkout's line endings here would fail contributors for a conversion the repository
 * says is allowed. Prettier still reports genuinely unformatted content either way.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Same extensions as package.json `lint-staged`, across the whole tree instead of only staged paths.
export const FORMAT_GLOB = "**/*.{ts,tsx,js,mjs}";

const prettierBin = createRequire(import.meta.url).resolve("prettier/bin/prettier.cjs");

export function checkFormat({ rootDir = process.cwd(), glob = FORMAT_GLOB } = {}) {
  const result = spawnSync(process.execPath, [prettierBin, "--check", "--end-of-line", "auto", glob], {
    cwd: rootDir,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkFormat();
  if (result.ok) {
    console.log(`Format check passed (${FORMAT_GLOB}).`);
  } else {
    if (result.output) console.error(result.output);
    console.error(`Format check failed: run \`npx prettier --write "${FORMAT_GLOB}"\` and commit the result.`);
    process.exitCode = 1;
  }
}
