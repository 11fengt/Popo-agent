const STOP_WORDS = new Set([
  '的',
  '了',
  '和',
  '是',
  '在',
  '有',
  '与',
  '及',
  '或',
  '一个',
  '这个',
  '什么',
  '怎么',
  '如何'
]);

const segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' });
const technicalTokenPattern = /[a-z0-9]+(?:[._/@:-][a-z0-9]+)+/g;

export function tokenize(input) {
  const normalized = input.normalize('NFKC').toLowerCase();
  const wordTokens = [...segmenter.segment(normalized)]
    .filter((item) => item.isWordLike)
    .map((item) => item.segment.trim())
    .filter((token) => token && !STOP_WORDS.has(token));
  const technicalTokens = normalized.match(technicalTokenPattern) || [];

  return [...wordTokens, ...technicalTokens];
}

export function buildBm25Index(chunks) {
  const chunkById = new Map();
  const documentLengths = new Map();
  const documentFrequencies = new Map();
  const postings = new Map();
  let totalLength = 0;

  for (const chunk of chunks) {
    const tokens = Array.isArray(chunk.tokens) ? chunk.tokens : tokenize(chunk.text);
    const termFrequencies = new Map();

    chunkById.set(chunk.id, chunk);
    documentLengths.set(chunk.id, tokens.length);
    totalLength += tokens.length;

    for (const token of tokens) {
      termFrequencies.set(token, (termFrequencies.get(token) || 0) + 1);
    }

    for (const [token, frequency] of termFrequencies) {
      documentFrequencies.set(token, (documentFrequencies.get(token) || 0) + 1);
      if (!postings.has(token)) {
        postings.set(token, new Map());
      }
      postings.get(token).set(chunk.id, frequency);
    }
  }

  return {
    chunkById,
    documentLengths,
    documentFrequencies,
    postings,
    documentCount: chunks.length,
    averageDocumentLength: chunks.length ? totalLength / chunks.length : 0
  };
}

export function searchBm25(index, query, limit = 20, { k1 = 1.2, b = 0.75 } = {}) {
  if (!index.documentCount || !query.trim()) {
    return [];
  }

  const queryTerms = [...new Set(tokenize(query))];
  const scores = new Map();

  for (const term of queryTerms) {
    const matchingDocuments = index.documentFrequencies.get(term) || 0;
    const termPostings = index.postings.get(term);
    if (!matchingDocuments || !termPostings) continue;

    const idf = Math.log(
      1 + (index.documentCount - matchingDocuments + 0.5) / (matchingDocuments + 0.5)
    );

    for (const [chunkId, termFrequency] of termPostings) {
      const documentLength = index.documentLengths.get(chunkId) || 0;
      const lengthRatio = index.averageDocumentLength
        ? documentLength / index.averageDocumentLength
        : 0;
      const denominator = termFrequency + k1 * (1 - b + b * lengthRatio);
      const termScore = idf * ((termFrequency * (k1 + 1)) / denominator);
      scores.set(chunkId, (scores.get(chunkId) || 0) + termScore);
    }
  }

  return [...scores.entries()]
    .map(([chunkId, score]) => ({
      chunk: index.chunkById.get(chunkId),
      score
    }))
    .filter((item) => item.chunk && item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function reciprocalRankFusion(
  vectorResults,
  keywordResults,
  topK,
  { rankConstant = 60, vectorWeight = 1, keywordWeight = 1 } = {}
) {
  const merged = new Map();

  function mergeRanking(results, source, weight) {
    results.forEach((item, index) => {
      const existing = merged.get(item.chunk.id) || {
        chunk: item.chunk,
        rrfScore: 0,
        vectorRank: null,
        vectorScore: null,
        keywordRank: null,
        bm25Score: null
      };

      existing.rrfScore += weight / (rankConstant + index + 1);
      if (source === 'vector') {
        existing.vectorRank = index + 1;
        existing.vectorScore = item.score;
      } else {
        existing.keywordRank = index + 1;
        existing.bm25Score = item.score;
      }
      merged.set(item.chunk.id, existing);
    });
  }

  mergeRanking(vectorResults, 'vector', vectorWeight);
  mergeRanking(keywordResults, 'keyword', keywordWeight);

  return [...merged.values()]
    .sort((a, b) => {
      if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
      const aHits = Number(a.vectorRank !== null) + Number(a.keywordRank !== null);
      const bHits = Number(b.vectorRank !== null) + Number(b.keywordRank !== null);
      return bHits - aHits;
    })
    .slice(0, topK);
}
