import logging
from .client import get_client, SynologyAuthError

logger = logging.getLogger("comfyui-synology")

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
        client = get_client()
        local_path = client.download_model("checkpoints", ckpt_name)
        return comfy.sd.load_checkpoint_guess_config(local_path)[:3]

# ---------------------------------------------------------------------------
# LoRA Loader
# ---------------------------------------------------------------------------

MAX_LORA_SLOTS = 20

class SynologyLoRALoader:
    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("model", "clip")
    FUNCTION = "load"
    CATEGORY = "loaders/synology"

    def __init__(self):
        self.loaded_loras = {}  # name -> loaded lora data

    @classmethod
    def INPUT_TYPES(cls):
        lora_list = ["None"] + _get_model_list("loras")
        inputs = {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
            },
            "optional": {},
        }
        for i in range(1, MAX_LORA_SLOTS + 1):
            inputs["optional"][f"lora_{i}"] = (lora_list,)
            inputs["optional"][f"strength_{i}"] = ("FLOAT", {
                "default": 1.0, "min": -20.0, "max": 20.0, "step": 0.01,
            })
        return inputs

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return get_client().auth_version

    def load(self, model, clip, **kwargs):
        import comfy.utils
        import comfy.sd

        for i in range(1, MAX_LORA_SLOTS + 1):
            lora_name = kwargs.get(f"lora_{i}", "None")
            strength = kwargs.get(f"strength_{i}", 1.0)

            if lora_name == "None":
                continue

            if lora_name not in self.loaded_loras:
                client = get_client()
                local_path = client.download_model("loras", lora_name)
                self.loaded_loras[lora_name] = comfy.utils.load_torch_file(local_path, safe_load=True)

            model, clip = comfy.sd.load_lora_for_models(
                model, clip, self.loaded_loras[lora_name], strength, strength,
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
        local_path = client.download_model("vae", vae_name)
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

        client = get_client()
        local_path = client.download_model("controlnet", control_net_name)
        return (comfy.controlnet.load_controlnet(local_path),)
