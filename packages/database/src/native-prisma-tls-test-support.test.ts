import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { connect as connectTcp, type Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { connect as connectTls, TLSSocket } from "node:tls";
import { after, before, test } from "node:test";
import {
  createPostgresTlsProbe,
  createTlsCertificateFixture,
  type TlsCertificateFixture,
  type TlsProbeEvidence,
} from "./native-prisma-tls-test-support.ts";

let certificates: TlsCertificateFixture;
let ca: Buffer;
before(async () => {
  certificates = await createTlsCertificateFixture();
  ca = await readFile(certificates.caPath);
});
after(async () => { await certificates?.close(); });

async function requestTls(port: number): Promise<Socket> {
  const socket = connectTcp({ port, host: "127.0.0.1" });
  socket.on("error", () => { /* Teardown can abort either transport. */ });
  await once(socket, "connect");
  const response = once(socket, "data");
  const request = Buffer.alloc(8);
  request.writeUInt32BE(8, 0);
  request.writeUInt32BE(80_877_103, 4);
  socket.write(request);
  const [reply] = await response;
  assert.equal((reply as Buffer).toString(), "S");
  return socket;
}

function upgrade(socket: Socket, trusted: boolean): TLSSocket {
  const secure = connectTls({
    socket,
    host: "127.0.0.1",
    rejectUnauthorized: true,
    ...(trusted ? { ca } : {}),
  });
  secure.on("error", () => { /* Certificate rejection is asserted by the test. */ });
  return secure;
}

async function assertEvidenceSettled(evidence: TlsProbeEvidence): Promise<void> {
  const snapshot = { ...evidence };
  await setImmediate();
  assert.deepEqual(evidence, snapshot, "probe.close must finish every evidence callback");
  assert.equal(evidence.plaintextStartupPackets, 0);
  assert.equal(evidence.encryptedStartupPackets, 0);
  assert.equal(evidence.protocolErrors, 0);
  assert.equal(evidence.socketTimeouts, 0);
}

test("probe close waits for delayed server TLS close evidence", { timeout: 10_000 }, async (context) => {
  const probe = await createPostgresTlsProbe(certificates.matching);
  let socket: Socket | undefined;
  let secure: TLSSocket | undefined;
  let closing: Promise<void> | undefined;
  let releaseServerClose: (() => void) | undefined;
  try {
    socket = await requestTls(probe.port);
    secure = upgrade(socket, true);
    await once(secure, "secureConnect");
    assert.equal(secure.authorized, true);
    const emit = TLSSocket.prototype.emit;
    let closeHeld: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { closeHeld = resolve; });
    // Keep the real handshake and bytes. Hold only the server's final close
    // notification, reproducing an event order the OS can naturally produce.
    context.mock.method(TLSSocket.prototype, "emit", function (
      this: TLSSocket, event: string | symbol, ...args: unknown[]
    ) {
      if (event === "close" && this !== secure) {
        releaseServerClose = () => { Reflect.apply(emit, this, [event, ...args]); };
        closeHeld?.();
        return true;
      }
      return Reflect.apply(emit, this, [event, ...args]) as boolean;
    });
    let returned = false;
    closing = probe.close().then(() => { returned = true; });
    await held;
    await setImmediate();
    assert.equal(returned, false, "server.close alone must not complete the probe teardown");
    releaseServerClose?.();
    releaseServerClose = undefined;
    await closing;
    assert.equal(probe.evidence.sslRequests, 1);
    assert.ok(probe.evidence.tlsBytesRead > 0, "the completed TLS exchange must already be recorded");
    await assertEvidenceSettled(probe.evidence);
  } finally {
    context.mock.restoreAll();
    releaseServerClose?.();
    secure?.destroy();
    socket?.destroy();
    await (closing ?? probe.close());
  }
});

test("probe close settles evidence when the client is already closing after certificate rejection", { timeout: 10_000 }, async () => {
  const probe = await createPostgresTlsProbe(certificates.matching);
  let socket: Socket | undefined;
  let secure: TLSSocket | undefined;
  let closing: Promise<void> | undefined;
  try {
    socket = await requestTls(probe.port);
    secure = upgrade(socket, false);
    const [error] = await once(secure, "error");
    assert.match((error as Error).message, /certificate/i);
    assert.equal(secure.destroyed, true);
    closing = probe.close();
    await closing;
    assert.equal(probe.evidence.sslRequests, 1);
    assert.ok(probe.evidence.tlsBytesRead > 0, "certificate rejection must retain TLS handshake evidence");
    assert.equal(probe.evidence.secureHandshakes, 0);
    await assertEvidenceSettled(probe.evidence);
  } finally {
    secure?.destroy();
    socket?.destroy();
    await (closing ?? probe.close());
  }
});

test("SSL negotiation without a ClientHello never counts as TLS handshake evidence", { timeout: 10_000 }, async () => {
  const probe = await createPostgresTlsProbe(certificates.matching);
  let socket: Socket | undefined;
  let closing: Promise<void> | undefined;
  try {
    socket = await requestTls(probe.port);
    const clientClosed = new Promise<void>((resolve) => socket!.once("close", () => resolve()));
    socket.destroy();
    await clientClosed;
    closing = probe.close();
    await closing;
    assert.equal(probe.evidence.sslRequests, 1);
    assert.equal(probe.evidence.tlsBytesRead, 0);
    assert.equal(probe.evidence.secureHandshakes, 0);
    await assertEvidenceSettled(probe.evidence);
  } finally {
    socket?.destroy();
    await (closing ?? probe.close());
  }
});
