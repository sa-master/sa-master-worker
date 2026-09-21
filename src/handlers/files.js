import { json, error } from "../lib/json.js";
import { str } from "../lib/validate.js";

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_CONTENT_LENGTH = 30 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
  "text/plain",
]);

const DANGEROUS_INLINE = /^(text\/html|image\/svg\+xml|application\/xhtml\+xml|text\/xml|application\/xml)$/i;

function sanitizeName(name) {
  return String(name || "file")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180) || "file";
}

export async function handleUploadFile(request, env, headers, params) {
  const [objectCode] = params;

  if (!env.FILES) return error("R2 binding FILES не підключений", headers, 500);

  const cl = Number(request.headers.get("Content-Length") || 0);
  if (cl && cl > MAX_CONTENT_LENGTH) return error("Занадто великий запит", headers, 413);

  const object = await env.DB.prepare(
    `SELECT id, object_code, name FROM objects WHERE object_code = ? LIMIT 1`
  ).bind(objectCode).first();

  if (!object) return error("Об'єкт не знайдено", headers, 404);

  let formData;
  try { formData = await request.formData(); }
  catch { return error("Очікується multipart/form-data", headers, 400); }

  const file = formData.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    return error("Файл не переданий. Використай поле file.", headers, 400);
  }
  if (file.size > MAX_FILE_SIZE) {
    return error(`Файл завеликий. Максимум ${MAX_FILE_SIZE / 1024 / 1024} МБ`, headers, 413);
  }

  const mime = file.type || "application/octet-stream";
  if (!ALLOWED_MIME.has(mime)) {
    return error("Тип файлу не дозволений: " + mime, headers, 415);
  }

  const originalName = str(file.name, { max: 200 }) || "file";
  const safeName = sanitizeName(originalName);
  const folder = str(formData.get("folder"), { max: 60 }) || "documents";
  const uploadedBy = str(formData.get("uploaded_by"), { max: 80 }) || "system";

  const storageKey = `objects/${object.object_code}/${folder}/${Date.now()}-${safeName}`;

  const arrayBuffer = await file.arrayBuffer();

  await env.FILES.put(storageKey, arrayBuffer, {
    httpMetadata: { contentType: mime },
  });

  const versionRow = await env.DB.prepare(`
    SELECT COALESCE(MAX(version), 0) + 1 AS next_version
    FROM files WHERE object_id = ? AND name = ?
  `).bind(object.id, originalName).first();

  const version = Number(versionRow?.next_version || 1);

  const insertResult = await env.DB.prepare(`
    INSERT INTO files (object_id, name, file_type, storage_key, version, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(object.id, originalName, mime, storageKey, version, uploadedBy).run();

  if (!insertResult.meta?.last_row_id) {
    try { await env.FILES.delete(storageKey); } catch (e) { console.error("R2 cleanup:", e); }
    return error("Файл у R2, але метадані не вдалося записати в D1", headers, 500);
  }

  await env.DB.prepare(`
    INSERT INTO events (object_id, request_id, event_type, content, author_type)
    VALUES (?, NULL, 'file_uploaded', ?, 'system')
  `).bind(object.id, `Додано файл: ${originalName}`).run();

  return json({
    ok: true,
    file: {
      id: insertResult.meta.last_row_id,
      object_id: object.id,
      object_code: object.object_code,
      name: originalName,
      file_type: mime,
      storage_key: storageKey,
      version,
      uploaded_by: uploadedBy,
      size: file.size || arrayBuffer.byteLength,
    },
  }, headers);
}

export async function handleListFiles(request, env, headers, params) {
  const [objectCode] = params;

  const object = await env.DB.prepare(
    `SELECT id, object_code, name FROM objects WHERE object_code = ? LIMIT 1`
  ).bind(objectCode).first();

  if (!object) return error("Об'єкт не знайдено", headers, 404);

  const files = await env.DB.prepare(`
    SELECT id, object_id, name, file_type, storage_key, version, uploaded_by, created_at
    FROM files WHERE object_id = ?
    ORDER BY created_at DESC, id DESC
  `).bind(object.id).all();

  return json({
    ok: true,
    object: { id: object.id, object_code: object.object_code, name: object.name },
    files: files.results || [],
  }, headers);
}

export async function handleDownloadFile(request, env, headers, params) {
  const [objectCode, fileIdStr] = params;

  if (!env.FILES) return error("R2 binding FILES не підключений", headers, 500);

  const fileId = Number(fileIdStr);
  if (!Number.isInteger(fileId) || fileId <= 0) {
    return error("Некоректний ID файлу", headers, 400);
  }

  const file = await env.DB.prepare(`
    SELECT f.id, f.object_id, f.name, f.file_type, f.storage_key, o.object_code
    FROM files f
    INNER JOIN objects o ON o.id = f.object_id
    WHERE f.id = ? AND o.object_code = ?
    LIMIT 1
  `).bind(fileId, objectCode).first();

  if (!file) return error("Файл не знайдено", headers, 404);

  const storedObject = await env.FILES.get(file.storage_key);
  if (!storedObject) {
    return error("Файл є в базі, але відсутній у R2", headers, 404);
  }

  const contentType =
    storedObject.httpMetadata?.contentType ||
    file.file_type ||
    "application/octet-stream";

  const disposition = DANGEROUS_INLINE.test(contentType) ? "attachment" : "inline";
  const encodedName = encodeURIComponent(file.name || "file");

  return new Response(storedObject.body, {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": contentType,
      "Content-Length": String(storedObject.size),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}