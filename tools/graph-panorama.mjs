#!/usr/bin/env node
import process from "node:process";
import { generateGraphPanorama } from "../packages/cli/src/commands/graph-panorama.ts";

export { generateGraphPanorama };

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--root" || token === "--projection" || token === "--out" || token === "--focus") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      index += 1;
      if (token === "--root") options.rootDir = value;
      if (token === "--projection") options.projectionPath = value;
      if (token === "--out") options.outputPath = value;
      if (token === "--focus") options.focus = value;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const report = generateGraphPanorama(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`Graph panorama written to ${report.outputPath}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
