import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWN_MESSAGE_KINDS,
  messageKindLabel,
} from "./message-delivery-copy.ts";

test("direct operator account notices have a friendly delivery label", () => {
  assert.equal(
    messageKindLabel("operator_account_created"),
    "Operator account created",
  );
  assert.deepEqual(
    KNOWN_MESSAGE_KINDS.find(
      ({ kind }) => kind === "operator_account_created",
    ),
    {
      kind: "operator_account_created",
      label: "Operator account created",
    },
  );
});

test("unknown catalogue kinds remain visible by their stable identifier", () => {
  assert.equal(messageKindLabel("future_transactional_kind"), "future_transactional_kind");
});
