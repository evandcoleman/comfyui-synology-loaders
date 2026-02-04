# ComfyUI Synology Loaders

Custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) that load models directly from a Synology NAS via the FileStation API. Models are downloaded on demand and cached locally.

## Nodes

- **Load Checkpoint (Synology)** - Load checkpoint models from your NAS
- **Load LoRA (Synology)** - Load multiple LoRAs with per-slot toggles and strength controls
- **Load VAE (Synology)** - Load VAE models from your NAS
- **Load ControlNet (Synology)** - Load ControlNet models from your NAS

## Features

- Browse and select models stored on your Synology NAS
- Automatic local caching (models are only downloaded once)
- In-node login/logout for NAS authentication
- Folder browser to configure custom NAS paths per model type
- **LoRA loader**: add/remove slots dynamically, per-slot toggle switches, inline strength adjustment with arrow controls, collapsible folder tree in the dropdown, right-click context menu for move/remove, Toggle All switch

## Installation

Clone this repository into your ComfyUI `custom_nodes` directory:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/evandcoleman/comfyui-synology-loaders.git
cd comfyui-synology-loaders
pip install -r requirements.txt
```

## Configuration

You can configure the connection in three ways:

### 1. In-node login (recommended)

Click the **Login to Synology** button on any Synology loader node, enter your NAS URL, username, and password. Credentials are saved to `config.yaml` for future sessions.

### 2. Config file

Copy `config.yaml.example` to `config.yaml` and fill in your values:

```yaml
api_url: "https://your-nas:5001"
username: "admin"
password: "your-password"
models_base_path: "/volume1/models"
```

### 3. Environment variables

```bash
export SYNOLOGY_API_URL="https://your-nas:5001"
export SYNOLOGY_USERNAME="admin"
export SYNOLOGY_PASSWORD="your-password"
```

Environment variables take priority over `config.yaml` values.

## Folder paths

By default, models are expected at `<models_base_path>/<type>` (e.g. `/volume1/models/loras`). You can override this per model type using the folder browser button on each node, or by setting `folder_paths` in `config.yaml`.

## License

MIT
