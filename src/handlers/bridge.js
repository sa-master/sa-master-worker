import { publishRequestToJobs as publishToOldJobs } from "./jobs.js";
import { sendTelegram } from "../lib/telegram.js";

/*
 * Міст у новий SA-MASTER Jobs.
 *
 * Якщо в Worker задано NEW_JOBS_URL і BRIDGE_SECRET, заявка передається
 * в новий бот. Якщо хоч одного з них немає, працює старий Jobs, як раніше.
 */
export async function publishRequestToJobs(env, request) {
  if (!env.NEW_JOBS_URL || !env.BRIDGE_SECRET) {
    return publishToOldJobs(env, request);
  }

  const req = request?.id
    ? await env.DB.prepare("SELECT * FROM requests WHERE id = ? LIMIT 1").bind(request.id).first()
    : await env.DB.prepare("SELECT * FROM requests WHERE request_code = ? LIMIT 1").bind(request?.request_code).first();

  if (!req) return { ok: false, description: "Заявку не знайдено" };

  if (Number(req.transferred_to_jobs || 0) === 1) {
    return { ok: true, already_published: true, request_code: req.request_code };
  }

  const claim = await env.DB.prepare(`
    UPDATE requests
    SET transferred_to_jobs = 1, transferred_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND COALESCE(transferred_to_jobs, 0) = 0
  `).bind(req.id).run();

  if (!claim.meta?.changes) {
    return { ok: true, already_published: true, request_code: req.request_code };
  }

  async function rollback() {
    try {
      await env.DB.prepare(`
        UPDATE requests
        SET transferred_to_jobs = 0, transferred_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(req.id).run();
    } catch (err) {
      console.error("Bridge rollback failed:", err);
    }
  }

  let details = null;
  try {
    details = req.request_details ? JSON.parse(req.request_details) : null;
  } catch {
    details = null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${String(env.NEW_JOBS_URL).replace(/\/$/, "")}/site-request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Secret": env.BRIDGE_SECRET,
      },
      body: JSON.stringify({
        request_code: req.request_code,
        name: req.name,
        phone: req.phone,
        type: req.type,
        type_label: req.type_label,
        work_scope: req.work_scope,
        object_type: req.object_type,
        location: req.location,
        address: req.address,
        timing: req.timing,
        project: req.project,
        notes: req.notes,
        request_details: details,
      }),
      signal: controller.signal,
    });

    const raw = await res.text().catch(() => "");
    let data = {};
    try { data = JSON.parse(raw); } catch { data = {}; }

    if (!res.ok || !data.ok) {
      await rollback();
      const why = data.error || `HTTP ${res.status} ${String(raw).slice(0, 120)}`.trim();
      await sendTelegram(env, `⚠️ Міст у новий Jobs не спрацював (${req.request_code}): ${why}`);
      return { ok: false, description: why };
    }

    return { ok: true, request_code: req.request_code, new_request_id: data.request_id };
  } catch (err) {
    await rollback();
    const why = String(err?.message || err);
    await sendTelegram(env, `⚠️ Міст у новий Jobs не спрацював (${req.request_code}): ${why}`);
    return { ok: false, description: why };
  } finally {
    clearTimeout(timer);
  }
}
