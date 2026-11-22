import type { DossierSlot } from "./living-dossier.ts";
import type { DossierLedgerEntry, DossierLedgerState } from "./living-dossier-synthesizer.ts";

const ANCHOR_LABELS: Readonly<Record<string, string>> = {
  "atlas-topology": "架构拓扑",
  "entity-map": "实体分布",
  "change-ledger": "增量变更账本",
  "pulse-flow": "演进脉络",
  "decision-trail": "裁决因果链",
  "risk-signals": "风险与关注信号",
};

const CSS = [
  ":root{color-scheme:light dark;--bg:#f6f6f8;--surface:#ffffff;--surface-alt:#eef0f4;--border:#d8dce4;--ink:#1b1f27;--muted:#5b6472;--accent:#2b59c3;--done:#1f7a4d;--wait:#b26216;--bad:#b93838;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,Segoe UI,sans-serif}",
  "@media(prefers-color-scheme:dark){:root{--bg:#15161a;--surface:#1d1f26;--surface-alt:#252832;--border:#323746;--ink:#eceff4;--muted:#9aa3b2;--accent:#7aa2f7;--done:#4fd18b;--wait:#e5a94c;--bad:#f27474}}",
  "*{box-sizing:border-box}body{margin:0;padding:20px clamp(16px,2vw,32px) 48px;background:var(--bg);color:var(--ink);font:14px/1.55 var(--sans)}",
  "main{max-width:none;margin:0 auto;display:flex;flex-direction:column;gap:20px}",
  ".topbar{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding-bottom:12px}",
  ".topbar h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-0.01em}",
  ".meta-row{display:flex;flex-wrap:wrap;gap:8px;font:12px/1.3 var(--mono);color:var(--muted)}",
  ".pill{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface)}",
  ".pill-accent{border-color:var(--accent);color:var(--accent)}.pill-done{border-color:var(--done);color:var(--done)}.pill-wait{border-color:var(--wait);color:var(--wait)}.pill-bad{border-color:var(--bad);color:var(--bad)}",
  ".metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}",
  ".metric{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px 14px}",
  ".metric strong{display:block;font:700 22px/1.15 var(--mono);color:var(--ink)}.metric span{display:block;margin-top:4px;font-size:12px;color:var(--muted)}",
  "section{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:16px 18px}",
  "section h2{margin:0 0 12px;font-size:15px;font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:8px}",
  "section h2 small{font:12px/1 var(--mono);color:var(--muted);font-weight:400}",
  "svg{display:block;width:100%;height:auto;background:var(--surface-alt);border:1px solid var(--border);border-radius:4px}",
  ".svg-box{fill:var(--surface);stroke:var(--border);stroke-width:1.5}.svg-box-accent{fill:var(--surface);stroke:var(--accent);stroke-width:1.8}",
  ".svg-box-done{fill:var(--surface);stroke:var(--done);stroke-width:1.6}.svg-box-wait{fill:var(--surface);stroke:var(--wait);stroke-width:1.6}",
  ".svg-line{fill:none;stroke:var(--accent);stroke-width:1.8}.svg-muted-line{fill:none;stroke:var(--border);stroke-width:1.5;stroke-dasharray:5 4}",
  ".svg-title{fill:var(--ink);font:600 13px var(--sans)}.svg-mono{fill:var(--muted);font:12px var(--mono)}.svg-num{fill:var(--accent);font:700 16px var(--mono)}",
  ".grid-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}",
  ".kind-card{background:var(--surface-alt);border:1px solid var(--border);border-radius:5px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}",
  ".kind-card code{font:600 12px var(--mono);color:var(--accent)}.kind-card strong{font:700 18px var(--mono)}.kind-card span{font-size:12px;color:var(--muted)}",
  ".table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}",
  "th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--border)}th{font:600 12px var(--mono);color:var(--muted);background:var(--surface-alt)}",
  "td.rev,td.time{font:12px var(--mono);color:var(--muted);white-space:nowrap}td.refs{font:12px var(--mono);color:var(--accent);word-break:break-word}",
  "details{margin-top:10px;border-top:1px solid var(--border);padding-top:8px}summary{cursor:pointer;font:12px var(--mono);color:var(--muted)}",
  ".bar-track{fill:var(--border)}.bar-fill{fill:var(--accent)}.bar-done{fill:var(--done)}.bar-wait{fill:var(--wait)}.bar-bad{fill:var(--bad)}",
  "@media(max-width:760px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}body{padding:14px 12px 36px}}",
].join("");

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clipLabel(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function anchorTitle(anchor: string): string {
  return ANCHOR_LABELS[anchor] ?? anchor.replaceAll("-", " ");
}

function renderAtlasSvg(verticalId: string, slot: DossierSlot, state: DossierLedgerState): string {
  const kinds = slot.entityKinds.length > 0 ? slot.entityKinds.slice(0, 6) : ["task", "decision", "fact"];
  const cols = Math.min(3, Math.max(1, kinds.length));
  const rows = Math.ceil(kinds.length / cols);
  const cardW = 196;
  const cardH = 68;
  const gapX = 18;
  const gapY = 16;
  const startX = 24;
  const startY = 30;
  const height = Math.max(210, startY + rows * (cardH + gapY) + 26);
  const hubX = 700;
  const hubY = Math.round((height - 116) / 2);
  const nodes = kinds
    .map((kind, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = startX + col * (cardW + gapX);
      const y = startY + row * (cardH + gapY);
      const count = state.kindCounts[kind] ?? 0;
      const lineY = y + cardH / 2;
      const boxClass = count > 0 ? "svg-box-done" : "svg-box";
      return [
        `<g>`,
        `<rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="5" class="${boxClass}"/>`,
        `<text x="${x + 12}" y="${y + 24}" class="svg-title">${escapeHtml(clipLabel(kind, 20))}</text>`,
        `<text x="${x + 12}" y="${y + 46}" class="svg-num">${count}</text>`,
        `<text x="${x + 58}" y="${y + 46}" class="svg-mono">events</text>`,
        `<line x1="${x + cardW}" y1="${lineY}" x2="${hubX}" y2="${hubY + 58}" class="svg-muted-line"/>`,
        `</g>`,
      ].join("");
    })
    .join("");
  return [
    `<svg viewBox="0 0 960 ${height}" role="img" aria-label="${escapeHtml(`${verticalId} ${slot.title} topology`)}">`,
    nodes,
    `<rect x="${hubX}" y="${hubY}" width="236" height="116" rx="6" class="svg-box-accent"/>`,
    `<text x="${hubX + 14}" y="${hubY + 28}" class="svg-title">${escapeHtml(clipLabel(verticalId, 24))}</text>`,
    `<text x="${hubX + 14}" y="${hubY + 54}" class="svg-num">r${state.watermark}</text>`,
    `<text x="${hubX + 14}" y="${hubY + 78}" class="svg-mono">${escapeHtml(clipLabel(slot.path, 24))}</text>`,
    `<text x="${hubX + 14}" y="${hubY + 98}" class="svg-mono">total ${state.totalChanges} changes</text>`,
    `</svg>`,
  ].join("");
}

function renderPulseSvg(
  verticalId: string,
  slot: DossierSlot,
  state: DossierLedgerState,
  expectedWatermark: number,
  windowChangeCount: number,
): string {
  const buckets = [
    { label: "Tasks", count: state.categoryCounts.task, cls: "bar-done" },
    { label: "Decisions", count: state.categoryCounts.decision, cls: "bar-fill" },
    { label: "Facts", count: state.categoryCounts.fact, cls: "bar-wait" },
    { label: "Domain", count: state.categoryCounts.domain, cls: "bar-bad" },
  ];
  const peak = Math.max(1, ...buckets.map((item) => item.count));
  const bars = buckets
    .map((item, idx) => {
      const y = 34 + idx * 40;
      const barW = Math.max(8, Math.round((item.count / peak) * 340));
      return [
        `<text x="430" y="${y + 16}" class="svg-title">${item.label}</text>`,
        `<rect x="520" y="${y + 4}" width="340" height="16" rx="3" class="bar-track"/>`,
        `<rect x="520" y="${y + 4}" width="${barW}" height="16" rx="3" class="${item.cls}"/>`,
        `<text x="872" y="${y + 16}" class="svg-num">${item.count}</text>`,
      ].join("");
    })
    .join("");
  return [
    `<svg viewBox="0 0 960 210" role="img" aria-label="${escapeHtml(`${verticalId} ${slot.title} revision pulse`)}">`,
    `<rect x="24" y="34" width="140" height="62" rx="5" class="svg-box"/>`,
    `<text x="38" y="58" class="svg-mono">PREV CUT</text>`,
    `<text x="38" y="82" class="svg-num">r${expectedWatermark}</text>`,
    `<line x1="164" y1="65" x2="218" y2="65" class="svg-line"/>`,
    `<rect x="218" y="34" width="174" height="62" rx="5" class="svg-box-accent"/>`,
    `<text x="232" y="58" class="svg-mono">CURRENT CUT</text>`,
    `<text x="232" y="82" class="svg-num">r${state.watermark}</text>`,
    `<rect x="24" y="116" width="368" height="66" rx="5" class="svg-box-wait"/>`,
    `<text x="38" y="142" class="svg-title">${escapeHtml(clipLabel(verticalId, 24))}</text>`,
    `<text x="38" y="166" class="svg-mono">delta +${windowChangeCount} in window · ${state.totalChanges} cumulative</text>`,
    bars,
    `</svg>`,
  ].join("");
}

function renderEntryTable(entries: readonly DossierLedgerEntry[], emptySummary: string): string {
  if (entries.length === 0) return `<p>${escapeHtml(emptySummary)}</p>`;
  const rows = entries
    .map(
      (entry) =>
        `<tr>` +
        `<td class="rev">r${entry.workspaceRevision}</td>` +
        `<td><code>${escapeHtml(entry.type)}</code></td>` +
        `<td class="refs">${escapeHtml(entry.entityRefs.join(", ") || entry.eventId)}</td>` +
        `<td>${escapeHtml(entry.summary)}</td>` +
        `<td class="time">${escapeHtml(entry.occurredAt.slice(0, 19).replace("T", " "))}</td>` +
        `</tr>`,
    )
    .join("");
  return (
    `<div class="table-wrap"><table><thead><tr>` +
    `<th>Rev</th><th>Event</th><th>Entities</th><th>Summary</th><th>Time</th>` +
    `</tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

function renderSectionBody(
  anchor: string,
  verticalId: string,
  slot: DossierSlot,
  state: DossierLedgerState,
  expectedWatermark: number,
  windowChangeCount: number,
): string {
  if (anchor === "atlas-topology") {
    return renderAtlasSvg(verticalId, slot, state);
  }
  if (anchor === "pulse-flow") {
    return renderPulseSvg(verticalId, slot, state, expectedWatermark, windowChangeCount);
  }
  if (anchor === "entity-map") {
    const cards = slot.entityKinds
      .map((kind) => {
        const count = state.kindCounts[kind] ?? 0;
        const latest = state.entries.find((entry) => entry.kinds.includes(kind));
        const detail = latest ? `r${latest.workspaceRevision} · ${clipLabel(latest.summary, 42)}` : "No delta yet";
        return (
          `<div class="kind-card">` +
          `<code>${escapeHtml(kind)}</code>` +
          `<strong>${count}</strong>` +
          `<span>${escapeHtml(detail)}</span>` +
          `</div>`
        );
      })
      .join("");
    return `<div class="grid-cards">${cards}</div>`;
  }
  if (anchor === "decision-trail") {
    const decisions = state.entries.filter((entry) => entry.category === "decision");
    return renderEntryTable(
      decisions.slice(0, 16),
      `Watermarked at r${state.watermark}: 0 decision transitions observed in tracked windows.`,
    );
  }
  if (anchor === "risk-signals") {
    const risks = state.entries.filter((entry) => entry.riskSignal);
    return renderEntryTable(
      risks.slice(0, 16),
      `Watermarked at r${state.watermark}: 0 supersession, retirement, or blocked-task risk events observed.`,
    );
  }
  return renderEntryTable(
    state.entries.slice(0, 24),
    `Watermarked at r${state.watermark}: 0 matching entity events observed in (${expectedWatermark}, ${state.watermark}].`,
  );
}

export function renderDossierHtmlDocument(input: {
  readonly verticalId: string;
  readonly slot: DossierSlot;
  readonly state: DossierLedgerState;
  readonly expectedWatermark: number;
  readonly windowChangeCount: number;
  readonly stateComment: string;
}): string {
  const { verticalId, slot, state, expectedWatermark, windowChangeCount, stateComment } = input;
  const anchors = slot.requiredAnchors.length > 0 ? slot.requiredAnchors : ["atlas-topology", "change-ledger"];
  const hasDiagramAnchor = anchors.includes("atlas-topology") || anchors.includes("pulse-flow");
  const fallbackDiagram = hasDiagramAnchor
    ? ""
    : `<section><h2>${escapeHtml(slot.title)}<small>r${state.watermark}</small></h2>${renderAtlasSvg(verticalId, slot, state)}</section>`;
  const sections = anchors
    .map(
      (anchor) =>
        `<section id="${escapeHtml(anchor)}">` +
        `<h2>${escapeHtml(anchorTitle(anchor))}<small>#${escapeHtml(anchor)}</small></h2>` +
        renderSectionBody(anchor, verticalId, slot, state, expectedWatermark, windowChangeCount) +
        `</section>`,
    )
    .join("");
  const riskCount = state.entries.filter((entry) => entry.riskSignal).length;
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="dossier-watermark" content="${state.watermark}">`,
    `<title>${escapeHtml(slot.title)} · ${escapeHtml(verticalId)}</title>`,
    `<style>${CSS}</style>`,
    "</head>",
    "<body>",
    "<main>",
    `<header class="topbar">`,
    `<h1>${escapeHtml(slot.title)}</h1>`,
    `<div class="meta-row">` +
      `<span class="pill pill-accent">${escapeHtml(verticalId)}</span>` +
      `<span class="pill pill-done">r${state.watermark}</span>` +
      `<span class="pill">window r${expectedWatermark}→r${state.watermark}</span>` +
      `<span class="pill">${escapeHtml(state.synthesizedAt.slice(0, 19).replace("T", " "))}</span>` +
      `</div>`,
    `</header>`,
    `<div class="metrics">` +
      `<div class="metric"><strong>r${state.watermark}</strong><span>Source Watermark</span></div>` +
      `<div class="metric"><strong>${state.totalChanges}</strong><span>Tracked Changes (+${windowChangeCount})</span></div>` +
      `<div class="metric"><strong>${slot.entityKinds.length}</strong><span>Bound Entity Kinds</span></div>` +
      `<div class="metric"><strong>${riskCount}</strong><span>Risk Signals</span></div>` +
      `</div>`,
    fallbackDiagram,
    sections,
    `<details><summary>Bound schema · ${escapeHtml(slot.path)}</summary><p>Vertical: <code>${escapeHtml(verticalId)}</code> · Kinds: <code>${escapeHtml(slot.entityKinds.join(", "))}</code> · Anchors: <code>${escapeHtml(slot.requiredAnchors.join(", "))}</code></p></details>`,
    "</main>",
    stateComment,
    "</body>",
    "</html>",
  ].join("\n");
}
