> SELECT current_timestamp AS now, (SELECT COUNT(*) FROM objects) AS objects_count, (SELECT COUNT(*) FROM clients) AS clients_count;
now	objects_count	clients_count
2026-09-12 00:28:38	1	1
