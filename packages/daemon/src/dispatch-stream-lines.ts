import { readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { withReadOnlyFile } from "../../storage/src/durable-file.ts";

const readChunkBytes = 64 * 1024;

/** Visit complete JSONL units without retaining the transcript; false stops the reader. */
export function visitDispatchStreamLines(file: string, visit: (line: string, lineNumber: number) => boolean): void {
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
