import { corsHeaders, preflight } from "./lib/cors.js";
import { error } from "./lib/json.js";
import { requireAuth } from "./lib/auth.js";
import { createRouter } from "./lib/router.js";

import { handleHealth } from "./handlers/health.js";
import {
  handleCreateRequest,
  handleListRequests,
  handleGetRequest,
  handleUpdateStatus,
  handleGetEvents,
  handleAttachClient,
} from "./handlers/requests.js";
import {
  handleGetObject,
  handleUpdateObject,
} from "./handlers/objects.js";
import {
  handleUploadFile,
  handleListFiles,
  handleDownloadFile,
} from "./handlers/files.js";

const PUBLIC_ROUTES = [
  ["GET",  /^\/$/, handleHealth,        { auth: false }],
  ["POST", /^\/$/, handleCreateRequest, { auth: false }],
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
const routeAdmin  = createRouter(ADMIN_ROUTES);

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return preflight();

    const headers = corsHeaders();
    const url = new URL(request.url);

    try {
      const pub = await routePublic(request, url);
      if (pub) return await pub.handler(request, env, headers, pub.params, url);

      const admin = await routeAdmin(request, url);
      if (admin) {
        const authError = requireAuth(request, env, headers);
        if (authError) return authError;
        return await admin.handler(request, env, headers, admin.params, url);
      }

      return error("Not found", headers, 404);
    } catch (err) {
      console.error("Unhandled error:", err);
      return error(err?.message || String(err), headers, 500);
    }
  },
};
