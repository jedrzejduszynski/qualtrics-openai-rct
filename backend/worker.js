
/**
 * Qualtrics creativity RCT - Cloudflare Worker with D1 conversation logging
 *
 * Deploy this as a REPLACEMENT for the existing Worker code.
 * Assumes the D1 tables `sessions`, `turns` and `events` already exist,
 * using the schema created in the preceding Qualtrics/Cloudflare setup.
 *
 * REQUIRED WORKER BINDING: DB (D1 database)
 * REQUIRED SECRETS: OPENAI_API_KEY, QUALTRICS_SESSION_KEY, SESSION_SIGNING_SECRET
 * EXISTING VARIABLES: ALLOWED_ORIGINS, OPENAI_MODEL, MAX_OUTPUT_TOKENS,
 *                     SESSION_TTL_SECONDS, EXPERIMENT_VERSION
 * OPTIONAL VARIABLE: MAX_PROMPTS (default 50)
 *
 * /session  POST - Qualtrics Web Service only; authenticates X-Study-Key.
 * /chat     POST - authenticated browser request; records prompt before API call,
 *                  then response or failure; returns turn_id to the client.
 * /events   POST - optional authenticated browser events, e.g. response_displayed.
 * /health   GET  - health check (does not expose conversation content).
 *
 * NOTE: The participant_id submitted by Qualtrics must equal the same
 *       ChatStudyID embedded-data field exported from the survey.
 */

const OPENAI_URL = "https://api.openai.com/v1/responses";

// These instructions have been preserved from the supplied Worker.
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

// Client-side event categories. The Worker automatically logs API activity.
// Extra interaction events require a small change to your chatbot iframe.
const ALLOWED_CLIENT_EVENTS = new Set([
  "chat_opened", "chat_closed", "page_visible", "page_hidden",
  "input_focused", "input_blurred", "response_displayed",
  "task_started", "session_ended", "copy_clicked"
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
    const corsHeaders = makeCorsHeaders(origin, allowedOrigins);

    try {
      if (request.method === "OPTIONS") {
        if (!["/chat", "/events"].includes(url.pathname) || !allowedOrigins.has(origin)) {
          return json({ error: "Forbidden origin" }, 403, corsHeaders);
        }
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (url.pathname === "/health" && request.method === "GET") {
        return json({
          status: "ok",
          service: "qualtrics-openai-rct",
          version: env.EXPERIMENT_VERSION || "dev",
          d1_binding_configured: Boolean(env.DB)
        }, 200, corsHeaders);
      }

      if (url.pathname === "/session" && request.method === "POST") {
        // No CORS access: the Qualtrics Web Service calls this from the server.
        return createSession(request, env);
      }

      if (url.pathname === "/chat" && request.method === "POST") {
        if (!allowedOrigins.has(origin)) {
          return json({ error: "Forbidden origin" }, 403, corsHeaders);
        }
        return chat(request, env, corsHeaders);
      }

      if (url.pathname === "/events" && request.method === "POST") {
        if (!allowedOrigins.has(origin)) {
          return json({ error: "Forbidden origin" }, 403, corsHeaders);
        }
        return receiveClientEvent(request, env, corsHeaders);
      }

      return json({ error: "Not found" }, 404, corsHeaders);
    } catch (error) {
      // Never log messages, participant IDs, API secrets or authentication tokens.
      console.error("Unhandled Worker error:", safeErrorCode(error));
      return json({ error: "Internal server error" }, 500, corsHeaders);
    }
  }
};

// ---- Qualtrics-only endpoint: create an authenticated, recorded session ----

async function createSession(request, env) {
  if (!env.DB) return json({ error: "D1 database binding DB is missing" }, 503);
  if (!env.QUALTRICS_SESSION_KEY || !env.SESSION_SIGNING_SECRET) {
    return json({ error: "Session service is not configured" }, 500);
  }

  const suppliedKey = request.headers.get("X-Study-Key") || bearerToken(request);
  if (!suppliedKey || !constantTimeStringEqual(suppliedKey, env.QUALTRICS_SESSION_KEY)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await safeJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Keep the original request shape: participant_id + arm.
  // Ensure Qualtrics sends its ChatStudyID here (not a newly generated ID).
  const participantId = cleanString(body.participant_id, 200);
  const arm = body.arm === "socratic" ? "socratic"
    : body.arm === "unrestricted" ? "unrestricted" : "";

  if (!participantId || !arm) {
    return json({ error: "participant_id and a valid arm are required" }, 400);
  }

  // Catch accidental Qualtrics piped-text failures before they enter the data.
  if (participantId.includes("${") || participantId === "undefined" || participantId === "null") {
    return json({ error: "Qualtrics did not supply a valid participant_id" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = clampInteger(env.SESSION_TTL_SECONDS, 900, 86400, 14400);
  const expiresAt = now + ttl;
  const participantHash = await sha256Base64Url(participantId);
  const model = String(env.OPENAI_MODEL || "gpt-5.6-luna");

  // Detect code changes to the treatment prompt without requiring a migration.
  // The complete instruction text remains in this versioned Worker source.
  const promptFingerprint = await sha256Hex(JSON.stringify({ system_prompt: SYSTEM_PROMPTS[arm], task_contexts: TASK_CONTEXTS }));
  const promptVersion = `${arm}-${promptFingerprint.slice(0, 16)}`;

  const payload = {
    sub: participantHash,
    arm,
    iat: now,
    exp: expiresAt,
    jti: crypto.randomUUID(),
    experiment: String(env.EXPERIMENT_VERSION || "dev")
  };

  // Fail closed: do not mint usable tokens if the study cannot log the session.
  try {
    await env.DB.prepare(`
      INSERT INTO sessions
        (conversation_id, study_id, condition, model, prompt_version, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      payload.jti,
      participantId,
      arm,
      model,
      promptVersion,
      new Date().toISOString()
    ).run();
  } catch (error) {
    console.error("D1 session insert failed:", safeErrorCode(error));
    return json({ error: "Could not create recorded study session" }, 503);
  }

  const sessionToken = await signToken(payload, env.SESSION_SIGNING_SECRET);
  await bestEffortEvent(env, payload.jti, null, "session_created", { arm });

  return json({
    session_token: sessionToken,
    session_expires_at: new Date(expiresAt * 1000).toISOString(),
    assigned_arm: arm,
    experiment_version: payload.experiment,
    conversation_id: payload.jti
  }, 200);
}

// ---- Chat endpoint: record request BEFORE OpenAI and result AFTER OpenAI ----

async function chat(request, env, corsHeaders) {
  if (!env.DB) return json({ error: "D1 database binding DB is missing" }, 503, corsHeaders);
  if (!env.OPENAI_API_KEY || !env.SESSION_SIGNING_SECRET) {
    return json({ error: "Chat service is not configured" }, 500, corsHeaders);
  }

  const auth = await authenticateSession(request, env);
  if (!auth.ok) return json({ error: auth.error }, auth.status, corsHeaders);
  const { payload, conversationId } = auth;

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 120000) return json({ error: "Request too large" }, 413, corsHeaders);

  const body = await safeJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid JSON" }, 400, corsHeaders);
  }

  // The iframe normally sends the complete conversation history. Only the
  // LAST user message is the *new* prompt. Do not re-log prior history.
  const messages = sanitizeMessages(body.messages);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return json({ error: "The latest message must be a user prompt" }, 400, corsHeaders);
  }
  const userMessage = messages[messages.length - 1].content;

  const taskId = cleanString(body.task_id, 50) || "main";
  const taskContext = TASK_CONTEXTS[taskId] || TASK_CONTEXTS.main;
  const model = String(env.OPENAI_MODEL || "gpt-5.6-luna");
  const maxOutputTokens = clampInteger(env.MAX_OUTPUT_TOKENS, 100, 2000, 700);
  const maxPrompts = 500;
  const instructions = `${SYSTEM_PROMPTS[payload.arm]}\n\nResearcher-provided task context:\n${taskContext}`;

  // Atomic assignment of the next turn number, with a server-side prompt cap.
  // SQL RETURNING is supported by D1's SQLite engine.
  const turnId = crypto.randomUUID();
  const promptSubmittedAt = new Date().toISOString();
  let inserted;
  try {
    inserted = await env.DB.prepare(`
      INSERT INTO turns
        (turn_id, conversation_id, turn_number, user_message, prompt_submitted_at, status)
      SELECT ?, ?, COALESCE(MAX(turn_number), 0) + 1, ?, ?, 'pending'
      FROM turns
      WHERE conversation_id = ?
      HAVING COALESCE(MAX(turn_number), 0) < ?
      RETURNING turn_number
    `).bind(
      turnId, conversationId, userMessage, promptSubmittedAt, conversationId, maxPrompts
    ).first();
  } catch (error) {
    console.error("D1 prompt insert failed:", safeErrorCode(error));
    return json({ error: "Could not record prompt; it was not sent to OpenAI" }, 503, corsHeaders);
  }

  if (!inserted) {
    await bestEffortEvent(env, conversationId, null, "prompt_limit_reached", { limit: maxPrompts });
    return json({ error: "Prompt limit reached", limit: maxPrompts }, 429, corsHeaders);
  }
  const turnNumber = inserted.turn_number;
  await bestEffortEvent(env, conversationId, turnId, "prompt_submitted", {
    task_id: taskId,
    context_message_count: messages.length,
    configured_model: model,
    max_output_tokens: maxOutputTokens
  }, promptSubmittedAt);

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
    await recordFailure(env, conversationId, turnId, startedAt, "network_error");
    return json({ error: "Could not reach OpenAI", turn_id: turnId }, 502, corsHeaders);
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    await recordFailure(env, conversationId, turnId, startedAt, "invalid_openai_json");
    return json({ error: "Invalid response from OpenAI", turn_id: turnId }, 502, corsHeaders);
  }

  if (!upstream.ok) {
    await recordFailure(env, conversationId, turnId, startedAt, `openai_http_${upstream.status}`);
    return json({
      error: "OpenAI request failed",
      status: upstream.status,
      detail: data?.error?.message || "Unknown upstream error",
      request_id: upstream.headers.get("x-request-id") || null,
      turn_id: turnId
    }, upstream.status, corsHeaders);
  }

  const content = extractOutputText(data);
  if (!content) {
    await recordFailure(env, conversationId, turnId, startedAt, "empty_openai_response");
    return json({ error: "OpenAI returned no text", turn_id: turnId }, 502, corsHeaders);
  }

  const responseCompletedAt = new Date().toISOString();
  const latencyMs = Date.now() - startedAt;
  const usage = data.usage || null;
  try {
    await env.DB.prepare(`
      UPDATE turns SET
        assistant_message = ?,
        response_completed_at = ?,
        latency_ms = ?,
        input_tokens = ?,
        output_tokens = ?,
        status = 'completed',
        error_code = NULL
      WHERE turn_id = ? AND conversation_id = ?
    `).bind(
      content,
      responseCompletedAt,
      latencyMs,
      asNullableInteger(usage?.input_tokens),
      asNullableInteger(usage?.output_tokens),
      turnId,
      conversationId
    ).run();
  } catch (error) {
    // Do not show unlogged AI content to a participant.
    console.error("D1 response update failed:", safeErrorCode(error));
    return json({
      error: "The AI response could not be recorded; please try again",
      turn_id: turnId
    }, 503, corsHeaders);
  }

  // Diagnostic metadata is kept in events, without adding columns to turns.
  await bestEffortEvent(env, conversationId, turnId, "response_completed", {
    response_id: data.id || null,
    request_id: upstream.headers.get("x-request-id") || null,
    model: data.model || model,
    task_id: taskId,
    usage
  }, responseCompletedAt);

  // All original response properties remain; three new identifiers are added.
  return json({
    response_id: data.id || null,
    request_id: upstream.headers.get("x-request-id") || null,
    content,
    model: data.model || model,
    arm: payload.arm,
    experiment_version: payload.experiment,
    latency_ms: latencyMs,
    usage,
    turn_id: turnId,
    turn_number: turnNumber,
    conversation_id: conversationId
  }, 200, corsHeaders);
}

async function recordFailure(env, conversationId, turnId, startedAt, errorCode) {
  const timestamp = new Date().toISOString();
  try {
    await env.DB.prepare(`
      UPDATE turns SET
        response_completed_at = ?,
        latency_ms = ?,
        status = 'failed',
        error_code = ?
      WHERE turn_id = ? AND conversation_id = ?
    `).bind(timestamp, Date.now() - startedAt, errorCode, turnId, conversationId).run();
  } catch (error) {
    console.error("D1 failed-request update failed:", safeErrorCode(error));
    // A row still exists with status='pending', allowing incomplete requests
    // to be identified in the research data rather than silently disappearing.
  }
  await bestEffortEvent(env, conversationId, turnId, "response_failed", {
    error_code: errorCode
  }, timestamp);
}

// ---- Optional browser/UI event endpoint ----

async function receiveClientEvent(request, env, corsHeaders) {
  if (!env.DB) return json({ error: "D1 database binding DB is missing" }, 503, corsHeaders);
  if (!env.SESSION_SIGNING_SECRET) return json({ error: "Session service is not configured" }, 500, corsHeaders);

  const auth = await authenticateSession(request, env);
  if (!auth.ok) return json({ error: auth.error }, auth.status, corsHeaders);

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 6000) return json({ error: "Event too large" }, 413, corsHeaders);

  const body = await safeJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid JSON" }, 400, corsHeaders);
  }

  const eventType = cleanString(body.event_type, 80);
  if (!ALLOWED_CLIENT_EVENTS.has(eventType)) {
    return json({ error: "Unsupported event_type" }, 400, corsHeaders);
  }

  const turnId = body.turn_id == null ? null : cleanString(body.turn_id, 100);
  if (turnId) {
    const ownTurn = await env.DB.prepare(`
      SELECT turn_id FROM turns WHERE turn_id = ? AND conversation_id = ?
    `).bind(turnId, auth.conversationId).first();
    if (!ownTurn) return json({ error: "Unknown turn_id for session" }, 400, corsHeaders);
  }
  if (eventType === "response_displayed" && !turnId) {
    return json({ error: "response_displayed requires turn_id" }, 400, corsHeaders);
  }

  // Client metadata is kept small, with server time as the authoritative time.
  const metadata = isPlainObject(body.metadata) ? body.metadata : {};
  let metadataJson;
  try {
    metadataJson = JSON.stringify({
      ...metadata,
      client_timestamp: typeof body.client_timestamp === "string"
        ? cleanString(body.client_timestamp, 40) : null
    });
  } catch {
    return json({ error: "Invalid event metadata" }, 400, corsHeaders);
  }
  if (metadataJson.length > 3000) return json({ error: "Event metadata too large" }, 413, corsHeaders);

  const serverTime = new Date().toISOString();
  try {
    await insertEvent(env, auth.conversationId, turnId, eventType, metadataJson, serverTime);
    if (eventType === "response_displayed") {
      await env.DB.prepare(`
        UPDATE turns SET response_displayed_at = COALESCE(response_displayed_at, ?)
        WHERE turn_id = ? AND conversation_id = ?
      `).bind(serverTime, turnId, auth.conversationId).run();
    }
    if (eventType === "session_ended") {
      await env.DB.prepare(`
        UPDATE sessions SET ended_at = COALESCE(ended_at, ?)
        WHERE conversation_id = ?
      `).bind(serverTime, auth.conversationId).run();
    }
  } catch (error) {
    console.error("D1 client event insert/update failed:", safeErrorCode(error));
    return json({ error: "Could not record event" }, 503, corsHeaders);
  }
  return json({ ok: true }, 200, corsHeaders);
}

// Verify the signed token AND that its session/participant/arm exist in D1.
async function authenticateSession(request, env) {
  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, error: "Missing session token" };

  const checked = await verifyToken(token, env.SESSION_SIGNING_SECRET);
  if (!checked.ok) return { ok: false, status: 401, error: checked.error };
  const payload = checked.payload;

  if (!payload.jti || !payload.sub) {
    return { ok: false, status: 401, error: "Invalid recorded session" };
  }

  let savedSession;
  try {
    savedSession = await env.DB.prepare(`
      SELECT study_id, condition FROM sessions WHERE conversation_id = ?
    `).bind(payload.jti).first();
  } catch (error) {
    console.error("D1 session lookup failed:", safeErrorCode(error));
    return { ok: false, status: 503, error: "Could not verify recorded session" };
  }

  if (!savedSession || savedSession.condition !== payload.arm) {
    return { ok: false, status: 401, error: "Session not found" };
  }
  const expectedHash = await sha256Base64Url(savedSession.study_id);
  if (!constantTimeStringEqual(expectedHash, payload.sub)) {
    return { ok: false, status: 401, error: "Participant/session mismatch" };
  }

  return { ok: true, payload, conversationId: payload.jti };
}

// Server-side events: diagnostic only. A failed event write must not erase
// an otherwise successfully persisted prompt/response.
async function bestEffortEvent(env, conversationId, turnId, eventType, metadata, eventAt) {
  try {
    await insertEvent(
      env,
      conversationId,
      turnId,
      eventType,
      JSON.stringify(metadata || {}),
      eventAt || new Date().toISOString()
    );
  } catch (error) {
    console.error("D1 diagnostic event insert failed:", safeErrorCode(error));
  }
}

async function insertEvent(env, conversationId, turnId, eventType, metadataJson, eventAt) {
  await env.DB.prepare(`
    INSERT INTO events
      (event_id, conversation_id, turn_id, event_type, event_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), conversationId, turnId, eventType, eventAt, metadataJson
  ).run();
}

// ---- Original helper functions, retained with minor validation hardening ----

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
  if (String(token).length > 4096) return { ok: false, error: "Invalid session token" };
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
  if (!payload || !payload.exp || payload.exp < now) {
    return { ok: false, error: "Session expired" };
  }
  if (payload.arm !== "socratic" && payload.arm !== "unrestricted") {
    return { ok: false, error: "Invalid session arm" };
  }
  return { ok: true, payload };
}

async function hmacSha256(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function asNullableInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeErrorCode(error) {
  // Error class name only; avoid leaking user-provided text into Worker logs.
  return error && typeof error.name === "string" ? error.name : "Error";
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
