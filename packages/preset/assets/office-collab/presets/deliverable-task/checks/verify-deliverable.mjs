import { hash } from "node:crypto";
import { readFileSync } from "node:fs";

const PREDICATE_TYPE = "office-collab/deliverable-contract/v1";
const SCHEMA_ID = "office-collab/deliverable-manifest/v1";
const MANIFEST_PATH = "artifacts/deliverable-manifest.json";
const ALLOWED_KINDS = new Set(["proposal", "report", "specification", "briefing", "checklist", "other"]);
const SHA256_RE = /^[0-9a-f]{64}$/u;
const SAFE_ARTIFACT = /^artifacts\/(?:(?!\.\.?\/)[^/\\]+\/)*(?!\.\.?$)[^/\\]+$/u;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function findRootSubject(subjects, logicalPath) {
  const pattern = new RegExp(`^(?:(?!artifacts\\/)[^/]+\\/)*${escapeRegex(logicalPath)}$`, "u");
  return subjects.find((item) => typeof item?.path === "string" && pattern.test(item.path));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function scanDuplicateTopLevelKeys(raw) {
  const seen = new Set();
  const duplicates = [];
  for (let i = 0, depth = 0, strStart = -1, escaped = false; i < raw.length; i += 1) {
    const ch = raw[i];
    if (strStart >= 0) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        if (depth === 1) {
          let j = i + 1;
          while (/\s/u.test(raw[j] ?? "")) j += 1;
          if (raw[j] === ":") {
            const key = JSON.parse(raw.slice(strStart, i + 1));
            if (seen.has(key) && !duplicates.includes(key)) duplicates.push(key);
            seen.add(key);
          }
        }
        strStart = -1;
      }
    } else if (ch === '"') strStart = i;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
  }
  return duplicates;
}

function stripFrontmatter(body) {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(body);
  return match ? body.slice(match[0].length) : body;
}

const NAMED_ENTITIES = new Map([
  ["Tab", "\t"],
  ["NewLine", "\n"],
  ["nbsp", "\u00a0"],
  ["NonBreakingSpace", "\u00a0"],
  ["shy", "\u00ad"],
  ["ensp", "\u2002"],
  ["emsp", "\u2003"],
  ["emsp13", "\u2004"],
  ["emsp14", "\u2005"],
  ["numsp", "\u2007"],
  ["puncsp", "\u2008"],
  ["thinsp", "\u2009"],
  ["ThinSpace", "\u2009"],
  ["hairsp", "\u200a"],
  ["VeryThinSpace", "\u200a"],
  ["ZeroWidthSpace", "\u200b"],
  ["NegativeThinSpace", "\u200b"],
  ["NegativeMediumSpace", "\u200b"],
  ["NegativeThickSpace", "\u200b"],
  ["NegativeVeryThinSpace", "\u200b"],
  ["zwnj", "\u200c"],
  ["zwj", "\u200d"],
  ["lrm", "\u200e"],
  ["rlm", "\u200f"],
  ["MediumSpace", "\u205f"],
  ["ThickSpace", "\u205f\u200a"],
  ["NoBreak", "\u2060"],
  ["ApplyFunction", "\u2061"],
  ["af", "\u2061"],
  ["InvisibleTimes", "\u2062"],
  ["it", "\u2062"],
  ["InvisibleComma", "\u2063"],
  ["ic", "\u2063"],
  ["amp", "&"],
  ["AMP", "&"],
  ["lt", "<"],
  ["LT", "<"],
  ["gt", ">"],
  ["GT", ">"],
  ["quot", '"'],
  ["QUOT", '"'],
  ["apos", "'"],
  ["copy", "\u00a9"],
  ["COPY", "\u00a9"],
  ["reg", "\u00ae"],
  ["REG", "\u00ae"],
  ["trade", "\u2122"],
  ["mdash", "\u2014"],
  ["ndash", "\u2013"],
  ["hellip", "\u2026"],
  ["bull", "\u2022"],
  ["middot", "\u00b7"],
  ["lsquo", "\u2018"],
  ["rsquo", "\u2019"],
  ["ldquo", "\u201c"],
  ["rdquo", "\u201d"],
]);

const INVISIBLE_TEXT_RE = /(?:\s|\p{Cf}|\u034f|\u115f|\u1160|\u3164)/gu;
const ASCII_PUNCTUATION_RE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/u;
const UNICODE_PUNCTUATION_RE = /[\p{P}\p{S}]/u;

function hasVisibleText(text) {
  return text.replace(INVISIBLE_TEXT_RE, "").length > 0;
}

function normalizeLinkLabel(label) {
  return label
    .trim()
    .replace(/[ \t\r\n]+/gu, " ")
    .toLowerCase();
}

function decodeCharacterReferenceAt(text, start) {
  if (text[start] !== "&") return null;
  const numericHex = /^&#[xX]([0-9a-fA-F]{1,6});/u.exec(text.slice(start));
  if (numericHex) {
    const code = Number.parseInt(numericHex[1], 16);
    const decoded = code === 0 || code > 0x10ffff ? "\ufffd" : String.fromCodePoint(code);
    return { decoded, length: numericHex[0].length };
  }
  const numericDec = /^&#([0-9]{1,7});/u.exec(text.slice(start));
  if (numericDec) {
    const code = Number.parseInt(numericDec[1], 10);
    const decoded = code === 0 || code > 0x10ffff ? "\ufffd" : String.fromCodePoint(code);
    return { decoded, length: numericDec[0].length };
  }
  const named = /^&([A-Za-z][A-Za-z0-9]{1,31});/u.exec(text.slice(start));
  if (named && NAMED_ENTITIES.has(named[1])) {
    return { decoded: NAMED_ENTITIES.get(named[1]), length: named[0].length };
  }
  return null;
}

function decodeCharacterReferences(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "&") {
      const entity = decodeCharacterReferenceAt(text, i);
      if (entity) {
        out += entity.decoded;
        i += entity.length;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function stripHtmlComments(text) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("<!--", index);
    if (start < 0) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, start);
    const end = text.indexOf("-->", start + 4);
    if (end < 0) break;
    index = end + 3;
  }
  return out;
}

const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const NON_BODY_HTML_TAGS = new Set([
  "style",
  "script",
  "template",
  "head",
  "title",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
const HTML_ATTR_RE =
  /[ \t\r\n]+([A-Za-z_:][A-Za-z0-9_.:-]*)(?:[ \t\r\n]*=[ \t\r\n]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gu;

function matchInlineHtmlAt(text, start) {
  if (text[start] !== "<") return null;
  const tail = text.slice(start);
  const comment = /^<!--(?:>|->|[\s\S]*?-->)/u.exec(tail);
  if (comment) return { length: comment[0].length, visible: "", kind: "other" };
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>/u.exec(tail);
  if (cdata) return { length: cdata[0].length, visible: cdata[1], kind: "other" };
  const pi = /^<\?[\s\S]*?\?>/u.exec(tail);
  if (pi) return { length: pi[0].length, visible: "", kind: "other" };
  const decl = /^<![A-Za-z][^>]*>/u.exec(tail);
  if (decl) return { length: decl[0].length, visible: "", kind: "other" };
  const openTag =
    /^<([A-Za-z][A-Za-z0-9-]*)((?:[ \t\r\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\r\n]*=[ \t\r\n]*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*)[ \t\r\n]*(\/?)>/u.exec(
      tail,
    );
  if (openTag) {
    const tag = openTag[1].toLowerCase();
    const selfClosing = openTag[3] === "/" || VOID_HTML_TAGS.has(tag);
    const hiddenAttr =
      openTag[2].length > 0 &&
      Array.from(openTag[2].matchAll(HTML_ATTR_RE), (match) => match[1].toLowerCase()).includes("hidden");
    const suppressed = NON_BODY_HTML_TAGS.has(tag) || hiddenAttr;
    return { length: openTag[0].length, visible: "", kind: "open", tag, selfClosing, suppressed };
  }
  const closeTag = /^<\/([A-Za-z][A-Za-z0-9-]*)[ \t\r\n]*>/u.exec(tail);
  if (closeTag) return { length: closeTag[0].length, visible: "", kind: "close", tag: closeTag[1].toLowerCase() };
  return null;
}

function applyHtmlTagToSuppression(stack, html) {
  if (html.kind === "open" && !html.selfClosing) {
    stack.push({ tag: html.tag, suppressed: html.suppressed });
  } else if (html.kind === "close") {
    for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
      if (stack[idx].tag === html.tag) {
        stack.length = idx;
        break;
      }
    }
  }
}

function isHtmlSuppressed(stack) {
  return stack.some((frame) => frame.suppressed);
}

function matchAutolinkAt(text, start) {
  if (text[start] !== "<") return null;
  const tail = text.slice(start);
  const uri = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/u.exec(tail);
  if (uri) return { length: uri[0].length, visible: uri[1] };
  const email =
    /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/u.exec(
      tail,
    );
  if (email) return { length: email[0].length, visible: email[1] };
  return null;
}

function stripHtmlCommentsAndTags(text) {
  let out = "";
  const stack = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "<") {
      const html = matchInlineHtmlAt(text, i);
      if (html) {
        if (!isHtmlSuppressed(stack)) out += html.visible;
        applyHtmlTagToSuppression(stack, html);
        i += html.length;
        continue;
      }
    }
    if (!isHtmlSuppressed(stack)) out += text[i];
    i += 1;
  }
  return stripHtmlComments(out);
}

function parseAtxHeading(line) {
  const match = /^ {0,3}(#{1,6})(?:$|[ \t]+(.*)$)/u.exec(line);
  if (!match) return null;
  let text = (match[2] ?? "").replace(/[ \t]+$/u, "");
  if (/^#+$/u.test(text)) text = "";
  else text = text.replace(/[ \t]+#+$/u, "").replace(/[ \t]+$/u, "");
  return {
    depth: match[1].length,
    text,
    normalized: text ? `${match[1]} ${text}` : match[1],
  };
}

function matchHtmlBlockStart(line, inParagraph) {
  // CommonMark §4.6 HTML blocks (types 1–7); types 1–6 interrupt paragraphs, type 7 cannot.
  if (/^ {0,3}<(?:pre|script|style|textarea)(?:$|[ \t>])/iu.test(line))
    return { type: 1, endPattern: /<\/(?:pre|script|style|textarea)>/iu };
  if (/^ {0,3}<!--/u.test(line)) return { type: 2, endPattern: /-->/u };
  if (/^ {0,3}<\?/u.test(line)) return { type: 3, endPattern: /\?>/u };
  if (/^ {0,3}<![A-Za-z]/u.test(line)) return { type: 4, endPattern: />/u };
  if (/^ {0,3}<!\[CDATA\[/u.test(line)) return { type: 5, endPattern: /\]\]>/u };
  const type6 =
    /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:$|[ \t>]|\/>)/iu;
  if (type6.test(line)) return { type: 6, endPattern: null };
  if (inParagraph) return null;
  const openTag =
    /^ {0,3}<(?!(?:pre|script|style|textarea)(?:$|[ \t/>]))[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>[ \t]*$/iu;
  const closeTag = /^ {0,3}<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/u;
  if (openTag.test(line) || closeTag.test(line)) return { type: 7, endPattern: null };
  return null;
}

function makeCursor(line) {
  return { line, index: 0, col: 0, virtualSpaces: 0 };
}

function peekIndent(cursor) {
  let spaces = cursor.virtualSpaces;
  let index = cursor.index;
  let col = cursor.col + cursor.virtualSpaces;
  while (index < cursor.line.length) {
    const ch = cursor.line[index];
    if (ch === " ") {
      spaces += 1;
      col += 1;
      index += 1;
    } else if (ch === "\t") {
      const advance = 4 - (col % 4);
      spaces += advance;
      col += advance;
      index += 1;
    } else {
      break;
    }
  }
  return { spaces, blank: index >= cursor.line.length, nextIndex: index };
}

function consumeColumns(cursor, count) {
  let remaining = count;
  if (cursor.virtualSpaces > 0) {
    const take = Math.min(cursor.virtualSpaces, remaining);
    cursor.virtualSpaces -= take;
    cursor.col += take;
    remaining -= take;
  }
  while (remaining > 0 && cursor.index < cursor.line.length) {
    const ch = cursor.line[cursor.index];
    if (ch === " ") {
      cursor.index += 1;
      cursor.col += 1;
      remaining -= 1;
    } else if (ch === "\t") {
      const tabWidth = 4 - (cursor.col % 4);
      cursor.index += 1;
      if (tabWidth <= remaining) {
        cursor.col += tabWidth;
        remaining -= tabWidth;
      } else {
        cursor.col += remaining;
        cursor.virtualSpaces = tabWidth - remaining;
        remaining = 0;
      }
    } else {
      break;
    }
  }
}

function restText(cursor) {
  return (cursor.virtualSpaces > 0 ? " ".repeat(cursor.virtualSpaces) : "") + cursor.line.slice(cursor.index);
}

function isThematicBreak(text) {
  return /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/u.test(text);
}

function isSetextUnderline(text) {
  return /^ {0,3}(=+|-+)[ \t]*$/u.exec(text);
}

function matchFencedCodeOpener(text) {
  const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text);
  return opener && !(opener[1][0] === "`" && opener[2].includes("`")) ? opener : null;
}

function matchListMarker(cursor, inParagraph) {
  const info = peekIndent(cursor);
  if (info.blank || info.spaces > 3) return null;
  const tail = cursor.line.slice(info.nextIndex);
  const bullet = /^([-+*])(?:$|[ \t])/u.exec(tail);
  const ordered = bullet ? null : /^(\d{1,9})([.)])(?:$|[ \t])/u.exec(tail);
  if (!bullet && !ordered) return null;
  const markerLen = bullet ? 1 : ordered[1].length + 1;
  const probe = { ...cursor };
  consumeColumns(probe, info.spaces);
  probe.index += markerLen;
  probe.col += markerLen;
  const after = peekIndent(probe);
  if (inParagraph && (after.blank || (ordered !== null && ordered[1] !== "1"))) return null;
  const markerWidth = info.spaces + markerLen;
  const emptyFirstLine = after.blank;
  const consumeAfter = emptyFirstLine ? 0 : after.spaces >= 5 ? 1 : after.spaces;
  const itemIndent = markerWidth + (emptyFirstLine || after.spaces >= 5 ? 1 : after.spaces);
  return { spaces: info.spaces, markerLen, consumeAfter, itemIndent, emptyFirstLine };
}

function skipOptionalSpaceAndOneNewline(text, start) {
  let i = start;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  if (text[i] === "\n") {
    i += 1;
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  }
  return i;
}

function skipHorizontalSpaces(text, start) {
  let i = start;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  return i;
}

function parseLinkDestination(text, start) {
  if (start >= text.length) return -1;
  if (text[start] === "<") {
    let i = start + 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\n" || ch === "<") return -1;
      if (ch === "\\" && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (ch === ">") return i + 1;
      i += 1;
    }
    return -1;
  }
  let i = start;
  let parens = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) break;
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === "(") {
      parens += 1;
      if (parens > 32) return -1;
    } else if (ch === ")") {
      if (parens === 0) return -1;
      parens -= 1;
    }
    i += 1;
  }
  return i > start && parens === 0 ? i : -1;
}

function parseLinkTitle(text, start) {
  const open = text[start];
  const close = open === '"' ? '"' : open === "'" ? "'" : open === "(" ? ")" : null;
  if (!close) return -1;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === close) return i + 1;
    if (open === "(" && ch === "(") return -1;
    i += 1;
  }
  return -1;
}

function consumeLinkReferenceDefinition(text, start) {
  // CommonMark §4.7 link reference definition: [label]: destination [title]
  let i = start;
  let leadingSpaces = 0;
  while (i < text.length && text[i] === " " && leadingSpaces < 3) {
    i += 1;
    leadingSpaces += 1;
  }
  if (text[i] !== "[") return null;
  i += 1;
  const labelStart = i;
  let labelLength = 0;
  let hasNonSpace = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      labelLength += 2;
      hasNonSpace = true;
      i += 2;
      if (labelLength > 999) return null;
      continue;
    }
    if (ch === "[") return null;
    if (ch === "]") break;
    if (ch !== " " && ch !== "\t" && ch !== "\n") hasNonSpace = true;
    labelLength += 1;
    if (labelLength > 999) return null;
    i += 1;
  }
  if (i >= text.length || text[i] !== "]" || !hasNonSpace || text[i + 1] !== ":") return null;
  const label = normalizeLinkLabel(text.slice(labelStart, i));
  const destStart = skipOptionalSpaceAndOneNewline(text, i + 2);
  const destEnd = parseLinkDestination(text, destStart);
  if (destEnd < 0) return null;

  // Try optional title when separated by whitespace or a single newline.
  const afterDestSpace = skipHorizontalSpaces(text, destEnd);
  const hadSpace = afterDestSpace > destEnd;
  const hadNewline = text[afterDestSpace] === "\n";
  let titleEnd = -1;
  if (hadSpace || hadNewline) {
    const titleStart = hadNewline ? skipHorizontalSpaces(text, afterDestSpace + 1) : afterDestSpace;
    const candidateEnd = parseLinkTitle(text, titleStart);
    if (candidateEnd >= 0) {
      const afterTitle = skipHorizontalSpaces(text, candidateEnd);
      if (afterTitle >= text.length || text[afterTitle] === "\n") {
        titleEnd = afterTitle < text.length ? afterTitle + 1 : afterTitle;
      }
    }
  }
  if (titleEnd >= 0) return { end: titleEnd, label };

  // Otherwise destination itself must finish the line (or end of paragraph buffer).
  if (afterDestSpace >= text.length) return { end: afterDestSpace, label };
  if (text[afterDestSpace] === "\n") return { end: afterDestSpace + 1, label };
  return null;
}

function splitParagraphDefinitions(lines) {
  const joined = lines.join("\n");
  let offset = 0;
  const labels = [];
  while (offset < joined.length) {
    const match = consumeLinkReferenceDefinition(joined, offset);
    if (!match || match.end <= offset) break;
    labels.push(match.label);
    offset = match.end;
  }
  const remainder = joined.slice(offset);
  const remainingLines = remainder.length === 0 ? [] : remainder.split("\n");
  return { definitionCount: labels.length, labels, remainingLines };
}

function parseInlineLinkDestination(text, start) {
  if (start >= text.length) return -1;
  if (text[start] === "<") {
    let i = start + 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\n" || ch === "<") return -1;
      if (ch === "\\" && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (ch === ">") return i + 1;
      i += 1;
    }
    return -1;
  }
  let i = start;
  let parens = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) break;
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === "(") {
      parens += 1;
      if (parens > 32) return -1;
    } else if (ch === ")") {
      if (parens === 0) break;
      parens -= 1;
    }
    i += 1;
  }
  return parens === 0 ? i : -1;
}

function parseInlineLinkTail(text, start) {
  if (text[start] !== "(") return -1;
  let i = start + 1;
  while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i += 1;
  if (text[i] === ")") return i + 1;
  const destEnd = parseInlineLinkDestination(text, i);
  if (destEnd < 0) return -1;
  let j = destEnd;
  while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) j += 1;
  if (text[j] === ")") return j + 1;
  if (j > destEnd) {
    const titleEnd = parseLinkTitle(text, j);
    if (titleEnd >= 0) {
      let k = titleEnd;
      while (k < text.length && (text[k] === " " || text[k] === "\t" || text[k] === "\n" || text[k] === "\r")) k += 1;
      if (text[k] === ")") return k + 1;
    }
  }
  return -1;
}

function matchCodeSpanAt(text, start) {
  if (text[start] !== "`") return null;
  let ticks = 0;
  while (start + ticks < text.length && text[start + ticks] === "`") ticks += 1;
  let i = start + ticks;
  while (i < text.length) {
    if (text[i] === "`") {
      let run = 0;
      while (i + run < text.length && text[i + run] === "`") run += 1;
      if (run === ticks) {
        let content = text.slice(start + ticks, i).replace(/\r?\n/gu, " ");
        if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && /[^ ]/u.test(content)) {
          content = content.slice(1, -1);
        }
        return { end: i + run, content };
      }
      i += run;
      continue;
    }
    i += 1;
  }
  return { end: start + ticks, content: "`".repeat(ticks) };
}

function parseReferenceLabelAt(text, start) {
  if (text[start] !== "[") return null;
  let i = start + 1;
  let len = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      len += 2;
      i += 2;
      if (len > 999) return null;
      continue;
    }
    if (ch === "[") return null;
    if (ch === "]") return { end: i + 1, raw: text.slice(start + 1, i) };
    len += 1;
    if (len > 999) return null;
    i += 1;
  }
  return null;
}

function findBracketClose(text, openIndex) {
  let i = openIndex + 1;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === "`") {
      i = matchCodeSpanAt(text, i).end;
      continue;
    }
    if (ch === "<") {
      const auto = matchAutolinkAt(text, i);
      if (auto) {
        i += auto.length;
        continue;
      }
      const html = matchInlineHtmlAt(text, i);
      if (html) {
        i += html.length;
        continue;
      }
    }
    if (ch === "[") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "]") {
      if (depth === 0) return i;
      depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

function tryMatchLinkOrImageAt(text, start, definitions) {
  const isImage = text[start] === "!" && text[start + 1] === "[";
  const openIndex = isImage ? start + 1 : start;
  if (text[openIndex] !== "[") return null;
  const closeIndex = findBracketClose(text, openIndex);
  if (closeIndex < 0) return null;
  const inner = text.slice(openIndex + 1, closeIndex);
  if (!isImage && containsLink(inner, definitions)) return null;

  const after = closeIndex + 1;
  if (text[after] === "(") {
    const tailEnd = parseInlineLinkTail(text, after);
    if (tailEnd >= 0) return { end: tailEnd, inner, isImage };
  }
  if (text[after] === "[") {
    const ref = parseReferenceLabelAt(text, after);
    if (ref) {
      const key = ref.raw.length === 0 ? normalizeLinkLabel(inner) : normalizeLinkLabel(ref.raw);
      if (key.length > 0 && definitions.has(key)) {
        return { end: ref.end, inner, isImage };
      }
      return null;
    }
  }
  const shortcutKey = normalizeLinkLabel(inner);
  if (shortcutKey.length > 0 && definitions.has(shortcutKey)) {
    return { end: after, inner, isImage };
  }
  return null;
}

function containsLink(text, definitions) {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === "`") {
      i = matchCodeSpanAt(text, i).end;
      continue;
    }
    if (ch === "<") {
      const auto = matchAutolinkAt(text, i);
      if (auto) {
        i += auto.length;
        continue;
      }
      const html = matchInlineHtmlAt(text, i);
      if (html) {
        i += html.length;
        continue;
      }
    }
    if (ch === "[" && (i === 0 || text[i - 1] !== "!")) {
      const match = tryMatchLinkOrImageAt(text, i, definitions);
      if (match) return true;
    }
    i += 1;
  }
  return false;
}

function isUnicodeWhitespace(ch) {
  return ch === undefined || /\s/u.test(ch);
}

function isUnicodePunctuation(ch) {
  return ch !== undefined && (ASCII_PUNCTUATION_RE.test(ch) || UNICODE_PUNCTUATION_RE.test(ch));
}

function extractVisibleInlineText(text, definitions) {
  const tokens = [];
  const htmlStack = [];
  const pushText = (value) => {
    if (value.length > 0 && !isHtmlSuppressed(htmlStack)) tokens.push({ kind: "text", value });
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next !== undefined && ASCII_PUNCTUATION_RE.test(next)) {
        pushText(next);
        i += 2;
        continue;
      }
      pushText("\\");
      i += 1;
      continue;
    }
    if (ch === "`") {
      const span = matchCodeSpanAt(text, i);
      pushText(span.content);
      i = span.end;
      continue;
    }
    if (ch === "<") {
      const auto = matchAutolinkAt(text, i);
      if (auto) {
        pushText(auto.visible);
        i += auto.length;
        continue;
      }
      const html = matchInlineHtmlAt(text, i);
      if (html) {
        pushText(html.visible);
        applyHtmlTagToSuppression(htmlStack, html);
        i += html.length;
        continue;
      }
      pushText("<");
      i += 1;
      continue;
    }
    if (ch === "[" || (ch === "!" && text[i + 1] === "[")) {
      const link = tryMatchLinkOrImageAt(text, i, definitions);
      if (link) {
        pushText(extractVisibleInlineText(link.inner, definitions));
        i = link.end;
        continue;
      }
      if (ch === "!") {
        pushText("![");
        i += 2;
      } else {
        pushText("[");
        i += 1;
      }
      continue;
    }
    if (ch === "&") {
      const entity = decodeCharacterReferenceAt(text, i);
      if (entity) {
        pushText(entity.decoded);
        i += entity.length;
        continue;
      }
      pushText("&");
      i += 1;
      continue;
    }
    if (ch === "*" || ch === "_") {
      let run = 0;
      while (i + run < text.length && text[i + run] === ch) run += 1;
      if (!isHtmlSuppressed(htmlStack)) {
        const before = i > 0 ? text[i - 1] : undefined;
        const after = i + run < text.length ? text[i + run] : undefined;
        const leftFlanking =
          !isUnicodeWhitespace(after) &&
          (!isUnicodePunctuation(after) || isUnicodeWhitespace(before) || isUnicodePunctuation(before));
        const rightFlanking =
          !isUnicodeWhitespace(before) &&
          (!isUnicodePunctuation(before) || isUnicodeWhitespace(after) || isUnicodePunctuation(after));
        const canOpen = ch === "_" ? leftFlanking && (!rightFlanking || isUnicodePunctuation(before)) : leftFlanking;
        const canClose = ch === "_" ? rightFlanking && (!leftFlanking || isUnicodePunctuation(after)) : rightFlanking;
        tokens.push({ kind: "delim", char: ch, count: run, originalCount: run, canOpen, canClose });
      }
      i += run;
      continue;
    }
    pushText(ch);
    i += 1;
  }

  // CommonMark §6.2 emphasis delimiter matching: strip matched * / _ markers.
  for (let closerIdx = 0; closerIdx < tokens.length; closerIdx += 1) {
    const closer = tokens[closerIdx];
    if (closer.kind !== "delim" || !closer.canClose || closer.count === 0) continue;
    for (let openerIdx = closerIdx - 1; openerIdx >= 0 && closer.count > 0; openerIdx -= 1) {
      const opener = tokens[openerIdx];
      if (opener.kind !== "delim" || !opener.canOpen || opener.count === 0 || opener.char !== closer.char) continue;
      if (
        (opener.canClose || closer.canOpen) &&
        closer.originalCount % 3 !== 0 &&
        (opener.originalCount + closer.originalCount) % 3 === 0
      ) {
        continue;
      }
      const use = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
      opener.count -= use;
      closer.count -= use;
      for (let mid = openerIdx + 1; mid < closerIdx; mid += 1) {
        if (tokens[mid].kind === "delim") {
          tokens[mid].canOpen = false;
          tokens[mid].canClose = false;
        }
      }
      openerIdx = closerIdx;
    }
  }

  let out = "";
  for (const token of tokens) {
    if (token.kind === "text") out += token.value;
    else if (token.count > 0) out += token.char.repeat(token.count);
  }
  return out;
}

function parseCommonMarkAst(documentText) {
  const root = { type: "root", children: [] };
  const definitions = new Set();
  const containers = [];
  let leaf = null;

  const currentParent = () => (containers.length === 0 ? root : containers[containers.length - 1].node);

  const appendNode = (node) => {
    currentParent().children.push(node);
  };

  const closeLeaf = () => {
    if (leaf === null) return;
    if (leaf.kind === "paragraph") {
      const { definitionCount, labels, remainingLines } = splitParagraphDefinitions(leaf.lines);
      for (const label of labels) definitions.add(label);
      for (let i = 0; i < definitionCount; i += 1) appendNode({ type: "definition" });
      if (remainingLines.length > 0) {
        const text = remainingLines.map((line) => line.trim()).join("\n");
        if (text.length > 0) appendNode({ type: "paragraph", text });
      }
    } else if (leaf.kind === "fencedCode" || leaf.kind === "indentedCode") {
      appendNode({ type: "code", value: leaf.lines.join("\n") });
    } else if (leaf.kind === "htmlBlock") {
      appendNode({ type: "html", value: leaf.lines.join("\n") });
    }
    leaf = null;
  };

  const closeContainersTo = (targetLength) => {
    if (containers.length <= targetLength) return;
    closeLeaf();
    containers.length = targetLength;
  };

  for (const line of stripFrontmatter(documentText).split(/\r?\n/u)) {
    const cursor = makeCursor(line);

    // Phase 1: match open container blocks (CommonMark §5 blockquotes & list items).
    let matched = 0;
    for (let i = 0; i < containers.length; i += 1) {
      const container = containers[i];
      const info = peekIndent(cursor);
      if (container.kind === "blockquote") {
        if (!info.blank && info.spaces <= 3 && cursor.line[info.nextIndex] === ">") {
          consumeColumns(cursor, info.spaces);
          cursor.index += 1;
          cursor.col += 1;
          const after = peekIndent(cursor);
          if (!after.blank && after.spaces >= 1) consumeColumns(cursor, 1);
          matched += 1;
          continue;
        }
        break;
      }
      if (info.blank) {
        if (container.emptyFirstLine) break;
        consumeColumns(cursor, Math.min(info.spaces, container.indent));
        matched += 1;
        continue;
      }
      if (info.spaces >= container.indent) {
        consumeColumns(cursor, container.indent);
        container.emptyFirstLine = false;
        matched += 1;
        continue;
      }
      break;
    }

    // Phase 2: check lazy paragraph continuation or close unmatched containers (and inner leaves).
    if (matched < containers.length) {
      const info = peekIndent(cursor);
      const rest = restText(cursor);
      const canLazyContinue =
        leaf?.kind === "paragraph" &&
        !info.blank &&
        !(info.spaces <= 3 && cursor.line[info.nextIndex] === ">") &&
        !(info.spaces <= 3 && isThematicBreak(rest)) &&
        !(info.spaces <= 3 && isSetextUnderline(rest)) &&
        !(info.spaces <= 3 && parseAtxHeading(rest) !== null) &&
        !(info.spaces <= 3 && matchFencedCodeOpener(rest) !== null) &&
        !(info.spaces <= 3 && matchHtmlBlockStart(rest, true) !== null) &&
        matchListMarker(cursor, false) === null;
      if (canLazyContinue) {
        leaf.lines.push(rest);
        continue;
      }
      closeContainersTo(matched);
    }

    // Phase 3: continue active fenced code / HTML block leaves.
    if (leaf?.kind === "fencedCode") {
      const rest = restText(cursor);
      const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(rest);
      const closes = closer !== null && closer[1][0] === leaf.marker && closer[1].length >= leaf.length;
      if (closes) {
        closeLeaf();
      } else {
        leaf.lines.push(rest);
      }
      continue;
    }
    if (leaf?.kind === "htmlBlock") {
      const info = peekIndent(cursor);
      const rest = restText(cursor);
      if (leaf.endPattern === null && info.blank) {
        closeLeaf();
        continue;
      }
      leaf.lines.push(rest);
      if (leaf.endPattern !== null && leaf.endPattern.test(rest)) closeLeaf();
      continue;
    }

    // Phase 4: open new container blocks (or settle Setext underline / thematic break).
    let lineConsumed = false;
    while (leaf?.kind !== "indentedCode") {
      const info = peekIndent(cursor);
      if (info.blank || info.spaces > 3) break;
      const rest = restText(cursor);
      if (leaf?.kind === "paragraph") {
        const setext = isSetextUnderline(rest);
        if (setext) {
          // CommonMark §4.3 + §4.7: extract leading link reference definitions first.
          // If nothing remains, the underline cannot form a Setext heading.
          const { definitionCount, labels, remainingLines } = splitParagraphDefinitions(leaf.lines);
          for (const label of labels) definitions.add(label);
          for (let i = 0; i < definitionCount; i += 1) appendNode({ type: "definition" });
          leaf = null;
          if (remainingLines.length > 0) {
            const depth = setext[1][0] === "=" ? 1 : 2;
            const headingText = remainingLines
              .map((item) => item.trim())
              .join("\n")
              .trim();
            appendNode({ type: "heading", depth, text: headingText });
            lineConsumed = true;
            break;
          }
          // Fall through so "---" is handled as a thematic break and "===" as a paragraph.
        }
      }
      if (cursor.line[info.nextIndex] === ">") {
        closeLeaf();
        consumeColumns(cursor, info.spaces);
        cursor.index += 1;
        cursor.col += 1;
        const after = peekIndent(cursor);
        if (!after.blank && after.spaces >= 1) consumeColumns(cursor, 1);
        const node = { type: "blockquote", children: [] };
        appendNode(node);
        containers.push({ kind: "blockquote", node });
        continue;
      }
      if (isThematicBreak(rest)) {
        closeLeaf();
        appendNode({ type: "thematicBreak" });
        lineConsumed = true;
        break;
      }
      const listMarker = matchListMarker(cursor, leaf?.kind === "paragraph");
      if (listMarker) {
        closeLeaf();
        consumeColumns(cursor, listMarker.spaces);
        cursor.index += listMarker.markerLen;
        cursor.col += listMarker.markerLen;
        if (listMarker.consumeAfter > 0) consumeColumns(cursor, listMarker.consumeAfter);
        const node = { type: "listItem", children: [] };
        appendNode(node);
        containers.push({
          kind: "listItem",
          indent: listMarker.itemIndent,
          emptyFirstLine: listMarker.emptyFirstLine,
          node,
        });
        continue;
      }
      break;
    }
    if (lineConsumed) continue;

    // Phase 5: leaf blocks at current container depth.
    const info = peekIndent(cursor);
    if (info.blank) {
      closeLeaf();
      continue;
    }
    const rest = restText(cursor);
    if ((leaf === null || leaf.kind === "indentedCode") && info.spaces >= 4) {
      consumeColumns(cursor, 4);
      const codeText = restText(cursor);
      if (leaf === null) leaf = { kind: "indentedCode", lines: [] };
      leaf.lines.push(codeText);
      continue;
    }
    if (leaf?.kind === "indentedCode") closeLeaf();
    if (info.spaces <= 3) {
      const opener = matchFencedCodeOpener(rest);
      if (opener) {
        closeLeaf();
        leaf = { kind: "fencedCode", marker: opener[1][0], length: opener[1].length, lines: [] };
        continue;
      }
      const heading = parseAtxHeading(rest);
      if (heading) {
        closeLeaf();
        appendNode({ type: "heading", depth: heading.depth, text: heading.text });
        continue;
      }
      const htmlStart = matchHtmlBlockStart(rest, leaf?.kind === "paragraph");
      if (htmlStart) {
        closeLeaf();
        if (htmlStart.endPattern !== null && htmlStart.endPattern.test(rest)) {
          appendNode({ type: "html", value: rest });
        } else {
          leaf = { kind: "htmlBlock", ...htmlStart, lines: [rest] };
        }
        continue;
      }
    }
    if (leaf?.kind !== "paragraph") leaf = { kind: "paragraph", lines: [] };
    leaf.lines.push(rest);
  }
  closeContainersTo(0);
  closeLeaf();
  return { root, definitions };
}

function nodeHasVisibleContent(node, definitions) {
  switch (node.type) {
    case "definition":
    case "thematicBreak":
    case "heading":
      return false;
    case "code":
      return hasVisibleText(node.value);
    case "html":
      return hasVisibleText(decodeCharacterReferences(stripHtmlCommentsAndTags(node.value)));
    case "paragraph":
      return hasVisibleText(extractVisibleInlineText(node.text, definitions));
    case "blockquote":
    case "listItem":
      return node.children.some((child) => nodeHasVisibleContent(child, definitions));
    default:
      return false;
  }
}

function checkRequiredSections(documentText, requiredHeadingSpecs) {
  const { root: ast, definitions } = parseCommonMarkAst(documentText);
  const missing = [];
  const empty = [];
  for (const target of requiredHeadingSpecs) {
    const matchingIndices = [];
    for (let i = 0; i < ast.children.length; i += 1) {
      const node = ast.children[i];
      if (
        node.type === "heading" &&
        node.depth === target.depth &&
        (node.text === target.text || extractVisibleInlineText(node.text, definitions).trim() === target.visibleText)
      ) {
        matchingIndices.push(i);
      }
    }
    if (matchingIndices.length === 0) {
      missing.push(target.raw);
      continue;
    }
    let hasBody = false;
    for (const startIndex of matchingIndices) {
      for (let i = startIndex + 1; i < ast.children.length; i += 1) {
        const current = ast.children[i];
        if (current.type === "heading") {
          if (current.depth <= target.depth) break;
          continue;
        }
        if (nodeHasVisibleContent(current, definitions)) {
          hasBody = true;
          break;
        }
      }
      if (hasBody) break;
    }
    if (!hasBody) empty.push(target.raw);
  }
  return { missing, empty };
}

function emit(result, subjects, predicate, diagnostic) {
  const frame = (message) =>
    JSON.stringify({
      schema: "preset-script-result/v1",
      produces: [
        {
          capabilityId: "completion-witness",
          payload: {
            result,
            subjects,
            predicateType: PREDICATE_TYPE,
            predicate,
            diagnostic: message,
          },
        },
      ],
    });
  let message = diagnostic;
  let output = frame(message);
  while (result === "fail" && Buffer.byteLength(output) > 959 && message) {
    message = message.slice(0, Math.floor(message.length * 0.7));
    output = frame(message ? `${message}...` : "Invalid.");
  }
  console.log(output);
}

const inputPath = JSON.parse(process.env.HA_PRESET_INPUT ?? "{}").witnessInput;
const witness = JSON.parse(readFileSync(inputPath, "utf8"));
const rawSubjects = Array.isArray(witness.subjects) ? witness.subjects : [];
const readableArtifacts = Array.isArray(witness.artifacts) ? witness.artifacts : rawSubjects;
const subjects = rawSubjects.map(({ file: _file, ...identity }) => identity);

const manifestSubject = findRootSubject(rawSubjects, MANIFEST_PATH);
if (!manifestSubject) {
  emit("fail", subjects, {}, `Missing required artifact ${MANIFEST_PATH}.`);
  process.exit(0);
}

const rawManifest = readFileSync(manifestSubject.file, "utf8");
let manifest;
try {
  manifest = JSON.parse(rawManifest);
} catch (error) {
  emit("fail", subjects, {}, `Invalid JSON in ${MANIFEST_PATH}: ${error?.message ?? error}`);
  process.exit(0);
}
if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
  emit("fail", subjects, {}, `${MANIFEST_PATH} must be a JSON object.`);
  process.exit(0);
}

const errors = scanDuplicateTopLevelKeys(rawManifest).map((key) => `Duplicate top-level key "${key}".`);
if (manifest.schema !== SCHEMA_ID) errors.push(`schema must equal "${SCHEMA_ID}".`);
if (!nonEmptyString(manifest.title)) errors.push('Missing non-empty "title".');
if (!ALLOWED_KINDS.has(manifest.deliverableKind))
  errors.push('Invalid "deliverableKind" (expected proposal|report|specification|briefing|checklist|other).');
if (!nonEmptyString(manifest.owner)) errors.push('Missing non-empty "owner".');
if (!nonEmptyString(manifest.audience)) errors.push('Missing non-empty "audience".');
if (typeof manifest.documentPath !== "string" || !SAFE_ARTIFACT.test(manifest.documentPath))
  errors.push('Field "documentPath" must be a safe artifacts/... relative path.');
if (typeof manifest.documentSha256 !== "string" || !SHA256_RE.test(manifest.documentSha256))
  errors.push('Field "documentSha256" must be a 64-character lowercase SHA-256 hex digest.');

const requiredHeadingSpecs = [];
if (!Array.isArray(manifest.requiredSections) || manifest.requiredSections.length === 0) {
  errors.push('Field "requiredSections" must be a non-empty array of section headings.');
} else if (!manifest.requiredSections.every(nonEmptyString)) {
  errors.push('Field "requiredSections" entries must be non-empty strings.');
} else {
  const seenNormalized = new Set();
  const invalidAnchors = [];
  let hasDuplicates = false;
  const emptyDefs = new Set();
  for (const item of manifest.requiredSections) {
    const raw = item.trim();
    const parsed = parseAtxHeading(raw);
    const visibleText = parsed ? extractVisibleInlineText(parsed.text, emptyDefs).trim() : "";
    if (!parsed || !hasVisibleText(visibleText)) {
      invalidAnchors.push(raw);
      continue;
    }
    if (seenNormalized.has(parsed.normalized)) {
      hasDuplicates = true;
      continue;
    }
    seenNormalized.add(parsed.normalized);
    requiredHeadingSpecs.push({ raw, depth: parsed.depth, text: parsed.text, visibleText });
  }
  if (invalidAnchors.length > 0) {
    errors.push(
      `Field "requiredSections" entries must be non-empty Markdown ATX headings (e.g. "## Section"): invalid ${invalidAnchors.map((item) => `"${item}"`).join(", ")}.`,
    );
  }
  if (hasDuplicates) errors.push('Field "requiredSections" must not contain duplicates.');
}

if (errors.length === 0) {
  const documentSubject = findRootSubject(readableArtifacts, manifest.documentPath);
  if (!documentSubject) {
    errors.push(`Referenced deliverable "${manifest.documentPath}" is absent from submitted artifacts.`);
  } else {
    const bytes = readFileSync(documentSubject.file);
    const actualSha256 = hash("sha256", bytes, "hex");
    if (actualSha256 !== manifest.documentSha256)
      errors.push(
        `Deliverable hash mismatch for ${manifest.documentPath}: expected ${manifest.documentSha256.slice(0, 12)}, got ${actualSha256.slice(0, 12)}.`,
      );
    const { missing, empty } = checkRequiredSections(bytes.toString("utf8"), requiredHeadingSpecs);
    if (missing.length > 0) errors.push(`Missing required sections: ${missing.join(", ")}.`);
    if (empty.length > 0) errors.push(`Empty required sections: ${empty.join(", ")}.`);
  }
}

if (errors.length > 0) {
  emit("fail", subjects, {}, errors.join(" "));
} else {
  emit(
    "pass",
    subjects,
    {
      schema: manifest.schema,
      deliverableKind: manifest.deliverableKind,
      owner: manifest.owner,
      documentPath: manifest.documentPath,
      documentSha256: manifest.documentSha256,
      verifiedSectionCount: requiredHeadingSpecs.length,
    },
    "Deliverable contract, SHA-256 digest, and required sections verified.",
  );
}
