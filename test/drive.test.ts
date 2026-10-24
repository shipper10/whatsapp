import { describe, expect, it } from "vitest";
import { resolveCredentialPath } from "../src/drive/client.js";
import type { DriveStore } from "../src/drive/store.js";
import { scanSource, syncDrive } from "../src/drive/sync.js";
import {
  DriveAccessError,
  type DriveClient,
  type DriveFileMeta,
  type DriveListEntry,
  type DriveSourceConfig,
} from "../src/drive/types.js";
import { parseFolderId } from "../src/drive/url.js";

const F = "application/vnd.google-apps.folder";
const src = (id: number, folderId: string, recursive = true): DriveSourceConfig => ({
  id,
  label: `s${id}`,
  folderId,
  credentialRef: "default",
  recursiveScan: recursive,
  enabled: true,
});

class FakeDrive implements DriveClient {
  identity = "bot@project.iam.gserviceaccount.com";
  calls: string[] = [];
  constructor(private tree: Record<string, DriveListEntry[] | "denied">) {}
  async listChildren(id: string) {
    this.calls.push(id);
    const v = this.tree[id];
    if (v === undefined || v === "denied") throw new DriveAccessError(id, this.identity);
    return v;
  }
}

class MemStore implements DriveStore {
  files = new Map<string, DriveFileMeta & { status: string; seen: Date }>();
  status = new Map<number, string>();
  constructor(public sources: DriveSourceConfig[]) {}
  async listSources() {
    return this.sources;
  }
  async upsertFiles(sid: number, fs: DriveFileMeta[], seen: Date) {
    let inserted = 0,
      updated = 0;
    for (const f of fs) {
      const k = `${sid}:${f.driveFileId}`;
      this.files.has(k) ? updated++ : inserted++;
      this.files.set(k, { ...f, status: "active", seen });
    }
    return { inserted, updated };
  }
  async markMissing(sid: number, before: Date) {
    let n = 0;
    for (const [k, v] of this.files)
      if (k.startsWith(`${sid}:`) && v.status === "active" && v.seen < before) {
        v.status = "missing";
        n++;
      }
    return n;
  }
  async setSourceStatus(id: number, s: string) {
    this.status.set(id, s);
  }
  async startRun() {
    return 1;
  }
  async finishRun() {}
}

const noSleep = { sleep: async () => {} };

describe("parseFolderId", () => {
  it("handles urls and bare ids", () => {
    expect(
      parseFolderId("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn?usp=sharing"),
    ).toBe("1AbCdEfGhIjKlMn");
    expect(parseFolderId("https://drive.google.com/open?id=1AbCdEfGhIjKlMn")).toBe(
      "1AbCdEfGhIjKlMn",
    );
    expect(parseFolderId("1AbCdEfGhIjKlMn")).toBe("1AbCdEfGhIjKlMn");
    expect(() => parseFolderId("hello")).toThrow();
  });
});

describe("resolveCredentialPath", () => {
  it("supports default and env: refs, rejects others", () => {
    const env = { GOOGLE_SERVICE_ACCOUNT_JSON_PATH: "/a.json", OTHER: "/b.json" };
    expect(resolveCredentialPath("default", env)).toBe("/a.json");
    expect(resolveCredentialPath("env:OTHER", env)).toBe("/b.json");
    expect(() => resolveCredentialPath("env:MISSING", env)).toThrow(/not set/);
    expect(() => resolveCredentialPath("raw-secret", env)).toThrow(/Unsupported/);
  });
});

describe("scanSource", () => {
  const tree = {
    root: [
      {
        id: "f1",
        name: "a.pdf",
        mimeType: "application/pdf",
        size: "100",
        modifiedTime: "2026-01-01T00:00:00Z",
        webViewLink: "https://drive.google.com/file/d/f1/view",
      },
      { id: "d1", name: "Cardio", mimeType: F },
    ],
    d1: [
      { id: "f2", name: "a.pdf", mimeType: "application/pdf" },
      { id: "root", name: "loop", mimeType: F }, // cycle back to root
    ],
  };
  it("is recursive, keeps same-named files in different folders distinct, builds links, survives cycles", async () => {
    const files = await scanSource(new FakeDrive(tree), src(1, "root"), noSleep);
    expect(files.map((f) => f.driveFileId).sort()).toEqual(["f1", "f2"]);
    expect(files.find((f) => f.driveFileId === "f2")?.folderPath).toBe("Cardio");
    expect(files.find((f) => f.driveFileId === "f2")?.webViewLink).toBe(
      "https://drive.google.com/file/d/f2/view",
    );
    expect(files.find((f) => f.driveFileId === "f1")?.sizeBytes).toBe(100);
  });
  it("does not descend when recursion is off", async () => {
    const client = new FakeDrive(tree);
    const files = await scanSource(client, src(1, "root", false), noSleep);
    expect(files.map((f) => f.driveFileId)).toEqual(["f1"]);
    expect(client.calls).toEqual(["root"]);
  });
});

describe("syncDrive", () => {
  it("isolates a denied source, reports a clear error, and still syncs the others", async () => {
    const store = new MemStore([src(1, "bad"), src(2, "ok")]);
    const client = new FakeDrive({
      bad: "denied",
      ok: [{ id: "x", name: "x.pdf", mimeType: "application/pdf" }],
    });
    const res = await syncDrive(store, () => client, noSleep);
    expect(res[0]).toMatchObject({ ok: false });
    expect(res[0]?.error).toMatch(/Share the folder.*bot@project/);
    expect(res[1]).toMatchObject({ ok: true, inserted: 1 });
    expect(store.status.get(1)).toBe("error");
    expect(store.status.get(2)).toBe("ok");
  });
  it("updates changed metadata, marks vanished files missing only after a good scan", async () => {
    const store = new MemStore([src(1, "ok")]);
    let t = 0;
    const now = () => new Date(2026, 0, 1, 0, 0, t++);
    const v1 = new FakeDrive({
      ok: [
        { id: "a", name: "old.pdf", mimeType: "application/pdf" },
        { id: "b", name: "b.pdf", mimeType: "application/pdf" },
      ],
    });
    await syncDrive(store, () => v1, { ...noSleep, now });
    const v2 = new FakeDrive({ ok: [{ id: "a", name: "new.pdf", mimeType: "application/pdf" }] });
    const r = await syncDrive(store, () => v2, { ...noSleep, now });
    expect(store.files.get("1:a")?.name).toBe("new.pdf");
    expect(r[0]?.missing).toBe(1);
    expect(store.files.get("1:b")?.status).toBe("missing");
    // a failed scan must not mark anything missing
    const broken = new FakeDrive({ ok: "denied" });
    await syncDrive(store, () => broken, { ...noSleep, now });
    expect(store.files.get("1:a")?.status).toBe("active");
  });
});
