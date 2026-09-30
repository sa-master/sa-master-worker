const TELEGRAM_API = "https://api.telegram.org";

/* =========================================================
 * Telegram API
 * ========================================================= */

function apiUrl(env, method) {
  return `${TELEGRAM_API}/bot${env.JOBS_BOT_TOKEN}/${method}`;
}

async function callJobsBot(env, method, payload = {}) {
  if (!env.JOBS_BOT_TOKEN) {
    return {
      ok: false,
      description: "JOBS_BOT_TOKEN не встановлено",
    };
  }

  try {
    const res = await fetch(
      apiUrl(env, method),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

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
      description: String(
        err?.message || err
      ),
    };
  }
}

/* =========================================================
 * Надіслати повідомлення майстру
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

  return callJobsBot(
    env,
    "sendMessage",
    payload
  );
}

/* =========================================================
 * Редагувати повідомлення майстра
 * ========================================================= */

export async function editMasterMessage(
  env,
  chatId,
  messageId,
  text,
  inlineKeyboard = null
) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard:
        inlineKeyboard || [],
    },
  };

  return callJobsBot(
    env,
    "editMessageText",
    payload
  );
}

/* =========================================================
 * Видалити повідомлення
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
 * Відповідь на callback-кнопку
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
 * Перевірка Jobs Bot
 * ========================================================= */

export async function getJobsBotInfo(env) {
  return callJobsBot(
    env,
    "getMe",
    {}
  );
}