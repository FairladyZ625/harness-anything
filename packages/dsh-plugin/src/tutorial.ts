import { createElement as h, useState, type ReactNode } from "react";
import type { TutorialCopy, TutorialItem, TutorialSection } from "./tutorial-content.ts";

/**
 * Styles use DSH's own design tokens (`--dsw-alias-*`), so the page follows the
 * host's light/dark theme and matches the Settings → Plugins cards.
 */
const STYLE = `
.hat{height:100%;overflow-y:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:14px;line-height:1.65;-webkit-font-smoothing:antialiased}
.hat-inner{max-width:880px;margin:0 auto;padding:calc(var(--dsh-frame-top-clearance,24px) + 8px) 32px 64px}
.hat-hero{display:flex;flex-direction:column;gap:12px;padding-bottom:24px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.hat-hero h1{margin:0;font-family:var(--dsw-font-family-brand);font-size:26px;font-weight:600;letter-spacing:-.01em}
.hat-lead{margin:0;max-width:640px;color:var(--dsw-alias-label-secondary);font-size:15px}
.hat-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:4px}
.hat-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.hat-btn{appearance:none;border:0;cursor:pointer;font:inherit;font-weight:500;border-radius:var(--dsw-radius-sm);transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.hat-btn-primary{padding:8px 16px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.hat-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.hat-btn-ghost{padding:2px 10px;font-size:12px;background:transparent;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l3)}
.hat-btn-ghost:hover{background:var(--dsw-alias-button-ghost-active-fill)}
.hat-toc{display:flex;flex-wrap:wrap;gap:6px 8px;margin:20px 0 8px;padding:0;list-style:none}
.hat-toc a{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);text-decoration:none}
.hat-toc a:hover{color:var(--dsw-alias-label-primary)}
.hat-section{margin-top:32px;scroll-margin-top:24px}
.hat-section h2{margin:0 0 4px;font-size:17px;font-weight:600}
.hat-intro{margin:0 0 12px;color:var(--dsw-alias-label-secondary)}
.hat-list{display:flex;flex-direction:column;gap:10px;margin:12px 0 0;padding:0;list-style:none;counter-reset:hat}
.hat-card{position:relative;padding:14px 16px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-settings-card-stroke)}
.hat-numbered .hat-card{padding-left:52px;counter-increment:hat}
.hat-numbered .hat-card::before{content:counter(hat);position:absolute;left:16px;top:14px;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.hat-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0;font-weight:600}
.hat-tag{padding:1px 8px;border-radius:var(--dsw-radius-xs);font-family:var(--ds-font-family-code);font-size:12px;font-weight:500;color:var(--dsw-static-deepseek-500);background:var(--dsw-static-deepseek-50)}
body[data-ds-dark-theme] .hat-tag{color:var(--dsw-static-deepseek-300);background:var(--dsw-static-deepseek-900)}
.hat-body{margin:4px 0 0;color:var(--dsw-alias-label-secondary)}
.hat-title + .hat-body{margin-top:4px}
.hat code{white-space:nowrap;font-family:var(--ds-font-family-code);font-size:.92em;padding:1px 5px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-markdown-code-block)}
.hat-snippet{margin-top:10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-markdown-code-block);overflow:hidden}
.hat-snippet-head{display:flex;align-items:center;justify-content:space-between;padding:6px 8px 0 12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.hat-snippet pre{margin:0;padding:6px 12px 10px;white-space:pre-wrap;word-break:break-word;font-size:13px}
.hat-snippet-command pre{font-family:var(--ds-font-family-code)}
.hat-snippet-say pre{font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary)}
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
    { className: `hat-snippet hat-snippet-${kind}` },
    h(
      "div",
      { className: "hat-snippet-head" },
      h("span", null, kind === "say" ? copy.sayLabel : copy.commandLabel),
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
    ),
    h("pre", null, text),
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
    { className: "hat-section", id: `hat-${section.id}` },
    h("h2", null, section.title),
    section.intro ? h("p", { className: "hat-intro" }, ...inline(section.intro)) : null,
    h(
      "ol",
      { className: section.numbered ? "hat-list hat-numbered" : "hat-list" },
      ...section.items.map((item, index) => h(Item, { key: index, item, copy })),
    ),
  );
}

export function Tutorial({ copy, onOpen }: { copy: TutorialCopy; onOpen: () => void }): ReactNode {
  return h(
    "div",
    { className: "hat" },
    h("style", null, STYLE),
    h(
      "article",
      { className: "hat-inner" },
      h(
        "header",
        { className: "hat-hero" },
        h("h1", null, copy.title),
        h("p", { className: "hat-lead" }, copy.lead),
        h(
          "div",
          { className: "hat-actions" },
          h("button", { type: "button", className: "hat-btn hat-btn-primary", onClick: onOpen }, copy.open),
          h("p", { className: "hat-hint" }, copy.openHint),
        ),
      ),
      h(
        "nav",
        { "aria-label": copy.contents },
        h(
          "ul",
          { className: "hat-toc" },
          ...copy.sections.map((section) =>
            h(
              "li",
              { key: section.id },
              h(
                "a",
                {
                  href: `#hat-${section.id}`,
                  onClick: (event: { preventDefault(): void }) => {
                    event.preventDefault();
                    document
                      .getElementById(`hat-${section.id}`)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  },
                },
                section.title,
              ),
            ),
          ),
        ),
      ),
      ...copy.sections.map((section) => h(Section, { key: section.id, section, copy })),
    ),
  );
}
