import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  eventObjectTarget,
  makeTaskEventStore,
  makeTaskProjection,
  serializeCanonicalEvent,
  serializeEventHead,
  sha256Text,
  type TaskEventV1,
} from "../../kernel/src/index.ts";
import {
  acceptBuiltinVerticalScriptPlan,
  compilePresetSnapshotUpgrade,
  compileRepoTaskPackage,
  compileRepositoryScaffold,
  compileTaskBootstrap,
  createCanonicalPresetResolver,
  installPresetPackage,
  prepareBuiltinVerticalScriptExecution,
  runPresetAction,
  uninstallPresetPackage,
} from "../src/index.ts";
import {
  createRuntime,
  decodePresetPackageV3,
} from "../src/preset-resolver.ts";

export function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-preset-resolver-")),
    bundledRoot = path.join(root, "bundled"),
    userRoot = path.join(root, "user"),
    assetsRoot = path.join(root, "assets"),
    presetRoot = path.join(bundledRoot, "standard-task");
  cpSync(new URL("../assets/software-coding/", import.meta.url), assetsRoot, {
    recursive: true,
  });
  write(
    path.join(presetRoot, "preset.json"),
    JSON.stringify({
      schema: "preset-manifest/v3",
      id: "standard-task",
      title: "Standard Task",
      vertical: "software/coding",
      version: "3.0.0",
      kind: "template-content",
      outputShape: "repository-diff",
      kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
      capabilityImports: [],
      profiles: [
        {
          id: "baseline",
          title: "Baseline",
          completionGates: ["ci", "code-doc-reconciliation"],
          templateSelections: [],
        },
      ],
      defaultProfile: "baseline",
    }),
  );
  write(
    path.join(presetRoot, "PRESET.md"),
    "---\nschema: preset-document/v1\ndescription: General task\nwhenToUse: Use for ordinary repository work.\n---\n# Standard Task\n",
  );
  write(
    path.join(assetsRoot, "capabilities.json"),
    JSON.stringify({ schema: "preset-capabilities/v1", providers: [] }),
  );
  mkdirSync(userRoot, { recursive: true });
  return {
    bundledRoot,
    userRoot,
    assetsRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
export function writePackage(
  root: string,
  id: string,
  extra: Record<string, unknown> = {},
): void {
  const identity = extra.kind === "agent" || extra.kind === "squad",
    taskShape = identity
      ? {}
      : {
          kind: "template-content",
          outputShape: "repository-diff",
          kernelVersionRange: { min: "1.0.0" },
          capabilityImports: [],
          profiles: [
            {
              id: "baseline",
              title: "Baseline",
              completionGates: [],
              templateSelections: [],
            },
          ],
          defaultProfile: "baseline",
        };
  write(
    path.join(root, id, "preset.json"),
    JSON.stringify({
      schema: "preset-manifest/v3",
      id,
      title: id,
      vertical: "software/coding",
      version: "3.0.0",
      ...taskShape,
      ...extra,
    }),
  );
  write(
    path.join(root, id, "PRESET.md"),
    `---\nschema: preset-document/v1\ndescription: ${id}\nwhenToUse: Test ${id}.\n---\n# ${id}\n`,
  );
}
export function templateCatalog(
  documents: readonly Record<string, unknown>[],
  id = "fixture",
) {
  return {
    schema: "template-catalog/v2",
    package: {
      id,
      title: id,
      version: "1.0.0",
      owner: "test",
      locales: ["en-US"],
    },
    documents,
  };
}
export function write(target: string, body: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${body}${body.endsWith("\n") ? "" : "\n"}`);
}
export function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}
