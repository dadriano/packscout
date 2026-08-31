import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const SSL_REQUEST = 80_877_103;
const STARTUP_PROTOCOL = 196_608;
const SOCKET_TIMEOUT_MS = 3_000;

/** No database implementation: this fixture stops at the startup packet. */
export interface TlsProbeEvidence {
  sslRequests: number;
  plaintextStartupPackets: number;
  encryptedStartupPackets: number;
  secureHandshakes: number;
  tlsBytesRead: number;
  tlsErrors: number;
  protocolErrors: number;
  socketTimeouts: number;
}

export interface TlsCertificateFixture {
  readonly caPath: string;
  readonly matching: { readonly cert: Buffer; readonly key: Buffer };
  readonly mismatched: { readonly cert: Buffer; readonly key: Buffer };
  close(): Promise<void>;
}

export async function createTlsCertificateFixture(): Promise<TlsCertificateFixture> {
  const directory = await mkdtemp(join(tmpdir(), "packscout-synthetic-tls-"));
  const openssl = async (...args: string[]) => {
    await runFile("openssl", args, {
      cwd: directory,
      timeout: 10_000,
      maxBuffer: 64 * 1_024,
      // Do not pass application secrets or OpenSSL overrides into this fixture.
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin" },
    });
  };
  try {
    await openssl(
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
      "-subj", "/CN=PackScout synthetic test CA",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout", "ca.key", "-out", "ca.pem",
    );
    await openssl(
      "req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256",
      "-subj", "/CN=PackScout synthetic server",
      "-keyout", "server.key", "-out", "server.csr",
    );
    for (const [index, name, san] of [
      [2, "matching", "IP:127.0.0.1"],
      [3, "mismatched", "DNS:wrong.synthetic.invalid"],
    ] as const) {
      await writeFile(join(directory, `${name}.ext`), [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        `subjectAltName=${san}`,
        "",
      ].join("\n"), { mode: 0o600 });
      await openssl(
        "x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
        "-set_serial", String(index), "-days", "2", "-sha256",
        "-extfile", `${name}.ext`, "-out", `${name}.pem`,
      );
    }
    const key = await readFile(join(directory, "server.key"));
    return {
      caPath: join(directory, "ca.pem"),
      matching: { cert: await readFile(join(directory, "matching.pem")), key },
      mismatched: { cert: await readFile(join(directory, "mismatched.pem")), key },
      async close() {
        key.fill(0);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function startupRefusal(): Buffer {
  const payload = Buffer.from(
    "SFATAL\0VFATAL\0C28000\0MSynthetic TLS probe does not authenticate clients\0\0",
  );
  const header = Buffer.alloc(5);
  header.write("E");
  header.writeUInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

export async function createPostgresTlsProbe(
  certificate?: { readonly cert: Buffer; readonly key: Buffer },
): Promise<{
  readonly port: number;
  readonly evidence: TlsProbeEvidence;
  close(): Promise<void>;
}> {
  const evidence: TlsProbeEvidence = {
    sslRequests: 0,
    plaintextStartupPackets: 0,
    encryptedStartupPackets: 0,
    secureHandshakes: 0,
    tlsBytesRead: 0,
    tlsErrors: 0,
    protocolErrors: 0,
    socketTimeouts: 0,
  };
  const context = certificate ? createSecureContext(certificate) : undefined;
  const sockets = new Map<Socket, Promise<void>>();
  const track = (socket: Socket) => {
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        sockets.delete(socket);
        resolve();
      });
    });
    sockets.set(socket, closed);
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
      evidence.socketTimeouts += 1;
      socket.destroy();
    });
  };
  const server = createServer((socket) => {
    track(socket);
    socket.on("error", () => { /* Expected clients may abort rejected TLS. */ });
    let negotiation = Buffer.alloc(0);
    const acceptStartup = (transport: Socket, encrypted: boolean) => {
      let startup = Buffer.alloc(0);
      transport.on("data", (chunk: Buffer) => {
        startup = Buffer.concat([startup, chunk]);
        if (startup.length < 8) return;
        if (startup.readUInt32BE(4) !== STARTUP_PROTOCOL) {
          evidence.protocolErrors += 1;
          transport.destroy();
          return;
        }
        if (encrypted) evidence.encryptedStartupPackets += 1;
        else evidence.plaintextStartupPackets += 1;
        transport.end(startupRefusal());
      });
    };
    const negotiate = (chunk: Buffer) => {
      negotiation = Buffer.concat([negotiation, chunk]);
      if (negotiation.length < 8) return;
      socket.removeListener("data", negotiate);
      if (negotiation.length !== 8 || negotiation.readUInt32BE(0) !== 8
        || negotiation.readUInt32BE(4) !== SSL_REQUEST) {
        evidence.protocolErrors += 1;
        socket.destroy();
        return;
      }
      evidence.sslRequests += 1;
      if (!context) {
        acceptStartup(socket, false);
        socket.write("N");
        return;
      }
      socket.write("S");
      const secureSocket = new TLSSocket(socket, {
        isServer: true,
        secureContext: context,
        minVersion: "TLSv1.2",
      });
      track(secureSocket);
      secureSocket.once("secure", () => { evidence.secureHandshakes += 1; });
      secureSocket.on("error", () => { evidence.tlsErrors += 1; });
      secureSocket.once("close", () => {
        evidence.tlsBytesRead += socket.bytesRead - 8;
      });
      acceptStartup(secureSocket, true);
    };
    socket.on("data", negotiate);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Probe did not bind loopback.");
  return {
    port: address.port,
    evidence,
    async close() {
      // net.Server can finish closing before a wrapped TLS socket emits its
      // own close event. Evidence is finalized by those socket listeners, so
      // teardown must also await every tracked transport's close completion.
      const closedSockets = [...sockets.values()];
      const closedServer = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      for (const socket of sockets.keys()) socket.destroy();
      await Promise.all([closedServer, ...closedSockets]);
    },
  };
}
