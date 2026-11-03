// The spec reporter prints a failing test's name inline but writes the error and stack only in
// the "failing tests" recap it emits after every file finishes. `run-node-tests.mjs` kills the
// whole run when one file never exits, so that recap — the only assertion text a red CI lane
// shows — is lost exactly when it is needed. Stream each failure at test:fail instead: the bytes
// are already in the log by the time the watchdog fires.
export default async function* reportTestFailures(source) {
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const data = event?.data;
    if (data === undefined || data === null) continue;
    // Node wraps an assertion in an ERR_TEST_FAILURE whose cause is the error the test actually
    // threw; the wrapper's stack points at the test runner, not at the assertion.
    const original = data.details?.error;
    // A failed subtest bubbles a bare "test failed" into its parent. The subtest already carried
    // the real error, so keep the parent line out of the log.
    if (original?.message === "test failed" && original?.cause == null) continue;
    // Only unwrap the runner's own failure wrapper. Following an arbitrary Error.cause chain can
    // end at a primitive (new Error("outer", { cause: "root" })) and throw away the outer stack,
    // which is exactly the diagnostic this reporter exists to keep. Stop at the last Error that
    // can still render.
    let error = original;
    while (isTestFailureWrapper(error) && isRenderable(error.cause)) error = error.cause;
    if (!isRenderable(error) && isRenderable(original)) error = original;
    if (!isRenderable(error)) continue;
    const stack = typeof error.stack === "string" ? error.stack : undefined;
    const message = typeof error.message === "string" ? error.message : undefined;
    const name = typeof data.name === "string" ? data.name : "<unnamed test>";
    const file = typeof data.file === "string" ? data.file.replaceAll("\\", "/") : undefined;
    yield `[test-failure] ${file === undefined ? name : `${file}: ${name}`}\n${indent(stack ?? message)}\n`;
  }
}

function isRenderable(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    (typeof value.stack === "string" || typeof value.message === "string")
  );
}

function isTestFailureWrapper(value) {
  if (value === null || typeof value !== "object") return false;
  // Node's test runner sets ERR_TEST_FAILURE on both the assertion wrapper and the parent
  // subtest wrapper; older shapes only carry the "test failed" message plus the child cause.
  return value.code === "ERR_TEST_FAILURE" || (value.message === "test failed" && isRenderable(value.cause));
}

function indent(text) {
  return String(text)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
