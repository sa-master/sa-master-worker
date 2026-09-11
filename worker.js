export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors,
      });
    }

    // Only POST requests
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Method not allowed. Use POST.",
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
      // Check Cloudflare Secrets
      if (!env.BOT_TOKEN) {
        throw new Error("BOT_TOKEN binding is NOT available");
      }

      if (!env.CHAT_ID) {
        throw new Error("CHAT_ID binding is NOT available");
      }

      // Read request body
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

      // Validate form data
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

      // Prepare Telegram message
      const text = `🏠 НОВА ЗАЯВКА

👤 Ім'я: ${name}
📞 Телефон: ${phone}
🔗 Джерело: ${source || "сайт"}
🕐 Час: ${new Date().toLocaleString("uk-UA")}`;

      // Telegram API
      const telegramResponse = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            chat_id: env.CHAT_ID,
            text: text,
          }),
        }
      );

      // Read Telegram response
      let telegramData;

      try {
        telegramData = await telegramResponse.json();
      } catch {
        throw new Error(
          `Telegram returned invalid response (${telegramResponse.status})`
        );
      }

      // Telegram API error
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

      // Success
      return new Response(
        JSON.stringify({
          ok: true,
        }),
        {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json",
          },
        }
      );

    } catch (err) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: err?.message || "Unknown Worker error",
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
