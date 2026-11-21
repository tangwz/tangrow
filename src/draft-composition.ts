import { Platform } from 'obsidian';

type DraftControl = HTMLInputElement | HTMLTextAreaElement;

/**
 * Android keyboards such as Gboard keep the word being typed as composition text, so on Android that text is the
 * user's input and is saved like ordinary input. Desktop and iOS compose CJK candidates (pinyin, kana, Hangul),
 * which stay out of drafts until confirmed.
 */
export function tracksComposition(): boolean {
  return !Platform.isAndroidApp;
}

/** Defers a composition's verdict to a later task. Tests replace it to settle synchronously or in a chosen order. */
export const compositionTiming = {
  later(callback: () => void): void { window.setTimeout(callback, 0); }
};

/**
 * Tracks one IME composition so that text which was never confirmed stays out of the shared draft.
 *
 * A composition is unconfirmed when Escape ended it, or when focus had left the control by the time it settles:
 * clicking elsewhere, closing the view, or switching to another window or app. Chromium ends composition before it
 * dispatches the blur for those focus changes, so the verdict waits for the next task. Every other ending is kept,
 * including commit keys that leave the text unchanged, such as Shift, Enter, a Korean syllable boundary or an IME
 * toggle like Ctrl+Space.
 */
export class DraftComposition {
  private readonly value: string;
  private readonly start: number;
  private readonly end: number;
  private readonly direction: DraftControl['selectionDirection'];
  private readonly scrollTop: number;
  private escaped = false;
  private blurred = false;
  private readonly onBlur = () => { this.blurred = true; };
  private readonly onFocus = () => { this.blurred = false; };

  constructor(readonly control: DraftControl) {
    this.value = control.value;
    this.start = control.selectionStart ?? 0;
    this.end = control.selectionEnd ?? this.start;
    this.direction = control.selectionDirection;
    this.scrollTop = control.scrollTop;
    control.addEventListener('blur', this.onBlur);
    control.addEventListener('focus', this.onFocus);
  }

  keyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' || event.code === 'Escape') {
      this.escaped = true;
      // Let the IME handle Escape without letting a workspace shortcut move focus.
      event.stopPropagation();
    } else {
      // Typing on after Escape continues the same composition: a Japanese IME only reverts the conversion.
      this.escaped = false;
    }
  }

  /** Calls `done` once focus changes from the same action have been dispatched. */
  settle(done: (confirmed: boolean) => void): void {
    compositionTiming.later(() => done(!this.escaped && !this.blurred && this.control.isConnected));
  }

  /** Puts back the text and selection from before the composition. */
  restore(): void {
    if (this.control.value !== this.value) this.control.value = this.value;
    this.control.setSelectionRange(this.start, this.end, this.direction ?? undefined);
    this.control.scrollTop = this.scrollTop;
  }

  restoreIfEscaped(): boolean {
    if (!this.escaped) return false;
    this.restore();
    return true;
  }

  dispose(): void {
    this.control.removeEventListener('blur', this.onBlur);
    this.control.removeEventListener('focus', this.onFocus);
  }
}
