# RAG 检索评测集

`rag-recall-cases.json` 是依据 4 份真实制度文档人工整理的 32 条正例问题，每份文档 8 条。

## 这份数据如何用于 Recall@3

对每条 `question` 执行当前的混合检索并取 Top 3。如果至少一个返回切片：

1. `documentName` 等于 `expectedDocument`；
2. 对 PDF，切片页码与 `relevantPages` 至少有一页重叠；
3. 切片正文包含足够的 `evidenceKeywords`，能够支持 `referenceAnswer`；

则该题记为命中。最终：

```text
Recall@3 = 命中题数 / 32
```

`referenceAnswer` 用于人工检查标注和检索切片是否真的包含答案，不用于评价模型最终生成的回答。DOCX 当前没有页码元数据，因此广府人助学金的题目使用文档名与证据关键词定位。

这批题只评估“能否召回正确证据”，不评估回答是否通顺、是否忠于原文。正式写入简历前，应先上传这 4 份文档，在同一套数据和参数下实际运行并保存命中明细。

## 运行评测

先启动本地 Chroma 服务，并确认四份评测文档已经上传，然后在项目根目录执行：

```bash
npm run eval:recall
```

脚本对每个问题只生成一次查询向量，并用它同时测试：

- 纯向量检索基线；
- 当前的向量检索 + BM25 + RRF 融合检索。

终端会显示两种方法的命中情况和 Recall@3，完整结果保存在 `eval/recall-report.json`，其中包含每道题的 Top 3、相关切片位置和失败明细。

可以通过参数更换数据集、输出文件或 K 值：

```bash
npm run eval:recall -- --dataset=eval/rag-recall-cases.json --output=eval/recall-report.json --k=3
```
