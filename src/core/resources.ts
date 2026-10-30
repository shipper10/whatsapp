import { statfs } from "node:fs/promises";

const MB = 1024 * 1024;

/** Free space (MB) on the disk holding `dir`, or null when the platform cannot say. */
export async function freeDiskMb(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / MB);
  } catch {
    return null;
  }
}

/** Resident memory of this process in MB. */
export const rssMb = () => Math.round(process.memoryUsage.rss() / MB);
