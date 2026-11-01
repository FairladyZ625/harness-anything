import { createElement as h, useState, type ReactNode } from "react";
import { TUTORIAL_LAYOUT, type TutorialCopy, type TutorialItem, type TutorialSection } from "./tutorial-content.ts";

/**
 * Styles use DSH's own design tokens (`--dsw-alias-*`), so the page follows the
 * host's light/dark theme and matches the Settings → Plugins cards.
 * Layout: a header, a row of tabs, and the active tab's sections side by side
 * as columns that fill the width; narrow windows stack them.
 */
const STYLE = `
.hat{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
.hat-head{flex:none;display:flex;align-items:center;gap:32px;padding:calc(var(--dsh-frame-top-clearance,16px) + 4px) 32px 16px}
.hat-head-text{flex:1;min-width:0}
.hat-head h1{margin:0;font-family:var(--dsw-font-family-brand);font-size:26px;font-weight:600;letter-spacing:-.01em}
.hat-lead{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:16px}
.hat-head-action{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:420px}
.hat-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:right}
.hat-tabs{flex:none;display:flex;gap:4px;margin:0;padding:0 28px;list-style:none;border-bottom:1px solid var(--dsw-alias-border-l2);overflow-x:auto}
.hat-tab{appearance:none;display:flex;align-items:center;gap:8px;padding:10px 14px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:15px;white-space:nowrap;cursor:pointer}
.hat-tab:hover{color:var(--dsw-alias-label-primary)}
.hat-tab[aria-selected=true]{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-button-primary-fill)}
.hat-tab-n{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.hat-panel{flex:1;min-height:0;overflow-y:auto;padding:24px 32px 32px}
.hat-row{display:grid;gap:28px;align-items:start}
.hat-section h2{margin:0;font-size:18px;font-weight:600}
.hat-intro{margin:2px 0 0;color:var(--dsw-alias-label-secondary)}
.hat-grid{display:grid;gap:12px;margin:14px 0 0;padding:0;list-style:none;counter-reset:hat}
.hat-card{display:flex;flex-direction:column;gap:8px;padding:16px 18px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-settings-card-stroke)}
.hat-numbered .hat-card{counter-increment:hat}
.hat-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0;font-size:16px;font-weight:600}
.hat-numbered .hat-title::before{content:counter(hat);flex:none;width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.hat-tag{padding:0 8px;border-radius:var(--dsw-radius-xs);font-family:var(--ds-font-family-code);font-size:13px;font-weight:500;color:var(--dsw-static-deepseek-500);background:var(--dsw-static-deepseek-50)}
body[data-ds-dark-theme] .hat-tag{color:var(--dsw-static-deepseek-300);background:var(--dsw-static-deepseek-900)}
.hat-body{margin:0;color:var(--dsw-alias-label-secondary)}
.hat code{font-family:var(--ds-font-family-code);font-size:.9em;padding:0 5px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-markdown-code-block)}
.hat-snippet{display:flex;align-items:flex-start;gap:10px;padding:10px 10px 10px 12px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-markdown-code-block)}
.hat-snippet pre{flex:1;min-width:0;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;color:var(--dsw-alias-label-primary)}
.hat-url{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.hat-snippet-command pre{font-family:var(--ds-font-family-code)}
.hat-snippet-say pre{font-family:var(--dsw-font-family)}
.hat-btn{appearance:none;border:0;cursor:pointer;font:inherit;font-weight:500;border-radius:var(--dsw-radius-sm);transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.hat-btn-primary{padding:9px 20px;font-size:15px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.hat-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.hat-btn-ghost{flex:none;padding:2px 10px;font-size:13px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l3)}
.hat-btn-ghost:hover{background:var(--dsw-alias-button-ghost-active-fill)}
.hat-pager{display:flex;justify-content:flex-end;margin-top:20px}
@media (max-width:1100px){.hat-row{grid-template-columns:1fr !important}.hat-section{grid-column:auto !important}.hat-grid{grid-template-columns:repeat(auto-fit,minmax(280px,1fr)) !important}}
@media (max-width:720px){.hat-head{flex-direction:column;align-items:flex-start}.hat-head-action{align-items:flex-start}.hat-hint{text-align:left}}
`;

/** Show long links quietly; the copied text keeps them verbatim. */
function withQuietLinks(text: string): ReactNode[] {
  return text
    .split(/(https:\/\/\S+?)(?=[）)\s]|$)/u)
    .map((part, index) => (index % 2 === 1 ? h("span", { key: index, className: "hat-url" }, part) : part));
}

/** Render `text` with `code` spans between backticks. */
function inline(text: string): ReactNode[] {
  return text.split("`").map((part, index) => (index % 2 === 1 ? h("code", { key: index }, part) : part));
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall through: some embeddings deny the async clipboard API.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function Snippet({ text, kind, copy }: { text: string; kind: "say" | "command"; copy: TutorialCopy }): ReactNode {
  const [copied, setCopied] = useState(false);
  return h(
    "div",
    { className: `hat-snippet hat-snippet-${kind}`, title: kind === "say" ? copy.sayLabel : copy.commandLabel },
    h("pre", null, ...withQuietLinks(text)),
    h(
      "button",
      {
        type: "button",
        className: "hat-btn hat-btn-ghost",
        onClick: () => {
          void writeClipboard(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        },
      },
      copied ? copy.copied : copy.copy,
    ),
  );
}

function Item({ item, copy }: { item: TutorialItem; copy: TutorialCopy }): ReactNode {
  return h(
    "li",
    { className: "hat-card" },
    item.title || item.tag
      ? h(
          "p",
          { className: "hat-title" },
          item.title ? h("span", null, ...inline(item.title)) : null,
          item.tag ? h("span", { className: "hat-tag" }, item.tag) : null,
        )
      : null,
    item.body ? h("p", { className: "hat-body" }, ...inline(item.body)) : null,
    item.say ? h(Snippet, { text: item.say, kind: "say", copy }) : null,
    item.command ? h(Snippet, { text: item.command, kind: "command", copy }) : null,
  );
}

function Section({ section, span, copy }: { section: TutorialSection; span: number; copy: TutorialCopy }): ReactNode {
  return h(
    "section",
    { className: "hat-section", id: `hat-${section.id}`, style: { gridColumn: `span ${span}` } },
    h("h2", null, section.title),
    section.intro ? h("p", { className: "hat-intro" }, ...inline(section.intro)) : null,
    h(
      "ol",
      {
        className: section.numbered ? "hat-grid hat-numbered" : "hat-grid",
        style: { gridTemplateColumns: `repeat(${span}, minmax(0, 1fr))` },
      },
      ...section.items.map((item, index) => h(Item, { key: index, item, copy })),
    ),
  );
}

export function Tutorial({ copy, onOpen }: { copy: TutorialCopy; onOpen: () => void }): ReactNode {
  const [active, setActive] = useState(0);
  const tab = Math.min(active, TUTORIAL_LAYOUT.length - 1);
  const row = TUTORIAL_LAYOUT[tab]!;
  const columns = row.reduce((total, [, span]) => total + span, 0);
  const sections = new Map(copy.sections.map((section) => [section.id, section]));
  return h(
    "div",
    { className: "hat" },
    h("style", null, STYLE),
    h(
      "header",
      { className: "hat-head" },
      h("div", { className: "hat-head-text" }, h("h1", null, copy.title), h("p", { className: "hat-lead" }, copy.lead)),
      h(
        "div",
        { className: "hat-head-action" },
        h("button", { type: "button", className: "hat-btn hat-btn-primary", onClick: onOpen }, copy.open),
        h("p", { className: "hat-hint" }, copy.openHint),
      ),
    ),
    h(
      "ol",
      { className: "hat-tabs", role: "tablist", "aria-label": copy.contents },
      ...copy.tabs.map((label, position) =>
        h(
          "li",
          { key: label },
          h(
            "button",
            {
              type: "button",
              role: "tab",
              className: "hat-tab",
              "aria-selected": position === tab,
              onClick: () => setActive(position),
            },
            h("span", { className: "hat-tab-n" }, String(position + 1).padStart(2, "0")),
            h("span", null, label),
          ),
        ),
      ),
    ),
    h(
      "div",
      { className: "hat-panel", role: "tabpanel" },
      h(
        "div",
        { className: "hat-row", style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } },
        ...row.map(([id, span]) => {
          const section = sections.get(id);
          return section ? h(Section, { key: id, section, span, copy }) : null;
        }),
      ),
      tab + 1 < TUTORIAL_LAYOUT.length
        ? h(
            "div",
            { className: "hat-pager" },
            h(
              "button",
              { type: "button", className: "hat-btn hat-btn-ghost", onClick: () => setActive(tab + 1) },
              `${copy.next} ${copy.tabs[tab + 1]} →`,
            ),
          )
        : null,
    ),
  );
}
