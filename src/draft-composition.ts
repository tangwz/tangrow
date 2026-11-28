import { Platform } from 'obsidian';

type DraftControl = HTMLInputElement | HTMLTextAreaElement;
const focusChangeGraceMs = 50;
// Chromium ends composition on the confirmation keydown, and a normal press is released well after the focus-change
// grace period. Wait this long at most for the release, unless focus moves first.
const keyReleaseGraceMs = 1000;
const finalScript = /^[\p{scx=Hangul}\p{scx=Hiragana}\p{scx=Katakana}]+$/u;
// Keys that commit a candidate: commit keys, candidate numbers on either keyboard, and punctuation that commits the
// candidate before inserting its mark. Each is matched by `code`, or by `key` when no code is reported.
const confirmationKeys = new RegExp('^(Enter|NumpadEnter|Space| |Shift(Left|Right)?|Digit[0-9]|Numpad[0-9]|Comma|Period|' +
  'Semicolon|Quote|Slash|Backslash|BracketLeft|BracketRight|Minus|Equal|Backquote|[0-9,.;\'/\\\\[\\]=`-])$');
// Only a quick return can still see the candidate window left over from the cancelled composition.
const recomposeHintWindowMs = 60_000;
export const recomposeHint = 'Composition ended when focus moved. Start composing again to choose a candidate with the keyboard.';

/**
 * Android keyboards such as Gboard keep the word being typed as composition text, so on Android that text is the
 * user's input and is saved like ordinary input. Desktop and iOS compose CJK candidates (pinyin, kana, Hangul),
 * which stay out of drafts until confirmed.
 */
export function tracksComposition(): boolean {
  return !Platform.isAndroidApp;
}

/** Defers a composition's verdict. Tests can replace it to settle synchronously. */
export const compositionTiming = {
  later(callback: () => void, owner: Window, delay = focusChangeGraceMs): void { owner.setTimeout(callback, delay); }
};

/**
 * Tracks one IME composition so that text which was never confirmed stays out of the shared draft.
 *
 * Chromium can end composition and run a zero-delay timer before dispatching the pointer press or blur that caused
 * it. Keep the draft pending briefly so focus loss can cancel the preedit, unless it is Hangul or kana. Escape also
 * cancels. Other endings are kept, including commit keys that leave the text unchanged, such as Shift, Enter or an IME
 * toggle like Ctrl+Space.
 */
export class DraftComposition {
  private readonly value: string;
  private readonly start: number;
  private readonly end: number;
  private readonly direction: DraftControl['selectionDirection'];
  private readonly scrollTop: number;
  private readonly pointerDocument?: Document;
  private escaped = false;
  private focusState: 'uninterrupted' | 'blurred' | 'refocused' = 'uninterrupted';
  private confirmationKey?: string;
  private explicitCommit = false;
  private onSettled?: (confirmed: boolean) => void;
  private awaitingRelease = false;
  private outsidePointer?: { id: number; at: number };
  private readonly onPointerDown = (event: PointerEvent) => {
    this.outsidePointer = event.composedPath().includes(this.control)
      ? undefined : { id: event.pointerId, at: event.timeStamp };
  };
  private readonly onPointerUp = (event: PointerEvent) => {
    // WebKit can change focus when a touch ends, well after pointerdown.
    const outside = this.outsidePointer;
    if (outside && outside.id === event.pointerId) outside.at = event.timeStamp;
  };
  private readonly onBlur = () => {
    this.focusState = 'blurred';
    this.confirmationKey = undefined;
    this.explicitCommit = false;
    // Nothing can confirm the composition after this, so do not hold the draft for the rest of the wait.
    if (this.awaitingRelease) this.flush();
  };
  private readonly onFocus = (event: Event) => {
    // A return outside the pointer gesture can still confirm the current composition.
    if (this.outsidePointer && event.timeStamp - this.outsidePointer.at > focusChangeGraceMs) {
      this.outsidePointer = undefined;
    }
    // Returning after compositionend cannot revive a candidate dismissed by focus loss.
    if (this.focusState === 'blurred' && !this.onSettled) this.focusState = 'refocused';
  };
  private readonly onKeyUp = (event: Event) => {
    const key = event as KeyboardEvent;
    if (!this.confirmationKey || (key.code || key.key) !== this.confirmationKey) return;
    this.confirmationKey = undefined;
    if (key.isComposing) return;
    if (this.focusState === 'refocused') this.explicitCommit = true;
    this.flush();
  };
  private readonly onInput = (event: Event) => {
    // WebKit can report a focus-loss commit as insertFromComposition, even after an outside tap briefly refocuses the field.
    // Only a candidate picked after intentionally returning counts as explicit. Otherwise the grace period decides.
    if ((event as InputEvent).inputType !== 'insertFromComposition' || this.focusState !== 'refocused' ||
        this.outsidePointer) return;
    this.explicitCommit = true;
    this.flush();
  };
  private readonly onBeforeInput = (event: Event) => {
    const input = event as InputEvent;
    if (input.isComposing || input.inputType?.includes('Composition')) return;
    // A punctuation key that commits the candidate inserts its mark before the key is released.
    if (this.confirmationKey && this.focusState === 'refocused') this.explicitCommit = true;
    this.flush();
  };

  constructor(readonly control: DraftControl) {
    this.value = control.value;
    this.start = control.selectionStart ?? 0;
    this.end = control.selectionEnd ?? this.start;
    this.direction = control.selectionDirection;
    this.scrollTop = control.scrollTop;
    control.addEventListener('blur', this.onBlur);
    control.addEventListener('focus', this.onFocus);
    control.addEventListener('beforeinput', this.onBeforeInput);
    control.addEventListener('keyup', this.onKeyUp);
    control.addEventListener('input', this.onInput);
    if (Platform.isIosApp) {
      this.pointerDocument = control.ownerDocument;
      this.pointerDocument.addEventListener('pointerdown', this.onPointerDown, true);
      this.pointerDocument.addEventListener('pointerup', this.onPointerUp, true);
    }
  }

  keyDown(event: KeyboardEvent): void {
    if (this.onSettled) {
      if (!event.isComposing && event.key === 'Tab') this.flush();
      return;
    }
    const key = event.code || event.key;
    this.confirmationKey = this.focusState !== 'blurred' && event.isComposing && !event.metaKey && !event.altKey &&
      (!event.ctrlKey || key === 'Space' || key === ' ') &&
      confirmationKeys.test(key) ? key : undefined;
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
    this.onSettled = done;
    if (this.explicitCommit) { this.flush(); return; }
    // After a return, only the release of the confirmation key can confirm the candidate it picked.
    this.awaitingRelease = this.focusState === 'refocused' && this.confirmationKey !== undefined;
    compositionTiming.later(() => this.flush(), this.control.ownerDocument.defaultView ?? window,
      this.awaitingRelease ? keyReleaseGraceMs : focusChangeGraceMs);
  }

  /** Settles a finished composition before the control is changed by a new edit. */
  flush(): boolean | undefined {
    const done = this.onSettled;
    if (!done) return undefined;
    this.onSettled = undefined;
    this.awaitingRelease = false;
    const confirmed = !this.escaped && this.control.isConnected &&
      (this.focusState === 'uninterrupted' || this.explicitCommit || this.composedInFinalScript());
    done(confirmed);
    return confirmed;
  }

  /**
   * Hangul and kana compositions are already the words being typed, and native apps commit them when focus moves.
   * Pinyin, romaji and shape codes stay in another script until a candidate is chosen, so focus loss still drops them.
   */
  private composedInFinalScript(): boolean {
    const value = this.control.value;
    const before = this.value.slice(0, this.start);
    const after = this.value.slice(this.end);
    if (value.length < before.length + after.length || !value.startsWith(before) || !value.endsWith(after)) return false;
    return finalScript.test(value.slice(before.length, value.length - after.length));
  }

  /** Puts back the text and selection from before the composition. */
  restore(onRefocus?: () => void): void {
    const discardedText = this.control.value !== this.value;
    if (discardedText) this.control.value = this.value;
    this.control.setSelectionRange(this.start, this.end, this.direction ?? undefined);
    this.control.scrollTop = this.scrollTop;
    if (!onRefocus || !Platform.isDesktopApp || !Platform.isMacOS || !discardedText || this.escaped ||
        this.focusState === 'uninterrupted' || !this.control.isConnected || this.control.readOnly) return;
    // Apple Pinyin can leave its candidate window visible after the field has reverted to ordinary typing.
    const doc = this.control.ownerDocument;
    if (doc.activeElement === this.control && doc.hasFocus()) onRefocus();
    else {
      const until = Date.now() + recomposeHintWindowMs;
      this.control.addEventListener('focus', () => { if (Date.now() <= until) onRefocus(); }, { once: true });
    }
  }

  /**
   * After this composition was cancelled, an IME can still end it and put its text back. That text was never
   * confirmed, so the control returns to `saved`, the draft as it is now, with this composition's selection when nothing
   * else has changed the draft since.
   */
  revertLateEnd(saved: string): void {
    const control = this.control;
    if (control.value === saved) return;
    if (saved === this.value) { this.restore(); return; }
    const focused = control.ownerDocument.activeElement === control;
    const start = control.selectionStart ?? saved.length;
    const end = control.selectionEnd ?? start;
    control.value = saved;
    if (focused) control.setSelectionRange(Math.min(start, saved.length), Math.min(end, saved.length));
  }

  restoreIfEscaped(): boolean {
    if (!this.escaped) return false;
    this.restore();
    return true;
  }

  dispose(): void {
    this.onSettled = undefined;
    this.awaitingRelease = false;
    this.control.removeEventListener('blur', this.onBlur);
    this.control.removeEventListener('focus', this.onFocus);
    this.control.removeEventListener('beforeinput', this.onBeforeInput);
    this.control.removeEventListener('keyup', this.onKeyUp);
    this.control.removeEventListener('input', this.onInput);
    this.pointerDocument?.removeEventListener('pointerdown', this.onPointerDown, true);
    this.pointerDocument?.removeEventListener('pointerup', this.onPointerUp, true);
  }
}
