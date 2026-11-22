import { dossierContentMaxBytes } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { DossierError, type DossierSlot } from "@harness-anything/kernel/internal/domain/living-dossier.ts";

const placeholder = /^(?:todo|tbd|placeholder|coming soon|待补充|待填写|占位|敬请期待|[-–—.…]+)[.!。！]?$/iu;
const comments = /<!--[\s\S]*?-->/gu;
const styleElements = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/giu;
const inertElements = /<(template|title|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const htmlTags = /<\/?([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/giu;
const attributes = /([^\s/="'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/gu;
const forbiddenTags = new Set(["base", "embed", "frame", "iframe", "link", "object", "script", "portal"]);
const sourceAttributes = new Set(["background", "data", "poster", "src", "srcset", "xlink:href"]);

function contentError(message: string): never {
  throw new DossierError("invalid_dossier_content", message);
}

function visibleText(value: string): string {
  return value
    .replace(/&(?:nbsp|#160|#x0*a0);/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isContent(value: string): boolean {
  const text = visibleText(value);
  return text !== "" && !placeholder.test(text);
}

function localResource(value: string): boolean {
  return (
    value.trim() === "" ||
    /^#[A-Za-z0-9_.:-]+$/u.test(value.trim()) ||
    /^data:(?:image\/(?:png|gif|jpe?g|webp|avif)|font\/(?:woff2?|ttf));base64,[A-Za-z0-9+/=]+$/iu.test(value.trim())
  );
}

function validateStyle(style: string): void {
  const css = style.replace(/\/\*[\s\S]*?\*\//gu, "");
  if (/\\|@import\b|(?:-webkit-)?image-set\s*\(/iu.test(css))
    contentError("Dossier HTML styles must use inline resources.");
  for (const [, value] of css.matchAll(/url\s*\(\s*([^)]*)\)/giu)) {
    if (!localResource(value!.trim().replace(/^(['"])([\s\S]*)\1$/u, "$2")))
      contentError("Dossier HTML styles must use inline resources.");
  }
}

function validateHtml(body: string, watermark: number): Set<string> {
  const document = body
    .replace(comments, "")
    .replace(styleElements, (_element, start: string, style: string, end: string) => {
      validateStyle(style);
      return start + end;
    })
    .replace(inertElements, "");
  const anchors = new Set<string>();
  const sourceWatermarks: string[] = [];
  const head = /<head(?:\s[^>]*)?>([\s\S]*?)<\/head\s*>/iu.exec(document);
  if (!head) contentError("Dossier HTML requires a head for source metadata.");
  if (!/^\s*<!doctype\s+html\s*>/iu.test(document) || !/<html(?:\s|>)[\s\S]*<\/html\s*>\s*$/iu.test(document))
    contentError("Dossier HTML requires a standalone HTML document.");
  const bodyMatch = /<body(?:\s[^>]*)?>([\s\S]*)<\/body\s*>/iu.exec(document);
  if (!bodyMatch) contentError("Dossier HTML requires a body.");
  const bodyMarkup = bodyMatch[1]!;
  const visibleMarkup = bodyMarkup.replace(styleElements, "");
  const prose = visibleMarkup.replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/giu, "");
  if (!isContent(prose.replace(htmlTags, " ").replace(/<![^>]*>/gu, "")))
    contentError("Dossier HTML body is empty or a placeholder.");

  for (const [tag, name, fragment] of document.matchAll(htmlTags)) {
    const element = name!.toLowerCase();
    if (tag.startsWith("</")) continue;
    if (forbiddenTags.has(element)) contentError(`Dossier HTML cannot use <${element}>.`);
    const fields = new Map<string, string>();
    for (const [, raw, quoted, single, bare] of fragment!.matchAll(attributes)) {
      const key = raw!.toLowerCase(),
        value = quoted ?? single ?? bare ?? "";
      if (fields.has(key)) contentError(`Dossier HTML repeats attribute ${key}.`);
      fields.set(key, value);
      if (
        key.startsWith("on") ||
        key === "srcdoc" ||
        key === "ping" ||
        key === "http-equiv" ||
        (sourceAttributes.has(key) && !localResource(value)) ||
        (key === "href" && !(element === "a" && /^(?:https?:\/\/|mailto:)/iu.test(value)) && !localResource(value))
      )
        contentError(`Dossier HTML has an executable or external resource attribute ${key}.`);
      if (key === "style") {
        if (/&(?:#|[a-z])/iu.test(value)) contentError("Dossier HTML style attributes must use literal CSS.");
        validateStyle(value);
      }
    }
    if (element === "meta" && fields.get("name")?.toLowerCase() === "dossier-watermark")
      sourceWatermarks.push(head[1]!.includes(tag) ? (fields.get("content") ?? "") : "");
  }
  for (const [tag, , fragment] of visibleMarkup.matchAll(htmlTags)) {
    if (tag.startsWith("</")) continue;
    for (const [, name, quoted, single, bare] of fragment!.matchAll(attributes)) {
      if (name?.toLowerCase() === "id") anchors.add(quoted ?? single ?? bare ?? "");
    }
  }
  if (sourceWatermarks.length !== 1 || sourceWatermarks[0] !== String(watermark))
    contentError(`Dossier HTML requires one meta dossier-watermark with content ${watermark}.`);
  return anchors;
}

function validateMarkdown(body: string, watermark: number): Set<string> {
  const withoutExamples = body.replace(/^ {0,3}(`{3,}|~{3,}).*\n[\s\S]*?^ {0,3}\1[\t ]*$/gmu, "");
  const firstLine = withoutExamples.trimStart().split("\n", 1)[0]?.trimEnd();
  if (firstLine !== `<!-- dossier-watermark: ${watermark} -->`)
    contentError(`Dossier Markdown must start with <!-- dossier-watermark: ${watermark} -->.`);
  const anchors = new Set<string>();
  for (const [, anchor] of withoutExamples.matchAll(/^\s*<!-- dossier-anchor: ([A-Za-z][A-Za-z0-9_.:-]*) -->\s*$/gmu))
    anchors.add(anchor!);
  const prose = withoutExamples.replace(comments, "");
  for (const [, heading] of prose.matchAll(/^ {0,3}#{1,6}[\t ]+([^\r\n]+)$/gmu))
    anchors.add(
      heading!
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _.-]/gu, "")
        .replace(/ +/gu, "-"),
    );
  if (
    !prose
      .split("\n")
      .some(
        (line) =>
          !/^\s*#/u.test(line) && isContent(line.replace(/^\s*(?:[-*+>]\s+|\d+[.)]\s+)?/u, "").replace(/[*_]/gu, "")),
      )
  )
    contentError("Dossier Markdown body is empty or a placeholder.");
  return anchors;
}

/** Check structure and source identity at the write boundary. Navigation links may cite sources. */
export function validateDossierContent(slot: DossierSlot, body: string, watermark: number): void {
  if (Buffer.byteLength(body) > dossierContentMaxBytes)
    contentError(`Dossier content exceeds ${dossierContentMaxBytes} UTF-8 bytes.`);
  const anchors = slot.kind === "html" ? validateHtml(body, watermark) : validateMarkdown(body, watermark);
  const missing = slot.requiredAnchors.filter((anchor) => !anchors.has(anchor));
  if (missing.length) contentError(`Dossier is missing required anchors ${missing.join(", ")}.`);
}
