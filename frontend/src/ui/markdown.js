// Minimal Markdown for the app's own content (the setup guide): # / ## / ### headings, paragraphs,
// - and 1. lists, ``` code blocks, ![alt](/assets/...) images on their own line, and **bold** /
// `code` inline. Text always becomes text nodes, never HTML.
import { h } from './dom.js';
import { icons } from './icons.js';
import { t } from '../core/i18n.js';

/** Splits a line into text / strong / code runs. */
export function parseInline(text) {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith('**') && part.endsWith('**') && part.length > 4
        ? { type: 'strong', text: part.slice(2, -2) }
        : part.startsWith('`') && part.endsWith('`') && part.length > 2
          ? { type: 'code', text: part.slice(1, -1) }
          : { type: 'text', text: part },
    );
}

/** @returns {Array<{ type: 'heading', level: number, inline } | { type: 'p', inline } | { type: 'ul' | 'ol', items } | { type: 'code', text } | { type: 'img', alt, src }>} */
export function parseMarkdown(source) {
  const blocks = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let paragraph = null;
  let list = null; // the list the previous line added an item to
  const endParagraph = () => {
    if (paragraph) blocks.push({ type: 'p', inline: parseInline(paragraph.join(' ')) });
    paragraph = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    if ((match = /^\s*(?:([-*])|\d+\.)\s+(.*)$/.exec(line))) {
      endParagraph();
      const type = match[1] ? 'ul' : 'ol';
      if (list?.type !== type) blocks.push((list = { type, items: [] }));
      list.items.push(parseInline(match[2].trim()));
      continue;
    }
    list = null;
    if (line.startsWith('```')) {
      endParagraph();
      const code = [];
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
      blocks.push({ type: 'code', text: code.join('\n') });
    } else if ((match = /^(#{1,3})\s+(.*)$/.exec(line))) {
      endParagraph();
      blocks.push({ type: 'heading', level: match[1].length, inline: parseInline(match[2].trim()) });
    } else if ((match = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line))) {
      endParagraph();
      // Only the app's own bundled images.
      if (match[2].startsWith('/assets/')) blocks.push({ type: 'img', alt: match[1], src: match[2] });
    } else if (!line.trim()) {
      endParagraph();
    } else {
      (paragraph ??= []).push(line.trim());
    }
  }
  endParagraph();
  return blocks;
}

const inlineNodes = (runs) =>
  runs.map((run) => (run.type === 'strong' ? h('strong', {}, run.text) : run.type === 'code' ? h('code', {}, run.text) : run.text));

/** A code block with a pill that copies it (the guide's commands are meant to be pasted). */
function codeBlock(text) {
  const label = h('span', {}, t('Copy'));
  const button = h('button', { type: 'button', class: 'code-copy', 'aria-label': t('Copy command'), html: icons.copy }, label);
  let timer;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      label.textContent = t('Copied!');
    } catch {
      label.textContent = t('Select and copy');
    }
    clearTimeout(timer);
    timer = setTimeout(() => (label.textContent = t('Copy')), 1500);
  });
  return h('div', { class: 'code-block' }, h('pre', {}, h('code', {}, text)), button);
}

/** @returns {DocumentFragment} */
export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(source)) {
    if (block.type === 'heading') fragment.append(h(`h${block.level + 1}`, {}, inlineNodes(block.inline)));
    else if (block.type === 'p') fragment.append(h('p', {}, inlineNodes(block.inline)));
    else if (block.type === 'code') fragment.append(codeBlock(block.text));
    else if (block.type === 'img') fragment.append(h('img', { src: block.src, alt: block.alt, loading: 'lazy' }));
    else fragment.append(h(block.type, {}, block.items.map((item) => h('li', {}, inlineNodes(item)))));
  }
  return fragment;
}
