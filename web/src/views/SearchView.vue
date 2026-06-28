<script setup lang="ts">
// The search box + results now live in the persistent left sidebar
// (SearchSidebar.vue). This view is just the main-panel placeholder shown at
// `/`, before a session is opened.
</script>

<template>
  <div
    class="flex flex-col items-center justify-center text-center px-6"
    style="min-height: 100%; color: var(--muted-fg); font-size: 14px; line-height: 1.8"
  >
    <p class="m-0" style="font-size: 24px; opacity: 0.5">◈</p>
    <p class="m-0 mt-3">Search in the sidebar to find a moment in your sessions.</p>
    <p class="m-0">Pick a result to open the full transcript here.</p>
  </div>
</template>
