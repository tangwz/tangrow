import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Access, type AccessResult, type AccessState } from '../src/access';
import type TangrowPlugin from '../src/main';
import { ITEMS, SECTION_IDS, SECTIONS, searchSettings } from '../src/settings/catalog';
import { DEFAULT_SETTINGS } from '../src/types';
import * as mock from './obsidian-mock';
import vector from './fixtures/license-vectors.json';

type ElementOptions = { text?: string; value?: string; type?: string; cls?: string; attr?: Record<string, string> };

class Element extends EventTarget {
  children: Element[] = [];
  parentElement: Element | null = null;
  ownerDocument = { activeElement: null as Element | null, hasFocus: () => true };
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classes = new Set<string>();
  classList = this.classes;
  textContent = '';
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  open = false;
  onclick?: () => void | Promise<void>;
  oninput?: () => void | Promise<void>;
  onchange?: () => void | Promise<void>;
  onblur?: () => void | Promise<void>;

  constructor(readonly tagName = 'DIV') { super(); }

  createEl(tag: string, options: ElementOptions = {}): Element {
    const element = new Element(tag.toUpperCase());
    element.parentElement = this;
    element.ownerDocument = this.ownerDocument;
    element.attributes = { ...options.attr };
    if (options.type) element.attributes.type = options.type;
    element.textContent = options.text ?? '';
    element.value = options.value ?? '';
    for (const name of options.cls?.split(' ') ?? []) element.classes.add(name);
    this.children.push(element);
    return element;
  }

  createDiv(options?: ElementOptions): Element { return this.createEl('div', options); }
  createSpan(options?: ElementOptions): Element { return this.createEl('span', options); }
  addClass(name: string): void { this.classes.add(name); }
  removeClass(name: string): void { this.classes.delete(name); }
  empty(): void { this.children = []; }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); }
  focus(): void { this.ownerDocument.activeElement = this; }
  scrollIntoView(): void {}
  click(): void {
    if (!this.disabled) {
      this.dispatchEvent(new Event('click'));
      void this.onclick?.();
    }
  }
  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
  getAttribute(key: string): string | null { return this.attributes[key] ?? null; }
  removeAttribute(key: string): void { delete this.attributes[key]; }
  insertBefore(child: Element, sibling: Element): void {
    this.children = this.children.filter((element) => element !== child);
    this.children.splice(this.children.indexOf(sibling), 0, child);
  }

  descendants(): Element[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }

  querySelector(selector: string): Element | undefined {
    const id = /^\[data-setting-id="([^"]+)"\]$/.exec(selector)?.[1];
    return this.descendants().find((element) => {
      if (id) return element.dataset.settingId === id;
      if (selector.includes(':enabled')) return ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(element.tagName)
        && !element.disabled && !element.hidden;
      return element.tagName.toLowerCase() === selector;
    });
  }
}

class Setting {
  settingEl: Element;
  infoEl: Element;
  nameEl: Element;
  descEl: Element;
  controlEl: Element;

  constructor(parent: Element) {
    this.settingEl = parent.createDiv();
    this.infoEl = this.settingEl.createDiv();
    this.nameEl = this.infoEl.createDiv();
    this.descEl = this.infoEl.createDiv();
    this.controlEl = this.settingEl.createDiv();
  }

  setName(name: string): this { this.nameEl.textContent = name; return this; }
  setDesc(description: string): this { this.descEl.textContent = description; return this; }
  addDropdown(buildDropdown: (dropdown: {
    selectEl: Element;
    addOption(value: string, text: string): unknown;
    setValue(value: string): unknown;
    onChange(change: (value: string) => void): unknown;
  }) => void): void {
    const control = this.controlEl.createEl('select');
    const dropdown = {
      selectEl: control,
      addOption(value: string, text: string) { control.createEl('option', { value, text }); return this; },
      setValue(value: string) { control.value = value; return this; },
      onChange() { return this; }
    };
    buildDropdown(dropdown);
  }
}

class PluginSettingTab {
  containerEl = new Element();
}

class Modal {
  static current: Modal | null = null;
  contentEl = new Element();
  title = '';
  setTitle(title: string): void { this.title = title; }
  open(): void { Modal.current = this; this.onOpen(); }
  close(): void { Modal.current = null; this.onClose(); }
  onOpen(): void {}
  onClose(): void {}
}

const repository = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  absWorkingDir: repository,
  stdin: {
    contents: "export { default as TangrowPlugin } from './src/main'; export { TangrowSettings } from './src/settings/tab'; export { AccessGate } from './src/access-gate';",
    resolveDir: repository
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22', external: ['obsidian']
});
const moduleObject: { exports: unknown } = { exports: {} };
const requireModule = createRequire(import.meta.url);
new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(
  moduleObject, moduleObject.exports, (name: string) => name === 'obsidian' ? { ...mock, Setting, PluginSettingTab, Modal } : requireModule(name)
);
const harness = moduleObject.exports as {
  TangrowPlugin: new (app: mock.MockApp) => TangrowPlugin & { saveFailures: number; saveCalls: number; savedData: unknown };
  TangrowSettings: new (host: TangrowPlugin) => PluginSettingTab & { display(): void; hide(): void };
  AccessGate: new (host: TangrowPlugin, root: Element, flush: () => void, restore: () => void) => { mount(): void; dispose(): void };
};

function fixture(language: 'en' | 'zh-CN' = 'en') {
  const app = mock.createMockApp();
  const plugin = new harness.TangrowPlugin(app);
  plugin.settings.language = language;
  plugin.manifest.version = '1.2.3';
  const listeners = new Set<(event: string) => void>();
  const cleanup: (() => void)[] = [];
  const access = {
    state: 'active' as AccessState,
    snapshot() { return { state: this.state, remainingMs: 0 }; },
    canUse() { return this.state === 'active' || this.state === 'trial'; },
    hasLease() { return this.state === 'active' || this.state === 'needs_network'; },
    subscribe(listener: (event: string) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    change(state: AccessState) { this.state = state; for (const listener of listeners) listener('change'); },
    deviceList: null as Access['deviceList'],
    deviceLimitReached: false,
    ownerBuild: false,
    async activate(_code: string): Promise<AccessResult> { return { ok: true }; },
    async renew(): Promise<AccessResult> { return { ok: true }; },
    async release(): Promise<AccessResult> { return { ok: true }; }
  };
  Object.assign(plugin, { access, register: (dispose: () => void) => cleanup.push(dispose) });
  const tab = new harness.TangrowSettings(plugin);
  tab.display();
  const root = tab.containerEl;
  const byText = (text: string) => {
    const element = root.descendants().find((item) => item.textContent === text);
    assert.ok(element, `Expected to find "${text}"`);
    return element;
  };
  return {
    app, plugin, tab, root, access, listeners,
    dispose: () => { for (const dispose of cleanup) dispose(); },
    navigate: (name: string) => byText(name).parentElement!.click(),
    row: (id: string) => root.querySelector(`[data-setting-id="${id}"]`)!,
    byText
  };
}

test('every existing preference and maintenance action renders once in its assigned section', () => {
  const { root, navigate, byText, dispose } = fixture();
  const rendered: string[] = [];
  for (const section of SECTION_IDS.filter((id) => id !== 'welcome')) {
    navigate(SECTIONS[section].name);
    const ids = root.descendants().flatMap((element) => element.dataset.settingId ?? []);
    assert.deepEqual(ids.sort(), ITEMS.filter((item) => item.section === section).map((item) => item.id).sort());
    rendered.push(...ids);
    byText('Back to settings').click();
  }
  const expectedSettings = Object.keys(DEFAULT_SETTINGS).filter((key) => !['journalFormat', 'journalFormats', 'journalTemplates', 'habits'].includes(key));
  const periodic = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'].flatMap((period) => [`format-${period}`, `template-${period}`]);
  for (const id of [...expectedSettings, ...periodic, 'setup', 'migration', 'agentGuide']) {
    assert.equal(rendered.filter((entry) => entry === id).length, 1, id);
  }
  dispose();
});

test('search ranks name prefixes, name substrings, then descriptions and includes both languages', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    assert.deepEqual(searchSettings(' weekly ', locale).map(({ id }) => id), ['format-weekly', 'template-weekly']);
    assert.deepEqual(searchSettings('周记', locale).map(({ id }) => id), ['format-weekly', 'template-weekly']);
    const devices = searchSettings('device', locale).map(({ id }) => id);
    assert.ok(devices.indexOf('requirements') < devices.indexOf('devices'));
    assert.ok(devices.indexOf('devices') < devices.indexOf('redemption'));
    assert.equal(searchSettings('周期笔记模板', locale).length, 5);
    assert.equal(searchSettings('系统维护', locale).length, 3);
    assert.deepEqual(searchSettings('no-such-setting', locale), []);
  }
});

test('selecting a weekly template result opens Periodic notes and focuses the field', async () => {
  const { root, row, navigate, byText, dispose } = fixture();
  navigate('Report settings');
  const search = root.descendants().find((element) => element.attributes.type === 'search')!;
  search.value = '周记模板';
  await search.oninput?.();
  byText('Weekly note template').parentElement!.click();
  const target = row('template-weekly');
  assert.equal(byText('Periodic notes').tagName, 'H2');
  assert.equal(root.ownerDocument.activeElement, target.querySelector('input'));
  assert.ok(target.classes.has('tangrow-settings-highlight'));
  dispose();
});

test('settings entries show current PARA and suggestion summaries', async () => {
  const { app, plugin, byText, dispose } = fixture();
  assert.ok(byText('PARA 0/5'));
  assert.ok(byText('Suggestions off'));
  app.vault.seedFolder('Inbox');
  await plugin.updateVaultStructure({ inboxFolder: 'Inbox' });
  await plugin.updateAiSettings({ aiEnabled: true });
  assert.ok(byText('PARA 1/5'));
  assert.ok(byText('Suggestions on'));
  dispose();
});

test('the welcome guide can be rerun from settings and completes the four steps', async () => {
  const { app, plugin, navigate, dispose } = fixture();
  const original = app.vault.seedFile('1. 项目/Original.md', '# Original\n');
  const click = async (label: string) => {
    const button = Modal.current?.contentEl.descendants().find((element) => element.tagName === 'BUTTON' && element.textContent === label);
    assert.ok(button?.onclick, label);
    await button.onclick();
  };
  const control = (label: string) => {
    const element = Modal.current?.contentEl.descendants().find((element) => element.attributes['aria-label'] === label);
    assert.ok(element, label);
    return element;
  };
  navigate('Welcome guide');
  const wizard = Modal.current;
  assert.equal(wizard?.title, 'Welcome guide');
  navigate('Welcome guide');
  assert.equal(Modal.current, wizard);
  await click('Get started');
  const bases = control('Also create Bases');
  assert.equal(bases.checked, true);
  bases.checked = false;
  await bases.onchange?.();
  await click('Create 5 missing folders');
  assert.equal(plugin.settings.projectFolder, '1. 项目');
  assert.equal(original.content, '# Original\n');
  assert.deepEqual(app.vault.createdPaths, ['00-Inbox', '30-Area', '40-Resources', '90-Archive', '50-Zettel']);
  await click('Next');
  const review = control('Prepare daily review');
  assert.equal(review.checked, false);
  review.checked = true;
  await review.onchange?.();
  assert.equal(plugin.settings.prepareDailyReview, true);
  await click('Next');
  const capture = control('Capture your first thought');
  capture.value = 'First workshop thought';
  await capture.oninput?.();
  await click('Save');
  let settingsCloseCalls = 0;
  Object.assign(app, { setting: { close: () => {
    assert.equal(Modal.current, null);
    assert.equal((plugin.savedData as { onboardingCompleted: boolean }).onboardingCompleted, true);
    settingsCloseCalls += 1;
  } } });
  plugin.saveFailures = 1;
  await click('Done, go process it');
  assert.equal(Modal.current, wizard);
  assert.equal(settingsCloseCalls, 0);
  await click('Done, go process it');
  assert.equal(Modal.current, null);
  assert.equal(settingsCloseCalls, 1);
  assert.equal((plugin.savedData as { onboardingCompleted: boolean }).onboardingCompleted, true);
  const files = app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${plugin.settings.inboxFolder}/`));
  assert.equal(files.length, 1);
  assert.match(files[0]!.content, /First workshop thought/);

  navigate('Welcome guide');
  assert.notEqual(Modal.current, wizard);
  await click('Skip the guide');
  assert.equal(Modal.current, null);
  assert.equal(app.vault.getMarkdownFiles().length, 2);
  dispose();
});

test('an unactivated user can skip setup and capture without creating vault content', async () => {
  const { access, app, plugin, navigate, dispose } = fixture();
  access.change('not_started');
  navigate('Welcome guide');
  const button = (label: string) => {
    const control = Modal.current?.contentEl.descendants().find((element) => element.tagName === 'BUTTON' && element.textContent === label);
    assert.ok(control?.onclick, label);
    return control;
  };
  await button('Get started').onclick?.();
  assert.ok(button('Create 6 missing folders').disabled);
  assert.equal(button('Start 24-hour trial').hidden, false);
  await button('Not now').onclick?.();
  await button('Next').onclick?.();
  assert.ok(button('Save').disabled);
  await button('Later, finish').onclick?.();
  assert.equal(Modal.current, null);
  assert.equal((plugin.savedData as { onboardingCompleted: boolean }).onboardingCompleted, true);
  assert.equal(plugin.settings.prepareDailyReview, false);
  assert.deepEqual(app.vault.createdPaths, []);
  dispose();
});

test('finishing a dismissed guide leaves a newly opened guide alone', async () => {
  const { app, navigate, dispose } = fixture();
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const ready = new Promise<void>((resolve) => { resume = resolve; });
  Object.assign(app.workspace, { ensureSideLeaf: async () => {
    enter();
    await ready;
    return { view: {} };
  } });
  navigate('Welcome guide');
  const first = Modal.current!;
  const skip = first.contentEl.descendants().find((element) => element.textContent === 'Skip the guide')!;
  const finish = skip.onclick!();
  await entered;
  first.close();
  navigate('Welcome guide');
  const second = Modal.current;
  assert.ok(second && second !== first);
  resume();
  await finish;
  assert.equal(Modal.current, second);
  second.close();
  dispose();
});

test('the organizing engine status follows the coming soon preference', async () => {
  const { navigate, row, byText, dispose } = fixture();
  navigate('AI');
  const preference = row('showComingSoon').querySelector('input')!;
  const status = byText('Coming soon');
  assert.equal(status.hidden, false);
  preference.checked = false;
  await preference.onchange?.();
  assert.equal(status.hidden, true);
  preference.checked = true;
  await preference.onchange?.();
  assert.equal(status.hidden, false);
  // A later display rule with equal specificity would override the settings [hidden] rule in Obsidian.
  const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.tangrow-settings\s+\.tangrow-settings-status:not\(\[hidden\]\)\s*\{[^}]*\bdisplay:\s*inline-flex\b/);
  dispose();
});

test('the model selector preserves custom IDs and rolls back a failed preset save', async () => {
  const { plugin, navigate, row, byText, dispose } = fixture();
  await plugin.updateAiSettings({ aiModel: 'claude-custom-2026' });
  navigate('AI');
  const model = row('aiModel');
  const select = model.querySelector('select')!;
  const custom = model.querySelector('input')!;
  const customControls = custom.parentElement!;
  assert.deepEqual([select.value, custom.value], ['', 'claude-custom-2026']);
  assert.equal(customControls.hidden, false);
  select.value = 'claude-sonnet-5-5';
  plugin.saveFailures = 1;
  await select.onchange?.();
  assert.deepEqual([select.value, custom.value, plugin.settings.aiModel], ['', 'claude-custom-2026', 'claude-custom-2026']);
  select.value = 'claude-sonnet-5-5';
  await select.onchange?.();
  assert.equal(plugin.settings.aiModel, 'claude-sonnet-5-5');
  assert.equal(customControls.hidden, true);
  select.value = '';
  await select.onchange?.();
  assert.equal(plugin.settings.aiModel, 'claude-sonnet-5-5');
  assert.equal(customControls.hidden, false);
  custom.value = 'claude-another-model';
  await byText('Save model').onclick?.();
  assert.deepEqual([select.value, custom.value, plugin.settings.aiModel], ['', 'claude-another-model', 'claude-another-model']);
  dispose();
});

test('a valid integer that was typed but not committed is saved when settings move on or close', async () => {
  const { plugin, row, navigate, byText, dispose } = fixture();
  navigate('Sidebar modules');
  let duration = row('focusMinutes').querySelector('input')!;
  duration.value = '45';
  await duration.oninput?.();
  assert.equal(plugin.saveCalls, 0);
  // Leaving the section replaces the field without a change event.
  byText('Back to settings').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plugin.settings.focusMinutes, 45);
  assert.equal(plugin.saveCalls, 1);
  navigate('Sidebar modules');
  duration = row('focusMinutes').querySelector('input')!;
  duration.value = '50';
  await duration.oninput?.();
  // Closing the settings window hides the tab.
  dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plugin.settings.focusMinutes, 50);
  assert.equal(plugin.saveCalls, 2);
});

test('an integer field nobody typed into never writes back a value another view changed', async () => {
  const { plugin, row, navigate, byText, dispose } = fixture();
  navigate('Report settings');
  const goal = row('activityGoalMinutes').querySelector('input')!;
  const rendered = Number(goal.value);
  let saves = 0;
  const updateReportSettings = plugin.updateReportSettings.bind(plugin);
  plugin.updateReportSettings = async (patch) => { saves++; await updateReportSettings(patch); };
  // The report view changes the goal while settings stay open.
  await updateReportSettings({ activityGoalMinutes: rendered + 17 });
  await goal.onblur?.();
  await goal.onchange?.();
  byText('Back to settings').click();
  navigate('Report settings');
  await updateReportSettings({ activityGoalMinutes: rendered + 18 });
  dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plugin.settings.activityGoalMinutes, rendered + 18);
  assert.equal(saves, 0);
});

test('an integer typed back to the value it showed does not overwrite a newer value from another view', async () => {
  const { plugin, row, navigate, dispose } = fixture();
  navigate('Report settings');
  const goal = row('activityGoalMinutes').querySelector('input')!;
  const rendered = Number(goal.value);
  const updateReportSettings = plugin.updateReportSettings.bind(plugin);
  goal.value = String(rendered + 1);
  await goal.oninput?.();
  // The report view changes the goal while the user is editing here, so the field keeps the user's input.
  await updateReportSettings({ activityGoalMinutes: rendered + 30 });
  assert.equal(goal.value, String(rendered + 1));
  let saves = 0;
  plugin.updateReportSettings = async (patch) => { saves++; await updateReportSettings(patch); };
  goal.value = String(rendered);
  await goal.oninput?.();
  await goal.onblur?.();
  dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plugin.settings.activityGoalMinutes, rendered + 30);
  assert.equal(saves, 0);
});

test('an untouched integer field shows a value changed elsewhere, and typing the old value then restores it', async () => {
  const { plugin, row, navigate, dispose } = fixture();
  navigate('Report settings');
  const goal = row('activityGoalMinutes').querySelector('input')!;
  const rendered = Number(goal.value);
  // The report view changes the goal while the settings page is open.
  await plugin.updateReportSettings({ activityGoalMinutes: rendered + 30 });
  assert.equal(goal.value, String(rendered + 30));
  goal.value = String(rendered);
  await goal.oninput?.();
  await goal.onblur?.();
  dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([goal.value, plugin.settings.activityGoalMinutes], [String(rendered), rendered]);
});

test('closing settings stops integer fields from following later changes', async () => {
  const { plugin, row, navigate, dispose } = fixture();
  navigate('Sidebar modules');
  const duration = row('focusMinutes').querySelector('input')!;
  const shown = duration.value;
  dispose();
  await plugin.saveSettings({ focusMinutes: Number(shown) + 5 });
  assert.equal(duration.value, shown);
});

test('a focused integer field keeps in-progress input across unrelated refreshes and catches up on blur', async () => {
  const { plugin, row, navigate, dispose } = fixture();
  navigate('Report settings');
  const goal = row('activityGoalMinutes').querySelector('input')!;
  const rendered = Number(goal.value);
  goal.focus();
  goal.value = String(rendered + 1);
  await goal.oninput?.();
  // Report view updates the goal while the user is actively typing here.
  await plugin.updateReportSettings({ activityGoalMinutes: rendered + 30 });
  assert.equal(goal.value, String(rendered + 1));
  // User edits back through the old value (e.g. heading toward another number) while still focused.
  goal.value = String(rendered);
  await goal.oninput?.();
  await plugin.action('refresh');
  assert.equal(goal.value, String(rendered));
  // Blurring preserves the newer external value and immediately displays it so the old value can be typed again.
  let saves = 0;
  const updateReportSettings = plugin.updateReportSettings.bind(plugin);
  plugin.updateReportSettings = async (patch) => { saves++; await updateReportSettings(patch); };
  goal.ownerDocument.activeElement = null;
  await goal.onblur?.();
  assert.deepEqual([goal.value, plugin.settings.activityGoalMinutes, saves], [String(rendered + 30), rendered + 30, 0]);
  goal.value = String(rendered);
  await goal.oninput?.();
  await goal.onblur?.();
  dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([goal.value, plugin.settings.activityGoalMinutes, saves], [String(rendered), rendered, 1]);
});

test('a focused untouched integer field in an inactive window still follows external changes', async () => {
  const { plugin, row, navigate, dispose } = fixture();
  navigate('Report settings');
  const goal = row('activityGoalMinutes').querySelector('input')!;
  const rendered = Number(goal.value);
  goal.focus();
  goal.ownerDocument.hasFocus = () => false;
  await plugin.updateReportSettings({ activityGoalMinutes: rendered + 30 });
  assert.equal(goal.value, String(rendered + 30));
  dispose();
});

test('failed external settings writes notify listeners on rollback so integer fields never keep phantom values', async () => {
  for (const [section, id, key, trigger] of [
    ['Report settings', 'activityGoalMinutes', 'activityGoalMinutes', (plugin: TangrowPlugin, value: number) => plugin.updateReportSettings({ activityGoalMinutes: value })],
    ['Sidebar modules', 'focusMinutes', 'focusMinutes', (plugin: TangrowPlugin, value: number) => plugin.saveSettings({ focusMinutes: value })]
  ] as const) {
    const { plugin, row, navigate, dispose } = fixture();
    navigate(section);
    const field = row(id).querySelector('input')!;
    const original = plugin.settings[key];
    let rejectSave!: (reason: Error) => void;
    plugin.saveData = () => new Promise<void>((_, reject) => { rejectSave = reject; });
    const pending = trigger(plugin, original + 20);
    await new Promise(resolve => setImmediate(resolve));
    // An unrelated refresh runs while the optimistic write is in flight.
    await plugin.action('refresh');
    assert.equal(field.value, String(original + 20));
    rejectSave(new Error('Save failed'));
    await assert.rejects(pending, /Save failed/);
    assert.deepEqual([field.value, plugin.settings[key]], [String(original), original]);
    dispose();
  }
});

for (const [name, read, write] of [
  ['knowledge features', (plugin: TangrowPlugin) => plugin.settings.knowledgeEnabled,
    (plugin: TangrowPlugin) => plugin.updateKnowledgeEnabled(!plugin.settings.knowledgeEnabled)],
  ['journal format', (plugin: TangrowPlugin) => plugin.settings.journalFormat,
    (plugin: TangrowPlugin) => plugin.updateJournalSettings('daily', 'YYYY/[Day] MM-DD')],
  ['AI settings', (plugin: TangrowPlugin) => plugin.settings.aiEnabled,
    (plugin: TangrowPlugin) => plugin.updateAiSettings({ aiEnabled: !plugin.settings.aiEnabled })],
  ['AI key', (plugin: TangrowPlugin) => plugin.settings.aiApiKey,
    (plugin: TangrowPlugin) => plugin.setAiKey('sk-ant-test-key')],
  ['interface language', (plugin: TangrowPlugin) => plugin.settings.language,
    (plugin: TangrowPlugin) => plugin.setLanguage(plugin.settings.language === 'en' ? 'zh-CN' : 'en')]
] as const) test(`a failed ${name} write refreshes views with the restored value`, async () => {
  const { plugin, dispose } = fixture();
  const original = read(plugin);
  const seen: unknown[] = [];
  plugin.subscribe(() => seen.push(read(plugin)));
  let rejectSave!: (reason: Error) => void;
  plugin.saveData = () => new Promise<void>((_, reject) => { rejectSave = reject; });
  const pending = write(plugin);
  await new Promise(resolve => setImmediate(resolve));
  // An unrelated refresh renders the unsaved value while the write is in flight.
  await plugin.action('refresh');
  assert.notDeepEqual(seen.at(-1), original);
  rejectSave(new Error('Save failed'));
  await assert.rejects(pending, /Save failed/);
  assert.deepEqual([read(plugin), seen.at(-1)], [original, original]);
  dispose();
});

test('a commit of the value another view is still saving is kept when that save fails', async () => {
  const { plugin, row, navigate, dispose } = fixture();
  navigate('Report settings');
  const goal = row('activityGoalMinutes').querySelector('input')!;
  const rendered = Number(goal.value);
  const saveData = plugin.saveData.bind(plugin);
  let rejectFirst!: (reason: Error) => void;
  let writes = 0;
  plugin.saveData = (data) => ++writes === 1 ? new Promise<void>((_, reject) => { rejectFirst = reject; }) : saveData(data);
  // The report view starts saving a new goal; the settings field is being edited, so it keeps the user's input.
  goal.focus();
  const external = plugin.updateReportSettings({ activityGoalMinutes: rendered + 30 });
  await new Promise(resolve => setImmediate(resolve));
  goal.value = String(rendered + 30);
  await goal.oninput?.();
  const commit = goal.onchange?.();
  rejectFirst(new Error('Save failed'));
  await assert.rejects(external, /Save failed/);
  await commit;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([goal.value, plugin.settings.activityGoalMinutes], [String(rendered + 30), rendered + 30]);
  dispose();
});

test('a view that fails to refresh after a rollback neither hides the save error nor blocks other views', async () => {
  const { plugin, dispose } = fixture();
  const original = plugin.settings.focusMinutes;
  plugin.subscribe(() => { throw new Error('View refresh failed'); });
  const seen: number[] = [];
  plugin.subscribe(() => seen.push(plugin.settings.focusMinutes));
  plugin.saveData = () => Promise.reject(new Error('Save failed'));
  const errors = console.error;
  console.error = () => undefined;
  try { await assert.rejects(plugin.saveSettings({ focusMinutes: original + 5 }), /Save failed/); }
  finally { console.error = errors; }
  assert.deepEqual([plugin.settings.focusMinutes, seen.at(-1)], [original, original]);
  dispose();
});

test('an integer typed back to its original value while the first save is in flight saves the original value', async () => {
  const { plugin, row, navigate, dispose } = fixture();
  navigate('Sidebar modules');
  const field = row('focusMinutes').querySelector('input')!;
  const original = plugin.settings.focusMinutes;
  const saveSettings = plugin.saveSettings.bind(plugin);
  let release!: () => void;
  const slowWrite = new Promise<void>(resolve => { release = resolve; });
  plugin.saveSettings = async (patch) => { await slowWrite; await saveSettings(patch); };
  field.value = String(original + 20);
  field.oninput?.();
  const first = field.onchange?.();
  field.value = String(original);
  field.oninput?.();
  const second = field.onchange?.();
  await field.onblur?.();
  dispose();
  release();
  await Promise.all([first, second]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([field.value, plugin.settings.focusMinutes], [String(original), original]);
});

test('a failed earlier integer save does not undo a later commit that is still in flight', async () => {
  const { plugin, row, navigate, dispose } = fixture();
  navigate('Sidebar modules');
  const field = row('focusMinutes').querySelector('input')!;
  const original = plugin.settings.focusMinutes;
  const saveSettings = plugin.saveSettings.bind(plugin);
  let calls = 0;
  plugin.saveSettings = async (patch) => {
    if (++calls === 1) throw new Error('Save failed');
    await saveSettings(patch);
  };
  field.value = String(original + 20);
  field.oninput?.();
  const first = field.onchange?.();
  field.value = String(original + 30);
  field.oninput?.();
  await Promise.all([first, field.onchange?.()]);
  await field.onblur?.();
  dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([field.value, plugin.settings.focusMinutes, calls], [String(original + 30), original + 30, 2]);
});

test('a failed first save of a value committed twice does not drop a later return to the original', async () => {
  const { plugin, row, navigate, dispose } = fixture();
  navigate('Sidebar modules');
  const field = row('focusMinutes').querySelector('input')!;
  const original = plugin.settings.focusMinutes;
  const changed = original + 20;
  const saveSettings = plugin.saveSettings.bind(plugin);
  // Like the plugin's save queue, writes run one at a time in order. The first one is slow and fails.
  let release!: () => void;
  const slowWrite = new Promise<void>(resolve => { release = resolve; });
  let queue = Promise.resolve();
  let calls = 0;
  plugin.saveSettings = (patch) => {
    const call = ++calls;
    const write = queue.then(async () => {
      if (call === 1) { await slowWrite; throw new Error('Save failed'); }
      await saveSettings(patch);
    });
    queue = write.catch(() => undefined);
    return write;
  };
  const commits: Promise<void>[] = [];
  for (const value of [changed, original, changed]) {
    field.value = String(value);
    field.oninput?.();
    commits.push(field.onchange?.() ?? Promise.resolve());
  }
  release();
  await commits[0];
  // Back to the original while the second and third saves may still be queued.
  field.value = String(original);
  field.oninput?.();
  commits.push(field.onchange?.() ?? Promise.resolve());
  await field.onblur?.();
  dispose();
  await Promise.all(commits);
  await queue;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([field.value, plugin.settings.focusMinutes, calls], [String(original), original, 4]);
});

test('a different integer typed over a stale page still saves the user\'s value', async () => {
  const { plugin, row, navigate, dispose } = fixture();
  navigate('Report settings');
  const goal = row('activityGoalMinutes').querySelector('input')!;
  const rendered = Number(goal.value);
  await plugin.updateReportSettings({ activityGoalMinutes: rendered + 30 });
  goal.value = String(rendered + 5);
  await goal.oninput?.();
  dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plugin.settings.activityGoalMinutes, rendered + 5);
});

test('an integer saved once is not written again over a later change from another view', async () => {
  const { plugin, row, navigate, dispose } = fixture();
  navigate('Sidebar modules');
  const duration = row('focusMinutes').querySelector('input')!;
  duration.value = '45';
  await duration.oninput?.();
  await duration.onchange?.();
  assert.equal(plugin.settings.focusMinutes, 45);
  await plugin.saveSettings({ focusMinutes: 70 });
  const saves = plugin.saveCalls;
  await duration.onblur?.();
  dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plugin.settings.focusMinutes, 70);
  assert.equal(plugin.saveCalls, saves);
});

test('an earlier integer save failure does not replace an uncommitted edit', async () => {
  const { plugin, row, navigate, dispose } = fixture();
  navigate('Sidebar modules');
  const field = row('focusMinutes').querySelector('input')!;
  const saveSettings = plugin.saveSettings;
  let reject!: (reason: Error) => void;
  plugin.saveSettings = () => new Promise<void>((_, fail) => { reject = fail; });
  field.value = '90';
  field.oninput?.();
  const pending = field.onchange?.();
  field.value = '120';
  field.oninput?.();
  reject(new Error('Save failed'));
  await pending;
  assert.equal(field.value, '120');
  plugin.saveSettings = saveSettings;
  dispose();
});

test('change, blur and leaving the section save one edit once', async () => {
  const { plugin, row, navigate, byText, dispose } = fixture();
  navigate('Sidebar modules');
  const duration = row('focusMinutes').querySelector('input')!;
  duration.value = '90';
  await duration.oninput?.();
  // Blur follows change before the first save has finished.
  await Promise.all([duration.onchange?.(), duration.onblur?.()]);
  assert.equal(plugin.settings.focusMinutes, 90);
  assert.equal(plugin.saveCalls, 1);
  byText('Back to settings').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plugin.saveCalls, 1);
  dispose();
});

test('valid integers save when committed, out of range values show a hint, and access changes lock editing', async () => {
  const { plugin, root, row, access, navigate, byText, dispose } = fixture();
  navigate('Sidebar modules');
  const duration = row('focusMinutes').querySelector('input')!;
  const original = plugin.settings.focusMinutes;
  for (const value of ['0', '241', '1.5', '']) {
    duration.value = value;
    await duration.oninput?.();
    await duration.onchange?.();
    assert.equal(plugin.saveCalls, 0);
    assert.equal(duration.attributes['aria-invalid'], 'true');
    assert.equal(byText('Enter a whole number from 1 to 240.').hidden, false);
  }
  // Intermediate values while typing 300 are never stored.
  for (const value of ['3', '30', '300']) {
    duration.value = value;
    await duration.oninput?.();
  }
  await duration.onchange?.();
  assert.equal(plugin.saveCalls, 0);
  assert.equal(plugin.settings.focusMinutes, original);
  duration.value = '120';
  await duration.oninput?.();
  assert.equal(plugin.saveCalls, 0);
  await duration.onchange?.();
  assert.equal(plugin.settings.focusMinutes, 120);
  assert.equal(plugin.saveCalls, 1);
  access.change('needs_network');
  assert.equal(root.querySelector('fieldset')?.disabled, true);
  assert.equal(byText('Connect to the internet to renew access and edit local settings.').hidden, false);
  duration.value = '180';
  await duration.oninput?.();
  await duration.onchange?.();
  assert.equal(plugin.saveCalls, 1);
  byText('Back to settings').click();
  navigate('Language and startup');
  assert.notEqual(row('language').parentElement?.tagName, 'FIELDSET');
  assert.equal(root.querySelector('fieldset')?.disabled, true);
  dispose();
});

test('section saves reject the whole candidate and keep inputs available for retry', async () => {
  const { plugin, app, row, navigate, byText, dispose } = fixture();
  navigate('Vault structure');
  const previousPaths = { inbox: plugin.settings.inboxFolder, task: plugin.settings.taskOverviewPath };
  const inbox = row('inboxFolder').querySelector('input')!;
  const task = row('taskOverviewPath').querySelector('input')!;
  app.vault.seedFile('Tasks.md', '# Tasks');
  inbox.value = 'New Inbox';
  task.value = 'Tasks.md';
  await inbox.oninput?.();
  await task.oninput?.();
  await byText('Save changes').onclick?.();
  assert.deepEqual([plugin.settings.inboxFolder, plugin.settings.taskOverviewPath], [previousPaths.inbox, previousPaths.task]);
  assert.equal(plugin.saveCalls, 0);
  app.vault.seedFolder('New Inbox');
  plugin.saveFailures = 1;
  await byText('Save changes').onclick?.();
  assert.deepEqual([plugin.settings.inboxFolder, plugin.settings.taskOverviewPath], [previousPaths.inbox, previousPaths.task]);
  assert.deepEqual([inbox.value, task.value], ['New Inbox', 'Tasks.md']);
  await byText('Save changes').onclick?.();
  assert.deepEqual([plugin.settings.inboxFolder, plugin.settings.taskOverviewPath], ['New Inbox', 'Tasks.md']);

  byText('Back to settings').click();
  navigate('Periodic notes');
  const format = row('format-weekly').querySelector('input')!;
  const template = row('template-weekly').querySelector('input')!;
  const previousFormat = plugin.settings.journalFormats.weekly;
  format.value = 'GGGG/[Weeks]/WW';
  template.value = 'Weekly.md';
  await format.oninput?.();
  await template.oninput?.();
  assert.match(row('format-weekly').querySelector('code')!.textContent, /Weeks/);
  await byText('Save changes').onclick?.();
  assert.deepEqual([plugin.settings.journalFormats.weekly, plugin.settings.journalTemplates.weekly], [previousFormat, '']);
  app.vault.seedFile('Weekly.md', '# Weekly');
  await byText('Save changes').onclick?.();
  assert.deepEqual([plugin.settings.journalFormats.weekly, plugin.settings.journalTemplates.weekly], ['GGGG/[Weeks]/WW', 'Weekly.md']);

  byText('Back to settings').click();
  navigate('Report settings');
  const exclusions = row('reportExcludedFolders');
  exclusions.querySelector('textarea')!.value = 'Archive\nPrivate';
  plugin.saveFailures = 1;
  await exclusions.querySelector('button')!.onclick?.();
  assert.deepEqual(plugin.settings.reportExcludedFolders, []);
  await exclusions.querySelector('button')!.onclick?.();
  assert.deepEqual(plugin.settings.reportExcludedFolders, ['Archive', 'Private']);
  dispose();
});

test('activation event opens the section while shown or before display and is removed on unload', () => {
  const mainDocument = new EventTarget();
  Object.defineProperty(globalThis, 'document', { value: mainDocument, configurable: true });
  try {
    const { tab, byText, listeners, dispose } = fixture();
    const dispatch = () => mainDocument.dispatchEvent(new Event('tangrow:open-activation'));
    dispatch();
    assert.equal(byText('Activation and updates').tagName, 'H2');
    assert.equal(byText('Current version v1.2.3 · ').tagName, 'P');
    tab.hide();
    assert.equal(listeners.size, 0);
    dispatch();
    tab.display();
    assert.equal(byText('Activation and updates').tagName, 'H2');
    dispose();
    assert.equal(listeners.size, 0);
    dispatch();
    tab.display();
    assert.equal(byText('Tangrow').tagName, 'H2');
    tab.hide();
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
  }
});

test('the settings toggle and sidebar action share the default width and clear per-note overrides', async () => {
  const { app, plugin, navigate, row, dispose } = fixture();
  const file = app.vault.seedFile('Sample.md', '# Sample');
  const editor = new mock.MarkdownView();
  editor.file = file;
  app.workspace.setActiveView(editor);
  const appliedWidths: boolean[] = [];
  editor.containerEl.toggleClass = (_name?: string, enabled?: boolean) => { appliedWidths.push(Boolean(enabled)); };
  app.workspace.iterateAllLeaves = (each) => each({ view: editor });

  await plugin.action('page-width');
  assert.equal(appliedWidths.at(-1), true);
  navigate('Sidebar modules');
  const toggle = row('wideByDefault').querySelector('input')!;
  toggle.checked = true;
  await toggle.onchange?.();
  assert.equal(plugin.settings.wideByDefault, true);
  assert.equal(appliedWidths.at(-1), true);

  await plugin.action('page-width');
  assert.equal(appliedWidths.at(-1), false);
  await plugin.action('all-width');
  assert.equal(plugin.settings.wideByDefault, false);
  assert.equal(appliedWidths.at(-1), false);
  dispose();
});

test('a fourth device can open its rejected activation from the gate and review the linked devices', async (context) => {
  const mainDocument = new EventTarget();
  Object.defineProperty(globalThis, 'document', { value: mainDocument, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: { document: mainDocument }, configurable: true });
  context.after(() => { Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, 'document'); });
  const { app, plugin, tab, root, byText, dispose } = fixture();
  context.after(dispose);
  tab.hide();
  Object.assign(app, { setting: { open() {}, openTabById() { tab.display(); } } });
  const devices = ['macOS', 'Windows', 'Android'].map((platform, index) => ({
    platform, isCurrent: false, lastRenewedAt: vector.payload.iat - index * 86400
  }));
  const storage = mock.memoryStorage();
  const requests: string[] = [];
  const access = plugin.access = new Access({
    storage: () => storage, now: () => vector.payload.iat * 1000, bytes: () => Buffer.from(vector.deviceId, 'hex'),
    coordination: { initializeDevice: async write => write(), tryActivate: send => send() },
    jitter: () => 0, keys: {}, platform: 'iOS', version: '1',
    request: async (path) => {
      requests.push(path);
      return { status: 409, text: JSON.stringify({ error: 'device_limit', deviceLimit: 3, devices }) };
    },
    later: () => 0, cancel() {}, warn() {}
  });
  access.start();
  context.after(() => access.dispose());
  const locked = new Element();
  const gate = new harness.AccessGate(plugin, locked, () => {}, () => {});
  gate.mount();
  context.after(() => gate.dispose());
  const clickGate = async (label: string) => {
    const button = locked.descendants().find((item) => item.attributes['aria-label'] === label && item.tagName === 'BUTTON');
    assert.ok(button, label);
    button.click();
    await new Promise(resolve => setImmediate(resolve));
  };

  locked.querySelector('input')!.value = vector.code;
  await clickGate('Activate this device');
  await clickGate('Activation and updates');
  assert.deepEqual(requests, ['/v1/activate']);
  assert.equal(byText('3/3').hidden, false);
  const dates = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });
  assert.deepEqual(root.querySelector('ul')!.children.map((item) => item.textContent),
    devices.map(({ platform, lastRenewedAt }) => `${platform} · Last used ${dates.format(lastRenewedAt * 1000)}`));
  assert.equal(byText('Device limit reached. Release one of your old devices, wait until it has gone 45 days without renewal, or contact the seller.').hidden, false);
  assert.equal(byText('Release this device').hidden, true);
});

test('an owner build explains that access is never restricted instead of offering activation', () => {
  const { access, root, row, tab, navigate, byText, dispose } = fixture();
  access.ownerBuild = true;
  tab.display();
  byText('Owner build');
  navigate('Activation and updates');
  byText('This owner build is for your own vaults. Access is never restricted, the trial stays unused, and nothing is sent to the activation service.');
  assert.ok(!row('redemption'));
  assert.ok(!root.descendants().some(item => ['Start 24-hour trial', 'Activate this device', 'Release this device'].includes(item.textContent ?? '')));
  byText('Owner build');
  dispose();
});

test('activation shows the device limit response and releasing this device requires confirmation', async () => {
  const { access, root, row, navigate, byText, dispose } = fixture();
  access.change('not_started');
  navigate('Activation and updates');
  const lastRenewedAt = 1_760_000_000;
  const devices = ['macOS', 'Windows', 'Android'].map((platform) => (
    { platform: platform as 'macOS' | 'Windows' | 'Android', lastRenewedAt, isCurrent: false }
  ));
  const code = row('redemption').querySelector('input')!;
  code.value = 'TGRW-ABCD-EFGH-JKMP-QRST';
  access.activate = async (submitted) => {
    assert.equal(submitted, code.value);
    access.deviceList = { deviceLimit: 3, devices };
    access.deviceLimitReached = true;
    access.change('not_started');
    return { ok: false, error: 'device_limit' };
  };
  byText('Activate this device').click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(byText('3/3').tagName, 'SPAN');
  assert.equal(root.querySelector('ul')?.children.length, 3);
  assert.equal(byText('Device limit reached. Release one of your old devices, wait until it has gone 45 days without renewal, or contact the seller.').hidden, false);

  access.deviceList = { deviceLimit: 3, devices: [{ platform: 'iOS', lastRenewedAt, isCurrent: true }] };
  access.deviceLimitReached = false;
  access.change('active');
  assert.equal(byText('1/3').tagName, 'SPAN');
  assert.match(root.querySelector('ul')!.children[0]!.textContent, /iOS \(this device\)/);
  let releases = 0;
  access.release = async () => {
    releases++;
    access.deviceList = { deviceLimit: 3, devices: [] };
    access.change('not_started');
    return { ok: true };
  };
  byText('Release this device').click();
  assert.equal(Modal.current?.title, 'Release this device?');
  assert.equal(releases, 0);
  Modal.current?.contentEl.descendants().find((element) => element.textContent === 'Cancel')?.click();
  assert.equal(releases, 0);
  byText('Release this device').click();
  Modal.current?.contentEl.descendants().find((element) => element.textContent === 'Release this device')?.click();
  await Promise.resolve();
  assert.equal(releases, 1);
  assert.equal(byText('This device was released.').hidden, false);
  dispose();
});

test('renewal recovery explains how to reactivate and keeps the existing lease controls available', async () => {
  for (const language of ['en', 'zh-CN'] as const) {
    const { access, plugin, navigate, row, byText, dispose } = fixture(language);
    access.change('needs_network');
    navigate(plugin.t('Activation and updates'));
    assert.equal(row('redemption').querySelector('input')!.disabled, true);
    assert.equal(byText(plugin.t('Activate this device')).disabled, true);
    access.renew = async () => ({ ok: false, error: 'reactivate_required' });
    byText(plugin.t('Renew online')).click();
    await Promise.resolve();
    const instruction = 'In Activation and updates, release this device and enter your original redemption code to reactivate it.';
    if (language === 'zh-CN') assert.notEqual(plugin.t(instruction), instruction);
    assert.equal(byText(plugin.t(instruction)).hidden, false);
    assert.equal(byText(plugin.t('Release this device')).hidden, false);

    const locked = new Element();
    const gate = new harness.AccessGate(plugin, locked, () => {}, () => {});
    gate.mount();
    assert.equal(locked.querySelector('input'), undefined);
    const renew = locked.descendants().find((item) => item.attributes['aria-label'] === plugin.t('Renew now'));
    assert.ok(renew);
    renew.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mock.notices.at(-1), plugin.t(instruction));
    gate.dispose();
    dispose();
  }
});
