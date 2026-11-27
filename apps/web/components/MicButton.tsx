"use client";

import { useEffect } from "react";
import { useDictation } from "@/lib/voice";
import { MicIcon } from "./icons";

/**
 * Dictation button. Renders nothing where the browser has no speech
 * recognition, so there is never a button that cannot work.
 */
export function MicButton({
  onText,
  onError,
  disabled,
}: {
  onText: (text: string) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}) {
  const { supported, listening, error, start, stop } = useDictation(onText);
  useEffect(() => {
    if (error) onError?.(error);
  }, [error, onError]);
  if (!supported) return null;
  return (
    <button
      type="button"
      className={`btn icon-btn mic ${listening ? "mic-live" : "btn-secondary"}`}
      onClick={listening ? stop : start}
      disabled={disabled}
      aria-label={listening ? "Stop listening" : "Speak to Jarvis"}
      aria-pressed={listening}
      title="Voice input uses your browser's speech recognition, which may send audio to your browser's provider."
    >
      <MicIcon />
    </button>
  );
}
