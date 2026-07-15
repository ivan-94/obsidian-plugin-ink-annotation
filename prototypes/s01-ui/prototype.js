const variants = {
  A: {
    name: 'Context first',
    description: '选择附近完成高频动作；复杂编辑进入 inspector 或侧栏。',
  },
  B: {
    name: 'Stable bottom surfaces',
    description: '以稳定 bottom action bar / sheet 避开原生选择菜单和键盘。',
  },
  C: {
    name: 'Workspace rail',
    description: '动作和管理集中在 rail，用来检验上下文距离与信息密度。',
  },
};

const initialState = () => ({
  mode: 'Reading',
  platform: 'desktop',
  viewport: 'wide',
  collision: 'center',
  scenario: 'normal',
  pendingSelection: false,
  annotationCount: 3,
  mark: null,
  toolbarContainer: null,
  composerOpen: false,
  draftPersisted: false,
  draftBody: '',
  saveStatus: 'Saved locally',
  inspectorOpen: false,
  overlapChoice: null,
  sidebarOpen: true,
  scope: 'current',
  bulkMode: false,
  inkPaletteOpen: false,
  inkStrokeCount: 2,
  inkTool: 'Pen',
  inkSaved: true,
  keyboardVisible: false,
  moreOpen: false,
  repairStep: null,
  focusReturn: 'document',
});

let state = initialState();
let variant = new URLSearchParams(location.search).get('variant')?.toUpperCase() ?? 'A';
if (!variants[variant]) variant = 'A';
let autosaveTimer;

const app = document.querySelector('#app');
const stateOutput = document.querySelector('#state-output');
const liveRegion = document.querySelector('#live-region');

function escapeHtml(value) {
  return String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character],
  );
}

function announce(message) {
  liveRegion.textContent = message;
}
function focusAfterRender(selector) {
  requestAnimationFrame(() => document.querySelector(selector)?.focus());
}
function setState(patch, message) {
  state = { ...state, ...patch };
  if (message) announce(message);
  render();
}

function chooseToolbarContainer() {
  if (state.toolbarContainer) return state.toolbarContainer;
  if (variant === 'B') return 'bottom';
  if (variant === 'C') return 'rail';
  if (state.platform === 'ipad' && ['bottom', 'left', 'right'].includes(state.collision))
    return 'bottom';
  return 'anchored';
}

function selectText() {
  if (state.scenario === 'unsupported') {
    setState(
      { mode: 'TextSelected', pendingSelection: true, toolbarContainer: chooseToolbarContainer() },
      'Unsupported generated Dataview content. No annotation was created.',
    );
    return;
  }
  setState(
    {
      mode: 'TextSelected',
      pendingSelection: true,
      toolbarContainer: chooseToolbarContainer(),
      focusReturn: 'selected-text',
      sidebarOpen: state.platform === 'ipad' || variant === 'B' ? false : state.sidebarOpen,
    },
    'Text selected. Choose an action to create an annotation.',
  );
}

function commitMark(mark) {
  setState(
    {
      mode: 'Annotated',
      pendingSelection: false,
      toolbarContainer: null,
      annotationCount: state.annotationCount + 1,
      mark,
      saveStatus: 'Saved locally',
    },
    `${mark} saved locally.`,
  );
}

function openComposer() {
  setState(
    {
      mode: 'Composing',
      pendingSelection: false,
      toolbarContainer: null,
      composerOpen: true,
      draftPersisted: true,
      mark: 'Note only',
      saveStatus: 'Saved locally',
      focusReturn: 'selected-text',
      sidebarOpen: state.platform === 'ipad' || variant === 'B' ? false : state.sidebarOpen,
    },
    'Draft anchor saved locally. Note composer opened.',
  );
  requestAnimationFrame(() => document.querySelector('#note-body')?.focus());
}

function closeComposer() {
  const keep = state.draftBody.trim().length > 0;
  setState(
    {
      mode: keep ? 'Annotated' : 'Reading',
      composerOpen: false,
      draftPersisted: keep,
      annotationCount: keep ? state.annotationCount + 1 : state.annotationCount,
      saveStatus: 'Saved locally',
    },
    keep ? 'Note saved locally.' : 'Empty draft removed.',
  );
  focusAfterRender('.selectable-text');
}

function closeInspector() {
  const focusTarget = state.focusReturn;
  setState(
    { mode: 'Reading', inspectorOpen: false, overlapChoice: null },
    `Focus returned to ${focusTarget}.`,
  );
  focusAfterRender(focusTarget === 'sidebar-row' ? '.annotation-row.active' : '.overlap-mark');
}

function enterInk() {
  setState(
    {
      mode: 'InkMode',
      pendingSelection: false,
      toolbarContainer: null,
      inkPaletteOpen: true,
      inkSaved: true,
      focusReturn: 'ink-switch',
      sidebarOpen: state.platform === 'ipad' || variant === 'B' ? false : state.sidebarOpen,
    },
    'Ink Mode active. Mouse or Pencil draws; finger or wheel scrolls. Escape exits.',
  );
}

function exitInk() {
  setState({ mode: 'Saving', saveStatus: 'Saving…', inkSaved: false }, 'Saving Ink locally.');
  window.setTimeout(() => {
    if (state.scenario === 'ink-save-error') {
      setState(
        {
          mode: 'InkMode',
          inkPaletteOpen: true,
          inkSaved: false,
          saveStatus: 'Save failed — Retry',
        },
        'Ink save failed. Strokes remain recoverable.',
      );
    } else {
      setState(
        { mode: 'Reading', inkPaletteOpen: false, inkSaved: true, saveStatus: 'Saved locally' },
        'Ink saved locally. Fixed layout retained.',
      );
      focusAfterRender('.ink-switch');
    }
  }, 350);
}

function renderToolbar() {
  if (state.mode !== 'TextSelected') return '';
  if (state.scenario === 'unsupported')
    return `<div class="unsupported" role="status"><strong>Cannot annotate this selection</strong><span>Generated Dataview content has no stable Markdown source.</span><button data-action="dismiss-selection">Dismiss</button></div>`;
  const presets = ['Sun', 'Mint', 'Sky', 'Rose', 'Violet'];
  return `<div class="quick-toolbar ${chooseToolbarContainer()} collision-${state.collision}" role="toolbar" aria-label="Quick annotation toolbar" data-roving>
    ${presets.map((name, index) => `<button class="color preset-${index + 1}" data-action="highlight" data-value="Highlight · ${name}" aria-label="Highlight with ${name} preset" title="Highlight · ${name}" tabindex="${index === 0 ? 0 : -1}"><span>${name}</span></button>`).join('')}
    <button data-action="underline" aria-label="Underline with recent preset" title="Underline" tabindex="-1">U̲ <span>Underline</span></button>
    <button data-action="add-note" aria-label="Add note" title="Add note" tabindex="-1">＋ <span>Add note</span></button>
    <button data-action="more" aria-label="More annotation actions" title="More" tabindex="-1">••• <span>More</span></button>
  </div>${state.moreOpen ? `<div class="more-menu" role="menu"><button>Tag</button><button>Copy quote</button><button>Copy annotation link</button><button>Export</button></div>` : ''}`;
}

function renderComposer() {
  if (!state.composerOpen) return '';
  return `<section class="composer ${state.platform === 'ipad' || variant === 'B' ? 'bottom-sheet' : 'anchored-composer'}" role="dialog" aria-label="Note composer">
    <header><div><span class="eyebrow">Draft anchor saved</span><blockquote>“Mutable Markdown needs resilient anchors…”</blockquote></div><button data-action="close-composer" aria-label="Close note composer">×</button></header>
    <textarea id="note-body" placeholder="Add a Markdown note…">${escapeHtml(state.draftBody)}</textarea>
    <fieldset class="mark-combination"><legend>Mark presentation</legend>
      ${['Note only', 'Highlight + note', 'Underline + note'].map((mark) => `<button type="button" data-action="draft-mark" data-value="${mark}" aria-pressed="${state.mark === mark}">${mark}</button>`).join('')}
    </fieldset>
    <footer><span class="save-status">${escapeHtml(state.saveStatus)}</span><button data-action="background">Simulate background</button><button data-action="close-composer">Done</button></footer>
  </section>`;
}

function renderInspector() {
  if (!state.inspectorOpen) return '';
  if (!state.overlapChoice) {
    return `<section class="inspector" role="dialog" aria-label="Choose overlapping annotation"><header><strong>2 annotations here</strong><button data-action="close-inspector">×</button></header>
      <button class="record-choice" data-action="choose-record" data-value="highlight"><span class="type-mark fill"></span><span><strong>Highlight · Sky</strong><small>“resilient anchors…” · Has note</small></span></button>
      <button class="record-choice" data-action="choose-record" data-value="underline"><span class="type-mark line"></span><span><strong>Underline · Rose</strong><small>“anchors across edits” · #research</small></span></button>
    </section>`;
  }
  return `<section class="inspector" role="dialog" aria-label="Annotation inspector"><header><strong>${state.overlapChoice} annotation</strong><button data-action="close-inspector">×</button></header><label>Mark <select id="inspector-mark">${['Highlight', 'Underline', 'Note only'].map((mark) => `<option value="${mark}" ${state.mark === mark ? 'selected' : ''}>${mark}</option>`).join('')}</select></label><label>Note <textarea>Existing Markdown note.</textarea></label><div class="tag-row"><span>#research</span><button>＋ Tag</button></div><footer><button>Copy</button><button>Export</button><button class="danger">Delete · Undo available</button></footer></section>`;
}

function problemRows() {
  if (!['unanchored', 'needs-rebase', 'conflict'].includes(state.scenario)) return '';
  const status = state.scenario;
  const labels = {
    unanchored: 'Unanchored',
    'needs-rebase': 'Needs rebase',
    conflict: 'iCloud conflict',
  };
  return `<section class="problem-group"><h4>Problems · 1</h4><button class="annotation-row problem" data-action="repair" data-value="${status}"><span class="status-icon">!</span><span><strong>${labels[status]}</strong><small>Architecture decisions · “fixed logical layout…”</small></span></button></section>`;
}

function renderSidebar() {
  if (!state.sidebarOpen) return '';
  return `<aside class="annotation-sidebar ${variant === 'B' ? 'drawer' : ''}" aria-label="Annotations sidebar"><header><div><span class="eyebrow">Workspace</span><h3>Annotations</h3></div><button data-action="close-sidebar" aria-label="Close sidebar">×</button></header>
    <div class="scope-tabs" role="tablist"><button role="tab" aria-selected="${state.scope === 'current'}" data-action="scope" data-value="current">Current file</button><button role="tab" aria-selected="${state.scope === 'vault'}" data-action="scope" data-value="vault">Entire Vault</button></div>
    <input class="search" aria-label="Search annotations" placeholder="Search annotations…" />
    <div class="filter-row"><button>Tags</button><button>Type</button><button>Status</button><button>More</button></div>
    ${problemRows()}
    ${
      state.scenario === 'empty'
        ? `<section class="empty-state"><strong>No annotations in this file</strong><p>Select text in Reading View or enter Ink Mode to create one.</p></section>`
        : `<section><div class="group-heading"><h4>${state.scope === 'current' ? 'Architecture decisions' : '3 notes · grouped by note'}</h4><button data-action="bulk">${state.bulkMode ? 'Exit select' : 'Select'}</button></div>
      <button class="annotation-row active" data-action="open-inspector"><span class="type-mark fill"></span><span><strong>“resilient anchors…”</strong><small>Note preview · #research</small></span>${state.bulkMode ? '<input type="checkbox" aria-label="Select annotation" />' : ''}</button>
      <button class="annotation-row" data-action="open-inspector"><span class="type-mark line"></span><span><strong>“explicit Ink mode…”</strong><small>Underline · Saved locally</small></span>${state.bulkMode ? '<input type="checkbox" aria-label="Select annotation" />' : ''}</button>
      <button class="annotation-row ink-row"><span class="ink-thumb">〰</span><span><strong>Ink surface · 2 strokes</strong><small>Section 2 · fixed layout</small></span></button>
    </section>`
    }
  </aside>`;
}

function renderRepair() {
  if (!state.repairStep) return '';
  const steps = {
    choose:
      '<p>Choose replacement text from the rendered note.</p><button data-action="repair-preview">Use “stable source anchor”</button>',
    preview:
      '<p>Preview: old quote → <mark>stable source anchor</mark></p><button data-action="repair-confirm">Confirm reattach</button>',
    done: '<p class="success">Reattached. Original record ID preserved.</p><button data-action="repair-close">Close</button>',
  };
  return `<section class="repair-dialog" role="dialog" aria-label="Repair annotation"><header><strong>Repair target</strong><button data-action="repair-close">×</button></header><div class="old-context">Old context thumbnail · Architecture decisions</div>${steps[state.repairStep]}</section>`;
}

function renderInkPalette() {
  if (!state.inkPaletteOpen) return '';
  const tools = ['Pen', 'Highlighter', 'Stroke eraser', 'Color', 'Width', 'Undo', 'Redo', 'More'];
  return `<div class="ink-palette ${state.platform === 'ipad' || variant === 'B' ? 'horizontal' : 'vertical'}" role="toolbar" aria-label="Ink tools" data-roving><button class="exit" data-action="exit-ink" tabindex="0">Exit</button>${tools.map((tool) => `<button class="${state.inkTool === tool ? 'selected' : ''}" data-action="ink-tool" data-value="${tool}" tabindex="-1">${tool}</button>`).join('')}</div>`;
}

function statusBanner() {
  if (state.scenario === 'conflict')
    return '<div class="status-banner warning"><strong>iCloud conflict needs repair</strong><span>Both versions are preserved. Review in Problems.</span></div>';
  if (state.scenario === 'local-only')
    return '<div class="status-banner"><strong>Saved locally</strong><span>iCloud synchronization has not been confirmed.</span></div>';
  if (state.saveStatus.startsWith('Save failed'))
    return '<div class="status-banner error"><strong>Ink save failed</strong><span>Strokes are still in memory.</span><button data-action="exit-ink">Retry</button></div>';
  return '';
}

function renderDocument() {
  return `<section class="obsidian-shell">
    <header class="note-header"><div><span class="crumb">Vault / Research</span><h2>Mutable Markdown annotations</h2></div><div class="header-actions"><span class="local-status">${escapeHtml(state.saveStatus)}</span><button data-action="toggle-sidebar">Annotations</button><button class="ink-switch ${state.mode === 'InkMode' || state.mode === 'Saving' ? 'active' : ''}" data-action="toggle-ink">${state.mode === 'InkMode' || state.mode === 'Saving' ? 'Ink Mode · Exit' : '✎ Ink'}</button></div></header>
    ${statusBanner()}
    <div class="content-layout"><article class="markdown-reading ${state.inkStrokeCount > 0 ? 'fixed-layout' : ''} ${state.mode === 'InkMode' || state.mode === 'Saving' ? 'ink-active' : ''}" aria-label="Reading View">
      <h1>Resilient annotation anchors</h1><p class="lede">A low-fidelity document for testing selection, inspection, Ink, and recovery.</p>
      <h2>Architecture decisions</h2>
      <p><button class="selectable-text collision-target-${state.collision}" data-action="select-text">Mutable Markdown needs resilient anchors that survive ordinary edits. Select this sentence to annotate it.</button></p>
      <blockquote>Selection reveals intent; it never creates a record by itself.</blockquote>
      <p>Existing records can <button class="overlap-mark" data-action="overlap">overlap without letting visual z-order decide which record is edited</button>.</p>
      <h2>Fixed Ink layout</h2><p>The document remains in the same logical layout after leaving Ink Mode, so visible strokes do not jump.</p>
      <div class="fake-ink" aria-label="Two existing Ink strokes"><span></span><span></span></div>
      ${state.mode === 'InkMode' || state.mode === 'Saving' ? `<button class="ink-canvas" data-action="draw" aria-label="Transparent Ink input surface"><span>${state.inkStrokeCount} strokes · click to draw</span></button>` : ''}
      ${renderToolbar()}${renderComposer()}${renderInspector()}${renderRepair()}${renderInkPalette()}
    </article>${renderSidebar()}</div>
    ${state.keyboardVisible ? '<div class="software-keyboard" aria-label="Simulated software keyboard">Simulated iPad keyboard · safe-area respected</div>' : ''}
  </section>`;
}

function render() {
  document.body.dataset.variant = variant;
  document.body.dataset.platform = state.platform;
  document.body.dataset.keyboard = state.keyboardVisible ? 'visible' : 'hidden';
  const frame = document.querySelector('#device-frame');
  frame.dataset.viewport = state.viewport;
  app.innerHTML = renderDocument();
  stateOutput.textContent = JSON.stringify(
    {
      variant,
      ...state,
      toolbarContainer:
        state.mode === 'TextSelected' ? chooseToolbarContainer() : state.toolbarContainer,
    },
    null,
    2,
  );
  document.querySelector('#variant-label').textContent = `${variant} — ${variants[variant].name}`;
  document.querySelector('#variant-description').textContent = variants[variant].description;
  for (const id of ['platform', 'viewport', 'collision', 'scenario'])
    document.querySelector(`#${id}`).value = state[id];
  document.querySelector('#keyboard').checked = state.keyboardVisible;
}

function handleAction(action, value) {
  if (action === 'select-text') selectText();
  else if (action === 'dismiss-selection') {
    setState(
      { mode: 'Reading', pendingSelection: false, toolbarContainer: null },
      'Selection dismissed.',
    );
    focusAfterRender('.selectable-text');
  } else if (action === 'highlight') commitMark(value);
  else if (action === 'underline') commitMark('Underline · recent preset');
  else if (action === 'add-note') openComposer();
  else if (action === 'draft-mark') setState({ mark: value });
  else if (action === 'more') setState({ moreOpen: !state.moreOpen });
  else if (action === 'close-composer') closeComposer();
  else if (action === 'background')
    setState(
      { saveStatus: 'Saved locally' },
      'Draft flushed before backgrounding; restored on return.',
    );
  else if (action === 'overlap' || action === 'open-inspector')
    setState({
      mode: 'Inspecting',
      pendingSelection: false,
      toolbarContainer: null,
      inspectorOpen: true,
      overlapChoice: action === 'overlap' ? null : 'highlight',
      mark: action === 'open-inspector' ? 'Highlight' : state.mark,
      focusReturn: action === 'overlap' ? 'overlap-mark' : 'sidebar-row',
    });
  else if (action === 'choose-record')
    setState({ overlapChoice: value, mark: value === 'underline' ? 'Underline' : 'Highlight' });
  else if (action === 'close-inspector') closeInspector();
  else if (action === 'toggle-sidebar')
    setState({
      sidebarOpen: !state.sidebarOpen,
      mode: state.sidebarOpen ? 'Reading' : 'Managing',
      pendingSelection: false,
      toolbarContainer: null,
    });
  else if (action === 'close-sidebar') setState({ sidebarOpen: false, mode: 'Reading' });
  else if (action === 'scope')
    setState({
      scope: value,
      mode: 'Managing',
      pendingSelection: false,
      toolbarContainer: null,
    });
  else if (action === 'bulk')
    setState({
      bulkMode: !state.bulkMode,
      mode: 'Managing',
      pendingSelection: false,
      toolbarContainer: null,
    });
  else if (action === 'toggle-ink')
    state.mode === 'InkMode' || state.mode === 'Saving' ? exitInk() : enterInk();
  else if (action === 'exit-ink') exitInk();
  else if (action === 'ink-tool') setState({ inkTool: value });
  else if (action === 'draw')
    setState({
      inkStrokeCount: state.inkStrokeCount + 1,
      inkSaved: false,
      saveStatus: 'Unsaved Ink in memory',
    });
  else if (action === 'repair') setState({ repairStep: 'choose', mode: 'Managing' });
  else if (action === 'repair-preview') setState({ repairStep: 'preview' });
  else if (action === 'repair-confirm')
    setState({ repairStep: 'done' }, 'Repair preview confirmed.');
  else if (action === 'repair-close') setState({ repairStep: null });
}

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (target) handleAction(target.dataset.action, target.dataset.value);
});

app.addEventListener('input', (event) => {
  if (event.target.id !== 'note-body') return;
  state.draftBody = event.target.value;
  state.saveStatus = 'Saving…';
  stateOutput.textContent = JSON.stringify({ variant, ...state }, null, 2);
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(
    () => setState({ saveStatus: 'Saved locally' }, 'Note autosaved locally.'),
    500,
  );
});

app.addEventListener('change', (event) => {
  if (event.target.id === 'inspector-mark') setState({ mark: event.target.value });
});

document.addEventListener('keydown', (event) => {
  const editing = event.target.matches('input, textarea, select, [contenteditable]');
  const toolbar = event.target.closest('[data-roving]');
  if (!editing && !toolbar && ['ArrowLeft', 'ArrowRight'].includes(event.key))
    switchVariant(event.key === 'ArrowRight' ? 1 : -1);
  if (event.key === 'Escape') {
    if (state.moreOpen) setState({ moreOpen: false });
    else if (state.composerOpen) closeComposer();
    else if (state.inspectorOpen) closeInspector();
    else if (state.pendingSelection) {
      setState({ mode: 'Reading', pendingSelection: false, toolbarContainer: null });
      focusAfterRender('.selectable-text');
    } else if (state.mode === 'InkMode') exitInk();
  }
  if (toolbar && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    const buttons = [...toolbar.querySelectorAll('button:not([disabled])')];
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
    const next =
      buttons[(buttons.indexOf(event.target) + direction + buttons.length) % buttons.length];
    buttons.forEach((button) => {
      button.tabIndex = button === next ? 0 : -1;
    });
    next.focus();
  }
});

function switchVariant(delta) {
  const keys = Object.keys(variants);
  const next = keys[(keys.indexOf(variant) + delta + keys.length) % keys.length];
  variant = next;
  const url = new URL(location.href);
  url.searchParams.set('variant', variant);
  history.replaceState({}, '', url);
  render();
}

document.querySelector('#previous-variant').addEventListener('click', () => switchVariant(-1));
document.querySelector('#next-variant').addEventListener('click', () => switchVariant(1));
document.querySelector('#reset').addEventListener('click', () => {
  state = initialState();
  render();
});
for (const id of ['platform', 'viewport', 'collision', 'scenario'])
  document.querySelector(`#${id}`).addEventListener('change', (event) => {
    const patch = {
      [id]: event.target.value,
      toolbarContainer:
        (id === 'collision' || id === 'platform') && !state.pendingSelection
          ? null
          : state.toolbarContainer,
    };
    if (id === 'platform' && event.target.value === 'ipad') patch.sidebarOpen = false;
    setState(patch);
  });
document
  .querySelector('#keyboard')
  .addEventListener('change', (event) => setState({ keyboardVisible: event.target.checked }));

render();
