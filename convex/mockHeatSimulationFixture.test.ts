/// <reference types="vite/client" />

import { publicRepackHeatSignalSchema } from "@packscout/contracts";
import { describe, expect, test } from "vitest";
import { sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import {
  MOCK_HEAT_DEFAULT_FRAME_STEP_MILLISECONDS,
  MOCK_HEAT_DEFAULT_PUBLICATION_CADENCE_MILLISECONDS,
  MOCK_HEAT_FRAME_HASH_DOMAIN,
  buildMockHeatFrame,
  mockHeatFrameBody,
  mockHeatSnapshotIdFromHash,
  validateMockHeatControls,
} from "./mockHeatSimulationFixture";

const controls = {
  seed: "packscout-demo",
  startAt: "2027-01-01T12:00:00.000Z",
  frameIndex: 0,
  frameStepMilliseconds: MOCK_HEAT_DEFAULT_FRAME_STEP_MILLISECONDS,
  publicationCadenceMilliseconds:
    MOCK_HEAT_DEFAULT_PUBLICATION_CADENCE_MILLISECONDS,
} as const;

describe("mock heat frame projection", () => {
  test("is deterministic, self-hashed, and covers every presentation state", async () => {
    const first = await buildMockHeatFrame(controls);
    const replay = await buildMockHeatFrame(controls);
    expect(replay).toEqual(first);
    expect(first.signals.map((signal) => signal.publicRepackId)).toEqual(
      [...first.signals.map((signal) => signal.publicRepackId)].sort(),
    );
    expect(new Set(first.signals.map((signal) => signal.state))).toEqual(
      new Set(["hot", "warm", "normal", "cold", "insufficient_data"]),
    );
    expect(
      first.signals.every(
        (signal) =>
          publicRepackHeatSignalSchema.safeParse(signal).success &&
          signal.provenance.kind === "simulated" &&
          signal.limitationCodes.includes("simulated_data"),
      ),
    ).toBe(true);
    await expect(
      sha256CanonicalJson(
        MOCK_HEAT_FRAME_HASH_DOMAIN,
        mockHeatFrameBody(first),
      ),
    ).resolves.toBe(first.contentHash);
    expect(first.publicHeatSnapshotId).toBe(
      mockHeatSnapshotIdFromHash(first.contentHash),
    );
  });

  test("supports reproducible direct frame selection and controlled transitions", async () => {
    const frameOne = await buildMockHeatFrame({ ...controls, frameIndex: 1 });
    const frameTwo = await buildMockHeatFrame({ ...controls, frameIndex: 2 });
    expect(frameOne.sequence).toBe(1);
    expect(frameTwo.sequence).toBe(2);
    expect(frameOne.simulationRunId).toBe(frameTwo.simulationRunId);
    expect(frameOne.publicHeatSnapshotId).not.toBe(frameTwo.publicHeatSnapshotId);
    expect(
      frameOne.signals.map((signal) => signal.state),
    ).not.toEqual(frameTwo.signals.map((signal) => signal.state));
    expect(frameOne.calculatedAt).toBe("2027-01-01T12:00:05.000Z");
    const slowerScenario = await buildMockHeatFrame({
      ...controls,
      frameIndex: 1,
      frameStepMilliseconds: 60_000,
    });
    expect(slowerScenario.signals.map(({ state }) => state)).not.toEqual(
      frameOne.signals.map(({ state }) => state),
    );
  });

  test("rejects ambiguous or unsafe simulation controls", () => {
    expect(() =>
      validateMockHeatControls({ ...controls, seed: "bad seed" }),
    ).toThrow("seed");
    expect(() =>
      validateMockHeatControls({ ...controls, startAt: "2027-01-01" }),
    ).toThrow("canonical");
    expect(() =>
      validateMockHeatControls({ ...controls, frameIndex: -1 }),
    ).toThrow("frame index");
    expect(() =>
      validateMockHeatControls({ ...controls, frameStepMilliseconds: 1 }),
    ).toThrow("frame step");
    expect(() =>
      validateMockHeatControls({ ...controls, publicationCadenceMilliseconds: 1 }),
    ).toThrow("publication cadence");
  });
});
