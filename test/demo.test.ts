import { test } from "node:test";
import assert from "node:assert/strict";
import { runDemo } from "../src/run.js";
import { client, stepUp, type Client } from "../src/oneclaw.js";

const ok = (data: unknown = {}) => ({ data, error: null, meta: { status: 200 } });
const fail = (status: number) => ({ data: null, error: { type: "t", message: "m", detail: "d" }, meta: { status } });

/** In-memory stand-in for 1Claw. `broken` overrides the answer for one "who op" call. */
function world(broken: Record<string, number> = {}) {
  const state = { writerActive: true, calls: [] as string[], lines: [] as string[] };
  const agent = (who: "reader" | "writer", fresh = false) => {
    const answer = (op: string, allowed: boolean) => {
      const key = `${who} ${op}${state.writerActive ? "" : " revoked"}`;
      state.calls.push(key);
      if (broken[key]) return fail(broken[key]);
      if (who === "writer" && !state.writerActive) {
        if (fresh) throw new Error("Agent token refresh failed: HTTP 401");
        return fail(401);
      }
      return allowed ? ok({ version: 1, value: "TOP-SECRET" }) : fail(403);
    };
    return {
      agents: { getSelf: async () => ok({ id: who }) },
      secrets: {
        get: async () => answer("get", who === "reader"),
        set: async () => answer("set", who === "writer"),
      },
    } as unknown as Client;
  };
  const human = {
    agents: { update: async (_id: string, u: { is_active: boolean }) => ((state.writerActive = u.is_active), ok()) },
    audit: { query: async () => ok({ events: [{ actor_id: "reader", resource_id: "x", action: "secret.read", timestamp: "2026-11-26T00:00:00Z" }] }) },
  } as unknown as Client;
  const run = (elevate: Parameters<typeof runDemo>[0]["elevate"] = (_action, change) => change(), lines = state.lines) => runDemo({
    human, reader: agent("reader"), writer: agent("writer"), freshWriter: () => agent("writer", true),
    vaultId: "v", elevate, log: (l) => lines.push(l),
  });
  return { state, run };
}

test("expected matrix, revocation, reader unaffected, writer restored, value never logged", async () => {
  const { state, run } = world();
  await run();
  assert.equal(state.writerActive, true);
  assert.ok(state.calls.includes("reader get revoked"));
  assert.match(state.lines.join("\n"), /2026-11-26T00:00:00Z\s+reader\s+secret\.read/);
  assert.doesNotMatch(state.lines.join("\n"), /TOP-SECRET/);
});

test("an outage is not counted as a denial", async () => {
  await assert.rejects(world({ "reader set": 500 }).run(), /failed \(500\)/);
});

test("a revoked agent that still writes fails the run and is restored", async () => {
  const { state, run } = world();
  const original = state.calls.push.bind(state.calls);
  state.calls.push = (key: string) => {
    if (key === "writer set revoked") state.writerActive = true; // revocation silently did nothing
    return original(key);
  };
  await assert.rejects(run(), /expected denied, got allowed/);
  assert.equal(state.writerActive, true);
});

test("an error after revocation still restores the writer", async () => {
  const { state, run } = world({ "reader get revoked": 500 });
  await assert.rejects(run(), /failed \(500\)/);
  assert.equal(state.writerActive, true);
});

test("402 stops at the first call", async () => {
  const { state, run } = world({ "reader get": 402 });
  await assert.rejects(run(), /do not retry/);
  assert.deepEqual(state.calls, ["reader get"]);
});

const detail = "This action requires re-authentication. Provide your account password, or a re-auth token";
const stepUpNeeded = { data: null, error: { type: "auth_error", message: detail }, meta: { status: 403 } };

// Real SDK, faked network: the error shape comes from the SDK, not from this test.
test("step-up: a code becomes a single-use token and the change is retried with it", async (t) => {
  const confirms: (string | null)[] = [];
  let code = "";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/v1/auth/api-key-token")) return Response.json({ access_token: "jwt" });
    if (url.endsWith("/v1/auth/reauth/complete")) {
      code = JSON.parse(String(init.body)).password;
      return Response.json({ reauth_token: "rat_test" });
    }
    const confirm = new Headers(init.headers).get("X-Auth-Confirm");
    confirms.push(confirm);
    return confirm ? Response.json({ id: "a" }) : Response.json({ detail }, { status: 403 });
  });
  const human = client("human-key");
  const res = await stepUp("human-key", "edit", (c) => human.agents.update("a", { is_active: true }, { confirm: c }), async () => " 123456 ");
  assert.equal(res.error, null);
  assert.deepEqual(confirms, [null, "rat_test"]);
  assert.equal(code, "123456");
});

test("step-up: gives up after three rejected codes", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ detail: "bad code" }, { status: 401 }));
  await assert.rejects(stepUp("key", "edit", async () => stepUpNeeded, async () => "000000"), /bad code/);
  assert.equal(fetch.mock.callCount(), 3);
});

test("step-up: an ordinary 403 never asks for a code", async () => {
  const res = await stepUp("key", "edit", async () => fail(403), async () => assert.fail("asked for a code"));
  assert.equal(res.meta?.status, 403);
});

test("a writer that cannot be reactivated fails the run with a warning", async () => {
  const lines: string[] = [];
  const w = world();
  await assert.rejects(w.run((action, change) => {
    if (action.startsWith("reactivate")) return Promise.reject(new Error("no terminal"));
    return change();
  }, lines), /could not reactivate/);
  assert.match(lines.join("\n"), /WARNING.*no terminal/);
});
