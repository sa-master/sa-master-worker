JOBS.JS — ПОГОДЖЕНІ ЗМІНИ
=============================

У поточному jobs.js треба привести ВСІ внутрішні зв'язки майстра до masters.id.
Telegram ID використовується тільки для Telegram-повідомлень і пошуку профілю.

1. ЗАМІНИ saveOutcome:

async function saveOutcome(env, req, masterId, outcome) {
  try {
    await env.DB.prepare(`
      INSERT INTO request_outcomes (
        request_id,
        master_id,
        outcome
      )
      VALUES (?, ?, ?)
    `).bind(req.id, masterId, outcome).run();
  } catch (err) {
    console.error("Save outcome failed:", err);
  }
}

2. ЗАМІНИ getAssignedRequest:

async function getAssignedRequest(env, requestCode, masterId) {
  const req = await env.DB.prepare(`
    SELECT *
    FROM requests
    WHERE request_code = ?
    LIMIT 1
  `).bind(requestCode).first();

  if (!req) {
    return { req: null, error: "❌ Заявку не знайдено" };
  }

  if (String(req.assigned_master_id || "") !== String(masterId)) {
    return {
      req,
      error: "❌ Ця заявка більше не закріплена за вами",
    };
  }

  return { req, error: null };
}

3. У handleTakeJob() у UPDATE requests:

ЗАМІНИ:
  `).bind(telegramId, masterName, req.id).run();`

НА:
  `).bind(master.id, masterName, req.id).run();`

4. В УСІХ функціях після отримання:
  const master = await getMasterByTelegramId(env, telegramId);

виклики:
  getAssignedRequest(env, requestCode, telegramId)

ЗАМІНИ НА:
  getAssignedRequest(env, requestCode, master.id)

Це стосується:
- handleMasterOutcome
- handleOutcomeBack
- handleNotAgreedReason
- handleJobStarted
- handleCooperationFailed
- handleJobCompleted

5. У ВСІХ SQL UPDATE, де є:
  AND assigned_master_id = ?

і bind використовує telegramId, ЗАМІНИ bind на master.id.

Тобто:

handleMasterOutcome:
  `).bind(req.id, master.id).run();`

handleNotAgreedReason — ОБИДВІ гілки:
  `).bind(req.id, master.id).run();`

handleJobStarted:
  `).bind(req.id, master.id).run();`

handleJobCompleted:
  `).bind(req.id, master.id).run();`

6. У ВСІХ saveOutcome:

ЗАМІНИ:
  await saveOutcome(env, req, telegramId, "...");

НА:
  await saveOutcome(env, req, master.id, "...");

Це стосується:
- agreed
- not_agreed_<reason>
- job_started
- job_completed

7. ЛІЧИЛЬНИК good_deals_count можна залишити через telegram_id.
Це не зовнішній ключ, а пошук профілю:
  WHERE telegram_id = ?

8. ДЛЯ АДМІНСЬКОЇ ПЕРЕВІРКИ.

Імпорт зверху вже містить:
  import { sendTelegram } from "../lib/telegram.js";

ЗАМІНИ ЙОГО НА:
  import {
    sendTelegram,
    sendMessageWithButtons,
  } from "../lib/telegram.js";

У handleNotAgreedReason(), у гілці needsAdminReview,
ЗАМІНИ цей блок:

    await notifyAdmin(env, [
      "⚠️ SA-MASTER Jobs — ПОТРІБНА ПЕРЕВІРКА",
      "",
      `🆔 ${req.request_code}`,
      `🙋 Майстер: ${masterName}`,
      `👤 Клієнт: ${req.name || "—"}`,
      `📞 ${req.phone || "—"}`,
      "",
      `📝 Причина: ${reasonLabels[reason]}`,
      "",
      "⏸ Заявку прибрано зі списку доступних майстрам.",
      "👨‍💼 Потрібне рішення адміністратора.",
    ]);

НА:

    try {
      await sendMessageWithButtons(
        env,
        [
          "⚠️ SA-MASTER Jobs — ПОТРІБНА ПЕРЕВІРКА",
          "",
          `🆔 ${req.request_code}`,
          `🙋 Майстер: ${masterName}`,
          `👤 Клієнт: ${req.name || "—"}`,
          `📞 ${req.phone || "—"}`,
          "",
          `📝 Причина: ${reasonLabels[reason]}`,
          "",
          "⏸ Заявку прибрано зі списку доступних майстрам.",
          "👨‍💼 Оберіть рішення:",
        ].join("\n"),
        [
          [{
            text: "↩️ Повернути майстрам",
            callback_data: `jobs_review_return:${req.request_code}`,
          }],
          [{
            text: "❌ Закрити заявку",
            callback_data: `jobs_review_close:${req.request_code}`,
          }],
        ]
      );
    } catch (err) {
      console.error("Admin review notification failed:", err);
    }

ПІДСУМОК
--------
Після цих змін:
- requests.assigned_master_id = masters.id
- requests.source_master_id = masters.id
- request_outcomes.master_id = masters.id
- events.author_id для master = masters.id
- telegram_id використовується лише для Telegram/пошуку профілю
- «Клієнт відмовився / неактуально» прибирає заявку з Jobs
- адміністратор отримує 2 кнопки:
  ↩️ Повернути майстрам
  ❌ Закрити заявку
