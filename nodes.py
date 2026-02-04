import os
import logging
from .client import get_client, SynologyAuthError

logger = logging.getLogger("comfyui-synology")

# ---------------------------------------------------------------------------
# Flexible input type helpers (for dynamic LoRA inputs)
# ---------------------------------------------------------------------------

class AnyType(str):
    """Matches any ComfyUI type for flexible inputs."""
    def __ne__(self, __value):
        return False

any_type = AnyType("*")

class FlexibleOptionalInputType(dict):
    """Dict that accepts any key, returning (any_type,) for unknowns."""
    def __contains__(self, key):
        return True
    def __getitem__(self, key):
        return (any_type,)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_model_list(folder):
    """Fetch model list from Synology, with graceful fallback."""
    try:
        client = get_client()
        if not client.authenticated:
            return ["(login required)"]
        models = client.list_models(folder)
        return models if models else ["(no models found)"]
    except SynologyAuthError:
        return ["(login required)"]
    except Exception as e:
        logger.warning(f"Failed to list models in {folder}: {e}")
        return ["(error loading models)"]

# ---------------------------------------------------------------------------
# Checkpoint Loader
# ---------------------------------------------------------------------------

class SynologyCheckpointLoader:
    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("model", "clip", "vae")
    FUNCTION = "load"
    CATEGORY = "loaders/synology"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ckpt_name": (_get_model_list("checkpoints"),),
            }
        }

    @classmethod
    def IS_CHANGED(cls, ckpt_name):
        return get_client().auth_version

    def load(self, ckpt_name):
        import comfy.sd
        import comfy.utils
        client = get_client()
        pbar = comfy.utils.ProgressBar(100)
        def on_progress(downloaded, total):
            pbar.update_absolute(int(downloaded * 100 / total), 100)
        local_path = client.download_model("checkpoints", ckpt_name, progress_callback=on_progress)
        return comfy.sd.load_checkpoint_guess_config(local_path)[:3]

# ---------------------------------------------------------------------------
# LoRA Loader (single)
# ---------------------------------------------------------------------------

class SynologyLoRALoader:
    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("model", "clip")
    FUNCTION = "load"
    CATEGORY = "loaders/synology"

    def __init__(self):
        self.loaded_lora = None
        self.loaded_lora_name = None

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "lora_name": (_get_model_list("loras"),),
                "strength_model": ("FLOAT", {"default": 1.0, "min": -20.0, "max": 20.0, "step": 0.05}),
                "strength_clip": ("FLOAT", {"default": 1.0, "min": -20.0, "max": 20.0, "step": 0.05}),
            },
            "optional": {
                "clip": ("CLIP",),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return get_client().auth_version

    def load(self, model, lora_name, strength_model, strength_clip, clip=None):
        import comfy.utils
        import comfy.sd

        if self.loaded_lora_name != lora_name:
            client = get_client()
            pbar = comfy.utils.ProgressBar(100)
            def on_progress(downloaded, total):
                pbar.update_absolute(int(downloaded * 100 / total), 100)
            local_path = client.download_model("loras", lora_name, progress_callback=on_progress)
            self.loaded_lora = comfy.utils.load_torch_file(local_path, safe_load=True)
            self.loaded_lora_name = lora_name

        return comfy.sd.load_lora_for_models(model, clip, self.loaded_lora, strength_model, strength_clip)

# ---------------------------------------------------------------------------
# Multi-LoRA Loader (Power LoRA style)
# ---------------------------------------------------------------------------

class SynologyMultiLoRALoader:
    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("model", "clip")
    FUNCTION = "load"
    CATEGORY = "loaders/synology"

    def __init__(self):
        self.loaded_loras = {}  # name -> loaded lora data

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
            },
            "optional": FlexibleOptionalInputType({
                "clip": ("CLIP",),
            }),
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return get_client().auth_version

    def load(self, model, clip=None, **kwargs):
        import comfy.utils
        import comfy.sd

        for key in sorted(kwargs.keys()):
            if not key.startswith("lora_"):
                continue

            value = kwargs[key]

            # Accept structured {on, lora, strength, strengthTwo} dicts from the frontend
            if isinstance(value, dict):
                on = value.get("on", True)
                lora_name = value.get("lora", "None")
                strength_model = value.get("strength", 1.0)
                strength_clip = value.get("strengthTwo") if value.get("strengthTwo") is not None else strength_model
            else:
                # Fallback for plain string values
                on = True
                lora_name = str(value)
                strength_model = 1.0
                strength_clip = 1.0

            if not on or lora_name == "None":
                continue
            if clip is None:
                strength_clip = 0

            if lora_name not in self.loaded_loras:
                client = get_client()
                pbar = comfy.utils.ProgressBar(100)
                def on_progress(downloaded, total):
                    pbar.update_absolute(int(downloaded * 100 / total), 100)
                local_path = client.download_model("loras", lora_name, progress_callback=on_progress)
                self.loaded_loras[lora_name] = comfy.utils.load_torch_file(local_path, safe_load=True)

            if strength_model != 0 or strength_clip != 0:
                model, clip = comfy.sd.load_lora_for_models(
                    model, clip, self.loaded_loras[lora_name], strength_model, strength_clip,
                )

        return (model, clip)

# ---------------------------------------------------------------------------
# VAE Loader
# ---------------------------------------------------------------------------

class SynologyVAELoader:
    RETURN_TYPES = ("VAE",)
    RETURN_NAMES = ("vae",)
    FUNCTION = "load"
    CATEGORY = "loaders/synology"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae_name": (_get_model_list("vae"),),
            }
        }

    @classmethod
    def IS_CHANGED(cls, vae_name):
        return get_client().auth_version

    def load(self, vae_name):
        import comfy.utils
        import comfy.sd

        client = get_client()
        pbar = comfy.utils.ProgressBar(100)
        def on_progress(downloaded, total):
            pbar.update_absolute(int(downloaded * 100 / total), 100)
        local_path = client.download_model("vae", vae_name, progress_callback=on_progress)
        sd = comfy.utils.load_torch_file(local_path)
        return (comfy.sd.VAE(sd=sd),)

# ---------------------------------------------------------------------------
# ControlNet Loader
# ---------------------------------------------------------------------------

class SynologyControlNetLoader:
    RETURN_TYPES = ("CONTROL_NET",)
    RETURN_NAMES = ("control_net",)
    FUNCTION = "load"
    CATEGORY = "loaders/synology"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "control_net_name": (_get_model_list("controlnet"),),
            }
        }

    @classmethod
    def IS_CHANGED(cls, control_net_name):
        return get_client().auth_version

    def load(self, control_net_name):
        import comfy.controlnet
        import comfy.utils

        client = get_client()
        pbar = comfy.utils.ProgressBar(100)
        def on_progress(downloaded, total):
            pbar.update_absolute(int(downloaded * 100 / total), 100)
        local_path = client.download_model("controlnet", control_net_name, progress_callback=on_progress)
        return (comfy.controlnet.load_controlnet(local_path),)

# ---------------------------------------------------------------------------
# Clear Cache
# ---------------------------------------------------------------------------

class SynologyClearCache:
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("status",)
    FUNCTION = "clear"
    CATEGORY = "loaders/synology"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "confirm": ("BOOLEAN", {"default": False}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def clear(self, confirm):
        if not confirm:
            client = get_client()
            cache_dir = client.cache_dir
            total = 0
            if os.path.isdir(cache_dir):
                for dirpath, _dirnames, filenames in os.walk(cache_dir):
                    for f in filenames:
                        total += os.path.getsize(os.path.join(dirpath, f))
            size_mb = total / (1024 * 1024)
            return (f"Cache: {size_mb:.1f} MB — set confirm to true to clear",)

        client = get_client()
        freed = client.clear_cache()
        freed_mb = freed / (1024 * 1024)
        return (f"Cleared {freed_mb:.1f} MB",)
