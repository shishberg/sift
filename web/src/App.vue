<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { RouterView } from 'vue-router';
import { Progress } from '@/components/ui/progress';
import type { StatusResponse } from './types';

const status = ref<StatusResponse>({ total: 0, embedded: 0, pending: 0 });
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchStatus(): Promise<void> {
  try {
    const res = await fetch('/api/status');
    if (res.ok) {
      status.value = (await res.json()) as StatusResponse;
    }
  } catch {
    // Server not reachable — keep last value.
  }
}

const progressValue = computed((): number => {
  const { total, embedded } = status.value;
  if (total === 0) return 100; // Nothing to embed → show as complete.
  return Math.round((embedded / total) * 100);
});

const isIndexing = computed((): boolean => status.value.pending > 0);

onMounted(() => {
  void fetchStatus();
  pollTimer = setInterval(() => void fetchStatus(), 1500);
});

onUnmounted(() => {
  if (pollTimer !== null) clearInterval(pollTimer);
});
</script>

<template>
  <div class="min-h-screen flex flex-col" style="background-color: var(--bg); color: var(--fg)">
    <!-- Header -->
    <header
      class="sticky top-0 z-10 flex items-center justify-between px-6 h-12 border-b"
      style="
        background: var(--white);
        border-color: var(--border);
        min-height: 48px;
      "
    >
      <!-- Logo -->
      <RouterLink
        to="/"
        class="flex items-center gap-2 no-underline"
        style="color: var(--fg); text-decoration: none"
      >
        <span
          class="font-mono"
          style="font-size: 15px; font-weight: 500; letter-spacing: -0.01em"
        >
          <span style="color: var(--violet)">◈</span> agent-search
        </span>
      </RouterLink>

      <!-- Embedding progress -->
      <div class="flex items-center gap-3" style="min-width: 220px">
        <div class="flex flex-col gap-1" style="flex: 1">
          <Progress :model-value="progressValue" class="h-1.5" />
        </div>
        <span
          class="font-mono whitespace-nowrap"
          style="font-size: 11px; color: var(--muted-fg); letter-spacing: 0.02em"
        >
          <span v-if="isIndexing" style="color: var(--violet)">●</span>
          <span v-else>○</span>
          {{ status.embedded }}/{{ status.total }}
          <span v-if="isIndexing"> · {{ status.pending }} pending</span>
        </span>
      </div>
    </header>

    <!-- Page content -->
    <main class="flex-1">
      <RouterView />
    </main>
  </div>
</template>
