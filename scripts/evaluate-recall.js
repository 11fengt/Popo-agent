import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { createKnowledgeStore } from '../server/knowledge-store.js';
import {
  buildBm25Index,
  reciprocalRankFusion,
  searchBm25,
  tokenize
} from '../server/retrieval.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

const DEFAULT_DATASET_PATH = path.resolve(process.cwd(), 'eval/rag-recall-cases.json');
const DEFAULT_REPORT_PATH = path.resolve(process.cwd(), 'eval/recall-report.json');
const VECTOR_SCORE_THRESHOLD = 0.15;

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\\\s]/g, '');
}

function overlapsRelevantPage(chunk, pages) {
  if (!pages.length) return true;
  return pages.some((page) => page >= chunk.pageStart && page <= chunk.pageEnd);
}

function keywordCoverage(chunk, keywords) {
  if (!keywords.length) return 1;
  const text = normalize(chunk.text);
  return keywords.filter((keyword) => text.includes(normalize(keyword))).length / keywords.length;
}

function resolveGoldChunks(testCase, chunks) {
  const expectedName = normalize(testCase.expectedDocument);
  const documentChunks = chunks.filter(
    (chunk) => normalize(chunk.documentName) === expectedName
  );

  if (!documentChunks.length) {
    throw new Error(`知识库缺少评测文档：${testCase.expectedDocument}`);
  }

  const locationChunks = documentChunks.filter((chunk) =>
    overlapsRelevantPage(chunk, testCase.relevantPages || [])
  );

  if (!locationChunks.length) {
    throw new Error(
      `${testCase.id} 无法找到标注页：${testCase.expectedDocument} ` +
      `${JSON.stringify(testCase.relevantPages)}`
    );
  }

  const scored = locationChunks.map((chunk) => ({
    chunk,
    coverage: keywordCoverage(chunk, testCase.evidenceKeywords || [])
  }));
  const bestCoverage = Math.max(...scored.map((item) => item.coverage));

  if (bestCoverage === 0) {
    throw new Error(`${testCase.id} 的证据关键词没有出现在标注切片中`);
  }

  return {
    chunks: scored
      .filter((item) => item.coverage === bestCoverage)
      .map((item) => item.chunk),
    bestCoverage
  };
}

async function createEmbedding(text, config) {
  let response;
  try {
    response = await fetch(`${config.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: text.slice(0, 6000)
      })
    });
  } catch (error) {
    throw new Error(`无法连接 Embedding 服务：${error instanceof Error ? error.message : error}`);
  }

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`Embedding 请求失败（HTTP ${response.status}）：${details}`);
  }

  const payload = await response.json();
  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || !embedding.length) {
    throw new Error('Embedding 服务没有返回有效向量');
  }
  return embedding;
}

function summarizeResult(results, goldIds) {
  const firstGoldIndex = results.findIndex((item) => goldIds.has(item.chunk.id));
  return {
    hit: firstGoldIndex >= 0,
    firstRelevantRank: firstGoldIndex >= 0 ? firstGoldIndex + 1 : null,
    topResults: results.map((item, index) => ({
      rank: index + 1,
      chunkId: item.chunk.id,
      documentName: item.chunk.documentName,
      pageStart: item.chunk.pageStart,
      pageEnd: item.chunk.pageEnd,
      vectorScore: item.vectorScore ?? item.score ?? null,
      bm25Score: item.bm25Score ?? null,
      rrfScore: item.rrfScore ?? null,
      relevant: goldIds.has(item.chunk.id),
      snippet: item.chunk.text.slice(0, 180)
    }))
  };
}

function calculateMetrics(caseResults, key, k) {
  const hits = caseResults.filter((item) => item[key].hit).length;
  return {
    name: key === 'vectorOnly' ? '纯向量检索基线' : '向量 + BM25 + RRF',
    k,
    hits,
    total: caseResults.length,
    recallAtK: hits / caseResults.length,
    recallAtKPercent: Number(((hits / caseResults.length) * 100).toFixed(2))
  };
}

async function main() {
  const datasetPath = path.resolve(readArgument('dataset', DEFAULT_DATASET_PATH));
  const reportPath = path.resolve(readArgument('output', DEFAULT_REPORT_PATH));
  const k = Number(readArgument('k', '3'));
  if (!Number.isInteger(k) || k < 1) {
    throw new Error('--k 必须是正整数');
  }

  const config = {
    apiKey: process.env.QWEN_API_KEY,
    baseUrl: (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1')
      .replace(/\/$/, ''),
    embeddingModel: process.env.QWEN_EMBEDDING_MODEL || 'text-embedding-v3',
    chromaHost: process.env.CHROMA_HOST || '127.0.0.1',
    chromaPort: Number(process.env.CHROMA_PORT || 8000),
    chromaSsl: process.env.CHROMA_SSL === 'true',
    chromaCollection: process.env.CHROMA_COLLECTION || 'yuan_agent_knowledge'
  };

  if (!config.apiKey) {
    throw new Error('缺少 QWEN_API_KEY，请检查 .env.local');
  }

  const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
  const store = createKnowledgeStore({
    host: config.chromaHost,
    port: config.chromaPort,
    ssl: config.chromaSsl,
    collectionName: config.chromaCollection
  });
  const storedChunks = await store.listChunks();
  const chunks = storedChunks.map((chunk) => ({
    ...chunk,
    tokens: tokenize(chunk.text)
  }));

  if (!chunks.length) {
    throw new Error('ChromaDB 中没有知识库切片');
  }

  const availableDocuments = new Set(chunks.map((chunk) => normalize(chunk.documentName)));
  const missingDocuments = dataset.documents.filter(
    (documentName) => !availableDocuments.has(normalize(documentName))
  );
  if (missingDocuments.length) {
    throw new Error(`请先上传评测所需文档：${missingDocuments.join('、')}`);
  }

  const bm25Index = buildBm25Index(chunks);
  const candidateLimit = Math.min(chunks.length, Math.max(k * 5, 20));
  const caseResults = [];

  for (const [index, testCase] of dataset.cases.entries()) {
    process.stdout.write(`[${index + 1}/${dataset.cases.length}] ${testCase.id} `);

    const gold = resolveGoldChunks(testCase, chunks);
    const goldIds = new Set(gold.chunks.map((chunk) => chunk.id));
    const embedding = await createEmbedding(testCase.question, config);
    const vectorCandidates = (await store.searchByVector(embedding, candidateLimit))
      .filter((item) => item.score > VECTOR_SCORE_THRESHOLD);
    const keywordCandidates = searchBm25(bm25Index, testCase.question, candidateLimit);

    const vectorOnlyResults = vectorCandidates.slice(0, k);
    const hybridResults = reciprocalRankFusion(
      vectorCandidates,
      keywordCandidates,
      k
    );
    const vectorOnly = summarizeResult(vectorOnlyResults, goldIds);
    const hybrid = summarizeResult(hybridResults, goldIds);

    caseResults.push({
      id: testCase.id,
      question: testCase.question,
      expectedDocument: testCase.expectedDocument,
      relevantPages: testCase.relevantPages,
      goldChunkIds: [...goldIds],
      goldKeywordCoverage: Number(gold.bestCoverage.toFixed(4)),
      vectorOnly,
      hybrid
    });

    process.stdout.write(`vector=${vectorOnly.hit ? 'hit' : 'miss'}, hybrid=${hybrid.hit ? 'hit' : 'miss'}\n`);
  }

  const vectorOnly = calculateMetrics(caseResults, 'vectorOnly', k);
  const hybrid = calculateMetrics(caseResults, 'hybrid', k);
  const absolutePercentagePoints = Number(
    (hybrid.recallAtKPercent - vectorOnly.recallAtKPercent).toFixed(2)
  );
  const relativePercent = vectorOnly.recallAtK === 0
    ? null
    : Number((((hybrid.recallAtK - vectorOnly.recallAtK) / vectorOnly.recallAtK) * 100).toFixed(2));

  const report = {
    generatedAt: new Date().toISOString(),
    dataset: path.relative(process.cwd(), datasetPath).replaceAll('\\', '/'),
    collection: config.chromaCollection,
    embeddingModel: config.embeddingModel,
    chunkCount: chunks.length,
    candidateLimit,
    vectorScoreThreshold: VECTOR_SCORE_THRESHOLD,
    evaluationRule: '每题 Top K 中至少出现一个人工标注的相关切片即记为命中',
    methods: {
      vectorOnly,
      hybrid
    },
    improvement: {
      additionalHits: hybrid.hits - vectorOnly.hits,
      absolutePercentagePoints,
      relativePercent
    },
    cases: caseResults
  };

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('\n评测完成');
  console.log(`纯向量 Recall@${k}: ${vectorOnly.hits}/${vectorOnly.total} = ${vectorOnly.recallAtKPercent}%`);
  console.log(`混合检索 Recall@${k}: ${hybrid.hits}/${hybrid.total} = ${hybrid.recallAtKPercent}%`);
  console.log(`绝对提升: ${absolutePercentagePoints} 个百分点`);
  console.log(`相对提升: ${relativePercent === null ? '基线为 0，无法计算' : `${relativePercent}%`}`);
  console.log(`详细报告: ${path.relative(process.cwd(), reportPath)}`);
}

main().catch((error) => {
  console.error(`评测失败：${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
