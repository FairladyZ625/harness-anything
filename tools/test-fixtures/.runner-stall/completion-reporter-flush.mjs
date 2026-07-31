import completionReporter from "../../node-test-completion-reporter.mjs";

const recordCount = 20_000;
const counts = {
  tests: 1,
  failed: 0,
  passed: 1,
  cancelled: 0,
  skipped: 0,
  todo: 0
};

async function* summaries() {
  for (let index = 0; index < recordCount; index += 1) {
    yield {
      type: "test:summary",
      data: {
        file: `/repo/tools/flush-${index}.test.mjs`,
        success: true,
        counts
      }
    };
  }
  yield {
    type: "test:summary",
    data: {
      success: true,
      counts: {
        ...counts,
        tests: recordCount,
        passed: recordCount
      }
    }
  };
}

for await (const _chunk of completionReporter(summaries())) {
  // Drain the spec output; this fixture only asserts the fd 3 proof stream.
}
process.exit(0);
