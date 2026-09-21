import { error } from "./json.js";

export function requireAuth(request, env, headers) {
  if (!env.ADMIN_TOKEN) {
    return error("Server misconfigured: ADMIN_TOKEN не встановлено", headers, 500);
  }
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || token !== env.ADMIN_TOKEN) {
    return error("Unauthorized", headers, 401);
  }
  return null;
}

// Постійний час порівняння (захист від timing-атак)
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
