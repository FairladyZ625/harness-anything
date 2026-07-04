<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Milestone Dossier</title>
<style>
:root { --bg:#0b0d12; --bg-2:#11141c; --panel:#161a24; --panel-2:#1c2230; --ink:#e8eaf0; --ink-dim:#9aa3b4; --ink-faint:#5c6478; --line:#262d3d; --line-soft:#1f2433; --amber:#f0a830; --teal:#3fb8af; --rose:#e5484d; --violet:#a78bfa; --lime:#a3e635; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 15px; line-height: 1.62; letter-spacing: 0; -webkit-font-smoothing: antialiased; }
.serif { font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif; }
.mono { font-family: "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, "Liberation Mono", monospace; }
.wrap { width: min(1180px, calc(100vw - 40px)); margin: 0 auto; }
.topbar { position: sticky; top: 0; z-index: 10; background: rgba(11, 13, 18, .86); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
.topbar .row { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 13px 0; }
.brand { display: flex; align-items: center; gap: 11px; font-weight: 650; font-size: 14px; }
.brand .dot { width: 10px; height: 10px; border-radius: 3px; background: linear-gradient(135deg, var(--violet), var(--teal), var(--rose)); }
nav { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
nav a { color: var(--ink-dim); text-decoration: none; font-size: 12px; padding: 5px 9px; border-radius: 6px; }
nav a:hover { color: var(--ink); background: var(--panel); }
.hero { padding: 82px 0 54px; border-bottom: 1px solid var(--line); }
.eyebrow { color: var(--violet); font-size: 12px; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 20px; }
h1 { margin: 0; font-family: "Iowan Old Style", Palatino, Georgia, serif; font-size: clamp(38px, 5.4vw, 68px); line-height: 1.06; font-weight: 400; letter-spacing: 0; }
.lede { margin: 24px 0 0; max-width: 820px; color: var(--ink-dim); font-family: "Iowan Old Style", Palatino, Georgia, serif; font-size: 19px; line-height: 1.56; }
.meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; margin-top: 44px; }
.meta-cell { padding: 18px 20px; background: var(--panel); border-right: 1px solid var(--line); }
.meta-cell:last-child { border-right: 0; }
.k { color: var(--ink-faint); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.v { margin-top: 7px; font-size: 21px; font-weight: 650; }
section { padding: 64px 0; border-bottom: 1px solid var(--line); }
.section-head { margin-bottom: 30px; }
.section-num { color: var(--ink-faint); font-size: 12px; letter-spacing: .13em; text-transform: uppercase; }
h2 { margin: 8px 0 0; font-family: "Iowan Old Style", Palatino, Georgia, serif; font-weight: 400; font-size: clamp(28px, 3.4vw, 42px); line-height: 1.12; letter-spacing: 0; }
.takeaway { margin-top: 14px; max-width: 860px; border-left: 3px solid var(--violet); padding-left: 16px; color: var(--ink); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.card { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 22px; }
.card h3 { margin: 0 0 10px; font-size: 17px; }
.card p, .card li { color: var(--ink-dim); }
.placeholder { min-height: 90px; border: 1px dashed var(--line); border-radius: 8px; background: var(--bg-2); color: var(--ink-faint); padding: 16px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13px; background: var(--panel); }
th, td { border: 1px solid var(--line); padding: 10px 12px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--ink-faint); background: var(--bg-2); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
code { color: var(--teal); background: var(--bg-2); border: 1px solid var(--line-soft); border-radius: 4px; padding: 1px 5px; }
footer { padding: 34px 0 48px; color: var(--ink-faint); }
@media (max-width: 760px) { .topbar .row, .grid-2 { display: block; } nav { justify-content: flex-start; margin-top: 10px; } .meta-grid { grid-template-columns: 1fr 1fr; } .meta-cell { border-bottom: 1px solid var(--line); } }
</style>
</head>
<body>
<header class="topbar"><div class="wrap row"><div class="brand"><span class="dot"></span><span>milestone dossier</span></div><nav><a href="#brief">brief</a><a href="#boundary">boundary</a><a href="#evidence">evidence</a><a href="#provenance">provenance</a></nav></div></header>
<main>
  <div class="hero"><div class="wrap"><div class="eyebrow mono">aggregation boundary</div><h1>Write the milestone close boundary as an auditable understanding dossier</h1><p class="lede">This file is only the editorial shell. Use <code>artifacts/dossier.data.json</code> and the original source documents to write the final human interpretation by hand.</p><div class="meta-grid"><div class="meta-cell"><div class="k mono">coordination task</div><div class="v">task/...</div></div><div class="meta-cell"><div class="k mono">boundary decision</div><div class="v">decision/...</div></div><div class="meta-cell"><div class="k mono">coverage</div><div class="v">0 / 0</div></div><div class="meta-cell"><div class="k mono">status</div><div class="v">draft</div></div></div></div></div>
  <section id="brief" data-dossier-section="brief"><div class="wrap"><div class="section-head"><div class="section-num mono">01 / brief</div><h2>Closeout Brief</h2><p class="takeaway">Explain the milestone objective, the boundary that is complete, and the risks still worth carrying forward.</p></div><div class="placeholder">Agent-authored narrative goes here.</div></div></section>
  <section id="boundary" data-dossier-section="boundary"><div class="wrap"><div class="section-head"><div class="section-num mono">02 / boundary</div><h2>Aggregation Boundary</h2><p class="takeaway">State which tasks, decisions, and facts form the close boundary, and why this is the correct stopping point.</p></div><div class="grid-2"><div class="card"><h3>Included</h3><div class="placeholder">Task and decision groups.</div></div><div class="card"><h3>Excluded</h3><div class="placeholder">Deferred or out-of-bound work.</div></div></div></div></section>
  <section id="evidence" data-dossier-section="evidence"><div class="wrap"><div class="section-head"><div class="section-num mono">03 / evidence</div><h2>Evidence And Coverage</h2><p class="takeaway">Translate coverage rows, facts, and relation paths into a reviewable evidence story.</p></div><table><thead><tr><th>Claim</th><th>Evidence</th><th>Interpretation</th></tr></thead><tbody><tr><td>decision/.../C1</td><td>fact/.../F-...</td><td>Replace with authored reading.</td></tr></tbody></table></div></section>
  <section id="provenance" data-dossier-section="provenance"><div class="wrap"><div class="section-head"><div class="section-num mono">04 / provenance</div><h2>Resolvable References</h2><p class="takeaway">List the real entity refs used by this dossier. The checker verifies resolution only, not writing quality.</p></div><div class="placeholder">task/..., decision/..., fact/.../F-...</div></div></section>
</main>
<footer><div class="wrap mono">Generated from template://dossier/editorial-shell@1. Write final content to artifacts/dossier.html.</div></footer>
</body>
</html>
