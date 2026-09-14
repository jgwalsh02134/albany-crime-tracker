import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  resetXaiSttBackoff,
  sttBackoffHealth,
  transcribeAudioFile,
  transcribeWithWhisperFallback,
} from "./transcribe.ts";

const sample = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]);

type EnvKey = "OPENAI_API_KEY" | "GROQ_API_KEY" | "XAI_API_KEY" | "SCANNER_STT_PREFER";

function withEnv(patch: Partial<Record<EnvKey, string | undefined>>, fn: () => Promise<void>) {
  const prev: Partial<Record<EnvKey, string | undefined>> = {};
  for (const k of Object.keys(patch) as EnvKey[]) {
    prev[k] = process.env[k];
    const v = patch[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const k of Object.keys(prev) as EnvKey[]) {
      const v = prev[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

afterEach(() => {
  resetXaiSttBackoff();
});

describe("transcribeWithWhisperFallback", () => {
  it("continues to Groq when OpenAI returns 429", async () => {
    await withEnv(
      {
        OPENAI_API_KEY: "sk-test-openai",
        GROQ_API_KEY: "gsk-test-groq",
        XAI_API_KEY: undefined,
      },
      async () => {
        const calls: string[] = [];
        const orig = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url = String(input);
          calls.push(url);
          if (url.includes("api.openai.com")) {
            return new Response(JSON.stringify({ error: { message: "insufficient_quota" } }), {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "60" },
            });
          }
          if (url.includes("api.groq.com")) {
            return new Response(JSON.stringify({ text: "unit 42 Central Avenue", duration: 1.2 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error(`unexpected fetch ${url}`);
        }) as typeof fetch;

        try {
          const result = await transcribeWithWhisperFallback(sample, "segment.mp3", "audio/mpeg");
          assert.equal(result.text, "unit 42 Central Avenue");
          assert.ok(calls.some((u) => u.includes("api.openai.com")));
          assert.ok(calls.some((u) => u.includes("api.groq.com")));
          const backoff = sttBackoffHealth();
          assert.ok(backoff.openaiWhisperBlockedSec >= 40);
        } finally {
          globalThis.fetch = orig;
        }
      },
    );
  });
});

describe("transcribeAudioFile prefer=xai cascade", () => {
  it("xAI 403 then OpenAI 429 still reaches Groq success", async () => {
    await withEnv(
      {
        OPENAI_API_KEY: "sk-test-openai",
        GROQ_API_KEY: "gsk-test-groq",
        XAI_API_KEY: "xai-test",
        SCANNER_STT_PREFER: "xai",
      },
      async () => {
        const calls: string[] = [];
        const orig = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url = String(input);
          calls.push(url);
          if (url.includes("api.x.ai")) {
            return new Response("forbidden", { status: 403 });
          }
          if (url.includes("api.openai.com")) {
            return new Response(JSON.stringify({ error: { message: "insufficient_quota" } }), {
              status: 429,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.includes("api.groq.com")) {
            return new Response(JSON.stringify({ text: "10-31 Central and Quail", duration: 2 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error(`unexpected fetch ${url}`);
        }) as typeof fetch;

        try {
          const result = await transcribeAudioFile(sample, "segment.mp3", "audio/mpeg");
          assert.equal(result.text, "10-31 Central and Quail");
          assert.ok(calls.some((u) => u.includes("api.x.ai")));
          assert.ok(calls.some((u) => u.includes("api.openai.com")));
          assert.ok(calls.some((u) => u.includes("api.groq.com")));
        } finally {
          globalThis.fetch = orig;
        }
      },
    );
  });
});
