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
 * Надсилання повідомлення в групу заявок
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
 * Редагування повідомлення в групі
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
 * Відповідь на callback
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
 * Особисте повідомлення майстру
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
 * Перевірка статусу користувача в JOBS_CHAT_ID
 * ========================================================= */

export async function getJobsChatMember(
  env,
  telegramId
) {
  if (!env.JOBS_CHAT_ID) {
    return {
      ok: false,
      description: "JOBS_CHAT_ID не встановлено",
    };
  }

  return callJobsBot(
    env,
    "getChatMember",
    {
      chat_id: env.JOBS_CHAT_ID,
      user_id: telegramId,
    }
  );
}

/* =========================================================
 * БЛОКУВАННЯ МАЙСТРА В TELEGRAM-ГРУПІ
 *
 * Використовуємо banChatMember.
 *
 * Після цього Telegram повертає для користувача status=kicked.
 * Такий користувач НЕ зможе повернутися через invite link,
 * доки адміністратор/система його не розблокує.
 *
 * УВАГА:
 * ця функція НЕ змінює masters.status у D1.
 * Це робитиме адміністративна логіка окремо.
 * ========================================================= */

export async function banMasterFromJobsGroup(
  env,
  telegramId
) {
  if (!env.JOBS_CHAT_ID) {
    return {
      ok: false,
      description: "JOBS_CHAT_ID не встановлено",
    };
  }

  if (!telegramId) {
    return {
      ok: false,
      description: "telegramId не передано",
    };
  }

  const result = await callJobsBot(
    env,
    "banChatMember",
    {
      chat_id: env.JOBS_CHAT_ID,
      user_id: telegramId,

      /*
       * Не видаляємо старі повідомлення майстра.
       */
      revoke_messages: false,
    }
  );

  if (!result?.ok) {
    console.error(
      "banMasterFromJobsGroup failed:",
      result
    );

    return {
      ok: false,
      description:
        result?.description ||
        "Не вдалося заблокувати майстра в групі",
    };
  }

  return {
    ok: true,
    telegram_id: telegramId,
    status: "kicked",
  };
}

/* =========================================================
 * РОЗБЛОКУВАННЯ МАЙСТРА В TELEGRAM-ГРУПІ
 *
 * Після unbanChatMember користувач НЕ додається в групу
 * автоматично.
 *
 * Він лише отримує можливість знову приєднатися.
 * Після цього createInviteForMaster() може створити
 * для нього нове персональне запрошення.
 *
 * УВАГА:
 * ця функція НЕ змінює masters.status у D1.
 * ========================================================= */

export async function unbanMasterFromJobsGroup(
  env,
  telegramId
) {
  if (!env.JOBS_CHAT_ID) {
    return {
      ok: false,
      description: "JOBS_CHAT_ID не встановлено",
    };
  }

  if (!telegramId) {
    return {
      ok: false,
      description: "telegramId не передано",
    };
  }

  const result = await callJobsBot(
    env,
    "unbanChatMember",
    {
      chat_id: env.JOBS_CHAT_ID,
      user_id: telegramId,
      only_if_banned: true,
    }
  );

  if (!result?.ok) {
    console.error(
      "unbanMasterFromJobsGroup failed:",
      result
    );

    return {
      ok: false,
      description:
        result?.description ||
        "Не вдалося розблокувати майстра в групі",
    };
  }

  return {
    ok: true,
    telegram_id: telegramId,
    status: "left",
  };
}

/* =========================================================
 * Перевірка / відновлення доступу до групи
 *
 * Ця функція використовується для АКТИВНОГО майстра,
 * коли він просить нове запрошення.
 *
 * Якщо Telegram показує kicked:
 * - знімаємо Telegram-бан;
 * - після цього можна створити нове запрошення.
 *
 * Перевірка masters.status='active' виконується ВИЩЕ,
 * у jobs.js / join.js.
 * ========================================================= */

export async function ensureJobsGroupAccess(
  env,
  telegramId
) {
  const member =
    await getJobsChatMember(
      env,
      telegramId
    );

  if (!member?.ok) {
    return {
      ok: false,
      description:
        member?.description ||
        "Не вдалося перевірити статус у групі",
    };
  }

  const status =
    member.result?.status || "";

  if (status === "kicked") {
    const unban =
      await unbanMasterFromJobsGroup(
        env,
        telegramId
      );

    if (!unban?.ok) {
      return {
        ok: false,
        status,
        description:
          unban?.description ||
          "Не вдалося розблокувати користувача",
      };
    }

    return {
      ok: true,
      status: "left",
      is_member: false,
      was_unbanned: true,
    };
  }

  return {
    ok: true,
    status,
    is_member:
      !!member.result?.is_member,
    was_unbanned: false,
  };
}

/* =========================================================
 * Створення нового персонального invite link
 *
 * member_limit навмисно НЕ використовуємо.
 *
 * Кожен запит створює НОВЕ унікальне посилання.
 * ========================================================= */

export async function createInviteLink(
  env
) {
  if (!env.JOBS_CHAT_ID) {
    return {
      ok: false,
      description: "JOBS_CHAT_ID не встановлено",
    };
  }

  const result =
    await callJobsBot(
      env,
      "createChatInviteLink",
      {
        chat_id: env.JOBS_CHAT_ID,

        name:
          `SA-MASTER ${Date.now()}`
            .slice(0, 32),
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

  return result;
}

/* =========================================================
 * Створення запрошення для конкретного майстра
 *
 * 1. Перевіряємо його стан у Telegram-групі.
 *
 * 2. Якщо він уже:
 *    member / administrator / creator —
 *    нового посилання не створюємо.
 *
 * 3. Якщо kicked —
 *    ensureJobsGroupAccess() спочатку його розбанить.
 *
 * 4. Якщо left —
 *    створюємо НОВЕ invite link.
 *
 * ВАЖЛИВО:
 * masters.status повинен бути перевірений ДО виклику
 * цієї функції.
 * ========================================================= */

export async function createInviteForMaster(
  env,
  telegramId
) {
  const access =
    await ensureJobsGroupAccess(
      env,
      telegramId
    );

  if (!access.ok) {
    return access;
  }

  if (
    access.status === "member" ||
    access.status === "administrator" ||
    access.status === "creator" ||
    (
      access.status === "restricted" &&
      access.is_member
    )
  ) {
    return {
      ok: true,
      already_member: true,
      status: access.status,
    };
  }

  const invite =
    await createInviteLink(env);

  if (
    !invite?.ok ||
    !invite?.result?.invite_link
  ) {
    return {
      ok: false,
      status: access.status,
      description:
        invite?.description ||
        "Не вдалося створити запрошення",
    };
  }

  return {
    ok: true,
    already_member: false,

    was_unbanned:
      !!access.was_unbanned,

    status:
      access.status,

    invite_link:
      invite.result.invite_link,

    invite:
      invite.result,
  };
}