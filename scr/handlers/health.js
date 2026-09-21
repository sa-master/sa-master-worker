import { json } from "../lib/json.js";

export async function handleHealth(request, env, headers) {
  return json(
    {
      ok: true,
      environment: env.ENVIRONMENT || "unknown",
      bindings: {
        DB: !!env.DB,
        FILES: !!env.FILES,
        BOT_TOKEN: !!env.BOT_TOKEN,
        CHAT_ID: !!env.CHAT_ID,
        ADMIN_TOKEN: !!env.ADMIN_TOKEN,
      },
      time: new Date().toISOString(),
    },
    headers
  );
}
