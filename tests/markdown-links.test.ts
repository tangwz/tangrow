import assert from 'node:assert/strict';
import test from 'node:test';
import { rebaseMarkdownLinks } from '../src/markdown-links';

const SOURCE = '00-Inbox/Capture.md';
const TARGET = '20-Project/Launch/Insight.md';

test('copied Markdown links and images retain their original vault destinations', () => {
  const content = '[Plan](./Plan.md#Next)\n![sketch](./assets/sketch.png)\n[Guide](../40-Resources/Guide.md?mode=read#Part)\n[Plain](Related.md)';
  assert.equal(rebaseMarkdownLinks(content, SOURCE, TARGET),
    '[Plan](../../00-Inbox/Plan.md#Next)\n![sketch](../../00-Inbox/assets/sketch.png)\n[Guide](../../40-Resources/Guide.md?mode=read#Part)\n[Plain](../../00-Inbox/Related.md)');
});

test('rebasing retains encoded paths, escapes, angle destinations, titles and line endings', () => {
  const content = '[One](./Folder%20name/Plan.md "A title")\r\n![Two](<./assets/figure (1).png> \'A caption\')\r\n[Three](./a(b(c)).md#Part)\r\n[Four](./a\\(b\\).md)\r\n';
  assert.equal(rebaseMarkdownLinks(content, SOURCE, TARGET),
    '[One](../../00-Inbox/Folder%20name/Plan.md "A title")\r\n![Two](<../../00-Inbox/assets/figure (1).png> \'A caption\')\r\n[Three](../../00-Inbox/a(b(c)).md#Part)\r\n[Four](../../00-Inbox/a\\(b\\).md)\r\n');
});

test('reference definitions are rebased while their uses and captions stay intact', () => {
  const content = '[Plan][plan]\n![sketch][image]\n\n[plan]: ./Plan.md#Next "Plan [example](./keep.md)"\n[image]: <./assets/my sketch.png>\n> [quoted]: ../Other.md\n';
  assert.equal(rebaseMarkdownLinks(content, SOURCE, TARGET),
    '[Plan][plan]\n![sketch][image]\n\n[plan]: ../../00-Inbox/Plan.md#Next "Plan [example](./keep.md)"\n[image]: <../../00-Inbox/assets/my sketch.png>\n> [quoted]: ../../Other.md\n');
});

test('linked images rebase both the image and the enclosing link', () => {
  assert.equal(rebaseMarkdownLinks('[![preview](./assets/image.png)](./Full.md)', SOURCE, TARGET),
    '[![preview](../../00-Inbox/assets/image.png)](../../00-Inbox/Full.md)');
});

test('external, absolute, wiki and same-note links keep their original text', () => {
  const content = [
    '[Web](https://example.com/a(b)?q=1#part)', '![Remote](//example.com/image.png)',
    '[Mail](mailto:someone@example.com)', '[App](obsidian://open?vault=Work)',
    '[Data](data:image/png;base64,abc)', '[Root](/00-Inbox/Plan.md)',
    '[Heading](#Local)', '[Query](?view=source)', '[[Related]]', '![[assets/sketch.png]]', '[Empty]()'
  ].join('\n');
  assert.equal(rebaseMarkdownLinks(content, SOURCE, TARGET), content);
});

test('code examples, escaped links and comments are preserved without hiding nearby links', () => {
  const content = [
    '`[inline](./keep.md)` and [actual](./rebase.md)',
    '``[inline ` tick](./keep.md)``',
    '\\[escaped](./keep.md)',
    '<!-- [comment](./keep.md) --> [after](./rebase.md)',
    '```md', '[fenced](./keep.md)', '```',
    '~~~', '[tilde](./keep.md)', '~~~',
    '> ```md', '> [quoted](./keep.md)', '> ```',
    '    [indented](./keep.md)', '\t[indented](./keep.md)',
    '[last](./rebase.md)'
  ].join('\n');
  assert.equal(rebaseMarkdownLinks(content, SOURCE, TARGET), content.replaceAll('(./rebase.md)', '(../../00-Inbox/rebase.md)'));
});

test('rebasing uses the current source location and the actual destination depth', () => {
  assert.equal(rebaseMarkdownLinks('[sibling](../Shared.md)', 'Deep/Inbox/Capture.md', 'Deep/Work/Note.md'), '[sibling](../Shared.md)');
  assert.equal(rebaseMarkdownLinks('![image](./assets/p.png)', 'Capture.md', 'Work/Note.md'), '![image](../assets/p.png)');
  assert.equal(rebaseMarkdownLinks('[doc](./Plan.md)', SOURCE, 'Note.md'), '[doc](./00-Inbox/Plan.md)');
  assert.equal(rebaseMarkdownLinks('[folder](./assets/)', SOURCE, TARGET), '[folder](../../00-Inbox/assets/)');
});

test('Obsidian vault-root and shortest links stay intact when they still resolve to the same file', () => {
  const content = '[Root](40-Resources/Guide.md#Next)\n![Unique](sketch.png)\n[Unresolved](40-Resources/Future.md)';
  const resolve = (linkpath: string): string | null => ({
    '40-Resources/Guide.md': '40-Resources/Guide.md', 'sketch.png': '00-Inbox/assets/sketch.png'
  })[linkpath] ?? null;
  assert.equal(rebaseMarkdownLinks(content, SOURCE, TARGET, resolve), content);
});

test('a shortest link that resolves differently at the destination is made explicitly relative', () => {
  const resolve = (linkpath: string, sourcePath: string): string | null => {
    assert.equal(linkpath, 'Plan draft.md');
    return sourcePath === SOURCE ? '00-Inbox/Plan draft.md' : '20-Project/Launch/Plan draft.md';
  };
  assert.equal(rebaseMarkdownLinks('[Plan](Plan%20draft.md#Next)', SOURCE, TARGET, resolve),
    '[Plan](../../00-Inbox/Plan%20draft.md#Next)');
});

test('wiki links and embeds keep their resolved files, headings, block references and aliases', () => {
  const resolve = (linkpath: string, sourcePath: string): string | null => {
    if (['Plan', 'Plan.md', './Plan', 'sketch.png'].includes(linkpath)) {
      const name = linkpath === 'sketch.png' ? linkpath : 'Plan.md';
      return `${sourcePath === SOURCE ? '00-Inbox' : '20-Project/Launch'}/${name}`;
    }
    return linkpath === 'Unique' ? '40-Resources/Unique.md' : null;
  };
  const content = '[[Plan]] [[Plan.md#Next|Read this]] ![[Plan#^block]] ![[sketch.png|240]] [[./Plan]]\r\n[[Unique]] [[Missing]] [[#Local]] [[#^local]]';
  assert.equal(rebaseMarkdownLinks(content, SOURCE, TARGET, resolve),
    '[[00-Inbox/Plan.md]] [[00-Inbox/Plan.md#Next|Read this]] ![[00-Inbox/Plan.md#^block]] ![[00-Inbox/sketch.png|240]] [[00-Inbox/Plan.md]]\r\n[[Unique]] [[Missing]] [[#Local]] [[#^local]]');
});

test('wiki links are left alone in code, escaped text and comments', () => {
  const content = [
    '`[[Plan]]` [[Plan]]', '\\[[Plan]]', '<!-- ![[Plan]] -->',
    '```md', '[[Plan]]', '```', '~~~', '![[Plan]]', '~~~',
    '> ```md', '> [[Plan]]', '> ```', '    [[Plan]]', '\t![[Plan]]',
    '- Item', '  ```md', '  [[Plan]]', '  ```', '> [[Plan]]'
  ].join('\n');
  const resolve = (_linkpath: string, sourcePath: string): string => sourcePath === SOURCE ? '00-Inbox/Plan.md' : '20-Project/Launch/Plan.md';
  assert.equal(rebaseMarkdownLinks(content, SOURCE, TARGET, resolve),
    content.replace('`[[Plan]]` [[Plan]]', '`[[Plan]]` [[00-Inbox/Plan.md]]').replace(/> \[\[Plan\]\]$/, '> [[00-Inbox/Plan.md]]'));
});

test('folder names are encoded before they are inserted into Markdown destinations', () => {
  assert.equal(rebaseMarkdownLinks('[plan](./Plan.md#Next)', 'Inbox ideas (old)/Capture.md', TARGET),
    '[plan](../../Inbox%20ideas%20%28old%29/Plan.md#Next)');
  assert.equal(rebaseMarkdownLinks('![image](./assets/p.png)', 'Inbox#1/100%/Capture.md', TARGET),
    '![image](../../Inbox%231/100%25/assets/p.png)');
});

test('nested list links are rebased while code blocks inside lists stay unchanged', () => {
  const content = [
    '- [outer](./rebase.md)',
    '    - [nested](./rebase.md)',
    '      [continued](./rebase.md)',
    '',
    '          [code](./keep.md)',
    '- Another item',
    '',
    '      [code](./keep.md)',
    '',
    '  [continued](./rebase.md)',
    '- ```md',
    '  [fenced](./keep.md)',
    '  ```',
    '',
    '[last](./rebase.md)'
  ].join('\n');
  assert.equal(rebaseMarkdownLinks(content, SOURCE, TARGET), content.replaceAll('(./rebase.md)', '(../../00-Inbox/rebase.md)'));
});

test('copying within the same folder leaves the body byte-for-byte unchanged', () => {
  const content = '[dot](./Plan.md)\r\n![image](assets/p.png)\r\n[reference]: ../Work.md\r\n';
  assert.equal(rebaseMarkdownLinks(content, SOURCE, '00-Inbox/New note.md'), content);
  assert.equal(rebaseMarkdownLinks(content, 'Capture.md', 'New note.md'), content);
});

test('a blank line cannot turn following text into a link destination', () => {
  const content = '[broken](\n\n./keep.md)\n[ref]:\n\n./keep.md\n[actual](\n  ./rebase.md)';
  assert.equal(rebaseMarkdownLinks(content, SOURCE, TARGET), content.replace('./rebase.md', '../../00-Inbox/rebase.md'));
});
