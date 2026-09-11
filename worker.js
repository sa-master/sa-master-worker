export default {
  async fetch(request, env) {

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    // Only POST is allowed
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'Method not allowed. Use POST.'
        }),
        {
          status: 405,
          headers: {
            ...cors,
            'Content-Type': 'application/json'
          }
        }
      );
    }

    try {

      // Check environment variables
      if (!env.BOT_TOKEN) {
        throw new Error('BOT_TOKEN is missing');
      }

      if (!env.CHAT_ID) {
        throw new Error('CHAT_ID is missing');
      }

      // Read request
      const data = await request.json();

      const {
        name,
        phone,
        source
      } = data;

      // Validate required fields
      if (!name || !phone) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: 'Missing name or phone'
          }),
          {
            status: 400,
            headers: {
              ...cors,
              'Content-Type': 'application/json'
            }
          }
        );
      }

      // Message for Telegram
      const text =
`🏠 НОВА ЗАЯВКА

👤 Ім'я: ${name}
📞 Телефон: ${phone}
🔗 Джерело: ${source || 'сайт'}
🕐 Час: ${new Date().toLocaleString('uk-UA')}`;

      // Telegram API
      const telegramUrl =
        `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;

      const telegramResponse = await fetch(telegramUrl, {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          chat_id: env.CHAT_ID,
          text: text
        })
      });

      // Read Telegram response
      const telegramData = await telegramResponse.json();

      // Telegram returned an error
      if (!telegramResponse.ok || !telegramData.ok) {

        return new Response(
          JSON.stringify({
            ok: false,
            error: 'Telegram API error',
            telegram: telegramData
          }),
          {
            status: 500,
            headers: {
              ...cors,
              'Content-Type': 'application/json'
            }
          }
        );
      }

      // Everything is OK
      return new Response(
        JSON.stringify({
          ok: true
        }),
        {
          status: 200,
          headers: {
            ...cors,
            'Content-Type': 'application/json'
          }
        }
      );

    } catch (err) {

      // Internal Worker error
      return new Response(
        JSON.stringify({
          ok: false,
          error: err.message
        }),
        {
          status: 500,
          headers: {
            ...cors,
            'Content-Type': 'application/json'
          }
        }
      );
    }
  }
};
