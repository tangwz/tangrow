import { Platform } from 'obsidian';

type DraftControl = HTMLInputElement | HTMLTextAreaElement;

/**
 * Mobile keyboards keep the word being typed as composition text, so on mobile that text is the user's input,
 * not an unconfirmed IME candidate, and is saved like ordinary input.
 */
export function tracksComposition(): boolean {
  return !Platform.isMobile;
}

/**
 * Tracks one IME composition so that text which was never confirmed stays out of the shared draft.
 *
 * A composition counts as unconfirmed only when something interrupted it: Escape, a shortcut, or a pointer press
 * outside the control (Obsidian can end composition before the click that closes a view). Every other ending,
 * including commit keys that leave the text unchanged such as Shift, Enter or a Korean syllable boundary, keeps it.
 */
export class DraftComposition {
  private readonly value: string;
  private readonly start: number;
  private readonly end: number;
  private readonly direction: DraftControl['selectionDirection'];
  private readonly scrollTop: number;
  private interrupted = false;
  private readonly stopListening: () => void;

  constructor(readonly control: DraftControl) {
    this.value = control.value;
    this.start = control.selectionStart ?? 0;
    this.end = control.selectionEnd ?? this.start;
    this.direction = control.selectionDirection;
    this.scrollTop = control.scrollTop;
    const document = control.ownerDocument as Partial<Document> | null;
    const pressed = (event: Event) => { if (event.target !== control) this.interrupted = true; };
    if (typeof document?.addEventListener === 'function' && typeof document.removeEventListener === 'function') {
      const remove = document.removeEventListener.bind(document);
      document.addEventListener('pointerdown', pressed, true);
      document.addEventListener('mousedown', pressed, true);
      this.stopListening = () => {
        remove('pointerdown', pressed, true);
        remove('mousedown', pressed, true);
      };
    } else this.stopListening = () => {};
  }

  keyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' || event.code === 'Escape') {
      this.interrupted = true;
      // Let the IME handle Escape without letting a workspace shortcut move focus.
      event.stopPropagation();
    } else if (event.ctrlKey || event.metaKey || event.altKey) {
      // A shortcut such as closing the view can end the composition without confirming it.
      this.interrupted = true;
    } else {
      // Typing on after Escape (a Japanese IME only reverts the conversion) or after returning to the window
      // continues the same composition.
      this.interrupted = false;
    }
  }

  /** Ends tracking. Returns whether the text was confirmed; an interrupted composition is restored first. */
  finish(): boolean {
    this.dispose();
    return !this.restoreIfInterrupted();
  }

  restoreIfInterrupted(): boolean {
    if (!this.interrupted) return false;
    if (this.control.value !== this.value) this.control.value = this.value;
    this.control.setSelectionRange(this.start, this.end, this.direction ?? undefined);
    this.control.scrollTop = this.scrollTop;
    return true;
  }

  dispose(): void {
    this.stopListening();
  }
}
