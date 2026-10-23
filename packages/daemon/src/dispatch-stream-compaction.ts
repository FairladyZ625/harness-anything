import { readSync, statSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { withReadOnlyFile, writeFileDurablyFrom } from "./durable-file.ts";

const compactionVersion = 1 as const;
const compactionSchema = "dispatch-transcript-compaction/v1" as const;
const readChunkBytes = 64 * 1024;
const writeChunkChars = 64 * 1024;

type TranscriptItemType = "text" | "thinking";
type ProviderKind = "zcode" | "acp";
type JsonRecord = Record<string, unknown>;

interface DeltaGroup {
  readonly provider: ProviderKind;
  readonly correlation: string;
  readonly itemType: TranscriptItemType;
  readonly firstLine: number;
  readonly lines: number[];
  delta: string;
  replayAt: string | null;
  result?: { readonly id: string; readonly start: number; readonly end: number };
}

interface DeltaState {
  active: DeltaGroup | null;
  readonly messageGroups: DeltaGroup[];
}

interface CompactionPlan {
  readonly groups: ReadonlyMap<number, DeltaGroup>;
  readonly resultIds: ReadonlyMap<number, string>;
  readonly droppedLines: ReadonlySet<number>;
}

/** Rewrite an archived JSONL stream atomically; the live writer never calls this function. */
export function compactDispatchStreamArchive(file: string, dispatchId: string): boolean {
  const header = readHeader(file);
  if (header.dispatchId !== dispatchId) throw new Error(`Dispatch archive ${dispatchId} has a mismatched header.`);
  if (header.transcriptCompactionVersion === compactionVersion) return false;

  const plan = findCompactionPlan(file),
    mode = statSync(file).mode & 0o777;
  writeFileDurablyFrom(file, (descriptor) => writeCompactedArchive(file, descriptor, header, plan), mode);
  return true;
}

function findCompactionPlan(file: string): CompactionPlan {
  const groups = new Map<number, DeltaGroup>(),
    resultIds = new Map<number, string>(),
    droppedLines = new Set<number>(),
    zcode = new Map<string, DeltaState>(),
    acp = new Map<string, DeltaState>();
  let nextResultId = 1;

  forEachLine(file, (line, lineNumber) => {
    if (lineNumber === 0 || line.length === 0) return true;
    const record = parseRecord(line, lineNumber);
    if (record.kind !== "provider_event") {
      clearActive(zcode);
      clearActive(acp);
      return true;
    }

    const event = objectOf(record.event);
    if (!event) return true;
    const type = stringOf(event.type);
    if (type === "model.streaming") {
      const payload = objectOf(event.payload),
        kind = stringOf(payload?.kind),
        correlation = correlationOf(event.turnId, "zcode:default");
      if (!payload) return true;
      if ((kind === "reasoning_delta" || kind === "text_delta") && typeof payload.delta === "string") {
        const state = stateFor(zcode, correlation),
          itemType = kind === "reasoning_delta" ? "thinking" : "text";
        if (payload.delta)
          appendDelta(groups, state, {
            provider: "zcode",
            correlation,
            itemType,
            lineNumber,
            record,
            delta: payload.delta,
          });
      } else if (kind === "tool_call") stateFor(zcode, correlation).active = null;
      return true;
    }
    if (type === "tool.updated") {
      const payload = objectOf(event.payload),
        kind = stringOf(payload?.kind);
      if (kind === "result" || kind === "error")
        stateFor(zcode, correlationOf(event.turnId, "zcode:default")).active = null;
      return true;
    }
    if (type === "result") {
      const correlation = correlationOf(event.turnId, "zcode:default"),
        state = stateFor(zcode, correlation),
        response = stringOf(event.response),
        candidate = state.active;
      if (response && candidate?.itemType === "text" && candidate.delta === response) {
        const id = String(nextResultId++);
        candidate.result = { id, start: 0, end: response.length };
        candidate.delta = "";
        resultIds.set(lineNumber, id);
      }
      state.active = null;
      return true;
    }
    if (type === "turn.started" || type === "turn.completed" || type === "turn.failed" || type === "error") {
      clearActive(zcode);
      return true;
    }
    if (type === "acp.update") {
      const update = objectOf(event.update),
        kind = stringOf(update?.sessionUpdate),
        correlation = correlationOf(event.sessionId, "acp:1"),
        state = stateFor(acp, correlation);
      if (!update) return true;
      if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
        const content = objectOf(update.content),
          delta = stringOf(content?.text);
        if (delta) {
          const itemType = kind === "agent_message_chunk" ? "text" : "thinking";
          const group = appendDelta(groups, state, {
            provider: "acp",
            correlation,
            itemType,
            lineNumber,
            record,
            delta,
          });
          if (itemType === "text" && state.messageGroups.at(-1) !== group) state.messageGroups.push(group);
        }
      } else if (kind === "tool_call") state.active = null;
      else if (kind === "tool_call_update") {
        const status = stringOf(update.status);
        if (status !== "in_progress" && status !== "pending") state.active = null;
      }
      return true;
    }
    if (type === "acp.result") {
      const correlation = correlationOf(event.sessionId, "acp:1"),
        state = stateFor(acp, correlation),
        finalText = stringOf(event.finalText),
        messageText = state.messageGroups.map((group) => group.delta).join("");
      if (finalText && finalText === messageText) {
        const id = String(nextResultId++);
        let offset = 0;
        for (const group of state.messageGroups) {
          const start = offset;
          offset += group.delta.length;
          group.result = { id, start, end: offset };
          group.delta = "";
        }
        resultIds.set(lineNumber, id);
      }
      state.messageGroups.length = 0;
      state.active = null;
      return true;
    }
    if (type === "acp.error") stateFor(acp, correlationOf(event.sessionId, "acp:1")).active = null;
    return true;
  });

  for (const group of groups.values()) for (const line of group.lines.slice(1)) droppedLines.add(line);
  return { groups, resultIds, droppedLines };
}

function appendDelta(
  groups: Map<number, DeltaGroup>,
  state: DeltaState,
  input: {
    readonly provider: ProviderKind;
    readonly correlation: string;
    readonly itemType: TranscriptItemType;
    readonly lineNumber: number;
    readonly record: JsonRecord;
    readonly delta: string;
  },
): DeltaGroup {
  const recordAt = recordTime(input.record),
    active = state.active;
  if (active?.itemType === input.itemType) {
    active.lines.push(input.lineNumber);
    active.delta += input.delta;
    active.replayAt = recordAt ?? active.replayAt;
    return active;
  }
  const group: DeltaGroup = {
    provider: input.provider,
    correlation: input.correlation,
    itemType: input.itemType,
    firstLine: input.lineNumber,
    lines: [input.lineNumber],
    delta: input.delta,
    replayAt: recordAt,
  };
  groups.set(input.lineNumber, group);
  state.active = group;
  return group;
}

function writeCompactedArchive(
  file: string,
  descriptor: number,
  originalHeader: JsonRecord,
  plan: CompactionPlan,
): void {
  let output = "";
  const emit = (line: string): void => {
    output += `${line}\n`;
    if (output.length >= writeChunkChars) flush();
  };
  const flush = (): void => {
    if (!output) return;
    writeAllSync(descriptor, Buffer.from(output, "utf8"));
    output = "";
  };
  forEachLine(file, (line, lineNumber) => {
    if (plan.droppedLines.has(lineNumber)) return true;
    if (lineNumber === 0) {
      emit(JSON.stringify({ ...originalHeader, transcriptCompactionVersion: compactionVersion }));
      return true;
    }
    if (!line) {
      emit(line);
      return true;
    }
    const group = plan.groups.get(lineNumber),
      resultId = plan.resultIds.get(lineNumber);
    if (!group && !resultId) {
      emit(line);
      return true;
    }
    const record = parseRecord(line, lineNumber);
    if (group && (group.lines.length > 1 || group.result)) rewriteDeltaRecord(record, group);
    if (resultId) record.transcriptCompactionResult = { schema: compactionSchema, id: resultId };
    emit(JSON.stringify(record));
    return true;
  });
  flush();
}

function rewriteDeltaRecord(record: JsonRecord, group: DeltaGroup): void {
  const event = objectOf(record.event);
  if (!event) throw new Error(`Provider delta at archive line ${group.firstLine + 1} has no event body.`);
  const placeholder = group.result !== undefined;
  if (group.provider === "zcode") {
    const payload = objectOf(event.payload);
    if (!payload) throw new Error(`ZCode delta at archive line ${group.firstLine + 1} has no payload.`);
    payload.delta = placeholder ? "" : group.delta;
  } else {
    const update = objectOf(event.update),
      content = objectOf(update?.content);
    if (!content) throw new Error(`ACP delta at archive line ${group.firstLine + 1} has no content.`);
    content.text = placeholder ? "" : group.delta;
  }
  if (group.replayAt) record.transcriptReplayAt = group.replayAt;
  if (group.result)
    record.transcriptCompactionSegment = {
      schema: compactionSchema,
      id: group.result.id,
      type: group.itemType,
      start: group.result.start,
      end: group.result.end,
    };
}

function readHeader(file: string): JsonRecord {
  const holder: { header: JsonRecord | null } = { header: null };
  forEachLine(file, (line, lineNumber) => {
    if (lineNumber > 0) return false;
    holder.header = parseRecord(line, lineNumber);
    return false;
  });
  const header = holder.header;
  if (!header || header.kind !== "dispatch" || header.schema !== "runtime-dispatch-stream/v1")
    throw new Error(`Dispatch archive ${file} has no valid stream header.`);
  return header;
}

function parseRecord(line: string, lineNumber: number): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Dispatch archive line ${lineNumber + 1} is invalid JSON: ${detail}`);
  }
  const record = objectOf(parsed);
  if (!record) throw new Error(`Dispatch archive line ${lineNumber + 1} is not a JSON object.`);
  return record;
}

function forEachLine(file: string, visit: (line: string, lineNumber: number) => boolean): void {
  withReadOnlyFile(file, (descriptor) => {
    const decoder = new StringDecoder("utf8"),
      buffer = Buffer.allocUnsafe(readChunkBytes);
    let pending = "",
      lineNumber = 0,
      shouldContinue = true;
    while (shouldContinue) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let start = 0,
        newline = pending.indexOf("\n", start);
      while (newline >= 0) {
        const line = pending.slice(start, newline).replace(/\r$/u, "");
        shouldContinue = visit(line, lineNumber++);
        if (!shouldContinue) break;
        start = newline + 1;
        newline = pending.indexOf("\n", start);
      }
      pending = pending.slice(start);
    }
    if (shouldContinue) {
      pending += decoder.end();
      if (pending.length > 0) visit(pending.replace(/\r$/u, ""), lineNumber);
    }
  });
}

function writeAllSync(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
}

function stateFor(states: Map<string, DeltaState>, key: string): DeltaState {
  const existing = states.get(key);
  if (existing) return existing;
  const created: DeltaState = { active: null, messageGroups: [] };
  states.set(key, created);
  return created;
}

function clearActive(states: Map<string, DeltaState>): void {
  for (const state of states.values()) state.active = null;
}

function objectOf(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function correlationOf(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function recordTime(record: JsonRecord): string | null {
  return stringOf(record.occurredAt) ?? stringOf(record.at);
}
