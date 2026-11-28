/**
 * Minimal Server-Sent Events parser: yields the `data:` payload of each event.
 * Handles chunks split anywhere (mid-line, mid-UTF-8 sequence) and CRLF endings.
 */
export async function* parseSseData(
  body: ReadableStream<Uint8Array>,
  maxEventBytes = 1024 * 1024,
): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let data: string[] = [];

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      if (buffer.length > maxEventBytes) {
        throw new Error("SSE event exceeds maximum size");
      }

      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);

        if (line === "") {
          if (data.length > 0) {
            yield data.join("\n");
            data = [];
          }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
        // Comments (":") and other fields (event, id, retry) are ignored.
      }
    }
    // A final line without a trailing newline still counts.
    const last = buffer.replace(/\r$/, "");
    if (last.startsWith("data:")) data.push(last.slice(5).replace(/^ /, ""));
    if (data.length > 0) yield data.join("\n");
  } finally {
    reader.releaseLock();
  }
}
