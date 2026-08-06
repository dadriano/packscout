import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildMachineReport,
  collectTopCards,
  fetchAllNfts,
  formatTable,
  parsePositiveInteger,
  sortReports,
  topCardFrom,
} from "./fetch-gacha-top-cards.mjs";

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fetch-gacha-top-cards.mjs",
);

function card(name, insuredValue, rarity = "epic") {
  return {
    nft_address: `addr-${name}`,
    name,
    description: `${name} description`,
    rarity,
    insured_value: insuredValue,
    image: `https://example.test/${name}.png`,
  };
}

const fixtureMachines = [
  {
    code: "alpha_50",
    name: "Alpha Pack",
    price: 50,
    public: true,
    stock: { common: 2, uncommon: 0, rare: 0, epic: 1 },
  },
  {
    code: "beta_250",
    name: "Beta Pack",
    price: 250,
    public: false,
    stock: { common: 0, uncommon: 0, rare: 0, epic: 0 },
  },
];

const fixtureNfts = {
  alpha_50: [card("Common A", 40, "common"), card("Common B", 55, "common"), card("Epic A", 900)],
  beta_250: [],
};

function startMockApi(t, { pageSize = 2 } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api/machines") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ machines: fixtureMachines }));
      return;
    }
    if (url.pathname === "/api/getNfts") {
      const code = url.searchParams.get("code");
      const page = Number(url.searchParams.get("page") ?? "1");
      const limit = Math.min(
        Number(url.searchParams.get("limit") ?? "500"),
        pageSize,
      );
      const all = fixtureNfts[code] ?? [];
      const start = (page - 1) * limit;
      const nfts = all.slice(start, start + limit);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ nfts, hasMore: start + limit < all.length, page, limit }),
      );
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => server.close());
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function runScript(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      encoding: "utf8",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("parsePositiveInteger accepts positive integers and rejects the rest", () => {
  assert.equal(parsePositiveInteger(null, "--limit"), null);
  assert.equal(parsePositiveInteger("25", "--limit"), 25);
  for (const invalid of ["0", "-3", "1.5", "abc"]) {
    assert.throws(() => parsePositiveInteger(invalid, "--limit"), /--limit/);
  }
});

test("topCardFrom picks the highest insured value and skips valueless cards", () => {
  const top = topCardFrom([
    card("Low", 10),
    { name: "No value", rarity: "epic" },
    card("High", 5000),
    card("Mid", 300),
  ]);
  assert.equal(top.name, "High");
  assert.equal(top.insuredValue, 5000);
  assert.equal(top.nftAddress, "addr-High");
});

test("topCardFrom returns null for an empty machine", () => {
  assert.equal(topCardFrom([]), null);
});

test("buildMachineReport totals stock and counts cards without values", () => {
  const report = buildMachineReport(fixtureMachines[0], [
    card("Epic A", 900),
    { name: "broken card" },
  ]);
  assert.equal(report.reportedStock, 3);
  assert.equal(report.fetchedCount, 2);
  assert.equal(report.missingValueCount, 1);
  assert.equal(report.topCard.name, "Epic A");
});

test("sortReports orders by top card value with empty machines last", () => {
  const sorted = sortReports([
    { code: "empty", topCard: null },
    { code: "big", topCard: { insuredValue: 900 } },
    { code: "small", topCard: { insuredValue: 55 } },
  ]);
  assert.deepEqual(
    sorted.map((report) => report.code),
    ["big", "small", "empty"],
  );
});

test("formatTable renders values, empty machines, and failures", () => {
  const table = formatTable([
    {
      code: "alpha_50",
      price: 50,
      topCard: { insuredValue: 900, rarity: "epic", description: "Epic A description" },
    },
    { code: "beta_250", price: 250, topCard: null },
    { code: "gamma_100", error: "HTTP 500" },
  ]);
  assert.match(table, /alpha_50 \| \$50 \| \$900 \| epic \| Epic A description/);
  assert.match(table, /beta_250 \| \$250 \| \(empty\)/);
  assert.match(table, /gamma_100 \| - \| ERROR \| - \| HTTP 500/);
});

test("fetchAllNfts follows pagination until hasMore is false", async (t) => {
  const baseUrl = await startMockApi(t, { pageSize: 2 });
  const nfts = await fetchAllNfts(baseUrl, "alpha_50", { pageLimit: 2 });
  assert.equal(nfts.length, 3);
  assert.deepEqual(
    nfts.map((nft) => nft.name),
    ["Common A", "Common B", "Epic A"],
  );
});

test("collectTopCards reports every machine and filters by code", async (t) => {
  const baseUrl = await startMockApi(t);
  const reports = await collectTopCards({ baseUrl, pageLimit: 2 });
  assert.deepEqual(
    reports.map((report) => report.code),
    ["alpha_50", "beta_250"],
  );
  assert.equal(reports[0].topCard.insuredValue, 900);
  assert.equal(reports[1].topCard, null);

  const filtered = await collectTopCards({
    baseUrl,
    machineCodes: ["beta_250"],
  });
  assert.deepEqual(
    filtered.map((report) => report.code),
    ["beta_250"],
  );

  await assert.rejects(
    () => collectTopCards({ baseUrl, machineCodes: ["missing_1"] }),
    /unknown machine code\(s\): missing_1/,
  );
});

test("CLI emits JSON with machine reports against a mock API", async (t) => {
  const baseUrl = await startMockApi(t);
  const result = await runScript([
    "--base-url",
    baseUrl,
    "--format",
    "json",
    "--limit",
    "2",
  ]);
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.machineCount, 2);
  assert.equal(payload.failureCount, 0);
  assert.equal(payload.machines[0].code, "alpha_50");
  assert.equal(payload.machines[0].topCard.insuredValue, 900);
  assert.equal(payload.machines[1].topCard, null);
});

test("CLI rejects an unknown --format", async () => {
  const result = await runScript(["--format", "xml"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--format must be "table" or "json"/);
});
