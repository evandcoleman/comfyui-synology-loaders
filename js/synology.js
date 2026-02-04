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
// Dynamic LoRA slot management (rgthree-style architecture)
// ---------------------------------------------------------------------------

// -- Canvas drawing helpers ------------------------------------------------

function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
    } else {
        ctx.beginPath();
        ctx.rect(x, y, w, h);
    }
}

function drawSwitch(ctx, x, y, on, partial) {
    const W = SWITCH_W;
    const H = SWITCH_H;
    const R = H / 2;
    const knobR = R - 2;

    ctx.fillStyle = on ? "#4a9eff" : partial ? "rgba(74,158,255,0.35)" : "#555";
    roundRect(ctx, x, y, W, H, [R]);
    ctx.fill();

    const knobX = on || partial ? x + W - R : x + R;
    ctx.fillStyle = "#eee";
    ctx.beginPath();
    ctx.arc(knobX, y + R, knobR, 0, Math.PI * 2);
    ctx.fill();
}

function truncateText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    const ellipsis = "\u2026";
    while (text.length > 1 && ctx.measureText(text + ellipsis).width > maxWidth) {
        text = text.slice(0, -1);
    }
    return text + ellipsis;
}

// -- Zone layout constants -------------------------------------------------

const MARGIN = 15;
const SWITCH_W = 22;
const SWITCH_H = 12;
const SWITCH_PAD = 4;
const ARROW_W = 14;
const STRENGTH_NUM_W = 36;

function loraZones(width) {
    const switchX = MARGIN + SWITCH_PAD;
    const nameX = switchX + SWITCH_W + 8;
    const arrowRightEnd = width - MARGIN;
    const arrowRightX = arrowRightEnd - ARROW_W;
    const numEnd = arrowRightX;
    const numX = numEnd - STRENGTH_NUM_W;
    const arrowLeftEnd = numX;
    const arrowLeftX = arrowLeftEnd - ARROW_W;
    const nameEnd = arrowLeftX - 4;
    return {
        toggle:     { x: MARGIN, w: nameX - MARGIN },
        name:       { x: nameX,  w: nameEnd - nameX },
        arrowLeft:  { x: arrowLeftX, w: ARROW_W },
        strengthNum:{ x: numX, w: STRENGTH_NUM_W },
        arrowRight: { x: arrowRightX, w: ARROW_W },
    };
}

// -- Interaction helpers ---------------------------------------------------

function showLoraDropdown(event, widget, node) {
    const values = loraValues.map(v => ({
        content: v === "None" ? "None" : v.replace(/\.[^.]+$/, ""),
        callback: () => {
            widget.value = { ...widget.value, lora: v, on: v !== "None" };
            node.setDirtyCanvas(true);
        }
    }));
    new LiteGraph.ContextMenu(values, {
        event: event,
        scale: app.canvas.ds?.scale || 1,
    });
}

function showStrengthInput(event, widget, node) {
    const input = document.createElement("input");
    input.type = "number";
    input.value = widget.value.strength.toFixed(2);
    input.step = "0.05";
    input.min = "-20";
    input.max = "20";
    Object.assign(input.style, {
        position: "fixed",
        left: (event.clientX - 40) + "px",
        top: (event.clientY - 12) + "px",
        width: "60px",
        padding: "4px 6px",
        border: "1px solid #4a9eff",
        borderRadius: "4px",
        background: "#1a1a1a",
        color: "#eee",
        fontSize: "13px",
        zIndex: "20000",
        textAlign: "center",
        outline: "none",
    });

    function apply() {
        const v = parseFloat(input.value);
        if (!isNaN(v)) {
            widget.value = { ...widget.value, strength: Math.max(-20, Math.min(20, v)) };
        }
        input.remove();
        node.setDirtyCanvas(true);
    }

    input.onblur = apply;
    input.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); apply(); }
        if (e.key === "Escape") input.remove();
    };

    document.body.appendChild(input);
    input.focus();
    input.select();
}

// -- Widget factories ------------------------------------------------------

function getLoraWidgets(node) {
    return (node.widgets || []).filter(w => w.name.startsWith("lora_") && w._isLoraSlot);
}

function createLoraWidget(node, index, initialValue) {
    const val = initialValue || { on: true, lora: "None", strength: 1.0 };
    // Create as combo (for addWidget initialization), then change type to prevent
    // LiteGraph's combo-specific processing from resetting our object value
    const w = node.addWidget("combo", `lora_${index}`, "None", null, { values: loraValues });
    w.type = "lora_slot";
    w.value = val;
    w._isLoraSlot = true;
    w._lastStrengthClick = 0;

    w.draw = function (ctx, _node, width, y, H) {
        this.last_y = y;
        const z = loraZones(width);
        const switchX = MARGIN + SWITCH_PAD;
        const switchY = y + (H - SWITCH_H) / 2;
        const v = this.value;
        const on = v.on !== false;

        // background
        ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR || "#2a2a2a";
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR || "#666";
        roundRect(ctx, MARGIN, y, width - MARGIN * 2, H, [4]);
        ctx.fill();
        ctx.stroke();

        // toggle switch
        drawSwitch(ctx, switchX, switchY, on, false);

        const savedAlpha = ctx.globalAlpha;
        if (!on) ctx.globalAlpha = 0.4;

        // LoRA name
        const rawName = v.lora === "None" ? "None" : v.lora.replace(/\.[^.]+$/, "");
        ctx.fillStyle = on ? (LiteGraph.WIDGET_TEXT_COLOR || "#ddd") : "#666";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(truncateText(ctx, rawName, z.name.w), z.name.x, y + H / 2);

        // left arrow
        ctx.fillStyle = LiteGraph.WIDGET_SECONDARY_TEXT_COLOR || "#999";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("\u25C0", z.arrowLeft.x + z.arrowLeft.w / 2, y + H / 2);

        // strength value
        ctx.fillStyle = on ? (LiteGraph.WIDGET_SECONDARY_TEXT_COLOR || "#999") : "#555";
        ctx.font = "11px monospace";
        ctx.textAlign = "center";
        ctx.fillText(v.strength.toFixed(2), z.strengthNum.x + z.strengthNum.w / 2, y + H / 2);

        // right arrow
        ctx.fillStyle = LiteGraph.WIDGET_SECONDARY_TEXT_COLOR || "#999";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("\u25B6", z.arrowRight.x + z.arrowRight.w / 2, y + H / 2);

        ctx.globalAlpha = savedAlpha;
    };

    w.mouse = function (event, pos) {
        const t = event.type;
        if (t === "pointerdown" || t === "mousedown") return true;
        if (t !== "pointerup" && t !== "mouseup") return false;
        const x = pos[0];
        const z = loraZones(node.size[0]);

        // toggle switch
        if (x < z.toggle.x + z.toggle.w) {
            this.value = { ...this.value, on: !this.value.on };
            node.setDirtyCanvas(true);
            return true;
        }
        // left arrow — decrement strength
        if (x >= z.arrowLeft.x && x < z.arrowLeft.x + z.arrowLeft.w) {
            const s = Math.max(-20, this.value.strength - 0.05);
            this.value = { ...this.value, strength: Math.round(s * 100) / 100 };
            node.setDirtyCanvas(true);
            return true;
        }
        // strength number — double-click to open inline input
        if (x >= z.strengthNum.x && x < z.strengthNum.x + z.strengthNum.w) {
            const now = Date.now();
            if (now - this._lastStrengthClick < 300) {
                this._lastStrengthClick = 0;
                showStrengthInput(event, this, node);
            } else {
                this._lastStrengthClick = now;
            }
            return true;
        }
        // right arrow — increment strength
        if (x >= z.arrowRight.x && x < z.arrowRight.x + z.arrowRight.w) {
            const s = Math.min(20, this.value.strength + 0.05);
            this.value = { ...this.value, strength: Math.round(s * 100) / 100 };
            node.setDirtyCanvas(true);
            return true;
        }
        // name zone — open dropdown
        showLoraDropdown(event, this, node);
        return true;
    };

    w.serializeValue = function () {
        return this.value;
    };

    return w;
}

function createToggleAllWidget(node) {
    const w = node.addWidget("combo", "toggle_all", "", null, { values: [] });
    w.type = "lora_toggle_all";
    w.serialize = false;
    w._isToggleAll = true;

    w.draw = function (ctx, _node, width, y, H) {
        this.last_y = y;
        const switchX = MARGIN + SWITCH_PAD;
        const switchY = y + (H - SWITCH_H) / 2;
        const z = loraZones(width);
        const loraW = getLoraWidgets(node);
        const allOn = loraW.length > 0 && loraW.every(lw => lw.value.on !== false);
        const someOn = loraW.some(lw => lw.value.on !== false);

        ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR || "#2a2a2a";
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR || "#666";
        roundRect(ctx, MARGIN, y, width - MARGIN * 2, H, [4]);
        ctx.fill();
        ctx.stroke();

        drawSwitch(ctx, switchX, switchY, allOn, !allOn && someOn);

        ctx.fillStyle = LiteGraph.WIDGET_SECONDARY_TEXT_COLOR || "#999";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText("Toggle All", z.name.x, y + H / 2);
    };

    w.mouse = function (event) {
        const t = event.type;
        if (t === "pointerdown" || t === "mousedown") return true;
        if (t !== "pointerup" && t !== "mouseup") return false;
        const loraW = getLoraWidgets(node);
        const allOn = loraW.length > 0 && loraW.every(lw => lw.value.on !== false);
        const newState = !allOn;
        for (const lw of loraW) {
            lw.value = { ...lw.value, on: newState };
        }
        node.setDirtyCanvas(true);
        return true;
    };

    return w;
}

function createAddLoraButton(node) {
    const btn = node.addWidget("button", "add_lora", "Add LoRA", () => {
        const loraW = getLoraWidgets(node);
        const newIndex = loraW.length + 1;
        const newW = createLoraWidget(node, newIndex, { on: true, lora: "None", strength: 1.0 });
        // Move new widget before the Add LoRA button
        const widgets = node.widgets;
        const newWIdx = widgets.indexOf(newW);
        const btnIdx = widgets.indexOf(btn);
        if (newWIdx > btnIdx) {
            widgets.splice(newWIdx, 1);
            widgets.splice(btnIdx, 0, newW);
        }
        fitNodeHeight(node);
        node.setDirtyCanvas(true);
    });
    btn.serialize = false;
    btn._isAddLora = true;
    return btn;
}

// -- Renumber lora widget names to keep them sequential --------------------

function fitNodeHeight(node) {
    const computed = node.computeSize();
    node.setSize([node.size[0], computed[1]]);
}

function renumberLoraWidgets(node) {
    const loraW = getLoraWidgets(node);
    for (let i = 0; i < loraW.length; i++) {
        loraW[i].name = `lora_${i + 1}`;
    }
}

// -- Setup & lifecycle -----------------------------------------------------

function setupLoraNode(node) {
    // Remove any auto-created optional widgets/inputs from FlexibleOptionalInputType
    node.widgets = (node.widgets || []).filter(w =>
        w.name === "model" || w.name === "clip" ||
        w.name === "synology_auth" || w.name === "synology_browse"
    );
    if (node.inputs) {
        node.inputs = node.inputs.filter(input =>
            input.name === "model" || input.name === "clip"
        );
    }

    // Create Toggle All
    createToggleAllWidget(node);

    // Create one default LoRA slot
    createLoraWidget(node, 1, { on: true, lora: "None", strength: 1.0 });

    // Create Add LoRA button
    createAddLoraButton(node);

    fitNodeHeight(node);

    // Workflow load — restore slots from saved widget values
    const origConfigure = node.configure;
    node.configure = function (info) {
        // Strip dynamic LoRA widgets before configure restores values
        node.widgets = (node.widgets || []).filter(w =>
            !w._isLoraSlot && !w._isToggleAll && !w._isAddLora
        );
        if (node.inputs) {
            node.inputs = node.inputs.filter(input =>
                input.name === "model" || input.name === "clip"
            );
        }

        origConfigure?.call(this, info);

        // Rebuild from saved widgets_values
        const savedValues = info.widgets_values || [];
        const loraSlotValues = savedValues.filter(
            v => v && typeof v === "object" && "lora" in v
        );

        createToggleAllWidget(node);

        if (loraSlotValues.length > 0) {
            for (let i = 0; i < loraSlotValues.length; i++) {
                const sv = loraSlotValues[i];
                createLoraWidget(node, i + 1, {
                    on: sv.on !== false,
                    lora: sv.lora || "None",
                    strength: typeof sv.strength === "number" ? sv.strength : 1.0,
                });
            }
        } else {
            createLoraWidget(node, 1, { on: true, lora: "None", strength: 1.0 });
        }

        createAddLoraButton(node);
        fitNodeHeight(node);
    };

    // Right-click context menu
    const origGetExtraMenuOptions = node.getExtraMenuOptions;
    node.getExtraMenuOptions = function (canvas, options) {
        if (origGetExtraMenuOptions) origGetExtraMenuOptions.call(this, canvas, options);

        const nodeY = canvas.graph_mouse[1] - node.pos[1];
        const widgetH = LiteGraph.NODE_WIDGET_HEIGHT || 20;

        const loraW = getLoraWidgets(node);
        let slotIdx = -1;
        for (let i = 0; i < loraW.length; i++) {
            const ly = loraW[i].last_y;
            if (ly == null) continue;
            if (nodeY >= ly && nodeY < ly + widgetH) { slotIdx = i; break; }
        }
        if (slotIdx < 0) return;

        const menuItems = [];

        // Toggle On/Off
        const isOn = loraW[slotIdx].value.on !== false;
        menuItems.push({
            content: isOn ? "Disable LoRA" : "Enable LoRA",
            callback: () => {
                loraW[slotIdx].value = { ...loraW[slotIdx].value, on: !isOn };
                node.setDirtyCanvas(true);
            },
        });

        if (slotIdx > 0) {
            menuItems.push({
                content: "Move LoRA Up",
                callback: () => {
                    const widgets = node.widgets;
                    const aIdx = widgets.indexOf(loraW[slotIdx - 1]);
                    const bIdx = widgets.indexOf(loraW[slotIdx]);
                    [widgets[aIdx], widgets[bIdx]] = [widgets[bIdx], widgets[aIdx]];
                    renumberLoraWidgets(node);
                    node.setDirtyCanvas(true);
                },
            });
        }

        if (slotIdx < loraW.length - 1) {
            menuItems.push({
                content: "Move LoRA Down",
                callback: () => {
                    const widgets = node.widgets;
                    const aIdx = widgets.indexOf(loraW[slotIdx]);
                    const bIdx = widgets.indexOf(loraW[slotIdx + 1]);
                    [widgets[aIdx], widgets[bIdx]] = [widgets[bIdx], widgets[aIdx]];
                    renumberLoraWidgets(node);
                    node.setDirtyCanvas(true);
                },
            });
        }

        menuItems.push({
            content: "Remove LoRA",
            callback: () => {
                const idx = node.widgets.indexOf(loraW[slotIdx]);
                if (idx >= 0) node.widgets.splice(idx, 1);
                renumberLoraWidgets(node);
                fitNodeHeight(node);
                node.setDirtyCanvas(true);
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

        const origOnCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            if (origOnCreated) origOnCreated.apply(this, arguments);

            const node = this;

            // --- Dynamic LoRA slot management ---
            if (isLoraNode) {
                setupLoraNode(node);
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
