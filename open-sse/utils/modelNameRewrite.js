/**
 * Rewrite the model name clients see in responses.
 *
 * When a request is served through a combo, clients currently see whichever
 * upstream model id happened to serve it — response translators overwrite the
 * emitted model from upstream chunks (claude-to-openai, openai-to-claude, ...)
 * and same-format passthrough forwards them untouched. This rewriter swaps
 * that field for the combo name the client asked for, so the client-visible
 * model stays stable.
 *
 * Scope: 2xx responses only.
 * - SSE: line-buffered rewrite of the top-level "model" value in each data
 *   line (OpenAI chunk header, Claude message_start, Responses response.*).
 *   Lines without a model key pass through untouched.
 * - JSON: top-level `model` (OpenAI/Claude/Responses) or `modelVersion`
 *   (Gemini) is rewritten.
 * - Any other content type passes through untouched.
 *
 * The replacement is JSON-escaped, and a raw `"model":"` sequence can only be
 * a real key — quotes inside string values are always escaped — so model
 * names echoed inside tool-call arguments or content are never touched.
 */

// Non-string values after the colon don't match: the value must be a string.
const MODEL_KEY_RE = /("model"\s*:\s*")((?:[^"\\]|\\.)*)(")/;
const MODEL_VERSION_KEY_RE = /("modelVersion"\s*:\s*")((?:[^"\\]|\\.)*)(")/;

function jsonEscape(value) {
  // Inner content of a JSON string literal (quotes, backslashes, control chars).
  return JSON.stringify(String(value)).slice(1, -1);
}

function rewriteLine(line, escapedName) {
  if (!line.includes('"model')) return line;
  return line
    .replace(MODEL_KEY_RE, (m, pre, val, post) => pre + escapedName + post)
    .replace(MODEL_VERSION_KEY_RE, (m, pre, val, post) => pre + escapedName + post);
}

/**
 * Line-buffered byte stream that rewrites the model field of SSE data lines.
 * Decoding is streamed so multi-byte characters split across chunks survive.
 */
export function createModelRewriteStream(modelName) {
  const escapedName = jsonEscape(modelName);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let start = 0;
      let nl;
      while ((nl = buffer.indexOf("\n", start)) !== -1) {
        const end = nl + 1;
        controller.enqueue(encoder.encode(rewriteLine(buffer.slice(start, end), escapedName)));
        start = end;
      }
      buffer = buffer.slice(start);
    },
    flush(controller) {
      const rest = buffer + decoder.decode();
      if (rest) controller.enqueue(encoder.encode(rewriteLine(rest, escapedName)));
    },
  });
}

/**
 * Rewrite the model name of a successful response to `modelName`.
 * No-op when disabled, not ok, no name given, or content type is neither SSE nor JSON.
 * @param {Response} response
 * @param {string} modelName - Name to report (the combo name the client asked for)
 * @param {boolean} [enabled=true]
 * @returns {Promise<Response>}
 */
export async function rewriteResponseModelName(response, modelName, enabled = true) {
  if (!enabled || !response || !response.ok || !modelName) return response;

  const contentType = response.headers?.get?.("content-type") || "";
  const isSSE = contentType.includes("text/event-stream");
  const isJSON = contentType.includes("application/json");
  if (!isSSE && !isJSON) return response;

  try {
    if (isSSE) {
      if (!response.body) return response;
      const rewritten = response.body.pipeThrough(createModelRewriteStream(modelName));
      return new Response(rewritten, { status: response.status, statusText: response.statusText, headers: response.headers });
    }

    const text = await response.text();
    try {
      const body = JSON.parse(text);
      let changed = false;
      if (body && typeof body === "object") {
        if (typeof body.model === "string") { body.model = modelName; changed = true; }
        if (typeof body.modelVersion === "string") { body.modelVersion = modelName; changed = true; }
      }
      const out = changed ? JSON.stringify(body) : text;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(out, { status: response.status, statusText: response.statusText, headers });
    } catch {
      // Not JSON after all — forward the original bytes unchanged.
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(text, { status: response.status, statusText: response.statusText, headers });
    }
  } catch {
    // Rewriting must never break the response — fall back to the original body.
    return response;
  }
}
