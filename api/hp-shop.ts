const STORE_DOMAIN = "harry-potter-unified.myshopify.com";
const STOREFRONT_API_VERSION = "2024-10";
const UPSTREAM = `https://${STORE_DOMAIN}/api/${STOREFRONT_API_VERSION}/graphql.json`;

/** Bumped whenever proxy behavior changes; visible on GET /api/hp-shop (verify production deploy). */
const HANDLER_REVISION = "2026-06-03-v1-hp-shop-smoke";

type VercelRequest = import("@vercel/node").VercelRequest;
type VercelResponse = import("@vercel/node").VercelResponse;

function getStorefrontToken(): string | undefined {
  const token = process.env.SHOPIFY_HP_STOREFRONT_TOKEN;
  return typeof token === "string" && token.trim() ? token.trim() : undefined;
}

function sendJson(res: VercelResponse, statusCode: number, payload: unknown): void {
  res.setHeader("X-Fetchly-HP-Shop-Proxy", HANDLER_REVISION);
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
        proxy: "hp-shop",
        revision: HANDLER_REVISION,
        store: STORE_DOMAIN,
        storefrontApiVersion: STOREFRONT_API_VERSION,
        upstream: new URL(UPSTREAM).host,
        tokenConfigured: Boolean(getStorefrontToken()),
        postHint: "POST JSON { query, variables? } to proxy Shopify Storefront GraphQL",
      });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const token = getStorefrontToken();
    if (!token) {
      sendJson(res, 500, {
        error: "MissingStorefrontToken",
        message: "Set SHOPIFY_HP_STOREFRONT_TOKEN in the Vercel project environment.",
        proxyRevision: HANDLER_REVISION,
      });
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
          "X-Shopify-Storefront-Access-Token": token,
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
        body: upstreamPayload,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      sendJson(res, 502, {
        error: "UpstreamFetchFailed",
        message: `Could not reach Shopify Storefront API: ${message}`,
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
    console.error("HP Shop proxy error:", error);
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, {
      error: "Proxy error",
      message,
      proxyRevision: HANDLER_REVISION,
    });
  }
}

module.exports = handler;

export {};
