const testFilePattern = /\.(?:test|spec)\.(?:mjs|js|ts)$/u;

export default async function* reportTestFileActivity(source) {
  for await (const event of source) {
    const file = testFileName(event);
    if (file === null) continue;
    if (event.type === "test:dequeue") yield `${JSON.stringify({ state: "started", file, at: Date.now() })}\n`;
    if (event.type === "test:complete" || event.type === "test:fail") yield `${JSON.stringify({ state: "finished", file, at: Date.now() })}\n`;
  }
}

function testFileName(event) {
  const data = event?.data;
  if (data?.nesting !== 0 || data.line !== 1 || data.column !== 1 || typeof data.name !== "string" || !testFilePattern.test(data.name)) return null;
  return data.name.replaceAll("\\", "/");
}
