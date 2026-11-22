import {
  dossierDocumentPath,
  dossierRoot,
  type LivingDossier,
} from "@harness-anything/kernel/internal/domain/living-dossier.ts";
import type { FdeDomainDraft } from "@harness-anything/preset/fde-studio-draft";
import type { FdeHtmlPreviews } from "./studio-api.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const SHARED_STYLE = [
  ":root{color-scheme:light}*{box-sizing:border-box}",
  "body{margin:0;padding:20px 24px 48px;background:#faf7f0;color:#2c2824;font:14px/1.55 system-ui,-apple-system,sans-serif}",
  "header{border-bottom:1px solid #d8d0c4;padding-bottom:14px;margin-bottom:18px}",
  "h1{margin:0 0 6px;font:700 26px/1.15 Georgia,serif;color:#1f1c18}",
  "h2{margin:20px 0 8px;font:700 15px/1.25 system-ui,sans-serif;color:#3d3833;text-transform:uppercase;letter-spacing:.05em}",
  ".meta{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;color:#6b6359}",
  ".pill{border:1px solid #c9bfb0;border-radius:999px;padding:2px 9px;background:#f3ede2;color:#3d3833;font:500 12px/1.4 ui-monospace,monospace}",
  ".pill.ok{border-color:#4a7c59;background:#e4eee5;color:#2b5438}",
  ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:12px 0 18px}",
  ".metric{background:#fff;border:1px solid #d8d0c4;padding:10px 12px;border-radius:6px}",
  ".metric strong{display:block;font:700 22px/1.1 Georgia,serif;color:#2e5b82}",
  ".metric span{display:block;font-size:12px;color:#6b6359;margin-top:4px}",
  "table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d8d0c4;margin:8px 0 16px}",
  "th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #e6dfd3;vertical-align:top;font-size:13px}",
  "th{background:#f4efe6;color:#2e5b82;font-weight:600}",
  "code{background:#eee8dc;padding:1px 5px;border-radius:3px;font:12px ui-monospace,monospace}",
  "svg{display:block;width:100%;height:auto;background:#f5f0e6;border:1px solid #d8d0c4;border-radius:6px;margin:8px 0 16px}",
].join("");

export function renderDomainExplainerHtml(draft: FdeDomainDraft): string {
  const entityRows = draft.entities
    .map(
      (entity) =>
        `<tr><td><code>${escapeHtml(entity.id)}</code></td><td><code>${escapeHtml(entity.idPrefix)}</code></td><td>${escapeHtml(
          entity.attributes.map((attr) => `${attr.name}:${attr.type}${attr.required ? "*" : ""}`).join(", "),
        )}</td><td><code>${escapeHtml(entity.pathTemplate)}</code></td></tr>`,
    )
    .join("");
  const gateRows = draft.gates
    .map(
      (gate) =>
        `<tr><td><code>${escapeHtml(gate.gateId)}</code></td><td><code>${escapeHtml(gate.sourceKind)}</code></td><td><code>${escapeHtml(
          gate.artifactPath,
        )}</code></td><td>${gate.fields
          .map((field) => `<code>${escapeHtml(field.name)} -> ${escapeHtml(field.pointer)}</code>`)
          .join(" ")}</td></tr>`,
    )
    .join("");
  const agentRows = draft.agents
    .map(
      (agent) =>
        `<tr><td><code>${escapeHtml(agent.id)}</code></td><td>${escapeHtml(agent.name)}</td><td><span class="pill">${escapeHtml(
          agent.role,
        )}</span></td><td>${escapeHtml(agent.skills.join(", ") || "—")}</td></tr>`,
    )
    .join("");

  const svgNodes = draft.entities
    .map((entity, index) => {
      const x = 30 + (index % 3) * 230;
      const y = 30 + Math.floor(index / 3) * 86;
      return `<rect x="${x}" y="${y}" width="200" height="58" rx="6" fill="#e4eee5" stroke="#4a7c59" stroke-width="1.5"/><text x="${
        x + 100
      }" y="${y + 26}" text-anchor="middle" font-family="system-ui" font-size="13" font-weight="600" fill="#1f1c18">${escapeHtml(
        entity.id,
      )} (${escapeHtml(entity.idPrefix)})</text><text x="${x + 100}" y="${
        y + 44
      }" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="#5c544b">${
        entity.attributes.length
      } fields</text>`;
    })
    .join("");
  const svgHeight = Math.max(120, Math.ceil(Math.max(1, draft.entities.length) / 3) * 86 + 34);

  return `<!doctype html>
<html lang="${escapeHtml(draft.locale)}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    draft.title,
  )} — Explainer</title><style>${SHARED_STYLE}</style></head>
<body>
<header>
  <h1>${escapeHtml(draft.title)}</h1>
  <div class="meta">
    <span class="pill ok">${escapeHtml(draft.verticalId)}</span>
    <span class="pill">v${escapeHtml(draft.version)}</span>
    <span class="pill">preset:${escapeHtml(draft.defaultPresetId)}</span>
    <span class="pill">locale:${escapeHtml(draft.locale)}</span>
  </div>
</header>
<div class="grid">
  <div class="metric"><strong>${draft.entities.length}</strong><span>Artifact Entities</span></div>
  <div class="metric"><strong>${draft.gates.length}</strong><span>Completion Gates</span></div>
  <div class="metric"><strong>${draft.presets.length}</strong><span>Domain Presets</span></div>
  <div class="metric"><strong>${draft.agents.length}</strong><span>Domain Agents</span></div>
</div>
<section id="entities">
  <h2>Domain Entities</h2>
  <svg viewBox="0 0 740 ${svgHeight}" role="img" aria-label="Domain Entity Graph">${svgNodes}</svg>
  <table><thead><tr><th>Kind</th><th>Prefix</th><th>Attributes</th><th>Storage Path</th></tr></thead><tbody>${entityRows}</tbody></table>
</section>
<section id="gates">
  <h2>Declarative Completion Gates</h2>
  <table><thead><tr><th>Gate</th><th>Source</th><th>Artifact</th><th>JSON Pointer Bindings</th></tr></thead><tbody>${gateRows}</tbody></table>
</section>
<section id="agents">
  <h2>Domain Agents</h2>
  <table><thead><tr><th>ID</th><th>Name</th><th>Role</th><th>Skills</th></tr></thead><tbody>${agentRows}</tbody></table>
</section>
</body>
</html>`;
}

export function renderProjectAtlasHtml(draft: FdeDomainDraft, livingDossier: LivingDossier): string {
  const rootPath = dossierRoot(draft.verticalId);
  const slotRows = livingDossier.slots
    .map((slot) => {
      const targetPath = dossierDocumentPath(draft.verticalId, slot);
      const triggers = slot.triggers
        .map((trigger) =>
          trigger.kind === "event-watermark"
            ? `watermark >= +${trigger.minimumDelta}`
            : `periodic ${Math.round(trigger.everyMs / 1000)}s`,
        )
        .join(" · ");
      return `<tr><td><code>${escapeHtml(slot.id)}</code></td><td><code>${escapeHtml(targetPath)}</code></td><td><span class="pill">${escapeHtml(
        slot.kind,
      )}</span></td><td>${slot.entityKinds.map((kind) => `<code>${escapeHtml(kind)}</code>`).join(" ")}</td><td>${slot.requiredAnchors
        .map((anchor) => `<code>#${escapeHtml(anchor)}</code>`)
        .join(" ")}</td><td>${escapeHtml(triggers || "manual")}</td></tr>`;
    })
    .join("");
  const relationRows = draft.relations
    .map(
      (relation) =>
        `<tr><td><code>${escapeHtml(relation.sourceKind)}</code></td><td><span class="pill">${escapeHtml(
          relation.type,
        )}</span></td><td><code>${escapeHtml(relation.targetKind)}</code></td><td>${escapeHtml(
          relation.reads,
        )}</td><td>${escapeHtml(relation.strength)}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<!-- harness:living-dossier:watermark=0 vertical=${escapeHtml(draft.verticalId)} -->
<html lang="${escapeHtml(draft.locale)}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    draft.title,
  )} — Project Atlas</title><style>${SHARED_STYLE}</style></head>
<body>
<header id="overview">
  <h1>${escapeHtml(draft.title)} · Project Atlas</h1>
  <div class="meta">
    <span class="pill ok">${escapeHtml(draft.verticalId)}</span>
    <span class="pill">root:${escapeHtml(rootPath)}</span>
    <span class="pill">watermark:0</span>
  </div>
</header>
<section id="dossier-slots">
  <h2>Living Dossier Slots (${livingDossier.slots.length})</h2>
  <table><thead><tr><th>Slot</th><th>Materialized Path</th><th>Kind</th><th>Entities</th><th>Anchors</th><th>Triggers</th></tr></thead><tbody>${slotRows}</tbody></table>
</section>
<section id="entities">
  <h2>Entity Relation Topology (${draft.relations.length})</h2>
  <table><thead><tr><th>Source</th><th>Relation</th><th>Target</th><th>Reads</th><th>Strength</th></tr></thead><tbody>${
    relationRows || '<tr><td colspan="5">—</td></tr>'
  }</tbody></table>
</section>
<section id="gates">
  <h2>Gate Readiness Matrix</h2>
  <div class="grid">${draft.gates
    .map(
      (gate) =>
        `<div class="metric"><strong>${escapeHtml(gate.gateId)}</strong><span>${escapeHtml(gate.artifactPath)} (${
          gate.fields.length
        } bindings)</span></div>`,
    )
    .join("")}</div>
</section>
</body>
</html>`;
}

export function buildHtmlPreviews(draft: FdeDomainDraft, livingDossier: LivingDossier): FdeHtmlPreviews {
  return {
    explainerHtml: renderDomainExplainerHtml(draft),
    projectAtlasHtml: renderProjectAtlasHtml(draft, livingDossier),
  };
}
