import { MarkdownRenderer, Notice, type Component } from 'obsidian';
import { CLAUDIAN_ID, WORKFLOWS, type Workflow } from './claudian';
import { describeError } from './i18n';
import type { SidebarHost } from './types';
import { SidebarUI, icon } from './ui';

/**
 * The assistant workspace. Multi-step jobs are handed to the Claudian plugin, whose agent
 * reads and edits the vault itself; Tangrow supplies the vault conventions and the entry points.
 */
export class AiPanel {
  private readonly ui: SidebarUI;
  private root?: HTMLElement;
  private sending = false;

  constructor(private readonly host: SidebarHost, private readonly component: Component) {
    this.ui = new SidebarUI(() => this.host.settings.language);
  }

  /** Re-renders when the active note, Claudian's state or a running job changes. */
  refresh(): void { if (this.root) this.render(); }

  mount(container: HTMLElement): void {
    this.root = container.createDiv({ cls: 'tangrow-ai-panel' });
    this.render();
  }

  destroy(): void {
    this.root?.remove();
    this.root = undefined;
  }

  private render(): void {
    const root = this.root;
    if (!root) return;
    root.empty();
    this.ui.sectionHeading(root, 'Vault workflows', 'Multi-step jobs that Claudian\'s agent carries out with this vault\'s folders and properties.');
    const status = this.host.agentStatus();
    if (status === 'missing' || status === 'incompatible') {
      const box = root.createDiv({ cls: 'tangrow-empty' });
      icon(box, 'bot');
      box.createEl('strong', { text: this.ui.t(status === 'missing' ? 'Claudian is not installed or enabled' : 'This Claudian version is not supported') });
      this.ui.paragraph(box, status === 'missing'
        ? 'Workflows run in Claudian, a separate community plugin that embeds Claude Code and other agents in Obsidian. It is desktop only.'
        : 'Tangrow uses version 1 of Claudian\'s plugin API. Update Claudian and Tangrow, then reopen this panel.');
      if (status === 'missing') this.ui.button(box, 'Find Claudian in Community plugins', () => { window.open(`obsidian://show-plugin?id=${CLAUDIAN_ID}`); }, { icon: 'external-link', cls: 'mod-cta' });
    } else {
      this.renderRun(root);
      const markdown = this.host.snapshot().active?.path.toLowerCase().endsWith('.md') ?? false;
      const busy = this.sending || this.host.agentRun()?.state === 'running';
      const list = root.createDiv({ cls: 'tangrow-workflows' });
      for (const item of WORKFLOWS) this.renderWorkflow(list, item, busy, markdown);
      this.ui.paragraph(root, status === 'idle'
        ? 'No Claudian chat is focused. Running a workflow opens Claudian; pick or start a chat there, then run it again.'
        : 'Jobs go to the chat that is focused in Claudian. Its agent edits files under Claudian\'s own permission settings, and each job that writes shows its plan and waits for your reply first.', 'tangrow-muted tangrow-ai-privacy');
      const skills = root.createDiv({ cls: 'tangrow-ai-guide' });
      this.ui.sectionHeading(skills, 'Use them from the chat', 'Installs these workflows as vault skills in .claude/skills, so you can call them by typing / in Claudian or Claude Code. Existing skill files are left unchanged.');
      const row = skills.createDiv({ cls: 'tangrow-actions' });
      this.ui.button(row, 'Install skills', () => this.host.installAgentSkills(), { icon: 'package-plus' });
      this.ui.button(row, 'Open Claudian', () => this.host.openAgent(), { icon: 'bot' });
    }
    this.renderGuide(root);
    this.renderBuiltIn(root);
  }

  private renderWorkflow(list: HTMLElement, item: Workflow, busy: boolean, markdown: boolean): void {
    const blocked = item.needsNote && !markdown;
    const button = list.createEl('button', { cls: 'tangrow-workflow', attr: { type: 'button' } });
    button.disabled = busy || blocked;
    icon(button, item.icon);
    const copy = button.createDiv({ cls: 'tangrow-workflow-copy' });
    copy.createEl('strong', { text: this.ui.t(item.label) });
    copy.createSpan({ text: this.ui.t(blocked ? 'Open a Markdown note first.' : item.description) });
    button.createSpan({ cls: 'tangrow-workflow-tag', text: this.ui.t(item.writes ? 'Asks before writing' : 'Read only') });
    button.addEventListener('click', () => { void this.run(item); });
  }

  private renderRun(root: HTMLElement): void {
    const run = this.host.agentRun();
    if (!run) return;
    const item = WORKFLOWS.find((entry) => entry.id === run.workflow);
    const card = root.createDiv({ cls: 'tangrow-ai-output', attr: { 'aria-live': 'polite' } });
    const heading = card.createDiv({ cls: 'tangrow-ai-output-heading' });
    icon(heading, run.state === 'running' ? 'loader' : 'sparkles');
    heading.createEl('strong', { text: this.ui.t(item?.label ?? 'Workflow') });
    heading.createSpan({ cls: 'tangrow-muted', text: this.ui.t(run.state === 'running' ? 'Running in Claudian' : 'Latest reply') });
    const body = card.createDiv({ cls: 'tangrow-ai-output-body' });
    const footer = card.createDiv({ cls: 'tangrow-ai-output-actions' });
    if (run.state === 'running') {
      body.addClass('is-streaming');
      body.textContent = this.ui.t('Claudian is working. Answer its questions and permission requests in the chat; its reply appears here when the turn ends.');
      this.ui.button(footer, 'Open Claudian', () => this.host.openAgent(), { icon: 'bot' });
      this.ui.button(footer, 'Stop', () => this.host.stopWorkflow(), { icon: 'circle-stop' });
      return;
    }
    const text = run.reply;
    if (text) {
      body.addClass('markdown-rendered');
      try { void MarkdownRenderer.render(this.host.app, text, body, this.host.snapshot().active?.path ?? '', this.component); }
      catch { body.textContent = text; }
      this.ui.button(footer, 'Copy', async () => { await navigator.clipboard.writeText(text); new Notice(this.ui.t('Copied.')); }, { icon: 'copy' });
    } else body.textContent = this.ui.t('The turn ended without a reply that could be read. Check the chat in Claudian.');
    this.ui.button(footer, 'Continue in Claudian', () => this.host.openAgent(), { icon: 'bot' });
    this.ui.button(footer, 'Dismiss', () => this.host.stopWorkflow(), { icon: 'x' });
  }

  private renderGuide(root: HTMLElement): void {
    const guide = root.createDiv({ cls: 'tangrow-ai-guide' });
    this.ui.sectionHeading(guide, 'Agent guide', 'A plain description of this vault\'s folders and properties. Every workflow tells the agent to read it first.');
    this.ui.button(guide, 'Open agent guide', () => this.host.openAiGuide(), { icon: 'book-open', cls: 'tangrow-full-width' });
  }

  private renderBuiltIn(root: HTMLElement): void {
    const section = root.createDiv({ cls: 'tangrow-ai-guide' });
    this.ui.sectionHeading(section, 'Instant suggestions', this.host.aiReady()
      ? 'On. Quick add and capture processing can suggest a type, title, date and project with your own Anthropic API key.'
      : 'Off. Quick add and capture processing can suggest a type, title, date and project once you add your own Anthropic API key.');
    this.ui.button(section, 'Open AI settings', () => this.host.action('settings'), { icon: 'settings-2', cls: 'tangrow-full-width' });
  }

  private async run(item: Workflow): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    this.render();
    try { await this.host.runWorkflow(item.id); }
    catch (error) { new Notice(describeError(this.host.settings.language, error)); }
    finally { this.sending = false; this.render(); }
  }
}
