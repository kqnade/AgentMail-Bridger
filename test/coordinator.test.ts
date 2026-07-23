import assert from "node:assert/strict";
import test from "node:test";
import { Coordinator } from "../src/coordinator.js";

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
