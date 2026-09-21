export function createRouter(routes) {
  return async function match(request, url) {
    for (const [method, pattern, handler, options] of routes) {
      if (request.method !== method) continue;
      const m = url.pathname.match(pattern);
      if (!m) continue;
      const params = m.slice(1).map((p) => {
        try { return decodeURIComponent(p); }
        catch { return p; }
      });
      return { handler, params, options: options || {} };
    }
    return null;
  };
}
