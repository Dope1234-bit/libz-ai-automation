import { AppError, ErrorCode } from "@jarvis/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { parseBody } from "../validation.js";

export interface SpeechSettings {
  /** null when ELEVENLABS_API_KEY is unset: the browser's own voice is used instead. */
  apiKey: string | null;
  voiceId: string;
  modelId: string;
  /** Characters per user per UTC day. */
  dailyChars: number;
  fetch?: typeof fetch;
}

const bodySchema = z.object({ text: z.string().trim().min(1).max(2500) }).strict();

/**
 * Sir Libz's voice. Text is turned into speech by ElevenLabs on the server, so
 * the key never reaches the browser; usage is capped per user per day.
 */
export function speechRoutes(settings: SpeechSettings) {
  const doFetch = settings.fetch ?? fetch;
  return new Hono<AppEnv>()
    .get("/speech/status", (c) => c.json({ configured: settings.apiKey !== null }))
    .post("/speech", async (c) => {
      if (!settings.apiKey) {
        throw new AppError(ErrorCode.Unavailable, "Sir Libz's voice is not connected.");
      }
      const { text } = await parseBody(c, bodySchema);

      // Characters count against a daily budget (ElevenLabs bills per character).
      const { data, error } = await c.get("db").rpc("consume_usage", {
        p_bucket: "speech_chars",
        p_amount: text.length,
        p_limit: settings.dailyChars,
        p_window_seconds: 86_400,
      });
      if (error) throw new AppError(ErrorCode.Internal, "Could not check the voice allowance.");
      if (!(data as { allowed: boolean }).allowed) {
        throw new AppError(
          ErrorCode.RateLimited,
          "Today's voice allowance is used up. Sir Libz will use your device's voice until 00:00 UTC.",
        );
      }

      let upstream: Response;
      try {
        upstream = await doFetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${settings.voiceId}/stream?output_format=mp3_44100_64`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
              "xi-api-key": settings.apiKey,
            },
            body: JSON.stringify({
              text,
              model_id: settings.modelId,
              voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.2 },
            }),
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch {
        throw new AppError(ErrorCode.Unavailable, "The voice service is not responding.");
      }
      if (!upstream.ok || !upstream.body) {
        console.error(
          JSON.stringify({ level: "error", msg: "elevenlabs failed", status: upstream.status }),
        );
        throw new AppError(
          ErrorCode.Unavailable,
          upstream.status === 401
            ? "The voice service rejected the API key."
            : "The voice service is not available right now.",
        );
      }
      return new Response(upstream.body, {
        headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
      });
    });
}
