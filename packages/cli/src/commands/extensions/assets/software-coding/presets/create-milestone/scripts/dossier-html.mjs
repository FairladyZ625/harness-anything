import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export function renderMilestoneDossierHtml({ paths, artifactsDir }) {
  const dossierPath = path.join(paths.milestonesRoot, "dossier-data.md");
  const htmlPath = path.join(paths.milestonesRoot, "milestones-dossier.html");
  const milestones = parseDossierMilestones(readOptional(dossierPath));
  const html = buildDossierHtml({ milestones, sourcePath: relative(paths, dossierPath) });
  writeFileSync(htmlPath, html, "utf8");
  writeFileSync(path.join(artifactsDir, "milestones-dossier-render.json"), `${JSON.stringify({
    schema: "create-milestone-dossier-html-render/v1",
    status: "passed",
    source: relative(paths, dossierPath),
    path: relative(paths, htmlPath),
    milestones: milestones.length,
    lines: [...new Set(milestones.map((item) => item.line).filter(Boolean))].sort()
  }, null, 2)}\n`, "utf8");
  return {
    schema: "create-milestone-dossier-html-render/v1",
    status: "passed",
    source: relative(paths, dossierPath),
    path: relative(paths, htmlPath),
    milestones: milestones.length
  };
}

function parseDossierMilestones(body) {
  const rows = body.split(/\r?\n/u).filter((line) => /^\s*\|/u.test(line));
  if (rows.length < 2) return [];
  const headerIndex = rows.findIndex((line) => /Milestone/u.test(line) && /Status/u.test(line));
  if (headerIndex < 0) return [];
  const headers = splitMarkdownRow(rows[headerIndex]).map((header) => stripMarkdown(header).toLowerCase());
  const dataRows = rows.slice(headerIndex + 1).filter((line) => !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line));
  return dataRows.map((line) => {
    const cells = splitMarkdownRow(line);
    return {
      line: cellByHeader(headers, cells, "line"),
      milestone: cellByHeader(headers, cells, "milestone"),
      status: cellByHeader(headers, cells, "status"),
      goal: cellByHeader(headers, cells, "one-line goal"),
      rootTaskId: stripMarkdown(cellByHeader(headers, cells, "root task id")),
      childCount: stripMarkdown(cellByHeader(headers, cells, "child count")),
      dependencies: cellByHeader(headers, cells, "dependencies / entry"),
      batch: cellByHeader(headers, cells, "batch")
    };
  }).filter((row) => row.line || row.milestone || row.status || row.goal || row.rootTaskId || row.dependencies || row.batch);
}

function buildDossierHtml(input) {
  const lines = [...new Set(input.milestones.map((item) => item.line).filter(Boolean))].sort();
  const statuses = [...new Set(input.milestones.map((item) => item.status).filter(Boolean))].sort();
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Milestone Dossier</title>
<style>
${editorialShellCss()}
.summary-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.pill { display: inline-flex; align-items: center; min-height: 28px; border: 1px solid var(--line); border-radius: 5px; background: var(--panel); color: var(--ink-dim); padding: 4px 9px; font-family: var(--mono); font-size: 11px; }
.line-group { display: grid; gap: 14px; }
.milestone-row { display: grid; grid-template-columns: minmax(120px, .72fr) minmax(180px, 1fr) minmax(90px, .42fr) minmax(130px, .54fr); gap: 14px; align-items: start; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 16px; }
.milestone-row h3 { font-family: var(--serif); font-size: 18px; font-weight: 400; line-height: 1.3; margin-bottom: 8px; color: var(--ink); }
.milestone-row p { color: var(--ink-dim); font-size: 13px; line-height: 1.6; }
.status { color: var(--accent); }
.status.done, .status.shipped, .status.complete, .status.completed { color: var(--done); }
.status.planned, .status.active, .status.in-progress { color: var(--defer); }
.status.rejected, .status.blocked { color: var(--reject); }
.small-label { font-family: var(--mono); font-size: 10.5px; color: var(--ink-faint); letter-spacing: .06em; text-transform: uppercase; margin-bottom: 5px; }
@media (max-width: 860px) {
  .milestone-row { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<script>
(function () {
  try {
    var saved = localStorage.getItem('ha-dossier-theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', saved || (prefersDark ? 'dark' : 'light'));
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
</script>
<header class="topbar">
  <div class="wrap row">
    <div class="brand"><span class="dot"></span><span>milestone dossier</span></div>
    <nav>
      <a href="#overview">overview</a>
      <a href="#milestones">milestones</a>
      <a href="#source">source</a>
      <button class="theme-toggle" id="themeToggle" type="button" aria-label="切换日 / 夜主题" title="切换日 / 夜主题">
        <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.5" y1="4.5" x2="6" y2="6"/><line x1="18" y1="18" x2="19.5" y2="19.5"/><line x1="4.5" y1="19.5" x2="6" y2="18"/><line x1="18" y1="6" x2="19.5" y2="4.5"/></svg>
        <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      </button>
    </nav>
  </div>
</header>
<main>
  <div class="hero" id="overview">
    <div class="wrap">
      <div class="eyebrow">mechanical dossier</div>
      <h1>Milestone Dossier</h1>
      <p class="lede">This page is mechanically derived from <code>${escapeHtml(input.sourcePath)}</code>.</p>
      <div class="meta-grid">
        <div class="meta-cell"><div class="k">milestones</div><div class="v">${input.milestones.length}</div></div>
        <div class="meta-cell"><div class="k">lines</div><div class="v">${lines.length}</div></div>
        <div class="meta-cell"><div class="k">statuses</div><div class="v">${statuses.length}</div></div>
        <div class="meta-cell"><div class="k">source</div><div class="v">dossier-data.md</div></div>
      </div>
      <div class="summary-list">
        ${lines.map((line) => `<span class="pill">${escapeHtml(line)}</span>`).join("\n        ")}
      </div>
    </div>
  </div>
  <section id="milestones">
    <div class="wrap">
      <div class="section-head">
        <div class="section-num">01 / derived table</div>
        <h2>Milestones</h2>
      </div>
      <div class="line-group">
        ${input.milestones.map(renderMilestoneRow).join("\n        ")}
      </div>
    </div>
  </section>
  <section id="source">
    <div class="wrap">
      <div class="section-head">
        <div class="section-num">02 / provenance</div>
        <h2>Source</h2>
      </div>
      <div class="card">
        <p><code>${escapeHtml(input.sourcePath)}</code></p>
      </div>
    </div>
  </section>
</main>
<footer>
  <div class="wrap">
    <div class="src">Generated by create-milestone preset render-html from dossier-data.md.</div>
  </div>
</footer>
<script>
document.getElementById('themeToggle').addEventListener('click', function () {
  var cur = document.documentElement.getAttribute('data-theme') || 'light';
  var next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('ha-dossier-theme', next); } catch (e) {}
});
</script>
</body>
</html>
`;
}

function renderMilestoneRow(item) {
  const statusClass = classToken(item.status);
  const childCount = item.childCount ? `<p><span class="small-label">children</span>${escapeHtml(item.childCount)}</p>` : "";
  const rootTask = item.rootTaskId ? `<p><span class="small-label">root task</span><code>${escapeHtml(item.rootTaskId)}</code></p>` : "";
  const dependencies = item.dependencies ? `<p><span class="small-label">dependencies / entry</span>${escapeHtml(item.dependencies)}</p>` : "";
  const batch = item.batch ? `<p><span class="small-label">batch</span>${escapeHtml(item.batch)}</p>` : "";
  const goal = item.goal ? `<p>${escapeHtml(item.goal)}</p>` : "";
  return `<article class="milestone-row">
  <div>
    ${item.line ? `<div class="small-label">${escapeHtml(item.line)}</div>` : ""}
    ${item.milestone ? `<h3>${escapeHtml(item.milestone)}</h3>` : ""}
    ${goal}
  </div>
  <div>${rootTask}${dependencies}</div>
  <div>${item.status ? `<p class="status ${statusClass}"><span class="small-label">status</span>${escapeHtml(item.status)}</p>` : ""}${childCount}</div>
  <div>${batch}</div>
</article>`;
}

function editorialShellCss() {
  const templatePath = path.resolve(scriptDir, "..", "..", "..", "templates", "dossier.editorial.shell", "zh-CN.md");
  const template = readOptional(templatePath);
  const match = /<style>([\s\S]*?)<\/style>/u.exec(template);
  if (!match) throw new Error(`Could not read editorial shell CSS at ${templatePath}`);
  return match[1].trim();
}

function splitMarkdownRow(line) {
  return String(line ?? "")
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

function cellByHeader(headers, cells, header) {
  const index = headers.indexOf(header);
  return index >= 0 ? String(cells[index] ?? "").trim() : "";
}

function classToken(value) {
  return stripMarkdown(value).toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-|-$/gu, "");
}

function stripMarkdown(value) {
  return String(value ?? "").replace(/[`*]/gu, "").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readOptional(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function relative(paths, filePath) {
  return toSlash(path.relative(paths.rootDir ?? process.cwd(), filePath));
}

function toSlash(value) {
  return value.split(path.sep).join("/");
}
