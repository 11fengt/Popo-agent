import { ChromaClient } from 'chromadb';
import { normalizeDocumentName } from './filename.js';

const UPSERT_BATCH_SIZE = 100;
const DELETE_BATCH_SIZE = 500;

function createStoreError(error, action) {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`ChromaDB ${action}失败`);
  wrapped.code = 'CHROMA_UNAVAILABLE';
  wrapped.details = `请先启动本地 Chroma 服务，并检查连接配置。原始错误：${message}`;
  wrapped.status = 503;
  return wrapped;
}

function chunkArray(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function toChunk(id, document, metadata = {}) {
  return {
    id,
    documentId: String(metadata.documentId || ''),
    documentName: normalizeDocumentName(metadata.documentName || '未知文档'),
    chunkIndex: Number(metadata.chunkIndex || 0),
    createdAt: Number(metadata.createdAt || Date.now()),
    fileType: String(metadata.fileType || ''),
    heading: String(metadata.heading || ''),
    pageStart: Number(metadata.pageStart || 0),
    pageEnd: Number(metadata.pageEnd || 0),
    blockType: String(metadata.blockType || 'paragraph'),
    text: document || ''
  };
}

export function createKnowledgeStore({
  host = '127.0.0.1',
  port = 8000,
  ssl = false,
  collectionName = 'yuan_agent_knowledge'
} = {}) {
  const client = new ChromaClient({ host, port, ssl });
  let collectionPromise = null;

  async function getCollection() {
    if (!collectionPromise) {
      collectionPromise = (async () => {
        await client.heartbeat();
        return client.getOrCreateCollection({
          name: collectionName,
          embeddingFunction: null,
          configuration: {
            hnsw: {
              space: 'cosine'
            }
          }
        });
      })().catch((error) => {
        collectionPromise = null;
        throw createStoreError(error, '连接');
      });
    }

    return collectionPromise;
  }

  async function runWithCollection(action, operation) {
    try {
      const collection = await getCollection();
      return await operation(collection);
    } catch (error) {
      if (error?.code === 'CHROMA_UNAVAILABLE') throw error;
      collectionPromise = null;
      throw createStoreError(error, action);
    }
  }

  async function listChunks() {
    return runWithCollection('加载知识库', async (collection) => {
      const count = await collection.count();
      if (!count) return [];

      const result = await collection.get({
        limit: count,
        include: ['documents', 'metadatas']
      });

      return result.ids.map((id, index) =>
        toChunk(id, result.documents[index], result.metadatas[index] || {})
      );
    });
  }

  async function upsertChunks(chunks) {
    if (!chunks.length) return;

    return runWithCollection('写入知识库', async (collection) => {
      for (const batch of chunkArray(chunks, UPSERT_BATCH_SIZE)) {
        await collection.upsert({
          ids: batch.map((chunk) => chunk.id),
          documents: batch.map((chunk) => chunk.text),
          embeddings: batch.map((chunk) => chunk.embedding),
          metadatas: batch.map((chunk) => ({
            documentId: chunk.documentId,
            documentName: chunk.documentName,
            chunkIndex: chunk.chunkIndex,
            createdAt: chunk.createdAt,
            fileType: chunk.fileType || '',
            heading: chunk.heading || '',
            pageStart: chunk.pageStart || 0,
            pageEnd: chunk.pageEnd || 0,
            blockType: chunk.blockType || 'paragraph'
          }))
        });
      }
    });
  }

  async function searchByVector(queryEmbedding, limit) {
    return runWithCollection('向量检索', async (collection) => {
      const count = await collection.count();
      if (!count) return [];

      const result = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: Math.min(limit, count),
        include: ['distances', 'documents', 'metadatas']
      });
      const rows = result.rows()[0] || [];

      return rows.map((row) => ({
        chunk: toChunk(row.id, row.document, row.metadata || {}),
        score: 1 - Number(row.distance ?? 1)
      }));
    });
  }

  async function deleteDocument(documentId) {
    return runWithCollection('删除文档', async (collection) => {
      await collection.delete({
        where: {
          documentId: { $eq: documentId }
        }
      });
    });
  }

  async function clear() {
    return runWithCollection('清空知识库', async (collection) => {
      const count = await collection.count();
      if (!count) return;

      const result = await collection.get({ limit: count, include: [] });
      for (const ids of chunkArray(result.ids, DELETE_BATCH_SIZE)) {
        await collection.delete({ ids });
      }
    });
  }

  return {
    listChunks,
    upsertChunks,
    searchByVector,
    deleteDocument,
    clear
  };
}
