export async function sendTelegram(env, text) {
  if (!env.BOT_TOKEN || !env.CHAT_ID) return { ok: false, skipped: true };
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.CHAT_ID,
          text,
          disable_web_page_preview: true,
        }),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      console.error("Telegram sendMessage failed:", res.status, body);
      return { ok: false, status: res.status, body };
    }
    return { ok: true };
  } catch (err) {
    console.error("Telegram error:", err);
    return { ok: false, error: err?.message || String(err) };
  }
}
