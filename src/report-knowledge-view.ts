import { setTooltip } from 'obsidian';
import {
  CARD_RELATION_FILTERS, cardCreationTrend, filterCardReport, reportCaptureCoverage, reportDrafts, reportMaterials,
  type CardDateRange, type CardFilter, type CardReport, type CardReportRow
} from './card-report-data';
import type { CardRelation, CardRelationship } from './knowledge-index';
import type { ReportRange, ReportRecord, ReportSnapshot } from './report-contract';
import type { SidebarHost } from './types';
import { SidebarUI } from './ui';

const PAGE_SIZE = 20;
const FILTER_LABELS: Record<Exclude<CardFilter, 'period'>, string> = {
  all: 'All cards', week: 'Cards created in the last 7 days', isolated: 'Unconnected cards', inHub: 'Included in topics',
  reasoned: 'Outgoing connections with a reason', sourced: 'Cards with an explicit source', cited: 'Cited in manuscripts',
  candidate: 'Only collected as material', unused: 'Unused in manuscripts', seed: 'Seed', growing: 'Growing', evergreen: 'Evergreen',
  unset: 'Card maturity not set', unknown: 'Unrecognized card stage', recentReview: 'Reviewed in the last 30 days',
  stale: 'Last reviewed 30 or more days ago', noReview: 'No review recorded', invalidReview: 'Review date needs checking',
  unknownCreated: 'Creation date needs checking'
};
const RELATIONS: Record<CardRelation, string> = {
  supports: 'Supports', challenges: 'Challenges', extends: 'Extends', exemplifies: 'Exemplifies', contrasts: 'Contrasts', related: 'Related'
};
const DRAFT_STAGES = {
  outline: 'Outline', drafting: 'Drafting', revising: 'Revising', finished: 'Finished', published: 'Published',
  unset: 'Writing stage not set', unknown: 'Unrecognized writing stage'
} as const;
const MATERIAL_REASONS = { literature: 'Literature note', clip: 'Clip', resource: 'Resource folder', derived: 'Note with a derivation source' } as const;

export class ReportKnowledgeView {
  composing = false;
  private readonly ui: SidebarUI;
  private filter: CardFilter = 'all';
  private dates?: CardDateRange;
  private cardSearch = '';
  private cardPage = 0;
  private readonly draftFilters = { stage: '', page: 0 };
  private readonly materialFilters = { search: '', coveredOnly: false, page: 0 };
  private readonly expanded = new Set<string>();

  constructor(
    private readonly host: SidebarHost,
    private readonly openCards: (filter: CardFilter, dates?: CardDateRange) => void,
    private readonly openOverview?: () => void,
    private readonly onCompositionEnd?: () => void
  ) {
    this.ui = new SidebarUI(() => this.host.settings.language);
  }

  selectCards(filter: CardFilter = 'all', dates?: CardDateRange): void {
    this.filter = filter === 'period' && !dates ? 'all' : filter;
    this.dates = dates;
    this.cardPage = 0;
    this.cardSearch = '';
  }

  resetDraftFilters(): void {
    this.draftFilters.stage = '';
    this.draftFilters.page = 0;
  }

  renderOverview(parent: HTMLElement, snapshot: ReportSnapshot, range: ReportRange): void {
    if (!this.host.settings.knowledgeEnabled || !snapshot.cards) return;
    const cards = snapshot.cards;
    const panel = parent.createEl('section', { cls: 'tangrow-report-panel tangrow-card-report' });
    const title = panel.createDiv({ cls: 'tangrow-report-panel-heading' });
    title.createEl('h2', { text: this.ui.t('Card notes') });
    this.ui.button(title, 'View card details', () => this.openCards('all'), { icon: 'arrow-right' });

    const metrics = panel.createDiv({ cls: 'tangrow-card-metrics' });
    this.metric(metrics, 'Current cards', this.ui.number(cards.counts.all), () => this.openCards('all'));
    for (const filter of ['inHub', 'cited'] as const) {
      this.metric(metrics, FILTER_LABELS[filter], cards.linksReady ? this.ui.number(cards.counts[filter]) : this.ui.t('Pending confirmation'),
        () => this.openCards(filter), undefined, !cards.linksReady);
    }

    const trend = cardCreationTrend(cards, range);
    const heading = panel.createDiv({ cls: 'tangrow-report-panel-heading' });
    const trendTitle = heading.createEl('h3', { text: this.ui.t('Card creation trend'), attr: { tabindex: '-1', 'data-card-trend-destination': '' } });
    trendTitle.dataset.reportFocus = 'card-overview-trend';
    heading.createSpan({ cls: 'tangrow-muted', text: this.ui.t(trend.step === 1 ? 'Grouped by day' : 'Groups of {count} days', { count: trend.step }) });
    const totals = panel.createDiv({ cls: 'tangrow-card-controls' });
    this.ui.userButton(totals, this.ui.t('Created in range · {count}', { count: this.ui.number(trend.count) }), () => this.openCards('period', { first: trend.first, last: trend.last }));
    if (trend.unknown) this.ui.userButton(totals, this.ui.t('{count} cards with creation dates to check', { count: this.ui.number(trend.unknown) }), () => this.openCards('unknownCreated'));

    const scroller = panel.createDiv({ cls: 'tangrow-card-trend-scroll' });
    const bars = scroller.createDiv({ cls: 'tangrow-card-trend', attr: { role: 'group', 'aria-label': this.ui.t('Open cards by creation date') } });
    bars.style.setProperty('--tangrow-card-bins', String(trend.bins.length));
    const peak = Math.max(1, ...trend.bins.map((bin) => bin.count));
    for (const bin of trend.bins) {
      const label = this.ui.t('{range} · {count} cards', { range: this.dateRange(bin), count: this.ui.number(bin.count) });
      const button = this.ui.userButton(bars, this.ui.number(bin.count), () => this.openCards('period', { first: bin.first, last: bin.last }), {
        cls: 'tangrow-card-trend-bin', title: label
      });
      button.setAttribute('aria-label', label);
      const bar = button.createDiv({ cls: 'tangrow-card-trend-column', attr: { 'aria-hidden': 'true' } });
      bar.style.setProperty('--tangrow-card-bar-height', `${bin.count / peak * 100}%`);
      button.createEl('small', { text: this.date(bin.first, true), attr: { 'aria-hidden': 'true' } });
    }
    panel.createEl('p', { cls: 'tangrow-report-caption', text: this.dateRange(trend) });
  }

  renderCards(parent: HTMLElement, snapshot: ReportSnapshot): void {
    const cards = snapshot.cards;
    if (!this.host.settings.knowledgeEnabled || !cards) return;
    const panel = parent.createEl('section', { cls: 'tangrow-report-panel tangrow-card-report' });
    const heading = panel.createDiv({ cls: 'tangrow-report-panel-heading' });
    heading.createEl('h2', { text: this.ui.t('Card notes'), attr: { tabindex: '-1', 'data-card-destination': '' } });
    if (this.openOverview) this.ui.button(heading, 'View card creation trend', this.openOverview);
    if (!cards.linksReady) this.ui.paragraph(panel, 'Indexing card relationships. Connection, topic and manuscript counts are pending.');

    const metrics = panel.createDiv({ cls: 'tangrow-card-metrics' });
    const metric = (key: CardFilter, title: string, numerator: number, denominator?: number): void => {
      const pending = !cards.linksReady && CARD_RELATION_FILTERS.has(key);
      const value = pending ? this.ui.t('Pending confirmation') : denominator === undefined ? this.ui.number(numerator) : this.percentage(numerator, denominator);
      this.metric(metrics, title, value, () => this.openCards(key), !pending && denominator !== undefined ? this.ratio(numerator, denominator) : undefined, pending);
    };
    metric('all', 'Current cards', cards.counts.all);
    metric('isolated', 'Unconnected card rate', cards.counts.isolated, cards.counts.all);
    metric('inHub', 'Topic coverage', cards.counts.inHub, cards.counts.all);
    metric('reasoned', 'Connections with a reason', cards.reasonedEdges, cards.edges);
    metric('cited', 'Manuscript citation rate', cards.counts.cited, cards.counts.all);
    metric('sourced', 'Cards with an explicit source', cards.counts.sourced);

    this.breakdown(panel, cards, 'Card maturity', ['seed', 'growing', 'evergreen', 'unset', 'unknown']);
    this.breakdown(panel, cards, 'Writing usage', ['cited', 'candidate', 'unused']);
    this.breakdown(panel, cards, 'Review history', ['recentReview', 'stale', 'noReview', 'invalidReview']);

    const listing = panel.createEl('section', { cls: 'tangrow-card-listing' });
    listing.createEl('h3', { text: this.ui.t('Card details'), attr: { tabindex: '-1', 'data-card-list-destination': '' } });
    const filters = listing.createDiv({ cls: 'tangrow-card-controls' });
    const filterLabel = filters.createEl('label');
    filterLabel.createSpan({ text: this.ui.t('Card filter') });
    const select = filterLabel.createEl('select');
    select.dataset.reportFocus = 'card-filter';
    for (const [key, label] of Object.entries(FILTER_LABELS) as Array<[Exclude<CardFilter, 'period'>, string]>) {
      const option = select.createEl('option', { value: key, text: this.ui.t(label) });
      option.disabled = !cards.linksReady && CARD_RELATION_FILTERS.has(key);
    }
    if (this.dates) select.createEl('option', { value: 'period', text: this.dateRange(this.dates) });
    select.value = this.filter;
    const searchLabel = filters.createEl('label');
    searchLabel.createSpan({ text: this.ui.t('Search cards') });
    const input = searchLabel.createEl('input', { type: 'search', attr: { placeholder: this.ui.t('Title or file path') } });
    input.dataset.reportFocus = 'card-search';
    input.value = this.cardSearch;
    const results = listing.createDiv();
    const update = (): void => this.renderCardList(results, cards);
    select.addEventListener('change', () => { this.filter = select.value as CardFilter; this.cardPage = 0; update(); });
    this.bindSearch(input, () => { this.cardSearch = input.value; this.cardPage = 0; update(); });
    update();
  }

  private bindSearch(input: HTMLInputElement, update: () => void): void {
    input.addEventListener('compositionstart', () => { this.composing = true; });
    input.addEventListener('compositionend', () => {
      this.composing = false;
      update();
      this.onCompositionEnd?.();
    });
    input.addEventListener('input', () => { if (!this.composing) update(); });
  }

  private breakdown(parent: HTMLElement, cards: CardReport, label: string, filters: Array<Exclude<CardFilter, 'period'>>): void {
    const section = parent.createDiv({ cls: 'tangrow-card-breakdown' });
    section.createEl('h3', { text: this.ui.t(label) });
    const controls = section.createDiv({ cls: 'tangrow-card-controls' });
    for (const key of filters) {
      if ((key === 'unknown' || key === 'invalidReview') && !cards.counts[key]) continue;
      const pending = !cards.linksReady && CARD_RELATION_FILTERS.has(key);
      const count = pending ? this.ui.t('Pending confirmation') : this.ui.number(cards.counts[key]);
      this.ui.userButton(controls, `${this.ui.t(FILTER_LABELS[key])} · ${count}`, () => this.openCards(key), { disabled: pending });
    }
  }

  private renderCardList(parent: HTMLElement, cards: CardReport): void {
    parent.empty();
    if (!cards.linksReady && CARD_RELATION_FILTERS.has(this.filter)) {
      this.ui.paragraph(parent, 'Pending confirmation');
      return;
    }
    const rows = filterCardReport(cards, this.filter, this.dates, this.cardSearch);
    parent.createEl('p', { cls: 'tangrow-report-caption', attr: { role: 'status' }, text: this.ui.t('{count} cards', { count: this.ui.number(rows.length) }) });
    if (!rows.length) {
      this.ui.paragraph(parent, cards.rows.length ? 'No cards match the current filter.' : 'There are no card notes yet.');
      if (this.filter !== 'all' || this.cardSearch) this.ui.button(parent, 'Clear filters', () => this.openCards('all'));
      if (!cards.rows.length) this.ui.button(parent, 'New card', () => this.host.openQuickAdd('card'), { icon: 'plus' });
      return;
    }
    if (this.filter === 'reasoned') this.ui.paragraph(parent, 'Open each card to see the targets and reasons for its outgoing connections.');
    const pages = Math.ceil(rows.length / PAGE_SIZE);
    this.cardPage = Math.min(this.cardPage, pages - 1);
    for (const row of rows.slice(this.cardPage * PAGE_SIZE, (this.cardPage + 1) * PAGE_SIZE)) this.cardRow(parent, row, cards.linksReady);
    this.pager(parent, this.cardPage, pages, (page) => { this.cardPage = page; this.renderCardList(parent, cards); });
  }

  private cardRow(parent: HTMLElement, row: CardReportRow, ready: boolean): void {
    const entry = parent.createEl('article', { cls: 'tangrow-card-entry' });
    const header = entry.createDiv({ cls: 'tangrow-report-panel-heading' });
    this.noteButton(header, row.note);
    header.createSpan({ cls: 'tangrow-muted', text: this.ui.t(FILTER_LABELS[row.stage]) });
    const created = row.created ? `${this.date(row.created)} · ${this.ui.t(row.creationBasis === 'property' ? 'Created property' : 'File creation time')}` : this.ui.t('Creation date needs checking');
    const use = (['cited', 'candidate', 'unused'] as const).find((filter) => row.groups.has(filter));
    const summary = [created, ready && use ? this.ui.t(FILTER_LABELS[use]) : '', ready && row.groups.has('isolated') ? this.ui.t('Unconnected cards') : ''].filter(Boolean);
    entry.createEl('p', { cls: 'tangrow-report-caption', text: summary.join(' · ') });
    const details = entry.createEl('details');
    details.open = this.expanded.has(row.note.path);
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) this.expanded.add(row.note.path);
      else this.expanded.delete(row.note.path);
    });
    details.createEl('summary', { text: this.ui.t('Sources and usage') });
    const list = details.createEl('dl');
    this.detail(list, 'File path').setText(row.note.path);
    this.detail(list, 'Creation date').setText(created);
    if (row.stage === 'unknown') this.detail(list, 'Card maturity').setText(String(row.note.frontmatter?.tangrow_stage));
    this.detail(list, 'Latest review').setText(row.reviewed ? this.date(row.reviewed) : this.ui.t(row.groups.has('invalidReview') ? 'Review date needs checking' : 'No review recorded'));
    if (ready) {
      this.links(this.detail(list, 'Derivation sources'), row.sources, 'Missing source');
      if (row.legacySources.length) this.links(this.detail(list, 'Existing source links'), row.legacySources, 'Missing source');
      if (row.parent.length) this.links(this.detail(list, 'Parent card'), row.parent);
      this.links(this.detail(list, 'Outgoing body links'), row.outgoing);
      this.links(this.detail(list, 'Incoming body links'), row.incoming);
      this.links(this.detail(list, 'Topics'), row.hubs);
      this.links(this.detail(list, 'Candidate manuscripts'), row.candidates);
      this.links(this.detail(list, 'Manuscripts citing this card'), row.citations);
    } else this.detail(list, 'Relationships').setText(this.ui.t('Pending confirmation'));
    if (row.bodyUnreadable) this.ui.paragraph(details, 'This card could not be read. Connection reasons may be incomplete.');
  }

  renderDrafts(parent: HTMLElement, snapshot: ReportSnapshot): void {
    const panel = parent.createEl('section', { cls: 'tangrow-report-panel tangrow-card-report' });
    panel.createEl('h2', { text: this.ui.t('Manuscript progress') });
    const drafts = reportDrafts(snapshot);
    const ready = snapshot.quality.linksReady;
    const filter = panel.createDiv({ cls: 'tangrow-card-controls' });
    const select = filter.createEl('select', { attr: { 'aria-label': this.ui.t('Writing stage') } });
    select.dataset.reportFocus = 'draft-stage';
    select.createEl('option', { value: '', text: this.ui.t('All manuscripts · {count}', { count: this.ui.number(drafts.length) }) });
    for (const [stage, label] of Object.entries(DRAFT_STAGES)) {
      const count = drafts.filter((draft) => draft.stage === stage).length;
      select.createEl('option', { value: stage, text: `${this.ui.t(label)} · ${this.ui.number(count)}` });
    }
    const state = this.draftFilters;
    select.value = state.stage;
    const results = panel.createDiv();
    const update = (): void => {
      const selected = drafts.filter((draft) => !state.stage || draft.stage === state.stage);
      this.recordList(results, selected, 'No matching manuscripts.', (entry, draft) => {
        this.noteButton(entry, draft.note);
        entry.createSpan({ cls: 'tangrow-muted', text: this.ui.t(DRAFT_STAGES[draft.stage]) });
        const details = entry.createEl('details');
        details.createEl('summary', { text: this.ui.t('Sources and usage') });
        const list = details.createEl('dl');
        this.detail(list, 'File path').setText(draft.note.path);
        if (!ready) this.detail(list, 'Relationships').setText(this.ui.t('Pending confirmation'));
        else {
          this.links(this.detail(list, 'Candidate material'), draft.candidates);
          this.links(this.detail(list, 'Body citations'), draft.citations);
          const cards = this.detail(list, 'Cards derived from this manuscript');
          if (!draft.cards.length) cards.setText(this.ui.t('None'));
          for (const card of draft.cards) this.noteButton(cards, card);
        }
      }, state);
    };
    select.addEventListener('change', () => { state.stage = select.value; state.page = 0; update(); });
    update();
  }

  renderMaterials(parent: HTMLElement, snapshot: ReportSnapshot): void {
    const panel = parent.createEl('section', { cls: 'tangrow-report-panel tangrow-card-report' });
    panel.createEl('h2', { text: this.ui.t('Source materials') });
    const materials = reportMaterials(snapshot, this.host.settings);
    const filters = panel.createDiv({ cls: 'tangrow-card-controls' });
    const search = filters.createEl('input', { type: 'search', attr: { 'aria-label': this.ui.t('Search materials'), placeholder: this.ui.t('Title or file path') } });
    const state = this.materialFilters;
    search.dataset.reportFocus = 'material-search';
    search.value = state.search;
    const results = panel.createDiv();
    const coverage = materials.covered;
    const values = coverage === null ? this.ui.t('Pending confirmation') : `${this.percentage(coverage, materials.rows.length)} · ${this.ratio(coverage, materials.rows.length)}`;
    const toggle = this.ui.userButton(filters, `${this.ui.t('Material derivation coverage')} · ${values}`, () => {
      state.coveredOnly = !state.coveredOnly;
      state.page = 0;
      toggle.setAttribute('aria-pressed', String(state.coveredOnly));
      update();
    }, { disabled: coverage === null, pressed: state.coveredOnly });
    toggle.dataset.reportFocus = 'material-coverage';
    const update = (): void => {
      if (state.coveredOnly && coverage === null) {
        results.empty();
        this.ui.paragraph(results, 'Pending confirmation');
        return;
      }
      const query = state.search.trim().toLocaleLowerCase();
      const selected = materials.rows.filter(({ note, cards }) => (!state.coveredOnly || (cards ?? 0) > 0) && `${note.name} ${note.path}`.toLocaleLowerCase().includes(query));
      this.recordList(results, selected, 'No matching materials.', (entry, material) => {
        this.noteButton(entry, material.note);
        entry.createSpan({ cls: 'tangrow-muted', text: this.ui.t(MATERIAL_REASONS[material.reason]) });
        entry.createEl('p', { cls: 'tangrow-report-caption', text: material.cards === null || material.citations === null
          ? this.ui.t('Pending confirmation') : this.ui.t('{cards} derived cards · {drafts} citing manuscripts', { cards: this.ui.number(material.cards), drafts: this.ui.number(material.citations) }) });
      }, state);
    };
    this.bindSearch(search, () => { state.search = search.value; state.page = 0; update(); });
    update();
  }

  renderCaptureCoverage(parent: HTMLElement, snapshot: ReportSnapshot): void {
    const { captures, withResult, rows } = reportCaptureCoverage(snapshot);
    const panel = parent.createEl('details', { cls: 'tangrow-report-panel tangrow-card-report' });
    const ratio = withResult === null ? this.ui.t('Pending confirmation') : `${this.percentage(withResult, captures)} · ${this.ratio(withResult, captures)}`;
    panel.createEl('summary', { text: `${this.ui.t('Capture results in the last 90 days')} · ${ratio}` });
    const entries = panel.createDiv();
    this.recordList(entries, withResult === null ? rows : rows.filter(({ hasResult }) => hasResult), 'No captures with a result in this period.', (entry, { note }) => this.noteButton(entry, note));
  }

  private recordList<T>(parent: HTMLElement, rows: readonly T[], empty: string, render: (entry: HTMLElement, row: T) => void, state?: { page: number }): void {
    const pages = Math.ceil(rows.length / PAGE_SIZE);
    const show = (page: number): void => {
      if (state) state.page = page;
      parent.empty();
      if (!rows.length) this.ui.paragraph(parent, empty);
      for (const row of rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) render(parent.createEl('article', { cls: 'tangrow-card-entry' }), row);
      this.pager(parent, page, pages, show);
    };
    show(Math.min(state?.page ?? 0, Math.max(0, pages - 1)));
  }

  private pager(parent: HTMLElement, page: number, pages: number, select: (page: number) => void): void {
    if (pages < 2) return;
    const controls = parent.createDiv({ cls: 'tangrow-card-controls' });
    this.ui.button(controls, 'Previous page', () => select(page - 1), { disabled: page === 0 });
    controls.createSpan({ text: this.ratio(page + 1, pages) });
    this.ui.button(controls, 'Next page', () => select(page + 1), { disabled: page === pages - 1 });
  }

  private metric(parent: HTMLElement, label: string, value: string, open: () => void, detail?: string, disabled = false): void {
    const button = this.ui.button(parent, label, open, { cls: 'tangrow-report-metric tangrow-card-metric', disabled });
    button.createEl('strong', { text: value });
    button.setAttribute('aria-label', `${this.ui.t(label)} · ${value}${detail ? ` · ${detail}` : ''}`);
    if (detail) button.createEl('small', { text: detail });
  }

  private links(parent: HTMLElement, links: readonly CardRelationship[], missing = 'Unresolved link'): void {
    if (!links.length) { parent.setText(this.ui.t('None')); return; }
    const list = parent.createEl('ul');
    for (const link of links) {
      const item = list.createEl('li');
      if (link.path) {
        const path = link.path;
        const title = `${path.split('/').at(-1)?.replace(/\.md$/i, '') ?? path}${link.anchor}`;
        this.ui.userButton(item, title, () => this.host.openNote(path, undefined, link.anchorMissing ? undefined : link.anchor), { cls: 'tangrow-card-note-link', title: `${path}${link.anchor}` });
        if (link.anchorMissing) item.createSpan({ text: ` · ${this.ui.t('Missing anchor')}` });
      } else item.createSpan({ text: `${link.raw} · ${this.ui.t(missing)}` });
      if (link.relation) item.createSpan({ text: ` · ${this.ui.t(RELATIONS[link.relation])}` });
      if (link.reason) item.createSpan({ text: ` · ${link.reason}` });
    }
  }

  private noteButton(parent: HTMLElement, note: ReportRecord): void {
    const button = this.ui.userButton(parent, note.name, () => this.host.openNote(note.path), { cls: 'tangrow-card-note-link' });
    setTooltip(button, note.path);
  }

  private detail(parent: HTMLElement, label: string): HTMLElement {
    parent.createEl('dt', { text: this.ui.t(label) });
    return parent.createEl('dd');
  }

  private ratio(numerator: number, denominator: number): string { return `${this.ui.number(numerator)} / ${this.ui.number(denominator)}`; }
  private percentage(numerator: number, denominator: number): string {
    return denominator ? (numerator / denominator).toLocaleString(this.host.settings.language, { style: 'percent', maximumFractionDigits: 1 }) : this.ui.t('No data');
  }
  private date(day: string, short = false): string {
    return new Date(`${day}T12:00:00`).toLocaleDateString(this.host.settings.language, short ? { month: 'numeric', day: 'numeric' } : undefined);
  }
  private dateRange({ first, last }: CardDateRange): string { return first === last ? this.date(first) : `${this.date(first)} – ${this.date(last)}`; }
}
