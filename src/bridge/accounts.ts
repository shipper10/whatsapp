import type { WAMessage } from "@whiskeysockets/baileys";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import type { Db } from "../db/client.js";
import { useDbAuthState } from "../providers/whatsapp/baileys/authState.js";
import type { BaileysProvider, LinkStatus } from "../providers/whatsapp/baileys/provider.js";
import { BaileysProvider as Baileys } from "../providers/whatsapp/baileys/provider.js";
import { type AccountRow, AccountStore } from "./accountStore.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { type BridgeService, endpointKey } from "./service.js";
import type { BridgeStore } from "./store.js";
import { TelegramBridgeEndpoint } from "./telegramEndpoint.js";
import type { BridgeEndpoint, BridgeMessage, BridgeReaction, Platform } from "./types.js";
import { WhatsAppBridgeEndpoint } from "./whatsappEndpoint.js";

interface Logger {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}

/** What an endpoint reports to the service; the manager stamps the account id on everything. */
export interface AccountHooks {
  onMessage: (m: BridgeMessage) => Promise<void>;
  onEdit: (m: BridgeMessage, editKey: string) => Promise<void>;
  onDelete: (chatId: string | undefined, messageId: string) => Promise<void>;
  onReaction: (r: BridgeReaction) => Promise<void>;
  onUnrecognised: (chat: string, kinds: string[]) => void;
  onError: (err: unknown) => void;
}

export interface WaRuntime {
  endpoint: BridgeEndpoint;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): LinkStatus;
  pairingCode(phone: string): Promise<string>;
  /** Forget the linked device's keys. */
  clearAuth(): Promise<void>;
}
export interface TgRuntime {
  endpoint: BridgeEndpoint;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export interface TgLoginClient {
  start(p: {
    phoneNumber: () => Promise<string>;
    phoneCode: (viaApp?: boolean) => Promise<string>;
    password: () => Promise<string>;
    onError: (e: Error) => Promise<boolean> | void;
  }): Promise<void>;
  session(): string;
  who(): Promise<string>;
  disconnect(): Promise<void>;
}

export interface AccountFactories {
  whatsapp(id: number, hooks: AccountHooks): WaRuntime;
  telegram(session: string, hooks: AccountHooks): TgRuntime;
  telegramLogin(): TgLoginClient;
}

export function defaultFactories(o: {
  db: Db;
  logger: Logger;
  baileysLogger: unknown;
  apiId: number;
  apiHash: string;
}): AccountFactories {
  return {
    whatsapp(id, hooks) {
      const namespace = `bridge-wa-${id}`;
      let ep: WhatsAppBridgeEndpoint | undefined;
      const provider: BaileysProvider = new Baileys({
        db: o.db,
        logger: o.logger,
        baileysLogger: o.baileysLogger,
        namespace,
        // An extra account only feeds the bridge: the library bot never sees its messages.
        onMessage: async () => undefined,
        onRawMessage: (m: WAMessage) => ep?.tap(m),
        onRawUpdate: (u) => ep?.tapUpdate(u),
        onRawReaction: (l) => ep?.tapReaction(l),
        minSendGapMs: async () => 1500,
      });
      ep = new WhatsAppBridgeEndpoint(
        provider,
        hooks.onMessage,
        hooks.onError,
        hooks.onUnrecognised,
        {
          onEdit: hooks.onEdit,
          onDelete: hooks.onDelete,
          onReaction: hooks.onReaction,
        },
      );
      return {
        endpoint: ep,
        start: () => provider.start(),
        stop: () => provider.stop(),
        status: () => provider.status(),
        pairingCode: (phone) => provider.requestPairingCode(phone),
        clearAuth: async () => (await useDbAuthState(o.db, namespace)).clear(),
      };
    },
    telegram(session, hooks) {
      const ep = new TelegramBridgeEndpoint(
        { apiId: o.apiId, apiHash: o.apiHash, sessionString: session },
        o.logger,
        hooks.onMessage,
        { onEdit: hooks.onEdit, onDelete: hooks.onDelete, onReaction: hooks.onReaction },
      );
      return { endpoint: ep, start: () => ep.start(), stop: () => ep.stop() };
    },
    telegramLogin() {
      const client = new TelegramClient(new StringSession(""), o.apiId, o.apiHash, {
        connectionRetries: 3,
      });
      return {
        start: (p) => client.start(p),
        session: () => String(client.session.save()),
        who: async () => {
          const me = (await client.getMe()) as { phone?: string; username?: string };
          return me.username ? `@${me.username}` : me.phone ? `+${me.phone}` : "";
        },
        disconnect: async () => {
          await client.disconnect().catch(() => undefined);
        },
      };
    },
  };
}

type TgStep = "connecting" | "code" | "password" | "failed";
interface TgFlow {
  step: TgStep;
  error?: string;
  viaApp?: boolean;
  client: TgLoginClient;
  answer?: (v: string) => void;
  timer: NodeJS.Timeout;
}

interface Running {
  platform: Platform;
  wa?: WaRuntime;
  tg?: TgRuntime;
  error?: string;
}

export interface AccountView {
  row: AccountRow;
  /** One of: connected, waiting_qr, connecting, login, error, paused. */
  state: "connected" | "waiting_qr" | "connecting" | "login" | "error" | "paused";
  detail?: string;
  qr?: string;
  tgStep?: TgStep | "phone";
  viaApp?: boolean;
  error?: string;
}

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

/**
 * Extra accounts of either platform, linked and controlled from the dashboard. Each account is its own connection
 * and its own endpoint in the bridge; the library bot's WhatsApp and the env Telegram session are untouched ("main").
 */
export class AccountManager {
  private readonly running = new Map<number, Running>();
  private readonly flows = new Map<number, TgFlow>();
  readonly accounts: AccountStore;

  constructor(
    private readonly deps: {
      db: Db;
      bridgeStore: BridgeStore;
      svc: BridgeService;
      endpoints: Record<string, BridgeEndpoint | undefined>;
      logger: Logger;
      factories: AccountFactories;
      /** Key for the stored Telegram sessions. */
      secret: string;
      /** False when TELEGRAM_API_ID / HASH are missing: Telegram accounts cannot be added. */
      telegramAvailable: boolean;
      /** Phone digits of the main WhatsApp account, to refuse linking the same number twice. */
      mainWhatsAppPhone?: () => string | undefined;
    },
  ) {
    this.accounts = new AccountStore(deps.db);
  }

  get telegramAvailable() {
    return this.deps.telegramAvailable;
  }

  private hooks(id: number, platform: Platform): AccountHooks {
    const { svc, logger } = this.deps;
    return {
      onMessage: (m) => svc.handle({ ...m, accountId: id }),
      onEdit: (m, key) => svc.handleEdit({ ...m, accountId: id }, key),
      onDelete: (chat, mid) => svc.handleDelete(platform, chat, mid, id),
      onReaction: (r) => svc.handleReaction({ ...r, accountId: id }),
      onUnrecognised: (chat, kinds) =>
        void svc.noteUnrecognised(platform, chat, kinds).catch(() => undefined),
      onError: (err) =>
        logger.error({ err: String(err), account: id }, "bridge: account message failed"),
    };
  }

  /** Starts every enabled account. Failures are kept per account; nothing here can stop the rest of the app. */
  async startAll() {
    for (const row of await this.accounts.list()) if (row.enabled) await this.launch(row);
  }

  async stopAll() {
    for (const f of this.flows.values()) clearTimeout(f.timer);
    for (const [id, r] of this.running) await this.halt(id, r);
  }

  private async halt(id: number, r: Running) {
    delete this.deps.endpoints[endpointKey(r.platform, id)];
    await r.wa?.stop().catch(() => undefined);
    await r.tg?.stop().catch(() => undefined);
    this.running.delete(id);
  }

  /** (Re)starts one account. Never throws. */
  private async launch(row: AccountRow) {
    const old = this.running.get(row.id);
    if (old) await this.halt(row.id, old);
    const run: Running = { platform: row.platform };
    this.running.set(row.id, run);
    try {
      if (row.platform === "whatsapp") {
        run.wa = this.deps.factories.whatsapp(row.id, this.hooks(row.id, "whatsapp"));
        this.deps.endpoints[endpointKey("whatsapp", row.id)] = run.wa.endpoint;
        await run.wa.start();
      } else {
        if (!row.session) return; // waiting for the login to finish
        const plain = decryptSecret(row.session, this.deps.secret);
        if (!plain) {
          run.error =
            "The saved session cannot be decrypted (BRIDGE_SECRET / ADMIN_HTTP_TOKEN changed?). Log in again.";
          return;
        }
        run.tg = this.deps.factories.telegram(plain, this.hooks(row.id, "telegram"));
        await run.tg.start();
        this.deps.endpoints[endpointKey("telegram", row.id)] = run.tg.endpoint;
        void this.deps.svc.refreshAccount("telegram", row.id).catch(() => undefined);
      }
    } catch (err) {
      run.error = msg(err);
      delete this.deps.endpoints[endpointKey(row.platform, row.id)];
      this.deps.logger.warn(
        { err: String(err), account: row.id },
        "bridge: account failed to start",
      );
    }
  }

  // ---- adding and removing

  async create(platform: Platform, label: string): Promise<number> {
    const name =
      label.trim().slice(0, 40) ||
      (platform === "whatsapp" ? "WhatsApp account" : "Telegram account");
    const id = await this.accounts.add(platform, name);
    const row = (await this.accounts.get(id)) as AccountRow;
    if (platform === "whatsapp") await this.launch(row);
    return id;
  }

  /** Returns how many rules were paused because they used the account. */
  async remove(id: number): Promise<number> {
    const row = await this.accounts.get(id);
    if (!row) return 0;
    const flow = this.flows.get(id);
    if (flow) this.cancelFlow(id);
    const r = this.running.get(id);
    const wa = r?.wa;
    if (r) await this.halt(id, r);
    if (row.platform === "whatsapp") {
      // Keys of the linked device go with the account (the phone still lists the device until it is removed there).
      const rt = wa ?? this.deps.factories.whatsapp(id, this.hooks(id, "whatsapp"));
      await rt.clearAuth().catch(() => undefined);
    }
    const paused = await this.deps.bridgeStore.forgetAccount(row.platform, id);
    await this.accounts.remove(id);
    return paused;
  }

  async setEnabled(id: number, enabled: boolean) {
    const row = await this.accounts.get(id);
    if (!row) return;
    await this.accounts.setEnabled(id, enabled);
    const r = this.running.get(id);
    if (!enabled) {
      if (r) await this.halt(id, r);
      return;
    }
    await this.launch({ ...row, enabled });
  }

  async rename(id: number, label: string) {
    const name = label.trim().slice(0, 40);
    if (name) await this.accounts.rename(id, name);
  }

  // ---- WhatsApp linking

  async pairingCode(id: number, phone: string): Promise<string> {
    const wa = this.running.get(id)?.wa;
    if (!wa) throw new Error("This account is not running");
    return wa.pairingCode(phone);
  }

  /** Called when the page is viewed: remember who is logged in and refuse a number that is already linked. */
  private async checkIdentity(row: AccountRow, run: Running) {
    if (!run.wa) return;
    const st = run.wa.status();
    if (st.state !== "open" || !st.me) return;
    const phone = st.me.split(":")[0]?.split("@")[0] ?? "";
    if (!phone) return;
    const others = (await this.accounts.list()).filter(
      (a) => a.id !== row.id && a.platform === "whatsapp",
    );
    const main = this.deps.mainWhatsAppPhone?.();
    const clash =
      main === phone
        ? "the main account (library bot)"
        : others.find((a) => a.identity === `+${phone}`)?.label;
    if (clash) {
      // The same number on two connections kicks both off. Keep the first, stop this one.
      run.error = `This number (+${phone}) is already linked as ${clash}. Remove this account and use another number.`;
      await this.halt(row.id, run);
      this.running.set(row.id, run);
      await run.wa.clearAuth().catch(() => undefined);
      return;
    }
    if (row.identity !== `+${phone}`) {
      await this.accounts.setIdentity(row.id, `+${phone}`);
      // Just linked: fill its chat list so it can be used in rules right away.
      void this.deps.svc.refreshAccount("whatsapp", row.id).catch(() => undefined);
    }
  }

  // ---- Telegram linking (driven from the web page, step by step)

  async telegramBegin(id: number, phone: string) {
    if (!this.deps.telegramAvailable)
      throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH are not set");
    const row = await this.accounts.get(id);
    if (!row || row.platform !== "telegram") throw new Error("not a Telegram account");
    if (this.flows.has(id)) this.cancelFlow(id);
    const client = this.deps.factories.telegramLogin();
    const flow: TgFlow = {
      step: "connecting",
      client,
      timer: setTimeout(() => this.cancelFlow(id), LOGIN_TIMEOUT_MS),
    };
    flow.timer.unref?.();
    this.flows.set(id, flow);
    const ask = (step: TgStep) =>
      new Promise<string>((resolve) => {
        flow.step = step;
        flow.answer = resolve;
      });
    void client
      .start({
        phoneNumber: async () => phone,
        phoneCode: (viaApp) => {
          flow.viaApp = viaApp;
          return ask("code");
        },
        password: () => ask("password"),
        onError: async (e) => {
          flow.error = msg(e);
          // A problem before the code step (bad number, flood) cannot be fixed by retrying here.
          return flow.step === "connecting";
        },
      })
      .then(async () => {
        const session = client.session();
        const who = await client.who().catch(() => "");
        await this.accounts.setSession(id, encryptSecret(session, this.deps.secret));
        if (who) await this.accounts.setIdentity(id, who);
        await client.disconnect();
        clearTimeout(flow.timer);
        this.flows.delete(id);
        const fresh = await this.accounts.get(id);
        if (fresh) await this.launch(fresh);
      })
      .catch(async (e) => {
        flow.step = "failed";
        flow.error = flow.error ?? msg(e);
        await client.disconnect().catch(() => undefined);
      });
  }

  /** The user typed the code or the 2FA password. */
  telegramAnswer(id: number, value: string): boolean {
    const f = this.flows.get(id);
    if (!f?.answer) return false;
    const answer = f.answer;
    f.answer = undefined;
    f.error = undefined;
    f.step = "connecting";
    answer(value.trim());
    return true;
  }

  /** Alternative to the phone login: a session string made with `npm run telegram:login`. */
  async telegramImport(id: number, session: string) {
    const row = await this.accounts.get(id);
    if (!row || row.platform !== "telegram") throw new Error("not a Telegram account");
    const clean = session.trim();
    if (clean.length < 20) throw new Error("That does not look like a session string");
    await this.accounts.setSession(id, encryptSecret(clean, this.deps.secret));
    if (!row.identity) await this.accounts.setIdentity(id, "session imported");
    await this.launch({ ...row, session: encryptSecret(clean, this.deps.secret) });
    const err = this.running.get(id)?.error;
    if (err) {
      await this.accounts.setSession(id, null);
      throw new Error(err);
    }
  }

  private cancelFlow(id: number) {
    const f = this.flows.get(id);
    if (!f) return;
    clearTimeout(f.timer);
    void f.client.disconnect();
    this.flows.delete(id);
  }

  // ---- what the Accounts page shows

  async views(): Promise<AccountView[]> {
    const out: AccountView[] = [];
    for (const row of await this.accounts.list()) {
      const run = this.running.get(row.id);
      if (run) await this.checkIdentity(row, run);
      out.push(await this.viewOf((await this.accounts.get(row.id)) ?? row));
    }
    return out;
  }

  async view(id: number): Promise<AccountView | undefined> {
    const row = await this.accounts.get(id);
    if (!row) return undefined;
    const run = this.running.get(id);
    if (run) await this.checkIdentity(row, run);
    return this.viewOf((await this.accounts.get(id)) ?? row);
  }

  private viewOf(row: AccountRow): AccountView {
    if (!row.enabled) return { row, state: "paused" };
    const run = this.running.get(row.id);
    if (run?.error) return { row, state: "error", error: run.error };
    if (row.platform === "whatsapp") {
      const st = run?.wa?.status();
      if (!st) return { row, state: "connecting" };
      if (st.state === "open") return { row, state: "connected" };
      if (st.state === "qr") return { row, state: "waiting_qr", qr: st.qr };
      if (st.state === "replaced")
        return { row, state: "error", error: "Another client took over this login." };
      if (st.state === "logged_out")
        return { row, state: "waiting_qr", detail: "Logged out from the phone — scan again." };
      return { row, state: "connecting", detail: st.state };
    }
    const flow = this.flows.get(row.id);
    if (flow)
      return { row, state: "login", tgStep: flow.step, viaApp: flow.viaApp, error: flow.error };
    if (!row.session) return { row, state: "login", tgStep: "phone" };
    if (run?.tg) {
      const ready = this.deps.endpoints[endpointKey("telegram", row.id)]?.ready();
      return { row, state: ready ? "connected" : "connecting" };
    }
    return { row, state: "connecting" };
  }
}
