import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chunkDocumentBlocks,
  estimateTokens,
  parseMarkdownBlocks,
  parsePlainTextBlocks,
  parseUploadedDocument
} from './document-processing.js';

function createTextPdf(text) {
  const escaped = text.replace(/([()\\])/g, '\\$1');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${escaped.length + 35} >>\nstream\nBT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n`;
  source += '0000000000 65535 f \n';
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(source);
}

test('Markdown is split by heading before token budget is applied', () => {
  const blocks = parseMarkdownBlocks(`
# 使用指南

## 安装

安装 Python。

启动虚拟环境。

## 运行

启动 Chroma。
  `);
  const chunks = chunkDocumentBlocks(blocks);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, '使用指南 / 安装');
  assert.match(chunks[0].text, /安装 Python/);
  assert.equal(chunks[1].heading, '使用指南 / 运行');
});

test('long semantic blocks are split into bounded overlapping chunks', () => {
  const text = Array.from({ length: 900 }, (_, index) => `第${index}项知识。`).join('');
  const chunks = chunkDocumentBlocks(parsePlainTextBlocks(text));

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => estimateTokens(chunk.text) <= 660));
  assert.ok(chunks.every((chunk) => chunk.tokenCount <= 650));
});

test('text PDF pages are extracted without OCR and keep page metadata', async () => {
  const document = await parseUploadedDocument({
    originalname: 'searchable.pdf',
    buffer: createTextPdf('Searchable PDF knowledge document for vector retrieval.')
  });

  assert.equal(document.fileType, 'pdf');
  assert.equal(document.blocks[0].pageStart, 1);
  assert.match(document.blocks[0].text, /Searchable PDF knowledge/);
});

test('image-only PDFs are rejected with an OCR-specific error', async () => {
  await assert.rejects(
    parseUploadedDocument({ originalname: 'scan.pdf', buffer: createTextPdf('') }),
    (error) => error.code === 'SCANNED_PDF_UNSUPPORTED' && /OCR/.test(error.details)
  );
});

test('unsupported formats are rejected before embedding', async () => {
  await assert.rejects(
    parseUploadedDocument({ originalname: 'data.json', buffer: Buffer.from('{}') }),
    (error) => error.code === 'UNSUPPORTED_FILE' && error.status === 400
  );
});
