import { Command } from "commander";
import { runSetup } from "./setup.js";

const program = new Command();

program
  .name("svarog")
  .description("Telegram bot that manages Claude Code worker sessions on your projects")
  .version("0.1.0");

program
  .command("setup")
  .description("Interactive setup wizard — configure Telegram bot, auth, and projects")
  .action(async () => {
    await runSetup();
  });

program.parse();
