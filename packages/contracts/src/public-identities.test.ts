import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_PUBLIC_IDENTITY_NAMESPACE,
  packscoutPublicIdentityUuid,
  provisionalCollectiblePublicId,
  provisionalCollectiblePublicIdentityName,
} from "./public-identities.ts";

const providerId = "10000000-0000-4000-8000-000000000001";
const localCollectibleId = "20000000-0000-4000-8000-000000000001";

test("the public UUID namespace and provisional collectible golden identity stay frozen", () => {
  assert.equal(
    PACKSCOUT_PUBLIC_IDENTITY_NAMESPACE,
    "a35fca42-e6b2-54be-8425-c662e41b8543",
  );
  const name = provisionalCollectiblePublicIdentityName({
    providerId,
    localCollectibleId,
  });
  assert.equal(
    name,
    "provider:10000000-0000-4000-8000-000000000001:collectible:20000000-0000-4000-8000-000000000001",
  );
  assert.equal(
    provisionalCollectiblePublicId({ providerId, localCollectibleId }),
    "40a85f64-ad56-5575-b21b-8024ee216651",
  );
  assert.equal(
    packscoutPublicIdentityUuid(name),
    "40a85f64-ad56-5575-b21b-8024ee216651",
  );
});

test("provisional public IDs normalize UUID case before hashing", () => {
  assert.equal(
    provisionalCollectiblePublicId({
      providerId: providerId.toUpperCase(),
      localCollectibleId: localCollectibleId.toUpperCase(),
    }),
    provisionalCollectiblePublicId({ providerId, localCollectibleId }),
  );
});
