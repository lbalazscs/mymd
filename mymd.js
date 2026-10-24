/*
 * mymd.js: a client-side Markdown viewer. Pasted text or dropped .md files each get a tab of their own.
 *
 * Loading: index.html loads this file and the CDN libraries (marked, highlight.js, KaTeX, Toastify,
 * DOMPurify) all with `defer`, which runs them in document order once the DOM is parsed: libraries first,
 * this file last. So the element lookups below are safe, and the many `typeof X === 'undefined'` checks
 * exist only to survive a library failing to load (the app degrades instead of crashing), not to wait for one.
 *
 * State lives in the DOM, not in JS objects:
 *  - Tabs are `.tab` elements in #tab-list. Their DOM order IS the tab order; the "+" button is always last.
 *  - Panes are `.content-pane` elements in `.content-container`. A tab and its pane are linked by
 *    tab.dataset.paneId === pane.id. Pane order is irrelevant: only the `.active` pane is displayed.
 *  - At most one tab and one pane carry `.active`. A tab is "blank" (has no document yet) while its
 *    pane still contains the `.placeholder` element.
 *  - The only state outside the DOM: tabCounter, pendingSource, and the undo records that closeTabs()
 *    hands to its toast.
 *
 * Flow: paste or drop -> renderContent() -> blank tab (or a new one) -> pane = preview view + source view.
 *
 * Untrusted strings (document text, file names, tab names) reach the DOM only through DOMPurify,
 * textContent or escapeHtml(), never as raw innerHTML.
 */

// Only used for the paste hint shown in blank tabs; no key handling depends on it.
const isMac = navigator.userAgent.toLowerCase().includes('mac');
const pasteShortcut = isMac ? 'Cmd+V' : 'Ctrl+V';

const appContainer = document.querySelector('.app-container');
const tabList = document.getElementById('tab-list');
const contentContainer = document.querySelector('.content-container');
const newTabBtn = document.getElementById('new-tab-btn');

// Dropdown Menu Elements
const dropdownBtn = document.querySelector('.dropdown-btn');
const dropdownContent = document.querySelector('.dropdown-content');
const menuToggleSource = document.getElementById('menu-toggle-source');
const menuToggleSourceText = document.getElementById('menu-toggle-source-text');
const menuCloseOthers = document.getElementById('menu-close-others');
const menuCloseAll = document.getElementById('menu-close-all');

// Only ever incremented. It feeds the default tab names ("new N") and the tab/pane ids, which must stay
// unique even after tabs are closed, because a closed tab can come back through Undo.
let tabCounter = 0;

// Icons of the code-block copy button (see addCopyButtons). copyIcon takes the button's text color through
// currentColor; checkIcon is drawn in the theme's success color to confirm the copy.
const copyIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const checkIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

// --- Tab reordering by drag and drop ---
// Reordering happens live: while a tab is dragged, the dragover handler moves it in the DOM, so tabs need
// no drop handling of their own. Only tabs move; panes are found by id, so their DOM order doesn't matter.
// Dropping *files* onto the app is a separate feature, see the drop-target comments near the end of this file.
tabList.addEventListener('dragover', (e) => {
    const draggingTab = document.querySelector('.tab.dragging');
    if (!draggingTab) return; // If dragging a file instead of a tab, ignore this and let the file drop handler take over

    e.preventDefault(); // Allow the drop

    // Find all tabs except the one currently being dragged
    const draggableElements = [...tabList.querySelectorAll('.tab:not(.dragging)')];

    // Find the tab to insert the dragged tab in front of: among the tabs whose midpoint lies right of
    // the cursor (offset < 0), the nearest one. None means the cursor is past the last tab.
    const afterElement = draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = e.clientX - box.left - box.width / 2;
        if (offset < 0 && offset > closest.offset) {
            return {offset: offset, element: child};
        } else {
            return closest;
        }
    }, {offset: Number.NEGATIVE_INFINITY}).element;

    // Live-update the DOM position
    if (afterElement == null) {
        tabList.insertBefore(draggingTab, newTabBtn);
    } else {
        tabList.insertBefore(draggingTab, afterElement);
    }
});

tabList.addEventListener('dragstart', (e) => {
    const tab = tabOf(e.target);
    if (!tab) return;

    // Prevent dragging if the user is clicking the close button or typing a new name
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') {
        e.preventDefault();
        return;
    }
    // dragover can't read the transferred data, so this class is how it recognizes a tab drag
    tab.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox only starts a drag if some data is set. The value itself is never read.
    e.dataTransfer.setData('text/plain', tab.dataset.paneId);
});

tabList.addEventListener('dragend', (e) => {
    tabOf(e.target)?.classList.remove('dragging');
});

// --- Toasts ---
// All styling lives in mymd.css (.toast-* classes). The code here only builds the
// DOM and wires up the behavior.

// Drawn in currentColor, so the CSS rule for the variant decides the color
// Only 'error' has an icon; 'info' toasts are text only.
const TOAST_ICONS = {
    error: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`
};

// Shows a Toastify toast together with a progress bar (added to the toast's
// content node) that counts down to the toast's auto-close.
function showToastWithProgressBar(toast, container, duration) {
    toast.showToast(); // creates toast.toastElement and starts Toastify's timer
    // Toastify never auto-closes a toast with duration <= 0, so there would be nothing to count down
    if (!duration || duration <= 0) return;

    const track = document.createElement("div");
    track.className = "toast-progress-track";

    const bar = document.createElement("div");
    bar.className = "toast-progress-bar";

    track.appendChild(bar);
    container.appendChild(track);

    const countdown = bar.animate(
        [{transform: "scaleX(1)"}, {transform: "scaleX(0)"}],
        {duration, easing: "linear", fill: "forwards"}
    );

    // The bar mirrors Toastify's stopOnFocus behavior (see showToast), which runs on its own timer: hovering
    // stops that timer and leaving restarts it with the full duration (Toastify 1.12). Hence the bar pauses on
    // hover and restarts from full on leave. The two timers agree only because both use `duration`.
    const toastEl = toast.toastElement;
    toastEl.addEventListener('mouseover', () => {
        // Once the bar has run out, Toastify is already closing the toast
        if (countdown.playState === "finished") return;
        countdown.pause();
    });
    toastEl.addEventListener('mouseleave', () => {
        if (countdown.playState === "finished") return;
        countdown.currentTime = 0;
        countdown.play();
    });
}

/**
 * Shows a toast: a message, plus an icon for some variants and an optional button.
 *
 * @param {string} message
 * @param {object} [options]
 * @param {'info'|'error'} [options.variant='info']
 * @param {{label: string, onClick: Function}} [options.action] Adds a button (e.g.
 *   "Undo"). Clicking it dismisses the toast and runs onClick, at most once.
 *   Toasts with an action stay up longer.
 */
function showToast(message, {variant = 'info', action = null} = {}) {
    if (typeof Toastify === 'undefined') {
        // An alert is the last way left to show a message. It can't carry an action,
        // though, and a blocking dialog on every tab close is worse than no undo.
        if (!action) alert(message);
        return;
    }

    const duration = action ? 5000 : 3000; // time to reach the button

    // `content` is the toast's body (Toastify's `node` option). The progress bar is appended to it, which is
    // why .toast-content is position: relative in the CSS.
    const content = document.createElement("div");
    content.className = "toast-content";

    if (TOAST_ICONS[variant]) {
        const icon = document.createElement("span");
        icon.className = "toast-icon";
        icon.innerHTML = TOAST_ICONS[variant];
        content.appendChild(icon);
    }

    const text = document.createElement("span");
    text.className = "toast-message";
    // textContent, never innerHTML: messages contain file names and tab names
    text.textContent = message;
    content.appendChild(text);

    let actionBtn = null;
    if (action) {
        actionBtn = document.createElement("button");
        actionBtn.type = "button";
        actionBtn.className = "toast-action";
        actionBtn.textContent = action.label;
        content.appendChild(actionBtn);
    }

    const toast = Toastify({
        node: content,
        duration,
        gravity: "bottom",
        position: "right",
        // Hovering pauses Toastify's auto-close timer (the progress bar follows, see showToastWithProgressBar)
        stopOnFocus: true,
        // Toastify announces every toast politely by default; errors should interrupt
        ariaLive: variant === 'error' ? "assertive" : "polite",
        // Class hooks for mymd.css (.toast-error, ...). A new variant needs its own CSS rule, and optionally a TOAST_ICONS entry.
        className: `toast-box toast-${variant}${action ? " toast-has-action" : ""}`
    });

    // `once`: the toast stays clickable while it fades out, so a repeated click
    // must not run the action again
    actionBtn?.addEventListener('click', () => {
        toast.hideToast();
        action.onClick();
    }, {once: true});

    showToastWithProgressBar(toast, content, duration);
}

// --- Dropdown Logic ---
dropdownBtn.addEventListener('click', (e) => {
    // Without this the click would reach the window handler below and close the menu again at once
    e.stopPropagation();
    const isExpanded = dropdownContent.classList.toggle('show');
    dropdownBtn.setAttribute('aria-expanded', String(isExpanded));
});

// Any click closes an open menu, including clicks on its items: the items rely on this and have no
// close logic of their own.
window.addEventListener('click', () => {
    if (dropdownContent.classList.contains('show')) {
        dropdownContent.classList.remove('show');
        dropdownBtn.setAttribute('aria-expanded', 'false');
    }
});

// Queries for the current state: the DOM is the state (see the overview at the top)
function getActivePane() {
    return document.querySelector('.content-pane.active');
}

function getTabs() {
    return Array.from(tabList.querySelectorAll('.tab'));
}

function getActiveTab() {
    return tabList.querySelector('.tab.active');
}

// The tab that contains `node` (a null-safe closest('.tab')), or null
function tabOf(node) {
    const el = node instanceof Element ? node : node?.parentElement;
    return el?.closest('.tab') ?? null;
}

// The one place that sets the "Show Source / Show Formatted" menu label.
// `pane` must be the currently active pane.
// Source mode is stored per pane (class `show-source`) but the menu entry is shared, so the label has to be
// re-synced whenever the active pane changes (activateTab) or its mode does (setSourceMode).
function syncSourceMenuLabel(pane) {
    const isSource = pane.classList.contains('show-source');
    menuToggleSourceText.textContent = isSource ? 'Show Formatted' : 'Show Source';
}

// Raw markdown whose source view hasn't been built yet, keyed by its pane.
// Highlighting the whole document is expensive and the source view is rarely
// opened, so renderContent() only parks the text here and fillSourceView()
// builds the view on first use.
// An entry's presence IS the "not filled yet" flag: it is deleted on fill, so
// there is no separate state to go stale, and rendering into a pane again just
// sets a fresh entry. Weak keys let a pane that is gone for good (undo window
// over) take its entry with it.
const pendingSource = new WeakMap();

function fillSourceView(pane) {
    const markdown = pendingSource.get(pane);
    if (markdown === undefined) return; // placeholder pane, or already filled
    pendingSource.delete(pane);

    const code = pane.querySelector('.source-view code');
    if (!code) return;

    code.textContent = markdown; // textContent: no escaping needed
    if (typeof hljs !== 'undefined') {
        hljs.highlightElement(code);
    }
}

// Switches the *active* pane between formatted view and source view. Each pane keeps its own mode.
// Works on a blank tab too (there is nothing to fill then); renderContent() resets the mode when
// that tab receives a document.
function setSourceMode(showSource) {
    const activeContentPane = getActivePane();
    if (!activeContentPane) return;

    if (showSource) fillSourceView(activeContentPane);
    activeContentPane.classList.toggle('show-source', showSource);
    syncSourceMenuLabel(activeContentPane);
}

menuToggleSource.addEventListener('click', toggleSource);

function toggleSource() {
    const activeContentPane = getActivePane();
    if (!activeContentPane) return;
    setSourceMode(!activeContentPane.classList.contains('show-source'));
}

function closeOtherTabs() {
    const activeTab = getActiveTab();
    // Without a reference tab, "others" is undefined: do nothing rather than close everything
    if (!activeTab) return;
    closeTabs(getTabs().filter(tab => tab !== activeTab));
}

function closeAllTabs() {
    closeTabs(getTabs());
}

menuCloseOthers.addEventListener('click', closeOtherTabs);
menuCloseAll.addEventListener('click', closeAllTabs);

// Hotkeys
document.addEventListener('keydown', (e) => {
    // Prevent hotkeys from triggering when the user is typing inside an input field
    // (the tab-rename field is the only text input in the app)
    if (e.target.tagName === 'INPUT') return;

    // Escape to close dropdown if it's open
    if (e.key === 'Escape' && dropdownContent.classList.contains('show')) {
        dropdownContent.classList.remove('show');
        dropdownBtn.setAttribute('aria-expanded', 'false');
        dropdownBtn.focus();
    }

    // F2 to rename the tab that has focus, or the active tab if focus isn't on a tab
    if (e.key === 'F2') {
        const tab = tabOf(e.target) ?? getActiveTab();
        if (tab) {
            e.preventDefault();
            makeTabEditable(tab);
        }
    }

    // S to toggle source (if no modifier keys are pressed)
    if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        // Ignore auto-repeat, or holding S would flip the view back and forth
        if (e.repeat) return;
        e.preventDefault();
        toggleSource();
    }

    // Ctrl+Shift+O for Close Others
    // ctrlKey only, also on macOS (as in the menu label in index.html); Cmd is not accepted
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        closeOtherTabs();
    }
});

// --- Markdown Rendering Logic ---
// Setup of `marked`: a math extension and a custom code-block renderer. Turning a whole document
// into HTML happens in renderContent(), further down.

// LaTeX math: $$display$$, \[display\], $inline$, and \(inline\). This is an *inline-level* extension, which means:
//  - marked tries it at each `$` or `\` before its other inline rules, so a formula is consumed whole and the
//    `_` or `*` inside it are not read as markdown;
//  - display math that is not on lines of its own ("text \[x\] more text") is part of a paragraph, so it cannot
//    contain a blank line. Display math on its own lines is handled by mathBlockExtension below.
const mathExtension = {
    name: 'math',
    level: 'inline',
    // Hint for marked: where a formula could start (-1: nowhere in `src`), so plain text is cut there
    // and `tokenizer` gets tried. Matches '$', '\[', or '\('.
    start(src) {
        return src.search(/\$|\\[\[(]/);
    },
    // Returning nothing (no match) leaves the delimiter to marked's normal text handling
    tokenizer(src) {
        const displayMatch = src.match(/^\$\$([\s\S]+?)\$\$/);
        if (displayMatch) {
            return {type: 'math', raw: displayMatch[0], text: displayMatch[1].trim(), displayMode: true};
        }
        const bracketDisplayMatch = src.match(/^\\\[([\s\S]+?)\\\]/);
        if (bracketDisplayMatch) {
            return {type: 'math', raw: bracketDisplayMatch[0], text: bracketDisplayMatch[1].trim(), displayMode: true};
        }
        const bracketInlineMatch = src.match(/^\\\(([\s\S]+?)\\\)/);
        if (bracketInlineMatch) {
            return {type: 'math', raw: bracketInlineMatch[0], text: bracketInlineMatch[1].trim(), displayMode: false};
        }
        // Inline math follows Pandoc's rules so that ordinary dollar signs ("costs $5 and $10") stay text:
        // the opening `$` must not be followed by whitespace, the closing `$` must not be preceded by
        // whitespace nor followed by a digit, and the formula can't span lines.
        const inlineMatch = src.match(/^\$(?!\s)([^\$\n]*?\S)\$(?!\d)/);
        if (inlineMatch) {
            return {type: 'math', raw: inlineMatch[0], text: inlineMatch[1].trim(), displayMode: false};
        }
    },
    renderer(token) {
        try {
            return katex.renderToString(token.text, {
                displayMode: token.displayMode,
                throwOnError: false,
                output: 'html'
            });
        } catch (e) {
            // With `throwOnError: false` KaTeX itself renders malformed LaTeX as red text instead of throwing,
            // so this is reached for other failures, e.g. KaTeX not having loaded at all (ReferenceError).
            // Show the raw source instead.
            console.error('KaTeX rendering error:', e);
            return `<span style="color: var(--danger-text-color, #ff6b6b);">${escapeHtml(token.raw)}</span>`;
        }
    }
};

// Display math ($$...$$ and \[...\]) that starts at the beginning of a line, as a *block-level* extension.
// Without it the formula is part of a paragraph, and marked's block rules can cut it apart first: a line
// consisting of only `=` or `-` becomes a setext heading underline, a line starting with `- ` becomes a list
// item, and a blank line ends the paragraph. Block extensions are tried before all of those rules.
// Display math that doesn't sit on lines of its own ("text \[x\] more text") still goes to the inline extension.
const mathBlockExtension = {
    name: 'mathBlock',
    level: 'block',
    // Hint for marked so a paragraph is cut right before a formula that follows it without a blank line.
    // As the marked docs ask for block extensions, this returns the index of the "\n" preceding the formula.
    start(src) {
        return src.search(/\n {0,3}(?:\$\$|\\\[)/);
    },
    tokenizer(src) {
        // The closing delimiter must end its line, and the formula can't contain its own closing delimiter,
        // so "$$a$$ and $$b$$" is not read as one big formula (the inline extension handles that case).
        const match = src.match(/^ {0,3}(?:\$\$((?:(?!\$\$)[\s\S])+?)\$\$|\\\[((?:(?!\\\])[\s\S])+?)\\\])[ \t]*(?:\n|$)/);
        if (match) {
            return {type: 'mathBlock', raw: match[0], text: (match[1] ?? match[2]).trim(), displayMode: true};
        }
    },
    // Same KaTeX rendering (and error handling) as the inline extension
    renderer: mathExtension.renderer
};

function configureMarked() {
    if (typeof marked !== 'undefined') {
        marked.use({
            extensions: [mathBlockExtension, mathExtension],
            renderer: {
                // Replaces marked's default code-block output with highlight.js. Current marked passes renderer
                // methods a token object; `lang` is the fence's whole info string.
                code({text, lang}) {
                    // Only the first word of the info string names the language ("js title=x" -> "js")
                    const language = (lang || '').trim().split(/\s+/)[0];
                    // Known language: highlight it (ignoreIllegals: don't throw on syntax the grammar rejects).
                    // Unknown or missing language, or hljs not loaded: plain escaped text, there is no auto-detection.
                    const html = (typeof hljs !== 'undefined' && hljs.getLanguage(language))
                        ? hljs.highlight(text, {language, ignoreIllegals: true}).value
                        : escapeHtml(text);
                    // `hljs` is the class the highlight.js theme styles. `language` comes from the document,
                    // hence escapeHtml() in the attribute.
                    return `<pre><code class="hljs language-${escapeHtml(language || 'plaintext')}">${html}</code></pre>\n`;
                }
            }
        });
    }
}

configureMarked();

// --- Tabs: focus, input handling, creation, activation ---
// The only place that sets tabindex on tabs: roving tabindex, so exactly one tab
// (together with its close button) is reachable with the Tab key.
function updateTabStops(focusedTab) {
    getTabs().forEach(t => {
        const tabIndex = (t === focusedTab) ? 0 : -1;
        t.tabIndex = tabIndex;
        t.querySelector('.close-tab').tabIndex = tabIndex;
    });
}

// Helper to move roving focus among tabs without activating immediately
function setTabFocus(tab) {
    updateTabStops(tab);
    tab.focus();
}

// Keyboard navigation on tabs
// ARIA "manual activation": the arrow keys only move focus, Enter/Space activate the focused tab.
tabList.addEventListener('keydown', (e) => {
    // Keystrokes in the rename field belong to the field
    if (e.target.tagName === 'INPUT') return;

    const currentTab = tabOf(e.target);
    if (!currentTab) return;

    const tabs = getTabs();
    const currentIndex = tabs.indexOf(currentTab);
    if (currentIndex === -1) return;

    if (e.key === 'ArrowRight') {
        e.preventDefault();
        const nextIndex = (currentIndex + 1) % tabs.length;
        setTabFocus(tabs[nextIndex]);
    } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        setTabFocus(tabs[prevIndex]);
    } else if (e.key === 'Enter' || e.key === ' ') {
        // On the close button, leave the key alone so the button's native click fires
        if (e.target.classList.contains('close-tab')) return;
        e.preventDefault();
        activateTab(currentTab);
    }
});

// When focus leaves the tabs, ensure roving tabindex resets to the active tab
// (the arrow keys may have moved the tab stop to a tab that isn't active; without this reset,
// tabbing back in would land on that one)
tabList.addEventListener('focusout', (e) => {
    if (tabOf(e.relatedTarget)) return; // focus is just moving between tabs or onto a tab's close button
    const activeTab = getActiveTab();
    if (activeTab) updateTabStops(activeTab);
});

// Delegated mouse handling: tabs are created, removed and restored dynamically
tabList.addEventListener('click', (e) => {
    const tab = tabOf(e.target);
    // Clicks inside the rename field do nothing
    if (!tab || e.target.tagName === 'INPUT') return;

    if (e.target.closest('.close-tab')) {
        closeTabs([tab]);
    } else {
        activateTab(tab);
    }
});

tabList.addEventListener('dblclick', (e) => {
    // Only a double-click on the label itself starts renaming
    if (e.target.matches('.tab > span')) {
        makeTabEditable(e.target.parentElement);
    }
});

// Creates a tab + pane, activates them via activateTab(), and returns both.
function createNewTab() {
    tabCounter++;
    const paneId = `mymd-pane-${tabCounter}`;
    const tabId = `mymd-tab-${tabCounter}`;

    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.id = tabId;
    tab.dataset.paneId = paneId;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-controls', paneId);
    tab.setAttribute('draggable', 'true');
    // tabindex is managed by updateTabStops() (called via activateTab below)
    // The label <span> doubles as state: while a tab is being renamed, the span is swapped for an <input>,
    // so "no span in the tab" means "rename in progress" (see makeTabEditable, getTabName, renderContent).
    // The title attribute shows the full name when CSS ellipsizes a long label; keep it in step with the text.
    tab.innerHTML = `
        <span title="new ${tabCounter}">new ${tabCounter}</span>
        <button class="close-tab" title="Close Tab" aria-label="Close Tab">×</button>
    `;

    tabList.insertBefore(tab, newTabBtn);

    const pane = document.createElement('div');
    pane.className = 'content-pane';
    pane.id = paneId;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', tabId);
    // Whether a tab is still blank is decided by the presence of this .placeholder element: renderContent()
    // looks for it, and captureClosedTab/restoreClosedTabs use it to skip blank tabs. Rendering a document
    // replaces all of the pane's children, which removes it.
    pane.innerHTML = `
        <div class="placeholder">
            <p>Paste Markdown (${pasteShortcut})<br>or drop .md files anywhere.</p>
        </div>
    `;
    contentContainer.appendChild(pane);

    // Last, because activateTab() finds the pane by id and so needs both elements in the DOM
    activateTab(tab);

    return {tab, pane};
}

// The only place that marks a tab/pane as active. It also re-syncs the source-menu label with the
// pane now shown (see syncSourceMenuLabel). It does not move keyboard focus (see setTabFocus).
function activateTab(tab) {
    getTabs().forEach(t => {
        const isActive = (t === tab);
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', String(isActive));
    });
    document.querySelectorAll('.content-pane.active').forEach(p => p.classList.remove('active'));
    updateTabStops(tab);

    const pane = document.getElementById(tab.dataset.paneId);
    if (pane) {
        pane.classList.add('active');
        syncSourceMenuLabel(pane);
    }
}

// --- Closing tabs, with Undo ---
// Closing detaches the tab and pane elements from the DOM but keeps those very elements alive in records
// (see captureClosedTab) that the "Undo" toast's callback closes over. Undo (restoreClosedTabs) re-inserts
// the same elements, so nothing is re-rendered and each pane keeps its state (source mode, pendingSource
// entry, ...). Once the toast is gone, the records and the detached elements can be garbage-collected.

// The tab to show when the active tab is closed: the nearest surviving tab to
// its left, otherwise the nearest one to its right, otherwise none.
// (Only called when the active tab is itself among the tabs being closed.)
function pickFallbackTab(allTabs, activeTab, closing) {
    const i = allTabs.indexOf(activeTab);
    return allTabs.slice(0, i).filter(t => !closing.has(t)).at(-1)
        ?? allTabs.slice(i + 1).find(t => !closing.has(t))
        ?? null;
}

// The name shown in the undo toast: the label, or (if a rename is somehow still
// open) what has been typed into the rename field.
// captureClosedTab() normally commits an open rename first, so the input branch is only a fallback.
function getTabName(tab) {
    const label = tab.querySelector('span');
    if (label) return label.textContent;
    return tab.querySelector('.tab-name-input')?.value.trim() || 'Tab';
}

// Everything needed to bring a tab back, captured while it is still in the DOM.
// `index` is its position among all tabs before the close (see restoreClosedTabs).
function captureClosedTab(tab, index) {
    // Commit a rename in progress, so the tab comes back with a normal label
    // instead of a dead input field
    tab.querySelector('.tab-name-input')?.blur();

    const pane = document.getElementById(tab.dataset.paneId);
    return {
        tab,
        pane,
        index,
        name: getTabName(tab),
        wasActive: tab.classList.contains('active'),
        // "Empty" = blank, never received a document (see createNewTab). Such tabs are not offered for undo.
        isEmpty: pane?.querySelector('.placeholder') != null
    };
}

// Puts closed tabs back, in ascending `index` order. `originalOrder` is the list
// of all tabs as it was before the close. Each tab goes in front of the first tab
// that used to follow it and is open now (or at the end if there is none). Anchoring
// to real tabs, rather than to a numeric position in the live list, keeps every tab
// in the right place even when other tabs were opened, closed or restored since,
// e.g. while the undo toasts of two separate closes overlap.
// `closedTabs` must not be empty. `autoCreated` is the blank {tab, pane} that closeTabs() opened because
// no tab was left, or null.
function restoreClosedTabs(closedTabs, originalOrder, autoCreated) {
    // Closing every tab leaves a fresh blank one behind; drop it again unless it was used
    if (autoCreated?.tab.isConnected && autoCreated.pane.querySelector('.placeholder')) {
        autoCreated.tab.remove();
        autoCreated.pane.remove();
    }

    // Measured after the auto-created tab (normally the active one) has been removed above
    const hadActiveTab = getActiveTab() !== null;

    for (const {tab, pane, index} of closedTabs) {
        const nextOpenTab = originalOrder.slice(index + 1).find(t => t.isConnected);
        tabList.insertBefore(tab, nextOpenTab ?? newTabBtn);
        // Panes can just go at the end: only the order of the tabs matters
        if (pane) contentContainer.appendChild(pane);
    }

    // Re-activate the tab that was active, or if nothing is active now, the first restored one
    const tabToActivate = closedTabs.find(c => c.wasActive)?.tab
        ?? (hadActiveTab ? null : closedTabs[0].tab);
    if (tabToActivate) activateTab(tabToActivate);
}

// Closes `tabsToClose` (close button, menu entries, shortcut). Undoable for a few seconds unless every
// closed tab was blank. The app always keeps at least one tab: closing the last one opens a new blank tab.
function closeTabs(tabsToClose) {
    const closing = new Set(tabsToClose);
    const originalOrder = getTabs();
    const activeTab = getActiveTab();
    // Picked now, before anything is removed, because it depends on the tabs' current positions. Only needed
    // when the active tab is closing; otherwise the active tab simply stays active.
    const fallbackTab = closing.has(activeTab) ? pickFallbackTab(originalOrder, activeTab, closing) : null;

    // Capture every record before removing anything: capturing needs the tab and pane to still be in the DOM.
    // Walking the tabs in order makes each record's `index` ascending (restoreClosedTabs relies on that)
    const closedTabs = [];
    originalOrder.forEach((tab, index) => {
        if (closing.has(tab)) closedTabs.push(captureClosedTab(tab, index));
    });
    if (closedTabs.length === 0) return;

    for (const {tab, pane} of closedTabs) {
        tab.remove();
        pane?.remove();
    }
    if (fallbackTab) activateTab(fallbackTab);

    // Closing every tab leaves a fresh blank one behind
    // (kept in `autoCreated` so that Undo can remove it again)
    const autoCreated = getTabs().length === 0 ? createNewTab() : null;

    // Blank tabs aren't worth an undo
    const restorable = closedTabs.filter(c => !c.isEmpty);
    if (restorable.length === 0) return;

    const message = restorable.length > 1
        ? `Closed ${restorable.length} tabs`
        : `Closed "${restorable[0].name}"`;
    showToast(message, {
        action: {label: 'Undo', onClick: () => restoreClosedTabs(restorable, originalOrder, autoCreated)}
    });
}

// --- Renaming a tab ---
// Swaps the tab's label <span> for an <input> (see the note in createNewTab) and swaps it back when done.
function makeTabEditable(tab) {
    const labelElement = tab.querySelector('span');
    if (!labelElement) return; // no label means a rename is already in progress

    const originalText = labelElement.textContent;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = originalText;
    input.className = 'tab-name-input';

    // Keeps the tab from shrinking (and the strip from jumping) while the label is replaced by the input
    input.style.minWidth = `${labelElement.offsetWidth}px`;

    tab.replaceChild(input, labelElement);
    input.focus();
    input.select();

    const finishEditing = (save = true) => {
        // Detach the listeners first: removing the focused input from the DOM can itself fire `blur`,
        // which would call this function a second time
        input.removeEventListener('blur', onBlur);
        input.removeEventListener('keydown', onKeydown);

        const newText = input.value.trim();
        // An empty name, or Escape, keeps the old name
        const finalName = (save && newText) ? newText : originalText;

        const newLabel = document.createElement('span');
        newLabel.textContent = finalName;
        newLabel.title = finalName;

        if (input.parentElement) {
            input.parentElement.replaceChild(newLabel, input);
        }
    };

    // Blur (clicking elsewhere) commits the rename; Enter commits, Escape cancels. Both keys hand focus back
    // to the tab so keyboard users aren't left on an input that is being removed.
    const onBlur = () => finishEditing(true);
    const onKeydown = (e) => {
        if (e.key === 'Enter') {
            finishEditing(true);
            tab.focus();
        } else if (e.key === 'Escape') {
            finishEditing(false);
            tab.focus();
        }
    };

    input.addEventListener('blur', onBlur);
    input.addEventListener('keydown', onKeydown);
}

// --- Rendering a document into a tab ---

// Wraps every <pre> in `container` (the preview, not yet attached to the page) in a .code-block-wrapper and
// adds a copy button to it. The button is laid over the code by CSS (grid, see .code-block-wrapper).
function addCopyButtons(container) {
    const codeBlocks = container.querySelectorAll('pre');
    codeBlocks.forEach(block => {
        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';
        const button = document.createElement('button');
        button.className = 'copy-code-btn';
        button.innerHTML = copyIcon;
        button.title = 'Copy';

        block.parentNode.insertBefore(wrapper, block);
        wrapper.appendChild(block);
        wrapper.appendChild(button);

        button.addEventListener('click', () => {
            // textContent: the plain code, without highlight.js's <span>s
            const code = block.textContent;
            // Needs a secure context (https or localhost). Elsewhere navigator.clipboard is undefined and this
            // line throws before the .catch below can run.
            navigator.clipboard.writeText(code).then(() => {
                button.innerHTML = checkIcon;
                setTimeout(() => {
                    button.innerHTML = copyIcon;
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy text: ', err);
                button.textContent = 'Error';
                setTimeout(() => {
                    button.innerHTML = copyIcon;
                }, 2000);
            });
        });
    });
}

// For text inside HTML elements and inside quoted attribute values (hence the quotes)
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Entry point for pasted text and dropped files. Never overwrites a tab that already holds a document:
// it fills the active tab if that is still blank, and otherwise opens a new one.
// `filename`, if given, becomes the tab's label (dropped files only; pastes have no name).
function renderContent(markdown, filename = null) {
    if (!markdown) return;

    let activeContentPane = getActivePane();
    let activeTab = getActiveTab();

    // Open a fresh tab if nothing is active, or if the active tab already has content
    // Multi-file drops rely on this: the first file fills the blank tab, and every later call finds a filled
    // active tab and so opens another one.
    if (!activeContentPane || !activeContentPane.querySelector('.placeholder')) {
        ({tab: activeTab, pane: activeContentPane} = createNewTab());
    }

    // Force exit Source mode specifically on this tab on paste/drop
    // (a blank tab may have been switched to source mode before; setSourceMode() acts on the active pane,
    // which by now is the target pane)
    setSourceMode(false);

    let renderedHtml = '';
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
        // Fall back to escaped raw text if marked or DOMPurify fails to load
        // (DOMPurify is needed too: parsed HTML is never used unsanitized)
        renderedHtml = `<pre><code>${escapeHtml(markdown)}</code></pre>`;
        showToast('Markdown parser or sanitizer not loaded. Showing raw text.', {variant: 'error'});
    } else {
        // marked does not sanitize and passes raw HTML in the document through. DOMPurify is the XSS defense, and
        // ALL HTML derived from the document goes through it, KaTeX output and highlighted code included. Its
        // defaults keep the inline `style` attributes KaTeX relies on: re-check math before tightening its config.
        // marked.parse() returns a string only while no async extension/option is used; an async one needs an await here.
        renderedHtml = DOMPurify.sanitize(marked.parse(markdown));
    }

    const previewView = document.createElement('div');
    previewView.className = 'preview-view';
    previewView.innerHTML = renderedHtml;
    addCopyButtons(previewView);

    // The source view starts out empty; setSourceMode(true) fills and
    // highlights it the first time it's shown (see fillSourceView).
    const sourceCode = document.createElement('code');
    // Tells highlight.js which grammar to use when the source view is filled
    sourceCode.className = 'language-markdown';
    const sourcePre = document.createElement('pre');
    sourcePre.appendChild(sourceCode);
    const sourceView = document.createElement('div');
    sourceView.className = 'source-view';
    sourceView.appendChild(sourcePre);

    // Replaces all children, including the .placeholder: from here on the tab no longer counts as blank
    activeContentPane.replaceChildren(previewView, sourceView);
    pendingSource.set(activeContentPane, markdown);

    // If a filename was provided, strips the .md extension and sets it as the tab label
    if (filename && activeTab) {
        const cleanName = filename.replace(/\.md$/i, '');
        const tabLabel = activeTab.querySelector('span');
        if (tabLabel) {
            tabLabel.textContent = cleanName;
            tabLabel.title = cleanName;
        } else {
            // A rename is in progress (the label span is currently an input). Update the input, or finishing
            // the rename would put the old name back. Only reachable for dropped files: pastes have no filename.
            const tabInput = activeTab.querySelector('.tab-name-input');
            if (tabInput) {
                tabInput.value = cleanName;
            }
        }
    }
}

// --- Input: pasted text and dropped files ---

function handlePaste(event) {
    // Let the rename field handle its own paste: returning before preventDefault keeps the native behavior
    if (document.activeElement.classList.contains('tab-name-input')) return;

    event.preventDefault();
    const pastedText = (event.clipboardData || window.clipboardData).getData('text');
    // trim() only serves the emptiness check (blank text, or a non-text clipboard such as an image).
    // The text is rendered as pasted: leading whitespace can be significant in markdown.
    if (!pastedText || !pastedText.trim()) return;

    renderContent(pastedText);
}

async function handleFileDrop(event) {
    // Without this the browser would navigate to the dropped file
    event.preventDefault();
    // dragleave doesn't fire on a drop, so the overlay has to be hidden here
    appContainer.classList.remove('is-dragging');

    // Has to be called synchronously from the event handler, see getDroppedFiles()
    const allFiles = await getDroppedFiles(event.dataTransfer);
    // Also what happens when a reordered tab is dropped: that drop bubbles up to this handler too, but carries no files
    if (allFiles.length === 0) return;

    // Separate .md files from non-.md files.
    // Filter out common OS hidden metadata files (e.g., .DS_Store, Thumbs.db)
    // so they do not trigger annoying warnings when dropping folders.
    const mdFiles = [];
    const skippedFiles = [];

    for (const file of allFiles) {
        if (file.name.toLowerCase().endsWith('.md')) {
            mdFiles.push(file);
        } else if (!file.name.startsWith('.') && file.name !== 'Thumbs.db') {
            skippedFiles.push(file);
        }
    }

    // If no markdown files were present in the drop
    if (mdFiles.length === 0) {
        if (skippedFiles.length === 1) {
            showToast(`"${skippedFiles[0].name}" is not an .md file.`, {variant: 'error'});
        } else {
            showToast('Please drop at least one .md file.', {variant: 'error'});
        }
        return;
    }

    // Load and render all valid .md files
    // One file at a time, in order: renderContent() chooses between the blank active tab and a new tab based on
    // the current DOM, and the tabs should open in file order.
    let loadedCount = 0;
    for (const file of mdFiles) {
        try {
            const fileContent = await file.text();
            if (!fileContent) {
                showToast(`The file "${file.name}" is empty.`, {variant: 'error'});
                continue;
            }
            renderContent(fileContent, file.name);
            loadedCount++;
        } catch (err) {
            console.error(`Error reading file ${file.name}:`, err);
            showToast(`Sorry, there was an error reading "${file.name}".`, {variant: 'error'});
        }
    }

    // Summary toast when multiple .md files were loaded
    if (mdFiles.length > 1 && loadedCount > 0) {
        showToast(`Loaded ${loadedCount} file${loadedCount > 1 ? 's' : ''}`);
    }

    // Inform the user about any skipped non-.md files
    if (skippedFiles.length > 0) {
        if (skippedFiles.length === 1) {
            showToast(`Skipped "${skippedFiles[0].name}" (not an .md file).`, {variant: 'error'});
        } else {
            showToast(`Skipped ${skippedFiles.length} non-.md files.`, {variant: 'error'});
        }
    }
}

/**
 * Extracts all File objects from a DataTransfer object, traversing
 * directories recursively if a folder was dropped.
 */
async function getDroppedFiles(dataTransfer) {
    const items = dataTransfer.items;

    // Use webkitGetAsEntry if available to support folder drops
    if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
        const files = [];
        // Entries still to visit. Folders are expanded by appending their entries, so the traversal is
        // breadth-first (files of nested folders come after the files of the folder above them).
        const queue = [];

        // Collect every entry synchronously, before the first `await`: the dropped items are only readable
        // while the drop event is being dispatched, and the list is empty by the time async code resumes.
        for (let i = 0; i < items.length; i++) {
            const entry = items[i].webkitGetAsEntry();
            if (entry) queue.push(entry);
        }

        while (queue.length > 0) {
            const entry = queue.shift();
            if (entry.isFile) {
                // A file that can't be read resolves to null and is skipped
                const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
                if (file) files.push(file);
            } else if (entry.isDirectory) {
                const dirReader = entry.createReader();
                // readEntries must be called repeatedly until it returns an empty array
                // (each call returns only a batch of entries; Chrome caps it at 100)
                const readBatch = () => new Promise((resolve) => dirReader.readEntries(resolve, () => resolve([])));
                let entries;
                do {
                    entries = await readBatch();
                    queue.push(...entries);
                } while (entries && entries.length > 0);
            }
        }

        // Nothing usable found (or an item that isn't a file, such as a dragged tab): use the plain file list below
        if (files.length > 0) return files;
    }

    // Fallback for standard file drops or browsers without webkitGetAsEntry
    return Array.from(dataTransfer.files || []);
}

// Drop target for files: the whole app container (it fills the viewport).
// preventDefault() in dragover is what makes dropping possible at all. It runs for every drag, tab
// reordering included, which is harmless because handleFileDrop() ignores drops that carry no files.
// The overlay is shown only for file drags ('Files' in types), not while reordering tabs.
appContainer.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer.types.includes('Files')) {
        appContainer.classList.add('is-dragging');
    }
});

// The overlay is the container's ::before and covers all of it, so once it is shown it is itself the drag
// target: dragleave then essentially fires only when the pointer leaves the app, which is why no
// enter/leave counter is needed. (Relies on the overlay in mymd.css not having pointer-events: none.)
appContainer.addEventListener('dragleave', () => {
    appContainer.classList.remove('is-dragging');
});

appContainer.addEventListener('drop', handleFileDrop);

newTabBtn.addEventListener('click', createNewTab);
// On document, so pasting works wherever focus is (handlePaste skips the rename field)
document.addEventListener('paste', handlePaste);

// Start with one blank tab: the code assumes there is always at least one
// (closeTabs() opens a new one when the last is closed)
createNewTab();
