#!/usr/bin/env node
/**
 * Combine the member bodies of a manual merge train into one PR body.
 *
 * A manual train changes the union of its members' files, so its body must carry one dependency
 * declaration, one event-migration declaration, one governance declaration and complete prose
 * sections — not one hand-stitched copy per PR. This generator aggregates those sections from the
 * member bodies; questions the sources cannot answer (two different migrations) fail closed.
 *
 * The output is meant to be checked with the same entry CI uses:
 *   node tools/check-pr-body-workflow.mjs --body-file /tmp/train-body.md
 *
 * Queue-managed merge groups decide their own body after task_f8d4c881 lands; this generator serves
 * manual trains and single-PR refreshes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isPlaceholderLine, readEventMigrationDeclarations } from "../check-pr-body.mjs";
import { readDependencyDeclarations, replaceDependencyDeclaration } from "./dependency-policy.mjs";
import { repoRoot } from "./git.mjs";

const TEMPLATE_PATH = ".github/pull_request_template.md";
const MACHINE_SECTION = "Machine-Readable Declarations";
const GOVERNANCE_DECLARATION = /^(?:Governance Declaration|Governance 声明|治理声明)$/iu;
const GOVERNANCE_EXCEPTION = /^(?:Governance Exception|治理例外)$/iu;

const ENGLISH_SECTIONS = Object.freeze([
  { title: "Summary", aliases: ["Summary"], required: true },
  { title: "What Changed", aliases: ["What Changed"], required: true },
  { title: "Verification", aliases: ["Verification"], required: true },
  { title: "Residual Risk", aliases: ["Residual Risk"], required: true },
]);

const CHINESE_SECTIONS = Object.freeze([
  { title: "摘要", aliases: ["摘要"], required: true },
  { title: "验证", aliases: ["验证"], required: true },
  { title: "改动内容", aliases: ["改动内容"], required: false },
  { title: "残余风险", aliases: ["残余风险"], required: false },
]);

function splitChinese(body) {
  const match = /^#\s+中文\s*$/mu.exec(body);
  if (!match) return { english: body, chinese: "" };
  return { english: body.slice(0, match.index), chinese: body.slice(match.index + match[0].length) };
}

/** Level-two sections only: a `# 中文` or `# English` heading ends the current section. */
export function markdownSections(text) {
  const sections = [];
  let current = null;
  for (const line of text.split(/\r?\n/u)) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/u.exec(line);
    if (heading) {
      current = { title: heading[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (/^#[ \t]+/u.test(line)) {
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections.map((section) => ({ title: section.title, content: section.lines.join("\n").trim() }));
}

function findSections(sections, aliases) {
  return sections
    .filter((section) => aliases.some((alias) => section.title === alias))
    .map((section) => section.content);
}

function substantive(content) {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some(
      (line) => line.length > 0 && !line.startsWith("<!--") && !isPlaceholderLine(line) && !/^#{1,6}[ \t]/u.test(line),
    );
}

function sourceLabel(label) {
  const cleaned = String(label).replace(/\s+/gu, " ").trim();
  return cleaned.length > 0 ? cleaned : "unnamed source";
}

function combineProseSections({ sources, sections, required, language }) {
  const combined = [];
  for (const { title, aliases, required: sectionRequired } of sections) {
    const parts = [];
    for (const source of sources) {
      const content = findSections(source.sections, aliases).join("\n\n").trim();
      if (substantive(content)) parts.push({ label: source.label, content });
    }
    if (parts.length === 0) {
      if (!(required && sectionRequired)) continue;
      throw new Error(
        `combined ${language} body has no filled "## ${title}" section; fill it in at least one member PR body before combining`,
      );
    }
    const body =
      parts.length === 1
        ? parts[0].content
        : parts.map((part) => `### ${sourceLabel(part.label)}\n\n${part.content}`).join("\n\n");
    combined.push({ title, body });
  }
  return combined;
}

function dependencyDeclaration(sources) {
  const values = sources
    .flatMap((source) => readDependencyDeclarations(source.body))
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !/^(?:none|n\/a)$/iu.test(value));
  return [...new Set(values)].join("; ") || "none";
}

function eventMigrationDeclaration(sources) {
  const declarations = sources.flatMap((source) => readEventMigrationDeclarations(source.body));
  const invalid = declarations.filter(
    (value) => !/^ha migrate [a-z0-9][a-z0-9-]*$/u.test(value) && !/^none(?:\s*[-—:]\s*|\s+)\S/u.test(value),
  );
  if (invalid.length > 0) {
    throw new Error(
      `member body has an invalid Event-Migration declaration (${invalid.join(", ")}); use \`ha migrate <name>\` or \`none — <reason>\``,
    );
  }
  const migrations = [...new Set(declarations.filter((value) => /^ha migrate /u.test(value)))];
  if (migrations.length > 1) {
    throw new Error(
      `member bodies declare ${migrations.length} different event migrations (${migrations.join(", ")}); a train body can carry only one — combine them into one migration first`,
    );
  }
  if (migrations.length === 1) return `Event-Migration: ${migrations[0]}`;
  const reasons = declarations
    .filter((value) => /^none/u.test(value))
    .map((value) => value.replace(/^none(?:\s*[-—:]\s*|\s+)/u, "").trim())
    .filter(Boolean);
  if (reasons.length === 0) return null;
  return `Event-Migration: none — ${[...new Set(reasons)].join("; ")}`;
}

function evidenceClaimBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split(/\r?\n/u)) {
    if (/^(?:Evidence-Type|CI-Attribution|Performance-Claim):/iu.test(line)) {
      current = [line.trim()];
      blocks.push(current);
      continue;
    }
    if (/^#{1,6}[ \t]/u.test(line)) {
      current = null;
      continue;
    }
    if (current === null) continue;
    if (line.trim().length === 0) {
      current = null;
      continue;
    }
    if (/^[A-Za-z][A-Za-z-]*:\s*/u.test(line)) current.push(line.trim());
    else current = null;
  }
  return [...new Set(blocks.map((lines) => lines.join("\n")))];
}

function uniqueGovernanceLines(contents) {
  const lines = [];
  for (const content of contents) {
    for (const line of content.split(/\r?\n/u)) {
      const trimmed = line.trimEnd();
      if (trimmed.trim().length === 0 || trimmed.trim().startsWith("<!--")) continue;
      lines.push(trimmed);
    }
  }
  const hasTouchedYes = lines.some((line) => /^-\s*Protected surface touched:\s*yes\b/iu.test(line));
  return [...new Set(lines)]
    .filter((line) => !(hasTouchedYes && /^-\s*Protected surface touched:\s*no\b/iu.test(line)))
    .join("\n");
}

function governanceSections(sources) {
  const declarations = [];
  const exceptions = [];
  for (const source of sources) {
    for (const section of source.sections) {
      if (GOVERNANCE_DECLARATION.test(section.title)) declarations.push(section.content);
      else if (GOVERNANCE_EXCEPTION.test(section.title)) exceptions.push(section.content);
    }
  }
  const sections = [];
  const declared = uniqueGovernanceLines(declarations);
  if (declared.length > 0) sections.push({ title: "Governance Declaration", body: declared });
  const excepted = uniqueGovernanceLines(exceptions);
  if (excepted.length > 0) sections.push({ title: "Governance Exception", body: excepted });
  return sections;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Replace one level-two section, or insert it before Verification when the template lacks it. */
export function replaceSection(body, title, content) {
  const heading = new RegExp(`^##[ \\t]+${escapeRegExp(title)}[ \\t]*$`, "mu");
  const match = heading.exec(body);
  const block = `## ${title}\n\n${content.trim()}\n\n`;
  if (!match) {
    const verification = /^##[ \t]+Verification[ \t]*$/mu.exec(body);
    if (verification) return `${body.slice(0, verification.index)}${block}${body.slice(verification.index)}`;
    return `${body.trimEnd()}\n\n${block}`;
  }
  const start = match.index;
  const next = /^##[ \t]+/gmu;
  next.lastIndex = start + match[0].length;
  const following = next.exec(body);
  const end = following ? following.index : body.length;
  return `${body.slice(0, start)}${block}${body.slice(end)}`;
}

function machineSection(templateSection, sources) {
  const claims = sources.flatMap((source) => evidenceClaimBlocks(source.english));
  let content = replaceDependencyDeclaration(templateSection, dependencyDeclaration(sources));
  const migration = eventMigrationDeclaration(sources);
  if (migration) {
    if (/^Event-Migration:/mu.test(content)) content = content.replace(/^Event-Migration:.*$/mu, migration);
    else content = content.replace(/^(Dependency-Change:.*)$/mu, `$1\n\n${migration}`);
  }
  if (claims.length > 0) content = `${content.trimEnd()}\n\n${[...new Set(claims)].join("\n\n")}\n`;
  return content;
}

/**
 * Pure combiner. Each source is `{ label, body }`; the template is the live PR template. Returns a
 * body that carries one of each machine declaration and all required prose sections.
 */
export function combinePrBodies({ sources, template }) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("combinePrBodies requires at least one member body");
  }
  const prepared = sources.map((source, index) => {
    const parts = splitChinese(source.body);
    return {
      label: sourceLabel(source.label ?? `source ${index + 1}`),
      body: source.body,
      english: parts.english,
      sections: markdownSections(parts.english),
      chineseSections: markdownSections(parts.chinese),
    };
  });

  const templateSections = markdownSections(template);
  const templateMachine = findSections(templateSections, [MACHINE_SECTION])[0];
  if (templateMachine === undefined) throw new Error(`PR template is missing the ## ${MACHINE_SECTION} section`);

  const english = combineProseSections({
    sources: prepared,
    sections: ENGLISH_SECTIONS,
    required: true,
    language: "English",
  });
  const governance = governanceSections(prepared);
  const machine = machineSection(templateMachine, prepared);

  let rendered = template;
  for (const { title, body } of english) rendered = replaceSection(rendered, title, body);
  rendered = replaceSection(rendered, MACHINE_SECTION, machine);
  for (const { title, body } of governance) rendered = replaceSection(rendered, title, body);

  const hasChinese = prepared.some((source) => source.chineseSections.length > 0);
  if (!hasChinese) return `${rendered.replace(/\s+$/u, "")}\n`;
  const chinese = combineProseSections({
    sources: prepared.map((source) => ({ label: source.label, sections: source.chineseSections })),
    sections: CHINESE_SECTIONS,
    required: true,
    language: "Chinese",
  });
  return `${rendered.replace(/\s+$/u, "")}\n\n# 中文\n\n${chinese
    .map(({ title, body }) => `## ${title}\n\n${body}`)
    .join("\n\n")}\n`;
}

function parseArgs(argv) {
  const options = { root: null, template: null, members: [], help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (!["--root", "--template", "--pr", "--body-file"].includes(token)) {
      throw new Error(`unknown argument: ${token}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
    index += 1;
    if (token === "--root") options.root = value;
    else if (token === "--template") options.template = value;
    else options.members.push({ kind: token === "--pr" ? "pr" : "file", value });
  }
  if (!options.help && options.members.length === 0) {
    throw new Error("at least one --pr or --body-file is required");
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node tools/gates/combine-pr-bodies.mjs (--pr <number> | --body-file <path>)... [--template <path>]",
      "",
      "Combines member PR bodies into one manual-train body: one Dependency-Change line, one",
      "Event-Migration line, aggregated governance declarations/exceptions, merged prose sections,",
      "and preserved evidence claims. Check the result with tools/check-pr-body-workflow.mjs.",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

function readMember(rootDir, member) {
  if (member.kind === "file") {
    const absolute = path.resolve(rootDir, member.value);
    return { label: path.basename(absolute), body: readFileSync(absolute, "utf8") };
  }
  let output;
  try {
    output = execFileSync("gh", ["pr", "view", member.value, "--json", "body,number"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`gh pr view ${member.value} failed (${detail.split(/\r?\n/u)[0]}); use --body-file instead`);
  }
  const pr = JSON.parse(output);
  return { label: `PR #${pr.number ?? member.value}`, body: pr.body ?? "" };
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const rootDir = options.root ? path.resolve(options.root) : repoRoot();
  const template = readFileSync(path.resolve(rootDir, options.template ?? TEMPLATE_PATH), "utf8");
  const sources = options.members.map((member) => readMember(rootDir, member));
  process.stdout.write(combinePrBodies({ sources, template }));
  return 0;
}

function entrypoint(argv) {
  try {
    return main(argv);
  } catch (error) {
    console.error(`combine-pr-bodies failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = entrypoint(process.argv.slice(2));
}
