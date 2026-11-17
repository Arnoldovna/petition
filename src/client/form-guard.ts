// Double-submit guard for every `form[data-guard]` (ADR 0010 item 1, F-75, B-49). Loaded on every page as a module
// (deferred, CSP `script-src 'self'`). Progressive enhancement only: without JavaScript every form still posts, and
// the server handlers stay idempotent on their own (B-49); this script only spares the second request of a double
// click or a repeated Enter.
//
// - The first submission always goes through. The submitter is locked only after the `submit` event has been
//   dispatched (a zero-delay task), so the browser has built the form data set with the submitter, and only when no
//   other listener cancelled the submission (the signature pad blocks a blank pad with `preventDefault`, F-41).
// - While a form is locked, every further submission of it is cancelled, including implicit submission with Enter
//   and `requestSubmit()`.
// - The submitter gets `aria-busy="true"` and `disabled` (F-75).
// - Unlock: on `pageshow` with `persisted` (the page came back from the back/forward cache, where the locked state
//   would otherwise survive), and after RELEASE_AFTER_MS as a fallback for a navigation that never replaces the page
//   (the visitor pressed stop, or the network failed), so a form can never stay unusable.

const GUARDED_FORM = 'form[data-guard]';
const SUBMIT_CONTROL = 'button[type="submit"], button:not([type]), input[type="submit"]';
/** Far longer than any regular response (argon2id hashing included), short enough to retry after a stopped load. */
const RELEASE_AFTER_MS = 15_000;

type SubmitControl = HTMLButtonElement | HTMLInputElement;

interface SubmitLock {
  control: SubmitControl | null;
  /** Whether the control had focus when it was disabled; disabling moves focus to the body. */
  hadFocus: boolean;
  timer: number;
}

const locks = new Map<HTMLFormElement, SubmitLock>();
/** Forms whose submit event is still being dispatched: a repeat in that window is cancelled too. */
const pending = new WeakSet<HTMLFormElement>();

function isSubmitControl(element: unknown): element is SubmitControl {
  return element instanceof HTMLButtonElement || element instanceof HTMLInputElement;
}

/** The control that submitted the form; a `requestSubmit()` without a submitter falls back to the default button. */
function submitControlOf(form: HTMLFormElement, submitter: HTMLElement | null): SubmitControl | null {
  if (isSubmitControl(submitter)) return submitter;
  const fallback = form.querySelector(SUBMIT_CONTROL);
  return isSubmitControl(fallback) ? fallback : null;
}

function release(form: HTMLFormElement): void {
  const lock = locks.get(form);
  if (lock === undefined) return;
  locks.delete(form);
  window.clearTimeout(lock.timer);
  const { control, hadFocus } = lock;
  if (control === null) return;
  control.disabled = false;
  control.removeAttribute('aria-busy');
  // Give a keyboard user their place back, but never steal focus that has moved on meanwhile.
  if (hadFocus && (document.activeElement === null || document.activeElement === document.body)) control.focus();
}

function lock(form: HTMLFormElement, submitter: HTMLElement | null): void {
  if (locks.has(form) || !form.isConnected) return;
  const control = submitControlOf(form, submitter);
  const hadFocus = control !== null && document.activeElement === control;
  const timer = window.setTimeout(() => {
    release(form);
  }, RELEASE_AFTER_MS);
  locks.set(form, { control, hadFocus, timer });
  if (control === null) return;
  control.setAttribute('aria-busy', 'true');
  control.disabled = true;
}

function onSubmit(event: SubmitEvent): void {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.matches(GUARDED_FORM)) return;
  if (locks.has(form) || pending.has(form)) {
    // A second submission while the first request is on its way (double click, Enter again).
    event.preventDefault();
    return;
  }
  pending.add(form);
  const { submitter } = event;
  window.setTimeout(() => {
    pending.delete(form);
    // Dispatch has finished: every submit listener has run, wherever and whenever it was registered.
    if (!event.defaultPrevented) lock(form, submitter);
  }, 0);
}

function onPageShow(event: PageTransitionEvent): void {
  if (!event.persisted) return;
  for (const form of [...locks.keys()]) release(form);
}

document.addEventListener('submit', onSubmit);
window.addEventListener('pageshow', onPageShow);

// A module, not a script: the declarations above stay local instead of merging with DOM globals (such as `Lock`).
export {};
