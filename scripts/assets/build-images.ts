// Builds every species image in apps/web/public/species/ from the owner's
// incoming art (NFT-U1). Run: pnpm assets:build-images
//
// Each PNG in scripts/assets/incoming.json is read from assets-incoming/ (its
// hash checked), resized to IMAGE_SIZE on its longest side and written as a
// WebP at IMAGE_QUALITY, which the configure page (about 320 CSS px), the
// mint page's thumbnails and the My Agents cards all read.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { SPECIES } from "@alpha-agents/domain";
import { REPO_ROOT, incomingRoot, readIncomingMap, readPinned } from "./incoming.ts";

export const IMAGE_SIZE = 1024;
export const IMAGE_QUALITY = 82;
const OUT = join(REPO_ROOT, "apps/web/public/species");

export async function buildImage(png: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp(png)
      .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: IMAGE_QUALITY, effort: 5 })
      .toBuffer(),
  );
}

const map = readIncomingMap();
const root = incomingRoot(map, "images");
if (!root) {
  console.error(`error: ${map.roots.images} is not on this machine; the committed images stand`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [slug, entry] of Object.entries(map.images)) {
  if (!SPECIES.some((s) => s.slug === slug)) throw new Error(`${slug} is not a species`);
  const out = await buildImage(readPinned(root, entry));
  writeFileSync(join(OUT, `${slug}.webp`), out);
  total += out.byteLength;
  console.log(
    `${slug.padEnd(16)} ${(out.byteLength / 1e3).toFixed(0).padStart(4)} kB  from ${entry.file}`,
  );
}
console.log(`${Object.keys(map.images).length} images, ${(total / 1e6).toFixed(2)} MB in all`);
