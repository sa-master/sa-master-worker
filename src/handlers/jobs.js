import { json } from "../lib/json.js";
import {
  sendToMaster,
  answerJobsCallback,
} from "../lib/telegram-jobs.js";
import { sendTelegram } from "../lib/telegram.js";
import {
  buildMasterOutcomeButtons,
  buildMasterNotAgreedReasonButtons,
} from "../lib/telegram-buttons.js";
import {
  handleJoinStart,
  handleJoinMessage,
  handleApplicationReview,
} from "./join.js";

const SITE_URL = "https://sa-master.pro/";
const JOBS_LIMIT = 20;

/* =========================================================
 * MASTER: helpers
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

async function ensureActiveMaster(env, telegramId) {
  const master = await getMasterByTelegramId(
    env,
    telegramId
  );

  return {
    master,
    active: Boolean(
      master &&
      master.status === "active"
    ),
  };
}

function masterAccessMessage(status) {
  if (status === "blocked") {
    return [
      "🚫 ДОСТУП ЗАБОРОНЕНО",
      "",
      "Ваш профіль SA-MASTER Jobs заблоковано адміністратором.",
      "",
      "Ви не можете переглядати, брати або передавати заявки.",
      "",
      "Для відновлення доступу зверніться до адміністратора.",
    ].join("\n");
  }

  if (status === "inactive") {
    return [
      "⚪ ПРОФІЛЬ НЕАКТИВНИЙ",
      "",
      "Ваш профіль SA-MASTER Jobs зараз неактивний.",
      "",
      "Для відновлення доступу зверніться до адміністратора.",
    ].join("\n");
  }

  return [
    "❌ ДОСТУП ВІДСУТНІЙ",
    "",
    "Ви не зареєстровані в SA-MASTER Jobs.",
  ].join("\n");
}

/* =========================================================
 * Головне меню
 * ========================================================= */

function buildHomeButtons() {
  return [
    [
      {
        text: "📋 Доступні заявки",
        callback_data: "jobs_list",
      },
    ],
    [
      {
        text: "➕ Передати заявку",
        callback_data: "submit_request",
      },
    ],
  ];
}

async function sendHome(
  env,
  chatId,
  master
) {
  const text = [
    "🔧 SA-MASTER Jobs",
    "",
    master?.first_name
      ? `Вітаємо, ${master.first_name}!`
      : "Вітаємо!",
    "",
    "📋 Переглядайте доступні заявки",
    "🤝 Беріть у роботу ті, які вам підходять",
    "📞 Контакти замовника відкриваються тільки після взяття заявки",
    "🔄 Передавайте заявки, які не можете виконати самі",
    "",
    "Оберіть дію:",
  ].join("\n");

  return sendToMaster(
    env,
    chatId,
    text,
    buildHomeButtons()
  );
}

/* =========================================================
 * Персональне посилання майстра
 * ========================================================= */

async function getMasterReferralLink(
  env,
  telegramId
) {
  const master =
    await getMasterByTelegramId(
      env,
      telegramId
    );

  if (
    !master ||
    master.status !== "active"
  ) {
    return null;
  }

  let token =
    master.referral_token;

  if (!token) {
    token =
      crypto.randomUUID()
        .replaceAll("-", "");

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
        .bind(
          token,
          master.id
        )
        .run();

      const updated =
        await env.DB.prepare(`
          SELECT
            referral_token,
            status
          FROM masters
          WHERE id = ?
          LIMIT 1
        `)
          .bind(master.id)
          .first();

      if (
        !updated ||
        updated.status !== "active"
      ) {
        return null;
      }

      token =
        updated.referral_token ||
        token;
    } catch (err) {
      console.error(
        "Referral token generation failed:",
        err
      );

      return null;
    }
  }

  const url =
    new URL(SITE_URL);

  url.searchParams.set(
    "ref",
    token
  );

  return url.toString();
}

/* =========================================================
 * Публікація заявки в SA-MASTER Jobs
 *
 * Заявка НЕ надсилається в Telegram-групу.
 * Вона стає доступною майстрам у боті.
 * ========================================================= */

export async function publishRequestToJobs(
  env,
  request
) {
  if (
    !request?.id &&
    !request?.request_code
  ) {
    return {
      ok: false,
      description:
        "REQUEST_NOT_FOUND",
    };
  }

  try {
    let result;

    if (request.id) {
      result =
        await env.DB.prepare(`
          UPDATE requests
          SET
            transferred_to_jobs = 1,
            transferred_at =
              COALESCE(
                transferred_at,
                CURRENT_TIMESTAMP
              ),
            updated_at =
              CURRENT_TIMESTAMP
          WHERE id = ?
        `)
          .bind(request.id)
          .run();
    } else {
      result =
        await env.DB.prepare(`
          UPDATE requests
          SET
            transferred_to_jobs = 1,
            transferred_at =
              COALESCE(
                transferred_at,
                CURRENT_TIMESTAMP
              ),
            updated_at =
              CURRENT_TIMESTAMP
          WHERE request_code = ?
        `)
          .bind(
            request.request_code
          )
          .run();
    }

    if (!result.meta?.changes) {
      return {
        ok: false,
        description:
          "Заявку не знайдено",
      };
    }

    return {
      ok: true,
      request_code:
        request.request_code,
    };
  } catch (err) {
    console.error(
      "Publish request to Jobs failed:",
      err
    );

    return {
      ok: false,
      description:
        String(
          err?.message ||
          err
        ),
    };
  }
}

/* Тимчасова сумісність зі старими імпортами */
export async function publishRequestToJobsGroup(
  env,
  request
) {
  return publishRequestToJobs(
    env,
    request
  );
}

/* =========================================================
 * Отримання доступних заявок
 * ========================================================= */

async function getAvailableJobs(env) {
  const rows =
    await env.DB.prepare(`
      SELECT
        id,
        request_code,
        type,
        type_label,
        location,
        timing,
        project,
        priority,
        notes,
        created_at
      FROM requests
      WHERE transferred_to_jobs = 1
        AND assigned_master_id IS NULL
        AND status NOT IN (
          'cancelled',
          'installation',
          'completed'
        )
      ORDER BY
        CASE priority
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END,
        id DESC
      LIMIT ?
    `)
      .bind(JOBS_LIMIT)
      .all();

  return rows.results || [];
}

function jobButtonText(req) {
  const type =
    req.type_label ||
    req.type ||
    "Заявка";

  const location =
    req.location ||
    "Без адреси";

  const text =
    `${type} · ${location}`;

  if (text.length <= 60) {
    return text;
  }

  return (
    text.slice(0, 57) +
    "..."
  );
}

/* =========================================================
 * Список заявок
 * ========================================================= */

async function showAvailableJobs(
  env,
  chatId
) {
  const jobs =
    await getAvailableJobs(env);

  if (!jobs.length) {
    return sendToMaster(
      env,
      chatId,
      [
        "📋 ДОСТУПНІ ЗАЯВКИ",
        "",
        "Зараз немає вільних заявок.",
        "",
        "Нові заявки з'являться тут після публікації адміністратором.",
      ].join("\n"),
      [
        [
          {
            text: "🔄 Оновити",
            callback_data:
              "jobs_list",
          },
        ],
        [
          {
            text: "➕ Передати заявку",
            callback_data:
              "submit_request",
          },
        ],
        [
          {
            text: "🏠 Головна",
            callback_data:
              "jobs_home",
          },
        ],
      ]
    );
  }

  const buttons =
    jobs.map((req) => [
      {
        text:
          jobButtonText(req),

        callback_data:
          `job_open:${req.request_code}`,
      },
    ]);

  buttons.push([
    {
      text: "🔄 Оновити",
      callback_data:
        "jobs_list",
    },
  ]);

  buttons.push([
    {
      text: "➕ Передати заявку",
      callback_data:
        "submit_request",
    },
    {
      text: "🏠 Головна",
      callback_data:
        "jobs_home",
    },
  ]);

  return sendToMaster(
    env,
    chatId,
    [
      "📋 ДОСТУПНІ ЗАЯВКИ",
      "",
      `Вільних заявок: ${jobs.length}`,
      "",
      "🔒 Контактні дані замовників приховані.",
      "",
      "Оберіть заявку, щоб переглянути деталі.",
    ].join("\n"),
    buttons
  );
}

/* =========================================================
 * Картка заявки БЕЗ контактів
 * ========================================================= */

async function showJobCard(
  env,
  chatId,
  requestCode
) {
  const req =
    await env.DB.prepare(`
      SELECT *
      FROM requests
      WHERE request_code = ?
        AND transferred_to_jobs = 1
      LIMIT 1
    `)
      .bind(requestCode)
      .first();

  if (!req) {
    return sendToMaster(
      env,
      chatId,
      "❌ Заявку не знайдено."
    );
  }

  if (
    req.assigned_master_id ||
    [
      "cancelled",
      "installation",
      "completed",
    ].includes(req.status)
  ) {
    return sendToMaster(
      env,
      chatId,
      [
        "🔒 ЗАЯВКА НЕДОСТУПНА",
        "",
        "Цю заявку вже взяли або вона була закрита.",
      ].join("\n"),
      [
        [
          {
            text: "📋 До заявок",
            callback_data:
              "jobs_list",
          },
        ],
      ]
    );
  }

  const text = [
    "🔔 ЗАЯВКА",
    `🆔 ${req.request_code}`,
    "",
    `🔧 ${
      req.type_label ||
      req.type ||
      "—"
    }`,
    `📍 ${
      req.location ||
      "—"
    }`,
    req.project
      ? `📐 Дизайн-проєкт: ${req.project}`
      : null,
    req.timing
      ? `🗓 Початок: ${req.timing}`
      : null,
    req.notes
      ? `📝 Опис: ${req.notes}`
      : null,
    "",
    "🔒 Ім'я та телефон замовника приховані.",
    "",
    "Після натискання «🤝 Беру в роботу» заявка буде закріплена за вами, а контакти відкриються в особистому чаті з ботом.",
  ]
    .filter(Boolean)
    .join("\n");

  return sendToMaster(
    env,
    chatId,
    text,
    [
      [
        {
          text: "🤝 Беру в роботу",
          callback_data:
            `take:${req.request_code}`,
        },
      ],
      [
        {
          text: "📋 До заявок",
          callback_data:
            "jobs_list",
        },
      ],
    ]
  );
}

/* =========================================================
 * POST /jobs-webhook
 * ========================================================= */

export async function handleJobsWebhook(
  request,
  env,
  headers
) {
  let update;

  try {
    update =
      await request.json();
  } catch {
    return json(
      { ok: false },
      headers,
      400
    );
  }

  if (update.message) {
    const msg =
      update.message;

    const chatId =
      msg.chat?.id;

    const fromUser =
      msg.from;

    const text =
      String(
        msg.text || ""
      ).trim();

    if (!fromUser?.id) {
      return json(
        { ok: true },
        headers
      );
    }

    if (
      text === "/start" ||
      text.startsWith("/start ")
    ) {
      const master =
        await getMasterByTelegramId(
          env,
          fromUser.id
        );

      if (
        master &&
        master.status === "active"
      ) {
        await sendHome(
          env,
          chatId,
          master
        );

        return json(
          { ok: true },
          headers
        );
      }

      if (master) {
        await sendToMaster(
          env,
          chatId,
          masterAccessMessage(
            master.status
          )
        );

        return json(
          { ok: true },
          headers
        );
      }

      return handleJoinStart(
        env,
        headers,
        chatId,
        fromUser
      );
    }

    if (
      text === "/join" ||
      text.startsWith("/join ")
    ) {
      const master =
        await getMasterByTelegramId(
          env,
          fromUser.id
        );

      if (
        master &&
        master.status === "active"
      ) {
        await sendHome(
          env,
          chatId,
          master
        );

        return json(
          { ok: true },
          headers
        );
      }

      if (master) {
        await sendToMaster(
          env,
          chatId,
          masterAccessMessage(
            master.status
          )
        );

        return json(
          { ok: true },
          headers
        );
      }

      return handleJoinStart(
        env,
        headers,
        chatId,
        fromUser
      );
    }

    if (
      text === "/jobs" ||
      text.startsWith("/jobs ")
    ) {
      const access =
        await ensureActiveMaster(
          env,
          fromUser.id
        );

      if (!access.active) {
        await sendToMaster(
          env,
          chatId,
          masterAccessMessage(
            access.master?.status
          )
        );

        return json(
          { ok: true },
          headers
        );
      }

      await showAvailableJobs(
        env,
        chatId
      );

      return json(
        { ok: true },
        headers
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

  if (!update.callback_query) {
    return json(
      { ok: true },
      headers
    );
  }

  const cq =
    update.callback_query;

  const data =
    String(
      cq.data || ""
    );

  const chatId =
    cq.message?.chat?.id ||
    cq.from.id;

  if (data === "join_start") {
    const master =
      await getMasterByTelegramId(
        env,
        cq.from.id
      );

    if (
      master &&
      master.status === "active"
    ) {
      await answerJobsCallback(
        env,
        cq.id,
        "✅ Ви вже зареєстровані"
      );

      await sendHome(
        env,
        chatId,
        master
      );

      return json(
        { ok: true },
        headers
      );
    }

    if (master) {
      await answerJobsCallback(
        env,
        cq.id,
        master.status === "blocked"
          ? "🚫 Ваш профіль заблоковано"
          : "⚪ Ваш профіль неактивний",
        true
      );

      return json(
        { ok: true },
        headers
      );
    }

    await answerJobsCallback(
      env,
      cq.id,
      "📝 Починаємо анкету"
    );

    return handleJoinStart(
      env,
      headers,
      chatId,
      cq.from
    );
  }

  if (data === "jobs_home") {
    const access =
      await ensureActiveMaster(
        env,
        cq.from.id
      );

    if (!access.active) {
      await answerJobsCallback(
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

    await answerJobsCallback(
      env,
      cq.id,
      ""
    );

    await sendHome(
      env,
      chatId,
      access.master
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (data === "jobs_list") {
    const access =
      await ensureActiveMaster(
        env,
        cq.from.id
      );

    if (!access.active) {
      await answerJobsCallback(
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

    await answerJobsCallback(
      env,
      cq.id,
      ""
    );

    await showAvailableJobs(
      env,
      chatId
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (
    data.startsWith(
      "job_open:"
    )
  ) {
    const access =
      await ensureActiveMaster(
        env,
        cq.from.id
      );

    if (!access.active) {
      await answerJobsCallback(
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

    await answerJobsCallback(
      env,
      cq.id,
      ""
    );

    await showJobCard(
      env,
      chatId,
      data.slice(9)
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (
    data ===
    "submit_request"
  ) {
    const access =
      await ensureActiveMaster(
        env,
        cq.from.id
      );

    if (!access.active) {
      await answerJobsCallback(
        env,
        cq.id,
        "❌ Доступ до передачі заявок відсутній",
        true
      );

      return json(
        { ok: true },
        headers
      );
    }

    const referralLink =
      await getMasterReferralLink(
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

      return json(
        { ok: true },
        headers
      );
    }

    await answerJobsCallback(
      env,
      cq.id,
      ""
    );

    await sendToMaster(
      env,
      chatId,
      [
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
      ].join("\n"),
      [
        [
          {
            text:
              "➕ Заповнити заявку",
            url:
              referralLink,
          },
        ],
        [
          {
            text:
              "🏠 Головна",
            callback_data:
              "jobs_home",
          },
        ],
      ]
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (
    data.startsWith("take:")
  ) {
    return handleTakeJob(
      env,
      headers,
      data.slice(5),
      cq
    );
  }

  if (
    data.startsWith(
      "outcome:"
    )
  ) {
    const [
      ,
      requestCode,
      outcome,
    ] =
      data.split(":");

    return handleMasterOutcome(
      env,
      headers,
      requestCode,
      outcome,
      cq
    );
  }

  if (
    data.startsWith(
      "not_agreed_reason:"
    )
  ) {
    const [
      ,
      requestCode,
      reason,
    ] =
      data.split(":");

    return handleNotAgreedReason(
      env,
      headers,
      requestCode,
      reason,
      cq
    );
  }

  if (
    data.startsWith(
      "app_approve:"
    )
  ) {
    return handleApplicationReview(
      env,
      headers,
      Number(
        data.slice(12)
      ),
      "approve",
      cq
    );
  }

  if (
    data.startsWith(
      "app_reject:"
    )
  ) {
    return handleApplicationReview(
      env,
      headers,
      Number(
        data.slice(11)
      ),
      "reject",
      cq
    );
  }

  if (
    data ===
    "get_group_invite"
  ) {
    await answerJobsCallback(
      env,
      cq.id,
      "ℹ️ Група більше не використовується. Заявки доступні прямо в боті.",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  await answerJobsCallback(
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
 * Взяти заявку
 * ========================================================= */

async function handleTakeJob(
  env,
  headers,
  requestCode,
  cq
) {
  const telegramId =
    cq.from.id;

  const master =
    await getMasterByTelegramId(
      env,
      telegramId
    );

  if (
    !master ||
    master.status !== "active"
  ) {
    await answerJobsCallback(
      env,
      cq.id,
      master?.status === "blocked"
        ? "🚫 Ваш профіль заблоковано"
        : "❌ Немає доступу",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const req =
    await env.DB.prepare(`
      SELECT *
      FROM requests
      WHERE request_code = ?
        AND transferred_to_jobs = 1
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

    return json(
      { ok: true },
      headers
    );
  }

  const masterName =
    master.username
      ? `@${master.username}`
      : (
          master.first_name ||
          cq.from.first_name ||
          `ID ${telegramId}`
        );

  let assigned;

  try {
    assigned =
      await env.DB.prepare(`
        UPDATE requests
        SET
          assigned_master_id = ?,
          assigned_master_name = ?,
          assigned_at =
            CURRENT_TIMESTAMP,
          updated_at =
            CURRENT_TIMESTAMP
        WHERE id = ?
          AND transferred_to_jobs = 1
          AND assigned_master_id IS NULL
          AND status NOT IN (
            'cancelled',
            'installation',
            'completed'
          )
      `)
        .bind(
          telegramId,
          masterName,
          req.id
        )
        .run();
  } catch (err) {
    console.error(
      "Take job failed:",
      err
    );

    await answerJobsCallback(
      env,
      cq.id,
      "❌ Помилка збереження",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (!assigned.meta?.changes) {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Цю заявку вже взяв інший майстер",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  try {
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
        String(master.id)
      )
      .run();
  } catch (err) {
    console.error(
      "Save master_took_job event failed:",
      err
    );
  }

  const contactsText = [
    `✅ ВИ ВЗЯЛИ ЗАЯВКУ ${req.request_code}`,
    "",
    `👤 Клієнт: ${
      req.name ||
      "—"
    }`,
    `📞 Телефон: ${
      req.phone ||
      "—"
    }`,
    `🔧 Роботи: ${
      req.type_label ||
      req.type ||
      "—"
    }`,
    `📍 Об'єкт: ${
      req.location ||
      "—"
    }`,
    req.project
      ? `📐 Дизайн-проєкт: ${req.project}`
      : null,
    req.timing
      ? `🗓 Початок: ${req.timing}`
      : null,
    req.notes
      ? `📝 Опис: ${req.notes}`
      : null,
    "",
    "📞 Зв'яжіться із замовником.",
    "",
    "Після розмови позначте результат:",
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

  try {
    await sendTelegram(
      env,
      [
        "🔔 ЗАЯВКУ ВЗЯТО",
        `🆔 ${req.request_code}`,
        `🙋 Майстер: ${masterName}`,
        `👤 Клієнт: ${
          req.name ||
          "—"
        }`,
        `📞 ${
          req.phone ||
          "—"
        }`,
      ].join("\n")
    );
  } catch (err) {
    console.error(
      "Admin notification failed:",
      err
    );
  }

  await answerJobsCallback(
    env,
    cq.id,
    "✅ Заявка ваша"
  );

  return json(
    { ok: true },
    headers
  );
}

/* =========================================================
 * Результат контакту
 *
 * Погоджена логіка:
 * 1. Домовились -> заявка переходить у installation.
 * 2. Не домовились -> спочатку обираємо нейтральну причину.
 * 3. Після вибору причини заявка звільняється і знову
 *    стає доступною іншим майстрам.
 * ========================================================= */

async function handleMasterOutcome(
  env,
  headers,
  requestCode,
  outcome,
  cq
) {
  const telegramId =
    cq.from.id;

  const master =
    await getMasterByTelegramId(
      env,
      telegramId
    );

  if (
    !master ||
    master.status !== "active"
  ) {
    await answerJobsCallback(
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

  const validOutcomes = [
    "agreed",
    "not_agreed",
  ];

  if (
    !validOutcomes.includes(
      outcome
    )
  ) {
    await answerJobsCallback(
      env,
      cq.id,
      "ℹ️ Ця кнопка застаріла. Відкрийте актуальну заявку.",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const req =
    await env.DB.prepare(`
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

    return json(
      { ok: true },
      headers
    );
  }

  if (
    String(
      req.assigned_master_id ||
      ""
    ) !==
    String(telegramId)
  ) {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Ця заявка більше не закріплена за вами",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (
    [
      "installation",
      "completed",
      "cancelled",
    ].includes(req.status)
  ) {
    await answerJobsCallback(
      env,
      cq.id,
      "ℹ️ Результат цієї заявки вже зафіксовано",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const masterName =
    master.username
      ? `@${master.username}`
      : (
          master.first_name ||
          cq.from.first_name ||
          `ID ${telegramId}`
        );

  /* =======================================================
   * ДОМОВИЛИСЬ
   * ===================================================== */

  if (
    outcome === "agreed"
  ) {
    let updated;

    try {
      updated =
        await env.DB.prepare(`
          UPDATE requests
          SET
            status = 'installation',
            updated_at =
              CURRENT_TIMESTAMP
          WHERE id = ?
            AND assigned_master_id = ?
            AND status NOT IN (
              'installation',
              'completed',
              'cancelled'
            )
        `)
          .bind(
            req.id,
            telegramId
          )
          .run();
    } catch (err) {
      console.error(
        "Agree job failed:",
        err
      );

      await answerJobsCallback(
        env,
        cq.id,
        "❌ Не вдалося зберегти результат",
        true
      );

      return json(
        { ok: true },
        headers
      );
    }

    if (!updated.meta?.changes) {
      await answerJobsCallback(
        env,
        cq.id,
        "ℹ️ Результат уже зафіксовано",
        true
      );

      return json(
        { ok: true },
        headers
      );
    }

    try {
      await env.DB.prepare(`
        INSERT INTO request_outcomes (
          request_id,
          master_id,
          outcome
        )
        VALUES (?, ?, 'agreed')
      `)
        .bind(
          req.id,
          telegramId
        )
        .run();
    } catch (err) {
      console.error(
        "Save agreed outcome failed:",
        err
      );
    }

    try {
      await env.DB.prepare(`
        UPDATE masters
        SET
          good_deals_count =
            COALESCE(
              good_deals_count,
              0
            ) + 1
        WHERE telegram_id = ?
          AND status = 'active'
      `)
        .bind(telegramId)
        .run();
    } catch (err) {
      console.error(
        "Increment good_deals_count failed:",
        err
      );
    }

    try {
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
          'master_agreed',
          ?,
          'master',
          ?
        )
      `)
        .bind(
          req.object_id || null,
          req.id,
          `${masterName}: домовились із клієнтом`,
          String(master.id)
        )
        .run();
    } catch (err) {
      console.error(
        "Save master_agreed event failed:",
        err
      );
    }

    await answerJobsCallback(
      env,
      cq.id,
      "✅ Домовленість зафіксовано"
    );

    await sendToMaster(
      env,
      telegramId,
      [
        "✅ ДОМОВИЛИСЬ",
        "",
        `🆔 ${req.request_code}`,
        "",
        "Співпрацю із замовником підтверджено.",
        "",
        "Заявка більше не показується іншим майстрам.",
        "",
        "Успіхів у роботі!",
      ].join("\n"),
      [
        [
          {
            text:
              "📋 Доступні заявки",
            callback_data:
              "jobs_list",
          },
        ],
        [
          {
            text:
              "🏠 Головна",
            callback_data:
              "jobs_home",
          },
        ],
      ]
    );

    try {
      await sendTelegram(
        env,
        [
          "ℹ️ SA-MASTER Jobs",
          "",
          `🆔 ${req.request_code}`,
          `🙋 ${masterName}`,
          "📊 Домовились із клієнтом",
        ].join("\n")
      );
    } catch (err) {
      console.error(
        "Admin agreed notification failed:",
        err
      );
    }

    return json(
      { ok: true },
      headers
    );
  }

  /* =======================================================
   * НЕ ДОМОВИЛИСЬ
   *
   * На цьому кроці заявку ще НЕ звільняємо.
   * Спочатку майстер має вибрати причину.
   * ===================================================== */

  await answerJobsCallback(
    env,
    cq.id,
    ""
  );

  await sendToMaster(
    env,
    telegramId,
    [
      "❌ НЕ ДОМОВИЛИСЬ",
      "",
      `🆔 ${req.request_code}`,
      "",
      "Оберіть основну причину.",
      "",
      "Це допоможе зберігати історію заявки без суб'єктивних оцінок клієнта.",
    ].join("\n"),
    buildMasterNotAgreedReasonButtons(
      req.request_code
    )
  );

  return json(
    { ok: true },
    headers
  );
}

/* =========================================================
 * Причина, чому не домовились
 * ========================================================= */

async function handleNotAgreedReason(
  env,
  headers,
  requestCode,
  reason,
  cq
) {
  const telegramId =
    cq.from.id;

  const master =
    await getMasterByTelegramId(
      env,
      telegramId
    );

  if (
    !master ||
    master.status !== "active"
  ) {
    await answerJobsCallback(
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

  const reasonLabels = {
    no_answer:
      "Не вдалося зв'язатися",

    price:
      "Не домовились по вартості",

    timing:
      "Не підійшли терміни",

    scope:
      "Не підійшов обсяг / тип робіт",

    other:
      "Інша причина",
  };

  if (!reasonLabels[reason]) {
    await answerJobsCallback(
      env,
      cq.id,
      "❓ Невідома причина",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const req =
    await env.DB.prepare(`
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

    return json(
      { ok: true },
      headers
    );
  }

  if (
    String(
      req.assigned_master_id ||
      ""
    ) !==
    String(telegramId)
  ) {
    await answerJobsCallback(
      env,
      cq.id,
      "❌ Ця заявка більше не закріплена за вами",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (
    [
      "installation",
      "completed",
      "cancelled",
    ].includes(req.status)
  ) {
    await answerJobsCallback(
      env,
      cq.id,
      "ℹ️ Результат цієї заявки вже зафіксовано",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  const masterName =
    master.username
      ? `@${master.username}`
      : (
          master.first_name ||
          cq.from.first_name ||
          `ID ${telegramId}`
        );

  /*
   * Атомарно звільняємо заявку.
   *
   * transferred_to_jobs залишається = 1,
   * тому вона автоматично повертається
   * у список доступних заявок.
   */

  let released;

  try {
    released =
      await env.DB.prepare(`
        UPDATE requests
        SET
          assigned_master_id = NULL,
          assigned_master_name = NULL,
          assigned_at = NULL,
          updated_at =
            CURRENT_TIMESTAMP
        WHERE id = ?
          AND assigned_master_id = ?
          AND status NOT IN (
            'installation',
            'completed',
            'cancelled'
          )
      `)
        .bind(
          req.id,
          telegramId
        )
        .run();
  } catch (err) {
    console.error(
      "Release not-agreed job failed:",
      err
    );

    await answerJobsCallback(
      env,
      cq.id,
      "❌ Не вдалося зберегти результат",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  if (!released.meta?.changes) {
    await answerJobsCallback(
      env,
      cq.id,
      "ℹ️ Результат уже зафіксовано",
      true
    );

    return json(
      { ok: true },
      headers
    );
  }

  /*
   * Зберігаємо нейтральну причину.
   */

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
        `not_agreed_${reason}`
      )
      .run();
  } catch (err) {
    console.error(
      "Save not-agreed outcome failed:",
      err
    );
  }

  try {
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
        'master_not_agreed',
        ?,
        'master',
        ?
      )
    `)
      .bind(
        req.object_id || null,
        req.id,
        `${masterName}: не домовились — ${reasonLabels[reason]}`,
        String(master.id)
      )
      .run();
  } catch (err) {
    console.error(
      "Save master_not_agreed event failed:",
      err
    );
  }

  await answerJobsCallback(
    env,
    cq.id,
    "✅ Причину збережено"
  );

  await sendToMaster(
    env,
    telegramId,
    [
      "↩️ ЗАЯВКУ ПОВЕРНУТО",
      "",
      `🆔 ${req.request_code}`,
      "",
      `📝 Причина: ${reasonLabels[reason]}`,
      "",
      "Заявка більше не закріплена за вами.",
      "",
      "Вона знову доступна іншим майстрам.",
    ].join("\n"),
    [
      [
        {
          text:
            "📋 Доступні заявки",
          callback_data:
            "jobs_list",
        },
      ],
      [
        {
          text:
            "🏠 Головна",
          callback_data:
            "jobs_home",
        },
      ],
    ]
  );

  try {
    await sendTelegram(
      env,
      [
        "ℹ️ SA-MASTER Jobs",
        "",
        `🆔 ${req.request_code}`,
        `🙋 ${masterName}`,
        "📊 Не домовились",
        `📝 Причина: ${reasonLabels[reason]}`,
        "↩️ Заявка знову доступна майстрам",
      ].join("\n")
    );
  } catch (err) {
    console.error(
      "Admin not-agreed notification failed:",
      err
    );
  }

  return json(
    { ok: true },
    headers
  );
}
