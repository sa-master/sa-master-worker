import { json } from "../lib/json.js";
import { statusLabel } from "../lib/statuses.js";
import {
  sendToJobsGroup,
  editJobsMessage,
  answerJobsCallback,
  sendToMaster,
} from "../lib/telegram-jobs.js";
import { sendTelegram } from "../lib/telegram.js";

/* =========================================================
 * Публікація заявки в групу майстрів
 * ========================================================= */
export async function publishRequestToJobsGroup(env, request) {
  const text = [
    `🔔 НОВА ЗАЯВКА`,
    `🆔 ${request.request_code}`,
    `👤 ${request.name}`,
    `🔧 ${request.type_label || request.type}`,
    `📍 ${request.location || "—"}`,
    request.project ? `📐 Дизайн-проєкт: ${request.project}` : null,
    request.timing ? `🗓 Початок: ${request.timing}` : null,
    `📊 Пріоритет: ${request.priority === "high" ? "🥇 Високий" : request.priority === "medium" ? "🥈 Середній" : "🥉 Низький"}`,
  ].filter(Boolean).join("\n");

  const buttons = [
    [{ text: "🤝 Беру в роботу", callback_data: `take:${request.request_code}` }],
  ];

  return sendToJobsGroup(env, text, buttons);
}

/* =========================================================
 * POST /jobs-webhook — прийом callback від 2-го бота
 * ========================================================= */
export async function handleJobsWebhook(request, env, headers) {
  let update;
  try { update = await request.json(); }
  catch { return json({ ok: false }, headers, 400); }

  if (!update.callback_query) {
    return json({ ok: true }, headers);
  }

  const cq = update.callback_query;
  const data = String(cq.data || "");

  /* ---- Взяти в роботу ---- */
  if (data.startsWith("take:")) {
    const requestCode = data.slice(5);
    return await handleTakeJob(env, headers, requestCode, cq);
  }

  /* Невідома дія */
  await answerJobsCallback(env, cq.id, "❓ Невідома дія", true);
  return json({ ok: true }, headers);
}

/* ---- Обробка взяття заявки ---- */
async function handleTakeJob(env, headers, requestCode, cq) {
  const master = cq.from;
  const masterId = master.id;
  const masterName = master.username ? `@${master.username}` : master.first_name;

  const req = await env.DB.prepare(`
    SELECT * FROM requests WHERE request_code = ? LIMIT 1
  `).bind(requestCode).first();

  if (!req) {
    await answerJobsCallback(env, cq.id, "❌ Заявку не знайдено", true);
    return json({ ok: true }, headers);
  }

  /* Перевірка: чи заявка вже взята */
  if (req.assigned_master_id) {
    await answerJobsCallback(
      env,
      cq.id,
      `❌ Вже взято: ${req.assigned_master_name || "іншим майстром"}`,
      true
    );
    return json({ ok: true }, headers);
  }

  /* Перевірка: чи майстер зареєстрований */
  const registeredMaster = await env.DB.prepare(`
    SELECT id, status FROM masters WHERE telegram_id = ? LIMIT 1
  `).bind(masterId).first();

  if (!registeredMaster || registeredMaster.status !== "active") {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Ви не зареєстровані. Напишіть /join у приватний чат бота.",
      true
    );
    return json({ ok: true }, headers);
  }

  /* Позначаємо заявку як взяту */
  try {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE requests
        SET assigned_master_id = ?,
            assigned_master_name = ?,
            assigned_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(masterId, masterName, req.id),
      env.DB.prepare(`
        INSERT INTO events (object_id, request_id, event_type, content, author_type)
        VALUES (?, ?, 'master_took_job', ?, 'master')
      `).bind(req.object_id || null, req.id, `${masterName} взяв заявку в роботу`),
    ]);
  } catch (err) {
    console.error("Take job failed:", err);
    await answerJobsCallback(env, cq.id, "❌ Помилка збереження", true);
    return json({ ok: true }, headers);
  }

  /* Оновлюємо повідомлення в групі */
  const updatedText = [
    `✅ ЗАЯВКА ${req.request_code}`,
    `👤 ${req.name}`,
    `📍 ${req.location || "—"}`,
    `📊 Статус: Взято`,
    `🙋 Виконавець: ${masterName}`,
  ].join("\n");

  await editJobsMessage(env, cq.message.message_id, updatedText, []);

  /* Надсилаємо контакти майстру в приват */
  const contactsText = [
    `✅ Ви взяли заявку ${req.request_code}`,
    ``,
    `👤 Клієнт: ${req.name}`,
    `📞 Телефон: ${req.phone}`,
    `📍 Об'єкт: ${req.location || "—"}`,
    req.project ? `📐 Дизайн-проєкт: ${req.project}` : null,
    req.timing ? `🗓 Початок: ${req.timing}` : null,
  ].filter(Boolean).join("\n");

  await sendToMaster(env, masterId, contactsText);

  /* Сповіщаємо тебе (адміна) */
  const adminText = [
    `🔔 ЗАЯВКУ ВЗЯТО`,
    `🆔 ${req.request_code}`,
    `🙋 Майстер: ${masterName}`,
    `👤 Клієнт: ${req.name}`,
    `📞 ${req.phone}`,
  ].join("\n");

  await sendTelegram(env, adminText);

  /* Відповідаємо майстру */
  await answerJobsCallback(env, cq.id, `✅ Ви взяли заявку`);

  return json({ ok: true }, headers);
}
