import * as p from "@clack/prompts";
import { validateTelegramToken, validateProjectsDir, validateClaudeCli } from "./validate.js";
import { writeEnvFile, type EnvValues } from "./env-writer.js";

function guardCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return value;
}

export async function runSetup(): Promise<void> {
  p.intro("Conciergon Setup");

  p.note(
    "This wizard will help you configure Conciergon.\n" +
      "You'll need:\n" +
      "  1. A Telegram bot token (from @BotFather)\n" +
      "  2. Your Telegram user ID\n" +
      "  3. Claude Code CLI installed & authenticated",
    "Prerequisites"
  );

  // ── Step 1: Telegram Bot Token ──────────────────────────────
  const botToken = guardCancel(
    await p.text({
      message: "Telegram Bot Token",
      placeholder: "123456:ABC-DEF...",
      validate(value) {
        if (!value?.trim()) return "Required";
        if (!/^\d+:[A-Za-z0-9_-]+$/.test(value.trim())) {
          return "Invalid format. Expected: 123456:ABC-DEF...";
        }
      },
    })
  ) as string;

  // Verify token
  const spin = p.spinner();
  spin.start("Verifying bot token...");
  const tokenResult = await validateTelegramToken(botToken.trim());
  if (tokenResult.valid && tokenResult.botName) {
    spin.stop(`Bot verified: @${tokenResult.botName}`);
  } else if (tokenResult.valid) {
    spin.stop(`Token format OK (could not verify online: ${tokenResult.error})`);
  } else {
    spin.stop(`Token invalid: ${tokenResult.error}`);
    p.cancel("Please check your bot token and try again.");
    process.exit(1);
  }

  // ── Step 2: Telegram User ID ────────────────────────────────
  const userId = guardCancel(
    await p.text({
      message: "Your Telegram User ID",
      placeholder: "123456789",
      validate(value) {
        if (!value?.trim()) return "Required";
        const ids = value.split(",").map((s) => s.trim());
        for (const id of ids) {
          if (!/^\d+$/.test(id)) return `Invalid user ID: "${id}" (must be a number)`;
        }
      },
    })
  ) as string;

  p.note(
    "Tip: Send /start to @userinfobot on Telegram to find your user ID.",
    "How to find your ID"
  );

  // ── Step 3: Authentication ──────────────────────────────────
  const authMethod = guardCancel(
    await p.select({
      message: "How do you authenticate with Anthropic?",
      options: [
        {
          value: "oauth",
          label: "Claude Code OAuth (recommended)",
          hint: "run `claude login` first",
        },
        {
          value: "apikey",
          label: "API Key",
          hint: "ANTHROPIC_API_KEY",
        },
      ],
    })
  ) as string;

  let authToken: string | undefined;
  let apiKey: string | undefined;

  if (authMethod === "oauth") {
    const cliCheck = validateClaudeCli();
    if (cliCheck.found) {
      p.log.success(`Claude Code CLI found: ${cliCheck.path}`);
      p.note(
        "Make sure you've run `claude login` to authenticate.\n" +
          "Conciergon will use your OAuth token automatically.",
        "OAuth Authentication"
      );
    } else {
      p.log.warning("Claude Code CLI not found in PATH.");
      p.note(
        "Install Claude Code CLI and run `claude login` before starting Conciergon.\n" +
          "See: https://docs.anthropic.com/en/docs/claude-code",
        "Action Required"
      );
    }
  } else {
    apiKey = guardCancel(
      await p.text({
        message: "Anthropic API Key",
        placeholder: "sk-ant-api03-...",
        validate(value) {
          if (!value?.trim()) return "Required";
          if (!value.trim().startsWith("sk-ant-")) return "Expected format: sk-ant-...";
        },
      })
    ) as string;
  }

  // ── Step 4: Projects Directory ──────────────────────────────
  const projectsDir = guardCancel(
    await p.text({
      message: "Projects directory (where your code projects live)",
      initialValue: "~/projects",
      validate(value) {
        if (!value?.trim()) return "Required";
      },
    })
  ) as string;

  const dirCheck = validateProjectsDir(projectsDir.trim());
  if (dirCheck.valid) {
    const count = dirCheck.projects.length;
    if (count > 0) {
      const preview = dirCheck.projects.slice(0, 8).join(", ");
      const suffix = count > 8 ? `, ... and ${count - 8} more` : "";
      p.log.success(`Found ${count} projects: ${preview}${suffix}`);
    } else {
      p.log.warning("No projects found in that directory (it's empty or has only hidden folders).");
    }
  } else {
    p.log.warning(dirCheck.error!);
    p.log.info("You can create this directory later. Conciergon will scan it on startup.");
  }

  // ── Step 5: Optional Settings ───────────────────────────────
  const configureOptional = guardCancel(
    await p.confirm({
      message: "Configure optional settings? (health port, log level, timezone)",
      initialValue: false,
    })
  );

  let logLevel: string | undefined;
  let timezone: string | undefined;
  let healthPort: number | undefined;
  if (configureOptional) {
    logLevel = guardCancel(
      await p.select({
        message: "Log level",
        options: [
          { value: "info", label: "info (default)" },
          { value: "debug", label: "debug" },
          { value: "trace", label: "trace (verbose)" },
          { value: "warn", label: "warn (quiet)" },
        ],
      })
    ) as string;

    timezone = guardCancel(
      await p.text({
        message: "Your timezone",
        initialValue: "UTC",
        placeholder: "America/New_York",
      })
    ) as string;

    const portStr = guardCancel(
      await p.text({
        message: "Health endpoint port",
        initialValue: "3847",
        validate(value) {
          const n = Number(value);
          if (isNaN(n) || n < 1 || n > 65535) return "Must be a valid port (1-65535)";
        },
      })
    ) as string;
    healthPort = Number(portStr);
  }

  // ── Step 6: Write .env ──────────────────────────────────────
  const values: EnvValues = {
    TELEGRAM_BOT_TOKEN: botToken.trim(),
    TELEGRAM_ALLOWED_USERS: userId.trim(),
    PROJECTS_DIR: projectsDir.trim(),
    ...(authToken ? { ANTHROPIC_AUTH_TOKEN: authToken } : {}),
    ...(apiKey ? { ANTHROPIC_API_KEY: apiKey.trim() } : {}),
    ...(logLevel && logLevel !== "info" ? { LOG_LEVEL: logLevel } : {}),
    ...(timezone && timezone !== "UTC" ? { USER_TIMEZONE: timezone.trim() } : {}),
    ...(healthPort && healthPort !== 3847 ? { HEALTH_PORT: healthPort } : {}),
  };

  writeEnvFile(values);
  p.log.success(".env file created successfully");

  // ── Step 7: Summary ─────────────────────────────────────────
  const summaryLines = [
    `Bot: @${tokenResult.botName ?? "unknown"}`,
    `Users: ${userId.trim()}`,
    `Auth: ${authMethod === "oauth" ? "OAuth (claude login)" : "API Key"}`,
    `Projects: ${projectsDir.trim()}`,
  ];
  if (logLevel && logLevel !== "info") summaryLines.push(`Log level: ${logLevel}`);
  if (timezone && timezone !== "UTC") summaryLines.push(`Timezone: ${timezone}`);

  p.note(summaryLines.join("\n"), "Configuration");

  p.outro("Setup complete! Run `npm run dev` to start Conciergon.");
}
