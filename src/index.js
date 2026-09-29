import { corsHeaders, preflight } from "./lib/cors.js";
import { error, json } from "./lib/json.js";
import { requireAuth } from "./lib/auth.js";
import { createRouter } from "./lib/router.js";

import { handleHealth } from "./handlers/health.js";
import {
  handleCreateRequest,
  handleGetCalculatorRequest,
  handleListRequests,
  handleGetRequest,
  handleUpdateStatus,
  handleGetEvents,
  handleAttachClient,
  handleTelegramWebhook,
} from "./handlers/requests.js";
import { handleJobsWebhook } from "./handlers/jobs.js";
import { handleGetObject, handleUpdateObject } from "./handlers/objects.js";
import {
  handleUploadRequestProject,
  handleUploadFile,
  handleListFiles,
  handleDownloadFile,
} from "./handlers/files.js";

/* =========================================================
 * TEMP DEBUG: GET /debug/jobs-group
 * Тимчасово публічний маршрут для діагностики.
 * Після перевірки його треба видалити.
 * ========================================================= */

const TELEGRAM_API = "https://api.telegram.org";

async function jobsApi(env, method, payload = {}) {
  if (!env.JOBS_BOT_TOKEN) {
    return {
      ok: false,
      description: "JOBS_BOT_TOKEN не встановлено",
    };
  }

  try {
    const response = await fetch(
      `${TELEGRAM_API}/bot${env.JOBS_BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    return await response.json();
  } catch (err) {
    return {
      ok: false,
      description: String(err?.message || err),
    };
  }
}

async function handleJobsGroupDebug(request, env, headers, params, url) {
  const telegramIdRaw = url.searchParams.get("telegram_id");
  const telegramId = telegramIdRaw ? Number(telegramIdRaw) : null;

  const result = {
    ok: true,
    jobs_chat_id: env.JOBS_CHAT_ID || null,
    telegram_id: telegramId || null,
    checks: {},
  };

  if (!env.JOBS_CHAT_ID) {
    result.ok = false;
    result.error = "JOBS_CHAT_ID не встановлено";
    return json(result, headers, 500);
  }

  if (!env.JOBS_BOT_TOKEN) {
    result.ok = false;
    result.error = "JOBS_BOT_TOKEN не встановлено";
    return json(result, headers, 500);
  }

  result.checks.get_chat = await jobsApi(env, "getChat", {
    chat_id: env.JOBS_CHAT_ID,
  });

  if (telegramId) {
    result.checks.get_chat_member = await jobsApi(env, "getChatMember", {
      chat_id: env.JOBS_CHAT_ID,
      user_id: telegramId,
    });
  } else {
    result.checks.get_chat_member = {
      ok: false,
      skipped: true,
      description: "Додайте ?telegram_id=TELEGRAM_ID другого акаунта",
    };
  }

  result.checks.create_invite_link = await jobsApi(
    env,
    "createChatInviteLink",
    {
      chat_id: env.JOBS_CHAT_ID,
      name: `DEBUG ${Date.now()}`.slice(0, 32),
    }
  );

  return json(result, headers);
}

const PUBLIC_ROUTES = [
  ["GET",  /^\/$/,                            handleHealth,                { auth: false }],
  ["POST", /^\/$/,                            handleCreateRequest,         { auth: false }],
  ["GET",  /^\/calculator-request\/([^/]+)$/, handleGetCalculatorRequest, { auth: false }],
  ["POST", /^\/request\/([^/]+)\/project$/,   handleUploadRequestProject, { auth: false }],
  ["POST", /^\/telegram-webhook$/,            handleTelegramWebhook,      { auth: false }],
  ["POST", /^\/jobs-webhook$/,                handleJobsWebhook,          { auth: false }],

  /* ТИМЧАСОВО ПУБЛІЧНИЙ DEBUG */
  ["GET",  /^\/debug\/jobs-group$/,           handleJobsGroupDebug,       { auth: false }],
];

const ADMIN_ROUTES = [
  ["GET",   /^\/requests$/,                     handleListRequests,  { auth: true }],
  ["GET",   /^\/request\/([^/]+)$/,             handleGetRequest,    { auth: true }],
  ["POST",  /^\/request\/([^/]+)\/status$/,     handleUpdateStatus,  { auth: true }],
  ["GET",   /^\/request\/([^/]+)\/events$/,     handleGetEvents,     { auth: true }],
  ["POST",  /^\/request\/([^/]+)\/client$/,     handleAttachClient,  { auth: true }],
  ["GET",   /^\/object\/([^/]+)$/,              handleGetObject,     { auth: true }],
  ["PATCH", /^\/object\/([^/]+)$/,              handleUpdateObject,  { auth: true }],
  ["POST",  /^\/object\/([^/]+)\/file$/,        handleUploadFile,    { auth: true }],
  ["GET",   /^\/object\/([^/]+)\/files$/,       handleListFiles,     { auth: true }],
  ["GET",   /^\/object\/([^/]+)\/file\/(\d+)$/, handleDownloadFile,  { auth: true }],
];

const routePublic = createRouter(PUBLIC_ROUTES);
const routeAdmin = createRouter(ADMIN_ROUTES);

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return preflight();

    const headers = corsHeaders();
    const url = new URL(request.url);

    try {
      const pub = await routePublic(request, url);

      if (pub) {
        return await pub.handler(
          request,
          env,
          headers,
          pub.params,
          url,
          ctx
        );
      }

      const admin = await routeAdmin(request, url);

      if (admin) {
        const authError = requireAuth(request, env, headers);

        if (authError) return authError;

        return await admin.handler(
          request,
          env,
          headers,
          admin.params,
          url,
          ctx
        );
      }

      return error("Not found", headers, 404);
    } catch (err) {
      console.error("Unhandled error:", err);

      return error(
        err?.message || String(err),
        headers,
        500
      );
    }
  },
};
