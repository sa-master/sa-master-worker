import { json, error } from "../lib/json.js";
import { statusLabel } from "../lib/statuses.js";
import { str, num, dateStr } from "../lib/validate.js";

const ALLOWED_PATCH_FIELDS = new Set([
  "notes",
  "planned_start_date",
  "estimated_value",
  "actual_value",
  "completed_at",
]);

export async function handleGetObject(request, env, headers, params) {
  const [objectCode] = params;

  const objectData = await env.DB.prepare(`
    SELECT
      o.*,
      c.id    AS client_id,
      c.name  AS client_name,
      c.phone AS client_phone
    FROM objects o
    LEFT JOIN clients c ON c.id = o.client_id
    WHERE o.object_code = ?
    LIMIT 1
  `).bind(objectCode).first();

  if (!objectData) return error("Об'єкт не знайдено", headers, 404);

  const requests = await env.DB.prepare(`
    SELECT
      id, request_code, type, type_label, name, phone,
      location, timing, project, consultation_date,
      source, status, created_at, updated_at
    FROM requests WHERE object_id = ? ORDER BY id DESC
  `).bind(objectData.id).all();

  const events = await env.DB.prepare(`
    SELECT id, request_id, object_id, event_type, content, author_type, author_id, created_at
    FROM events WHERE object_id = ? ORDER BY id ASC
  `).bind(objectData.id).all();

  return json(
    {
      ok: true,
      object: { ...objectData, status_label: statusLabel(objectData.status) },
      client: objectData.client_id
        ? { id: objectData.client_id, name: objectData.client_name, phone: objectData.client_phone }
        : null,
      requests: (requests.results || []).map((r) => ({
        ...r, status_label: statusLabel(r.status),
      })),
      events: events.results || [],
    },
    headers
  );
}

export async function handleUpdateObject(request, env, headers, params) {
  const [objectCode] = params;

  let body;
  try { body = await request.json(); }
  catch { return error("Некоректний JSON", headers, 400); }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return error("Некоректні дані", headers, 400);
  }

  const current = await env.DB.prepare(
    `SELECT id FROM objects WHERE object_code = ? LIMIT 1`
  ).bind(objectCode).first();

  if (!current) return error("Об'єкт не знайдено", headers, 404);

  const fields = [], values = [], changed = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (has("notes")) {
    const v = body.notes === null ? null : str(body.notes, { max: 2000 });
    fields.push("notes = ?"); values.push(v || null); changed.push("notes");
  }
  if (has("planned_start_date")) {
    const v = body.planned_start_date === null ? null : dateStr(body.planned_start_date);
    if (v === null && body.planned_start_date !== null) {
      return error("Некоректний planned_start_date", headers, 400);
    }
    fields.push("planned_start_date = ?"); values.push(v); changed.push("planned_start_date");
  }
  if (has("estimated_value")) {
    const v = num(body.estimated_value, { min: 0, max: 1e9 });
    if (v === null && body.estimated_value !== null && body.estimated_value !== "") {
      return error("Некоректний estimated_value", headers, 400);
    }
    fields.push("estimated_value = ?"); values.push(v ?? null); changed.push("estimated_value");
  }
  if (has("actual_value")) {
    const v = num(body.actual_value, { min: 0, max: 1e9 });
    if (v === null && body.actual_value !== null && body.actual_value !== "") {
      return error("Некоректний actual_value", headers, 400);
    }
    fields.push("actual_value = ?"); values.push(v ?? null); changed.push("actual_value");
  }
  if (has("completed_at")) {
    const v = body.completed_at === null ? null : dateStr(body.completed_at);
    if (v === null && body.completed_at !== null) {
      return error("Некоректний completed_at", headers, 400);
    }
    fields.push("completed_at = ?"); values.push(v); changed.push("completed_at");
  }

  if (!fields.length) return error("Немає даних для оновлення", headers, 400);

  const invalid = changed.find((f) => !ALLOWED_PATCH_FIELDS.has(f));
  if (invalid) return error("Заборонене поле: " + invalid, headers, 400);

  fields.push("updated_at = CURRENT_TIMESTAMP");

  await env.DB.batch([
    env.DB.prepare(`UPDATE objects SET ${fields.join(", ")} WHERE id = ?`)
      .bind(...values, current.id),
    env.DB.prepare(`
      INSERT INTO events (object_id, request_id, event_type, content, author_type)
      VALUES (?, NULL, 'object_updated', ?, 'system')
    `).bind(current.id, `Оновлено: ${changed.join(", ")}`),
  ]);

  const updated = await env.DB.prepare(`
    SELECT o.*, c.id AS client_id, c.name AS client_name, c.phone AS client_phone
    FROM objects o
    LEFT JOIN clients c ON c.id = o.client_id
    WHERE o.id = ?
    LIMIT 1
  `).bind(current.id).first();

  if (updated) updated.status_label = statusLabel(updated.status);

  return json(
    {
      ok: true,
      object: updated,
      event: { event_type: "object_updated", changed_fields: changed, author_type: "system" },
    },
    headers
  );
}
