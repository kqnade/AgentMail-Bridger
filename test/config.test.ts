import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("rejects duplicate worker mappings", async () => {
  await assert.rejects(
    loadConfig(undefined, {
      AGENTMAIL_BRIDGER_MAPPINGS: "worker:manager-a,worker:manager-b",
    }),
    /Duplicate worker mapping: worker/,
  );
});
