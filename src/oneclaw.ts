import { createInterface } from "node:readline/promises";
import { createClient, type OneclawResponse } from "@1claw/sdk";

export const SHARED = "two-keys/shared"; // the one secret both agents go after

export function need(name: string, prefix = ""): string {
  const value = process.env[name];
  if (!value || !value.startsWith(prefix)) throw new Error(`Set ${name}${prefix && ` (${prefix}...)`} in .env`);
  return value;
}

const API = "https://api.1claw.co";
export const client = (apiKey: string) => createClient({ baseUrl: API, apiKey });
export type Client = ReturnType<typeof client>;

export function must<T>(label: string, res: OneclawResponse<T>): T {
  if (res.error) {
    const hint = res.meta?.status === 402 ? " (quota or payment: stop, do not retry)" : "";
    throw new Error(`${label} failed (${res.meta?.status})${hint}: ${res.error.detail ?? res.error.message}`);
  }
  return res.data as T;
}

async function askTerminal(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("1Claw asked for an authenticator code: run this in an interactive terminal");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

/**
 * Makes a human change. If 1Claw answers "re-authenticate", trades a code from your authenticator
 * app for a single-use token and makes the change once more.
 */
export async function stepUp<T>(
  apiKey: string,
  action: string,
  change: (confirm?: string) => Promise<OneclawResponse<T>>,
  ask = askTerminal,
): Promise<OneclawResponse<T>> {
  const first = await change();
  // The SDK puts the server's text in `message` for a 403, and leaves `detail` empty.
  const why = first.error?.detail ?? first.error?.message;
  if (first.meta?.status !== 403 || !why?.includes("re-authentication")) return first;

  for (let attempt = 1; ; attempt++) {
    const code = (await ask(`6-digit authenticator code, to ${action}: `)).trim();
    const res = await fetch(`${API}/v1/auth/reauth/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      // For method "totp" the API takes the code in the `password` field.
      body: JSON.stringify({ method: "totp", purpose: "security.guardrail.edit", password: code }),
    });
    const body = (await res.json().catch(() => ({}))) as { reauth_token?: string; detail?: string };
    if (res.ok && body.reauth_token) return change(body.reauth_token);
    // Bounded: repeated failures can lock the account.
    if (attempt === 3 || ![400, 401, 403].includes(res.status)) throw new Error(`re-authentication failed (${res.status}): ${body.detail}`);
    console.log(`Rejected: ${body.detail}. Wait for a new code and try again.`);
  }
}
