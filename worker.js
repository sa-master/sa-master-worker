const STATUS_LABELS = {
  new: "Нова",
  processing: "Опрацювання",
  estimate: "Прорахунок",
  approved: "Погоджено",
  scheduled: "Заплановано",
  installation: "Монтаж",
  completed: "Завершено",
  service: "Сервіс",
  cancelled: "Відмова / Неактуально"
};

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {

      // =========================================================
      // GET /
      // =========================================================

      if (request.method === "GET" && path === "/") {
        return json({
          ok: true,
          BOT_TOKEN: !!env.BOT_TOKEN,
          CHAT_ID: !!env.CHAT_ID,
          DB: !!env.DB,
          bindings: Object.keys(env),
          statuses: STATUS_LABELS
        }, cors);
      }


      // =========================================================
      // GET /requests
      // =========================================================

      if (request.method === "GET" && path === "/requests") {
        const result = await env.DB.prepare(`
          SELECT
            r.*,
            c.id AS client_id,
            c.name AS client_name,
            c.phone AS client_phone
          FROM requests r
          LEFT JOIN clients c ON c.id = r.client_id
          ORDER BY r.id DESC
        `).all();

        const requests = (result.results || []).map(r => ({
          ...r,
          status_label:
            STATUS_LABELS[r.status] ||
            r.status ||
            "Невідомо"
        }));

        return json({
          ok: true,
          requests
        }, cors);
      }


      // =========================================================
      // POST /request/:requestCode/client
      // =========================================================

      if (
        request.method === "POST" &&
        path.startsWith("/request/") &&
        path.endsWith("/client")
      ) {
        const requestCode = decodeURIComponent(
          path
            .replace("/request/", "")
            .replace("/client", "")
            .replace(/\/+$/, "")
        );

        const requestResult = await env.DB.prepare(`
          SELECT *
          FROM requests
          WHERE request_code = ?
          LIMIT 1
        `).bind(requestCode).all();

        if (
          !requestResult.results ||
          !requestResult.results.length
        ) {
          return json({
            ok: false,
            error: "Заявку не знайдено"
          }, cors, 404);
        }

        const req = requestResult.results[0];

        if (req.client_id) {
          const clientResult = await env.DB.prepare(`
            SELECT *
            FROM clients
            WHERE id = ?
            LIMIT 1
          `).bind(req.client_id).all();

          return json({
            ok: true,
            created: false,
            existing: true,
            request: req,
            client: clientResult.results?.[0] || null
          }, cors);
        }

        const normalizedPhone = normalizePhone(req.phone);

        let clientResult = await env.DB.prepare(`
          SELECT *
          FROM clients
          WHERE phone = ?
          LIMIT 1
        `).bind(normalizedPhone).all();

        let client;
        let created = false;
        let existing = false;

        if (
          clientResult.results &&
          clientResult.results.length
        ) {
          client = clientResult.results[0];
          existing = true;
        } else {
          const insertClient = await env.DB.prepare(`
            INSERT INTO clients (
              name,
              phone
            )
            VALUES (?, ?)
          `).bind(
            req.name,
            normalizedPhone
          ).run();

          if (!insertClient.meta?.last_row_id) {
            return json({
              ok: false,
              error: "Не вдалося створити клієнта"
            }, cors, 500);
          }

          const newClientId =
            insertClient.meta.last_row_id;

          const newClientResult = await env.DB.prepare(`
            SELECT *
            FROM clients
            WHERE id = ?
            LIMIT 1
          `).bind(newClientId).all();

          client =
            newClientResult.results?.[0] || null;

          created = true;
        }

        await env.DB.prepare(`
          UPDATE requests
          SET client_id = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          client.id,
          req.id
        ).run();

        return json({
          ok: true,
          created,
          existing,
          request: {
            ...req,
            client_id: client.id
          },
          client
        }, cors);
      }


      // =========================================================
      // POST /request/:requestCode/status
      // Зміна статусу + запис події
      // =========================================================

      if (
        request.method === "POST" &&
        path.startsWith("/request/") &&
        path.endsWith("/status")
      ) {
        const requestCode = decodeURIComponent(
          path
            .replace("/request/", "")
            .replace("/status", "")
            .replace(/\/+$/, "")
        );

        let body;

        try {
          body = await request.json();
        } catch {
          return json({
            ok: false,
            error: "Некоректний JSON"
          }, cors, 400);
        }

        const newStatus =
          String(body.status || "").trim();

        if (!STATUS_LABELS[newStatus]) {
          return json({
            ok: false,
            error: "Невідомий статус",
            allowed_statuses: STATUS_LABELS
          }, cors, 400);
        }

        const requestResult = await env.DB.prepare(`
          SELECT id, request_code, status
          FROM requests
          WHERE request_code = ?
          LIMIT 1
        `).bind(requestCode).all();

        if (
          !requestResult.results ||
          !requestResult.results.length
        ) {
          return json({
            ok: false,
            error: "Заявку не знайдено"
          }, cors, 404);
        }

        const currentRequest =
          requestResult.results[0];

        const oldStatus =
          currentRequest.status;

        const updateResult = await env.DB.prepare(`
          UPDATE requests
          SET status = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          newStatus,
          currentRequest.id
        ).run();

        if (
          updateResult.meta &&
          updateResult.meta.changes !== 1
        ) {
          return json({
            ok: false,
            error: "Статус заявки не було змінено"
          }, cors, 500);
        }

        const oldStatusLabel =
          STATUS_LABELS[oldStatus] ||
          oldStatus ||
          "Невідомо";

        const newStatusLabel =
          STATUS_LABELS[newStatus];

        const eventContent =
          `${oldStatusLabel} → ${newStatusLabel}`;

        const eventResult = await env.DB.prepare(`
          INSERT INTO events (
            object_id,
            request_id,
            event_type,
            content,
            author_type
          )
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          null,
          currentRequest.id,
          "status_changed",
          eventContent,
          "system"
        ).run();

        if (
          eventResult.meta &&
          eventResult.meta.changes !== 1
        ) {
          return json({
            ok: false,
            error:
              "Статус змінено, але подію не вдалося записати"
          }, cors, 500);
        }

        return json({
          ok: true,
          request: {
            id: currentRequest.id,
            request_code:
              currentRequest.request_code,

            old_status: oldStatus,
            old_status_label: oldStatusLabel,

            status: newStatus,
            status_label: newStatusLabel
          },

          event: {
            event_type: "status_changed",
            content: eventContent,
            author_type: "system"
          }
        }, cors);
      }


      // =========================================================
      // GET /request/:requestCode/events
      // =========================================================

      if (
        request.method === "GET" &&
        path.startsWith("/request/") &&
        path.endsWith("/events")
      ) {
        const requestCode = decodeURIComponent(
          path
            .replace("/request/", "")
            .replace("/events", "")
            .replace(/\/+$/, "")
        );

        const requestResult = await env.DB.prepare(`
          SELECT
            id,
            request_code,
            status
          FROM requests
          WHERE request_code = ?
          LIMIT 1
        `).bind(requestCode).all();

        if (
          !requestResult.results ||
          !requestResult.results.length
        ) {
          return json({
            ok: false,
            error: "Заявку не знайдено"
          }, cors, 404);
        }

        const currentRequest =
          requestResult.results[0];

        const eventsResult = await env.DB.prepare(`
          SELECT
            id,
            request_id,
            object_id,
            event_type,
            content,
            author_type,
            author_id,
            created_at
          FROM events
          WHERE request_id = ?
          ORDER BY id ASC
        `).bind(currentRequest.id).all();

        const events =
          eventsResult.results || [];

        return json({
          ok: true,
          request: {
            id: currentRequest.id,
            request_code:
              currentRequest.request_code,
            status: currentRequest.status,
            status_label:
              STATUS_LABELS[currentRequest.status] ||
              currentRequest.status ||
              "Невідомо"
          },
          events
        }, cors);
      }


      // =========================================================
      // GET /request/:requestCode
      // =========================================================

      if (
        request.method === "GET" &&
        path.startsWith("/request/")
      ) {
        const requestCode = decodeURIComponent(
          path
            .replace("/request/", "")
            .replace(/\/+$/, "")
        );

        const result = await env.DB.prepare(`
          SELECT
            r.*,
            c.name AS client_name,
            c.phone AS client_phone,
            o.object_code,
            o.name AS object_name,
            o.address AS object_address,
            o.status AS object_status
          FROM requests r
          LEFT JOIN clients c
            ON c.id = r.client_id
          LEFT JOIN objects o
            ON o.id = r.object_id
          WHERE r.request_code = ?
          LIMIT 1
        `).bind(requestCode).all();

        if (
          !result.results ||
          !result.results.length
        ) {
          return json({
            ok: false,
            error: "Заявку не знайдено"
          }, cors, 404);
        }

        const requestData =
          result.results[0];

        return json({
          ok: true,
          request: {
            ...requestData,

            status_label:
              STATUS_LABELS[requestData.status] ||
              requestData.status ||
              "Невідомо",

            object_status_label:
              STATUS_LABELS[requestData.object_status] ||
              requestData.object_status ||
              null
          }
        }, cors);
      }


      // =========================================================
      // GET /object/:objectCode
      // Повна картка об'єкта
      // =========================================================

      if (
        request.method === "GET" &&
        path.startsWith("/object/")
      ) {
        const objectCode = decodeURIComponent(
          path
            .replace("/object/", "")
            .replace(/\/+$/, "")
        );

        // ---------------------------------------------------------
        // Об'єкт + клієнт
        // ---------------------------------------------------------

        const objectResult = await env.DB.prepare(`
          SELECT
            o.*,
            c.id AS client_id,
            c.name AS client_name,
            c.phone AS client_phone
          FROM objects o
          LEFT JOIN clients c
            ON c.id = o.client_id
          WHERE o.object_code = ?
          LIMIT 1
        `).bind(objectCode).all();

        if (
          !objectResult.results ||
          !objectResult.results.length
        ) {
          return json({
            ok: false,
            error: "Об'єкт не знайдено"
          }, cors, 404);
        }

        const objectData =
          objectResult.results[0];

        // ---------------------------------------------------------
        // Усі заявки цього об'єкта
        // ---------------------------------------------------------

        const requestsResult = await env.DB.prepare(`
          SELECT
            r.id,
            r.request_code,
            r.type,
            r.type_label,
            r.name,
            r.phone,
            r.location,
            r.timing,
            r.project,
            r.consultation_date,
            r.source,
            r.status,
            r.created_at,
            r.updated_at
          FROM requests r
          WHERE r.object_id = ?
          ORDER BY r.id DESC
        `).bind(objectData.id).all();

        const requests =
          (requestsResult.results || []).map(r => ({
            ...r,
            status_label:
              STATUS_LABELS[r.status] ||
              r.status ||
              "Невідомо"
          }));

        // ---------------------------------------------------------
        // Події об'єкта
        // ---------------------------------------------------------

        const eventsResult = await env.DB.prepare(`
          SELECT
            id,
            request_id,
            object_id,
            event_type,
            content,
            author_type,
            author_id,
            created_at
          FROM events
          WHERE object_id = ?
          ORDER BY id ASC
        `).bind(objectData.id).all();

        const events =
          eventsResult.results || [];

        return json({
          ok: true,

          object: {
            ...objectData,

            status_label:
              STATUS_LABELS[objectData.status] ||
              objectData.status ||
              "Невідомо"
          },

          client: objectData.client_id
            ? {
                id: objectData.client_id,
                name: objectData.client_name,
                phone: objectData.client_phone
              }
            : null,

          requests,

          events
        }, cors);
      }


      // =========================================================
      // POST /
      // Створення нової заявки
      // =========================================================

      if (
        request.method === "POST" &&
        path === "/"
      ) {
        let body;

        try {
          body = await request.json();
        } catch {
          return json({
            ok: false,
            error: "Некоректний JSON"
          }, cors, 400);
        }

        const name =
          String(body.name || "").trim();

        const phone =
          String(body.phone || "").trim();

        const type =
          String(body.type || "").trim();

        const typeLabel =
          String(body.typeLabel || "").trim();

        const location =
          String(body.location || "").trim();

        const timing =
          String(body.timing || "").trim();

        const project =
          String(body.project || "").trim();

        const consultationDate =
          String(body.consultationDate || "").trim();

        const source =
          String(
            body.source ||
            "SA-MASTER.PRO"
          ).trim();

        if (!name || !phone || !type) {
          return json({
            ok: false,
            error:
              "Необхідні ім'я, телефон та тип заявки"
          }, cors, 400);
        }

        // ---------------------------------------------------------
        // Створюємо код заявки
        // ---------------------------------------------------------

        const countResult = await env.DB.prepare(`
          SELECT COUNT(*) AS count
          FROM requests
          WHERE request_code LIKE 'SM-R-2026-%'
        `).all();

        const count =
          Number(
            countResult.results?.[0]?.count || 0
          ) + 1;

        const requestCode =
          `SM-R-2026-${String(count).padStart(3, "0")}`;

        // ---------------------------------------------------------
        // Створюємо заявку
        // ---------------------------------------------------------

        const insertResult = await env.DB.prepare(`
          INSERT INTO requests (
            request_code,
            type,
            type_label,
            name,
            phone,
            location,
            timing,
            project,
            consultation_date,
            source,
            status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          requestCode,
          type,
          typeLabel,
          name,
          phone,
          location || null,
          timing || null,
          project || null,
          consultationDate || null,
          source,
          "new"
        ).run();

        if (!insertResult.meta?.last_row_id) {
          return json({
            ok: false,
            error: "Не вдалося створити заявку"
          }, cors, 500);
        }

        const requestId =
          insertResult.meta.last_row_id;

        // ---------------------------------------------------------
        // Автоматично знаходимо / створюємо клієнта
        // ---------------------------------------------------------

        const normalizedPhone =
          normalizePhone(phone);

        let clientResult = await env.DB.prepare(`
          SELECT *
          FROM clients
          WHERE phone = ?
          LIMIT 1
        `).bind(normalizedPhone).all();

        let client;

        if (
          clientResult.results &&
          clientResult.results.length
        ) {
          client =
            clientResult.results[0];
        } else {
          const clientInsert = await env.DB.prepare(`
            INSERT INTO clients (
              name,
              phone
            )
            VALUES (?, ?)
          `).bind(
            name,
            normalizedPhone
          ).run();

          if (clientInsert.meta?.last_row_id) {
            const createdClient =
              await env.DB.prepare(`
                SELECT *
                FROM clients
                WHERE id = ?
                LIMIT 1
              `).bind(
                clientInsert.meta.last_row_id
              ).all();

            client =
              createdClient.results?.[0] ||
              null;
          }
        }

        // ---------------------------------------------------------
        // Прив'язуємо клієнта до заявки
        // ---------------------------------------------------------

        if (client) {
          await env.DB.prepare(`
            UPDATE requests
            SET client_id = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(
            client.id,
            requestId
          ).run();
        }

        // ---------------------------------------------------------
        // Перша подія заявки
        // ---------------------------------------------------------

        await env.DB.prepare(`
          INSERT INTO events (
            object_id,
            request_id,
            event_type,
            content,
            author_type
          )
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          null,
          requestId,
          "request_created",
          "Створено заявку",
          "system"
        ).run();

        // ---------------------------------------------------------
        // Дані для Telegram
        // ---------------------------------------------------------

        const telegramText = [
          "🏠 НОВА ЗАЯВКА",
          `🆔 ID: ${requestCode}`,
          `👤 Ім'я: ${name}`,
          `📞 Телефон: ${phone}`,
          `🔧 Тип: ${typeLabel || type}`,
          `📍 Об'єкт: ${location || "—"}`,
          `📐 Дизайн-проєкт: ${project || "—"}`,
          `🗓 Початок: ${timing || "—"}`,
          `📅 Консультація: ${consultationDate || "—"}`,
          `🔗 Джерело: ${source}`,
          `📊 Статус: ${STATUS_LABELS.new}`,
          `🕐 Час: ${new Date().toLocaleString(
            "uk-UA",
            {
              timeZone: "Europe/Kyiv"
            }
          )}`
        ].join("\n");

        // ---------------------------------------------------------
        // Telegram
        // ---------------------------------------------------------

        if (env.BOT_TOKEN && env.CHAT_ID) {
          try {
            await fetch(
              `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
              {
                method: "POST",
                headers: {
                  "Content-Type":
                    "application/json"
                },
                body: JSON.stringify({
                  chat_id: env.CHAT_ID,
                  text: telegramText
                })
              }
            );
          } catch (telegramError) {
            console.error(
              "Telegram error:",
              telegramError
            );
          }
        }

        return json({
          ok: true,
          request: {
            id: requestId,
            request_code: requestCode,
            client_id: client?.id || null,
            status: "new",
            status_label:
              STATUS_LABELS.new
          }
        }, cors);
      }


      // =========================================================
      // 404
      // =========================================================

      return json({
        ok: false,
        error: "Not found"
      }, cors, 404);

    } catch (error) {
      console.error(error);

      return json({
        ok: false,
        error:
          error?.message ||
          String(error)
      }, cors, 500);
    }
  }
};


// =============================================================
// Helpers
// =============================================================

function json(data, cors, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...cors,
        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}


function normalizePhone(phone) {
  return String(phone || "")
    .replace(/[^\d+]/g, "");
}
