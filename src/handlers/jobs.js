import { json } from "../lib/json.js";
import {
  sendToMaster,
  answerJobsCallback,
  setMasterMenu,
  activateMasterBot,
  deleteMasterMessage,
  sendFileToMaster,
  editMasterMessage,
} from "../lib/telegram-jobs.js";
import { sendTelegram, sendMessageWithButtons } from "../lib/telegram.js";
import {
  buildMasterOutcomeButtons,
  buildMasterNotAgreedReasonButtons,
  buildAgreedJobButtons,
  buildStartedJobButtons,
  buildContactButtons,
} from "../lib/telegram-buttons.js";
import {
  handleJoinStart,
  handleJoinMessage,
  handleApplicationReview,
} from "./join.js";

const SITE_URL = "https://sa-master.pro/";

async function getMasterByTelegramId(env, telegramId) {
  return env.DB.prepare(
    "SELECT * FROM masters WHERE telegram_id = ? LIMIT 1"
  ).bind(telegramId).first();
}

async function ensureActiveMaster(env, telegramId) {
  const master = await getMasterByTelegramId(env, telegramId);
  return { master, active: Boolean(master && master.status === "active") };
}

function masterAccessMessage(status) {
  if (status === "blocked") {
    return "🚫 ДОСТУП ЗАБОРОНЕНО\n\nВаш профіль SA-MASTER Jobs заблоковано адміністратором.\n\nДля відновлення доступу зверніться до адміністратора.";
  }
  if (status === "inactive") {
    return "⚪ ПРОФІЛЬ НЕАКТИВНИЙ\n\nВаш профіль SA-MASTER Jobs зараз неактивний.\n\nДля відновлення доступу відкрийте бота та натисніть /start.";
  }
  return "❌ ДОСТУП ВІДСУТНІЙ\n\nВи не зареєстровані в SA-MASTER Jobs.";
}

function masterDisplayName(master, fromUser = {}) {
  return master?.username
    ? `@${master.username}`
    : master?.first_name || fromUser?.first_name || `ID ${fromUser?.id || "—"}`;
}

async function saveEvent(env, req, eventType, content, master) {
  try {
    await env.DB.prepare(`
      INSERT INTO events
      (object_id, request_id, event_type, content, author_type, author_id)
      VALUES (?, ?, ?, ?, 'master', ?)
    `).bind(
      req.object_id || null,
      req.id,
      eventType,
      content,
      String(master.id)
    ).run();
  } catch (err) {
    console.error(`Save ${eventType} event failed:`, err);
  }
}

async function saveOutcome(env, req, masterId, outcome) {
  try {
    await env.DB.prepare(`
      INSERT INTO request_outcomes (request_id, master_id, outcome)
      VALUES (?, ?, ?)
    `).bind(req.id, masterId, outcome).run();
  } catch (err) {
    console.error("Save outcome failed:", err);
  }
}

async function notifyAdmin(env, lines, buttons = null) {
  try {
    if (buttons?.length) {
      return await sendMessageWithButtons(env, lines.join("\n"), buttons);
    }
    return await sendTelegram(env, lines.join("\n"));
  } catch (err) {
    console.error("Admin notification failed:", err);
  }
}

async function getAssignedRequest(env, requestCode, masterId) {
  const req = await env.DB.prepare(`
    SELECT * FROM requests WHERE request_code = ? LIMIT 1
  `).bind(requestCode).first();

  if (!req) return { req: null, error: "❌ Заявку не знайдено" };

  if (String(req.assigned_master_id || "") !== String(masterId)) {
    return { req, error: "❌ Ця заявка більше не закріплена за вами" };
  }

  return { req, error: null };
}

/* ========================= CLEAN CHAT UI ========================= */

async function ensureMasterUiStateTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS master_ui_state (
      chat_id TEXT PRIMARY KEY,
      transient_message_id INTEGER,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function clearTransient(env, chatId) {
  try {
    await ensureMasterUiStateTable(env);
    const row = await env.DB.prepare(`
      SELECT transient_message_id
      FROM master_ui_state
      WHERE chat_id = ?
      LIMIT 1
    `).bind(String(chatId)).first();

    if (row?.transient_message_id) {
      await deleteMasterMessage(env, chatId, row.transient_message_id);
    }

    await env.DB.prepare(`
      DELETE FROM master_ui_state WHERE chat_id = ?
    `).bind(String(chatId)).run();
  } catch (err) {
    console.error("Clear transient Jobs UI failed:", err);
  }
}

async function rememberTransient(env, chatId, result) {
  const messageId = result?.result?.message_id;
  if (!messageId) return result;

  try {
    await ensureMasterUiStateTable(env);
    await env.DB.prepare(`
      INSERT INTO master_ui_state (chat_id, transient_message_id, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id) DO UPDATE SET
        transient_message_id = excluded.transient_message_id,
        updated_at = CURRENT_TIMESTAMP
    `).bind(String(chatId), Number(messageId)).run();
  } catch (err) {
    console.error("Remember transient Jobs UI failed:", err);
  }

  return result;
}

async function sendTransient(env, chatId, text, buttons = null) {
  await clearTransient(env, chatId);
  const result = await sendToMaster(env, chatId, text, buttons);
  return rememberTransient(env, chatId, result);
}

/* ========================= HOME ========================= */

async function sendHome(env, chatId, master) {
  const referralLink = await getMasterReferralLink(env, master.telegram_id);

  await clearTransient(env, chatId);
  const result = await setMasterMenu(
    env,
    chatId,
    referralLink,
    [
      "🔧 SA-MASTER Jobs",
      "",
      master?.first_name ? `Вітаємо, ${master.first_name}!` : "Вітаємо!",
      "",
      "Нові доступні заявки автоматично з’являються в цьому чаті.",
      "",
      "Для керування використовуйте меню внизу:",
      "🔧 Мої заявки — ваші активні заявки",
      "➕ Передати — передати заявку іншому майстру",
      "❓ Допомога — правила роботи з ботом",
    ].join("\n")
  );

  return rememberTransient(env, chatId, result);
}

async function getMasterReferralLink(env, telegramId) {
  const master = await getMasterByTelegramId(env, telegramId);
  if (!master || master.status !== "active") return null;

  let token = master.referral_token;

  if (!token) {
    token = crypto.randomUUID().replaceAll("-", "");

    try {
      await env.DB.prepare(`
        UPDATE masters
        SET referral_token = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND referral_token IS NULL AND status = 'active'
      `).bind(token, master.id).run();

      const updated = await env.DB.prepare(`
        SELECT referral_token, status FROM masters WHERE id = ? LIMIT 1
      `).bind(master.id).first();

      if (!updated || updated.status !== "active") return null;
      token = updated.referral_token || token;
    } catch (err) {
      console.error("Referral token generation failed:", err);
      return null;
    }
  }

  const url = new URL(SITE_URL);
  url.searchParams.set("ref", token);
  url.searchParams.set("request", "1");
  return url.toString();
}

/* ========================= PUBLIC JOB CARD ========================= */

function publicJobText(req, returned = false) {
  return [
    returned ? "↩️ ЗАЯВКА ЗНОВУ ДОСТУПНА" : "🔔 НОВА ЗАЯВКА",
    `🆔 ${req.request_code || "—"}`,
    "",
    `🔧 ${req.type_label || req.type || "—"}`,
    `📍 ${req.location || "—"}`,
    req.project ? `📐 Дизайн-проєкт: ${req.project}` : null,
    req.timing ? `🗓 Початок: ${req.timing}` : null,
    req.source ? `🔗 Джерело: ${req.source}` : null,
    req.notes ? `📝 Опис: ${String(req.notes).replace(/^Опис роботи:\s*/i, "")}` : null,
    "",
    "🔒 Ім'я та телефон замовника приховані.",
    "",
    "Якщо заявка підходить — натисніть «🤝 Беру в роботу».",
  ].filter(Boolean).join("\n");
}

function publicJobButtons(req) {
  return [[{
    text: "🤝 Беру в роботу",
    callback_data: `take:${req.request_code}`,
  }]];
}

async function broadcastJob(env, req, returned = false) {
  const rows = await env.DB.prepare(`
    SELECT id, telegram_id
    FROM masters
    WHERE status = 'active' AND telegram_id IS NOT NULL
    ORDER BY id ASC
  `).all();

  const masters = rows.results || [];
  let delivered = 0;
  let failed = 0;

  for (const master of masters) {
    try {
      const result = await sendToMaster(
        env,
        master.telegram_id,
        publicJobText(req, returned),
        publicJobButtons(req)
      );
      if (result?.ok) delivered++;
      else failed++;
    } catch (err) {
      failed++;
      console.error(`Job delivery failed for master ${master.id}:`, err);
    }
  }

  return { total: masters.length, delivered, failed };
}

async function broadcastRequestAttachments(env, req) {
  if (!req?.id || !env.FILES) return;

  try {
    const [mastersResult, filesResult] = await Promise.all([
      env.DB.prepare(`
        SELECT telegram_id
        FROM masters
        WHERE status = 'active' AND telegram_id IS NOT NULL
        ORDER BY id ASC
      `).all(),
      env.DB.prepare(`
        SELECT name, file_type, storage_key, uploaded_by
        FROM request_files
        WHERE request_id = ?
        ORDER BY id ASC
      `).bind(req.id).all(),
    ]);

    const files = filesResult.results || [];
    if (!files.length) return;

    for (const file of files) {
      const stored = await env.FILES.get(file.storage_key);
      if (!stored) continue;
      const bytes = await stored.arrayBuffer();
      const isPhoto = file.uploaded_by === "master_photo";

      for (const master of mastersResult.results || []) {
        await sendFileToMaster(env, master.telegram_id, {
          name: file.name,
          fileType: file.file_type,
          bytes,
          caption: isPhoto
            ? `📷 Фото об’єкта · ${req.request_code}`
            : `📐 Дизайн-проєкт · ${req.request_code}`,
        });
      }
    }
  } catch (err) {
    console.error("Jobs request attachments broadcast failed:", err);
  }
}

/* ========================= PUBLICATION ========================= */

export async function publishRequestToJobs(env, request) {
  if (!request?.id && !request?.request_code) {
    return { ok: false, description: "REQUEST_NOT_FOUND" };
  }

  try {
    const req = request.id
      ? await env.DB.prepare("SELECT * FROM requests WHERE id = ? LIMIT 1").bind(request.id).first()
      : await env.DB.prepare("SELECT * FROM requests WHERE request_code = ? LIMIT 1").bind(request.request_code).first();

    if (!req) return { ok: false, description: "Заявку не знайдено" };

    if (Number(req.transferred_to_jobs || 0) === 1) {
      return { ok: true, already_published: true, request_code: req.request_code };
    }

    const result = await env.DB.prepare(`
      UPDATE requests
      SET transferred_to_jobs = 1,
          transferred_at = COALESCE(transferred_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND COALESCE(transferred_to_jobs, 0) = 0
    `).bind(req.id).run();

    if (!result.meta?.changes) {
      return { ok: true, already_published: true, request_code: req.request_code };
    }

    const fresh = await env.DB.prepare(
      "SELECT * FROM requests WHERE id = ? LIMIT 1"
    ).bind(req.id).first();

    const publishedRequest = fresh || req;
    const delivery = await broadcastJob(env, publishedRequest);
    await broadcastRequestAttachments(env, publishedRequest);

    return {
      ok: true,
      request_code: req.request_code,
      recipients: delivery.total,
      delivered: delivery.delivered,
      failed: delivery.failed,
    };
  } catch (err) {
    console.error("Publish request to Jobs failed:", err);
    return { ok: false, description: String(err?.message || err) };
  }
}

export async function publishRequestToJobsGroup(env, request) {
  return publishRequestToJobs(env, request);
}

/* ========================= HIDDEN /jobs ========================= */

async function showAvailableJobs(env, chatId) {
  const rows = await env.DB.prepare(`
    SELECT *
    FROM requests
    WHERE transferred_to_jobs = 1
      AND assigned_master_id IS NULL
      AND status NOT IN ('cancelled', 'installation', 'completed')
    ORDER BY
      CASE priority
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        ELSE 4
      END,
      id DESC
    LIMIT 20
  `).all();

  const jobs = rows.results || [];

  if (!jobs.length) {
    return sendToMaster(
      env,
      chatId,
      "📋 ДОСТУПНІ ЗАЯВКИ\n\nЗараз немає вільних заявок.\n\nНові заявки автоматично з'являться прямо в цьому чаті."
    );
  }

  await sendToMaster(env, chatId, `📋 АКТУАЛЬНІ ВІЛЬНІ ЗАЯВКИ\n\nЗараз доступно: ${jobs.length}`);

  for (const req of jobs) {
    await sendToMaster(env, chatId, publicJobText(req), publicJobButtons(req));
  }
}

/* ========================= MY JOBS ========================= */

async function getMyJobs(env, masterId) {
  const rows = await env.DB.prepare(`
    SELECT *
    FROM requests
    WHERE assigned_master_id = ?
      AND status NOT IN ('completed', 'cancelled')
    ORDER BY
      CASE status
        WHEN 'installation' THEN 1
        WHEN 'approved' THEN 2
        ELSE 3
      END,
      assigned_at DESC,
      id DESC
    LIMIT 30
  `).bind(masterId).all();

  return rows.results || [];
}

function myJobStep(req) {
  if (req.status === "installation") return "🔧 Виконуєте роботи";
  if (req.status === "approved") return "⏳ Очікуємо початку робіт";
  return "📞 Потрібно зв'язатися із замовником";
}

async function showMyJobs(env, chatId, master) {
  const jobs = await getMyJobs(env, master.id);

  if (!jobs.length) {
    return sendTransient(
      env, chatId,
      "🔧 МОЇ ЗАЯВКИ\n\nУ вас зараз немає активних заявок.\n\nНові доступні заявки з'являються прямо в чаті.",
      [[{ text: "🏠 Головна", callback_data: "jobs_home" }]]
    );
  }

  const buttons = jobs.map(req => [{
    text: `${myJobStep(req)} · ${req.request_code}`,
    callback_data: `my_job_open:${req.request_code}`,
  }]);
  buttons.push([{ text: "🏠 Головна", callback_data: "jobs_home" }]);

  return sendTransient(
    env, chatId,
    `🔧 МОЇ ЗАЯВКИ\n\nАктивних: ${jobs.length}\n\nОберіть заявку:`,
    buttons
  );
}

async function showMyJobCard(env, chatId, master, requestCode) {
  const { req, error } = await getAssignedRequest(env, requestCode, master.id);
  if (error) return sendToMaster(env, chatId, error);

  const base = [
    `🔧 МОЯ ЗАЯВКА ${req.request_code}`, "",
    `👤 ${req.name || "—"}`,
    `📞 ${req.phone || "—"}`,
    `🔧 ${req.type_label || req.type || "—"}`,
    `📍 ${req.location || "—"}`,
    req.timing ? `🗓 ${req.timing}` : null,
    req.notes ? `📝 ${req.notes}` : null, "",
  ].filter(Boolean);

  if (req.status === "installation") {
    base.push("👉 НАСТУПНИЙ КРОК:", "Після фактичного завершення натисніть «✅ Роботи завершено».");
    return sendToMaster(env, chatId, base.join("\n"), buildStartedJobButtons(req.request_code));
  }

  if (req.status === "approved") {
    base.push("👉 НАСТУПНИЙ КРОК:", "Коли фактично почнете виконувати роботи — натисніть «🔧 Роботи розпочато».");
    return sendToMaster(env, chatId, base.join("\n"), buildAgreedJobButtons(req.request_code));
  }

  base.push(
    "👉 НАСТУПНИЙ КРОК:",
    "1. Зв'яжіться із замовником.",
    "2. Одразу після розмови зафіксуйте результат у боті."
  );

  return sendToMaster(env, chatId, base.join("\n"), buildContactButtons(req.request_code, req.phone));
}

/* ========================= HELP / SUBMIT ========================= */

async function showHelp(env, chatId) {
  return sendTransient(
    env, chatId,
    [
      "❓ ЯК КОРИСТУВАТИСЯ SA-MASTER Jobs", "",
      "1️⃣ Нові заявки автоматично з'являються прямо в чаті.",
      "2️⃣ Натискайте «🤝 Беру в роботу» лише якщо готові зв'язатися із замовником.",
      "3️⃣ Після взяття заявка переходить у «🔧 Мої заявки».",
      "4️⃣ Зателефонуйте замовнику та одразу позначте результат.",
      "5️⃣ Якщо домовились — після фактичного старту натисніть «🔧 Роботи розпочато».",
      "6️⃣ Після завершення — «✅ Роботи завершено».", "",
      "💡 Старі повідомлення залишаються в історії чату.",
      "Якщо заявку вже забрав інший майстер, повторно взяти її не вийде.",
    ].join("\n"),
    [[{ text: "🏠 Головна", callback_data: "jobs_home" }]]
  );
}

async function showSubmitRequest(env, chatId, telegramId) {
  const referralLink = await getMasterReferralLink(env, telegramId);
  if (!referralLink) return sendTransient(env, chatId, "❌ Не вдалося створити посилання.");

  return sendTransient(
    env, chatId,
    "➕ ПЕРЕДАТИ ЗАЯВКУ\n\nНатисніть кнопку нижче та заповніть заявку від імені замовника.\n\nЗаявка автоматично буде прив'язана до вашого профілю SA-MASTER Jobs.",
    [
      [{ text: "➕ Заповнити заявку", url: referralLink }],
      [{ text: "🏠 Головна", callback_data: "jobs_home" }],
    ]
  );
}

async function handleMenuText(env, headers, chatId, fromUser, text) {
  const access = await ensureActiveMaster(env, fromUser.id);

  if (!access.active) {
    await sendToMaster(env, chatId, masterAccessMessage(access.master?.status));
    return json({ ok: true }, headers);
  }

  if (text === "🔧 Мої заявки") {
    await showMyJobs(env, chatId, access.master);
    return json({ ok: true }, headers);
  }

  if (["➕ Передати", "➕ Передати заявку"].includes(text)) {
    await showSubmitRequest(env, chatId, fromUser.id);
    return json({ ok: true }, headers);
  }

  if (text === "❓ Допомога") {
    await showHelp(env, chatId);
    return json({ ok: true }, headers);
  }

  return null;
}

/* ========================= WEBHOOK ========================= */

export async function handleJobsWebhook(request, env, headers) {
  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: false }, headers, 400);
  }

  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat?.id;
    const fromUser = msg.from;
    const text = String(msg.text || "").trim();

    if (!fromUser?.id) return json({ ok: true }, headers);
    await activateMasterBot(env, fromUser.id);

    if (text === "/start" || text.startsWith("/start ")) {
      const master = await getMasterByTelegramId(env, fromUser.id);
      if (master?.status === "active") {
        await sendHome(env, chatId, master);
        return json({ ok: true }, headers);
      }
      if (master) {
        await sendToMaster(env, chatId, masterAccessMessage(master.status));
        return json({ ok: true }, headers);
      }
      return handleJoinStart(env, headers, chatId, fromUser);
    }

    if (text === "/join" || text.startsWith("/join ")) {
      const master = await getMasterByTelegramId(env, fromUser.id);
      if (master?.status === "active") {
        await sendHome(env, chatId, master);
        return json({ ok: true }, headers);
      }
      if (master) {
        await sendToMaster(env, chatId, masterAccessMessage(master.status));
        return json({ ok: true }, headers);
      }
      return handleJoinStart(env, headers, chatId, fromUser);
    }

    if (text === "/jobs" || text.startsWith("/jobs ")) {
      const access = await ensureActiveMaster(env, fromUser.id);
      if (!access.active) {
        await sendToMaster(env, chatId, masterAccessMessage(access.master?.status));
        return json({ ok: true }, headers);
      }
      await showAvailableJobs(env, chatId);
      return json({ ok: true }, headers);
    }

    const master = await getMasterByTelegramId(env, fromUser.id);
    if (!master) return handleJoinMessage(env, headers, chatId, fromUser, text);

    const menuResult = await handleMenuText(env, headers, chatId, fromUser, text);
    if (menuResult) return menuResult;
    return json({ ok: true }, headers);
  }

  if (!update.callback_query) return json({ ok: true }, headers);

  const cq = update.callback_query;
  const data = String(cq.data || "");
  const chatId = cq.message?.chat?.id || cq.from.id;

  if (cq.from?.id) await activateMasterBot(env, cq.from.id);

  if (data === "join_start") {
    const master = await getMasterByTelegramId(env, cq.from.id);
    if (master?.status === "active") {
      await answerJobsCallback(env, cq.id, "✅ Ви вже зареєстровані");
      await sendHome(env, chatId, master);
      return json({ ok: true }, headers);
    }
    if (master) {
      await answerJobsCallback(env, cq.id, master.status === "blocked" ? "🚫 Ваш профіль заблоковано" : "⚪ Ваш профіль неактивний", true);
      return json({ ok: true }, headers);
    }
    await answerJobsCallback(env, cq.id, "📝 Починаємо анкету");
    return handleJoinStart(env, headers, chatId, cq.from);
  }

  if (data === "jobs_home") {
    const access = await ensureActiveMaster(env, cq.from.id);
    if (!access.active) {
      await answerJobsCallback(env, cq.id, "❌ Немає доступу", true);
      return json({ ok: true }, headers);
    }
    await answerJobsCallback(env, cq.id, "");
    await sendHome(env, chatId, access.master);
    return json({ ok: true }, headers);
  }

  if (data === "jobs_list") {
    const access = await ensureActiveMaster(env, cq.from.id);
    if (!access.active) {
      await answerJobsCallback(env, cq.id, "❌ Немає доступу", true);
      return json({ ok: true }, headers);
    }
    await answerJobsCallback(env, cq.id, "");
    await showAvailableJobs(env, chatId);
    return json({ ok: true }, headers);
  }

  if (data === "my_jobs") {
    const access = await ensureActiveMaster(env, cq.from.id);
    if (!access.active) {
      await answerJobsCallback(env, cq.id, "❌ Немає доступу", true);
      return json({ ok: true }, headers);
    }
    await answerJobsCallback(env, cq.id, "");
    await showMyJobs(env, chatId, access.master);
    return json({ ok: true }, headers);
  }

  if (data.startsWith("my_job_open:")) {
    const access = await ensureActiveMaster(env, cq.from.id);
    if (!access.active) {
      await answerJobsCallback(env, cq.id, "❌ Немає доступу", true);
      return json({ ok: true }, headers);
    }
    await answerJobsCallback(env, cq.id, "");
    await clearTransient(env, chatId);
    await showMyJobCard(env, chatId, access.master, data.slice("my_job_open:".length));
    return json({ ok: true }, headers);
  }

  if (data === "jobs_help") {
    const access = await ensureActiveMaster(env, cq.from.id);
    if (!access.active) {
      await answerJobsCallback(env, cq.id, "❌ Немає доступу", true);
      return json({ ok: true }, headers);
    }
    await answerJobsCallback(env, cq.id, "");
    await showHelp(env, chatId);
    return json({ ok: true }, headers);
  }

  if (data === "submit_request") {
    const access = await ensureActiveMaster(env, cq.from.id);
    if (!access.active) {
      await answerJobsCallback(env, cq.id, "❌ Доступ відсутній", true);
      return json({ ok: true }, headers);
    }
    await answerJobsCallback(env, cq.id, "");
    await showSubmitRequest(env, chatId, cq.from.id);
    return json({ ok: true }, headers);
  }

  if (data.startsWith("contact_done:")) {
    const access = await ensureActiveMaster(env, cq.from.id);
    if (!access.active) {
      await answerJobsCallback(env, cq.id, "❌ Немає доступу", true);
      return json({ ok: true }, headers);
    }

    const requestCode = data.slice("contact_done:".length);
    const { req, error } = await getAssignedRequest(env, requestCode, access.master.id);
    if (error) {
      await answerJobsCallback(env, cq.id, error, true);
      return json({ ok: true }, headers);
    }

    await saveEvent(env, req, "master_contact_confirmed",
      `${masterDisplayName(access.master, cq.from)} підтвердив контакт із замовником`,
      access.master
    );

    await answerJobsCallback(env, cq.id, "✅ Контакт зафіксовано");
    await sendToMaster(
      env, chatId,
      `📞 КОНТАКТ ІЗ ЗАМОВНИКОМ\n\n🆔 ${req.request_code}\n\nОдразу позначте результат розмови:`,
      buildMasterOutcomeButtons(req.request_code)
    );
    return json({ ok: true }, headers);
  }

  if (data.startsWith("take:")) return handleTakeJob(env, headers, data.slice(5), cq);
  if (data.startsWith("outcome:")) {
    const [, requestCode, outcome] = data.split(":");
    return handleMasterOutcome(env, headers, requestCode, outcome, cq);
  }
  if (data.startsWith("outcome_back:")) return handleOutcomeBack(env, headers, data.slice("outcome_back:".length), cq);
  if (data.startsWith("not_agreed_reason:")) {
    const [, requestCode, reason] = data.split(":");
    return handleNotAgreedReason(env, headers, requestCode, reason, cq);
  }
  if (data.startsWith("job_started:")) return handleJobStarted(env, headers, data.slice("job_started:".length), cq);
  if (data.startsWith("cooperation_failed:")) return handleCooperationFailed(env, headers, data.slice("cooperation_failed:".length), cq);
  if (data.startsWith("job_completed:")) return handleJobCompleted(env, headers, data.slice("job_completed:".length), cq);
  if (data.startsWith("app_approve:")) return handleApplicationReview(env, headers, Number(data.slice(12)), "approve", cq);
  if (data.startsWith("app_reject:")) return handleApplicationReview(env, headers, Number(data.slice(11)), "reject", cq);

  await answerJobsCallback(env, cq.id, "❓ Невідома дія", true);
  return json({ ok: true }, headers);
}

/* ========================= TAKE JOB ========================= */

async function handleTakeJob(env, headers, requestCode, cq) {
  const master = await getMasterByTelegramId(env, cq.from.id);

  if (!master || master.status !== "active") {
    await answerJobsCallback(
      env, cq.id,
      master?.status === "blocked" ? "🚫 Ваш профіль заблоковано" : "❌ Немає доступу",
      true
    );
    return json({ ok: true }, headers);
  }

  const req = await env.DB.prepare(`
    SELECT * FROM requests
    WHERE request_code = ? AND transferred_to_jobs = 1
    LIMIT 1
  `).bind(requestCode).first();

  if (!req) {
    await answerJobsCallback(env, cq.id, "❌ Заявку не знайдено", true);
    return json({ ok: true }, headers);
  }

  const masterName = masterDisplayName(master, cq.from);
  const callbackChatId = cq.message?.chat?.id || cq.from.id;
  const callbackMessageId = cq.message?.message_id;

  let assigned;
  try {
    assigned = await env.DB.prepare(`
      UPDATE requests
      SET assigned_master_id = ?,
          assigned_master_name = ?,
          assigned_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND transferred_to_jobs = 1
        AND assigned_master_id IS NULL
        AND status NOT IN ('cancelled', 'installation', 'completed')
    `).bind(master.id, masterName, req.id).run();
  } catch (err) {
    console.error("Take job DB update failed:", err);
    await answerJobsCallback(env, cq.id, "❌ Помилка збереження", true);
    return json({ ok: true }, headers);
  }

  if (!assigned.meta?.changes) {
    await answerJobsCallback(env, cq.id, "❌ Цю заявку вже взяв інший майстер", true);
    return json({ ok: true }, headers);
  }

  await saveEvent(env, req, "master_took_job", `${masterName} взяв заявку`, master);

  const privateText = [
    `✅ ВИ ВЗЯЛИ ЗАЯВКУ ${req.request_code}`,
    "",
    `👤 Клієнт: ${req.name || "—"}`,
    `📞 Телефон: ${req.phone || "—"}`,
    `🔧 Роботи: ${req.type_label || req.type || "—"}`,
    `📍 Об'єкт: ${req.location || "—"}`,
    req.timing ? `🗓 Початок: ${req.timing}` : null,
    req.notes ? `📝 Опис: ${String(req.notes).replace(/^Опис роботи:\s*/i, "")}` : null,
    "",
    "👉 ЗАРАЗ ПОТРІБНО:",
    "1. Зв'язатися із замовником.",
    "2. Після розмови натиснути «✅ Я зв'язався» та вказати результат.",
    "",
    "Заявка збережена у «🔧 Мої заявки».",
  ].filter(Boolean).join("\n");

  let delivery;
  try {
    delivery = await sendToMaster(
      env,
      callbackChatId,
      privateText,
      buildContactButtons(req.request_code, req.phone)
    );
  } catch (err) {
    console.error("TAKE JOB: sendToMaster threw:", err);
    delivery = { ok: false, description: String(err?.message || err) };
  }

  if (!delivery?.ok) {
    console.error("TAKE JOB: private card delivery FAILED", {
      requestCode: req.request_code,
      masterId: master.id,
      telegramId: master.telegram_id,
      callbackChatId,
      description: delivery?.description || delivery,
    });

    // Повертаємо заявку у вільний стан, бо майстер не отримав контактну картку.
    try {
      await env.DB.prepare(`
        UPDATE requests
        SET assigned_master_id = NULL,
            assigned_master_name = NULL,
            assigned_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND assigned_master_id = ?
      `).bind(req.id, master.id).run();
    } catch (rollbackErr) {
      console.error("TAKE JOB: rollback failed:", rollbackErr);
    }

    await answerJobsCallback(
      env,
      cq.id,
      `❌ Не вдалося відкрити заявку. Спробуйте ще раз.`,
      true
    );

    return json({ ok: true }, headers);
  }

  // Тільки після гарантованої доставки контактної картки підтверджуємо callback.
  await answerJobsCallback(env, cq.id, "✅ Заявка ваша");

  // У повідомленні, на якому майстер натиснув кнопку, прибираємо стару кнопку "Беру в роботу".
  if (callbackMessageId) {
    try {
      const editedText = [
        publicJobText(req),
        "",
        "✅ Ви взяли цю заявку в роботу.",
      ].join("\n");

      const editResult = await editMasterMessage(
        env,
        callbackChatId,
        callbackMessageId,
        editedText,
        []
      );

      if (!editResult?.ok) {
        console.error("TAKE JOB: could not remove take button:", editResult?.description || editResult);
      }
    } catch (err) {
      console.error("TAKE JOB: edit source card failed:", err);
    }
  }

  await notifyAdmin(env, [
    "🔔 ЗАЯВКУ ВЗЯТО",
    `🆔 ${req.request_code}`,
    `🙋 Майстер: ${masterName}`,
    `👤 Клієнт: ${req.name || "—"}`,
    `📞 ${req.phone || "—"}`,
  ]);

  return json({ ok: true }, headers);
}

/* ========================= OUTCOME ========================= */

async function handleMasterOutcome(env, headers, requestCode, outcome, cq) {
  const master = await getMasterByTelegramId(env, cq.from.id);
  if (!master || master.status !== "active") {
    await answerJobsCallback(env, cq.id, "❌ Немає доступу", true);
    return json({ ok: true }, headers);
  }

  if (!["agreed", "not_agreed"].includes(outcome)) {
    await answerJobsCallback(env, cq.id, "ℹ️ Ця кнопка застаріла.", true);
    return json({ ok: true }, headers);
  }

  const { req, error } = await getAssignedRequest(env, requestCode, master.id);
  if (error) {
    await answerJobsCallback(env, cq.id, error, true);
    return json({ ok: true }, headers);
  }

  if (["installation", "completed", "cancelled"].includes(req.status)) {
    await answerJobsCallback(env, cq.id, "ℹ️ Результат цієї заявки вже зафіксовано", true);
    return json({ ok: true }, headers);
  }

  const masterName = masterDisplayName(master, cq.from);
  const chatId = cq.message?.chat?.id || cq.from.id;

  if (outcome === "not_agreed") {
    await answerJobsCallback(env, cq.id, "");
    await sendToMaster(
      env, chatId,
      `❌ НЕ ДОМОВИЛИСЬ\n\n🆔 ${req.request_code}\n\nОберіть основну причину:`,
      buildMasterNotAgreedReasonButtons(req.request_code)
    );
    return json({ ok: true }, headers);
  }

  let updated;
  try {
    updated = await env.DB.prepare(`
      UPDATE requests
      SET status = 'approved', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND assigned_master_id = ?
        AND status NOT IN ('installation', 'completed', 'cancelled')
    `).bind(req.id, master.id).run();
  } catch (err) {
    console.error("Agree job failed:", err);
    await answerJobsCallback(env, cq.id, "❌ Не вдалося зберегти результат", true);
    return json({ ok: true }, headers);
  }

  if (!updated.meta?.changes) {
    await answerJobsCallback(env, cq.id, "ℹ️ Результат уже зафіксовано", true);
    return json({ ok: true }, headers);
  }

  await saveOutcome(env, req, master.id, "agreed");

  try {
    await env.DB.prepare(`
      UPDATE masters
      SET good_deals_count = COALESCE(good_deals_count, 0) + 1
      WHERE id = ? AND status = 'active'
    `).bind(master.id).run();
  } catch (err) {
    console.error("Increment good_deals_count failed:", err);
  }

  await saveEvent(env, req, "master_agreed", `${masterName}: домовились із клієнтом`, master);
  await answerJobsCallback(env, cq.id, "✅ Домовленість зафіксовано");

  await sendToMaster(
    env, chatId,
    `✅ ДОМОВИЛИСЬ\n\n🆔 ${req.request_code}\n\nДомовленість зафіксовано.\n\n👉 НАСТУПНИЙ КРОК:\nКоли фактично почнете роботи — натисніть «🔧 Роботи розпочато».`,
    buildAgreedJobButtons(req.request_code)
  );

  await notifyAdmin(env, [
    "ℹ️ SA-MASTER Jobs", "",
    `🆔 ${req.request_code}`,
    `🙋 ${masterName}`,
    "📊 Домовились із клієнтом",
    "⏳ Роботи ще не розпочато",
  ]);

  return json({ ok: true }, headers);
}

async function handleOutcomeBack(env, headers, requestCode, cq) {
  const master = await getMasterByTelegramId(env, cq.from.id);
  if (!master || master.status !== "active") {
    await answerJobsCallback(env, cq.id, "❌ Немає доступу", true);
    return json({ ok: true }, headers);
  }

  const { req, error } = await getAssignedRequest(env, requestCode, master.id);
  if (error) {
    await answerJobsCallback(env, cq.id, error, true);
    return json({ ok: true }, headers);
  }

  await answerJobsCallback(env, cq.id, "");
  await showMyJobCard(env, cq.message?.chat?.id || cq.from.id, master, req.request_code);
  return json({ ok: true }, headers);
}

/* ========================= NOT AGREED ========================= */

async function handleNotAgreedReason(env, headers, requestCode, rawReason, cq) {
  const master = await getMasterByTelegramId(env, cq.from.id);
  if (!master || master.status !== "active") {
    await answerJobsCallback(env, cq.id, "❌ Немає доступу", true);
    return json({ ok: true }, headers);
  }

  const reasonAliases = { no_answer: "no_contact", scope: "work_scope" };
  const reason = reasonAliases[rawReason] || rawReason;

  const reasonLabels = {
    no_contact: "Не вдалося зв'язатися",
    price: "Не погодили вартість",
    timing: "Не погодили терміни",
    work_scope: "Не підійшов обсяг / тип робіт",
    location: "Не підходить локація",
    client_declined: "Клієнт відмовився / неактуально",
    other: "Інша причина",
  };

  if (!reasonLabels[reason]) {
    await answerJobsCallback(env, cq.id, "❓ Невідома причина", true);
    return json({ ok: true }, headers);
  }

  const { req, error } = await getAssignedRequest(env, requestCode, master.id);
  if (error) {
    await answerJobsCallback(env, cq.id, error, true);
    return json({ ok: true }, headers);
  }

  if (["installation", "completed", "cancelled"].includes(req.status)) {
    await answerJobsCallback(env, cq.id, "ℹ️ Результат уже зафіксовано", true);
    return json({ ok: true }, headers);
  }

  const masterName = masterDisplayName(master, cq.from);
  const needsAdminReview = reason === "client_declined";
  const chatId = cq.message?.chat?.id || cq.from.id;

  try {
    if (needsAdminReview) {
      await env.DB.prepare(`
        UPDATE requests
        SET assigned_master_id = NULL,
            assigned_master_name = NULL,
            assigned_at = NULL,
            transferred_to_jobs = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND assigned_master_id = ?
          AND status NOT IN ('installation', 'completed', 'cancelled')
      `).bind(req.id, master.id).run();
    } else {
      await env.DB.prepare(`
        UPDATE requests
        SET assigned_master_id = NULL,
            assigned_master_name = NULL,
            assigned_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND assigned_master_id = ?
          AND status NOT IN ('installation', 'completed', 'cancelled')
      `).bind(req.id, master.id).run();
    }
  } catch (err) {
    console.error("Release not-agreed job failed:", err);
    await answerJobsCallback(env, cq.id, "❌ Не вдалося зберегти результат", true);
    return json({ ok: true }, headers);
  }

  await saveOutcome(env, req, master.id, `not_agreed_${reason}`);
  await saveEvent(
    env, req,
    needsAdminReview ? "master_client_declined" : "master_not_agreed",
    needsAdminReview
      ? `${masterName}: клієнт відмовився / заявка неактуальна — передано адміністратору`
      : `${masterName}: не домовились — ${reasonLabels[reason]}`,
    master
  );

  await answerJobsCallback(env, cq.id, "✅ Причину збережено");

  if (needsAdminReview) {
    await sendToMaster(
      env, chatId,
      `🕓 ЗАЯВКУ ПЕРЕДАНО НА ПЕРЕВІРКУ\n\n🆔 ${req.request_code}\n📝 Причина: ${reasonLabels[reason]}\n\nЗаявка більше не закріплена за вами.`,
      [
        [{ text: "🔧 Мої заявки", callback_data: "my_jobs" }],
        [{ text: "🏠 Головна", callback_data: "jobs_home" }],
      ]
    );

    await notifyAdmin(
      env,
      [
        "⚠️ SA-MASTER Jobs — ПОТРІБНА ПЕРЕВІРКА", "",
        `🆔 ${req.request_code}`,
        `🙋 Майстер: ${masterName}`,
        `👤 Клієнт: ${req.name || "—"}`,
        `📞 ${req.phone || "—"}`, "",
        `📝 Причина: ${reasonLabels[reason]}`, "",
        "⏸ Заявку прибрано з доступних.",
      ],
      [
        [{ text: "↩️ Повернути в Jobs", callback_data: `jobs_review_return:${req.request_code}` }],
        [{ text: "❌ Закрити заявку", callback_data: `jobs_review_close:${req.request_code}` }],
      ]
    );
  } else {
    await sendToMaster(
      env, chatId,
      `↩️ ЗАЯВКУ ПОВЕРНУТО\n\n🆔 ${req.request_code}\n\n📝 Причина: ${reasonLabels[reason]}\n\nЗаявка знову доступна іншим майстрам.`,
      [[{ text: "🏠 Головна", callback_data: "jobs_home" }]]
    );

    const fresh = await env.DB.prepare(
      "SELECT * FROM requests WHERE id = ? LIMIT 1"
    ).bind(req.id).first();

    if (fresh) await broadcastJob(env, fresh, true);

    await notifyAdmin(env, [
      "ℹ️ SA-MASTER Jobs", "",
      `🆔 ${req.request_code}`,
      `🙋 ${masterName}`,
      "📊 Не домовились",
      `📝 Причина: ${reasonLabels[reason]}`,
      "↩️ Заявка знову доступна майстрам",
    ]);
  }

  return json({ ok: true }, headers);
}

/* ========================= JOB STARTED ========================= */

async function handleJobStarted(env, headers, requestCode, cq) {
  const master = await getMasterByTelegramId(env, cq.from.id);
  if (!master || master.status !== "active") {
    await answerJobsCallback(env, cq.id, "❌ Немає доступу", true);
    return json({ ok: true }, headers);
  }

  const { req, error } = await getAssignedRequest(env, requestCode, master.id);
  if (error) {
    await answerJobsCallback(env, cq.id, error, true);
    return json({ ok: true }, headers);
  }

  if (req.status === "installation") {
    await answerJobsCallback(env, cq.id, "ℹ️ Роботи вже розпочато", true);
    return json({ ok: true }, headers);
  }

  if (req.status !== "approved") {
    await answerJobsCallback(env, cq.id, "❌ Спочатку підтвердьте домовленість", true);
    return json({ ok: true }, headers);
  }

  try {
    const updated = await env.DB.prepare(`
      UPDATE requests
      SET status = 'installation', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND assigned_master_id = ? AND status = 'approved'
    `).bind(req.id, master.id).run();

    if (!updated.meta?.changes) {
      await answerJobsCallback(env, cq.id, "ℹ️ Стан заявки вже змінився", true);
      return json({ ok: true }, headers);
    }
  } catch (err) {
    console.error("Start job failed:", err);
    await answerJobsCallback(env, cq.id, "❌ Не вдалося зберегти початок робіт", true);
    return json({ ok: true }, headers);
  }

  const masterName = masterDisplayName(master, cq.from);
  const chatId = cq.message?.chat?.id || cq.from.id;

  await saveOutcome(env, req, master.id, "job_started");
  await saveEvent(env, req, "master_job_started", `${masterName}: роботи розпочато`, master);
  await answerJobsCallback(env, cq.id, "🔧 Початок робіт зафіксовано");

  await sendToMaster(
    env, chatId,
    `🔧 РОБОТИ РОЗПОЧАТО\n\n🆔 ${req.request_code}\n\n👉 НАСТУПНИЙ КРОК:\nПісля фактичного завершення натисніть «✅ Роботи завершено».`,
    buildStartedJobButtons(req.request_code)
  );

  await notifyAdmin(env, [
    "🔧 РОБОТИ РОЗПОЧАТО",
    `🆔 ${req.request_code}`,
    `🙋 ${masterName}`,
  ]);

  return json({ ok: true }, headers);
}

/* ========================= COOPERATION FAILED ========================= */

async function handleCooperationFailed(env, headers, requestCode, cq) {
  const master = await getMasterByTelegramId(env, cq.from.id);
  if (!master || master.status !== "active") {
    await answerJobsCallback(env, cq.id, "❌ Немає доступу", true);
    return json({ ok: true }, headers);
  }

  const { req, error } = await getAssignedRequest(env, requestCode, master.id);
  if (error) {
    await answerJobsCallback(env, cq.id, error, true);
    return json({ ok: true }, headers);
  }

  if (req.status !== "approved") {
    await answerJobsCallback(
      env, cq.id,
      req.status === "installation" ? "❌ Роботи вже розпочаті" : "❌ Ця дія зараз недоступна",
      true
    );
    return json({ ok: true }, headers);
  }

  await answerJobsCallback(env, cq.id, "");
  await sendToMaster(
    env, cq.message?.chat?.id || cq.from.id,
    `↩️ СПІВПРАЦЯ НЕ ВІДБУЛАСЬ\n\n🆔 ${req.request_code}\n\nОберіть основну причину:`,
    buildMasterNotAgreedReasonButtons(req.request_code)
  );

  return json({ ok: true }, headers);
}

/* ========================= JOB COMPLETED ========================= */

async function handleJobCompleted(env, headers, requestCode, cq) {
  const master = await getMasterByTelegramId(env, cq.from.id);
  if (!master || master.status !== "active") {
    await answerJobsCallback(env, cq.id, "❌ Немає доступу", true);
    return json({ ok: true }, headers);
  }

  const { req, error } = await getAssignedRequest(env, requestCode, master.id);
  if (error) {
    await answerJobsCallback(env, cq.id, error, true);
    return json({ ok: true }, headers);
  }

  if (req.status === "completed") {
    await answerJobsCallback(env, cq.id, "ℹ️ Роботи вже завершено", true);
    return json({ ok: true }, headers);
  }

  if (req.status !== "installation") {
    await answerJobsCallback(env, cq.id, "❌ Спочатку позначте початок робіт", true);
    return json({ ok: true }, headers);
  }

  try {
    const updated = await env.DB.prepare(`
      UPDATE requests
      SET status = 'completed', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND assigned_master_id = ? AND status = 'installation'
    `).bind(req.id, master.id).run();

    if (!updated.meta?.changes) {
      await answerJobsCallback(env, cq.id, "ℹ️ Стан заявки вже змінився", true);
      return json({ ok: true }, headers);
    }
  } catch (err) {
    console.error("Complete job failed:", err);
    await answerJobsCallback(env, cq.id, "❌ Не вдалося завершити заявку", true);
    return json({ ok: true }, headers);
  }

  const masterName = masterDisplayName(master, cq.from);
  const chatId = cq.message?.chat?.id || cq.from.id;

  await saveOutcome(env, req, master.id, "job_completed");
  await saveEvent(env, req, "master_job_completed", `${masterName}: роботи завершено`, master);
  await answerJobsCallback(env, cq.id, "✅ Роботи завершено");

  await sendToMaster(
    env, chatId,
    `✅ РОБОТИ ЗАВЕРШЕНО\n\n🆔 ${req.request_code}\n\nЗаявку завершено. Дякуємо!`,
    [
      [{ text: "🔧 Мої заявки", callback_data: "my_jobs" }],
      [{ text: "🏠 Головна", callback_data: "jobs_home" }],
    ]
  );

  await notifyAdmin(env, [
    "✅ РОБОТИ ЗАВЕРШЕНО",
    `🆔 ${req.request_code}`,
    `🙋 ${masterName}`,
  ]);

  return json({ ok: true }, headers);
}
