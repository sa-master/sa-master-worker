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
 * СТАН ДОСТУПУ МАЙСТРА ДО БОТА
 *
 * active   = майстер активний, бот доступний
 * inactive = майстер заблокував бота
 * blocked  = майстра заблокував адміністратор
 * ========================================================= */

function isBotBlockedByUser(result) {
  if (!result || result.ok) return false;

  const errorCode = Number(result.error_code || 0);
  const description = String(
    result.description || ""
  ).toLowerCase();

  /*
   * Не кожен 403 означає саме блокування користувачем.
   * Міняємо статус лише для відомих відповідей Telegram,
   * які означають, що приватний чат з ботом недоступний.
   */
  return (
    errorCode === 403 &&
    (
      description.includes("bot was blocked by the user") ||
      description.includes("user is deactivated")
    )
  );
}

async function markMasterInactive(env, telegramId) {
  if (!env?.DB || telegramId == null) return;

  try {
    const result = await env.DB.prepare(`
      UPDATE masters
      SET
        status = 'inactive',
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
        AND status = 'active'
    `)
      .bind(telegramId)
      .run();

    if (result.meta?.changes) {
      console.log(
        `Master ${telegramId} marked inactive: Jobs bot unavailable`
      );
    }
  } catch (err) {
    console.error(
      `Failed to mark master ${telegramId} inactive:`,
      err
    );
  }
}

async function processMasterDeliveryResult(
  env,
  chatId,
  result
) {
  if (isBotBlockedByUser(result)) {
    await markMasterInactive(
      env,
      chatId
    );
  }

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
        inline_keyboard: inlineKeyboard || [],
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
  return callJobsBot(
    env,
    "deleteMessage",
    {
      chat_id: chatId,
      message_id: messageId,
    }
  );
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
      callback_query_id: callbackQueryId,
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
 *
 * ReplyKeyboard залишається доступним майстру незалежно
 * від того, яке повідомлення зараз відкрите.
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
      text: "Меню SA-MASTER Jobs готове 👇",
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
