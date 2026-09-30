import { json } from "../lib/json.js";
import {
  sendToMaster,
  answerJobsCallback,
} from "../lib/telegram-jobs.js";
import { sendTelegram } from "../lib/telegram.js";
import { buildMasterOutcomeButtons } from "../lib/telegram-buttons.js";
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
 * ТЕПЕР:
 * заявка НЕ надсилається в Telegram-групу.
 * Вона просто стає доступною майстрам у боті.
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

/*
 * Тимчасова сумісність зі старим requests.js.
 *
 * Якщо requests.js ще імпортує:
 *
 * publishRequestToJobsGroup
 *
 * усе продовжить працювати.
 */

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
          'done'
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
      "done",
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

  /* -------------------------------------------------------
   * Повідомлення
   * ----------------------------------------------------- */

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

    /* /start */

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

    /* /join */

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

    /* /jobs */

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

    /*
     * Якщо майстер ще проходить анкету,
     * передаємо повідомлення в join.js.
     */

    return handleJoinMessage(
      env,
      headers,
      chatId,
      fromUser,
      text
    );
  }

  /* -------------------------------------------------------
   * Callback
   * ----------------------------------------------------- */

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

  /* -------------------------------------------------------
   * Старий join_start
   * ----------------------------------------------------- */

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

  /* -------------------------------------------------------
   * Головна
   * ----------------------------------------------------- */

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

  /* -------------------------------------------------------
   * Список заявок
   * ----------------------------------------------------- */

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

  /* -------------------------------------------------------
   * Відкрити заявку
   * ----------------------------------------------------- */

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

  /* -------------------------------------------------------
   * Передати заявку
   * ----------------------------------------------------- */

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

  /* -------------------------------------------------------
   * Взяти заявку
   * ----------------------------------------------------- */

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

  /* -------------------------------------------------------
   * Результат
   * ----------------------------------------------------- */

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

  /* -------------------------------------------------------
   * Анкети
   * ----------------------------------------------------- */

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

  /*
   * Старі кнопки групи.
   * Не ламаємо старі повідомлення.
   */

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
 *
 * Перший майстер отримує її.
 * Контакти відкриваються ТІЛЬКИ після успішного UPDATE.
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
            'done'
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

  /*
   * КРИТИЧНО:
   *
   * якщо changes = 0 —
   * заявку вже хтось забрав.
   *
   * Контакти НЕ показуємо.
   */

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

  /* Подія */

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

  /*
   * ТІЛЬКИ ТЕПЕР
   * показуємо ім'я + телефон.
   */

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

  /* Повідомлення адміну */

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
    "working",
    "no_answer",
    "weird_client",
    "too_expensive",
  ];

  if (
    !validOutcomes.includes(
      outcome
    )
  ) {
    await answerJobsCallback(
      env,
      cq.id,
      "❓ Невідомий результат",
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

  const masterName =
    master.username
      ? `@${master.username}`
      : (
          master.first_name ||
          cq.from.first_name ||
          `ID ${telegramId}`
        );

  /*
   * Зберігаємо результат.
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
        outcome
      )
      .run();
  } catch (err) {
    console.error(
      "Save outcome failed:",
      err
    );
  }

  /* =======================================================
   * WORKING
   * ===================================================== */

  if (
    outcome === "working"
  ) {
    await env.DB.batch([
      env.DB.prepare(`
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
        .bind(telegramId),

      env.DB.prepare(`
        UPDATE requests
        SET
          status = 'installation',
          updated_at =
            CURRENT_TIMESTAMP
        WHERE id = ?
          AND assigned_master_id = ?
      `)
        .bind(
          req.id,
          telegramId
        ),

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
      `)
        .bind(
          req.object_id || null,
          req.id,
          `${masterName} підтвердив роботу`,
          String(master.id)
        ),
    ]);

    await answerJobsCallback(
      env,
      cq.id,
      "✅ Заявка в роботі"
    );

    await sendToMaster(
      env,
      telegramId,
      [
        "✅ ЗАЯВКА В РОБОТІ",
        "",
        `🆔 ${req.request_code}`,
        "",
        "Заявку закріплено за вами.",
        "",
        "Успіхів!",
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
  }

  /* =======================================================
   * NO ANSWER
   * ===================================================== */

  if (
    outcome === "no_answer"
  ) {
    const statements = [
      env.DB.prepare(`
        UPDATE masters
        SET
          no_answer_count =
            COALESCE(
              no_answer_count,
              0
            ) + 1
        WHERE telegram_id = ?
          AND status = 'active'
      `)
        .bind(telegramId),

      env.DB.prepare(`
        UPDATE requests
        SET
          assigned_master_id = NULL,
          assigned_master_name = NULL,
          assigned_at = NULL,
          updated_at =
            CURRENT_TIMESTAMP
        WHERE id = ?
          AND assigned_master_id = ?
      `)
        .bind(
          req.id,
          telegramId
        ),

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
      `)
        .bind(
          req.object_id || null,
          req.id,
          `${masterName}: клієнт не відповідає`,
          String(master.id)
        ),
    ];

    if (req.client_id) {
      statements.push(
        env.DB.prepare(`
          UPDATE clients
          SET
            no_answer_count =
              COALESCE(
                no_answer_count,
                0
              ) + 1
          WHERE id = ?
        `)
          .bind(
            req.client_id
          )
      );
    }

    await env.DB.batch(
      statements
    );

    /*
     * НІЧОГО в групу не надсилаємо.
     *
     * assigned_master_id = NULL,
     * transferred_to_jobs = 1
     *
     * тому заявка автоматично
     * знову з'явиться в боті.
     */

    await answerJobsCallback(
      env,
      cq.id,
      "✅ Заявка знову доступна"
    );

    await sendToMaster(
      env,
      telegramId,
      [
        "📵 КЛІЄНТ НЕ ВІДПОВІДАЄ",
        "",
        `Заявку ${req.request_code} звільнено.`,
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
      ]
    );
  }

  /* =======================================================
   * WEIRD CLIENT
   * ===================================================== */

  if (
    outcome ===
    "weird_client"
  ) {
    const statements = [
      env.DB.prepare(`
        UPDATE masters
        SET
          weird_client_count =
            COALESCE(
              weird_client_count,
              0
            ) + 1
        WHERE telegram_id = ?
          AND status = 'active'
      `)
        .bind(telegramId),

      env.DB.prepare(`
        UPDATE requests
        SET
          status = 'cancelled',
          updated_at =
            CURRENT_TIMESTAMP
        WHERE id = ?
          AND assigned_master_id = ?
      `)
        .bind(
          req.id,
          telegramId
        ),

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
      `)
        .bind(
          req.object_id || null,
          req.id,
          `${masterName}: дивний клієнт`,
          String(master.id)
        ),
    ];

    if (req.client_id) {
      statements.push(
        env.DB.prepare(`
          UPDATE clients
          SET
            weird_count =
              COALESCE(
                weird_count,
                0
              ) + 1
          WHERE id = ?
        `)
          .bind(
            req.client_id
          )
      );
    }

    await env.DB.batch(
      statements
    );

    await answerJobsCallback(
      env,
      cq.id,
      "⚠️ Позначено. Дякую!"
    );

    await sendToMaster(
      env,
      telegramId,
      [
        "⚠️ ЗАЯВКУ ЗАКРИТО",
        "",
        "Дякуємо за сигнал.",
        "",
        "Ця заявка більше не показуватиметься майстрам.",
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
      ]
    );
  }

  /* =======================================================
   * НЕ ПІДХОДИТЬ
   * ===================================================== */

  if (
    outcome ===
    "too_expensive"
  ) {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE requests
        SET
          assigned_master_id = NULL,
          assigned_master_name = NULL,
          assigned_at = NULL,
          updated_at =
            CURRENT_TIMESTAMP
        WHERE id = ?
          AND assigned_master_id = ?
      `)
        .bind(
          req.id,
          telegramId
        ),

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
      `)
        .bind(
          req.object_id || null,
          req.id,
          `${masterName}: заявка не підходить`,
          String(master.id)
        ),
    ]);

    /*
     * Заявка автоматично повертається
     * у список, бо assigned_master_id = NULL.
     */

    await answerJobsCallback(
      env,
      cq.id,
      "✅ Заявка знову доступна"
    );

    await sendToMaster(
      env,
      telegramId,
      [
        "↩️ ЗАЯВКУ ПОВЕРНУТО",
        "",
        `Заявка ${req.request_code} більше не закріплена за вами.`,
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
      ]
    );
  }

  /* =======================================================
   * Повідомлення адміну
   * ===================================================== */

  try {
    const labels = {
      working:
        "підтвердив роботу",

      no_answer:
        "не додзвонився; заявка знову доступна",

      weird_client:
        "позначив клієнта як проблемного",

      too_expensive:
        "відмовився; заявка знову доступна",
    };

    await sendTelegram(
      env,
      [
        "ℹ️ SA-MASTER Jobs",
        "",
        `🆔 ${req.request_code}`,
        `🙋 ${masterName}`,
        `📊 ${labels[outcome]}`,
      ].join("\n")
    );
  } catch (err) {
    console.error(
      "Admin outcome notification failed:",
      err
    );
  }

  return json(
    { ok: true },
    headers
  );
}