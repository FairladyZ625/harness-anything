#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { landedSettingsRegistry } from "@harness-anything/kernel";

const generatedHeader = [
  "# GENERATED FILE: do not edit by hand.",
  "# Source: packages/kernel/src/config/landed-settings-registry.ts",
  "# Regenerate: node tools/generate-settings-examples.mjs",
  ""
];

export function renderHarnessYamlExample() {
  const root = branch();
  for (const definition of landedSettingsRegistry) {
    if (!definition.yamlPath) continue;
    insertDefinition(root, definition.yamlPath, definition);
  }
  return [...generatedHeader, "schema: harness-anything/v1", "settings:", ...renderBranch(root, 1), ""].join("\n");
}

export function renderEnvExample() {
  const lines = [...generatedHeader];
  for (const definition of landedSettingsRegistry) {
    const details = [
      `${definition.cluster} ${definition.description}`,
      `unit=${definition.unit}`,
      `default=${formatDefault(definition.defaultValue)}`,
      `override=${definition.overrideChain.join(" < ")}`,
      ...(definition.yamlPath ? [`yaml=settings.${definition.yamlPath.join(".")}`] : []),
      ...(definition.flag ? [`flag=${definition.flag}`] : []),
      ...(definition.callerOption ? [`caller-option=${definition.callerOption}`] : [])
    ];
    lines.push(`# ${details.join("; ")}`, `${definition.env}=${formatEnvValue(definition.defaultValue)}`, "");
  }
  return lines.join("\n");
}

export function writeSettingsExamples(root = process.cwd()) {
  writeFileSync(path.join(root, "harness.yaml.example"), renderHarnessYamlExample(), "utf8");
  writeFileSync(path.join(root, ".env.example"), renderEnvExample(), "utf8");
}

function branch() {
  return { children: new Map(), definition: undefined };
}

function insertDefinition(root, yamlPath, definition) {
  let current = root;
  for (const segment of yamlPath) {
    let child = current.children.get(segment);
    if (!child) {
      child = branch();
      current.children.set(segment, child);
    }
    current = child;
  }
  current.definition = definition;
}

function renderBranch(current, depth) {
  const lines = [];
  for (const [key, child] of current.children) {
    const indent = "  ".repeat(depth);
    if (child.definition) {
      const definition = child.definition;
      lines.push(
        `${indent}# ${definition.cluster} ${definition.description}; unit=${definition.unit}; override=${definition.overrideChain.join(" < ")}`,
        `${indent}${key}: ${formatYamlValue(definition.defaultValue)}`
      );
      continue;
    }
    lines.push(`${indent}${key}:`, ...renderBranch(child, depth + 1));
  }
  return lines;
}

function formatDefault(value) {
  return value === undefined ? "unset" : String(value);
}

function formatEnvValue(value) {
  return value === undefined ? "" : String(value);
}

function formatYamlValue(value) {
  if (value === undefined) return "null";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  writeSettingsExamples();
}
