import { json } from "../lib/json.js";
import {
  sendToMaster,
  answerJobsCallback,
  createInviteLink,
} from "../lib/telegram-jobs.js";
import { sendMessageWithButtons, editMessageText } from "../lib/telegram.js";

/* Запуск анкети */
export async function handleJoinStart(env, headers, chatId, fromUser) {
  const existing = await env.DB.prepare(`
    SELECT id, status FROM master_applications
    WHERE telegram_id = ? ORDER BY id DESC LIMIT 1
  `).bind(fromUser.id).first();

  if (existing && existing.status === "pending") {
    await sendToMaster(env, chatId, "⏳ Ваша анкета вже на розгляді. Зачекайте, будь ласка.");
    return json({ ok: true }, headers);
  }

  const isMaster = await env.DB.prepare(`
    SELECT id FROM masters WHERE telegram_id = ? LIMIT 1
  `).bind(fromUser.id).first();

  if (isMaster) {
    await sendToMaster(env, chatId, "✅ Ви вже зареєстровані як майстер.");
    return json({ ok: true }, headers);
  }

  await env.DB.prepare(`
    INSERT INTO master_applications (telegram_id, username, first_name, status)
    VALUES (?, ?, ?, 'draft')
  `).bind(fromUser.id, fromUser.username || null, fromUser.first_name || null).run();

  await sendToMaster(
    env,
    chatId,
    "👋 Вітаю! Давайте заповнимо анкету.\n\nЯк до вас звертатися? (Ваше ім'я)"
  );

  return json({ ok: true }, headers);
}

/* Обробка текстової відповіді в анкеті */
export async function handleJoinMessage(env, headers, chatId, fromUser, text) {
  const app = await env.DB.prepare(`
    SELECT * FROM master_applications
    WHERE telegram_id = ? AND status = 'draft'
    ORDER BY id DESC LIMIT 1
  `).bind(fromUser.id).first();

  if (!app) return json({ ok: false }, headers);

  /* Крок 1: ім'я */
  if (!app.phone && (!app.first_name || app.first_name === fromUser.first_name)) {
    await env.DB.prepare(`
      UPDATE master_applications SET first_name = ? WHERE id = ?
    `).bind(text, app.id).run();
    await sendToMaster(env, chatId, "📞 Ваш телефон?");
    return json({ ok: true }, headers);
  }

  /* Крок 2: телефон */
  if (!app.phone) {
    const digits = String(text).replace(/\D/g, "");
    if (digits.length < 9) {
      await sendToMaster(env, chatId, "❌ Схоже, це не телефон. Введіть ще раз (наприклад: +380...).");
      return json({ ok: true }, headers);
    }
    await env.DB.prepare(`
      UPDATE master_applications SET phone = ? WHERE id = ?
    `).bind(text, app.id).run();
    await sendToMaster(env, chatId, "🛠 Яка ваша спеціалізація?");
    await sendToMaster(env, chatId, "Напишіть: сантехніка, електрика або універсал");
    return json({ ok: true }, headers);
  }

  /* Крок 3: спеціалізація */
  if (!app.specializations) {
    const lower = String(text).toLowerCase().trim();
    let spec = "";
    if (lower.includes("сант") || lower.includes("plumb")) spec = "Сантехніка";
    else if (lower.includes("елект") || lower.includes("electric")) spec = "Електрика";
    else if (lower.includes("універс") || lower.includes("universal")) spec = "Універсал";
    else {
      await sendToMaster(env, chatId, "❌ Не зрозумів. Напишіть: сантехніка, електрика або універсал.");
      return json({ ok: true }, headers);
    }
    await env.DB.prepare(`
      UPDATE master_applications SET specializations = ? WHERE id = ?
    `).bind(spec, app.id).run();
    await sendToMaster(env, chatId, "🏙 Ваше місто? (Київ / інше)");
    return json({ ok: true }, headers);
  }

  /* Крок 4: місто */
  if (!app.city) {
    await env.DB.prepare(`
      UPDATE master_applications SET city = ? WHERE id = ?
    `).bind(text, app.id).run();
    await sendToMaster(env, chatId, "📆 Скільки років досвіду?");
    return json({ ok: true }, headers);
  }

  /* Крок 5: досвід */
  if (!app.experience) {
    await env.DB.prepare(`
      UPDATE master_applications SET experience = ? WHERE id = ?
    `).bind(text, app.id).run();
    await sendToMaster(env, chatId, "💬 Коротко про себе (1-2 речення):");
    return json({ ok: true }, headers);
  }

  /* Крок 6: про себе — завершення */
  if (!app.about) {
    await env.DB.prepare(`
      UPDATE master_applications SET about = ?, status = 'pending' WHERE id = ?
    `).bind(text, app.id).run();

    await sendToMaster(env, chatId, "✅ Дякую! Анкету надіслано на розгляд. Зачекайте, будь ласка.");

    const appFull = await env.DB.prepare(`
      SELECT * FROM master_applications WHERE id = ?
    `).bind(app.id).first();

    const adminText = [
      "🆕 НОВА АНКЕТА МАЙСТРА",
      `👤 ${appFull.first_name}`,
      `📞 ${appFull.phone}`,
      `🛠 ${appFull.specializations}`,
      `🏙 ${appFull.city}`,
      `📆 ${appFull.experience}`,
      `💬 ${appFull.about}`,
      `🆔 Telegram: ${appFull.telegram_id}`,
    ].join("\n");

    const adminButtons = [
      [
        { text: "✅ Прийняти", callback_data: `app_approve:${app.id}` },
        { text: "❌ Відхилити", callback_data: `app_reject:${app.id}` },
      ],
    ];

    await sendMessageWithButtons(env, adminText, adminButtons);
    return json({ ok: true }, headers);
  }

  return json({ ok: true }, headers);
}

/* Обробка підтвердження/відхилення анкети адміном */
export async function handleApplicationReview(env, headers, appId, action, cq) {
  const app = await env.DB.prepare(`
    SELECT * FROM master_applications WHERE id = ?
  `).bind(appId).first();

  if (!app) {
    await answerJobsCallback(env, cq.id, "❌ Анкету не знайдено", true);
    return json({ ok: true }, headers);
  }

  /* Перевірка: чи вже оброблено */
  if (app.status !== "pending") {
    await answerJobsCallback(env, cq.id, `⚠️ Вже оброблено: ${app.status}`, true);
    return json({ ok: true }, headers);
  }

  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const now = new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" });

  /* ---- Відхилення ---- */
  if (action === "reject") {
    await env.DB.prepare(`
      UPDATE master_applications SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(appId).run();

    await sendToMaster(env, app.telegram_id, "❌ На жаль, вашу анкету відхилено. Дякуємо за інтерес!");

    /* Оновлюємо повідомлення */
    const rejectedText = [
      "❌ АНКЕТУ ВІДХИЛЕНО",
      `👤 ${app.first_name}`,
      `📞 ${app.phone}`,
      `🛠 ${app.specializations}`,
      `🏙 ${app.city}`,
      `📆 ${app.experience}`,
      `💬 ${app.about}`,
      `🆔 Telegram: ${app.telegram_id}`,
      ``,
      `❌ Відхилено: ${now}`,
    ].join("\n");

    await editMessageText(env, chatId, messageId, rejectedText, []);

    await answerJobsCallback(env, cq.id, "❌ Відхилено");
    return json({ ok: true }, headers);
  }

  /* ---- Прийняття ---- */
  await env.DB.prepare(`
    UPDATE master_applications SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(appId).run();

  await env.DB.prepare(`
    INSERT INTO masters (telegram_id, username, first_name, phone, specializations, cities, status, application_id, joined_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP)
  `).bind(
    app.telegram_id,
    app.username,
    app.first_name,
    app.phone,
    app.specializations,
    app.city,
    app.id
  ).run();

  /* Генеруємо посилання */
  const invite = await createInviteLink(env);

  if (invite && invite.ok && invite.result?.invite_link) {
    await sendToMaster(
      env,
      app.telegram_id,
      `✅ Вас прийнято!\n\nПриєднайтесь до групи майстрів:\n${invite.result.invite_link}\n\n⚠️ Посилання дійсне 24 години та для 1 людини.`
    );
  } else {
    await sendToMaster(
      env,
      app.telegram_id,
      "✅ Вас прийнято! Очікуйте, скоро додамо вас у групу."
    );
  }

  /* Оновлюємо повідомлення в адміна */
  const approvedText = [
    "✅ АНКЕТУ ПРИЙНЯТО",
    `👤 ${app.first_name}`,
    `📞 ${app.phone}`,
    `🛠 ${app.specializations}`,
    `🏙 ${app.city}`,
    `📆 ${app.experience}`,
    `💬 ${app.about}`,
    `🆔 Telegram: ${app.telegram_id}`,
    ``,
    `✅ Прийнято: ${now}`,
  ].join("\n");

  await editMessageText(env, chatId, messageId, approvedText, []);

  await answerJobsCallback(env, cq.id, "✅ Прийнято!");
  return json({ ok: true }, headers);
}
