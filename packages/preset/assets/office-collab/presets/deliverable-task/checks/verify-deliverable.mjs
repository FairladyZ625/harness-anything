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

function stripHtmlCommentsOnLine(line, inComment) {
  let out = "";
  let index = 0;
  let comment = inComment;
  while (index < line.length) {
    if (comment) {
      const end = line.indexOf("-->", index);
      if (end < 0) return { text: out, inComment: true };
      index = end + 3;
      comment = false;
    } else {
      const start = line.indexOf("<!--", index);
      if (start < 0) {
        out += line.slice(index);
        break;
      }
      out += line.slice(index, start);
      index = start + 4;
      comment = true;
    }
  }
  return { text: out, inComment: comment };
}

function parseHeading(line) {
  const match = /^ {0,3}(#{1,6})(?:$|[ \t]+(.*)$)/u.exec(line);
  if (!match) return null;
  let content = (match[2] ?? "").replace(/[ \t]+$/u, "");
  if (/^#+$/u.test(content)) content = "";
  else content = content.replace(/[ \t]+#+$/u, "").replace(/[ \t]+$/u, "");
  return {
    level: match[1].length,
    normalized: content ? `${match[1]} ${content}` : match[1],
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

function makeEntry(text, flags = {}) {
  return {
    text,
    isHeading: flags.isHeading ?? false,
    inCode: flags.inCode ?? false,
    isHtmlBlock: flags.isHtmlBlock ?? false,
    hasContent: flags.hasContent ?? false,
    level: flags.level ?? 0,
    normalizedHeading: flags.normalizedHeading ?? "",
  };
}

function flushParagraphLines(parsed, paragraphLines) {
  if (paragraphLines.length === 0) return;
  let inComment = false;
  for (const rawLine of paragraphLines) {
    const stripped = stripHtmlCommentsOnLine(rawLine, inComment);
    inComment = stripped.inComment;
    parsed.push(makeEntry(stripped.text, { hasContent: stripped.text.trim().length > 0 }));
  }
  paragraphLines.length = 0;
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

function paragraphHasSubstantiveText(lines) {
  let inComment = false;
  for (const rawLine of lines) {
    const stripped = stripHtmlCommentsOnLine(rawLine, inComment);
    inComment = stripped.inComment;
    if (stripped.text.trim().length > 0) return true;
  }
  return false;
}

function parseMarkdownLines(documentText) {
  const parsed = [];
  const containers = [];
  let rootContainerHasContent = false;
  let leaf = null;

  const closeLeaf = () => {
    if (leaf === null) return;
    if (leaf.kind === "paragraph") {
      if (containers.length === 0) flushParagraphLines(parsed, leaf.lines);
      else if (paragraphHasSubstantiveText(leaf.lines)) rootContainerHasContent = true;
    }
    leaf = null;
  };

  const closeContainersTo = (targetLength) => {
    if (containers.length <= targetLength) return;
    closeLeaf();
    containers.length = targetLength;
    if (targetLength === 0) {
      parsed.push(makeEntry("", { hasContent: rootContainerHasContent }));
      rootContainerHasContent = false;
    }
  };

  const recordSubstantive = (text, flags) => {
    if (containers.length === 0) parsed.push(makeEntry(text, flags));
    else if (flags.hasContent) rootContainerHasContent = true;
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
        !(info.spaces <= 3 && parseHeading(rest) !== null) &&
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
      recordSubstantive(rest, { inCode: true, hasContent: !closes && rest.trim().length > 0 });
      if (closes) leaf = null;
      continue;
    }
    if (leaf?.kind === "htmlBlock") {
      const info = peekIndent(cursor);
      const rest = restText(cursor);
      if (leaf.endPattern === null && info.blank) {
        leaf = null;
        continue;
      }
      const hasContent =
        leaf.type === 2 ? stripHtmlCommentsOnLine(rest, true).text.trim().length > 0 : rest.trim().length > 0;
      recordSubstantive(rest, { isHtmlBlock: true, hasContent });
      if (leaf.endPattern !== null && leaf.endPattern.test(rest)) leaf = null;
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
          const level = setext[1][0] === "=" ? 1 : 2;
          const headingText = leaf.lines
            .map((item) => item.trim())
            .join("\n")
            .trim();
          const hashes = "#".repeat(level);
          leaf = null;
          if (containers.length === 0) {
            parsed.push(
              makeEntry(headingText, {
                isHeading: true,
                level,
                normalizedHeading: headingText ? `${hashes} ${headingText}` : hashes,
              }),
            );
          } else {
            rootContainerHasContent = true;
          }
          lineConsumed = true;
          break;
        }
      }
      if (cursor.line[info.nextIndex] === ">") {
        closeLeaf();
        consumeColumns(cursor, info.spaces);
        cursor.index += 1;
        cursor.col += 1;
        const after = peekIndent(cursor);
        if (!after.blank && after.spaces >= 1) consumeColumns(cursor, 1);
        containers.push({ kind: "blockquote" });
        continue;
      }
      if (isThematicBreak(rest)) {
        closeLeaf();
        if (containers.length === 0) parsed.push(makeEntry(rest));
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
        containers.push({
          kind: "listItem",
          indent: listMarker.itemIndent,
          emptyFirstLine: listMarker.emptyFirstLine,
        });
        continue;
      }
      break;
    }
    if (lineConsumed) continue;

    // Phase 5: leaf blocks at current container depth (only root depth emits root headings).
    const info = peekIndent(cursor);
    if (info.blank) {
      closeLeaf();
      continue;
    }
    const rest = restText(cursor);
    if ((leaf === null || leaf.kind === "indentedCode") && info.spaces >= 4) {
      consumeColumns(cursor, 4);
      const codeText = restText(cursor);
      leaf = { kind: "indentedCode" };
      recordSubstantive(codeText, { inCode: true, hasContent: codeText.trim().length > 0 });
      continue;
    }
    if (leaf?.kind === "indentedCode") closeLeaf();
    if (info.spaces <= 3) {
      const opener = matchFencedCodeOpener(rest);
      if (opener) {
        closeLeaf();
        leaf = { kind: "fencedCode", marker: opener[1][0], length: opener[1].length };
        if (containers.length === 0) parsed.push(makeEntry(rest, { inCode: true }));
        continue;
      }
      const heading = parseHeading(rest);
      if (heading) {
        closeLeaf();
        if (containers.length === 0) {
          parsed.push(
            makeEntry(rest, { isHeading: true, level: heading.level, normalizedHeading: heading.normalized }),
          );
        } else {
          rootContainerHasContent = true;
        }
        continue;
      }
      const htmlStart = matchHtmlBlockStart(rest, leaf?.kind === "paragraph");
      if (htmlStart) {
        closeLeaf();
        const hasContent =
          htmlStart.type === 2 ? stripHtmlCommentsOnLine(rest, false).text.trim().length > 0 : rest.trim().length > 0;
        recordSubstantive(rest, { isHtmlBlock: true, hasContent });
        if (htmlStart.endPattern === null || !htmlStart.endPattern.test(rest))
          leaf = { kind: "htmlBlock", ...htmlStart };
        continue;
      }
    }
    if (leaf?.kind !== "paragraph") leaf = { kind: "paragraph", lines: [] };
    leaf.lines.push(rest);
  }
  closeContainersTo(0);
  closeLeaf();
  return parsed;
}

function checkRequiredSections(documentText, requiredSections) {
  const entries = parseMarkdownLines(documentText);
  const missing = [];
  const empty = [];
  for (const anchor of requiredSections) {
    const trimmedAnchor = anchor.trim();
    const targetHeading = parseHeading(trimmedAnchor);
    const matchingIndices = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (targetHeading) {
        if (entry.isHeading && entry.normalizedHeading === targetHeading.normalized) matchingIndices.push(i);
      } else if (!entry.inCode && !entry.isHtmlBlock && entry.text.trim() === trimmedAnchor) {
        matchingIndices.push(i);
      }
    }
    if (matchingIndices.length === 0) {
      missing.push(trimmedAnchor);
      continue;
    }
    const level = targetHeading?.level ?? 0;
    let hasBody = false;
    for (const startIndex of matchingIndices) {
      for (let i = startIndex + 1; i < entries.length; i += 1) {
        const current = entries[i];
        if (current.isHeading) {
          if (level > 0 && current.level <= level) break;
          continue;
        }
        if (current.hasContent) {
          hasBody = true;
          break;
        }
      }
      if (hasBody) break;
    }
    if (!hasBody) empty.push(trimmedAnchor);
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

let requiredSections = [];
if (!Array.isArray(manifest.requiredSections) || manifest.requiredSections.length === 0) {
  errors.push('Field "requiredSections" must be a non-empty array of section headings.');
} else if (!manifest.requiredSections.every(nonEmptyString)) {
  errors.push('Field "requiredSections" entries must be non-empty strings.');
} else {
  requiredSections = manifest.requiredSections.map((item) => item.trim());
  if (new Set(requiredSections).size !== requiredSections.length)
    errors.push('Field "requiredSections" must not contain duplicates.');
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
    const { missing, empty } = checkRequiredSections(bytes.toString("utf8"), requiredSections);
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
      verifiedSectionCount: requiredSections.length,
    },
    "Deliverable contract, SHA-256 digest, and required sections verified.",
  );
}
