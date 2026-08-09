import { installPublicationReaderLeakDetector } from "./publication-reader-leak-detector.mjs";

// Node's process-isolated test child does not expose the outer runner's CLI
// envelope through process.execArgv. A directly owned no-isolation worker must
// preserve that inheritance contract or a test's ordinary fork() will start a
// second test runner instead of the requested child program.
const workerBootstrapUrl = import.meta.url;
const inheritedExecArgv = process.execArgv.filter((argument) =>
  argument !== "--test"
  && argument !== "--test-isolation=none"
  && argument !== "--test-force-exit"
  && argument !== "--report-on-signal"
  && argument !== "--report-exclude-env"
  && !argument.startsWith("--test-timeout=")
  && !argument.startsWith("--test-reporter=")
  && !argument.startsWith("--test-reporter-destination=")
  && !argument.startsWith("--report-signal=")
  && !argument.startsWith("--report-directory=")
  && argument !== `--import=${workerBootstrapUrl}`
);
process.execArgv.splice(0, process.execArgv.length, ...inheritedExecArgv);

// Set this only after Node has selected ordinary CLI test-runner mode. Passing
// it in spawn env would enter Node's private child IPC protocol; setting it in
// the preload preserves the logical test-child boundary consumed by product
// code and inherited CLI fixtures without changing runner transport.
process.env.NODE_TEST_CONTEXT = "child-v8";
installPublicationReaderLeakDetector();
