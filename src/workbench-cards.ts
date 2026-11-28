import { Notice } from 'obsidian';
import type { CardFilter, CardReportRow } from './card-report-data';
import { createCardReviewQueue, resolveCardReviewQueue, type CardReviewQueue, type CardReviewReason } from './card-review';
import { sortCaptures } from './capture-data';
import { capturePreview } from './capture-preview';
import type { ReportRecord } from './report-contract';
import type { CaptureSummary, SidebarHost } from './types';
import type { SidebarUI } from './ui';
import type { KnowledgeTab } from './workbench-navigation';

type CardData = Awaited<ReturnType<SidebarHost['loadWorkbenchCards']>>;
const PAGE_SIZE = 20;
const REVIEW_REASON: Record<CardReviewReason, string> = {
  isolated: 'Awaiting connections', overdue: 'Due for another look', sample: 'Daily selection'
};
const STAGE_LABELS: Record<CardReportRow['stage'], string> = {
  seed: 'Seed', growing: 'Growing', evergreen: 'Evergreen', unset: 'Stage not set', unknown: 'Unknown stage'
};

export class WorkbenchCards {
  private data?: CardData;
  private queue?: CardReviewQueue;
  private preview?: CardReviewQueue;
  private failed = false;
  private queueFailed = false;
  private loading = false;
  private refreshAgain = false;
  private reviewOpen = false;
  private pages: Partial<Record<KnowledgeTab, number>> = {};

  constructor(
    private readonly host: SidebarHost,
    private readonly ui: SidebarUI,
    private readonly onChange: () => void,
    private readonly showKnowledge: (tab: KnowledgeTab) => void,
    private readonly manuscript: () => string | undefined,
    private readonly chooseManuscript: () => void,
    private readonly showCaptures: () => void
  ) {}

  refresh(openReview: boolean): void {
    this.reviewOpen = openReview;
    if (this.loading) { this.refreshAgain = true; return; }
    this.loading = true;
    void this.load().finally(() => {
      this.loading = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.refresh(this.reviewOpen);
      }
    });
  }

  pause(): void {
    this.reviewOpen = false;
    this.refreshAgain = false;
  }

  private async load(): Promise<void> {
    try {
      const data = await this.host.loadWorkbenchCards();
      if (!this.host.settings.knowledgeEnabled) return;
      if (this.data !== data) {
        this.data = data;
        this.preview = data.knowledge.linksReady ? createCardReviewQueue(data.knowledge) : undefined;
      }
      this.failed = false;
      const recalled = this.host.loadCardReview(data.knowledge.today);
      this.queue = recalled ?? undefined;
      if (recalled) this.queueFailed = false;
      if (!recalled && this.reviewOpen && data.knowledge.linksReady && data.knowledge.rows.length && !this.queueFailed) {
        await this.saveQueue();
      }
    } catch {
      this.failed = true;
    } finally {
      this.onChange();
    }
  }

  get homeSignature(): string {
    const { data } = this;
    return JSON.stringify([this.failed, this.queueFailed, data?.knowledge.today, data?.knowledge.counts.all,
      data?.report.linksReady, data && [data.report.counts.week, data.report.counts.isolated, data.report.counts.candidate],
      data?.knowledge.linksReady, this.recent().map((row) => [row.note.path, row.note.name, row.created, row.stage]),
      this.reviewItems().map(({ entry, row, reviewed }) => [entry, row?.note.path, row?.note.name, reviewed]), this.queue !== undefined]);
  }

  private recent(): CardReportRow[] {
    return this.data?.knowledge.rows.slice(0, 2).filter((row) => row.created) ?? [];
  }

  private reviewItems() {
    if (!this.data) return [];
    const queue = this.queue ?? this.preview;
    return queue ? resolveCardReviewQueue(queue, this.data.knowledge) : [];
  }

  private async saveQueue(rebuild = false): Promise<void> {
    const cards = this.data?.knowledge;
    if (!cards?.linksReady) return;
    try {
      this.queue = await this.host.saveCardReview(this.preview ?? createCardReviewQueue(cards), rebuild);
      this.queueFailed = false;
    } catch {
      this.queueFailed = true;
    }
  }

  private reportButton(parent: HTMLElement, source: string, filter: CardFilter, count: number | null): void {
    const label = `${this.ui.t(source)} · ${count === null ? this.ui.t('Pending confirmation') : this.ui.number(count)}`;
    const button = this.ui.userButton(parent, label, () => this.host.openCardReport(filter), { level: 'text', disabled: count === null });
    button.dataset.tangrowAction = `home-card-report-${filter}`;
  }

  renderToday(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: 'tangrow-workbench-card' });
    const heading = section.createDiv({ cls: 'tangrow-list-heading' });
    this.ui.sectionHeading(heading, 'Card activity');
    if (!this.renderStatus(section)) return;
    const { knowledge, report } = this.data!;
    const total = this.ui.userButton(heading, this.ui.t('View all · {count}', { count: this.ui.number(knowledge.counts.all) }), () => this.showKnowledge('cards'), { level: 'text' });
    total.dataset.tangrowAction = 'home-cards';
    const links = section.createDiv({ cls: 'tangrow-chips tangrow-card-links' });
    this.reportButton(links, 'Created in the last 7 days', 'week', report.counts.week);
    this.reportButton(links, 'Awaiting connections', 'isolated', report.linksReady ? report.counts.isolated : null);
    this.reportButton(links, 'Manuscript candidates only', 'candidate', report.linksReady ? report.counts.candidate : null);
    if (knowledge.counts.all === 0) {
      this.ui.button(section, 'New card', () => this.host.openQuickAdd('card'), { icon: 'plus', cls: 'tangrow-full-width' });
      return;
    }
    this.renderReview(section, false);
    const recent = this.recent();
    this.ui.sectionHeading(section, 'Recently created cards');
    if (!recent.length) this.ui.paragraph(section, 'No cards with a known creation date.');
    for (const row of recent) this.note(section, row.note, this.cardMeta(row), 'notebook-pen');
  }

  renderKnowledge(parent: HTMLElement, tab: KnowledgeTab): void {
    parent.empty();
    if (!this.renderStatus(parent)) return;
    const { knowledge, materials, hubs } = this.data!;
    if (tab === 'review') {
      this.renderReview(parent, true);
      this.ui.comingSoon(parent, 'AI drafts today’s review');
      return;
    }
    if (tab === 'cards' && !knowledge.rows.length) {
      this.renderFirstCard(parent);
      this.ui.comingSoon(parent, 'AI drafts candidate cards');
      return;
    }
    if (tab === 'hubs' && !hubs.length) {
      const missing = 3 - knowledge.rows.length;
      this.ui.empty(parent, 'No hubs yet', 'A hub connects related cards into a line of argument.', 'network', [{
        label: missing <= 0 ? 'New hub' : missing === 3 ? 'Write cards first' : this.ui.t('Write {count} more cards', { count: this.ui.number(missing) }),
        onClick: missing <= 0 ? () => this.host.openNewHub() : () => this.showKnowledge('cards'),
        level: 'primary'
      }]);
      this.ui.comingSoon(parent, 'AI suggests which hub a card belongs to');
      return;
    }
    const heading = parent.createDiv({ cls: 'tangrow-list-heading' });
    const label = { cards: 'Cards', hubs: 'Knowledge hubs', materials: 'Knowledge materials' }[tab];
    const rows = tab === 'cards' ? knowledge.rows.map((row) => ({ note: row.note, detail: this.cardMeta(row) }))
      : tab === 'materials' ? materials.map((row) => ({ note: row.note, detail: this.ui.t({
        literature: 'Literature note', clip: 'Web clipping', resource: 'Resource folder', derived: 'Distillation source'
      }[row.reason]) }))
        : hubs.map((note) => ({ note, detail: note.path }));
    this.ui.sectionHeading(heading, label);
    heading.createSpan({ cls: 'tangrow-muted', text: this.ui.number(rows.length) });
    if (tab === 'cards') {
      const actions = parent.createDiv({ cls: 'tangrow-chips tangrow-card-links' });
      this.ui.button(actions, 'New card', () => this.host.openQuickAdd('card'), { icon: 'plus' });
      this.ui.button(actions, 'Open card report', () => this.host.openCardReport('all'), { icon: 'chart-no-axes-combined', level: 'text' });
    }
    if (tab === 'hubs') this.ui.button(parent, 'New hub', () => this.host.openNewHub(), { icon: 'plus', level: 'text' });
    if (!rows.length) this.ui.paragraph(parent, 'No notes in this view.');
    else {
      const lastPage = Math.ceil(rows.length / PAGE_SIZE);
      const page = Math.min(this.pages[tab] ?? 1, lastPage);
      for (const { note, detail } of rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)) this.note(parent, note, detail);
      if (lastPage > 1) {
        const pager = parent.createDiv({ cls: 'tangrow-workbench-pager' });
        for (const [direction, step, icon] of [['Previous page', -1, 'chevron-left'], ['Next page', 1, 'chevron-right']] as const) {
          const control = this.ui.button(pager, direction, () => {
            this.pages[tab] = page + step;
            this.onChange();
          }, { icon, cls: 'tangrow-chip', disabled: page + step < 1 || page + step > lastPage });
          control.dataset.tangrowAction = direction;
        }
        pager.createSpan({ cls: 'tangrow-muted', text: this.ui.t('Page {page} of {total}', { page: this.ui.number(page), total: this.ui.number(lastPage) }) });
      }
    }
    if (tab === 'cards') this.ui.comingSoon(parent, 'AI finds connections for a card');
  }

  private recentCaptures(): CaptureSummary[] {
    return sortCaptures(this.host.snapshot().captures).slice(0, 2);
  }

  private renderFirstCard(parent: HTMLElement): void {
    const captures = this.recentCaptures();
    const blank = { label: 'Blank card', onClick: () => this.host.openQuickAdd('card') };
    if (!captures.length) {
      this.ui.empty(parent, 'Write your first card', 'Cards grow from your captures. Jot a thought, then develop one idea worth keeping.', 'notebook-pen', [
        { label: 'Capture your first thought', onClick: this.showCaptures, level: 'primary' }, blank
      ]);
      return;
    }
    this.ui.empty(parent, 'Write your first card', 'A card expresses a single idea in your own words. Start with a recent capture.', 'notebook-pen', [blank]);
    this.ui.sectionHeading(parent, 'Distill from a recent capture');
    for (const capture of captures) {
      const control = this.ui.userButton(parent, capture.name, async () => {
        await this.host.openCardFromCapture(capture.path, () => parent.isConnected);
      }, {
        icon: 'inbox', cls: 'tangrow-note-row', title: capture.path
      });
      const descriptionId = `tangrow-capture-description-${crypto.randomUUID()}`;
      control.dataset.tangrowAction = `distill-capture-${capture.path}`;
      control.setAttribute('aria-label', this.ui.t('Distill capture: {capture}', { capture: capture.name }));
      control.setAttribute('aria-describedby', descriptionId);
      const preview = control.createSpan({ cls: 'tangrow-note-folder', text: this.ui.t('Loading preview...'), attr: { id: descriptionId } });
      void this.host.readCapture(capture.path).then((content) => {
        preview.textContent = capturePreview(content) || this.ui.t('No text preview');
      }, () => { preview.textContent = this.ui.t('Preview unavailable'); });
    }
  }

  private renderStatus(parent: HTMLElement): boolean {
    if (this.failed) {
      this.ui.paragraph(parent, 'Card data could not be loaded.');
      this.ui.button(parent, 'Retry', () => this.refresh(this.reviewOpen), { icon: 'refresh-cw', cls: 'tangrow-chip' });
      return false;
    }
    if (!this.data) {
      this.ui.paragraph(parent, 'Loading knowledge notes…');
      return false;
    }
    return true;
  }

  private cardMeta(row: CardReportRow): string {
    const day = row.created
      ? new Date(`${row.created}T12:00:00`).toLocaleDateString(this.host.settings.language, { year: 'numeric', month: 'short', day: 'numeric' })
      : this.ui.t('Creation date unknown');
    return `${day} · ${this.ui.t(STAGE_LABELS[row.stage])}`;
  }

  private note(parent: HTMLElement, note: ReportRecord, detail: string, icon = 'file-text'): void {
    const control = this.ui.userButton(parent, note.name, () => this.host.openNote(note.path), { icon, cls: 'tangrow-note-row', title: note.path });
    control.createSpan({ cls: 'tangrow-note-folder', text: detail });
    control.dataset.tangrowAction = `knowledge-note-${note.path}`;
  }

  private renderReview(parent: HTMLElement, full: boolean): void {
    const cards = this.data!.knowledge;
    if (full && !cards.rows.length) {
      const capture = this.recentCaptures()[0];
      const label = capture ? 'Distill your first card' : 'Capture your first thought';
      const onClick = capture ? async () => {
        await this.host.openCardFromCapture(capture.path, () => parent.isConnected);
      } : this.showCaptures;
      this.ui.empty(parent, 'Review starts with cards', 'Review brings back a few cards each day, starting with unlinked cards and ones you have not seen in a while.', 'list-checks', [
        { label, onClick, level: 'primary' }
      ]);
      return;
    }
    const items = this.reviewItems();
    const available = items.filter(({ row }) => row);
    const next = available.find(({ reviewed }) => !reviewed);
    const done = available.filter(({ reviewed }) => reviewed).length;
    const section = parent.createDiv({ cls: 'tangrow-review' });
    const heading = section.createDiv({ cls: 'tangrow-list-heading' });
    this.ui.sectionHeading(heading, 'Daily card review');
    if (items.length) heading.createSpan({ cls: 'tangrow-muted', text: this.ui.t('{done} of {total} reviewed', { done: this.ui.number(done), total: this.ui.number(available.length) }) });
    if (items.length > available.length) {
      section.createEl('p', { cls: 'tangrow-muted', text: this.ui.t('Unavailable cards · {count}', { count: this.ui.number(items.length - available.length) }) });
    }
    if (!items.length && !cards.rows.length) this.ui.paragraph(section, 'No cards to review.');
    else if (!this.queue && !cards.linksReady) this.ui.paragraph(section, 'Building knowledge links…');
    else if (this.queueFailed) {
      this.ui.paragraph(section, 'The review queue could not be saved.');
      this.ui.button(section, 'Retry', async () => { await this.saveQueue(); this.onChange(); }, { icon: 'refresh-cw', cls: 'tangrow-chip' });
    } else if (next?.row) {
      const path = next.row.note.path;
      const control = this.ui.userButton(section, next.row.note.name, async () => {
        if (!this.queue) await this.saveQueue();
        if (this.queue) await this.host.openNote(path);
        this.onChange();
      }, { icon: 'notebook-pen', title: path, cls: 'tangrow-full-width' });
      control.dataset.tangrowAction = 'review-next-card';
      this.ui.paragraph(section, REVIEW_REASON[next.entry.reason]);
      const actions = section.createDiv({ cls: 'tangrow-chips tangrow-card-links' });
      const mark = this.ui.button(actions, 'Mark reviewed', async () => {
        if (!this.queue) await this.saveQueue();
        if (this.queue) {
          await this.host.markCardReviewed(path, this.queue.day, next.entry.path);
          this.queue = this.host.loadCardReview(this.queue.day) ?? this.queue;
        }
        this.onChange();
      }, { icon: 'check', level: full ? 'primary' : 'secondary' });
      mark.dataset.tangrowAction = 'mark-card-reviewed';
      const target = this.manuscript();
      const use = this.ui.button(actions, target ? 'Use in selected manuscript' : 'Choose a manuscript', async () => {
        if (!this.queue) await this.saveQueue();
        if (!this.queue) { this.onChange(); return; }
        if (target) {
          await this.host.addWritingMaterial(target, path);
          new Notice(this.ui.t('Added to manuscript candidates.'));
        } else this.chooseManuscript();
      }, { icon: 'pen-line', cls: 'tangrow-chip' });
      use.dataset.tangrowAction = 'review-use-card';
    } else if (items.length && !available.length) this.ui.paragraph(section, 'No cards from today’s queue are available.');
    else if (items.length) {
      if (full) {
        const unlinked = cards.linksReady ? cards.counts.isolated : 0;
        this.ui.empty(section, 'Today’s card review is complete.', 'A new set will be available tomorrow.', 'check', unlinked ? [{
          label: this.ui.t('See unlinked cards · {count}', { count: this.ui.number(unlinked) }), onClick: () => this.host.openCardReport('isolated')
        }] : []).setAttribute('role', 'status');
      } else this.ui.paragraph(section, 'Today’s card review is complete.');
    }
    if (!full) {
      const control = this.ui.button(section, 'Open review queue', () => this.showKnowledge('review'), { icon: 'list-checks', cls: 'tangrow-full-width tangrow-text-button' });
      control.dataset.tangrowAction = 'home-card-review';
      return;
    }
    if (items.length) {
      this.ui.sectionHeading(section, 'Today’s review queue');
      for (const { entry, row, reviewed } of items) {
        if (row) this.note(section, row.note, this.ui.t(reviewed ? 'Reviewed' : REVIEW_REASON[entry.reason]), reviewed ? 'check' : 'notebook-pen');
        else section.createEl('p', { cls: 'tangrow-muted', text: `${entry.path} · ${this.ui.t('Unavailable')}` });
      }
      if (cards.linksReady) this.ui.button(section, 'Rebuild review queue', async () => {
        await this.saveQueue(true);
        this.onChange();
      }, { icon: 'refresh-cw', cls: 'tangrow-chip' });
    }
  }
}
