SA-MASTER — ОНОВЛЕННЯ requests.js

У поточному src/handlers/requests.js заміни ТІЛЬКИ функцію
export async function handleCreateRequest(...) на версію нижче.
Решту файлу не змінюй.

Підтримка: request_goal, work_scope, object_type, address,
request_details, estimate_type. Старі поля, referral та MASTER_TRANSFER_MODE
залишаються сумісними.

export async function handleCreateRequest(request, env, headers) {
  let body;

  try {
    body = await request.json();
  } catch {
    return error("Некоректний JSON", headers, 400);
  }

  const name = str(body.name, { max: 120, required: true });
  const phone = str(body.phone, { max: 40, required: true });
  const type = str(body.type, { max: 40, required: true });

  if (!name || !phone || !type) {
    return error("Необхідні ім'я, телефон та тип заявки", headers, 400);
  }

  if (!isValidPhone(phone)) {
    return error("Некоректний номер телефону", headers, 400);
  }

  const normalizedPhone = normalizePhone(phone);
  const typeLabel = str(body.typeLabel, { max: 80 }) || type;
  const location = str(body.location, { max: 300 });
  const timing = str(body.timing, { max: 100 });
  const project = str(body.project, { max: 200 });
  const consultation = str(body.consultationDate, { max: 100 });
  const source = str(body.source, { max: 80 }) || "SA-MASTER.PRO";
  const notes = str(body.notes, { max: 500 });
  const referralToken = str(body.ref, { max: 100 });

  const requestGoal = str(body.request_goal, { max: 40 });
  const workScope = str(body.work_scope, { max: 40 });
  const objectType = str(body.object_type, { max: 40 });
  const address = str(body.address, { max: 300 });
  const estimateType = str(body.estimate_type, { max: 40 });

  let requestDetails = null;

  if (
    body.request_details !== undefined &&
    body.request_details !== null &&
    body.request_details !== ""
  ) {
    try {
      const details =
        typeof body.request_details === "string"
          ? JSON.parse(body.request_details)
          : body.request_details;

      if (
        details === null ||
        typeof details !== "object" ||
        Array.isArray(details)
      ) {
        return error("request_details має бути JSON-об'єктом", headers, 400);
      }

      requestDetails = JSON.stringify(details);

      if (requestDetails.length > 30000) {
        return error("Забагато даних у технічній анкеті", headers, 400);
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        return error("Некоректний JSON у request_details", headers, 400);
      }
      throw err;
    }
  }

  let sourceType = "client";
  let sourceMasterId = null;
  let sourceMaster = null;

  if (referralToken) {
    try {
      sourceMaster = await env.DB.prepare(`
        SELECT id, telegram_id, username, first_name, status
        FROM masters
        WHERE referral_token = ?
          AND status = 'active'
        LIMIT 1
      `).bind(referralToken).first();

      if (sourceMaster) {
        sourceType = "master";
        sourceMasterId = sourceMaster.id;
      }
    } catch (err) {
      console.error("Referral lookup failed:", err);
    }
  }

  const estimateToken = crypto.randomUUID().replaceAll("-", "");
  const estimateTokenExpiresAt =
    new Date(Date.now() + ESTIMATE_LINK_TTL_MS).toISOString();

  const uploadToken = crypto.randomUUID().replaceAll("-", "");
  const uploadTokenExpiresAt =
    new Date(Date.now() + UPLOAD_LINK_TTL_MS).toISOString();

  let requestId;
  let requestCode;
  let clientId = null;

  try {
    const seq = await env.DB.prepare(`
      UPDATE sequences
      SET value = value + 1
      WHERE name = ?
      RETURNING value
    `).bind(`request_${CURRENT_YEAR}`).first();

    if (!seq || typeof seq.value !== "number") {
      return error("Не вдалося згенерувати код заявки", headers, 500);
    }

    requestCode =
      `SM-R-${CURRENT_YEAR}-${String(seq.value).padStart(3, "0")}`;

    const existingClient = await env.DB.prepare(`
      SELECT id FROM clients WHERE phone = ? LIMIT 1
    `).bind(normalizedPhone).first();

    if (existingClient) {
      clientId = existingClient.id;
    } else {
      const ins = await env.DB.prepare(`
        INSERT INTO clients (name, phone)
        VALUES (?, ?)
      `).bind(name, normalizedPhone).run();

      clientId = ins.meta?.last_row_id || null;
    }

    const insertResult = await env.DB.prepare(`
      INSERT INTO requests (
        request_code, type, type_label, name, phone,
        location, timing, project, consultation_date,
        source, source_type, source_master_id, status,
        client_id, notes, estimate_token, estimate_token_expires_at,
        upload_token, upload_token_expires_at,
        request_goal, work_scope, object_type, address,
        request_details, estimate_type
      )
      VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, 'new',
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )
    `).bind(
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
      uploadTokenExpiresAt,
      requestGoal || null,
      workScope || null,
      objectType || null,
      address || null,
      requestDetails,
      estimateType || null
    ).run();

    if (!insertResult.meta?.last_row_id) {
      return error("Не вдалося створити заявку", headers, 500);
    }

    requestId = insertResult.meta.last_row_id;

    await env.DB.prepare(`
      INSERT INTO events (
        object_id, request_id, event_type, content, author_type
      )
      VALUES (
        NULL, ?, 'request_created', 'Створено заявку', 'system'
      )
    `).bind(requestId).run();

    if (sourceMasterId) {
      await env.DB.prepare(`
        INSERT INTO events (
          object_id, request_id, event_type, content, author_type, author_id
        )
        VALUES (
          NULL, ?, 'request_referred', 'Заявку передано майстром', 'master', ?
        )
      `).bind(requestId, String(sourceMasterId)).run();
    }
  } catch (err) {
    console.error("Create request failed:", err);

    if (String(err?.message || "").includes("UNIQUE")) {
      return error("Конфлікт даних клієнта. Спробуйте ще раз.", headers, 409);
    }

    return error("Помилка створення заявки", headers, 500);
  }

  const referralLabel =
    sourceMasterId
      ? (
          sourceMaster?.username
            ? `@${sourceMaster.username}`
            : sourceMaster?.first_name || `ID ${sourceMasterId}`
        )
      : null;

  const text = [
    "🏠 НОВА ЗАЯВКА",
    `🆔 ${requestCode}`,
    `👤 Ім'я: ${name}`,
    `📞 Телефон: ${normalizedPhone}`,
    `🔧 Тип: ${typeLabel}`,
    `📍 Об'єкт: ${location || "—"}`,
    address ? `🏠 Адреса: ${address}` : null,
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
    notes ? `📝 Опис: ${notes}` : null,
  ].filter(Boolean).join("\n");

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

  const tg = await sendMessageWithButtons(env, text, buttons);

  if (!tg.ok) {
    console.error("Telegram send failed:", tg.description || tg);
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
