#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import { agentProtocolCommands } from "../packages/daemon/src/protocol/daemon-protocol-commands-agent.ts";
import { clientLocalCommands } from "../packages/cli/src/cli/thin-command-help.ts";
import { changedFiles, pullRequestBase, repoRoot } from "./gates/git.mjs";

const EVENT_MIGRATION = /^Event-Migration:[ \t]*(.*?)\s*$/gmu;
const ACCEPTED_CANONICAL_EVENT_SAMPLE =
  /^packages\/kernel\/fixtures\/canonical-events\/[^/]+\/accepted(?:-[^/]+)?\.json$/u;

const PLACEHOLDER_RESIDUE_PATTERNS = Object.freeze([
  {
    id: "angle-placeholder",
    label: "angle-bracket placeholder",
    pattern: /<[A-Za-z][A-Za-z0-9 ,_-]*>/u,
  },
  {
    id: "choice-list",
    label: "unresolved choice list",
    pattern: /\b(?:no|yes|none needed|no publish)\b\s+\/\s+\S/u,
  },
  {
    id: "choice-list-cjk",
    label: "unresolved choice list",
    pattern: /(?:不需要|不发布)\s+\/\s+\S/u,
  },
  {
    id: "bracketed-instruction",
    label: "bracketed instruction",
    pattern: /\[[^\]\n]*(?:\brequired\b|必填)[^\]\n]*\]/iu,
  },
  {
    id: "bracketed-placeholder",
    label: "bracketed placeholder",
    pattern: /\[(?!x\])[a-z][a-z0-9_-]{0,30}\](?!\()/u,
  },
  {
    id: "bracketed-placeholder-cjk",
    label: "bracketed placeholder",
    pattern: /\[[\u4E00-\u9FFF][^\]\n]{0,20}\](?!\()/u,
  },
  {
    id: "adr-placeholder",
    label: "template id placeholder",
    pattern: /\bADR-####\b/u,
  },
]);

// Same invisible spans the section checks strip, but blanked with padding so the
// surviving text keeps its original line numbers for the issue message.
function maskInvisibleTemplateText(body) {
  return body
    .replace(/<!--[\s\S]*?-->/gu, (span) => span.replace(/[^\n]/gu, " "))
    .replace(/^\s*(`{3,}|~{3,}).*\n[\s\S]*?^\s*\1\s*$/gmu, (span) => span.replace(/[^\n]/gu, " "))
    .replace(/`[^`\n]*`/gu, (span) => span.replace(/[^\n]/gu, " "));
}

export function findTemplatePlaceholderResidues(body) {
  const residues = [];
  maskInvisibleTemplateText(body)
    .split(/\r?\n/u)
    .forEach((line, index) => {
      for (const { id, label, pattern } of PLACEHOLDER_RESIDUE_PATTERNS) {
        if (pattern.test(line)) {
          residues.push({ line: index + 1, id, label, snippet: line.trim().slice(0, 100) });
        }
      }
    });
  return residues;
}

export function checkTemplatePlaceholderResidue(body) {
  const residues = findTemplatePlaceholderResidues(body),
    issues = residues.map(
      (residue) =>
        `PR body line ${residue.line} keeps an unfilled template placeholder (${residue.label}): ${residue.snippet}`,
    );
  return { ok: issues.length === 0, residues, issues };
}

export function eventMigrationCommandNames(commands = [...agentProtocolCommands, ...clientLocalCommands]) {
  return commands
    .filter(({ path }) => path[0] === "migrate" && typeof path[1] === "string")
    .map(({ path }) => path[1])
    .sort();
}

export function checkEventMigrationDeclaration(body, { files = [], commandNames = eventMigrationCommandNames() } = {}) {
  const acceptedSampleChanges = files.filter((file) => ACCEPTED_CANONICAL_EVENT_SAMPLE.test(file)),
    declarations = [...body.matchAll(EVENT_MIGRATION)].map((match) => match[1].trim()),
    required = acceptedSampleChanges.length > 0,
    issues = [];
  if (!required && declarations.length === 0)
    return { ok: true, required, acceptedSampleChanges, declarations, migrationName: null, issues };
  if (declarations.length !== 1) {
    issues.push("Accepted canonical-event sample changes require exactly one Event-Migration declaration.");
    return { ok: false, required, acceptedSampleChanges, declarations, migrationName: null, issues };
  }
  const declaration = declarations[0],
    migration = declaration.match(/^ha migrate ([a-z0-9][a-z0-9-]*)$/u);
  if (migration) {
    const migrationName = migration[1];
    if (!commandNames.includes(migrationName)) {
      issues.push(
        `Event-Migration names unknown command \`ha migrate ${migrationName}\`; use a command from \`ha migrate --help\`.`,
      );
    }
    return {
      ok: issues.length === 0,
      required,
      acceptedSampleChanges,
      declarations,
      migrationName,
      issues,
    };
  }
  const noMigrationReason = declaration.match(/^none(?:\s*[-—:]\s*|\s+)(.+)$/u)?.[1]?.trim();
  if (!noMigrationReason) {
    issues.push("Event-Migration must be `ha migrate <name>` or `none — <why no migration is required>`.");
  }
  return {
    ok: issues.length === 0,
    required,
    acceptedSampleChanges,
    declarations,
    migrationName: null,
    issues,
  };
}

function normalizedNonEmptyLines(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// A line counts as a placeholder only when it stands alone: an optional list marker, one of the
// placeholder words below (any case), and optional trailing punctuation — nothing else.
const PLACEHOLDER_ONLY_LINE =
  /^\s*(?:[-*+][ \t]*)?(?:tbd|todo|n\/a|na|none|pending|not applicable|待定|待补|待填|无|暂无|不适用|没有)\s*[.。!！]?\s*$/iu;

function isPlaceholderLine(line) {
  return /^\s*[-*]\s*$/u.test(line) || /^\s*(?:[-*_]){3,}\s*$/u.test(line) || PLACEHOLDER_ONLY_LINE.test(line);
}

function unfilledSectionTitles(body) {
  const headings = [...body.matchAll(/^##[ \t]+(\S.*?)[ \t]*$/gmu)];
  const titles = [];
  for (let index = 0; index < headings.length; index += 1) {
    const content = body
      .slice(headings[index].index + headings[index][0].length, headings[index + 1]?.index ?? body.length)
      .replace(/<!--[\s\S]*?-->/gu, "");
    // Headings of any level are structure, not prose: a section holding only a heading (for
    // example a level-1 language heading between two sections) is still unfilled.
    if (
      !content
        .split(/\r?\n/u)
        .some((line) => line.trim().length > 0 && !isPlaceholderLine(line) && !/^#{1,6}[ \t]/u.test(line))
    ) {
      titles.push(headings[index][1]);
    }
  }
  return titles;
}

// Sections whose empty-or-default state is legitimate without worker prose: the machine-readable
// declaration section may legitimately hold only comments — the template instructs deleting the
// `Dependency-Change: none` line when nothing changed, and its real declarations are checked by
// the dedicated declaration jobs instead.
const PLACEHOLDER_SECTION_EXEMPT_TITLES = Object.freeze(["Machine-Readable Declarations"]);

export function checkPlaceholderOnlySections(body) {
  const sections = unfilledSectionTitles(body)
    .map((title) => ({ title }))
    .filter(({ title }) => !PLACEHOLDER_SECTION_EXEMPT_TITLES.includes(title));
  const named = sections.map(({ title }) => `## ${title}`),
    list = named.map((entry) => `\`${entry}\``).join(", "),
    issues =
      sections.length === 0
        ? []
        : [
            `Required PR body sections are empty or contain only placeholder lines (-, TBD, N/A, ...): ${list}. Fill each one with real content before review.`,
          ];
  return { ok: issues.length === 0, sections, issues };
}

export function checkUnfilledPrTemplate(body, template) {
  if (typeof template !== "string" || template.trim().length === 0) {
    return { ok: true, applicable: false, unfilled: false, unfilledSections: [], issues: [] };
  }
  const templateLines = new Set(normalizedNonEmptyLines(template));
  if (normalizedNonEmptyLines(body).some((line) => !templateLines.has(line))) {
    return { ok: true, applicable: true, unfilled: false, unfilledSections: [], issues: [] };
  }
  const unfilledSections = unfilledSectionTitles(body),
    list = unfilledSections.join(", ");
  return {
    ok: false,
    applicable: true,
    unfilled: true,
    unfilledSections,
    issues: [
      `The PR body is the unfilled PR template: no line goes beyond .github/pull_request_template.md.${
        unfilledSections.length > 0
          ? ` Fill the empty sections before review: ${list}.`
          : " Fill the template sections before review."
      }`,
    ],
  };
}

export function checkPrBody(body, context = {}) {
  const unfilledTemplate = checkUnfilledPrTemplate(body, context.prTemplate);
  const placeholderResidue = checkTemplatePlaceholderResidue(body);
  const placeholderSections = checkPlaceholderOnlySections(body);
  const eventMigration = checkEventMigrationDeclaration(body, context.eventMigration);
  const issues = [
    ...unfilledTemplate.issues,
    ...placeholderResidue.issues,
    ...placeholderSections.issues,
    ...eventMigration.issues,
  ];
  return {
    ok: issues.length === 0,
    eventMigration,
    unfilledTemplate,
    placeholderResidue,
    placeholderSections,
    issues,
  };
}

function readBodyFromArgs(argv) {
  if (argv.length === 0) return process.env.PR_BODY ?? "";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--text" || token === "--file" || token === "--env") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      if (token === "--text") return value;
      if (token === "--file") return readFileSync(value, "utf8");
      if (token === "--env") return process.env[value] ?? "";
    }
    if (token === "--help") {
      process.stdout.write(
        [
          "Usage: node tools/check-pr-body.mjs [--text <body> | --file <path> | --env <name>]",
          "",
          "A body that contributes no line beyond the verbatim PR template is rejected as unfilled, naming its empty sections.",
          "Required `##` sections whose content is empty or only placeholder lines (`-`, TBD, TODO, N/A, none, pending, not applicable, ...) are rejected, naming each section; Machine-Readable Declarations may hold only comments.",
          "Visible template placeholders (angle brackets like `<operation>`, unresolved `no / yes` choice lists, bracketed instructions like `[required ...]`) are rejected with their line numbers.",
          "When an accepted canonical-event sample changes, Event-Migration must name an existing ha migrate command or explain why no migration is required.",
        ].join("\n"),
      );
      process.stdout.write("\n");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return process.env.PR_BODY ?? "";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const body = readBodyFromArgs(process.argv.slice(2));
    const root = repoRoot(),
      base = process.env.PR_BASE_SHA || pullRequestBase(root),
      head = process.env.PR_HEAD_SHA || "HEAD",
      files = changedFiles(root, base, head),
      prTemplate = readFileSync(new URL("../.github/pull_request_template.md", import.meta.url), "utf8"),
      result = checkPrBody(body, { eventMigration: { files }, prTemplate });
    if (result.ok) {
      process.stdout.write("PR body check passed.\n");
    } else {
      process.stderr.write(
        [
          "PR body check failed.",
          "",
          ...result.issues,
          "",
          "How to fix: fill every required section of the PR template with real delivery facts.",
        ].join("\n"),
      );
      process.stderr.write("\n");
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
