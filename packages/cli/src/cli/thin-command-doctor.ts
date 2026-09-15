import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { daemonProtocolCommands } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { globalOption, stripGlobals } from "./thin-command-flags.ts";
import { cliCommandDomains, clientLocalCommands, firstCliCommandIndex } from "./thin-command-help.ts";
import { parseThinCommand } from "./thin-command.ts";

export interface DoctorFinding {
  readonly path: string;
  readonly line: number;
  readonly command: string;
  readonly code: string;
  readonly reason: string;
}

export interface DoctorReport {
  readonly checked: number;
  readonly findings: readonly DoctorFinding[];
}

export interface DoctorCommand {
  readonly line: number;
  readonly command: string;
}

// Commands the entry dispatches before parseThinCommand (daemon control, offline storage, meta, GUI)
// have no descriptor-driven flag parse, so doctor can only prove their command path still exists.
// Every other invocation goes through parseThinCommand itself — the same pipeline the CLI runs.
const doctorLocalRoots: readonly string[] = [
    "backup",
    "capabilities",
    "daemon",
    "doctor",
    "events",
    "gui",
    "restore",
    "version",
  ],
  doctorLocalPaths: readonly (readonly string[])[] = Object.freeze([
    ["backup"],
    ["capabilities"],
    ["doctor"],
    ["doctor", "commands"],
    ["restore"],
    ["events", "tail"],
    ["version"],
    ...clientLocalCommands.map((command) => command.path.filter((token) => !token.startsWith("-"))),
    ...daemonProtocolCommands
      .filter((command) => command.path[0] === "daemon")
      .map((command) => command.path.filter((token) => !token.startsWith("-"))),
  ]);

const doctorDocDirs = ["harness/context", "harness/governance", "docs-release"],
  doctorDocFiles = ["AGENTS.md", "CLAUDE.md"],
  doctorSkipDirs: readonly string[] = [
    ".git",
    ".harness",
    ".worktrees",
    "app-node_modules",
    "coverage",
    "dist",
    "node_modules",
    "out",
  ];

export function doctorInvocation(
  argv: readonly string[],
): { readonly ok: true; readonly rootDir: string } | { readonly ok: false; readonly reason: string } {
  const rest = stripGlobals(argv),
    args = rest.slice(rest.indexOf("doctor") + 1),
    rootDir = path.resolve(globalOption(argv, "--root") ?? process.cwd());
  if (args.length > 1 || (args.length === 1 && args[0] !== "commands"))
    return { ok: false, reason: "Use ha doctor [commands] [--root <path>] [--json]." };
  return existsSync(rootDir) ? { ok: true, rootDir } : { ok: false, reason: `--root ${rootDir} does not exist.` };
}

export function renderDoctorReport(report: DoctorReport, json: boolean): number {
  const failed = report.findings.length > 0;
  if (json) {
    console.log(
      JSON.stringify({
        schema: "doctor-command-drift/v1",
        ok: !failed,
        checked: report.checked,
        findings: report.findings,
      }),
    );
    return failed ? 1 : 0;
  }
  for (const finding of report.findings)
    console.log(`${finding.path}:${finding.line} — ${finding.command} — ${finding.code}: ${finding.reason}`);
  console.log(
    failed
      ? `doctor: ${report.findings.length} stale command reference(s) (${report.checked} commands checked)`
      : `doctor: ok (${report.checked} commands checked)`,
  );
  return failed ? 1 : 0;
}

export function runDoctor(rootDir: string): DoctorReport {
  const findings: DoctorFinding[] = [];
  let checked = 0;
  for (const file of authoredMarkdownFiles(rootDir)) {
    const relative = path.relative(rootDir, file),
      source = readFileSync(file, "utf8");
    for (const hit of extractDoctorCommands(source)) {
      const args = tokenizeCommand(hit.command).slice(1);
      if (args.length === 0 || args.some((token) => /[<>`$*|…]/u.test(token) || token === "...")) continue;
      checked += 1;
      const verdict = validateInvocation(args, rootDir);
      if (!verdict.ok)
        findings.push({
          path: relative,
          line: hit.line,
          command: hit.command,
          code: verdict.code,
          reason: verdict.reason,
        });
    }
  }
  return { checked, findings };
}

function authoredMarkdownFiles(rootDir: string): readonly string[] {
  const files = new Set<string>();
  for (const relative of doctorDocDirs) {
    const directory = path.join(rootDir, relative);
    if (existsSync(directory)) collectMarkdown(directory, files);
  }
  for (const name of doctorDocFiles) {
    const file = path.join(rootDir, name);
    if (existsSync(file)) files.add(file);
  }
  collectAgentsDirs(rootDir, files);
  return [...files].sort();
}

function collectMarkdown(directory: string, files: Set<string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!doctorSkipDirs.includes(entry.name)) collectMarkdown(full, files);
    } else if (entry.isFile() && entry.name.endsWith(".md")) files.add(full);
  }
}

function collectAgentsDirs(directory: string, files: Set<string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || doctorSkipDirs.includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.name === ".agents") collectMarkdown(full, files);
    else collectAgentsDirs(full, files);
  }
}

// Extraction contract: inside a fenced code block, a line starting with `ha ` (after an optional
// shell prompt prefix) is an invocation; outside fences, an inline `ha ...` code span is. The
// command text ends at the next backtick or at end of line.
export function extractDoctorCommands(source: string): readonly DoctorCommand[] {
  const lines = source.split(/\r?\n/u),
    commands: DoctorCommand[] = [];
  let fenceMark: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!,
      fence = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fence) {
      const mark = fence[1]![0]!;
      if (fenceMark === undefined) fenceMark = mark;
      else if (mark === fenceMark) fenceMark = undefined;
      continue;
    }
    if (fenceMark !== undefined) {
      let text = line;
      const startLine = index;
      while (/\\\s*$/u.test(text) && index + 1 < lines.length && !/^\s*(`{3,}|~{3,})/u.test(lines[index + 1]!))
        text = `${text.replace(/\\\s*$/u, " ")}${lines[++index]}`;
      const candidate = text.replace(/^\s*[$>#]\s+/u, "");
      if (/^ha(?:\s|$)/u.test(candidate))
        commands.push({ line: startLine + 1, command: (candidate.split("`")[0] ?? candidate).trim() });
      continue;
    }
    for (const match of line.matchAll(/`([^`\n]+)`/gu)) {
      const span = match[1].trim();
      if (/^ha(?:\s|$)/u.test(span)) commands.push({ line: index + 1, command: span });
    }
  }
  return commands;
}

function tokenizeCommand(command: string): readonly string[] {
  const tokens: string[] = [];
  let current = "",
    quote: string | undefined;
  const push = () => {
    if (current !== "") tokens.push(current);
    current = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote === undefined && /\s/u.test(char)) {
      push();
      continue;
    }
    // A word-initial # is a shell comment; shell operators and redirections end the invocation.
    if (quote === undefined && current === "" && (char === "#" || char === "&" || char === "|" || char === ";")) break;
    if (char === "'" || char === '"') {
      if (quote === char) quote = undefined;
      else if (quote === undefined) quote = char;
      else current += char;
      continue;
    }
    if (char === "\\" && quote !== "'" && index + 1 < command.length) {
      current += command[index + 1]!;
      index += 1;
      continue;
    }
    current += char;
  }
  push();
  return tokens;
}

type DoctorVerdict = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason: string };

const doctorOk: DoctorVerdict = { ok: true };

function validateInvocation(args: readonly string[], rootDir: string): DoctorVerdict {
  if (args.includes("--version") || args.includes("-v")) return doctorOk;
  // The dispatcher resolves the command word like firstCliCommand: it skips every leading option,
  // so `ha --verbose daemon status` still routes to daemon control and bare `ha --help` renders help.
  const at = firstCliCommandIndex(args),
    root = at < 0 ? undefined : args[at];
  if (args.includes("--help"))
    return root === undefined || cliCommandDomains.includes(root) || doctorLocalRoots.includes(root)
      ? doctorOk
      : { ok: false, code: "command_not_found", reason: `${root} is not a command domain.` };
  const local =
    root === undefined ? false : root === "migrate" ? args[at + 1] === "ledger" : doctorLocalRoots.includes(root);
  if (local) {
    const words = args.slice(at),
      firstFlag = words.findIndex((token, index) => index > 0 && token.startsWith("-")),
      leading = firstFlag < 0 ? words : words.slice(0, firstFlag);
    if (leading.length === 1 && leading[0] === "daemon") return doctorOk;
    return doctorLocalPaths.some((commandPath) => commandPath.every((token, index) => leading[index] === token))
      ? doctorOk
      : {
          ok: false,
          code: "command_not_found",
          reason: `${leading.join(" ")} names no command in the CLI surface.`,
        };
  }
  const parsed = parseThinCommand(args, rootDir);
  return parsed.ok
    ? doctorOk
    : {
        ok: false,
        code: parsed.code === "unsupported_command" ? "command_not_found" : parsed.code,
        reason: parsed.nextAction,
      };
}
