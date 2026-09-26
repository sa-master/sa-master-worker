const TELEGRAM_API = "https://api.telegram.org";

function apiUrl(env, method) {
  return `${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`;
}

async function callTelegram(env, method, payload) {
  if (!env.BOT_TOKEN) return { ok: false, description: "BOT_TOKEN не встановлено" };
  try {
    const res = await fetch(apiUrl(env, method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) console.error(`Telegram ${method} failed:`, data.description || data);
    return data;
  } catch (err) {
    console.error(`Telegram ${method} error:`, err);
    return { ok: false, description: String(err?.message || err) };
  }
}

export async function sendTelegram(env, text) {
  if (!env.CHAT_ID) return { ok: false, description: "CHAT_ID не встановлено" };
  return callTelegram(env, "sendMessage", {
    chat_id: env.CHAT_ID, text, disable_web_page_preview: true,
  });
}

export async function sendMessageWithButtons(env, text, inlineKeyboard) {
  if (!env.CHAT_ID) return { ok: false, description: "CHAT_ID не встановлено" };
  const payload = { chat_id: env.CHAT_ID, text, disable_web_page_preview: true };
  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };
  return callTelegram(env, "sendMessage", payload);
}

export async function editMessageText(env, chatId, messageId, text, inlineKeyboard) {
  const payload = { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true };
  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };
  return callTelegram(env, "editMessageText", payload);
}

export async function answerCallbackQuery(env, callbackQueryId, text, showAlert = false) {
  return callTelegram(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId, text: text || "", show_alert: !!showAlert,
  });
}

/* Надсилає прикріплений клієнтом проєкт прямо в робочий чат Telegram. */
export async function sendTelegramDocument(env, { name, fileType, bytes, caption }) {
  if (!env.BOT_TOKEN || !env.CHAT_ID) {
    return { ok: false, description: "BOT_TOKEN або CHAT_ID не встановлено" };
  }
  try {
    const form = new FormData();
    form.set("chat_id", String(env.CHAT_ID));
    form.set("caption", caption || "📎 Файл");
    form.set("document", new Blob([bytes], { type: fileType || "application/octet-stream" }), name || "project");
    const res = await fetch(apiUrl(env, "sendDocument"), { method: "POST", body: form });
    const data = await res.json();
    if (!data.ok) console.error("Telegram sendDocument failed:", data.description || data);
    return data;
  } catch (err) {
    console.error("Telegram sendDocument error:", err);
    return { ok: false, description: String(err?.message || err) };
  }
}
