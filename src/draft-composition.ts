type DraftControl = HTMLInputElement | HTMLTextAreaElement;

export class DraftComposition {
  private readonly value: string;
  private readonly start: number;
  private readonly end: number;
  private readonly direction: DraftControl['selectionDirection'];
  private readonly scrollTop: number;
  private preeditAtKeyUp?: string;
  private cancelled = false;

  constructor(readonly control: DraftControl) {
    this.value = control.value;
    this.start = control.selectionStart ?? 0;
    this.end = control.selectionEnd ?? this.start;
    this.direction = control.selectionDirection;
    this.scrollTop = control.scrollTop;
  }

  keyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' || event.code === 'Escape') {
      this.cancelled = true;
      // Let the IME handle Escape without letting a workspace shortcut move focus.
      event.stopPropagation();
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey &&
      (event.key.length === 1 || event.key === 'Enter' || event.key === 'Tab')) {
      this.preeditAtKeyUp = undefined;
    }
  }

  keyUp(event: KeyboardEvent): void {
    if (event.isComposing) this.preeditAtKeyUp = this.control.value;
  }

  input(): void {
    this.preeditAtKeyUp = undefined;
  }

  finish(): boolean {
    // Obsidian can end composition before dispatching the click that closes the view.
    // An unchanged preedit from a released key has not received a confirming edit.
    if (this.control.value === this.preeditAtKeyUp) this.cancelled = true;
    return !this.restoreIfCancelled();
  }

  restoreIfCancelled(): boolean {
    if (!this.cancelled) return false;
    if (this.control.value !== this.value) this.control.value = this.value;
    this.control.setSelectionRange(this.start, this.end, this.direction ?? undefined);
    this.control.scrollTop = this.scrollTop;
    return true;
  }
}
