import { describe, expect, it } from "vitest";
import { SettingsService, type SettingsStore } from "../src/settings/service.js";

class MemStore implements SettingsStore {
  data: Record<string, unknown> = {};
  async loadAll() {
    return { ...this.data };
  }
  async save(k: string, v: unknown) {
    this.data[k] = v;
  }
  async remove(k: string) {
    delete this.data[k];
  }
}

describe("SettingsService", () => {
  it("uses default, then env, then DB override", async () => {
    const store = new MemStore();
    const svc = new SettingsService(store, { PAGE_SIZE: "5" }, 0);
    expect(await svc.get("search.maxResults")).toBe(10);
    expect(await svc.get("search.pageSize")).toBe(5);
    await svc.set("search.pageSize", 12, "admin");
    expect(await svc.get("search.pageSize")).toBe(12);
    await svc.reset("search.pageSize");
    expect(await svc.get("search.pageSize")).toBe(5);
  });
  it("rejects invalid values and reports restart flag", async () => {
    const svc = new SettingsService(new MemStore(), {}, 0);
    await expect(svc.set("search.pageSize", 500, "admin")).rejects.toThrow(/Invalid value/);
    expect((await svc.set("sync.concurrency", 4, "admin")).restartRequired).toBe(true);
  });
  it("ignores corrupt stored values", async () => {
    const store = new MemStore();
    store.data["search.pageSize"] = "not a number";
    expect(await new SettingsService(store, {}, 0).get("search.pageSize")).toBe(8);
  });
});
