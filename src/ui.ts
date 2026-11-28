import { Notice, setIcon, setTooltip } from 'obsidian';
import { describeError, translate } from './i18n';
import type { TranslationValues } from './i18n';
import type { Locale } from './types';

export function icon(parent: HTMLElement, name: string): HTMLElement {
  const element = parent.createSpan({ cls: 'tangrow-icon' });
  setIcon(element, name);
  return element;
}

/** Name a button independently of the aria-label Obsidian uses for its hover tooltip. */
export function nameTooltipButton(button: HTMLButtonElement, name: string): void {
  const id = `tangrow-button-name-${crypto.randomUUID()}`;
  button.createSpan({ text: name, attr: { id, hidden: '' } });
  button.setAttribute('aria-labelledby', id);
}

export interface ButtonOptions {
  icon?: string;
  cls?: string;
  level?: 'primary' | 'secondary' | 'text';
  disabled?: boolean;
  title?: string;
  pressed?: boolean;
}

interface EmptyAction extends ButtonOptions {
  label: string;
  onClick: () => void | Promise<void>;
}

const buttonLevels: Record<NonNullable<ButtonOptions['level']>, string> = {
  primary: 'mod-cta', secondary: '', text: 'tangrow-text-button'
};

export class SidebarUI {
  constructor(private readonly language: () => Locale, private readonly showComingSoon: () => boolean = () => true) {}

  t(source: string, values?: TranslationValues): string {
    return translate(this.language(), source, values);
  }

  number(value: number): string { return value.toLocaleString(this.language()); }

  paragraph(parent: HTMLElement, source: string, cls = 'tangrow-muted'): HTMLElement {
    return parent.createEl('p', { text: this.t(source), cls });
  }

  sectionHeading(parent: HTMLElement, title: string, caption?: string): void {
    parent.createEl('h3', { cls: 'tangrow-section-title', text: this.t(title) });
    if (caption) this.paragraph(parent, caption, 'tangrow-section-caption');
  }

  button(parent: HTMLElement, source: string, onClick: () => void | Promise<void>, options: ButtonOptions = {}): HTMLButtonElement {
    return this.userButton(parent, this.t(source), onClick, { ...options, title: options.title ? this.t(options.title) : undefined });
  }

  userButton(parent: HTMLElement, label: string, onClick: () => void | Promise<void>, options: ButtonOptions = {}): HTMLButtonElement {
    const element = parent.createEl('button', {
      cls: ['tangrow-button', buttonLevels[options.level ?? 'secondary'], options.cls].filter(Boolean).join(' '),
      attr: { type: 'button', 'aria-label': label }
    });
    if (options.icon) icon(element, options.icon);
    element.createSpan({ text: label });
    element.disabled = options.disabled ?? false;
    if (options.title) setTooltip(element, options.title);
    if (options.pressed !== undefined) element.setAttribute('aria-pressed', String(options.pressed));
    element.addEventListener('click', () => {
      if (element.disabled || element.getAttribute('aria-busy') === 'true') return;
      element.setAttribute('aria-busy', 'true');
      Promise.resolve().then(onClick).catch((error: unknown) => {
        new Notice(describeError(this.language(), error instanceof Error ? error : new Error('Tangrow could not complete this action.')));
      }).finally(() => {
        element.removeAttribute('aria-busy');
      });
    });
    return element;
  }

  empty(parent: HTMLElement, title: string, detail: string, iconName = 'sprout', actions: readonly EmptyAction[] = []): HTMLElement {
    const box = parent.createDiv({ cls: 'tangrow-empty' });
    icon(box, iconName);
    box.createEl('strong', { text: this.t(title) });
    this.paragraph(box, detail);
    if (actions.length) {
      const controls = box.createDiv({ cls: 'tangrow-empty-actions' });
      for (const { label, onClick, ...options } of actions) this.button(controls, label, onClick, options);
    }
    return box;
  }

  comingSoon(parent: HTMLElement, source: string): void {
    if (!this.showComingSoon()) return;
    const row = parent.createDiv({ cls: 'tangrow-coming-soon' });
    icon(row, 'sparkles').setAttribute('aria-hidden', 'true');
    row.createSpan({ cls: 'tangrow-coming-soon-description', text: this.t(source) });
    row.createSpan({ cls: 'tangrow-coming-soon-label', text: this.t('Coming soon') });
  }
}
