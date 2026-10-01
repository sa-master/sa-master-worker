const TELEGRAM_API = "https://api.telegram.org";

function apiUrl(env, method) {
  return `${TELEGRAM_API}/bot${env.JOBS_BOT_TOKEN}/${method}`;
}

async function callJobsBot(env, method, payload = {}) {
  if (!env.JOBS_BOT_TOKEN) return { ok: false, description: "JOBS_BOT_TOKEN не встановлено" };
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

function isBotUnavailable(result) {
  if (!result || result.ok) return false;
  const errorCode = Number(result.error_code || 0);
  const description = String(result.description || "").toLowerCase();
  if (errorCode !== 403) return false;
  return (
    description.includes("bot was blocked by the user") ||
    description.includes("user is deactivated") ||
    description.includes("bot can't initiate conversation with a user") ||
    description.includes("forbidden")
  );
}

async function markMasterInactive(env, telegramId) {
  if (!env?.DB || telegramId == null) return;
  try {
    await env.DB.prepare(`
      UPDATE masters SET
        status = 'inactive',
        bot_status = 'unavailable',
        bot_status_checked_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ? AND status = 'active'
    `).bind(telegramId).run();
  } catch (err) {
    console.error(`Failed to mark master ${telegramId} inactive:`, err);
  }
}

async function markMasterAvailable(env, telegramId) {
  if (!env?.DB || telegramId == null) return;
  try {
    await env.DB.prepare(`
      UPDATE masters SET
        bot_status = 'available',
        bot_status_checked_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ? AND status != 'blocked'
    `).bind(telegramId).run();
  } catch (err) {
    console.error(`Failed to mark master ${telegramId} available:`, err);
  }
}

export async function activateMasterBot(env, telegramId) {
  if (!env?.DB || telegramId == null) return null;
  try {
    return await env.DB.prepare(`
      UPDATE masters SET
        status = CASE WHEN status = 'inactive' THEN 'active' ELSE status END,
        bot_status = 'available',
        bot_status_checked_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ? AND status != 'blocked'
    `).bind(telegramId).run();
  } catch (err) {
    console.error(`Failed to activate master ${telegramId}:`, err);
    return null;
  }
}

export async function checkMasterBotAvailability(env, telegramId) {
  if (!env?.DB || telegramId == null) {
    return { ok: false, available: false, description: "telegramId не вказано" };
  }

  const result = await callJobsBot(env, "getChat", { chat_id: telegramId });

  if (result?.ok) {
    await markMasterAvailable(env, telegramId);
    return { ok: true, available: true, result: result.result };
  }

  if (isBotUnavailable(result)) {
    await markMasterInactive(env, telegramId);
    return { ok: true, available: false, description: result.description || "Jobs-бот недоступний" };
  }

  return {
    ok: false,
    available: false,
    description: result?.description || "Не вдалося перевірити доступність Jobs-бота",
  };
}

async function processMasterDeliveryResult(env, chatId, result) {
  if (result?.ok) {
    await markMasterAvailable(env, chatId);
    return result;
  }
  if (isBotUnavailable(result)) await markMasterInactive(env, chatId);
  return result;
}

export async function sendToMaster(env, chatId, text, inlineKeyboard = null) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };
  const result = await callJobsBot(env, "sendMessage", payload);
  return processMasterDeliveryResult(env, chatId, result);
}

export async function editMasterMessage(env, chatId, messageId, text, inlineKeyboard = null) {
  const result = await callJobsBot(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: inlineKeyboard || [] },
  });
  return processMasterDeliveryResult(env, chatId, result);
}

export async function deleteMasterMessage(env, chatId, messageId) {
  const result = await callJobsBot(env, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
  if (isBotUnavailable(result)) await markMasterInactive(env, chatId);
  return result;
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

export async function setMasterMenu(env, chatId) {
  const result = await callJobsBot(env, "sendMessage", {
    chat_id: chatId,
    text: "Оновлення меню…",
    disable_notification: true,
    reply_markup: {
      keyboard: [
        [
          { text: "🔧 Мої заявки" },
          { text: "➕ Передати" },
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

  if (!result?.ok) return processMasterDeliveryResult(env, chatId, result);

  await markMasterAvailable(env, chatId);

  const messageId = result?.result?.message_id;
  if (messageId) {
    const deleted = await callJobsBot(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
    if (!deleted?.ok) console.error("Temporary menu message delete failed:", deleted?.description || deleted);
  }

  return result;
}

export async function removeMasterMenu(env, chatId) {
  const result = await callJobsBot(env, "sendMessage", {
    chat_id: chatId,
    text: "Оновлення меню…",
    disable_notification: true,
    reply_markup: { remove_keyboard: true },
  });

  if (!result?.ok) return processMasterDeliveryResult(env, chatId, result);

  await markMasterAvailable(env, chatId);

  const messageId = result?.result?.message_id;
  if (messageId) {
    const deleted = await callJobsBot(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
    if (!deleted?.ok) console.error("Temporary menu removal message delete failed:", deleted?.description || deleted);
  }

  return result;
}
