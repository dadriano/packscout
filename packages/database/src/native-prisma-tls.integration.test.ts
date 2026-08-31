import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createCentralDatabaseLifecycle } from "./central-database.ts";
import { createProviderDatabaseLifecycle } from "./provider-database.ts";
import {
  createPostgresTlsProbe,
  createTlsCertificateFixture,
  type TlsCertificateFixture,
} from "./native-prisma-tls-test-support.ts";

const providerId = "79ad49f7-94a3-4fb9-a03e-58506e802c62";
const nativeLifecycles = [
  { name: "central", create: (databaseUrl: string) => createCentralDatabaseLifecycle({ databaseUrl }) },
  {
    name: "provider",
    create: (databaseUrl: string) => createProviderDatabaseLifecycle({
      databaseUrl, providerId, providerKey: "synthetic",
    }),
  },
] as const;
let certificates: TlsCertificateFixture;

before(async () => { certificates = await createTlsCertificateFixture(); });
after(async () => { await certificates?.close(); });

function connectionUrl(port: number, caPath?: string): string {
  const url = new URL(`postgresql://synthetic_role:synthetic_password@127.0.0.1:${port}/synthetic`);
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("connect_timeout", "2");
  url.searchParams.set("pool_timeout", "2");
  if (caPath) url.searchParams.set("sslcert", caPath);
  return url.toString();
}

for (const lifecycleFactory of nativeLifecycles) {
  test(`${lifecycleFactory.name} native client refuses plaintext when verify-full is requested`,
    { timeout: 10_000 }, async () => {
      const probe = await createPostgresTlsProbe();
      const lifecycle = lifecycleFactory.create(connectionUrl(probe.port));
      try {
        await assert.rejects(lifecycle.client.$connect());
      } finally {
        await lifecycle.close();
        await probe.close();
      }
      assert.equal(probe.evidence.sslRequests, 1);
      assert.equal(probe.evidence.plaintextStartupPackets, 0);
      assert.equal(probe.evidence.protocolErrors, 0);
      assert.equal(probe.evidence.socketTimeouts, 0);
    });

  for (const rejectedCertificate of ["untrusted", "hostname mismatch"] as const) {
    test(`${lifecycleFactory.name} native client rejects ${rejectedCertificate} before startup/authentication`,
      { timeout: 10_000 }, async () => {
        const certificate = rejectedCertificate === "untrusted"
          ? certificates.matching : certificates.mismatched;
        const probe = await createPostgresTlsProbe(certificate);
        const caPath = rejectedCertificate === "untrusted" ? undefined : certificates.caPath;
        const lifecycle = lifecycleFactory.create(connectionUrl(probe.port, caPath));
        try {
          await assert.rejects(lifecycle.client.$connect(), /certificate|hostname/i);
        } finally {
          await lifecycle.close();
          await probe.close();
        }
        assert.equal(probe.evidence.sslRequests, 1);
        assert.equal(probe.evidence.plaintextStartupPackets, 0);
        assert.equal(probe.evidence.encryptedStartupPackets, 0);
        assert.ok(probe.evidence.tlsBytesRead > 0, "client attempted a TLS handshake");
        assert.equal(probe.evidence.protocolErrors, 0);
        assert.equal(probe.evidence.socketTimeouts, 0);
      });
  }

  test(`${lifecycleFactory.name} native client accepts trusted matching TLS before synthetic authentication refusal`,
    { timeout: 10_000 }, async () => {
      const probe = await createPostgresTlsProbe(certificates.matching);
      const lifecycle = lifecycleFactory.create(connectionUrl(probe.port, certificates.caPath));
      try {
        // No database exists here: the fixture always refuses authentication
        // after seeing startup. This is the positive TLS handshake control.
        await assert.rejects(lifecycle.client.$connect());
      } finally {
        await lifecycle.close();
        await probe.close();
      }
      assert.equal(probe.evidence.sslRequests, 1);
      assert.equal(probe.evidence.secureHandshakes, 1);
      assert.equal(probe.evidence.encryptedStartupPackets, 1);
      assert.equal(probe.evidence.plaintextStartupPackets, 0);
      assert.equal(probe.evidence.protocolErrors, 0);
      assert.equal(probe.evidence.socketTimeouts, 0);
    });
}
