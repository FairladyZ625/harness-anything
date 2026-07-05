<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Milestone Dossier</title>
<style>
/* ============================================================
   Editorial shell — calm, readable, day/night.
   LIGHT (default): warm off-white, near-black ink, newspaper calm.
   DARK: soft muted charcoal, never pure black, never neon.
   One low-saturation slate-indigo accent; muted sage/clay/brick
   reserved for done / risk / rejected once an agent fills content.
   ============================================================ */
:root {
  /* light (default) */
  --bg:#faf9f6;
  --panel:#ffffff;
  --panel-2:#f5f2ec;
  --ink:#1f1d1a;
  --ink-dim:#57534a;
  --ink-faint:#8a8478;
  --line:#e7e3db;
  --line-soft:#efece5;
  --accent:#5b6b8c;          /* muted slate-indigo */
  --accent-soft:#e8ebf2;
  --done:#5f7a55;            /* muted sage */
  --done-soft:#eef1ea;
  --defer:#a07238;           /* muted clay/amber */
  --defer-soft:#f4ecdc;
  --reject:#9a4a3f;          /* muted brick */
  --reject-soft:#f3e3df;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,"Times New Roman",serif;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:"SF Mono",SFMono-Regular,ui-monospace,"JetBrains Mono","Cascadia Code",Menlo,Consolas,"Liberation Mono",monospace;
}
:root[data-theme="dark"] {
  --bg:#1b1d21;
  --panel:#23262c;
  --panel-2:#2a2e35;
  --ink:#e6e3dd;
  --ink-dim:#a9a39a;
  --ink-faint:#7d776c;
  --line:#373b43;
  --line-soft:#2e3138;
  --accent:#8896b5;
  --accent-soft:#2c3142;
  --done:#9bb089;
  --done-soft:#2c352b;
  --defer:#c89a5e;
  --defer-soft:#38301f;
  --reject:#bf8074;
  --reject-soft:#3a2622;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
  text-wrap: pretty;
  transition: background-color .25s ease, color .25s ease;
}
.serif { font-family: var(--serif); }
.mono { font-family: var(--mono); }
.wrap { max-width: 1080px; margin: 0 auto; padding: 0 32px; }

/* ===== topbar ===== */
.topbar {
  position: sticky; top: 0; z-index: 50;
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: saturate(140%) blur(10px);
  border-bottom: 1px solid var(--line);
}
.topbar .row { display: flex; align-items: center; justify-content: space-between; padding: 14px 0; gap: 16px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 500; font-size: 14px; letter-spacing: -.005em; color: var(--ink); flex-shrink: 0; }
.brand .dot { width: 8px; height: 8px; border-radius: 2px; background: var(--accent); }
nav { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; justify-content: flex-end; }
nav a { color: var(--ink-dim); text-decoration: none; font-size: 13px; padding: 5px 11px; border-radius: 5px; transition: .15s; white-space: nowrap; }
nav a:hover { color: var(--ink); background: var(--panel-2); }
.theme-toggle {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border-radius: 6px; border: 1px solid var(--line);
  background: var(--panel); color: var(--ink-dim); cursor: pointer; transition: .2s; margin-left: 6px;
}
.theme-toggle:hover { color: var(--accent); border-color: var(--accent); background: var(--panel-2); }
.theme-toggle svg { width: 17px; height: 17px; display: block; }
.theme-toggle .moon { display: none; }
:root[data-theme="dark"] .theme-toggle .sun { display: none; }
:root[data-theme="dark"] .theme-toggle .moon { display: block; }

/* ===== hero ===== */
.hero { padding: 72px 0 52px; border-bottom: 1px solid var(--line); }
.eyebrow {
  font-family: var(--mono); font-size: 11.5px; color: var(--accent);
  letter-spacing: .1em; text-transform: uppercase; margin-bottom: 22px;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.eyebrow::before { content: ""; width: 22px; height: 1px; background: var(--accent); }
h1 {
  font-family: var(--serif); font-weight: 400;
  font-size: clamp(34px, 5vw, 56px); line-height: 1.08; letter-spacing: -.015em;
  margin-bottom: 24px; max-width: 20em; color: var(--ink);
}
.lede { font-size: 18px; color: var(--ink-dim); max-width: 68ch; line-height: 1.6; font-family: var(--serif); margin-top: 4px; }
.lede code, code {
  font-family: var(--mono); font-size: .85em;
  background: var(--panel-2); padding: 1px 5px; border-radius: 3px; color: var(--accent);
  border: 1px solid var(--line); white-space: nowrap;
}
.hero-figure {
  margin-top: 40px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--panel); padding: 24px 24px 16px;
}
.hero-figure .figtitle {
  font-family: var(--mono); font-size: 11px; color: var(--ink-faint);
  letter-spacing: .08em; text-transform: uppercase; margin-bottom: 14px;
}
.hero-figure svg { display: block; width: 100%; height: auto; overflow: visible; }
.hero-figure figcaption { margin-top: 12px; font-size: 12.5px; color: var(--ink-dim); line-height: 1.55; font-family: var(--serif); }
.meta-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 0;
  margin-top: 28px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden;
}
.meta-cell { padding: 18px 22px; border-right: 1px solid var(--line); background: var(--panel); }
.meta-cell:last-child { border-right: none; }
.meta-cell .k { font-family: var(--mono); font-size: 10.5px; color: var(--ink-faint); letter-spacing: .07em; text-transform: uppercase; margin-bottom: 6px; }
.meta-cell .v { font-size: 19px; font-weight: 500; letter-spacing: -.005em; line-height: 1.25; color: var(--ink); }

/* ===== section ===== */
section { padding: 64px 0; border-bottom: 1px solid var(--line); }
.section-head { margin-bottom: 30px; max-width: 68ch; }
.section-num { font-family: var(--mono); font-size: 11.5px; color: var(--ink-faint); letter-spacing: .12em; text-transform: uppercase; margin-bottom: 10px; }
h2 { font-family: var(--serif); font-weight: 400; font-size: clamp(26px, 3.4vw, 38px); line-height: 1.16; letter-spacing: -.015em; margin-bottom: 14px; color: var(--ink); }
.takeaway { color: var(--ink-dim); font-size: 16px; line-height: 1.62; border-left: 2px solid var(--accent); padding-left: 14px; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
.card { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 22px; }
.card h3 { margin-bottom: 10px; font-family: var(--serif); font-weight: 400; font-size: 18px; color: var(--ink); }
.card p, .card li { color: var(--ink-dim); }

/* placeholder + empty diagram slot (agent replaces both) */
.placeholder {
  min-height: 90px; border: 1px dashed var(--line); border-radius: 8px;
  background: var(--panel-2); color: var(--ink-faint); padding: 16px; font-size: 14px;
}
.diagram-slot {
  margin-top: 22px; border: 1px dashed var(--line); border-radius: 8px;
  background: var(--panel-2); padding: 20px; text-align: center;
  color: var(--ink-faint); font-family: var(--mono); font-size: 11px;
  letter-spacing: .05em; text-transform: uppercase;
}

/* ===== evidence table ===== */
.scroll-x { overflow-x: auto; border-radius: 8px; border: 1px solid var(--line); -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-size: 13px; background: var(--panel); min-width: 640px; }
thead { background: var(--panel-2); }
th { text-align: left; padding: 13px 16px; font-family: var(--mono); font-size: 10.5px; color: var(--ink-faint); letter-spacing: .06em; text-transform: uppercase; border-bottom: 1px solid var(--line); font-weight: 500; white-space: nowrap; }
td { padding: 14px 16px; border-bottom: 1px solid var(--line-soft); vertical-align: top; line-height: 1.55; color: var(--ink-dim); overflow-wrap: anywhere; }
tr:last-child td { border-bottom: none; }
td code { white-space: normal; }

/* ===== footer ===== */
footer { padding: 44px 0 64px; color: var(--ink-faint); }
footer .src { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); line-height: 1.75; }

/* ===== responsive ===== */
@media (max-width: 760px) {
  .wrap { padding: 0 22px; }
  .hero { padding: 48px 0 36px; }
  nav { justify-content: flex-start; }
  .grid-2 { grid-template-columns: 1fr; }
  .meta-grid { grid-template-columns: 1fr; }
  .meta-cell { border-right: none; border-bottom: 1px solid var(--line); }
  .meta-cell:last-child { border-bottom: none; }
  section { padding: 46px 0; }
}
</style>
</head>
<body>

<!-- theme bootstrap: apply persisted / prefers-color-scheme choice before first paint -->
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
      <a href="#brief">brief</a>
      <a href="#boundary">boundary</a>
      <a href="#evidence">evidence</a>
      <a href="#provenance">provenance</a>
      <button class="theme-toggle" id="themeToggle" type="button" aria-label="Toggle day / night theme" title="Toggle day / night theme">
        <!-- sun (shown in light) -->
        <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4"/>
          <line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/>
          <line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>
          <line x1="4.5" y1="4.5" x2="6" y2="6"/><line x1="18" y1="18" x2="19.5" y2="19.5"/>
          <line x1="4.5" y1="19.5" x2="6" y2="18"/><line x1="18" y1="6" x2="19.5" y2="4.5"/>
        </svg>
        <!-- moon (shown in dark) -->
        <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>
        </svg>
      </button>
    </nav>
  </div>
</header>

<script>
document.getElementById('themeToggle').addEventListener('click', function () {
  var cur = document.documentElement.getAttribute('data-theme') || 'light';
  var next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('ha-dossier-theme', next); } catch (e) {}
});
</script>

<main>
  <div class="hero">
    <div class="wrap">
      <div class="eyebrow">aggregation boundary</div>
      <h1>Write the milestone close boundary as an auditable understanding dossier</h1>
      <p class="lede">This file is only the editorial shell. Use <code>artifacts/dossier.data.json</code> and the original source documents to write the final human interpretation by hand.</p>

      <!-- Theme-aware inline-SVG placeholder. It uses CSS vars (var(--line), var(--accent), var(--done))
           and currentColor, so it repaints correctly in both light and dark. Replace with a real
           diagram (timeline / boundary set / coverage) drawn from artifacts/dossier.data.json.
           PATTERN for filling agents — draw diagrams inline like this, no external images:
             <svg viewBox="0 0 W H" role="img" aria-label="...">
               <line ... stroke="var(--line)"/>          quiet structure
               <circle ... fill="var(--done)"/>          done / covered
               <rect ... stroke="var(--accent)"/>        highlighted / in-scope
               <text ... fill="var(--ink)">label</text>  theme-aware text
             </svg>
           Never hardcode hex colors; always reference the CSS custom properties above. -->
      <figure class="hero-figure">
        <div class="figtitle">FIG · placeholder diagram · replace with real coverage / boundary art</div>
        <svg viewBox="0 0 880 120" role="img" aria-label="Placeholder milestone rail: an empty progress track awaiting real packet data">
          <line x1="30" y1="60" x2="850" y2="60" stroke="var(--line)" stroke-width="1"/>
          <g font-family="var(--mono)" font-size="10" text-anchor="middle" fill="var(--ink-faint)">
            <g transform="translate(30,60)"><circle r="6" fill="var(--panel)" stroke="var(--line)" stroke-width="1.2"/><text y="22">start</text></g>
            <g transform="translate(300,60)"><circle r="5" fill="var(--panel)" stroke="var(--line)" stroke-width="1.2"/></g>
            <g transform="translate(570,60)"><circle r="5" fill="var(--panel)" stroke="var(--line)" stroke-width="1.2"/></g>
            <g transform="translate(850,60)"><circle r="6.5" fill="var(--panel)" stroke="var(--accent)" stroke-width="1.2"/><text y="22" fill="var(--accent)">close</text></g>
          </g>
        </svg>
        <figcaption>Placeholder only. Replace with a theme-aware diagram of the real coverage or boundary once data is in hand.</figcaption>
      </figure>

      <div class="meta-grid">
        <div class="meta-cell"><div class="k mono">coordination task</div><div class="v">task/...</div></div>
        <div class="meta-cell"><div class="k mono">boundary decision</div><div class="v">decision/...</div></div>
        <div class="meta-cell"><div class="k mono">coverage</div><div class="v">0 / 0</div></div>
        <div class="meta-cell"><div class="k mono">status</div><div class="v">draft</div></div>
      </div>
    </div>
  </div>

  <section id="brief" data-dossier-section="brief">
    <div class="wrap">
      <div class="section-head">
        <div class="section-num">01 / brief</div>
        <h2>Closeout Brief</h2>
        <p class="takeaway">Explain the milestone objective, the boundary that is complete, and the risks still worth carrying forward.</p>
      </div>
      <div class="placeholder">Agent-authored narrative goes here.</div>
      <div class="diagram-slot">empty diagram slot — draw a theme-aware inline SVG here</div>
    </div>
  </section>

  <section id="boundary" data-dossier-section="boundary">
    <div class="wrap">
      <div class="section-head">
        <div class="section-num">02 / boundary</div>
        <h2>Aggregation Boundary</h2>
        <p class="takeaway">State which tasks, decisions, and facts form the close boundary, and why this is the correct stopping point.</p>
      </div>
      <div class="grid-2">
        <div class="card"><h3>Included</h3><div class="placeholder">Task and decision groups.</div></div>
        <div class="card"><h3>Excluded</h3><div class="placeholder">Deferred or out-of-bound work.</div></div>
      </div>
      <div class="diagram-slot">empty diagram slot — draw an included / excluded set diagram here</div>
    </div>
  </section>

  <section id="evidence" data-dossier-section="evidence">
    <div class="wrap">
      <div class="section-head">
        <div class="section-num">03 / evidence</div>
        <h2>Evidence And Coverage</h2>
        <p class="takeaway">Translate coverage rows, facts, and relation paths into a reviewable evidence story.</p>
      </div>
      <div class="scroll-x">
        <table>
          <thead><tr><th>Claim</th><th>Evidence</th><th>Interpretation</th></tr></thead>
          <tbody><tr><td><code>decision/.../C1</code></td><td><code>fact/.../F-...</code></td><td>Replace with authored reading.</td></tr></tbody>
        </table>
      </div>
    </div>
  </section>

  <section id="provenance" data-dossier-section="provenance">
    <div class="wrap">
      <div class="section-head">
        <div class="section-num">04 / provenance</div>
        <h2>Resolvable References</h2>
        <p class="takeaway">List the real entity refs used by this dossier. The checker verifies resolution only, not writing quality.</p>
      </div>
      <div class="placeholder mono">task/..., decision/..., fact/.../F-...</div>
    </div>
  </section>
</main>

<footer><div class="wrap src">Generated from template://dossier/editorial-shell@1. Write final content to artifacts/dossier.html.</div></footer>
</body>
</html>
