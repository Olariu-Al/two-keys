// Opt-in, read-only call against the live API: npm run smoke
import { test } from "node:test";
import assert from "node:assert/strict";
import { attempt } from "../src/run.js";
import { client, need, SHARED } from "../src/oneclaw.js";

test("live: the reader can read the shared secret", { skip: process.env.ONECLAW_SMOKE !== "1" }, async () => {
  const reader = client(need("ONECLAW_READER_KEY", "ocv_"));
  const result = await attempt(() => reader.secrets.get(need("ONECLAW_VAULT_ID"), SHARED));
  assert.equal(result.verdict, "allowed", result.note);
});
