/**
 * Incremental Server-Sent Events parser (WHATWG "event stream" format).
 *
 * The backend streams SSE over a POST response, so the browser's `EventSource` cannot be
 * used; this parses a `fetch` body instead. It handles events split across network chunks,
 * several events per chunk, `\n`, `\r\n` and `\r` line endings (including a `\r\n` split
 * between chunks), multi-line `data:` fields, comment/keep-alive lines and UTF-8 characters
 * split across chunks.
 */

export interface SSEMessage {
  event: string;
  data: string;
}

export class SSEParser {
  private buffer = "";
  private eventName = "";
  private dataLines: string[] = [];
  private sawData = false;

  constructor(private readonly onMessage: (message: SSEMessage) => void) {}

  /** Feed decoded text. May dispatch zero or more messages. */
  feed(text: string): void {
    this.buffer += text;
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== "\n" && ch !== "\r") continue;
      if (ch === "\r") {
        // A lone trailing "\r" may be the first half of "\r\n": wait for more input.
        if (i === this.buffer.length - 1) break;
        this.processLine(this.buffer.slice(start, i));
        if (this.buffer[i + 1] === "\n") i++;
      } else {
        this.processLine(this.buffer.slice(start, i));
      }
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
  }

  /** Signal end of stream. Per the spec, an event without a terminating blank line is discarded. */
  end(): void {
    if (this.buffer.endsWith("\r")) {
      this.processLine(this.buffer.slice(0, -1));
    }
    this.buffer = "";
    this.reset();
  }

  private processLine(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return; // comment / keep-alive

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      this.eventName = value;
    } else if (field === "data") {
      this.dataLines.push(value);
      this.sawData = true;
    }
    // "id" and "retry" are not used by this client (no automatic reconnection).
  }

  private dispatch(): void {
    if (this.sawData) {
      this.onMessage({ event: this.eventName || "message", data: this.dataLines.join("\n") });
    }
    this.reset();
  }

  private reset(): void {
    this.eventName = "";
    this.dataLines = [];
    this.sawData = false;
  }
}

/**
 * Read a byte stream as SSE messages. Breaking out of the loop (or an error) cancels the
 * underlying stream, which closes the HTTP connection and lets the server stop work.
 */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const queue: SSEMessage[] = [];
  const parser = new SSEParser((message) => queue.push(message));
  let finished = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        parser.feed(decoder.decode());
        parser.end();
        finished = true;
      } else {
        parser.feed(decoder.decode(value, { stream: true }));
      }
      while (queue.length > 0) {
        yield queue.shift() as SSEMessage;
      }
      if (finished) return;
    }
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
