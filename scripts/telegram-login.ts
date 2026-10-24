/**
 * One-time interactive login. Run it on a machine that can reach Telegram:
 *   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... npm run telegram:login
 * Prints a session string. Put it in TELEGRAM_SESSION_STRING (.env / secret store). Never commit it.
 * Use a dedicated Telegram account that is a member of the channel.
 */
import { createInterface } from "node:readline/promises";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => rl.question(q);

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH ?? "";
if (!apiId || !apiHash) throw new Error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH first.");

const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
await client.start({
  phoneNumber: () => ask("Phone number (+249...): "),
  password: () => ask("2FA password (if any): "),
  phoneCode: () => ask("Code sent by Telegram: "),
  onError: (e) => console.error(e),
});
console.log("\nTELEGRAM_SESSION_STRING=" + client.session.save());
await client.disconnect();
rl.close();
process.exit(0);
