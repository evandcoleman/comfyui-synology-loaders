import asyncio
import logging
from aiohttp import web

from .nodes import (
    SynologyCheckpointLoader,
    SynologyLoRALoader,
    SynologyVAELoader,
    SynologyControlNetLoader,
)
from .client import get_client, SynologyAuthError, SynologyError

logger = logging.getLogger("comfyui-synology")

# ---------------------------------------------------------------------------
# Node Registration
# ---------------------------------------------------------------------------

NODE_CLASS_MAPPINGS = {
    "SynologyCheckpointLoader": SynologyCheckpointLoader,
    "SynologyLoRALoader": SynologyLoRALoader,
    "SynologyVAELoader": SynologyVAELoader,
    "SynologyControlNetLoader": SynologyControlNetLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SynologyCheckpointLoader": "Load Checkpoint (Synology)",
    "SynologyLoRALoader": "Load LoRA x3 (Synology)",
    "SynologyVAELoader": "Load VAE (Synology)",
    "SynologyControlNetLoader": "Load ControlNet (Synology)",
}

WEB_DIRECTORY = "./js"

# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

ALLOWED_FOLDERS = {"checkpoints", "loras", "vae", "controlnet"}

try:
    from server import PromptServer

    @PromptServer.instance.routes.get("/synology/status")
    async def synology_status(request):
        loop = asyncio.get_event_loop()
        client = await loop.run_in_executor(None, get_client)
        return web.json_response({
            "authenticated": client.authenticated,
            "user": client.username,
            "api_url": client.api_url,
        })

    @PromptServer.instance.routes.post("/synology/login")
    async def synology_login(request):
        data = await request.json()
        api_url = data.get("api_url", "").strip()
        username = data.get("username", "").strip()
        password = data.get("password", "")

        if not api_url or not username or not password:
            return web.json_response(
                {"error": "api_url, username, and password are required"},
                status=400,
            )

        loop = asyncio.get_event_loop()
        try:
            client = await loop.run_in_executor(None, get_client)
            await loop.run_in_executor(None, lambda: client.login(username, password, api_url, persist=True))
            return web.json_response({
                "authenticated": True,
                "user": client.username,
            })
        except SynologyAuthError as e:
            return web.json_response({"error": str(e)}, status=401)
        except Exception as e:
            logger.error(f"Login error: {e}")
            return web.json_response({"error": f"Connection failed: {e}"}, status=502)

    @PromptServer.instance.routes.post("/synology/logout")
    async def synology_logout(request):
        loop = asyncio.get_event_loop()
        client = await loop.run_in_executor(None, get_client)
        await loop.run_in_executor(None, client.logout)
        return web.json_response({"authenticated": False})

    @PromptServer.instance.routes.get("/synology/browse")
    async def synology_browse(request):
        path = request.query.get("path", "/")
        loop = asyncio.get_event_loop()
        try:
            client = await loop.run_in_executor(None, get_client)
            dirs = await loop.run_in_executor(None, client.list_directory, path)
            return web.json_response({"path": path, "directories": dirs})
        except SynologyAuthError as e:
            return web.json_response({"error": str(e)}, status=401)
        except SynologyError as e:
            return web.json_response({"error": str(e)}, status=500)
        except Exception as e:
            logger.error(f"Browse error for path {path}: {e}")
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/synology/folder-path")
    async def synology_set_folder_path(request):
        data = await request.json()
        folder = data.get("folder", "")
        path = data.get("path", "")

        if folder not in ALLOWED_FOLDERS:
            return web.json_response(
                {"error": f"Invalid folder. Allowed: {', '.join(sorted(ALLOWED_FOLDERS))}"},
                status=400,
            )
        if not path:
            return web.json_response({"error": "path is required"}, status=400)

        loop = asyncio.get_event_loop()
        client = await loop.run_in_executor(None, get_client)
        await loop.run_in_executor(None, client.set_folder_path, folder, path)
        return web.json_response({
            "folder": folder,
            "path": client.get_folder_path(folder),
        })

    @PromptServer.instance.routes.get("/synology/folder-paths")
    async def synology_get_folder_paths(request):
        loop = asyncio.get_event_loop()
        client = await loop.run_in_executor(None, get_client)
        paths = {f: client.get_folder_path(f) for f in sorted(ALLOWED_FOLDERS)}
        return web.json_response(paths)

    @PromptServer.instance.routes.get("/synology/models/{folder}")
    async def synology_models(request):
        folder = request.match_info["folder"]
        if folder not in ALLOWED_FOLDERS:
            return web.json_response(
                {"error": f"Invalid folder. Allowed: {', '.join(sorted(ALLOWED_FOLDERS))}"},
                status=400,
            )

        loop = asyncio.get_event_loop()
        try:
            client = await loop.run_in_executor(None, get_client)
            models = await loop.run_in_executor(None, client.list_models, folder)
            return web.json_response({"models": models})
        except SynologyAuthError as e:
            return web.json_response({"error": str(e)}, status=401)
        except SynologyError as e:
            return web.json_response({"error": str(e)}, status=500)
        except Exception as e:
            logger.error(f"Models list error for {folder}: {e}")
            return web.json_response({"error": str(e)}, status=500)

except ImportError:
    logger.warning("PromptServer not available — API routes not registered")
