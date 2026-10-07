CREATE TABLE sessions (
  token_hash CHAR(64) PRIMARY KEY,
  owner_id UUID NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE links (
  code VARCHAR(32) COLLATE "C" PRIMARY KEY,
  owner_id UUID NOT NULL,
  target_url TEXT NOT NULL CHECK (length(target_url) <= 2048),
  request_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  revoked_at BIGINT,
  CONSTRAINT links_idempotency_unique UNIQUE (owner_id, idempotency_key),
  CONSTRAINT links_expiry_check CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX links_owner_page_idx ON links (owner_id, created_at DESC, code DESC);
CREATE INDEX links_state_idx ON links (code) INCLUDE (expires_at, revoked_at);

CREATE TABLE click_daily (
  code VARCHAR(32) COLLATE "C" NOT NULL REFERENCES links(code),
  day VARCHAR(10) NOT NULL,
  clicks BIGINT NOT NULL CHECK (clicks >= 0),
  PRIMARY KEY (code, day)
);
