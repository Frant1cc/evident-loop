<script setup lang="ts">
import { ref } from 'vue';
import WebEvaluationView from './WebEvaluationView.vue';
import RagEvaluationView from './RagEvaluationView.vue';
const mode = ref<'web' | 'rag'>('web');
</script>
<template>
  <div class="hub">
    <div class="tabs"><button :class="{ active: mode === 'web' }" @click="mode = 'web'">联网检索评测</button><button :class="{ active: mode === 'rag' }" @click="mode = 'rag'">知识库 RAG 评测</button></div>
    <WebEvaluationView v-if="mode === 'web'" /><RagEvaluationView v-else />
  </div>
</template>
<style scoped>
.hub{height:100%;min-height:0}.tabs{display:flex;gap:4px;border-bottom:1px solid var(--agent-border,#ddd);background:var(--agent-surface,#fff);padding:9px 18px}.tabs button{border:1px solid transparent;border-radius:6px;background:transparent;color:var(--agent-text-muted,#666);font-size:13px;font-weight:750;padding:7px 11px;cursor:pointer}.tabs button.active{border-color:var(--agent-border,#ddd);background:var(--agent-surface-muted,#f2f2ee);color:var(--agent-text,#222)}
</style>
