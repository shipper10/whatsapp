import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { UploadMeter } from "../src/providers/whatsapp/baileys/uploadMeter.js";

describe("UploadMeter", () => {
  it("reports the bytes sent over its connections while a job runs", async () => {
    const d = mkdtempSync(join(tmpdir(), "um-"));
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(d, "k.pem"),
          "-out",
          join(d, "c.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
        ],
        { stdio: "ignore" },
      );
    } catch {
      return; // no openssl here
    }
    const srv = createServer(
      { key: readFileSync(join(d, "k.pem")), cert: readFileSync(join(d, "c.pem")) },
      (req, res) => {
        req.resume();
        req.on("end", () => res.end("{}"));
      },
    );
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as { port: number }).port;
    const meter = new UploadMeter();
    const total = 6 * 1024 * 1024;
    let chunks = 0;
    const body = new Readable({
      read() {
        setTimeout(
          () => (chunks++ < 6 ? this.push(Buffer.alloc(1024 * 1024)) : this.push(null)),
          60,
        );
      },
    });
    const seen: number[] = [];
    await meter.measure(
      total,
      (s) => seen.push(s),
      () =>
        new Promise((resolve, reject) => {
          const req = request(
            {
              host: "localhost",
              port,
              method: "POST",
              path: "/",
              agent: meter,
              rejectUnauthorized: false,
              headers: { "Content-Length": total },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(1));
            },
          );
          req.on("error", reject);
          body.pipe(req);
        }),
      50,
    );
    srv.close();
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.at(-1) as number).toBeGreaterThan(0);
    expect(seen.at(-1) as number).toBeLessThanOrEqual(total);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen); // monotonic
  }, 30000);
});
