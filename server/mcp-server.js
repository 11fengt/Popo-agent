import dotenv from 'dotenv';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chunkDocumentBlocks, parseTextDocument, SUPPORTED_DOCUMENT_EXTENSIONS } from './document-processing.js';
import { createKnowledgeStore } from './knowledge-store.js';
import { buildBm25Index, reciprocalRankFusion, searchBm25, tokenize } from './retrieval.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

const state = {
  documents: [],
  chunks: [],
  bm25Index: buildBm25Index([])
};

const config = {
  apiKey: process.env.QWEN_API_KEY,
  baseUrl: (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
  embeddingModel: process.env.QWEN_EMBEDDING_MODEL || 'text-embedding-v3',
  chromaHost: process.env.CHROMA_HOST || '127.0.0.1',
  chromaPort: Number(process.env.CHROMA_PORT || 8000),
  chromaSsl: process.env.CHROMA_SSL === 'true',
  chromaCollection: process.env.CHROMA_COLLECTION || 'yuan_agent_knowledge'
};

const knowledgeStore = createKnowledgeStore({
  host: config.chromaHost,
  port: config.chromaPort,
  ssl: config.chromaSsl,
  collectionName: config.chromaCollection
});

let knowledgeStatePromise = null;

async function ensureKnowledgeState() {
  if (!knowledgeStatePromise) {
    knowledgeStatePromise = (async () => {
      const chunks = await knowledgeStore.listChunks();
      const documents = new Map();

      state.chunks = chunks.map((chunk) => ({
        ...chunk,
        tokens: tokenize(chunk.text)
      }));

      for (const chunk of state.chunks) {
        if (!documents.has(chunk.documentId)) {
          documents.set(chunk.documentId, {
            id: chunk.documentId,
            name: chunk.documentName,
            content: '',
            createdAt: chunk.createdAt,
            fileType: chunk.fileType,
            chunkCount: 1
          });
        } else {
          documents.get(chunk.documentId).chunkCount += 1;
        }
      }

      state.documents = [...documents.values()];
      state.bm25Index = buildBm25Index(state.chunks);
    })().catch((error) => {
      knowledgeStatePromise = null;
      throw error;
    });
  }

  return knowledgeStatePromise;
}

function uid(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function createAppError(code, message, details = '', status = 500) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}

async function qwenFetch(endpoint, body) {
  if (!config.apiKey) {
    throw createAppError('MISSING_API_KEY', '缺少 Qwen API Key', '请检查服务端 `.env.local` 中的 `QWEN_API_KEY` 配置。', 500);
  }

  let response;
  try {
    response = await fetch(`${config.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw createAppError(
      'NETWORK_UNREACHABLE',
      '无法连接到 Qwen 服务',
      '当前运行环境访问 DashScope 失败。请检查网络、代理、VPN 或防火墙设置。',
      502
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 401) {
      throw createAppError('INVALID_API_KEY', 'Qwen API Key 无效或已过期', text || '请检查 `QWEN_API_KEY` 是否正确。', 401);
    }

    if (response.status === 429) {
      throw createAppError('RATE_LIMITED', 'Qwen 请求过于频繁', text || '请稍后重试，或检查账户配额是否充足。', 429);
    }

    throw createAppError('QWEN_HTTP_ERROR', `Qwen 请求失败（${response.status}）`, text || '上游模型服务返回异常响应。', 502);
  }

  return response.json();
}

async function createEmbedding(text) {
  const result = await qwenFetch('/embeddings', {
    model: config.embeddingModel,
    input: text.slice(0, 6000)
  });

  const vector = result.data?.[0]?.embedding;
  if (!vector) {
    throw createAppError('EMBEDDING_EMPTY', 'Embedding 生成失败', '模型返回为空，无法建立向量索引。', 502);
  }

  return vector;
}

function buildCitation(result) {
  const { chunk } = result;
  const retrievalDetails = [];
  if (result.vectorRank !== null) retrievalDetails.push(`向量 #${result.vectorRank}`);
  if (result.keywordRank !== null) retrievalDetails.push(`BM25 #${result.keywordRank}`);
  const locations = [];
  if (chunk.heading) locations.push(chunk.heading);
  if (chunk.pageStart) {
    locations.push(chunk.pageEnd > chunk.pageStart
      ? `第 ${chunk.pageStart}-${chunk.pageEnd} 页`
      : `第 ${chunk.pageStart} 页`);
  }
  const sourceLocation = locations.length ? ` / ${locations.join(' / ')}` : '';

  return {
    id: chunk.id,
    title: chunk.documentName,
    snippet: chunk.text,
    source: `混合检索 / ${chunk.documentName}${sourceLocation}${retrievalDetails.length ? `（${retrievalDetails.join(' · ')}）` : ''}`,
    score: Number(result.rrfScore.toFixed(4)),
    retrieval: {
      vectorRank: result.vectorRank,
      vectorScore: result.vectorScore === null ? null : Number(result.vectorScore.toFixed(4)),
      keywordRank: result.keywordRank,
      bm25Score: result.bm25Score === null ? null : Number(result.bm25Score.toFixed(4)),
      rrfScore: Number(result.rrfScore.toFixed(6))
    }
  };
}

async function searchByVector(query, limit) {
  const queryEmbedding = await createEmbedding(query);
  const results = await knowledgeStore.searchByVector(queryEmbedding, limit);
  return results.filter((item) => item.score > 0.15);
}

async function searchKnowledge(query, topK = 4) {
  await ensureKnowledgeState();

  if (!state.chunks.length) {
    return [];
  }

  const candidateLimit = Math.min(state.chunks.length, Math.max(topK * 5, 20));
  const keywordResults = searchBm25(state.bm25Index, query, candidateLimit);
  const vectorResults = await searchByVector(query, candidateLimit);

  return reciprocalRankFusion(vectorResults, keywordResults, topK)
    .map((result) => buildCitation(result));
}

async function ingestDocuments(documents) {
  await ensureKnowledgeState();

  const supported = documents.filter((document) =>
    SUPPORTED_DOCUMENT_EXTENSIONS.some((extension) => document.name.toLowerCase().endsWith(extension))
  );

  if (!supported.length) {
    throw createAppError(
      'UNSUPPORTED_FILES',
      '没有可导入的知识文件',
      '仅支持 Markdown（.md、.markdown）、TXT、文本型 PDF 和 Word（.docx）。',
      400
    );
  }

  const inserted = [];
  const nextDocuments = [];
  const nextChunks = [];

  for (const source of supported) {
    const blocks = Array.isArray(source.blocks) && source.blocks.length
      ? source.blocks
      : parseTextDocument(source.name, source.content || '');
    const parts = chunkDocumentBlocks(blocks);
    if (!parts.length) continue;

    const document = {
      id: uid('doc'),
      name: source.name,
      content: '',
      createdAt: Date.now(),
      fileType: source.fileType || source.name.split('.').pop()?.toLowerCase() || 'unknown',
      chunkCount: parts.length
    };

    nextDocuments.push(document);
    inserted.push({
      id: document.id,
      name: document.name,
      createdAt: document.createdAt,
      fileType: document.fileType,
      chunkCount: parts.length
    });

    for (const [chunkIndex, part] of parts.entries()) {
      const embedding = await createEmbedding(part.text);
      nextChunks.push({
        id: uid('chunk'),
        documentId: document.id,
        documentName: document.name,
        chunkIndex,
        createdAt: document.createdAt,
        fileType: document.fileType,
        heading: part.heading,
        pageStart: part.pageStart,
        pageEnd: part.pageEnd,
        blockType: part.type,
        text: part.text,
        tokens: tokenize(part.text),
        embedding
      });
    }
  }

  if (!inserted.length) {
    throw createAppError('EMPTY_FILES', '上传的文件内容为空', '请确认文件不是空文件，且编码为 UTF-8。', 400);
  }

  await knowledgeStore.upsertChunks(nextChunks);

  state.documents.push(...nextDocuments);
  state.chunks.push(...nextChunks.map(({ embedding: _, ...chunk }) => chunk));
  state.bm25Index = buildBm25Index(state.chunks);

  return inserted;
}

async function listDocuments() {
  await ensureKnowledgeState();
  return state.documents.map((document) => ({
    id: document.id,
    name: document.name,
    createdAt: document.createdAt,
    fileType: document.fileType,
    chunkCount: document.chunkCount
  }));
}

async function deleteDocument(id) {
  await ensureKnowledgeState();

  const before = state.documents.length;
  if (!state.documents.some((document) => document.id === id)) {
    throw createAppError('DOCUMENT_NOT_FOUND', '知识文件不存在', '请确认传入的文档 ID 是否正确。', 404);
  }

  await knowledgeStore.deleteDocument(id);
  state.documents = state.documents.filter((document) => document.id !== id);
  state.chunks = state.chunks.filter((chunk) => chunk.documentId !== id);
  state.bm25Index = buildBm25Index(state.chunks);

  return { ok: before > state.documents.length, id };
}

async function clearDocuments() {
  await ensureKnowledgeState();
  await knowledgeStore.clear();
  state.documents = [];
  state.chunks = [];
  state.bm25Index = buildBm25Index([]);
  return { ok: true };
}

function toTextContent(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: value
  };
}

function toErrorContent(error) {
  return {
    content: [
      {
        type: 'text',
        text: error.details ? `${error.message}\n${error.details}` : error.message
      }
    ],
    structuredContent: {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message,
      details: error.details || '',
      status: error.status || 500
    },
    isError: true
  };
}

const server = new McpServer({
  name: 'yuan-agent-mcp-server',
  version: '1.0.0'
});

server.registerTool(
  'retrieve_knowledge',
  {
    description: '通过向量语义召回、BM25 关键词召回与 RRF 融合，从知识库检索最相关的文档片段',
    inputSchema: z.object({
      query: z.string().min(1, 'query 不能为空'),
      topK: z.number().int().min(1).max(10).optional()
    })
  },
  async ({ query, topK = 4 }) => {
    try {
      const citations = await searchKnowledge(query, topK);
      return toTextContent({ citations, count: citations.length });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'list_knowledge_documents',
  {
    description: '列出当前后端知识库中的文档',
    inputSchema: z.object({})
  },
  async () => {
    try {
      return toTextContent({ documents: await listDocuments() });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'ingest_knowledge_documents',
  {
    description: '导入已解析的 Markdown、TXT、文本型 PDF 或 DOCX 文档，并建立结构化向量索引',
    inputSchema: z.object({
      documents: z.array(
        z.object({
          name: z.string().min(1, 'name 不能为空'),
          fileType: z.string().optional(),
          content: z.string().optional(),
          blocks: z.array(
            z.object({
              text: z.string().min(1, 'block text 不能为空'),
              type: z.string().optional(),
              heading: z.string().optional(),
              pageStart: z.number().int().nonnegative().optional(),
              pageEnd: z.number().int().nonnegative().optional()
            })
          ).optional()
        })
      ).min(1, '至少导入一份文档')
    })
  },
  async ({ documents }) => {
    try {
      const inserted = await ingestDocuments(documents);
      return toTextContent({ documents: inserted, message: `已成功导入 ${inserted.length} 份知识文件。` });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'delete_knowledge_document',
  {
    description: '删除指定的知识文档以及对应的向量索引',
    inputSchema: z.object({
      id: z.string().min(1, 'id 不能为空')
    })
  },
  async ({ id }) => {
    try {
      return toTextContent(await deleteDocument(id));
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'clear_knowledge_documents',
  {
    description: '清空知识库中的所有文档与向量索引',
    inputSchema: z.object({})
  },
  async () => {
    try {
      return toTextContent(await clearDocuments());
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'get_current_time',
  {
    description: '获取当前系统时间',
    inputSchema: z.object({})
  },
  async () =>
    toTextContent({
      iso: new Date().toISOString(),
      locale: new Date().toLocaleString('zh-CN', { hour12: false })
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
