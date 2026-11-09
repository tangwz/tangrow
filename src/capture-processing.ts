import { getFrontMatterInfo, parseYaml, stringifyYaml, TFile, TFolder, type App } from 'obsidian';
import { inFolder, safeFolder, safeTitle } from './model';
import { hasValidSupportFolder } from './folders';
import type { CaptureRequest, Settings } from './types';

interface CaptureJob { id: string; action: 'note' | 'task'; target: string; title: string; project?: string }
const JOB_FIELD = 'tangrow_capture_processing';
const RESULT_FIELD = 'tangrow_capture_result';

function fieldsFrom(content: string): Record<string, unknown> {
  const info = getFrontMatterInfo(content);
  const fields: unknown = info.exists ? parseYaml(info.frontmatter) : null;
  return fields && typeof fields === 'object' && !Array.isArray(fields) ? fields as Record<string, unknown> : {};
}
function assertCapture(fields: Record<string, unknown>): void {
  if (fields.tangrow_kind !== 'capture') throw new Error('This capture no longer exists.');
}
export function captureIsProcessed(fields: Record<string, unknown>): boolean {
  return typeof fields.tangrow_processed_at === 'string' && Number.isFinite(Date.parse(fields.tangrow_processed_at));
}
function readJob(value: unknown): CaptureJob | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('The saved capture action is invalid.');
  const job = value as Partial<CaptureJob>;
  if (typeof job.id !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(job.id)
    || (job.action !== 'note' && job.action !== 'task') || typeof job.target !== 'string'
    || !job.target.endsWith('.md') || safeFolder(job.target) !== job.target || typeof job.title !== 'string'
    || (job.project !== undefined && typeof job.project !== 'string')) throw new Error('The saved capture action is invalid.');
  if (job.action === 'note') safeTitle(job.title);
  else taskTitle(job.title);
  return job as CaptureJob;
}
function taskTitle(value: string): string {
  const title = value.trim();
  if (!title || title.length > 240 || /[\r\n]/.test(title)) throw new Error('Use a task title of 1-240 characters on one line.');
  return title;
}
function markdownFile(app: App, path: string): TFile {
  safeFolder(path);
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile) || file.extension !== 'md') throw new Error('Choose an existing Markdown note.');
  return file;
}
export function captureProjectFiles(app: App, settings: Settings): TFile[] {
  return app.vault.getMarkdownFiles().filter((file) => inFolder(file.path, settings.projectFolder)
    && (!hasValidSupportFolder(settings) || !inFolder(file.path, settings.supportFolder)))
    .sort((a, b) => a.path.localeCompare(b.path));
}
function projectFile(app: App, settings: Settings, path: string, source: TFile): TFile {
  const file = markdownFile(app, path);
  if (file === source || !captureProjectFiles(app, settings).includes(file)) throw new Error('Choose an existing project note.');
  return file;
}
async function ensureFolder(app: App, folder: string): Promise<void> {
  let path = '';
  for (const segment of safeFolder(folder).split('/')) {
    path = path ? `${path}/${segment}` : segment;
    const found = app.vault.getAbstractFileByPath(path);
    if (found && !(found instanceof TFolder)) throw new Error('The destination folder is occupied by a file.');
    if (!found) await app.vault.createFolder(path);
  }
}
function uniquePath(app: App, folder: string, title: string): string {
  let path = `${safeFolder(folder)}/${title}.md`;
  let suffix = 2;
  while (app.vault.getAbstractFileByPath(path)) path = `${folder}/${title} (${suffix++}).md`;
  return path;
}
async function savedResult(app: App, job: CaptureJob, searchMoved: boolean): Promise<TFile | null> {
  const expected = app.vault.getAbstractFileByPath(job.target);
  const candidates = expected instanceof TFile && expected.extension === 'md' ? [expected] : [];
  if (searchMoved) candidates.push(...app.vault.getMarkdownFiles().filter((file) => file !== expected));
  for (const file of candidates) {
    const content = await app.vault.read(file);
    if (job.action === 'task') {
      if (content.includes(`<!-- tangrow-capture:${job.id} -->`)) return file;
    } else {
      if (!content.includes(job.id)) continue;
      const fields = fieldsFrom(content);
      if (fields.tangrow_capture_action_id === job.id && fields.tangrow_kind === 'note') return file;
    }
  }
  return null;
}
async function createResult(app: App, source: TFile, job: CaptureJob, resume: boolean): Promise<TFile> {
  const saved = await savedResult(app, job, resume);
  if (saved) return saved;
  const sourceLink = app.fileManager.generateMarkdownLink(source, job.target);
  if (job.action === 'task') {
    const target = markdownFile(app, job.target);
    if (target === source) throw new Error('The task overview must be different from the capture.');
    const marker = `<!-- tangrow-capture:${job.id} -->`;
    await app.vault.process(target, (content) => content.includes(marker) ? content
      : `${content}${content.endsWith('\n') ? '' : '\n'}\n- [ ] ${job.title} ${sourceLink} ${marker}\n`);
    return target;
  }
  const content = await app.vault.read(source);
  const info = getFrontMatterInfo(content);
  const body = info.exists ? content.slice(info.contentStart) : content;
  const fields = {
    tangrow_kind: 'note', created: new Date().toISOString(), tangrow_source: sourceLink,
    tangrow_capture_action_id: job.id, ...(job.project ? { tangrow_project: job.project } : {})
  };
  await ensureFolder(app, job.target.slice(0, job.target.lastIndexOf('/')));
  try { return await app.vault.create(job.target, `---\n${stringifyYaml(fields)}---\n\n# ${job.title}\n\n${body.trim()}\n`); }
  catch (error) {
    const written = await savedResult(app, job, false);
    if (written) return written;
    throw error;
  }
}

export async function processCapturedNote(app: App, settings: Settings, path: string, request: CaptureRequest): Promise<string | null> {
  const source = markdownFile(app, path);
  const fields = fieldsFrom(await app.vault.read(source));
  assertCapture(fields);
  if (captureIsProcessed(fields) && request.action !== 'pending') return null;
  let job = readJob(fields[JOB_FIELD]);
  const resume = job !== null;
  if (job && request.action !== 'resume') {
    const project = request.action === 'note' && request.projectPath
      ? app.fileManager.generateMarkdownLink(projectFile(app, settings, request.projectPath, source), job.target) : undefined;
    if ((request.action !== 'note' && request.action !== 'task') || request.action !== job.action
      || (request.action === 'note' ? safeTitle(request.title) : taskTitle(request.title)) !== job.title
      || project !== job.project) throw new Error('Continue the unfinished capture action first.');
  }
  if (!job && request.action === 'resume') throw new Error('There is no unfinished capture action.');

  if (!job) {
    let project: TFile | undefined;
    if (request.action === 'project' || (request.action === 'note' && request.projectPath)) {
      project = projectFile(app, settings, request.projectPath!, source);
    }
    if (request.action === 'done' || request.action === 'project' || request.action === 'pending') {
      await app.fileManager.processFrontMatter(source, (latest) => {
        assertCapture(latest);
        if (readJob(latest[JOB_FIELD])) throw new Error('Continue the unfinished capture action first.');
        if (request.action === 'pending') { delete latest.tangrow_processed_at; return; }
        if (captureIsProcessed(latest)) return;
        if (project) {
          latest.tangrow_project = app.fileManager.generateMarkdownLink(project, source.path);
          latest[RESULT_FIELD] = latest.tangrow_project;
        }
        latest.tangrow_processed_at = new Date().toISOString();
      });
      return project?.path ?? null;
    }
    if (request.action === 'resume') return null;
    const title = request.action === 'note' ? safeTitle(request.title) : taskTitle(request.title);
    const target = request.action === 'task' ? markdownFile(app, settings.taskOverviewPath).path
      : uniquePath(app, project?.parent?.path ?? settings.inboxFolder, title);
    if (target === source.path) throw new Error('The task overview must be different from the capture.');
    job = { id: crypto.randomUUID(), action: request.action, target, title,
      ...(project ? { project: app.fileManager.generateMarkdownLink(project, target) } : {}) };
    const prepared = job;
    let accepted = false;
    // Store the operation in the source note before touching its destination.
    await app.fileManager.processFrontMatter(source, (latest) => {
      assertCapture(latest);
      if (readJob(latest[JOB_FIELD])) throw new Error('Continue the unfinished capture action first.');
      if (captureIsProcessed(latest)) return;
      latest[JOB_FIELD] = prepared;
      accepted = true;
    });
    if (!accepted) return null;
  }
  const result = await createResult(app, source, job, resume);
  const completed = job;
  await app.fileManager.processFrontMatter(source, (latest) => {
    assertCapture(latest);
    if (captureIsProcessed(latest) && !latest[JOB_FIELD]) return;
    if (readJob(latest[JOB_FIELD])?.id !== completed.id) throw new Error('The capture action changed. Review the source note before retrying.');
    latest[RESULT_FIELD] = app.fileManager.generateMarkdownLink(result, source.path);
    latest.tangrow_processed_at = new Date().toISOString();
    delete latest[JOB_FIELD];
  });
  return result.path;
}
