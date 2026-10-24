/**
 * One-time interactive login. Run it on a machine that can reach Telegram:
 *   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... npm run telegram:login
 * Prints a session string. Put it in TELEGRAM_SESSION_STRING (.env / secret store). Never commit it.
 * Use a dedicated Telegram account that is a member of the channel.
 */
import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH ?? "";
if (!apiId || !apiHash) throw new Error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH first.");

const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
await client.start({
  phoneNumber: () => input.text("Phone number (+249...): "),
  password: () => input.text("2FA password (if any): "),
  phoneCode: () => input.text("Code sent by Telegram: "),
  onError: (e) => console.error(e),
});
console.log("\nTELEGRAM_SESSION_STRING=" + client.session.save());
await client.disconnect();
process.exit(0);
