import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesGeneratedContent } from '../src/managed-files';

const generated = {
  filters: { and: ['file.ext == "md"', 'file.inFolder("20-Project")'] },
  properties: { 'file.name': { displayName: 'Note' } },
  views: [{ type: 'table', name: 'Notes', order: ['file.name'] }]
};

test('host formatting and object key order do not block untouched Base localization', () => {
  const content = JSON.stringify({ views: generated.views, properties: generated.properties, filters: generated.filters }, null, 2);
  assert.equal(matchesGeneratedContent('Tangrow Notes.base', content, JSON.stringify(generated), JSON.parse), true);
});

test('custom filters, labels, view order and properties remain protected', () => {
  for (const modified of [
    { ...generated, filters: { and: ['file.ext == "md"'] } },
    { ...generated, properties: { 'file.name': { displayName: 'My title' } } },
    { ...generated, views: [{ ...generated.views[0], name: 'My view' }] },
    { ...generated, views: [{ ...generated.views[0], columnSize: { 'file.name': 200 } }] }
  ]) assert.equal(matchesGeneratedContent('Tangrow Notes.base', JSON.stringify(modified), JSON.stringify(generated), JSON.parse), false);
});

test('custom comments, invalid YAML and changed instructions are never normalized away', () => {
  assert.equal(matchesGeneratedContent('Tangrow Notes.base', '# Keep this comment\n{}', '{}', () => ({})), false);
  assert.equal(matchesGeneratedContent('Tangrow Notes.base', 'invalid', '{}', JSON.parse), false);
  assert.equal(matchesGeneratedContent('README.md', 'New instructions', 'Old instructions', JSON.parse), false);
  assert.equal(matchesGeneratedContent('README.md', 'Original instructions', 'Original instructions', JSON.parse), true);
});
