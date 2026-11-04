import type { AccountView } from "../../bridge/accounts.js";
import { esc } from "../ui.js";
import { bridgePage, HERE, LABEL } from "./shared.js";

type Flash = { text: string; err?: boolean };

const STATE: Record<AccountView["state"], [string, string]> = {
  connected: ["connected", "ok"],
  waiting_qr: ["waiting for scan", "warn"],
  connecting: ["connecting…", "warn"],
  login: ["needs login", "warn"],
  error: ["problem", "bad"],
  paused: ["paused", "off"],
};
const badge = (v: AccountView) =>
  `<span class="badge ${STATE[v.state][1]}">${STATE[v.state][0]}</span>`;

export interface MainAccounts {
  whatsapp: { present: boolean; connected: boolean };
  telegram: { present: boolean; connected: boolean };
}

export function accountsView(
  views: AccountView[],
  main: MainAccounts,
  telegramAvailable: boolean,
  flash?: Flash,
) {
  const mainRow = (name: string, m: { present: boolean; connected: boolean }, note: string) =>
    `<tr><td>${name}</td><td>${m.present ? `<span class="badge ${m.connected ? "ok" : "bad"}">${m.connected ? "connected" : "not connected"}</span>` : '<span class="badge off">not configured</span>'}</td><td class="muted">${note}</td></tr>`;
  const cards = views
    .map(
      (v) => `<div class="card rule"><div class="main">
<div><span class="badge">${LABEL[v.row.platform]}</span> ${badge(v)}</div>
<div class="route">${esc(v.row.label)}</div>
<div class="muted">${v.row.identity ? esc(v.row.identity) : "not logged in yet"}${v.error && v.state === "error" ? ` — <span class="bad">${esc(v.error)}</span>` : ""}</div></div>
<div class="acts"><a class="btn" href="${HERE}/accounts/${v.row.id}">${v.state === "connected" ? "Details" : "Log in / status"}</a>
<form class="inline" method="post" action="${HERE}/accounts/${v.row.id}/toggle"><button class="ghost">${v.row.enabled ? "Pause" : "Resume"}</button></form></div></div>`,
    )
    .join("");
  return bridgePage(
    "accounts",
    "Accounts",
    `<div class="card"><h2>Main accounts</h2><div class="scroll"><table>
${mainRow("WhatsApp", main.whatsapp, "The number linked to the library bot (set up on the admin link page).")}
${mainRow("Telegram", main.telegram, "Session from BRIDGE_TELEGRAM_SESSION_STRING.")}
</table></div><p class="muted">The main accounts are used by rules that were made before accounts existed. They are not changed here.</p></div>
<h2 style="margin:1rem 0 .6rem">Extra accounts</h2>
${cards || '<div class="card empty">No extra accounts yet.</div>'}
<div class="row">
<form class="card" method="post" action="${HERE}/accounts/add-whatsapp"><h2>+ WhatsApp account</h2><p class="muted">Link another WhatsApp number as a linked device (QR or pairing code).</p><p><input name="label" placeholder="Name, e.g. Biology batch" maxlength="40"></p><p><button>Add WhatsApp</button></p></form>
<form class="card" method="post" action="${HERE}/accounts/add-telegram"><h2>+ Telegram account</h2>${telegramAvailable ? '<p class="muted">Log in with the phone number and the code Telegram sends.</p>' : '<p class="bad">TELEGRAM_API_ID / TELEGRAM_API_HASH are not set, so Telegram accounts cannot be added.</p>'}<p><input name="label" placeholder="Name, e.g. Study channels" maxlength="40"${telegramAvailable ? "" : " disabled"}></p><p><button${telegramAvailable ? "" : " disabled"}>Add Telegram</button></p></form>
</div>
<div class="card muted">Every account is a separate connection and uses some memory (roughly 40–80 MB for a WhatsApp account). Use one number per account: linking the same number twice disconnects both. Sessions are stored in the database — Telegram ones encrypted.</div>`,
    flash,
  );
}

export function accountView(
  v: AccountView,
  qrSvg: string | undefined,
  rulesUsing: number,
  flash?: Flash,
) {
  const { row } = v;
  const wa = row.platform === "whatsapp";
  let login = "";
  let refresh: number | undefined;
  if (v.state === "connected") {
    login = `<p class="ok">✔ Logged in${row.identity ? ` as <b>${esc(row.identity)}</b>` : ""}. Its chats appear in the Chats tab and in the rule builder.</p>`;
  } else if (v.state === "paused") {
    login = '<p class="muted">Paused — press Resume to connect again.</p>';
  } else if (v.state === "error") {
    login = `<p class="bad">${esc(v.error ?? "Something went wrong.")}</p>`;
    if (!wa) login += tgPhoneForm(row.id);
  } else if (wa) {
    refresh = 6;
    login = `${v.detail ? `<p class="warn">${esc(v.detail)}</p>` : ""}${
      qrSvg
        ? `<div style="max-width:280px;background:#fff;padding:.5rem;border-radius:8px">${qrSvg}</div><p>On the phone: WhatsApp → Linked devices → Link a device → scan this code. The page refreshes by itself.</p>`
        : "<p>Preparing the QR code… the page refreshes by itself.</p>"
    }
<details class="card"><summary>Or link with a phone number instead</summary>
<form method="post" action="${HERE}/accounts/${row.id}/pair"><p><input name="phone" placeholder="Phone number with country code, digits only" inputmode="numeric"></p><p><button>Get pairing code</button></p></form>
<p class="muted">Then on the phone: Linked devices → Link a device → Link with phone number instead → type the code.</p></details>`;
  } else {
    const step = v.tgStep ?? "phone";
    if (step === "phone") login = tgPhoneForm(row.id);
    else if (step === "code") {
      login = `<form method="post" action="${HERE}/accounts/${row.id}/tg-code"><p>Telegram sent a login code ${v.viaApp ? "to the Telegram app of that account" : "by SMS"}.</p><p><input name="value" placeholder="Code" inputmode="numeric" autocomplete="one-time-code" required></p><p><button>Confirm code</button></p></form>`;
    } else if (step === "password") {
      login = `<form method="post" action="${HERE}/accounts/${row.id}/tg-code"><p>This account has two-step verification. Enter its password.</p><p><input type="password" name="value" placeholder="2FA password" required></p><p><button>Log in</button></p></form>`;
    } else if (step === "failed") {
      login = `<p class="bad">Login failed: ${esc(v.error ?? "unknown error")}</p>${tgPhoneForm(row.id)}`;
    } else {
      refresh = 3;
      login = "<p>Working… the page refreshes by itself.</p>";
    }
    if (v.error && step !== "failed" && step !== "connecting")
      login = `<p class="bad">${esc(v.error)}</p>${login}`;
    login += `<details class="card"><summary>Advanced: paste a session string</summary>
<form method="post" action="${HERE}/accounts/${row.id}/tg-session"><p><input name="value" placeholder="Session string from npm run telegram:login" autocomplete="off"></p><p><button class="ghost">Use this session</button></p></form></details>`;
  }
  return bridgePage(
    "accounts",
    row.label,
    `<div class="card"><div class="rule"><div class="main"><div><span class="badge">${LABEL[row.platform]}</span> ${badge(v)}</div><h2 style="margin:.4rem 0">${esc(row.label)}</h2>
<div class="muted">${row.identity ? esc(row.identity) : "not logged in yet"} • used by ${rulesUsing} rule(s)</div></div>
<div class="acts"><form class="inline" method="post" action="${HERE}/accounts/${row.id}/toggle"><button class="ghost sm">${row.enabled ? "Pause" : "Resume"}</button></form>
<a class="btn danger sm" href="${HERE}/accounts/${row.id}/confirm">Remove</a></div></div></div>
<div class="card"><h2>Login</h2>${login}</div>
<details class="card"><summary>Rename</summary><form method="post" action="${HERE}/accounts/${row.id}/rename" class="row"><input name="label" value="${esc(row.label)}" maxlength="40"><button>Save</button></form></details>
<p><a href="${HERE}/accounts">‹ all accounts</a></p>`,
    flash,
    { refresh },
  );
}

const tgPhoneForm = (id: number) =>
  `<form method="post" action="${HERE}/accounts/${id}/tg-phone"><p><input name="phone" placeholder="Phone number with country code, e.g. +249…" inputmode="tel" required></p><p><button>Send login code</button></p></form>`;

export function accountConfirmView(v: AccountView, rulesUsing: number) {
  return bridgePage(
    "accounts",
    "Confirm",
    `<div class="card"><h2>Remove “${esc(v.row.label)}”</h2>
<p>The login is forgotten${v.row.platform === "whatsapp" ? " (also remove the linked device on the phone: Linked devices)" : ""}. ${rulesUsing ? `<b>${rulesUsing} rule(s)</b> use this account; they are paused, not deleted.` : "No rule uses it."}</p>
<form method="post" action="${HERE}/accounts/${v.row.id}/remove"><button class="danger">Yes, remove</button> <a class="btn ghost" href="${HERE}/accounts/${v.row.id}">Cancel</a></form></div>`,
  );
}
