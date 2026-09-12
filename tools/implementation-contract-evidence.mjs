export const eventStoreEvidence = Object.freeze([
  "before_event_write",
  "after_event_write",
  "after_head_write",
  "after_git_commit",
]);

export function missingEventStoreEvidence(storeTest, daemonTest) {
  return eventStoreEvidence.filter((evidence) => !storeTest.includes(evidence) && !daemonTest.includes(evidence));
}

export function hasContractEvidence(text, id) {
  const declarations = text.matchAll(/^\s*\/\/ harness-contract: ([a-z0-9.-]+)\r?\n\s*test\s*\(/gm);
  return Array.from(declarations).some((match) => match[1] === id);
}
