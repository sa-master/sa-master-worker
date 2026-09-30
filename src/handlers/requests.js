import { json, error } from "../lib/json.js";
import {
  STATUS_LABELS,
  statusLabel,
  isValidStatus,
  withStatusLabel,
} from "../lib/statuses.js";
import { normalizePhone, isValidPhone } from "../lib/phone.js";
import { str } from "../lib/validate.js";
import {
  sendMessageWithButtons,
  editMessageText,
  answerCallbackQuery,
} from "../lib/telegram.js";
import { buildStatusButtons, canChangeStatus, formatRequestText } from "../lib/telegram-buttons.js";
import { sendToMaster } from "../lib/telegram-jobs.js";
import { publishRequestToJobs } from "./jobs.js";

const CURRENT_YEAR = 2026;
const ESTIMATE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_LINK_TTL_MS = 2 * 60 * 60 * 1000;

/* =========================================================
 * ADMIN: helpers
 * ========================================================= */

function canEditMessage(chatId, messageId) {
  return chatId !== null &&
    chatId !== undefined &&
    messageId !== null &&
    messageId !== undefined;
}

function adminRenderer(env, chatId = null, messageId = null) {
  if (canEditMessage(chatId, messageId)) {
    return (text, buttons) =>
      editMessageText(env, chatId, messageId, text, buttons);
  }

  return (text, buttons) =>
    sendMessageWithButtons(env, text, buttons);
}

async function deleteIncomingCommand(env, msg) {
  const chatId = msg?.chat?.id;
  const messageId = msg?.message_id;

  if (!env.BOT_TOKEN || chatId == null || messageId == null) return;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
        }),
      }
    );

    const data = await res.json();

    if (!data.ok) {
      console.error(
        "Telegram deleteMessage failed:",
        data.description || data
      );
    }
  } catch (err) {
    console.error("Telegram deleteMessage error:", err);
  }
}

/* =========================================================
 * ADMIN: стан повідомлення статистики
 * ========================================================= */

async function ensureAdminUiStateTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admin_ui_state (
      chat_id TEXT PRIMARY KEY,
      stats_message_id INTEGER,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function rememberStatsMessage(env, chatId, messageId) {
  if (chatId == null || messageId == null) return;

  await ensureAdminUiStateTable(env);

  await env.DB.prepare(`
    INSERT INTO admin_ui_state (
      chat_id,
      stats_message_id,
      updated_at
    )
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET
      stats_message_id = excluded.stats_message_id,
      updated_at = CURRENT_TIMESTAMP
  `)
    .bind(
      String(chatId),
      Number(messageId)
    )
    .run();
}

async function deleteTelegramMessage(env, chatId, messageId) {
  if (!env.BOT_TOKEN || chatId == null || messageId == null) return;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
        }),
      }
    );

    const data = await res.json();

    if (
      !data.ok &&
      !String(data.description || "")
        .includes("message to delete not found")
    ) {
      console.error(
        "Telegram delete stats message failed:",
        data.description || data
      );
    }
  } catch (err) {
    console.error(
      "Telegram delete stats message error:",
      err
    );
  }
}

async function removeStatsMessage(env, chatId) {
  if (chatId == null) return;

  await ensureAdminUiStateTable(env);

  const row = await env.DB.prepare(`
    SELECT stats_message_id
    FROM admin_ui_state
    WHERE chat_id = ?
    LIMIT 1
  `)
    .bind(String(chatId))
    .first();

  if (row?.stats_message_id != null) {
    await deleteTelegramMessage(
      env,
      chatId,
      row.stats_message_id
    );
  }

  await env.DB.prepare(`
    DELETE FROM admin_ui_state
    WHERE chat_id = ?
  `)
    .bind(String(chatId))
    .run();
}

/* =========================================================
 * ADMIN: головне меню / статистика
 * ========================================================= */

async function sendAdminMenu(env, chatId = null, messageId = null) {
  const render = adminRenderer(env, chatId, messageId);

  const stats = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM requests) AS requests_total,
      (SELECT COUNT(*) FROM requests WHERE status = 'new') AS requests_new,
      (SELECT COUNT(*) FROM masters) AS masters_total,
      (SELECT COUNT(*) FROM masters WHERE status = 'active') AS masters_active
  `).first();

  return render(
    [
      "📊 СТАТИСТИКА",
      "",
      `📋 Заявки: ${stats?.requests_total || 0}`,
      `🆕 Нові: ${stats?.requests_new || 0}`,
      `👥 Майстри: ${stats?.masters_total || 0}`,
      `🟢 Активні: ${stats?.masters_active || 0}`,
    ].join("\n"),
    []
  );
}

/* =========================================================
 * ADMIN: заявки
 * ========================================================= */

async function sendRequestsMenu(env, chatId = null, messageId = null) {
  const render = adminRenderer(env, chatId, messageId);

  const rows = await env.DB.prepare(`
    SELECT
      id,
      request_code,
      name,
      phone,
      type,
      type_label,
      location,
      status,
      created_at
    FROM requests
    ORDER BY id DESC
    LIMIT 30
  `).all();

  const requests = rows.results || [];

  if (!requests.length) {
    return render(
      [
        "📋 ЗАЯВКИ",
        "",
        "У базі поки немає заявок.",
      ].join("\n"),
      [[
        { text: "❌ Закрити", callback_data: "admin_close" },
      ]]
    );
  }

  const buttons = requests.map((req) => [{
    text: `${statusLabel(req.status)} · ${req.request_code} · ${req.name || "—"}`,
    callback_data: `request_open:${req.request_code}`,
  }]);

  buttons.push([
    { text: "❌ Закрити", callback_data: "admin_close" },
  ]);

  return render(
    [
      "📋 ЗАЯВКИ",
      "",
      `Показано останніх: ${requests.length}`,
      "",
      "Оберіть заявку:",
    ].join("\n"),
    buttons
  );
}

async function showRequestCard(
  env,
  callbackId,
  requestCode,
  workerOrigin,
  chatId,
  messageId
) {
  const req = await env.DB.prepare(`
    SELECT *
    FROM requests
    WHERE request_code = ?
    LIMIT 1
  `)
    .bind(requestCode)
    .first();

  if (!req) {
    if (callbackId) {
      await answerCallbackQuery(
        env,
        callbackId,
        "❌ Заявку не знайдено",
        true
      );
    }
    return;
  }

  const text = [
    `🏠 ЗАЯВКА ${req.request_code}`,
    "",
    `👤 ${req.name || "—"}`,
    `📞 ${req.phone || "—"}`,
    `🔧 ${req.type_label || req.type || "—"}`,
    `📍 ${req.location || "—"}`,
    req.project ? `📐 Дизайн-проєкт: ${req.project}` : null,
    req.timing ? `🗓 Початок: ${req.timing}` : null,
    req.consultation_date
      ? `📅 Консультація: ${req.consultation_date}`
      : null,
    `📊 Статус: ${statusLabel(req.status)}`,
    req.transferred_to_jobs
      ? "🤝 Доступна майстрам SA-MASTER Jobs"
      : null,
    req.assigned_master_name
      ? `🙋 Майстер: ${req.assigned_master_name}`
      : null,
    req.notes ? `📝 ${req.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const buttons = buildStatusButtons(
    req.request_code,
    req.status,
    calculatorUrl(
      req.request_code,
      req.estimate_token,
      workerOrigin,
      env
    )
  );

  if (!req.transferred_to_jobs) {
    buttons.push([{
      text: "🤝 Передати майстрам",
      callback_data: `transfer_to_jobs:${req.request_code}`,
    }]);
  }

  buttons.push([{
    text: "ℹ️ Деталі",
    callback_data: `details:${req.request_code}`,
  }]);

  buttons.push([
    { text: "📋 До заявок", callback_data: "requests_list" },
    { text: "❌ Закрити", callback_data: "admin_close" },
  ]);

  await editMessageText(
    env,
    chatId,
    messageId,
    text,
    buttons
  );

  if (callbackId) {
    await answerCallbackQuery(env, callbackId, "");
  }
}

/* =========================================================
 * ADMIN: майстри
 * ========================================================= */

function adminMasterStatusLabel(status) {
  if (status === "active") return "🟢 Активний";
  if (status === "blocked") return "🔴 Заблокований";
  if (status === "inactive") return "⚪ Неактивний";
  return `⚪ ${status || "невідомо"}`;
}

async function getAdminMaster(env, masterId) {
  return env.DB.prepare(`
    SELECT
      id,
      telegram_id,
      username,
      first_name,
      phone,
      specializations,
      cities,
      status,
      referral_token,
      application_id,
      joined_at,
      good_deals_count,
      no_answer_count,
      weird_client_count
    FROM masters
    WHERE id = ?
    LIMIT 1
  `)
    .bind(masterId)
    .first();
}

async function sendMastersMenu(env, chatId = null, messageId = null) {
  const render = adminRenderer(env, chatId, messageId);

  const rows = await env.DB.prepare(`
    SELECT
      id,
      first_name,
      username,
      specializations,
      cities,
      status
    FROM masters
    ORDER BY
      CASE status
        WHEN 'active' THEN 1
        WHEN 'blocked' THEN 2
        WHEN 'inactive' THEN 3
        ELSE 4
      END,
      id DESC
    LIMIT 100
  `).all();

  const masters = rows.results || [];

  if (!masters.length) {
    return render(
      [
        "👥 МАЙСТРИ",
        "",
        "У базі поки немає зареєстрованих майстрів.",
      ].join("\n"),
      [[
        { text: "❌ Закрити", callback_data: "admin_close" },
      ]]
    );
  }

  const buttons = masters.map((master) => [{
    text:
      `${master.status === "active"
        ? "🟢"
        : master.status === "blocked"
          ? "🔴"
          : "⚪"} ` +
      `${master.first_name ||
        master.username ||
        `Майстер #${master.id}`}`,
    callback_data: `master_open:${master.id}`,
  }]);

  buttons.push([
    { text: "❌ Закрити", callback_data: "admin_close" },
  ]);

  return render(
    [
      "👥 МАЙСТРИ SA-MASTER Jobs",
      "",
      `Всього: ${masters.length}`,
      "",
      "Оберіть майстра:",
    ].join("\n"),
    buttons
  );
}

async function showMasterCard(
  env,
  callbackId,
  masterId,
  chatId,
  messageId
) {
  const master = await getAdminMaster(env, masterId);

  if (!master) {
    if (callbackId) {
      await answerCallbackQuery(
        env,
        callbackId,
        "❌ Майстра не знайдено",
        true
      );
    }
    return;
  }

  const text = [
    "👤 МАЙСТЕР SA-MASTER Jobs",
    "",
    `Ім'я: ${master.first_name || "—"}`,
    `Username: ${master.username ? `@${master.username}` : "—"}`,
    `📞 ${master.phone || "—"}`,
    `🛠 ${master.specializations || "—"}`,
    `🏙 ${master.cities || "—"}`,
    `🆔 Telegram: ${master.telegram_id}`,
    `📊 Статус: ${adminMasterStatusLabel(master.status)}`,
    "",
    `✅ Успішні заявки: ${master.good_deals_count || 0}`,
    `📵 Не відповіли: ${master.no_answer_count || 0}`,
    `⚠️ Дивні клієнти: ${master.weird_client_count || 0}`,
  ].join("\n");

  const buttons = [];

  if (master.status === "active") {
    buttons.push([{
      text: "🚫 Заблокувати",
      callback_data: `master_block:${master.id}`,
    }]);
  } else if (
    master.status === "blocked" ||
    master.status === "inactive"
  ) {
    buttons.push([{
      text: "✅ Активувати",
      callback_data: `master_unblock:${master.id}`,
    }]);
  }

  buttons.push([{
    text: "🗑 Видалити назавжди",
    callback_data: `master_delete_ask:${master.id}`,
  }]);

  buttons.push([
    { text: "👥 До списку", callback_data: "masters_list" },
    { text: "❌ Закрити", callback_data: "admin_close" },
  ]);

  await editMessageText(
    env,
    chatId,
    messageId,
    text,
    buttons
  );

  if (callbackId) {
    await answerCallbackQuery(env, callbackId, "");
  }
}

async function blockMaster(env, callbackId, masterId) {
  const master = await getAdminMaster(env, masterId);

  if (!master) {
    await answerCallbackQuery(
      env,
      callbackId,
      "❌ Майстра не знайдено",
      true
    );
    return false;
  }

  if (master.status === "blocked") {
    await answerCallbackQuery(
      env,
      callbackId,
      "⚠️ Майстер уже заблокований",
      true
    );
    return false;
  }

  try {
    await env.DB.prepare(`
      UPDATE masters
      SET
        status = 'blocked',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
      .bind(master.id)
      .run();
  } catch (err) {
    console.error("DB block master failed:", err);

    await answerCallbackQuery(
      env,
      callbackId,
      "❌ Не вдалося зберегти блокування в D1",
      true
    );

    return false;
  }

  try {
    await sendToMaster(
      env,
      master.telegram_id,
      [
        "🚫 ДОСТУП ДО SA-MASTER Jobs ЗАБЛОКОВАНО",
        "",
        "Ваш профіль заблоковано адміністратором.",
        "",
        "Ви більше не можете переглядати, брати або передавати заявки.",
        "",
        "Для відновлення доступу зверніться до адміністратора.",
      ].join("\n")
    );
  } catch (err) {
    console.error(
      "Blocked master notification failed:",
      err
    );
  }

  await answerCallbackQuery(
    env,
    callbackId,
    "🚫 Майстра заблоковано"
  );

  return true;
}

async function unblockMaster(env, callbackId, masterId) {
  const master = await getAdminMaster(env, masterId);

  if (!master) {
    await answerCallbackQuery(
      env,
      callbackId,
      "❌ Майстра не знайдено",
      true
    );
    return false;
  }

  if (master.status === "active") {
    await answerCallbackQuery(
      env,
      callbackId,
      "⚠️ Майстер уже активний",
      true
    );
    return false;
  }

  try {
    await env.DB.prepare(`
      UPDATE masters
      SET
        status = 'active',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
      .bind(master.id)
      .run();
  } catch (err) {
    console.error("DB activate master failed:", err);

    await answerCallbackQuery(
      env,
      callbackId,
      "❌ Не вдалося змінити статус у D1",
      true
    );

    return false;
  }

  try {
    await sendToMaster(
      env,
      master.telegram_id,
      [
        "✅ ДОСТУП ДО SA-MASTER Jobs ВІДНОВЛЕНО",
        "",
        "Ваш профіль знову активний.",
        "",
        "Відкрийте бота та натисніть /start.",
        "Доступні заявки знову можна переглядати прямо в боті.",
      ].join("\n")
    );
  } catch (err) {
    console.error(
      "Activated master notification failed:",
      err
    );
  }

  await answerCallbackQuery(
    env,
    callbackId,
    "✅ Майстра активовано"
  );

  return true;
}

async function deleteMasterPermanently(
  env,
  callbackId,
  masterId,
  chatId,
  messageId
) {
  const master = await getAdminMaster(env, masterId);

  if (!master) {
    await answerCallbackQuery(
      env,
      callbackId,
      "❌ Майстра не знайдено",
      true
    );
    return false;
  }

  const cleanupSteps = [
    {
      name: "request_outcomes",
      statement: env.DB.prepare(`
        DELETE FROM request_outcomes
        WHERE master_id = ?
      `).bind(master.telegram_id),
    },
    {
      name: "requests.source_master_id",
      statement: env.DB.prepare(`
        UPDATE requests
        SET
          source_master_id = NULL,
          source_type = 'client',
          updated_at = CURRENT_TIMESTAMP
        WHERE source_master_id = ?
      `).bind(master.id),
    },
    {
      name: "requests.assigned_master_id",
      statement: env.DB.prepare(`
        UPDATE requests
        SET
          assigned_master_id = NULL,
          assigned_master_name = NULL,
          assigned_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE assigned_master_id = ?
      `).bind(master.telegram_id),
    },
    {
      name: "events.author_id",
      statement: env.DB.prepare(`
        UPDATE events
        SET author_id = NULL
        WHERE author_type = 'master'
          AND author_id = ?
      `).bind(String(master.id)),
    },
    {
      name: "master_applications",
      statement: env.DB.prepare(`
        DELETE FROM master_applications
        WHERE telegram_id = ?
      `).bind(master.telegram_id),
    },
    {
      name: "masters",
      statement: env.DB.prepare(`
        DELETE FROM masters
        WHERE id = ?
      `).bind(master.id),
    },
  ];

  for (const step of cleanupSteps) {
    try {
      console.log(
        `Permanent master delete: ${step.name}`
      );

      await step.statement.run();
    } catch (err) {
      const message =
        err?.message ||
        err?.cause?.message ||
        String(err);

      console.error(
        `Permanent master delete failed at step "${step.name}":`,
        message,
        err
      );

      await answerCallbackQuery(
        env,
        callbackId,
        `❌ Помилка видалення: ${step.name}`,
        true
      );

      return false;
    }
  }

  await editMessageText(
    env,
    chatId,
    messageId,
    [
      "🗑 МАЙСТРА ВИДАЛЕНО",
      "",
      "Профіль, анкета, статистика та відомі персональні дані майстра видалені.",
      "",
      "Клієнтські заявки та їх історія залишилися в системі без прив'язки до видаленого профілю.",
    ].join("\n"),
    [[
      {
        text: "👥 До списку майстрів",
        callback_data: "masters_list",
      },
      {
        text: "❌ Закрити",
        callback_data: "admin_close",
      },
    ]]
  );

  await answerCallbackQuery(
    env,
    callbackId,
    "🗑 Майстра видалено назавжди"
  );

  return true;
}

/* =========================================================
 * Посилання на калькулятор
 * ========================================================= */

function calculatorUrl(
  requestCode,
  token,
  workerOrigin,
  env
) {
  if (!token || !env.CALCULATOR_URL) return "";

  const url = new URL(env.CALCULATOR_URL);

  url.searchParams.set("request", requestCode);
  url.searchParams.set("token", token);
  url.searchParams.set("api", workerOrigin);

  return url.toString();
}

/* =========================================================
 * POST / — створення заявки
 * ========================================================= */

export async function handleCreateRequest(
  request,
  env,
  headers
) {
  let body;

  try {
    body = await request.json();
  } catch {
    return error(
      "Некоректний JSON",
      headers,
      400
    );
  }

  const name = str(
    body.name,
    { max: 120, required: true }
  );

  const phone = str(
    body.phone,
    { max: 40, required: true }
  );

  const type = str(
    body.type,
    { max: 40, required: true }
  );

  if (!name || !phone || !type) {
    return error(
      "Необхідні ім'я, телефон та тип заявки",
      headers,
      400
    );
  }

  if (!isValidPhone(phone)) {
    return error(
      "Некоректний номер телефону",
      headers,
      400
    );
  }

  const normalizedPhone = normalizePhone(phone);

  const typeLabel =
    str(body.typeLabel, { max: 80 }) || type;

  const location =
    str(body.location, { max: 300 });

  const timing =
    str(body.timing, { max: 100 });

  const project =
    str(body.project, { max: 200 });

  const consultation =
    str(body.consultationDate, { max: 100 });

  const source =
    str(body.source, { max: 80 }) ||
    "SA-MASTER.PRO";

  const notes =
    str(body.notes, { max: 500 });

  const referralToken =
    str(body.ref, { max: 100 });

  let sourceType = "client";
  let sourceMasterId = null;
  let sourceMaster = null;

  if (referralToken) {
    try {
      sourceMaster = await env.DB.prepare(`
        SELECT
          id,
          telegram_id,
          username,
          first_name,
          status
        FROM masters
        WHERE referral_token = ?
          AND status = 'active'
        LIMIT 1
      `)
        .bind(referralToken)
        .first();

      if (sourceMaster) {
        sourceType = "master";
        sourceMasterId = sourceMaster.id;
      }
    } catch (err) {
      console.error(
        "Referral lookup failed:",
        err
      );
    }
  }

  const estimateToken =
    crypto.randomUUID().replaceAll("-", "");

  const estimateTokenExpiresAt =
    new Date(
      Date.now() + ESTIMATE_LINK_TTL_MS
    ).toISOString();

  const uploadToken =
    crypto.randomUUID().replaceAll("-", "");

  const uploadTokenExpiresAt =
    new Date(
      Date.now() + UPLOAD_LINK_TTL_MS
    ).toISOString();

  let requestId;
  let requestCode;
  let clientId = null;

  try {
    const seq = await env.DB.prepare(`
      UPDATE sequences
      SET value = value + 1
      WHERE name = ?
      RETURNING value
    `)
      .bind(`request_${CURRENT_YEAR}`)
      .first();

    if (
      !seq ||
      typeof seq.value !== "number"
    ) {
      return error(
        "Не вдалося згенерувати код заявки",
        headers,
        500
      );
    }

    requestCode =
      `SM-R-${CURRENT_YEAR}-${String(seq.value).padStart(3, "0")}`;

    const existingClient =
      await env.DB.prepare(`
        SELECT id
        FROM clients
        WHERE phone = ?
        LIMIT 1
      `)
        .bind(normalizedPhone)
        .first();

    if (existingClient) {
      clientId = existingClient.id;
    } else {
      const ins = await env.DB.prepare(`
        INSERT INTO clients (name, phone)
        VALUES (?, ?)
      `)
        .bind(
          name,
          normalizedPhone
        )
        .run();

      clientId =
        ins.meta?.last_row_id || null;
    }

    const insertResult =
      await env.DB.prepare(`
        INSERT INTO requests (
          request_code,
          type,
          type_label,
          name,
          phone,
          location,
          timing,
          project,
          consultation_date,
          source,
          source_type,
          source_master_id,
          status,
          client_id,
          notes,
          estimate_token,
          estimate_token_expires_at,
          upload_token,
          upload_token_expires_at
        )
        VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?,
          'new',
          ?, ?,
          ?, ?,
          ?, ?
        )
      `)
        .bind(
          requestCode,
          type,
          typeLabel,
          name,
          normalizedPhone,
          location || null,
          timing || null,
          project || null,
          consultation || null,
          source,
          sourceType,
          sourceMasterId,
          clientId,
          notes || null,
          estimateToken,
          estimateTokenExpiresAt,
          uploadToken,
          uploadTokenExpiresAt
        )
        .run();

    if (!insertResult.meta?.last_row_id) {
      return error(
        "Не вдалося створити заявку",
        headers,
        500
      );
    }

    requestId =
      insertResult.meta.last_row_id;

    await env.DB.prepare(`
      INSERT INTO events (
        object_id,
        request_id,
        event_type,
        content,
        author_type
      )
      VALUES (
        NULL,
        ?,
        'request_created',
        'Створено заявку',
        'system'
      )
    `)
      .bind(requestId)
      .run();

    if (sourceMasterId) {
      await env.DB.prepare(`
        INSERT INTO events (
          object_id,
          request_id,
          event_type,
          content,
          author_type,
          author_id
        )
        VALUES (
          NULL,
          ?,
          'request_referred',
          'Заявку передано майстром',
          'master',
          ?
        )
      `)
        .bind(
          requestId,
          String(sourceMasterId)
        )
        .run();
    }
  } catch (err) {
    console.error(
      "Create request failed:",
      err
    );

    if (
      String(err?.message || "")
        .includes("UNIQUE")
    ) {
      return error(
        "Конфлікт даних клієнта. Спробуйте ще раз.",
        headers,
        409
      );
    }

    return error(
      "Помилка створення заявки",
      headers,
      500
    );
  }

  const referralLabel =
    sourceMasterId
      ? (
          sourceMaster?.username
            ? `@${sourceMaster.username}`
            : sourceMaster?.first_name ||
              `ID ${sourceMasterId}`
        )
      : null;

  const text = [
    "🏠 НОВА ЗАЯВКА",
    `🆔 ${requestCode}`,
    `👤 Ім'я: ${name}`,
    `📞 Телефон: ${normalizedPhone}`,
    `🔧 Тип: ${typeLabel}`,
    `📍 Об'єкт: ${location || "—"}`,
    `📐 Дизайн-проєкт: ${project || "—"}`,
    `🗓 Початок: ${timing || "—"}`,
    `📅 Консультація: ${consultation || "—"}`,
    sourceMasterId
      ? `🤝 Передав майстер: ${referralLabel}`
      : `🔗 Джерело: ${source}`,
    `📊 Статус: ${statusLabel("new")}`,
    `🕐 Час: ${new Date().toLocaleString(
      "uk-UA",
      { timeZone: "Europe/Kyiv" }
    )}`,
    notes
      ? `📝 Опис: ${notes}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const buttons = buildStatusButtons(
    requestCode,
    "new",
    calculatorUrl(
      requestCode,
      estimateToken,
      new URL(request.url).origin,
      env
    )
  );

  buttons.push([{
    text: "🤝 Передати майстрам",
    callback_data: `transfer_to_jobs:${requestCode}`,
  }]);

  const tg = await sendMessageWithButtons(
    env,
    text,
    buttons
  );

  if (!tg.ok) {
    console.error(
      "Telegram send failed:",
      tg.description || tg
    );
  }

  return json({
    ok: true,
    request: {
      id: requestId,
      request_code: requestCode,
      client_id: clientId,
      status: "new",
      status_label: statusLabel("new"),
      upload_token: uploadToken,
    },
  }, headers);
}

/* =========================================================
 * API: calculator request
 * ========================================================= */

export async function handleGetCalculatorRequest(
  request,
  env,
  headers,
  params,
  url
) {
  const [requestCode] = params;

  const token = str(
    url.searchParams.get("token"),
    { max: 100, required: true }
  );

  if (!token) {
    return error(
      "Відсутній ключ заявки",
      headers,
      403
    );
  }

  const row = await env.DB.prepare(`
    SELECT
      request_code,
      name,
      phone,
      location,
      type,
      type_label,
      timing,
      project,
      consultation_date,
      notes
    FROM requests
    WHERE request_code = ?
      AND estimate_token = ?
      AND datetime(estimate_token_expires_at) > CURRENT_TIMESTAMP
    LIMIT 1
  `)
    .bind(
      requestCode,
      token
    )
    .first();

  if (!row) {
    return error(
      "Посилання на заявку недійсне або вже прострочене",
      headers,
      404
    );
  }

  return json(
    {
      ok: true,
      request: row,
    },
    headers
  );
}

/* =========================================================
 * API: requests
 * ========================================================= */

export async function handleListRequests(
  request,
  env,
  headers,
  _params,
  url
) {
  const limit = Math.min(
    Number(url.searchParams.get("limit")) || 50,
    200
  );

  const offset = Math.max(
    Number(url.searchParams.get("offset")) || 0,
    0
  );

  const result = await env.DB.prepare(`
    SELECT
      r.*,
      c.id AS client_id,
      c.name AS client_name,
      c.phone AS client_phone
    FROM requests r
    LEFT JOIN clients c
      ON c.id = r.client_id
    ORDER BY r.id DESC
    LIMIT ?
    OFFSET ?
  `)
    .bind(
      limit,
      offset
    )
    .all();

  return json({
    ok: true,
    requests:
      (result.results || [])
        .map(withStatusLabel),
    limit,
    offset,
  }, headers);
}

export async function handleGetRequest(
  request,
  env,
  headers,
  params
) {
  const [requestCode] = params;

  const row = await env.DB.prepare(`
    SELECT
      r.*,
      c.name AS client_name,
      c.phone AS client_phone,
      o.object_code,
      o.name AS object_name,
      o.address AS object_address,
      o.status AS object_status
    FROM requests r
    LEFT JOIN clients c
      ON c.id = r.client_id
    LEFT JOIN objects o
      ON o.id = r.object_id
    WHERE r.request_code = ?
    LIMIT 1
  `)
    .bind(requestCode)
    .first();

  if (!row) {
    return error(
      "Заявку не знайдено",
      headers,
      404
    );
  }

  return json({
    ok: true,
    request: {
      ...row,
      status_label:
        statusLabel(row.status),
      object_status_label:
        row.object_status
          ? statusLabel(row.object_status)
          : null,
    },
  }, headers);
}

export async function handleUpdateStatus(
  request,
  env,
  headers,
  params
) {
  const [requestCode] = params;

  let body;

  try {
    body = await request.json();
  } catch {
    return error(
      "Некоректний JSON",
      headers,
      400
    );
  }

  const newStatus =
    String(body.status || "").trim();

  if (!isValidStatus(newStatus)) {
    return error(
      "Невідомий статус",
      headers,
      400,
      {
        allowed_statuses:
          Object.keys(STATUS_LABELS),
      }
    );
  }

  const current = await env.DB.prepare(`
    SELECT
      id,
      request_code,
      status,
      object_id
    FROM requests
    WHERE request_code = ?
    LIMIT 1
  `)
    .bind(requestCode)
    .first();

  if (!current) {
    return error(
      "Заявку не знайдено",
      headers,
      404
    );
  }

  const oldStatus = current.status;

  if (oldStatus === newStatus) {
    return json({
      ok: true,
      unchanged: true,
      status: newStatus,
    }, headers);
  }

  const oldLabel =
    statusLabel(oldStatus);

  const newLabel =
    statusLabel(newStatus);

  const eventContent =
    `${oldLabel} → ${newLabel}`;

  const statements = [
    env.DB.prepare(`
      UPDATE requests
      SET
        status = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      newStatus,
      current.id
    ),

    env.DB.prepare(`
      INSERT INTO events (
        object_id,
        request_id,
        event_type,
        content,
        author_type
      )
      VALUES (
        ?,
        ?,
        'status_changed',
        ?,
        'system'
      )
    `).bind(
      current.object_id || null,
      current.id,
      eventContent
    ),
  ];

  const syncObject =
    current.object_id &&
    newStatus !== "cancelled";

  if (syncObject) {
    statements.push(
      env.DB.prepare(`
        UPDATE objects
        SET
          status = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        newStatus,
        current.object_id
      ),

      env.DB.prepare(`
        INSERT INTO events (
          object_id,
          request_id,
          event_type,
          content,
          author_type
        )
        VALUES (
          ?,
          ?,
          'object_status_changed',
          ?,
          'system'
        )
      `).bind(
        current.object_id,
        current.id,
        `Статус об'єкта → ${newLabel}`
      )
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (err) {
    console.error(
      "Status update batch failed:",
      err
    );

    return error(
      "Не вдалося оновити статус",
      headers,
      500
    );
  }

  let object = null;

  if (current.object_id) {
    object = await env.DB.prepare(`
      SELECT
        id,
        object_code,
        name,
        status
      FROM objects
      WHERE id = ?
      LIMIT 1
    `)
      .bind(current.object_id)
      .first();

    if (object) {
      object.status_label =
        statusLabel(object.status);

      object.updated =
        syncObject;
    }
  }

  return json({
    ok: true,
    request: {
      id: current.id,
      request_code:
        current.request_code,
      old_status:
        oldStatus,
      old_status_label:
        oldLabel,
      status:
        newStatus,
      status_label:
        newLabel,
    },
    object,
    event: {
      event_type: "status_changed",
      content: eventContent,
      author_type: "system",
    },
  }, headers);
}

export async function handleGetEvents(
  request,
  env,
  headers,
  params
) {
  const [requestCode] = params;

  const current = await env.DB.prepare(`
    SELECT
      id,
      request_code,
      status
    FROM requests
    WHERE request_code = ?
    LIMIT 1
  `)
    .bind(requestCode)
    .first();

  if (!current) {
    return error(
      "Заявку не знайдено",
      headers,
      404
    );
  }

  const events = await env.DB.prepare(`
    SELECT
      id,
      request_id,
      object_id,
      event_type,
      content,
      author_type,
      author_id,
      created_at
    FROM events
    WHERE request_id = ?
    ORDER BY id ASC
  `)
    .bind(current.id)
    .all();

  return json({
    ok: true,
    request: {
      id: current.id,
      request_code:
        current.request_code,
      status:
        current.status,
      status_label:
        statusLabel(current.status),
    },
    events:
      events.results || [],
  }, headers);
}

export async function handleAttachClient(
  request,
  env,
  headers,
  params
) {
  const [requestCode] = params;

  const req = await env.DB.prepare(`
    SELECT *
    FROM requests
    WHERE request_code = ?
    LIMIT 1
  `)
    .bind(requestCode)
    .first();

  if (!req) {
    return error(
      "Заявку не знайдено",
      headers,
      404
    );
  }

  if (req.client_id) {
    const client = await env.DB.prepare(`
      SELECT
        id,
        name,
        phone
      FROM clients
      WHERE id = ?
      LIMIT 1
    `)
      .bind(req.client_id)
      .first();

    return json({
      ok: true,
      created: false,
      existing: true,
      request: req,
      client,
    }, headers);
  }

  const normalizedPhone =
    normalizePhone(req.phone);

  if (!normalizedPhone) {
    return error(
      "Некоректний телефон у заявці",
      headers,
      400
    );
  }

  let client = await env.DB.prepare(`
    SELECT
      id,
      name,
      phone
    FROM clients
    WHERE phone = ?
    LIMIT 1
  `)
    .bind(normalizedPhone)
    .first();

  let created = false;

  if (!client) {
    const ins = await env.DB.prepare(`
      INSERT INTO clients (
        name,
        phone
      )
      VALUES (?, ?)
    `)
      .bind(
        req.name || "—",
        normalizedPhone
      )
      .run();

    if (!ins.meta?.last_row_id) {
      return error(
        "Не вдалося створити клієнта",
        headers,
        500
      );
    }

    client = await env.DB.prepare(`
      SELECT
        id,
        name,
        phone
      FROM clients
      WHERE id = ?
      LIMIT 1
    `)
      .bind(ins.meta.last_row_id)
      .first();

    created = true;
  }

  await env.DB.prepare(`
    UPDATE requests
    SET
      client_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `)
    .bind(
      client.id,
      req.id
    )
    .run();

  return json({
    ok: true,
    created,
    existing: !created,
    request: {
      ...req,
      client_id: client.id,
    },
    client,
  }, headers);
}

/* =========================================================
 * POST /telegram-webhook
 * ========================================================= */

export async function handleTelegramWebhook(
  request,
  env,
  headers
) {
  let update;

  try {
    update = await request.json();
  } catch {
    return json(
      { ok: false },
      headers,
      400
    );
  }

  /* -------------------------------------------------------
   * Звичайні повідомлення / команди
   * ----------------------------------------------------- */

  if (update.message) {
    const msg = update.message;

    if (
      String(msg.from?.id) !==
      String(env.CHAT_ID)
    ) {
      return json(
        { ok: true },
        headers
      );
    }

    const text =
      String(msg.text || "").trim();

    const adminCommand =
      text.split(/\s+/)[0]
        .split("@")[0]
        .toLowerCase();

    if (adminCommand === "/start") {
      await deleteIncomingCommand(env, msg);

      await removeStatsMessage(
        env,
        msg.chat?.id
      );

      const sent =
        await sendAdminMenu(env);

      if (
        sent?.ok &&
        sent?.result?.message_id != null
      ) {
        await rememberStatsMessage(
          env,
          sent.result.chat?.id ??
            msg.chat?.id ??
            env.CHAT_ID,
          sent.result.message_id
        );
      }

      return json(
        { ok: true },
        headers
      );
    }

    if (adminCommand === "/requests") {
      await deleteIncomingCommand(env, msg);

      await removeStatsMessage(
        env,
        msg.chat?.id
      );

      await sendRequestsMenu(env);

      return json(
        { ok: true },
        headers
      );
    }

    if (adminCommand === "/masters") {
      await deleteIncomingCommand(env, msg);

      await removeStatsMessage(
        env,
        msg.chat?.id
      );

      await sendMastersMenu(env);

      return json(
        { ok: true },
        headers
      );
    }

    return json(
      { ok: true },
      headers
    );
  }

  /* -------------------------------------------------------
   * Callback-и inline-кнопок
   * ----------------------------------------------------- */

  if (!update.callback_query) {
    return json(
      { ok: true },
      headers
    );
  }

  const cq = update.callback_query;

  if (
    String(cq.from?.id) !==
    String(env.CHAT_ID)
  ) {
    await answerCallbackQuery(
      env,
      cq.id,
      "❌ Немає доступу",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const data =
    String(cq.data || "");

  const chatId =
    cq.message?.chat?.id;

  const messageId =
    cq.message?.message_id;

  const workerOrigin =
    new URL(request.url).origin;

  if (!canEditMessage(chatId, messageId)) {
    await answerCallbackQuery(
      env,
      cq.id,
      "❌ Не вдалося визначити повідомлення адмінки",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (data === "admin_close") {
    await deleteTelegramMessage(
      env,
      chatId,
      messageId
    );

    await answerCallbackQuery(
      env,
      cq.id,
      ""
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (data === "requests_list") {
    await sendRequestsMenu(
      env,
      chatId,
      messageId
    );

    await answerCallbackQuery(
      env,
      cq.id,
      ""
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (
    data.startsWith("request_open:")
  ) {
    await showRequestCard(
      env,
      cq.id,
      data.slice(13),
      workerOrigin,
      chatId,
      messageId
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (data === "masters_list") {
    await sendMastersMenu(
      env,
      chatId,
      messageId
    );

    await answerCallbackQuery(
      env,
      cq.id,
      ""
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (
    data.startsWith("master_open:")
  ) {
    await showMasterCard(
      env,
      cq.id,
      Number(data.slice(12)),
      chatId,
      messageId
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (
    data.startsWith("master_block:")
  ) {
    const masterId =
      Number(data.slice(13));

    const changed =
      await blockMaster(
        env,
        cq.id,
        masterId
      );

    if (changed) {
      await showMasterCard(
        env,
        "",
        masterId,
        chatId,
        messageId
      );
    }

    return json(
      { ok: true },
      headers
    );
  }

  if (
    data.startsWith("master_unblock:")
  ) {
    const masterId =
      Number(data.slice(15));

    const changed =
      await unblockMaster(
        env,
        cq.id,
        masterId
      );

    if (changed) {
      await showMasterCard(
        env,
        "",
        masterId,
        chatId,
        messageId
      );
    }

    return json(
      { ok: true },
      headers
    );
  }

  if (
    data.startsWith("master_delete_ask:")
  ) {
    const masterId =
      Number(data.slice(18));

    const master =
      await getAdminMaster(
        env,
        masterId
      );

    if (!master) {
      await answerCallbackQuery(
        env,
        cq.id,
        "❌ Майстра не знайдено",
        true
      );

      return json(
        { ok: true },
        headers
      );
    }

    const masterLabel =
      master.username
        ? `@${master.username}`
        : master.first_name ||
          `Майстер #${master.id}`;

    await editMessageText(
      env,
      chatId,
      messageId,
      [
        "⚠️ ВИДАЛИТИ МАЙСТРА НАЗАВЖДИ?",
        "",
        `👤 ${masterLabel}`,
        `📞 ${master.phone || "—"}`,
        "",
        "Буде видалено профіль, анкету, статистику та відомі персональні дані майстра.",
        "",
        "Клієнтські заявки та їх історія залишаться, але прив'язка до цього майстра буде очищена.",
        "",
        "Цю дію неможливо скасувати.",
      ].join("\n"),
      [[
        {
          text: "🗑 Видалити",
          callback_data:
            `master_delete_confirm:${master.id}`,
        },
        {
          text: "Скасувати",
          callback_data:
            `master_open:${master.id}`,
        },
      ]]
    );

    await answerCallbackQuery(
      env,
      cq.id,
      ""
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (
    data.startsWith("master_delete_confirm:")
  ) {
    await deleteMasterPermanently(
      env,
      cq.id,
      Number(data.slice(22)),
      chatId,
      messageId
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (data.startsWith("details:")) {
    return handleTelegramDetails(
      env,
      headers,
      data.slice(8),
      cq.id,
      chatId,
      messageId
    );
  }

  if (data.startsWith("status:")) {
    const [
      ,
      requestCode,
      newStatus,
    ] = data.split(":");

    return handleTelegramStatusUpdate(
      env,
      headers,
      requestCode,
      newStatus,
      cq.id,
      chatId,
      messageId,
      workerOrigin
    );
  }

  if (
    data.startsWith("transfer_to_jobs:")
  ) {
    return handleTransferToJobs(
      env,
      headers,
      data.slice(17),
      cq,
      chatId,
      messageId,
      workerOrigin
    );
  }

  if (data.startsWith("app_approve:")) {
    const {
      handleApplicationReview,
    } = await import("./join.js");

    return handleApplicationReview(
      env,
      headers,
      Number(data.slice(12)),
      "approve",
      cq
    );
  }

  if (data.startsWith("app_reject:")) {
    const {
      handleApplicationReview,
    } = await import("./join.js");

    return handleApplicationReview(
      env,
      headers,
      Number(data.slice(11)),
      "reject",
      cq
    );
  }

  await answerCallbackQuery(
    env,
    cq.id,
    "❓ Невідома дія",
    true
  );

  return json(
    { ok: true },
    headers
  );
}

/* =========================================================
 * TELEGRAM: деталі заявки
 * ========================================================= */

async function handleTelegramDetails(
  env,
  headers,
  requestCode,
  callbackId,
  chatId,
  messageId
) {
  const req = await env.DB.prepare(`
    SELECT *
    FROM requests
    WHERE request_code = ?
    LIMIT 1
  `)
    .bind(requestCode)
    .first();

  if (!req) {
    await answerCallbackQuery(
      env,
      callbackId,
      "❌ Заявку не знайдено",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const events = await env.DB.prepare(`
    SELECT
      event_type,
      content,
      created_at
    FROM events
    WHERE request_id = ?
    ORDER BY id ASC
  `)
    .bind(req.id)
    .all();

  const lines = [
    formatRequestText(req),
    "",
    `🕐 Створено: ${req.created_at || "—"}`,
    `🕐 Оновлено: ${req.updated_at || "—"}`,
    req.transferred_to_jobs
      ? "🤝 SA-MASTER Jobs: передано майстрам"
      : "🤝 SA-MASTER Jobs: не передано",
    req.assigned_master_name
      ? `🙋 Закріплено за: ${req.assigned_master_name}`
      : null,
  ].filter(Boolean);

  if (events.results?.length) {
    lines.push(
      "",
      "📜 Історія:"
    );

    for (
      const ev of events.results.slice(-10)
    ) {
      lines.push(
        `• ${ev.content}`
      );
    }
  }

  await editMessageText(
    env,
    chatId,
    messageId,
    lines.join("\n"),
    [[
      {
        text: "⬅️ До заявки",
        callback_data:
          `request_open:${requestCode}`,
      },
      {
        text: "❌ Закрити",
        callback_data: "admin_close",
      },
    ]]
  );

  await answerCallbackQuery(
    env,
    callbackId,
    ""
  );

  return json(
    { ok: true },
    headers
  );
}

/* =========================================================
 * TELEGRAM: зміна статусу
 * ========================================================= */

async function handleTelegramStatusUpdate(
  env,
  headers,
  requestCode,
  newStatus,
  callbackId,
  chatId,
  messageId,
  workerOrigin
) {
  if (!isValidStatus(newStatus)) {
    await answerCallbackQuery(
      env,
      callbackId,
      "❌ Невідомий статус",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const current = await env.DB.prepare(`
    SELECT
      id,
      request_code,
      status,
      object_id,
      name,
      phone
    FROM requests
    WHERE request_code = ?
    LIMIT 1
  `)
    .bind(requestCode)
    .first();

  if (!current) {
    await answerCallbackQuery(
      env,
      callbackId,
      "❌ Заявку не знайдено",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (
    !canChangeStatus(
      current.status,
      newStatus
    )
  ) {
    await answerCallbackQuery(
      env,
      callbackId,
      `❌ Неможливо: статус «${statusLabel(current.status)}» → «${statusLabel(newStatus)}»`,
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const oldLabel =
    statusLabel(current.status);

  const newLabel =
    statusLabel(newStatus);

  const eventContent =
    `${oldLabel} → ${newLabel}`;

  try {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE requests
        SET
          status = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        newStatus,
        current.id
      ),

      env.DB.prepare(`
        INSERT INTO events (
          object_id,
          request_id,
          event_type,
          content,
          author_type
        )
        VALUES (
          ?,
          ?,
          'status_changed',
          ?,
          'system'
        )
      `).bind(
        current.object_id || null,
        current.id,
        eventContent
      ),
    ]);
  } catch (err) {
    console.error(
      "Telegram status update failed:",
      err
    );

    await answerCallbackQuery(
      env,
      callbackId,
      "❌ Помилка збереження",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const req = await env.DB.prepare(`
    SELECT *
    FROM requests
    WHERE id = ?
    LIMIT 1
  `)
    .bind(current.id)
    .first();

  const text = [
    `🏠 ЗАЯВКА ${req.request_code}`,
    "",
    `👤 ${req.name || "—"}`,
    `📞 ${req.phone || "—"}`,
    `🔧 ${req.type_label || req.type || "—"}`,
    `📍 ${req.location || "—"}`,
    `📊 Статус: ${newLabel}`,
    req.transferred_to_jobs
      ? "🤝 Доступна майстрам SA-MASTER Jobs"
      : null,
    req.assigned_master_name
      ? `🙋 Майстер: ${req.assigned_master_name}`
      : null,
    `🕐 Оновлено: ${new Date().toLocaleString(
      "uk-UA",
      { timeZone: "Europe/Kyiv" }
    )}`,
  ]
    .filter(Boolean)
    .join("\n");

  const buttons = buildStatusButtons(
    req.request_code,
    newStatus,
    calculatorUrl(
      req.request_code,
      req.estimate_token,
      workerOrigin,
      env
    )
  );

  if (!req.transferred_to_jobs) {
    buttons.push([{
      text: "🤝 Передати майстрам",
      callback_data: `transfer_to_jobs:${req.request_code}`,
    }]);
  }

  buttons.push([{
    text: "ℹ️ Деталі",
    callback_data: `details:${req.request_code}`,
  }]);

  buttons.push([
    {
      text: "📋 До заявок",
      callback_data: "requests_list",
    },
    {
      text: "❌ Закрити",
      callback_data: "admin_close",
    },
  ]);

  await editMessageText(
    env,
    chatId,
    messageId,
    text,
    buttons
  );

  await answerCallbackQuery(
    env,
    callbackId,
    `✅ ${newLabel}`
  );

  return json(
    { ok: true },
    headers
  );
}

/* =========================================================
 * TELEGRAM: передача заявки майстрам SA-MASTER Jobs
 *
 * Група більше не використовується.
 * publishRequestToJobs() робить заявку доступною в Jobs-боті.
 * ========================================================= */

async function handleTransferToJobs(
  env,
  headers,
  requestCode,
  cq,
  chatId,
  messageId,
  workerOrigin
) {
  const req = await env.DB.prepare(`
    SELECT *
    FROM requests
    WHERE request_code = ?
    LIMIT 1
  `)
    .bind(requestCode)
    .first();

  if (!req) {
    await answerCallbackQuery(
      env,
      cq.id,
      "❌ Заявку не знайдено",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (req.transferred_to_jobs) {
    await answerCallbackQuery(
      env,
      cq.id,
      "⚠️ Заявка вже доступна майстрам",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const result =
    await publishRequestToJobs(
      env,
      req
    );

  if (!result.ok) {
    console.error(
      "Publish to SA-MASTER Jobs failed:",
      result.description || result
    );

    await answerCallbackQuery(
      env,
      cq.id,
      "❌ Не вдалося передати заявку",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  /*
   * publishRequestToJobs() уже виставив:
   *
   * transferred_to_jobs = 1
   * transferred_at
   * updated_at
   *
   * Тут НЕ дублюємо UPDATE.
   * Додаємо лише подію.
   */

  try {
    await env.DB.prepare(`
      INSERT INTO events (
        object_id,
        request_id,
        event_type,
        content,
        author_type
      )
      VALUES (
        ?,
        ?,
        'transferred_to_jobs',
        'Передано майстрам SA-MASTER Jobs',
        'system'
      )
    `)
      .bind(
        req.object_id || null,
        req.id
      )
      .run();
  } catch (err) {
    console.error(
      "Save transferred_to_jobs event failed:",
      err
    );
  }

  const updated = await env.DB.prepare(`
    SELECT *
    FROM requests
    WHERE id = ?
    LIMIT 1
  `)
    .bind(req.id)
    .first();

  const updatedText = [
    `🏠 ЗАЯВКА ${updated.request_code}`,
    "",
    `👤 ${updated.name || "—"}`,
    `📞 ${updated.phone || "—"}`,
    `🔧 ${updated.type_label || updated.type || "—"}`,
    `📍 ${updated.location || "—"}`,
    `📊 Статус: ${statusLabel(updated.status)}`,
    "",
    "🤝 Передано майстрам SA-MASTER Jobs",
    "📋 Заявка тепер доступна у Jobs-боті.",
    `🕐 ${new Date().toLocaleString(
      "uk-UA",
      { timeZone: "Europe/Kyiv" }
    )}`,
  ].join("\n");

  const buttons = buildStatusButtons(
    updated.request_code,
    updated.status,
    calculatorUrl(
      updated.request_code,
      updated.estimate_token,
      workerOrigin,
      env
    )
  );

  buttons.push([{
    text: "ℹ️ Деталі",
    callback_data: `details:${updated.request_code}`,
  }]);

  buttons.push([
    {
      text: "📋 До заявок",
      callback_data: "requests_list",
    },
    {
      text: "❌ Закрити",
      callback_data: "admin_close",
    },
  ]);

  await editMessageText(
    env,
    chatId,
    messageId,
    updatedText,
    buttons
  );

  await answerCallbackQuery(
    env,
    cq.id,
    "✅ Передано майстрам"
  );

  return json(
    { ok: true },
    headers
  );
}
