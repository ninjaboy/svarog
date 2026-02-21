# Conciergon Development Rules

## Server Restart

After ANY code changes, ALWAYS restart the dev server. Kill the existing process first, then start fresh:

```
npm run dev
```

Never leave code changes untested. The server must be running to verify changes work.

## Project Overview

Conciergon is a Telegram bot that manages Claude Code worker sessions on projects. It uses a persistent ConciergSession (Claude Code SDK subprocess) for message classification and conversational replies, with a local regex classifier as fallback.

## Key Architecture

- `src/concierg/session.ts` — Persistent ConciergSession with AsyncQueue bridging Telegram (push) to SDK (pull)
- `src/concierg/index.ts` — Session lifecycle + classify() with local fallback
- `src/dispatcher/index.ts` — Worker orchestration, question/answer flow
- `src/watchdog/index.ts` — Idle worker monitoring only
- `src/index.ts` — Direct classify-and-act flow (no watchdog polling for intents)

## Dev Commands

- `npm run dev` — Run with tsx (auto-loads .env)
- `npm run build` — TypeScript compile to dist/
