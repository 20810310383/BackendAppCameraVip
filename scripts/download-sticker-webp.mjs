import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const stickerPackRoot = path.resolve(scriptDirectory, '../assets/sticker-packs/sticker-new');
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = 'CameraDailyStickerDownloader/1.0 (+local tool)';
const supportsColor = Boolean(process.stdout.isTTY || process.stderr.isTTY);

function colorize(code, value) {
  return supportsColor ? `\x1b[${code}m${value}\x1b[0m` : value;
}

const green = (value) => colorize(32, value);
const red = (value) => colorize(31, value);
const yellow = (value) => colorize(33, value);

function printUsage() {
  console.log('Usage: npm run download:stickers -- <page-url> [folder-name] [--all]');
  console.log('Example: npm run download:stickers -- "https://example.com/stickers" "cute-cats"');
  console.log('Add --all only when you intentionally want images from every pack on the page.');
}

function safeFolderName(value) {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52);
  return normalized || 'stickers';
}

function defaultFolderName(pageUrl) {
  const host = safeFolderName(new URL(pageUrl).hostname.replace(/^www\./, ''));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${host}-${timestamp}`;
}

async function createUniqueFolder(baseName) {
  await mkdir(stickerPackRoot, { recursive: true });
  let suffix = 0;
  while (true) {
    const folderName = suffix ? `${baseName}-${suffix}` : baseName;
    const targetDirectory = path.join(stickerPackRoot, folderName);
    try {
      await stat(targetDirectory);
      suffix += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(targetDirectory, { recursive: false });
      return targetDirectory;
    }
  }
}

function decodeUrlEscapes(value) {
  let decoded = String(value);

  // Sticker sites often embed URLs in JSON, for example:
  // https:\u002F\u002Fimg-10.stickers.cloud\u002Fpacks\u002F...
  // Decode twice to also cover values that were escaped once more by the page.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    decoded = decoded
      .replace(/\\u([0-9a-f]{4})/gi, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)))
      .replace(/\\\//g, '/');
  }

  return decoded.replace(/&amp;/gi, '&');
}

function normalizeWebpUrl(value, baseUrl) {
  const candidate = decodeUrlEscapes(value).trim().replace(/^['"(]+|[)'",;]+$/g, '');
  if (!candidate || candidate.startsWith('data:')) return null;
  try {
    const resolved = new URL(candidate, baseUrl);
    return /^https?:$/.test(resolved.protocol) ? resolved.href : null;
  } catch {
    return null;
  }
}

function extractWebpUrls(source, baseUrl) {
  const decodedSource = decodeUrlEscapes(source);
  const matches = decodedSource.matchAll(/(?:https?:)?\/\/[^\s'"<>()[\]{}]+?\.webp(?:\?[^\s'"<>()[\]{}]*)?|(?:\.\.\/|\.\/|\/)?[^\s'"<>()[\]{}]+?\.webp(?:\?[^\s'"<>()[\]{}]*)?/gi);
  const urls = new Set();
  for (const match of matches) {
    const url = normalizeWebpUrl(match[0], baseUrl);
    if (url) urls.add(url);
  }
  return urls;
}

function stickerVariant(url) {
  return url.match(/\/webp\/(animated|static)\//i)?.[1].toLowerCase() ?? null;
}

function stickerIdentity(url) {
  return url.replace(/\/webp\/(?:animated|static)\//i, '/webp/{variant}/');
}

function withVariant(url, variant) {
  return url.replace(/\/webp\/(?:animated|static)\//i, '/webp/' + variant + '/');
}

function makeDownloadTargets(urls) {
  const targets = new Map();

  for (const url of urls) {
    const variant = stickerVariant(url);
    if (!variant) {
      targets.set(url, { url, fallbackUrl: null });
      continue;
    }

    const identity = stickerIdentity(url);
    const existing = targets.get(identity);
    if (variant === 'animated') {
      targets.set(identity, {
        url,
        fallbackUrl: existing?.fallbackUrl ?? withVariant(url, 'static'),
      });
      continue;
    }

    // Sites frequently load a static preview before the animation starts.
    // Request its animated counterpart first, then retain the static file
    // when that sticker is genuinely still.
    if (existing) {
      existing.fallbackUrl = url;
    } else {
      targets.set(identity, {
        url: withVariant(url, 'animated'),
        fallbackUrl: url,
      });
    }
  }

  return [...targets.values()];
}

function packIdFromUrl(url) {
  try {
    return new URL(url).pathname
      .match(/\/packs\/([0-9a-f]{8}-[0-9a-f-]{27,})\//i)?.[1]
      ?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function selectPrimaryPack(urls, pageUrl, includeAllPacks) {
  if (includeAllPacks) {
    return { urls: [...urls], packId: null, mode: 'all packs' };
  }

  const groups = new Map();
  for (const url of urls) {
    const packId = packIdFromUrl(url);
    if (!packId) continue;
    const group = groups.get(packId) ?? [];
    group.push(url);
    groups.set(packId, group);
  }

  if (!groups.size) {
    return { urls: [...urls], packId: null, mode: 'no pack identifier found' };
  }

  const pagePackId = packIdFromUrl(pageUrl);
  if (pagePackId && groups.has(pagePackId)) {
    return { urls: groups.get(pagePackId), packId: pagePackId, mode: 'pack in page URL' };
  }

  // Related packs normally contribute only a few preview files, while the
  // displayed pack contains the full sticker grid. Pick that largest group.
  const [packId, packUrls] = [...groups.entries()]
    .sort(([, left], [, right]) => right.length - left.length)[0];
  return { urls: packUrls, packId, mode: 'largest pack on page' };
}

function extractStylesheetUrls(html, baseUrl) {
  const stylesheetUrls = new Set();
  for (const tagMatch of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = tagMatch[0];
    if (!/\brel\s*=\s*['"][^'"]*stylesheet[^'"]*['"]/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    if (!href) continue;
    const url = normalizeWebpUrl(href, baseUrl);
    if (url) stylesheetUrls.add(url);
  }
  return stylesheetUrls;
}

async function fetchText(url, referer) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,text/css;q=0.9,*/*;q=0.8',
      'User-Agent': USER_AGENT,
      ...(referer ? { Referer: referer } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

function stickerFilename(url, index, usedNames) {
  const pathname = new URL(url).pathname;
  const stem = path.basename(pathname, path.extname(pathname))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || `sticker-${index + 1}`;
  let filename = `${stem}.webp`;
  let suffix = 2;
  while (usedNames.has(filename.toLowerCase())) {
    filename = `${stem}-${suffix}.webp`;
    suffix += 1;
  }
  usedNames.add(filename.toLowerCase());
  return filename;
}

function isWebp(buffer) {
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

async function fetchWebp(url, referer) {
  const response = await fetch(url, {
    headers: {
      Accept: 'image/webp,image/*;q=0.9,*/*;q=0.8',
      'User-Agent': USER_AGENT,
      Referer: referer,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const file = Buffer.from(await response.arrayBuffer());
  if (!isWebp(file)) throw new Error('response is not a valid WebP image');
  return file;
}

async function downloadSticker({ url, fallbackUrl }, destination, referer) {
  let file;
  let usedFallback = false;
  try {
    file = await fetchWebp(url, referer);
  } catch (primaryError) {
    if (!fallbackUrl || fallbackUrl === url) throw primaryError;
    file = await fetchWebp(fallbackUrl, referer);
    usedFallback = true;
  }
  const metadata = await sharp(file, { animated: true }).metadata();
  await writeFile(destination, file, { flag: 'wx' });
  return { frameCount: metadata.pages ?? 1, usedFallback };
}

const [pageUrl, requestedFolderName, ...options] = process.argv.slice(2);
const includeAllPacks = options.includes('--all');
if (!pageUrl) {
  printUsage();
  process.exit(1);
}

let startUrl;
try {
  startUrl = new URL(pageUrl).href;
} catch {
  console.error(`Invalid URL: ${pageUrl}`);
  process.exit(1);
}

const webpUrls = new Set();
if (/\.webp(?:\?|$)/i.test(new URL(startUrl).pathname + new URL(startUrl).search)) {
  webpUrls.add(startUrl);
} else {
  console.log(`Reading: ${startUrl}`);
  const html = await fetchText(startUrl);
  for (const url of extractWebpUrls(html, startUrl)) webpUrls.add(url);

  const stylesheetUrls = extractStylesheetUrls(html, startUrl);
  for (const stylesheetUrl of stylesheetUrls) {
    try {
      const css = await fetchText(stylesheetUrl, startUrl);
      for (const url of extractWebpUrls(css, stylesheetUrl)) webpUrls.add(url);
    } catch (error) {
      console.warn(yellow(`! Skipped stylesheet ${stylesheetUrl}: ${error.message}`));
    }
  }
}

const selection = selectPrimaryPack(webpUrls, startUrl, includeAllPacks);
const targets = makeDownloadTargets(selection.urls);
if (!targets.length) {
  console.error('No .webp URLs were found. No folder was created.');
  process.exit(1);
}

const folderName = safeFolderName(requestedFolderName || defaultFolderName(startUrl));
const destinationDirectory = await createUniqueFolder(folderName);
const usedNames = new Set();
let downloaded = 0;
let failed = 0;

if (selection.packId) {
  console.log(`Selected pack: ${selection.packId} (${selection.mode})`);
} else if (includeAllPacks) {
  console.log('Selected: all packs on the page');
}
console.log(`Found ${targets.length} sticker(s). Saving to: ${destinationDirectory}`);
for (const [index, target] of targets.entries()) {
  const filename = stickerFilename(target.url, index, usedNames);
  try {
    const { frameCount, usedFallback } = await downloadSticker(target, path.join(destinationDirectory, filename), startUrl);
    downloaded += 1;
    const animationStatus = frameCount > 1 ? `WebP động · ${frameCount} frame` : 'WebP tĩnh · 1 frame';
    const fallbackStatus = usedFallback ? ' · không có bản động, giữ bản tĩnh' : '';
    console.log(green(`✓ [${index + 1}/${targets.length}] Đã tải: ${filename} (${animationStatus}${fallbackStatus})`));
  } catch (error) {
    failed += 1;
    console.warn(red(`✗ [${index + 1}/${targets.length}] Lỗi: ${target.url} — ${error.message}`));
  }
}

console.log(green(`Thành công: ${downloaded}`) + (failed ? ` · ${red(`Lỗi: ${failed}`)}` : ''));
console.log(`Folder: ${destinationDirectory}`);
