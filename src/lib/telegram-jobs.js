const TELEGRAM_API = "https://api.telegram.org";

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
      description: String(
        err?.message || err
      ),
    };
  }
}

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

export async function editMasterMessage(
  env,
  chatId,
  messageId,
  text,
  inlineKeyboard = null
) {
  return callJobsBot(
    env,
    "editMessageText",
    {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard:
          inlineKeyboard || [],
      },
    }
  );
}

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

export async function getJobsBotInfo(env) {
  return callJobsBot(
    env,
    "getMe",
    {}
  );
}

/*
 * Постійне нижнє меню Telegram.
 *
 * Кнопки:
 * 🔧 Мої заявки
 * ➕ Передати
 * ❓ Допомога
 *
 * Telegram вимагає sendMessage для встановлення
 * ReplyKeyboard.
 *
 * Тому:
 * 1. надсилаємо коротке технічне повідомлення;
 * 2. разом із ним встановлюємо клавіатуру;
 * 3. одразу видаляємо технічне повідомлення;
 * 4. клавіатура залишається у користувача.
 */
export async function setMasterMenu(
  env,
  chatId
) {
  const result =
    await callJobsBot(
      env,
      "sendMessage",
      {
        chat_id: chatId,

        /*
         * Непорожній текст обов'язковий
         * для Telegram sendMessage.
         */
        text: "Оновлення меню…",

        disable_notification: true,

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
          is_persistent: true,

          input_field_placeholder:
            "Оберіть дію",
        },
      }
    );

  /*
   * Якщо Telegram успішно створив
   * технічне повідомлення —
   * одразу його видаляємо.
   */
  const messageId =
    result?.result?.message_id;

  if (result?.ok && messageId) {
    try {
      await callJobsBot(
        env,
        "deleteMessage",
        {
          chat_id: chatId,
          message_id: messageId,
        }
      );
    } catch (err) {
      console.error(
        "Temporary menu message delete failed:",
        err
      );
    }
  }

  return result;
}

/*
 * Якщо знадобиться примусово прибрати
 * нижню ReplyKeyboard.
 */
export async function removeMasterMenu(
  env,
  chatId
) {
  const result =
    await callJobsBot(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text: "Оновлення меню…",
        disable_notification: true,

        reply_markup: {
          remove_keyboard: true,
        },
      }
    );

  const messageId =
    result?.result?.message_id;

  if (result?.ok && messageId) {
    try {
      await callJobsBot(
        env,
        "deleteMessage",
        {
          chat_id: chatId,
          message_id: messageId,
        }
      );
    } catch (err) {
      console.error(
        "Temporary menu removal message delete failed:",
        err
      );
    }
  }

  return result;
}