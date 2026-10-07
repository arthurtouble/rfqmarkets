const response = (error, status, headers = {}) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export async function admitAtEdge(request, env) {
  const client = request.headers.get("cf-connecting-ip");
  if (!client) return response("edge_identity_missing", 403);
  const write = !["GET", "HEAD"].includes(request.method),
    clientLimiter = write ? env.PUBLIC_WRITE_LIMIT : env.PUBLIC_READ_LIMIT,
    globalLimiter = write ? env.GLOBAL_WRITE_LIMIT : env.GLOBAL_READ_LIMIT;
  if (!clientLimiter || !globalLimiter) return response("edge_admission_unavailable", 503);
  try {
    const [perClient, global] = await Promise.all([
      clientLimiter.limit({ key: client }),
      globalLimiter.limit({ key: "public-origin" }),
    ]);
    if (!perClient.success || !global.success)
      return response("rate_limit_exceeded", 429, { "retry-after": "10" });
    return null;
  } catch {
    return response("edge_admission_unavailable", 503);
  }
}
