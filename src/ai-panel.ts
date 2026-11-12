import { MarkdownRenderer, Notice, type Component } from 'obsidian';
import { AI_ACTIONS, type AiActionId, type AiSource } from './ai';
import { describeError } from './i18n';
import { extractTasks } from './task-tools';
import type { SidebarHost } from './types';
import { SidebarUI, icon } from './ui';

const SOURCES: { id: AiSource; label: string; icon: string }[] = [
  { id: 'note', label: 'Current note', icon: 'file-text' },
  { id: 'selection', label: 'Selection', icon: 'text-select' },
  { id: 'draft', label: 'Writing draft', icon: 'pen-line' },
  { id: 'today', label: 'Today', icon: 'sun' },
  { id: 'week', label: 'This week', icon: 'calendar-range' }
];

/** The assistant workspace. Its state outlives remounts so a reply survives switching tabs. */
export class AiPanel {
  private readonly ui: SidebarUI;
  private root?: HTMLElement;
  private source: AiSource = 'note';
  private question = '';
  private output = '';
  private outputTitle = '';
  private outputAction: AiActionId | null = null;
  private outputSource: AiSource = 'note';
  private outputDraftRevision?: number;
  private failure = '';
  private running?: AbortController;
  private body?: HTMLElement;

  constructor(private readonly host: SidebarHost, private readonly component: Component) {
    this.ui = new SidebarUI(() => this.host.settings.language);
  }

  /** Lets a command or menu item preselect what the assistant works on. */
  setSource(source: AiSource): void { this.source = source; if (this.root) this.render(); }

  /** Re-renders when the active note or the AI settings change, unless a reply is streaming. */
  refresh(): void { if (this.root && !this.running) this.render(); }

  mount(container: HTMLElement): void {
    this.root = container.createDiv({ cls: 'tangrow-ai-panel' });
    this.render();
  }

  destroy(): void {
    this.root?.remove();
    this.root = undefined;
    this.body = undefined;
  }

  private render(): void {
    const root = this.root;
    if (!root) return;
    root.empty();
    this.body = undefined;
    this.ui.sectionHeading(root, 'An assistant for this vault', 'Summarize, pull out tasks, tidy your writing, or review the day.');
    if (!this.host.aiReady()) {
      const box = root.createDiv({ cls: 'tangrow-empty' });
      icon(box, 'sparkles');
      box.createEl('strong', { text: this.ui.t(this.host.settings.aiEnabled ? 'Add your API key to begin' : 'AI is off until you turn it on') });
      this.ui.paragraph(box, 'AI features use your own Anthropic API key. Text is sent only when you press an action, and only the text you chose.');
      this.ui.button(box, 'Open AI settings', () => this.host.action('settings'), { icon: 'settings-2', cls: 'mod-cta' });
      this.renderGuide(root);
      return;
    }

    const sources = root.createDiv({ cls: 'tangrow-chips tangrow-ai-sources', attr: { role: 'radiogroup', 'aria-label': this.ui.t('Work on') } });
    for (const item of SOURCES) {
      const chip = sources.createEl('button', { cls: 'tangrow-chip', attr: { type: 'button', role: 'radio', 'aria-checked': String(this.source === item.id) } });
      icon(chip, item.icon);
      chip.createSpan({ text: this.ui.t(item.label) });
      chip.addEventListener('click', () => { if (!this.running) { this.source = item.id; this.render(); } });
    }

    const review = this.source === 'today' || this.source === 'week';
    const actions = root.createDiv({ cls: 'tangrow-actions tangrow-ai-actions' });
    for (const action of AI_ACTIONS.filter((item) => (item.id === 'review') === review)) {
      this.ui.button(actions, action.label, () => this.run(action.id), { icon: action.icon, disabled: Boolean(this.running), cls: review ? 'mod-cta tangrow-ai-wide' : '' });
    }

    const ask = root.createEl('form', { cls: 'tangrow-composer tangrow-ai-ask' });
    const input = ask.createEl('textarea', { cls: 'tangrow-textarea', attr: { rows: '2', placeholder: this.ui.t('Ask about this material...'), 'aria-label': this.ui.t('Question') } });
    input.value = this.question;
    const askFooter = ask.createDiv({ cls: 'tangrow-composer-footer' });
    askFooter.createSpan({ cls: 'tangrow-muted', text: this.ui.t('Enter to send · Shift+Enter for a new line') });
    const send = this.ui.button(askFooter, 'Ask', () => this.run('ask'), { icon: 'send', cls: 'mod-cta', disabled: Boolean(this.running) || !this.question.trim() });
    input.addEventListener('input', () => { this.question = input.value; send.disabled = Boolean(this.running) || !this.question.trim(); });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      send.click();
    });
    ask.addEventListener('submit', (event) => event.preventDefault());

    this.renderOutput(root);
    this.ui.paragraph(root, 'Sent to the Claude API with your key only when you press an action. Nothing is written to a note until you choose where it goes.', 'tangrow-muted tangrow-ai-privacy');
    this.renderGuide(root);
  }

  private renderGuide(root: HTMLElement): void {
    const guide = root.createDiv({ cls: 'tangrow-ai-guide' });
    this.ui.sectionHeading(guide, 'Working with an outside agent', 'A plain guide to this vault\'s folders and properties, for tools such as Claude Code. It works without an API key.');
    this.ui.button(guide, 'Open agent guide', () => this.host.openAiGuide(), { icon: 'bot', cls: 'tangrow-full-width' });
  }

  private renderOutput(root: HTMLElement): void {
    if (!this.running && !this.output && !this.failure) return;
    const card = root.createDiv({ cls: 'tangrow-ai-output', attr: { 'aria-live': 'polite' } });
    const heading = card.createDiv({ cls: 'tangrow-ai-output-heading' });
    icon(heading, 'sparkles');
    const label = this.outputAction === 'ask' ? 'Answer' : AI_ACTIONS.find((item) => item.id === this.outputAction)?.label ?? 'Answer';
    heading.createEl('strong', { text: this.ui.t(label) });
    heading.createSpan({ cls: 'tangrow-muted', text: this.outputTitle });
    if (this.running) this.ui.button(heading, 'Stop', () => this.running?.abort(), { icon: 'circle-stop', cls: 'tangrow-text-button' });
    this.body = card.createDiv({ cls: 'tangrow-ai-output-body' });
    if (this.failure) { this.body.addClass('tangrow-input-error'); this.body.textContent = this.failure; return; }
    if (this.running) {
      this.body.addClass('is-streaming');
      this.body.textContent = this.output || this.ui.t('Thinking...');
      return;
    }
    this.body.addClass('markdown-rendered');
    try { void MarkdownRenderer.render(this.host.app, this.output, this.body, this.host.snapshot().active?.path ?? '', this.component); }
    catch { this.body.textContent = this.output; }

    const text = this.output;
    const footer = card.createDiv({ cls: 'tangrow-ai-output-actions' });
    this.ui.button(footer, 'Copy', async () => { await navigator.clipboard.writeText(text); new Notice(this.ui.t('Copied.')); }, { icon: 'copy' });
    const markdown = this.host.snapshot().active?.path.toLowerCase().endsWith('.md') ?? false;
    this.ui.button(footer, 'Insert at cursor', () => this.host.insertAtCursor(text), { icon: 'text-cursor-input', disabled: !markdown });
    this.ui.button(footer, 'Append to note', () => this.host.appendToActiveNote(text), { icon: 'arrow-down-to-line', disabled: !markdown });
    this.ui.button(footer, 'Save as note', () => this.host.openQuickAdd('note', `${this.outputTitle}\n${text}`), { icon: 'file-plus-2' });
    if (this.outputSource === 'draft' && (this.outputAction === 'polish' || this.outputAction === 'continue')) {
      const action = this.outputAction;
      this.ui.button(footer, action === 'polish' ? 'Replace draft' : 'Add to draft', () => {
        const draft = this.host.loadWritingDraft();
        const next = action === 'polish' ? text : `${draft.text.trimEnd()}\n\n${text}`;
        if (this.outputDraftRevision === undefined || !this.host.updateWritingDraft({ text: next }, this.outputDraftRevision)) throw new Error('The writing draft changed in another view. Review the latest text before saving.');
        new Notice(this.ui.t('Writing draft updated.'));
      }, { icon: 'pen-line' });
    }
    const tasks = this.outputAction === 'tasks' ? extractTasks(text) : [];
    if (tasks.length) this.ui.userButton(footer, this.ui.t('Add {count} tasks', { count: this.ui.number(tasks.length) }), () => this.host.openQuickAdd('task', tasks.join('\n')), { icon: 'list-plus', cls: 'mod-cta' });
  }

  private async run(action: AiActionId): Promise<void> {
    if (this.running) return;
    const question = action === 'ask' ? this.question : undefined;
    const controller = new AbortController();
    this.running = controller;
    this.output = '';
    this.failure = '';
    this.outputAction = action;
    this.outputSource = this.source;
    this.outputDraftRevision = undefined;
    this.outputTitle = '';
    try {
      const context = await this.host.aiContext(this.source);
      this.outputTitle = context.title;
      this.outputDraftRevision = context.draftRevision;
      this.render();
      this.output = await this.host.runAi({ action, context, question }, (text) => {
        this.output = text;
        if (this.body?.isConnected) {
          const pinned = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 40;
          this.body.textContent = text;
          if (pinned) this.body.scrollTop = this.body.scrollHeight;
        }
      }, controller.signal);
      if (action === 'ask' && this.question === question) this.question = '';
    } catch (error) {
      // A stopped request keeps whatever text had already arrived.
      if (!controller.signal.aborted || !this.output) this.failure = describeError(this.host.settings.language, error);
    } finally {
      this.running = undefined;
      this.render();
    }
  }
}
