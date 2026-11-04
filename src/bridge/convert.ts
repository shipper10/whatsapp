import { dirname, join } from "node:path";
import sharp from "sharp";

/**
 * Turns a sticker (static or animated WebP, and most other image formats) into a plain PNG so it can be sent
 * as an ordinary picture where the other side refuses stickers. Animated stickers keep their first frame.
 * The result is written next to the source, which the bridge deletes after forwarding.
 */
export async function stickerToPng(inputPath: string): Promise<string> {
  const out = join(dirname(inputPath), "sticker.png");
  await sharp(inputPath).png().toFile(out);
  return out;
}
