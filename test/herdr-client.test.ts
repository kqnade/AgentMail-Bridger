import { Duplex } from "node:stream";
import net from "node:net";
import test from "node:test";
import { HerdrClient } from "../src/herdr-client.js";

test("emits close when the subscription closes immediately after its acknowledgement", async () => {
  const socket = new Duplex({
    read() {},
    write(data, _encoding, callback) {
      const request = JSON.parse(data.toString()) as { id: string };
      this.push(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      this.push(null);
      this.emit("close");
      callback();
    },
  });
  const client = new HerdrClient(
    "unused",
    () => socket as net.Socket,
  );
  const closed = new Promise<void>((resolve) => client.once("close", resolve));
  queueMicrotask(() => socket.emit("connect"));

  await client.subscribe(["pane"]);
  await withTimeout(closed, 1_000);
});

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("close event timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
