import { json } from "../lib/json.js";
import {
  sendToMaster,
  answerJobsCallback,
  createInviteForMaster,
} from "../lib/telegram-jobs.js";
import {
  sendMessageWithButtons,
  editMessageText,
} from "../lib/telegram.js";

const MASTER_STATUS = {
  ACTIVE: "active",
  BLOCKED: "blocked",
  ARCHIVED: "archived",
};

async function getMasterByTelegramId(env, telegramId) {
  return env.DB.prepare(`
    SELECT
      id, telegram_id, username, first_name, phone,
      specializations, cities, status, referral_token,
      application_id, joined_at
    FROM masters
    WHERE telegram_id = ?
    LIMIT 1
  `).bind(telegramId).first();
}

async function getLatestApplication(env, telegramId) {
  return env.DB.prepare(`
    SELECT *
    FROM master_applications
    WHERE telegram_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).bind(telegramId).first();
}

async function sendMasterStatusMessage(env, chatId, master) {
  if (!master) return false;

  if (master.status === MASTER_STATUS.ACTIVE) {
    await sendToMaster(env, chatId, [
      "✅ Ви вже зареєстровані як майстер.",
      "",
      "Ваш профіль SA-MASTER Jobs активний.",
    ].join("\n"));
    return true;
  }

  if (master.status === MASTER_STATUS.BLOCKED) {
    await sendToMaster(env, chatId, [
      "🚫 Ваш доступ до SA-MASTER Jobs заблоковано.",
      "",
      "Повторна реєстрація не змінює статус профілю.",
      "",
      "Якщо вважаєте, що це сталося помилково — зверніться до адміністратора.",
    ].join("\n"));
    return true;
  }

  if (master.status === MASTER_STATUS.ARCHIVED) {
    await sendToMaster(env, chatId, [
      "⚫ Ваш профіль SA-MASTER Jobs знаходиться в архіві.",
      "",
      "Для відновлення доступу зверніться до адміністратора.",
    ].join("\n"));
    return true;
  }

  await sendToMaster(env, chatId, [
    "⚠️ Ваш профіль уже існує в SA-MASTER Jobs.",
    "",
    "Зверніться до адміністратора для перевірки доступу.",
  ].join("\n"));

  return true;
}

export async function handleJoinStart(env, headers, chatId, fromUser) {
  const master = await getMasterByTelegramId(env, fromUser.id);

  if (master) {
    await sendMasterStatusMessage(env, chatId, master);
    return json({ ok: true }, headers);
  }

  const existing = await getLatestApplication(env, fromUser.id);

  if (existing?.status === "pending") {
    await sendToMaster(
      env,
      chatId,
      "⏳ Ваша анкета вже на розгляді. Зачекайте, будь ласка."
    );
    return json({ ok: true }, headers);
  }

  if (existing?.status === "draft") {
    await sendToMaster(env, chatId, [
      "📝 У вас уже є незавершена анкета.",
      "",
      "Продовжимо з місця, на якому ви зупинились.",
    ].join("\n"));

    if (!existing.phone && (!existing.first_name || existing.first_name === fromUser.first_name)) {
      await sendToMaster(env, chatId, "Як до вас звертатися? (Ваше ім'я)");
    } else if (!existing.phone) {
      await sendToMaster(env, chatId, "📞 Ваш телефон?");
    } else if (!existing.specializations) {
      await sendToMaster(env, chatId, "🛠 Напишіть вашу спеціалізацію: сантехніка, електрика або універсал");
    } else if (!existing.city) {
      await sendToMaster(env, chatId, "🏙 Ваше місто? (Київ / інше)");
    } else if (!existing.experience) {
      await sendToMaster(env, chatId, "📆 Скільки років досвіду?");
    } else if (!existing.about) {
      await sendToMaster(env, chatId, "💬 Коротко про себе (1–2 речення):");
    }

    return json({ ok: true }, headers);
  }

  await env.DB.prepare(`
    INSERT INTO master_applications (
      telegram_id, username, first_name, status
    )
    VALUES (?, ?, ?, 'draft')
  `).bind(
    fromUser.id,
    fromUser.username || null,
    fromUser.first_name || null
  ).run();

  await sendToMaster(env, chatId, [
    "👋 Вітаю!",
    "",
    "Давайте заповнимо коротку анкету майстра.",
    "",
    "Як до вас звертатися? (Ваше ім'я)",
  ].join("\n"));

  return json({ ok: true }, headers);
}

export async function handleJoinMessage(env, headers, chatId, fromUser, text) {
  const master = await getMasterByTelegramId(env, fromUser.id);
  if (master) return json({ ok: true }, headers);

  const app = await env.DB.prepare(`
    SELECT *
    FROM master_applications
    WHERE telegram_id = ?
      AND status = 'draft'
    ORDER BY id DESC
    LIMIT 1
  `).bind(fromUser.id).first();

  if (!app) return json({ ok: false }, headers);

  if (!app.phone && (!app.first_name || app.first_name === fromUser.first_name)) {
    await env.DB.prepare(`
      UPDATE master_applications SET first_name = ? WHERE id = ?
    `).bind(text, app.id).run();

    await sendToMaster(env, chatId, "📞 Ваш телефон?");
    return json({ ok: true }, headers);
  }

  if (!app.phone) {
    const digits = String(text).replace(/\D/g, "");

    if (digits.length < 9) {
      await sendToMaster(
        env,
        chatId,
        "❌ Схоже, це не телефон. Введіть ще раз (наприклад: +380...)."
      );
      return json({ ok: true }, headers);
    }

    await env.DB.prepare(`
      UPDATE master_applications SET phone = ? WHERE id = ?
    `).bind(text, app.id).run();

    await sendToMaster(env, chatId, "🛠 Яка ваша спеціалізація?");
    await sendToMaster(env, chatId, "Напишіть: сантехніка, електрика або універсал");
    return json({ ok: true }, headers);
  }

  if (!app.specializations) {
    const lower = String(text).toLowerCase().trim();
    let spec = "";

    if (lower.includes("сант") || lower.includes("plumb")) {
      spec = "Сантехніка";
    } else if (lower.includes("елект") || lower.includes("electric")) {
      spec = "Електрика";
    } else if (lower.includes("універс") || lower.includes("universal")) {
      spec = "Універсал";
    } else {
      await sendToMaster(
        env,
        chatId,
        "❌ Не зрозумів. Напишіть: сантехніка, електрика або універсал."
      );
      return json({ ok: true }, headers);
    }

    await env.DB.prepare(`
      UPDATE master_applications SET specializations = ? WHERE id = ?
    `).bind(spec, app.id).run();

    await sendToMaster(env, chatId, "🏙 Ваше місто? (Київ / інше)");
    return json({ ok: true }, headers);
  }

  if (!app.city) {
    await env.DB.prepare(`
      UPDATE master_applications SET city = ? WHERE id = ?
    `).bind(text, app.id).run();

    await sendToMaster(env, chatId, "📆 Скільки років досвіду?");
    return json({ ok: true }, headers);
  }

  if (!app.experience) {
    await env.DB.prepare(`
      UPDATE master_applications SET experience = ? WHERE id = ?
    `).bind(text, app.id).run();

    await sendToMaster(env, chatId, "💬 Коротко про себе (1–2 речення):");
    return json({ ok: true }, headers);
  }

  if (!app.about) {
    await env.DB.prepare(`
      UPDATE master_applications
      SET about = ?, status = 'pending'
      WHERE id = ?
    `).bind(text, app.id).run();

    await sendToMaster(env, chatId, [
      "✅ Дякую!",
      "",
      "Анкету надіслано на розгляд.",
      "Зачекайте, будь ласка.",
    ].join("\n"));

    const appFull = await env.DB.prepare(`
      SELECT * FROM master_applications WHERE id = ? LIMIT 1
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

    const adminButtons = [[
      { text: "✅ Прийняти", callback_data: `app_approve:${app.id}` },
      { text: "❌ Відхилити", callback_data: `app_reject:${app.id}` },
    ]];

    await sendMessageWithButtons(env, adminText, adminButtons);
    return json({ ok: true }, headers);
  }

  return json({ ok: true }, headers);
}

export async function handleApplicationReview(env, headers, appId, action, cq) {
  const app = await env.DB.prepare(`
    SELECT * FROM master_applications WHERE id = ? LIMIT 1
  `).bind(appId).first();

  if (!app) {
    await answerJobsCallback(env, cq.id, "❌ Анкету не знайдено", true);
    return json({ ok: true }, headers);
  }

  if (app.status !== "pending") {
    await answerJobsCallback(env, cq.id, `⚠️ Вже оброблено: ${app.status}`, true);
    return json({ ok: true }, headers);
  }

  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const now = new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" });

  if (action === "reject") {
    await env.DB.prepare(`
      UPDATE master_applications
      SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(appId).run();

    await sendToMaster(env, app.telegram_id, [
      "❌ На жаль, вашу анкету відхилено.",
      "",
      "Дякуємо за інтерес до SA-MASTER Jobs.",
    ].join("\n"));

    const rejectedText = [
      "❌ АНКЕТУ ВІДХИЛЕНО",
      `👤 ${app.first_name}`,
      `📞 ${app.phone}`,
      `🛠 ${app.specializations}`,
      `🏙 ${app.city}`,
      `📆 ${app.experience}`,
      `💬 ${app.about}`,
      `🆔 Telegram: ${app.telegram_id}`,
      "",
      `❌ Відхилено: ${now}`,
    ].join("\n");

    await editMessageText(env, chatId, messageId, rejectedText, []);
    await answerJobsCallback(env, cq.id, "❌ Відхилено");
    return json({ ok: true }, headers);
  }

  const existingMaster = await getMasterByTelegramId(env, app.telegram_id);

  if (existingMaster) {
    await env.DB.prepare(`
      UPDATE master_applications
      SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(appId).run();

    await answerJobsCallback(env, cq.id, "⚠️ Профіль майстра вже існує", true);
    return json({ ok: true }, headers);
  }

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO masters (
          telegram_id, username, first_name, phone,
          specializations, cities, status,
          application_id, joined_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP)
      `).bind(
        app.telegram_id,
        app.username || null,
        app.first_name || null,
        app.phone || null,
        app.specializations || null,
        app.city || null,
        app.id
      ),

      env.DB.prepare(`
        UPDATE master_applications
        SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(appId),
    ]);
  } catch (err) {
    console.error("Master approval failed:", err);
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Не вдалося створити профіль майстра",
      true
    );
    return json({ ok: true }, headers);
  }

  const invite = await createInviteForMaster(env, app.telegram_id);

  if (invite?.ok && invite.already_member) {
    await sendToMaster(env, app.telegram_id, [
      "✅ Вас прийнято до SA-MASTER Jobs!",
      "",
      "Ви вже перебуваєте у групі заявок.",
    ].join("\n"));
  } else if (invite?.ok && invite.invite_link) {
    await sendToMaster(
      env,
      app.telegram_id,
      [
        "✅ Вас прийнято до SA-MASTER Jobs!",
        "",
        invite.was_unbanned
          ? "Ваш попередній доступ до групи було відновлено."
          : "Приєднайтесь до групи майстрів.",
        "",
        "Натисніть кнопку нижче:",
      ].join("\n"),
      [[
        {
          text: "👥 Увійти в групу заявок",
          url: invite.invite_link,
        },
      ]]
    );
  } else {
    console.error("Master invite failed:", invite);

    await sendToMaster(env, app.telegram_id, [
      "✅ Вас прийнято до SA-MASTER Jobs!",
      "",
      "Не вдалося автоматично відновити доступ до групи.",
      "Зверніться до адміністратора.",
    ].join("\n"));
  }

  const approvedText = [
    "✅ АНКЕТУ ПРИЙНЯТО",
    `👤 ${app.first_name}`,
    `📞 ${app.phone}`,
    `🛠 ${app.specializations}`,
    `🏙 ${app.city}`,
    `📆 ${app.experience}`,
    `💬 ${app.about}`,
    `🆔 Telegram: ${app.telegram_id}`,
    "",
    `✅ Прийнято: ${now}`,
  ].join("\n");

  await editMessageText(env, chatId, messageId, approvedText, []);
  await answerJobsCallback(env, cq.id, "✅ Прийнято!");

  return json({ ok: true }, headers);
}

export async function createNewMasterInvite(env, telegramId) {
  const master = await getMasterByTelegramId(env, telegramId);

  if (!master) {
    return { ok: false, error: "MASTER_NOT_FOUND" };
  }

  if (master.status !== MASTER_STATUS.ACTIVE) {
    return {
      ok: false,
      error: "MASTER_NOT_ACTIVE",
      status: master.status,
    };
  }

  const result = await createInviteForMaster(env, telegramId);

  if (!result?.ok) {
    console.error("Create new master invite failed:", result);
    return {
      ok: false,
      error: "INVITE_CREATE_FAILED",
      description: result?.description || "",
    };
  }

  if (result.already_member) {
    await sendToMaster(
      env,
      master.telegram_id,
      "✅ Ви вже перебуваєте у групі SA-MASTER Jobs."
    );

    return {
      ok: true,
      already_member: true,
      master,
    };
  }

  await sendToMaster(
    env,
    master.telegram_id,
    [
      "🔗 НОВЕ ЗАПРОШЕННЯ",
      "",
      result.was_unbanned
        ? "Доступ до групи відновлено. Натисніть кнопку нижче."
        : "Натисніть кнопку нижче, щоб увійти до групи.",
    ].join("\n"),
    [[
      {
        text: "👥 Увійти в групу заявок",
        url: result.invite_link,
      },
    ]]
  );

  return {
    ok: true,
    already_member: false,
    master,
    invite_link: result.invite_link,
    was_unbanned: !!result.was_unbanned,
  };
}
