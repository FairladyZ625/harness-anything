# Back up and restore a ledger

Run backups from the repository root. For a registered local repository, the daemon takes the
backup in its write queue, so the command works from a sandboxed agent session that cannot open the
ledger itself. For an unregistered root, the daemon takes the backup directly because it has no
writer for that ledger. A backup is a directory containing an integrity-checked manifest and a
consistent SQLite snapshot; choose a new absolute destination outside `.harness/` and `harness/`.

```sh
ha backup /Volumes/offsite/harness-backup-2026-09-15
```

The manifest records the repository ID, mode, connection, display name, authored branch, and
writer epoch alongside the digest and size of every retained file. Keep the whole backup directory.
A backup taken from an unregistered root has no registration; the restore receipt then leaves the
repository ID for you to supply to `ha init`.

Exercise the backup without changing the live repository:

```sh
ha restore --drill /Volumes/offsite/harness-backup-2026-09-15
```

The drill verifies the file inventory and digests, opens each SQLite snapshot read-only, checks its
integrity and event chain, and restores only below the repository's `.harness/restore-drills`
directory.

For a real restore, choose an absolute destination that does not exist:

```sh
ha restore /Volumes/offsite/harness-backup-2026-09-15 --to /srv/restored-project
```

The restore verifies before and after copying and advances the saved repository's writer-epoch
floor in the selected Harness user root. It never overwrites an existing destination. If an old
registration for the same repository ID remains, run `ha repo unbind <repoId>` first. Then use
the `repoId` printed in the restore receipt to bind and verify the restored repository:

```sh
cd /srv/restored-project
ha init --repo-id <repoId> --person-id <owner-person-id> --display-name <owner-display-name>
ha task show <known-task-id>
ha fact search <known-query>
```

Use the registry metadata printed in the receipt when the original repository used a non-local
mode or named connection. Do not copy a live `ledger.sqlite` file manually: `ha backup` uses
SQLite's snapshot operation while the daemon may still be accepting writes.

To permanently remove every local Harness record for a repository, let the daemon create and
exercise a fresh backup before it deletes anything:

```sh
ha repo purge <repoId> --scope all \
  --backup /Volumes/offsite/harness-final-backup \
  --confirm <repoId>
```

The confirmation must exactly match the repository ID. The backup destination must be absolute,
must not exist, and must not be inside the repository's `.harness/` or `harness/` directory. The
command refuses while work is in flight. It then creates the backup, runs a restore drill, unbinds
the repository, removes `.harness/` and `harness/`, and removes the two Harness rules added to the
project `.gitignore`. Project files, worktrees, and Git history remain in place. A failed backup or
drill leaves the registered repository and its data untouched.

The receipt prints the backup directory and the corresponding `ha restore <backup> --to <dir>` and
`ha init --repo-id <repoId>` commands. The writer-epoch history remains as a fencing tombstone, so
restoring and binding the repository cannot reuse an earlier writer epoch.
