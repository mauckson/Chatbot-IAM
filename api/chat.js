// Orbit chat endpoint: POST /api/chat -> Groq chat completions.
// GROQ_API_KEY is read from the server environment and never sent to the browser.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

const MAX_USER_CHARS = 4000; // longest message a user can send
const MAX_ASSISTANT_CHARS = 6000; // older replies are clipped to this
const MAX_HISTORY_MESSAGES = 12; // recent messages sent as context
const MAX_CONTEXT_CHARS = 24000; // total character budget for that history
const MAX_INCOMING_MESSAGES = 100; // anything longer is not a real client
const MAX_BODY_BYTES = 200_000;
const MAX_OUTPUT_TOKENS = 1024;
const UPSTREAM_TIMEOUT_MS = 25_000; // keep below maxDuration in vercel.json

const SYSTEM_PROMPT = [
  'You are Orbit, a friendly general-purpose AI assistant.',
  'Help people with questions on any topic, writing, brainstorming, explaining concepts and follow-up questions.',
  'Be clear and concise, and use Markdown (short paragraphs, lists, code blocks) when it makes an answer easier to read.',
  'If you are unsure, or something may have changed since your training data, say so instead of guessing.',
].join(' ');

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return errorResponse(405, 'method_not_allowed', 'Use POST to talk to Orbit.', { Allow: 'POST' });
    }
    try {
      return await handleChat(request);
    } catch (err) {
      console.error('[orbit] Unexpected error:', err?.message || err);
      return errorResponse(500, 'server_error', 'Something went wrong on the server. Please try again.');
    }
  },
};

async function handleChat(request) {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return errorResponse(415, 'unsupported_media_type', 'Send the conversation as JSON.');
  }
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) {
    return errorResponse(413, 'payload_too_large', 'That conversation is too large to send.');
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return errorResponse(413, 'payload_too_large', 'That conversation is too large to send.');
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return errorResponse(400, 'invalid_json', 'The request body must be valid JSON.');
  }

  const parsed = buildHistory(body?.messages);
  if (parsed.error) return errorResponse(400, parsed.code, parsed.error);

  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) {
    console.error('[orbit] GROQ_API_KEY is not set.');
    return errorResponse(
      500,
      'missing_api_key',
      'Orbit isn’t connected to Groq yet: the server has no GROQ_API_KEY. Add it as an environment variable and restart or redeploy.',
    );
  }
  const model = (process.env.GROQ_MODEL || '').trim() || DEFAULT_MODEL;

  let upstream;
  let data;
  try {
    upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...parsed.messages],
        temperature: 0.7,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    data = await upstream.json().catch(() => null);
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      console.error(`[orbit] Groq timed out after ${UPSTREAM_TIMEOUT_MS}ms.`);
      return errorResponse(504, 'upstream_timeout', 'Groq took too long to respond. Please try again.');
    }
    console.error('[orbit] Could not reach Groq:', err?.message || err);
    return errorResponse(502, 'upstream_unreachable', 'Couldn’t reach Groq. Please try again in a moment.');
  }

  if (!upstream.ok) return upstreamError(upstream, data, model);

  const choice = data?.choices?.[0];
  const reply = stripThinking(choice?.message?.content);
  if (!reply) {
    console.error('[orbit] Groq returned an empty reply.', choice?.finish_reason);
    return errorResponse(502, 'empty_reply', 'Groq sent back an empty reply. Please try again.');
  }

  return jsonResponse(200, {
    reply,
    model: data?.model || model,
    truncated: choice?.finish_reason === 'length',
  });
}

// Keeps only user/assistant turns, checks the newest message and trims the rest
// to the most recent messages that fit the history limits.
function buildHistory(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return { code: 'invalid_messages', error: 'Send at least one message.' };
  }
  if (input.length > MAX_INCOMING_MESSAGES) {
    return { code: 'invalid_messages', error: 'Too many messages in one request.' };
  }

  const cleaned = [];
  for (const message of input) {
    if (!message || typeof message !== 'object') {
      return { code: 'invalid_messages', error: 'Each message must be an object.' };
    }
    // Client-supplied system prompts and unknown roles are dropped, not forwarded.
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (typeof message.content !== 'string') {
      return { code: 'invalid_messages', error: 'Each message needs text content.' };
    }
    const content = message.content.trim();
    if (content) cleaned.push({ role: message.role, content });
  }

  const latest = cleaned.at(-1);
  if (!latest || latest.role !== 'user') {
    return { code: 'invalid_messages', error: 'The last message must come from the user.' };
  }
  if (latest.content.length > MAX_USER_CHARS) {
    return { code: 'message_too_long', error: `Messages can be up to ${MAX_USER_CHARS} characters.` };
  }

  const messages = [];
  let budget = MAX_CONTEXT_CHARS;
  for (let i = cleaned.length - 1; i >= 0 && messages.length < MAX_HISTORY_MESSAGES; i--) {
    const { role, content } = cleaned[i];
    const clipped = clip(content, role === 'user' ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS);
    if (clipped.length > budget) break;
    budget -= clipped.length;
    messages.unshift({ role, content: clipped });
  }
  // Start the context on a user turn so the model never sees a dangling reply first.
  while (messages.length > 1 && messages[0].role !== 'user') messages.shift();

  return { messages };
}

function upstreamError(upstream, data, model) {
  const status = upstream.status;
  const detail = data?.error || {};
  const code = String(detail.code || '');
  console.error(`[orbit] Groq error ${status}:`, code || '-', detail.message || '');

  if (status === 401 || status === 403) {
    return errorResponse(502, 'upstream_auth', 'Groq rejected the server’s API key. Check GROQ_API_KEY.');
  }
  if (status === 429) {
    const retryAfter = upstream.headers.get('retry-after');
    return errorResponse(
      429,
      'rate_limited',
      'Groq is rate-limiting requests right now. Wait a few seconds and try again.',
      retryAfter ? { 'Retry-After': retryAfter } : {},
    );
  }
  if (status === 404 || code.includes('model')) {
    return errorResponse(502, 'model_unavailable', `The model “${model}” isn’t available on Groq. Check GROQ_MODEL.`);
  }
  if (status === 413 || code === 'context_length_exceeded') {
    return errorResponse(400, 'context_too_long', 'This conversation is too long for the model. Start a new chat to keep going.');
  }
  return errorResponse(502, 'upstream_error', 'Groq couldn’t answer just now. Please try again.');
}

// Some reasoning models put their working inside <think> tags; only the answer is shown.
function stripThinking(content) {
  if (typeof content !== 'string') return '';
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function errorResponse(status, code, message, headers) {
  return jsonResponse(status, { error: { code, message } }, headers);
}
