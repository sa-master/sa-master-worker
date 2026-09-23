const TELEGRAM_API = "https://api.telegram.org";

function apiUrl(env, method) {
  return `${TELEGRAM_API}/bot${env.JOBS_BOT_TOKEN}/${method}`;
}

async function callJobsBot(env, method, payload) {
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
      console.error(`Jobs bot ${method} failed:`, data.description || data);
    }
    return data;
  } catch (err) {
    console.error(`Jobs bot ${method} error:`, err);
    return { ok: false, description: String(err?.message || err) };
  }
}

/* Відправити в групу майстрів */
export async function sendToJobsGroup(env, text, inlineKeyboard, threadId) {
  if (!env.JOBS_CHAT_ID) {
    return { ok: false, description: "JOBS_CHAT_ID не встановлено" };
  }
  const payload = {
    chat_id: env.JOBS_CHAT_ID,
    text,
    disable_web_page_preview: true,
  };
  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };
  if (threadId) payload.message_thread_id = threadId;

  return callJobsBot(env, "sendMessage", payload);
}

/* Оновити повідомлення в групі */
export async function editJobsMessage(env, messageId, text, inlineKeyboard) {
  const payload = {
    chat_id: env.JOBS_CHAT_ID,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  };
  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };

  return callJobsBot(env, "editMessageText", payload);
}

/* Відповісти на callback у групі */
export async function answerJobsCallback(env, callbackQueryId, text, showAlert = false) {
  return callJobsBot(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || "",
    show_alert: !!showAlert,
  });
}

/* Надіслати в приватний чат майстру (з опціональними кнопками) */
export async function sendToMaster(env, chatId, text, inlineKeyboard) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };

  return callJobsBot(env, "sendMessage", payload);
}
