// Runs both agents against the same secret, revokes the writer, then restores it.
import { client, need, stepUp } from "./oneclaw.js";
import { runDemo } from "./run.js";

const writerKey = need("ONECLAW_WRITER_KEY", "ocv_");
const humanKey = need("ONECLAW_API_KEY", "1ck_");
await runDemo({
  human: client(humanKey), // revoking is a human action; agents cannot do it
  reader: client(need("ONECLAW_READER_KEY", "ocv_")),
  writer: client(writerKey),
  freshWriter: () => client(writerKey),
  vaultId: need("ONECLAW_VAULT_ID"),
  elevate: (action, change) => stepUp(humanKey, action, change),
  log: console.log,
});
