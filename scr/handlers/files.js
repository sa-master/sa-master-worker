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

  const storageKey = `objects/${object.object_code}/${folder}/${
