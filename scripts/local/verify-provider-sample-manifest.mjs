import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, parse, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const RECORD_GROUPS = ["catalog", "pulls", "trades"];
const EVIDENCE_GROUP_BY_RECORD_KIND = Object.freeze({
  catalog: "catalog",
  pulls: "pulls",
  trades: "sales",
});
const MANIFEST_URL = new URL(
  "../../packages/contracts/src/__fixtures__/provider-sample-manifest.json",
  import.meta.url,
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shapeSignature(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const elementShapes = [...new Set(value.map(shapeSignature))].sort();
    return `array<${elementShapes.join("|")}>`;
  }
  if (typeof value === "object") {
    const fields = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${shapeSignature(value[key])}`);
    return `object<{${fields.join(",")}}>`;
  }
  return typeof value;
}

function requireObject(value, file, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file} has an invalid ${path} structure.`);
  }
  return value;
}

function requireRecordArray(page, group, file) {
  const records = page[group];
  if (!Array.isArray(records)) {
    throw new Error(`${file} has an invalid ${group} structure.`);
  }
  return records;
}

function sortedKeySet(value) {
  return Object.keys(value).sort();
}

function addKeySet(keySets, keys) {
  keySets.set(JSON.stringify(keys), keys);
}

function summarizeRecordShapes(records) {
  const countsByShape = new Map();
  for (const record of records) {
    const digest = sha256(shapeSignature(record));
    countsByShape.set(digest, (countsByShape.get(digest) ?? 0) + 1);
  }
  const shapeCounts = [...countsByShape].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return {
    sha256: sha256(JSON.stringify(shapeCounts)),
    uniqueShapeCount: shapeCounts.length,
  };
}

async function readSample(directory, file) {
  const bytes = await readFile(join(directory, file));
  let parsedValue;
  try {
    parsedValue = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }
  const page = requireObject(parsedValue, file, "page");
  const records = Object.fromEntries(
    RECORD_GROUPS.map((group) => [
      group,
      requireRecordArray(page, EVIDENCE_GROUP_BY_RECORD_KIND[group], file),
    ]),
  );
  for (const group of RECORD_GROUPS) {
    for (const record of records[group]) {
      requireObject(record, file, `${group} record`);
    }
  }
  return { bytes, page, records };
}

async function deriveManifest(directory) {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const pageKeySets = new Map();
  const recordKeySets = Object.fromEntries(
    RECORD_GROUPS.map((group) => [group, new Map()]),
  );
  const samples = [];

  for (const file of files) {
    const { bytes, page, records } = await readSample(directory, file);
    addKeySet(
      pageKeySets,
      sortedKeySet(page).map((key) => (key === "sales" ? "trades" : key)),
    );
    for (const group of RECORD_GROUPS) {
      for (const record of records[group]) {
        addKeySet(recordKeySets[group], sortedKeySet(record));
      }
    }
    samples.push({
      name: parse(file).name,
      file,
      contentSha256: sha256(bytes),
      counts: Object.fromEntries(
        RECORD_GROUPS.map((group) => [group, records[group].length]),
      ),
      recordShapes: Object.fromEntries(
        RECORD_GROUPS.map((group) => [
          group,
          summarizeRecordShapes(records[group]),
        ]),
      ),
      nullableFields: {
        pullPackExternalId: records.pulls.some(
          (record) => record.pack_external_id === null,
        ),
        tradeAmount: records.trades.some((record) => record.amount === null),
        tradeCurrency: records.trades.some((record) => record.currency === null),
      },
    });
  }

  return {
    version: 1,
    hashAlgorithm: "sha256",
    shapeAlgorithm: "recursive-key-and-json-type-v1",
    outerStructure: {
      pageKeySets: [...pageKeySets.values()].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
      recordKeySets: Object.fromEntries(
        RECORD_GROUPS.map((group) => [
          group,
          [...recordKeySets[group].values()].sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          ),
        ]),
      ),
    },
    samples,
  };
}

function mismatchedFiles(expected, actual) {
  const expectedByFile = new Map(
    expected.samples.map((sample) => [sample.file, sample]),
  );
  const actualByFile = new Map(
    actual.samples.map((sample) => [sample.file, sample]),
  );
  return [...new Set([...expectedByFile.keys(), ...actualByFile.keys()])]
    .filter(
      (file) =>
        !isDeepStrictEqual(expectedByFile.get(file), actualByFile.get(file)),
    )
    .sort();
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1) {
    throw new Error(
      "Usage: node scripts/local/verify-provider-sample-manifest.mjs <sample-directory>",
    );
  }
  const directory = resolve(arguments_[0]);
  let directoryStats;
  try {
    directoryStats = await stat(directory);
  } catch {
    throw new Error("Provider sample directory does not exist.");
  }
  if (!directoryStats.isDirectory()) {
    throw new Error("Provider sample path must be a directory.");
  }

  const expected = JSON.parse(await readFile(MANIFEST_URL, "utf8"));
  const actual = await deriveManifest(directory);
  if (!isDeepStrictEqual(expected, actual)) {
    const changedFiles = mismatchedFiles(expected, actual);
    const outerChanged = !isDeepStrictEqual(
      expected.outerStructure,
      actual.outerStructure,
    );
    const details = [
      ...changedFiles.map((file) => basename(file)),
      ...(outerChanged ? ["outer structure"] : []),
    ];
    throw new Error(
      `Provider sample manifest mismatch (${details.join(", ") || "metadata"}).`,
    );
  }
  console.log(`Verified ${actual.samples.length} provider sample manifests.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Manifest verification failed.");
  process.exitCode = 1;
});
