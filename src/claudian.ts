import type { App } from 'obsidian';
import type { Settings } from './types';

/**
 * A bridge to the Claudian plugin's experimental Plugin API (version 1).
 * Tangrow only calls the runtime interface that Claudian documents for other plugins;
 * no Claudian code is bundled or copied here.
 */
export const CLAUDIAN_ID = 'realclaudian';
export const CLAUDIAN_OPEN_COMMAND = `${CLAUDIAN_ID}:open-view`;
export const CLAUDIAN_TURN_ENDED = 'claudian:turn-ended';

export type SendStatus = 'started' | 'queued' | 'steered' | 'uncertain' | 'interrupted' | 'idle';
export interface ClaudianAPI {
  readonly version: 1;
  getActiveSessionId(): string | null;
  send(sessionId: string, options: { text?: string; mode?: 'queue' | 'steer' | 'interrupt' }): Promise<SendStatus>;
  read(sessionId: string): Promise<string>;
}

/** missing: not installed or disabled; incompatible: another API version; idle: no chat is focused. */
export type AgentStatus = 'missing' | 'incompatible' | 'idle' | 'ready';
export type WorkflowId = 'inbox' | 'weekly' | 'tasks' | 'project-brief' | 'project-plan' | 'connect';
export interface Workflow { id: WorkflowId; label: string; description: string; icon: string; needsNote: boolean; writes: boolean }
export interface WorkflowRun { workflow: WorkflowId; sessionId: string; state: 'running' | 'done'; reply: string }
export interface WorkflowContext { today: string; weeklyNote: string; activeNote?: string }

export const WORKFLOWS: readonly Workflow[] = [
  { id: 'inbox', label: 'Sort the inbox', description: 'Turns pending captures into notes, tasks or project material.', icon: 'inbox', needsNote: false, writes: true },
  { id: 'weekly', label: 'Write the weekly review', description: 'Reads this week\'s notes and tasks, then drafts the review in your weekly note.', icon: 'calendar-check', needsNote: false, writes: true },
  { id: 'tasks', label: 'Review open tasks', description: 'Finds stale and duplicate tasks and proposes what to do today.', icon: 'list-checks', needsNote: false, writes: false },
  { id: 'project-brief', label: 'Brief me on this project', description: 'Where the open project stands, what is stuck, and the next steps.', icon: 'folder-kanban', needsNote: true, writes: false },
  { id: 'project-plan', label: 'Break this project down', description: 'Proposes concrete tasks for the open project note and adds the ones you accept.', icon: 'list-tree', needsNote: true, writes: true },
  { id: 'connect', label: 'Connect this note', description: 'Finds related notes and adds the links you accept.', icon: 'waypoints', needsNote: true, writes: true }
];

/** Resolved on every use: disabling or updating Claudian replaces its plugin instance. */
export function claudianApi(app: App): ClaudianAPI | AgentStatus {
  const plugins = (app as unknown as { plugins?: { getPlugin?(id: string): { api?: { version?: unknown } } | null } }).plugins;
  let plugin: { api?: { version?: unknown } } | null | undefined;
  try { plugin = plugins?.getPlugin?.(CLAUDIAN_ID); }
  catch { return 'missing'; }
  if (!plugin) return 'missing';
  const api = plugin.api;
  if (!api || api.version !== 1) return 'incompatible';
  const candidate = api as Partial<ClaudianAPI>;
  if (typeof candidate.getActiveSessionId !== 'function' || typeof candidate.send !== 'function' || typeof candidate.read !== 'function') return 'incompatible';
  return api as ClaudianAPI;
}

const ZH = (settings: Settings): boolean => settings.language === 'zh-CN';

function guidePath(settings: Settings): string { return `${settings.supportFolder}/AGENTS.md`; }

function rules(settings: Settings, writes: boolean): string[] {
  if (ZH(settings)) return [
    `开始前先读 \`${guidePath(settings)}\`，按其中的目录和属性约定工作。`,
    '不移动、不重命名、不删除任何已有笔记或目录。',
    `不要改动 \`${settings.supportFolder}\` 里的 \`.base\` 文件和 \`Records\`。`,
    writes
      ? '先把打算做的修改列成清单给我看，等我回复确认后再写入；我只同意其中几项时，只做那几项。'
      : '这项工作只读：把结果直接回复给我，不要修改任何文件。',
    '只依据笔记里实际写的内容，不要编造事实、日期或承诺。用简体中文回复。'
  ];
  return [
    `Read \`${guidePath(settings)}\` first and follow its folder and property conventions.`,
    'Do not move, rename or delete any existing note or folder.',
    `Leave the \`.base\` files and \`Records\` in \`${settings.supportFolder}\` alone.`,
    writes
      ? 'Show me the list of changes you intend to make and wait for my reply before writing anything. If I accept only some of them, make only those.'
      : 'This job is read-only: reply with the result and do not change any file.',
    'Rely only on what the notes actually say; do not invent facts, dates or commitments. Reply in English.'
  ];
}

function steps(id: WorkflowId, settings: Settings, context: WorkflowContext | null): string[] {
  const s = settings;
  const zh = ZH(s);
  const note = context?.activeNote ? `\`${context.activeNote}\`` : (zh ? '我指定的笔记（没有指定时用当前打开的笔记）' : 'the note I name (or the note that is currently open when I name none)');
  const weekly = context ? `\`${context.weeklyNote}\`` : (zh ? `\`${s.journalFolder}\` 里本周的周记` : `this week's note in \`${s.journalFolder}\``);
  switch (id) {
    case 'inbox': return zh ? [
      `找出 \`${s.inboxFolder}\` 里所有待处理的速记：\`tangrow_kind\` 为 \`capture\`，且没有 \`tangrow_processed_at\`。`,
      '逐条读完，判断它应该成为什么：一条任务、一篇值得保留的笔记、某个已有项目的材料，或者暂时还无法归类。',
      '用一张表列出每条速记的建议去向、建议标题和一句理由，等我确认。',
      `确认后执行：任务追加到 \`${s.taskOverviewPath}\` 末尾（\`- [ ] \` 开头）；笔记新建在 \`${s.inboxFolder}\`，属于某个项目的新建在该项目的子目录里，并写上 \`tangrow_kind: note\`、\`created\` 和指向原速记的 \`tangrow_source\`。`,
      '原速记保留原文，只补上 `tangrow_capture_result`（指向结果的链接）和 `tangrow_processed_at`（当前时间，ISO 格式）。无法归类的速记不要动。',
      '最后告诉我处理了几条、跳过了几条，以及跳过的原因。'
    ] : [
      `Find every pending capture in \`${s.inboxFolder}\`: \`tangrow_kind\` is \`capture\` and there is no \`tangrow_processed_at\`.`,
      'Read each one and decide what it should become: a task, a note worth keeping, material for an existing project, or nothing yet because it is too vague.',
      'Show me a table with the suggested destination, suggested title and a one-sentence reason for each capture, then wait.',
      `Once I confirm: append tasks to the end of \`${s.taskOverviewPath}\` as \`- [ ] \` lines; create notes in \`${s.inboxFolder}\`, or in the project's own subfolder when they belong to one, with \`tangrow_kind: note\`, \`created\` and a \`tangrow_source\` link back to the capture.`,
      'Keep each capture\'s original text. Add only `tangrow_capture_result` (a link to the result) and `tangrow_processed_at` (the current time, ISO format). Leave captures you could not sort untouched.',
      'Finish by telling me how many you processed, how many you skipped, and why.'
    ];
    case 'weekly': return zh ? [
      `回顾本周（周一到今天）：读 \`${s.journalFolder}\` 里本周的日记、本周新建或修改过的笔记、\`${s.inboxFolder}\` 里本周的速记，以及 \`${s.supportFolder}/Records\` 里本周的专注和打卡记录（只读）。`,
      '找出本周完成的任务（`- [x]`）和仍未完成的任务（`- [ ]`、`- [/]`）。',
      '写一份周回顾，包含四节：推进了什么、还悬着什么、值得记住的想法、下周先做哪三件事。提到笔记时用 `[[双链]]`，具体、简短，没有内容的小节直接省略。',
      `把草稿给我看。确认后写进 ${weekly} 的「周回顾」小标题下；周记不存在就新建，已有内容一律保留，只在末尾追加。`
    ] : [
      `Look back over this week (Monday to today): read this week's daily notes in \`${s.journalFolder}\`, notes created or edited this week, this week's captures in \`${s.inboxFolder}\`, and this week's focus and check-in records in \`${s.supportFolder}/Records\` (read only).`,
      'Collect the tasks finished this week (`- [x]`) and the ones still open (`- [ ]`, `- [/]`).',
      'Write a weekly review with four sections: what moved forward, what is still open, ideas worth keeping, and the three things to start with next week. Refer to notes as `[[wikilinks]]`, stay specific and brief, and leave out a section that has nothing in it.',
      `Show me the draft. Once I confirm, write it under a "Weekly review" heading in ${weekly}; create the note if it does not exist, keep everything already there, and append at the end.`
    ];
    case 'tasks': return zh ? [
      `收集所有未完成的任务：\`${s.taskOverviewPath}\` 以及 \`${s.projectFolder}\`、\`${s.areaFolder}\`、\`${s.inboxFolder}\`、\`${s.journalFolder}\` 里笔记正文中的 \`- [ ]\` 和 \`- [/]\`。`,
      '标出三类问题：已过截止日期的、重复或高度相似的、所在笔记很久没动过的。',
      '结合今天的日期，建议今天最该做的三件事，并各用一句话说明理由。',
      '按「今天做 / 需要决定 / 可以放下」分组回复，每条任务后面注明所在笔记的 `[[双链]]`。'
    ] : [
      `Collect every open task: \`- [ ]\` and \`- [/]\` lines in \`${s.taskOverviewPath}\` and in note bodies under \`${s.projectFolder}\`, \`${s.areaFolder}\`, \`${s.inboxFolder}\` and \`${s.journalFolder}\`.`,
      'Flag three kinds of problem: tasks past their due date, duplicates or near-duplicates, and tasks in notes that have not been touched for a long time.',
      'With today\'s date in mind, suggest the three things most worth doing today, each with a one-sentence reason.',
      'Reply in three groups — do today, needs a decision, can be dropped — and follow each task with a `[[wikilink]]` to its note.'
    ];
    case 'project-brief': return zh ? [
      `确定 ${note} 属于 \`${s.projectFolder}\` 下的哪个项目子目录；不在任何项目里就直接告诉我，然后停止。`,
      '读完这个项目目录里的全部笔记，以及库里链接到它们的笔记。',
      '回复一份简报：项目目标一句话、目前进展、未完成的任务、卡住或很久没动的部分、建议的下三步。',
      '每个判断后面注明依据的笔记（`[[双链]]`）。'
    ] : [
      `Work out which project subfolder under \`${s.projectFolder}\` ${note} belongs to. If it is not in a project, say so and stop.`,
      'Read every note in that project folder and the notes elsewhere in the vault that link to them.',
      'Reply with a briefing: the goal in one sentence, where things stand, open tasks, what is stuck or has gone quiet, and the next three steps you would take.',
      'After each judgement, name the note it rests on as a `[[wikilink]]`.'
    ];
    case 'project-plan': return zh ? [
      `读 ${note} 和它所在项目目录里的其他笔记，弄清项目目标和已经有的任务。`,
      '把还缺的工作拆成具体任务：每条以动词开头，单独看也能明白，一次能做完。不要重复已有任务。',
      '按先后顺序列给我看，标出你认为的第一步，等我确认或修改。',
      `确认后把任务以 \`- [ ] \` 形式追加到 ${note} 的「任务」小标题下；没有这个小标题就在文末新建，其余内容保持不变。`
    ] : [
      `Read ${note} and the other notes in its project folder to understand the goal and the tasks that already exist.`,
      'Break the missing work into concrete tasks: each starts with a verb, makes sense on its own, and can be finished in one sitting. Do not repeat existing tasks.',
      'Show them to me in order, mark the one you would start with, and wait for me to confirm or change them.',
      `Once I confirm, append them as \`- [ ] \` lines under a "Tasks" heading in ${note}; add the heading at the end if it is missing and leave everything else as it is.`
    ];
    case 'connect': return zh ? [
      `读 ${note}，提炼它的主题、关键概念和提到的人、项目。`,
      `在库里搜索相关笔记（跳过 \`${s.supportFolder}\` 和 \`${s.archiveFolder}\`），优先找还没有互相链接的。`,
      '列出最多八篇，每篇用一句话说明它和这篇笔记的关系，等我挑选。',
      `把我选中的链接以列表形式追加到 ${note} 的「相关笔记」小标题下；没有这个小标题就在文末新建。不要改动正文其他部分，也不要修改被链接的笔记。`
    ] : [
      `Read ${note} and pick out its subject, key ideas, and the people and projects it mentions.`,
      `Search the vault for related notes (skip \`${s.supportFolder}\` and \`${s.archiveFolder}\`), preferring ones that are not linked to it yet.`,
      'List up to eight, each with one sentence on how it relates to this note, and wait for me to choose.',
      `Append the links I choose as a list under a "Related notes" heading in ${note}; add the heading at the end if it is missing. Do not change the rest of the body or the linked notes.`
    ];
  }
}

function numbered(lines: string[]): string { return lines.map((line, index) => `${index + 1}. ${line}`).join('\n'); }
function bullets(lines: string[]): string { return lines.map((line) => `- ${line}`).join('\n'); }

function workflow(id: WorkflowId): Workflow {
  const found = WORKFLOWS.find((item) => item.id === id);
  if (!found) throw new Error('Unknown workflow.');
  return found;
}

/** The prompt sent to the focused Claudian session. It names files by path; the agent reads them itself. */
export function workflowPrompt(id: WorkflowId, settings: Settings, context: WorkflowContext): string {
  const item = workflow(id);
  if (item.needsNote && !context.activeNote) throw new Error('Open a Markdown note first.');
  const zh = ZH(settings);
  return [
    zh ? `这是来自 Tangrow 的一项笔记库工作。今天是 ${context.today}。` : `This is a vault job from Tangrow. Today is ${context.today}.`,
    zh ? '## 约定' : '## Ground rules',
    bullets(rules(settings, item.writes)),
    zh ? '## 步骤' : '## Steps',
    numbered(steps(id, settings, context))
  ].join('\n\n');
}

const SKILL_TITLES: Record<WorkflowId, { zh: string; en: string; zhWhen: string; enWhen: string }> = {
  inbox: { zh: '整理收件箱', en: 'Sort the inbox', zhWhen: '用户想整理、分拣或清空速记收件箱时使用。', enWhen: 'Use when the user wants to sort, triage or clear pending captures in the inbox.' },
  weekly: { zh: '写周回顾', en: 'Write the weekly review', zhWhen: '用户想回顾本周或写周记、周总结时使用。', enWhen: 'Use when the user wants to look back over the week or write a weekly review.' },
  tasks: { zh: '检查未完成任务', en: 'Review open tasks', zhWhen: '用户想梳理待办、找出过期或重复任务、决定今天做什么时使用。', enWhen: 'Use when the user wants to review open tasks, find overdue or duplicate ones, or decide what to do today.' },
  'project-brief': { zh: '项目简报', en: 'Project briefing', zhWhen: '用户想了解某个项目的现状、卡点和下一步时使用。', enWhen: 'Use when the user wants to know where a project stands, what is stuck and what comes next.' },
  'project-plan': { zh: '拆解项目', en: 'Break a project down', zhWhen: '用户想把项目拆成具体任务或规划下一步时使用。', enWhen: 'Use when the user wants to break a project into concrete tasks or plan its next steps.' },
  connect: { zh: '关联笔记', en: 'Connect a note', zhWhen: '用户想为一篇笔记找相关笔记或补充链接时使用。', enWhen: 'Use when the user wants to find notes related to one note or add links to it.' }
};

export function skillFolder(id: WorkflowId): string { return `.claude/skills/tangrow-${id}`; }

/** Vault-level skills so the same jobs can be called by name from Claudian or Claude Code. */
export function skillFiles(settings: Settings): { path: string; content: string }[] {
  const zh = ZH(settings);
  return WORKFLOWS.map((item) => {
    const title = SKILL_TITLES[item.id];
    const description = zh ? `${title.zh}（Tangrow 笔记库）。${title.zhWhen}` : `${title.en} in a Tangrow vault. ${title.enWhen}`;
    return {
      path: `${skillFolder(item.id)}/SKILL.md`,
      content: [
        '---',
        `name: tangrow-${item.id}`,
        `description: ${JSON.stringify(description)}`,
        '---',
        '',
        `# ${zh ? title.zh : title.en}`,
        '',
        zh ? '由 Tangrow 生成。目录以生成时的 Tangrow 设置为准；设置变化后可删除本文件，再从 Tangrow 的助手面板重新安装。' : 'Generated by Tangrow. Folders reflect the Tangrow settings at the time; if they change, delete this file and install the skills again from Tangrow\'s assistant panel.',
        '',
        zh ? '## 约定' : '## Ground rules',
        '',
        bullets(rules(settings, item.writes)),
        '',
        zh ? '## 步骤' : '## Steps',
        '',
        numbered(steps(item.id, settings, null)),
        ''
      ].join('\n')
    };
  });
}
