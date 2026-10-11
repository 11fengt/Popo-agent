import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDocumentName } from './filename.js';

test('repairs UTF-8 filenames that were decoded as Latin-1', () => {
  const broken = Buffer.from('知识库说明.pdf', 'utf8').toString('latin1');
  assert.equal(normalizeDocumentName(broken), '知识库说明.pdf');
});

test('keeps already-correct Chinese and ASCII filenames unchanged', () => {
  assert.equal(normalizeDocumentName('知识库说明.pdf'), '知识库说明.pdf');
  assert.equal(normalizeDocumentName('rag-guide.md'), 'rag-guide.md');
});

test('removes client-side path components from uploaded filenames', () => {
  assert.equal(normalizeDocumentName('C:\\fakepath\\guide.docx'), 'guide.docx');
});
