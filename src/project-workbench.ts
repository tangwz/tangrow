import { Notice, setTooltip } from 'obsidian';
import { describeError } from './i18n';
import type { WorkbenchArea, WorkbenchLinkCandidate, WorkbenchProject, WorkbenchProjectTask } from './project-workbench-data';
import { sortTaskDisplay, taskDisplayRank, taskDueLabel, type TaskDisplay } from './task-display';
import { renderTaskMetadata } from './task-row';
import type { NoteSummary, SidebarHost } from './types';
import { icon, type SidebarUI } from './ui';
import { renderWorkbenchPicker, type WorkbenchPickerItem, type WorkbenchPickerState } from './workbench-picker';

const TASK_PREVIEW_LIMIT = 5;
const PROJECT_STATUS = { open: 'Active', done: 'Completed', archived: 'Archived', unknown: 'Status not set' } as const;
type EntityKind = 'project' | 'area';
type PickerKind = 'area' | 'notes' | 'references';
type TaskEntity = Pick<WorkbenchProject, 'path' | 'notePath' | 'tasks'>;
type RankedProject = { project: WorkbenchProject; nextTask: TaskDisplay | undefined };

export function rankWorkbenchProjects(projects: readonly WorkbenchProject[], today: Date): RankedProject[] {
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
  private selectedArea: string | null = null;
  private projectFromArea?: string;
  private renderedEntity: string | null = null;
  private groupByArea = false;
  private readonly collapsedAreaGroups = new Set<string>();
  private picker?: { kind: PickerKind; state: WorkbenchPickerState; saving: boolean };
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
    private readonly onChange: () => void,
    private readonly openProject?: (path: string, fromArea?: string) => void,
    private readonly openArea?: (path: string) => void
  ) {}

  showProject(path: string | null, fromArea?: string): void {
    if (this.selectedProject === path && this.projectFromArea === fromArea) return;
    this.selectedProject = path;
    this.projectFromArea = fromArea;
    this.picker = undefined;
    this.expandedTasks = false;
    this.onChange();
  }

  showArea(path: string | null): void {
    if (this.selectedArea === path) return;
    this.selectedArea = path;
    this.expandedTasks = false;
    this.onChange();
  }

  render(parent: HTMLElement): void { this.renderView(parent, 'project'); }
  renderAreas(parent: HTMLElement): void { this.renderView(parent, 'area'); }

  private renderView(parent: HTMLElement, kind: EntityKind): void {
    const selected = kind === 'project' ? this.selectedProject : this.selectedArea;
    const entity = selected ? `${kind}:${selected}` : null;
    const previous = this.taskInput;
    const focused = previous && parent.ownerDocument.activeElement === previous && parent.contains(previous);
    if (parent === this.container && entity === this.renderedEntity && this.picker?.saving) return;
    if (focused && previous === this.composingInput && entity === this.renderedEntity) {
      this.deferredRender = true;
      return;
    }
    this.deferredRender = false;
    this.composingInput = undefined;
    const selection = focused ? [previous.selectionStart ?? 0, previous.selectionEnd ?? 0] as const : null;
    this.container = parent;
    this.renderedEntity = entity;
    parent.empty();
    const view = parent.createDiv({ cls: 'tangrow-project-workbench' });
    const today = new Date();
    this.taskInput = undefined;
    if (kind === 'project') {
      const projects = this.host.workbenchProjects();
      const project = projects.find((item) => item.path === selected);
      if (project) this.taskInput = this.renderDetail(view, project, today);
      else {
        this.selectedProject = null;
        this.picker = undefined;
        this.renderList(view, projects, today);
      }
      this.ui.comingSoon(view, 'AI writes a project brief and breaks down tasks');
    } else {
      const areas = this.host.workbenchAreas();
      const area = areas.find((item) => item.path === selected);
      if (area) this.taskInput = this.renderAreaDetail(view, area, today);
      else {
        this.selectedArea = null;
        this.renderAreaList(view, areas);
      }
    }
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
    const toolbar = parent.createDiv({ cls: 'tangrow-project-toolbar' });
    this.ui.button(toolbar, 'New project', create, { icon: 'plus', level: 'text' });
    const mode = toolbar.createEl('select', { attr: { 'aria-label': this.ui.t('Organize projects') } });
    mode.createEl('option', { value: 'urgency', text: this.ui.t('By task urgency') });
    mode.createEl('option', { value: 'area', text: this.ui.t('By area') });
    mode.value = this.groupByArea ? 'area' : 'urgency';
    mode.dataset.tangrowAction = 'project-group-mode';
    mode.addEventListener('change', () => { this.groupByArea = mode.value === 'area'; this.onChange(); });
    const ranked = rankWorkbenchProjects(projects, today);
    if (!this.groupByArea) {
      this.renderProjectRows(parent, ranked, today);
      return;
    }
    const areas = this.host.workbenchAreas();
    const known = new Set(areas.map((area) => area.path));
    for (const area of areas) {
      const entries = ranked.filter(({ project }) => project.areaPath === area.path);
      if (entries.length) this.renderProjectGroup(parent, area.path, area.name, entries, today);
    }
    const unlinked = ranked.filter(({ project }) => !project.areaPath || !known.has(project.areaPath));
    if (unlinked.length) this.renderProjectGroup(parent, '', this.ui.t('No linked area'), unlinked, today);
  }

  private renderProjectGroup(parent: HTMLElement, areaPath: string, name: string, ranked: readonly RankedProject[], today: Date): void {
    const group = parent.createEl('section');
    const expanded = !this.collapsedAreaGroups.has(areaPath);
    const heading = group.createEl('h3', { cls: 'tangrow-section-title tangrow-project-group-heading' });
    const rows = group.createDiv({ attr: { id: `tangrow-project-group-${crypto.randomUUID()}` } });
    const title = this.ui.userButton(heading, `${name} · ${this.ui.number(ranked.length)}`, () => {
      if (expanded) this.collapsedAreaGroups.add(areaPath);
      else this.collapsedAreaGroups.delete(areaPath);
      this.onChange();
      this.focusAction(`project-group-${areaPath}`);
    }, { icon: expanded ? 'chevron-down' : 'chevron-right', level: 'text' });
    title.dataset.tangrowAction = `project-group-${areaPath}`;
    title.setAttribute('aria-expanded', String(expanded));
    title.setAttribute('aria-controls', rows.id);
    if (expanded) this.renderProjectRows(rows, ranked, today);
  }

  private renderProjectRows(parent: HTMLElement, ranked: readonly RankedProject[], today: Date): void {
    const list = parent.createDiv({ cls: 'tangrow-note-list' });
    const areaNames = new Map(this.groupByArea ? [] : this.host.workbenchAreas().map((area) => [area.path, area.name]));
    for (const { project, nextTask } of ranked) {
      const next = nextTask?.title ? this.ui.t('Next: {task}', { task: nextTask.title }) : this.ui.t('No next step yet');
      const area = project.areaPath ? areaNames.get(project.areaPath) : undefined;
      const status = this.awaitingArchive(project) ? this.ui.t('Completed · move to archive') : this.projectMeta(project, today);
      const detail = [status, area, next].filter(Boolean).join(' · ');
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
    const area = this.projectFromArea;
    this.detailHeading(parent, project.name, area && this.openArea ? 'Back to area' : 'Back to projects', 'project-back', () => {
      if (area && this.openArea) {
        this.openArea(area);
        this.focusAction(`area-project-${project.path}`);
      } else {
        this.showProject(null);
        this.focusAction(`project-open-${project.path}`);
      }
    });
    parent.createEl('p', { cls: 'tangrow-muted tangrow-project-status', text: this.projectMeta(project, today) });
    if (project.areaNotePath) this.renderProjectArea(parent, project);

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
    this.renderLinkHeading(notes, 'Manuscripts and notes', 'Link', 'notes', project.notePath !== null);
    if (this.picker?.kind === 'notes') this.renderNotePicker(notes, project, 'notes');
    if (!project.notes.length) this.ui.paragraph(notes, 'Notes inside the project folder or linked to the project appear here.');
    for (const note of project.notes) {
      const kind = this.ui.t(note.kind === 'draft' ? 'Manuscript' : 'Note');
      this.noteRow(notes, note, kind, note.kind === 'draft' ? 'pen-line' : 'file-text', 'project-note');
    }
    const input = this.renderTasks(parent, project, today, 'project');
    this.renderReferences(parent, project);
    this.renderArchive(parent, project);
    return input;
  }

  private detailHeading(parent: HTMLElement, name: string, label: string, action: string, onBack: () => void): void {
    const heading = parent.createDiv({ cls: 'tangrow-project-heading' });
    const back = this.ui.button(heading, label, onBack, { icon: 'chevron-left', level: 'text' });
    back.dataset.tangrowAction = action;
    heading.createEl('h3', { text: name });
  }

  private renderProjectArea(parent: HTMLElement, project: WorkbenchProject): void {
    const areas = this.host.workbenchAreas().filter((area) => area.notePath !== null);
    const assigned = areas.find((area) => area.path === project.areaPath);
    const button = this.ui.userButton(parent, assigned ? this.ui.t('Area · {area}', { area: assigned.name }) : this.ui.t('Set area'),
      () => this.togglePicker('area', project.areaPath), { icon: 'layers', level: 'text' });
    button.dataset.tangrowAction = 'project-picker-area';
    button.setAttribute('aria-expanded', String(this.picker?.kind === 'area'));
    if (this.picker?.kind !== 'area') return;
    const items: WorkbenchPickerItem[] = areas.map((area) => ({ path: area.path, label: area.name, detail: area.path }));
    if (project.areaPath) items.push({ path: '', label: this.ui.t('Clear area') });
    this.renderPicker(parent, 'area', this.ui.t('Set area'), items, (path) => this.host.setWorkbenchProjectArea(project.path, path || null));
  }

  private renderLinkHeading(parent: HTMLElement, title: string, label: string, kind: 'notes' | 'references', canLink: boolean): void {
    const heading = parent.createDiv({ cls: 'tangrow-list-heading' });
    this.ui.sectionHeading(heading, title);
    if (!canLink) return;
    const button = this.ui.button(heading, label, () => this.togglePicker(kind), { icon: 'plus', level: 'text' });
    button.dataset.tangrowAction = `project-picker-${kind}`;
    button.setAttribute('aria-expanded', String(this.picker?.kind === kind));
  }

  private renderReferences(parent: HTMLElement, project: WorkbenchProject): void {
    const section = parent.createEl('section');
    this.renderLinkHeading(section, 'Reference', 'Add', 'references', project.notePath !== null);
    if (this.picker?.kind === 'references') this.renderNotePicker(section, project, 'references');
    if (!project.references.length) this.ui.paragraph(section, 'Materials and cards linked to this project appear here.');
    for (const role of ['material', 'card'] as const) {
      const references = project.references.filter((note) => note.role === role);
      if (!references.length) continue;
      section.createEl('h4', { cls: 'tangrow-project-reference-title', text: this.ui.t(role === 'material' ? 'Materials' : 'Cards') });
      for (const note of references) {
        const location = note.path.startsWith(`${this.host.settings.resourcesFolder}/`)
          ? this.ui.t('{location} · Resource', { location: note.location }) : note.location;
        this.noteRow(section, note, location, role === 'card' ? 'notebook-pen' : 'book-open', 'project-reference');
      }
    }
  }

  private renderNotePicker(parent: HTMLElement, project: WorkbenchProject, kind: 'notes' | 'references'): void {
    const projects = new Map(this.host.workbenchProjects().map((item) => [item.path, item.name]));
    const linked = new Set([...project.notes, ...project.references].map((note) => note.path));
    const candidates = this.host.workbenchLinkCandidates().filter((note) => note.path !== project.notePath
      && !linked.has(note.path) && (kind === 'notes' ? note.role === 'note' : note.role !== 'note'));
    const group = (note: WorkbenchLinkCandidate) => this.ui.t(note.role === 'card' ? 'Cards' : note.role === 'material' ? 'Materials' : 'Notes');
    const items = candidates.map((note): WorkbenchPickerItem => {
      const assigned = note.projectPath ? projects.get(note.projectPath) : undefined;
      const detail = [note.location, assigned && this.ui.t('Currently linked to {project}', { project: assigned })].filter(Boolean).join(' · ');
      return { path: note.path, label: note.name, detail, group: group(note) };
    });
    this.renderPicker(parent, kind, this.ui.t(kind === 'notes' ? 'Link a project note' : 'Add reference'), items,
      (path) => this.host.linkWorkbenchNote(path, project.path));
  }

  private togglePicker(kind: PickerKind, selected: string | null = null): void {
    if (this.picker?.saving) return;
    this.picker = this.picker?.kind === kind ? undefined : { kind, state: { query: '', selected }, saving: false };
    this.onChange();
    this.focusAction(this.picker ? `project-picker-search-${kind}` : `project-picker-${kind}`);
  }

  private renderPicker(parent: HTMLElement, kind: PickerKind, label: string, items: readonly WorkbenchPickerItem[],
    save: (path: string) => Promise<void>): void {
    const picker = this.picker;
    if (picker?.kind !== kind) return;
    const entity = this.renderedEntity;
    const search = renderWorkbenchPicker(parent, this.ui, {
      label, items, state: picker.state,
      onCancel: () => { if (this.picker === picker) this.togglePicker(kind); },
      onConfirm: async (path) => {
        if (this.picker !== picker || picker.saving) return;
        picker.saving = true;
        try {
          await save(path);
          if (this.picker === picker) this.picker = undefined;
        } finally {
          picker.saving = false;
          this.onChange();
          if (this.renderedEntity === entity) this.focusAction(this.picker === picker ? `project-picker-search-${kind}` : `project-picker-${kind}`);
        }
      }
    });
    search.dataset.tangrowAction = `project-picker-search-${kind}`;
  }

  private awaitingArchive(project: WorkbenchProject): boolean { return project.status === 'done' || project.status === 'archived'; }

  private renderArchive(parent: HTMLElement, project: WorkbenchProject): void {
    const wrap = parent.createEl('section');
    this.ui.sectionHeading(wrap, 'Wrap up');
    if (!this.awaitingArchive(project)) {
      this.ui.button(wrap, 'Mark as done', () => this.host.setWorkbenchProjectStatus(project.path, 'done'), { icon: 'check', level: 'text' });
      this.ui.paragraph(wrap, 'Marking a project as done only changes its status.');
      return;
    }
    const hint = wrap.createDiv({ cls: 'tangrow-project-archive' });
    hint.createEl('p', { cls: 'tangrow-muted', attr: { role: 'status' }, text: this.ui.t('Move this project into {folder} from the file list when you are ready.', {
      folder: this.host.settings.archiveFolder
    }) });
    const actions = hint.createDiv({ cls: 'tangrow-workbench-picker-actions' });
    this.ui.button(actions, 'Reveal in file list', () => this.host.revealWorkbenchPath(project.path), { icon: 'folder-search' });
    this.ui.button(actions, 'Reopen project', () => this.host.setWorkbenchProjectStatus(project.path, 'open'), { level: 'text' });
  }

  private noteRow(parent: HTMLElement, note: Pick<NoteSummary, 'path' | 'name'>, detail: string, iconName: string, action: string): void {
    const row = this.ui.userButton(parent, note.name, () => this.host.openNote(note.path), {
      icon: iconName, cls: 'tangrow-note-row', title: note.path
    });
    row.dataset.tangrowAction = `${action}-${note.path}`;
    row.createSpan({ cls: 'tangrow-note-folder', text: detail });
    row.setAttribute('aria-label', `${note.name} · ${detail}`);
  }

  private renderAreaList(parent: HTMLElement, areas: readonly WorkbenchArea[]): void {
    if (!areas.length) {
      this.ui.empty(parent, 'No areas yet', 'Areas are ongoing responsibilities. Folders and root notes in your Areas folder appear here.', 'layers');
    } else {
      const list = parent.createDiv({ cls: 'tangrow-note-list' });
      for (const area of areas) {
        const open = area.tasks.filter((task) => !task.done).length;
        const activity = this.ui.t('{tasks} open tasks · {notes} notes', { tasks: this.ui.number(open), notes: this.ui.number(area.noteCount) });
        const updated = area.modified === null ? '' : this.updatedLabel(area.modified);
        const detail = [activity, updated].filter(Boolean).join(' · ');
        const row = this.ui.userButton(list, area.name, () => {
          this.showArea(area.path);
          this.focusAction('area-back');
        }, { cls: 'tangrow-note-row', icon: 'layers', title: area.path });
        row.dataset.tangrowAction = `area-open-${area.path}`;
        row.createSpan({ cls: 'tangrow-note-folder', text: detail });
        row.setAttribute('aria-label', `${area.name} · ${detail}`);
      }
    }
    this.ui.comingSoon(parent, 'AI suggests which area inbox items belong to');
  }

  private renderAreaDetail(parent: HTMLElement, area: WorkbenchArea, today: Date): HTMLInputElement | undefined {
    this.detailHeading(parent, area.name, 'Back to areas', 'area-back', () => {
      this.showArea(null);
      this.focusAction(`area-open-${area.path}`);
    });
    const actions = parent.createDiv({ cls: 'tangrow-project-toolbar' });
    const notePath = area.notePath;
    if (notePath) this.ui.button(actions, 'Open the area note', () => this.host.openNote(notePath), { icon: 'file-text', level: 'primary' });
    this.ui.button(actions, 'New note in this area', () => this.host.openNewAreaNote(area.path), { icon: 'plus', level: notePath ? 'text' : 'primary' });
    this.ui.button(actions, 'Reveal in file list', () => this.host.revealWorkbenchPath(area.path), { icon: 'folder-search', level: 'text' });

    const input = this.renderTasks(parent, area, today, 'area');
    const notes = parent.createEl('section');
    this.ui.sectionHeading(notes, 'Recent updates');
    if (!area.recent.length) this.ui.paragraph(notes, 'No notes in this area yet.');
    for (const note of area.recent) this.noteRow(notes, note, this.updatedLabel(note.modified), 'file-text', 'area-note');

    const projects = parent.createEl('section');
    this.ui.sectionHeading(projects, 'Active projects');
    if (!area.projects.length) this.ui.paragraph(projects, 'No active projects are linked to this area.');
    for (const project of area.projects) {
      const row = this.ui.userButton(projects, project.name, () => {
        if (this.openProject) this.openProject(project.path, area.path);
        else this.showProject(project.path, area.path);
        this.focusAction('project-back');
      }, { cls: 'tangrow-note-row', icon: 'folder-kanban', title: project.path });
      row.dataset.tangrowAction = `area-project-${project.path}`;
    }
    return input;
  }

  private updatedLabel(timestamp: number): string {
    const date = new Date(timestamp).toLocaleDateString(this.host.settings.language, { month: 'short', day: 'numeric' });
    return this.ui.t('Updated {date}', { date });
  }

  private renderTasks(parent: HTMLElement, entity: TaskEntity, today: Date, kind: EntityKind): HTMLInputElement | undefined {
    const isArea = kind === 'area';
    const section = parent.createEl('section');
    const heading = section.createDiv({ cls: 'tangrow-list-heading tangrow-project-task-heading' });
    this.ui.sectionHeading(heading, isArea ? 'To do' : 'Tasks');
    const open = entity.tasks.filter((task) => !task.done);
    if (entity.tasks.length) {
      const done = entity.tasks.length - open.length;
      const progress = heading.createDiv({ cls: 'tangrow-project-progress' });
      const label = this.ui.t('{done}/{total} done', { done: this.ui.number(done), total: this.ui.number(entity.tasks.length) });
      const meter = progress.createEl('progress', { attr: { 'aria-label': label, max: String(entity.tasks.length) } });
      meter.value = done;
      progress.createSpan({ text: label, attr: { 'aria-hidden': 'true' } });
    }
    const notePath = entity.notePath;
    const input = notePath ? this.renderTaskInput(section, `${kind}:${entity.path}`, kind,
      (text) => isArea ? this.host.addAreaTask(entity.path, text) : this.host.addProjectTask(notePath, text)) : undefined;
    if (!input) this.ui.paragraph(section, isArea ? 'Create an area note to add linked tasks.' : 'Create a project note to add tasks from the task overview.');
    if (!open.length) {
      this.ui.paragraph(section, isArea ? 'Open tasks in the area folder and task overview lines that link to the area appear here.'
        : 'Open tasks from the project folder, linked notes, and the task overview appear here.');
      return input;
    }
    const list = section.createDiv({ cls: 'tangrow-task-list', attr: { id: this.taskListId } });
    const visible = sortTaskDisplay(open, today).slice(0, this.expandedTasks ? open.length : TASK_PREVIEW_LIMIT);
    for (const { task, display } of visible) this.renderTask(list, task, display, today, kind);
    if (open.length > TASK_PREVIEW_LIMIT) {
      const more = this.ui.userButton(section, this.ui.t(this.expandedTasks ? 'Show less' : 'Show {count} more', {
        count: this.ui.number(open.length - TASK_PREVIEW_LIMIT)
      }), () => {
        this.expandedTasks = !this.expandedTasks;
        this.onChange();
      }, { level: 'text' });
      more.dataset.tangrowAction = `${kind}-task-more`;
      more.setAttribute('aria-expanded', String(this.expandedTasks));
      more.setAttribute('aria-controls', this.taskListId);
    }
    return input;
  }

  private renderTaskInput(parent: HTMLElement, key: string, kind: EntityKind, save: (text: string) => Promise<void>): HTMLInputElement {
    const form = parent.createEl('form', { cls: 'tangrow-task-add' });
    icon(form, 'plus').setAttribute('aria-hidden', 'true');
    const input = form.createEl('input', { type: 'text', attr: {
      placeholder: this.ui.t('Add a task; Enter adds it to the task overview'), 'aria-label': this.ui.t('New task'), maxlength: '240'
    } });
    input.value = this.taskDrafts.get(key) ?? '';
    input.readOnly = this.addingTasks.has(key);
    input.dataset.tangrowAction = `${kind}-task-add`;
    input.addEventListener('compositionstart', () => { this.composingInput = input; });
    input.addEventListener('compositionend', () => {
      if (this.composingInput !== input) return;
      this.composingInput = undefined;
      this.taskDrafts.set(key, input.value);
      if (this.deferredRender) queueMicrotask(() => this.onChange());
    });
    input.addEventListener('input', (event) => {
      if (this.composingInput !== input && !(event as InputEvent).isComposing) this.taskDrafts.set(key, input.value);
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (this.taskInput !== input || this.composingInput === input || !text || this.addingTasks.has(key)) return;
      this.taskDrafts.set(key, input.value);
      this.addingTasks.add(key);
      input.readOnly = true;
      void save(text).then(() => { this.taskDrafts.delete(key); })
        .catch((error: unknown) => new Notice(describeError(this.host.settings.language, error)))
        .finally(() => {
          this.addingTasks.delete(key);
          this.onChange();
        });
    });
    return input;
  }

  private renderTask(parent: HTMLElement, task: WorkbenchProjectTask, display: TaskDisplay, today: Date, kind: EntityKind): void {
    const label = display.title || this.ui.t('Untitled task');
    const key = `${task.path}:${task.line}`;
    const row = parent.createDiv({ cls: 'tangrow-task-item' });
    const check = row.createEl('button', { cls: 'tangrow-task-check', attr: {
      type: 'button', 'aria-label': this.ui.t('Complete: {task}', { task: label })
    } });
    const busy = this.completingTasks.has(key);
    check.disabled = busy || !!task.labelPending;
    if (busy) row.addClass('is-completing');
    check.dataset.tangrowAction = `${kind}-task-check-${key}`;
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
    open.dataset.tangrowAction = `${kind}-task-note-${key}`;
    setTooltip(open, task.text || task.path);
    const contained = kind === 'area' ? 'Area folder · {note}' : 'Project folder · {note}';
    const source = task.sourceKind === 'overview' ? this.ui.t('Task overview')
      : this.ui.t(task.sourceKind === 'folder' ? contained : 'Linked note · {note}', { note: task.sourceName });
    renderTaskMetadata(this.ui, open, display, today, this.host.settings.language, { source });
  }
}
