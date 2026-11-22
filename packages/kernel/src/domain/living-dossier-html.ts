import type { DossierSlot } from "./living-dossier.ts";
import {
  sanitizeExternalUrlText,
  type DossierDecisionRecord,
  type DossierLedgerEntry,
  type DossierLedgerState,
  type DossierRelationEdge,
  type DossierTaskRecord,
} from "./living-dossier-state.ts";

export interface DossierWorkRollup {
  readonly workId: string;
  readonly title: string;
  readonly status: string;
  readonly totalTasks: number;
  readonly doneTasks: number;
  readonly blockedTasks: number;
  readonly activeTasks: number;
  readonly cancelledTasks: number;
  readonly explainerPath: string;
  readonly packagePath?: string;
  readonly latestRevision: number;
  readonly recentChildIds: readonly string[];
  readonly countsIncomplete?: boolean;
}

const ANCHOR_LABELS: Readonly<Record<string, string>> = {
  "atlas-topology": "架构拓扑与实体关系",
  "entity-map": "实体域分布",
  "change-ledger": "增量变更账本",
  "pulse-flow": "跨 Work 推进与水位脉动",
  "decision-trail": "在效决策与派生因果链",
  "risk-signals": "实时阻塞与风险信号",
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
  ".svg-box-done{fill:var(--surface);stroke:var(--done);stroke-width:1.6}.svg-box-wait{fill:var(--surface);stroke:var(--wait);stroke-width:1.6}.svg-box-bad{fill:var(--surface);stroke:var(--bad);stroke-width:1.8}",
  ".svg-line{fill:none;stroke:var(--accent);stroke-width:1.8}.svg-line-bad{fill:none;stroke:var(--bad);stroke-width:1.8}.svg-muted-line{fill:none;stroke:var(--border);stroke-width:1.5;stroke-dasharray:5 4}",
  ".svg-arrow{fill:var(--accent)}.svg-arrow-bad{fill:var(--bad)}",
  ".svg-title{fill:var(--ink);font:600 13px var(--sans)}.svg-mono{fill:var(--muted);font:11.5px var(--mono)}.svg-num{fill:var(--accent);font:700 16px var(--mono)}.svg-edge-label{fill:var(--accent);font:600 11px var(--mono)}",
  ".grid-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}",
  ".kind-card{background:var(--surface-alt);border:1px solid var(--border);border-radius:5px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}",
  ".kind-card code{font:600 12px var(--mono);color:var(--accent)}.kind-card strong{font:700 18px var(--mono)}.kind-card span{font-size:12px;color:var(--muted)}",
  ".tag-strip{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.tag{font:11.5px var(--mono);padding:2px 7px;border-radius:4px;background:var(--surface-alt);border:1px solid var(--border);color:var(--muted)}",
  ".table-wrap{overflow-x:auto;margin-top:12px}table{width:100%;border-collapse:collapse;font-size:13px}",
  "th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--border)}th{font:600 12px var(--mono);color:var(--muted);background:var(--surface-alt)}",
  "td.rev,td.time{font:12px var(--mono);color:var(--muted);white-space:nowrap}td.refs{font:12px var(--mono);color:var(--accent);word-break:break-word}",
  "details{margin-top:12px;border-top:1px solid var(--border);padding-top:8px}summary{cursor:pointer;font:12px var(--mono);color:var(--muted)}",
  ".bar-track{fill:var(--border)}.bar-fill{fill:var(--accent)}.bar-done{fill:var(--done)}.bar-wait{fill:var(--wait)}.bar-bad{fill:var(--bad)}",
  "@media(max-width:760px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}body{padding:14px 12px 36px}}",
].join("");

export function escapeHtml(value: string): string {
  return sanitizeExternalUrlText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clipLabel(value: string, maxChars: number): string {
  const safe = sanitizeExternalUrlText(value);
  return safe.length <= maxChars ? safe : `${safe.slice(0, maxChars - 1)}…`;
}

function anchorTitle(anchor: string): string {
  return ANCHOR_LABELS[anchor] ?? anchor.replaceAll("-", " ");
}

function shortEntityLabel(ref: string): string {
  const parts = ref.split("/");
  if (ref.startsWith("entity-kind/") && parts.length >= 3) return parts[2]!;
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return ref;
}

function renderTopologyEdgesSvg(
  verticalId: string,
  slot: DossierSlot,
  state: DossierLedgerState,
  edges: readonly DossierRelationEdge[],
  blockedCount: number,
  blockedCountIncomplete: boolean,
): string {
  const boundedEdges = edges.slice(0, 8);
  const sources = [...new Set(boundedEdges.map((edge) => edge.source))].slice(0, 6);
  const targets = [...new Set(boundedEdges.map((edge) => edge.target))].slice(0, 6);
  const nodeH = 44;
  const gapY = 12;
  const startY = 34;
  const rows = Math.max(sources.length, targets.length, 2);
  const height = Math.max(220, startY + rows * (nodeH + gapY) + 28);
  const leftX = 24;
  const midX = 376;
  const nodeW = 224;
  const hubX = 708;
  const hubY = Math.round((height - 128) / 2);

  const sourcePos = new Map<string, { x: number; y: number }>();
  const targetPos = new Map<string, { x: number; y: number }>();

  const sourceNodes = sources
    .map((ref, idx) => {
      const y = startY + idx * (nodeH + gapY);
      sourcePos.set(ref, { x: leftX + nodeW, y: y + nodeH / 2 });
      const edge = boundedEdges.find((item) => item.source === ref);
      const cls = edge?.sourceKind === "decision" ? "svg-box-accent" : "svg-box-done";
      return [
        `<g>`,
        `<rect x="${leftX}" y="${y}" width="${nodeW}" height="${nodeH}" rx="5" class="${cls}"/>`,
        `<text x="${leftX + 10}" y="${y + 17}" font-size="11" class="svg-mono">${escapeHtml(clipLabel(edge?.sourceKind ?? "entity", 20))}</text>`,
        `<text x="${leftX + 10}" y="${y + 34}" font-size="12" class="svg-title">${escapeHtml(clipLabel(shortEntityLabel(ref), 22))}</text>`,
        `</g>`,
      ].join("");
    })
    .join("");

  const targetNodes = targets
    .map((ref, idx) => {
      const y = startY + idx * (nodeH + gapY);
      targetPos.set(ref, { x: midX, y: y + nodeH / 2 });
      const edge = boundedEdges.find((item) => item.target === ref);
      const taskId = ref.startsWith("task/") ? ref.slice(5) : null;
      const isBlocked = taskId ? state.tasks[taskId]?.status === "blocked" : false;
      const cls = isBlocked ? "svg-box-bad" : "svg-box-wait";
      return [
        `<g>`,
        `<rect x="${midX}" y="${y}" width="${nodeW}" height="${nodeH}" rx="5" class="${cls}"/>`,
        `<text x="${midX + 10}" y="${y + 17}" font-size="11" class="svg-mono">${escapeHtml(clipLabel(edge?.targetKind ?? "entity", 20))}</text>`,
        `<text x="${midX + 10}" y="${y + 34}" font-size="12" class="svg-title">${escapeHtml(clipLabel(shortEntityLabel(ref), 22))}</text>`,
        `<line x1="${midX + nodeW}" y1="${y + nodeH / 2}" x2="${hubX}" y2="${hubY + 64}" class="svg-muted-line"/>`,
        `</g>`,
      ].join("");
    })
    .join("");

  const edgeLines = boundedEdges
    .map((edge, idx) => {
      const from = sourcePos.get(edge.source);
      const to = targetPos.get(edge.target);
      if (!from || !to) return "";
      const isDanger = edge.relationType.includes("block") || edge.relationType.includes("supersede");
      const midXPos = Math.round((from.x + to.x) / 2);
      const midYPos = Math.round((from.y + to.y) / 2) - 4 + ((idx % 2) * 10 - 5);
      const lineCls = isDanger ? "svg-line-bad" : "svg-line";
      const marker = isDanger ? "url(#dossier-arrow-bad)" : "url(#dossier-arrow)";
      return [
        `<g>`,
        `<path d="M ${from.x} ${from.y} C ${midXPos} ${from.y}, ${midXPos} ${to.y}, ${to.x - 4} ${to.y}" class="${lineCls}" marker-end="${marker}"/>`,
        `<text x="${midXPos}" y="${midYPos}" text-anchor="middle" font-size="11" class="svg-edge-label">${escapeHtml(clipLabel(edge.relationType, 16))}</text>`,
        `</g>`,
      ].join("");
    })
    .join("");

  const activeDecisionCount = Object.keys(state.activeDecisions).length;
  return [
    `<svg viewBox="0 0 960 ${height}" role="img" aria-label="${escapeHtml(`${verticalId} ${slot.title} architecture relation topology`)}">`,
    `<defs>`,
    `<marker id="dossier-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" class="svg-arrow"/></marker>`,
    `<marker id="dossier-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" class="svg-arrow-bad"/></marker>`,
    `</defs>`,
    `<text x="${leftX}" y="20" font-size="11" class="svg-mono">GOVERNING / SOURCE NODES</text>`,
    `<text x="${midX}" y="20" font-size="11" class="svg-mono">DERIVED / TARGET NODES</text>`,
    sourceNodes,
    targetNodes,
    edgeLines,
    `<rect x="${hubX}" y="${hubY}" width="228" height="128" rx="6" class="svg-box-accent"/>`,
    `<text x="${hubX + 12}" y="${hubY + 26}" font-size="13" class="svg-title">${escapeHtml(clipLabel(verticalId, 20))}</text>`,
    `<text x="${hubX + 12}" y="${hubY + 50}" font-size="15" class="svg-num">r${state.watermark}</text>`,
    `<text x="${hubX + 12}" y="${hubY + 72}" font-size="11" class="svg-mono">rels ${state.relations.length} · ADR ${activeDecisionCount}</text>`,
    `<text x="${hubX + 12}" y="${hubY + 92}" font-size="11" class="svg-mono">blockers ${blockedCount}${blockedCountIncomplete ? "+ (windowed)" : ""}</text>`,
    `<text x="${hubX + 12}" y="${hubY + 112}" font-size="11" class="svg-mono">total ${state.totalChanges} changes</text>`,
    `</svg>`,
  ].join("");
}

function renderAtlasSvg(
  verticalId: string,
  slot: DossierSlot,
  state: DossierLedgerState,
  blockedCount: number,
  blockedCountIncomplete: boolean,
): string {
  const workEdges: DossierRelationEdge[] = Object.values(state.tasks)
    .filter((task) => task.parentTaskId !== null)
    .slice(0, 4)
    .map((task) => ({
      source: `task/${task.parentTaskId}`,
      target: `task/${task.taskId}`,
      sourceKind: "work",
      targetKind: "task",
      relationType: "contains",
      workspaceRevision: task.workspaceRevision,
    }));
  const combinedEdges = [...state.relations, ...workEdges];
  if (combinedEdges.length > 0) {
    return renderTopologyEdgesSvg(verticalId, slot, state, combinedEdges, blockedCount, blockedCountIncomplete);
  }

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
  workRollups: readonly DossierWorkRollup[],
  totalWorkCount: number,
  blockedCount: number,
  blockedCountIncomplete: boolean,
  expectedWatermark: number,
  windowChangeCount: number,
): string {
  const rows =
    workRollups.length > 0
      ? workRollups.slice(0, 4).map((work) => {
          const partial = Boolean(work.countsIncomplete);
          return {
            label: clipLabel(work.title, 18),
            partial,
            ratio: partial
              ? 0
              : work.totalTasks > 0
                ? work.doneTasks / work.totalTasks
                : work.status === "done"
                  ? 1
                  : 0,
            valueLabel: `${work.doneTasks}/${work.totalTasks}${partial ? " (partial)" : ""}${work.blockedTasks > 0 ? ` (${work.blockedTasks}${partial ? "+" : ""} blk)` : ""}`,
            cls:
              work.blockedTasks > 0
                ? "bar-bad"
                : !partial && work.totalTasks > 0 && work.doneTasks === work.totalTasks
                  ? "bar-done"
                  : "bar-fill",
          };
        })
      : [
          {
            label: "Tasks",
            partial: false,
            ratio: state.categoryCounts.task,
            valueLabel: String(state.categoryCounts.task),
            cls: "bar-done",
          },
          {
            label: "Decisions",
            partial: false,
            ratio: state.categoryCounts.decision,
            valueLabel: String(state.categoryCounts.decision),
            cls: "bar-fill",
          },
          {
            label: "Facts",
            partial: false,
            ratio: state.categoryCounts.fact,
            valueLabel: String(state.categoryCounts.fact),
            cls: "bar-wait",
          },
          {
            label: "Domain",
            partial: false,
            ratio: state.categoryCounts.domain,
            valueLabel: String(state.categoryCounts.domain),
            cls: "bar-bad",
          },
        ];
  const peak = workRollups.length > 0 ? 1 : Math.max(1, ...rows.map((item) => item.ratio));
  const bars = rows
    .map((item, idx) => {
      const y = 34 + idx * 40;
      const barW = Math.max(8, Math.round((item.ratio / peak) * 260));
      return [
        `<text x="424" y="${y + 16}" class="svg-title">${escapeHtml(item.label)}</text>`,
        `<rect x="580" y="${y + 4}" width="260" height="16" rx="3" class="bar-track"/>`,
        ...(item.partial
          ? []
          : [`<rect x="580" y="${y + 4}" width="${barW}" height="16" rx="3" class="${item.cls}"/>`]),
        `<text x="852" y="${y + 16}" class="svg-mono">${escapeHtml(item.valueLabel)}</text>`,
      ].join("");
    })
    .join("");
  const anyPartial = workRollups.slice(0, 4).some((work) => Boolean(work.countsIncomplete));
  return [
    `<svg viewBox="0 0 960 210" role="img" aria-label="${escapeHtml(`${verticalId} ${slot.title} revision pulse`)}">`,
    `<rect x="24" y="34" width="140" height="62" rx="5" class="svg-box"/>`,
    `<text x="38" y="58" font-size="11" class="svg-mono">PREV CUT</text>`,
    `<text x="38" y="82" font-size="15" class="svg-num">r${expectedWatermark}</text>`,
    `<line x1="164" y1="65" x2="218" y2="65" class="svg-line"/>`,
    `<rect x="218" y="34" width="174" height="62" rx="5" class="svg-box-accent"/>`,
    `<text x="232" y="58" font-size="11" class="svg-mono">CURRENT CUT</text>`,
    `<text x="232" y="82" font-size="15" class="svg-num">r${state.watermark}</text>`,
    `<rect x="24" y="116" width="368" height="66" rx="5" class="${blockedCount > 0 || blockedCountIncomplete ? "svg-box-bad" : "svg-box-done"}"/>`,
    `<text x="38" y="142" font-size="13" class="svg-title">${escapeHtml(clipLabel(verticalId, 24))}</text>`,
    `<text x="38" y="166" font-size="11" class="svg-mono">delta +${windowChangeCount} · ${totalWorkCount}${state.workCountersTruncated ? "+" : ""} works · ${blockedCount}${blockedCountIncomplete ? "+ live blockers (windowed)" : " live blockers"}</text>`,
    `<text x="424" y="20" font-size="11" class="svg-mono">${workRollups.length > 0 ? (anyPartial || state.workCountersTruncated || workRollups.length < totalWorkCount ? "WORK COMPLETION ROLLUP (WINDOWED)" : "WORK COMPLETION ROLLUP") : "CATEGORY VOLUME"}</text>`,
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
        `<td>${escapeHtml(entry.kinds.join(", ") || entry.category)}</td>` +
        `<td class="refs">${escapeHtml(entry.entityRefs.join(", ") || entry.eventId)}</td>` +
        `<td>${escapeHtml(entry.summary)}</td>` +
        `<td class="time">${escapeHtml(entry.occurredAt.slice(0, 19).replace("T", " "))}</td>` +
        `</tr>`,
    )
    .join("");
  return (
    `<div class="table-wrap"><table><thead><tr>` +
    `<th>Rev</th><th>Event</th><th>Kinds</th><th>Entities</th><th>Summary</th><th>Time</th>` +
    `</tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

function renderWorkRollupTable(
  workRollups: readonly DossierWorkRollup[],
  totalWorkCount: number,
  workCountersTruncated: boolean,
): string {
  if (workRollups.length === 0) return "";
  const coverageNote = workCountersTruncated
    ? `<p>Showing ${workRollups.length} most recent retained Work streams (${totalWorkCount}+ total).</p>`
    : workRollups.length < totalWorkCount
      ? `<p>Showing ${workRollups.length} most recent of ${totalWorkCount} Work streams.</p>`
      : "";
  const rows = workRollups
    .map(
      (work) =>
        `<tr>` +
        `<td class="refs"><code>${escapeHtml(work.workId)}</code></td>` +
        `<td>${escapeHtml(work.title)}</td>` +
        `<td><span class="pill ${work.blockedTasks > 0 ? "pill-bad" : work.status === "done" ? "pill-done" : "pill-accent"}">${escapeHtml(work.status)}</span></td>` +
        `<td class="rev">${work.doneTasks}/${work.totalTasks}${work.countsIncomplete ? " (partial)" : ""}</td>` +
        `<td class="rev">${work.blockedTasks}${work.countsIncomplete ? " (partial)" : ""}</td>` +
        `<td class="refs"><code>${escapeHtml(work.explainerPath)}</code></td>` +
        `<td class="rev">r${work.latestRevision}</td>` +
        `</tr>`,
    )
    .join("");
  return (
    `${coverageNote}<div class="table-wrap"><table><thead><tr>` +
    `<th>Work</th><th>Title</th><th>Status</th><th>Done/Total</th><th>Blocked</th><th>Work Explainer</th><th>Latest Rev</th>` +
    `</tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

function renderDecisionTable(decisions: readonly DossierDecisionRecord[], emptySummary: string): string {
  if (decisions.length === 0) return `<p>${escapeHtml(emptySummary)}</p>`;
  const rows = decisions
    .map((dec) => {
      const detailParts = [
        dec.title,
        ...(dec.chosen && dec.chosen.length > 0 ? [`chosen: ${dec.chosen.join("; ")}`] : []),
        ...(dec.reason && dec.reason !== dec.title ? [dec.reason] : []),
      ];
      const detail = detailParts.join(" — ");
      const scope = dec.modules.join(", ") || "—";
      const derived = dec.derivedTaskIds.map((id) => `task/${id}`).join(", ") || "—";
      return (
        `<tr>` +
        `<td class="rev">r${dec.workspaceRevision}</td>` +
        `<td class="refs"><code>decision/${escapeHtml(dec.decisionId)}</code></td>` +
        `<td><span class="pill ${dec.state === "in_effect" ? "pill-done" : "pill-wait"}">${escapeHtml(dec.state)}</span></td>` +
        `<td>${escapeHtml(detail)}</td>` +
        `<td class="refs">${escapeHtml(scope)}</td>` +
        `<td class="refs">${escapeHtml(derived)}</td>` +
        `</tr>`
      );
    })
    .join("");
  return (
    `<div class="table-wrap"><table><thead><tr>` +
    `<th>Rev</th><th>Decision</th><th>State</th><th>Title / Rationale</th><th>Modules</th><th>Derived Tasks</th>` +
    `</tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

function renderSectionBody(
  anchor: string,
  verticalId: string,
  slot: DossierSlot,
  state: DossierLedgerState,
  workRollups: readonly DossierWorkRollup[],
  totalWorkCount: number,
  blockedTasks: readonly DossierTaskRecord[],
  totalBlockedCount: number,
  blockedCountIncomplete: boolean,
  expectedWatermark: number,
  windowChangeCount: number,
): string {
  if (anchor === "atlas-topology") {
    const relationsTable =
      state.relations.length > 0
        ? `<div class="table-wrap"><table><thead><tr><th>Rev</th><th>Source</th><th>Relation</th><th>Target</th><th>Rationale</th></tr></thead><tbody>` +
          state.relations
            .slice(0, 12)
            .map(
              (edge) =>
                `<tr><td class="rev">r${edge.workspaceRevision}</td>` +
                `<td class="refs">${escapeHtml(edge.source)}</td>` +
                `<td><code>${escapeHtml(edge.relationType)}</code></td>` +
                `<td class="refs">${escapeHtml(edge.target)}</td>` +
                `<td>${escapeHtml(edge.rationale ?? "—")}</td></tr>`,
            )
            .join("") +
          `</tbody></table></div>`
        : "";
    return `${renderAtlasSvg(verticalId, slot, state, totalBlockedCount, blockedCountIncomplete)}${relationsTable}`;
  }
  if (anchor === "pulse-flow") {
    return `${renderPulseSvg(verticalId, slot, state, workRollups, totalWorkCount, totalBlockedCount, blockedCountIncomplete, expectedWatermark, windowChangeCount)}${renderWorkRollupTable(workRollups, totalWorkCount, Boolean(state.workCountersTruncated))}`;
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
    const modules = [
      ...new Set([
        ...Object.values(state.activeDecisions).flatMap((dec) => dec.modules),
        ...Object.values(state.tasks).flatMap((task) => task.surfaces),
      ]),
    ].slice(0, 14);
    const moduleStrip =
      modules.length > 0
        ? `<div class="tag-strip">${modules.map((mod) => `<span class="tag">${escapeHtml(mod)}</span>`).join("")}</div>`
        : "";
    return `<div class="grid-cards">${cards}</div>${moduleStrip}`;
  }
  if (anchor === "decision-trail") {
    const active = Object.values(state.activeDecisions).sort(
      (left, right) => right.workspaceRevision - left.workspaceRevision,
    );
    const activeHtml = renderDecisionTable(
      active,
      `Watermarked at r${state.watermark}: 0 active governing decisions observed.`,
    );
    const retiredHtml =
      state.retiredDecisions.length > 0
        ? `<details><summary>Superseded / Retired Decisions (${state.retiredDecisions.length})</summary>${renderDecisionTable(state.retiredDecisions, "")}</details>`
        : "";
    return `${activeHtml}${retiredHtml}`;
  }
  if (anchor === "risk-signals") {
    const blocked = blockedTasks;
    const coverageNote = blockedCountIncomplete
      ? `<p>Showing ${blocked.length} most recent retained live blocked tasks (${totalBlockedCount}+ live blockers; older blocked tasks compacted to fit 512 KiB dossier budget).</p>`
      : blocked.length < totalBlockedCount
        ? `<p>Showing ${blocked.length} most recent of ${totalBlockedCount} live blocked tasks.</p>`
        : "";
    const blockedHtml =
      blocked.length === 0
        ? `<p>Watermarked at r${state.watermark}: 0${blockedCountIncomplete ? ` retained live blocked tasks in recent window (${totalBlockedCount}+ total)` : " live blocked tasks"}.</p>`
        : `${coverageNote}<div class="table-wrap"><table><thead><tr><th>Rev</th><th>Task</th><th>Work</th><th>Title</th><th>Block Reason</th></tr></thead><tbody>` +
          blocked
            .map(
              (task) =>
                `<tr>` +
                `<td class="rev">r${task.workspaceRevision}</td>` +
                `<td class="refs"><code>task/${escapeHtml(task.taskId)}</code></td>` +
                `<td class="refs">${escapeHtml(task.parentTaskId ?? "—")}</td>` +
                `<td>${escapeHtml(task.title)}</td>` +
                `<td>${escapeHtml(task.reason ?? "blocked")}</td>` +
                `</tr>`,
            )
            .join("") +
          `</tbody></table></div>`;
    const historicalRisks = state.entries.filter((entry) => entry.riskSignal && entry.type !== "task_transitioned");
    const historicalHtml =
      historicalRisks.length > 0
        ? `<details><summary>Historical Supersessions &amp; Cancellations (${historicalRisks.length})</summary>${renderEntryTable(historicalRisks.slice(0, 12), "")}</details>`
        : "";
    return `${blockedHtml}${historicalHtml}`;
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
  readonly workRollups: readonly DossierWorkRollup[];
  readonly totalWorkCount: number;
  readonly blockedTasks: readonly DossierTaskRecord[];
  readonly totalBlockedCount: number;
  readonly blockedCountIncomplete: boolean;
  readonly expectedWatermark: number;
  readonly windowChangeCount: number;
  readonly stateComment: string;
}): string {
  const {
    verticalId,
    slot,
    state,
    workRollups,
    totalWorkCount,
    blockedTasks,
    totalBlockedCount,
    blockedCountIncomplete,
    expectedWatermark,
    windowChangeCount,
    stateComment,
  } = input;
  const activeDecisionCount = Object.keys(state.activeDecisions).length;
  const anchors = slot.requiredAnchors.length > 0 ? slot.requiredAnchors : ["atlas-topology", "change-ledger"];
  const hasDiagramAnchor = anchors.includes("atlas-topology") || anchors.includes("pulse-flow");
  const fallbackDiagram = hasDiagramAnchor
    ? ""
    : `<section><h2>${escapeHtml(slot.title)}<small>r${state.watermark}</small></h2>${renderAtlasSvg(verticalId, slot, state, totalBlockedCount, blockedCountIncomplete)}</section>`;
  const sections = anchors
    .map(
      (anchor) =>
        `<section id="${escapeHtml(anchor)}">` +
        `<h2>${escapeHtml(anchorTitle(anchor))}<small>#${escapeHtml(anchor)}</small></h2>` +
        renderSectionBody(
          anchor,
          verticalId,
          slot,
          state,
          workRollups,
          totalWorkCount,
          blockedTasks,
          totalBlockedCount,
          blockedCountIncomplete,
          expectedWatermark,
          windowChangeCount,
        ) +
        `</section>`,
    )
    .join("");
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
      `<div class="metric"><strong>${activeDecisionCount}</strong><span>Active Decisions</span></div>` +
      `<div class="metric"><strong>${totalBlockedCount}${blockedCountIncomplete ? "+" : ""}</strong><span>${blockedCountIncomplete ? "Live Blockers (windowed)" : "Live Blockers"}</span></div>` +
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
