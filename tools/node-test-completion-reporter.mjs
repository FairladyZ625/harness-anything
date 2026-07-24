import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { spec } from "node:test/reporters";

/**
 * Preserves Node's ordinary spec output while recording the child-side summary
 * that arrives after every test and hook in one isolated file has completed.
 * The outer file result is deliberately not a completion marker: Node only
 * creates it after the isolation process exits.
 */
export default async function* completionReporter(source) {
  const completionStream = createWriteStream(null, { fd: 3, autoClose: false });
  const formatted = Readable.from(recordCompletionEvents(source, completionStream)).pipe(new spec());
  try {
    for await (const chunk of formatted) yield chunk;
  } finally {
    completionStream.end();
  }
}

async function* recordCompletionEvents(source, completionStream) {
  for await (const event of source) {
    if (event.type === "test:summary" && typeof event.data?.file === "string") {
      record(completionStream, {
        type: "test-file-summary",
        file: event.data.file,
        success: event.data.success,
        counts: event.data.counts
      });
    } else if (event.type === "test:fail" && typeof event.data?.file === "string") {
      record(completionStream, {
        type: "test-failure",
        file: event.data.file,
        name: event.data.name,
        signal: event.data.details?.error?.signal ?? null
      });
    } else if (event.type === "test:summary" && event.data?.file === undefined) {
      record(completionStream, {
        type: "test-run-summary",
        success: event.data.success,
        counts: event.data.counts
      });
    }
    yield event;
  }
}

function record(completionStream, value) {
  completionStream.write(`${JSON.stringify(value)}\n`);
}
