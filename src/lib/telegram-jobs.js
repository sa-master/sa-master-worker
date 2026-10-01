const TELEGRAM_API = "https://api.telegram.org";

function apiUrl(env, method) {
  return `${TELEGRAM_API}/bot${env.JOBS_BOT_TOKEN}/${method}`;
}

async function callJobsBot(env, method, payload = {}) {
  if (!env.JOBS_BOT_TOKEN) {
    return { ok: false, description: "JOBS_BOT_TOKEN не встановлено" };
  }

  try {
    const res = await fetch(apiUrl(env, method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    console.error(`Jobs bot ${method} error:`, err);

    return {
      ok: false,
      description: String(err?.message || err),
    };
  }
}

/* =========================================================
 * MASTER MESSAGES
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

  return callJobsBot(env, "sendMessage", payload);
}

export async function editMasterMessage(
  env,
  chatId,
  messageId,
  text,
  inlineKeyboard = null
) {
  return callJobsBot(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: inlineKeyboard || [],
    },
  });
}

export async function deleteMasterMessage(
  env,
  chatId,
  messageId
) {
  return callJobsBot(env, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

export async function answerJobsCallback(
  env,
  callbackQueryId,
  text = "",
  showAlert = false
) {
  return callJobsBot(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: !!showAlert,
  });
}

export async function getJobsBotInfo(env) {
  return callJobsBot(env, "getMe", {});
}

/* =========================================================
 * MASTER BOT AVAILABILITY
 * ========================================================= */

/*
 * Перевіряє, чи може Jobs-бот написати майстру.
 *
 * Використовується requests.js перед надсиланням/передачею
 * заявки майстру.
 */
export async function checkMasterBotAvailability(
  env,
  telegramId
) {
  if (!telegramId) {
    return {
      ok: false,
      available: false,
      description: "telegramId не вказано",
    };
  }

  const result = await callJobsBot(env, "getChat", {
    chat_id: telegramId,
  });

  return {
    ...result,
    available: Boolean(result?.ok),
  };
}

/*
 * Викликається jobs.js при повідомленні або callback від майстра.
 *
 * Сам факт отримання update від користувача означає, що він
 * відкрив/активував Jobs-бота. Функція залишена окремим export,
 * оскільки її використовує поточна логіка handlers/jobs.js.
 */
export async function activateMasterBot(
  env,
  telegramId
) {
  if (!telegramId) {
    return {
      ok: false,
      description: "telegramId не вказано",
    };
  }

  return {
    ok: true,
    telegram_id: telegramId,
  };
}

/* =========================================================
 * PERMANENT TELEGRAM CHAT MENU
 * ========================================================= */

/*
 * Це НЕ inline-кнопки під повідомленням.
 *
 * Це ReplyKeyboardMarkup — постійне меню внизу чату Telegram,
 * на місці звичайної клавіатури.
 *
 * Меню:
 *
 * ┌─────────────────┬──────────────┐
 * │ 🔧 Мої заявки   │ ➕ Передати  │
 * ├─────────────────┴──────────────┤
 * │ ❓ Допомога                    │
 * └────────────────────────────────┘
 *
 * Кнопки "📋 Заявки" тут немає.
 */
export async function setMasterMenu(
  env,
  chatId
) {
  if (!chatId) {
    return {
      ok: false,
      description: "chatId не вказано",
    };
  }

  return callJobsBot(env, "sendMessage", {
    chat_id: chatId,

    /*
     * Telegram API вимагає текст у sendMessage.
     * Це службове коротке повідомлення з'явиться лише тоді,
     * коли setMasterMenu() викликається (зараз — при /start
     * через sendHome()).
     */
    text: "Меню SA-MASTER Jobs готове 👇",

    disable_web_page_preview: true,

    reply_markup: {
      keyboard: [
        [
          {
            text: "🔧 Мої заявки",
          },
          {
            text: "➕ Передати",
          },
        ],
        [
          {
            text: "❓ Допомога",
          },
        ],
      ],

      resize_keyboard: true,

      /*
       * Не використовуємо one_time_keyboard.
       * Клавіатура має залишатися постійним меню чату.
       */
      is_persistent: true,

      input_field_placeholder: "Оберіть дію",
    },
  });
}
