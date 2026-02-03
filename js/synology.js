import { app } from "../../scripts/app.js";

const SYNOLOGY_NODE_TYPES = [
    "SynologyCheckpointLoader",
    "SynologyLoRALoader",
    "SynologyVAELoader",
    "SynologyControlNetLoader",
];

const synologyState = {
    authenticated: false,
    user: null,
    api_url: null,
};

const trackedButtons = new Set();

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

function updateAllButtons() {
    for (const widget of trackedButtons) {
        if (widget.onSynologyStateChange) {
            widget.onSynologyStateChange();
        }
    }
}

// ---------------------------------------------------------------------------
// Login dialog
// ---------------------------------------------------------------------------

function showLoginDialog() {
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

    const dialog = document.createElement("div");
    Object.assign(dialog.style, {
        background: "#2a2a2a",
        borderRadius: "8px",
        padding: "24px",
        minWidth: "320px",
        maxWidth: "400px",
        color: "#eee",
        fontFamily: "sans-serif",
        boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
    });

    const title = document.createElement("h3");
    title.textContent = "Login to Synology NAS";
    Object.assign(title.style, { margin: "0 0 16px 0", fontSize: "16px" });

    const errorDiv = document.createElement("div");
    Object.assign(errorDiv.style, {
        color: "#ff6b6b",
        marginBottom: "12px",
        fontSize: "13px",
        display: "none",
    });

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

    const apiUrl = makeField("API URL", "text", "https://your-nas:5001");
    const username = makeField("Username", "text", "admin");
    const password = makeField("Password", "password", "");

    // Pre-fill API URL if we have one from a previous session
    if (synologyState.api_url) {
        apiUrl.input.value = synologyState.api_url;
    }

    const btnRow = document.createElement("div");
    Object.assign(btnRow.style, {
        display: "flex",
        justifyContent: "flex-end",
        gap: "8px",
        marginTop: "16px",
    });

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

    const cancelBtn = makeButton("Cancel", false);
    const loginBtn = makeButton("Login", true);

    cancelBtn.onclick = () => overlay.remove();
    overlay.onclick = (e) => {
        if (e.target === overlay) overlay.remove();
    };

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
            updateAllButtons();

            // Refresh dropdowns on all nodes
            if (app.refreshComboInNodes) {
                app.refreshComboInNodes();
            }
        } catch (e) {
            errorDiv.textContent = "Connection failed: " + e.message;
            errorDiv.style.display = "block";
            loginBtn.disabled = false;
            loginBtn.textContent = "Login";
        }
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(loginBtn);

    dialog.appendChild(title);
    dialog.appendChild(errorDiv);
    dialog.appendChild(apiUrl.container);
    dialog.appendChild(username.container);
    dialog.appendChild(password.container);
    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Focus first empty field
    if (!apiUrl.input.value) {
        apiUrl.input.focus();
    } else {
        username.input.focus();
    }
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
    updateAllButtons();

    if (app.refreshComboInNodes) {
        app.refreshComboInNodes();
    }
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
    name: "Comfy.Synology",

    async setup() {
        await fetchStatus();
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!SYNOLOGY_NODE_TYPES.includes(nodeData.name)) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origOnCreated) {
                origOnCreated.apply(this, arguments);
            }

            const node = this;
            const widget = node.addWidget("button", "synology_auth", null, () => {
                if (synologyState.authenticated) {
                    doLogout();
                } else {
                    showLoginDialog();
                }
            });

            widget.serialize = false;

            widget.onSynologyStateChange = () => {
                widget.name = synologyState.authenticated
                    ? `Synology: ${synologyState.user}`
                    : "Login to Synology";
            };

            // Set initial label
            widget.onSynologyStateChange();
            trackedButtons.add(widget);

            // Clean up on removal
            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                trackedButtons.delete(widget);
                if (origOnRemoved) origOnRemoved.apply(this, arguments);
            };
        };
    },
});
