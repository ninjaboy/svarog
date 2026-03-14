# Svarog

<p align="center">
  <img src="assets/svarog-art.jpg" alt="Svarog" width="480" />
  <br />
  <em>As seen through my son's eyes via ChatGPT</em>
</p>

A Telegram bot that manages [Claude Code](https://docs.anthropic.com/en/docs/claude-code) worker sessions on your projects. Send tasks in natural language via Telegram, and Svarog spawns AI workers to implement them across your codebases.

## Features

- **Natural language dispatch** — describe tasks in Telegram, workers execute them
- **Multi-project support** — auto-scans your projects directory, routes tasks to the right repo
- **Plan-review workflow** — workers propose plans, you approve or reject before execution
- **Follow-ups & questions** — send additional instructions or answer worker questions inline
- **Scheduled tasks** — cron-based worker spawning for recurring automation
- **Health monitoring** — auto-recovery for Telegram polling and SDK sessions
- **Idle worker detection** — alerts and cleanup for stalled workers

## Architecture

```
                        incoming messages
+----------+    +----------+    +-----------+    +------------+    +-------------+
| Telegram |----> Telegram |----> Svarog  |----> Dispatcher |----> Worker Pool |
|   User   |    | Bot      |    | Session   |    | (router)   |    | (Claude Code)|
+----------+    +----+-----+    +-----------+    +-----+------+    +------+------+
                     ^                                 |                  |
                     |   formatted messages,           |                  |
                     |   questions, photos             |                  |
                     +---------------------------------+------------------+
                        responses & notifications

+-----------+    +----------+    +-----------------+
| Scheduler |    | Watchdog |    | Health Monitor  |
| (cron)    |    | (idle)   |    | (auto-recovery) |
+-----------+    +----------+    +-----------------+
```

**Message flow:** User sends a Telegram message → Svarog Session (a persistent Claude Code subprocess) classifies the intent → Dispatcher routes it → Worker (another Claude Code subprocess) executes the task on the target project → Results sent back via Telegram.

## Prerequisites

- **Node.js 22+**
- **Claude Code CLI** — install and authenticate with `claude login`
- **Telegram bot** — create one via [@BotFather](https://t.me/BotFather)
- **macOS or Linux** (token auto-refresh requires macOS Keychain; on Linux, use API key auth)

## Quick Start

```bash
# 1. Clone
git clone https://github.com/anthropics/svarog.git
cd svarog

# 2. Install dependencies
npm install

# 3. Run interactive setup
npm run setup

# 4. Start the bot
npm run dev
```

The setup wizard will guide you through configuring your Telegram bot token, user ID, authentication, and projects directory.

### Manual Configuration

Alternatively, copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
# Edit .env with your values
```

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USERS` | Yes | — | Comma-separated Telegram user IDs with access |
| `ANTHROPIC_AUTH_TOKEN` | One of these | — | OAuth token (from `claude login`) |
| `ANTHROPIC_API_KEY` | One of these | — | API key (alternative to OAuth) |
| `PROJECTS_DIR` | No | `~/projects` | Directory to scan for projects |
| `DB_PATH` | No | `./data/svarog.db` | SQLite database file path |
| `HEALTH_PORT` | No | `3847` | HTTP health endpoint port |
| `WATCHDOG_INTERVAL_MS` | No | `1500` | Idle worker check frequency (ms) |
| `WORKER_IDLE_TIMEOUT_S` | No | `300` | Seconds before worker idle alert |
| `WORKER_SESSION_TIMEOUT_S` | No | `7200` | Seconds before idle worker cleanup |
| `WORKER_RESUME_MAX_AGE_S` | No | `3600` | Max age for worker session resume |
| `LOG_LEVEL` | No | `info` | Log level: trace, debug, info, warn, error, fatal |
| `USER_TIMEZONE` | No | `UTC` | Timezone for scheduled tasks |

### Authentication

Svarog needs Anthropic credentials to run Claude Code workers. Two options:

1. **OAuth (recommended):** Run `claude login` to authenticate via the Claude Code CLI. Svarog reads the OAuth token from the macOS Keychain and auto-refreshes it.

2. **API Key:** Set `ANTHROPIC_API_KEY` in `.env`. Works on all platforms. No auto-refresh needed (keys don't expire).

On Linux, the Keychain-based token refresh is unavailable. Use an API key or manually provide `ANTHROPIC_AUTH_TOKEN` in `.env`.

## How It Works

1. **Svarog Session** — A persistent Claude Code subprocess that classifies every incoming Telegram message into intents (spawn worker, follow up, approve plan, answer question, etc.)

2. **Dispatcher** — Routes classified intents to the right handler: spawning new workers, delivering follow-ups, resolving plan approvals, routing answers to pending questions.

3. **Workers** — Each worker is an independent Claude Code subprocess running against a specific project directory. Workers can propose plans (requiring your approval), ask questions, and deliver results.

4. **Scheduler** — Supports cron-based task scheduling. Create recurring workers that run on a schedule.

5. **Health Monitor** — Checks Telegram polling and SDK session health. Auto-restarts components on failure. Exposes an HTTP `/health` endpoint.

## Development

```bash
npm run dev           # Run with tsx (auto-loads .env)
npm run build         # TypeScript compile to dist/
npm run db:generate   # Generate Drizzle migrations
npm run db:migrate    # Apply migrations
npm run db:studio     # Interactive DB browser
```

## Deployment

See [docs/deployment.md](docs/deployment.md) for production deployment on macOS (launchd) and Linux (systemd).

## License

[MIT](LICENSE)
