import assert from "node:assert/strict";
import type { LaunchProviderKey } from "@packscout/contracts";
import {
  SourceAdapterContractError,
  captureAndTerminalizeSourceAdapterRequest,
  completeSourceAdapterConnectionTest,
  completeSourceAdapterPageRead,
  completeSourceAdapterSourceTest,
  interpretSourceAdapterConnectionTest,
  interpretSourceAdapterPage,
  interpretSourceAdapterSourceTest,
  sourceAdapterInterpretationContextOf,
  type CapturedSourcePageV1,
  type ConnectionTestOperation,
  type PageReadOperation,
  type SourceAdapter,
  type SourceAdapterOperationResult,
  type SourceAdapterRequestTerminalizationInput,
  type SourceTestOperation,
} from "./source-adapter.ts";
import type { SourceRequestLeaseAuthority } from "./source-request-lease.ts";

function acknowledgeTerminalization(
  input: SourceAdapterRequestTerminalizationInput,
) {
  return Promise.resolve(Object.freeze({
    requestAttemptId: input.requestAttemptId,
    requestLeaseId: input.requestLeaseId,
    operationScope: input.operationScope,
  }));
}

function isInvalidRequestCapture(error: unknown): boolean {
  return error instanceof SourceAdapterContractError &&
    error.code === "invalid_request_capture";
}

export interface SourceAdapterConformanceCase {
  readonly adapter: SourceAdapter;
  readonly requestLeaseAuthority: SourceRequestLeaseAuthority;
  readonly provider: LaunchProviderKey;
  readonly validConnectionConfiguration: Readonly<Record<string, unknown>>;
  readonly validSourceConfiguration: Readonly<Record<string, unknown>>;
  readonly expectedCursorValue: string;
  buildConnectionOperation(): Promise<ConnectionTestOperation>;
  buildSourceOperation(): Promise<SourceTestOperation>;
  buildPageOperation(): Promise<PageReadOperation>;
}

export interface SourceAdapterConformanceResult {
  readonly page: SourceAdapterOperationResult<CapturedSourcePageV1>;
}

export async function assertSourceAdapterConformance(
  fixture: SourceAdapterConformanceCase,
): Promise<SourceAdapterConformanceResult> {
  assert.equal(
    fixture.adapter.validateConnectionConfiguration(
      fixture.validConnectionConfiguration,
    ).ok,
    true,
  );
  assert.equal(
    fixture.adapter.validateSourceConfiguration(
      fixture.provider,
      fixture.validSourceConfiguration,
    ).ok,
    true,
  );

  const connection = await fixture.buildConnectionOperation();
  const connectionRequest = await captureAndTerminalizeSourceAdapterRequest(
    fixture.requestLeaseAuthority,
    fixture.adapter,
    connection,
    acknowledgeTerminalization,
  );
  assert.equal(connectionRequest.ok, true);
  if (!connectionRequest.ok) assert.fail("connection request failed");
  const connectionContext = sourceAdapterInterpretationContextOf(connection);
  const connectionInterpretation = await interpretSourceAdapterConnectionTest(
    fixture.adapter,
    connection,
    connectionRequest,
  );
  const connectionResult = completeSourceAdapterConnectionTest(
    connection,
    connectionContext,
    connectionRequest,
    connectionInterpretation,
  );
  assert.equal(connectionResult.ok, true);
  assert.equal("nextCursor" in connectionResult, false);
  assert.equal(connectionResult.measurements.recordCount, 0);
  connection.requestLease.close();

  const source = await fixture.buildSourceOperation();
  const sourceRequest = await captureAndTerminalizeSourceAdapterRequest(
    fixture.requestLeaseAuthority,
    fixture.adapter,
    source,
    acknowledgeTerminalization,
  );
  assert.equal(sourceRequest.ok, true);
  if (!sourceRequest.ok) assert.fail("source request failed");
  const sourceContext = sourceAdapterInterpretationContextOf(source);
  const sourceInterpretation = await interpretSourceAdapterSourceTest(
    fixture.adapter,
    source,
    sourceRequest,
  );
  const sourceResult = completeSourceAdapterSourceTest(
    source,
    sourceContext,
    sourceRequest,
    sourceInterpretation,
  );
  assert.equal(sourceResult.ok, true);
  assert.equal("nextCursor" in sourceResult, false);
  assert.equal(sourceResult.measurements.recordCount > 0, true);
  source.requestLease.close();

  const page = await fixture.buildPageOperation();
  const pageRequest = await captureAndTerminalizeSourceAdapterRequest(
    fixture.requestLeaseAuthority,
    fixture.adapter,
    page,
    acknowledgeTerminalization,
  );
  assert.equal(pageRequest.ok, true);
  if (!pageRequest.ok) assert.fail("page request failed");
  const pageContext = sourceAdapterInterpretationContextOf(page);
  const pageInterpretation = await interpretSourceAdapterPage(
    fixture.adapter,
    page,
    pageRequest,
  );
  const foreignPage = await fixture.buildPageOperation();
  assert.equal(foreignPage.requestLease.state, "available");
  await assert.rejects(
    interpretSourceAdapterPage(fixture.adapter, foreignPage, pageRequest),
    isInvalidRequestCapture,
  );
  assert.throws(
    () => completeSourceAdapterPageRead(
      foreignPage,
      sourceAdapterInterpretationContextOf(foreignPage),
      pageRequest,
      pageInterpretation,
    ),
    isInvalidRequestCapture,
  );
  assert.equal(foreignPage.requestLease.state, "available");
  foreignPage.requestLease.close();
  const pageResult = completeSourceAdapterPageRead(
    page,
    pageContext,
    pageRequest,
    pageInterpretation,
  );
  assert.equal(pageResult.ok, true);
  if (pageResult.ok) {
    assert.equal(pageResult.value.normalizedPage.provider, fixture.provider);
    assert.equal(
      pageResult.value.normalizedPage.nextCursor.value,
      fixture.expectedCursorValue,
    );
    assert.equal(
      pageResult.value.normalizedPage.outcomes.length,
      pageResult.measurements.recordCount,
    );
    assert.equal(pageResult.diagnostics.length > 0, true);
  }
  page.requestLease.close();
  return { page: pageResult };
}
