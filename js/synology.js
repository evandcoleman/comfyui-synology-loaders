import { app } from "../../scripts/app.js";

// Maps node type -> folder key used by the backend
const NODE_FOLDER_MAP = {
    SynologyCheckpointLoader: "checkpoints",
    SynologyLoRALoader: "loras",
    SynologyVAELoader: "vae",
    SynologyControlNetLoader: "controlnet",
};

const SYNOLOGY_NODE_TYPES = Object.keys(NODE_FOLDER_MAP);

const synologyState = {
    authenticated: false,
    user: null,
    api_url: null,
    folderPaths: {}, // folder key -> current NAS path
};

const trackedWidgets = new Set(); // all auth + browse widgets

// Shared LoRA model list — mutated in-place so all combo widgets stay current
const loraValues = ["None"];

// ---------------------------------------------------------------------------
// Shared UI helpers
// ---------------------------------------------------------------------------

function makeOverlay() {
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "100%",
        height: "100%",
        background: "rgba(0,0,0,0.5)",
        zIndex: "10000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
    });
    return overlay;
}

function makeDialogBox(width = "400px") {
    const dialog = document.createElement("div");
    Object.assign(dialog.style, {
        background: "#2a2a2a",
        borderRadius: "8px",
        padding: "24px",
        minWidth: "320px",
        maxWidth: width,
        color: "#eee",
        fontFamily: "sans-serif",
        boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
    });
    return dialog;
}

function makeTitle(text) {
    const title = document.createElement("h3");
    title.textContent = text;
    Object.assign(title.style, { margin: "0 0 16px 0", fontSize: "16px" });
    return title;
}

function makeErrorDiv() {
    const errorDiv = document.createElement("div");
    Object.assign(errorDiv.style, {
        color: "#ff6b6b",
        marginBottom: "12px",
        fontSize: "13px",
        display: "none",
    });
    return errorDiv;
}

function makeField(label, type, placeholder) {
    const container = document.createElement("div");
    container.style.marginBottom = "12px";
    const lbl = document.createElement("label");
    lbl.textContent = label;
    Object.assign(lbl.style, {
        display: "block",
        marginBottom: "4px",
        fontSize: "13px",
        color: "#aaa",
    });
    const input = document.createElement("input");
    input.type = type;
    input.placeholder = placeholder;
    Object.assign(input.style, {
        width: "100%",
        padding: "8px",
        border: "1px solid #555",
        borderRadius: "4px",
        background: "#1a1a1a",
        color: "#eee",
        fontSize: "14px",
        boxSizing: "border-box",
    });
    container.appendChild(lbl);
    container.appendChild(input);
    return { container, input };
}

function makeButton(text, primary) {
    const btn = document.createElement("button");
    btn.textContent = text;
    Object.assign(btn.style, {
        padding: "8px 16px",
        border: "none",
        borderRadius: "4px",
        cursor: "pointer",
        fontSize: "14px",
        background: primary ? "#4a9eff" : "#555",
        color: "#fff",
    });
    return btn;
}

function makeBtnRow() {
    const row = document.createElement("div");
    Object.assign(row.style, {
        display: "flex",
        justifyContent: "flex-end",
        gap: "8px",
        marginTop: "16px",
    });
    return row;
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

async function fetchStatus() {
    try {
        const resp = await fetch("/synology/status");
        const data = await resp.json();
        synologyState.authenticated = data.authenticated;
        synologyState.user = data.user;
        synologyState.api_url = data.api_url;
    } catch (e) {
        console.warn("Synology: failed to fetch status", e);
    }
}

async function fetchFolderPaths() {
    try {
        const resp = await fetch("/synology/folder-paths");
        synologyState.folderPaths = await resp.json();
    } catch (e) {
        console.warn("Synology: failed to fetch folder paths", e);
    }
}

async function refreshLoraValues() {
    if (!synologyState.authenticated) return;
    try {
        const resp = await fetch("/synology/models/loras");
        const data = await resp.json();
        if (data.models) {
            loraValues.length = 0;
            loraValues.push("None", ...data.models);
        }
    } catch (e) {
        console.warn("Synology: failed to refresh LoRA list", e);
    }
}

function updateAllWidgets() {
    for (const w of trackedWidgets) {
        if (w.onSynologyStateChange) w.onSynologyStateChange();
    }
}

// ---------------------------------------------------------------------------
// Login dialog
// ---------------------------------------------------------------------------

function showLoginDialog() {
    const overlay = makeOverlay();
    const dialog = makeDialogBox();
    const errorDiv = makeErrorDiv();

    const apiUrl = makeField("API URL", "text", "https://your-nas:5001");
    const username = makeField("Username", "text", "admin");
    const password = makeField("Password", "password", "");

    if (synologyState.api_url) apiUrl.input.value = synologyState.api_url;

    const btnRow = makeBtnRow();
    const cancelBtn = makeButton("Cancel", false);
    const loginBtn = makeButton("Login", true);

    cancelBtn.onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    loginBtn.onclick = async () => {
        const url = apiUrl.input.value.trim();
        const user = username.input.value.trim();
        const pass = password.input.value;

        if (!url || !user || !pass) {
            errorDiv.textContent = "All fields are required.";
            errorDiv.style.display = "block";
            return;
        }

        loginBtn.disabled = true;
        loginBtn.textContent = "Logging in...";
        errorDiv.style.display = "none";

        try {
            const resp = await fetch("/synology/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ api_url: url, username: user, password: pass }),
            });
            const data = await resp.json();

            if (!resp.ok) {
                errorDiv.textContent = data.error || "Login failed";
                errorDiv.style.display = "block";
                loginBtn.disabled = false;
                loginBtn.textContent = "Login";
                return;
            }

            synologyState.authenticated = true;
            synologyState.user = data.user;
            synologyState.api_url = url;
            overlay.remove();
            await fetchFolderPaths();
            await refreshLoraValues();
            updateAllWidgets();
            if (app.refreshComboInNodes) app.refreshComboInNodes();
        } catch (e) {
            errorDiv.textContent = "Connection failed: " + e.message;
            errorDiv.style.display = "block";
            loginBtn.disabled = false;
            loginBtn.textContent = "Login";
        }
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(loginBtn);

    dialog.appendChild(makeTitle("Login to Synology NAS"));
    dialog.appendChild(errorDiv);
    dialog.appendChild(apiUrl.container);
    dialog.appendChild(username.container);
    dialog.appendChild(password.container);
    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    (apiUrl.input.value ? username.input : apiUrl.input).focus();
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

async function doLogout() {
    if (!confirm("Disconnect from Synology NAS?")) return;

    try {
        await fetch("/synology/logout", { method: "POST" });
    } catch (e) {
        console.warn("Synology: logout request failed", e);
    }

    synologyState.authenticated = false;
    synologyState.user = null;
    updateAllWidgets();
    if (app.refreshComboInNodes) app.refreshComboInNodes();
}

// ---------------------------------------------------------------------------
// Folder browser dialog
// ---------------------------------------------------------------------------

function showFolderBrowser(folderKey) {
    const overlay = makeOverlay();
    const dialog = makeDialogBox("500px");
    const errorDiv = makeErrorDiv();

    // Start at the custom path if set, otherwise at root (lists shares)
    const customPath = synologyState.folderPaths[folderKey];
    const startPath = customPath || "/";

    // Current path display
    const pathBar = document.createElement("div");
    Object.assign(pathBar.style, {
        padding: "8px 10px",
        background: "#1a1a1a",
        border: "1px solid #555",
        borderRadius: "4px",
        fontSize: "13px",
        color: "#ccc",
        marginBottom: "12px",
        wordBreak: "break-all",
    });
    pathBar.textContent = startPath;

    // Directory listing
    const listContainer = document.createElement("div");
    Object.assign(listContainer.style, {
        border: "1px solid #555",
        borderRadius: "4px",
        background: "#1a1a1a",
        maxHeight: "300px",
        overflowY: "auto",
        marginBottom: "4px",
    });

    const statusLine = document.createElement("div");
    Object.assign(statusLine.style, {
        fontSize: "12px",
        color: "#888",
        marginBottom: "12px",
    });

    let currentPath = startPath;

    function makeRow(text, onClick, isParent = false) {
        const row = document.createElement("div");
        Object.assign(row.style, {
            padding: "8px 12px",
            cursor: "pointer",
            borderBottom: "1px solid #333",
            fontSize: "14px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
        });
        row.onmouseenter = () => row.style.background = "#333";
        row.onmouseleave = () => row.style.background = "transparent";

        const icon = document.createElement("span");
        icon.textContent = isParent ? "\u2B06" : "\uD83D\uDCC1";
        icon.style.fontSize = "14px";

        const label = document.createElement("span");
        label.textContent = text;
        if (isParent) label.style.color = "#aaa";

        row.appendChild(icon);
        row.appendChild(label);
        row.onclick = onClick;
        return row;
    }

    async function navigateTo(path, isRetry = false) {
        listContainer.innerHTML = "";
        errorDiv.style.display = "none";
        statusLine.textContent = "Loading...";
        currentPath = path;
        pathBar.textContent = path;

        try {
            const resp = await fetch(`/synology/browse?path=${encodeURIComponent(path)}`);
            const text = await resp.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch {
                throw new Error(`Server returned invalid response (${resp.status}): ${text.slice(0, 200) || "(empty)"}`);
            }

            if (!resp.ok) {
                // If path doesn't exist and we haven't retried, fall back to root
                if (!isRetry && path !== "/") {
                    return navigateTo("/", true);
                }
                errorDiv.textContent = data.error || "Failed to browse";
                errorDiv.style.display = "block";
                statusLine.textContent = "";
                return;
            }

            listContainer.innerHTML = "";

            // Parent directory row (unless at root)
            if (path !== "/") {
                const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
                listContainer.appendChild(makeRow(".. (up)", () => navigateTo(parent), true));
            }

            const dirs = data.directories || [];
            for (const dir of dirs) {
                listContainer.appendChild(makeRow(dir.name, () => navigateTo(dir.path)));
            }

            statusLine.textContent = dirs.length === 0
                ? "No subdirectories"
                : `${dirs.length} folder${dirs.length > 1 ? "s" : ""}`;
        } catch (e) {
            errorDiv.textContent = "Request failed: " + e.message;
            errorDiv.style.display = "block";
            statusLine.textContent = "";
        }
    }

    const btnRow = makeBtnRow();
    const cancelBtn = makeButton("Cancel", false);
    const selectBtn = makeButton("Select This Folder", true);

    cancelBtn.onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    selectBtn.onclick = async () => {
        selectBtn.disabled = true;
        selectBtn.textContent = "Saving...";

        try {
            const resp = await fetch("/synology/folder-path", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ folder: folderKey, path: currentPath }),
            });
            const text = await resp.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch {
                throw new Error(`Server returned invalid response (${resp.status})`);
            }

            if (!resp.ok) {
                errorDiv.textContent = data.error || "Failed to save";
                errorDiv.style.display = "block";
                selectBtn.disabled = false;
                selectBtn.textContent = "Select This Folder";
                return;
            }

            synologyState.folderPaths[folderKey] = currentPath;
            await refreshLoraValues();
            overlay.remove();
            updateAllWidgets();
            if (app.refreshComboInNodes) app.refreshComboInNodes();
        } catch (e) {
            errorDiv.textContent = "Request failed: " + e.message;
            errorDiv.style.display = "block";
            selectBtn.disabled = false;
            selectBtn.textContent = "Select This Folder";
        }
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(selectBtn);

    dialog.appendChild(makeTitle(`Browse NAS — ${folderKey}`));
    dialog.appendChild(errorDiv);
    dialog.appendChild(pathBar);
    dialog.appendChild(listContainer);
    dialog.appendChild(statusLine);
    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    navigateTo(currentPath);
}

// ---------------------------------------------------------------------------
// Dynamic LoRA slot management
// ---------------------------------------------------------------------------

const LORA_SLOT_RE = /^(?:lora|strength)_(\d+)$/;

/**
 * Rebuild the dynamic lora/strength widgets from node.properties.loraSlots.
 * Widgets are inserted before the "Add LoRA" button so auth/browse stay last.
 */
function syncLoraWidgets(node) {
    // Remove existing dynamic widgets
    node.widgets = node.widgets.filter(w => !LORA_SLOT_RE.test(w.name));
    node._loraSlotWidgets = [];

    const slots = node.properties.loraSlots;

    for (let i = 0; i < slots.length; i++) {
        const data = slots[i];

        const loraW = node.addWidget("combo", `lora_${i + 1}`, data.lora, (v) => {
            if (node.properties.loraSlots[i]) {
                node.properties.loraSlots[i].lora = v;
            }
        }, { values: loraValues });

        const strW = node.addWidget("number", `strength_${i + 1}`, data.strength, (v) => {
            if (node.properties.loraSlots[i]) {
                node.properties.loraSlots[i].strength = v;
            }
        }, { min: -20.0, max: 20.0, step: 0.01, precision: 2 });

        node._loraSlotWidgets.push({ lora: loraW, strength: strW });
    }

    // Move the newly appended widgets to just before the "Add LoRA" button
    const addedCount = slots.length * 2;
    if (addedCount > 0) {
        const added = node.widgets.splice(node.widgets.length - addedCount, addedCount);
        const insertIdx = node.widgets.indexOf(node._loraAddBtn);
        node.widgets.splice(insertIdx, 0, ...added);
    }

    node.setSize(node.computeSize());
}

/**
 * Determine which LoRA slot (index) was right-clicked, using widget.last_y
 * positions set by LiteGraph during rendering.  Returns -1 if none.
 */
function getClickedLoraSlot(node, canvas) {
    const nodeY = canvas.graph_mouse[1] - node.pos[1];
    const widgetH = LiteGraph.NODE_WIDGET_HEIGHT || 20;

    for (let i = 0; i < node._loraSlotWidgets.length; i++) {
        const sw = node._loraSlotWidgets[i];
        const loraY = sw.lora.last_y;
        if (loraY == null) continue;

        const strEnd = (sw.strength.last_y ?? loraY + widgetH) + widgetH;
        if (nodeY >= loraY && nodeY < strEnd) {
            return i;
        }
    }

    return -1;
}

/**
 * Set up dynamic LoRA slot management on a SynologyLoRALoader node.
 *
 * - Removes auto-created optional widgets/inputs from INPUT_TYPES
 * - Adds an "Add LoRA" button
 * - Right-click context menu on slots: Move Up / Move Down / Remove
 * - Persists slot data in node.properties.loraSlots for workflow save/load
 */
function setupLoraSlots(node) {
    node._loraSlotWidgets = [];

    // Remove auto-created optional widgets and input slots
    node.widgets = node.widgets.filter(w => !LORA_SLOT_RE.test(w.name));
    if (node.inputs) {
        node.inputs = node.inputs.filter(input => !LORA_SLOT_RE.test(input.name));
    }

    // Initialize slot data
    node.properties = node.properties || {};
    if (!Array.isArray(node.properties.loraSlots) || node.properties.loraSlots.length === 0) {
        node.properties.loraSlots = [{ lora: "None", strength: 1.0 }];
    }

    // "Add LoRA" button
    node._loraAddBtn = node.addWidget("button", "add_lora", "Add LoRA", () => {
        node.properties.loraSlots.push({ lora: "None", strength: 1.0 });
        syncLoraWidgets(node);
    });
    node._loraAddBtn.serialize = false;

    // Build initial widgets
    syncLoraWidgets(node);

    // Workflow load — restore slots from properties
    const origConfigure = node.configure;
    node.configure = function (data) {
        // Clear dynamic widgets before configure restores old widget values
        node.widgets = node.widgets.filter(w => !LORA_SLOT_RE.test(w.name));
        node._loraSlotWidgets = [];

        origConfigure?.call(this, data);

        // Restore from properties (populated by configure from saved workflow)
        if (!Array.isArray(node.properties?.loraSlots) || node.properties.loraSlots.length === 0) {
            node.properties = node.properties || {};
            node.properties.loraSlots = [{ lora: "None", strength: 1.0 }];
        }

        syncLoraWidgets(node);
    };

    // Right-click context menu
    const origGetExtraMenuOptions = node.getExtraMenuOptions;
    node.getExtraMenuOptions = function (canvas, options) {
        if (origGetExtraMenuOptions) origGetExtraMenuOptions.call(this, canvas, options);

        const slotIdx = getClickedLoraSlot(node, canvas);
        if (slotIdx < 0) return;

        const menuItems = [];
        const slots = node.properties.loraSlots;

        if (slotIdx > 0) {
            menuItems.push({
                content: "Move LoRA Up",
                callback: () => {
                    [slots[slotIdx - 1], slots[slotIdx]] = [slots[slotIdx], slots[slotIdx - 1]];
                    syncLoraWidgets(node);
                },
            });
        }

        if (slotIdx < slots.length - 1) {
            menuItems.push({
                content: "Move LoRA Down",
                callback: () => {
                    [slots[slotIdx], slots[slotIdx + 1]] = [slots[slotIdx + 1], slots[slotIdx]];
                    syncLoraWidgets(node);
                },
            });
        }

        menuItems.push({
            content: "Remove LoRA",
            callback: () => {
                slots.splice(slotIdx, 1);
                syncLoraWidgets(node);
            },
        });

        options.unshift(...menuItems, null);
    };
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
    name: "Comfy.Synology",

    async setup() {
        await fetchStatus();
        if (synologyState.authenticated) {
            await fetchFolderPaths();
            await refreshLoraValues();
        }
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!SYNOLOGY_NODE_TYPES.includes(nodeData.name)) return;

        const folderKey = NODE_FOLDER_MAP[nodeData.name];
        const isLoraNode = nodeData.name === "SynologyLoRALoader";

        // Extract initial LoRA values from the server-provided INPUT_TYPES
        if (isLoraNode && nodeData.input?.optional?.lora_1) {
            loraValues.length = 0;
            loraValues.push(...nodeData.input.optional.lora_1[0]);
        }

        const origOnCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            if (origOnCreated) origOnCreated.apply(this, arguments);

            const node = this;

            // --- Dynamic LoRA slot management ---
            if (isLoraNode) {
                setupLoraSlots(node);
            }

            // --- Auth button ---
            const authWidget = node.addWidget("button", "synology_auth", null, () => {
                if (synologyState.authenticated) {
                    doLogout();
                } else {
                    showLoginDialog();
                }
            });
            authWidget.serialize = false;

            authWidget.onSynologyStateChange = () => {
                authWidget.name = synologyState.authenticated
                    ? `Synology: ${synologyState.user}`
                    : "Login to Synology";
            };
            authWidget.onSynologyStateChange();
            trackedWidgets.add(authWidget);

            // --- Browse folder button ---
            const browseWidget = node.addWidget("button", "synology_browse", null, () => {
                if (!synologyState.authenticated) {
                    showLoginDialog();
                    return;
                }
                showFolderBrowser(folderKey);
            });
            browseWidget.serialize = false;

            browseWidget.onSynologyStateChange = () => {
                const p = synologyState.folderPaths[folderKey];
                browseWidget.name = synologyState.authenticated && p
                    ? `\uD83D\uDCC2 ${p}`
                    : `Browse NAS for ${folderKey}`;
            };
            browseWidget.onSynologyStateChange();
            trackedWidgets.add(browseWidget);

            // --- Cleanup ---
            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                trackedWidgets.delete(authWidget);
                trackedWidgets.delete(browseWidget);
                if (origOnRemoved) origOnRemoved.apply(this, arguments);
            };
        };
    },
});
