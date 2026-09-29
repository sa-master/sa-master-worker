import { json } from "../lib/json.js";
import {
  sendToJobsGroup,
  editJobsMessage,
  answerJobsCallback,
  sendToMaster,
} from "../lib/telegram-jobs.js";
import { sendTelegram } from "../lib/telegram.js";
import { buildMasterOutcomeButtons } from "../lib/telegram-buttons.js";
import {
  handleJoinStart,
  handleJoinMessage,
  handleApplicationReview,
} from "./join.js";

/* =========================================================
 * Публікація заявки в групу майстрів
 * ========================================================= */
export async function publishRequestToJobsGroup(env, request) {
  const text = [
    "🔔 НОВА ЗАЯВКА",
    `🆔 ${request.request_code}`,
    `👤 ${request.name}`,
    `🔧 ${request.type_label || request.type}`,
    `📍 ${request.location || "—"}`,
    request.project
      ? `📐 Дизайн-проєкт: ${request.project}`
      : null,
    request.timing
      ? `🗓 Початок: ${request.timing}`
      : null,
    `📊 Пріоритет: ${
      request.priority === "high"
        ? "🥇 Високий"
        : request.priority === "medium"
        ? "🥈 Середній"
        : "🥉 Низький"
    }`,
  ]
    .filter(Boolean)
    .join("\n");

  return sendToJobsGroup(
    env,
    text,
    [
      [
        {
          text: "🤝 Беру в роботу",
          callback_data: `take:${request.request_code}`,
        },
      ],
    ]
  );
}

/* =========================================================
 * POST /jobs-webhook
 * Повідомлення та кнопки SA-MASTER Jobs
 * ========================================================= */
export async function handleJobsWebhook(request, env, headers) {
  let update;

  try {
    update = await request.json();
  } catch {
    return json({ ok: false }, headers, 400);
  }

  /* =======================================================
   * ЗВИЧАЙНІ ПОВІДОМЛЕННЯ
   * ======================================================= */
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const fromUser = msg.from;
    const text = String(msg.text || "").trim();

    /* -----------------------------------------------------
     * /start
     * Стартова сторінка SA-MASTER Jobs
     * ----------------------------------------------------- */
    if (text === "/start" || text.startsWith("/start ")) {
      const welcomeText = [
        "🔧 SA-MASTER Jobs",
        "",
        "Сервіс для обміну заявками між майстрами.",
        "",
        "Тут публікуються заявки на роботи, які SA-MASTER або інші майстри не можуть взяти у роботу.",
        "",
        "🔔 Отримуйте нові заявки",
        "🤝 Беріть у роботу ті, які вам підходять",
        "📞 Отримуйте контакти замовника",
        "🔄 Передавайте іншим майстрам заявки, які не можете виконати самі",
        "",
        "➕ Є заявка, яку не можете взяти?",
        "",
        "Перейдіть на sa-master.pro та заповніть заявку від імені замовника, вказавши його контактні дані та інформацію про роботи.",
        "",
        "Після цього заявка потрапить у систему SA-MASTER Jobs і стане доступною іншим майстрам.",
        "",
        "⭐ Ми розвиваємо систему винагород для майстрів, які передають якісні заявки.",
        "",
        "Щоб отримати доступ до заявок, пройдіть коротку реєстрацію майстра.",
      ].join("\n");

      const welcomeButtons = [
        [
          {
            text: "🤝 Долучитися до SA-MASTER Jobs",
            callback_data: "join_start",
          },
        ],
      ];

      await sendToMaster(
        env,
        chatId,
        welcomeText,
        welcomeButtons
      );

      return json({ ok: true }, headers);
    }

    /* -----------------------------------------------------
     * /join
     * Резервний спосіб запуску анкети
     * ----------------------------------------------------- */
    if (text === "/join" || text.startsWith("/join ")) {
      return handleJoinStart(
        env,
        headers,
        chatId,
        fromUser
      );
    }

    /* -----------------------------------------------------
     * Відповіді користувача під час анкети
     * ----------------------------------------------------- */
    return handleJoinMessage(
      env,
      headers,
      chatId,
      fromUser,
      text
    );
  }

  /* =======================================================
   * CALLBACK-КНОПКИ
   * ======================================================= */
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = String(cq.data || "");

    /* -----------------------------------------------------
     * Долучитися до SA-MASTER Jobs
     * ----------------------------------------------------- */
    if (data === "join_start") {
      await answerJobsCallback(
        env,
        cq.id,
        "📝 Починаємо анкету"
      );

      return handleJoinStart(
        env,
        headers,
        cq.message.chat.id,
        cq.from
      );
    }

    /* -----------------------------------------------------
     * Взяти заявку
     * ----------------------------------------------------- */
    if (data.startsWith("take:")) {
      return handleTakeJob(
        env,
        headers,
        data.slice(5),
        cq
      );
    }

    /* -----------------------------------------------------
     * Результат контакту із замовником
     * ----------------------------------------------------- */
    if (data.startsWith("outcome:")) {
      const [, requestCode, outcome] = data.split(":");

      return handleMasterOutcome(
        env,
        headers,
        requestCode,
        outcome,
        cq
      );
    }

    /* -----------------------------------------------------
     * Прийняття анкети
     * ----------------------------------------------------- */
    if (data.startsWith("app_approve:")) {
      return handleApplicationReview(
        env,
        headers,
        Number(data.slice(12)),
        "approve",
        cq
      );
    }

    /* -----------------------------------------------------
     * Відхилення анкети
     * ----------------------------------------------------- */
    if (data.startsWith("app_reject:")) {
      return handleApplicationReview(
        env,
        headers,
        Number(data.slice(11)),
        "reject",
        cq
      );
    }

    await answerJobsCallback(
      env,
      cq.id,
      "❓ Невідома дія",
      true
    );
  }

  return json({ ok: true }, headers);
}

/* =========================================================
 * Перший майстер, який натиснув кнопку,
 * отримує заявку.
 *
 * Дані майстра зберігаються в базі
 * та надсилаються адміністратору,
 * але не показуються в групі.
 * ========================================================= */
async function handleTakeJob(
  env,
  headers,
  requestCode,
  cq
) {
  const master = cq.from;
  const masterId = master.id;

  const masterName = master.username
    ? `@${master.username}`
    : master.first_name;

  const req = await env.DB.prepare(`
    SELECT *
    FROM requests
    WHERE request_code = ?
    LIMIT 1
  `)
    .bind(requestCode)
    .first();

  if (!req) {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Заявку не знайдено",
      true
    );

    return json({ ok: true }, headers);
  }

  /* -----------------------------------------------------
   * Перевірка реєстрації майстра
   * ----------------------------------------------------- */
  const registeredMaster = await env.DB.prepare(`
    SELECT id, status
    FROM masters
    WHERE telegram_id = ?
    LIMIT 1
  `)
    .bind(masterId)
    .first();

  if (
    !registeredMaster ||
    registeredMaster.status !== "active"
  ) {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Ви ще не зареєстровані в SA-MASTER Jobs. Відкрийте бота та подайте анкету.",
      true
    );

    return json({ ok: true }, headers);
  }

  /* -----------------------------------------------------
   * WHERE assigned_master_id IS NULL
   * захищає від одночасного взяття заявки
   * двома майстрами.
   * ----------------------------------------------------- */
  let assigned;

  try {
    assigned = await env.DB.prepare(`
      UPDATE requests
      SET
        assigned_master_id = ?,
        assigned_master_name = ?,
        assigned_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND assigned_master_id IS NULL
    `)
      .bind(
        masterId,
        masterName,
        req.id
      )
      .run();
  } catch (err) {
    console.error("Take job failed:", err);

    await answerJobsCallback(
      env,
      cq.id,
      "❌ Помилка збереження",
      true
    );

    return json({ ok: true }, headers);
  }

  if (!assigned.meta?.changes) {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Цю заявку вже взяли в роботу",
      true
    );

    return json({ ok: true }, headers);
  }

  /* -----------------------------------------------------
   * Запис події
   * ----------------------------------------------------- */
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
      'master_took_job',
      ?,
      'master'
    )
  `)
    .bind(
      req.object_id || null,
      req.id,
      `${masterName} взяв заявку в роботу`
    )
    .run();

  /* -----------------------------------------------------
   * Оновлення повідомлення в групі
   * ----------------------------------------------------- */
  const groupText = [
    "🔒 ЗАЯВКУ ВЖЕ ВЗЯТО В РОБОТУ",
    `🆔 ${req.request_code}`,
    "📊 Статус: заявка зайнята",
  ].join("\n");

  await editJobsMessage(
    env,
    cq.message.message_id,
    groupText,
    []
  );

  /* -----------------------------------------------------
   * Контакти замовника отримує майстер
   * ----------------------------------------------------- */
  const contactsText = [
    `✅ Ви взяли заявку ${req.request_code}`,
    "",
    `👤 Клієнт: ${req.name}`,
    `📞 Телефон: ${req.phone}`,
    `📍 Об'єкт: ${req.location || "—"}`,
    req.project
      ? `📐 Дизайн-проєкт: ${req.project}`
      : null,
    req.timing
      ? `🗓 Початок: ${req.timing}`
      : null,
    "",
    "Після розмови — позначте результат:",
  ]
    .filter(Boolean)
    .join("\n");

  await sendToMaster(
    env,
    masterId,
    contactsText,
    buildMasterOutcomeButtons(req.request_code)
  );

  /* -----------------------------------------------------
   * Адміністратор отримує інформацію про виконавця
   * ----------------------------------------------------- */
  await sendTelegram(
    env,
    [
      "🔔 ЗАЯВКУ ВЗЯТО",
      `🆔 ${req.request_code}`,
      `🙋 Майстер: ${masterName}`,
      `👤 Клієнт: ${req.name}`,
      `📞 ${req.phone}`,
    ].join("\n")
  );

  await answerJobsCallback(
    env,
    cq.id,
    "✅ Ви взяли заявку"
  );

  return json({ ok: true }, headers);
}

/* =========================================================
 * Результат контакту із замовником
 * ========================================================= */
async function handleMasterOutcome(
  env,
  headers,
  requestCode,
  outcome,
  cq
) {
  const master = cq.from;
  const masterId = master.id;

  const masterName = master.username
    ? `@${master.username}`
    : master.first_name;

  const validOutcomes = [
    "working",
    "no_answer",
    "weird_client",
    "too_expensive",
  ];

  if (!validOutcomes.includes(outcome)) {
    await answerJobsCallback(
      env,
      cq.id,
      "❓ Невідомий результат",
      true
    );

    return json({ ok: true }, headers);
  }

  const req = await env.DB.prepare(`
    SELECT *
    FROM requests
    WHERE request_code = ?
    LIMIT 1
  `)
    .bind(requestCode)
    .first();

  if (!req) {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Заявку не знайдено",
      true
    );

    return json({ ok: true }, headers);
  }

  /* -----------------------------------------------------
   * Зберігаємо результат
   * ----------------------------------------------------- */
  try {
    await env.DB.prepare(`
      INSERT INTO request_outcomes (
        request_id,
        master_id,
        outcome
      )
      VALUES (?, ?, ?)
    `)
      .bind(
        req.id,
        masterId,
        outcome
      )
      .run();
  } catch (err) {
    console.error("Save outcome failed:", err);
  }

  /* =======================================================
   * ЗАЯВКА В РОБОТІ
   * ======================================================= */
  if (outcome === "working") {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE masters
        SET good_deals_count =
          COALESCE(good_deals_count, 0) + 1
        WHERE telegram_id = ?
      `).bind(masterId),

      env.DB.prepare(`
        UPDATE requests
        SET
          status = 'installation',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(req.id),

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
          'master_working',
          ?,
          'master'
        )
      `).bind(
        req.object_id || null,
        req.id,
        `${masterName} підтвердив роботу`
      ),
    ]);

    await answerJobsCallback(
      env,
      cq.id,
      "✅ Дякую! Заявка в роботі"
    );

    await sendToMaster(
      env,
      masterId,
      "✅ Заявка переведена в статус «У роботі». Успіхів!"
    );
  }

  /* =======================================================
   * КЛІЄНТ НЕ ВІДПОВІДАЄ
   * ======================================================= */
  if (outcome === "no_answer") {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE masters
        SET no_answer_count =
          COALESCE(no_answer_count, 0) + 1
        WHERE telegram_id = ?
      `).bind(masterId),

      env.DB.prepare(`
        UPDATE requests
        SET
          assigned_master_id = NULL,
          assigned_master_name = NULL,
          assigned_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(req.id),

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
          'client_no_answer',
          ?,
          'master'
        )
      `).bind(
        req.object_id || null,
        req.id,
        `${masterName}: клієнт не відповідає`
      ),

      ...(req.client_id
        ? [
            env.DB.prepare(`
              UPDATE clients
              SET no_answer_count =
                COALESCE(no_answer_count, 0) + 1
              WHERE id = ?
            `).bind(req.client_id),
          ]
        : []),
    ]);

    const text = [
      `🔔 ЗАЯВКА ${req.request_code}`,
      `👤 ${req.name}`,
      `🔧 ${req.type_label || req.type}`,
      `📍 ${req.location || "—"}`,
      "",
      "⚠️ Попередній майстер не зміг додзвонитись",
    ].join("\n");

    await sendToJobsGroup(
      env,
      text,
      [
        [
          {
            text: "🤝 Беру в роботу",
            callback_data: `take:${req.request_code}`,
          },
        ],
      ]
    );

    await answerJobsCallback(
      env,
      cq.id,
      "✅ Заявка повернута в канал"
    );

    await sendToMaster(
      env,
      masterId,
      "Заявку повернуто в канал з позначкою «клієнт не відповідав»"
    );

    await sendTelegram(
      env,
      `⚠️ ${masterName} повідомив: клієнт ${req.name} (${req.request_code}) не відповідає`
    );
  }

  /* =======================================================
   * ДИВНИЙ КЛІЄНТ
   * ======================================================= */
  if (outcome === "weird_client") {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE masters
        SET weird_client_count =
          COALESCE(weird_client_count, 0) + 1
        WHERE telegram_id = ?
      `).bind(masterId),

      env.DB.prepare(`
        UPDATE requests
        SET
          status = 'cancelled',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(req.id),

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
          'weird_client',
          ?,
          'master'
        )
      `).bind(
        req.object_id || null,
        req.id,
        `${masterName}: дивний клієнт`
      ),

      ...(req.client_id
        ? [
            env.DB.prepare(`
              UPDATE clients
              SET weird_count =
                COALESCE(weird_count, 0) + 1
              WHERE id = ?
            `).bind(req.client_id),
          ]
        : []),
    ]);

    await answerJobsCallback(
      env,
      cq.id,
      "⚠️ Позначено. Дякую!"
    );

    await sendToMaster(
      env,
      masterId,
      "Заявку закрито. Дякую за сигнал!"
    );

    await sendTelegram(
      env,
      `⚠️ ${masterName} позначив клієнта ${req.name} (${req.request_code}) як дивного`
    );
  }

  /* =======================================================
   * ЗАЯВКА НЕ ПІДХОДИТЬ
   * ======================================================= */
  if (outcome === "too_expensive") {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE requests
        SET
          assigned_master_id = NULL,
          assigned_master_name = NULL,
          assigned_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(req.id),

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
          'not_suitable',
          ?,
          'master'
        )
      `).bind(
        req.object_id || null,
        req.id,
        `${masterName}: не підходить`
      ),
    ]);

    await sendToJobsGroup(
      env,
      [
        `🔔 ЗАЯВКА ${req.request_code}`,
        `👤 ${req.name}`,
        `📍 ${req.location || "—"}`,
        "",
        "[Повторно]",
      ].join("\n"),
      [
        [
          {
            text: "🤝 Беру в роботу",
            callback_data: `take:${req.request_code}`,
          },
        ],
      ]
    );

    await answerJobsCallback(
      env,
      cq.id,
      "✅ Заявка повернута в канал"
    );

    await sendToMaster(
      env,
      masterId,
      "Заявку повернуто в канал"
    );
  }

  return json({ ok: true }, headers);
}