/** Accepts a Drive folder URL or a bare folder id and returns the folder id. */
export function parseFolderId(input: string): string {
  const s = input.trim();
  const fromPath = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s);
  if (fromPath?.[1]) return fromPath[1];
  const fromQuery = /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  if (fromQuery?.[1]) return fromQuery[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  throw new Error(`Not a Drive folder URL or id: ${input}`);
}

/** Documented Drive URL format, used only when the API returned no webViewLink. */
export const driveFileUrl = (fileId: string) => `https://drive.google.com/file/d/${fileId}/view`;
