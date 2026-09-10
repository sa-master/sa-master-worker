export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

    try {
      const { name, phone, source } = await request.json();
      if (!name || !phone) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing fields' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      const text = `🏠 Нова заявка\n👤 ${name}\n📞 ${phone}\n🔗 ${source || 'сайт'}\n🕐 ${new Date().toLocaleString('uk-UA')}`;

      const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.CHAT_ID, text })
      });

      if (!r.ok) throw new Error('Telegram API error');

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
  }
};
