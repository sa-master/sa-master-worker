import { json } from "../lib/json.js";
import {
  sendToMaster,
  answerJobsCallback,
} from "../lib/telegram-jobs.js";
import {
  sendMessageWithButtons,
  editMessageText,
} from "../lib/telegram.js";

const MASTER_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  BLOCKED: "blocked",
};

/* =========================================================
 * HELPERS
 * ========================================================= */

async function getMasterByTelegramId(env, telegramId) {
  return env.DB.prepare(`
    SELECT
      id,
      telegram_id,
      username,
      first_name,
      phone,
      specializations,
      cities,
      status,
      referral_token,
      application_id,
      joined_at
    FROM masters
    WHERE telegram_id = ?
    LIMIT 1
  `)
    .bind(telegramId)
    .first();
}

async function getLatestApplication(env, telegramId) {
  return env.DB.prepare(`
    SELECT *
    FROM master_applications
    WHERE telegram_id = ?
    ORDER BY id DESC
    LIMIT 1
  `)
    .bind(telegramId)
    .first();
}

/* =========================================================
 * ГОЛОВНЕ МЕНЮ МАЙСТРА
 * ========================================================= */

function buildMasterMenuButtons() {
  return [
    [
      {
        text: "📋 Доступні заявки",
        callback_data: "available_jobs",
      },
    ],
    [
      {
        text: "➕ Передати заявку",
        callback_data: "submit_request",
      },
    ],
  ];
}

async function sendActiveMasterMenu(env, chatId, master) {
  const name =
    master?.first_name
      ? `, ${master.first_name}`
      : "";

  await sendToMaster(
    env,
    chatId,
    [
      `👋 Вітаю${name}!`,
      "",
      "🔧 SA-MASTER Jobs",
      "",
      "Ваш профіль активний.",
      "",
      "📋 Переглядайте доступні заявки прямо в боті.",
      "🤝 Беріть у роботу ті, які вам підходять.",
      "🔒 Контакти замовника відкриваються після того, як ви берете заявку.",
      "➕ Передавайте заявки, які не можете виконати самі.",
      "",
      "Оберіть дію:",
    ].join("\n"),
    buildMasterMenuButtons()
  );
}

/* =========================================================
 * СТАТУС МАЙСТРА
 * ========================================================= */

async function sendMasterStatusMessage(
  env,
  chatId,
  master
) {
  if (!master) return false;

  if (master.status === MASTER_STATUS.ACTIVE) {
    await sendActiveMasterMenu(
      env,
      chatId,
      master
    );

    return true;
  }

  if (master.status === MASTER_STATUS.INACTIVE) {
    await sendToMaster(
      env,
      chatId,
      [
        "⚪ Ваш профіль SA-MASTER Jobs неактивний.",
        "",
        "Ваші дані та історія в системі збережені.",
        "",
        "Для відновлення доступу зверніться до адміністратора.",
      ].join("\n")
    );

    return true;
  }

  if (master.status === MASTER_STATUS.BLOCKED) {
    await sendToMaster(
      env,
      chatId,
      [
        "🚫 Ваш доступ до SA-MASTER Jobs заблоковано.",
        "",
        "Повторна реєстрація не змінює статус профілю.",
        "",
        "Якщо вважаєте, що це сталося помилково — зверніться до адміністратора.",
      ].join("\n")
    );

    return true;
  }

  await sendToMaster(
    env,
    chatId,
    [
      "⚠️ Ваш профіль уже існує в SA-MASTER Jobs.",
      "",
      "Зверніться до адміністратора для перевірки доступу.",
    ].join("\n")
  );

  return true;
}

/* =========================================================
 * ПОЧАТОК РЕЄСТРАЦІЇ
 * ========================================================= */

export async function handleJoinStart(
  env,
  headers,
  chatId,
  fromUser
) {
  const master =
    await getMasterByTelegramId(
      env,
      fromUser.id
    );

  if (master) {
    await sendMasterStatusMessage(
      env,
      chatId,
      master
    );

    return json(
      { ok: true },
      headers
    );
  }

  const existing =
    await getLatestApplication(
      env,
      fromUser.id
    );

  if (existing?.status === "pending") {
    await sendToMaster(
      env,
      chatId,
      [
        "⏳ Ваша анкета вже на розгляді.",
        "",
        "Зачекайте, будь ласка.",
        "Після схвалення бот повідомить вас автоматично.",
      ].join("\n")
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (existing?.status === "draft") {
    await sendToMaster(
      env,
      chatId,
      [
        "📝 У вас уже є незавершена анкета.",
        "",
        "Продовжимо з місця, на якому ви зупинились.",
      ].join("\n")
    );

    if (
      !existing.phone &&
      (
        !existing.first_name ||
        existing.first_name ===
          fromUser.first_name
      )
    ) {
      await sendToMaster(
        env,
        chatId,
        "Як до вас звертатися? (Ваше ім'я)"
      );
    } else if (!existing.phone) {
      await sendToMaster(
        env,
        chatId,
        "📞 Ваш телефон?"
      );
    } else if (!existing.specializations) {
      await sendToMaster(
        env,
        chatId,
        [
          "🛠 Яка ваша спеціалізація?",
          "",
          "Напишіть:",
          "• сантехніка",
          "• електрика",
          "• універсал",
        ].join("\n")
      );
    } else if (!existing.city) {
      await sendToMaster(
        env,
        chatId,
        "🏙 Ваше місто? (Київ / інше)"
      );
    } else if (!existing.experience) {
      await sendToMaster(
        env,
        chatId,
        "📆 Скільки років досвіду?"
      );
    } else if (!existing.about) {
      await sendToMaster(
        env,
        chatId,
        "💬 Коротко про себе (1–2 речення):"
      );
    }

    return json(
      { ok: true },
      headers
    );
  }

  await env.DB.prepare(`
    INSERT INTO master_applications (
      telegram_id,
      username,
      first_name,
      status
    )
    VALUES (?, ?, ?, 'draft')
  `)
    .bind(
      fromUser.id,
      fromUser.username || null,
      fromUser.first_name || null
    )
    .run();

  await sendToMaster(
    env,
    chatId,
    [
      "👋 Вітаю!",
      "",
      "🔧 SA-MASTER Jobs",
      "",
      "Для доступу до заявок потрібно пройти коротку реєстрацію.",
      "",
      "Після перевірки анкети ви зможете:",
      "",
      "📋 переглядати доступні заявки",
      "🤝 брати заявки в роботу",
      "📞 отримувати контакти замовника після взяття заявки",
      "➕ передавати власні заявки",
      "",
      "Почнемо.",
      "",
      "Як до вас звертатися? (Ваше ім'я)",
    ].join("\n")
  );

  return json(
    { ok: true },
    headers
  );
}

/* =========================================================
 * ЗАПОВНЕННЯ АНКЕТИ
 * ========================================================= */

export async function handleJoinMessage(
  env,
  headers,
  chatId,
  fromUser,
  text
) {
  const master =
    await getMasterByTelegramId(
      env,
      fromUser.id
    );

  if (master) {
    return json(
      { ok: true },
      headers
    );
  }

  const app =
    await env.DB.prepare(`
      SELECT *
      FROM master_applications
      WHERE telegram_id = ?
        AND status = 'draft'
      ORDER BY id DESC
      LIMIT 1
    `)
      .bind(fromUser.id)
      .first();

  if (!app) {
    return json(
      { ok: false },
      headers
    );
  }

  /* -------------------------------------------------------
   * ІМ'Я
   * ----------------------------------------------------- */

  if (
    !app.phone &&
    (
      !app.first_name ||
      app.first_name ===
        fromUser.first_name
    )
  ) {
    const firstName =
      String(text || "").trim();

    if (firstName.length < 2) {
      await sendToMaster(
        env,
        chatId,
        "❌ Введіть, будь ласка, ваше ім'я."
      );

      return json(
        { ok: true },
        headers
      );
    }

    await env.DB.prepare(`
      UPDATE master_applications
      SET first_name = ?
      WHERE id = ?
    `)
      .bind(
        firstName,
        app.id
      )
      .run();

    await sendToMaster(
      env,
      chatId,
      "📞 Ваш телефон?"
    );

    return json(
      { ok: true },
      headers
    );
  }

  /* -------------------------------------------------------
   * ТЕЛЕФОН
   * ----------------------------------------------------- */

  if (!app.phone) {
    const digits =
      String(text || "")
        .replace(/\D/g, "");

    if (digits.length < 9) {
      await sendToMaster(
        env,
        chatId,
        [
          "❌ Схоже, це не номер телефону.",
          "",
          "Введіть ще раз.",
          "Наприклад: +380XXXXXXXXX",
        ].join("\n")
      );

      return json(
        { ok: true },
        headers
      );
    }

    await env.DB.prepare(`
      UPDATE master_applications
      SET phone = ?
      WHERE id = ?
    `)
      .bind(
        String(text).trim(),
        app.id
      )
      .run();

    await sendToMaster(
      env,
      chatId,
      [
        "🛠 Яка ваша спеціалізація?",
        "",
        "Напишіть:",
        "• сантехніка",
        "• електрика",
        "• універсал",
      ].join("\n")
    );

    return json(
      { ok: true },
      headers
    );
  }

  /* -------------------------------------------------------
   * СПЕЦІАЛІЗАЦІЯ
   * ----------------------------------------------------- */

  if (!app.specializations) {
    const lower =
      String(text || "")
        .toLowerCase()
        .trim();

    let spec = "";

    if (
      lower.includes("сант") ||
      lower.includes("plumb")
    ) {
      spec = "Сантехніка";
    } else if (
      lower.includes("елект") ||
      lower.includes("electric")
    ) {
      spec = "Електрика";
    } else if (
      lower.includes("універс") ||
      lower.includes("universal")
    ) {
      spec = "Універсал";
    } else {
      await sendToMaster(
        env,
        chatId,
        [
          "❌ Не зрозумів спеціалізацію.",
          "",
          "Напишіть:",
          "• сантехніка",
          "• електрика",
          "• універсал",
        ].join("\n")
      );

      return json(
        { ok: true },
        headers
      );
    }

    await env.DB.prepare(`
      UPDATE master_applications
      SET specializations = ?
      WHERE id = ?
    `)
      .bind(
        spec,
        app.id
      )
      .run();

    await sendToMaster(
      env,
      chatId,
      "🏙 Ваше місто? (Київ / інше)"
    );

    return json(
      { ok: true },
      headers
    );
  }

  /* -------------------------------------------------------
   * МІСТО
   * ----------------------------------------------------- */

  if (!app.city) {
    const city =
      String(text || "").trim();

    if (!city) {
      await sendToMaster(
        env,
        chatId,
        "❌ Вкажіть ваше місто."
      );

      return json(
        { ok: true },
        headers
      );
    }

    await env.DB.prepare(`
      UPDATE master_applications
      SET city = ?
      WHERE id = ?
    `)
      .bind(
        city,
        app.id
      )
      .run();

    await sendToMaster(
      env,
      chatId,
      "📆 Скільки років досвіду?"
    );

    return json(
      { ok: true },
      headers
    );
  }

  /* -------------------------------------------------------
   * ДОСВІД
   * ----------------------------------------------------- */

  if (!app.experience) {
    const experience =
      String(text || "").trim();

    if (!experience) {
      await sendToMaster(
        env,
        chatId,
        "❌ Вкажіть ваш досвід роботи."
      );

      return json(
        { ok: true },
        headers
      );
    }

    await env.DB.prepare(`
      UPDATE master_applications
      SET experience = ?
      WHERE id = ?
    `)
      .bind(
        experience,
        app.id
      )
      .run();

    await sendToMaster(
      env,
      chatId,
      "💬 Коротко про себе (1–2 речення):"
    );

    return json(
      { ok: true },
      headers
    );
  }

  /* -------------------------------------------------------
   * ПРО СЕБЕ + ВІДПРАВКА АНКЕТИ
   * ----------------------------------------------------- */

  if (!app.about) {
    const about =
      String(text || "").trim();

    if (about.length < 3) {
      await sendToMaster(
        env,
        chatId,
        "❌ Напишіть кілька слів про себе."
      );

      return json(
        { ok: true },
        headers
      );
    }

    await env.DB.prepare(`
      UPDATE master_applications
      SET
        about = ?,
        status = 'pending'
      WHERE id = ?
    `)
      .bind(
        about,
        app.id
      )
      .run();

    await sendToMaster(
      env,
      chatId,
      [
        "✅ Дякую!",
        "",
        "Анкету надіслано на розгляд.",
        "",
        "Після перевірки ви отримаєте повідомлення прямо в цьому боті.",
      ].join("\n")
    );

    const appFull =
      await env.DB.prepare(`
        SELECT *
        FROM master_applications
        WHERE id = ?
        LIMIT 1
      `)
        .bind(app.id)
        .first();

    const adminText = [
      "🆕 НОВА АНКЕТА МАЙСТРА",
      "",
      `👤 ${appFull.first_name || "—"}`,
      `📞 ${appFull.phone || "—"}`,
      `🛠 ${appFull.specializations || "—"}`,
      `🏙 ${appFull.city || "—"}`,
      `📆 Досвід: ${appFull.experience || "—"}`,
      `💬 ${appFull.about || "—"}`,
      "",
      `🆔 Telegram: ${appFull.telegram_id}`,
      appFull.username
        ? `🔗 @${appFull.username}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const adminButtons = [
      [
        {
          text: "✅ Прийняти",
          callback_data:
            `app_approve:${app.id}`,
        },
        {
          text: "❌ Відхилити",
          callback_data:
            `app_reject:${app.id}`,
        },
      ],
    ];

    await sendMessageWithButtons(
      env,
      adminText,
      adminButtons
    );

    return json(
      { ok: true },
      headers
    );
  }

  return json(
    { ok: true },
    headers
  );
}

/* =========================================================
 * РОЗГЛЯД АНКЕТИ АДМІНІСТРАТОРОМ
 * ========================================================= */

export async function handleApplicationReview(
  env,
  headers,
  appId,
  action,
  cq
) {
  const app =
    await env.DB.prepare(`
      SELECT *
      FROM master_applications
      WHERE id = ?
      LIMIT 1
    `)
      .bind(appId)
      .first();

  if (!app) {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Анкету не знайдено",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (app.status !== "pending") {
    await answerJobsCallback(
      env,
      cq.id,
      `⚠️ Вже оброблено: ${app.status}`,
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const chatId =
    cq.message?.chat?.id;

  const messageId =
    cq.message?.message_id;

  const now =
    new Date().toLocaleString(
      "uk-UA",
      {
        timeZone: "Europe/Kyiv",
      }
    );

  /* -------------------------------------------------------
   * ВІДХИЛИТИ
   * ----------------------------------------------------- */

  if (action === "reject") {
    await env.DB.prepare(`
      UPDATE master_applications
      SET
        status = 'rejected',
        reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
      .bind(appId)
      .run();

    await sendToMaster(
      env,
      app.telegram_id,
      [
        "❌ На жаль, вашу анкету не схвалено.",
        "",
        "Дякуємо за інтерес до SA-MASTER Jobs.",
      ].join("\n")
    );

    const rejectedText = [
      "❌ АНКЕТУ ВІДХИЛЕНО",
      "",
      `👤 ${app.first_name || "—"}`,
      `📞 ${app.phone || "—"}`,
      `🛠 ${app.specializations || "—"}`,
      `🏙 ${app.city || "—"}`,
      `📆 ${app.experience || "—"}`,
      `💬 ${app.about || "—"}`,
      `🆔 Telegram: ${app.telegram_id}`,
      "",
      `❌ Відхилено: ${now}`,
    ].join("\n");

    if (
      chatId != null &&
      messageId != null
    ) {
      await editMessageText(
        env,
        chatId,
        messageId,
        rejectedText,
        []
      );
    }

    await answerJobsCallback(
      env,
      cq.id,
      "❌ Відхилено"
    );

    return json(
      { ok: true },
      headers
    );
  }

  /* -------------------------------------------------------
   * ПРИЙНЯТИ
   * ----------------------------------------------------- */

  if (action !== "approve") {
    await answerJobsCallback(
      env,
      cq.id,
      "❓ Невідома дія",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const existingMaster =
    await getMasterByTelegramId(
      env,
      app.telegram_id
    );

  if (existingMaster) {
    await env.DB.prepare(`
      UPDATE master_applications
      SET
        status = 'approved',
        reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
      .bind(appId)
      .run();

    await answerJobsCallback(
      env,
      cq.id,
      "⚠️ Профіль майстра вже існує",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO masters (
          telegram_id,
          username,
          first_name,
          phone,
          specializations,
          cities,
          status,
          application_id,
          joined_at
        )
        VALUES (
          ?, ?, ?, ?, ?, ?,
          'active',
          ?,
          CURRENT_TIMESTAMP
        )
      `)
        .bind(
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
        SET
          status = 'approved',
          reviewed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
        .bind(appId),
    ]);
  } catch (err) {
    console.error(
      "Master approval failed:",
      err
    );

    await answerJobsCallback(
      env,
      cq.id,
      "❌ Не вдалося створити профіль майстра",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const master =
    await getMasterByTelegramId(
      env,
      app.telegram_id
    );

  /* -------------------------------------------------------
   * ПОВІДОМЛЕННЯ МАЙСТРУ
   * ----------------------------------------------------- */

  await sendToMaster(
    env,
    app.telegram_id,
    [
      "✅ ВАС ПРИЙНЯТО ДО SA-MASTER Jobs!",
      "",
      "Ваш профіль активовано.",
      "",
      "Тепер ви можете:",
      "",
      "📋 переглядати доступні заявки прямо в боті",
      "🤝 брати заявки, які вам підходять",
      "📞 отримувати контакти клієнта після взяття заявки",
      "➕ передавати власні заявки",
      "",
      "Номер телефону замовника не показується іншим майстрам, доки заявку не взято в роботу.",
      "",
      "Оберіть дію:",
    ].join("\n"),
    buildMasterMenuButtons()
  );

  /* -------------------------------------------------------
   * ОНОВЛЕННЯ АДМІНСЬКОГО ПОВІДОМЛЕННЯ
   * ----------------------------------------------------- */

  const approvedText = [
    "✅ АНКЕТУ ПРИЙНЯТО",
    "",
    `👤 ${app.first_name || "—"}`,
    `📞 ${app.phone || "—"}`,
    `🛠 ${app.specializations || "—"}`,
    `🏙 ${app.city || "—"}`,
    `📆 ${app.experience || "—"}`,
    `💬 ${app.about || "—"}`,
    `🆔 Telegram: ${app.telegram_id}`,
    "",
    `✅ Прийнято: ${now}`,
    "",
    "🤖 Доступ до заявок через бот активовано.",
  ].join("\n");

  if (
    chatId != null &&
    messageId != null
  ) {
    await editMessageText(
      env,
      chatId,
      messageId,
      approvedText,
      []
    );
  }

  await answerJobsCallback(
    env,
    cq.id,
    "✅ Прийнято!"
  );

  return json(
    {
      ok: true,
      master_id:
        master?.id || null,
    },
    headers
  );
}

/* =========================================================
 * СУМІСНІСТЬ ЗІ СТАРИМ КОДОМ
 *
 * Старий jobs.js міг імпортувати createNewMasterInvite().
 * Групи більше немає, тому замість invite показуємо меню.
 * Після повної заміни jobs.js цю функцію можна буде видалити.
 * ========================================================= */

export async function createNewMasterInvite(
  env,
  telegramId
) {
  const master =
    await getMasterByTelegramId(
      env,
      telegramId
    );

  if (!master) {
    return {
      ok: false,
      error: "MASTER_NOT_FOUND",
    };
  }

  if (
    master.status !==
    MASTER_STATUS.ACTIVE
  ) {
    return {
      ok: false,
      error: "MASTER_NOT_ACTIVE",
      status: master.status,
    };
  }

  await sendActiveMasterMenu(
    env,
    master.telegram_id,
    master
  );

  return {
    ok: true,
    master,
    bot_mode: true,
  };
}