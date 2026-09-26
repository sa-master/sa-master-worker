ALTER TABLE requests ADD COLUMN estimate_token TEXT;
ALTER TABLE requests ADD COLUMN estimate_token_expires_at TEXT;

CREATE UNIQUE INDEX idx_requests_estimate_token
ON requests(estimate_token);
