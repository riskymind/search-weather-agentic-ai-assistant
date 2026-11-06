/**
 * Streaming pass-through for the backend's Server-Sent Events (server-only).
 *
 * Bytes are forwarded exactly as they arrive, one upstream chunk at a time, so event
 * boundaries and timing are preserved and nothing is buffered. A decoded copy is fed to the
 * SSE parser only to notice the terminal `done`/`error` event. If the upstream connection
 * fails or ends before a terminal event, a sanitized `error` event is appended so the
 * browser always receives a terminal event. Cancelling the returned stream (the browser
 * disconnected) cancels the upstream body, which closes the backend connection.
 */

import { SSEParser } from "@/lib/sse";

export const SSE_RESPONSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform stops compression middleware from buffering the stream.
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

const TERMINAL_EVENTS = new Set(["done", "error"]);

/**
 * Leading blank lines terminate any partial event already forwarded, so this frame is
 * always parsed on its own (a truncated event without its blank line is discarded).
 */
export const INTERRUPTED_FRAME =
  "\n\nevent: error\ndata: " +
  JSON.stringify({
    event: "error",
    code: "stream_interrupted",
    message: "The connection to the assistant service was lost before the answer finished.",
  }) +
  "\n\n";

export type StreamOutcome = "completed" | "interrupted" | "cancelled";

export function proxySseStream(
  upstream: ReadableStream<Uint8Array>,
  onFinish?: (outcome: StreamOutcome) => void,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder("utf-8");
  let terminal = false;
  const parser = new SSEParser((message) => {
    if (TERMINAL_EVENTS.has(message.event)) terminal = true;
  });
  let finished = false;
  const finish = (outcome: StreamOutcome) => {
    if (finished) return;
    finished = true;
    onFinish?.(outcome);
  };

  const endWithoutTerminal = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.enqueue(new TextEncoder().encode(INTERRUPTED_FRAME));
    controller.close();
    finish("interrupted");
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch {
          if (finished) return;
          if (terminal) {
            controller.close();
            finish("completed");
          } else {
            endWithoutTerminal(controller);
          }
          return;
        }
        if (finished) return;
        if (result.done) {
          parser.feed(decoder.decode());
          if (terminal) {
            controller.close();
            finish("completed");
          } else {
            endWithoutTerminal(controller);
          }
          return;
        }
        parser.feed(decoder.decode(result.value, { stream: true }));
        controller.enqueue(result.value);
      },
      async cancel(reason) {
        finish("cancelled");
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    // Pull only when the consumer reads: no read-ahead buffering.
    { highWaterMark: 0 },
  );
}
