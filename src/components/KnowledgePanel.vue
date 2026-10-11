<template>
  <aside class="knowledge-panel">
    <div class="knowledge-header">
      <div>
        <p class="section-label">Knowledge</p>
        <h2>向量知识库</h2>
      </div>
      <span class="knowledge-count">{{ documents.length }} 份</span>
    </div>

    <label class="upload-dropzone">
      <input accept=".md,.markdown,.txt,.pdf,.docx" multiple type="file" @change="handleFiles" />
      <strong>上传文件</strong>
      <span>支持 Markdown、TXT、文本型 PDF 和 Word（.docx）</span>
      <small>后端会按标题、段落和页码切片</small>
    </label>

    <div v-if="documents.length" class="knowledge-list">
      <article v-for="doc in documents" :key="doc.id" class="knowledge-item">
        <div class="knowledge-item-body">
          <strong>{{ doc.name }}</strong>
          <p>
            {{ formatTime(doc.createdAt) }}
            <span v-if="doc.chunkCount"> · {{ doc.chunkCount }} 个切片</span>
          </p>
        </div>
        <button class="inline-link" @click="$emit('remove', doc.id)">移除</button>
      </article>
    </div>
    <div v-else class="knowledge-empty">
      <p>暂无知识文档。上传后，Agent 可通过工具调用自动执行向量检索。</p>
    </div>

    <button v-if="documents.length" class="clear-button" @click="$emit('clear')">清空知识库</button>
  </aside>
</template>

<script setup lang="ts">
import type { KnowledgeDocument } from '@/types/chat';

const emit = defineEmits<{
  upload: [files: FileList];
  remove: [id: string];
  clear: [];
}>();

defineProps<{
  documents: KnowledgeDocument[];
}>();

function handleFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) {
    emit('upload', input.files);
    input.value = '';
  }
}

function formatTime(time: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(time);
}
</script>
