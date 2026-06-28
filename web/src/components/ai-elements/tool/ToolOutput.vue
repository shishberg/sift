<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ output?: string; isError?: boolean }>();

const formatted = computed(() => {
  const raw = props.output ?? '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
});
</script>

<template>
  <div v-if="output" class="tool-section">
    <h4 class="tool-section-label">{{ props.isError ? 'Error' : 'Result' }}</h4>
    <pre class="tool-pre" :class="{ 'tool-pre-error': props.isError }">{{ formatted }}</pre>
  </div>
</template>
