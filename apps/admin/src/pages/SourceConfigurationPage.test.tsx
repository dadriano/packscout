import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import type {
  AuthSessionResponse,
  ProviderSourceAdminCatalog,
} from "@packscout/contracts";
import { ConfirmProvider } from "../providers/confirm.tsx";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
import { ProviderSourceLedger } from "../components/source-configuration/SourceConfigurationLedgers.tsx";
import {
  changeControl,
  cleanupPage,
  findButton,
  jsonResponse,
  pageText,
  renderPage,
  settlePage,
  stubFetch,
} from "../testing/react-page-test.tsx";
import { SourceConfigurationPage } from "./SourceConfigurationPage.tsx";

Object.assign(globalThis, { React });

const providerId = "00000000-0000-4000-8000-000000000001";
const profileId = "00000000-0000-4000-8000-000000000002";
const connectionRevisionId = "00000000-0000-4000-8000-000000000003";
const sourceId = "00000000-0000-4000-8000-000000000004";
const sourceRevisionId = "00000000-0000-4000-8000-000000000005";
const scheduleRevisionId = "00000000-0000-4000-8000-000000000006";
const blockedRevisionId = "00000000-0000-4000-8000-000000000007";
const fingerprint = "a".repeat(64);

const catalog: ProviderSourceAdminCatalog = {
  availableSourceTypes: [{
    sourceTypeKey: "dataforrest-events-v1",
    label: "DataForrest events",
  }],
  providers: [{
    id: providerId,
    provider: "courtyard",
    sourceRegistration: {
      sourceTypeKey: "dataforrest-events-v1",
      sourceAdapterVersion: "dataforrest-events-adapter-v1",
      normalizedContractVersion: "provider-observation-v1",
      mapperKey: "courtyard-provider-observation",
      mapperVersion: "1",
      identityNamespaceKey: "dataforrest-courtyard-records-v1",
      recordIdScopes: [
        "catalog-pack-v1",
        "catalog-card-v1",
        "pull-v1",
        "trade-v1",
      ],
    },
  }],
  connections: [{
    id: profileId,
    displayName: "Shared DataForrest",
    sourceTypeKey: "dataforrest-events-v1",
    connectionTypeKey: "dataforrest-events-connection-v1",
    state: "active",
    requestLimit: 2,
    activeRevisionId: connectionRevisionId,
    recoveryFence: null,
    latestRevision: {
      id: connectionRevisionId,
      revisionNumber: 1,
      sourceAdapterVersion: "dataforrest-events-adapter-v1",
      state: "active",
      endpointHost: "198.204.245.26.sslip.io",
      credentialConfigured: true,
      credentialMask: "••••••••",
      encryptionKeyVersion: 1,
      healthGeneration: "0",
      revokedAt: null,
      test: {
        jobId: connectionRevisionId,
        connectionRevisionId,
        current: true,
        state: "succeeded",
        outcome: "success",
        safeCode: "connection_valid",
        requestedAt: "2026-08-21T12:00:00.000Z",
        testedAt: "2026-08-21T12:00:05.000Z",
      },
      createdAt: "2026-08-21T12:00:00.000Z",
    },
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:05.000Z",
  }],
  sources: [{
    providerId,
    provider: "courtyard",
    sourceInstanceId: sourceId,
    sourceRevisionId,
    sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: "dataforrest-events-adapter-v1",
    connectionProfileId: profileId,
    connectionRevisionId,
    state: "paused",
    pauseRequested: false,
    normalizedContractVersion: "provider-observation-v1",
    mapperKey: "courtyard-provider-observation",
    mapperVersion: "1",
    identityNamespaceKey: "dataforrest-courtyard-records-v1",
    recordIdScopes: [
      "catalog-pack-v1",
      "catalog-card-v1",
      "pull-v1",
      "trade-v1",
    ],
    intervalSeconds: 60,
    freshnessGraceSeconds: 900,
    scheduleRevisionId,
    cursor: {
      generation: "2",
      fingerprint,
      resumeLabel: "Saved cursor",
    },
    test: {
      jobId: sourceRevisionId,
      connectionRevisionId,
      current: true,
      state: "succeeded",
      outcome: "success",
      safeCode: "source_valid",
      requestedAt: "2026-08-21T12:00:00.000Z",
      testedAt: "2026-08-21T12:00:05.000Z",
    },
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:05.000Z",
  }],
};

function session(admin: boolean): AuthSessionResponse {
  return {
    operator: {
      id: "00000000-0000-4000-8000-000000000010",
      email: "operator@packscout.test",
      displayName: "Source Operator",
      state: "active",
    },
    membership: {
      organizationId: "00000000-0000-4000-8000-000000000011",
      organizationName: "PackScout",
      role: admin ? "admin" : "data_operator",
    },
    permissions: admin
      ? ["providers:view", "providers:manage", "provider_secrets:manage"]
      : ["providers:view"],
    csrfToken: "fixture-csrf",
  };
}

function page(initialSession: AuthSessionResponse) {
  return (
    <MemoryRouter>
      <ToastProvider>
        <ConfirmProvider>
          <SessionProvider initialSession={initialSession}>
            <SourceConfigurationPage />
          </SessionProvider>
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>
  );
}

test("configuration UI renders masked evidence and explicit cursor impact without secret material", async (context) => {
  stubFetch(context, (request) => {
    const path = String(request.input);
    if (path.endsWith("cursor-reset-preview")) {
      return jsonResponse({
        preview: {
          providerId,
          provider: "courtyard",
          sourceInstanceId: sourceId,
          sourceRevisionId,
          sourceState: "paused",
          cursorGeneration: "2",
          cursorFingerprint: fingerprint,
          confirmation: "RESET courtyard TO FEED START",
          consequence: "The saved cursor will be cleared and the next resume will start from Feed start.",
        },
      });
    }
    return jsonResponse({ catalog });
  });
  const renderer = await renderPage(page(session(true)));
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /Shared DataForrest/);
  assert.match(text, /•••••••• configured/);
  assert.match(text, /courtyard-provider-observation @ 1/);
  assert.match(text, new RegExp(fingerprint));
  assert.doesNotMatch(renderer.container.innerHTML, /bearer-token|authorization|configuration_ciphertext/i);
  for (const password of renderer.container.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
    assert.equal(password.value, "");
  }

  await act(async () => {
    findButton(renderer, "Reset cursor").click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.match(pageText(renderer), /next resume will start from Feed start/);
  assert.match(pageText(renderer), /RESET courtyard TO FEED START/);
});

test("data operators receive dense read-only evidence without configuration controls", async (context) => {
  stubFetch(context, () => jsonResponse({ catalog }));
  const renderer = await renderPage(page(session(false)));
  cleanupPage(context, renderer);
  await settlePage();

  assert.match(pageText(renderer), /Read-only source evidence/);
  assert.match(pageText(renderer), /Shared DataForrest/);
  assert.equal(renderer.container.querySelector('input[type="password"]'), null);
  assert.equal([...renderer.container.querySelectorAll("button")]
    .some((button) => button.textContent?.trim() === "Revoke"), false);
  assert.equal(renderer.container.querySelector(".source-config-editor"), null);
});

test("an old retired-revision episode remains recoverable through the healthy latest active revision", async (context) => {
  const recoveryCatalog: ProviderSourceAdminCatalog = {
    ...catalog,
    connections: catalog.connections.map((connection) => ({
      ...connection,
      recoveryFence: {
        blockedRevisionId,
        blockingEpisodeId: "00000000-0000-4000-8000-000000000008",
      },
    })),
  };
  stubFetch(context, () => jsonResponse({ catalog: recoveryCatalog }));
  const renderer = await renderPage(page(session(true)));
  cleanupPage(context, renderer);
  await settlePage();

  assert.match(pageText(renderer), /Recover with a new credential revision/u);
  assert.ok(renderer.container.querySelector<HTMLInputElement>(
    'input[name="recoveryCredential"]',
  ));
  assert.equal([...renderer.container.querySelectorAll("button")]
    .some((button) => button.textContent?.trim() === "Test recovery"), false);
});

test("a revoked latest candidate does not hide the safe next-rotation path", async (context) => {
  const revokedCatalog: ProviderSourceAdminCatalog = {
    ...catalog,
    connections: catalog.connections.map((connection) => ({
      ...connection,
      latestRevision: {
        ...connection.latestRevision,
        state: "revoked",
        revokedAt: "2026-08-21T12:01:00.000Z",
        test: {
          ...connection.latestRevision.test,
          current: false,
        },
      },
    })),
  };
  stubFetch(context, () => jsonResponse({ catalog: revokedCatalog }));
  const renderer = await renderPage(page(session(true)));
  cleanupPage(context, renderer);
  await settlePage();

  assert.match(pageText(renderer), /Rotate credential on the same endpoint/u);
  assert.ok(renderer.container.querySelector<HTMLInputElement>(
    'input[name="bearerCredential"]',
  ));
});

test("source creation submits the immutable mapper descriptor supplied by the server catalog", async (context) => {
  const serverCatalog: ProviderSourceAdminCatalog = {
    ...catalog,
    providers: catalog.providers.map((provider) => ({
      ...provider,
      sourceRegistration: {
        ...provider.sourceRegistration,
        mapperKey: "server-approved-mapper",
        mapperVersion: "7",
      },
    })),
  };
  let submitted: unknown;
  const renderer = await renderPage(
    <ProviderSourceLedger
      catalog={serverCatalog}
      canManage
      pendingKey={null}
      onCreate={async (request) => {
        submitted = request;
        return true;
      }}
      onCommand={() => undefined}
      onInterval={async () => true}
    />,
  );
  cleanupPage(context, renderer);

  await act(async () => {
    changeControl(renderer, "source-provider", providerId);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    changeControl(renderer, "source-profile", profileId);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.match(pageText(renderer), /server-approved-mapper @ 7/u);
  const form = findButton(renderer, "Save inactive source").closest("form");
  assert.ok(form);
  await act(async () => {
    form.dispatchEvent(new renderer.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  assert.deepEqual(submitted, {
    providerId,
    connectionProfileId: profileId,
    sourceTypeKey: "dataforrest-events-v1",
    mapperKey: "server-approved-mapper",
    mapperVersion: "7",
    intervalSeconds: 60,
  });
});

test("source activation stays disabled after a newer pending or failed connection test", async (context) => {
  for (const state of ["pending", "failed"] as const) {
    const staleCatalog: ProviderSourceAdminCatalog = {
      ...catalog,
      connections: catalog.connections.map((connection) => ({
        ...connection,
        latestRevision: {
          ...connection.latestRevision,
          test: {
            ...connection.latestRevision.test,
            state,
            outcome: state === "failed" ? "failure" : null,
            current: true,
          },
        },
      })),
    };
    const renderer = await renderPage(
      <ProviderSourceLedger
        catalog={staleCatalog}
        canManage
        pendingKey={null}
        onCreate={async () => true}
        onCommand={() => undefined}
        onInterval={async () => true}
      />,
    );
    cleanupPage(context, renderer);
    assert.equal(findButton(renderer, "Activate paused").disabled, true);
  }
});

test("source testing is offered only for draft and disabled lifecycle states", async (context) => {
  for (const state of ["draft", "disabled", "paused", "active", "replaced"] as const) {
    const stateCatalog: ProviderSourceAdminCatalog = {
      ...catalog,
      sources: catalog.sources.map((source) => ({ ...source, state })),
    };
    const renderer = await renderPage(
      <ProviderSourceLedger
        catalog={stateCatalog}
        canManage
        pendingKey={null}
        onCreate={async () => true}
        onCommand={() => undefined}
        onInterval={async () => true}
      />,
    );
    cleanupPage(context, renderer);
    const hasTest = [...renderer.container.querySelectorAll("button")]
      .some((button) => button.textContent?.trim() === "Test");
    assert.equal(hasTest, state === "draft" || state === "disabled", state);
  }
});

test("replacement waits for selected-provider confirmation and explains the cursor boundary", async (context) => {
  let replacementBody: unknown = null;
  const requests = stubFetch(context, ({ input, init }) => {
    const path = String(input);
    if (path.endsWith("/provider-sources/sources/replacements")) {
      replacementBody = JSON.parse(String(init?.body));
      return jsonResponse({
        sourceInstanceId: "00000000-0000-4000-8000-000000000020",
        sourceRevisionId: "00000000-0000-4000-8000-000000000021",
        audit: {
          action: "source_replacement_created",
          subjectType: "provider_source",
          subjectId: "00000000-0000-4000-8000-000000000020",
          revisionId: "00000000-0000-4000-8000-000000000021",
          outcome: "succeeded",
          safeCode: null,
          occurredAt: "2026-08-21T12:05:00.000Z",
        },
      }, 201);
    }
    return jsonResponse({ catalog });
  });
  const renderer = await renderPage(page(session(true)));
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => {
    changeControl(renderer, "source-provider", providerId);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    changeControl(renderer, "source-profile", profileId);
    changeControl(renderer, "source-replacement", sourceId);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  const form = findButton(renderer, "Save inactive source").closest("form");
  assert.ok(form);
  await act(async () => {
    form.dispatchEvent(new renderer.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  assert.equal(replacementBody, null);
  assert.match(pageText(renderer), /Only courtyard is affected/iu);
  assert.match(pageText(renderer), /cursor cannot transfer/iu);
  assert.match(pageText(renderer), /activation begins paused/iu);

  await act(async () => {
    findButton(renderer, "Replace selected source").click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();

  assert.deepEqual(replacementBody, {
    providerId,
    connectionProfileId: profileId,
    sourceTypeKey: "dataforrest-events-v1",
    mapperKey: "courtyard-provider-observation",
    mapperVersion: "1",
    intervalSeconds: 60,
    replacesSourceInstanceId: sourceId,
  });
  assert.ok(requests.some(({ input }) => String(input).endsWith("/provider-sources/sources/replacements")));
});
