# The projection: canonical SQLite events to a read cache

Generation 1 has two distinct SQLite roles. `store/generations/1/ledger.sqlite`
is the canonical accepting database. The task projection is a derived read cache.
Only the cache can be discarded and rebuilt without losing accepted commands.

`makeTaskProjection` consumes the canonical store's bounded event batches and
required content objects. A catch-up advances a complete projection watermark;
a cold rebuild replays the same accepted history. Readers observe an installed
projection cut rather than partially applied rows.

The projection serves task lifecycle, decisions, facts, relations, session,
execution, review, declarations, and authorization reads. Its watermark measures
how far it has applied the accepting ledger. A committed command may be durable
while its projection facet remains pending. Receipt waits compare repository,
generation, revision, and the same-revision digest before claiming visibility.

Use `ha daemon projection rebuild` for a corrupt or missing read projection.
Preserve the canonical database and `objects/sha256/` throughout the rebuild.
Rebuilding from authored Markdown or Git alone would omit accepted commands whose
Git publication has not completed.

For a cutover check, perform two cold rebuilds against a fixed accepted cut and
compare their outputs. Independent ledger reconciliation also checks the immutable
import prefix, ledger metadata, row digests, command outcomes, required objects,
and actual Git follower read-back. Comparing two readers of the same database is
not a proof that the import preserved its source.
