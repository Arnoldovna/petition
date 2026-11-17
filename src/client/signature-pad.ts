/**
 * Signature pad for `/signature` (ADR 0010, F-38 to F-41, F-45, B-36 to B-39). Progressive enhancement: the drawing
 * form `form[data-signature-pad]` is `hidden` in the server markup and only shown here, after everything it needs
 * exists. Without JavaScript, or without a 2D canvas, the page offers the typed-name form alone (F-45, F-76).
 *
 * - Pointer Events for mouse, touch and pen, `touch-action: none` in CSS, pointer capture on `pointerdown`, so a stroke
 *   that leaves the pad keeps drawing and ends on `pointerup`, `pointercancel` or `lostpointercapture` (F-38, B-36,
 *   B-37).
 * - Coordinates from `getBoundingClientRect()` (coalesced events when the browser has them), normalised to 0..1;
 *   backing store = CSS size x `devicePixelRatio`, recomputed by a `ResizeObserver`, which replays the strokes once
 *   (F-39, B-38). During drawing only the newest segment is drawn (B-39).
 * - Export: the strokes are replayed onto an offscreen canvas of exactly `data-export-width` x `data-export-height`
 *   and written to the hidden `signature` input on every stroke end and again on submit (B-36, ADR 0004).
 * - "clear" empties strokes, canvas, input and message (F-40). An empty pad blocks the submit with "Please sign
 *   before submitting" in the form's alert and focuses it (F-41); the server checks again.
 *
 * The geometry and the stroke state are in `signature-pad.core.ts`.
 */
import {
  backingStoreSize,
  BLANK_MESSAGE,
  createStrokeRecorder,
  drawDot,
  drawSegment,
  EXPORT_INK,
  isBlank,
  lineWidthFor,
  normalisePoint,
  parseDimension,
  replay,
  type Point,
  type Surface,
} from './signature-pad.core.ts';

/** Everything the pad needs from the server markup (partial `signature-pad.hbs`). */
interface PadElements {
  form: HTMLFormElement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  input: HTMLInputElement;
  message: HTMLElement;
  clearButton: HTMLButtonElement;
  /** The offscreen export canvas of exactly `exportSize`, created once for the page's lifetime (see findElements). */
  exportCanvas: HTMLCanvasElement;
  exportContext: CanvasRenderingContext2D;
  exportSize: Surface;
}

/**
 * Finds the pad's parts and creates the export canvas; undefined when anything is missing, so a changed template or a
 * browser without 2D canvases leaves the typed form working (F-45).
 */
function findElements(form: HTMLFormElement): PadElements | undefined {
  const canvas = form.querySelector('canvas');
  const input = form.elements.namedItem('signature');
  const message = form.querySelector<HTMLElement>('[role="alert"]');
  // The only type="button" in the form is "clear" (the button partial takes no extra attributes).
  const clearButton = form.querySelector<HTMLButtonElement>('button[type="button"]');
  if (canvas === null || !(input instanceof HTMLInputElement) || message === null || clearButton === null) {
    return undefined;
  }
  const width = parseDimension(canvas.dataset['exportWidth']);
  const height = parseDimension(canvas.dataset['exportHeight']);
  const context = canvas.getContext('2d');
  if (width === undefined || height === undefined || context === null) return undefined;
  // One export canvas, reused for every export. A new canvas per stroke end could hit WebKit's canvas memory cap, after
  // which getContext() returns null and the hidden input would keep an older drawing than the one on screen (B-36).
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = width;
  exportCanvas.height = height;
  const exportContext = exportCanvas.getContext('2d');
  if (exportContext === null) return undefined;
  return {
    form,
    canvas,
    context,
    input,
    message,
    clearButton,
    exportCanvas,
    exportContext,
    exportSize: { width, height },
  };
}

/** Round caps and joins plus the ink colour; must be set again after every resize (it resets the context). */
function applyPen(context: CanvasRenderingContext2D, ink: string, surface: Surface): void {
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = ink;
  context.fillStyle = ink;
  context.lineWidth = lineWidthFor(surface);
}

/** The ink of the visible pad follows the canvas' CSS `color` (a token), with the export ink as fallback. */
function screenInk(canvas: HTMLCanvasElement): string {
  const { color } = getComputedStyle(canvas);
  return color === '' ? EXPORT_INK : color;
}

/** Replaces the alert's text with `text` (and the visually hidden "Error: " prefix the server renders too). */
function showMessage(message: HTMLElement, text: string): void {
  if (text === '') {
    message.replaceChildren();
    return;
  }
  const prefix = document.createElement('span');
  prefix.className = 'visually-hidden';
  prefix.textContent = 'Error: ';
  message.replaceChildren(prefix, document.createTextNode(text));
}

/** The pointer positions of one move: the coalesced ones in between frames when the browser reports them. */
function movePositions(event: PointerEvent): readonly PointerEvent[] {
  const coalesced = 'getCoalescedEvents' in event ? event.getCoalescedEvents() : [];
  return coalesced.length > 0 ? coalesced : [event];
}

function enhance(elements: PadElements): void {
  const { form, canvas, context, input, message, clearButton, exportCanvas, exportContext, exportSize } = elements;
  const recorder = createStrokeRecorder();
  let surface: Surface = { width: canvas.width, height: canvas.height };

  const pointOf = (event: PointerEvent, rect: DOMRect): Point => normalisePoint(event.clientX, event.clientY, rect);

  const serialise = (): void => {
    if (recorder.strokes.length === 0) {
      input.value = '';
      return;
    }
    exportContext.clearRect(0, 0, exportSize.width, exportSize.height);
    replay(exportContext, recorder.strokes, exportSize);
    input.value = exportCanvas.toDataURL('image/png');
  };

  const resize = (): void => {
    const { width, height } = canvas.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const next = backingStoreSize(width, height, window.devicePixelRatio);
    if (next.width === canvas.width && next.height === canvas.height) return;
    // Setting the size clears the canvas and resets the context, so the pen is set again and the strokes replayed.
    canvas.width = next.width;
    canvas.height = next.height;
    surface = next;
    applyPen(context, screenInk(canvas), surface);
    replay(context, recorder.strokes, surface);
  };

  const endStroke = (event: PointerEvent): void => {
    if (recorder.end(event.pointerId)) serialise();
  };

  canvas.addEventListener('pointerdown', (event) => {
    // Primary button only (left mouse button, touch contact, pen tip); a second finger is ignored by the recorder.
    if (event.button !== 0) return;
    const point = pointOf(event, canvas.getBoundingClientRect());
    if (!recorder.begin(event.pointerId, point)) return;
    // No text selection, no emulated mouse events.
    event.preventDefault();
    if (message.childNodes.length > 0) showMessage(message, '');
    drawDot(context, point, surface);
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // No capture (the pointer is no longer active): its release may never reach the canvas, and a stroke left open
      // would make the recorder ignore every later pointer as a second finger. So this press ends here, as a tap.
      endStroke(event);
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!recorder.drawing) return;
    const rect = canvas.getBoundingClientRect();
    const segment = recorder.extend(
      event.pointerId,
      movePositions(event).map((position) => pointOf(position, rect)),
    );
    drawSegment(context, segment, surface);
  });

  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('lostpointercapture', endStroke);

  clearButton.addEventListener('click', () => {
    recorder.clear();
    context.clearRect(0, 0, canvas.width, canvas.height);
    input.value = '';
    showMessage(message, '');
  });

  form.addEventListener('submit', (event) => {
    serialise();
    if (!isBlank(recorder.strokes, exportSize)) return;
    event.preventDefault();
    showMessage(message, BLANK_MESSAGE);
    message.focus();
  });

  new ResizeObserver(resize).observe(canvas);
  // A zoom or a move to another screen changes the pixel ratio, not always the CSS size.
  window.addEventListener('resize', resize);

  // A value restored by the browser's form state must not outlive the strokes it came from.
  input.value = '';
  form.hidden = false;
  // The export canvas never changes size, so its pen is set once; replay() sets the line width on every export.
  applyPen(exportContext, EXPORT_INK, exportSize);
  // The pen for the server-rendered size; resize() sets it again whenever the backing store changes.
  applyPen(context, screenInk(canvas), surface);
  resize();
}

const form = document.querySelector<HTMLFormElement>('form[data-signature-pad]');
const elements = form === null ? undefined : findElements(form);
if (elements !== undefined) enhance(elements);
