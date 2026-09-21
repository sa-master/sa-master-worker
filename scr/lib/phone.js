export function normalizePhone(input) {
  const digits = String(input || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 12 && digits.startsWith("380")) return "+" + digits;
  if (digits.length === 11 && digits.startsWith("80"))  return "+3" + digits;
  if (digits.length === 10 && digits.startsWith("0"))   return "+38" + digits;
  if (digits.length === 9)                              return "+380" + digits;
  if (digits.length < 10) return "";
  return "+" + digits;
}

export function isValidPhone(input) {
  return normalizePhone(input).length >= 13;
}
