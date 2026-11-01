import { createElement as h, useState, type ReactNode } from "react";
import type { TutorialCopy, TutorialItem, TutorialSection } from "./tutorial-content.ts";

/**
 * Styles use DSH's own design tokens (`--dsw-alias-*`), so the page follows the
 * host's light/dark theme and matches the Settings → Plugins cards.
 * Layout: a fixed header, section tabs on the left, and the active section on
 * the right as a card grid that fills wide screens instead of scrolling.
 */
const STYLE = `
.hat{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.6;-webkit-font-smoothing:antialiased}
.hat-head{flex:none;display:flex;align-items:center;gap:24px;padding:calc(var(--dsh-frame-top-clearance,16px) + 4px) 28px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.hat-head-text{flex:1;min-width:0}
.hat-head h1{margin:0;font-family:var(--dsw-font-family-brand);font-size:20px;font-weight:600;letter-spacing:-.01em}
.hat-lead{margin:2px 0 0;color:var(--dsw-alias-label-secondary)}
.hat-head-action{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:4px;max-width:360px}
.hat-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:right}
.hat-main{flex:1;min-height:0;display:flex}
.hat-nav{flex:none;width:236px;padding:16px 12px;border-right:1px solid var(--dsw-alias-border-l2);overflow-y:auto}
.hat-nav ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}
.hat-tab{appearance:none;width:100%;display:flex;align-items:center;gap:10px;padding:7px 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer}
.hat-tab:hover{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary)}
.hat-tab[aria-selected=true]{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary);font-weight:600}
.hat-tab-n{flex:none;width:18px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.hat-panel{flex:1;min-width:0;overflow-y:auto;padding:20px 28px 28px}
.hat-panel h2{margin:0;font-size:16px;font-weight:600}
.hat-intro{margin:2px 0 0;color:var(--dsw-alias-label-secondary)}
.hat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;margin:14px 0 0;padding:0;list-style:none;counter-reset:hat}
.hat-card{position:relative;display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-settings-card-stroke)}
.hat-numbered .hat-card{counter-increment:hat}
.hat-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0;font-weight:600}
.hat-numbered .hat-title::before{content:counter(hat);flex:none;width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.hat-tag{padding:0 7px;border-radius:var(--dsw-radius-xs);font-family:var(--ds-font-family-code);font-size:11.5px;font-weight:500;color:var(--dsw-static-deepseek-500);background:var(--dsw-static-deepseek-50)}
body[data-ds-dark-theme] .hat-tag{color:var(--dsw-static-deepseek-300);background:var(--dsw-static-deepseek-900)}
.hat-body{margin:0;color:var(--dsw-alias-label-secondary)}
.hat code{white-space:nowrap;font-family:var(--ds-font-family-code);font-size:.92em;padding:0 4px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-markdown-code-block)}
.hat-snippet{margin-top:auto;display:flex;align-items:flex-start;gap:8px;padding:8px 8px 8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-markdown-code-block)}
.hat-snippet pre{flex:1;min-width:0;margin:0;white-space:pre-wrap;word-break:break-word;font-size:12.5px;color:var(--dsw-alias-label-primary)}
.hat-snippet-command pre{font-family:var(--ds-font-family-code)}
.hat-snippet-say pre{font-family:var(--dsw-font-family)}
.hat-btn{appearance:none;border:0;cursor:pointer;font:inherit;font-weight:500;border-radius:var(--dsw-radius-sm);transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.hat-btn-primary{padding:7px 16px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.hat-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.hat-btn-ghost{flex:none;padding:1px 8px;font-size:11.5px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l3)}
.hat-btn-ghost:hover{background:var(--dsw-alias-button-ghost-active-fill)}
.hat-pager{display:flex;justify-content:flex-end;margin-top:16px}
@media (max-width:720px){.hat-head{flex-direction:column;align-items:flex-start}.hat-head-action{align-items:flex-start}.hat-hint{text-align:left}.hat-nav{width:150px}}
`;

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
    h("pre", null, text),
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

function Section({ section, copy }: { section: TutorialSection; copy: TutorialCopy }): ReactNode {
  return h(
    "section",
    { id: `hat-${section.id}`, role: "tabpanel" },
    h("h2", null, section.title),
    section.intro ? h("p", { className: "hat-intro" }, ...inline(section.intro)) : null,
    h(
      "ol",
      { className: section.numbered ? "hat-grid hat-numbered" : "hat-grid" },
      ...section.items.map((item, index) => h(Item, { key: index, item, copy })),
    ),
  );
}

export function Tutorial({ copy, onOpen }: { copy: TutorialCopy; onOpen: () => void }): ReactNode {
  const [active, setActive] = useState(0);
  const index = Math.min(active, copy.sections.length - 1);
  const section = copy.sections[index]!;
  const next = copy.sections[index + 1];
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
      "div",
      { className: "hat-main" },
      h(
        "nav",
        { className: "hat-nav", "aria-label": copy.contents },
        h(
          "ol",
          { role: "tablist", "aria-orientation": "vertical" },
          ...copy.sections.map((entry, position) =>
            h(
              "li",
              { key: entry.id },
              h(
                "button",
                {
                  type: "button",
                  role: "tab",
                  className: "hat-tab",
                  "aria-selected": position === index,
                  "aria-controls": `hat-${entry.id}`,
                  onClick: () => setActive(position),
                },
                h("span", { className: "hat-tab-n" }, String(position + 1).padStart(2, "0")),
                h("span", null, entry.title),
              ),
            ),
          ),
        ),
      ),
      h(
        "div",
        { className: "hat-panel" },
        h(Section, { key: section.id, section, copy }),
        next
          ? h(
              "div",
              { className: "hat-pager" },
              h(
                "button",
                { type: "button", className: "hat-btn hat-btn-ghost", onClick: () => setActive(index + 1) },
                `${copy.next} ${next.title} →`,
              ),
            )
          : null,
      ),
    ),
  );
}
