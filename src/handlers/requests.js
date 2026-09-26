import { json, error } from "../lib/json.js";
import { STATUS_LABELS, statusLabel, isValidStatus, withStatusLabel } from "../lib/statuses.js";
import { normalizePhone, isValidPhone } from "../lib/phone.js";
import { str } from "../lib/validate.js";
import {
  sendTelegram,
  sendMessageWithButtons,
  editMessageText,
  answerCallbackQuery,
} from "../lib/telegram.js";
import {
  buildStatusButtons,
  canChangeStatus,
  formatRequestText,
} from "../lib/telegram-buttons.js";
import { publishRequestToJobsGroup } from "./jobs.js";

const CURRENT_YEAR = 2026;
const ESTIMATE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_LINK_TTL_MS = 2 * 60 * 60 * 1000;

function calculatorUrl(requestCode, token, workerOrigin, env) {
  if (!token || !env.CALCULATOR_URL) return "";
  const url = new URL(env.CALCULATOR_URL);
  url.searchParams.set("request", requestCode);
  url.searchParams.set("token", token);
  url.searchParams.set("api", workerOrigin);
  return url.toString();
}

/* =========================================================
 * POST / — створення заявки (публічний)
 * ========================================================= */
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
  const notes        = str(body.notes,            { max: 500 });
  const estimateToken = crypto.randomUUID().replaceAll("-", "");
  const estimateTokenExpiresAt = new Date(Date.now() + ESTIMATE_LINK_TTL_MS).toISOString();
  const uploadToken = crypto.randomUUID().replaceAll("-", "");
  const uploadTokenExpiresAt = new Date(Date.now() + UPLOAD_LINK_TTL_MS).toISOString();

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
        timing, project, consultation_date, source, status, client_id, notes,
        estimate_token, estimate_token_expires_at,
        upload_token, upload_token_expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)
    `).bind(
      requestCode, type, typeLabel, name, normalizedPhone,
      location || null, timing || null, project || null,
      consultation || null, source, clientId, notes || null,
      estimateToken, estimateTokenExpiresAt,
      uploadToken, uploadTokenExpiresAt
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

  const text = [
    "🏠 НОВА ЗАЯВКА",
    `🆔 ${requestCode}`,
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
    notes ? `📝 Опис: ${notes}` : null,
  ].filter(Boolean).join("\n");

  const buttons = buildStatusButtons(
    requestCode,
    "new",
    calculatorUrl(requestCode, estimateToken, new URL(request.url).origin, env)
  );
  buttons.push([{ text: "🤝 Передати в канал", callback_data: `transfer_to_jobs:${requestCode}` }]);

  const tg = await sendMessageWithButtons(env, text, buttons);
  if (!tg.ok) {
    console.error("Telegram send failed:", tg.description || tg);
  }

  return json({
    ok: true,
    request: {
      id: requestId,
      request_code: requestCode,
      client_id: clientId,
      status: "new",
      status_label: statusLabel("new"),
      upload_token: uploadToken,
    },
  }, headers);
}

/* =========================================================
 * GET /calculator-request/:code?token=… (публічний, разове посилання)
 * ========================================================= */
export async function handleGetCalculatorRequest(request, env, headers, params, url) {
  const [requestCode] = params;
  const token = str(url.searchParams.get("token"), { max: 100, required: true });
  if (!token) return error("Відсутній ключ заявки", headers, 403);

  const row = await env.DB.prepare(`
    SELECT request_code, name, phone, location, type, type_label,
           timing, project, consultation_date, notes
    FROM requests
    WHERE request_code = ?
      AND estimate_token = ?
      AND datetime(estimate_token_expires_at) > CURRENT_TIMESTAMP
    LIMIT 1
  `).bind(requestCode, token).first();

  if (!row) {
    return error("Посилання на заявку недійсне або вже прострочене", headers, 404);
  }
  return json({ ok: true, request: row }, headers);
}

/* =========================================================
 * GET /requests (admin)
 * ========================================================= */
export async function handleListRequests(request, env, headers, _params, url) {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  const result = await env.DB.prepare(`
    SELECT r.*, c.id AS client_id, c.name AS client_name, c.phone AS client_phone
    FROM requests r
    LEFT JOIN clients c ON c.id = r.client_id
    ORDER BY r.id DESC LIMIT ? OFFSET ?
  `).bind(limit, offset).all();
  return json({ ok: true, requests: (result.results || []).map(withStatusLabel), limit, offset }, headers);
}

/* =========================================================
 * GET /request/:code (admin)
 * ========================================================= */
export async function handleGetRequest(request, env, headers, params) {
  const [requestCode] = params;
  const row = await env.DB.prepare(`
    SELECT r.*, c.name AS client_name, c.phone AS client_phone,
           o.object_code, o.name AS object_name, o.address AS object_address, o.status AS object_status
    FROM requests r
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN objects o ON o.id = r.object_id
    WHERE r.request_code = ? LIMIT 1
  `).bind(requestCode).first();
  if (!row) return error("Заявку не знайдено", headers, 404);
  return json({ ok: true, request: {
    ...row,
    status_label: statusLabel(row.status),
    object_status_label: row.object_status ? statusLabel(row.object_status) : null,
  } }, headers);
}

/* =========================================================
 * POST /request/:code/status (admin)
 * ========================================================= */
export async function handleUpdateStatus(request, env, headers, params) {
  const [requestCode] = params;
  let body;
  try { body = await request.json(); }
  catch { return error("Некоректний JSON", headers, 400); }
  const newStatus = String(body.status || "").trim();
  if (!isValidStatus(newStatus)) {
    return error("Невідомий статус", headers, 400, { allowed_statuses: Object.keys(STATUS_LABELS) });
  }
  const current = await env.DB.prepare(`
    SELECT id, request_code, status, object_id FROM requests WHERE request_code = ? LIMIT 1
  `).bind(requestCode).first();
  if (!current) return error("Заявку не знайдено", headers, 404);
  const oldStatus = current.status;
  if (oldStatus === newStatus) return json({ ok: true, unchanged: true, status: newStatus }, headers);
  const oldLabel = statusLabel(oldStatus);
  const newLabel = statusLabel(newStatus);
  const eventContent = `${oldLabel} → ${newLabel}`;
  const statements = [
    env.DB.prepare(`UPDATE requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(newStatus, current.id),
    env.DB.prepare(`INSERT INTO events (object_id, request_id, event_type, content, author_type) VALUES (?, ?, 'status_changed', ?, 'system')`).bind(current.object_id || null, current.id, eventContent),
  ];
  const syncObject = current.object_id && newStatus !== "cancelled";
  if (syncObject) {
    statements.push(
      env.DB.prepare(`UPDATE objects SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(newStatus, current.object_id),
      env.DB.prepare(`INSERT INTO events (object_id, request_id, event_type, content, author_type) VALUES (?, ?, 'object_status_changed', ?, 'system')`).bind(current.object_id, current.id, `Статус об'єкта → ${newLabel}`)
    );
  }
  try { await env.DB.batch(statements); }
  catch (err) { console.error("Status update batch failed:", err); return error("Не вдалося оновити статус", headers, 500); }
  let object = null;
  if (current.object_id) {
    object = await env.DB.prepare(`SELECT id, object_code, name, status FROM objects WHERE id = ? LIMIT 1`).bind(current.object_id).first();
    if (object) { object.status_label = statusLabel(object.status); object.updated = syncObject; }
  }
  return json({ ok: true, request: {
    id: current.id, request_code: current.request_code,
    old_status: oldStatus, old_status_label: oldLabel,
    status: newStatus, status_label: newLabel,
  }, object, event: { event_type: "status_changed", content: eventContent, author_type: "system" } }, headers);
}

/* =========================================================
 * GET /request/:code/events (admin)
 * ========================================================= */
export async function handleGetEvents(request, env, headers, params) {
  const [requestCode] = params;
  const current = await env.DB.prepare(`SELECT id, request_code, status FROM requests WHERE request_code = ? LIMIT 1`).bind(requestCode).first();
  if (!current) return error("Заявку не знайдено", headers, 404);
  const events = await env.DB.prepare(`
    SELECT id, request_id, object_id, event_type, content, author_type, author_id, created_at
    FROM events WHERE request_id = ? ORDER BY id ASC
  `).bind(current.id).all();
  return json({ ok: true, request: {
    id: current.id, request_code: current.request_code,
    status: current.status, status_label: statusLabel(current.status),
  }, events: events.results || [] }, headers);
}

/* =========================================================
 * POST /request/:code/client (admin)
 * ========================================================= */
export async function handleAttachClient(request, env, headers, params) {
  const [requestCode] = params;
  const req = await env.DB.prepare(`SELECT * FROM requests WHERE request_code = ? LIMIT 1`).bind(requestCode).first();
  if (!req) return error("Заявку не знайдено", headers, 404);
  if (req.client_id) {
    const client = await env.DB.prepare(`SELECT id, name, phone FROM clients WHERE id = ? LIMIT 1`).bind(req.client_id).first();
    return json({ ok: true, created: false, existing: true, request: req, client }, headers);
  }
  const normalizedPhone = normalizePhone(req.phone);
  if (!normalizedPhone) return error("Некоректний телефон у заявці", headers, 400);
  let client = await env.DB.prepare(`SELECT id, name, phone FROM clients WHERE phone = ? LIMIT 1`).bind(normalizedPhone).first();
  let created = false;
  if (!client) {
    const ins = await env.DB.prepare(`INSERT INTO clients (name, phone) VALUES (?, ?)`).bind(req.name || "—", normalizedPhone).run();
    if (!ins.meta?.last_row_id) return error("Не вдалося створити клієнта", headers, 500);
    client = await env.DB.prepare(`SELECT id, name, phone FROM clients WHERE id = ? LIMIT 1`).bind(ins.meta.last_row_id).first();
    created = true;
  }
  await env.DB.prepare(`UPDATE requests SET client_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(client.id, req.id).run();
  return json({ ok: true, created, existing: !created, request: { ...req, client_id: client.id }, client }, headers);
}

/* =========================================================
 * POST /telegram-webhook — прийом callback-ів від Telegram
 * ========================================================= */
export async function handleTelegramWebhook(request, env, headers) {
  let update;
  try { update = await request.json(); }
  catch { return json({ ok: false }, headers, 400); }
  if (!update.callback_query) return json({ ok: true }, headers);

  const cq = update.callback_query;
  if (String(cq.from?.id) !== String(env.CHAT_ID)) {
    await answerCallbackQuery(env, cq.id, "❌ Немає доступу", true);
    return json({ ok: true }, headers);
  }
  const data = String(cq.data || "");
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const workerOrigin = new URL(request.url).origin;

  if (data.startsWith("details:")) return handleTelegramDetails(env, headers, data.slice(8), cq.id, chatId);
  if (data.startsWith("status:")) {
    const [, requestCode, newStatus] = data.split(":");
    return handleTelegramStatusUpdate(env, headers, requestCode, newStatus, cq.id, chatId, messageId, workerOrigin);
  }
  if (data.startsWith("transfer_to_jobs:")) {
    return handleTransferToJobs(env, headers, data.slice(17), cq, chatId, messageId, workerOrigin);
  }
  if (data.startsWith("app_approve:")) {
    const { handleApplicationReview } = await import("./join.js");
    return handleApplicationReview(env, headers, Number(data.slice(12)), "approve", cq);
  }
  if (data.startsWith("app_reject:")) {
    const { handleApplicationReview } = await import("./join.js");
    return handleApplicationReview(env, headers, Number(data.slice(11)), "reject", cq);
  }
  await answerCallbackQuery(env, cq.id, "❓ Невідома дія", true);
  return json({ ok: true }, headers);
}

async function handleTelegramDetails(env, headers, requestCode, callbackId, chatId) {
  const req = await env.DB.prepare(`SELECT * FROM requests WHERE request_code = ? LIMIT 1`).bind(requestCode).first();
  if (!req) { await answerCallbackQuery(env, callbackId, "❌ Заявку не знайдено", true); return json({ ok: true }, headers); }
  const events = await env.DB.prepare(`SELECT event_type, content, created_at FROM events WHERE request_id = ? ORDER BY id ASC`).bind(req.id).all();
  const lines = [formatRequestText(req), "", `🕐 Створено: ${req.created_at || "—"}`, `🕐 Оновлено: ${req.updated_at || "—"}`];
  if (events.results?.length) {
    lines.push("", "📜 Історія:");
    for (const ev of events.results.slice(-10)) lines.push(`• ${ev.content}`);
  }
  await sendTelegram(env, lines.join("\n"));
  await answerCallbackQuery(env, callbackId, "");
  return json({ ok: true }, headers);
}

async function handleTelegramStatusUpdate(env, headers, requestCode, newStatus, callbackId, chatId, messageId, workerOrigin) {
  if (!isValidStatus(newStatus)) {
    await answerCallbackQuery(env, callbackId, "❌ Невідомий статус", true);
    return json({ ok: true }, headers);
  }
  const current = await env.DB.prepare(`SELECT id, request_code, status, object_id, name, phone FROM requests WHERE request_code = ? LIMIT 1`).bind(requestCode).first();
  if (!current) { await answerCallbackQuery(env, callbackId, "❌ Заявку не знайдено", true); return json({ ok: true }, headers); }
  if (!canChangeStatus(current.status, newStatus)) {
    await answerCallbackQuery(env, callbackId, `❌ Неможливо: статус «${statusLabel(current.status)}» → «${statusLabel(newStatus)}»`, true);
    return json({ ok: true }, headers);
  }
  const oldLabel = statusLabel(current.status);
  const newLabel = statusLabel(newStatus);
  const eventContent = `${oldLabel} → ${newLabel}`;
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(newStatus, current.id),
      env.DB.prepare(`INSERT INTO events (object_id, request_id, event_type, content, author_type) VALUES (?, ?, 'status_changed', ?, 'system')`).bind(current.object_id || null, current.id, eventContent),
    ]);
  } catch (err) {
    console.error("Telegram status update failed:", err);
    await answerCallbackQuery(env, callbackId, "❌ Помилка збереження", true);
    return json({ ok: true }, headers);
  }
  const req = await env.DB.prepare(`SELECT * FROM requests WHERE id = ? LIMIT 1`).bind(current.id).first();
  const text = [`🏠 ЗАЯВКА ${req.request_code}`, `👤 ${req.name}`, `📞 ${req.phone}`, `📊 Статус: ${newLabel}`, `🕐 Оновлено: ${new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" })}`].join("\n");
  const buttons = buildStatusButtons(
    req.request_code,
    newStatus,
    calculatorUrl(req.request_code, req.estimate_token, workerOrigin, env)
  );
  await editMessageText(env, chatId, messageId, text, buttons);
  await answerCallbackQuery(env, callbackId, `✅ ${newLabel}`);
  return json({ ok: true }, headers);
}

async function handleTransferToJobs(env, headers, requestCode, cq, chatId, messageId, workerOrigin) {
  const req = await env.DB.prepare(`SELECT * FROM requests WHERE request_code = ? LIMIT 1`).bind(requestCode).first();
  if (!req) { await answerCallbackQuery(env, cq.id, "❌ Заявку не знайдено", true); return json({ ok: true }, headers); }
  if (req.transferred_to_jobs) { await answerCallbackQuery(env, cq.id, "⚠️ Уже передано в канал", true); return json({ ok: true }, headers); }
  const result = await publishRequestToJobsGroup(env, req);
  if (!result.ok) {
    console.error("Publish to jobs group failed:", result.description || result);
    await answerCallbackQuery(env, cq.id, "❌ Не вдалося опублікувати", true);
    return json({ ok: true }, headers);
  }
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE requests SET transferred_to_jobs = 1, transferred_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(req.id),
      env.DB.prepare(`INSERT INTO events (object_id, request_id, event_type, content, author_type) VALUES (?, ?, 'transferred_to_jobs', 'Передано в канал майстрів', 'system')`).bind(req.object_id || null, req.id),
    ]);
  } catch (err) { console.error("Mark as transferred failed:", err); }
  const updatedText = [`🏠 ЗАЯВКА ${req.request_code}`, `👤 ${req.name}`, `📞 ${req.phone}`, "📊 Статус: Передано в канал майстрів", `🕐 ${new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" })}`].join("\n");
  const buttons = buildStatusButtons(
    req.request_code,
    req.status,
    calculatorUrl(req.request_code, req.estimate_token, workerOrigin, env)
  );
  await editMessageText(env, chatId, messageId, updatedText, buttons);
  await answerCallbackQuery(env, cq.id, "✅ Передано в канал майстрів");
  return json({ ok: true }, headers);
}
