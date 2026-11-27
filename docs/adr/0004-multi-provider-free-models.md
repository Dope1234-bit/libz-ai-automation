# ADR-0004: Multi-provider model router, free tiers first

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

We want to build and run Jarvis at no model cost during Phase 1, without locking
into a single provider. Free tiers have tight rate limits and change often.

## Decision

All model access goes through a provider router in `packages/ai` (Milestone 1.2).
Initial providers, each optional and enabled by the presence of its key:

| Provider | Use |
|---|---|
| Google AI Studio (Gemini) | Default chat and embeddings |
| Groq | Low-latency chat and classification |
| OpenRouter (free models) | Additional free model pool and fallback |
| Ollama (local) | Offline development, no key |

The router picks a model by task type, tracks per-provider rate limits and falls
back to the next provider on throttling or errors. Paid providers (for example
Anthropic Claude) can be added later with configuration only.

## Consequences

- No vendor lock-in; providers are swappable through configuration.
- Behaviour varies across models, so an evaluation suite gates changes to
  prompts and routing.
- Some free tiers may use prompts for training. Business workspaces must be able
  to restrict routing to providers whose terms suit their data. This is enforced
  per workspace before business data is processed.
- Embedding dimensions are fixed per index, so changing the embedding model
  requires a re-embedding migration.
