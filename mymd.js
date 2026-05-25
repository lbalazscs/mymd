document.addEventListener('DOMContentLoaded', () => {
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

    let tabCounter = 0;

    const copyIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
    const checkIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#28a745" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    
    tabList.addEventListener('dragover', (e) => {
        const draggingTab = document.querySelector('.tab.dragging');
        if (!draggingTab) return; // If dragging a file instead of a tab, ignore this and let the file drop handler take over

        e.preventDefault(); // Allow the drop
        
        // Find all tabs except the one currently being dragged
        const draggableElements = [...tabList.querySelectorAll('.tab:not(.dragging)')];
        
        // Determine which element the cursor is hovering over
        const afterElement = draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = e.clientX - box.left - box.width / 2;
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;

        // Live-update the DOM position
        if (afterElement == null) {
            tabList.insertBefore(draggingTab, newTabBtn);
        } else {
            tabList.insertBefore(draggingTab, afterElement);
        }
    });

    // Undo Toast helper
    function showUndoToast(message, onUndo, onCleanup) {
        let isUndone = false; // Track if the user clicked undo
        
        const toastNode = document.createElement("div");
        toastNode.style.display = "flex";
        toastNode.style.justifyContent = "space-between";
        toastNode.style.alignItems = "center";
        toastNode.style.width = "100%";

        const textSpan = document.createElement("span");
        textSpan.textContent = message;
        
        const undoBtn = document.createElement("button");
        undoBtn.textContent = "Undo";
        undoBtn.style.marginLeft = "15px";
        undoBtn.style.padding = "2px 8px";
        undoBtn.style.background = "green";
        undoBtn.style.color = "white";
        undoBtn.style.border = "none";
        undoBtn.style.borderRadius = "3px";
        undoBtn.style.cursor = "pointer";
        undoBtn.style.fontWeight = "bold";

        toastNode.appendChild(textSpan);
        toastNode.appendChild(undoBtn);

        const toast = Toastify({
            node: toastNode,
            duration: 5000,
            gravity: "bottom",
            position: "right",
            style: {
                background: "#333",
                color: "#fff",
                borderRadius: "4px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                minWidth: "250px"
            },
            callback: function() {
                // Fires when the toast naturally times out and disappears.
                // If the user didn't click undo, execute the permanent memory cleanup.
                if (!isUndone && onCleanup) {
                    onCleanup();
                }
            }
        });

        undoBtn.addEventListener('click', () => {
            isUndone = true; // Mark as undone so cleanup doesn't delete it
            toast.hideToast();
            if (onUndo) onUndo();
        });

        toast.showToast();
    }

    // Helper for universal toast notifications
    function showToast(message, isError = true) {
        if (typeof Toastify === 'undefined') {
            alert(message); // Fallback just in case script hasn't loaded
            return;
        }
        Toastify({
            text: message,
            duration: 3000,
            gravity: "bottom", 
            position: "right", 
            style: {
                background: isError ? "#c00" : "#28a745",
                color: "#fff",
                borderRadius: "4px"
            }
        }).showToast();
    }

    // --- Dropdown Logic ---
    dropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdownContent.classList.toggle('show');
    });

    window.addEventListener('click', () => {
        if (dropdownContent.classList.contains('show')) {
            dropdownContent.classList.remove('show');
        }
    });

    function setSourceMode(showSource) {
        if (showSource) {
            appContainer.classList.add('show-source');
            menuToggleSourceText.textContent = 'Show Formatted';
        } else {
            appContainer.classList.remove('show-source');
            menuToggleSourceText.textContent = 'Show Source';
        }
    }

    menuToggleSource.addEventListener('click', (e) => {
        e.preventDefault();
        toggleSource();
    });
    
    function toggleSource() {
        const isSource = appContainer.classList.contains('show-source');
        setSourceMode(!isSource);
    }

    function closeOtherTabs() {
        const activeTab = document.querySelector('.tab.active');
        if (!activeTab) return;
        
        const tabsToClose = [];
        document.querySelectorAll('.tab').forEach(tab => {
            if (tab !== activeTab) {
                tabsToClose.push(tab);
            }
        });
        closeTabs(tabsToClose);
    }

    function closeAllTabs() {
        const tabsToClose = Array.from(document.querySelectorAll('.tab'));
        closeTabs(tabsToClose);
    }

    menuCloseOthers.addEventListener('click', (e) => {
        e.preventDefault();
        closeOtherTabs();
    });

    menuCloseAll.addEventListener('click', (e) => {
        e.preventDefault();
        closeAllTabs();
    });

    // Hotkeys
    document.addEventListener('keydown', (e) => {
        // Prevent hotkeys from triggering when the user is typing inside an input field
        if (e.target.tagName === 'INPUT') return;

        // S to toggle source (if no modifier keys are pressed)
        if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            toggleSource();
        }

        // Ctrl+Shift+O for Close Others
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'o') {
            e.preventDefault();
            closeOtherTabs();
        }
    });

    // --- Markdown Rendering Logic ---
    const mathExtension = {
        name: 'math',
        level: 'inline',
        start(src) {
            const dollarMatch = src.match(/\$+/);
            return dollarMatch ? dollarMatch.index : -1;
        },
        tokenizer(src) {
            const displayMatch = src.match(/^\$\$([^\$]+?)\$\$/);
            if (displayMatch) {
                return { type: 'math', raw: displayMatch[0], text: displayMatch[1].trim(), displayMode: true };
            }
            const inlineMatch = src.match(/^\$([^\$\n]+?)\$/);
            if (inlineMatch) {
                return { type: 'math', raw: inlineMatch[0], text: inlineMatch[1].trim(), displayMode: false };
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
                console.error('KaTeX rendering error:', e);
                return `<span style="color: #ff6b6b;">${token.raw}</span>`;
            }
        }
    };

    function initializeMarked() {
        if (typeof marked !== 'undefined') {
            marked.use({ 
                extensions: [mathExtension],
                pedantic: false,
                gfm: true,
                breaks: false,
                renderer: {
                    code(token) {
                        const lang = token.lang || 'plaintext';
                        const language = hljs.getLanguage(lang) ? lang : 'plaintext';
                        
                        // Highlight the raw text string
                        const highlighted = hljs.highlight(token.text, { language, ignoreIllegals: true }).value;
                        
                        // Output the final <pre><code> block with the proper hljs classes
                        return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>\n`;
                    }
                }
            });
        }
    }
    
    initializeMarked();

    function createNewTab() {
        tabCounter++;
        const tabId = `tab-${tabCounter}`;

        deactivateAllTabs();

        const tab = document.createElement('div');
        tab.className = 'tab active';
        tab.dataset.tabId = tabId;
        tab.innerHTML = `
            <span>new ${tabCounter}</span>
            <button class="close-tab" title="Close Tab">×</button>
        `;
        
        tab.setAttribute('draggable', 'true');

        tab.addEventListener('dragstart', (e) => {
            // Prevent dragging if the user is clicking the close button or typing a new name
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') {
                e.preventDefault();
                return;
            }
            tab.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', tabId); // Required by Firefox to allow dragging
        });

        tab.addEventListener('dragend', () => {
            tab.classList.remove('dragging');
        });
        
        tabList.insertBefore(tab, newTabBtn);

        const contentPane = document.createElement('div');
        contentPane.className = 'content-pane active';
        contentPane.id = tabId;
        contentPane.innerHTML = `
            <div class="placeholder">
                <p>Paste Markdown (Ctrl+V)<br>or drop a .md file anywhere.</p>
            </div>
        `;
        contentContainer.appendChild(contentPane);

        tab.addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT') {
                switchTab(tab);
            }
        });

        tab.querySelector('.close-tab').addEventListener('click', (e) => {
            e.stopPropagation();
            closeTab(tab);
        });

        const tabLabel = tab.querySelector('span');
        tabLabel.addEventListener('dblclick', () => {
            makeTabEditable(tabLabel);
        });
    }

    function switchTab(tabToActivate) {
        deactivateAllTabs();
        const tabId = tabToActivate.dataset.tabId;
        const contentPaneToActivate = document.getElementById(tabId);

        tabToActivate.classList.add('active');
        if (contentPaneToActivate) {
            contentPaneToActivate.classList.add('active');
        }
    }

    function closeTab(tabToClose) {
        closeTabs([tabToClose]);
    }

    function closeTabs(tabsToClose) {
        if (!tabsToClose || tabsToClose.length === 0) return;

        // If the active tab is being closed, find a fallback tab to activate
        let fallbackTab = null;
        const activeTab = document.querySelector('.tab.active');
        if (activeTab && tabsToClose.includes(activeTab)) {
            const allTabs = Array.from(tabList.querySelectorAll('.tab'));
            let idx = allTabs.indexOf(activeTab);
            
            // Try previous siblings not in tabsToClose
            for (let i = idx - 1; i >= 0; i--) {
                if (!tabsToClose.includes(allTabs[i])) {
                    fallbackTab = allTabs[i];
                    break;
                }
            }
            // If none, try next siblings not in tabsToClose
            if (!fallbackTab) {
                for (let i = idx + 1; i < allTabs.length; i++) {
                    if (!tabsToClose.includes(allTabs[i])) {
                        fallbackTab = allTabs[i];
                        break;
                    }
                }
            }
        }

        // Batch state collection
        const closedTabsData = [];
        tabsToClose.forEach(tabToClose => {
            const renamingInput = tabToClose.querySelector('.tab-name-input');
            if (renamingInput) {
                renamingInput.blur();
            }

            const wasActive = tabToClose.classList.contains('active');
            const tabId = tabToClose.dataset.tabId;
            const contentPaneToClose = document.getElementById(tabId);
            
            // Capture all subsequent siblings up to newTabBtn
            const siblings = [];
            let current = tabToClose.nextElementSibling;
            while (current && current !== newTabBtn) {
                siblings.push(current);
                current = current.nextElementSibling;
            }

            const span = tabToClose.querySelector('span');
            const tabName = span ? span.textContent : (renamingInput && renamingInput.value.trim() ? renamingInput.value.trim() : 'Tab');
            
            const isEmpty = contentPaneToClose && contentPaneToClose.querySelector('.placeholder') !== null;

            closedTabsData.push({
                tabElement: tabToClose,
                contentPaneElement: contentPaneToClose,
                wasActive: wasActive,
                tabId: tabId,
                tabName: tabName,
                isEmpty: isEmpty,
                siblings: siblings
            });
        });

        // Detach elements from DOM
        closedTabsData.forEach(data => {
            data.tabElement.remove();
            if (data.contentPaneElement) {
                data.contentPaneElement.remove();
            }
        });

        // Activate the determined fallback tab if needed
        if (fallbackTab) {
            switchTab(fallbackTab);
        }

        // If all tabs are closed, auto-create a blank one and save its ID
        let autoCreatedTabId = null;
        if (tabList.querySelectorAll('.tab').length === 0) {
            createNewTab();
            const newTabs = tabList.querySelectorAll('.tab');
            if (newTabs.length > 0) {
                autoCreatedTabId = newTabs[newTabs.length - 1].dataset.tabId;
            }
        }

        // --- UNDO LOGIC ---
        // Filter out empty placeholder tabs
        const restorableTabs = closedTabsData.filter(d => !d.isEmpty);
        
        if (restorableTabs.length > 0) {
            const message = restorableTabs.length > 1 
                ? `Closed ${restorableTabs.length} tabs` 
                : `Closed "${restorableTabs[0].tabName}"`;
            
            showUndoToast(message, () => {
                // --- ON UNDO CALLBACK (Restore in bulk) ---
                restorableTabs.forEach(data => {
                    // Find the first surviving original sibling that is still in the DOM
                    let insertRef = newTabBtn;
                    for (const sibling of data.siblings) {
                        if (sibling.parentNode === tabList) {
                            insertRef = sibling;
                            break;
                        }
                    }
                    
                    // Re-insert the tab and content pane
                    tabList.insertBefore(data.tabElement, insertRef);
                    if (data.contentPaneElement) {
                        contentContainer.appendChild(data.contentPaneElement);
                    }
                });

                // Reactivate the originally active restored tab (or the most recent one)
                const originallyActive = restorableTabs.find(d => d.wasActive);
                if (originallyActive) {
                    switchTab(originallyActive.tabElement);
                } else if (restorableTabs.length > 0) {
                    switchTab(restorableTabs[restorableTabs.length - 1].tabElement);
                }

                // Delete only the exact auto-created tab if it's still untouched
                if (autoCreatedTabId) {
                    const autoTab = document.querySelector(`.tab[data-tab-id="${autoCreatedTabId}"]`);
                    const autoPane = document.getElementById(autoCreatedTabId);
                    if (autoTab && autoPane && autoPane.querySelector('.placeholder')) {
                        autoTab.remove();
                        autoPane.remove();
                    }
                }
            }, () => {
                // Cleanup (after the toast is gone): detaches the nodes
                // from the JS closure, guaranteeing they get GCd
                restorableTabs.forEach(data => {
                    data.tabElement = null;
                    data.contentPaneElement = null;
                    data.siblings = null;
                });
            });
        }
    }

    function deactivateAllTabs() {
        document.querySelectorAll('.tab.active').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.content-pane.active').forEach(p => p.classList.remove('active'));
    }

    function makeTabEditable(labelElement) {
        const originalText = labelElement.textContent;
        const tab = labelElement.parentElement;

        if (tab.querySelector('.tab-name-input')) {
            return;
        }

        const input = document.createElement('input');
        input.type = 'text';
        input.value = originalText;
        input.className = 'tab-name-input';
        
        input.style.width = `${labelElement.offsetWidth}px`;

        tab.replaceChild(input, labelElement);
        input.focus();
        input.select();

        const finishEditing = (save = true) => {
            input.removeEventListener('blur', onBlur);
            input.removeEventListener('keydown', onKeydown);

            const newText = input.value.trim();
            const finalName = (save && newText) ? newText : originalText;

            const newLabel = document.createElement('span');
            newLabel.textContent = finalName;

            if (input.parentElement) {
                input.parentElement.replaceChild(newLabel, input);
            }

            newLabel.addEventListener('dblclick', () => makeTabEditable(newLabel));
        };

        const onBlur = () => finishEditing(true);
        const onKeydown = (e) => {
            if (e.key === 'Enter') finishEditing(true);
            else if (e.key === 'Escape') finishEditing(false);
        };

        input.addEventListener('blur', onBlur);
        input.addEventListener('keydown', onKeydown);
    }

    function addCopyButtons(container) {
        const codeBlocks = container.querySelectorAll('pre');
        codeBlocks.forEach(block => {
            if (block.parentNode.classList.contains('code-block-wrapper')) return;
            
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
                const code = block.querySelector('code').innerText;
                navigator.clipboard.writeText(code).then(() => {
                    button.innerHTML = checkIcon;
                    setTimeout(() => { button.innerHTML = copyIcon; }, 2000);
                }).catch(err => {
                    console.error('Failed to copy text: ', err);
                    button.textContent = 'Error';
                });
            });
        });
    }

    function escapeHtml(text) {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function renderContent(markdown, filename = null) {
        if (!markdown) return;

        // Force exit Source mode on paste/drop
        setSourceMode(false);

        let activeContentPane = document.querySelector('.content-pane.active');
        let activeTab = document.querySelector('.tab.active');

        if (!activeContentPane) {
            createNewTab();
            activeContentPane = document.querySelector('.content-pane.active');
            activeTab = document.querySelector('.tab.active');
        }

        const isCurrentTabEmpty = activeContentPane.querySelector('.placeholder');

        if (!isCurrentTabEmpty) { // the current tab already has content
            createNewTab();
            activeContentPane = document.querySelector('.content-pane.active');
            activeTab = document.querySelector('.tab.active');
        }

        const renderedHtml = marked.parse(markdown);
        const sourceHtml = `<pre><code class="language-markdown">${escapeHtml(markdown)}</code></pre>`;

        activeContentPane.innerHTML = `
            <div class="preview-view">${renderedHtml}</div>
            <div class="source-view">${sourceHtml}</div>
        `;

        const previewView = activeContentPane.querySelector('.preview-view');
        const sourceView = activeContentPane.querySelector('.source-view');

        addCopyButtons(previewView);
        
        if(sourceView) {
            const sourceCodeBlock = sourceView.querySelector('code');
            if(sourceCodeBlock) hljs.highlightElement(sourceCodeBlock);
        }

        // If a filename was provided, strips the .md extension and sets it as the tab label
        if (filename && activeTab) {
            const cleanName = filename.replace(/\.md$/i, '');
            const tabLabel = activeTab.querySelector('span');
            if (tabLabel) {
                tabLabel.textContent = cleanName;
            } else {
                const tabInput = activeTab.querySelector('.tab-name-input');
                if (tabInput) {
                    tabInput.value = cleanName;
                }
            }
        }
    }

    function handlePaste(event) {
        if (document.activeElement.classList.contains('tab-name-input')) return;

        event.preventDefault();
        const pastedText = (event.clipboardData || window.clipboardData).getData('text');
        renderContent(pastedText);
    }

    async function handleFileDrop(event) {
        event.preventDefault();
        appContainer.classList.remove('is-dragging');

        const files = event.dataTransfer.files;
        if (files.length === 0) return;

        // all .md files from the drop event
        const mdFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.md'));
        
        if (mdFiles.length === 0) {
            showToast('Please drop at least one .md file.', true);
            return;
        }

        for (const file of mdFiles) {
            try {
                const fileContent = await file.text();
                if (!fileContent) {
                    showToast(`The file "${file.name}" is empty.`, true);
                    continue; 
                }
                renderContent(fileContent, file.name);
            } catch (err) {
                console.error(`Error reading file ${file.name}:`, err);
                showToast(`Sorry, there was an error reading "${file.name}".`, true);
            }
        }
    }

    appContainer.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (event.dataTransfer.types.includes('Files')) {
            appContainer.classList.add('is-dragging');
        }
    });

    appContainer.addEventListener('dragleave', () => {
        appContainer.classList.remove('is-dragging');
    });

    appContainer.addEventListener('drop', handleFileDrop);

    newTabBtn.addEventListener('click', createNewTab);
    document.addEventListener('paste', handlePaste);

    createNewTab();
});
