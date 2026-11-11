import { MarkdownView, Modal, Notice, setIcon } from 'obsidian';
import { CapturePanel } from './capture-panel';
import { describeError, translate } from './i18n';
import type { SidebarHost } from './types';

function control(parent: HTMLElement, label: string, icon: string, run: () => void): HTMLButtonElement {
  const button = parent.createEl('button', { cls: 'tangrow-button', attr: { type: 'button', 'aria-label': label, title: label } });
  setIcon(button.createSpan({ cls: 'tangrow-icon' }), icon);
  button.createSpan({ text: label });
  button.addEventListener('click', run);
  return button;
}

function fullscreen(target: HTMLElement, host: SidebarHost): void {
  try {
    const document = target.ownerDocument;
    const operation = document.fullscreenElement ? document.exitFullscreen() : target.requestFullscreen?.();
    if (operation) void operation.catch((error: unknown) => new Notice(describeError(host.settings.language, error)));
  } catch (error) { new Notice(describeError(host.settings.language, error)); }
}

export class ImmersiveCapture extends Modal {
  private panel?: CapturePanel;
  private unsubscribe?: () => void;
  private fullscreenButton?: HTMLButtonElement;
  private closeButton?: HTMLButtonElement;

  constructor(private readonly host: SidebarHost, private readonly closed: () => void) { super(host.app); }

  onOpen(): void {
    this.containerEl.addClass('tangrow-immersive-container');
    this.modalEl.addClass('tangrow-immersive-modal');
    const toolbar = this.contentEl.createDiv({ cls: 'tangrow-immersive-toolbar' });
    this.fullscreenButton = control(toolbar, '', 'maximize', () => fullscreen(this.modalEl, this.host));
    this.fullscreenButton.hidden = typeof this.modalEl.requestFullscreen !== 'function';
    this.closeButton = control(toolbar, '', 'minimize-2', () => this.close());
    this.panel = new CapturePanel(this.host, { composerOnly: true });
    this.panel.mount(this.contentEl);
    this.unsubscribe = this.host.subscribe(() => this.refreshLanguage());
    this.refreshLanguage();
    this.contentEl.querySelector('textarea')?.focus();
  }

  refreshLanguage(): void {
    const label = (button: HTMLButtonElement | undefined, source: string): void => {
      if (!button) return;
      const text = translate(this.host.settings.language, source);
      button.setAttribute('aria-label', text);
      button.title = text;
      button.lastElementChild!.textContent = text;
    };
    this.setTitle(translate(this.host.settings.language, 'Immersive capture'));
    label(this.fullscreenButton, 'Toggle system fullscreen');
    label(this.closeButton, 'Exit immersive mode');
    this.panel?.refresh();
  }

  onClose(): void {
    const document = this.modalEl.ownerDocument;
    if (document.fullscreenElement === this.modalEl) void document.exitFullscreen().catch(() => undefined);
    this.unsubscribe?.();
    this.panel?.destroy();
    this.contentEl.empty();
    this.closed();
  }
}

export class NoteImmersion {
  private isClosed = false;
  private ancestors: HTMLElement[] = [];
  private toolbar: HTMLElement;
  private document: Document;
  private unsubscribe: () => void;
  private fullscreenButton: HTMLButtonElement;
  private closeButton: HTMLButtonElement;

  constructor(private readonly view: MarkdownView, private readonly host: SidebarHost, private readonly closed: () => void) {
    const target = view.containerEl;
    this.document = target.ownerDocument;
    let ancestor = target.parentElement;
    while (ancestor && ancestor !== this.document.body) {
      ancestor.addClass('tangrow-immersive-ancestor');
      this.ancestors.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    target.addClass('tangrow-immersive-note');
    this.toolbar = target.createDiv({ cls: 'tangrow-immersive-toolbar' });
    this.fullscreenButton = control(this.toolbar, '', 'maximize', () => fullscreen(target, host));
    this.fullscreenButton.hidden = typeof target.requestFullscreen !== 'function';
    this.closeButton = control(this.toolbar, '', 'minimize-2', () => this.close());
    this.document.addEventListener('keydown', this.onKeyDown, true);
    this.unsubscribe = host.subscribe(() => this.refreshLanguage());
    this.refreshLanguage();
    view.editor.focus();
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  private refreshLanguage(): void {
    for (const [button, source] of [[this.fullscreenButton, 'Toggle system fullscreen'], [this.closeButton, 'Exit immersive mode']] as const) {
      const label = translate(this.host.settings.language, source);
      button.setAttribute('aria-label', label);
      button.title = label;
      button.lastElementChild!.textContent = label;
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.unsubscribe();
    this.document.removeEventListener('keydown', this.onKeyDown, true);
    if (this.document.fullscreenElement === this.view.containerEl) void this.document.exitFullscreen().catch(() => undefined);
    this.toolbar.remove();
    this.view.containerEl.removeClass('tangrow-immersive-note');
    for (const ancestor of this.ancestors) ancestor.removeClass('tangrow-immersive-ancestor');
    this.ancestors = [];
    this.closed();
  }
}
