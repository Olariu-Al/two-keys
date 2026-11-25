// Human-run, safe to re-run. Your 1ck_ key stores one demo secret and gives each agent exactly
// one policy in a vault meant for this demo. The agent keys are only used to ask 1Claw "who am I?".
import { client, must, need, SHARED, stepUp } from "../src/oneclaw.js";

const humanKey = need("ONECLAW_API_KEY", "1ck_");
const human = client(humanKey);
const vaultId = need("ONECLAW_VAULT_ID");
const agents = [
  { keyVar: "ONECLAW_READER_KEY", permissions: ["read"] },
  { keyVar: "ONECLAW_WRITER_KEY", permissions: ["write"] },
];

// 1. Identify both agents and refuse to continue if either already has other access to this vault.
const grants = must("list policies", await human.access.listGrants(vaultId)).policies;
const EVERYTHING = "**"; // the whole vault, which holds only this demo's secret
const plan = [];
for (const a of agents) {
  const me = must(`identify ${a.keyVar}`, await client(need(a.keyVar, "ocv_")).agents.getSelf());
  const mine = grants.filter((p) => p.principal_id === me.id);
  const wanted = mine.filter(
    (p) => p.secret_path_pattern === EVERYTHING && (p.effect ?? "allow") === "allow" &&
      [...p.permissions].sort().join() === [...a.permissions].sort().join(),
  );
  const extra = mine.filter((p) => !wanted.includes(p));
  if (extra.length) {
    const list = extra.map((p) => `${p.id} (${p.secret_path_pattern}: ${p.permissions.join(",")})`).join("; ");
    throw new Error(`${me.name} has other policies in this vault. Delete them in the dashboard, then re-run: ${list}`);
  }
  plan.push({ ...a, id: me.id, name: me.name, granted: wanted.length > 0 });
}
if (plan[0].id === plan[1].id) throw new Error("Both keys belong to the same agent. Create two agents.");

// 2. The demo secret (harmless text). An existing one is left alone.
const existing = must("list secrets", await human.secrets.list(vaultId, "two-keys/")).secrets.map((s) => s.path);
if (!existing.includes(SHARED)) must(`store ${SHARED}`, await human.secrets.set(vaultId, SHARED, "demo value, not a real secret", { type: "note" }));

// 3. One policy per agent. Then pin the agent to this vault, shorten its tokens and switch off unused features.
for (const a of plan) {
  if (!a.granted) must(`grant ${a.name}`, await human.access.grantAgent(vaultId, a.id, a.permissions, { secretPathPattern: EVERYTHING }));
  const settings = { vault_ids: [vaultId], token_ttl_seconds: 300, intents_api_enabled: false, shroud_enabled: false };
  must(`configure ${a.name}`, await stepUp(humanKey, `configure ${a.name}`, (confirm) => human.agents.update(a.id, settings, { confirm })));
  console.log(`${a.name}: ${a.permissions.join(" + ")} only, on this vault`);
}
console.log("Done. Run: npm run demo");
