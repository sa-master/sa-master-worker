export default {
  async fetch(request, env) {

    // ==========================================
    // CORS
    // ==========================================

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    const jsonHeaders = {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
    };

    // ==========================================
    // PREFLIGHT
    // ==========================================

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors,
      });
    }

    const url = new URL(request.url);

    // ==========================================
    // GET /requests
    // СПИСОК УСІХ ЗАЯВОК
    // ==========================================

    if (
      request.method === "GET" &&
      url.pathname === "/requests"
    ) {
      try {

        if (!env.DB) {
          throw new Error("DB binding is NOT available");
        }

        const requestsResult = await env.DB
          .prepare(`
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
          `)
          .all();

        return new Response(
          JSON.stringify({
            ok: true,
            requests:
              requestsResult.results || [],
          }),
          {
            status: 200,
            headers: jsonHeaders,
          }
        );

      } catch (error) {

        return new Response(
          JSON.stringify({
            ok: false,
            error:
              error?.message ||
              "Unknown D1 error",
          }),
          {
            status: 500,
            headers: jsonHeaders,
          }
        );
      }
    }

    // ==========================================
    // GET /request/:requestCode
    // ==========================================

    if (
      request.method === "GET" &&
      url.pathname.startsWith("/request/")
    ) {
      try {

        if (!env.DB) {
          throw new Error("DB binding is NOT available");
        }

        const requestCode = decodeURIComponent(
          url.pathname.replace("/request/", "")
        ).trim();

        if (!requestCode) {
          throw new Error("Request code is missing");
        }

        const requestResult = await env.DB
          .prepare(`
            SELECT
              r.id,
              r.request_code,
              r.client_id,
              r.object_id,

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

            WHERE r.request_code = ?

            LIMIT 1
          `)
          .bind(requestCode)
          .first();

        if (!requestResult) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: "Request not found",
            }),
            {
              status: 404,
              headers: jsonHeaders,
            }
          );
        }

        return new Response(
          JSON.stringify({
            ok: true,
            request: requestResult,
          }),
          {
            status: 200,
            headers: jsonHeaders,
          }
        );

      } catch (error) {

        return new Response(
          JSON.stringify({
            ok: false,
            error:
              error?.message ||
              "Unknown D1 error",
          }),
          {
            status: 500,
            headers: jsonHeaders,
          }
        );
      }
    }

    // ==========================================
    // GET /object/:objectCode
    // ==========================================

    if (
      request.method === "GET" &&
      url.pathname.startsWith("/object/")
    ) {
      try {

        if (!env.DB) {
          throw new Error("DB binding is NOT available");
        }

        const objectCode = decodeURIComponent(
          url.pathname.replace("/object/", "")
        ).trim();

        if (!objectCode) {
          throw new Error("Object code is missing");
        }

        const objectResult = await env.DB
          .prepare(`
            SELECT
              o.id,
              o.object_code,
              o.name,
              o.address,
              o.work_type,
              o.status,
              o.planned_start_date,
              o.created_at,
              o.updated_at,

              c.id AS client_id,
              c.name AS client_name,
              c.phone AS client_phone,
              c.telegram_id AS client_telegram_id

            FROM objects o

            JOIN clients c
              ON c.id = o.client_id

            WHERE o.object_code = ?

            LIMIT 1
          `)
          .bind(objectCode)
          .first();

        if (!objectResult) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: "Object not found",
            }),
            {
              status: 404,
              headers: jsonHeaders,
            }
          );
        }

        const objectId = objectResult.id;

        // ========================================
        // ESTIMATES
        // ========================================

        const estimatesResult = await env.DB
          .prepare(`
            SELECT
              id,
              title,
              status,
              created_at,
              updated_at
            FROM estimates
            WHERE object_id = ?
            ORDER BY id DESC
          `)
          .bind(objectId)
          .all();

        // ========================================
        // ESTIMATE ITEMS
        // ========================================

        const estimateItemsResult = await env.DB
          .prepare(`
            SELECT
              ei.id,
              ei.estimate_id,
              ei.description,
              ei.quantity,
              ei.unit_price,
              ei.total
            FROM estimate_items ei
            JOIN estimates e
              ON e.id = ei.estimate_id
            WHERE e.object_id = ?
            ORDER BY ei.id
          `)
          .bind(objectId)
          .all();

        // ========================================
        // PAYMENTS
        // ========================================

        const paymentsResult = await env.DB
          .prepare(`
            SELECT
              id,
              type,
              amount,
              description,
              created_at
            FROM payments
            WHERE object_id = ?
            ORDER BY id
          `)
          .bind(objectId)
          .all();

        // ========================================
        // EVENTS
        // ========================================

        const eventsResult = await env.DB
          .prepare(`
            SELECT
              id,
              event_type,
              content,
              author_type,
              author_id,
              created_at
            FROM events
            WHERE object_id = ?
            ORDER BY id DESC
          `)
          .bind(objectId)
          .all();

        // ========================================
        // IMPORTANT
        // ========================================

        const importantResult = await env.DB
          .prepare(`
            SELECT
              id,
              title,
              content,
              file_id,
              created_at,
              created_by
            FROM important
            WHERE object_id = ?
            ORDER BY id DESC
          `)
          .bind(objectId)
          .all();

        // ========================================
        // FILES
        // ========================================

        const filesResult = await env.DB
          .prepare(`
            SELECT
              id,
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
          .bind(objectId)
          .all();

        // ========================================
        // FINANCIAL
        // ========================================

        const financialResult = await env.DB
          .prepare(`
            SELECT
              COALESCE(
                SUM(
                  CASE
                    WHEN type = 'materials_received'
                    THEN amount
                    ELSE 0
                  END
                ),
                0
              ) AS received,

              COALESCE(
                SUM(
                  CASE
                    WHEN type = 'materials_spent'
                    THEN amount
                    ELSE 0
                  END
                ),
                0
              ) AS spent

            FROM payments
            WHERE object_id = ?
          `)
          .bind(objectId)
          .first();

        const received = Number(
          financialResult?.received || 0
        );

        const spent = Number(
          financialResult?.spent || 0
        );

        const balance = received - spent;

        // ========================================
        // RESPONSE
        // ========================================

        return new Response(
          JSON.stringify({
            ok: true,

            object: objectResult,

            estimates:
              estimatesResult.results || [],

            estimate_items:
              estimateItemsResult.results || [],

            payments:
              paymentsResult.results || [],

            financial: {
              received,
              spent,
              balance,
            },

            events:
              eventsResult.results || [],

            important:
              importantResult.results || [],

            files:
              filesResult.results || [],
          }),
          {
            status: 200,
            headers: jsonHeaders,
          }
        );

      } catch (error) {

        return new Response(
          JSON.stringify({
            ok: false,
            error:
              error?.message ||
              "Unknown D1 error",
          }),
          {
            status: 500,
            headers: jsonHeaders,
          }
        );
      }
    }

    // ==========================================
    // GET /
    // DIAGNOSTICS
    // ==========================================

    if (request.method === "GET") {

      return new Response(
        JSON.stringify({
          ok: true,
          BOT_TOKEN: !!env.BOT_TOKEN,
          CHAT_ID: !!env.CHAT_ID,
          DB: !!env.DB,
          bindings: Object.keys(env),
        }),
        {
          status: 200,
          headers: jsonHeaders,
        }
      );
    }

    // ==========================================
    // ONLY POST AFTER THIS POINT
    // ==========================================

    if (request.method !== "POST") {

      return new Response(
        JSON.stringify({
          ok: false,
          error: "Method not allowed",
        }),
        {
          status: 405,
          headers: jsonHeaders,
        }
      );
    }

    // ==========================================
    // POST — NEW REQUEST
    // ==========================================

    try {

      if (!env.BOT_TOKEN) {
        throw new Error(
          "BOT_TOKEN binding is NOT available"
        );
      }

      if (!env.CHAT_ID) {
        throw new Error(
          "CHAT_ID binding is NOT available"
        );
      }

      if (!env.DB) {
        throw new Error(
          "DB binding is NOT available"
        );
      }

      // ========================================
      // READ JSON
      // ========================================

      let data;

      try {
        data = await request.json();
      } catch {
        throw new Error(
          "Invalid JSON request"
        );
      }

      // ========================================
      // HELPERS
      // ========================================

      const clean = (value) => {
        if (
          value === undefined ||
          value === null
        ) {
          return "";
        }

        return String(value).trim();
      };

      const name = clean(data.name);
      const phone = clean(data.phone);
      const type = clean(data.type);

      const typeLabels = {
        complex: "Комплексний монтаж",
        local: "Локальний монтаж",
        consultation: "Консультація",
        estimate: "Прорахунок",
      };

      const typeLabel =
        clean(data.typeLabel) ||
        typeLabels[type] ||
        type;

      const location =
        clean(data.location);

      const timing =
        clean(data.timing);

      const project =
        clean(data.project);

      const consultationDate =
        clean(data.consultationDate);

      // ========================================
      // SOURCE
      // ========================================

      const source =
        clean(data.source) ||
        "SA-MASTER.PRO";

      // ========================================
      // VALIDATION
      // ========================================

      if (!name || !phone || !type) {

        return new Response(
          JSON.stringify({
            ok: false,
            error:
              "Missing name, phone or type",
          }),
          {
            status: 400,
            headers: jsonHeaders,
          }
        );
      }

      // ========================================
      // 1. SAVE REQUEST TO D1
      // ========================================

      const insertResult = await env.DB
        .prepare(`
          INSERT INTO requests (
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
            status
          )

          VALUES (
            NULL,
            NULL,
            NULL,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            'new'
          )
        `)
        .bind(
          type,
          typeLabel,
          name,
          phone,
          location || null,
          timing || null,
          project || null,
          consultationDate || null,
          source,
        )
        .run();

      const requestDbId =
        insertResult?.meta?.last_row_id;

      if (!requestDbId) {
        throw new Error(
          "Could not determine new request ID"
        );
      }

      // ========================================
      // 2. GENERATE REQUEST CODE
      // ========================================

      const year =
        new Date().getFullYear();

      const requestCode =
        `SM-R-${year}-${String(requestDbId).padStart(3, "0")}`;

      // ========================================
      // 3. SAVE REQUEST CODE
      // ========================================

      await env.DB
        .prepare(`
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

      // ========================================
      // 4. TELEGRAM MESSAGE
      // ========================================

      let text =
`🏠 НОВА ЗАЯВКА

🆔 ID: ${requestCode}

👤 Ім'я: ${name}
📞 Телефон: ${phone}

🔧 Тип: ${typeLabel}`;

      if (location) {
        text +=
          `\n📍 Об'єкт: ${location}`;
      }

      if (project) {
        text +=
          `\n📐 Дизайн-проєкт: ${project}`;
      }

      if (timing) {
        text +=
          `\n🗓 Початок: ${timing}`;
      }

      if (consultationDate) {
        text +=
          `\n📅 Консультація: ${consultationDate}`;
      }

      if (source) {
        text +=
          `\n🔗 Джерело: ${source}`;
      }

      text +=
        `\n📊 Статус: new`;

      text +=
        `\n🕐 Час: ${new Date().toLocaleString("uk-UA")}`;

      // ========================================
      // 5. SEND TO TELEGRAM
      // ========================================

      const telegramUrl =
        `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;

      const telegramResponse =
        await fetch(
          telegramUrl,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              chat_id: env.CHAT_ID,
              text,
            }),
          }
        );

      let telegramData;

      try {

        telegramData =
          await telegramResponse.json();

      } catch {

        throw new Error(
          `Telegram returned invalid response: ${telegramResponse.status}`
        );
      }

      // ========================================
      // TELEGRAM ERROR
      // ========================================

      if (
        !telegramResponse.ok ||
        !telegramData.ok
      ) {

        return new Response(
          JSON.stringify({
            ok: false,
            requestId: requestCode,
            error:
              "Telegram API error",
          }),
          {
            status: 500,
            headers: jsonHeaders,
          }
        );
      }

      // ========================================
      // SUCCESS
      // ========================================

      return new Response(
        JSON.stringify({
          ok: true,
          requestId: requestCode,
          message:
            "Заявку успішно збережено та відправлено в Telegram",
        }),
        {
          status: 200,
          headers: jsonHeaders,
        }
      );

    } catch (error) {

      return new Response(
        JSON.stringify({
          ok: false,
          error:
            error?.message ||
            "Unknown Worker error",
        }),
        {
          status: 500,
          headers: jsonHeaders,
        }
      );
    }
  },
};
