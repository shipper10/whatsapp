import { AsyncLocalStorage } from "node:async_hooks";
import { Agent } from "node:https";
import type { Socket } from "node:net";

interface Scope {
  sockets: Set<Socket>;
}

/**
 * Baileys exposes no upload progress, but its uploads go through the HTTPS agent we hand it. This agent
 * remembers which sockets were opened while a given send was running (AsyncLocalStorage ties them to
 * that send) and the bytes written to those sockets ARE the upload progress.
 */
export class UploadMeter extends Agent {
  private readonly als = new AsyncLocalStorage<Scope>();

  constructor() {
    super({ keepAlive: false }); // one connection per upload, so bytes belong to exactly one send
  }

  createConnection(options: any, callback?: any): Socket {
    const sock = (super.createConnection as (o: unknown, cb?: unknown) => Socket).call(
      this,
      options,
      callback,
    );
    this.als.getStore()?.sockets.add(sock);
    return sock;
  }

  /**
   * Runs `job`, reporting (bytesSent, totalBytes) about once per `everyMs` while it runs.
   * `totalBytes` is the plain file size; the encrypted body is a few bytes larger, so progress is capped at it.
   */
  async measure<T>(
    totalBytes: number,
    onProgress: ((sent: number, total: number) => void) | undefined,
    job: () => Promise<T>,
    everyMs = 1000,
  ): Promise<T> {
    if (!onProgress) return job();
    const scope: Scope = { sockets: new Set() };
    const read = () => {
      let sent = 0;
      for (const s of scope.sockets) sent += s.bytesWritten;
      return Math.min(sent, totalBytes);
    };
    const timer = setInterval(() => onProgress(read(), totalBytes), everyMs);
    timer.unref?.();
    try {
      return await this.als.run(scope, job);
    } finally {
      clearInterval(timer);
    }
  }
}
