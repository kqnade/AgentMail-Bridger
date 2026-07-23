import { readFile } from "node:fs/promises";

export interface Mapping {
  worker: string;
  manager: string;
}

export interface Config {
  socketPath: string;
  mappings: Mapping[];
  prompt: string;
  reconnectDelayMs: number;
}

interface FileConfig {
  socketPath?: string;
  mappings?: Mapping[];
  prompt?: string;
  reconnectDelayMs?: number;
}

export async function loadConfig(
  path?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Config> {
  let fileConfig: FileConfig = {};
  if (path) {
    fileConfig = JSON.parse(await readFile(path, "utf8"));
  }

  const mappings = fileConfig.mappings ?? parseMappings(env.AGENTMAIL_BRIDGER_MAPPINGS);
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new Error(
      "No worker mappings configured. Set mappings in the config file or AGENTMAIL_BRIDGER_MAPPINGS.",
    );
  }

  const workers = new Set<string>();
  for (const [index, mapping] of mappings.entries()) {
    if (!mapping || typeof mapping.worker !== "string" || typeof mapping.manager !== "string") {
      throw new Error(`mappings[${index}] must contain string worker and manager targets`);
    }
    if (workers.has(mapping.worker)) {
      throw new Error(`Duplicate worker mapping: ${mapping.worker}`);
    }
    workers.add(mapping.worker);
  }

  return {
    socketPath:
      fileConfig.socketPath ??
      env.HERDR_SOCKET_PATH ??
      `${env.HOME}/.config/herdr/herdr.sock`,
    mappings,
    prompt:
      fileConfig.prompt ??
      "Worker {{workers}} completed. Check Agent Mail now, collect their replies, and continue coordinating the task.",
    reconnectDelayMs: fileConfig.reconnectDelayMs ?? 1_000,
  };
}

function parseMappings(value: string | undefined): Mapping[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((pair) => {
    const separator = pair.indexOf(":");
    if (separator < 1 || separator === pair.length - 1) {
      throw new Error(`Invalid worker:manager mapping: ${pair}`);
    }
    return {
      worker: pair.slice(0, separator).trim(),
      manager: pair.slice(separator + 1).trim(),
    };
  });
}
