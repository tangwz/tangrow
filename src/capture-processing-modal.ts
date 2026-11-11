import { Modal } from 'obsidian';
import { captureProjectFiles } from './capture-processing';
import { describeError, translate } from './i18n';
import { safeTitle } from './model';
import type { CaptureRequest, CaptureSummary, SidebarHost } from './types';

export class CaptureProcessingModal extends Modal {
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
    const projectId = `tangrow-capture-project-${crypto.randomUUID()}`;
    projectField.createEl('label', { text: t('Project note'), attr: { for: projectId } });
    const project = projectField.createEl('select', { attr: { id: projectId } });
    project.createEl('option', { value: '', text: t('No project') });
    for (const file of captureProjectFiles(this.host.app, this.host.settings).filter((file) => file.path !== this.capture.path)) {
      project.createEl('option', { value: file.path, text: file.path });
    }
    const advice = form.createDiv({ cls: 'tangrow-quick-suggestion', attr: { 'aria-live': 'polite' } });
    if (this.host.aiReady()) {
      const suggest = form.createEl('button', { cls: 'tangrow-button tangrow-capture-suggest', text: t('Suggest with AI'), attr: { type: 'button' } });
      suggest.addEventListener('click', () => {
        if (suggest.disabled) return;
        suggest.disabled = true;
        suggest.textContent = t('Thinking...');
        error.textContent = '';
        void this.host.readCapture(this.capture.path).then((content) => this.host.suggestCapture(content)).then((result) => {
          // A project or an unsorted idea both map to keeping a note; the user still chooses.
          action.value = result.kind === 'task' ? 'task' : result.kind === 'capture' ? 'done' : 'note';
          if (result.title) title.value = result.title;
          project.value = result.project && action.value === 'note' ? result.project : '';
          advice.textContent = result.reason;
          update();
        }).catch((failure: unknown) => {
          error.textContent = describeError(this.host.settings.language, failure);
        }).finally(() => {
          suggest.disabled = false;
          suggest.textContent = t('Suggest with AI');
        });
      });
    }
    const destination = form.createEl('p', { cls: 'tangrow-destination' });
    const error = form.createDiv({ cls: 'tangrow-input-error', attr: { 'aria-live': 'polite' } });
    const footer = form.createDiv({ cls: 'tangrow-dialog-actions' });
    const cancel = footer.createEl('button', { text: t('Cancel'), attr: { type: 'button' } });
    cancel.addEventListener('click', () => this.close());
    const save = footer.createEl('button', { cls: 'mod-cta', attr: { type: 'submit' } });
    let saving = false;
    const update = (): void => {
      const mode = action.value;
      titleField.hidden = mode !== 'note' && mode !== 'task';
      projectField.hidden = mode !== 'note' && mode !== 'project';
      save.textContent = t(saving ? 'Processing capture...' : 'Process capture');
      action.disabled = title.disabled = project.disabled = saving;
      let valid = true;
      error.textContent = '';
      try {
        if (mode === 'note') safeTitle(title.value);
        if (mode === 'task' && (!title.value.trim() || title.value.trim().length > 240)) valid = false;
        if (mode === 'project' && !project.value) valid = false;
      } catch (failure) { valid = false; error.textContent = describeError(this.host.settings.language, failure); }
      save.disabled = saving || !valid;
      const folder = project.value ? project.value.slice(0, project.value.lastIndexOf('/')) : this.host.settings.inboxFolder;
      destination.textContent = mode === 'task'
        ? translate(this.host.settings.language, 'Destination: {path}', { path: this.host.settings.taskOverviewPath })
        : mode === 'note' ? translate(this.host.settings.language, 'Destination: {path}', { path: folder })
        : t(mode === 'project' ? 'Link the original capture without moving it.' : 'Keep the original capture and mark it processed.');
    };
    for (const control of [action, title, project]) control.addEventListener(control === title ? 'input' : 'change', update);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (saving || save.disabled) return;
      const request: CaptureRequest = action.value === 'note' ? { action: 'note', title: title.value, ...(project.value ? { projectPath: project.value } : {}) }
        : action.value === 'task' ? { action: 'task', title: title.value }
        : action.value === 'project' ? { action: 'project', projectPath: project.value } : { action: 'done' };
      saving = true;
      update();
      void this.host.processCapture(this.capture.path, request).then((result) => {
        if (!result) { this.close(); return; }
        save.hidden = true;
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

  onClose(): void { this.contentEl.empty(); }
}
