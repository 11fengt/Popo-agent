import path from 'node:path';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { normalizeDocumentName } from './filename.js';

export const SUPPORTED_DOCUMENT_EXTENSIONS = ['.md', '.markdown', '.txt', '.pdf', '.docx'];

const TARGET_CHUNK_TOKENS = 500;
const MAX_CHUNK_TOKENS = 650;
const MIN_CHUNK_TOKENS = 280;
const OVERLAP_TOKENS = 80;

const sentenceSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh-CN', { granularity: 'sentence' })
  : null;

function createDocumentError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = 400;
  return error;
}

function normalizeText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function normalizeBlock(block) {
  return {
    text: normalizeText(block.text),
    type: block.type || 'paragraph',
    heading: normalizeText(block.heading || ''),
    pageStart: Number(block.pageStart || 0),
    pageEnd: Number(block.pageEnd || block.pageStart || 0)
  };
}

function inferBlockType(lines) {
  if (lines.every((line) => /^\s*(?:[-*+] |\d+[.)] )/.test(line))) return 'list';
  if (lines.length > 1 && lines.every((line) => line.includes('|'))) return 'table';
  return 'paragraph';
}

export function parseMarkdownBlocks(markdown, location = {}) {
  const lines = normalizeText(markdown).split('\n');
  const blocks = [];
  const headingStack = [];
  let buffer = [];
  let codeFence = '';

  const currentHeading = () => headingStack.filter(Boolean).join(' / ');
  const pushBlock = (text, type) => {
    const block = normalizeBlock({
      text,
      type,
      heading: currentHeading(),
      ...location
    });
    if (block.text) blocks.push(block);
  };
  const flush = () => {
    if (!buffer.length) return;
    pushBlock(buffer.join('\n'), inferBlockType(buffer));
    buffer = [];
  };

  for (const line of lines) {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (codeFence) {
      buffer.push(line);
      if (fence?.[1]?.startsWith(codeFence[0]) && fence[1].length >= codeFence.length) {
        pushBlock(buffer.join('\n'), 'code');
        buffer = [];
        codeFence = '';
      }
      continue;
    }

    if (fence) {
      flush();
      codeFence = fence[1];
      buffer.push(line);
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      headingStack[level - 1] = heading[2].trim();
      headingStack.length = level;
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    buffer.push(line);
  }

  if (buffer.length) {
    pushBlock(buffer.join('\n'), codeFence ? 'code' : inferBlockType(buffer));
  }

  return blocks;
}

export function parsePlainTextBlocks(text, location = {}) {
  return normalizeText(text)
    .split(/\n\s*\n+/)
    .map((value) => normalizeBlock({ text: value, type: 'paragraph', ...location }))
    .filter((block) => block.text);
}

function decodeUtf8(buffer, name) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw createDocumentError(
      'INVALID_TEXT_ENCODING',
      `无法读取文件：${name}`,
      'Markdown 和 TXT 文件必须使用 UTF-8 编码。'
    );
  }
}

async function parsePdf(buffer, name) {
  const parser = new PDFParse({ data: buffer });
  let result;

  try {
    result = await parser.getText();
  } catch (error) {
    throw createDocumentError(
      'PDF_PARSE_FAILED',
      `PDF 解析失败：${name}`,
      error instanceof Error ? error.message : '文件可能已损坏或受到密码保护。'
    );
  } finally {
    await parser.destroy().catch(() => {});
  }

  const extracted = normalizeText(result.pages.map((page) => page.text).join('\n'));
  const meaningfulCharacters = extracted.match(/[\p{L}\p{N}]/gu)?.length || 0;
  if (meaningfulCharacters < 10) {
    throw createDocumentError(
      'SCANNED_PDF_UNSUPPORTED',
      `PDF 中没有可提取的文本：${name}`,
      '该文件可能是扫描件或图片型 PDF；当前版本暂不执行 OCR，请上传包含文本层的 PDF。'
    );
  }

  return result.pages.flatMap((page) =>
    parsePlainTextBlocks(page.text, {
      pageStart: page.num,
      pageEnd: page.num
    })
  );
}

async function parseDocx(buffer, name) {
  let result;
  try {
    result = await mammoth.convertToMarkdown(
      { buffer },
      { externalFileAccess: false, includeDefaultStyleMap: true }
    );
  } catch (error) {
    throw createDocumentError(
      'DOCX_PARSE_FAILED',
      `Word 文档解析失败：${name}`,
      error instanceof Error ? error.message : '文件可能已损坏；当前仅支持 `.docx`，不支持旧版 `.doc`。'
    );
  }

  const blocks = parseMarkdownBlocks(result.value);
  if (!blocks.length) {
    throw createDocumentError(
      'EMPTY_DOCUMENT',
      `Word 文档没有可提取的文本：${name}`,
      '请确认文档中包含可选择的文字，而不是只有图片。'
    );
  }
  return blocks;
}

export function parseTextDocument(name, content) {
  const extension = path.extname(name).toLowerCase();
  return extension === '.md' || extension === '.markdown'
    ? parseMarkdownBlocks(content)
    : parsePlainTextBlocks(content);
}

export async function parseUploadedDocument(file) {
  const name = normalizeDocumentName(file.originalname || file.name);
  const extension = path.extname(name).toLowerCase();
  if (!SUPPORTED_DOCUMENT_EXTENSIONS.includes(extension)) {
    throw createDocumentError(
      'UNSUPPORTED_FILE',
      `不支持的文件格式：${name}`,
      '仅支持 Markdown（.md、.markdown）、TXT、文本型 PDF 和 Word（.docx）。'
    );
  }

  let blocks;
  if (extension === '.pdf') {
    blocks = await parsePdf(file.buffer, name);
  } else if (extension === '.docx') {
    blocks = await parseDocx(file.buffer, name);
  } else {
    blocks = parseTextDocument(name, decodeUtf8(file.buffer, name));
  }

  if (!blocks.length) {
    throw createDocumentError(
      'EMPTY_DOCUMENT',
      `文档内容为空：${name}`,
      '请确认文件包含可提取的正文内容。'
    );
  }

  return {
    name,
    fileType: extension.slice(1),
    blocks
  };
}

export function estimateTokens(text) {
  const units = String(text || '').match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_-]+|[^\s]/gu
  ) || [];

  return units.reduce((count, unit) => {
    if (/^[\p{L}\p{N}_-]+$/u.test(unit) && /^[\x00-\x7F]+$/.test(unit)) {
      return count + Math.max(1, Math.ceil(unit.length / 4));
    }
    return count + 1;
  }, 0);
}

function sentenceUnits(text) {
  if (sentenceSegmenter) {
    return [...sentenceSegmenter.segment(text)]
      .map((item) => item.segment.trim())
      .filter(Boolean);
  }
  return text.split(/(?<=[。！？!?；;\.])\s*/).map((item) => item.trim()).filter(Boolean);
}

function hardSplitByBudget(text, budget) {
  const characters = Array.from(text);
  const parts = [];
  let start = 0;

  while (start < characters.length) {
    let low = start + 1;
    let high = characters.length;
    let end = low;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (estimateTokens(characters.slice(start, middle).join('')) <= budget) {
        end = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (end < characters.length) {
      const minimumBreak = start + Math.floor((end - start) * 0.7);
      for (let index = end; index > minimumBreak; index -= 1) {
        if (/\s|[，。！？；,.!?;]/u.test(characters[index - 1])) {
          end = index;
          break;
        }
      }
    }

    const value = characters.slice(start, end).join('').trim();
    if (value) parts.push(value);
    start = Math.max(end, start + 1);
  }

  return parts;
}

function takeTailByBudget(text, budget) {
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  let start = characters.length;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateTokens(characters.slice(middle).join('')) <= budget) {
      start = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  return characters.slice(start).join('').trim();
}

function splitOversizedBlock(block) {
  if (estimateTokens(block.text) <= MAX_CHUNK_TOKENS) return [block];

  const baseBudget = MAX_CHUNK_TOKENS - OVERLAP_TOKENS;
  const atomicUnits = sentenceUnits(block.text).flatMap((sentence) =>
    estimateTokens(sentence) > baseBudget
      ? hardSplitByBudget(sentence, baseBudget)
      : [sentence]
  );
  const parts = [];
  let current = '';

  for (const unit of atomicUnits) {
    const candidate = current ? `${current}\n${unit}` : unit;
    if (current && estimateTokens(candidate) > baseBudget) {
      parts.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);

  return parts.map((part, index) => {
    if (!index) return { ...block, text: part };
    const overlap = takeTailByBudget(parts[index - 1], OVERLAP_TOKENS);
    return { ...block, text: overlap ? `${overlap}\n${part}` : part };
  });
}

export function chunkDocumentBlocks(blocks) {
  const normalized = blocks
    .map(normalizeBlock)
    .filter((block) => block.text)
    .flatMap(splitOversizedBlock);
  const chunks = [];
  let current = [];
  let currentTokens = 0;
  let currentHeading = '';

  const flush = () => {
    if (!current.length) return;
    const body = current.map((block) => block.text).join('\n\n').trim();
    const pages = current.flatMap((block) => [block.pageStart, block.pageEnd]).filter((page) => page > 0);
    const heading = currentHeading;
    chunks.push({
      text: heading ? `章节：${heading}\n\n${body}` : body,
      heading,
      type: [...new Set(current.map((block) => block.type))].join(','),
      pageStart: pages.length ? Math.min(...pages) : 0,
      pageEnd: pages.length ? Math.max(...pages) : 0,
      tokenCount: estimateTokens(body)
    });
    current = [];
    currentTokens = 0;
    currentHeading = '';
  };

  for (const block of normalized) {
    const blockTokens = estimateTokens(block.text);
    const headingChanged = current.length > 0 && block.heading !== currentHeading;
    const exceedsTarget = currentTokens >= MIN_CHUNK_TOKENS
      && currentTokens + blockTokens > TARGET_CHUNK_TOKENS;
    const exceedsMax = currentTokens + blockTokens > MAX_CHUNK_TOKENS;

    if (headingChanged || exceedsTarget || exceedsMax) flush();

    current.push(block);
    currentTokens += blockTokens;
    currentHeading = block.heading;
  }
  flush();

  return chunks;
}
