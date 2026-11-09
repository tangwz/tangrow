import { getFrontMatterInfo, parseYaml, TFile, type App } from 'obsidian';
import { safeFolder } from './model';

export interface DraftSubmission { id: string; path: string | null }
export interface DraftSubmissions { capture: DraftSubmission | null; writing: DraftSubmission | null }
export type SubmissionKind = 'capture' | 'draft';

export function readDraftSubmissions(value: unknown): DraftSubmissions {
  if (value === undefined) return { capture: null, writing: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Saved submission state is invalid.');
  const read = (entry: unknown): DraftSubmission | null => {
    if (entry === null || entry === undefined) return null;
    if (typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Saved submission state is invalid.');
    const { id, path } = entry as Partial<DraftSubmission>;
    if (typeof id !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)
      || (path !== null && (typeof path !== 'string' || !path.endsWith('.md') || safeFolder(path) !== path))) throw new Error('Saved submission state is invalid.');
    return { id, path };
  };
  const data = value as Partial<DraftSubmissions>;
  return { capture: read(data.capture), writing: read(data.writing) };
}

async function matchesSubmission(app: App, file: TFile, submission: DraftSubmission, kind: SubmissionKind): Promise<boolean> {
  // Read the actual file: the host metadata index can lag a create or rename.
  const info = getFrontMatterInfo(await app.vault.read(file));
  if (!info.exists || !info.frontmatter.includes(submission.id)) return false;
  const fields = parseYaml(info.frontmatter) as Record<string, unknown> | null;
  return fields?.tangrow_submission_id === submission.id && fields.tangrow_kind === kind;
}

export async function findSubmittedNote(app: App, submission: DraftSubmission, kind: SubmissionKind, searchMoved = true): Promise<TFile | null> {
  if (submission.path === null) return null;
  const target = app.vault.getAbstractFileByPath(submission.path);
  if (target instanceof TFile && target.extension === 'md' && await matchesSubmission(app, target, submission, kind)) return target;
  if (!searchMoved) return null;
  // Recovery also handles notes moved after saving, without relying on a ready index.
  for (const file of app.vault.getMarkdownFiles()) {
    if (file !== target && await matchesSubmission(app, file, submission, kind)) return file;
  }
  return null;
}
