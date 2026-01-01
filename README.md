# Japanese Language Learning Bot (Sakura-sensei)

A Telegram bot that teaches Japanese (JLPT N5) through daily conversational lessons over 30 days. Uses a hybrid approach: predefined syllabus structure with LLM-generated exercises and explanations.

## Features

- **30-day N5 curriculum**: Vocabulary, grammar, kanji, and cultural notes
- **Adaptive learning**: Tracks mastery and focuses on weak areas
- **Multiple exercise types**: Translation, reading, grammar formation
- **Voice input support**: Practice pronunciation with Whisper transcription
- **Progress tracking**: Streaks, scores, and mastery levels
- **Sakura-sensei personality**: Patient, encouraging Japanese tutor

## Setup Instructions

### 1. Create a Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts
3. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Get Your Telegram User ID

1. Search for `@userinfobot` on Telegram
2. Start a chat with it - it will show your user ID
3. Copy this number for the `ALLOWED_USERS` env var

### 3. Set Up External Services

#### Upstash Redis
1. Go to [upstash.com](https://upstash.com) and create an account
2. Create a new Redis database
3. Copy the `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`

#### Upstash QStash
1. In Upstash console, go to QStash
2. Copy the `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, and `QSTASH_NEXT_SIGNING_KEY`

#### OpenRouter (LLM)
1. Go to [openrouter.ai](https://openrouter.ai) and create an account
2. Add credits and create an API key
3. Copy the `OPENROUTER_API_KEY`

#### OpenAI (Whisper for voice)
1. Go to [platform.openai.com](https://platform.openai.com) and create an account
2. Create an API key
3. Copy the `OPENAI_API_KEY`

#### Braintrust (Observability - Optional)
1. Go to [braintrust.dev](https://braintrust.dev) and create an account
2. Create a new project called "Japanese Language Bot"
3. Copy the `BRAINTRUST_API_KEY`

### 4. Deploy to Vercel

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) and import the repository
3. Add all environment variables (see below)
4. Deploy

### 5. Set Up Telegram Webhook

After deployment, set the webhook by visiting:
```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_VERCEL_URL>/api/telegram
```

### 6. Environment Variables

Create these in Vercel (or `.env.local` for local development):

```bash
# Telegram
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
ALLOWED_USERS=your-telegram-user-id

# Your Vercel deployment URL
BASE_URL=https://your-app.vercel.app

# Redis namespace (prevents collision with other bots)
REDIS_KEY_PREFIX=lang:

# Timezone for lesson scheduling
USER_TIMEZONE=America/Mexico_City

# Upstash Redis
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxx

# Upstash QStash
QSTASH_TOKEN=xxx
QSTASH_CURRENT_SIGNING_KEY=xxx
QSTASH_NEXT_SIGNING_KEY=xxx

# OpenRouter (LLM)
OPENROUTER_API_KEY=sk-or-v1-xxx

# OpenAI (Whisper voice transcription)
OPENAI_API_KEY=sk-xxx

# Braintrust (observability - optional)
BRAINTRUST_API_KEY=xxx
BRAINTRUST_PROJECT_NAME=Japanese Language Bot
```

## Multi-Tenancy (Sharing with ADHD Bot)

If you're sharing Redis/QStash with another bot (like the ADHD bot), the `REDIS_KEY_PREFIX` ensures no key collisions:

- ADHD Bot: `REDIS_KEY_PREFIX=adhd:`
- Language Bot: `REDIS_KEY_PREFIX=lang:`

All Redis keys are automatically prefixed, so `user:123` becomes `lang:user:123`.

## Usage

### Basic Commands

| Command | Description |
|---------|-------------|
| `/start` | Start or restart your learning journey |
| `/lesson` | Begin today's lesson |
| `/progress` | View your learning stats |
| `/weak` | Review your weak areas |
| `/help` | Show help message |

### Lesson Flow

1. **Intro**: Overview of the day's content
2. **Vocabulary**: Learn new words with examples
3. **Grammar**: New patterns with explanations
4. **Kanji**: Character study with mnemonics
5. **Practice**: Exercises for each section
6. **Assessment**: Final quiz (70% to pass)

### During Lessons

- Type answers to exercises
- Say "hint" for progressive hints
- Say "skip" to move on
- Send voice messages for pronunciation practice

## Curriculum Overview

| Week | Days | Theme |
|------|------|-------|
| 1 | 1-5 | Foundations: greetings, self-intro, numbers, particles |
| 2 | 6-10 | Daily Life: time, dates, routines, family |
| 3 | 11-15 | Actions & Places: verbs, locations, transportation |
| 4 | 16-20 | Descriptions: adjectives, comparisons, preferences |
| 5 | 21-25 | Social: shopping, dining, requests |
| 6 | 26-30 | Integration: complex sentences, review |

## Project Structure

```
language-bot/
├── api/
│   ├── telegram.ts      # Telegram webhook handler
│   └── notify.ts        # QStash notification handler
├── lib/
│   ├── types.ts         # TypeScript interfaces
│   ├── redis.ts         # Redis data access
│   ├── llm.ts           # LLM integration
│   ├── telegram.ts      # Telegram API helpers
│   ├── qstash.ts        # Notification scheduling
│   ├── whisper.ts       # Voice transcription
│   ├── syllabus.ts      # Syllabus loading
│   └── lesson-engine.ts # Lesson state machine
├── data/
│   └── syllabus/
│       └── n5/
│           ├── index.json
│           └── days/
│               ├── day01.json
│               └── ... (30 days)
└── package.json
```

## Development

```bash
# Install dependencies
npm install

# Type check
npm run type-check

# Build
npm run build

# Local development (requires vercel CLI)
vercel dev
```

## Troubleshooting

### Bot not responding
1. Check webhook is set correctly
2. Verify `TELEGRAM_BOT_TOKEN` is correct
3. Check Vercel function logs for errors

### Lessons not advancing
1. Check Redis connection
2. Verify `REDIS_KEY_PREFIX` is consistent
3. Check lesson progress in Redis

### Voice messages not working
1. Verify `OPENAI_API_KEY` is set
2. Check Whisper API quota

## License

MIT
