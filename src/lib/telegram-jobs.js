const TELEGRAM_API = "https://api.telegram.org";

function apiUrl(env, method) {
  return `${TELEGRAM_API}/bot${env.JOBS_BOT_TOKEN}/${method}`;
}

async function callJobsBot(env, method, payload) {
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
 * Відправити повідомлення в групу майстрів
 * ========================================================= */

export async function sendToJobsGroup(
  env,
  text,
  inlineKeyboard,
  threadId
) {
  if (!env.JOBS_CHAT_ID) {
    return {
      ok: false,
      description: "JOBS_CHAT_ID не встановлено",
    };
  }

  const payload = {
    chat_id: env.JOBS_CHAT_ID,
    text,
    disable_web_page_preview: true,
  };

  if (inlineKeyboard) {
    payload.reply_markup = {
      inline_keyboard: inlineKeyboard,
    };
  }

  if (threadId) {
    payload.message_thread_id = threadId;
  }

  return callJobsBot(
    env,
    "sendMessage",
    payload
  );
}

/* =========================================================
 * Оновити повідомлення в групі
 * ========================================================= */

export async function editJobsMessage(
  env,
  messageId,
  text,
  inlineKeyboard
) {
  if (!env.JOBS_CHAT_ID) {
    return {
      ok: false,
      description: "JOBS_CHAT_ID не встановлено",
    };
  }

  const payload = {
    chat_id: env.JOBS_CHAT_ID,
    message_id: messageId,
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
    "editMessageText",
    payload
  );
}

/* =========================================================
 * Відповісти на callback
 * ========================================================= */

export async function answerJobsCallback(
  env,
  callbackQueryId,
  text,
  showAlert = false
) {
  return callJobsBot(
    env,
    "answerCallbackQuery",
    {
      callback_query_id: callbackQueryId,
      text: text || "",
      show_alert: !!showAlert,
    }
  );
}

/* =========================================================
 * Надіслати повідомлення майстру
 * ========================================================= */

export async function sendToMaster(
  env,
  chatId,
  text,
  inlineKeyboard
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
 * Створити персональне посилання на групу
 *
 * ВАЖЛИВО:
 * - посилання не має короткого expire_date;
 * - member_limit = 1;
 * - кожен виклик створює НОВЕ посилання;
 * - Telegram API response перевіряється повністю.
 *
 * Таке посилання залишається чинним, доки:
 * 1. ним не скористається одна людина;
 * 2. його не відкличе адміністратор / бот;
 * 3. Telegram не визнає його недійсним з іншої причини.
 * ========================================================= */

export async function createInviteLink(env) {
  if (!env.JOBS_CHAT_ID) {
    return {
      ok: false,
      description: "JOBS_CHAT_ID не встановлено",
    };
  }

  const inviteName =
    `SA-MASTER ${Date.now()}`;

  const result = await callJobsBot(
    env,
    "createChatInviteLink",
    {
      chat_id: env.JOBS_CHAT_ID,

      /*
       * Одне посилання = один новий учасник.
       *
       * expire_date навмисно НЕ встановлюємо.
       * Тобто воно не протухає через 24 години.
       */
      member_limit: 1,

      name: inviteName,
    }
  );

  if (
    !result?.ok ||
    !result?.result?.invite_link
  ) {
    console.error(
      "createInviteLink failed:",
      result
    );

    return {
      ok: false,
      description:
        result?.description ||
        "Telegram не повернув invite_link",
    };
  }

  console.log(
    "New SA-MASTER Jobs invite created:",
    {
      name: inviteName,
      creates_join_request:
        result.result.creates_join_request,
      is_revoked:
        result.result.is_revoked,
      expire_date:
        result.result.expire_date,
      member_limit:
        result.result.member_limit,
      pending_join_request_count:
        result.result.pending_join_request_count,
    }
  );

  return result;
}
