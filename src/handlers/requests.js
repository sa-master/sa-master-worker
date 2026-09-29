SA-MASTER — PATCH: admin-only permanent master deletion
============================================================

МЕТА
----
1. Майстер НЕ може сам стерти свій профіль/історію.
2. Вихід із групи -> дані зберігаються, статус може бути "left".
3. Блокування -> дані зберігаються.
4. ТІЛЬКИ адміністратор у @sa_master_pro_bot може остаточно видалити майстра.

ФАЙЛ: handlers/requests.js
==========================

1) У showMasterCard(...) додайте кнопку видалення внизу, перед "Оновити / До списку":

buttons.push([
  {
    text: "🗑 Видалити назавжди",
    callback_data: `master_delete:${master.id}`,
  },
]);

buttons.push([
  {
    text: "🔄 Оновити",
    callback_data: `master_open:${master.id}`,
  },
  {
    text: "👥 До списку",
    callback_data: "masters_list",
  },
]);


2) Додайте функцію:

async function deleteMasterPermanently(env, callbackId, masterId) {
  const master = await getAdminMaster(env, masterId);

  if (!master) {
    await answerCallbackQuery(env, callbackId, "❌ Майстра не знайдено", true);
    return;
  }

  // Спочатку закриваємо доступ до Telegram-групи.
  // Помилка Telegram не повинна залишити профіль невидалим:
  // користувач міг уже сам вийти з групи.
  try {
    await banMasterFromJobsGroup(env, master.telegram_id);
  } catch (err) {
    console.error("Telegram cleanup before master delete failed:", err);
  }

  try {
    // Видаляємо/анонімізуємо залежності ДО masters.
    //
    // ВАЖЛИВО:
    // requests.source_master_id не видаляємо разом із заявкою клієнта.
    // Інакше адміністративне видалення майстра знищить саму клієнтську заявку.
    // Прибираємо лише прив'язку до вже видаленого профілю.
    //
    // events також не видаляємо цілком, бо там може бути історія клієнтської
    // заявки. Прибираємо author_id там, де він посилається на цього майстра.

    await env.DB.batch([
      env.DB.prepare(`
        UPDATE requests
        SET source_master_id = NULL
        WHERE source_master_id = ?
      `).bind(master.id),

      env.DB.prepare(`
        UPDATE events
        SET author_id = NULL
        WHERE author_type = 'master'
          AND author_id = ?
      `).bind(String(master.id)),

      env.DB.prepare(`
        DELETE FROM masters
        WHERE id = ?
      `).bind(master.id),
    ]);
  } catch (err) {
    console.error("Permanent master delete failed:", err);
    await answerCallbackQuery(
      env,
      callbackId,
      "❌ Не вдалося видалити майстра з бази",
      true
    );
    return;
  }

  await answerCallbackQuery(
    env,
    callbackId,
    "🗑 Профіль майстра видалено назавжди",
    true
  );

  await sendMessageWithButtons(
    env,
    [
      "🗑 МАЙСТРА ВИДАЛЕНО",
      "",
      "Профіль та персональні дані майстра видалено з таблиці masters.",
      "Посилання на нього в клієнтських заявках/подіях очищено без видалення самих заявок.",
    ].join("\n"),
    [[
      {
        text: "👥 До списку майстрів",
        callback_data: "masters_list",
      },
    ]]
  );
}


3) У handleTelegramWebhook(...) ДОДАЙТЕ callback ДО блоку
   "Старі callback заявки":

if (data.startsWith("master_delete:")) {
  const masterId = Number(data.slice(14));

  await deleteMasterPermanently(
    env,
    cq.id,
    masterId
  );

  return json({ ok: true }, headers);
}


ВАЖЛИВО ПРО СХЕМУ D1
====================
Цей варіант безпечно працює з уже відомими зв'язками:
- requests.source_master_id
- events.author_id
- masters.id

Якщо у вашій поточній БД є ДОДАТКОВІ таблиці, які мають FOREIGN KEY на
masters.id (наприклад master_applications, assignments, ratings тощо),
їх теж треба очистити/анонімізувати перед DELETE FROM masters.
Не додавайте вигадані DELETE-запити для таблиць, яких у схемі немає.

ПЕРЕВІРКА
=========
Після deploy:
1. /start у sa-master.
2. 👥 Майстри.
3. Відкрити ТЕСТОВОГО майстра.
4. Має бути кнопка "🗑 Видалити назавжди".
5. Натиснути її.
6. Майстер має зникнути зі списку.
7. Пов'язані клієнтські заявки НЕ повинні зникнути.
