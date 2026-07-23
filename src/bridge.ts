import { Coordinator } from "./coordinator.js";
import { HerdrClient, type HerdrAgent, type StatusEvent } from "./herdr-client.js";
import type { Config, Mapping } from "./config.js";

interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export class Bridge {
  #config: Config;
  #logger: Logger;
  #stopped = false;
  #client?: HerdrClient;

  constructor(config: Config, logger: Logger = console) {
    this.#config = config;
    this.#logger = logger;
  }

  async run(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.#runConnection();
      } catch (error) {
        if (!this.#stopped) {
          this.#logger.error(
            `Herdr connection failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!this.#stopped) await delay(this.#config.reconnectDelayMs);
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#client?.close();
  }

  async #runConnection(): Promise<void> {
    const client = new HerdrClient(this.#config.socketPath);
    this.#client = client;
    const snapshot = await client.snapshot();
    const lookup = buildTargetLookup(snapshot.agents, this.#config.mappings);
    const coordinator = new Coordinator({
      client: {
        sendPrompt: (target, text) => {
          const paneId = lookup.get(target);
          if (!paneId) throw new Error(`target is not present in Herdr snapshot: ${target}`);
          return client.sendPrompt(paneId, text);
        },
      },
      mappings: this.#config.mappings,
      prompt: this.#config.prompt,
      logger: this.#logger,
    });

    for (const [target, paneId] of lookup) {
      const agent = snapshot.agents.find((candidate) => candidate.pane_id === paneId);
      if (agent) coordinator.setInitialStatus(target, agent.agent_status);
    }

    const paneTargets = new Map([...lookup].map(([target, paneId]) => [paneId, target]));
    client.on("event", (event: StatusEvent) => {
      if (event.event !== "pane.agent_status_changed") return;
      const target = paneTargets.get(event.data.pane_id);
      if (target) void coordinator.statusChanged(target, event.data.agent_status);
    });

    await client.subscribe([...new Set(lookup.values())]);
    this.#logger.info(`subscribed to ${lookup.size} Herdr agent target(s)`);
    await new Promise<void>((resolve) => client.once("close", resolve));
  }
}

export function buildTargetLookup(
  agents: HerdrAgent[],
  mappings: Mapping[],
): Map<string, string> {
  const targets = new Set(mappings.flatMap(({ worker, manager }) => [worker, manager]));
  const lookup = new Map<string, string>();

  for (const target of targets) {
    const matches = agents.filter((agent) => agent.name === target || agent.pane_id === target);
    if (matches.length === 0) throw new Error(`Herdr agent target not found: ${target}`);
    if (matches.length > 1) throw new Error(`Herdr agent target is ambiguous: ${target}`);
    const paneId = matches[0]?.pane_id;
    if (!paneId) throw new Error(`Herdr agent target has no pane: ${target}`);
    lookup.set(target, paneId);
  }
  return lookup;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
