export const eventStoreEvidence = Object.freeze([
  "before_event_write",
  "after_event_write",
  "after_head_write",
  "after_git_commit",
  "advances canonical and authored refs to one SHA while preserving index, prose, and every unrelated dirty path byte",
  "independent of 100 versus 10,000-event history"
]);

export function missingEventStoreEvidence(storeTest, daemonTest) {
  return eventStoreEvidence.filter((evidence) => !storeTest.includes(evidence) && !daemonTest.includes(evidence));
}
