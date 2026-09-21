-- Послідовність для генерації request_code
CREATE TABLE IF NOT EXISTS sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sequences (name, value) VALUES ('request_2026', 0);

-- Унікальний індекс на телефон клієнта
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);

-- Індекси для швидких запитів
CREATE INDEX IF NOT EXISTS idx_requests_client_id ON requests(client_id);
CREATE INDEX IF NOT EXISTS idx_requests_object_id ON requests(object_id);
CREATE INDEX IF NOT EXISTS idx_events_object_id   ON events(object_id);
CREATE INDEX IF NOT EXISTS idx_events_request_id  ON events(request_id);
CREATE INDEX IF NOT EXISTS idx_files_object_id    ON files(object_id);
