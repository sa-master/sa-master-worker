export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // =========================================================
      // GET /
      // Diagnostics
      // =========================================================

      if (request.method === "GET" && path === "/") {
        return json({
          ok: true,
          BOT_TOKEN: !!env.BOT_TOKEN,
          CHAT_ID: !!env.CHAT_ID,
          DB: !!env.DB,
          bindings: Object.keys(env),
        });
      }

      // =========================================================
      // GET /requests
      // List all requests
      // =========================================================

      if (request.method === "GET" && path === "/requests") {
        if (!env.DB) {
          return json(
            {
              ok: false,
              error: "DB binding missing",
            },
            500
          );
        }

        const result = await env.DB.prepare(`
          SELECT
            id,
            request_code,
            client_id,
            object_id,
            type,
            type_label,
            name,
            phone,
            location,
            timing,
            project,
            consultation_date,
            source,
            status,
            created_at,
            updated_at
          FROM requests
          ORDER BY id DESC
        `).all();

        return json({
          ok: true,
          requests: result.results || [],
        });
      }

      // =========================================================
      // POST /request/:requestCode/client
      // Find or create client manually
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

        if (!requestCode) {
          return json(
            {
              ok: false,
              error: "Request code missing",
            },
            400
          );
        }

        const requestResult = await env.DB.prepare(`
          SELECT
            id,
            request_code,
            client_id,
            object_id,
            type,
            type_label,
            name,
            phone,
            location,
            timing,
            project,
            consultation_date,
            source,
            status,
            created_at,
            updated_at
          FROM requests
          WHERE request_code = ?
          LIMIT 1
        `)
          .bind(requestCode)
          .all();

        if (
          !requestResult.results ||
          !requestResult.results.length
        ) {
          return json(
            {
              ok: false,
              error: "Request not found",
              requestCode,
            },
            404
          );
        }

        const req = requestResult.results[0];

        // Якщо клієнт уже прив'язаний
        if (req.client_id) {
          const existingClient = await env.DB.prepare(`
            SELECT
              id,
              name,
              phone,
              telegram_id,
              created_at
            FROM clients
            WHERE id = ?
            LIMIT 1
          `)
            .bind(req.client_id)
            .all();

          if (
            existingClient.results &&
            existingClient.results.length
          ) {
            return json({
              ok: true,
              created: false,
              existing: true,
              request: req,
              client: existingClient.results[0],
            });
          }
        }

        const normalizedPhone = normalizePhone(req.phone);

        if (!normalizedPhone) {
          return json(
            {
              ok: false,
              error: "Phone is missing in request",
            },
            400
          );
        }

        // Шукаємо клієнта за телефоном
        const clientResult = await env.DB.prepare(`
          SELECT
            id,
            name,
            phone,
            telegram_id,
            created_at
          FROM clients
          WHERE phone = ?
          LIMIT 1
        `)
          .bind(normalizedPhone)
          .all();

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
            RETURNING
              id,
              name,
              phone,
              telegram_id,
              created_at
          `)
            .bind(req.name, normalizedPhone)
            .all();

          if (
            !insertClient.results ||
            !insertClient.results.length
          ) {
            return json(
              {
                ok: false,
                error: "Failed to create client",
              },
              500
            );
          }

          client = insertClient.results[0];
          created = true;
        }

        await env.DB.prepare(`
          UPDATE requests
          SET
            client_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
          .bind(client.id, req.id)
          .run();

        const updatedRequestResult = await env.DB.prepare(`
          SELECT
            id,
            request_code,
            client_id,
            object_id,
            type,
            type_label,
            name,
            phone,
            location,
            timing,
            project,
            consultation_date,
            source,
            status,
            created_at,
            updated_at
          FROM requests
          WHERE id = ?
          LIMIT 1
        `)
          .bind(req.id)
          .all();

        const updatedRequest =
          updatedRequestResult.results &&
          updatedRequestResult.results.length
            ? updatedRequestResult.results[0]
            : req;

        return json({
          ok: true,
          created,
          existing,
          request: updatedRequest,
          client,
        });
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

        if (!requestCode) {
          return json(
            {
              ok: false,
              error: "Request code missing",
            },
            400
          );
        }

        const result = await env.DB.prepare(`
          SELECT
            id,
            request_code,
            client_id,
            object_id,
            type,
            type_label,
            name,
            phone,
            location,
            timing,
            project,
            consultation_date,
            source,
            status,
            created_at,
            updated_at
          FROM requests
          WHERE request_code = ?
          LIMIT 1
        `)
          .bind(requestCode)
          .all();

        if (
          !result.results ||
          !result.results.length
        ) {
          return json(
            {
              ok: false,
              error: "Request not found",
            },
            404
          );
        }

        return json({
          ok: true,
          request: result.results[0],
        });
      }

      // =========================================================
      // GET /object/:objectCode
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

        if (!objectCode) {
          return json(
            {
              ok: false,
              error: "Object code missing",
            },
            400
          );
        }

        // Object
        const objectResult = await env.DB.prepare(`
          SELECT
            id,
            object_code,
            client_id,
            name,
            address,
            work_type,
            status,
            planned_start_date,
            created_at,
            updated_at
          FROM objects
          WHERE object_code = ?
          LIMIT 1
        `)
          .bind(objectCode)
          .all();

        if (
          !objectResult.results ||
          !objectResult.results.length
        ) {
          return json(
            {
              ok: false,
              error: "Object not found",
            },
            404
          );
        }

        const object = objectResult.results[0];

        // Client
        const clientResult = await env.DB.prepare(`
          SELECT
            id,
            name,
            phone,
            telegram_id,
            created_at
          FROM clients
          WHERE id = ?
          LIMIT 1
        `)
          .bind(object.client_id)
          .all();

        // Estimates
        const estimatesResult = await env.DB.prepare(`
          SELECT
            id,
            object_id,
            title,
            status,
            created_at,
            updated_at
          FROM estimates
          WHERE object_id = ?
          ORDER BY id DESC
        `)
          .bind(object.id)
          .all();

        const estimates = estimatesResult.results || [];

        // Estimate items
        let estimateItems = [];

        if (estimates.length) {
          const ids = estimates.map(
            (estimate) => estimate.id
          );

          const placeholders = ids
            .map(() => "?")
            .join(",");

          const itemsResult = await env.DB.prepare(`
            SELECT
              id,
              estimate_id,
              description,
              quantity,
              unit_price,
              total,
              created_at
            FROM estimate_items
            WHERE estimate_id IN (${placeholders})
            ORDER BY id ASC
          `)
            .bind(...ids)
            .all();

          estimateItems = itemsResult.results || [];
        }

        // Payments
        const paymentsResult = await env.DB.prepare(`
          SELECT
            id,
            object_id,
            type,
            amount,
            description,
            created_at
          FROM payments
          WHERE object_id = ?
          ORDER BY id DESC
        `)
          .bind(object.id)
          .all();

        const payments = paymentsResult.results || [];

        // Financial
        let totalEstimate = 0;

        for (const item of estimateItems) {
          totalEstimate += Number(item.total || 0);
        }

        let totalPayments = 0;

        for (const payment of payments) {
          totalPayments += Number(payment.amount || 0);
        }

        const balance =
          totalEstimate - totalPayments;

        // Events
        const eventsResult = await env.DB.prepare(`
          SELECT
            id,
            object_id,
            event_type,
            content,
            author_type,
            author_id,
            created_at
          FROM events
          WHERE object_id = ?
          ORDER BY id DESC
        `)
          .bind(object.id)
          .all();

        // Important
        const importantResult = await env.DB.prepare(`
          SELECT
            id,
            object_id,
            title,
            content,
            file_id,
            created_at,
            created_by
          FROM important
          WHERE object_id = ?
          ORDER BY id DESC
        `)
          .bind(object.id)
          .all();

        // Files
        const filesResult = await env.DB.prepare(`
          SELECT
            id,
            object_id,
            name,
            file_type,
            storage_key,
            version,
            uploaded_by,
            created_at
          FROM files
          WHERE object_id = ?
          ORDER BY id DESC
        `)
          .bind(object.id)
          .all();

        return json({
          ok: true,

          object,

          client:
            clientResult.results &&
            clientResult.results.length
              ? clientResult.results[0]
              : null,

          estimates,

          estimate_items: estimateItems,

          payments,

          financial: {
            total_estimate: totalEstimate,
            total_payments: totalPayments,
            balance,
          },

          events: eventsResult.results || [],

          important: importantResult.results || [],

          files: filesResult.results || [],
        });
      }

      // =========================================================
      // POST /
      // Create new request
      // =========================================================

      if (
        request.method === "POST" &&
        path === "/"
      ) {
        if (!env.DB) {
          return json(
            {
              ok: false,
              error: "DB binding missing",
            },
            500
          );
        }

        if (!env.BOT_TOKEN) {
          return json(
            {
              ok: false,
              error: "BOT_TOKEN secret missing",
            },
            500
          );
        }

        if (!env.CHAT_ID) {
          return json(
            {
              ok: false,
              error: "CHAT_ID secret missing",
            },
            500
          );
        }

        // -------------------------------------------------------
        // Body
        // -------------------------------------------------------

        let body;

        try {
          body = await request.json();
        } catch {
          return json(
            {
              ok: false,
              error: "Invalid JSON body",
            },
            400
          );
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
          String(
            body.consultationDate || ""
          ).trim();

        const source =
          String(
            body.source || "SA-MASTER.PRO"
          ).trim();

        // -------------------------------------------------------
        // Validation
        // -------------------------------------------------------

        if (!name) {
          return json(
            {
              ok: false,
              error: "Name is required",
            },
            400
          );
        }

        if (!phone) {
          return json(
            {
              ok: false,
              error: "Phone is required",
            },
            400
          );
        }

        const normalizedPhone =
          normalizePhone(phone);

        if (!normalizedPhone) {
          return json(
            {
              ok: false,
              error: "Phone is invalid",
            },
            400
          );
        }

        // -------------------------------------------------------
        // Type labels
        // -------------------------------------------------------

        const labels = {
          complex: "Комплексний монтаж",
          local: "Локальний монтаж",
          consultation: "Консультація",
          estimate: "Прорахунок",
        };

        const finalTypeLabel =
          typeLabel ||
          labels[type] ||
          type ||
          "Не вказано";

        // -------------------------------------------------------
        // Insert request
        // -------------------------------------------------------

        const insertResult =
          await env.DB.prepare(`
            INSERT INTO requests (
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
            RETURNING id
          `)
            .bind(
              type,
              finalTypeLabel,
              name,
              phone,
              location || null,
              timing || null,
              project || null,
              consultationDate || null,
              source || "SA-MASTER.PRO"
            )
            .all();

        if (
          !insertResult.results ||
          !insertResult.results.length
        ) {
          return json(
            {
              ok: false,
              error: "Failed to create request",
            },
            500
          );
        }

        const requestDbId =
          insertResult.results[0].id;

        // -------------------------------------------------------
        // Request code
        // -------------------------------------------------------

        const year =
          new Date().getFullYear();

        const requestCode =
          `SM-R-${year}-${String(
            requestDbId
          ).padStart(3, "0")}`;

        await env.DB.prepare(`
          UPDATE requests
          SET
            request_code = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
          .bind(
            requestCode,
            requestDbId
          )
          .run();

        // =======================================================
        // FIND / CREATE CLIENT AUTOMATICALLY
        // =======================================================

        const clientResult =
          await env.DB.prepare(`
            SELECT
              id,
              name,
              phone,
              telegram_id,
              created_at
            FROM clients
            WHERE phone = ?
            LIMIT 1
          `)
            .bind(normalizedPhone)
            .all();

        let client;
        let clientCreated = false;

        if (
          clientResult.results &&
          clientResult.results.length
        ) {
          // Existing client
          client = clientResult.results[0];
        } else {
          // New client
          const insertClient =
            await env.DB.prepare(`
              INSERT INTO clients (
                name,
                phone
              )
              VALUES (?, ?)
              RETURNING
                id,
                name,
                phone,
                telegram_id,
                created_at
            `)
              .bind(
                name,
                normalizedPhone
              )
              .all();

          if (
            !insertClient.results ||
            !insertClient.results.length
          ) {
            return json(
              {
                ok: false,
                error:
                  "Request created but client creation failed",
                requestId: requestCode,
              },
              500
            );
          }

          client =
            insertClient.results[0];

          clientCreated = true;
        }

        // -------------------------------------------------------
        // Attach client to request
        // -------------------------------------------------------

        const attachResult =
          await env.DB.prepare(`
            UPDATE requests
            SET
              client_id = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
            .bind(
              client.id,
              requestDbId
            )
            .run();

        if (
          !attachResult.meta ||
          attachResult.meta.changes !== 1
        ) {
          return json(
            {
              ok: false,
              error:
                "Request created but client could not be attached",
              requestId: requestCode,
              clientId: client.id,
            },
            500
          );
        }

        // -------------------------------------------------------
        // Get saved request
        // -------------------------------------------------------

        const requestResult =
          await env.DB.prepare(`
            SELECT
              id,
              request_code,
              client_id,
              object_id,
              type,
              type_label,
              name,
              phone,
              location,
              timing,
              project,
              consultation_date,
              source,
              status,
              created_at,
              updated_at
            FROM requests
            WHERE id = ?
            LIMIT 1
          `)
            .bind(requestDbId)
            .all();

        const savedRequest =
          requestResult.results &&
          requestResult.results.length
            ? requestResult.results[0]
            : null;

        // -------------------------------------------------------
        // Telegram
        // -------------------------------------------------------

        const now =
          new Date().toLocaleString(
            "uk-UA",
            {
              timeZone: "Europe/Kyiv",
              hour12: false,
            }
          );

        const telegramText = `
🏠 НОВА ЗАЯВКА

🆔 ID: ${requestCode}

👤 Ім'я: ${name}
📞 Телефон: ${phone}

🔧 Тип: ${finalTypeLabel}
📍 Об'єкт: ${location || "—"}
📐 Дизайн-проєкт: ${project || "—"}
🗓 Початок: ${timing || "—"}
📅 Консультація: ${consultationDate || "—"}

🔗 Джерело: ${source || "SA-MASTER.PRO"}
📊 Статус: new
🕐 Час: ${now}
`.trim();

        // -------------------------------------------------------
        // Telegram API
        // -------------------------------------------------------

        const telegramResponse =
          await fetch(
            `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json",
              },

              body: JSON.stringify({
                chat_id: env.CHAT_ID,
                text: telegramText,
              }),
            }
          );

        const telegramData =
          await telegramResponse.json();

        if (
          !telegramResponse.ok ||
          !telegramData.ok
        ) {
          console.error(
            "Telegram error:",
            telegramData
          );

          return json(
            {
              ok: false,
              error:
                "Request saved but Telegram notification failed",
              requestId: requestCode,
            },
            500
          );
        }

        // -------------------------------------------------------
        // Success
        // -------------------------------------------------------

        return json({
          ok: true,

          requestId:
            requestCode,

          request:
            savedRequest,

          client: {
            id: client.id,
            created: clientCreated,
          },
        });
      }

      // =========================================================
      // 404
      // =========================================================

      return json(
        {
          ok: false,
          error: "Not found",
        },
        404
      );

    } catch (error) {
      console.error(error);

      return json(
        {
          ok: false,
          error:
            error?.message ||
            String(error),
        },
        500
      );
    }

    // =========================================================
    // JSON helper
    // =========================================================

    function json(data, status = 200) {
      return new Response(
        JSON.stringify(data),
        {
          status,

          headers: {
            ...cors,
            "Content-Type":
              "application/json; charset=utf-8",
          },
        }
      );
    }

    // =========================================================
    // Phone normalization
    // =========================================================

    function normalizePhone(phone) {
      return String(phone || "")
        .replace(/[^\d+]/g, "")
        .trim();
    }
  },
};
