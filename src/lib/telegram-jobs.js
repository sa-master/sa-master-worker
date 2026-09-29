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

export async function editJobsMessage(env, messageId, text, inlineKeyboard) {
  if (!env.JOBS_CHAT_ID) {
    return { ok: false, description: "JOBS_CHAT_ID не встановлено" };
  }

  const payload = {
    chat_id: env.JOBS_CHAT_ID,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  };

  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };

  return callJobsBot(env, "editMessageText", payload);
}

export async function answerJobsCallback(env, callbackQueryId, text, showAlert = false) {
  return callJobsBot(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || "",
    show_alert: !!showAlert,
  });
}

export async function sendToMaster(env, chatId, text, inlineKeyboard) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };

  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };

  return callJobsBot(env, "sendMessage", payload);
}

export async function getJobsChatMember(env, telegramId) {
  if (!env.JOBS_CHAT_ID) {
    return { ok: false, description: "JOBS_CHAT_ID не встановлено" };
  }

  return callJobsBot(env, "getChatMember", {
    chat_id: env.JOBS_CHAT_ID,
    user_id: telegramId,
  });
}

export async function ensureJobsGroupAccess(env, telegramId) {
  const member = await getJobsChatMember(env, telegramId);

  if (!member?.ok) {
    return {
      ok: false,
      description: member?.description || "Не вдалося перевірити статус у групі",
    };
  }

  const status = member.result?.status || "";

  if (status === "kicked") {
    const unban = await callJobsBot(env, "unbanChatMember", {
      chat_id: env.JOBS_CHAT_ID,
      user_id: telegramId,
      only_if_banned: true,
    });

    if (!unban?.ok) {
      return {
        ok: false,
        status,
        description: unban?.description || "Не вдалося розблокувати користувача",
      };
    }

    return {
      ok: true,
      status: "left",
      was_unbanned: true,
    };
  }

  return {
    ok: true,
    status,
    is_member: !!member.result?.is_member,
    was_unbanned: false,
  };
}

/*
 * Персональне запрошення.
 *
 * ВАЖЛИВО:
 * member_limit навмисно НЕ використовується.
 * Telegram може вважати одноразове invite-посилання використаним
 * після попередньої спроби/входу. Для нашого сценарію достатньо
 * створювати нове унікальне посилання на кожний запит майстра.
 */
export async function createInviteLink(env) {
  if (!env.JOBS_CHAT_ID) {
    return { ok: false, description: "JOBS_CHAT_ID не встановлено" };
  }

  const result = await callJobsBot(env, "createChatInviteLink", {
    chat_id: env.JOBS_CHAT_ID,
    name: `SA-MASTER ${Date.now()}`.slice(0, 32),
  });

  if (!result?.ok || !result?.result?.invite_link) {
    console.error("createInviteLink failed:", result);

    return {
      ok: false,
      description: result?.description || "Telegram не повернув invite_link",
    };
  }

  return result;
}

export async function createInviteForMaster(env, telegramId) {
  const access = await ensureJobsGroupAccess(env, telegramId);

  if (!access.ok) {
    return access;
  }

  if (
    access.status === "member" ||
    access.status === "administrator" ||
    access.status === "creator" ||
    (access.status === "restricted" && access.is_member)
  ) {
    return {
      ok: true,
      already_member: true,
      status: access.status,
    };
  }

  const invite = await createInviteLink(env);

  if (!invite?.ok || !invite?.result?.invite_link) {
    return {
      ok: false,
      status: access.status,
      description: invite?.description || "Не вдалося створити запрошення",
    };
  }

  return {
    ok: true,
    already_member: false,
    was_unbanned: !!access.was_unbanned,
    status: access.status,
    invite_link: invite.result.invite_link,
    invite: invite.result,
  };
}
