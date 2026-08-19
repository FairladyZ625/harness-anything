const testFilePattern = /\.(?:test|spec)\.(?:mjs|js|ts)$/u;

// File-level state answers "which file stalled". The watchdog also needs "where inside it", or a
// stall costs another CI round to localise: node's spec reporter holds a file's subtest output
// until that file completes, so a file that never completes prints nothing about itself.
export default async function* reportTestActivity(source) {
  for await (const event of source) {
    const file = testFileName(event);
    if (file !== null) {
      if (event.type === "test:dequeue") yield `${JSON.stringify({ state: "started", file, at: Date.now() })}\n`;
      if (event.type === "test:complete" || event.type === "test:fail") yield `${JSON.stringify({ state: "finished", file, at: Date.now() })}\n`;
      continue;
    }
    // test:start is emitted late (after the test completes), so it cannot name a test that never
    // returns. test:dequeue is the point a test begins running, which is exactly the one that hung.
    // A stalled file has two very different causes with the same symptom: a test that never
    // returns, or a file whose tests all finished and whose process will not exit. Counting entries
    // against completions tells the watchdog which one it is, and they need opposite fixes.
    if (event.type !== "test:dequeue" && event.type !== "test:pass" && event.type !== "test:fail") continue;
    const owner = subtestOwner(event);
    if (owner === null) continue;
    const state = event.type === "test:dequeue" ? "progress" : "test-finished";
    yield `${JSON.stringify({ state, file: owner, name: event.data.name, at: Date.now() })}\n`;
  }
}

function testFileName(event) {
  const data = event?.data;
  if (data?.nesting !== 0 || data.line !== 1 || data.column !== 1 || typeof data.name !== "string" || !testFilePattern.test(data.name)) return null;
  return data.name.replaceAll("\\", "/");
}

function subtestOwner(event) {
  const file = event?.data?.file;
  if (typeof file !== "string" || typeof event.data.name !== "string") return null;
  return file.replaceAll("\\", "/");
}
