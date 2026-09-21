export function str(value, { max = 500, required = false } = {}) {
  const s = String(value ?? "").trim();
  if (required && !s) return null;
  return s.slice(0, max);
}

export function num(value, { required = false, min = -Infinity, max = Infinity } = {}) {
  if (value === null || value === undefined || value === "") {
    return required ? null : undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

export function dateStr(value, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    return required ? null : undefined;
  }
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  return s.slice(0, 10);
}
