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

  if (left.length !== right.length) {
    return false;
  }

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