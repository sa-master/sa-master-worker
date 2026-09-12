export default {
  async fetch(request, env) {

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
    // CORS PREFLIGHT
    // ==========================================

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors,
      });
    }

    const url = new URL(request.url);

    // ==========================================
    // GET /object/SM-2026-001
    // Отримання об'єкта з D1
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

        // ------------------------------------------
        // ОБ'ЄКТ + КЛІЄНТ
        // ------------------------------------------

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

        // ------------------------------------------
        // КОШТОРИСИ
        // ------------------------------------------

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

        // ------------------------------------------
        // ПОЗИЦІЇ КОШТОРИСУ
        // ------------------------------------------

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

        // ------------------------------------------
        // ФІНАНСОВІ ОПЕРАЦІЇ
        // ------------------------------------------

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

        // ------------------------------------------
        // ІСТОРІЯ
        // ------------------------------------------

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

        // ------------------------------------------
        // ВАЖЛИВЕ
        // ------------------------------------------

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

        // ------------------------------------------
        // ФАЙЛИ
        // ------------------------------------------

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

        // ------------------------------------------
        // ФІНАНСОВИЙ ПІДСУМОК
        // ------------------------------------------

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

        // ------------------------------------------
        // ВІДПОВІДЬ
        // ------------------------------------------

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
    // ДІАГНОСТИКА WORKER
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
    // POST
    // ЗАЯВКА З САЙТУ → TELEGRAM
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

      // ------------------------------------------
      // JSON
      // ------------------------------------------

      let data;

      try {
        data = await request.json();
      } catch {
        throw new Error(
          "Invalid JSON request"
        );
      }

      const {
        name,
        phone,
        source,
      } = data;

      // ------------------------------------------
      // ПЕРЕВІРКА
      // ------------------------------------------

      if (!name || !phone) {

        return new Response(
          JSON.stringify({
            ok: false,
            error: "Missing name or phone",
          }),
          {
            status: 400,
            headers: jsonHeaders,
          }
        );
      }

      // ------------------------------------------
      // TELEGRAM MESSAGE
      // ------------------------------------------

      const text = `🏠 НОВА ЗАЯВКА

👤 Ім'я: ${name}
📞 Телефон: ${phone}
🔗 Джерело: ${source || "сайт"}
🕐 Час: ${new Date().toLocaleString("uk-UA")}`;

      const telegramUrl =
        `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;

      // ------------------------------------------
      // TELEGRAM API
      // ------------------------------------------

      const telegramResponse = await fetch(
        telegramUrl,
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
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

      // ------------------------------------------
      // TELEGRAM ERROR
      // ------------------------------------------

      if (
        !telegramResponse.ok ||
        !telegramData.ok
      ) {

        return new Response(
          JSON.stringify({
            ok: false,
            error: "Telegram API error",
            telegram: telegramData,
          }),
          {
            status: 500,
            headers: jsonHeaders,
          }
        );
      }

      // ------------------------------------------
      // SUCCESS
      // ------------------------------------------

      return new Response(
        JSON.stringify({
          ok: true,
          message:
            "Заявку успішно відправлено в Telegram",
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
