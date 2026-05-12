const UPSTREAM = "https://wme-gep-graphql-qa.wme-digital.com/graphql"; // QA endpoint (PROD requires auth)

/** Bumped whenever proxy behavior changes; visible on GET /api/graphql (verify production deploy). */
const HANDLER_REVISION = "2026-05-12-v6-sendJson-health";

type VercelRequest = import("@vercel/node").VercelRequest;
type VercelResponse = import("@vercel/node").VercelResponse;

/** @see https://vercel.com/docs/functions/configuring-functions */
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4mb",
    },
  },
};

function sendJson(res: VercelResponse, statusCode: number, payload: unknown): void {
  res.setHeader("X-Currently-GraphQL-Proxy", HANDLER_REVISION);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        error: "ResponseSerializeFailed",
        message,
        proxyRevision: HANDLER_REVISION,
      })
    );
    return;
  }
  res.statusCode = statusCode;
  res.end(serialized);
}

function normalizeBody(req: VercelRequest): Record<string, unknown> | null {
  let body = req.body as unknown;
  if (body == null) return {};

  if (Buffer.isBuffer(body)) {
    const s = body.toString("utf8");
    if (!s.trim()) return {};
    try {
      body = JSON.parse(s) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof body === "string") {
    if (!body.trim()) return {};
    try {
      body = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  if (typeof body !== "object" || body === null) return {};
  return body as Record<string, unknown>;
}

type SafeJsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; snippet: string };

function safeJsonParse(raw: string): SafeJsonParseResult {
  const text = typeof raw === "string" ? raw : "";
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    const snippet = text.replace(/\s+/g, " ").slice(0, 200);
    return { ok: false, snippet };
  }
}

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, Cache-Control, Pragma"
    );

    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    if (req.method === "OPTIONS") {
      res.statusCode = 200;
      res.end();
      return;
    }

    if (req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        proxy: "graphql",
        revision: HANDLER_REVISION,
        upstream: new URL(UPSTREAM).host,
        postHint: "POST JSON { query, variables? } to proxy GraphQL",
      });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const body = normalizeBody(req);
    if (body === null) {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    let upstreamPayload: string;
    try {
      upstreamPayload = JSON.stringify({
        query: body.query,
        variables: body.variables,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      sendJson(res, 400, { error: "Invalid request body", message });
      return;
    }

    let fetchRes: Response;
    try {
      fetchRes = await fetch(UPSTREAM, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
        body: upstreamPayload,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      sendJson(res, 502, {
        error: "UpstreamFetchFailed",
        message: `Could not reach GraphQL upstream: ${message}`,
      });
      return;
    }

    const raw = await fetchRes.text();
    const parsed = safeJsonParse(raw);

    if (parsed.ok === false) {
      const snippet = parsed.snippet;
      const startsHtml = raw.trimStart().startsWith("<");
      const hint = startsHtml
        ? "Upstream returned HTML (gateway/WAF/maintenance), not GraphQL JSON."
        : "Upstream response was not valid JSON.";
      const ct = fetchRes.headers.get("content-type") || "";
      const statusOut = fetchRes.status >= 400 ? fetchRes.status : 502;
      sendJson(res, statusOut, {
        error: "UpstreamNonJson",
        message: `${hint} HTTP ${fetchRes.status}${ct ? ` content-type=${ct}` : ""}.${snippet ? ` Preview: ${snippet}${raw.length > 200 ? "…" : ""}` : ""}`,
        proxyRevision: HANDLER_REVISION,
      });
      return;
    }

    sendJson(res, fetchRes.status, parsed.value);
  } catch (error: unknown) {
    console.error("Proxy error:", error);
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, {
      error: "Proxy error",
      message,
      proxyRevision: HANDLER_REVISION,
    });
  }
}

module.exports = handler;
