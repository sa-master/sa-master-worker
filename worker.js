export default {
  async fetch(request, env) {

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors,
      });
    }

    // --------------------------------------------------
    // DIAGNOSTIC GET
    // --------------------------------------------------
    // Відкриття Worker у браузері покаже,
    // чи доступні Secrets. Значення секретів не показуються.
    if (request.method === "GET") {
      return new Response(
        JSON.stringify({
          ok: true,
          BOT_TOKEN: !!env.BOT_TOKEN,
          CHAT_ID: !!env.CHAT_ID,
          bindings: Object.keys(env),
        }),
        {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // --------------------------------------------------
    // ONLY POST
    // --------------------------------------------------
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Method not allowed",
        }),
        {
          status: 405,
          headers: {
            ...cors,
            "Content-Type": "application/json",
          },
        }
      );
    }

    try {

      // ------------------------------------------------
      // CHECK SECRETS
      // ------------------------------------------------
      if (!env.BOT_TOKEN) {
        throw new Error("BOT_TOKEN binding is NOT available");
      }

      if (!env.CHAT_ID) {
        throw new Error("CHAT_ID binding is NOT available");
      }

      // ------------------------------------------------
      // READ REQUEST
      // ------------------------------------------------
      let data;

      try {
        data = await request.json();
      } catch {
        throw new Error("Invalid JSON request");
      }

      const {
        name,
        phone,
        source,
      } = data;

      // ------------------------------------------------
      // VALIDATE FORM
      // ------------------------------------------------
      if (!name || !phone) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "Missing name or phone",
          }),
          {
            status: 400,
            headers: {
              ...cors,
              "Content-Type": "application/json",
            },
          }
        );
      }

      // ------------------------------------------------
      // TELEGRAM MESSAGE
      // ------------------------------------------------
      const text = `🏠 НОВА ЗАЯВКА

👤 Ім'я: ${name}
📞 Телефон: ${phone}
🔗 Джерело: ${source || "сайт"}
🕐 Час: ${new Date().toLocaleString("uk-UA")}`;

      // ------------------------------------------------
      // TELEGRAM API
      // ------------------------------------------------
      const telegramUrl =
        `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;

      const telegramResponse = await fetch(telegramUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: env.CHAT_ID,
          text: text,
        }),
      });

      // ------------------------------------------------
      // TELEGRAM RESPONSE
      // ------------------------------------------------
      let telegramData;

      try {
        telegramData = await telegramResponse.json();
      } catch {
        throw new Error(
          `Telegram returned invalid response: ${telegramResponse.status}`
        );
      }

      // ------------------------------------------------
      // TELEGRAM ERROR
      // ------------------------------------------------
      if (!telegramResponse.ok || !telegramData.ok) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "Telegram API error",
            telegram: telegramData,
          }),
          {
            status: 500,
            headers: {
              ...cors,
              "Content-Type": "application/json",
            },
          }
        );
      }

      // ------------------------------------------------
      // SUCCESS
      // ------------------------------------------------
      return new Response(
        JSON.stringify({
          ok: true,
          message: "Заявку успішно відправлено в Telegram",
        }),
        {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json",
          },
        }
      );

    } catch (error) {

      // ------------------------------------------------
      // WORKER ERROR
      // ------------------------------------------------
      return new Response(
        JSON.stringify({
          ok: false,
          error: error?.message || "Unknown Worker error",
        }),
        {
          status: 500,
          headers: {
            ...cors,
            "Content-Type": "application/json",
          },
        }
      );
    }
  },
};
