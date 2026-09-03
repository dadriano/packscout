import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "../prisma/generated/provider/index.js";
import { providerBatchRecordConstraint } from "./provider-canonical-batch-constraint.ts";

test("chunk fallback recognizes only trusted Prisma raw-query record-constraint SQLSTATEs", () => {
  const error = (code: string, sqlstate: string) => new Prisma.PrismaClientKnownRequestError("Synthetic private details", {
    code, clientVersion: "6.19.3", meta: { code: sqlstate },
  });
  for (const state of ["23502", "23503", "23505", "23514", "22001", "22003", "22P02"]) assert.equal(providerBatchRecordConstraint(error("P2010", state)), true);
  for (const state of ["P0001", "40001", "40P01", "57014", "08006", "23514 trailing"]) assert.equal(providerBatchRecordConstraint(error("P2010", state)), false);
  assert.equal(providerBatchRecordConstraint(error("P2028", "23514")), false);
  assert.equal(providerBatchRecordConstraint({ code: "P2010", meta: { code: "23514" } }), false);
  assert.equal(providerBatchRecordConstraint(null), false);
  const inherited = error("P2010", "23514"); inherited.meta = Object.create({ code: "23514" });
  assert.equal(providerBatchRecordConstraint(inherited), false);
  const accessor = error("P2010", "23514");
  Object.defineProperty(accessor, "meta", { get() { throw new Error("Must not evaluate private metadata accessors"); } });
  assert.equal(providerBatchRecordConstraint(accessor), false);
});
