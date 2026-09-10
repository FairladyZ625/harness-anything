import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ESLint } from "eslint";
import tsParser from "@typescript-eslint/parser";
import noPollSpin from "./gates/eslint-rules/no-poll-spin.js";

const gateId = "check-poll-spin-boundary";
const allowlistPath = `tools/gate-allowlists/${gateId}.json`;
const update = process.argv.includes("--update");
const rootArg = process.argv.slice(2).find((argument) => argument !== "--update");
const root = path.resolve(rootArg ?? process.cwd());
const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.{js,mjs,ts,tsx}"],
      languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 2024, sourceType: "module" } },
      plugins: { ha: { rules: { "no-poll-spin": noPollSpin } } },
      rules: { "ha/no-poll-spin": ["error", { baseline: [], root }] },
    },
  ],
});
const patterns = ["packages/*/src/**/*.{ts,tsx,js,mjs}", "tools/gates/**/*.{js,mjs}"];
const results = await eslint.lintFiles(patterns);
const keys = new Set();
for (const result of results) {
  if (result.filePath.endsWith("no-poll-spin.js")) continue;
  for (const message of result.messages) {
    const key = /Baseline key: (\S+)/u.exec(message.message)?.[1];
    if (key) keys.add(key);
  }
}
if (update) {
  const exceptions = [...keys].sort().map((key) => ({
    key,
    event: "baseline-2026-09-10: no awaitable completion event is exposed by the current API",
    ref: "dec_EF5F3820E81FB8A5266F1F3342",
    reason: "Existing polling or synchronous bridge at the CH3 baseline.",
  }));
  const document = { schema: "harness-anything/gate-allowlist/v1", gateId, entries: { exceptions } };
  await writeFile(path.join(root, allowlistPath), `${JSON.stringify(document, null, 2)}\n`);
}
const document = JSON.parse(await readFile(path.join(root, allowlistPath), "utf8"));
const entries = document.entries.exceptions;
for (const field of ["key", "event", "ref", "reason"]) {
  if (entries.some((entry) => typeof entry[field] !== "string" || !entry[field]))
    throw new Error(`poll-spin allowlist entry missing ${field}`);
}
const expected = new Set(entries.map((entry) => entry.key));
const missing = [...keys].filter((key) => !expected.has(key));
const stale = [...expected].filter((key) => !keys.has(key));
if (missing.length || stale.length)
  throw new Error(
    [
      ...missing.map((key) => `unlisted: ${key}`),
      ...stale.map((key) => `stale: ${key}`),
      `update ${allowlistPath} with event, ref, and reason`,
    ].join("\n"),
  );
console.log(`${gateId}: ${keys.size} allowed sites`);
