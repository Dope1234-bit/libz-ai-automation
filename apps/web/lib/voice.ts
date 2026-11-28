"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

/*
 * Voice v1 uses the browser's built-in speech services:
 *  - speech-to-text: the Web Speech API (SpeechRecognition). On Chrome this
 *    sends audio to the browser vendor's speech service; the UI says so.
 *  - text-to-speech: speechSynthesis, which runs on the device.
 * Sir Libz's own voice (a deep male ElevenLabs voice) is used when the server
 * has it connected; otherwise the deepest male voice on the device is chosen.
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
    "Microphone access was blocked. Allow it in your browser settings to talk to Sir Libz.",
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

let player: HTMLAudioElement | null = null;
let playerUrl: string | null = null;
let serverVoice: Promise<boolean> | null = null;

/** Whether the server speaks with Sir Libz's ElevenLabs voice (checked once). */
function serverVoiceAvailable(): Promise<boolean> {
  serverVoice ??= api
    .speechStatus()
    .then((s) => s.configured)
    .catch(() => false);
  return serverVoice;
}

/**
 * Must run inside a tap/click: mobile browsers only let a page play audio later
 * (after network calls) if playback was first started by a user gesture.
 */
export function unlockAudio() {
  if (typeof window === "undefined") return;
  player ??= new Audio();
  player.muted = true;
  player.src = SILENCE;
  void player
    .play()
    .catch(() => undefined)
    .finally(() => {
      if (player) player.muted = false;
    });
  if (speechOutputSupported()) window.speechSynthesis.getVoices();
}

// 0.1 s of silence, used only to unlock audio on mobile.
const SILENCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

/** The deepest-sounding male English voice the device offers, if any. */
function deviceVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  const male =
    /\b(male|man|daniel|david|george|guy|ryan|thomas|aaron|fred|alex|arthur|oliver|james|rishi|reed|eddy|ralph)\b/i;
  return (
    voices.find((v) => male.test(v.name) && /google|natural|premium|enhanced/i.test(v.name)) ??
    voices.find((v) => male.test(v.name)) ??
    null
  );
}

function speakOnDevice(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!speechOutputSupported()) return resolve();
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = deviceVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang ?? (navigator.language || "en-US");
    // Lower and slightly slower: closer to Sir Libz's deep, calm voice.
    utterance.pitch = 0.75;
    utterance.rate = 0.95;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
}

async function speakWithServer(text: string): Promise<boolean> {
  try {
    const audio = await api.speechAudio(text);
    player ??= new Audio();
    if (playerUrl) URL.revokeObjectURL(playerUrl);
    playerUrl = URL.createObjectURL(audio);
    player.src = playerUrl;
    await new Promise<void>((resolve, reject) => {
      player!.onended = () => resolve();
      player!.onerror = () => reject(new Error("playback failed"));
      player!.onpause = () => resolve();
      player!.play().catch(reject);
    });
    return true;
  } catch {
    return false;
  }
}

/** Speak a reply in Sir Libz's voice. Resolves when finished (or stopped). */
export async function speak(text: string): Promise<void> {
  const spoken = toSpeakable(text).slice(0, 2500);
  if (!spoken) return;
  stopSpeaking();
  if ((await serverVoiceAvailable()) && (await speakWithServer(spoken))) return;
  await speakOnDevice(spoken);
}

export function stopSpeaking() {
  if (player && !player.paused) player.pause();
  if (speechOutputSupported()) window.speechSynthesis.cancel();
}

/**
 * Listen for one spoken message (Live mode). Resolves with the final
 * transcript, or "" if nothing was said. `stop()` ends it early.
 */
export function listenOnce(onInterim?: (text: string) => void): {
  result: Promise<string>;
  stop: () => void;
} {
  const Ctor = recognitionCtor();
  if (!Ctor)
    return { result: Promise.reject(new Error(ERRORS["service-not-allowed"])), stop: () => {} };
  const r = new Ctor();
  r.lang = navigator.language || "en-US";
  r.interimResults = true;
  r.continuous = false;
  let finalText = "";
  const result = new Promise<string>((resolve, reject) => {
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      onInterim?.((finalText + interim).trim());
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      reject(new Error(ERRORS[e.error] ?? "Voice input failed."));
    };
    r.onend = () => resolve(finalText.trim());
    try {
      r.start();
    } catch {
      resolve("");
    }
  });
  return { result, stop: () => r.stop() };
}
