<script setup lang="ts">
import { ref } from 'vue';
import { copyText } from '@/lib/clipboard';

const props = defineProps<{ text: string; title?: string }>();
const copied = ref(false);

async function doCopy(): Promise<void> {
  const ok = await copyText(props.text);
  if (!ok) return;
  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, 1200);
}
</script>

<template>
  <button class="copy-btn" :title="title ?? 'Copy'" @click.stop.prevent="doCopy">
    <span v-if="copied" class="copy-check">✓</span>
    <svg
      v-else
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  </button>
</template>
