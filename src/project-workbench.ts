import { Notice, setTooltip } from 'obsidian';
import { describeError } from './i18n';
import type { WorkbenchProject, WorkbenchProjectTask } from './project-workbench-data';
import { sortTaskDisplay, taskDisplayRank, taskDueLabel, type TaskDisplay } from './task-display';
import { renderTaskMetadata } from './task-row';
import type { SidebarHost } from './types';
import { icon, type SidebarUI } from './ui';

const TASK_PREVIEW_LIMIT = 5;
const PROJECT_STATUS = { open: 'Active', done: 'Completed', archived: 'Archived', unknown: 'Status not set' } as const;

export function rankWorkbenchProjects(projects: readonly WorkbenchProject[], today: Date): Array<{ project: WorkbenchProject; nextTask: TaskDisplay | undefined }> {
  const done = (project: WorkbenchProject) => Number(project.status === 'done' || project.status === 'archived');
  const due = (project: WorkbenchProject) => project.due?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rank = (task: TaskDisplay | undefined) => task ? taskDisplayRank(task, today) : 5;
  return projects.map((project) => ({ project, nextTask: sortTaskDisplay(project.tasks.filter((task) => !task.done), today)[0]?.display }))
    .sort((left, right) => done(left.project) - done(right.project) || rank(left.nextTask) - rank(right.nextTask)
      || due(left.project) - due(right.project) || left.project.name.localeCompare(right.project.name));
}

export class ProjectWorkbench {
  private container?: HTMLElement;
  private selectedProject: string | null = null;
  private renderedProject: string | null = null;
  private expandedTasks = false;
  private readonly taskListId = `tangrow-project-tasks-${crypto.randomUUID()}`;
  private taskInput?: HTMLInputElement;
  private composingInput?: HTMLInputElement;
  private deferredRender = false;
  private readonly taskDrafts = new Map<string, string>();
  private readonly addingTasks = new Set<string>();
  private readonly completingTasks = new Set<string>();

  constructor(
    private readonly host: SidebarHost,
    private readonly ui: SidebarUI,
    private readonly onChange: () => void
  ) {}

  showProject(path: string | null): void {
    if (this.selectedProject === path) return;
    this.selectedProject = path;
    this.expandedTasks = false;
    this.onChange();
  }

  render(parent: HTMLElement): void {
    const previous = this.taskInput;
    const focused = previous && parent.ownerDocument.activeElement === previous && parent.contains(previous);
    if (focused && previous === this.composingInput && this.selectedProject === this.renderedProject) {
      this.deferredRender = true;
      return;
    }
    this.deferredRender = false;
    this.composingInput = undefined;
    const selection = focused ? [previous.selectionStart ?? 0, previous.selectionEnd ?? 0] as const : null;
    this.container = parent;
    parent.empty();
    const view = parent.createDiv({ cls: 'tangrow-project-workbench' });
    const projects = this.host.workbenchProjects();
    const project = projects.find((item) => item.path === this.selectedProject);
    this.renderedProject = project?.path ?? null;
    const today = new Date();
    if (project) this.taskInput = this.renderDetail(view, project, today);
    else {
      this.taskInput = undefined;
      this.selectedProject = null;
      this.renderList(view, projects, today);
    }
    this.ui.comingSoon(view, 'AI writes a project brief and breaks down tasks');
    if (selection && this.taskInput) {
      this.taskInput.focus({ preventScroll: true });
      this.taskInput.setSelectionRange(...selection);
    }
  }

  private focusAction(action: string): void {
    Array.from(this.container?.querySelectorAll<HTMLElement>('[data-tangrow-action]') ?? [])
      .find((control) => control.dataset.tangrowAction === action)?.focus();
  }

  private projectMeta(project: WorkbenchProject, today: Date): string {
    const status = this.ui.t(PROJECT_STATUS[project.status]);
    if (!project.due) return status;
    const due = taskDueLabel(project.due, today, this.host.settings.language);
    return `${status} · ${this.ui.t('Next task deadline · {date}', { date: due.text })}`;
  }

  private renderList(parent: HTMLElement, projects: readonly WorkbenchProject[], today: Date): void {
    const create = () => this.host.openQuickAdd('project');
    if (!projects.length) {
      this.ui.empty(parent, 'No projects yet', 'A project brings tasks and notes together around something you want to finish.', 'folder-kanban', [
        { label: 'New project', onClick: create, icon: 'plus', level: 'primary' }
      ]);
      return;
    }
    this.ui.button(parent, 'New project', create, { icon: 'plus', level: 'text' });
    const list = parent.createDiv({ cls: 'tangrow-note-list' });
    for (const { project, nextTask } of rankWorkbenchProjects(projects, today)) {
      const next = nextTask?.title ? this.ui.t('Next: {task}', { task: nextTask.title }) : this.ui.t('No next step yet');
      const detail = `${this.projectMeta(project, today)} · ${next}`;
      const row = this.ui.userButton(list, project.name, () => {
        this.showProject(project.path);
        this.focusAction('project-back');
      }, { cls: 'tangrow-note-row', icon: 'folder-kanban', title: project.path });
      row.dataset.tangrowAction = `project-open-${project.path}`;
      row.createSpan({ cls: 'tangrow-note-folder', text: detail });
      row.setAttribute('aria-label', `${project.name} · ${detail}`);
    }
  }

  private renderDetail(parent: HTMLElement, project: WorkbenchProject, today: Date): HTMLInputElement | undefined {
    const heading = parent.createDiv({ cls: 'tangrow-project-heading' });
    const back = this.ui.button(heading, 'Back to projects', () => {
      this.showProject(null);
      this.focusAction(`project-open-${project.path}`);
    }, { icon: 'chevron-left', level: 'text' });
    back.dataset.tangrowAction = 'project-back';
    heading.createEl('h3', { text: project.name });
    parent.createEl('p', { cls: 'tangrow-muted tangrow-project-status', text: this.projectMeta(project, today) });

    const latest = project.notes[0];
    const path = latest?.path ?? project.notePath;
    if (path) {
      const label = latest ? this.ui.t('Continue: {note}', { note: latest.name }) : this.ui.t('Open the project note');
      const primary = this.ui.userButton(parent, label, () => this.host.openNote(path), {
        icon: latest?.kind === 'draft' ? 'pen-line' : 'file-text', cls: 'tangrow-full-width', level: 'primary'
      });
      primary.dataset.tangrowAction = 'project-continue';
    } else this.ui.paragraph(parent, 'This project folder has no project note yet.');

    const notes = parent.createEl('section');
    this.ui.sectionHeading(notes, 'Manuscripts and notes');
    if (!project.notes.length) this.ui.paragraph(notes, 'Notes inside the project folder or linked to the project appear here.');
    for (const note of project.notes) {
      const row = this.ui.userButton(notes, note.name, () => this.host.openNote(note.path), {
        icon: note.kind === 'draft' ? 'pen-line' : 'file-text', cls: 'tangrow-note-row', title: note.path
      });
      row.dataset.tangrowAction = `project-note-${note.path}`;
      const kind = this.ui.t(note.kind === 'draft' ? 'Manuscript' : 'Note');
      row.createSpan({ cls: 'tangrow-note-folder', text: kind });
    }
    return this.renderTasks(parent, project, today);
  }

  private renderTasks(parent: HTMLElement, project: WorkbenchProject, today: Date): HTMLInputElement | undefined {
    const section = parent.createEl('section');
    const heading = section.createDiv({ cls: 'tangrow-list-heading tangrow-project-task-heading' });
    this.ui.sectionHeading(heading, 'Tasks');
    const open = project.tasks.filter((task) => !task.done);
    if (project.tasks.length) {
      const done = project.tasks.length - open.length;
      const progress = heading.createDiv({ cls: 'tangrow-project-progress' });
      const label = this.ui.t('{done}/{total} done', { done: this.ui.number(done), total: this.ui.number(project.tasks.length) });
      const meter = progress.createEl('progress', { attr: { 'aria-label': label, max: String(project.tasks.length) } });
      meter.value = done;
      progress.createSpan({ text: label, attr: { 'aria-hidden': 'true' } });
    }
    const input = project.notePath ? this.renderTaskInput(section, project.notePath) : undefined;
    if (!input) this.ui.paragraph(section, 'Create a project note to add tasks from the task overview.');
    if (!open.length) {
      this.ui.paragraph(section, 'Open tasks from the project folder, linked notes, and the task overview appear here.');
      return input;
    }
    const list = section.createDiv({ cls: 'tangrow-task-list', attr: { id: this.taskListId } });
    const visible = sortTaskDisplay(open, today).slice(0, this.expandedTasks ? open.length : TASK_PREVIEW_LIMIT);
    for (const { task, display } of visible) this.renderTask(list, task, display, today);
    if (open.length > TASK_PREVIEW_LIMIT) {
      const more = this.ui.userButton(section, this.ui.t(this.expandedTasks ? 'Show less' : 'Show {count} more', {
        count: this.ui.number(open.length - TASK_PREVIEW_LIMIT)
      }), () => {
        this.expandedTasks = !this.expandedTasks;
        this.onChange();
      }, { level: 'text' });
      more.dataset.tangrowAction = 'project-task-more';
      more.setAttribute('aria-expanded', String(this.expandedTasks));
      more.setAttribute('aria-controls', this.taskListId);
    }
    return input;
  }

  private renderTaskInput(parent: HTMLElement, projectNotePath: string): HTMLInputElement {
    const form = parent.createEl('form', { cls: 'tangrow-task-add' });
    icon(form, 'plus').setAttribute('aria-hidden', 'true');
    const input = form.createEl('input', { type: 'text', attr: {
      placeholder: this.ui.t('Add a task; Enter adds it to the task overview'), 'aria-label': this.ui.t('New task'), maxlength: '240'
    } });
    input.value = this.taskDrafts.get(projectNotePath) ?? '';
    input.readOnly = this.addingTasks.has(projectNotePath);
    input.dataset.tangrowAction = 'project-task-add';
    input.addEventListener('compositionstart', () => { this.composingInput = input; });
    input.addEventListener('compositionend', () => {
      if (this.composingInput !== input) return;
      this.composingInput = undefined;
      this.taskDrafts.set(projectNotePath, input.value);
      if (this.deferredRender) queueMicrotask(() => this.onChange());
    });
    input.addEventListener('input', (event) => {
      if (this.composingInput !== input && !(event as InputEvent).isComposing) this.taskDrafts.set(projectNotePath, input.value);
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (this.taskInput !== input || this.composingInput === input || !text || this.addingTasks.has(projectNotePath)) return;
      this.taskDrafts.set(projectNotePath, input.value);
      this.addingTasks.add(projectNotePath);
      input.readOnly = true;
      void this.host.addProjectTask(projectNotePath, text).then(() => { this.taskDrafts.delete(projectNotePath); })
        .catch((error: unknown) => new Notice(describeError(this.host.settings.language, error)))
        .finally(() => {
          this.addingTasks.delete(projectNotePath);
          this.onChange();
        });
    });
    return input;
  }

  private renderTask(parent: HTMLElement, task: WorkbenchProjectTask, display: TaskDisplay, today: Date): void {
    const label = display.title || this.ui.t('Untitled task');
    const key = `${task.path}:${task.line}`;
    const row = parent.createDiv({ cls: 'tangrow-task-item' });
    const check = row.createEl('button', { cls: 'tangrow-task-check', attr: {
      type: 'button', 'aria-label': this.ui.t('Complete: {task}', { task: label })
    } });
    const busy = this.completingTasks.has(key);
    check.disabled = busy || !!task.labelPending;
    if (busy) row.addClass('is-completing');
    check.dataset.tangrowAction = `project-task-check-${key}`;
    setTooltip(check, this.ui.t(task.labelPending ? 'Open the note to complete this task' : 'Mark done in the note'));
    check.addEventListener('click', () => {
      if (check.disabled || this.completingTasks.has(key)) return;
      this.completingTasks.add(key);
      check.disabled = true;
      row.addClass('is-completing');
      void this.host.completeTask(task.path, task.line, task.text)
        .catch((error: unknown) => new Notice(describeError(this.host.settings.language, error)))
        .finally(() => {
          this.completingTasks.delete(key);
          this.onChange();
        });
    });
    const open = this.ui.userButton(row, label, () => this.host.openNote(task.path, task.line), { cls: 'tangrow-task-row' });
    open.dataset.tangrowAction = `project-task-note-${key}`;
    setTooltip(open, task.text || task.path);
    const source = task.sourceKind === 'overview' ? this.ui.t('Task overview')
      : this.ui.t(task.sourceKind === 'folder' ? 'Project folder · {note}' : 'Linked note · {note}', { note: task.sourceName });
    renderTaskMetadata(this.ui, open, display, today, this.host.settings.language, { source });
  }
}
