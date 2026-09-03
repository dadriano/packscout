#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  directProvisionOperatorRequestSchema,
  inviteOperatorRequestSchema,
} from "@packscout/contracts";
import {
  createPrismaClientLifecycle,
  PrismaFirstAdminBootstrapRepository,
  type PackscoutPrismaClient,
} from "@packscout/database";
import { createNodePasswordHasher } from "../../apps/admin/server/auth/crypto.ts";
import {
  classifyLocalDatabaseTarget,
  isLoopbackHostname,
} from "./local-database-target.mjs";

const MAXIMUM_PASSWORD_INPUT_BYTES = 1_024;
const SYSTEM_DATABASE_NAMES = new Set(["postgres", "template0", "template1"]);

export const LOCAL_DEVELOPMENT_ORGANIZATION = Object.freeze({
  id: "00000000-0000-4000-8000-000000000001",
  slug: "packscout-local",
  name: "PackScout Local Development",
});

export const LOCAL_DEVELOPMENT_PROVIDER_ROOTS = Object.freeze([
  Object.freeze({
    id: "00000000-0000-4000-8000-000000000011",
    platformKey: "beezie",
    displayName: "Beezie (local development)",
    state: "draft" as const,
  }),
  Object.freeze({
    id: "00000000-0000-4000-8000-000000000013",
    platformKey: "gamestop",
    displayName: "GameStop (local development)",
    state: "draft" as const,
  }),
  Object.freeze({
    id: "9c2ef352-161a-4e5f-9d7d-6ff46755a104",
    platformKey: "clutchpacks",
    displayName: "ClutchPacks",
    state: "active" as const,
  }),
  Object.freeze({
    id: "9c2ef352-161a-4e5f-9d7d-6ff46755a102",
    platformKey: "collector_crypt",
    displayName: "Collector Crypt",
    state: "active" as const,
  }),
  Object.freeze({
    id: "9c2ef352-161a-4e5f-9d7d-6ff46755a101",
    platformKey: "courtyard",
    displayName: "Courtyard",
    state: "active" as const,
  }),
  Object.freeze({
    id: "9c2ef352-161a-4e5f-9d7d-6ff46755a103",
    platformKey: "phygitals",
    displayName: "Phygitals",
    state: "active" as const,
  }),
]);

export class LocalFirstAdminBootstrapError extends Error {
  override readonly name = "LocalFirstAdminBootstrapError";

  constructor(readonly code: string) {
    super(code);
  }
}

export function assertNoBootstrapArguments(argumentsList: readonly string[]): void {
  if (argumentsList.length !== 0) {
    throw new LocalFirstAdminBootstrapError("ARGUMENTS_FORBIDDEN");
  }
}

export function readLocalFirstAdminEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<{
  databaseUrl: string;
  databaseName: string;
  email: string;
  displayName: string;
}> {
  if (environment.NODE_ENV !== "development") {
    throw new LocalFirstAdminBootstrapError(
      "LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED",
    );
  }
  if (environment.PACKSCOUT_BOOTSTRAP_ADMIN_PASSWORD !== undefined) {
    throw new LocalFirstAdminBootstrapError(
      "ADMIN_PASSWORD_ENVIRONMENT_FORBIDDEN",
    );
  }

  const classification = classifyLocalDatabaseTarget(environment);
  if (!classification.local || !classification.database) {
    throw new LocalFirstAdminBootstrapError("DATABASE_TARGET_NOT_LOCAL");
  }
  const databaseUrl = environment.PACKSCOUT_DATABASE_URL?.trim() ?? "";
  const parsed = new URL(databaseUrl);
  if (
    parsed.search.length !== 0 ||
    parsed.hash.length !== 0 ||
    SYSTEM_DATABASE_NAMES.has(classification.database)
  ) {
    throw new LocalFirstAdminBootstrapError("DATABASE_TARGET_AMBIGUOUS");
  }

  const identity = inviteOperatorRequestSchema.safeParse({
    email: environment.PACKSCOUT_BOOTSTRAP_ADMIN_EMAIL,
    displayName:
      environment.PACKSCOUT_BOOTSTRAP_ADMIN_DISPLAY_NAME ?? "Primary Admin",
    role: "admin",
  });
  if (!identity.success) {
    throw new LocalFirstAdminBootstrapError("ADMIN_IDENTITY_INVALID");
  }

  return Object.freeze({
    databaseUrl,
    databaseName: classification.database,
    email: identity.data.email,
    displayName: identity.data.displayName,
  });
}

export function assertConnectedLocalDatabaseIdentity(
  identity: Readonly<{
    databaseName: string;
    serverAddress: string | null;
  }> | undefined,
  expectedDatabaseName: string,
): void {
  const serverAddress = (() => {
    const value = identity?.serverAddress;
    if (value === null || value === undefined) return value;
    const inet = /^(.*)\/(\d{1,3})$/u.exec(value);
    if (!inet) return value;
    const address = inet[1]!;
    const prefixLength = Number(inet[2]);
    const family = isIP(address);
    return (family === 4 && prefixLength === 32) ||
        (family === 6 && prefixLength === 128)
      ? address
      : value;
  })();
  if (
    !identity ||
    identity.databaseName !== expectedDatabaseName ||
    serverAddress === null ||
    serverAddress === undefined ||
    !isLoopbackHostname(serverAddress)
  ) {
    throw new LocalFirstAdminBootstrapError(
      "CONNECTED_DATABASE_IDENTITY_NOT_LOCAL",
    );
  }
}

async function verifyConnectedLocalDatabaseIdentity(
  database: PackscoutPrismaClient,
  expectedDatabaseName: string,
): Promise<void> {
  const rows = await database.$queryRaw<
    Array<{ databaseName: string; serverAddress: string | null }>
  >`
    select current_database() as "databaseName",
           inet_server_addr()::text as "serverAddress"
  `;
  if (rows.length !== 1) {
    throw new LocalFirstAdminBootstrapError(
      "CONNECTED_DATABASE_IDENTITY_NOT_LOCAL",
    );
  }
  assertConnectedLocalDatabaseIdentity(rows[0], expectedDatabaseName);
}

async function readPipedPassword(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of input) {
      // Own every chunk so zeroizing our temporary storage cannot mutate the
      // caller's stream buffer.
      const bytes = Buffer.isBuffer(chunk)
        ? Buffer.from(chunk)
        : Buffer.from(String(chunk));
      totalBytes += bytes.byteLength;
      if (totalBytes > MAXIMUM_PASSWORD_INPUT_BYTES) {
        bytes.fill(0);
        throw new LocalFirstAdminBootstrapError(
          "ADMIN_PASSWORD_INPUT_TOO_LARGE",
        );
      }
      chunks.push(bytes);
    }
    const combined = Buffer.concat(chunks, totalBytes);
    try {
      const text = combined.toString("utf8");
      const password = text.endsWith("\r\n")
        ? text.slice(0, -2)
        : text.endsWith("\n")
          ? text.slice(0, -1)
          : text;
      if (password.includes("\r") || password.includes("\n")) {
        throw new LocalFirstAdminBootstrapError(
          "ADMIN_PASSWORD_INPUT_MULTIPLE_LINES",
        );
      }
      return password;
    } finally {
      combined.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

type TerminalInput = Readable & {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): void;
};

async function readHiddenTerminalPassword(
  input: TerminalInput,
  output: Writable,
): Promise<string> {
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing === true;
  emitKeypressEvents(input);
  input.setRawMode?.(true);
  input.resume();
  output.write("Initial administrator password: ");

  return new Promise((resolve, reject) => {
    let password = "";
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.off("error", onError);
      input.off("end", onEnd);
      input.setRawMode?.(wasRaw);
      if (!wasFlowing) input.pause();
    };
    const refuse = (code: string) => {
      password = "";
      cleanup();
      output.write("\n");
      reject(new LocalFirstAdminBootstrapError(code));
    };
    const onError = () => refuse("ADMIN_PASSWORD_INPUT_UNAVAILABLE");
    const onEnd = () => refuse("ADMIN_PASSWORD_INPUT_UNAVAILABLE");
    const onKeypress = (
      character: string | undefined,
      key: Readonly<{
        name?: string;
        ctrl?: boolean;
        meta?: boolean;
      }>,
    ) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) {
        refuse("ADMIN_PASSWORD_INPUT_INTERRUPTED");
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const result = password;
        password = "";
        cleanup();
        output.write("\n");
        resolve(result);
        return;
      }
      if (key.name === "backspace") {
        password = [...password].slice(0, -1).join("");
        return;
      }
      if (character && !key.ctrl && !key.meta) {
        password += character;
        if (Buffer.byteLength(password, "utf8") > MAXIMUM_PASSWORD_INPUT_BYTES) {
          refuse("ADMIN_PASSWORD_INPUT_TOO_LARGE");
        }
      }
    };

    input.on("keypress", onKeypress);
    input.once("error", onError);
    input.once("end", onEnd);
  });
}

export async function readBootstrapPassword(
  input: Readable = process.stdin,
  output: Writable = process.stderr,
): Promise<string> {
  const terminal = input as TerminalInput;
  return terminal.isTTY && typeof terminal.setRawMode === "function"
    ? readHiddenTerminalPassword(terminal, output)
    : readPipedPassword(input);
}

export function safeBootstrapFailure(error: unknown): Readonly<{
  ok: false;
  operation: "bootstrap_first_admin";
  code: string;
}> {
  return Object.freeze({
    ok: false,
    operation: "bootstrap_first_admin",
    code:
      error instanceof LocalFirstAdminBootstrapError
        ? error.code
        : "UNEXPECTED_BOOTSTRAP_FAILURE",
  });
}

async function main(): Promise<void> {
  assertNoBootstrapArguments(process.argv.slice(2));
  const environment = readLocalFirstAdminEnvironment(process.env);
  const lifecycle = createPrismaClientLifecycle({
    databaseUrl: environment.databaseUrl,
  });
  try {
    await lifecycle.start();
    await verifyConnectedLocalDatabaseIdentity(
      lifecycle.client,
      environment.databaseName,
    );

    let password = await readBootstrapPassword();
    try {
      const account = directProvisionOperatorRequestSchema.safeParse({
        email: environment.email,
        displayName: environment.displayName,
        password,
        role: "admin",
      });
      if (!account.success) {
        throw new LocalFirstAdminBootstrapError("ADMIN_CREDENTIAL_INVALID");
      }
      const passwordHash = await createNodePasswordHasher().hash(
        account.data.password,
      );
      const result = await new PrismaFirstAdminBootstrapRepository(
        lifecycle.client,
      ).bootstrap({
        expectedOrganization: LOCAL_DEVELOPMENT_ORGANIZATION,
        expectedProviderRoots: LOCAL_DEVELOPMENT_PROVIDER_ROOTS,
        operatorId: randomUUID(),
        emailNormalized: account.data.email,
        displayName: account.data.displayName,
        passwordHash,
        now: new Date(),
      });
      if (result.kind === "operator_already_present") {
        throw new LocalFirstAdminBootstrapError("OPERATOR_ALREADY_PRESENT");
      }
      if (result.kind === "development_seed_not_exact") {
        throw new LocalFirstAdminBootstrapError(
          "DEVELOPMENT_DATABASE_NOT_EXACT_SEED",
        );
      }
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          operation: "bootstrap_first_admin",
          database: environment.databaseName,
          organizationId: result.organizationId,
          operatorId: result.operatorId,
        })}\n`,
      );
    } finally {
      // JavaScript strings cannot be zeroized, but dropping the final explicit
      // reference keeps credential lifetime bounded to this short-lived command.
      password = "";
    }
  } finally {
    await lifecycle.close().catch(() => undefined);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(safeBootstrapFailure(error))}\n`);
    process.exitCode = 1;
  });
}
