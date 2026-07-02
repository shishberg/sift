import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHistory } from 'vue-router';
import MessageActions from './MessageActions.vue';

vi.mock('@/lib/clipboard', () => ({
  copyText: vi.fn().mockResolvedValue(true),
}));
import { copyText } from '@/lib/clipboard';

async function mountActions(overrides: Partial<InstanceType<typeof MessageActions>['$props']> = {}) {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/session/:id', name: 'session', component: { template: '<div />' } },
    ],
  });
  await router.push('/session/abc?q=hello');
  await router.isReady();

  const wrapper = mount(MessageActions, {
    props: {
      sessionId: 'sess-123',
      filePath: '/logs/sess-123.jsonl',
      lineNumbers: [42, 43],
      text: 'the message text',
      ...overrides,
    },
    global: { plugins: [router] },
  });
  return { wrapper, router };
}

describe('MessageActions', () => {
  beforeEach(() => {
    vi.mocked(copyText).mockClear();
  });

  it('copies the message text', async () => {
    const { wrapper } = await mountActions();
    await wrapper.find('[aria-label="Copy message text"]').trigger('click');
    expect(copyText).toHaveBeenCalledWith('the message text');
  });

  it('copies "sessionId:line" using the first line number', async () => {
    const { wrapper } = await mountActions();
    await wrapper.find('[aria-label="Copy message id"]').trigger('click');
    expect(copyText).toHaveBeenCalledWith('sess-123:42');
  });

  it('shows just the line number as the id button tooltip', async () => {
    const { wrapper } = await mountActions();
    expect(wrapper.find('[aria-label="Copy message id"]').attributes('title')).toBe('42');
  });

  it('links to the session with file/line query params, carrying q along', async () => {
    const { wrapper } = await mountActions();
    const href = wrapper.find('[aria-label="Link to this message"]').attributes('href');
    expect(href).toBe('/session/sess-123?q=hello&file=/logs/sess-123.jsonl&line=42');
  });

  it('falls back to line 0 when there are no line numbers', async () => {
    const { wrapper } = await mountActions({ lineNumbers: [] });
    await wrapper.find('[aria-label="Copy message id"]').trigger('click');
    expect(copyText).toHaveBeenCalledWith('sess-123:0');
  });
});
