import path from 'node:path';

export function normalizeDocumentName(value) {
  const rawName = String(value || '')
    .replace(/\0/g, '')
    .replace(/\\/g, '/');
  const baseName = path.posix.basename(rawName).trim() || '未命名文档';

  // Multipart headers are UTF-8 bytes, but Busboy/Multer may expose them as Latin-1.
  // Only accept the repair when it forms valid UTF-8; this keeps already-correct names intact.
  if (/[^\x00-\x7F]/.test(baseName)) {
    const decoded = Buffer.from(baseName, 'latin1').toString('utf8');
    if (decoded !== baseName && !decoded.includes('\uFFFD')) {
      return decoded;
    }
  }

  return baseName;
}
