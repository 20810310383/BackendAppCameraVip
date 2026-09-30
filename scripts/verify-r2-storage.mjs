import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { deleteStoredObjects, storeProcessedFile } from '../src/services/object-storage-service.js';

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'cameradaily-r2-check-'));
const localPaths = [
  path.join(temporaryDirectory, 'check-video.txt'),
  path.join(temporaryDirectory, 'check-thumbnail.txt'),
];
const objectPrefix = `r2-check-${randomBytes(12).toString('hex')}`;

try {
  await Promise.all([
    writeFile(localPaths[0], 'CameraDaily R2 video deletion verification'),
    writeFile(localPaths[1], 'CameraDaily R2 thumbnail deletion verification'),
  ]);
  const urls = await Promise.all(localPaths.map((localPath, index) => storeProcessedFile({
    localPath,
    localUrl: `/uploads/r2-check/${objectPrefix}-${index}.txt`,
    objectKey: `media/system/${objectPrefix}-${index}.txt`,
    contentType: 'text/plain; charset=utf-8',
    cacheControl: 'no-store',
  })));
  if (urls.some((url) => !/^https:\/\//i.test(url))) {
    throw new Error('R2 chưa được bật vì thiếu một hoặc nhiều biến R2 trong .env.');
  }
  const deletedUrls = await deleteStoredObjects(urls);
  if (deletedUrls.size !== urls.length) {
    throw new Error('Đã upload được R2 nhưng không thể xoá object kiểm tra.');
  }
  console.log('R2 OK: upload và xoá object kiểm tra thành công; VPS không giữ file tạm.');
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
