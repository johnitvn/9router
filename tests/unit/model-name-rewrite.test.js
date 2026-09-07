import { describe, it, expect } from "vitest";
import { rewriteResponseModelName, createModelRewriteStream } from "open-sse/utils/modelNameRewrite.js";

const SSE_HEADERS = { "content-type": "text/event-stream" };
const JSON_HEADERS = { "content-type": "application/json" };

function sseResponse(lines) {
  return new Response(lines.join("\n") + "\n", { status: 200, headers: SSE_HEADERS });
}

function jsonResponse(body) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
}

async function readSSE(response) {
  const text = await response.text();
  return text.split("\n")
    .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(5)));
}

describe("rewriteResponseModelName — SSE", () => {
  it("rewrites model in OpenAI-style chunks and leaves other lines intact", async () => {
    const res = await rewriteResponseModelName(sseResponse([
      'data: {"id":"1","model":"gpt-5","choices":[{"delta":{"content":"hi"}}]}',
      'data: {"id":"1","model":"gpt-5","choices":[{"delta":{}}],"usage":{"prompt_tokens":1}}',
      "data: [DONE]",
    ]), "my-combo");

    const chunks = await readSSE(res);
    expect(chunks[0].model).toBe("my-combo");
    expect(chunks[0].choices[0].delta.content).toBe("hi");
    expect(chunks[1].model).toBe("my-combo");
    expect(chunks[1].usage.prompt_tokens).toBe(1);
  });

  it("rewrites Claude message_start nested model", async () => {
    const res = await rewriteResponseModelName(sseResponse([
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5-20250929","role":"assistant"}}',
    ]), "my-combo");

    const chunks = await readSSE(res);
    expect(chunks[0].message.model).toBe("my-combo");
    expect(chunks[0].message.id).toBe("msg_1");
  });

  it("rewrites modelVersion in Gemini-style lines", async () => {
    const res = await rewriteResponseModelName(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}],"modelVersion":"gemini-2.5-pro"}',
    ]), "my-combo");

    const chunks = await readSSE(res);
    expect(chunks[0].modelVersion).toBe("my-combo");
  });

  it("does not touch model names echoed inside escaped string values", async () => {
    const raw = 'data: {"model":"gpt-5","choices":[{"delta":{"content":"{\\"model\\":\\"fake\\"}"}}]}';
    const res = await rewriteResponseModelName(sseResponse([raw]), "my-combo");

    const chunks = await readSSE(res);
    expect(chunks[0].model).toBe("my-combo");
    expect(chunks[0].choices[0].delta.content).toBe('{"model":"fake"}');
  });

  it("keeps the rewritten value valid JSON for names with quotes and backslashes", async () => {
    const tricky = 'my "combo" \\ path';
    const res = await rewriteResponseModelName(sseResponse([
      'data: {"model":"gpt-5","choices":[{"delta":{"content":"x"}}]}',
    ]), tricky);

    const chunks = await readSSE(res);
    expect(chunks[0].model).toBe(tricky);
  });

  it("passes through responses with non-SSE/JSON content types untouched", async () => {
    const res = new Response('data: {"model":"gpt-5"}\n', { status: 200, headers: { "content-type": "text/html" } });
    const out = await rewriteResponseModelName(res, "my-combo");
    expect(out).toBe(res);
    expect(await out.text()).toBe('data: {"model":"gpt-5"}\n');
  });
});

describe("rewriteResponseModelName — JSON", () => {
  it("rewrites top-level model in OpenAI completions", async () => {
    const res = await rewriteResponseModelName(
      jsonResponse({ id: "1", model: "gpt-5", choices: [{ message: { role: "assistant", content: "hi" } }] }),
      "my-combo"
    );
    const body = await res.json();
    expect(body.model).toBe("my-combo");
    expect(body.choices[0].message.content).toBe("hi");
  });

  it("rewrites Claude messages model", async () => {
    const res = await rewriteResponseModelName(
      jsonResponse({ id: "msg_1", type: "message", model: "claude-sonnet-4-5-20250929", content: [] }),
      "my-combo"
    );
    const body = await res.json();
    expect(body.model).toBe("my-combo");
  });

  it("rewrites Gemini modelVersion", async () => {
    const res = await rewriteResponseModelName(
      jsonResponse({ candidates: [{ content: { parts: [{ text: "x" }] } }], modelVersion: "gemini-2.5-pro" }),
      "my-combo"
    );
    const body = await res.json();
    expect(body.modelVersion).toBe("my-combo");
  });

  it("forwards bodies that are not JSON unchanged", async () => {
    const res = await rewriteResponseModelName(jsonResponse("plain text"), "my-combo");
    expect(await res.text()).toBe("plain text");
  });
});

describe("rewriteResponseModelName — guards", () => {
  it("returns error responses untouched", async () => {
    const res = new Response(JSON.stringify({ error: { message: "All combo models unavailable" } }), { status: 503, headers: JSON_HEADERS });
    const out = await rewriteResponseModelName(res, "my-combo");
    expect(out).toBe(res);
    expect(out.status).toBe(503);
  });

  it("returns the response untouched when disabled", async () => {
    const res = jsonResponse({ model: "gpt-5" });
    const out = await rewriteResponseModelName(res, "my-combo", false);
    expect(out).toBe(res);
  });

  it("returns the response untouched when no model name is given", async () => {
    const res = jsonResponse({ model: "gpt-5" });
    const out = await rewriteResponseModelName(res, "");
    expect(out).toBe(res);
  });
});

describe("createModelRewriteStream", () => {
  it("survives multi-byte characters split across chunk boundaries", async () => {
    const ts = createModelRewriteStream("my-combo");
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();

    const line = 'data: {"model":"gpt-5","choices":[{"delta":{"content":"héllo 😀→ end"}}]}\n';
    const bytes = new TextEncoder().encode(line);
    // Split inside the emoji (starts at some byte index, 4 bytes long)
    const splitAt = bytes.length - 12;
    const collected = [];
    const readAll = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        collected.push(value);
      }
    })();

    await writer.write(bytes.slice(0, splitAt));
    await writer.write(bytes.slice(splitAt));
    await writer.close();
    await readAll;

    const out = new TextDecoder().decode(concat(collected));
    const parsed = JSON.parse(out.replace(/^data: /, "").trim());
    expect(parsed.model).toBe("my-combo");
    expect(parsed.choices[0].delta.content).toBe("héllo 😀→ end");
  });

  it("flushes a trailing line without a newline", async () => {
    const ts = createModelRewriteStream("my-combo");
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    const collected = [];
    const readAll = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        collected.push(value);
      }
    })();

    await writer.write(new TextEncoder().encode('data: {"model":"gpt-5"}'));
    await writer.close();
    await readAll;

    const out = new TextDecoder().decode(concat(collected));
    expect(JSON.parse(out.replace(/^data: /, "").trim()).model).toBe("my-combo");
  });
});

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
