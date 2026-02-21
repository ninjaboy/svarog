import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config/index.js";
import { upsertProject } from "../db/queries.js";
import { createChildLogger } from "./logger.js";

const log = createChildLogger("project-registry");

export function scanAndRegisterProjects(): number {
  const config = getConfig();
  const dir = config.PROJECTS_DIR;
  let count = 0;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    log.error({ err, dir }, "Failed to read projects directory");
    return 0;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (!stat.isDirectory()) continue;
      if (entry.startsWith(".")) continue;

      upsertProject(entry, fullPath);
      count++;
    } catch {
      // skip entries we can't stat
    }
  }

  // Register the "general" project so general workers have a valid FK reference
  const generalWorkerDir = join(process.cwd(), "concierg-workspace", "general-worker");
  upsertProject("general", generalWorkerDir);
  count++;

  log.info("Registered %d projects from %s", count, dir);
  return count;
}
