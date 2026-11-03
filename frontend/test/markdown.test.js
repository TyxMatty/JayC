import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline } from '../src/ui/markdown.js';

test('inline: bold and code, everything else is plain text', () => {
  assert.deepEqual(parseInline('Run **once**: `docker compose up -d` <b>x</b>'), [
    { type: 'text', text: 'Run ' },
    { type: 'strong', text: 'once' },
    { type: 'text', text: ': ' },
    { type: 'code', text: 'docker compose up -d' },
    { type: 'text', text: ' <b>x</b>' },
  ]);
});

test('blocks: headings, paragraphs, lists, code, images', () => {
  const blocks = parseMarkdown(
    [
      '# Title',
      'First line',
      'same paragraph.',
      '',
      '- a',
      '- b',
      '1. one',
      '2. two',
      'after',
      '```',
      'ipconfig',
      '  <keep spaces>',
      '```',
      '![Ports](/assets/setup/step3_firewall.svg)',
      '![Remote](https://example.com/x.png)',
    ].join('\r\n'),
  );
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading', 'p', 'ul', 'ol', 'p', 'code', 'img'],
    'the remote image is dropped',
  );
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[1].inline[0].text, 'First line same paragraph.');
  assert.equal(blocks[2].items.length, 2);
  assert.equal(blocks[3].items[1][0].text, 'two');
  assert.equal(blocks[5].text, 'ipconfig\n  <keep spaces>');
  assert.deepEqual(blocks[6], { type: 'img', alt: 'Ports', src: '/assets/setup/step3_firewall.svg' });
});
