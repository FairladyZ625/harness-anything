# Center relocation and break-glass promotion

This runbook covers a planned move from a personal laptop to a persistent server or cloud host, followed by the manual disaster path when the old center cannot export a bundle.

## Before the move

- Confirm the target machine has the same repository registration, enough disk for the ledger, content objects, a staged promotion copy, and a reachable HTTPS listener.
- Confirm the old daemon and managed RBAC service are running. Confirm the target daemon has its managed RBAC service installed, running, and configured with a TLS listener whose hostname and port match the new login URL.
- Keep the center client secret and access-admin admission record in the protected backup channel. The center export/import commands carry the managed RBAC relocation package and access-admin journal through the daemon's local single-writer service.
- Record the current repository id, writer epoch, final revision, tip hash, TLS SPKI fingerprint, and replication history.
- Stop new writes at the old center through the normal drain path. Do not start a second center before the old center is retired.

## Planned M1–M3 move

1. Stage and export the center bundle.

   `ha fleet center export --root <old-repo> --bundle <bundle-dir> --repo <repo-id> --writer-epoch <old-epoch> --slots <old-fleet>/replication-slots.sqlite --user-root <old-user> --json`

2. Retire the old center after the edge acknowledgements and save the returned `tipHash`, URLs, and SPKI fingerprint.

   `ha fleet center retire --repo <repo-id> --old-epoch <old-epoch> --final-revision <revision> --tip-hash <tip-hash> --new-external-url <https-url> --new-login-url <login-url> --spki-sha256 <sha256> --user-root <old-user> --json`

3. Import into the new directory and rebind the login and external URLs.

   `ha fleet center import --bundle <bundle-dir> --destination <new-repo> --repo <repo-id> --external-url <https-url> --login-url <login-url> --expected-final-revision <revision> --expected-tip-hash <tip-hash> --state-root <new-fleet> --user-root <new-user> --json`

4. On every edge, run the explicit repoint command with the new host, port, CA, and SPKI fingerprint. The daemon verifies the new epoch and resumes from its durable position.

   `ha daemon fleet edge repoint --root <edge-repo> --repo <repo-id> --host <new-host> --port <new-port> --ca <new-ca-cert> --spki-sha256 <new-spki> --servername <tls-name> --timeout-ms 60000 --json`

## Planned move verification

- Check the export manifest includes the ledger cut, replication slots, content objects, and `rbac/manifest.json` when the old provider is managed Keycloak. The RBAC package carries the center client secret and access-admin journal.
- Check the import receipt preserves `finalRevision` and `tipHash`, advances `writerEpoch`, and reports the requested external and login URLs.
- On each repointed edge, check `basebackup: false`, the prior `lastAppliedRevision`, the new writer epoch, and a replica sequence that reaches the new center head. Make an authenticated edge write before removing the old center's read-only backup.

## Planned move rollback

- Before old-center retirement, an export failure leaves the old center authoritative. Keep it in service, choose a fresh empty bundle path, and rerun after fixing the failed precondition.
- After old-center retirement, keep its ledger read-only. If target import or activation fails, preserve the verified bundle and edge replicas, correct the target RBAC listener or configuration, then import into a clean target directory. Do not restart the retired old center as a writer.
- Repoint edges only after the imported center reports the expected revision, tip hash, and advanced writer epoch. A failed lineage check leaves each edge configured to the old center and is retried after the target is corrected.

## M4 break-glass promotion

Use this only when the old center is physically unavailable and its bundle cannot be exported. The command is manual and has no timer or disconnect trigger.

1. Confirm the old center is physically unavailable and cannot resume writes. Stop the selected edge daemon so its receiver cannot install or collect a generation during promotion.
2. Check the daemon's `fleet-edge.json` for the expected `repoId`, `nodeId`, and `viewRoot`. Confirm the published generation is current and its durable revision matches the reported replica position. Record the observed tail-loss decision.
3. Confirm the RBAC backup state. Use `verified` only after the logical bundle or an equivalent credential recovery path is available. The command records this operator-supplied state and cannot verify a remote Keycloak backup itself.
4. Run the command with both confirmations. Missing either flag is rejected before the replica is opened.

   `ha daemon fleet center promote-from-edge --root <edge-repo> --repo <repo-id> --state-root <edge-fleet-state> --force-new-epoch --confirm-possible-tail-loss --rbac-backup-status <verified|unavailable|unknown> --json`

The CLI resolves the replica generation from `fleet-edge.json` and its `viewRoot/repos/<repo-id>/views/<node-id>/current.json` pointer. Storage verifies the pointer position against the ledger, checks the contiguous event prefix and content-object hashes, stages a copy into the edge workspace's canonical generation 3, advances the persistent writer epoch, claims the new writer lease, and rotates `replication_state.history` with sequence reset to zero. Any prior workspace generation 3 is retained under `.harness/store/retired/center-promote-from-edge/`; the receipt includes `displacedGenerationPath`. The command records `center_emergency_promoted` under `<edge-fleet-state>/governance/center-emergency-promoted/<repo-id>.json`.

## Verification and rollback

- Check the receipt fields `oldEpoch`, `newEpoch`, `finalRevision`, `tipHash`, `replicationHistory`, `rbacBackupStatus`, and `displacedGenerationPath`.
- Check that the audit JSON contains both confirmation markers and the same tip and epoch values.
- Restart the daemon, change the repository from `remote-edge` to `local` with `ha daemon repo update --repo-id <repo-id> --root <edge-repo> --mode local`, then start its center with `ha daemon fleet center start`. Repoint other edges explicitly and confirm their lineage witness before accepting writes.
- A failed preflight leaves both the replica and active workspace ledger unchanged. After a successful promotion, preserve the displaced ledger and old center read-only for forensics. Do not restore the old center as a writer. For a later recovery, promote a fresh edge replica or import a verified bundle.
