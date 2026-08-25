import http2 from "node:http2";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function http2Get(url: string, timeoutMs = 10000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const u = new URL(url);
    const client = http2.connect(`${u.protocol}//${u.host}`);
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);

    function finish(err: Error | null, data?: Uint8Array) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(data ?? new Uint8Array());
    }

    client.on("error", (err) => finish(err));

    const req = client.request({
      ":path": `${u.pathname}${u.search}`,
      ":method": "GET",
      "user-agent": UA,
      accept: "*/*",
    });
    const chunks: Buffer[] = [];
    req.on("response", (headers) => {
      const status = Number(headers[":status"] ?? 0);
      if (status >= 400) finish(new Error(`http-${status}`));
    });
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => finish(null, new Uint8Array(Buffer.concat(chunks))));
    req.on("error", (err) => finish(err));
    req.end();
  });
}

export function http2GetText(url: string, timeoutMs = 10000): Promise<string> {
  return http2Get(url, timeoutMs).then((bytes) => new TextDecoder().decode(bytes));
}
