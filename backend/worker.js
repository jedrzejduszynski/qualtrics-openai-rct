const OPENAI_URL = "https://api.openai.com/v1/responses";

const SYSTEM_PROMPTS = {
  socratic: `You are a Socratic creativity assistant.

Your role is to help the participant develop, examine, and refine their own ideas. Surface assumptions, encourage comparison of alternatives, and invite the participant to articulate their reasoning.

Do not take over authorship. Do not provide a complete final submission for the participant. Do not simply list finished ideas unless the participant has first developed them and a brief example is necessary to support reflection. Keep responses concise, constructive, and directly connected to the participant's latest message.`,

  unrestricted: `You are a helpful creativity assistant in a research study.

Respond directly and usefully to the participant's requests. You may suggest, develop, compare, rewrite, or improve ideas and may provide concrete examples or draft material. Keep responses concise, constructive, and directly connected to the participant's latest message.`
};

const TASK_CONTEXTS = {
  main: ``
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
    const corsHeaders = makeCorsHeaders(origin, allowedOrigins);

    if (request.method === "OPTIONS") {
      if (url.pathname !== "/chat" || !allowedOrigins.has(origin)) {
        return json({ error: "Forbidden origin" }, 403, corsHeaders);
      }
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        status: "ok",
        service: "qualtrics-openai-rct",
        version: env.EXPERIMENT_VERSION || "dev"
      }, 200, corsHeaders);
    }

    if (url.pathname === "/session" && request.method === "POST") {
      return createSession(request, env);
    }

    if (url.pathname === "/chat" && request.method === "POST") {
      if (!allowedOrigins.has(origin)) {
        return json({ error: "Forbidden origin" }, 403, corsHeaders);
      }
      return chat(request, env, corsHeaders);
    }

    return json({ error: "Not found" }, 404, corsHeaders);
  }
};

async function createSession(request, env) {
  if (!env.QUALTRICS_SESSION_KEY || !env.SESSION_SIGNING_SECRET) {
    return json({ error: "Session service is not configured" }, 500);
  }

  const suppliedKey = request.headers.get("X-Study-Key") || bearerToken(request);
  if (!suppliedKey || !constantTimeStringEqual(suppliedKey, env.QUALTRICS_SESSION_KEY)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await safeJson(request);
  if (!body) return json({ error: "Invalid JSON" }, 400);

  const participantId = cleanString(body.participant_id, 200);
  const arm = body.arm === "socratic" ? "socratic" : body.arm === "unrestricted" ? "unrestricted" : "";

  if (!participantId || !arm) {
    return json({ error: "participant_id and a valid arm are required" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = clampInteger(env.SESSION_TTL_SECONDS, 900, 86400, 14400);
  const expiresAt = now + ttl;
  const participantHash = await sha256Base64Url(participantId);

  const payload = {
    sub: participantHash,
    arm,
    iat: now,
    exp: expiresAt,
    jti: crypto.randomUUID(),
    experiment: String(env.EXPERIMENT_VERSION || "dev")
  };

  const sessionToken = await signToken(payload, env.SESSION_SIGNING_SECRET);

  return json({
    session_token: sessionToken,
    session_expires_at: new Date(expiresAt * 1000).toISOString(),
    assigned_arm: arm,
    experiment_version: payload.experiment
  }, 200);
}

async function chat(request, env, corsHeaders) {
  if (!env.OPENAI_API_KEY || !env.SESSION_SIGNING_SECRET) {
    return json({ error: "Chat service is not configured" }, 500, corsHeaders);
  }

  const token = bearerToken(request);
  if (!token) return json({ error: "Missing session token" }, 401, corsHeaders);

  const session = await verifyToken(token, env.SESSION_SIGNING_SECRET);
  if (!session.ok) {
    return json({ error: session.error }, 401, corsHeaders);
  }

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 120000) {
    return json({ error: "Request too large" }, 413, corsHeaders);
  }

  const body = await safeJson(request);
  if (!body) return json({ error: "Invalid JSON" }, 400, corsHeaders);

  const messages = sanitizeMessages(body.messages);
  if (!messages.some((message) => message.role === "user")) {
    return json({ error: "At least one user message is required" }, 400, corsHeaders);
  }

  const taskId = cleanString(body.task_id, 50) || "main";
  const taskContext = TASK_CONTEXTS[taskId] || TASK_CONTEXTS.main;
  const model = String(env.OPENAI_MODEL || "gpt-5.6-luna");
  const maxOutputTokens = clampInteger(env.MAX_OUTPUT_TOKENS, 100, 2000, 700);
  const instructions = `${SYSTEM_PROMPTS[session.payload.arm]}\n\nResearcher-provided task context:\n${taskContext}`;
  const startedAt = Date.now();

  let upstream;
  try {
    upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        instructions,
        input: messages,
        max_output_tokens: maxOutputTokens,
        store: false
      })
    });
  } catch {
    return json({ error: "Could not reach OpenAI" }, 502, corsHeaders);
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return json({ error: "Invalid response from OpenAI" }, 502, corsHeaders);
  }

  if (!upstream.ok) {
    return json({
      error: "OpenAI request failed",
      status: upstream.status,
      detail: data?.error?.message || "Unknown upstream error",
      request_id: upstream.headers.get("x-request-id") || null
    }, upstream.status, corsHeaders);
  }

  const content = extractOutputText(data);
  if (!content) {
    return json({ error: "OpenAI returned no text" }, 502, corsHeaders);
  }

  return json({
    response_id: data.id || null,
    request_id: upstream.headers.get("x-request-id") || null,
    content,
    model: data.model || model,
    arm: session.payload.arm,
    experiment_version: session.payload.experiment,
    latency_ms: Date.now() - startedAt,
    usage: data.usage || null
  }, 200, corsHeaders);
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .slice(-30)
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .map((message) => ({
      role: message.role,
      content: cleanString(message.content, 10000)
    }))
    .filter((message) => message.content.length > 0);
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  if (!Array.isArray(data?.output)) return "";

  return data.output
    .filter((item) => item?.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function signToken(payload, secret) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

async function verifyToken(token, secret) {
  const parts = String(token).split(".");
  if (parts.length !== 2) return { ok: false, error: "Invalid session token" };

  const [encodedPayload, suppliedSignature] = parts;
  const expectedSignature = await hmacSha256(encodedPayload, secret);
  if (!constantTimeStringEqual(suppliedSignature, expectedSignature)) {
    return { ok: false, error: "Invalid session token" };
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return { ok: false, error: "Invalid session token" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return { ok: false, error: "Session expired" };
  if (payload.arm !== "socratic" && payload.arm !== "unrestricted") {
    return { ok: false, error: "Invalid session arm" };
  }

  return { ok: true, payload };
}

async function hmacSha256(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function bearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function parseList(raw) {
  return new Set(String(raw || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function makeCorsHeaders(origin, allowedOrigins) {
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function cleanString(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function clampInteger(rawValue, min, max, fallback) {
  const value = Number.parseInt(String(rawValue ?? ""), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function constantTimeStringEqual(a, b) {
  const first = new TextEncoder().encode(String(a));
  const second = new TextEncoder().encode(String(b));
  const length = Math.max(first.length, second.length);
  let mismatch = first.length ^ second.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (first[index] || 0) ^ (second[index] || 0);
  }
  return mismatch === 0;
}

function base64UrlEncode(text) {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

function base64UrlDecode(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(payload, status, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}
