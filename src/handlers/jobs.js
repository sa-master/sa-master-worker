import { json } from "../lib/json.js";
import {
  sendToJobsGroup,
  editJobsMessage,
  answerJobsCallback,
  sendToMaster,
  createInviteForMaster,
} from "../lib/telegram-jobs.js";
import { sendTelegram } from "../lib/telegram.js";
import { buildMasterOutcomeButtons } from "../lib/telegram-buttons.js";
import {
  handleJoinStart,
  handleJoinMessage,
  handleApplicationReview,
} from "./join.js";

const SITE_URL = "https://sa-master.pro/";

/* =========================================================
 * Допоміжні функції майстра
 * ========================================================= */

async function getMasterByTelegramId(env, telegramId) {
  return env.DB.prepare(`
    SELECT *
    FROM masters
    WHERE telegram_id = ?
    LIMIT 1
  `)
    .bind(telegramId)
    .first();
}

function masterAccessMessage(status) {
  if (status === "blocked") {
    return [
      "🚫 ДОСТУП ЗАБОРОНЕНО",
      "",
      "Ваш профіль SA-MASTER Jobs заблоковано адміністратором.",
      "",
      "Ви не можете брати або передавати заявки.",
      "",
      "Для відновлення доступу зверніться до адміністратора.",
    ].join("\n");
  }

  if (status === "inactive") {
    return [
      "⚪ ПРОФІЛЬ НЕАКТИВНИЙ",
      "",
      "Ви зараз не перебуваєте у групі SA-MASTER Jobs.",
      "",
      "Щоб повернутися до роботи із заявками, виконайте /start та отримайте нове запрошення.",
    ].join("\n");
  }

  return "❌ Доступ до SA-MASTER Jobs відсутній.";
}

async function ensureActiveMaster(env, telegramId) {
  const master = await getMasterByTelegramId(env, telegramId);

  return {
    master,
    active: Boolean(master && master.status === "active"),
  };
}

async function setMasterMembershipStatus(env, telegramId, nextStatus) {
  if (!telegramId) return;

  try {
    await env.DB.prepare(`
      UPDATE masters
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
        AND status != 'blocked'
    `).bind(nextStatus, telegramId).run();
  } catch (err) {
    console.error("Master membership status sync failed:", err);
  }
}

async function handleJobsGroupServiceMessage(env, msg) {
  if (String(msg.chat?.id) !== String(env.JOBS_CHAT_ID)) {
    return false;
  }

  if (msg.left_chat_member?.id) {
    await setMasterMembershipStatus(
      env,
      msg.left_chat_member.id,
      "inactive"
    );
    return true;
  }

  if (Array.isArray(msg.new_chat_members) && msg.new_chat_members.length) {
    for (const member of msg.new_chat_members) {
      if (member?.id) {
        await setMasterMembershipStatus(
          env,
          member.id,
          "active"
        );
      }
    }
    return true;
  }

  return false;
}

/* =========================================================
 * Персональне посилання для передачі заявки
 * ========================================================= */

async function getMasterReferralLink(env, telegramId) {
  const master = await getMasterByTelegramId(env, telegramId);

  if (!master || master.status !== "active") {
    return null;
  }

  let token = master.referral_token;

  if (!token) {
    token = crypto.randomUUID().replaceAll("-", "");

    try {
      await env.DB.prepare(`
        UPDATE masters
        SET
          referral_token = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND referral_token IS NULL
          AND status = 'active'
      `)
        .bind(token, master.id)
        .run();

      const updatedMaster = await env.DB.prepare(`
        SELECT referral_token, status
        FROM masters
        WHERE id = ?
        LIMIT 1
      `)
        .bind(master.id)
        .first();

      if (!updatedMaster || updatedMaster.status !== "active") {
        return null;
      }

      token = updatedMaster.referral_token || token;
    } catch (err) {
      console.error("Referral token generation failed:", err);
      return null;
    }
  }

  const url = new URL(SITE_URL);
  url.searchParams.set("ref", token);

  return url.toString();
}

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

    if (await handleJobsGroupServiceMessage(env, msg)) {
      return json({ ok: true }, headers);
    }

    /* -----------------------------------------------------
     * /start
     * ----------------------------------------------------- */

    if (
      text === "/start" ||
      text.startsWith("/start ")
    ) {
      const master = await getMasterByTelegramId(
        env,
        fromUser.id
      );

      if (master && master.status === "active") {
        const masterText = [
          "🔧 SA-MASTER Jobs",
          "",
          "Ви зареєстровані в системі як майстер.",
          "",
          "🔔 Отримуйте заявки від інших майстрів",
          "🤝 Беріть у роботу ті, які вам підходять",
          "🔄 Передавайте заявки, які не можете виконати самі",
          "",
          "👥 Якщо ви ще не в групі заявок або раніше вийшли з неї — отримайте нове персональне запрошення.",
          "",
          "➕ Якщо маєте заявку, яку не можете взяти в роботу — передайте її через SA-MASTER Jobs.",
          "",
          "Заявку потрібно заповнити від імені замовника, вказавши його контактні дані та інформацію про роботи.",
          "",
          "⭐ Передані заявки фіксуються за вашим профілем. Ми розвиваємо систему винагород для майстрів, які передають якісні заявки.",
        ].join("\n");

        const masterButtons = [
          [
            {
              text: "👥 Увійти в групу заявок",
              callback_data: "get_group_invite",
            },
          ],
          [
            {
              text: "➕ Передати заявку",
              callback_data: "submit_request",
            },
          ],
        ];

        await sendToMaster(
          env,
          chatId,
          masterText,
          masterButtons
        );

        return json({ ok: true }, headers);
      }

      if (master && master.status === "inactive") {
        const inactiveText = [
          "🔧 SA-MASTER Jobs",
          "",
          "⚪ Ваш профіль зараз неактивний.",
          "",
          "Ви не перебуваєте у групі заявок.",
          "Щоб знову працювати із заявками — отримайте нове персональне запрошення.",
        ].join("\n");

        await sendToMaster(
          env,
          chatId,
          inactiveText,
          [
            [
              {
                text: "👥 Увійти в групу заявок",
                callback_data: "get_group_invite",
              },
            ],
          ]
        );

        return json({ ok: true }, headers);
      }

      if (master && master.status === "blocked") {
        await sendToMaster(
          env,
          chatId,
          masterAccessMessage(master.status)
        );

        return json({ ok: true }, headers);
      }

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
        "Після реєстрації ви зможете передавати такі заявки через SA-MASTER Jobs.",
        "",
        "⭐ Ми розвиваємо систему винагород для майстрів, які передають якісні заявки.",
        "",
        "Щоб отримати доступ до заявок та можливість передавати власні заявки, пройдіть коротку реєстрацію майстра.",
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
     *
     * Повторна анкета для вже зареєстрованого майстра
     * ніколи не запускається.
     * ----------------------------------------------------- */

    if (
      text === "/join" ||
      text.startsWith("/join ")
    ) {
      const master = await getMasterByTelegramId(
        env,
        fromUser.id
      );

      if (master) {
        if (master.status === "blocked") {
          await sendToMaster(
            env,
            chatId,
            masterAccessMessage("blocked")
          );

          return json({ ok: true }, headers);
        }

        if (master.status === "inactive") {
          await sendToMaster(
            env,
            chatId,
            [
              "⚪ Ваш профіль SA-MASTER Jobs уже зареєстрований.",
              "",
              "Повторно заповнювати анкету не потрібно.",
              "",
              "Щоб повернутися до групи заявок, виконайте /start та натисніть «👥 Увійти в групу заявок».",
            ].join("\n")
          );

          return json({ ok: true }, headers);
        }

        if (master.status === "active") {
          await sendToMaster(
            env,
            chatId,
            [
              "✅ Ви вже зареєстровані в SA-MASTER Jobs.",
              "",
              "Повторно заповнювати анкету не потрібно.",
            ].join("\n")
          );

          return json({ ok: true }, headers);
        }

        await sendToMaster(
          env,
          chatId,
          "⚠️ Ваш профіль уже існує. Зверніться до адміністратора для перевірки доступу."
        );

        return json({ ok: true }, headers);
      }

      return handleJoinStart(
        env,
        headers,
        chatId,
        fromUser
      );
    }

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

    if (data === "join_start") {
      const master = await getMasterByTelegramId(
        env,
        cq.from.id
      );

      if (master) {
        if (master.status === "active") {
          await answerJobsCallback(
            env,
            cq.id,
            "✅ Ви вже зареєстровані",
            true
          );
        } else {
          await answerJobsCallback(
            env,
            cq.id,
            master.status === "blocked"
              ? "🚫 Ваш профіль заблоковано"
              : "⚪ Ваш профіль неактивний",
            true
          );
        }

        return json({ ok: true }, headers);
      }

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

    if (data === "get_group_invite") {
      const access = await ensureActiveMaster(
        env,
        cq.from.id
      );

      const canJoin =
        access.master &&
        (
          access.master.status === "active" ||
          access.master.status === "inactive"
        );

      if (!canJoin) {
        const message =
          access.master?.status === "blocked"
            ? "🚫 Ваш профіль заблоковано"
            : "❌ Ви не зареєстровані";

        await answerJobsCallback(
          env,
          cq.id,
          message,
          true
        );

        return json({ ok: true }, headers);
      }

      const invite = await createInviteForMaster(
        env,
        cq.from.id
      );

      if (!invite?.ok) {
        console.error(
          "Create invite for master failed:",
          invite
        );

        await answerJobsCallback(
          env,
          cq.id,
          "❌ Не вдалося перевірити доступ до групи",
          true
        );

        return json({ ok: true }, headers);
      }

      if (invite.already_member) {
        await answerJobsCallback(
          env,
          cq.id,
          "✅ Ви вже перебуваєте у групі SA-MASTER Jobs",
          true
        );

        return json({ ok: true }, headers);
      }

      if (!invite.invite_link) {
        await answerJobsCallback(
          env,
          cq.id,
          "❌ Не вдалося створити посилання",
          true
        );

        return json({ ok: true }, headers);
      }

      await answerJobsCallback(
        env,
        cq.id,
        invite.was_unbanned
          ? "✅ Доступ відновлено"
          : "✅ Посилання створено"
      );

      const inviteText = [
        "👥 ГРУПА SA-MASTER Jobs",
        "",
        invite.was_unbanned
          ? "Ваш доступ до групи відновлено."
          : "Натисніть кнопку нижче, щоб приєднатися до групи заявок.",
        "",
        "🔐 Посилання персональне та одноразове.",
        "",
        "Якщо ви вийдете з групи — відкрийте бота та отримайте нове.",
      ].join("\n");

      const inviteButtons = [
        [
          {
            text: "👥 Приєднатися до групи",
            url: invite.invite_link,
          },
        ],
      ];

      await sendToMaster(
        env,
        cq.message.chat.id,
        inviteText,
        inviteButtons
      );

      return json({ ok: true }, headers);
    }

    if (data === "submit_request") {
      const access = await ensureActiveMaster(
        env,
        cq.from.id
      );

      if (!access.active) {
        const message =
          access.master?.status === "blocked"
            ? "🚫 Ваш профіль заблоковано"
            : access.master?.status === "inactive"
            ? "⚪ Спочатку поверніться до групи заявок"
            : "❌ Ви не зареєстровані";

        await answerJobsCallback(
          env,
          cq.id,
          message,
          true
        );

        return json({ ok: true }, headers);
      }

      const referralLink = await getMasterReferralLink(
        env,
        cq.from.id
      );

      if (!referralLink) {
        await answerJobsCallback(
          env,
          cq.id,
          "❌ Не вдалося створити посилання",
          true
        );

        return json({ ok: true }, headers);
      }

      await answerJobsCallback(env, cq.id, "");

      const text = [
        "➕ ПЕРЕДАТИ ЗАЯВКУ",
        "",
        "Натисніть кнопку нижче та заповніть заявку від імені замовника.",
        "",
        "Вкажіть:",
        "👤 ім'я замовника",
        "📞 його телефон",
        "🔧 потрібні роботи",
        "📍 інформацію про об'єкт",
        "",
        "Заявка буде автоматично прив'язана до вашого профілю SA-MASTER Jobs.",
      ].join("\n");

      const buttons = [
        [
          {
            text: "➕ Заповнити заявку",
            url: referralLink,
          },
        ],
      ];

      await sendToMaster(
        env,
        cq.message.chat.id,
        text,
        buttons
      );

      return json({ ok: true }, headers);
    }

    if (data.startsWith("take:")) {
      return handleTakeJob(
        env,
        headers,
        data.slice(5),
        cq
      );
    }

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

    if (data.startsWith("app_approve:")) {
      return handleApplicationReview(
        env,
        headers,
        Number(data.slice(12)),
        "approve",
        cq
      );
    }

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
 * отримує заявку
 * ========================================================= */

async function handleTakeJob(
  env,
  headers,
  requestCode,
  cq
) {
  const telegramMaster = cq.from;
  const telegramId = telegramMaster.id;

  const masterName =
    telegramMaster.username
      ? `@${telegramMaster.username}`
      : telegramMaster.first_name;

  const registeredMaster = await getMasterByTelegramId(
    env,
    telegramId
  );

  if (!registeredMaster) {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Ви ще не зареєстровані в SA-MASTER Jobs. Відкрийте бота та подайте анкету.",
      true
    );

    return json({ ok: true }, headers);
  }

  if (registeredMaster.status === "blocked") {
    await answerJobsCallback(
      env,
      cq.id,
      "🚫 Ваш профіль заблоковано",
      true
    );

    return json({ ok: true }, headers);
  }

  if (registeredMaster.status !== "active") {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Ваш профіль неактивний",
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
        telegramId,
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
      ?,
      ?,
      'master_took_job',
      ?,
      'master',
      ?
    )
  `)
    .bind(
      req.object_id || null,
      req.id,
      `${masterName} взяв заявку в роботу`,
      String(registeredMaster.id)
    )
    .run();

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
    telegramId,
    contactsText,
    buildMasterOutcomeButtons(
      req.request_code
    )
  );

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
  const telegramMaster = cq.from;
  const telegramId = telegramMaster.id;

  const masterName =
    telegramMaster.username
      ? `@${telegramMaster.username}`
      : telegramMaster.first_name;

  const registeredMaster = await getMasterByTelegramId(
    env,
    telegramId
  );

  if (!registeredMaster) {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Ваш профіль майстра не знайдено",
      true
    );

    return json({ ok: true }, headers);
  }

  if (registeredMaster.status === "blocked") {
    await answerJobsCallback(
      env,
      cq.id,
      "🚫 Ваш профіль заблоковано",
      true
    );

    return json({ ok: true }, headers);
  }

  if (registeredMaster.status !== "active") {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Ваш профіль неактивний",
      true
    );

    return json({ ok: true }, headers);
  }

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

  if (
    String(req.assigned_master_id || "") !==
    String(telegramId)
  ) {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Ця заявка більше не закріплена за вами",
      true
    );

    return json({ ok: true }, headers);
  }

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
        telegramId,
        outcome
      )
      .run();
  } catch (err) {
    console.error("Save outcome failed:", err);
  }

  if (outcome === "working") {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE masters
        SET
          good_deals_count =
            COALESCE(good_deals_count, 0) + 1
        WHERE telegram_id = ?
          AND status = 'active'
      `).bind(telegramId),

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
          author_type,
          author_id
        )
        VALUES (
          ?,
          ?,
          'master_working',
          ?,
          'master',
          ?
        )
      `).bind(
        req.object_id || null,
        req.id,
        `${masterName} підтвердив роботу`,
        String(registeredMaster.id)
      ),
    ]);

    await answerJobsCallback(
      env,
      cq.id,
      "✅ Дякую! Заявка в роботі"
    );

    await sendToMaster(
      env,
      telegramId,
      "✅ Заявка переведена в статус «У роботі». Успіхів!"
    );
  }

  if (outcome === "no_answer") {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE masters
        SET no_answer_count =
          COALESCE(no_answer_count, 0) + 1
        WHERE telegram_id = ?
          AND status = 'active'
      `).bind(telegramId),

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
          author_type,
          author_id
        )
        VALUES (
          ?,
          ?,
          'client_no_answer',
          ?,
          'master',
          ?
        )
      `).bind(
        req.object_id || null,
        req.id,
        `${masterName}: клієнт не відповідає`,
        String(registeredMaster.id)
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
      telegramId,
      "Заявку повернуто в канал з позначкою «клієнт не відповідав»"
    );

    await sendTelegram(
      env,
      `⚠️ ${masterName} повідомив: клієнт ${req.name} (${req.request_code}) не відповідає`
    );
  }

  if (outcome === "weird_client") {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE masters
        SET weird_client_count =
          COALESCE(weird_client_count, 0) + 1
        WHERE telegram_id = ?
          AND status = 'active'
      `).bind(telegramId),

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
          author_type,
          author_id
        )
        VALUES (
          ?,
          ?,
          'weird_client',
          ?,
          'master',
          ?
        )
      `).bind(
        req.object_id || null,
        req.id,
        `${masterName}: дивний клієнт`,
        String(registeredMaster.id)
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
      telegramId,
      "Заявку закрито. Дякую за сигнал!"
    );

    await sendTelegram(
      env,
      `⚠️ ${masterName} позначив клієнта ${req.name} (${req.request_code}) як дивного`
    );
  }

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
          author_type,
          author_id
        )
        VALUES (
          ?,
          ?,
          'not_suitable',
          ?,
          'master',
          ?
        )
      `).bind(
        req.object_id || null,
        req.id,
        `${masterName}: не підходить`,
        String(registeredMaster.id)
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
      telegramId,
      "Заявку повернуто в канал"
    );
  }

  return json({ ok: true }, headers);
}
