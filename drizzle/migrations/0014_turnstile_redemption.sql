CREATE TABLE turnstile_redemption (
  token_hash TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_turnstile_redemption_expires_at ON turnstile_redemption (expires_at);
