import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Access, type AccessResult, type AccessState } from '../src/access';
import type TangrowPlugin from '../src/main';
import { ITEMS, SECTION_IDS, searchSettings } from '../src/settings/catalog';
import { DEFAULT_SETTINGS } from '../src/types';
import * as mock from './obsidian-mock';
import vector from './fixtures/license-vectors.json';

type ElementOptions = { text?: string; value?: string; type?: string; cls?: string; attr?: Record<string, string> };

class Element extends EventTarget {
  children: Element[] = [];
  parentElement: Element | null = null;
  ownerDocument = { activeElement: null as Element | null };
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
  const sectionNames = [
    'Activation and updates', 'User guide', 'Purchase and support', 'Defaults', 'Folders and notes',
    'Sidebar components', 'View enhancements', 'Report settings', 'Maintenance'
  ];
  for (const [index, name] of sectionNames.entries()) {
    navigate(name);
    const ids = root.descendants().flatMap((element) => element.dataset.settingId ?? []);
    assert.deepEqual(ids.sort(), ITEMS.filter((item) => item.section === SECTION_IDS[index]).map((item) => item.id).sort());
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
    assert.equal(searchSettings('系统设置', locale).length, 3);
    assert.deepEqual(searchSettings('no-such-setting', locale), []);
  }
});

test('selecting a weekly template result opens Defaults, expands the group, and focuses the field', async () => {
  const { root, row, navigate, byText, dispose } = fixture();
  navigate('Report settings');
  const search = root.descendants().find((element) => element.attributes.type === 'search')!;
  search.value = '周记模板';
  await search.oninput?.();
  byText('Weekly note template').parentElement!.click();
  const target = row('template-weekly');
  assert.equal(target.parentElement!.tagName, 'DETAILS');
  assert.equal(target.parentElement!.open, true);
  assert.equal(root.ownerDocument.activeElement, target.querySelector('input'));
  assert.ok(target.classes.has('tangrow-settings-highlight'));
  dispose();
});

test('a valid integer that was typed but not committed is saved when settings move on or close', async () => {
  const { plugin, row, navigate, byText, dispose } = fixture();
  navigate('Sidebar components');
  let duration = row('focusMinutes').querySelector('input')!;
  duration.value = '45';
  await duration.oninput?.();
  assert.equal(plugin.saveCalls, 0);
  // Leaving the section replaces the field without a change event.
  byText('Back to settings').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plugin.settings.focusMinutes, 45);
  assert.equal(plugin.saveCalls, 1);
  navigate('Sidebar components');
  duration = row('focusMinutes').querySelector('input')!;
  duration.value = '50';
  await duration.oninput?.();
  // Closing the settings window hides the tab.
  dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plugin.settings.focusMinutes, 50);
  assert.equal(plugin.saveCalls, 2);
});

test('change, blur and leaving the section save one edit once', async () => {
  const { plugin, row, navigate, byText, dispose } = fixture();
  navigate('Sidebar components');
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
  navigate('Sidebar components');
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
  await duration.onchange?.();
  assert.equal(plugin.saveCalls, 1);
  byText('Back to settings').click();
  navigate('Defaults');
  assert.notEqual(row('language').parentElement?.tagName, 'FIELDSET');
  assert.equal(root.querySelector('fieldset')?.disabled, true);
  dispose();
});

test('Apply rolls back failed writes and leaves inputs available for retry', async () => {
  const { plugin, app, row, navigate, byText, dispose } = fixture();
  navigate('Folders and notes');
  const previousPaths = { inbox: plugin.settings.inboxFolder, task: plugin.settings.taskOverviewPath };
  app.vault.seedFile('Tasks.md', '# Tasks');
  for (const [key, value] of [['inboxFolder', 'New Inbox'], ['taskOverviewPath', 'Tasks.md']] as const) {
    const target = row(key);
    const input = target.querySelector('input')!;
    input.value = value;
    assert.equal(plugin.saveCalls, key === 'inboxFolder' ? 0 : 1);
    plugin.saveFailures = 1;
    await target.querySelector('button')!.onclick?.();
    assert.equal(input.value, value);
  }
  assert.equal(plugin.settings.inboxFolder, previousPaths.inbox);
  assert.equal(plugin.settings.taskOverviewPath, previousPaths.task);
  assert.equal(plugin.savedData, null);
  await row('inboxFolder').querySelector('button')!.onclick?.();
  assert.equal(plugin.settings.inboxFolder, 'New Inbox');

  byText('Back to settings').click();
  navigate('Defaults');
  app.vault.seedFile('Weekly.md', '# Weekly');
  const format = row('format-weekly');
  const template = row('template-weekly');
  format.querySelector('input')!.value = 'GGGG/[Weeks]/WW';
  template.querySelector('input')!.value = 'Weekly.md';
  await Promise.all([format.querySelector('button')!.onclick?.(), template.querySelector('button')!.onclick?.()]);
  assert.equal(plugin.settings.journalFormats.weekly, 'GGGG/[Weeks]/WW');
  assert.equal(plugin.settings.journalTemplates.weekly, 'Weekly.md');

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
  navigate('View enhancements');
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
