import { PluginSettingTab, TFolder, setIcon } from 'obsidian';
import { closeNativeSettings } from '../compat';
import type TangrowPlugin from '../main';
import { renderAccessStatus, renderActivation } from './activation';
import { GROUPS, SECTION_IDS, SECTIONS, searchSettings, type SectionId, type SettingItem } from './catalog';
import { renderSection } from './sections';
import { PARA_FOLDER_KEYS } from './vault-structure-data';

const OPEN_ACTIVATION = 'tangrow:open-activation';

export function focusSetting(container: HTMLElement, id: string): void {
  const row = container.querySelector<HTMLElement>(`[data-setting-id="${id}"]`);
  if (!row || row.hidden) { container.querySelector<HTMLElement>('h2')?.focus(); return; }
  for (let parent = row.parentElement; parent && parent !== container; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
  }
  const control = row.querySelector<HTMLElement>('input:enabled, select:enabled, textarea:enabled, button:enabled:not([hidden]), a[href]');
  (control ?? row).focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest' });
  row.classList.add('tangrow-settings-highlight');
  row.addEventListener('animationend', () => row.classList.remove('tangrow-settings-highlight'), { once: true });
}

export class TangrowSettings extends PluginSettingTab {
  private section?: Exclude<SectionId, 'welcome'>;
  private visible = false;
  private unsubscribe?: () => void;
  private unsubscribeHome?: () => void;
  private tick?: number;
  private disposeSection?: () => void;
  private refreshAccess?: () => void;

  constructor(private host: TangrowPlugin) {
    super(host.app, host);
    const openActivation = () => this.navigate('activation');
    const mainDocument = globalThis.document;
    mainDocument?.addEventListener(OPEN_ACTIVATION, openActivation);
    host.register(() => {
      mainDocument?.removeEventListener(OPEN_ACTIVATION, openActivation);
      this.hide();
    });
  }

  display(): void {
    if (!this.visible) {
      this.visible = true;
      this.unsubscribe = this.host.access.subscribe((event) => {
        if (event === 'change') this.refreshAccess?.();
      });
      this.unsubscribeHome = this.host.subscribe(() => {
        if (!this.section) this.refreshAccess?.();
      });
      this.tick = this.containerEl.ownerDocument.defaultView?.setInterval(() => this.refreshAccess?.(), 60000);
    }
    this.render();
  }

  hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeHome?.();
    this.unsubscribeHome = undefined;
    this.containerEl.ownerDocument.defaultView?.clearInterval(this.tick);
    this.tick = undefined;
    this.disposeSection?.();
    this.disposeSection = undefined;
    this.refreshAccess = undefined;
    this.visible = false;
    this.section = undefined;
    this.containerEl.empty();
  }

  private navigate(section?: SectionId, item?: SettingItem): void {
    if (section === 'welcome') {
      if (this.visible) {
        closeNativeSettings(this.host.app);
        this.host.openOnboarding();
      }
      return;
    }
    this.section = section;
    if (!this.visible) return;
    const page = this.render();
    if (item) focusSetting(page, item.id);
    else page.querySelector<HTMLElement>('h2')?.focus();
  }

  private render(): HTMLElement {
    this.disposeSection?.();
    this.disposeSection = undefined;
    const t = this.host.t.bind(this.host);
    this.containerEl.empty();
    const root = this.containerEl.createDiv({ cls: 'tangrow-settings' });
    const toolbar = root.createDiv({ cls: 'tangrow-settings-toolbar' });
    if (this.section) toolbar.createEl('button', { text: t('Back to settings') }).onclick = () => this.navigate();
    const search = toolbar.createEl('input', { type: 'search', placeholder: t('Search settings'), attr: { 'aria-label': t('Search settings') } });
    const results = root.createDiv({ cls: 'tangrow-settings-results' });
    const page = root.createDiv();
    const renderResults = () => {
      results.empty();
      results.hidden = !search.value.trim();
      page.hidden = !results.hidden;
      if (results.hidden) return;
      const matches = searchSettings(search.value, this.host.settings.language);
      if (!matches.length) results.createEl('p', { text: t('No matching settings'), attr: { role: 'status' } });
      for (const item of matches) {
        const result = results.createEl('button', { cls: 'tangrow-settings-link' });
        result.createSpan({ text: t(item.name) });
        result.createSpan({ cls: 'setting-item-description', text: t(SECTIONS[item.section].name) });
        result.onclick = () => this.navigate(item.section, item);
      }
    };
    results.hidden = true;
    search.oninput = renderResults;
    search.onkeydown = (event) => {
      if (event.isComposing || event.key !== 'Enter') return;
      event.preventDefault();
      results.querySelector('button')?.click();
    };
    root.onkeydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        event.stopPropagation();
        search.focus();
        search.select();
      }
    };

    if (this.section) {
      const heading = page.createEl('h2', { text: t(SECTIONS[this.section].name), attr: { tabindex: '-1' } });
      if (this.section === 'activation') {
        const status = heading.createSpan({ cls: 'tangrow-settings-status' });
        const activation = renderActivation(page, this.host);
        this.disposeSection = activation.dispose;
        this.refreshAccess = () => {
          renderAccessStatus(status, this.host);
          activation.refresh();
        };
      } else {
        const section = this.section;
        const rendered = renderSection(page, section, this.host, () => {
          if (this.visible && this.section === section) this.render();
        });
        this.refreshAccess = rendered.refresh;
        this.disposeSection = rendered.dispose;
      }
    } else {
      page.createEl('h2', { text: 'Tangrow', attr: { tabindex: '-1' } });
      const showStatus: (() => void)[] = [];
      for (const [group, name] of Object.entries(GROUPS)) {
        const sectionList = page.createDiv({ cls: 'tangrow-settings-section-list' });
        sectionList.createEl('h3', { text: t(name) });
        for (const id of SECTION_IDS.filter((id) => SECTIONS[id].group === group)) {
          const row = sectionList.createEl('button', { cls: 'tangrow-settings-link tangrow-settings-entry', attr: { type: 'button' } });
          row.createSpan({ text: t(SECTIONS[id].name) });
          row.createSpan({ cls: 'setting-item-description', text: t(SECTIONS[id].description) });
          const status = row.createSpan({ cls: 'tangrow-settings-status tangrow-settings-entry-status' });
          showStatus.push(() => {
            if (id === 'activation') renderAccessStatus(status, this.host);
            else status.textContent = this.summary(id);
          });
          const chevron = row.createSpan({ cls: 'tangrow-settings-entry-icon', attr: { 'aria-hidden': 'true' } });
          setIcon(chevron, 'chevron-right');
          row.onclick = () => this.navigate(id);
        }
      }
      this.refreshAccess = () => { for (const refresh of showStatus) refresh(); };
    }

    this.refreshAccess?.();
    return page;
  }

  private summary(section: Exclude<SectionId, 'activation'>): string {
    const t = this.host.t.bind(this.host);
    const settings = this.host.settings;
    switch (section) {
      case 'welcome': return t('Run again');
      case 'defaults': return settings.language === 'en' ? 'English' : t('Simplified Chinese');
      case 'folders': {
        const count = PARA_FOLDER_KEYS.filter((key) => this.host.app.vault.getAbstractFileByPath(settings[key]) instanceof TFolder).length;
        return t('PARA {count}/{total}', { count, total: PARA_FOLDER_KEYS.length });
      }
      case 'periodic': return t('D · W · M · Q · Y');
      case 'sidebar': return t(settings.knowledgeEnabled ? 'Knowledge on' : 'Knowledge off');
      case 'ai': return t(settings.aiEnabled ? 'Suggestions on' : 'Suggestions off');
      case 'reports': return t(settings.trackEditingActivity ? 'Activity on' : 'Activity off');
      default: return '';
    }
  }
}
