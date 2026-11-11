import { readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { withReadOnlyFile } from "../../storage/src/durable-file.ts";

const readChunkBytes = 64 * 1024;

/** Visit JSONL units without retaining the transcript; false stops the reader.
 * A selector may discard a line as soon as its prefix identifies an unwanted kind;
 * undefined keeps reading the prefix. Selected lines have no diagnostic byte cap. */
export function visitDispatchStreamLines(
  file: string,
  visit: (line: string, lineNumber: number) => boolean,
  select?: (prefix: string) => boolean | undefined,
): void {
  withReadOnlyFile(file, (descriptor) => {
    const decoder = new StringDecoder("utf8"),
      buffer = Buffer.allocUnsafe(readChunkBytes);
    let fragments: string[] = [],
      selected: boolean | undefined = select ? undefined : true,
      lineNumber = 0,
      shouldContinue = true;
    const consume = (part: string, complete: boolean): void => {
      if (selected !== false) {
        fragments.push(part);
        if (selected === undefined) selected = select!(fragments.join(""));
      }
      if (!complete) return;
      if (selected !== false) shouldContinue = visit(fragments.join("").replace(/\r$/u, ""), lineNumber);
      lineNumber += 1;
      fragments = [];
      selected = select ? undefined : true;
    };
    while (shouldContinue) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = decoder.write(buffer.subarray(0, bytesRead));
      let start = 0,
        newline = chunk.indexOf("\n");
      while (newline >= 0) {
        consume(chunk.slice(start, newline), true);
        if (!shouldContinue) break;
        start = newline + 1;
        newline = chunk.indexOf("\n", start);
      }
      if (shouldContinue) consume(chunk.slice(start), false);
    }
    if (shouldContinue) {
      consume(decoder.end(), false);
      if (fragments.some((part) => part.length > 0)) consume("", true);
    }
  });
}
