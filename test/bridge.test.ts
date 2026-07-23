import assert from "node:assert/strict";
import test from "node:test";
import { buildTargetLookup, reconcileStatuses } from "../src/bridge.js";
import { Coordinator } from "../src/coordinator.js";

test("resolves configured names and pane ids", () => {
  const agents = [
    { name: "worker", pane_id: "w1:p1" },
    { name: "manager", pane_id: "w1:p2" },
  ];
  const mappings = [{ worker: "worker", manager: "w1:p2" }];
  assert.deepEqual(
    [...buildTargetLookup(agents, mappings)],
    [["worker", "w1:p1"], ["w1:p2", "w1:p2"]],
  );
});

test("rejects missing targets", () => {
  assert.throws(
    () => buildTargetLookup([], [{ worker: "worker", manager: "manager" }]),
    /target not found/,
  );
});

test("reconciles a completion missed between snapshot and subscription", async () => {
  const prompts: Array<{ target: string; text: string }> = [];
  const mappings = [{ worker: "worker", manager: "manager" }];
  const coordinator = new Coordinator({
    client: {
      async sendPrompt(target, text) {
        prompts.push({ target, text });
      },
    },
    mappings,
    prompt: "Check {{workers}}",
  });
  const lookup = new Map([
    ["worker", "p1"],
    ["manager", "p2"],
  ]);

  await reconcileStatuses(
    coordinator,
    [
      { agent: "codex", name: "worker", pane_id: "p1", agent_status: "working" },
      { agent: "codex", name: "manager", pane_id: "p2", agent_status: "idle" },
    ],
    lookup,
    mappings,
    true,
  );
  await reconcileStatuses(
    coordinator,
    [
      { agent: "codex", name: "worker", pane_id: "p1", agent_status: "done" },
      { agent: "codex", name: "manager", pane_id: "p2", agent_status: "idle" },
    ],
    lookup,
    mappings,
    false,
  );

  assert.deepEqual(prompts, [{ target: "manager", text: "Check worker" }]);
});

test("keeps pending notifications when statuses are reconciled after reconnect", async () => {
  const prompts: Array<{ target: string; text: string }> = [];
  const mappings = [{ worker: "worker", manager: "manager" }];
  const coordinator = new Coordinator({
    client: {
      async sendPrompt(target, text) {
        prompts.push({ target, text });
      },
    },
    mappings,
    prompt: "Check {{workers}}",
  });
  const lookup = new Map([
    ["worker", "p1"],
    ["manager", "p2"],
  ]);
  coordinator.setInitialStatus("worker", "working");
  coordinator.setInitialStatus("manager", "working");
  await coordinator.statusChanged("worker", "done");

  await reconcileStatuses(
    coordinator,
    [
      { agent: "codex", name: "worker", pane_id: "p1", agent_status: "done" },
      { agent: "codex", name: "manager", pane_id: "p2", agent_status: "idle" },
    ],
    lookup,
    mappings,
    false,
  );

  assert.deepEqual(prompts, [{ target: "manager", text: "Check worker" }]);
  assert.deepEqual(coordinator.pending("manager"), []);
});

test("installs all manager statuses before reconciling dual-role workers", async () => {
  const prompts: Array<{ target: string; text: string }> = [];
  const mappings = [
    { worker: "worker-a", manager: "manager-b" },
    { worker: "manager-b", manager: "manager-c" },
  ];
  const coordinator = new Coordinator({
    client: {
      async sendPrompt(target, text) {
        prompts.push({ target, text });
      },
    },
    mappings,
    prompt: "Check {{workers}}",
  });
  const lookup = new Map([
    ["worker-a", "p1"],
    ["manager-b", "p2"],
    ["manager-c", "p3"],
  ]);
  coordinator.setInitialStatus("worker-a", "working");
  coordinator.setInitialStatus("manager-b", "working");
  coordinator.setInitialStatus("manager-c", "idle");

  await reconcileStatuses(
    coordinator,
    [
      { agent: "codex", name: "worker-a", pane_id: "p1", agent_status: "working" },
      { agent: "codex", name: "manager-b", pane_id: "p2", agent_status: "done" },
      { agent: "codex", name: "manager-c", pane_id: "p3", agent_status: "working" },
    ],
    lookup,
    mappings,
    false,
  );

  assert.deepEqual(prompts, []);
  assert.deepEqual(coordinator.pending("manager-c"), ["manager-b"]);
});
