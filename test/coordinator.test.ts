import assert from "node:assert/strict";
import test from "node:test";
import { Coordinator } from "../src/coordinator.js";
import { PromptTextDeliveredError } from "../src/prompt-client.js";

const silent = { info() {}, error() {} };

function fixture() {
  const prompts: Array<{ target: string; text: string }> = [];
  const coordinator = new Coordinator({
    client: {
      async sendPrompt(target: string, text: string) {
        prompts.push({ target, text });
      },
    },
    mappings: [
      { worker: "worker-a", manager: "manager" },
      { worker: "worker-b", manager: "manager" },
    ],
    prompt: "Check mail for {{workers}}.",
    logger: silent,
  });
  return { coordinator, prompts };
}

test("queues done notifications while manager is working and flushes when idle", async () => {
  const { coordinator, prompts } = fixture();
  coordinator.setInitialStatus("manager", "working");
  coordinator.setInitialStatus("worker-a", "working");

  await coordinator.statusChanged("worker-a", "done");
  assert.deepEqual(prompts, []);
  assert.deepEqual(coordinator.pending("manager"), ["worker-a"]);

  await coordinator.statusChanged("manager", "idle");
  assert.deepEqual(prompts, [
    { target: "manager", text: "Check mail for worker-a." },
  ]);
  assert.deepEqual(coordinator.pending("manager"), []);
});

test("prompts immediately when manager is settled", async () => {
  const { coordinator, prompts } = fixture();
  coordinator.setInitialStatus("manager", "done");
  coordinator.setInitialStatus("worker-a", "working");

  await coordinator.statusChanged("worker-a", "done");
  assert.equal(prompts.length, 1);
});

test("does not prompt twice for repeated done events", async () => {
  const { coordinator, prompts } = fixture();
  coordinator.setInitialStatus("manager", "idle");
  coordinator.setInitialStatus("worker-a", "working");

  await coordinator.statusChanged("worker-a", "done");
  await coordinator.statusChanged("worker-a", "done");
  assert.equal(prompts.length, 1);
});

test("retains queued work when prompt delivery fails", async () => {
  const coordinator = new Coordinator({
    client: { async sendPrompt() { throw new Error("offline"); } },
    mappings: [{ worker: "worker", manager: "manager" }],
    prompt: "{{workers}}",
    logger: silent,
  });
  coordinator.setInitialStatus("manager", "idle");
  coordinator.setInitialStatus("worker", "working");

  await coordinator.statusChanged("worker", "done");
  assert.deepEqual(coordinator.pending("manager"), ["worker"]);
});

test("retries a failed delivery while the manager remains idle", async () => {
  let attempts = 0;
  const coordinator = new Coordinator({
    client: {
      async sendPrompt() {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
      },
    },
    mappings: [{ worker: "worker", manager: "manager" }],
    prompt: "{{workers}}",
    logger: silent,
    retryDelayMs: 1,
  });
  coordinator.setInitialStatus("manager", "idle");
  coordinator.setInitialStatus("worker", "working");

  await coordinator.statusChanged("worker", "done");
  await waitFor(() => attempts === 2);

  assert.deepEqual(coordinator.pending("manager"), []);
});

test("retries only Enter after the prompt text was delivered", async () => {
  const stages: Array<string | undefined> = [];
  const coordinator = new Coordinator({
    client: {
      async sendPrompt(_target, _text, stage) {
        stages.push(stage);
        if (stages.length === 1) {
          throw new PromptTextDeliveredError("Enter failed");
        }
      },
    },
    mappings: [{ worker: "worker", manager: "manager" }],
    prompt: "{{workers}}",
    logger: silent,
    retryDelayMs: 1,
  });
  coordinator.setInitialStatus("manager", "idle");
  coordinator.setInitialStatus("worker", "working");

  await coordinator.statusChanged("worker", "done");
  await waitFor(() => stages.length === 2);

  assert.deepEqual(stages, ["full", "enter"]);
  assert.deepEqual(coordinator.pending("manager"), []);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
