import { Notice } from 'obsidian';
import { translate } from './i18n';
import type { AccessResult } from './access';
import { SidebarUI } from './ui';
import type { SidebarHost } from './types';

const guardedEvents = ['click', 'keydown', 'beforeinput', 'change', 'submit'] as const;
const failures: Record<string, string> = {
  invalid_code: 'Check the redemption code and try again.',
  device_limit: 'Device limit reached. Review your devices in Activation and updates.',
  revoked: 'This redemption code has been revoked.',
  storage: 'Could not save access on this device.',
  rate_limited: 'Too many requests. Try again later.'
};

/** Keep the ordinary view mounted so locking never replaces a composing control. */
export class AccessGate {
  locked = false;
  private page?: HTMLElement;
  private draftArea?: HTMLElement;
  private jobsArea?: HTMLElement;
  private jobsKey = '';
  private language = '';
  private state = '';
  private disposed = false;
  private subscriptions: (() => void)[] = [];
  private readonly ui: SidebarUI;

  constructor(private host: SidebarHost, private root: HTMLElement, private flush: (locked: boolean) => void, private restore: () => void) {
    this.ui = new SidebarUI(() => host.settings.language);
  }

  mount(): void {
    this.subscriptions.push(this.host.access.subscribe(event => {
      if (event !== 'change') this.flush(false);
      else this.refresh();
    }), this.host.subscribeComposer(() => this.renderDrafts()), this.host.subscribe(() => this.renderJobs()));
    for (const type of guardedEvents) this.root.addEventListener(type, this.guard, true);
    this.refresh();
  }

  private guard = (event: Event): void => {
    if (event.type === 'keydown' && ['Tab', 'Escape'].includes((event as KeyboardEvent).key)) return;
    if (this.page?.contains(event.target as Node) || this.host.access.canUse()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.host.access.refresh();
    if (event.type === 'click') this.host.requireAccess();
  };

  refresh(): void {
    if (this.disposed) return;
    const { state } = this.host.access.snapshot();
    const locked = state !== 'active' && state !== 'trial';
    if (!locked) {
      if (this.locked) {
        this.locked = false;
        this.page?.remove();
        this.page = this.draftArea = this.jobsArea = undefined;
        this.root.removeClass('tangrow-access-locked');
        this.restore();
      }
      return;
    }
    if (!this.locked) {
      this.locked = true;
      this.flush(true);
      this.root.addClass('tangrow-access-locked');
    }
    if (this.page && this.state === state && this.language === this.host.settings.language) return;
    this.state = state;
    this.language = this.host.settings.language;
    const code = this.page?.querySelector('input')?.value ?? '';
    this.page?.remove();
    const page = this.page = this.root.createDiv({ cls: 'tangrow-access-gate' });
    const heading = state === 'expired' ? 'Your trial has ended' : state === 'needs_network' ? 'Connect to renew access' : 'Activate Tangrow';
    page.createEl('h3', { text: this.ui.t(heading) });
    const input = page.createEl('input', { type: 'text', value: code, attr: { placeholder: 'TGRW-XXXX-XXXX-XXXX-XXXX', 'aria-label': this.ui.t('Redemption code') } });
    this.ui.button(page, 'Activate this device', async () => this.result(await this.host.access.activate(input.value)));
    if (state === 'not_started') this.ui.button(page, 'Start 24-hour trial', () => this.result(this.host.access.startTrial()));
    if (state === 'needs_network') this.ui.button(page, 'Renew now', async () => this.result(await this.host.access.renew()));
    this.ui.button(page, 'Activation and updates', () => this.host.openActivationSettings());
    const next = this.language === 'en' ? 'zh-CN' : 'en';
    this.ui.userButton(page, next === 'en' ? 'English' : translate('zh-CN', 'Simplified Chinese'), async () => {
      await this.host.setLanguage(next);
      this.refresh();
    });
    this.draftArea = page.createDiv();
    this.renderDrafts();
    this.jobsArea = page.createDiv();
    this.jobsKey = '';
    this.renderJobs();
  }

  private renderJobs(): void {
    if (!this.locked || !this.jobsArea) return;
    const jobs = this.host.snapshot().captures.filter(item => item.processing);
    const key = JSON.stringify(jobs.map(item => [item.path, item.name]));
    if (this.jobsKey === key) return;
    this.jobsKey = key;
    this.jobsArea.empty();
    for (const capture of jobs) {
      this.ui.userButton(this.jobsArea, this.ui.t('Continue processing: {name}', { name: capture.name }), async () => {
        await this.host.processCapture(capture.path, { action: 'resume' });
      });
    }
  }

  private result(result: AccessResult): void {
    if (!result.ok) new Notice(this.ui.t(failures[result.error] ?? 'Could not complete activation. Check your connection and try again.'));
  }

  private renderDrafts(): void {
    if (!this.locked || !this.draftArea) return;
    this.draftArea.empty();
    const capture = this.host.loadComposer().capture;
    const writing = this.host.loadWritingDraft();
    this.draft('Quick capture', capture, () => this.host.submitCaptureDraft(true));
    this.draft('Writing scratchpad', [writing.title, writing.text].filter(Boolean).join('\n\n'), () => this.host.submitWritingDraft(writing.revision, undefined, true));
  }

  private draft(label: string, value: string, save: () => Promise<void>): void {
    if (!value || !this.draftArea) return;
    const section = this.draftArea.createEl('section');
    section.createEl('h4', { text: this.ui.t(label) });
    const text = section.createEl('textarea', { attr: { readonly: '', 'aria-label': this.ui.t(label) } });
    text.value = value;
    this.ui.button(section, 'Save to Inbox', save);
    this.ui.button(section, 'Copy to clipboard', () => text.ownerDocument.defaultView!.navigator.clipboard.writeText(value));
  }

  dispose(): void {
    this.disposed = true;
    this.locked = false;
    this.page?.remove();
    this.page = this.draftArea = this.jobsArea = undefined;
    for (const stop of this.subscriptions) stop();
    for (const type of guardedEvents) this.root.removeEventListener(type, this.guard, true);
    this.root.removeClass('tangrow-access-locked');
  }
}
