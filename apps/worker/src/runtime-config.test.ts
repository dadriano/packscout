import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderWorkerConfigurationError,
  ProviderSourceSupervisorConfigurationError,
  readProviderSourceSupervisorConfiguration,
  readProviderWorkerConfiguration,
  type ProviderWorkerConfigurationErrorCode,
} from "./runtime-config.ts";

const credentialKey = Buffer.alloc(32, 3).toString("base64");
const actorKey = Buffer.alloc(32, 7).toString("base64");
const sourceConnectionKey = Buffer.alloc(32, 11).toString("base64");

function validEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PACKSCOUT_DATABASE_URL: "postgresql://worker:password@db.test/packscout",
    PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: actorKey,
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: credentialKey,
    PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64: sourceConnectionKey,
    PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION: "1",
    PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH: "/tmp",
    PACKSCOUT_PUBLIC_ORGANIZATION_ID:
      "54000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

function hasConfigurationCode(code: ProviderWorkerConfigurationErrorCode) {
  return (error: unknown) =>
    (error instanceof ProviderWorkerConfigurationError
      || error instanceof ProviderSourceSupervisorConfigurationError)
    && error.code === code;
}

test("worker configuration validates production defaults and bounded overrides", () => {
  const configuration = readProviderWorkerConfiguration(
    validEnvironment({
      PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "4",
      PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION: "7",
      PACKSCOUT_WORKER_DATABASE_POOL_MAX: "9",
      PACKSCOUT_WORKER_ID: "worker:production:1",
      PACKSCOUT_WORKER_MAX_CLAIMS_PER_CYCLE: "12",
      PACKSCOUT_WORKER_POLL_MS: "2500",
      PACKSCOUT_WORKER_RETENTION_BATCH_SIZE: "250",
      PACKSCOUT_WORKER_RETENTION_MAX_BATCHES_PER_CYCLE: "8",
      PACKSCOUT_WORKER_RETENTION_ORGANIZATION_DISCOVERY_LIMIT: "40",
      PACKSCOUT_ESTIMATED_EV_VERIFIED_USD_STABLECOINS: "USDC,USDT",
    }),
    "fallback:1",
  );

  assert.equal(configuration.environment, "production");
  assert.equal(configuration.workerId, "worker:production:1");
  assert.equal(configuration.pollIntervalMilliseconds, 2_500);
  assert.equal(
    configuration.publicOrganizationId,
    "54000000-0000-4000-8000-000000000001",
  );
  assert.equal(configuration.maximumClaimsPerCycle, 12);
  assert.equal(configuration.retentionBatchSize, 250);
  assert.equal(configuration.retentionMaximumBatchesPerCycle, 8);
  assert.equal(configuration.retentionOrganizationDiscoveryLimit, 40);
  assert.equal(configuration.databasePoolMaximum, 9);
  assert.equal(configuration.credentialKeyVersion, 4);
  assert.deepEqual(configuration.estimatedEvVerifiedUsdStablecoins, [
    "USDC",
    "USDT",
  ]);
  assert.deepEqual([...configuration.credentialKey], [...Buffer.alloc(32, 3)]);
  assert.deepEqual(
    [...configuration.actorPseudonymKey],
    [...Buffer.alloc(32, 7)],
  );
  assert.ok(configuration.sourceSupervisor);
  assert.equal(
    configuration.sourceSupervisor.sourceConnectionConfigurationKeyVersion,
    7,
  );
  assert.deepEqual(
    [...configuration.sourceSupervisor.sourceConnectionConfigurationKey],
    [...Buffer.alloc(32, 11)],
  );
});

test("source supervisor reads only ingestion-owned secret boundaries", () => {
  const configuration = readProviderSourceSupervisorConfiguration(
    validEnvironment({
      PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "not-a-url",
      PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: "not-a-key",
      PACKSCOUT_WORKER_RETENTION_BATCH_SIZE: "0",
      PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64:
        ` ${sourceConnectionKey.replace(/=+$/u, "")} `,
      PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION: "19",
    }),
    "source-supervisor:fallback",
  );

  assert.deepEqual(
    [...configuration.sourceConnectionConfigurationKey],
    [...Buffer.alloc(32, 11)],
  );
  assert.deepEqual(
    [...configuration.actorPseudonymKey],
    [...Buffer.alloc(32, 7)],
  );
  assert.equal(configuration.sourceConnectionConfigurationKeyVersion, 19);
  assert.equal(configuration.sourceDatabaseVolumePath, "/tmp");
  assert.equal(configuration.workerId, "source-supervisor:fallback");
  assert.equal(configuration.environment, "production");
});

test("source connection encryption settings are required without provider fallback", () => {
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64: undefined }),
        "combined-worker:1",
      ),
    (error: unknown) =>
      error instanceof ProviderWorkerConfigurationError
      && error.code === "SOURCE_CONNECTION_KEY_INVALID",
  );

  for (const sourceConnectionConfigurationKey of [
    undefined,
    "not base64",
    Buffer.alloc(31).toString("base64"),
  ]) {
    assert.throws(
      () =>
        readProviderSourceSupervisorConfiguration(
          validEnvironment({
            PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64:
              sourceConnectionConfigurationKey,
          }),
          "source-supervisor:1",
        ),
      hasConfigurationCode("SOURCE_CONNECTION_KEY_INVALID"),
    );
  }

  for (const sourceConnectionConfigurationKeyVersion of [
    undefined,
    "",
    "0",
    " 1",
    "1 ",
    "1.5",
    "2147483648",
  ]) {
    assert.throws(
      () =>
        readProviderSourceSupervisorConfiguration(
          validEnvironment({
            PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "23",
            PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION:
              sourceConnectionConfigurationKeyVersion,
          }),
          "source-supervisor:1",
        ),
      hasConfigurationCode("SOURCE_CONNECTION_KEY_VERSION_INVALID"),
    );
  }
});

test("worker configuration runs without the source supervisor lane when none of its settings are set", () => {
  for (const overrides of [
    {
      PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64: undefined,
      PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION: undefined,
      PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH: undefined,
    },
    {
      PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64: "",
      PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION: " ",
      PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH: "",
    },
  ]) {
    const configuration = readProviderWorkerConfiguration(
      validEnvironment(overrides),
      "worker:1",
    );

    assert.equal(configuration.sourceSupervisor, undefined);
    assert.equal(configuration.environment, "production");
    assert.equal(configuration.workerId, "worker:1");
    assert.deepEqual(
      [...configuration.actorPseudonymKey],
      [...Buffer.alloc(32, 7)],
    );
  }
});

test("worker configuration still fails startup on a partial source supervisor group", () => {
  const partials: [NodeJS.ProcessEnv, ProviderWorkerConfigurationErrorCode][] = [
    [
      {
        PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64: undefined,
        PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION: undefined,
      },
      "SOURCE_CONNECTION_KEY_INVALID",
    ],
    [
      {
        PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION: undefined,
        PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH: "",
      },
      "SOURCE_CONNECTION_KEY_VERSION_INVALID",
    ],
    [
      { PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH: undefined },
      "SOURCE_DATABASE_VOLUME_PATH_INVALID",
    ],
  ];

  for (const [overrides, code] of partials) {
    assert.throws(
      () =>
        readProviderWorkerConfiguration(validEnvironment(overrides), "worker:1"),
      hasConfigurationCode(code),
    );
  }
});

test("source database volume path is explicit, absolute, and not filesystem root", () => {
  for (const sourceDatabaseVolumePath of [undefined, "tmp", "/", " /tmp"] ) {
    assert.throws(
      () => readProviderSourceSupervisorConfiguration(
        validEnvironment({
          PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH: sourceDatabaseVolumePath,
        }),
        "source-supervisor:1",
      ),
      hasConfigurationCode("SOURCE_DATABASE_VOLUME_PATH_INVALID"),
    );
  }
});

test("worker configuration selects the local endpoint policy explicitly", () => {
  const configuration = readProviderWorkerConfiguration(
    validEnvironment({ NODE_ENV: "development" }),
    "local-host:123:worker",
  );

  assert.equal(configuration.environment, "local");
  assert.equal(configuration.workerId, "local-host:123:worker");
  assert.equal(configuration.pollIntervalMilliseconds, 1_000);
  assert.equal(configuration.maximumClaimsPerCycle, 25);
  assert.equal(configuration.retentionBatchSize, 100);
  assert.equal(configuration.retentionMaximumBatchesPerCycle, 5);
  assert.equal(configuration.retentionOrganizationDiscoveryLimit, 25);
  assert.deepEqual(configuration.estimatedEvVerifiedUsdStablecoins, []);
});

test("worker configuration resolves the operating settings instances publish", () => {
  const defaults = readProviderWorkerConfiguration(
    validEnvironment(),
    "worker:1",
  );

  assert.equal(defaults.heartbeatIntervalMilliseconds, 15_000);
  assert.equal(defaults.presenceStaleAfterMilliseconds, 60_000);
  assert.equal(defaults.runHeartbeatStaleAfterMilliseconds, 300_000);
  assert.equal(defaults.scheduleClaimLeaseMilliseconds, 30_000);
  assert.equal(defaults.importRunLeaseMilliseconds, 120_000);
  assert.equal(defaults.presenceRetentionDays, 14);
  assert.equal(defaults.workerVersion, "0.0.0-local");
  assert.match(defaults.workerHost, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

  const overridden = readProviderWorkerConfiguration(
    validEnvironment({
      PACKSCOUT_WORKER_HEARTBEAT_MS: "9000",
      PACKSCOUT_WORKER_PRESENCE_STALE_MS: "45000",
      PACKSCOUT_WORKER_RUN_HEARTBEAT_STALE_MS: "222000",
      PACKSCOUT_WORKER_SCHEDULE_CLAIM_LEASE_MS: "33000",
      PACKSCOUT_WORKER_IMPORT_RUN_LEASE_MS: "111000",
      PACKSCOUT_WORKER_PRESENCE_RETENTION_DAYS: "7",
      PACKSCOUT_WORKER_HOST: "worker-host-1",
      PACKSCOUT_WORKER_VERSION: "3.2.1+build9",
    }),
    "worker:1",
  );

  assert.equal(overridden.heartbeatIntervalMilliseconds, 9_000);
  assert.equal(overridden.presenceStaleAfterMilliseconds, 45_000);
  assert.equal(overridden.runHeartbeatStaleAfterMilliseconds, 222_000);
  assert.equal(overridden.scheduleClaimLeaseMilliseconds, 33_000);
  assert.equal(overridden.importRunLeaseMilliseconds, 111_000);
  assert.equal(overridden.presenceRetentionDays, 7);
  assert.equal(overridden.workerHost, "worker-host-1");
  assert.equal(overridden.workerVersion, "3.2.1+build9");
});

test("worker configuration fails closed on unusable liveness settings", () => {
  const invalid: [string, string, ProviderWorkerConfigurationErrorCode][] = [
    ["PACKSCOUT_WORKER_HEARTBEAT_MS", "999", "HEARTBEAT_INTERVAL_INVALID"],
    ["PACKSCOUT_WORKER_HEARTBEAT_MS", "300001", "HEARTBEAT_INTERVAL_INVALID"],
    ["PACKSCOUT_WORKER_PRESENCE_STALE_MS", "1000", "PRESENCE_STALE_INVALID"],
    [
      "PACKSCOUT_WORKER_RUN_HEARTBEAT_STALE_MS",
      "999",
      "RUN_HEARTBEAT_STALE_INVALID",
    ],
    [
      "PACKSCOUT_WORKER_SCHEDULE_CLAIM_LEASE_MS",
      "300001",
      "SCHEDULE_CLAIM_LEASE_INVALID",
    ],
    ["PACKSCOUT_WORKER_IMPORT_RUN_LEASE_MS", "29999", "IMPORT_RUN_LEASE_INVALID"],
    [
      "PACKSCOUT_WORKER_PRESENCE_RETENTION_DAYS",
      "3651",
      "PRESENCE_RETENTION_DAYS_INVALID",
    ],
    ["PACKSCOUT_WORKER_HOST", "worker host", "WORKER_HOST_INVALID"],
    ["PACKSCOUT_WORKER_VERSION", "-1.0.0", "WORKER_VERSION_INVALID"],
  ];

  for (const [name, value, code] of invalid) {
    assert.throws(
      () =>
        readProviderWorkerConfiguration(
          validEnvironment({ [name]: value }),
          "worker:1",
        ),
      hasConfigurationCode(code),
      `${name}=${value}`,
    );
  }

  // A staleness threshold inside its own bounds is still unusable when it
  // leaves no room for a missed beat.
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({
          PACKSCOUT_WORKER_HEARTBEAT_MS: "60000",
          PACKSCOUT_WORKER_PRESENCE_STALE_MS: "60000",
        }),
        "worker:1",
      ),
    hasConfigurationCode("PRESENCE_STALE_INVALID"),
  );
});

test("worker configuration fails closed for invalid secrets and destinations", () => {
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: "short" }),
        "worker:1",
      ),
    hasConfigurationCode("CREDENTIAL_KEY_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: undefined }),
        "worker:1",
      ),
    hasConfigurationCode("ACTOR_KEY_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_DATABASE_URL: "https://db.test" }),
        "worker:1",
      ),
    hasConfigurationCode("DATABASE_URL_INVALID"),
  );
  for (const publicOrganizationId of [undefined, "organization-from-request"]) {
    assert.throws(
      () =>
        readProviderWorkerConfiguration(
          validEnvironment({
            PACKSCOUT_PUBLIC_ORGANIZATION_ID: publicOrganizationId,
          }),
          "worker:1",
        ),
      hasConfigurationCode("PUBLIC_ORGANIZATION_ID_INVALID"),
    );
  }
});

test("worker configuration rejects ambiguous environments and unsafe bounds", () => {
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ NODE_ENV: "staging" }),
        "worker:1",
      ),
    hasConfigurationCode("NODE_ENV_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_WORKER_POLL_MS: "99" }),
        "worker:1",
      ),
    hasConfigurationCode("POLL_INTERVAL_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_WORKER_ID: "worker id with spaces" }),
        "worker:1",
      ),
    hasConfigurationCode("WORKER_ID_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_WORKER_ID: `w${"x".repeat(128)}` }),
        "worker:1",
      ),
    hasConfigurationCode("WORKER_ID_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_WORKER_RETENTION_BATCH_SIZE: "1001" }),
        "worker:1",
      ),
    hasConfigurationCode("RETENTION_BATCH_SIZE_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({
          PACKSCOUT_WORKER_RETENTION_MAX_BATCHES_PER_CYCLE: "0",
        }),
        "worker:1",
      ),
    hasConfigurationCode("RETENTION_MAX_BATCHES_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({
          PACKSCOUT_WORKER_RETENTION_ORGANIZATION_DISCOVERY_LIMIT: "101",
        }),
        "worker:1",
      ),
    hasConfigurationCode("RETENTION_DISCOVERY_LIMIT_INVALID"),
  );
  for (const value of ["usdc", "USDC, USDT", "USD", "USDC,USDC", "USDC,"]) {
    assert.throws(
      () =>
        readProviderWorkerConfiguration(
          validEnvironment({
            PACKSCOUT_ESTIMATED_EV_VERIFIED_USD_STABLECOINS: value,
          }),
          "worker:1",
        ),
      hasConfigurationCode("ESTIMATED_EV_STABLECOINS_INVALID"),
    );
  }
});

test("message outbox settings default sanely and honor bounded overrides", () => {
  const defaults = readProviderWorkerConfiguration(validEnvironment(), "worker:1");
  assert.equal(defaults.messageOutboxBatchSize, 25);
  assert.equal(defaults.messageOutboxPerRecipientLimit, 5);
  assert.equal(defaults.messageOutboxLeaseMilliseconds, 60_000);
  assert.equal(defaults.messageOutboxMaximumAttempts, 6);
  assert.equal(defaults.messageOutboxBackoffBaseMilliseconds, 30_000);
  assert.equal(defaults.messageOutboxBackoffCapMilliseconds, 3_600_000);
  assert.equal(defaults.messageOutboxPollMilliseconds, 5_000);
  assert.equal(defaults.messageOutboxRetentionDays, 90);

  const configured = readProviderWorkerConfiguration(
    validEnvironment({
      PACKSCOUT_WORKER_MESSAGE_OUTBOX_BATCH_SIZE: "40",
      PACKSCOUT_WORKER_MESSAGE_OUTBOX_PER_RECIPIENT_LIMIT: "2",
      PACKSCOUT_WORKER_MESSAGE_OUTBOX_LEASE_MS: "120000",
      PACKSCOUT_WORKER_MESSAGE_OUTBOX_MAX_ATTEMPTS: "8",
      PACKSCOUT_WORKER_MESSAGE_OUTBOX_BACKOFF_BASE_MS: "10000",
      PACKSCOUT_WORKER_MESSAGE_OUTBOX_BACKOFF_CAP_MS: "600000",
      PACKSCOUT_WORKER_MESSAGE_OUTBOX_POLL_MS: "2000",
      PACKSCOUT_WORKER_MESSAGE_OUTBOX_RETENTION_DAYS: "30",
    }),
    "worker:1",
  );
  assert.equal(configured.messageOutboxBatchSize, 40);
  assert.equal(configured.messageOutboxPerRecipientLimit, 2);
  assert.equal(configured.messageOutboxLeaseMilliseconds, 120_000);
  assert.equal(configured.messageOutboxMaximumAttempts, 8);
  assert.equal(configured.messageOutboxBackoffBaseMilliseconds, 10_000);
  assert.equal(configured.messageOutboxBackoffCapMilliseconds, 600_000);
  assert.equal(configured.messageOutboxPollMilliseconds, 2_000);
  assert.equal(configured.messageOutboxRetentionDays, 30);
});

test("message outbox settings refuse out-of-bounds values with their own codes", () => {
  const invalidSettings = [
    ["PACKSCOUT_WORKER_MESSAGE_OUTBOX_BATCH_SIZE", "0", "MESSAGE_OUTBOX_BATCH_SIZE_INVALID"],
    ["PACKSCOUT_WORKER_MESSAGE_OUTBOX_BATCH_SIZE", "101", "MESSAGE_OUTBOX_BATCH_SIZE_INVALID"],
    ["PACKSCOUT_WORKER_MESSAGE_OUTBOX_PER_RECIPIENT_LIMIT", "101", "MESSAGE_OUTBOX_PER_RECIPIENT_INVALID"],
    ["PACKSCOUT_WORKER_MESSAGE_OUTBOX_LEASE_MS", "999", "MESSAGE_OUTBOX_LEASE_INVALID"],
    ["PACKSCOUT_WORKER_MESSAGE_OUTBOX_LEASE_MS", "900001", "MESSAGE_OUTBOX_LEASE_INVALID"],
    ["PACKSCOUT_WORKER_MESSAGE_OUTBOX_MAX_ATTEMPTS", "21", "MESSAGE_OUTBOX_ATTEMPTS_INVALID"],
    ["PACKSCOUT_WORKER_MESSAGE_OUTBOX_BACKOFF_BASE_MS", "99", "MESSAGE_OUTBOX_BACKOFF_BASE_INVALID"],
    ["PACKSCOUT_WORKER_MESSAGE_OUTBOX_BACKOFF_CAP_MS", "86400001", "MESSAGE_OUTBOX_BACKOFF_CAP_INVALID"],
    ["PACKSCOUT_WORKER_MESSAGE_OUTBOX_POLL_MS", "99", "MESSAGE_OUTBOX_POLL_INVALID"],
    ["PACKSCOUT_WORKER_MESSAGE_OUTBOX_RETENTION_DAYS", "0", "MESSAGE_OUTBOX_RETENTION_DAYS_INVALID"],
  ] as const;
  for (const [variable, value, code] of invalidSettings) {
    assert.throws(
      () =>
        readProviderWorkerConfiguration(
          validEnvironment({ [variable]: value }),
          "worker:1",
        ),
      hasConfigurationCode(code),
      `${variable}=${value} refuses with ${code}`,
    );
  }
});

test("welcome dispatch settings default sanely, honor bounded overrides, and refuse out-of-bounds values", () => {
  const defaults = readProviderWorkerConfiguration(validEnvironment(), "worker:1");
  assert.equal(defaults.welcomeDispatchBatchSize, 10);
  assert.equal(defaults.welcomeDispatchLeaseMilliseconds, 300_000);
  assert.equal(defaults.welcomeDispatchPollMilliseconds, 60_000);

  const configured = readProviderWorkerConfiguration(
    validEnvironment({
      PACKSCOUT_WORKER_WELCOME_DISPATCH_BATCH_SIZE: "5",
      PACKSCOUT_WORKER_WELCOME_DISPATCH_LEASE_MS: "120000",
      PACKSCOUT_WORKER_WELCOME_DISPATCH_POLL_MS: "30000",
    }),
    "worker:1",
  );
  assert.equal(configured.welcomeDispatchBatchSize, 5);
  assert.equal(configured.welcomeDispatchLeaseMilliseconds, 120_000);
  assert.equal(configured.welcomeDispatchPollMilliseconds, 30_000);

  const invalidSettings = [
    // The batch bound mirrors the directory's claim bound (20), so a value
    // the worker accepts is never refused upstream.
    ["PACKSCOUT_WORKER_WELCOME_DISPATCH_BATCH_SIZE", "0", "WELCOME_DISPATCH_BATCH_SIZE_INVALID"],
    ["PACKSCOUT_WORKER_WELCOME_DISPATCH_BATCH_SIZE", "21", "WELCOME_DISPATCH_BATCH_SIZE_INVALID"],
    ["PACKSCOUT_WORKER_WELCOME_DISPATCH_LEASE_MS", "999", "WELCOME_DISPATCH_LEASE_INVALID"],
    ["PACKSCOUT_WORKER_WELCOME_DISPATCH_LEASE_MS", "900001", "WELCOME_DISPATCH_LEASE_INVALID"],
    ["PACKSCOUT_WORKER_WELCOME_DISPATCH_POLL_MS", "99", "WELCOME_DISPATCH_POLL_INVALID"],
    ["PACKSCOUT_WORKER_WELCOME_DISPATCH_POLL_MS", "300001", "WELCOME_DISPATCH_POLL_INVALID"],
  ] as const;
  for (const [variable, value, code] of invalidSettings) {
    assert.throws(
      () =>
        readProviderWorkerConfiguration(
          validEnvironment({ [variable]: value }),
          "worker:1",
        ),
      hasConfigurationCode(code),
      `${variable}=${value} refuses with ${code}`,
    );
  }
});

test("a backoff cap below the base is refused so retries can never shrink", () => {
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({
          PACKSCOUT_WORKER_MESSAGE_OUTBOX_BACKOFF_BASE_MS: "60000",
          PACKSCOUT_WORKER_MESSAGE_OUTBOX_BACKOFF_CAP_MS: "30000",
        }),
        "worker:1",
      ),
    hasConfigurationCode("MESSAGE_OUTBOX_BACKOFF_CAP_INVALID"),
  );
});
