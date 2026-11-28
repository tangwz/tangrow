import { Modal } from 'obsidian';
import { accessErrorMessage } from './access-messages';
import type { DraftSubmission } from './draft-submissions';
import { translate, type TranslationValues } from './i18n';
import type TangrowPlugin from './main';
import { ONBOARDING_FOLDER_KEYS } from './settings/onboarding-vault';
import { renderVaultStructureFields, vaultPathKind } from './settings/vault-structure';
import { inspectVaultStructurePath, VaultStructurePathError, type VaultStructurePatch, type VaultStructureValues } from './settings/vault-structure-data';
import type { Locale } from './types';

type Step = 1 | 2 | 3 | 4;
const titles: Record<Step, string> = {
  1: 'Welcome to Tangrow', 2: 'Your vault structure', 3: 'Daily review', 4: 'Capture your first thought'
};

export class OnboardingModal extends Modal {
  private step: Step = 1;
  private busy = false;
  private closed = false;
  private composing = false;
  private unsubscribe?: () => void;
  private vaultValues?: VaultStructureValues;
  private fields?: ReturnType<typeof renderVaultStructureFields>;
  private vaultSaved = false;
  private createBases = true;
  private captureText = '';
  private capturePath?: string;
  private readonly receipt: DraftSubmission = { id: crypto.randomUUID(), path: null };
  private languageButtons: HTMLButtonElement[] = [];
  private bases?: HTMLInputElement;
  private review?: HTMLInputElement;
  private capture?: HTMLTextAreaElement;
  private accessPanel?: HTMLElement;
  private accessHint?: HTMLElement;
  private trial?: HTMLButtonElement;
  private activation?: HTMLButtonElement;
  private feedback?: HTMLElement;
  private next?: HTMLButtonElement;
  private back?: HTMLButtonElement;

  constructor(private readonly host: TangrowPlugin, private readonly onDismiss: () => void) { super(host.app); }

  onOpen(): void {
    this.closed = false;
    this.contentEl.addClass('tangrow-onboarding');
    this.renderStep();
    this.unsubscribe = this.host.access.subscribe(() => this.refreshControls());
  }

  onClose(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.fields?.dispose();
    this.contentEl.empty();
    this.onDismiss();
  }

  private t(source: string, values?: TranslationValues): string { return this.host.t(source, values); }

  private renderStep(): void {
    this.fields?.dispose();
    this.fields = this.capture = this.bases = this.review = undefined;
    this.accessPanel = this.accessHint = this.trial = this.activation = undefined;
    this.languageButtons = [];
    this.composing = false;
    this.setTitle(this.t('Welcome guide'));
    this.contentEl.empty();
    const progress = this.contentEl.createDiv({ cls: 'tangrow-onboarding-progress' });
    const dots = progress.createSpan({ cls: 'tangrow-onboarding-dots', attr: { 'aria-hidden': 'true' } });
    for (let i = 1; i <= 4; i++) dots.createSpan({ cls: i <= this.step ? 'is-current' : '' });
    progress.createSpan({ text: this.t('Step {step} of {total}', { step: this.step, total: 4 }) });
    const heading = this.contentEl.createEl('h2', { text: this.t(titles[this.step]), attr: { tabindex: '-1' } });
    const body = this.contentEl.createDiv({ cls: 'tangrow-onboarding-body' });
    if (this.step === 1) this.renderWelcome(body);
    if (this.step === 2) this.renderVault(body);
    if (this.step === 3) this.renderReview(body);
    if (this.step === 4) this.renderCapture(body);
    if (this.step > 1) this.renderAccess();
    this.feedback = this.contentEl.createEl('p', { cls: 'tangrow-onboarding-feedback', attr: { role: 'status' } });
    const footer = this.contentEl.createDiv({ cls: 'tangrow-onboarding-footer' });
    this.back = footer.createEl('button', { type: 'button' });
    this.next = footer.createEl('button', { type: 'button', cls: 'mod-cta' });
    this.back.onclick = () => this.backAction();
    this.next.onclick = () => this.nextAction();
    this.refreshControls();
    heading.focus();
  }

  private renderWelcome(body: HTMLElement): void {
    body.createEl('p', { text: this.t('Turn what you jot down into your own ideas and work.') });
    const loop = body.createEl('ol', { cls: 'tangrow-onboarding-loop' });
    for (const action of ['Capture', 'Sort', 'Distill', 'Connect', 'Review', 'Create']) loop.createEl('li', { text: this.t(action) });
    const promises = body.createEl('ul', { cls: 'tangrow-onboarding-promises' });
    for (const [label, detail] of [
      ['No migration, no lock-in.', 'Tangrow uses your existing folders and only adds new files. Your notes and properties stay in Markdown.'],
      ['AI organizing is coming.', 'AI will draft filing choices, cards, links, and reviews. You will see a checklist before any write. The workflow is manual today.']
    ] as const) {
      const item = promises.createEl('li');
      item.createEl('strong', { text: this.t(label) });
      item.createSpan({ text: this.t(detail) });
    }
    const languages = body.createDiv({ cls: 'tangrow-onboarding-languages', attr: { role: 'group', 'aria-label': this.t('Interface language') } });
    languages.createSpan({ text: this.t('Interface language') });
    for (const language of ['zh-CN', 'en'] as const) {
      const button = languages.createEl('button', {
        type: 'button', text: language === 'en' ? 'English' : translate('zh-CN', 'Simplified Chinese'),
        attr: { lang: language, 'aria-pressed': String(language === this.host.settings.language) }
      });
      button.onclick = () => this.changeLanguage(language);
      this.languageButtons.push(button);
    }
  }

  private renderVault(body: HTMLElement): void {
    const values = this.vaultValues ??= this.host.onboardingVaultStructure();
    const hasMatches = ONBOARDING_FOLDER_KEYS.some((key) => vaultPathKind(this.host.app, values[key]) === 'folder');
    body.createEl('p', { text: this.t(hasMatches ? 'We matched available folders to PARA. You can edit any path.'
      : 'Choose a PARA structure for your vault. Tangrow can create missing folders.') });
    this.fields = renderVaultStructureFields(body, this.host, {
      values, keys: ONBOARDING_FOLDER_KEYS, directoryMode: 'allow-missing-folders',
      onChange: () => { this.vaultSaved = false; this.showStatus(); this.refreshControls(); }
    });
    const basesLabel = body.createEl('label', { cls: 'tangrow-onboarding-option' });
    this.bases = basesLabel.createEl('input', { type: 'checkbox', attr: { 'aria-label': this.t('Also create Bases') } });
    this.bases.checked = this.createBases;
    this.bases.onchange = () => {
      this.createBases = this.bases?.checked ?? this.createBases;
      this.vaultSaved = false;
      this.showStatus();
      this.refreshControls();
    };
    basesLabel.createSpan({ text: this.t('Also create Bases. Tangrow adds only missing files.') });
    body.createEl('p', { text: this.t('Existing notes stay where they are. Change folder mappings later in Settings → Vault structure.') });
  }

  private renderReview(body: HTMLElement): void {
    body.createEl('p', { text: this.t('Daily review brings your captures, tasks, and cards back to your attention.') });
    const option = body.createDiv({ cls: 'tangrow-onboarding-review' });
    const label = option.createEl('label', { cls: 'tangrow-onboarding-option' });
    const review = this.review = label.createEl('input', {
      type: 'checkbox', attr: { role: 'switch', 'aria-label': this.t('Prepare daily review') }
    });
    label.createSpan({ text: this.t('Prepare today’s review when I first open Obsidian') });
    label.createSpan({ cls: 'tangrow-onboarding-badge', text: this.t('Coming soon') });
    review.onchange = () => {
      if (!this.host.access.canUse()) { this.refreshControls(); return; }
      const prepareDailyReview = review.checked;
      return this.run(() => this.host.updateOrganizingPreferences({ prepareDailyReview }));
    };
    option.createEl('p', { text: this.t('The organizing engine will draft a review from today’s journal, captures, due tasks, and card review queue. Drafts require your own API key and use tokens. You decide what gets written.') });
    option.createEl('p', { text: this.t('Off by default. Your choice takes effect when the organizing engine is available. Change it any time in Settings → AI.') });
  }

  private renderCapture(body: HTMLElement): void {
    body.createEl('p', { text: this.t('Jot it down now and decide what to do with it later in Captures.') });
    if (this.capturePath) {
      const note = body.createEl('p', { cls: 'tangrow-onboarding-saved', attr: { role: 'status' } });
      note.createSpan({ text: this.t('Your first capture is saved.') });
      note.createEl('code', { text: this.capturePath });
    } else {
      const capture = this.capture = body.createEl('textarea', { attr: {
        rows: '4', 'aria-label': this.t('Capture your first thought'), placeholder: this.t('What’s on your mind? An idea, a question, a link.')
      } });
      capture.value = this.captureText;
      capture.oninput = () => {
        this.captureText = capture.value;
        this.showStatus();
        this.refreshControls();
      };
      capture.addEventListener('compositionstart', () => { this.composing = true; this.refreshControls(); });
      capture.addEventListener('compositionend', () => {
        this.composing = false;
        this.captureText = capture.value;
        this.refreshControls();
      });
    }
    body.createEl('p', { text: this.t('You can also capture from the sidebar, a separate window, the command palette, or the editor menu.') });
  }

  private renderAccess(): void {
    const panel = this.accessPanel = this.contentEl.createDiv({ cls: 'tangrow-onboarding-access' });
    this.accessHint = panel.createEl('p', { attr: { role: 'status' } });
    this.trial = panel.createEl('button', { type: 'button', text: this.t('Start 24-hour trial') });
    this.activation = panel.createEl('button', { type: 'button', text: this.t('Activation and updates') });
    this.trial.onclick = async () => {
      await this.run(async () => {
        const result = this.host.access.startTrial();
        if (!result.ok) throw new Error(accessErrorMessage(result.error));
        this.showStatus(this.t('Your 24-hour trial has started.'));
      });
      if (!this.closed && !this.next?.disabled) this.next?.focus();
    };
    this.activation.onclick = () => this.host.openActivationSettings();
  }

  private showStatus(text = '', error = false): void {
    if (!this.feedback) return;
    this.feedback.textContent = text;
    this.feedback.dataset.error = String(error);
  }

  private missingFolderCount(): number {
    const values = this.fields?.values();
    if (!values) return 0;
    const missing = new Set<string>();
    for (const key of ONBOARDING_FOLDER_KEYS) {
      const path = inspectVaultStructurePath(key, values[key], (value) => vaultPathKind(this.host.app, value), 'allow-missing-folders');
      if (path.status === 'will-create') missing.add(path.path);
    }
    return missing.size;
  }

  private refreshControls(): void {
    if (this.closed || !this.back || !this.next) return;
    const locked = this.step > 1 && !this.host.access.canUse();
    const accessState = this.host.access.snapshot().state;
    if (this.accessPanel) this.accessPanel.hidden = !locked;
    if (this.accessHint && locked) this.accessHint.textContent = this.t(accessState === 'needs_network'
      ? 'Connect to the internet to renew access and edit local settings.' : 'Start a trial or activate this device to edit local settings.');
    if (this.trial) { this.trial.hidden = accessState !== 'not_started'; this.trial.disabled = this.busy; }
    if (this.activation) this.activation.disabled = this.busy;
    for (const button of this.languageButtons) button.disabled = this.busy;
    const readOnly = locked || this.busy;
    this.fields?.setReadOnly(readOnly);
    if (this.bases) this.bases.disabled = readOnly;
    if (this.review) {
      this.review.disabled = readOnly;
      if (!this.busy) this.review.checked = this.host.settings.prepareDailyReview;
    }
    if (this.capture) this.capture.readOnly = readOnly;

    const missing = this.vaultSaved ? 0 : this.missingFolderCount();
    let main = this.t('Next');
    let secondary = this.t('Back');
    let blocked = false;
    if (this.step === 1) { main = this.t('Get started'); secondary = this.t('Skip the guide'); }
    if (this.step === 2) {
      if (!this.vaultSaved && (locked || missing)) secondary = this.t('Not now');
      if (missing) main = this.t(missing === 1 ? 'Create {count} missing folder' : 'Create {count} missing folders', { count: missing });
      blocked = locked && !this.vaultSaved;
    }
    if (this.step === 4) {
      main = this.t(this.capturePath ? 'Done, go process it' : 'Save');
      if (!this.capturePath) secondary = this.t('Later, finish');
      blocked = !this.capturePath && (locked || this.composing || !this.captureText.trim());
    }
    this.back.textContent = secondary;
    this.back.disabled = this.busy;
    this.next.textContent = main;
    this.next.disabled = this.busy || blocked;
  }

  private move(step: Step): void {
    if (this.fields) this.vaultValues = this.fields.values();
    this.step = step;
    this.renderStep();
  }

  private async changeLanguage(language: Locale): Promise<void> {
    if (language === this.host.settings.language) return;
    await this.run(async () => {
      await this.host.setLanguage(language, { localizeManagedFiles: false });
      if (!this.closed) this.renderStep();
    });
  }

  private async nextAction(): Promise<void> {
    if (this.closed || this.busy || this.next?.disabled) return;
    if (this.step === 1) this.move(2);
    else if (this.step === 2) {
      if (this.vaultSaved) this.move(3);
      else if (this.host.access.canUse()) await this.run(() => this.saveVault());
    } else if (this.step === 3) this.move(4);
    else if (this.capturePath) await this.finish();
    else if (this.host.access.canUse() && !this.composing) await this.run(async () => {
      const text = this.capture?.value ?? this.captureText;
      this.capturePath = await this.host.captureOnboardingText(text, this.receipt);
      if (!this.closed) this.renderStep();
    });
  }

  private async backAction(): Promise<void> {
    if (this.closed || this.busy) return;
    if (this.step === 1 || this.step === 4 && !this.capturePath) await this.finish();
    else if (this.step === 2) this.move(!this.vaultSaved && (!this.host.access.canUse() || this.missingFolderCount()) ? 3 : 1);
    else this.move(this.step === 3 ? 2 : 3);
  }

  private async saveVault(): Promise<void> {
    const values = this.fields?.values();
    if (!values) return;
    const missing = this.missingFolderCount();
    const patch: VaultStructurePatch = {};
    for (const key of ONBOARDING_FOLDER_KEYS) patch[key] = values[key];
    await this.host.setupOnboardingVault(patch, this.createBases);
    this.vaultSaved = true;
    if (this.closed) return;
    if (missing) {
      this.fields?.refresh();
      this.showStatus(this.t('Your vault folders are ready.'));
    } else this.move(3);
  }

  private async finish(): Promise<void> {
    await this.run(() => this.host.finishOnboarding());
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.closed || this.busy) return;
    this.busy = true;
    this.showStatus();
    this.refreshControls();
    try { await operation(); }
    catch (error) {
      if (!this.closed) {
        const message = this.host.error(error);
        this.fields?.refresh();
        if (this.fields && error instanceof VaultStructurePathError && ONBOARDING_FOLDER_KEYS.some((key) => key === error.key)) {
          this.fields.setError(error.key, message, true);
        }
        else this.showStatus(message, true);
      }
    } finally {
      this.busy = false;
      this.refreshControls();
    }
  }
}
