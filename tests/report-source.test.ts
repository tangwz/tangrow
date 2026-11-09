import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import type { App, CachedMetadata, ListItemCache, Pos, TFile } from 'obsidian';
import { ReportSource } from '../src/report-source';
import { DEFAULT_SETTINGS } from '../src/types';

function file(path: string, content: string): TFile {
  return {
    path,
    basename: path.split('/').at(-1)!.replace(/\.md$/, ''),
    extension: 'md',
    stat: { ctime: 1_000, mtime: 2_000, size: content.length }
  } as TFile;
}

function position(line: number): Pos {
  return { start: { line, col: 0, offset: 0 }, end: { line, col: 1, offset: 1 } };
}

function task(line: number, status: string): ListItemCache {
  return { task: status, parent: 0, position: position(line) };
}

function fixture(entries: Array<[string, string]>) {
  const files = entries.map(([path, content]) => file(path, content));
  const bodies = new Map(entries);
  const metadata = new Map<string, CachedMetadata | null>(files.map((entry) => [entry.path, {}]));
  const resolvedLinks: Record<string, Record<string, number>> = {};
  const reads: string[] = [];
  const failures = new Set<string>();
  const mutations: string[] = [];
  const folders = ['00-Inbox', '20-Project/Empty'];
  const vault = {
    getMarkdownFiles: () => [...files],
    getAllFolders: () => folders.map((path) => ({ path })),
    cachedRead: async (entry: TFile) => {
      reads.push(entry.path);
      if (failures.has(entry.path)) throw new Error('Read failed.');
      return bodies.get(entry.path) ?? '';
    },
    create: () => { mutations.push('create'); },
    modify: () => { mutations.push('modify'); },
    process: () => { mutations.push('process'); },
    rename: () => { mutations.push('rename'); },
    delete: () => { mutations.push('delete'); }
  };
  const app = { vault, metadataCache: { getFileCache: (entry: TFile) => metadata.get(entry.path) ?? null, resolvedLinks } } as unknown as App;
  return { app, files, bodies, metadata, resolvedLinks, reads, failures, mutations, folders, vault, source: new ReportSource(app) };
}

test('source keeps metadata, resolves links and tasks, and includes empty folders without writes', async () => {
  const state = fixture([['00-Inbox/Note.md', '\u4e2d\u6587 English\n- [ ] First task\n- [x] Done task']]);
  state.metadata.set('00-Inbox/Note.md', {
    frontmatter: { created: '2000-01-01', tags: ['clip', '#book'] },
    tags: [{ tag: '#clip', position: position(0) }],
    listItems: [task(1, ' '), task(2, 'x')]
  } as CachedMetadata);
  state.resolvedLinks['00-Inbox/Note.md'] = { '20-Project/Other.md': 2 };
  const result = await state.source.collect(DEFAULT_SETTINGS);
  assert.equal(result.unreadable, 0);
  assert.equal(result.linksReady, true);
  assert.deepEqual(result.folders, ['00-Inbox', '20-Project/Empty']);
  const record = result.records[0]!;
  assert.equal(record.created, 1_000);
  assert.equal(record.modified, 2_000);
  assert.equal(record.wordCount, 7);
  assert.deepEqual(record.tags, ['#clip', '#book']);
  assert.deepEqual(record.links, ['20-Project/Other.md']);
  assert.deepEqual(record.tasks, [' ', 'x']);
  assert.deepEqual(record.taskItems, [
    { path: '00-Inbox/Note.md', name: 'Note', line: 1, text: 'First task', status: ' ' },
    { path: '00-Inbox/Note.md', name: 'Note', line: 2, text: 'Done task', status: 'x' }
  ]);
  assert.deepEqual(state.mutations, []);
});

test('support and configured excluded folders are filtered before body reads with folder boundaries', async () => {
  const state = fixture([
    ['99-Tangrow/Records/Focus.md', 'Support hidden body'],
    ['Private/Hidden.md', 'Excluded hidden body'],
    ['Private-Other/Visible.md', 'Visible body']
  ]);
  state.metadata.set('99-Tangrow/Records/Focus.md', { frontmatter: { tangrow_kind: 'focus', tangrow_minutes: 25 } } as CachedMetadata);
  const result = await state.source.collect({ ...DEFAULT_SETTINGS, reportExcludedFolders: ['Private'] });
  assert.deepEqual(state.reads, ['Private-Other/Visible.md']);
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0]?.frontmatter?.tangrow_minutes, 25);
  assert.equal(result.records[0]?.wordCount, undefined);
  assert.equal(result.records[1]?.wordCount, undefined);
  assert.equal(result.records[2]?.wordCount, 2);
  assert.equal(result.unreadable, 0);
});

test('an exact excluded path is skipped before reads while a sibling prefix remains visible', async () => {
  const state = fixture([['Private.md', 'Excluded body'], ['Private.md-copy/Visible.md', 'Visible body']]);
  const result = await state.source.collect({ ...DEFAULT_SETTINGS, reportExcludedFolders: ['Private.md'] });
  assert.deepEqual(state.reads, ['Private.md-copy/Visible.md']);
  assert.equal(result.records[0]?.wordCount, undefined);
  assert.equal(result.records[1]?.wordCount, 2);
});

test('invalid support or excluded folder settings cannot hide existing user content', async () => {
  const state = fixture([['00-Inbox/Note.md', 'Visible body']]);
  const result = await state.source.collect({ ...DEFAULT_SETTINGS, supportFolder: '00-Inbox', reportExcludedFolders: ['', '..', '/'] });
  assert.equal(result.records[0]?.wordCount, 2);
  assert.deepEqual(state.reads, ['00-Inbox/Note.md']);
});

test('unchanged reports reuse stats, while modified files, invalidation and deleted paths refresh safely', async () => {
  const state = fixture([['00-Inbox/A.md', 'First'], ['00-Inbox/B.md', 'Second']]);
  await state.source.collect(DEFAULT_SETTINGS);
  await state.source.collect(DEFAULT_SETTINGS);
  assert.equal(state.reads.length, 2);
  state.files[0]!.stat.mtime++;
  state.bodies.set('00-Inbox/A.md', 'Changed body');
  const changed = await state.source.collect(DEFAULT_SETTINGS);
  assert.equal(changed.records[0]?.wordCount, 2);
  assert.equal(state.reads.length, 3);
  state.files[1]!.stat.size++;
  await state.source.collect(DEFAULT_SETTINGS);
  assert.equal(state.reads.length, 4);
  state.source.invalidate('00-Inbox/A.md');
  await state.source.collect(DEFAULT_SETTINGS);
  assert.equal(state.reads.length, 5);
  const removed = state.files.pop()!;
  await state.source.collect(DEFAULT_SETTINGS);
  state.files.push(removed);
  await state.source.collect(DEFAULT_SETTINGS);
  assert.equal(state.reads.length, 6);
  state.source.invalidate();
  await state.source.collect(DEFAULT_SETTINGS);
  assert.equal(state.reads.length, 8);
});

test('unreadable bodies retain metadata and retry on the next collection', async () => {
  const state = fixture([['00-Inbox/Note.md', 'Recovered text']]);
  state.failures.add('00-Inbox/Note.md');
  state.metadata.set('00-Inbox/Note.md', { frontmatter: { tangrow_pin: true }, listItems: [task(0, ' ')] } as CachedMetadata);
  const failed = await state.source.collect(DEFAULT_SETTINGS);
  assert.equal(failed.unreadable, 1);
  assert.equal(failed.records[0]?.frontmatter?.tangrow_pin, true);
  assert.deepEqual(failed.records[0]?.tasks, [' ']);
  assert.equal(failed.records[0]?.wordCount, undefined);
  assert.equal(failed.records[0]?.taskItems, undefined);
  state.failures.clear();
  const recovered = await state.source.collect(DEFAULT_SETTINGS);
  assert.equal(recovered.unreadable, 0);
  assert.equal(recovered.records[0]?.wordCount, 2);
  assert.equal(state.reads.length, 2);
});

test('metadata and tag changes appear without rereading unchanged bodies', async () => {
  const state = fixture([['00-Inbox/Note.md', '- [ ] Later indexed task']]);
  state.metadata.set('00-Inbox/Note.md', null);
  assert.equal((await state.source.collect(DEFAULT_SETTINGS)).linksReady, false);
  state.metadata.set('00-Inbox/Note.md', { frontmatter: { tags: 'clip, #book' }, listItems: [task(0, ' ')] } as CachedMetadata);
  state.resolvedLinks['00-Inbox/Note.md'] = { 'Other.md': 1 };
  const result = await state.source.collect(DEFAULT_SETTINGS);
  assert.equal(result.linksReady, true);
  assert.deepEqual(result.records[0]?.tags, ['#clip', '#book']);
  assert.deepEqual(result.records[0]?.links, ['Other.md']);
  assert.equal(result.records[0]?.taskItems?.[0]?.text, 'Later indexed task');
  assert.equal(state.reads.length, 1);
});

test('link readiness stays false after metadata changes until the graph resolves', async () => {
  const state = fixture([['00-Inbox/Note.md', 'Visible body']]);
  assert.equal((await state.source.collect(DEFAULT_SETTINGS)).linksReady, true);
  state.source.markLinksDirty();
  assert.equal((await state.source.collect(DEFAULT_SETTINGS)).linksReady, false);
  state.resolvedLinks['00-Inbox/Note.md'] = { 'Other.md': 1 };
  assert.equal((await state.source.collect(DEFAULT_SETTINGS)).linksReady, false);
  state.source.markLinksResolved();
  const resolved = await state.source.collect(DEFAULT_SETTINGS);
  assert.equal(resolved.linksReady, true);
  assert.deepEqual(resolved.records[0]?.links, ['Other.md']);
  state.metadata.set('00-Inbox/Note.md', null);
  state.source.markLinksResolved();
  assert.equal((await state.source.collect(DEFAULT_SETTINGS)).linksReady, false);
  assert.equal(state.reads.length, 1);
});

test('an in-flight report cannot expose old link data as ready after graph invalidation', async () => {
  const state = fixture([['00-Inbox/Note.md', 'Visible body']]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  state.vault.cachedRead = async (entry: TFile) => { await gate; return state.bodies.get(entry.path) ?? ''; };
  const pending = state.source.collect(DEFAULT_SETTINGS);
  state.source.markLinksDirty();
  state.source.markLinksResolved();
  release();
  assert.equal((await pending).linksReady, false);
  assert.equal((await state.source.collect(DEFAULT_SETTINGS)).linksReady, true);
});

test('body read concurrency stays at three across overlapping collection requests', async () => {
  const state = fixture(Array.from({ length: 10 }, (_, index) => [`00-Inbox/Note ${index}.md`, 'A word']));
  let active = 0;
  let maximum = 0;
  state.vault.cachedRead = async (entry: TFile) => {
    state.reads.push(entry.path);
    active++;
    maximum = Math.max(maximum, active);
    try { await setTimeout(2); return state.bodies.get(entry.path) ?? ''; }
    finally { active--; }
  };
  const [first, second] = await Promise.all([state.source.collect(DEFAULT_SETTINGS), state.source.collect(DEFAULT_SETTINGS)]);
  assert.equal(first.records.length, 10);
  assert.equal(second.records.length, 10);
  assert.equal(maximum, 3);
  assert.equal(state.reads.length, 10);
  assert.equal(active, 0);
  assert.deepEqual(state.mutations, []);
});
