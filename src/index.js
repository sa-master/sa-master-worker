import { corsHeaders, preflight } from "./lib/cors.js";
import { error } from "./lib/json.js";
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


function timingSafeEqualText(a, b) {
  const left = new TextEncoder().encode(String(a || ""));
  const right = new TextEncoder().encode(String(b || ""));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function requireTelegramWebhookSecret(request, env, secretName, headers) {
  const expected = env?.[secretName];
  if (!expected) {
    console.error(`Missing required secret: ${secretName}`);
    return error("Webhook security is not configured", headers, 503);
  }

  const received = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!timingSafeEqualText(received, expected)) {
    return error("Forbidden", headers, 403);
  }

  return null;
}

/*
 * TEMPORARY ADMIN ENDPOINT.
 * Registers both Telegram webhooks with their secret_token values.
 * Remove this route and handler after successful setup.
 */
async function handleSetupWebhooks(request, env, headers) {
  const required = [
    "TELEGRAM_BOT_TOKEN",
    "JOBS_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "JOBS_WEBHOOK_SECRET",
  ];

  const missing = required.filter((name) => !env?.[name]);
  if (missing.length) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Missing required secrets",
        missing,
      }),
      {
        status: 503,
        headers: {
          ...headers,
          "Content-Type": "application/json; charset=utf-8",
        },
      }
    );
  }

  const origin = new URL(request.url).origin;

  const configs = [
    {
      bot: "main",
      token: env.TELEGRAM_BOT_TOKEN,
      webhookUrl: `${origin}/telegram-webhook`,
      secretToken: env.TELEGRAM_WEBHOOK_SECRET,
    },
    {
      bot: "jobs",
      token: env.JOBS_BOT_TOKEN,
      webhookUrl: `${origin}/jobs-webhook`,
      secretToken: env.JOBS_WEBHOOK_SECRET,
    },
  ];

  const results = [];

  for (const config of configs) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${config.token}/setWebhook`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: config.webhookUrl,
            secret_token: config.secretToken,
            drop_pending_updates: false,
          }),
        }
      );

      const data = await response.json();

      results.push({
        bot: config.bot,
        ok: Boolean(data?.ok),
        description: data?.description || null,
      });
    } catch (err) {
      results.push({
        bot: config.bot,
        ok: false,
        description: err?.message || String(err),
      });
    }
  }

  const ok = results.every((item) => item.ok);

  return new Response(
    JSON.stringify({ ok, results }, null, 2),
    {
      status: ok ? 200 : 502,
      headers: {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
      },
    }
  );
}

const PUBLIC_ROUTES = [
  ["GET",  /^\/$/,                            handleHealth,                { auth: false }],
  ["POST", /^\/$/,                            handleCreateRequest,         { auth: false }],
  ["GET",  /^\/calculator-request\/([^/]+)$/, handleGetCalculatorRequest, { auth: false }],
  ["POST", /^\/request\/([^/]+)\/project$/,   handleUploadRequestProject, { auth: false }],
  ["POST", /^\/telegram-webhook$/,            handleTelegramWebhook,      { auth: false }],
  ["POST", /^\/jobs-webhook$/,                handleJobsWebhook,           { auth: false }],
];

const ADMIN_ROUTES = [
  ["POST",  /^\/admin\/setup-webhooks$/,         handleSetupWebhooks,  { auth: true }],
  ["GET",   /^\/requests$/,                     handleListRequests,   { auth: true }],
  ["GET",   /^\/request\/([^/]+)$/,             handleGetRequest,     { auth: true }],
  ["POST",  /^\/request\/([^/]+)\/status$/,     handleUpdateStatus,   { auth: true }],
  ["GET",   /^\/request\/([^/]+)\/events$/,     handleGetEvents,      { auth: true }],
  ["POST",  /^\/request\/([^/]+)\/client$/,     handleAttachClient,   { auth: true }],
  ["GET",   /^\/object\/([^/]+)$/,              handleGetObject,      { auth: true }],
  ["PATCH", /^\/object\/([^/]+)$/,              handleUpdateObject,   { auth: true }],
  ["POST",  /^\/object\/([^/]+)\/file$/,        handleUploadFile,     { auth: true }],
  ["GET",   /^\/object\/([^/]+)\/files$/,       handleListFiles,      { auth: true }],
  ["GET",   /^\/object\/([^/]+)\/file\/(\d+)$/, handleDownloadFile,   { auth: true }],
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
        if (url.pathname === "/telegram-webhook") {
          const webhookError = requireTelegramWebhookSecret(
            request, env, "TELEGRAM_WEBHOOK_SECRET", headers
          );
          if (webhookError) return webhookError;
        }

        if (url.pathname === "/jobs-webhook") {
          const webhookError = requireTelegramWebhookSecret(
            request, env, "JOBS_WEBHOOK_SECRET", headers
          );
          if (webhookError) return webhookError;
        }

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
