-- Requests retain this revision across all credential checks and writes.
CREATE TABLE auth_reset_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL
);
INSERT INTO auth_reset_revision (id, revision) VALUES (1, 0);
ALTER TABLE verification ADD COLUMN authUserId TEXT;
CREATE INDEX verification_authUserId_idx ON verification (authUserId);
CREATE TABLE auth_recovery_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actorId TEXT NOT NULL,
  targetId TEXT NOT NULL,
  outcome TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
