import { expect, test } from "vitest";
import schema from "./schema";

test("every database index name satisfies the Convex server identifier limit", () => {
  // convex-test does not validate this server-side deployment constraint.
  // Use the SDK's typed index introspection API instead of private schema fields.
  const invalidNames: string[] = [];
  let indexCount = 0;
  for (const [tableName, table] of Object.entries(schema.tables)) {
    const indexes = table[" indexes"]();
    for (const { indexDescriptor } of indexes) {
      indexCount += 1;
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(indexDescriptor)) {
        invalidNames.push(`${tableName}.${indexDescriptor}`);
      }
    }
  }
  expect(indexCount).toBeGreaterThan(0);
  expect(invalidNames).toEqual([]);
});
