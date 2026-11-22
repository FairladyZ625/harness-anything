#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createModelPricingCatalog } from "../packages/daemon/src/runtime-engine/model-pricing-catalog.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  outputPath = path.join(root, "packages/daemon/src/runtime-engine/model-pricing-catalog.json"),
  defaultUrl = "https://models.dev/api.json";

function optionsFrom(argv) {
  const options = { mode: "write", url: defaultUrl, input: undefined, version: new Date().toISOString().slice(0, 10) };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check" || arg === "--write") options.mode = arg.slice(2);
    else if (["--url", "--input", "--version"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--url") options.url = value;
      else if (arg === "--input") options.input = value;
      else options.version = value;
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (options.input && options.url !== defaultUrl) throw new Error("--input and --url are mutually exclusive");
  return options;
}

async function sourceData(options) {
  if (options.input) return JSON.parse(await readFile(path.resolve(options.input), "utf8"));
  const response = await fetch(options.url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`models.dev request failed with HTTP ${response.status}`);
  return response.json();
}

export async function syncModelPricing(argv = process.argv.slice(2)) {
  const options = optionsFrom(argv),
    catalog = createModelPricingCatalog({
      modelsDev: await sourceData(options),
      version: options.version,
      source: options.url,
    }),
    serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  if (options.mode === "check") {
    const current = await readFile(outputPath, "utf8");
    if (current !== serialized)
      throw new Error("model pricing catalog is stale; run node tools/sync-model-pricing.mjs --write");
  } else await writeFile(outputPath, serialized, "utf8");
  const byProvider = Object.fromEntries(
    [...new Set(catalog.models.map(({ provider }) => provider))].map((provider) => [
      provider,
      catalog.models.filter((model) => model.provider === provider).length,
    ]),
  );
  console.log(
    `models.dev ${options.mode}: ${catalog.models.length} priced models (${JSON.stringify(byProvider)}), version ${catalog.version}`,
  );
  return catalog;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncModelPricing().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
