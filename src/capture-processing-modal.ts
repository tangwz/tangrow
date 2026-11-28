import { Modal } from 'obsidian';
import { captureFilingEntries, captureProjectFiles } from './capture-processing';
import { describeError, translate } from './i18n';
import { safeTitle } from './model';
import type { CaptureRequest, CaptureSummary, SidebarHost } from './types';

export class CaptureProcessingModal extends Modal {
  private suggestionController: AbortController | null = null;
  constructor(private readonly host: SidebarHost, private readonly capture: CaptureSummary) { super(host.app); }

  onOpen(): void {
    const t = (text: string): string => translate(this.host.settings.language, text);
    this.setTitle(t('Process capture'));
    this.contentEl.addClass('tangrow-dialog');
    this.contentEl.createEl('p', { text: this.capture.name, cls: 'tangrow-muted' });
    const form = this.contentEl.createEl('form', { cls: 'tangrow-capture-process-form' });
    const actionId = `tangrow-capture-action-${crypto.randomUUID()}`;
    form.createEl('label', { text: t('Next step'), attr: { for: actionId } });
    const action = form.createEl('select', { attr: { id: actionId } });
    for (const [value, label] of [['note', 'Turn into a note'], ['task', 'Append to task overview'], ['project', 'Link to a project'], ['done', 'Mark processed']]) {
      action.createEl('option', { value, text: t(label!) });
    }
    const titleField = form.createDiv();
    const titleId = `tangrow-capture-title-${crypto.randomUUID()}`;
    titleField.createEl('label', { text: t('Title'), attr: { for: titleId } });
    const title = titleField.createEl('input', { type: 'text', value: this.capture.name, attr: { id: titleId, maxlength: '240' } });
    const projectField = form.createDiv();
    const search = projectField.createEl('input', { type: 'search', cls: 'tangrow-capture-destination-search' });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) event.preventDefault();
    });
    const projectId = `tangrow-capture-project-${crypto.randomUUID()}`;
    const projectLabel = projectField.createEl('label', { text: t('Project note'), attr: { for: projectId } });
    const project = projectField.createEl('select', { attr: { id: projectId } });
    const projectFiles = captureProjectFiles(this.host.app, this.host.settings).filter((file) => file.path !== this.capture.path);
    const filing = new Map(captureFilingEntries(this.host.app, this.host.settings).map((entry) => [`${entry.kind}:${entry.path}`, entry]));
    const noChoices = projectField.createEl('p', { cls: 'tangrow-muted', text: t('No destinations match this search.'), attr: { 'aria-live': 'polite' } });
    let previousMode = '';
    const renderChoices = (selection = project.value): void => {
      const mode = action.value;
      const query = search.value.trim().toLocaleLowerCase(this.host.settings.language);
      const groups = [{ label: 'Projects', options: projectFiles.map((file) => ({ value: file.path, label: file.path })) }];
      if (mode === 'note' || mode === 'task') groups.push({ label: 'Areas', options: [...filing].flatMap(([value, entry]) =>
        entry.kind === 'area' && (mode === 'note' || (entry.notePath && entry.notePath !== this.capture.path)) ? [{ value, label: entry.path }] : []) });
      if (mode === 'note') groups.push({ label: 'Resources', options: [...filing].flatMap(([value, entry]) =>
        entry.kind === 'resource' ? [{ value, label: entry.path }] : []) });
      project.empty();
      project.createEl('option', { value: '', text: t(mode === 'note' ? 'Keep in the inbox' : mode === 'task' ? 'No link' : 'No project') });
      let kept = '';
      let matched = false;
      for (const { label, options } of groups) {
        const rows = options.filter((option) => {
          const match = option.label.toLocaleLowerCase(this.host.settings.language).includes(query);
          matched ||= match;
          return match || option.value === selection;
        });
        if (!rows.length) continue;
        const group = project.createEl('optgroup', { attr: { label: t(label) } });
        for (const option of rows) {
          group.createEl('option', { value: option.value, text: option.label });
          if (option.value === selection) kept = selection;
        }
      }
      project.value = kept;
      noChoices.hidden = !query || matched;
    };
    const advice = form.createDiv({ cls: 'tangrow-quick-suggestion', attr: { 'aria-live': 'polite' } });
    let saving = false;
    let openingCard = false;
    let suggestButton: HTMLButtonElement | undefined;
    if (this.host.aiReady()) {
      const suggest = form.createEl('button', { cls: 'tangrow-button tangrow-capture-suggest', text: t('Suggest with AI'), attr: { type: 'button' } });
      suggestButton = suggest;
      suggest.addEventListener('click', () => {
        if (suggest.disabled || !this.host.requireAccess()) return;
        const controller = new AbortController();
        this.suggestionController = controller;
        const current = (): boolean => this.suggestionController === controller && !controller.signal.aborted;
        suggest.disabled = true;
        suggest.textContent = t('Thinking...');
        error.textContent = '';
        void this.host.readCapture(this.capture.path).then((content) => current() ? this.host.suggestCapture(content, controller.signal) : null).then((result) => {
          if (!result || !current()) return;
          // A project or an unsorted idea both map to keeping a note; the user still chooses.
          action.value = result.kind === 'task' ? 'task' : result.kind === 'capture' ? 'done' : 'note';
          if (result.title) title.value = result.title;
          search.value = '';
          renderChoices(result.project && action.value === 'note' ? result.project : '');
          advice.textContent = result.reason;
          update();
        }).catch((failure: unknown) => {
          if (current()) error.textContent = describeError(this.host.settings.language, failure);
        }).finally(() => {
          if (this.suggestionController !== controller) return;
          this.suggestionController = null;
          suggest.disabled = saving || openingCard;
          suggest.textContent = t('Suggest with AI');
        });
      });
    }
    const destination = form.createEl('p', { cls: 'tangrow-destination' });
    const error = form.createDiv({ cls: 'tangrow-input-error', attr: { 'aria-live': 'polite' } });
    let cardAction: HTMLElement | undefined;
    let distill: HTMLButtonElement | undefined;
    if (this.host.settings.knowledgeEnabled && !this.capture.processing) {
      cardAction = form.createDiv();
      const detailId = `${actionId}-distill-detail`;
      distill = cardAction.createEl('button', {
        cls: 'tangrow-button', text: t('Distill a card'), attr: { type: 'button', 'aria-describedby': detailId }
      });
      cardAction.createEl('p', {
        cls: 'tangrow-muted', attr: { id: detailId }, text: t('Keeps this capture as the source and preserves its processing status.')
      });
      distill.addEventListener('click', async () => {
        if (saving || openingCard || !this.host.settings.knowledgeEnabled || !this.host.requireAccess()) return;
        openingCard = true;
        this.suggestionController?.abort();
        update();
        let message: string | undefined;
        try {
          await this.host.openCardFromCapture(this.capture.path, () => {
            if (!this.contentEl.contains(form)) return false;
            this.close();
            return true;
          });
        } catch (failure) { message = describeError(this.host.settings.language, failure); }
        if (!this.contentEl.contains(form)) return;
        openingCard = false;
        update();
        if (message) error.textContent = message;
      });
    }
    const footer = form.createDiv({ cls: 'tangrow-dialog-actions' });
    const cancel = footer.createEl('button', { text: t('Cancel'), attr: { type: 'button' } });
    cancel.addEventListener('click', () => this.close());
    const save = footer.createEl('button', { cls: 'mod-cta', attr: { type: 'submit' } });
    const update = (): void => {
      const mode = action.value;
      const busy = saving || openingCard;
      if (mode !== previousMode) { previousMode = mode; renderChoices(); }
      titleField.hidden = mode !== 'note' && mode !== 'task';
      projectField.hidden = mode !== 'note' && mode !== 'project' && mode !== 'task';
      projectLabel.textContent = t(mode === 'note' ? 'Filing destination' : mode === 'task' ? 'Project or area link (optional)' : 'Project note');
      const searchLabel = t(mode === 'note' ? 'Search destinations' : mode === 'task' ? 'Search projects and areas' : 'Search projects');
      search.setAttribute('aria-label', searchLabel);
      search.setAttribute('placeholder', searchLabel);
      save.textContent = t(saving ? 'Processing capture...' : 'Process capture');
      action.disabled = title.disabled = search.disabled = project.disabled = busy;
      if (suggestButton) suggestButton.disabled = busy || this.suggestionController !== null;
      if (distill) distill.disabled = busy;
      let valid = true;
      error.textContent = '';
      try {
        if (mode === 'note') safeTitle(title.value);
        if (mode === 'task' && (!title.value.trim() || title.value.trim().length > 240)) valid = false;
        if (mode === 'project' && !project.value) valid = false;
      } catch (failure) { valid = false; error.textContent = describeError(this.host.settings.language, failure); }
      save.disabled = busy || !valid;
      const filingChoice = filing.get(project.value);
      const folder = filingChoice?.folder ?? (project.value ? project.value.slice(0, project.value.lastIndexOf('/')) : this.host.settings.inboxFolder);
      const linkTarget = filingChoice?.notePath ?? project.value;
      destination.textContent = mode === 'task'
        ? linkTarget ? translate(this.host.settings.language, 'Destination: {path} · Link: {target}', { path: this.host.settings.taskOverviewPath, target: linkTarget })
          : translate(this.host.settings.language, 'Destination: {path}', { path: this.host.settings.taskOverviewPath })
        : mode === 'note' ? translate(this.host.settings.language, 'Destination: {path}', { path: folder })
        : t(mode === 'project' ? 'Link the original capture without moving it.' : 'Keep the original capture and mark it processed.');
    };
    for (const control of [action, title, project]) control.addEventListener(control === title ? 'input' : 'change', () => {
      // Aborting also invalidates replies from providers that finish after cancellation.
      this.suggestionController?.abort();
      update();
    });
    search.addEventListener('input', () => {
      this.suggestionController?.abort();
      renderChoices();
      update();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (saving || openingCard || save.disabled || !this.host.requireAccess()) return;
      const projectChoice = project.value ? { projectPath: project.value } : {};
      const filingChoice = filing.get(project.value);
      const request: CaptureRequest = action.value === 'note' ? { action: 'note', title: title.value,
        ...(filingChoice ? { destination: { kind: filingChoice.kind, path: filingChoice.path } } : projectChoice) }
        : action.value === 'task' ? { action: 'task', title: title.value,
          ...(filingChoice?.notePath ? { areaPath: filingChoice.notePath } : projectChoice) }
        : action.value === 'project' ? { action: 'project', projectPath: project.value } : { action: 'done' };
      saving = true;
      this.suggestionController?.abort();
      update();
      void this.host.processCapture(this.capture.path, request).then((result) => {
        if (!result) { this.close(); return; }
        save.hidden = true;
        if (cardAction) cardAction.hidden = true;
        cancel.textContent = t('Done');
        destination.textContent = translate(this.host.settings.language, 'Destination: {path}', { path: result });
        const open = footer.createEl('button', { text: t('Open result'), cls: 'mod-cta', attr: { type: 'button' } });
        open.addEventListener('click', () => {
          void this.host.openNote(result).then(() => this.close()).catch((failure: unknown) => {
            error.textContent = describeError(this.host.settings.language, failure);
          });
        });
      }).catch((failure: unknown) => {
        saving = false;
        update();
        error.textContent = describeError(this.host.settings.language, failure);
      });
    });
    update();
    title.focus();
    title.select();
  }

  onClose(): void {
    this.suggestionController?.abort();
    this.suggestionController = null;
    this.contentEl.empty();
  }
}
