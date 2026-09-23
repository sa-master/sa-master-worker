import { json } from "../lib/json.js";
import { statusLabel } from "../lib/statuses.js";
import {
  sendToJobsGroup,
  editJobsMessage,
  answerJobsCallback,
  sendToMaster,
} from "../lib/telegram-jobs.js";
import { sendTelegram } from "../lib/telegram.js";
import { buildMasterOutcomeButtons } from "../lib/telegram-buttons.js";

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

  /* ---- Результат від майстра ---- */
  if (data.startsWith("outcome:")) {
    const parts = data.split(":");
    const requestCode = parts[1];
    const outcome = parts[2];
    return await handleMasterOutcome(env, headers, requestCode, outcome, cq);
  }

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

  if (req.assigned_master_id) {
    await answerJobsCallback(
      env,
      cq.id,
      `❌ Вже взято: ${req.assigned_master_name || "іншим майстром"}`,
      true
    );
    return json({ ok: true }, headers);
  }

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

  /* Надсилаємо контакти майстру з кнопками результату */
  const contactsText = [
    `✅ Ви взяли заявку ${req.request_code}`,
    ``,
    `👤 Клієнт: ${req.name}`,
    `📞 Телефон: ${req.phone}`,
    `📍 Об'єкт: ${req.location || "—"}`,
    req.project ? `📐 Дизайн-проєкт: ${req.project}` : null,
    req.timing ? `🗓 Початок: ${req.timing}` : null,
    ``,
    `Після розмови — позначте результат:`,
  ].filter(Boolean).join("\n");

  const outcomeButtons = buildMasterOutcomeButtons(req.request_code);
  await sendToMaster(env, masterId, contactsText, outcomeButtons);

  /* Сповіщаємо адміна */
  const adminText = [
    `🔔 ЗАЯВКУ ВЗЯТО`,
    `🆔 ${req.request_code}`,
    `🙋 Майстер: ${masterName}`,
    `👤 Клієнт: ${req.name}`,
    `📞 ${req.phone}`,
  ].join("\n");

  await sendTelegram(env, adminText);
  await answerJobsCallback(env, cq.id, `✅ Ви взяли заявку`);

  return json({ ok: true }, headers);
}

/* ---- Обробка результату від майстра ---- */
async function handleMasterOutcome(env, headers, requestCode, outcome, cq) {
  const master = cq.from;
  const masterId = master.id;
  const masterName = master.username ? `@${master.username}` : master.first_name;

  const validOutcomes = ["working", "no_answer", "weird_client", "too_expensive"];
  if (!validOutcomes.includes(outcome)) {
    await answerJobsCallback(env, cq.id, "❓ Невідомий результат", true);
    return json({ ok: true }, headers);
  }

  const req = await env.DB.prepare(`
    SELECT * FROM requests WHERE request_code = ? LIMIT 1
  `).bind(requestCode).first();

  if (!req) {
    await answerJobsCallback(env, cq.id, "❌ Заявку не знайдено", true);
    return json({ ok: true }, headers);
  }

  /* Записуємо результат */
  try {
    await env.DB.prepare(`
      INSERT INTO request_outcomes (request_id, master_id, outcome)
      VALUES (?, ?, ?)
    `).bind(req.id, masterId, outcome).run();
  } catch (err) {
    console.error("Save outcome failed:", err);
  }

  /* Лічильники майстра */
  if (outcome === "working") {
    await env.DB.prepare(`
      UPDATE masters SET good_deals_count = COALESCE(good_deals_count, 0) + 1 WHERE telegram_id = ?
    `).bind(masterId).run();
  } else if (outcome === "no_answer") {
    await env.DB.prepare(`
      UPDATE masters SET no_answer_count = COALESCE(no_answer_count, 0) + 1 WHERE telegram_id = ?
    `).bind(masterId).run();
  } else if (outcome === "weird_client") {
    await env.DB.prepare(`
      UPDATE masters SET weird_client_count = COALESCE(weird_client_count, 0) + 1 WHERE telegram_id = ?
    `).bind(masterId).run();
  }

  /* Лічильники клієнта */
  if (outcome === "no_answer" && req.client_id) {
    await env.DB.prepare(`
      UPDATE clients SET no_answer_count = COALESCE(no_answer_count, 0) + 1 WHERE id = ?
    `).bind(req.client_id).run();
  }
  if (outcome === "weird_client" && req.client_id) {
    await env.DB.prepare(`
      UPDATE clients SET weird_count = COALESCE(weird_count, 0) + 1 WHERE id = ?
    `).bind(req.client_id).run();
  }

  if (outcome === "working") {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE requests SET status = 'installation', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(req.id),
      env.DB.prepare(`
        INSERT INTO events (object_id, request_id, event_type, content, author_type)
        VALUES (?, ?, 'master_working', ?, 'master')
      `).bind(req.object_id || null, req.id, `${masterName} підтвердив роботу`),
    ]);

    await answerJobsCallback(env, cq.id, "✅ Дякую! Заявка в роботі");
    await sendToMaster(env, masterId, "✅ Заявка переведена в статус «У роботі». Успіхів!");

  } else if (outcome === "no_answer") {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE requests 
        SET assigned_master_id = NULL, 
            assigned_master_name = NULL, 
            assigned_at = NULL,
            updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).bind(req.id),
      env.DB.prepare(`
        INSERT INTO events (object_id, request_id, event_type, content, author_type)
        VALUES (?, ?, 'client_no_answer', ?, 'master')
      `).bind(req.object_id || null, req.id, `${masterName}: клієнт не відповідає`),
    ]);

    const warnText = [
      `🔔 ЗАЯВКА ${req.request_code}`,
      `👤 ${req.name}`,
      `🔧 ${req.type_label || req.type}`,
      `📍 ${req.location || "—"}`,
      ``,
      `⚠️ Попередження: попередній майстер не зміг додзвонитись`,
    ].join("\n");

    const buttons = [[{ text: "🤝 Беру в роботу", callback_data: `take:${req.request_code}` }]];
    await sendToJobsGroup(env, warnText, buttons);

    await answerJobsCallback(env, cq.id, "✅ Заявка повернута в канал");
    await sendToMaster(env, masterId, "Заявку повернуто в канал з позначкою «клієнт не відповідав»");
    await sendTelegram(env, `⚠️ ${masterName} повідомив: клієнт ${req.name} (${req.request_code}) не відповідає`);

  } else if (outcome === "weird_client") {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE requests SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(req.id),
      env.DB.prepare(`
        INSERT INTO events (object_id, request_id, event_type, content, author_type)
        VALUES (?, ?, 'weird_client', ?, 'master')
      `).bind(req.object_id || null, req.id, `${masterName}: дивний клієнт`),
    ]);

    await answerJobsCallback(env, cq.id, "⚠️ Позначено. Дякую!");
    await sendToMaster(env, masterId, "Заявку закрито. Дякую за сигнал!");
    await sendTelegram(env, `⚠️ ${masterName} позначив клієнта ${req.name} (${req.request_code}) як дивного`);

  } else if (outcome === "too_expensive") {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE requests 
        SET assigned_master_id = NULL, 
            assigned_master_name = NULL, 
            assigned_at = NULL,
            updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).bind(req.id),
      env.DB.prepare(`
        INSERT INTO events (object_id, request_id, event_type, content, author_type)
        VALUES (?, ?, 'not_suitable', ?, 'master')
      `).bind(req.object_id || null, req.id, `${masterName}: не підходить`),
    ]);

    const buttons = [[{ text: "🤝 Беру в роботу", callback_data: `take:${req.request_code}` }]];
    await sendToJobsGroup(
      env,
      `🔔 ЗАЯВКА ${req.request_code}\n👤 ${req.name}\n📍 ${req.location || "—"}\n\n[Повторно]`,
      buttons
    );

    await answerJobsCallback(env, cq.id, "✅ Заявка повернута в канал");
    await sendToMaster(env, masterId, "Заявку повернуто в канал");
  }

  return json({ ok: true }, headers);
}
