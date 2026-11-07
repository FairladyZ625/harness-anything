#!/usr/bin/env node
/**
 * CLI path contract gate (dec_ABECABC8044E25C24591AE4216/CH1).
 *
 * Two invariants, both evaluated against the command registry itself so a new command is covered
 * without editing this file:
 *
 *   1. Every value-taking input in the registry declares the coordinate it is read in:
 *      `ledger-document` / `workspace-file` / `cli-local` / `host-path` / `non-path`. The
 *      declaration is mandatory rather than inferred from the flag name, so a new command cannot
 *      hide a path behind an ordinary-looking flag such as `--input` or `--candidate`. A field
 *      that is not a path states that explicitly instead of being absent.
 *   2. Every write command with a document selection goes through the one doc action pipeline that
 *      refuses an unmatched selection. A new write command with `--path` that is not wired to that
 *      pipeline is named here instead of returning "applied" for zero candidates.
 *
 * The repository-relative invariant covers repository and ledger content. `cli-local` is the
 * explicit exception category: it names a file on the machine running the CLI, never repository
 * content. Credential-file inputs (`--password-file`, `--api-key-file`, `--credential-file`,
 * certificates) are the adjudicated case (CEO, 2026-11-07, fact F-0B58827E): credentials must
 * never be committed, so forcing a repository-relative path would push secrets into the repo and
 * forward an unreadable path to the center. `task artifact add --source` is the other member of
 * the category: the caller's local file whose bytes are copied into the ledger. The exemption is
 * declared per input with `pathKind: "cli-local"` plus `pathReader: "cli-local"`; it is a
 * category, not a per-command allowlist, and every input still states its coordinate.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentPath } from "../packages/kernel/src/domain/doc-sync-codec.ts";
import { resolveWorkspaceDocumentPath } from "../packages/kernel/src/layout/index.ts";
import { isDocAction } from "../packages/daemon/src/doc-sync-command-actions.ts";
import { validateSelectedDocPaths } from "../packages/daemon/src/doc-sync-candidate-scanner.ts";
import { daemonProtocolCommands } from "../packages/daemon/src/protocol/daemon-protocol-commands.ts";
import { parseThinCommand } from "../packages/cli/src/cli/thin-command.ts";
import { materializePromptFile } from "../packages/cli/src/cli-runtime-prompt-file.ts";
import { readRuntimeBatchFile } from "../packages/cli/src/cli-runtime-batch-input.ts";
import { workspaceText } from "../packages/daemon/src/repo-cell-packets.ts";

// CLI-host files: the one exempt coordinate. Credential material is the adjudicated case
// (fact F-0B58827E) and `task artifact add --source` is the caller-local artifact source; neither
// is repository content, so neither is normalized to a repository path.
const CLI_LOCAL_PATH_KIND = "cli-local";
const PATH_KINDS = new Set(["ledger-document", "workspace-file", CLI_LOCAL_PATH_KIND, "host-path", "non-path"]);
const WORKSPACE_FILE_READERS = new Set(["workspace-text", "prompt-file", "runtime-batch"]);
const WRITE_CLASSES = new Set(["repo-write", "arbiter", "admin"]);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI_SOURCE_ROOT = path.join(REPO_ROOT, "packages/cli/src");
// The reader modules are the only places allowed to call `readFileSync` with a declared
// workspace-file field. A command handler that raw-reads its own field bypasses the containment
// boundary even when its registry declaration names the right reader.
const WORKSPACE_FILE_READER_FILES = new Set([
  "cli-workspace-file.ts",
  "cli-runtime-prompt-file.ts",
  "cli-runtime-batch-input.ts",
]);
// The registry is the only list. A path input is a path input because its declaration says so,
// never because of what the flag is named: the gate requires a coordinate on every value-taking
// input, so a name this file has never seen still has to make the choice explicit.
const isPathTokenName = (name) =>
  name === "path" ||
  name === "source" ||
  name === "destination" ||
  name === "cwd" ||
  name === "root" ||
  name === "target" ||
  name === "backup" ||
  /(?:^|-)(?:file|dir|directory|root)$/u.test(name);
const isPositionalPathInputName = (token) => {
  const name = token.replace(/^\[/u, "").replace(/\]$/u, "").replace(/^</u, "").replace(/>$/u, "");
  return name !== token && isPathTokenName(name);
};

export function checkCliPathContract({ commands = daemonProtocolCommands, workspaceRoot } = {}) {
  const violations = [];
  const root = workspaceRoot ?? fixtureWorkspace();
  const known = new Set(daemonProtocolCommands.map((command) => command.id));
  const counts = {
    commands: commands.length,
    valueInputs: 0,
    nonPathInputs: 0,
    pathInputs: 0,
    workspaceFiles: 0,
    cliLocalInputs: 0,
    ledgerDocuments: 0,
    zeroHitWriteCommands: 0,
    positionalPaths: 0,
  };

  for (const command of commands) {
    const actionKind = actionKindOf(command);
    for (const input of command.inputs ?? []) {
      // A boolean carries no value, so it cannot name a path. Every other input is a string token
      // and must state its coordinate; absence is the defect this gate exists to find.
      if (input.kind === "boolean") continue;
      counts.valueInputs += 1;
      if (!PATH_KINDS.has(input.pathKind)) {
        violations.push(
          `${command.id} ${input.name}: value input must declare pathKind ` +
            `(${[...PATH_KINDS].join("|")}); an undeclared field cannot be proved non-path`,
        );
        continue;
      }
      if (input.pathKind === "non-path") {
        counts.nonPathInputs += 1;
        continue;
      }
      counts.pathInputs += 1;
      violations.push(...checkPathInput(command, input.name, input, counts, actionKind, root, known));
    }
    // A scalar `<id>` positional is an executable input too: the parser writes it into an action
    // field, so the command must say whether that field names a path. Otherwise `positional:
    // "inputPath"` would be a path input the gate never sees.
    const declaredPositionals = command.positionalInputs ?? [];
    if (command.positional) {
      const declared = declaredPositionals[0];
      if (!declared) {
        violations.push(
          `${command.id} ${command.positional}: positional input must declare pathKind and pathReader, ` +
            `or the gate cannot see which coordinate it is read in`,
        );
      } else {
        counts.valueInputs += 1;
        if (declared.pathKind === "non-path") counts.nonPathInputs += 1;
        else {
          counts.pathInputs += 1;
          counts.positionalPaths += 1;
        }
        violations.push(...checkPathInput(command, declared.name, declared, counts, actionKind, root, known));
      }
    }
    // Positional path tokens are registry syntax too (`runtime batch <batch-file>`), so a new file
    // positional cannot be green by omission. Tokens that are pure help text (an `<id>` with no
    // scalar positional field) are not executable and are skipped.
    for (const token of command.syntaxPath ?? command.path ?? []) {
      if (command.positional || !isPositionalPathInputName(token)) continue;
      const declared = declaredPositionals.find((input) => input.name === token);
      if (!declared) {
        violations.push(
          `${command.id} ${token}: positional path input must declare pathKind and pathReader, ` +
            `or the gate cannot see which coordinate it is read in`,
        );
        continue;
      }
      counts.valueInputs += 1;
      counts.pathInputs += 1;
      counts.positionalPaths += 1;
      violations.push(...checkPathInput(command, token, declared, counts, actionKind, root, known));
    }
  }

  violations.push(...checkRawWorkspaceFileReads(commands));

  // The guard itself, probed once through the same function every doc write selection reaches.
  const missing = "tasks/__gate_probe_missing__/nope.md";
  try {
    validateSelectedDocPaths([missing], {
      rows: [
        {
          path: missing,
          state: "clean",
          reason: null,
          baseBlobSha256: null,
          candidateBlobSha256: null,
        },
      ],
    });
    violations.push("the zero-hit guard accepted an unmatched document selection");
  } catch (error) {
    if (!String(error?.code ?? "").includes("document_not_found") && !String(error?.message ?? "").includes(missing))
      violations.push(`the zero-hit guard did not name the unmatched path: ${String(error)}`);
  }

  // Every shared workspace-file reader must refuse a path outside the selected root. A command can
  // only declare one of these readers, so a new --from-file cannot be green by declaration alone.
  const readerProbes = {
    "workspace-text": () => workspaceText(root, "../outside-gate-probe.json", "gateProbe"),
    "prompt-file": () =>
      materializePromptFile({
        rootDir: root,
        action: { kind: "runtime-steer", promptFile: "../outside-gate-probe.txt" },
      }),
    "runtime-batch": () =>
      readRuntimeBatchFile({
        rootDir: root,
        action: { kind: "runtime-batch", batchFile: "../outside-gate-probe.json" },
      }),
  };
  for (const [reader, probe] of Object.entries(readerProbes)) {
    try {
      probe();
      violations.push(`the ${reader} reader accepted a path outside the workspace root`);
    } catch (error) {
      if (!/outside the workspace|stay within|inside workspace root/iu.test(String(error?.message ?? "")))
        violations.push(`the ${reader} reader refused an outside path for an unrelated reason: ${String(error)}`);
    }
  }

  // The translation itself: the workspace spelling must produce the authored key, and the old
  // authored-relative spelling must be refused from the workspace root. From the ledger root the
  // same authored spelling is that repository's workspace-relative form and stays valid.
  const translated = resolveWorkspaceDocumentPath(root, "harness/tasks/task_a/x.md"),
    ledgerSpelling = resolveWorkspaceDocumentPath(root, "tasks/task_a/x.md"),
    fromLedgerRoot = resolveWorkspaceDocumentPath(path.join(root, "harness"), "tasks/task_a/x.md");
  if (!translated.ok || translated.documentPath !== "tasks/task_a/x.md")
    violations.push("the document-path resolver did not translate the workspace spelling");
  if (ledgerSpelling.ok)
    violations.push("the workspace-root boundary still accepts the old authored-relative spelling");
  if (!fromLedgerRoot.ok || fromLedgerRoot.documentPath !== "tasks/task_a/x.md")
    violations.push("the document-path resolver refused the ledger-root spelling");
  if (documentPath("tasks/task_a/x.md") !== "tasks/task_a/x.md")
    violations.push("the kernel document-path normalizer changed the authored key shape");

  return { ok: violations.length === 0, violations, counts };
}

/**
 * A registry declaration is not proof that the command uses the reader it names. The CLI source is
 * scanned for a raw `readFileSync` of any declared workspace-file action field; only the shared
 * reader modules may perform that read. The field list comes from the registry, so a new command
 * with a new workspace-file flag is covered without editing this check.
 */
export function findRawWorkspaceFileReads(source, fields) {
  const found = [];
  for (const field of fields) {
    if (new RegExp(`readFileSync\\([^)]*\\b${field}\\b`, "su").test(source)) found.push(field);
  }
  return found;
}

function declaredWorkspaceFileFields(commands) {
  const fields = new Set();
  // The action field (`candidatePath`) is what a handler passes to a reader; the flag spelling
  // (`--candidate`) can differ, and matching it would flag unrelated locals that share a word.
  const fieldName = (input) => (typeof input.field === "string" ? input.field : camelName(input.name));
  for (const command of commands) {
    for (const input of command.inputs ?? []) if (input.pathKind === "workspace-file") fields.add(fieldName(input));
    for (const input of command.positionalInputs ?? [])
      if (input.pathKind === "workspace-file") fields.add(fieldName(input));
  }
  return [...fields];
}

function camelName(name) {
  return name
    .replace(/^--/u, "")
    .replace(/^[<[]/u, "")
    .replace(/[>\]]$/u, "")
    .replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

function checkRawWorkspaceFileReads(commands) {
  const fields = declaredWorkspaceFileFields(commands),
    violations = [];
  for (const file of cliSourceFiles(CLI_SOURCE_ROOT)) {
    if (WORKSPACE_FILE_READER_FILES.has(path.basename(file))) continue;
    const source = readFileSync(file, "utf8");
    for (const field of findRawWorkspaceFileReads(source, fields))
      violations.push(
        `${path.relative(REPO_ROOT, file)}: raw read of declared workspace-file field ${field}; ` +
          `use the shared cli-workspace-file.ts reader`,
      );
  }
  return violations;
}

function cliSourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...cliSourceFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
  }
  return files;
}

function checkPathInput(command, label, input, counts, actionKind, root, known) {
  if (!PATH_KINDS.has(input.pathKind))
    return [
      `${command.id} ${label}: path input must declare pathKind ` +
        `(${[...PATH_KINDS].join("|")}); declare whether it names repository content or a host location, ` +
        `or mark it non-path`,
    ];
  if (input.pathKind === "workspace-file") {
    counts.workspaceFiles += 1;
    if (!WORKSPACE_FILE_READERS.has(input.pathReader))
      return [
        `${command.id} ${label}: workspace-file input must declare a shared pathReader ` +
          `(${[...WORKSPACE_FILE_READERS].join("|")}); a declaration without a reader is not checked`,
      ];
  }
  if (input.pathKind === CLI_LOCAL_PATH_KIND) {
    counts.cliLocalInputs += 1;
    // The exempt category still names its reader, so a new command cannot use `cli-local` as a
    // silent free pass for repository content without saying which CLI-host boundary it owns.
    if (input.pathReader !== CLI_LOCAL_PATH_KIND)
      return [
        `${command.id} ${label}: cli-local input must declare pathReader "${CLI_LOCAL_PATH_KIND}"; ` +
          `the CLI-host exemption is a declared category (credential files, caller-local artifact ` +
          `sources), not a default`,
      ];
    return [];
  }
  if (input.pathKind !== "ledger-document") return [];
  counts.ledgerDocuments += 1;
  const violations = [];
  if (!isDocAction(actionKind))
    violations.push(
      `${command.id} ${label}: ledger-document paths are translated by the doc action entry; ` +
        `this command (action kind ${actionKind}) bypasses it`,
    );
  if (input.pathReader !== undefined && input.pathReader !== "doc-action")
    violations.push(`${command.id} ${label}: ledger-document input declares the wrong pathReader`);
  if (WRITE_CLASSES.has(command.commandClass)) {
    counts.zeroHitWriteCommands += 1;
    if (!isDocAction(actionKind))
      violations.push(
        `${command.id}: write command with a document path is not routed through the doc action pipeline; ` +
          `an unmatched selection would not be refused`,
      );
  }
  if (!known.has(command.id) || !label.startsWith("--")) return violations;
  const probe = ledgerDocumentProbe(command, root);
  if (probe.violation) violations.push(probe.violation);
  return violations;
}

function actionKindOf(command) {
  return "actionKind" in command ? command.actionKind : command.id;
}

function ledgerDocumentProbe(command, root) {
  const supplied = new Set(["--path"]);
  const argv = [...command.path.filter((token) => !token.startsWith("<"))];
  for (const input of command.inputs ?? []) {
    if (!input.required || supplied.has(input.name)) continue;
    if (input.kind === "boolean") argv.push(input.name);
    else argv.push(input.name, "gate-probe");
    supplied.add(input.name);
  }
  argv.push("--path", `harness/tasks/task_a/x.md`);
  const parsed = parseThinCommand(argv, root);
  if (!parsed.ok)
    return { violation: `${command.id} --path: workspace-relative spelling was refused: ${parsed.nextAction}` };
  const action = parsed.command.action;
  const values = Array.isArray(action.paths) ? action.paths : [action.path];
  if (!values.every((value) => value === "harness/tasks/task_a/x.md"))
    return {
      violation:
        `${command.id} --path: the parser lost the caller's spelling before the doc action could translate it ` +
        `(${JSON.stringify(values)})`,
    };
  if (action.pathCoordinate !== "workspace")
    return {
      violation:
        `${command.id} --path: the CLI did not mark the caller coordinate, so the doc action entry ` +
        `would read the workspace spelling as an authored key`,
    };
  return {};
}

function fixtureWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-cli-path-gate-"));
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "harness", "harness.yaml"), "schema: harness-settings/v1\n");
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  return root;
}

function readFixture(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain an array of command declarations`);
  return parsed;
}

function main(argv) {
  const fixtureIndex = argv.indexOf("--registry-fixture"),
    fixture = fixtureIndex === -1 ? [] : readFixture(argv[fixtureIndex + 1]);
  const commands = [...daemonProtocolCommands, ...fixture];
  const result = checkCliPathContract({ commands });
  if (!result.ok) {
    console.error(`cli-path-contract: FAIL (${result.violations.length})`);
    for (const violation of result.violations) console.error(`- ${violation}`);
    return 1;
  }
  console.log(
    `cli-path-contract: ok (${result.counts.commands} commands, ${result.counts.valueInputs} typed value inputs, ` +
      `${result.counts.pathInputs} path inputs, ${result.counts.ledgerDocuments} document paths, ` +
      `${result.counts.zeroHitWriteCommands} zero-hit write commands)`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname))
  process.exitCode = main(process.argv.slice(2));
