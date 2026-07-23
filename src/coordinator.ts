import type { Mapping } from "./config.js";

const SETTLED = new Set<AgentStatus>(["idle", "done"]);

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

interface PromptClient {
  sendPrompt(target: string, text: string): Promise<void>;
}

interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export class Coordinator {
  #client: PromptClient;
  #logger: Logger;
  #promptTemplate: string;
  #workers = new Map<string, string>();
  #managers = new Map<string, Set<string>>();
  #statuses = new Map<string, AgentStatus>();
  #pending = new Map<string, Set<string>>();
  #flushing = new Set<string>();
  #retryTimers = new Map<string, NodeJS.Timeout>();
  #retryDelayMs: number;

  constructor({
    client,
    mappings,
    prompt,
    logger = console,
    retryDelayMs = 1_000,
  }: {
    client: PromptClient;
    mappings: Mapping[];
    prompt: string;
    logger?: Logger;
    retryDelayMs?: number;
  }) {
    this.#client = client;
    this.#logger = logger;
    this.#promptTemplate = prompt;
    this.#retryDelayMs = retryDelayMs;

    for (const { worker, manager } of mappings) {
      this.#workers.set(worker, manager);
      if (!this.#managers.has(manager)) this.#managers.set(manager, new Set());
      this.#managers.get(manager)?.add(worker);
    }
  }

  setInitialStatus(target: string, status: AgentStatus): void {
    this.#statuses.set(target, status);
  }

  async statusChanged(target: string, status: AgentStatus): Promise<void> {
    const previous = this.#statuses.get(target);
    this.#statuses.set(target, status);

    if (this.#workers.has(target) && status === "done" && previous !== "done") {
      const manager = this.#workers.get(target);
      if (!manager) return;
      if (!this.#pending.has(manager)) this.#pending.set(manager, new Set());
      this.#pending.get(manager)?.add(target);
      this.#logger.info(`queued Agent Mail check: worker=${target} manager=${manager}`);
      await this.#flushIfSettled(manager);
    }

    if (this.#managers.has(target) && SETTLED.has(status)) {
      await this.#flushIfSettled(target);
    }
  }

  pending(manager: string): string[] {
    return [...(this.#pending.get(manager) ?? [])];
  }

  async #flushIfSettled(manager: string): Promise<void> {
    const workers = this.#pending.get(manager);
    if (!workers?.size || !SETTLED.has(this.#statuses.get(manager) ?? "unknown")) return;
    if (this.#flushing.has(manager)) return;

    const retryTimer = this.#retryTimers.get(manager);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.#retryTimers.delete(manager);
    }
    this.#flushing.add(manager);
    const batch = [...workers];
    try {
      const prompt = this.#promptTemplate.replaceAll("{{workers}}", batch.join(", "));
      await this.#client.sendPrompt(manager, prompt);
      for (const worker of batch) workers.delete(worker);
      if (workers.size === 0) this.#pending.delete(manager);
      this.#logger.info(
        `sent Agent Mail check prompt: manager=${manager} workers=${batch.join(",")}`,
      );
    } catch (error) {
      this.#logger.error(
        `failed to prompt manager=${manager}: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.#scheduleRetry(manager);
    } finally {
      this.#flushing.delete(manager);
    }
  }

  #scheduleRetry(manager: string): void {
    if (this.#retryTimers.has(manager)) return;
    const timer = setTimeout(() => {
      this.#retryTimers.delete(manager);
      void this.#flushIfSettled(manager);
    }, this.#retryDelayMs);
    timer.unref();
    this.#retryTimers.set(manager, timer);
  }
}
