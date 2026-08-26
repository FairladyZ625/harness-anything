const MERGIFY_QUEUE_BRANCH = /^mergify\/merge-queue\//u;
const MERGIFY_AUTHORS = new Set(["mergify[bot]", "app/mergify"]);

export function isMergifyQueueDraft({ headRefName = "", authorLogin = "" } = {}) {
  return MERGIFY_AUTHORS.has(authorLogin) && MERGIFY_QUEUE_BRANCH.test(headRefName);
}
