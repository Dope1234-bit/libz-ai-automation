"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
 * Voice v1 uses the browser's built-in speech services:
 *  - speech-to-text: the Web Speech API (SpeechRecognition). On Chrome this
 *    sends audio to the browser vendor's speech service; the UI says so.
 *  - text-to-speech: speechSynthesis, which runs on the device.
 * Server-side, premium voices are a Phase 4 upgrade.
 */

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechInputSupported(): boolean {
  return recognitionCtor() !== null;
}

export function speechOutputSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

const ERRORS: Record<string, string> = {
  "not-allowed":
    "Microphone access was blocked. Allow it in your browser settings to talk to Jarvis.",
  "service-not-allowed": "Speech recognition is not available in this browser.",
  "no-speech": "I didn't hear anything. Tap the mic and try again.",
  network: "Speech recognition needs an internet connection.",
  "audio-capture": "No microphone was found.",
};

/**
 * Dictation hook: streams interim and final transcripts to `onText`
 * (replacing the text dictated so far in this session).
 */
export function useDictation(onText: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => setSupported(speechInputSupported()), []);
  useEffect(() => () => recognition.current?.abort(), []);

  const stop = useCallback(() => recognition.current?.stop(), []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    setError(null);
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    let finalText = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      onTextRef.current((finalText + interim).trim());
    };
    r.onerror = (e) => {
      if (e.error !== "aborted")
        setError(ERRORS[e.error] ?? "Voice input failed. Please try again.");
    };
    r.onend = () => setListening(false);
    recognition.current = r;
    setListening(true);
    try {
      r.start();
    } catch {
      setListening(false);
    }
  }, []);

  return { supported, listening, error, start, stop };
}

const READ_ALOUD_KEY = "jarvis.readAloud";

export function readAloudPreference(): boolean {
  try {
    return window.localStorage.getItem(READ_ALOUD_KEY) === "1";
  } catch {
    return false;
  }
}

export function setReadAloudPreference(on: boolean) {
  try {
    window.localStorage.setItem(READ_ALOUD_KEY, on ? "1" : "0");
  } catch {
    // Not persisted in private browsing; the toggle still works for this page.
  }
}

/** Turn Markdown into plain sentences for speech. */
export function toSpeakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function speak(text: string) {
  if (!speechOutputSupported()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(toSpeakable(text).slice(0, 4000));
  utterance.lang = navigator.language || "en-US";
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  if (speechOutputSupported()) window.speechSynthesis.cancel();
}
