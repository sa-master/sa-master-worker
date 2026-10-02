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
    if (!data.ok) console.error(`Jobs bot ${method} failed:`, data.description || data);
    return data;
  } catch (err) {
    console.error(`Jobs bot ${method} error:`, err);
    return { ok: false, description: String(err?.message || err) };
  }
}

async function ensureMasterUiStateTable(env) {
  if (!env?.DB) return;

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS master_ui_state (
      chat_id TEXT PRIMARY KEY,
      transient_message_id INTEGER,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function rememberMasterUiMessage(env, chatId, result) {
  const messageId = result?.result?.message_id;

  if (!env?.DB || chatId == null || messageId == null) {
    return result;
  }

  try {
    await ensureMasterUiStateTable(env);

    await env.DB.prepare(`
      INSERT INTO master_ui_state (
        chat_id,
        transient_message_id,
        updated_at
      )
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id)
      DO UPDATE SET
        transient_message_id = excluded.transient_message_id,
        updated_at = CURRENT_TIMESTAMP
    `).bind(String(chatId), Number(messageId)).run();
  } catch (err) {
    console.error("Remember master UI message failed:", err);
  }

  return result;
}

export async function sendToMaster(env, chatId, text, inlineKeyboard = null) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };

  if (inlineKeyboard) {
    payload.reply_markup = { inline_keyboard: inlineKeyboard };
  }

  return callJobsBot(env, "sendMessage", payload);
}

export async function editMasterMessage(env, chatId, messageId, text, inlineKeyboard = null) {
  return callJobsBot(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: inlineKeyboard || [] },
  });
}

export async function deleteMasterMessage(env, chatId, messageId) {
  return callJobsBot(env, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

export async function answerJobsCallback(env, callbackQueryId, text = "", showAlert = false) {
  return callJobsBot(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: !!showAlert,
  });
}

export async function getJobsBotInfo(env) {
  return callJobsBot(env, "getMe", {});
}

export async function checkMasterBotAvailability(env, telegramId) {
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

export async function activateMasterBot(env, telegramId) {
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

export async function setMasterMenu(env, chatId, referralUrl = null, text = "🔧 SA-MASTER Jobs") {
  if (!chatId) {
    return { ok: false, description: "chatId не вказано" };
  }

  const transferButton = referralUrl
    ? { text: "➕ Передати", web_app: { url: referralUrl } }
    : { text: "➕ Передати" };

  const result = await callJobsBot(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: {
      keyboard: [
        [
          { text: "🔧 Мої заявки" },
          transferButton,
        ],
        [
          { text: "❓ Допомога" },
        ],
      ],
      resize_keyboard: true,
      is_persistent: true,
      input_field_placeholder: "Оберіть дію",
    },
  });

  return rememberMasterUiMessage(env, chatId, result);
}

export async function removeMasterMenu(
  env,
  chatId,
  text = "ℹ️ Ваш профіль SA-MASTER Jobs видалено."
) {
  if (!chatId) {
    return { ok: false, description: "chatId не вказано" };
  }

  return callJobsBot(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: {
      remove_keyboard: true,
    },
  });
}

export async function sendFileToJobsGroup(env, { name, fileType, bytes, caption = "" }) {
  if (!env.JOBS_BOT_TOKEN || !env.JOBS_CHAT_ID) {
    return { ok: false, description: "JOBS_BOT_TOKEN або JOBS_CHAT_ID не встановлено" };
  }

  try {
    const form = new FormData();
    form.append("chat_id", String(env.JOBS_CHAT_ID));
    form.append("caption", caption);
    form.append("document", new Blob([bytes], { type: fileType || "application/octet-stream" }), name || "file");

    const res = await fetch(`${TELEGRAM_API}/bot${env.JOBS_BOT_TOKEN}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    if (!data.ok) console.error("Jobs bot sendDocument failed:", data.description || data);
    return data;
  } catch (err) {
    console.error("Jobs bot sendDocument error:", err);
    return { ok: false, description: String(err?.message || err) };
  }
}

export async function sendFileToMaster(env, chatId, { name, fileType, bytes, caption = "" }) {
  if (!env.JOBS_BOT_TOKEN || !chatId) {
    return { ok: false, description: "JOBS_BOT_TOKEN або chatId не встановлено" };
  }

  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption);
    form.append(
      "document",
      new Blob([bytes], { type: fileType || "application/octet-stream" }),
      name || "file"
    );

    const res = await fetch(`${TELEGRAM_API}/bot${env.JOBS_BOT_TOKEN}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    if (!data.ok) console.error("Jobs bot sendDocument to master failed:", data.description || data);
    return data;
  } catch (err) {
    console.error("Jobs bot sendDocument to master error:", err);
    return { ok: false, description: String(err?.message || err) };
  }
}

export async function getJobsChatMember(env, telegramId) {
  if (!env.JOBS_CHAT_ID) {
    return { ok: false, description: "JOBS_CHAT_ID не встановлено" };
  }
  if (!telegramId) {
    return { ok: false, description: "telegramId не вказано" };
  }

  return callJobsBot(env, "getChatMember", {
    chat_id: env.JOBS_CHAT_ID,
    user_id: telegramId,
  });
}

export async function banMasterFromJobsGroup(env, telegramId) {
  if (!env.JOBS_CHAT_ID) {
    return { ok: false, description: "JOBS_CHAT_ID не встановлено" };
  }
  if (!telegramId) {
    return { ok: false, description: "telegramId не вказано" };
  }

  return callJobsBot(env, "banChatMember", {
    chat_id: env.JOBS_CHAT_ID,
    user_id: telegramId,
    revoke_messages: false,
  });
}

export async function unbanMasterFromJobsGroup(env, telegramId) {
  if (!env.JOBS_CHAT_ID) {
    return { ok: false, description: "JOBS_CHAT_ID не встановлено" };
  }
  if (!telegramId) {
    return { ok: false, description: "telegramId не вказано" };
  }

  return callJobsBot(env, "unbanChatMember", {
    chat_id: env.JOBS_CHAT_ID,
    user_id: telegramId,
    only_if_banned: true,
  });
}
