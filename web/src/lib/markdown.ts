import MarkdownIt from 'markdown-it';

// html: false escapes raw HTML in the source, so rendering the output with
// v-html is safe — message text can't inject markup. linkify turns bare URLs
// into links; breaks keeps single newlines as <br> so transcripts read naturally.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

// Open links in a new tab so clicking one in a transcript doesn't lose the page.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(text: string): string {
  return md.render(text);
}
