import { Coordinator } from "./coordinator.js";
import { HerdrClient, type HerdrAgent, type StatusEvent } from "./herdr-client.js";
import type { Config, Mapping } from "./config.js";

interface Logger {
  info(message: string): void;
  error(message: string): void;
}

interface BufferedStatusEvent {
  target: string;
  status: StatusEvent["data"]["agent_status"];
}

export class Bridge {
  #config: Config;
  #logger: Logger;
  #stopped = false;
  #client: HerdrClient | undefined;
  #coordinator?: Coordinator;
  #lookup = new Map<string, string>();

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
    try {
      const snapshot = await client.snapshot();
      this.#lookup = buildTargetLookup(snapshot.agents, this.#config.mappings);
      const initialize = !this.#coordinator;
      this.#coordinator ??= new Coordinator({
        client: {
          sendPrompt: (target, text, stage) => {
            const activeClient = this.#client;
            const paneId = this.#lookup.get(target);
            if (!activeClient || !paneId) {
              throw new Error(`target is not present in the active Herdr snapshot: ${target}`);
            }
            return activeClient.sendPrompt(paneId, text, stage);
          },
        },
        mappings: this.#config.mappings,
        prompt: this.#config.prompt,
        logger: this.#logger,
      });
      this.#coordinator.resetPartialDeliveries();

      await reconcileStatuses(
        this.#coordinator,
        snapshot.agents,
        this.#lookup,
        this.#config.mappings,
        initialize,
      );

      const paneTargets = new Map([...this.#lookup].map(([target, paneId]) => [paneId, target]));
      const bufferedEvents: BufferedStatusEvent[] = [];
      let reconciling = true;
      let eventChain = Promise.resolve();
      client.on("event", (event: StatusEvent) => {
        if (event.event !== "pane.agent_status_changed") return;
        const target = paneTargets.get(event.data.pane_id);
        if (!target) return;
        if (reconciling) {
          bufferedEvents.push({ target, status: event.data.agent_status });
          return;
        }
        eventChain = eventChain.then(async () => {
          await this.#coordinator?.statusChanged(target, event.data.agent_status);
        });
      });

      const closed = new Promise<void>((resolve) => client.once("close", resolve));
      await client.subscribe([...new Set(this.#lookup.values())]);

      // Close the snapshot/subscribe race: any transition after the first snapshot
      // is either received as an event or reflected in this second snapshot.
      const subscribedSnapshot = await client.snapshot();
      const subscribedLookup = buildTargetLookup(
        subscribedSnapshot.agents,
        this.#config.mappings,
      );
      if (!sameLookup(this.#lookup, subscribedLookup)) {
        throw new Error("Herdr agent targets changed while establishing subscriptions");
      }
      await reconcileStatuses(
        this.#coordinator,
        subscribedSnapshot.agents,
        subscribedLookup,
        this.#config.mappings,
        false,
      );
      reconciling = false;
      for (const event of eventsAfterSnapshot(
        bufferedEvents,
        subscribedSnapshot.agents,
        subscribedLookup,
      )) {
        eventChain = eventChain.then(async () => {
          await this.#coordinator?.statusChanged(event.target, event.status);
        });
      }
      await eventChain;

      this.#logger.info(`subscribed to ${this.#lookup.size} Herdr agent target(s)`);
      await closed;
    } finally {
      client.close();
      if (this.#client === client) this.#client = undefined;
    }
  }
}

export function eventsAfterSnapshot(
  events: BufferedStatusEvent[],
  agents: HerdrAgent[],
  lookup: Map<string, string>,
): BufferedStatusEvent[] {
  const snapshotStatuses = new Map(
    [...lookup].flatMap(([target, paneId]) => {
      const agent = agents.find((candidate) => candidate.pane_id === paneId);
      return agent ? [[target, agent.agent_status] as const] : [];
    }),
  );
  const representedThrough = new Map<string, number>();

  for (const [index, event] of events.entries()) {
    if (snapshotStatuses.get(event.target) === event.status) {
      representedThrough.set(event.target, index);
    }
  }

  return events.filter(
    (event, index) => index > (representedThrough.get(event.target) ?? -1),
  );
}

export async function reconcileStatuses(
  coordinator: Coordinator,
  agents: HerdrAgent[],
  lookup: Map<string, string>,
  mappings: Mapping[],
  initialize: boolean,
): Promise<void> {
  const managers = new Set(mappings.map(({ manager }) => manager));
  const orderedTargets = [
    ...[...lookup.keys()].filter((target) => managers.has(target)),
    ...[...lookup.keys()].filter((target) => !managers.has(target)),
  ];

  const statuses = orderedTargets.flatMap((target) => {
    const paneId = lookup.get(target);
    const agent = agents.find((candidate) => candidate.pane_id === paneId);
    return agent ? [{ target, status: agent.agent_status }] : [];
  });

  if (initialize) {
    for (const { target, status } of statuses) {
      coordinator.setInitialStatus(target, status);
    }
  } else {
    await coordinator.statusesChanged(statuses);
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

function sameLookup(left: Map<string, string>, right: Map<string, string>): boolean {
  return (
    left.size === right.size &&
    [...left].every(([target, paneId]) => right.get(target) === paneId)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
