import { json, error } from "../lib/json.js";
import { STATUS_LABELS, statusLabel, isValidStatus, withStatusLabel } from "../lib/statuses.js";
import { normalizePhone, isValidPhone } from "../lib/phone.js";
import { str } from "../lib/validate.js";
import { sendTelegram } from "../lib/telegram.js";

const CURRENT_YEAR = 2026;

export async function handleCreateRequest(request, env, headers) {
  let body;
  try { body = await request.json(); }
  catch { return error("Некоректний JSON", headers, 400); }

  const name  = str(body.name,  { max: 120, required: true });
  const phone = str(body.phone, { max: 40,  required: true });
  const type  = str(body.type,  { max: 40,  required: true });

  if (!name || !phone || !type) {
    return error("Необхідні ім'я, телефон та тип заявки", headers, 400);
  }
  if (!isValidPhone(phone)) {
    return error("Некоректний номер телефону", headers, 400);
  }

  const normalizedPhone = normalizePhone(phone);
  const typeLabel    = str(body.typeLabel,        { max: 80 })  || type;
  const location     = str(body.location,         { max: 300 });
  const timing       = str(body.timing,           { max: 100 });
  const project      = str(body.project,          { max: 200 });
  const consultation = str(body.consultationDate, { max: 100 });
  const source       = str(body.source,           { max: 80 })  || "SA-MASTER.PRO";

  let requestId, requestCode, clientId = null;

  try {
    const seq = await env.DB.prepare(`
      UPDATE sequences
      SET value = value + 1
      WHERE name = ?
      RETURNING value
    `).bind(`request_${CURRENT_YEAR}`).first();

    if (!seq || typeof seq.value !== "number") {
      return error("Не вдалося згенерувати код заявки", headers, 500);
    }
    requestCode = `SM-R-${CURRENT_YEAR}-${String(seq.value).padStart(3, "0")}`;

    const existingClient = await env.DB.prepare(
      `SELECT id FROM clients WHERE phone = ? LIMIT 1`
    ).bind(normalizedPhone).first();

    if (existingClient) {
      clientId = existingClient.id;
    } else {
      const ins = await env.DB.prepare(`
        INSERT INTO clients (name, phone) VALUES (?, ?)
      `).bind(name, normalizedPhone).run();
      clientId = ins.meta?.last_row_id || null;
    }

    const insertResult = await env.DB.prepare(`
      INSERT INTO requests (
        request_code, type, type_label, name, phone, location,
        timing, project, consultation_date, source, status, client_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
    `).bind(
      requestCode, type, typeLabel, name, normalizedPhone,
      location || null, timing || null, project || null,
      consultation || null, source, clientId
    ).run();

    if (!insertResult.meta?.last_row_id) {
      return error("Не вдалося створити заявку", headers, 500);
    }
    requestId = insertResult.meta.last_row_id;

    await env.DB.prepare(`
      INSERT INTO events (object_id, request_id, event_type, content, author_type)
      VALUES (NULL, ?, 'request_created', 'Створено заявку', 'system')
    `).bind(requestId).run();

  } catch (err) {
    console.error("Create request failed:", err);
    if (String(err?.message || "").includes("UNIQUE")) {
      return error("Конфлікт даних клієнта. Спробуйте ще раз.", headers, 409);
    }
    return error("Помилка створення заявки", headers, 500);
  }

  const telegramText = [
    "🏠 НОВА ЗАЯВКА",
    `🆔 ID: ${requestCode}`,
    `👤 Ім'я: ${name}`,
    `📞 Телефон: ${normalizedPhone}`,
    `🔧 Тип: ${typeLabel}`,
    `📍 Об'єкт: ${location || "—"}`,
    `📐 Дизайн-проєкт: ${project || "—"}`,
    `🗓 Початок: ${timing || "—"}`,
    `📅 Консультація: ${consultation || "—"}`,
    `🔗 Джерело: ${source}`,
    `📊 Статус: ${statusLabel("new")}`,
    `🕐 Час: ${new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" })}`,
  ].join("\n");

  await sendTelegram(env, telegramText);

  return json(
    {
      ok: true,
      request: {
        id: requestId,
        request_code: requestCode,
        client_id: clientId,
        status: "new",
        status_label: statusLabel("new"),
      },
    },
    headers
  );
}

export async function handleListRequests(request, env, headers, _params, url) {
  const limit  = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const result = await env.DB.prepare(`
    SELECT
      r.*,
      c.id    AS client_id,
      c.name  AS client_name,
      c.phone AS client_phone
    FROM requests r
    LEFT JOIN clients c ON c.id = r.client_id
    ORDER BY r.id DESC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  const requests = (result.results || []).map(withStatusLabel);
  return json({ ok: true, requests, limit, offset }, headers);
}

export async function handleGetRequest(request, env, headers, params) {
  const [requestCode] = params;

  const row = await env.DB.prepare(`
    SELECT
      r.*,
      c.name  AS client_name,
      c.phone AS client_phone,
      o.object_code,
      o.name    AS object_name,
      o.address AS object_address,
      o.status  AS object_status
    FROM requests r
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN objects o ON o.id = r.object_id
    WHERE r.request_code = ?
    LIMIT 1
  `).bind(requestCode).first();

  if (!row) return error("Заявку не знайдено", headers, 404);

  return json(
    {
      ok: true,
      request: {
        ...row,
        status_label: statusLabel(row.status),
        object_status_label: row.object_status ? statusLabel(row.object_status) : null,
      },
    },
    headers
  );
}

export async function handleUpdateStatus(request, env, headers, params) {
  const [requestCode] = params;

  let body;
  try { body = await request.json(); }
  catch { return error("Некоректний JSON", headers, 400); }

  const newStatus = String(body.status || "").trim();
  if (!isValidStatus(newStatus)) {
    return error("Невідомий статус", headers, 400, {
      allowed_statuses: Object.keys(STATUS_LABELS),
    });
  }

  const current = await env.DB.prepare(`
    SELECT id, request_code, status, object_id
    FROM requests
    WHERE request_code = ?
    LIMIT 1
  `).bind(requestCode).first();

  if (!current) return error("Заявку не знайдено", headers, 404);

  const oldStatus = current.status;
  if (oldStatus === newStatus) {
    return json({ ok: true, unchanged: true, status: newStatus }, headers);
  }

  const oldLabel = statusLabel(oldStatus);
  const newLabel = statusLabel(newStatus);
  const eventContent = `${oldLabel} → ${newLabel}`;

  const statements = [
    env.DB.prepare(`
      UPDATE requests
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(newStatus, current.id),
    env.DB.prepare(`
      INSERT INTO events (object_id, request_id, event_type, content, author_type)
      VALUES (?, ?, 'status_changed', ?, 'system')
    `).bind(current.object_id || null, current.id, eventContent),
  ];

  const syncObject = current.object_id && newStatus !== "cancelled";
  if (syncObject) {
    statements.push(
      env.DB.prepare(`
        UPDATE objects SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(newStatus, current.object_id),
      env.DB.prepare(`
        INSERT INTO events (object_id, request_id, event_type, content, author_type)
        VALUES (?, ?, 'object_status_changed', ?, 'system')
      `).bind(current.object_id, current.id, `Статус об'єкта → ${newLabel}`)
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (err) {
    console.error("Status update batch failed:", err);
    return error("Не вдалося оновити статус", headers, 500);
  }

  let object = null;
  if (current.object_id) {
    object = await env.DB.prepare(`
      SELECT id, object_code, name, status FROM objects WHERE id = ? LIMIT 1
    `).bind(current.object_id).first();
    if (object) {
      object.status_label = statusLabel(object.status);
      object.updated = syncObject;
    }
  }

  return json(
    {
      ok: true,
      request: {
        id: current.id,
        request_code: current.request_code,
        old_status: oldStatus,
        old_status_label: oldLabel,
        status: newStatus,
        status_label: newLabel,
      },
      object,
      event: { event_type: "status_changed", content: eventContent, author_type: "system" },
    },
    headers
  );
}

export async function handleGetEvents(request, env, headers, params) {
  const [requestCode] = params;

  const current = await env.DB.prepare(`
    SELECT id, request_code, status FROM requests WHERE request_code = ? LIMIT 1
  `).bind(requestCode).first();

  if (!current) return error("Заявку не знайдено", headers, 404);

  const events = await env.DB.prepare(`
    SELECT id, request_id, object_id, event_type, content, author_type, author_id, created_at
    FROM events WHERE request_id = ? ORDER BY id ASC
  `).bind(current.id).all();

  return json(
    {
      ok: true,
      request: {
        id: current.id,
        request_code: current.request_code,
        status: current.status,
        status_label: statusLabel(current.status),
      },
      events: events.results || [],
    },
    headers
  );
}

export async function handleAttachClient(request, env, headers, params) {
  const [requestCode] = params;

  const req = await env.DB.prepare(
    `SELECT * FROM requests WHERE request_code = ? LIMIT 1`
  ).bind(requestCode).first();

  if (!req) return error("Заявку не знайдено", headers, 404);

  if (req.client_id) {
    const client = await env.DB.prepare(
      `SELECT id, name, phone FROM clients WHERE id = ? LIMIT 1`
    ).bind(req.client_id).first();
    return json({ ok: true, created: false, existing: true, request: req, client }, headers);
  }

  const normalizedPhone = normalizePhone(req.phone);
  if (!normalizedPhone) return error("Некоректний телефон у заявці", headers, 400);

  let client = await env.DB.prepare(
    `SELECT id, name, phone FROM clients WHERE phone = ? LIMIT 1`
  ).bind(normalizedPhone).first();

  let created = false;
  if (!client) {
    const ins = await env.DB.prepare(`
      INSERT INTO clients (name, phone) VALUES (?, ?)
    `).bind(req.name || "—", normalizedPhone).run();
    if (!ins.meta?.last_row_id) return error("Не вдалося створити клієнта", headers, 500);
    client = await env.DB.prepare(
      `SELECT id, name, phone FROM clients WHERE id = ? LIMIT 1`
    ).bind(ins.meta.last_row_id).first();
    created = true;
  }

  await env.DB.prepare(`
    UPDATE requests SET client_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(client.id, req.id).run();

  return json(
    {
      ok: true, created, existing: !created,
      request: { ...req, client_id: client.id },
      client,
    },
    headers
  );
}