import { Notice, setIcon, setTooltip } from 'obsidian';
import { describeError, translate } from './i18n';
import type { TranslationValues } from './i18n';
import type { Locale } from './types';

export function icon(parent: HTMLElement, name: string): HTMLElement {
  const element = parent.createSpan({ cls: 'tangrow-icon' });
  setIcon(element, name);
  return element;
}

export interface ButtonOptions {
  icon?: string;
  cls?: string;
  disabled?: boolean;
  title?: string;
  pressed?: boolean;
}

export class SidebarUI {
  constructor(private readonly language: () => Locale) {}

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
      cls: `tangrow-button ${options.cls ?? ''}`,
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

  empty(parent: HTMLElement, title: string, detail: string, iconName = 'sprout'): void {
    const box = parent.createDiv({ cls: 'tangrow-empty' });
    icon(box, iconName);
    box.createEl('strong', { text: this.t(title) });
    this.paragraph(box, detail);
  }
}
