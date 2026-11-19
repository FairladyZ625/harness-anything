import type { StatusVocabulary, StatusWordRegistration } from "./status-vocabulary.ts";
import { inboxItemStatuses, inboxQueueStatuses, type InboxItemStatus } from "./inbox.ts";

const meanings: Readonly<Record<InboxItemStatus, string>> = {
  pending: "The wakeup is durable and waits for the single automatic consumer to claim it.",
  quarantined_external: "External input is recorded only; it never wakes a runtime until host isolation exists.",
  claimed: "One consumer holds the wakeup under a claim id until its lease expires.",
  completed: "The claimed wakeup started its run; the item is settled.",
  failed: "The claimed wakeup could not start (for example, admission refused it); the item is settled.",
  dropped_stale: "The source epoch was superseded, the source retired, or the target ended; nothing was woken.",
};

/** Inbox item vocabulary (dec_7CE3162BF9BFB157DAB9F9B6C0 CH1); one meaning per word. */
export const inboxStatusWordRegister: readonly StatusWordRegistration[] = inboxItemStatuses.map((word) => ({
  word,
  entity: "Inbox" as const,
  field: "item status",
  meaning: meanings[word],
  divergence: "entity-scoped" as const,
}));

export const inboxStatusVocabularies: readonly StatusVocabulary[] = [
  {
    id: "inbox.item-status",
    entity: "Inbox",
    field: "item status",
    module: "packages/kernel/src/domain/inbox.ts",
    anchor: "inboxItemStatuses",
    words: inboxItemStatuses,
  },
  {
    id: "inbox.queue-status",
    entity: "Inbox",
    field: "item status",
    module: "packages/kernel/src/domain/inbox.ts",
    anchor: "inboxQueueStatuses",
    words: inboxQueueStatuses,
    subsetOf: "inbox.item-status",
  },
];
