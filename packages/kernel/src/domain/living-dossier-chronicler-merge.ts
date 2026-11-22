import { dossierContentMaxBytes } from "./cli-operational-policy.ts";
import {
  escapeMarkdownCell,
  sanitizeExternalUrlText,
  toLedgerEntry,
  type DossierSynthesisInput,
} from "./living-dossier-state.ts";

const INCREMENTAL_MD_START = "<!-- dossier-incremental-updates:start -->";
const INCREMENTAL_MD_END = "<!-- dossier-incremental-updates:end -->";
const MAX_APPENDIX_ROWS = 24;

const utf8Encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function escapeInlineHtmlText(value: string): string {
  return sanitizeExternalUrlText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function updateMarkdownWatermarkHeader(body: string, targetWatermark: number): string {
  const watermarkLine = `<!-- dossier-watermark: ${targetWatermark} -->`;
  if (/^\s*<!--\s*dossier-watermark:\s*\d+\s*-->/u.test(body)) {
    return body.replace(/^\s*<!--\s*dossier-watermark:\s*\d+\s*-->/u, () => watermarkLine);
  }
  return `${watermarkLine}\n${body}`;
}

function enforceDossierSizeCeiling(slotId: string, body: string): string {
  const bytes = utf8ByteLength(body);
  if (bytes > dossierContentMaxBytes) {
    throw new Error(
      `Dossier base document for slot "${slotId}" exceeds ${dossierContentMaxBytes} UTF-8 bytes (${bytes} bytes) even with 0 incremental appendix rows; ask the chronicler agent to condense or archive older sections before synthesizing.`,
    );
  }
  return body;
}

export function preserveExternalMarkdownBody(input: DossierSynthesisInput, previousBody: string): string {
  const withWatermark = updateMarkdownWatermarkHeader(previousBody, input.targetWatermark);
  if (input.changes.length === 0) {
    return enforceDossierSizeCeiling(input.slot.id, withWatermark);
  }

  const newRowLines = input.changes
    .map((change) => toLedgerEntry(change, input.slot, input.kindMap))
    .sort(
      (left, right) => right.workspaceRevision - left.workspaceRevision || right.eventId.localeCompare(left.eventId),
    )
    .slice(0, MAX_APPENDIX_ROWS)
    .map((row) => {
      const refs = row.entityRefs.join(", ") || row.eventId;
      return `| r${row.workspaceRevision} | \`${row.type}\` | \`${escapeMarkdownCell(refs)}\` | ${escapeMarkdownCell(row.summary)} | \`${escapeMarkdownCell(row.actorLabel)}\` |`;
    });

  const existingStart = withWatermark.indexOf(INCREMENTAL_MD_START);
  const existingEnd = withWatermark.indexOf(INCREMENTAL_MD_END);
  let baseMarkdown = withWatermark;
  let existingRows: string[] = [];
  if (existingStart !== -1 && existingEnd > existingStart) {
    const existingBlock = withWatermark.slice(existingStart, existingEnd);
    existingRows = existingBlock.split(/\r?\n/u).filter((line) => line.startsWith("| r"));
    const before = withWatermark.slice(0, existingStart).trimEnd();
    const after = withWatermark.slice(existingEnd + INCREMENTAL_MD_END.length).trimStart();
    baseMarkdown = after.length > 0 ? `${before}\n\n${after}` : `${before}\n`;
  }

  const combinedRows = [...newRowLines, ...existingRows].slice(0, MAX_APPENDIX_ROWS);
  const assemble = (rows: readonly string[]): string => {
    if (rows.length === 0) return baseMarkdown;
    const appendix = [
      "",
      INCREMENTAL_MD_START,
      `## Incremental Updates (through r${input.targetWatermark})`,
      "",
      "| Rev | Event | Entities | Summary | Actor |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
      INCREMENTAL_MD_END,
      "",
    ].join("\n");
    return `${baseMarkdown.trimEnd()}\n${appendix}`;
  };

  for (let keep = combinedRows.length; keep >= 0; keep -= 1) {
    const candidate = assemble(combinedRows.slice(0, keep));
    if (utf8ByteLength(candidate) <= dossierContentMaxBytes) return candidate;
  }

  return enforceDossierSizeCeiling(input.slot.id, baseMarkdown);
}

function updateHtmlWatermarkMeta(body: string, targetWatermark: number): string {
  const replacement = `<meta name="dossier-watermark" content="${targetWatermark}">`;
  const nameFirst = /<meta\b[^>]*\bname\s*=\s*(?:"dossier-watermark"|'dossier-watermark'|dossier-watermark)[^>]*>/iu;
  if (nameFirst.test(body)) {
    return body.replace(nameFirst, () => replacement);
  }
  return body.replace(/<head(\s[^>]*)?>/iu, (match) => `${match}\n${replacement}`);
}

/**
 * Losslessly scrubs external http(s):// URLs from chronicler-authored HTML so GUI continuation
 * outputs stay 100% offline-clean without dropping curated sections or citation clues.
 */
export function sanitizeExternalHtmlOffline(html: string): string {
  if (!/https?:(?:\/\/|\\\/\\\/)/iu.test(html)) return html;

  const hrefPattern = /\s+href\s*=\s*(?:"(https?:\/\/[^"]*)"|'(https?:\/\/[^']*)'|(https?:\/\/[^\s"'=<>`]+))/iu;
  // 1. Convert <a ... href="https?://...">text</a> to an offline linkless reference preserving domain/path clue.
  let cleaned = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu, (full, attrs: string, inner: string) => {
    const hrefMatch = hrefPattern.exec(attrs);
    if (!hrefMatch) return full;
    const rawUrl = hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "";
    const strippedRef = sanitizeExternalUrlText(rawUrl);
    const cleanedAttrs = attrs.replace(hrefPattern, "");
    const cleanedInner = sanitizeExternalUrlText(inner);
    const refSuffix =
      strippedRef.length > 0 && !cleanedInner.includes(strippedRef)
        ? ` [ref: ${escapeInlineHtmlText(strippedRef)}]`
        : "";
    return `<a${cleanedAttrs}>${cleanedInner}${refSuffix}</a>`;
  });

  // 2. Strip redundant SVG/XLink XML namespaces that embed http://www.w3.org/... (HTML5 inline SVG needs none).
  cleaned = cleaned.replace(/\s+xmlns(?::[a-z][\w-]*)?\s*=\s*(?:"https?:\/\/[^"]*"|'https?:\/\/[^']*')/giu, "");

  // 3. Strip any remaining external href attributes on malformed/unclosed anchors.
  cleaned = cleaned.replace(/\s+href\s*=\s*(?:"https?:\/\/[^"]*"|'https?:\/\/[^']*'|https?:\/\/[^\s"'=<>`]+)/giu, "");

  // 4. Fixed-point scrub any residual http(s):// in prose or comments while preserving domain/path text.
  return sanitizeExternalUrlText(cleaned);
}

const APPENDIX_SECTION_RE =
  /\s*<section\b[^>]*\b(?:id="dossier-incremental-appendix"|data-dossier-appendix="1"|data-dossier-incremental="true")[^>]*>[\s\S]*?<\/section\s*>\s*/giu;

function extractExistingHtmlAppendixRows(html: string): string[] {
  const rows: string[] = [];
  for (const match of html.matchAll(APPENDIX_SECTION_RE)) {
    const section = match[0] ?? "";
    const tbodyMatch = /<tbody\b[^>]*>([\s\S]*?)<\/tbody\s*>/iu.exec(section);
    if (!tbodyMatch) continue;
    for (const rowMatch of tbodyMatch[1]!.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/giu)) {
      rows.push(rowMatch[0]!);
    }
  }
  return rows;
}

function insertHtmlSection(baseHtml: string, sectionHtml: string): string {
  if (/<\/main\s*>/iu.test(baseHtml)) {
    return baseHtml.replace(/<\/main\s*>/iu, () => `${sectionHtml}</main>`);
  }
  if (/<\/body\s*>/iu.test(baseHtml)) {
    return baseHtml.replace(/<\/body\s*>/iu, () => `${sectionHtml}</body>`);
  }
  return `${baseHtml}${sectionHtml}`;
}

export function preserveExternalHtmlBody(input: DossierSynthesisInput, previousBody: string): string {
  const withWatermark = sanitizeExternalHtmlOffline(updateHtmlWatermarkMeta(previousBody, input.targetWatermark));
  if (input.changes.length === 0) {
    return enforceDossierSizeCeiling(input.slot.id, withWatermark);
  }

  const newRows = input.changes
    .map((change) => toLedgerEntry(change, input.slot, input.kindMap))
    .sort(
      (left, right) => right.workspaceRevision - left.workspaceRevision || right.eventId.localeCompare(left.eventId),
    )
    .slice(0, MAX_APPENDIX_ROWS)
    .map(
      (entry) =>
        `<tr>` +
        `<td class="rev">r${entry.workspaceRevision}</td>` +
        `<td><code>${escapeInlineHtmlText(entry.type)}</code></td>` +
        `<td class="refs">${escapeInlineHtmlText(entry.entityRefs.join(", ") || entry.eventId)}</td>` +
        `<td>${escapeInlineHtmlText(entry.summary)}</td>` +
        `<td class="time">${escapeInlineHtmlText(entry.occurredAt.slice(0, 19).replace("T", " "))}</td>` +
        `</tr>`,
    );

  const existingRows = extractExistingHtmlAppendixRows(withWatermark);
  const baseHtml = withWatermark.replace(APPENDIX_SECTION_RE, (match) => (match.includes("\n") ? "\n" : ""));
  const combinedRows = [...newRows, ...existingRows].slice(0, MAX_APPENDIX_ROWS);

  const assemble = (rows: readonly string[]): string => {
    if (rows.length === 0) return baseHtml;
    const incrementalSection =
      `\n<section id="dossier-incremental-appendix" data-dossier-appendix="1" data-dossier-incremental="true">` +
      `<h2>Incremental Updates <small>through r${input.targetWatermark}</small></h2>` +
      `<div class="table-wrap"><table><thead><tr><th>Rev</th><th>Event</th><th>Entities</th><th>Summary</th><th>Time</th></tr></thead>` +
      `<tbody>${rows.join("")}</tbody></table></div></section>\n`;
    return insertHtmlSection(baseHtml, incrementalSection);
  };

  for (let keep = combinedRows.length; keep >= 0; keep -= 1) {
    const candidate = assemble(combinedRows.slice(0, keep));
    if (utf8ByteLength(candidate) <= dossierContentMaxBytes) return candidate;
  }

  return enforceDossierSizeCeiling(input.slot.id, baseHtml);
}
