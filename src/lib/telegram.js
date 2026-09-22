const TELEGRAM_API = "https://api.telegram.org";

function apiUrl(env, method) {
  return `${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`;
}

/* Базовий надсилач — повертає { ok, result, description } */
async function callTelegram(env, method, payload) {
  if (!env.BOT_TOKEN) {
    return { ok: false, description: "BOT_TOKEN не встановлено" };
  }
  try {
    const res = await fetch(apiUrl(env, method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`Telegram ${method} failed:`, data.description || data);
    }
    return data;
  } catch (err) {
    console.error(`Telegram ${method} error:`, err);
    return { ok: false, description: String(err?.message || err) };
  }
}

/* Просте текстове повідомлення */
export async function sendTelegram(env, text) {
  if (!env.CHAT_ID) return { ok: false, description: "CHAT_ID не встановлено" };
  return callTelegram(env, "sendMessage", {
    chat_id: env.CHAT_ID,
    text,
    disable_web_page_preview: true,
  });
}

/* Повідомлення з inline-кнопками */
export async function sendMessageWithButtons(env, text, inlineKeyboard) {
  if (!env.CHAT_ID) return { ok: false, description: "CHAT_ID не встановлено" };
  return callTelegram(env, "sendMessage", {
    chat_id: env.CHAT_ID,
    text,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

/* Редагувати існуюче повідомлення (текст + кнопки) */
export async function editMessageText(env, chatId, messageId, text, inlineKeyboard) {
  return callTelegram(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
  });
}

/* Відповідь на натискання кнопки (щоб Telegram прибрав «годинник») */
export async function answerCallbackQuery(env, callbackQueryId, text, showAlert = false) {
  return callTelegram(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || "",
    show_alert: !!showAlert,
  });
}