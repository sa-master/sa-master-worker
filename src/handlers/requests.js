SA-MASTER — PATCH: admin-only permanent master deletion
============================================================

ФАЙЛ: handlers/requests.js

ВАЖЛИВО
-------
Це патч до актуального handlers/requests.js, який ви надіслали.
Він:
- додає адмінське видалення майстра;
- робить ОДНЕ підтвердження;
- прибирає кнопку "🔄 Оновити";
- не дозволяє майстру самому стерти історію;
- не видаляє клієнтські заявки;
- очищає відомі з поточного коду зв'язки майстра.


1. У showMasterCard(...) ЗАМІНІТЬ нижній блок кнопок
====================================================

ЗНАЙДІТЬ блок, де додаються кнопки "🔄 Оновити" та "👥 До списку",
і замініть його на:

buttons.push([
  {
    text: "🗑 Видалити назавжди",
    callback_data: `master_delete_ask:${master.id}`,
  },
]);

buttons.push([
  {
    text: "👥 До списку",
    callback_data: "masters_list",
  },
]);


2. ДОДАЙТЕ функцію перед handleTelegramWebhook(...)
==================================================

async function deleteMasterPermanently(env, callbackId, masterId) {
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

  /*
   * Закриваємо доступ до Telegram-групи.
   * Невдала Telegram-операція не блокує видалення з D1:
   * майстер міг уже сам вийти з групи.
   */
  try {
    const ban = await banMasterFromJobsGroup(
      env,
      master.telegram_id
    );

    if (!ban?.ok) {
      console.error(
        "Telegram cleanup before master delete failed:",
        ban?.description || ban
      );
    }
  } catch (err) {
    console.error(
      "Telegram cleanup before master delete failed:",
      err
    );
  }

  try {
    /*
     * Відомі з поточного коду зв'язки:
     *
     * requests.source_master_id -> masters.id
     * requests.assigned_master_id -> Telegram ID майстра
     * events.author_id -> masters.id для author_type='master'
     * request_outcomes.master_id -> Telegram ID майстра
     * master_request_drafts.telegram_id -> Telegram ID майстра
     * master_applications.telegram_id -> Telegram ID майстра
     *
     * Самі requests та events НЕ видаляємо.
     * Історія клієнтських заявок залишається.
     */

    await env.DB.batch([
      env.DB.prepare(`
        DELETE FROM request_outcomes
        WHERE master_id = ?
      `).bind(master.telegram_id),

      env.DB.prepare(`
        DELETE FROM master_request_drafts
        WHERE telegram_id = ?
      `).bind(master.telegram_id),

      env.DB.prepare(`
        UPDATE requests
        SET
          source_master_id = NULL,
          source_type = 'client',
          updated_at = CURRENT_TIMESTAMP
        WHERE source_master_id = ?
      `).bind(master.id),

      env.DB.prepare(`
        UPDATE requests
        SET
          assigned_master_id = NULL,
          assigned_master_name = NULL,
          assigned_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE assigned_master_id = ?
      `).bind(master.telegram_id),

      env.DB.prepare(`
        UPDATE events
        SET author_id = NULL
        WHERE author_type = 'master'
          AND author_id = ?
      `).bind(String(master.id)),

      env.DB.prepare(`
        DELETE FROM master_applications
        WHERE telegram_id = ?
      `).bind(master.telegram_id),

      env.DB.prepare(`
        DELETE FROM masters
        WHERE id = ?
      `).bind(master.id),
    ]);
  } catch (err) {
    console.error(
      "Permanent master delete failed:",
      err
    );

    await answerCallbackQuery(
      env,
      callbackId,
      "❌ Не вдалося видалити майстра з бази",
      true
    );

    return false;
  }

  await answerCallbackQuery(
    env,
    callbackId,
    "🗑 Майстра видалено назавжди",
    true
  );

  await sendMessageWithButtons(
    env,
    [
      "🗑 МАЙСТРА ВИДАЛЕНО",
      "",
      "Профіль, анкета, статистика та відомі персональні дані майстра видалені.",
      "",
      "Клієнтські заявки та їх історія залишилися в системі без прив'язки до видаленого профілю.",
    ].join("\n"),
    [
      [
        {
          text: "👥 До списку майстрів",
          callback_data: "masters_list",
        },
      ],
    ]
  );

  return true;
}


3. У handleTelegramWebhook(...) ДОДАЙТЕ ДВА callback
====================================================

Додайте їх у блок ADMIN callback-ів, ПЕРЕД старими callback заявок.


/* ADMIN: запит підтвердження повного видалення */
if (data.startsWith("master_delete_ask:")) {
  const masterId = Number(data.slice(18));

  const master = await getAdminMaster(
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

    return json({ ok: true }, headers);
  }

  await answerCallbackQuery(
    env,
    cq.id,
    ""
  );

  const masterLabel =
    master.username
      ? `@${master.username}`
      : master.first_name ||
        `Майстер #${master.id}`;

  await sendMessageWithButtons(
    env,
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
    [
      [
        {
          text: "🗑 Видалити",
          callback_data: `master_delete_confirm:${master.id}`,
        },
        {
          text: "Скасувати",
          callback_data: `master_open:${master.id}`,
        },
      ],
    ]
  );

  return json({ ok: true }, headers);
}


/* ADMIN: остаточне видалення після одного підтвердження */
if (data.startsWith("master_delete_confirm:")) {
  const masterId = Number(data.slice(22));

  await deleteMasterPermanently(
    env,
    cq.id,
    masterId
  );

  return json({ ok: true }, headers);
}


4. ВАЖЛИВО: САМОВИДАЛЕННЯ У jobs.js
===================================

У handlers/jobs.js НЕ повинні залишатися callback-и:

delete_profile_ask
delete_profile_cancel
delete_profile_confirm

і кнопка:

{
  text: "🗑 Видалити профіль",
  callback_data: "delete_profile_ask",
}

Майстер не повинен мати можливості стерти свої дані.

Якщо він просто виходить із Telegram-групи:
- профіль НЕ видаляється;
- історія НЕ видаляється;
- дані НЕ видаляються;
- змінюється лише статус (у вашій поточній реалізації це "inactive";
  якщо остаточно перейдете на "left", треба зробити це окремою узгодженою
  зміною в jobs.js та адмін-логіці).


5. РЕЗУЛЬТАТ У КАРТЦІ МАЙСТРА
=============================

Після цього кнопки внизу картки:

для active:
🚫 Заблокувати
🗑 Видалити назавжди
👥 До списку

для blocked:
✅ Розблокувати
🗑 Видалити назавжди
👥 До списку

для inactive:
🗑 Видалити назавжди
👥 До списку

Кнопки "🔄 Оновити" більше немає.


6. ПЕРЕВІРКА ПІСЛЯ DEPLOY
=========================

1. Відкрити @sa_master_pro_bot.
2. /start.
3. 👥 Майстри.
4. Відкрити тестового майстра.
5. Перевірити, що "🔄 Оновити" відсутня.
6. Натиснути "🗑 Видалити назавжди".
7. Має з'явитися ОДНЕ підтвердження.
8. Натиснути "🗑 Видалити".
9. Майстер має зникнути зі списку.
10. Його клієнтські заявки мають залишитися.
11. Повторний /start у Jobs-боті для цього Telegram ID має трактувати
    користувача як незареєстрованого (якщо немає іншої логіки/обмежень).


ПРИМІТКА ПРО D1
===============

Цей патч очищає таблиці та поля, які вже видно у наданому коді:
- masters
- master_applications
- master_request_drafts
- request_outcomes
- requests.source_master_id
- requests.assigned_master_id
- events.author_id

Якщо у фактичній D1-схемі існують інші таблиці з FOREIGN KEY на masters.id
або інші таблиці з персональними даними майстра, їх треба перевірити окремо
перед тим, як вважати видалення абсолютно повним.
