#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://gacha.collectorcrypt.com";
const DEFAULT_PAGE_LIMIT = 500;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRIES = 3;
const MAX_PAGES_PER_MACHINE = 400;

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

export function parsePositiveInteger(value, optionName) {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

async function fetchJson(url, { apiKey, retries = DEFAULT_RETRIES } = {}) {
  const headers = { accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * (attempt + 1)),
        );
      }
    }
  }
  throw lastError;
}

export async function fetchMachines(baseUrl, options = {}) {
  const payload = await fetchJson(`${baseUrl}/api/machines`, options);
  if (!Array.isArray(payload?.machines)) {
    throw new Error("unexpected /api/machines response: missing machines array");
  }
  return payload.machines;
}

export async function fetchAllNfts(baseUrl, code, options = {}) {
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const nfts = [];

  for (let page = 1; page <= MAX_PAGES_PER_MACHINE; page += 1) {
    const query = new URLSearchParams({
      code,
      page: String(page),
      limit: String(pageLimit),
    });
    const payload = await fetchJson(
      `${baseUrl}/api/getNfts?${query}`,
      options,
    );
    const batch = Array.isArray(payload?.nfts) ? payload.nfts : [];
    nfts.push(...batch);
    if (!payload?.hasMore || batch.length === 0) return nfts;
  }

  throw new Error(
    `machine "${code}" exceeded ${MAX_PAGES_PER_MACHINE} pages; aborting to avoid an endless crawl`,
  );
}

export function topCardFrom(nfts) {
  let top = null;
  for (const nft of nfts) {
    const value = nft?.insured_value;
    if (typeof value !== "number" || Number.isNaN(value)) continue;
    if (top === null || value > top.insuredValue) {
      top = {
        name: (nft.name ?? "").trim(),
        description: (nft.description ?? "").trim(),
        rarity: nft.rarity ?? null,
        insuredValue: value,
        nftAddress: nft.nft_address ?? nft.id ?? null,
        image: nft.image ?? null,
      };
    }
  }
  return top;
}

export function buildMachineReport(machine, nfts) {
  const reportedStock = Object.values(machine.stock ?? {}).reduce(
    (total, count) => total + (typeof count === "number" ? count : 0),
    0,
  );
  const withValue = nfts.filter(
    (nft) => typeof nft?.insured_value === "number",
  );
  return {
    code: machine.code,
    name: machine.name,
    price: machine.price ?? null,
    public: machine.public ?? null,
    reportedStock,
    fetchedCount: nfts.length,
    missingValueCount: nfts.length - withValue.length,
    topCard: topCardFrom(nfts),
  };
}

export function formatTable(reports) {
  const lines = [
    "machine | price | top card value | rarity | card",
    "--- | --- | --- | --- | ---",
  ];
  for (const report of reports) {
    if (report.error) {
      lines.push(`${report.code} | - | ERROR | - | ${report.error}`);
      continue;
    }
    if (!report.topCard) {
      lines.push(`${report.code} | $${report.price} | (empty) | - | -`);
      continue;
    }
    const card = report.topCard;
    lines.push(
      [
        report.code,
        `$${report.price}`,
        `$${card.insuredValue.toLocaleString("en-US")}`,
        card.rarity ?? "-",
        card.description || card.name,
      ].join(" | "),
    );
  }
  return lines.join("\n");
}

export function sortReports(reports) {
  return [...reports].sort(
    (a, b) => (b.topCard?.insuredValue ?? -1) - (a.topCard?.insuredValue ?? -1),
  );
}

async function mapWithConcurrency(items, concurrency, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await task(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function collectTopCards({
  baseUrl = DEFAULT_BASE_URL,
  apiKey = null,
  pageLimit = DEFAULT_PAGE_LIMIT,
  concurrency = DEFAULT_CONCURRENCY,
  machineCodes = null,
  log = () => {},
} = {}) {
  const machines = await fetchMachines(baseUrl, { apiKey });
  const selected = machineCodes
    ? machines.filter((machine) => machineCodes.includes(machine.code))
    : machines;

  if (machineCodes) {
    const known = new Set(machines.map((machine) => machine.code));
    const unknown = machineCodes.filter((code) => !known.has(code));
    if (unknown.length > 0) {
      throw new Error(`unknown machine code(s): ${unknown.join(", ")}`);
    }
  }

  const reports = await mapWithConcurrency(
    selected,
    concurrency,
    async (machine) => {
      try {
        const nfts = await fetchAllNfts(baseUrl, machine.code, {
          apiKey,
          pageLimit,
        });
        const report = buildMachineReport(machine, nfts);
        log(
          `fetched ${machine.code}: ${report.fetchedCount} cards` +
            (report.fetchedCount === report.reportedStock
              ? ""
              : ` (stock endpoint reports ${report.reportedStock})`),
        );
        return report;
      } catch (error) {
        log(`failed ${machine.code}: ${error.message}`);
        return { code: machine.code, name: machine.name, error: error.message };
      }
    },
  );

  return sortReports(reports);
}

async function main() {
  const baseUrl = readOption("--base-url") ?? DEFAULT_BASE_URL;
  const apiKey =
    readOption("--api-key") ?? process.env.COLLECTORCRYPT_API_KEY ?? null;
  const pageLimit =
    parsePositiveInteger(readOption("--limit"), "--limit") ??
    DEFAULT_PAGE_LIMIT;
  const concurrency =
    parsePositiveInteger(readOption("--concurrency"), "--concurrency") ??
    DEFAULT_CONCURRENCY;
  const machineCodes = readOption("--machines")
    ?.split(",")
    .map((code) => code.trim())
    .filter(Boolean);
  const format = readOption("--format") ?? "table";
  const outPath = readOption("--out");

  if (format !== "table" && format !== "json") {
    throw new Error(`--format must be "table" or "json", got "${format}"`);
  }

  const reports = await collectTopCards({
    baseUrl,
    apiKey,
    pageLimit,
    concurrency,
    machineCodes: machineCodes?.length ? machineCodes : null,
    log: (message) => console.error(message),
  });

  const failures = reports.filter((report) => report.error);
  const payload = {
    source: baseUrl,
    retrievedAt: new Date().toISOString(),
    machineCount: reports.length,
    failureCount: failures.length,
    machines: reports,
  };

  if (outPath) {
    await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    console.error(`wrote ${reports.length} machine report(s) to ${outPath}`);
  }

  if (format === "json") {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatTable(reports));
  }

  if (failures.length > 0) {
    console.error(`${failures.length} machine(s) failed; see rows above.`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  main().catch((error) => {
    console.error("fetch-gacha-top-cards failed:", error.message);
    process.exit(2);
  });
}
