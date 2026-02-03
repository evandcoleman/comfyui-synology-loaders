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
// Dynamic LoRA slot visibility
// ---------------------------------------------------------------------------

const LORA_SLOT_RE = /^(?:lora|strength)_(\d+)$/;

function hideWidget(widget) {
    if (widget._synHidden) return;
    widget._synHidden = true;
    widget._synOrigType = widget.type;
    widget._synOrigComputeSize = widget.computeSize;
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
}

function showWidget(widget) {
    if (!widget._synHidden) return;
    widget._synHidden = false;
    widget.type = widget._synOrigType;
    if (widget._synOrigComputeSize) {
        widget.computeSize = widget._synOrigComputeSize;
    } else {
        delete widget.computeSize;
    }
}

function updateLoraSlots(node) {
    const countWidget = node.widgets.find(w => w.name === "lora_count");
    if (!countWidget) return;
    const count = countWidget.value;

    for (const w of node.widgets) {
        const m = w.name.match(LORA_SLOT_RE);
        if (!m) continue;
        const idx = parseInt(m[1]);
        if (idx <= count) {
            showWidget(w);
        } else {
            hideWidget(w);
        }
    }

    node.setSize(node.computeSize());
}

function setupLoraSlots(node) {
    // Remove optional input connection slots for dynamic lora/strength widgets
    if (node.inputs) {
        node.inputs = node.inputs.filter(input => !LORA_SLOT_RE.test(input.name));
    }

    // Watch lora_count for changes
    const countWidget = node.widgets.find(w => w.name === "lora_count");
    if (countWidget) {
        const origCb = countWidget.callback;
        countWidget.callback = function (v) {
            if (origCb) origCb.call(this, v);
            updateLoraSlots(node);
        };
    }

    // Re-apply visibility after workflow load restores widget values
    const origConfigure = node.configure;
    node.configure = function (data) {
        origConfigure?.call(this, data);
        updateLoraSlots(node);
    };

    // Initial update
    updateLoraSlots(node);
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
        }
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!SYNOLOGY_NODE_TYPES.includes(nodeData.name)) return;

        const folderKey = NODE_FOLDER_MAP[nodeData.name];
        const isLoraNode = nodeData.name === "SynologyLoRALoader";
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
