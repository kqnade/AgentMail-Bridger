#!/usr/bin/env node
import { Bridge } from "./bridge.js";
import { loadConfig } from "./config.js";

function configPath(argv: string[]): string | undefined {
  const index = argv.indexOf("--config");
  if (index < 0) return undefined;
  if (!argv[index + 1]) throw new Error("--config requires a path");
  return argv[index + 1];
}

try {
  const config = await loadConfig(configPath(process.argv.slice(2)));
  const bridge = new Bridge(config);
  process.once("SIGINT", () => bridge.stop());
  process.once("SIGTERM", () => bridge.stop());
  await bridge.run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
