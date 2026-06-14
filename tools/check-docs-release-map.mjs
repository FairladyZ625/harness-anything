import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const expectedDocs = [
  "docs-release/m1-minimal-loop.md",
  "docs-release/m2-coding-vertical.md",
  "docs-release/m2-5-product-line.md",
  "docs-release/m2-5-gui-distribution.md",
  "docs-release/harness-agent-skill.md"
];

const requiredProductLinePhrases = [
  "Status taxonomy",
  "Shipped",
  "Foundation",
  "Planned",
  "M2.5 GUI/daemon foundation",
  "M3-M7"
];

const riskyClaims = [
  { name: "signed installer", subject: /\bsigned\b[^.!?\n;|]*\binstallers?\b/i },
  { name: "notarized build", subject: /\b(notarized\b[^.!?\n;|]*\bbuilds?|notarization)\b/i },
  { name: "auto-update", subject: /\b(auto-?update|auto updater|automatic update)\b/i },
  { name: "cloud relay", subject: /\bcloud relay\b/i },
  { name: "GitHub Issues adapter", subject: /\bgithub issues\b[^.!?\n;|]*\badapter\b/i },
  { name: "Linear adapter", subject: /\blinear\b[^.!?\n;|]*\badapter\b/i },
  { name: "M4 external adapter", subject: /\b(m4\b[^.!?\n;|]*\bexternal adapters?|external adapters?\b[^.!?\n;|]*\bm4)\b/i },
  { name: "M3 task hierarchy", subject: /\bm3\b[^.!?\n;|]*\b(task hierarchy|relation semantics)\b/i },
  { name: "M6 GUI product", subject: /\bm6\b[^.!?\n;|]*\b(gui product|full gui)\b/i },
  { name: "M7 release hardening", subject: /\bm7\b[^.!?\n;|]*\brelease hardening\b/i }
];

const errors = [];
const read = (path) => readFileSync(path, "utf8");
const readme = read("README.md");
const shippedClaim = /\b(shipped|available|implemented|complete|completed|ready|production-ready|supported|released)\b/i;
const negativeOrFuture = /\b(no|not|never|without|unshipped|planned|future|later|requires|remain|remains|before|deferred|placeholder)\b/i;

for (const docPath of expectedDocs) {
  if (!existsSync(docPath)) errors.push(`Missing expected docs-release page: ${docPath}`);
  const readmeLink = `./${docPath}`;
  if (!readme.includes(readmeLink)) errors.push(`README.md does not link ${readmeLink}`);
}

const productLinePath = "docs-release/m2-5-product-line.md";
if (existsSync(productLinePath)) {
  const productLine = read(productLinePath);
  for (const phrase of requiredProductLinePhrases) {
    if (!productLine.includes(phrase)) errors.push(`${productLinePath} is missing required phrase: ${phrase}`);
  }
  for (const docPath of expectedDocs) {
    const productLineLink = `./${docPath.replace(/^docs-release\//, "")}`;
    if (docPath !== productLinePath && !productLine.includes(productLineLink)) {
      errors.push(`${productLinePath} does not link ${docPath}`);
    }
  }
}

for (const docPath of ["README.md", ...listMarkdown("docs-release")]) {
  const content = read(docPath);
  if (/\/Users\/[^\s)`]+/.test(content)) errors.push(`${docPath} exposes an absolute local path`);
  collectOverclaims(docPath, content, errors);
}

for (const docPath of listMarkdown("docs-release")) {
  const content = read(docPath);
  if (content.includes(".harness-private/")) errors.push(`${docPath} exposes private harness path`);
}
validateReadmePrivateBoundary(readme, errors);

if (!readme.includes("M2.5 GUI/daemon foundation")) {
  errors.push("README.md must expose the M2.5 GUI/daemon foundation status");
}
if (!readme.includes("docs-release/m2-5-product-line.md")) {
  errors.push("README.md must link the public product-line map");
}

if (errors.length > 0) {
  console.error("Docs release map check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Docs release map check passed.");

function listMarkdown(root) {
  return readdirSync(root)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => join(root, entry))
    .sort();
}

function collectOverclaims(docPath, content, targetErrors) {
  for (const sentence of content.split(/(?<=[.!?])\s+|\n+/)) {
    if (!sentence.trim()) continue;
    if (!shippedClaim.test(sentence) || negativeOrFuture.test(sentence)) continue;
    for (const claim of riskyClaims) {
      if (claim.subject.test(sentence)) {
        targetErrors.push(`${docPath} may overclaim ${claim.name}: ${sentence.trim()}`);
      }
    }
  }
}

function validateReadmePrivateBoundary(content, targetErrors) {
  const privateMentions = content.match(/\.harness-private\//g) ?? [];
  if (privateMentions.length > 2) {
    targetErrors.push("README.md has more private harness path mentions than the boundary warning permits");
  }
  if (/\.harness-private\/[\w.-]+/.test(content)) {
    targetErrors.push("README.md exposes a browsable private harness subpath");
  }
}
