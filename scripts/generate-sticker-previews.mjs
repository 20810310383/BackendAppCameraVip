import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const stickerRoot = path.resolve(scriptDirectory, '../assets/sticker-packs');
const previewRoot = path.resolve(scriptDirectory, '../assets/sticker-previews');

const packNames = await readdir(stickerRoot, { withFileTypes: true });
let generated = 0;

for (const pack of packNames) {
  if (!pack.isDirectory()) continue;

  const sourceDirectory = path.join(stickerRoot, pack.name);
  const destinationDirectory = path.join(previewRoot, pack.name);
  await mkdir(destinationDirectory, { recursive: true });
  const files = await readdir(sourceDirectory, { withFileTypes: true });

  for (const file of files) {
    if (!file.isFile() || !/\.webp$/i.test(file.name)) continue;

    await sharp(path.join(sourceDirectory, file.name), { animated: false })
      .resize({
        width: 120,
        height: 120,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality: 62, effort: 4 })
      .toFile(path.join(destinationDirectory, file.name));
    generated += 1;
  }
}

console.log(`Generated ${generated} sticker previews in ${previewRoot}`);
