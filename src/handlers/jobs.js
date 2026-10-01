import { json } from "../lib/json.js";
import {
  sendToMaster,
  editMasterMessage,
  answerJobsCallback,
  setMasterMenu,
} from "../lib/telegram-jobs.js";
import {
  sendTelegram,
  sendMessageWithButtons,
} from "../lib/telegram.js";
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
const JOBS_LIMIT = 20;

/*
 * ID RULE
 * masters.id                  = internal master ID
 * masters.telegram_id         = Telegram transport ID
 * requests.assigned_master_id = masters.id
 * requests.source_master_id   = masters.id
 * request_outcomes.master_id  = masters.id
 * events.author_id            = masters.id
 */

async function getMasterByTelegramId(env, telegramId) {
  return env.DB.prepare(`
    SELECT * FROM masters
    WHERE telegram_id = ?
    LIMIT 1
  `).bind(telegramId).first();
}

async function ensureActiveMaster(env, telegramId) {
  const master = await getMasterByTelegramId(env, telegramId);
  return { master, active: Boolean(master && master.status === "active") };
}

function masterAccessMessage(status) {
  if (status === "blocked") {
    return [
      "🚫 ДОСТУП ЗАБОРОНЕНО", "",
      "Ваш профіль SA-MASTER Jobs заблоковано адміністратором.", "",
      "Для відновлення доступу зверніться до адміністратора.",
    ].join("\n");
  }
  if (status === "inactive") {
    return [
      "⚪ ПРОФІЛЬ НЕАКТИВНИЙ", "",
      "Ваш профіль SA-MASTER Jobs зараз неактивний.", "",
      "Для відновлення доступу зверніться до адміністратора.",
    ].join("\n");
  }
  return ["❌ ДОСТУП ВІДСУТНІЙ", "", "Ви не зареєстровані в SA-MASTER Jobs."].join("\n");
}

function masterDisplayName(master, fromUser = {}) {
  return master?.username
    ? `@${master.username}`
    : (master?.first_name || fromUser?.first_name || `ID ${fromUser?.id || "—"}`);
}

async function saveEvent(env, req, eventType, content, master) {
  try {
    await env.DB.prepare(`
      INSERT INTO events (
        object_id, request_id, event_type, content, author_type, author_id
      ) VALUES (?, ?, ?, ?, 'master', ?)
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
    if (buttons?.length) return await sendMessageWithButtons(env, lines.join("\n"), buttons);
    return await sendTelegram(env, lines.join("\n"));
  } catch (err) {
    console.error("Admin notification failed:", err);
  }
}

async function getAssignedRequest(env, requestCode, masterId) {
  const req = await env.DB.prepare(`
    SELECT * FROM requests
    WHERE request_code = ?
    LIMIT 1
  `).bind(requestCode).first();

  if (!req) return { req: null, error: "❌ Заявку не знайдено" };
  if (String(req.assigned_master_id || "") !== String(masterId)) {
    return { req, error: "❌ Ця заявка більше не закріплена за вами" };
  }
  return { req, error: null };
}

function buildHomeButtons() {
  return [
    [{ text: "📋 Доступні заявки", callback_data: "jobs_list" }],
    [{ text: "🔧 Мої заявки", callback_data: "my_jobs" }],
    [{ text: "➕ Передати заявку", callback_data: "submit_request" }],
    [{ text: "❓ Допомога", callback_data: "jobs_help" }],
  ];
}

async function sendHome(env, chatId, master) {
  await setMasterMenu(env, chatId);
  return sendToMaster(
    env,
    chatId,
    [
      "🔧 SA-MASTER Jobs", "",
      master?.first_name ? `Вітаємо, ${master.first_name}!` : "Вітаємо!", "",
      "Тут усе просто:", "",
      "📋 Заявки — знайти нову роботу",
      "🔧 Мої заявки — побачити, що потрібно зробити зараз",
      "➕ Передати — передати заявку іншому майстру", "",
      "Оберіть дію:",
    ].join("\n"),
    buildHomeButtons()
  );
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

export async function publishRequestToJobs(env, request) {
  if (!request?.id && !request?.request_code) {
    return { ok: false, description: "REQUEST_NOT_FOUND" };
  }
  try {
    const result = request.id
      ? await env.DB.prepare(`
          UPDATE requests SET transferred_to_jobs = 1,
          transferred_at = COALESCE(transferred_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).bind(request.id).run()
      : await env.DB.prepare(`
          UPDATE requests SET transferred_to_jobs = 1,
          transferred_at = COALESCE(transferred_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP WHERE request_code = ?
        `).bind(request.request_code).run();

    if (!result.meta?.changes) return { ok: false, description: "Заявку не знайдено" };
    return { ok: true, request_code: request.request_code };
  } catch (err) {
    console.error("Publish request to Jobs failed:", err);
    return { ok: false, description: String(err?.message || err) };
  }
}

export async function publishRequestToJobsGroup(env, request) {
  return publishRequestToJobs(env, request);
}

async function getAvailableJobs(env) {
  const rows = await env.DB.prepare(`
    SELECT id, request_code, type, type_label, location, timing, project, priority, notes, created_at
    FROM requests
    WHERE transferred_to_jobs = 1
      AND assigned_master_id IS NULL
      AND status NOT IN ('cancelled', 'installation', 'completed')
    ORDER BY
      CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
      id DESC
    LIMIT ?
  `).bind(JOBS_LIMIT).all();
  return rows.results || [];
}

function jobButtonText(req) {
  const type = req.type_label || req.type || "Заявка";
  const location = req.location || "Без адреси";
  const text = `${type} · ${location}`;
  return text.length <= 60 ? text : `${text.slice(0, 57)}...`;
}

async function showAvailableJobs(env, chatId) {
  const jobs = await getAvailableJobs(env);
  if (!jobs.length) {
    return sendToMaster(env, chatId, [
      "📋 ДОСТУПНІ ЗАЯВКИ", "",
      "Зараз немає вільних заявок.", "",
      "Натисніть «🔄 Оновити», щоб перевірити ще раз.",
    ].join("\n"), [
      [{ text: "🔄 Оновити", callback_data: "jobs_list" }],
      [{ text: "🔧 Мої заявки", callback_data: "my_jobs" }],
      [{ text: "🏠 Головна", callback_data: "jobs_home" }],
    ]);
  }

  const buttons = jobs.map(req => [{
    text: jobButtonText(req),
    callback_data: `job_open:${req.request_code}`,
  }]);
  buttons.push([{ text: "🔄 Оновити", callback_data: "jobs_list" }]);
  buttons.push([{ text: "🔧 Мої заявки", callback_data: "my_jobs" }]);
  buttons.push([{ text: "🏠 Головна", callback_data: "jobs_home" }]);

  return sendToMaster(env, chatId, [
    "📋 ДОСТУПНІ ЗАЯВКИ", "",
    `Вільних заявок: ${jobs.length}`, "",
    "🔒 Контакти замовника відкриються після взяття заявки.", "",
    "Оберіть заявку:",
  ].join("\n"), buttons);
}

async function showJobCard(env, chatId, requestCode) {
  const req = await env.DB.prepare(`
    SELECT * FROM requests
    WHERE request_code = ? AND transferred_to_jobs = 1
    LIMIT 1
  `).bind(requestCode).first();

  if (!req) return sendToMaster(env, chatId, "❌ Заявку не знайдено.");

  if (req.assigned_master_id || ["cancelled", "installation", "completed"].includes(req.status)) {
    return sendToMaster(env, chatId, [
      "🔒 ЗАЯВКА НЕДОСТУПНА", "",
      "Цю заявку вже взяли або вона була закрита.",
    ].join("\n"), [[{ text: "📋 До заявок", callback_data: "jobs_list" }]]);
  }

  const text = [
    "🔔 ЗАЯВКА", `🆔 ${req.request_code}`, "",
    `🔧 ${req.type_label || req.type || "—"}`,
    `📍 ${req.location || "—"}`,
    req.project ? `📐 Дизайн-проєкт: ${req.project}` : null,
    req.timing ? `🗓 Початок: ${req.timing}` : null,
    req.notes ? `📝 Опис: ${req.notes}` : null,
    "", "🔒 Ім'я та телефон замовника приховані.", "",
    "Якщо заявка підходить — натисніть «🤝 Беру в роботу».",
  ].filter(Boolean).join("\n");

  return sendToMaster(env, chatId, text, [
    [{ text: "🤝 Беру в роботу", callback_data: `take:${req.request_code}` }],
    [{ text: "📋 До заявок", callback_data: "jobs_list" }],
  ]);
}

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
    return sendToMaster(env, chatId, [
      "🔧 МОЇ ЗАЯВКИ", "",
      "У вас зараз немає активних заявок.", "",
      "Нову роботу можна знайти в «📋 Доступні заявки».",
    ].join("\n"), [
      [{ text: "📋 Доступні заявки", callback_data: "jobs_list" }],
      [{ text: "🏠 Головна", callback_data: "jobs_home" }],
    ]);
  }

  const buttons = jobs.map(req => [{
    text: `${myJobStep(req)} · ${req.request_code}`,
    callback_data: `my_job_open:${req.request_code}`,
  }]);

  buttons.push([{ text: "📋 Доступні заявки", callback_data: "jobs_list" }]);
  buttons.push([{ text: "🏠 Головна", callback_data: "jobs_home" }]);

  return sendToMaster(env, chatId, [
    "🔧 МОЇ ЗАЯВКИ", "",
    `Активних: ${jobs.length}`, "",
    "Бот показує, що потрібно зробити з кожною заявкою.",
    "Оберіть заявку:",
  ].join("\n"), buttons);
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
    req.notes ? `📝 ${req.notes}` : null,
    "",
  ].filter(Boolean);

  if (req.status === "installation") {
    base.push("👉 НАСТУПНИЙ КРОК:", "Після фактичного завершення натисніть «✅ Роботи завершено».");
    return sendToMaster(env, chatId, base.join("\n"), buildStartedJobButtons(req.request_code));
  }

  if (req.status === "approved") {
    base.push(
      "👉 НАСТУПНИЙ КРОК:",
      "Коли фактично почнете виконувати роботи — натисніть «🔧 Роботи розпочато»."
    );
    return sendToMaster(env, chatId, base.join("\n"), buildAgreedJobButtons(req.request_code));
  }

  base.push(
    "👉 НАСТУПНИЙ КРОК:",
    "1. Зв'яжіться із замовником.",
    "2. Одразу після розмови зафіксуйте результат у боті."
  );
  return sendToMaster(env, chatId, base.join("\n"), buildContactButtons(req.request_code, req.phone));
}

async function showHelp(env, chatId) {
  return sendToMaster(env, chatId, [
    "❓ ЯК КОРИСТУВАТИСЯ SA-MASTER Jobs", "",
    "1️⃣ «📋 Заявки» — перегляньте доступні роботи.",
    "2️⃣ Натисніть «🤝 Беру в роботу» лише якщо готові зв'язатися із замовником.",
    "3️⃣ Після взяття заявка завжди є в «🔧 Мої заявки».",
    "4️⃣ Зателефонуйте замовнику та одразу позначте результат.",
    "5️⃣ Якщо домовились — після фактичного старту натисніть «🔧 Роботи розпочато».",
    "6️⃣ Після завершення — «✅ Роботи завершено».", "",
    "💡 Якщо не пам'ятаєте, що робити — відкрийте «🔧 Мої заявки». Бот покаже наступний крок.",
  ].join("\n"), [[{ text: "🏠 Головна", callback_data: "jobs_home" }]]);
}

async function handleMenuText(env, headers, chatId, fromUser, text) {
  const access = await ensureActiveMaster(env, fromUser.id);
  if (!access.active) {
    await sendToMaster(env, chatId, masterAccessMessage(access.master?.status));
    return json({ ok: true }, headers);
  }

  if (["📋 Заявки", "📋 Доступні заявки"].includes(text)) {
    await showAvailableJobs(env, chatId);
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

async function showSubmitRequest(env, chatId, telegramId) {
  const referralLink = await getMasterReferralLink(env, telegramId);
  if (!referralLink) {
    return sendToMaster(env, chatId, "❌ Не вдалося створити посилання.");
  }

  return sendToMaster(env, chatId, [
    "➕ ПЕРЕДАТИ ЗАЯВКУ", "",
    "Натисніть кнопку нижче та заповніть заявку від імені замовника.", "",
    "Заявка автоматично буде прив'язана до вашого профілю SA-MASTER Jobs.",
  ].join("\n"), [
    [{ text: "➕ Заповнити заявку", url: referralLink }],
    [{ text: "🏠 Головна", callback_data: "jobs_home" }],
  ]);
}

export async function handleJobsWebhook(request, env, headers) {
  let update;
  try { update = await request.json(); }
  catch { return json({ ok: false }, headers, 400); }

  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat?.id;
    const fromUser = msg.from;
    const text = String(msg.text || "").trim();

    if (!fromUser?.id) return json({ ok: true }, headers);

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

    /*
     * ВАЖЛИВО:
     * Якщо профілю masters ще немає, повідомлення може бути
     * відповіддю на активну draft-анкету. Тому спочатку передаємо
     * його в handleJoinMessage(), а не в меню майстра.
     *
     * Саме це не дає handleMenuText() перехопити ім'я, телефон,
     * спеціалізацію та інші відповіді анкети повідомленням
     * «ДОСТУП ВІДСУТНІЙ».
     */
    const master = await getMasterByTelegramId(env, fromUser.id);

    if (!master) {
      return handleJoinMessage(env, headers, chatId, fromUser, text);
    }

    const menuResult = await handleMenuText(env, headers, chatId, fromUser, text);
    if (menuResult) return menuResult;

    return json({ ok: true }, headers);
  }

  if (!update.callback_query) return json({ ok: true }, headers);

  const cq = update.callback_query;
  const data = String(cq.data || "");
  const chatId = cq.message?.chat?.id || cq.from.id;

  if (data === "join_start") {
    const master = await getMasterByTelegramId(env, cq.from.id);
    if (master?.status === "active") {
      await answerJobsCallback(env, cq.id, "✅ Ви вже зареєстровані");
      await sendHome(env, chatId, master);
      return json({ ok: true }, headers);
    }
    if (master) {
      await answerJobsCallback(env, cq.id,
        master.status === "blocked" ? "🚫 Ваш профіль заблоковано" : "⚪ Ваш профіль неактивний", true);
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

  if (data.startsWith("job_open:")) {
    const access = await ensureActiveMaster(env, cq.from.id);
    if (!access.active) {
      await answerJobsCallback(env, cq.id, "❌ Немає доступу", true);
      return json({ ok: true }, headers);
    }
    await answerJobsCallback(env, cq.id, "");
    await showJobCard(env, chatId, data.slice(9));
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
      `${masterDisplayName(access.master, cq.from)} підтвердив контакт із замовником`, access.master);
    await answerJobsCallback(env, cq.id, "✅ Контакт зафіксовано");
    await sendToMaster(env, chatId, [
      "📞 КОНТАКТ ІЗ ЗАМОВНИКОМ", "",
      `🆔 ${req.request_code}`, "",
      "Одразу позначте результат розмови:",
    ].join("\n"), buildMasterOutcomeButtons(req.request_code));
    return json({ ok: true }, headers);
  }

  if (data.startsWith("take:")) return handleTakeJob(env, headers, data.slice(5), cq);

  if (data.startsWith("outcome:")) {
    const [, requestCode, outcome] = data.split(":");
    return handleMasterOutcome(env, headers, requestCode, outcome, cq);
  }
  if (data.startsWith("outcome_back:")) {
    return handleOutcomeBack(env, headers, data.slice("outcome_back:".length), cq);
  }
  if (data.startsWith("not_agreed_reason:")) {
    const [, requestCode, reason] = data.split(":");
    return handleNotAgreedReason(env, headers, requestCode, reason, cq);
  }
  if (data.startsWith("job_started:")) {
    return handleJobStarted(env, headers, data.slice("job_started:".length), cq);
  }
  if (data.startsWith("cooperation_failed:")) {
    return handleCooperationFailed(env, headers, data.slice("cooperation_failed:".length), cq);
  }
  if (data.startsWith("job_completed:")) {
    return handleJobCompleted(env, headers, data.slice("job_completed:".length), cq);
  }
  if (data.startsWith("app_approve:")) {
    return handleApplicationReview(env, headers, Number(data.slice(12)), "approve", cq);
  }
  if (data.startsWith("app_reject:")) {
    return handleApplicationReview(env, headers, Number(data.slice(11)), "reject", cq);
  }

  await answerJobsCallback(env, cq.id, "❓ Невідома дія", true);
  return json({ ok: true }, headers);
}

async function handleTakeJob(env, headers, requestCode, cq) {
  const master = await getMasterByTelegramId(env, cq.from.id);
  if (!master || master.status !== "active") {
    await answerJobsCallback(env, cq.id,
      master?.status === "blocked" ? "🚫 Ваш профіль заблоковано" : "❌ Немає доступу", true);
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
  let assigned;
  try {
    assigned = await env.DB.prepare(`
      UPDATE requests SET
        assigned_master_id = ?,
        assigned_master_name = ?,
        assigned_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND transferred_to_jobs = 1
        AND assigned_master_id IS NULL
        AND status NOT IN ('cancelled', 'installation', 'completed')
    `).bind(master.id, masterName, req.id).run();
  } catch (err) {
    console.error("Take job failed:", err);
    await answerJobsCallback(env, cq.id, "❌ Помилка збереження", true);
    return json({ ok: true }, headers);
  }

  if (!assigned.meta?.changes) {
    await answerJobsCallback(env, cq.id, "❌ Цю заявку вже взяв інший майстер", true);
    return json({ ok: true }, headers);
  }

  await saveEvent(env, req, "master_took_job", `${masterName} взяв заявку`, master);
  await answerJobsCallback(env, cq.id, "✅ Заявка ваша");

  await sendToMaster(env, master.telegram_id, [
    `✅ ВИ ВЗЯЛИ ЗАЯВКУ ${req.request_code}`, "",
    `👤 Клієнт: ${req.name || "—"}`,
    `📞 Телефон: ${req.phone || "—"}`,
    `🔧 Роботи: ${req.type_label || req.type || "—"}`,
    `📍 Об'єкт: ${req.location || "—"}`,
    req.timing ? `🗓 Початок: ${req.timing}` : null,
    req.notes ? `📝 Опис: ${req.notes}` : null,
    "", "👉 ЗАРАЗ ПОТРІБНО:",
    "1. Зв'язатися із замовником.",
    "2. Після розмови натиснути «✅ Я зв'язався» та вказати результат.",
    "", "Заявка також збережена у «🔧 Мої заявки».",
  ].filter(Boolean).join("\n"), buildContactButtons(req.request_code, req.phone));

  await notifyAdmin(env, [
    "🔔 ЗАЯВКУ ВЗЯТО",
    `🆔 ${req.request_code}`,
    `🙋 Майстер: ${masterName}`,
    `👤 Клієнт: ${req.name || "—"}`,
    `📞 ${req.phone || "—"}`,
  ]);

  return json({ ok: true }, headers);
}

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

  if (outcome === "not_agreed") {
    await answerJobsCallback(env, cq.id, "");
    await sendToMaster(env, master.telegram_id, [
      "❌ НЕ ДОМОВИЛИСЬ", "", `🆔 ${req.request_code}`, "",
      "Оберіть основну причину:",
    ].join("\n"), buildMasterNotAgreedReasonButtons(req.request_code));
    return json({ ok: true }, headers);
  }

  let updated;
  try {
    updated = await env.DB.prepare(`
      UPDATE requests SET status = 'approved', updated_at = CURRENT_TIMESTAMP
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
      UPDATE masters SET good_deals_count = COALESCE(good_deals_count, 0) + 1
      WHERE id = ? AND status = 'active'
    `).bind(master.id).run();
  } catch (err) {
    console.error("Increment good_deals_count failed:", err);
  }

  await saveEvent(env, req, "master_agreed", `${masterName}: домовились із клієнтом`, master);
  await answerJobsCallback(env, cq.id, "✅ Домовленість зафіксовано");

  await sendToMaster(env, master.telegram_id, [
    "✅ ДОМОВИЛИСЬ", "", `🆔 ${req.request_code}`, "",
    "Домовленість зафіксовано.", "",
    "👉 НАСТУПНИЙ КРОК:",
    "Коли фактично почнете роботи — натисніть «🔧 Роботи розпочато».",
  ].join("\n"), buildAgreedJobButtons(req.request_code));

  await notifyAdmin(env, [
    "ℹ️ SA-MASTER Jobs", "",
    `🆔 ${req.request_code}`, `🙋 ${masterName}`,
    "📊 Домовились із клієнтом", "⏳ Роботи ще не розпочато",
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
  await showMyJobCard(env, master.telegram_id, master, req.request_code);
  return json({ ok: true }, headers);
}

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

  try {
    if (needsAdminReview) {
      await env.DB.prepare(`
        UPDATE requests SET
          assigned_master_id = NULL, assigned_master_name = NULL, assigned_at = NULL,
          transferred_to_jobs = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND assigned_master_id = ?
          AND status NOT IN ('installation', 'completed', 'cancelled')
      `).bind(req.id, master.id).run();
    } else {
      await env.DB.prepare(`
        UPDATE requests SET
          assigned_master_id = NULL, assigned_master_name = NULL, assigned_at = NULL,
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
  await saveEvent(env, req,
    needsAdminReview ? "master_client_declined" : "master_not_agreed",
    needsAdminReview
      ? `${masterName}: клієнт відмовився / заявка неактуальна — передано адміністратору`
      : `${masterName}: не домовились — ${reasonLabels[reason]}`,
    master
  );

  await answerJobsCallback(env, cq.id, "✅ Причину збережено");

  if (needsAdminReview) {
    await sendToMaster(env, master.telegram_id, [
      "🕓 ЗАЯВКУ ПЕРЕДАНО НА ПЕРЕВІРКУ", "",
      `🆔 ${req.request_code}`, `📝 Причина: ${reasonLabels[reason]}`, "",
      "Заявка більше не закріплена за вами.",
    ].join("\n"), [
      [{ text: "🔧 Мої заявки", callback_data: "my_jobs" }],
      [{ text: "🏠 Головна", callback_data: "jobs_home" }],
    ]);

    await notifyAdmin(env, [
      "⚠️ SA-MASTER Jobs — ПОТРІБНА ПЕРЕВІРКА", "",
      `🆔 ${req.request_code}`, `🙋 Майстер: ${masterName}`,
      `👤 Клієнт: ${req.name || "—"}`, `📞 ${req.phone || "—"}`, "",
      `📝 Причина: ${reasonLabels[reason]}`, "",
      "⏸ Заявку прибрано зі списку доступних майстрам.",
    ], [
      [{ text: "↩️ Повернути в Jobs", callback_data: `jobs_review_return:${req.request_code}` }],
      [{ text: "❌ Закрити заявку", callback_data: `jobs_review_close:${req.request_code}` }],
    ]);
  } else {
    await sendToMaster(env, master.telegram_id, [
      "↩️ ЗАЯВКУ ПОВЕРНУТО", "", `🆔 ${req.request_code}`, "",
      `📝 Причина: ${reasonLabels[reason]}`, "",
      "Заявка знову доступна іншим майстрам.",
    ].join("\n"), [
      [{ text: "📋 Доступні заявки", callback_data: "jobs_list" }],
      [{ text: "🏠 Головна", callback_data: "jobs_home" }],
    ]);

    await notifyAdmin(env, [
      "ℹ️ SA-MASTER Jobs", "", `🆔 ${req.request_code}`, `🙋 ${masterName}`,
      "📊 Не домовились", `📝 Причина: ${reasonLabels[reason]}`,
      "↩️ Заявка знову доступна майстрам",
    ]);
  }

  return json({ ok: true }, headers);
}

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
      UPDATE requests SET status = 'installation', updated_at = CURRENT_TIMESTAMP
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
  await saveOutcome(env, req, master.id, "job_started");
  await saveEvent(env, req, "master_job_started", `${masterName}: роботи розпочато`, master);
  await answerJobsCallback(env, cq.id, "🔧 Початок робіт зафіксовано");

  await sendToMaster(env, master.telegram_id, [
    "🔧 РОБОТИ РОЗПОЧАТО", "", `🆔 ${req.request_code}`, "",
    "👉 НАСТУПНИЙ КРОК:",
    "Після фактичного завершення натисніть «✅ Роботи завершено».",
  ].join("\n"), buildStartedJobButtons(req.request_code));

  await notifyAdmin(env, ["🔧 РОБОТИ РОЗПОЧАТО", `🆔 ${req.request_code}`, `🙋 ${masterName}`]);
  return json({ ok: true }, headers);
}

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
    await answerJobsCallback(env, cq.id,
      req.status === "installation" ? "❌ Роботи вже розпочаті" : "❌ Ця дія зараз недоступна", true);
    return json({ ok: true }, headers);
  }

  await answerJobsCallback(env, cq.id, "");
  await sendToMaster(env, master.telegram_id, [
    "↩️ СПІВПРАЦЯ НЕ ВІДБУЛАСЬ", "", `🆔 ${req.request_code}`, "",
    "Оберіть основну причину:",
  ].join("\n"), buildMasterNotAgreedReasonButtons(req.request_code));
  return json({ ok: true }, headers);
}

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
      UPDATE requests SET status = 'completed', updated_at = CURRENT_TIMESTAMP
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
  await saveOutcome(env, req, master.id, "job_completed");
  await saveEvent(env, req, "master_job_completed", `${masterName}: роботи завершено`, master);
  await answerJobsCallback(env, cq.id, "✅ Роботи завершено");

  await sendToMaster(env, master.telegram_id, [
    "✅ РОБОТИ ЗАВЕРШЕНО", "", `🆔 ${req.request_code}`, "",
    "Заявку завершено. Дякуємо!",
  ].join("\n"), [
    [{ text: "📋 Доступні заявки", callback_data: "jobs_list" }],
    [{ text: "🔧 Мої заявки", callback_data: "my_jobs" }],
    [{ text: "🏠 Головна", callback_data: "jobs_home" }],
  ]);

  await notifyAdmin(env, ["✅ РОБОТИ ЗАВЕРШЕНО", `🆔 ${req.request_code}`, `🙋 ${masterName}`]);
  return json({ ok: true }, headers);
}
