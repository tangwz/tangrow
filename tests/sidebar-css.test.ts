import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('sidebar status bar clearance outranks Obsidian workspace padding', () => {
  const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const rule = styles.match(/\.workspace-leaf-content \.view-content\.tangrow-sidebar\s*\{([^}]+)\}/);
  assert.match(rule?.[1] ?? '', /padding-bottom:\s*max\(\s*var\(--safe-area-inset-bottom, 0px\),/);
  assert.match(rule?.[1] ?? '', /calc\(16px \+ var\(--status-bar-scroll-padding, var\(--tangrow-status-bar-height, 0px\)\)\)/);
});
