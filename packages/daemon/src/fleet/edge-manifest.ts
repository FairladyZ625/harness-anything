import { replicaManifestDigest } from "@harness-anything/kernel";
import { readFileWindow } from "../durable-file.ts";
import { StringDecoder } from "node:string_decoder";
import type { FleetCut, FleetEntry } from "./contract.ts";

export interface EdgeManifestHeader {
  readonly cut: FleetCut;
  readonly schemaGeneration: number;
  readonly manifestDigest: string;
}

/** Same JSON format and digest, without a second array or a whole-manifest string. */
export function* serializeEdgeManifest(header: EdgeManifestHeader, entries: readonly FleetEntry[]): Generator<string> {
  yield `${JSON.stringify(header).slice(0, -1)},"entries":[`;
  for (let offset = 0; offset < entries.length; offset += 128)
    yield `${offset ? "," : ""}${entries
      .slice(offset, offset + 128)
      .map((entry) => JSON.stringify(entry))
      .join(",")}`;
  yield "]}";
}

/** Caller owns canonical localeCompare ordering, as in fleetManifestDigest. */
export function orderedEdgeManifestDigest(entries: Iterable<FleetEntry>): string {
  return replicaManifestDigest(entries);
}

/** Read one JSON value at a time, including manifests written by the existing JSON writer. */
export function* readEdgeManifestEntries(file: string, header: Record<string, unknown> = {}): Generator<FleetEntry> {
  const decoder = new StringDecoder("utf8");
  let offset = 0,
    hasEntries = false;
  let text = "",
    cursor = 0,
    ended = false;
  const peek = (): string => {
    if (cursor === text.length && !ended) {
      const buffer = readFileWindow(file, offset, 64 * 1024),
        size = buffer.length;
      offset += size;
      text = size ? decoder.write(buffer) : decoder.end();
      cursor = 0;
      ended = size === 0;
      if (!text && !ended) return peek();
    }
    return text[cursor] ?? "";
  };
  const space = () => {
    while (/[ \t\r\n]/u.test(peek()) && peek()) cursor++;
  };
  const expect = (token: string) => {
    space();
    if (peek() !== token) throw new Error("invalid edge manifest JSON");
    cursor++;
  };
  const value = (): unknown => {
    space();
    let raw = "",
      depth = 0,
      quoted = false,
      escaped = false;
    for (;;) {
      const char = peek();
      if (
        !char ||
        (!quoted && depth === 0 && (char === "," || char === "]" || char === "}" || /[ \t\r\n]/u.test(char)))
      )
        break;
      raw += char;
      cursor++;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
      if (!quoted && depth === 0 && (char === '"' || char === "}" || char === "]")) break;
    }
    return JSON.parse(raw) as unknown;
  };
  {
    expect("{");
    space();
    while (peek() !== "}") {
      const key = value();
      if (typeof key !== "string") throw new Error("invalid edge manifest key");
      expect(":");
      if (key === "entries") {
        if (hasEntries) throw new Error("invalid edge manifest duplicate entries");
        hasEntries = true;
        expect("[");
        space();
        while (peek() !== "]") {
          yield value() as FleetEntry;
          space();
          if (peek() === "]") break;
          expect(",");
          space();
          if (peek() === "]") throw new Error("invalid edge manifest trailing comma");
        }
        expect("]");
      } else header[key] = value();
      space();
      if (peek() === "}") break;
      expect(",");
      space();
      if (peek() === "}") throw new Error("invalid edge manifest trailing comma");
    }
    expect("}");
    space();
    if (peek()) throw new Error("invalid edge manifest trailing data");
    if (!hasEntries) throw new Error("invalid edge manifest missing entries");
  }
}

export function readEdgeManifestHeader(file: string): EdgeManifestHeader {
  const header: Record<string, unknown> = {};
  for (const entry of readEdgeManifestEntries(file, header)) void entry;
  return header as unknown as EdgeManifestHeader;
}
