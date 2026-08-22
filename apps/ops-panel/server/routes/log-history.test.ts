import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { createLogStreamHub } from "../core/log-stream-hub.ts";
import { openLogFile } from "../log-file-handle.ts";
import { createLogHistoryReader } from "../log-history-reader.ts";
import { createLogHistoryRouter } from "./log-history.ts";

/**
 * The raw download, against a real filesystem and a real rotation.
 *
 * Rotation is the whole point of these tests, so nothing about the file is
 * faked: a temporary directory holds an actual `frontend.log`, and the seam is
 * only *when* the rename happens — between the descriptor being opened and the
 * first byte leaving through it. That is the window a download that trusts a
 * pathname loses, and it is invisible to any test that never opens two files.
 *
 * The header and guard behaviour of this route is covered end to end, through
 * the panel's access middleware, in `server/app.behavior.test.ts`. These tests
 * mount the router alone so the descriptor can be counted.
 */

const ORIGINAL = "original-generation-line\n".repeat(64);
// Longer than the original on purpose: a download that re-opened the name would
// happily serve this file's first `ORIGINAL.length` bytes under the original
// file's `content-length`, and the transfer would look entirely successful.
const REPLACEMENT = "replacement-generation-line\n".repeat(128);

async function downloadHarness(
  options: { onOpened?: (filePath: string) => Promise<void> } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "packscout-download-"));
  let opens = 0;
  let closes = 0;

  const reader = createLogHistoryReader({
    directory,
    hub: createLogStreamHub(),
    openFile: async (filePath) => {
      const file = await openLogFile(filePath);
      if (file === null) return null;
      opens += 1;
      // The rotation lands here: the descriptor exists, and not one byte has
      // been read through it yet.
      await options.onOpened?.(filePath);
      return {
        ...file,
        close: async () => {
          closes += 1;
          await file.close();
        },
      };
    },
  });

  const app = express();
  app.use("/api/logs", createLogHistoryRouter({ reader }));
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    directory,
    port,
    origin: `http://127.0.0.1:${port}`,
    opens: () => opens,
    closes: () => closes,
    write: (content: string) =>
      writeFile(path.join(directory, "frontend.log"), content, "utf8"),
    /** Waits for every descriptor the route opened to be released. */
    async settled(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (closes < opens && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A real rotation: the name is moved aside and a different file takes it. */
async function rotate(directory: string): Promise<void> {
  await rename(
    path.join(directory, "frontend.log"),
    path.join(directory, "frontend.log.1"),
  );
  await writeFile(path.join(directory, "frontend.log"), REPLACEMENT, "utf8");
}

test("a download that races a rotation serves the file it measured", async (t) => {
  let rotated = false;
  const harness = await downloadHarness({
    onOpened: async (filePath) => {
      if (rotated) return;
      rotated = true;
      await rotate(path.dirname(filePath));
    },
  });
  t.after(() => harness.close());
  await harness.write(ORIGINAL);

  const response = await fetch(
    `${harness.origin}/api/logs/download?service=frontend`,
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-length"),
    String(Buffer.byteLength(ORIGINAL)),
    "the length is pinned to the file that was opened",
  );

  const body = await response.text();
  assert.ok(rotated, "the rotation really happened mid-request");
  assert.ok(
    !body.includes("replacement-generation-line"),
    "the file that took over the name is never served",
  );
  assert.equal(body, ORIGINAL, "the bytes come from the descriptor, not the name");

  await harness.settled();
  assert.equal(harness.opens(), 1, "the name is opened once for the whole download");
  assert.equal(harness.closes(), 1, "the descriptor is released exactly once");
});

test("a completed download leaves no descriptor behind", async (t) => {
  const harness = await downloadHarness();
  t.after(() => harness.close());
  await harness.write(ORIGINAL);

  const response = await fetch(
    `${harness.origin}/api/logs/download?service=frontend`,
  );
  assert.equal(await response.text(), ORIGINAL);

  await harness.settled();
  assert.equal(harness.closes(), 1);
});

test("an abandoned download releases its descriptor", async (t) => {
  const harness = await downloadHarness();
  t.after(() => harness.close());
  // Large enough that the transfer cannot finish in one flush, so the client
  // goes away while the descriptor is still being read.
  await harness.write(`${"x".repeat(8 * 1024 * 1024)}\n`);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the download never started")),
      10_000,
    );
    const client = httpRequest(
      {
        host: "127.0.0.1",
        port: harness.port,
        path: "/api/logs/download?service=frontend",
      },
      (incoming) => {
        incoming.once("data", () => {
          clearTimeout(timer);
          client.destroy();
          resolve();
        });
        incoming.on("error", () => undefined);
      },
    );
    client.on("error", () => undefined);
    client.end();
  });

  await harness.settled();
  assert.equal(harness.opens(), 1);
  assert.equal(
    harness.closes(),
    1,
    "a client that disconnects mid-transfer does not leak a descriptor",
  );
});

test("a download of a name nothing is behind is refused", async (t) => {
  const harness = await downloadHarness();
  t.after(() => harness.close());

  const response = await fetch(
    `${harness.origin}/api/logs/download?service=frontend`,
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "ops_panel_log_file_missing");
  assert.equal(harness.opens(), 0);
});
