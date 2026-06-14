# Japanese Conversation Bot — Emi

A private Telegram bot for focused Japanese conversation practice with Emi.

This is **not** Rodolfo's main Japanese habit system. Treat it as an optional conversation sandbox: useful when focused practice sounds appealing, but not something that should become another daily obligation.

## Current status

- **Role:** occasional Japanese conversation gym / reference implementation
- **Interface:** Telegram
- **Core mode:** free conversation in Japanese with furigana
- **Status as of 2026-06-13:** code type-checks cleanly; deployment/webhook status should be verified before use
- **Do not revive as:** a full lesson curriculum, streak system, or primary practice habit

## What it does

- Chats as **Emi**, a warm puppygirl Japanese conversation partner
- Responds primarily in Japanese with inline furigana for kanji
- Adjusts to beginner/intermediate/advanced level from the stored user profile
- Rewrites English or mixed English/Japanese input into natural Japanese before replying
- Stores long-term user memory and Emi self-memory in Redis
- Supports Telegram voice messages via Whisper transcription
- Can send optional proactive check-ins via QStash
- Pauses proactive check-ins after unanswered messages so it does not nag forever

## Useful commands

| Command | Purpose |
| --- | --- |
| `/eng` | Translate Emi's last message into English |
| `/exp` | Explain grammar in Emi's last message |
| `/checkin status` | Show proactive check-in status |
| `/checkin on` | Enable daily proactive check-ins |
| `/checkin off` | Disable proactive check-ins |
| `/reset` or `/reset context` | Clear conversation context but keep memories |
| `/reset all` | Clear conversation context, user memory, and Emi memory |
| `/debug` | Show stored profile, memory, and check-in state |

## Practice shape

Good use:

1. Open Telegram when you deliberately want focused Japanese conversation.
2. Send a short Japanese or English thought.
3. Let Emi rewrite/answer naturally.
4. Use `/eng` if you need the meaning.
5. Use `/exp` if a grammar point is interesting.
6. Stop when you naturally feel done.

Avoid:

- Turning this into a required daily habit
- Rebuilding the old 30-day lesson system
- Adding streaks, stats, or heavy tracking
- Using proactive check-ins as the main consistency mechanism

## Tech stack

- **Runtime:** Cloudflare Workers, TypeScript
- **Interface:** Telegram Bot API
- **LLM:** OpenRouter-compatible chat completions
- **Voice transcription:** OpenAI Whisper
- **Storage:** Upstash Redis
- **Scheduling:** Upstash QStash
- **Tracing:** Braintrust optional

## Project structure

```text
language-bot/
├── worker.ts         # Cloudflare Worker entrypoint and route adapter
├── wrangler.toml    # Cloudflare Worker configuration
├── api/
│   ├── index.ts      # small status/landing page
│   ├── telegram.ts   # Telegram webhook handler
│   ├── notify.ts     # QStash proactive check-in callback
│   ├── setup.ts      # helper endpoint to set Telegram webhook
│   └── health.ts     # environment/health check
├── lib/
│   ├── llm.ts        # Emi prompt, LLM calls, translation, grammar explanation
│   ├── redis.ts      # conversation, memory, and schedule storage
│   ├── telegram.ts   # Telegram API helpers
│   ├── qstash.ts     # check-in scheduling
│   ├── whisper.ts    # voice transcription
│   └── types.ts      # shared TypeScript types
├── scripts/
│   ├── inspect-redis.ts
│   └── cleanup-redis.ts
└── package.json
```

## Environment variables

See `.env.example` for the full list. Required in production:

```bash
TELEGRAM_BOT_TOKEN=
ALLOWED_USERS=
BASE_URL=
REDIS_KEY_PREFIX=lang:
USER_TIMEZONE=America/Mexico_City
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
OPENROUTER_API_KEY=
OPENAI_API_KEY=
```

Optional:

```bash
OPENROUTER_MODEL_CHAT=
OPENROUTER_MODEL_INTENT=
BRAINTRUST_API_KEY=
BRAINTRUST_PROJECT_ID=
```

## Development

```bash
npm install
npm run type-check
npm run dev
```

Local Telegram webhook testing requires a public tunnel such as ngrok.

## Deployment checklist

Before using it again:

1. Confirm the Cloudflare Worker is configured and deployed.
2. Confirm production secrets and variables are present in Cloudflare.
3. Visit `/api/health` on the deployment URL.
4. Set Telegram webhook via `/api/setup?url=https://your-worker.workers.dev` or the Telegram API.
5. Send a real Telegram message to Emi.
6. Test `/eng` and `/exp`.
7. Keep `/checkin off` unless proactive practice is explicitly wanted.

## Triage note — 2026-06-13

Reviewed as part of a Saturday chaos sprint. The codebase is still viable and type-checks cleanly, but it should stay bounded: **optional focused conversation tool, not the main Japanese practice system**. The most useful ideas to salvage elsewhere are the `/eng` + `/exp` flow, furigana-first Japanese output, memory-backed conversation, and voice-message support.
