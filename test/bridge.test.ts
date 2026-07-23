import assert from "node:assert/strict";
import test from "node:test";
import { buildTargetLookup } from "../src/bridge.js";

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
