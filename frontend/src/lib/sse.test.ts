import { describe, expect, it } from "vitest";

import { readSSE, SSEParser, type SSEMessage } from "@/lib/sse";
import { streamOf } from "@/test/fixtures";

function parseAll(chunks: string[]): SSEMessage[] {
  const out: SSEMessage[] = [];
  const parser = new SSEParser((m) => out.push(m));
  chunks.forEach((c) => parser.feed(c));
  parser.end();
  return out;
}

const TEXT = 'event: token\ndata: {"delta":"hi"}\n\nevent: done\ndata: {"answer":"ok"}\n\n';

describe("SSEParser", () => {
  it("parses multiple events in one chunk", () => {
    expect(parseAll([TEXT])).toEqual([
      { event: "token", data: '{"delta":"hi"}' },
      { event: "done", data: '{"answer":"ok"}' },
    ]);
  });

  it("produces identical results however the stream is split", () => {
    const expected = parseAll([TEXT]);
    for (let size = 1; size <= TEXT.length; size++) {
      const chunks = [];
      for (let i = 0; i < TEXT.length; i += size) chunks.push(TEXT.slice(i, i + size));
      expect(parseAll(chunks)).toEqual(expected);
    }
  });

  it("handles CRLF and CR line endings, including CRLF split across chunks", () => {
    expect(parseAll(["event: a\r\ndata: 1\r", "\n\r\nevent: b\rdata: 2\r\r"])).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("joins multi-line data with newlines", () => {
    expect(parseAll(["data: line one\ndata: line two\n\n"])).toEqual([{ event: "message", data: "line one\nline two" }]);
  });

  it("ignores comments, keep-alive pings, unknown fields and id/retry", () => {
    expect(parseAll([": ping\n\nid: 7\nretry: 100\nfoo: bar\nevent: x\ndata: 1\n\n: ping\n\n"])).toEqual([
      { event: "x", data: "1" },
    ]);
  });

  it("strips exactly one leading space from values", () => {
    expect(parseAll(["data:  two spaces\ndata:none\n\n"])).toEqual([{ event: "message", data: " two spaces\nnone" }]);
  });

  it("does not dispatch events without data, and discards an unterminated final event", () => {
    expect(parseAll(["event: empty\n\n", "event: partial\ndata: 1"])).toEqual([]);
  });
});

describe("readSSE", () => {
  it("decodes UTF-8 characters split across chunks", async () => {
    const bytes = new TextEncoder().encode('event: token\ndata: {"delta":"22°C ☀️"}\n\n');
    const chunks = Array.from(bytes, (b) => new Uint8Array([b])); // one byte per chunk
    const messages: SSEMessage[] = [];
    for await (const m of readSSE(streamOf(chunks))) messages.push(m);
    expect(messages).toEqual([{ event: "token", data: '{"delta":"22°C ☀️"}' }]);
  });

  it("cancels the underlying stream when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const message of readSSE(body)) {
      expect(message.data).toBe("1");
      break;
    }
    expect(cancelled).toBe(true);
  });
});
