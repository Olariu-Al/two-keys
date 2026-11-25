import type { OneclawResponse } from "@1claw/sdk";
import { type Client, must, SHARED, type stepUp } from "./oneclaw.js";

type Verdict = "allowed" | "denied";

/** Only 401/403 count as "denied". Any other failure stops the run, so an outage never looks like a policy. */
export async function attempt(call: () => Promise<OneclawResponse<unknown>>) {
  let res: OneclawResponse<unknown>;
  try {
    res = await call();
  } catch (err) {
    // The SDK throws, instead of returning an envelope, when the key-to-token exchange is refused.
    const refused = /Agent token refresh failed: HTTP (401|403)/.exec(String(err));
    if (!refused) throw err;
    return { verdict: "denied" as Verdict, note: `${refused[1]} no token issued` };
  }
  const status = res.meta?.status;
  if (res.error && status !== 401 && status !== 403) must("request", res);
  if (res.error) return { verdict: "denied" as Verdict, note: `${status} ${res.error.detail ?? res.error.message}` };
  const version = (res.data as { version?: number } | null)?.version;
  return { verdict: "allowed" as Verdict, note: version ? `version ${version}` : "" }; // never the value
}

export async function runDemo(deps: {
  human: Client;
  reader: Client;
  writer: Client;
  freshWriter: () => Client;
  vaultId: string;
  elevate: (action: string, change: Parameters<typeof stepUp>[2]) => ReturnType<typeof stepUp>;
  log: (line: string) => void;
}) {
  const { human, reader, writer, vaultId, elevate, log } = deps;
  const readerId = must("identify reader", await reader.agents.getSelf()).id;
  const writerId = must("identify writer", await writer.agents.getSelf()).id;

  const read = (c: Client) => () => c.secrets.get(vaultId, SHARED);
  const write = (c: Client) => () => c.secrets.set(vaultId, SHARED, `written by the writer at ${new Date().toISOString()}`, { type: "note" });
  const check = async (who: string, what: string, expected: Verdict, call: () => Promise<OneclawResponse<unknown>>) => {
    const { verdict, note } = await attempt(call);
    log(`  ${who.padEnd(7)} ${what.padEnd(24)} ${verdict.padEnd(8)} ${note}`);
    if (verdict !== expected) throw new Error(`${who} ${what}: expected ${expected}, got ${verdict}`);
  };

  log("\n1. Same secret, two policies");
  await check("reader", `read  ${SHARED}`, "allowed", read(reader));
  await check("reader", `write ${SHARED}`, "denied", write(reader));
  await check("writer", `read  ${SHARED}`, "denied", read(writer));
  await check("writer", `write ${SHARED}`, "allowed", write(writer));
  await check("reader", `read  ${SHARED}`, "allowed", read(reader)); // sees the writer's new version

  const setActive = (action: string, is_active: boolean) =>
    elevate(action, (confirm) => human.agents.update(writerId, { is_active }, { confirm }));

  log("\n2. Revoke the writer");
  let restored = false;
  try {
    must("deactivate writer", await setActive("revoke the writer", false));
    await check("writer", "write with cached token", "denied", write(writer));
    await check("writer", "write with new token", "denied", write(deps.freshWriter()));
    log("\n3. The reader is unaffected");
    await check("reader", `read  ${SHARED}`, "allowed", read(reader));
  } finally {
    // A failed code prompt must not hide the warning below, or the error that brought us here.
    const res = await setActive("reactivate the writer", true).catch((err) => ({ error: { message: String(err), detail: undefined } }));
    restored = !res.error;
    log(restored
      ? "\nWriter reactivated."
      : `\nWARNING: the writer may still be deactivated (${res.error?.detail ?? res.error?.message}). Reactivate agent ${writerId} in the dashboard.`);
  }
  if (!restored) throw new Error("could not reactivate the writer");

  log("\n4. Audit trail (newest first)");
  const names: Record<string, string> = { [readerId]: "reader", [writerId]: "writer" };
  const { events } = must("query audit log", await human.audit.query({ limit: 50 }));
  for (const e of events.filter((e) => names[e.actor_id] || names[e.resource_id]).slice(0, 12)) {
    const about = names[e.resource_id] ? ` on ${names[e.resource_id]}` : "";
    // The live API sends `timestamp`; the SDK type and OpenAPI spec say `created_at`.
    const when = (e as { timestamp?: string }).timestamp ?? e.created_at;
    log(`  ${when}  ${(names[e.actor_id] ?? e.actor_type).padEnd(7)} ${e.action}${about}`);
  }
}
