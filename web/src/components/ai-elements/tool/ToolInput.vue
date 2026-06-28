<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ input: string }>();

const formatted = computed(() => {
  try {
    return JSON.stringify(JSON.parse(props.input), null, 2);
  } catch {
    return props.input;
  }
});
</script>

<template>
  <div class="tool-section">
    <h4 class="tool-section-label">Parameters</h4>
    <pre class="tool-pre">{{ formatted }}</pre>
  </div>
</template>
