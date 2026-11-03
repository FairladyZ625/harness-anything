# PostgreSQL document metadata expansion

This release retains projection generation **5**. Previous binaries continue to read the
original `value` and write their original columns. Current binaries write the additional
`document_metadata` column in the same row and transaction. No event replay or ledger
rewrite is required.

1. As the existing schema owner, run `ensurePgProjectionSchema` before deploying current
   readers. It adds a nullable text column without a default and installs the temporary
   previous-writer trigger. It does **not** backfill or change the generation. Keep this
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

3. Switch readers after every scope is complete. During a partially filled snapshot,
   current document lists return `projection_pending` instead of a partial list or reading
   bodies. Previous readers and writers stay usable throughout. Rollback to the previous
   binary leaves the additive column and trigger in place; keep both through the window.

The backfill visits O(D) document rows and decodes each missing body-containing serialization
once. Each transaction holds at most 64 row locks; it does not lock a full scope or keep
an unbounded queue. Body size still determines the cost of one legacy write/backfill row.
Current list reads transfer and parse metadata only. The temporary extractor removes the
flat canonical DocumentState `body` field as serialized text: PostgreSQL JSON operators
cannot process its legal NUL and unpaired-surrogate escapes. Other fields retain their
original bytes.

**Contract date: 2026-11-18.** Retire previous binaries by this date, verify all scopes have
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
