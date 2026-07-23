import net from "node:net";
import { EventEmitter } from "node:events";
import type { AgentStatus } from "./coordinator.js";
import {
  PromptTextDeliveredError,
  type PromptDeliveryStage,
} from "./prompt-client.js";

export interface HerdrAgent {
  agent: string;
  name?: string;
  pane_id: string;
  agent_status: AgentStatus;
}

export interface SessionSnapshot {
  protocol: number;
  agents: HerdrAgent[];
}

export interface StatusEvent {
  event: "pane.agent_status_changed";
  data: {
    pane_id: string;
    workspace_id: string;
    agent_status: AgentStatus;
  };
}

type ApiMessage =
  | { id: string; result: unknown }
  | { id: string; error: { code: string; message: string } }
  | StatusEvent;

export class HerdrClient extends EventEmitter {
  #socketPath: string;
  #createConnection: (path: string) => net.Socket;
  #subscriptionSocket: net.Socket | undefined;
  #sequence = 0;

  constructor(
    socketPath: string,
    createConnection: (path: string) => net.Socket = net.createConnection,
  ) {
    super();
    this.#socketPath = socketPath;
    this.#createConnection = createConnection;
  }

  close(): void {
    this.#subscriptionSocket?.destroy();
  }

  async snapshot(): Promise<SessionSnapshot> {
    const response = await this.request<{ snapshot: SessionSnapshot }>("session.snapshot", {});
    return response.snapshot;
  }

  async subscribe(paneIds: string[]): Promise<void> {
    if (paneIds.length === 0) return;
    if (this.#subscriptionSocket) throw new Error("Already subscribed");

    const socket = this.#createConnection(this.#socketPath);
    this.#subscriptionSocket = socket;
    const lines = lineReader(socket);
    let closeEmitted = false;
    const emitClose = () => {
      if (closeEmitted) return;
      closeEmitted = true;
      if (this.#subscriptionSocket === socket) this.#subscriptionSocket = undefined;
      this.emit("close");
    };
    socket.once("close", emitClose);
    socket.on("error", (error) => this.emit("socketError", error));
    await onceConnected(socket);
    socket.write(
      `${this.#encode("events.subscribe", {
        subscriptions: paneIds.map((pane_id) => ({
          type: "pane.agent_status_changed",
          pane_id,
        })),
      })}\n`,
    );

    const first = await lines.next();
    if (first.done) throw new Error("Herdr subscription closed before acknowledgement");
    const acknowledgement = parseMessage(first.value);
    if ("error" in acknowledgement) throw apiError(acknowledgement);

    void this.#consumeEvents(lines, emitClose);
  }

  async sendPrompt(
    paneId: string,
    text: string,
    stage: PromptDeliveryStage = "full",
  ): Promise<void> {
    if (stage === "full") {
      await this.request("pane.send_text", { pane_id: paneId, text });
    }
    try {
      await this.request("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
    } catch (error) {
      throw new PromptTextDeliveredError("prompt text delivered but Enter failed", {
        cause: error,
      });
    }
  }

  async request<T>(method: string, params: object): Promise<T> {
    const socket = this.#createConnection(this.#socketPath);
    const lines = lineReader(socket);
    await onceConnected(socket);
    socket.end(`${this.#encode(method, params)}\n`);
    const first = await lines.next();
    if (first.done) throw new Error(`Herdr closed without responding to ${method}`);
    const response = parseMessage(first.value);
    if ("error" in response) throw apiError(response);
    if (!("result" in response)) throw new Error(`Unexpected Herdr event while calling ${method}`);
    return response.result as T;
  }

  #encode(method: string, params: object): string {
    return JSON.stringify({
      id: `agentmail-bridger:${++this.#sequence}`,
      method,
      params,
    });
  }

  async #consumeEvents(
    lines: AsyncGenerator<string>,
    emitClose: () => void,
  ): Promise<void> {
    try {
      for await (const line of lines) {
        const message = parseMessage(line);
        if ("event" in message) this.emit("event", message);
      }
    } catch (error) {
      this.emit("protocolError", error);
      this.#subscriptionSocket?.destroy();
    } finally {
      emitClose();
    }
  }
}

function parseMessage(line: string): ApiMessage {
  return JSON.parse(line) as ApiMessage;
}

function apiError(response: { error: { code: string; message: string } }): Error {
  return new Error(`${response.error.code}: ${response.error.message}`);
}

function onceConnected(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

async function* lineReader(socket: net.Socket): AsyncGenerator<string> {
  socket.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of socket) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}
