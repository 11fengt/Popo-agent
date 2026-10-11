import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBm25Index, reciprocalRankFusion, searchBm25, tokenize } from './retrieval.js';

function chunk(id, text) {
  return { id, text, tokens: tokenize(text) };
}

test('tokenize segments Chinese text and preserves technical identifiers', () => {
  const tokens = tokenize('如何处理 ERR_MCP_TOOL_401 和 text-embedding-v3？');

  assert(tokens.includes('处理'));
  assert(tokens.includes('err_mcp_tool_401'));
  assert(tokens.includes('text-embedding-v3'));
});

test('BM25 ranks exact keyword matches ahead of unrelated chunks', () => {
  const chunks = [
    chunk('a', '系统通过 retrieve_knowledge 工具检索知识库。'),
    chunk('b', 'Vue 页面使用虚拟列表提升渲染性能。'),
    chunk('c', '知识库支持向量语义检索。')
  ];
  const index = buildBm25Index(chunks);
  const results = searchBm25(index, 'retrieve_knowledge', 3);

  assert.equal(results[0]?.chunk.id, 'a');
  assert(results[0].score > 0);
});

test('RRF rewards chunks returned by both retrieval paths', () => {
  const a = chunk('a', '向量检索');
  const b = chunk('b', '混合检索');
  const c = chunk('c', '关键词检索');
  const results = reciprocalRankFusion(
    [
      { chunk: a, score: 0.9 },
      { chunk: b, score: 0.8 }
    ],
    [
      { chunk: b, score: 3.2 },
      { chunk: c, score: 2.1 }
    ],
    3
  );

  assert.equal(results[0].chunk.id, 'b');
  assert.equal(results[0].vectorRank, 2);
  assert.equal(results[0].keywordRank, 1);
});
