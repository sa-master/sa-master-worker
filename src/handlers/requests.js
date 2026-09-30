REQUESTS.JS — ПОГОДЖЕНІ ЗМІНИ
================================

У поточному requests.js залиш увесь наявний код без змін і внеси ці 2 блоки.

1. У handleTelegramWebhook(), ПЕРЕД фінальним:
   await safeAnswerCallback(... "❓ Невідома дія" ...)

додай:

  if (data.startsWith("jobs_review_return:")) {
    const requestCode = data.slice("jobs_review_return:".length);

    const req = await env.DB.prepare(`
      SELECT *
      FROM requests
      WHERE request_code = ?
      LIMIT 1
    `).bind(requestCode).first();

    if (!req) {
      await safeAnswerCallback(env, cq.id, "❌ Заявку не знайдено", true);
      return json({ ok: true }, headers);
    }

    if (req.assigned_master_id) {
      await safeAnswerCallback(
        env,
        cq.id,
        "❌ Заявка вже закріплена за майстром",
        true
      );
      return json({ ok: true }, headers);
    }

    if (["installation", "completed", "cancelled"].includes(req.status)) {
      await safeAnswerCallback(
        env,
        cq.id,
        "❌ Заявку вже закрито або роботи розпочато",
        true
      );
      return json({ ok: true }, headers);
    }

    try {
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE requests
          SET
            transferred_to_jobs = 1,
            transferred_at = COALESCE(transferred_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(req.id),

        env.DB.prepare(`
          INSERT INTO events (
            object_id,
            request_id,
            event_type,
            content,
            author_type
          )
          VALUES (?, ?, 'admin_returned_to_jobs',
                  'Адміністратор повернув заявку майстрам',
                  'admin')
        `).bind(req.object_id || null, req.id),
      ]);
    } catch (err) {
      console.error("Admin return to Jobs failed:", err);
      await safeAnswerCallback(env, cq.id, "❌ Помилка збереження", true);
      return json({ ok: true }, headers);
    }

    await editMessageText(
      env,
      chatId,
      messageId,
      [
        "↩️ ЗАЯВКУ ПОВЕРНУТО МАЙСТРАМ",
        "",
        `🆔 ${req.request_code}`,
        `👤 ${req.name || "—"}`,
        `📞 ${req.phone || "—"}`,
        "",
        "Заявка знову доступна активним майстрам у SA-MASTER Jobs.",
      ].join("\n"),
      [[
        {
          text: "🏠 До заявки",
          callback_data: `request_open:${req.request_code}`,
        },
        {
          text: "❌ Закрити",
          callback_data: "admin_close",
        },
      ]]
    );

    await safeAnswerCallback(env, cq.id, "✅ Повернуто в Jobs");
    return json({ ok: true }, headers);
  }

  if (data.startsWith("jobs_review_close:")) {
    const requestCode = data.slice("jobs_review_close:".length);

    const req = await env.DB.prepare(`
      SELECT *
      FROM requests
      WHERE request_code = ?
      LIMIT 1
    `).bind(requestCode).first();

    if (!req) {
      await safeAnswerCallback(env, cq.id, "❌ Заявку не знайдено", true);
      return json({ ok: true }, headers);
    }

    if (req.status === "completed") {
      await safeAnswerCallback(
        env,
        cq.id,
        "❌ Завершену заявку не можна скасувати",
        true
      );
      return json({ ok: true }, headers);
    }

    try {
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE requests
          SET
            status = 'cancelled',
            transferred_to_jobs = 0,
            assigned_master_id = NULL,
            assigned_master_name = NULL,
            assigned_at = NULL,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(req.id),

        env.DB.prepare(`
          INSERT INTO events (
            object_id,
            request_id,
            event_type,
            content,
            author_type
          )
          VALUES (?, ?, 'admin_closed_jobs_review',
                  'Адміністратор закрив заявку після перевірки',
                  'admin')
        `).bind(req.object_id || null, req.id),
      ]);
    } catch (err) {
      console.error("Admin close Jobs review failed:", err);
      await safeAnswerCallback(env, cq.id, "❌ Помилка збереження", true);
      return json({ ok: true }, headers);
    }

    await editMessageText(
      env,
      chatId,
      messageId,
      [
        "❌ ЗАЯВКУ ЗАКРИТО",
        "",
        `🆔 ${req.request_code}`,
        `👤 ${req.name || "—"}`,
        "",
        "Статус: Скасовано.",
        "Заявка більше не доступна майстрам.",
      ].join("\n"),
      [[
        {
          text: "🏠 До заявки",
          callback_data: `request_open:${req.request_code}`,
        },
        {
          text: "❌ Закрити",
          callback_data: "admin_close",
        },
      ]]
    );

    await safeAnswerCallback(env, cq.id, "❌ Заявку закрито");
    return json({ ok: true }, headers);
  }

2. ВАЖЛИВО ДЛЯ jobs.js:
адмінське повідомлення «ПОТРІБНА ПЕРЕВІРКА» тепер надсилається через
sendMessageWithButtons(), тому requests.js уже вміє обробити callback:
  jobs_review_return:<requestCode>
  jobs_review_close:<requestCode>
