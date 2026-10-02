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


/* =========================================================
 * TELEGRAM WEBHOOK SECURITY
 * ========================================================= */

function timingSafeEqualText(a, b) {
  const left = new TextEncoder().encode(String(a || ""));
  const right = new TextEncoder().encode(String(b || ""));

  if (left.length !== right.length) return false;

  let diff = 0;

  for (let i = 0; i < left.length; i++) {
    diff |= left[i] ^ right[i];
  }

  return diff === 0;
}


function requireTelegramWebhookSecret(
  request,
  env,
  secretName,
  headers
) {
  const expected = env?.[secretName];

  if (!expected) {
    console.error(`Missing required secret: ${secretName}`);

    return error(
      "Webhook security is not configured",
      headers,
      503
    );
  }

  const received =
    request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    ) || "";

  if (!timingSafeEqualText(received, expected)) {
    return error(
      "Forbidden",
      headers,
      403
    );
  }

  return null;
}


/* =========================================================
 * ONE-TIME JOBS WEBHOOK SETUP
 * ========================================================= */

async function handleSetupJobsWebhook(
  request,
  env,
  headers
) {
  if (!env.JOBS_BOT_TOKEN) {
    return error(
      "JOBS_BOT_TOKEN is not configured",
      headers,
      503
    );
  }

  if (!env.JOBS_WEBHOOK_SECRET) {
    return error(
      "JOBS_WEBHOOK_SECRET is not configured",
      headers,
      503
    );
  }

  const webhookUrl =
    "https://sa-master-worker.c6hht469s9.workers.dev/jobs-webhook";

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.JOBS_BOT_TOKEN}/setWebhook`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: env.JOBS_WEBHOOK_SECRET,
          allowed_updates: [
            "message",
            "callback_query",
          ],
        }),
      }
    );

    const result = await response.json();

    if (!result?.ok) {
      console.error(
        "Telegram setWebhook failed:",
        result
      );

      return new Response(
        JSON.stringify({
          ok: false,
          telegram: result,
        }),
        {
          status: 502,
          headers: {
            ...headers,
            "Content-Type": "application/json; charset=UTF-8",
          },
        }
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        message: "SA-MASTER Jobs webhook configured",
        webhook_url: webhookUrl,
        telegram: result,
      }),
      {
        status: 200,
        headers: {
          ...headers,
          "Content-Type": "application/json; charset=UTF-8",
        },
      }
    );

  } catch (err) {
    console.error(
      "Jobs webhook setup failed:",
      err
    );

    return error(
      err?.message || String(err),
      headers,
      500
    );
  }
}


/* =========================================================
 * PUBLIC ROUTES
 * ========================================================= */

const PUBLIC_ROUTES = [

  [
    "GET",
    /^\/$/,
    handleHealth,
    { auth: false }
  ],

  [
    "POST",
    /^\/$/,
    handleCreateRequest,
    { auth: false }
  ],

  [
    "GET",
    /^\/calculator-request\/([^/]+)$/,
    handleGetCalculatorRequest,
    { auth: false }
  ],

  [
    "POST",
    /^\/request\/([^/]+)\/project$/,
    handleUploadRequestProject,
    { auth: false }
  ],

  [
    "POST",
    /^\/telegram-webhook$/,
    handleTelegramWebhook,
    { auth: false }
  ],

  [
    "POST",
    /^\/jobs-webhook$/,
    handleJobsWebhook,
    { auth: false }
  ],

];


/* =========================================================
 * ADMIN ROUTES
 * ========================================================= */

const ADMIN_ROUTES = [

  /*
   * ONE-TIME ROUTE
   *
   * Використовується лише для реєстрації
   * захищеного webhook SA-MASTER Jobs.
   *
   * Після успішного налаштування видалимо.
   */
  [
    "POST",
    /^\/setup-jobs-webhook$/,
    handleSetupJobsWebhook,
    { auth: true }
  ],

  [
    "GET",
    /^\/requests$/,
    handleListRequests,
    { auth: true }
  ],

  [
    "GET",
    /^\/request\/([^/]+)$/,
    handleGetRequest,
    { auth: true }
  ],

  [
    "POST",
    /^\/request\/([^/]+)\/status$/,
    handleUpdateStatus,
    { auth: true }
  ],

  [
    "GET",
    /^\/request\/([^/]+)\/events$/,
    handleGetEvents,
    { auth: true }
  ],

  [
    "POST",
    /^\/request\/([^/]+)\/client$/,
    handleAttachClient,
    { auth: true }
  ],

  [
    "GET",
    /^\/object\/([^/]+)$/,
    handleGetObject,
    { auth: true }
  ],

  [
    "PATCH",
    /^\/object\/([^/]+)$/,
    handleUpdateObject,
    { auth: true }
  ],

  [
    "POST",
    /^\/object\/([^/]+)\/file$/,
    handleUploadFile,
    { auth: true }
  ],

  [
    "GET",
    /^\/object\/([^/]+)\/files$/,
    handleListFiles,
    { auth: true }
  ],

  [
    "GET",
    /^\/object\/([^/]+)\/file\/(\d+)$/,
    handleDownloadFile,
    { auth: true }
  ],

];


/* =========================================================
 * ROUTERS
 * ========================================================= */

const routePublic = createRouter(PUBLIC_ROUTES);
const routeAdmin = createRouter(ADMIN_ROUTES);


/* =========================================================
 * WORKER
 * ========================================================= */

export default {

  async fetch(request, env, ctx) {

    /* -----------------------------------------------------
     * CORS preflight
     * ----------------------------------------------------- */

    if (request.method === "OPTIONS") {
      return preflight();
    }


    const headers = corsHeaders();
    const url = new URL(request.url);


    try {

      /* ===================================================
       * PUBLIC ROUTES
       * =================================================== */

      const pub = await routePublic(
        request,
        url
      );


      if (pub) {

        /*
         * Основний Telegram webhook.
         *
         * Telegram повинен передавати:
         *
         * X-Telegram-Bot-Api-Secret-Token
         *
         * Значення повинно збігатися з
         * TELEGRAM_WEBHOOK_SECRET у Cloudflare.
         */

        if (url.pathname === "/telegram-webhook") {

          const webhookError =
            requireTelegramWebhookSecret(
              request,
              env,
              "TELEGRAM_WEBHOOK_SECRET",
              headers
            );

          if (webhookError) {
            return webhookError;
          }

        }


        /*
         * SA-MASTER Jobs webhook.
         *
         * Telegram повинен передавати:
         *
         * X-Telegram-Bot-Api-Secret-Token
         *
         * Значення повинно збігатися з
         * JOBS_WEBHOOK_SECRET у Cloudflare.
         */

        if (url.pathname === "/jobs-webhook") {

          const webhookError =
            requireTelegramWebhookSecret(
              request,
              env,
              "JOBS_WEBHOOK_SECRET",
              headers
            );

          if (webhookError) {
            return webhookError;
          }

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


      /* ===================================================
       * ADMIN API ROUTES
       * =================================================== */

      const admin = await routeAdmin(
        request,
        url
      );


      if (admin) {

        const authError =
          requireAuth(
            request,
            env,
            headers
          );


        if (authError) {
          return authError;
        }


        return await admin.handler(
          request,
          env,
          headers,
          admin.params,
          url,
          ctx
        );

      }


      /* ===================================================
       * 404
       * =================================================== */

      return error(
        "Not found",
        headers,
        404
      );

    } catch (err) {

      /* ===================================================
       * GLOBAL ERROR HANDLER
       * =================================================== */

      console.error(
        "Unhandled error:",
        err
      );


      return error(
        err?.message || String(err),
        headers,
        500
      );

    }

  },

};