export async function handleCreateRequest(request, env, headers, _params, _url, ctx) {
  // ... (весь код як був) ...
  
  // Відправляємо Telegram у фоні через ctx.waitUntil
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(sendTelegram(env, telegramText));
  } else {
    // Fallback — чекаємо синхронно (якщо ctx немає)
    await sendTelegram(env, telegramText);
  }
  
  // ... (return json ...)
}