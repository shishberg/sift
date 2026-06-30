<script setup lang="ts">
import { onUnmounted, nextTick, computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { SessionResponse, TranscriptItem } from '@/types';
import { renderMarkdown } from '@/lib/markdown';
import { sessionHeader, resetSessionHeader } from '@/lib/sessionHeader';
import { Message, MessageContent } from '@/components/ai-elements/message';
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import { Compaction, CompactionHeader, CompactionContent } from '@/components/ai-elements/compaction';

const route = useRoute();

const sessionId = computed(() => route.params.id as string);
const matchFile = computed(() => (route.query.file as string | undefined) ?? '');
const matchLine = computed(() => parseInt((route.query.line as string | undefined) ?? '0', 10));

const session = ref<SessionResponse | null>(null);
const loading = ref(true);
const error = ref('');

async function loadSession(): Promise<void> {
  loading.value = true;
  error.value = '';
  resetSessionHeader();
  sessionHeader.active = true;
  sessionHeader.sessionId = sessionId.value;
  try {
    const res = await fetch('/api/session/' + encodeURIComponent(sessionId.value));
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      error.value = body.error ?? ('Server error ' + res.status);
      loading.value = false;
      return;
    }
    session.value = (await res.json()) as SessionResponse;
    sessionHeader.agentType = session.value.agentType;
    sessionHeader.filePath = session.value.filePath;
    sessionHeader.cwd = session.value.cwd;
    loading.value = false;
    await nextTick();
    scrollToMatch();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not load session.';
    loading.value = false;
  }
}

function isMatch(item: TranscriptItem): boolean {
  return item.filePath === matchFile.value && item.lineNumbers.includes(matchLine.value);
}

function scrollToMatch(): void {
  const el = document.querySelector('[data-matched]') as HTMLElement | null;
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderedHtml(text: string): string {
  return renderMarkdown(text);
}

function itemKey(item: TranscriptItem): string {
  return item.filePath + ':' + item.lineNumbers.join('-');
}

// A call with no paired result shows as Pending rather than Completed.
function toolStatus(item: TranscriptItem): 'completed' | 'pending' | 'error' {
  if (item.tool?.isError) return 'error';
  if (item.tool?.output === undefined) return 'pending';
  return 'completed';
}

// Load whenever the session id changes. This covers the first mount AND
// navigating from one open session to another: vue-router reuses this same
// component instance across /session/:id routes, so onMounted would not refire.
watch(sessionId, () => void loadSession(), { immediate: true });

// Clicking another result within the already-open session changes the matched
// file/line but not the id, so the loader above won't run — just re-scroll.
watch([matchFile, matchLine], async () => {
  if (loading.value || !session.value) return;
  await nextTick();
  scrollToMatch();
});

onUnmounted(() => {
  resetSessionHeader();
});
</script>

<template>
  <div style="max-width: 760px; margin: 0 auto; padding: 28px 24px 48px">
    <div v-if="loading" style="color: var(--muted-fg); font-size: 14px; padding-top: 32px; text-align: center">
      Loading…
    </div>

    <div
      v-if="error"
      class="rounded-md px-4 py-3"
      style="background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b; font-size: 13px"
    >
      {{ error }}
    </div>

    <div v-if="!loading && !error && session" class="flex flex-col" style="gap: 16px">
      <template v-for="(item, index) in session.items" :key="itemKey(item) + ':' + index">
        <!-- Compaction event (role is a placeholder; branch on `compaction` first) -->
        <div
          v-if="item.compaction"
          :data-matched="isMatch(item) ? '' : undefined"
          :class="['transcript-row', isMatch(item) ? 'chunk-matched' : '']"
        >
          <Compaction :default-open="isMatch(item)">
            <CompactionHeader :trigger="item.compaction.trigger" :tokens-before="item.compaction.tokensBefore" />
            <CompactionContent :summary="item.compaction.summary" />
          </Compaction>
        </div>

        <!-- Tool call -->
        <div
          v-else-if="item.role === 'tool'"
          :data-matched="isMatch(item) ? '' : undefined"
          :class="['transcript-row', isMatch(item) ? 'chunk-matched' : '']"
        >
          <Tool :default-open="isMatch(item)">
            <ToolHeader :name="item.tool?.name ?? 'tool'" :status="toolStatus(item)" />
            <ToolContent>
              <ToolInput v-if="item.tool?.input" :input="item.tool.input" />
              <ToolOutput :output="item.tool?.output" :is-error="item.tool?.isError" />
            </ToolContent>
          </Tool>
        </div>

        <!-- User / assistant message -->
        <div
          v-else
          :data-matched="isMatch(item) ? '' : undefined"
          :class="['transcript-row', isMatch(item) ? 'chunk-matched' : '']"
        >
          <Message :from="item.role">
            <MessageContent>
              <div class="md-body" v-html="renderedHtml(item.text)"></div>
            </MessageContent>
          </Message>
        </div>
      </template>

      <div v-if="session.items.length === 0" style="color: var(--muted-fg); font-size: 14px">
        This session has no readable messages.
      </div>
    </div>
  </div>
</template>
