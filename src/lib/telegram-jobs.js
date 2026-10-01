const TELEGRAM_API = "https://api.telegram.org";

function apiUrl(env, method) {
  return `${TELEGRAM_API}/bot${env.JOBS_BOT_TOKEN}/${method}`;
}

/* =========================================================
 * TELEGRAM API
 * ========================================================= */

async function callJobsBot(env, method, payload = {}) {
  if (!env.JOBS_BOT_TOKEN) {
    return {
      ok: false,
      description: "JOBS_BOT_TOKEN не встановлено",
    };
  }

  try {
    const res = await fetch(apiUrl(env, method), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!data.ok) {
      console.error(
        `Jobs bot ${method} failed:`,
        data.description || data
      );
    }

    return data;
  } catch (err) {
    console.error(
      `Jobs bot ${method} error:`,
      err
    );

    return {
      ok: false,
      description: String(err?.message || err),
    };
  }
}

/* =========================================================
 * TELEGRAM-ДОСТУПНІСТЬ МАЙСТРА
 *
 * masters.status:
 *   active   = активний у SA-MASTER Jobs
 *   inactive = профіль деактивований адміністратором
 *   blocked  = профіль заблокований адміністратором
 *
 * masters.bot_status:
 *   unknown     = ще не перевірено
 *   available   = бот може зв'язатися з майстром
 *   unavailable = Telegram не дозволяє зв'язатися
 *
 * ВАЖЛИВО:
 * Telegram-доступність НЕ змінює masters.status.
 * ========================================================= */

function isMasterTelegramUnavailable(result) {
  if (!result || result.ok) {
    return false;
  }

  const errorCode = Number(
    result.error_code || 0
  );

  const description = String(
    result.description || ""
  ).toLowerCase();

  /*
   * Фіксуємо unavailable лише для відповідей,
   * які дійсно означають недоступність приватного
   * чату з користувачем.
   */
  if (errorCode === 403) {
    return (
      description.includes(
        "bot was blocked by the user"
      ) ||
      description.includes(
        "user is deactivated"
      ) ||
      description.includes(
        "bot can't initiate conversation with a user"
      )
    );
  }

  /*
   * Telegram іноді повертає 400 для чату,
   * який більше недоступний.
   */
  if (errorCode === 400) {
    return (
      description.includes("chat not found")
    );
  }

  return false;
}

/* =========================================================
 * ЗАПИС BOT STATUS
 * ========================================================= */

async function setMasterBotStatus(
  env,
  telegramId,
  botStatus
) {
  if (
    !env?.DB ||
    telegramId == null ||
    !["available", "unavailable"].includes(botStatus)
  ) {
    return;
  }

  try {
    const result = await env.DB.prepare(`
      UPDATE masters
      SET
        bot_status = ?,
        bot_status_checked_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
    `)
      .bind(
        botStatus,
        telegramId
      )
      .run();

    if (result.meta?.changes) {
      console.log(
        `Master ${telegramId} bot_status -> ${botStatus}`
      );
    }
  } catch (err) {
    console.error(
      `Failed to update bot_status for master ${telegramId}:`,
      err
    );
  }
}

/* =========================================================
 * ОБРОБКА РЕЗУЛЬТАТУ ДОСТАВКИ
 * ========================================================= */

async function processMasterDeliveryResult(
  env,
  chatId,
  result
) {
  /*
   * Успішна доставка означає, що приватний
   * чат із майстром доступний.
   */
  if (result?.ok) {
    await setMasterBotStatus(
      env,
      chatId,
      "available"
    );

    return result;
  }

  /*
   * Відомі Telegram-помилки недоступності.
   */
  if (isMasterTelegramUnavailable(result)) {
    await setMasterBotStatus(
      env,
      chatId,
      "unavailable"
    );
  }

  /*
   * Інші помилки (мережа, Telegram API,
   * неправильний payload тощо) статус майстра
   * не змінюють.
   */
  return result;
}

/* =========================================================
 * ПОВІДОМЛЕННЯ МАЙСТРУ
 * ========================================================= */

export async function sendToMaster(
  env,
  chatId,
  text,
  inlineKeyboard = null
) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };

  if (inlineKeyboard) {
    payload.reply_markup = {
      inline_keyboard: inlineKeyboard,
    };
  }

  const result = await callJobsBot(
    env,
    "sendMessage",
    payload
  );

  return processMasterDeliveryResult(
    env,
    chatId,
    result
  );
}

/* =========================================================
 * РЕДАГУВАННЯ ПОВІДОМЛЕННЯ МАЙСТРА
 * ========================================================= */

export async function editMasterMessage(
  env,
  chatId,
  messageId,
  text,
  inlineKeyboard = null
) {
  const result = await callJobsBot(
    env,
    "editMessageText",
    {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard:
          inlineKeyboard || [],
      },
    }
  );

  return processMasterDeliveryResult(
    env,
    chatId,
    result
  );
}

/* =========================================================
 * ВИДАЛЕННЯ ПОВІДОМЛЕННЯ
 * ========================================================= */

export async function deleteMasterMessage(
  env,
  chatId,
  messageId
) {
  const result = await callJobsBot(
    env,
    "deleteMessage",
    {
      chat_id: chatId,
      message_id: messageId,
    }
  );

  /*
   * deleteMessage не використовуємо як доказ
   * available, оскільки помилка може стосуватися
   * самого повідомлення.
   *
   * Але явне блокування бота можемо зафіксувати.
   */
  if (isMasterTelegramUnavailable(result)) {
    await setMasterBotStatus(
      env,
      chatId,
      "unavailable"
    );
  }

  return result;
}

/* =========================================================
 * CALLBACK QUERY
 * ========================================================= */

export async function answerJobsCallback(
  env,
  callbackQueryId,
  text = "",
  showAlert = false
) {
  return callJobsBot(
    env,
    "answerCallbackQuery",
    {
      callback_query_id:
        callbackQueryId,
      text,
      show_alert: !!showAlert,
    }
  );
}

/* =========================================================
 * BOT INFO
 * ========================================================= */

export async function getJobsBotInfo(env) {
  return callJobsBot(
    env,
    "getMe",
    {}
  );
}

/* =========================================================
 * ПОСТІЙНЕ НИЖНЄ МЕНЮ TELEGRAM
 * ========================================================= */

export async function setMasterMenu(
  env,
  chatId
) {
  const result = await callJobsBot(
    env,
    "sendMessage",
    {
      chat_id: chatId,
      text:
        "Меню SA-MASTER Jobs готове 👇",
      disable_web_page_preview: true,

      reply_markup: {
        keyboard: [
          [
            {
              text: "📋 Заявки",
            },
            {
              text: "🔧 Мої заявки",
            },
          ],
          [
            {
              text: "➕ Передати",
            },
            {
              text: "❓ Допомога",
            },
          ],
        ],

        resize_keyboard: true,
        is_persistent: true,

        input_field_placeholder:
          "Оберіть дію",
      },
    }
  );

  return processMasterDeliveryResult(
    env,
    chatId,
    result
  );
}