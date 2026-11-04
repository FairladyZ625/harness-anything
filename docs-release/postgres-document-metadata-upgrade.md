# PostgreSQL projection read-index expansion

This release retains projection generation **5**. Previous binaries continue to read the
original `value` and write their original columns. Current binaries write the additional
`document_metadata` column in the same row and transaction. Scalar-index backfills do not
rewrite canonical events or switch the projection generation. The same generation also adds runtime read indexes **v2** and event
read indexes **v4**. External PostgreSQL does not backfill these automatically: ordinary
reader startup and `TaskProjection.catchUp` do not run the two management SQL functions.
Complete every phase below before switching readers. PGlite commits the same bounded
SQL batches during its schema-owner initialization.

The schema-owner connection, transaction-local claims and release workflow here are the
existing migration path; no ad-hoc repair script or canonical attach conversion is needed.

1. As the existing schema owner, run `ensurePgProjectionSchema` before deploying current
   readers. It adds document metadata, scalar read columns, binding tables, indexes and
   shared materialization triggers. It does **not** backfill or change the generation. Keep this
   DDL transaction short: it acquires a table schema lock, so run it outside a replay or
   other long transaction. Runtime logins do not perform DDL.
2. Backfill each tenant/project/policy-epoch scope using the existing management connection
   and transaction-local RLS claims (`ha.tenant_id`, `ha.project_id`, `ha.policy_epoch`).
   Start with empty cursor strings. Run one call per transaction and commit before saving
   its returned cursor:

   ```sql
   SELECT * FROM ha_backfill_document_metadata(
     'tenant-id', 'project-id', 1, '', ''
   );
   ```

   Pass `next_owner` and `next_entity` to the next call. Each call locks at most 64 document
   rows and only fills missing metadata. `processed = 0` is the terminal signal; the last
   nonempty cursor alone does not mean completion. The primary-key cursor advances once
   through the scope, including already filled rows. Save only committed cursors; after
   interruption, resume from that cursor or restart from empty strings. Concurrent previous
   writes maintain metadata through the trigger, including inserts behind the cursor.

3. Backfill runtime/pin/interval/fact-edge metadata for each tenant/project/policy epoch.
   Use the same management connection and claims, one call per transaction:

   ```sql
   BEGIN;
   SET LOCAL ROLE ha_schema_owner;
   SELECT set_config('ha.tenant_id', 'tenant-id', true),
          set_config('ha.project_id', 'project-id', true),
          set_config('ha.policy_epoch', '1', true);
   SELECT ha_backfill_projection_read_indexes('tenant-id', 'project-id', 1) AS processed;
   COMMIT;
   ```

   Use the schema-owner role name already configured for this deployment. Each call takes
   at most 64 pending rows, updates their scalar fields and runtime task bindings in the
   same transaction, and advances their version (runtime to 2, the other models to 1).
   Repeat until a **committed** call returns `processed=0`. No client cursor is needed:
   the partial pending index is the durable remainder. On interruption or transaction
   rollback, repeat the same call; committed rows are skipped and rolled-back rows remain
   pending. Do not wrap the loop in one transaction or infer completion from a short batch.

4. For **each repo in that scope**, run the event expansion after phase 3, so event session
   presence/outcome flags see the populated runtime index:

   ```sql
   BEGIN;
   SET LOCAL ROLE ha_schema_owner;
   SELECT set_config('ha.tenant_id', 'tenant-id', true),
          set_config('ha.project_id', 'project-id', true),
          set_config('ha.policy_epoch', '1', true);
   SELECT ha_backfill_event_read_indexes('tenant-id', 'project-id', 1, 'repo-id') AS processed;
   COMMIT;
   ```

   Again commit each <=64-row call and repeat to a committed `processed=0`. All old event
   rows, including non-runtime schemas, must reach version 4. Resume by repeating the
   function. Preserve tenant/project/policy-epoch **and repo** identity; do not merge scopes.

5. Verify readiness on the same claims before enabling current readers. Both probes must
   return no rows (use the actual deployment identifiers):

   ```sql
   SELECT 1 FROM ha_projection_values
   WHERE tenant_id='tenant-id' AND project_id='project-id' AND policy_epoch=1
     AND ((model='runtime-session' AND read_index_version<2)
       OR (model IN ('pin','lease-interval','relation-write') AND read_index_version=0))
   LIMIT 1;
   SELECT 1 FROM ha_events
   WHERE tenant_id='tenant-id' AND project_id='project-id' AND policy_epoch=1 AND repo_id='repo-id'
     AND read_index_version<4 LIMIT 1;
   ```

   Document metadata must also be complete as in phase 2. Finish the current declaration
   index using the existing management `backfillPgEntityDeclarationPage(pool, scope, repoId,
64)` entry, or the ordinary projection `catchUpAsync` facade, only after the canonical
   projection watermark equals its ledger head. It commits each <=64-event page under the
   repo-head fence; stop when its returned `watermark===sourceRevision`. It does not replace
   phases 3/4. A canonical gap must be rebuilt through the existing projection rebuild
   entry before declaration catch-up; never promote the declaration watermark by SQL.

6. Switch readers after every scope and repo is complete. During a partially filled snapshot,
   current document lists return `projection_pending` instead of a partial list or reading
   bodies; runtime/event reads likewise return `projection_pending` until their own expansion
   is complete. A ready projection generation alone does not certify these extensions.
   Previous readers and writers stay usable throughout. Rollback to the previous
   binary leaves the additive column and trigger in place; keep both through the window.

Read-index triggers are the **shared materialization path for current and previous writers**,
including inserts and updates during backfill. Runtime presence updates touch that session's
own dispatches; these triggers must remain installed on the serving schema. Replay/audit
management schemas own separate event tables and must never replace serving-schema triggers.
The rollout is additive and repeatable; a previous-binary rollback keeps these columns,
indexes and triggers. The current/previous binary support window ends **2026-11-18**.
Retiring previous binaries does not authorize dropping the shared read-index triggers:
current writes still use them. Only the document-only temporary objects below have a
contract-phase removal procedure. DDL lock duration under production load is unverified;
use the deployment's existing schema-owner release window and lock-timeout policy, never
a long replay transaction.

The backfill visits O(D) document rows and scans each missing body-containing serialization
once. Each transaction holds at most 64 row locks; it does not lock a full scope or keep
an unbounded queue. Body size still determines the cost of one legacy write/backfill row.
Current list reads transfer and parse metadata only. The temporary extractor removes the
flat canonical DocumentState `body` field as serialized text: PostgreSQL JSON operators
cannot process its legal NUL and unpaired-surrogate escapes. Other fields retain their
original bytes.

**Document-only contract date: 2026-11-18.** Retire previous binaries by this date, verify all scopes have
zero missing document metadata, then remove the temporary trigger, extractor and batch
function in a short schema-owner transaction:

```sql
DROP TRIGGER ha_document_metadata_previous_writer ON ha_projection_values;
DROP FUNCTION ha_document_metadata_previous_writer();
DROP FUNCTION ha_backfill_document_metadata(text,text,bigint,text,text);
DROP FUNCTION ha_document_metadata_from_value(text);
```

Remove their DDL from `pg-document-metadata-migration.ts` and the embedded PGlite startup
backfill loop in that contract release, retaining the column expansion for fresh installs.
PGlite owns its schema and commits the same bounded batches before exposing an opened scope;
external PostgreSQL uses the management sequence above. Current writes and reads already work without
these temporary objects; the upgrade test exercises this contract phase. Do not remove
the original `value` document representation during the previous-binary window.
