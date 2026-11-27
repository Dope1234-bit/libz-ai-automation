# ADR-0006: One OpenAI-compatible client instead of per-vendor AI SDKs

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

ADR-0004 chose a multi-provider router over free tiers (Gemini, Groq,
OpenRouter, Ollama). Options were a large multi-provider framework, one vendor
SDK per provider, or our own thin client.

All four providers expose an **OpenAI-compatible chat completions API** with
server-sent-event streaming.

## Decision

`packages/ai` contains one small, fully tested streaming client for that API, a
router with ordered fallback and per-provider cooldown, and prompt helpers. It
has no runtime dependency other than Zod.

- **Fallback rule:** fall back to the next model only if a provider fails
  _before_ producing text. After text has streamed, the error is surfaced
  instead, because splicing two models' answers would be incoherent.
- **Cooldown:** rate-limited or failing providers are skipped for their
  `Retry-After` (default 30 s).
- **Error hygiene:** provider error bodies are never surfaced or logged, because
  they can echo user content.
- **Credentials:** keys are optional per provider, so a managed egress proxy can
  inject them (`AI_KEYS_VIA_PROXY=true`). Gemini uses its `x-goog-api-key`
  header.
- **Configuration:** models are set per provider and task through environment
  variables (for example `GEMINI_CHAT_MODEL`), because free-tier model names
  change often.

## Consequences

- Small supply-chain surface and full control over retries, timeouts and
  logging.
- Provider-specific features such as native tool-calling formats need explicit
  support when Milestone 1.3 adds tools. If that grows large, we revisit a
  framework.
- Default model names and the Gemini OpenAI-compatible endpoint behaviour are
  verified with mocked HTTP; a live check against each provider is needed once
  keys are configured.
