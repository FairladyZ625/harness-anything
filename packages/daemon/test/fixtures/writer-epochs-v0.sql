PRAGMA journal_mode=WAL;
CREATE TABLE writer_epoch_history (
  repo_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  PRIMARY KEY(repo_id, epoch)
) STRICT;
CREATE TABLE writer_epochs (
  repo_id TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL CHECK(length(holder_id) > 0),
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  version INTEGER NOT NULL CHECK(version > 0),
  issued_at TEXT NOT NULL
) STRICT;
INSERT INTO writer_epochs(repo_id, holder_id, epoch, version, issued_at)
VALUES ('repo-current', 'old', 42, 45, '2026-08-19T00:00:00.000Z');
INSERT INTO writer_epochs(repo_id, holder_id, epoch, version, issued_at)
VALUES ('repo-history', 'old', 8, 8, '2026-08-19T00:00:00.000Z');
INSERT INTO writer_epoch_history(repo_id, epoch) VALUES ('repo-current', 41);
INSERT INTO writer_epoch_history(repo_id, epoch) VALUES ('repo-history', 12);
INSERT INTO writer_epoch_history(repo_id, epoch) VALUES ('repo-retired', 31);
