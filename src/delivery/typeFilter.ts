const GROUPS: Record<string, string[]> = {
  audio: ["audio/*"],
  video: ["video/*"],
  image: ["image/*"],
  images: ["image/*"],
  photo: ["image/*"],
  document: ["application/*", "text/*"],
  documents: ["application/*", "text/*"],
  doc: [".doc", ".docx"],
  docs: [".doc", ".docx"],
  word: [".doc", ".docx"],
  excel: [".xls", ".xlsx"],
  sheet: [".xls", ".xlsx"],
  ppt: [".ppt", ".pptx"],
  powerpoint: [".ppt", ".pptx"],
  slides: [".ppt", ".pptx"],
  office: [".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"],
};

const extOf = (name: string | null | undefined) =>
  /\.([a-z0-9]{1,6})$/i.exec(name ?? "")?.[1]?.toLowerCase() ?? "";

/**
 * Admin-friendly type filter. Each entry may be a group (audio, video, image, document), an extension
 * (pdf or .pdf), a MIME type (application/pdf) or a MIME prefix (audio/*). Empty list = everything.
 */
export function typeAllowed(
  mime: string | null,
  fileName: string | null | undefined,
  allowed: string[],
): boolean {
  if (allowed.length === 0) return true;
  const m = mime?.toLowerCase().split(";")[0]?.trim() ?? "";
  const ext = extOf(fileName);
  const entries = allowed.flatMap((a) => {
    const k = a.trim().toLowerCase();
    return GROUPS[k] ?? [k];
  });
  return entries.some((e) => {
    if (e.endsWith("/*")) return m.startsWith(e.slice(0, -1));
    if (e.includes("/")) return m === e;
    return ext !== "" && ext === e.replace(/^\./, "");
  });
}
