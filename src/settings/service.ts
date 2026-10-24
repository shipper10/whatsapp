import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appSettings } from "../db/schema.js";
import { type SettingKey, type SettingValue, settingsRegistry } from "./registry.js";

/** Storage abstraction so the service is testable without Postgres. */
export interface SettingsStore {
  loadAll(): Promise<Record<string, unknown>>;
  save(key: string, value: unknown, actor: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class DbSettingsStore implements SettingsStore {
  constructor(private readonly db: Db) {}
  async loadAll() {
    const rows = await this.db.select().from(appSettings);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
  async save(key: string, value: unknown, actor: string) {
    await this.db
      .insert(appSettings)
      .values({ key, value, updatedBy: actor })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedBy: actor, updatedAt: new Date() },
      });
  }
  async remove(key: string) {
    await this.db.delete(appSettings).where(eq(appSettings.key, key));
  }
}

export class SettingsService {
  private overrides: Record<string, unknown> = {};
  private loadedAt = 0;

  constructor(
    private readonly store: SettingsStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly cacheMs = 15_000,
    private readonly now: () => number = Date.now,
  ) {}

  private async refresh(force = false) {
    if (!force && this.now() - this.loadedAt < this.cacheMs) return;
    this.overrides = await this.store.loadAll();
    this.loadedAt = this.now();
  }

  /** Admin override > env var > built-in default. Invalid stored values fall back safely. */
  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    await this.refresh();
    const def = settingsRegistry[key];
    const candidates: unknown[] = [];
    if (key in this.overrides) candidates.push(this.overrides[key]);
    if (def.envName && this.env[def.envName] !== undefined) candidates.push(this.env[def.envName]);
    for (const c of candidates) {
      const parsed = def.schema.safeParse(c);
      if (parsed.success) return parsed.data as SettingValue<K>;
    }
    return def.default as SettingValue<K>;
  }

  /** Validates against the registry before saving; throws a readable error otherwise. */
  async set<K extends SettingKey>(key: K, raw: unknown, actor: string) {
    const def = settingsRegistry[key];
    if (!def) throw new Error(`Unknown setting: ${String(key)}`);
    const parsed = def.schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Invalid value for ${key}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    await this.store.save(key, parsed.data, actor);
    await this.refresh(true);
    return { restartRequired: def.restart };
  }

  async reset(key: SettingKey) {
    await this.store.remove(key);
    await this.refresh(true);
  }

  async describeAll() {
    await this.refresh(true);
    return Promise.all(
      (Object.keys(settingsRegistry) as SettingKey[]).map(async (key) => ({
        key,
        value: await this.get(key),
        overridden: key in this.overrides,
        restart: settingsRegistry[key].restart,
        description: settingsRegistry[key].description,
      })),
    );
  }
}
