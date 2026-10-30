import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { setTextOverrides } from "../src/bot/messages.js";
import { createPanel } from "../src/http/panel.js";
import type { Overview } from "../src/http/panelData.js";
import { createAppServer } from "../src/http/server.js";
import { SettingsService } from "../src/settings/service.js";
import { MemSettings } from "./helpers/bot.js";

const TOKEN = "panel-token-0123456789";
let servers: ReturnType<typeof createAppServer>[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  setTextOverrides({});
});

const overview: Overview = {
  whatsapp: "✅ متصل",
  syncs: [{ kind: "telegram", ok: false, at: new Date(), error: "boom <b>x</b>" }],
  load: { running: 1, queued: 2, inflightMb: 3, cached: 4, rssMb: 120, freeDiskMb: 900 },
  counts: { resources: 10, uncategorized: 1, nodes: 5, subscribers: 2 },
  delivery: [{ outcome: "file_sent", n: 7 }],
  sources: [],
  recentRuns: [],
};

async function start() {
  const store = new MemSettings();
  const settings = new SettingsService(store, {}, 0);
  const panel = createPanel({
    token: TOKEN,
    settings,
    logger: { warn: () => {} },
    overview: async () => overview,
    indexTitles: async () => ["Histology Index", "Biochemistry Index"],
  });
  const server = createAppServer({
    panel,
    health: async () => true,
    logger: { warn: () => {}, error: () => {} },
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, settings };
}

async function login(url: string) {
  const r = await fetch(`${url}/admin/panel/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `token=${TOKEN}`,
    redirect: "manual",
  });
  expect(r.status).toBe(303);
  return (r.headers.get("set-cookie") ?? "").split(";")[0] as string;
}
const post = (url: string, path: string, cookie: string, form: Record<string, string>) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams(form).toString(),
  });

describe("admin panel", () => {
  it("asks for the token, rejects a wrong one, then shows the overview with escaped content", async () => {
    const { url } = await start();
    expect((await fetch(`${url}/admin/panel`)).status).toBe(401);
    const bad = await fetch(`${url}/admin/panel/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=nope",
    });
    expect(bad.status).toBe(401);
    const cookie = await login(url);
    const page = await (await fetch(`${url}/admin/panel`, { headers: { cookie } })).text();
    expect(page).toContain("نظرة عامة");
    expect(page).toContain("120 MB");
    expect(page).not.toContain("<b>x</b>");
    expect(page).toContain("&#60;b&#62;x&#60;/b&#62;");
  });

  it("a link with ?token= signs in and strips the token from the address", async () => {
    const { url } = await start();
    const r = await fetch(`${url}/admin/panel?token=${TOKEN}`, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/panel");
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("adds, replaces and deletes translations and lists words without one", async () => {
    const { url, settings } = await start();
    const cookie = await login(url);
    await post(url, "/admin/panel/translations", cookie, {
      action: "add",
      ar: "علم الانسجة",
      en: "histology",
    });
    expect(await settings.get("library.indexAliases")).toContain("علم الانسجة=histology");
    await post(url, "/admin/panel/translations", cookie, {
      action: "add",
      ar: "علم الانسجة",
      en: "histology and cells",
    });
    const list = await settings.get("library.indexAliases");
    expect(list.filter((l) => l.startsWith("علم الانسجة"))).toEqual([
      "علم الانسجة=histology and cells",
    ]);
    const page = await (
      await fetch(`${url}/admin/panel/translations`, { headers: { cookie } })
    ).text();
    expect(page).toContain("biochemistry"); // existing default pair is shown
    await post(url, "/admin/panel/translations", cookie, { action: "delete", ar: "علم الانسجة" });
    expect(
      (await settings.get("library.indexAliases")).some((l) => l.startsWith("علم الانسجة")),
    ).toBe(false);
    const bulk = await post(url, "/admin/panel/translations", cookie, {
      action: "bulk",
      lines: "قلب=heart\nكلية=kidney",
    });
    expect(bulk.status).toBe(200);
    expect(await settings.get("library.indexAliases")).toEqual(["قلب=heart", "كلية=kidney"]);
    const empty = await (
      await post(url, "/admin/panel/translations", cookie, { action: "add", ar: "", en: "" })
    ).text();
    expect(empty).toContain("لم يُحفظ");
  });

  it("saves bot texts, ignoring unknown keys and blanks", async () => {
    const { url, settings } = await start();
    const cookie = await login(url);
    await post(url, "/admin/panel/texts", cookie, {
      "t.help.ar": "مساعدة مخصصة",
      "t.help.en": "  ",
      "t.nope.ar": "x",
    });
    expect(await settings.get("text.overrides")).toEqual({ "help.ar": "مساعدة مخصصة" });
  });

  it("does nothing without a session", async () => {
    const { url, settings } = await start();
    const r = await post(url, "/admin/panel/translations", "bp=wrong", {
      action: "bulk",
      lines: "a=b",
    });
    expect(r.status).toBe(401);
    expect((await settings.get("library.indexAliases")).length).toBeGreaterThan(5);
  });
});
