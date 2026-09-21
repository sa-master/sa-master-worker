export function json(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function error(message, headers = {}, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, headers, status);
}
