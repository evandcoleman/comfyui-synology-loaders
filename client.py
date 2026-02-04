import os
import threading
import logging
import yaml
import requests

logger = logging.getLogger("comfyui-synology")

# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class SynologyError(Exception):
    """Base exception for Synology operations."""

class SynologyAuthError(SynologyError):
    """Authentication failed (bad credentials or missing login)."""

class SynologyAPIError(SynologyError):
    """Synology API returned an error response."""
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code

class SessionExpiredError(SynologyError):
    """Session ID is no longer valid (error code 119)."""

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _config_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.yaml")

def load_config():
    """Load config from config.yaml, then let env vars override."""
    config = {
        "api_url": "",
        "username": "",
        "password": "",
        "models_base_path": "/volume1/models",
        "folder_paths": {},
        "cache_dir": "",
    }
    path = _config_path()
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                file_config = yaml.safe_load(f) or {}
            for key in config:
                if key in file_config and file_config[key]:
                    config[key] = file_config[key]
        except Exception as e:
            logger.warning(f"Failed to read config.yaml: {e}")

    env_map = {
        "SYNOLOGY_API_URL": "api_url",
        "SYNOLOGY_USERNAME": "username",
        "SYNOLOGY_PASSWORD": "password",
    }
    for env_key, config_key in env_map.items():
        val = os.environ.get(env_key)
        if val:
            config[config_key] = val

    return config


def save_config(config):
    """Write config dict back to config.yaml."""
    path = _config_path()
    try:
        with open(path, "w") as f:
            yaml.safe_dump(config, f, default_flow_style=False, sort_keys=False)
        logger.info(f"Saved config to {path}")
    except Exception as e:
        logger.warning(f"Failed to save config.yaml: {e}")

# ---------------------------------------------------------------------------
# Cache directory
# ---------------------------------------------------------------------------

def _default_cache_dir():
    try:
        import folder_paths
        return os.path.join(folder_paths.models_dir, "synology_cache")
    except ImportError:
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")

# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class SynologyClient:
    def __init__(self, cache_dir=None):
        self._lock = threading.Lock()
        self._sid = None
        self._api_url = None
        self._username = None
        self._password = None
        self._models_base_path = "/volume1/models"
        self._folder_paths = {}  # folder -> custom NAS path
        self._cache_dir = cache_dir or _default_cache_dir()
        self._model_cache = {}  # folder -> [filenames]
        self._auth_version = 0

    # -- public properties --------------------------------------------------

    @property
    def auth_version(self):
        return self._auth_version

    @property
    def authenticated(self):
        return self._sid is not None

    @property
    def username(self):
        return self._username

    @property
    def api_url(self):
        return self._api_url

    # -- config persistence -------------------------------------------------

    def _persist_config(self):
        """Save current credentials and folder paths to config.yaml."""
        config = load_config()
        config["api_url"] = self._api_url or ""
        config["username"] = self._username or ""
        config["password"] = self._password or ""
        config["folder_paths"] = dict(self._folder_paths)
        save_config(config)

    # -- auth ---------------------------------------------------------------

    def login(self, username, password, api_url=None, persist=False):
        with self._lock:
            if api_url:
                self._api_url = api_url.rstrip("/")
            if not self._api_url:
                raise SynologyAuthError("API URL is required")

            self._username = username
            self._password = password

            self._do_login()

            if persist:
                self._persist_config()

    def _do_login(self):
        """Internal login — caller must hold self._lock."""
        resp = requests.get(
            f"{self._api_url}/webapi/auth.cgi",
            params={
                "api": "SYNO.API.Auth",
                "version": "3",
                "method": "login",
                "account": self._username,
                "passwd": self._password,
                "session": "FileStation",
                "format": "sid",
            },
            timeout=15,
            verify=False,
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            code = data.get("error", {}).get("code")
            raise SynologyAuthError(f"Login failed (error code: {code})")

        self._sid = data["data"]["sid"]
        self._model_cache.clear()
        self._auth_version += 1
        logger.info(f"Logged in to Synology as {self._username}")

    def logout(self):
        with self._lock:
            if self._sid and self._api_url:
                try:
                    requests.get(
                        f"{self._api_url}/webapi/auth.cgi",
                        params={
                            "api": "SYNO.API.Auth",
                            "version": "1",
                            "method": "logout",
                            "session": "FileStation",
                            "_sid": self._sid,
                        },
                        timeout=10,
                        verify=False,
                    )
                except Exception:
                    pass  # best-effort

            self._sid = None
            self._username = None
            self._password = None
            self._model_cache.clear()
            self._auth_version += 1
            self._persist_config()
            logger.info("Logged out of Synology")

    # -- session retry wrapper ----------------------------------------------

    def _with_session_retry(self, fn):
        """Execute fn; on error 119 (session expired), re-auth and retry once."""
        try:
            return fn()
        except SessionExpiredError:
            with self._lock:
                if self._username and self._password:
                    logger.info("Session expired, re-authenticating...")
                    self._do_login()
                else:
                    raise SynologyAuthError("Session expired and no credentials available for re-auth")
            return fn()

    # -- API calls ----------------------------------------------------------

    def _resolve_folder_path(self, folder):
        """Return the full NAS path for a folder, using custom path if configured."""
        custom = self._folder_paths.get(folder)
        if custom:
            return custom.rstrip("/")
        return f"{self._models_base_path}/{folder}"

    def _require_auth(self):
        if not self._sid:
            raise SynologyAuthError("Not authenticated — please log in first")

    def _check_response(self, data):
        if not data.get("success"):
            code = data.get("error", {}).get("code")
            if code == 119:
                raise SessionExpiredError("Session expired")
            raise SynologyAPIError(f"API error (code: {code})", code=code)

    def get_folder_path(self, folder):
        """Return the custom NAS path for a folder type, or empty string if not set."""
        return self._folder_paths.get(folder, "")

    def set_folder_path(self, folder, path):
        """Set a custom NAS path for a folder type. Clears cached models for that folder."""
        if path:
            self._folder_paths[folder] = path.rstrip("/")
        else:
            self._folder_paths.pop(folder, None)
        self._model_cache.pop(folder, None)
        self._auth_version += 1
        self._persist_config()

    def list_shares(self):
        """List top-level shared folders (volumes) on the NAS."""
        def _do():
            self._require_auth()
            resp = requests.get(
                f"{self._api_url}/webapi/entry.cgi",
                params={
                    "api": "SYNO.FileStation.List",
                    "version": "2",
                    "method": "list_share",
                    "_sid": self._sid,
                },
                timeout=30,
                verify=False,
            )
            resp.raise_for_status()
            data = resp.json()
            self._check_response(data)

            shares = [
                {"name": s["name"], "path": s["path"]}
                for s in data.get("data", {}).get("shares", [])
            ]
            return sorted(shares, key=lambda s: s["name"])

        return self._with_session_retry(_do)

    def list_directory(self, path):
        """List subdirectories at the given NAS path.
        When path is '/', lists shared folders instead."""
        if path == "/":
            return self.list_shares()

        def _do():
            self._require_auth()
            resp = requests.get(
                f"{self._api_url}/webapi/entry.cgi",
                params={
                    "api": "SYNO.FileStation.List",
                    "version": "2",
                    "method": "list",
                    "folder_path": path,
                    "_sid": self._sid,
                },
                timeout=30,
                verify=False,
            )
            resp.raise_for_status()
            data = resp.json()
            self._check_response(data)

            dirs = [
                {"name": f["name"], "path": f["path"]}
                for f in data.get("data", {}).get("files", [])
                if f.get("isdir", False)
            ]
            return sorted(dirs, key=lambda d: d["name"])

        return self._with_session_retry(_do)

    def _list_folder(self, path):
        """List all entries (files and dirs) at a NAS path."""
        self._require_auth()
        resp = requests.get(
            f"{self._api_url}/webapi/entry.cgi",
            params={
                "api": "SYNO.FileStation.List",
                "version": "2",
                "method": "list",
                "folder_path": path,
                "_sid": self._sid,
            },
            timeout=30,
            verify=False,
        )
        resp.raise_for_status()
        data = resp.json()
        self._check_response(data)
        return data.get("data", {}).get("files", [])

    def list_models(self, folder):
        """List model files in a NAS folder, recursing into subdirectories.
        Returns paths relative to the folder root (e.g. 'subdir/model.safetensors').
        Results are cached."""
        if folder in self._model_cache:
            return self._model_cache[folder]

        def _do():
            base_path = self._resolve_folder_path(folder)
            results = []
            stack = [base_path]

            while stack:
                current = stack.pop()
                entries = self._list_folder(current)
                for entry in entries:
                    if entry.get("isdir", False):
                        stack.append(entry["path"])
                    else:
                        name = entry.get("name", "")
                        if not name.lower().endswith((".safetensors", ".ckpt", ".pt", ".pth", ".bin")):
                            continue
                        # Build path relative to the base folder
                        full = entry["path"]
                        if full.startswith(base_path + "/"):
                            relative = full[len(base_path) + 1:]
                        else:
                            relative = name
                        results.append(relative)

            self._model_cache[folder] = sorted(results)
            return self._model_cache[folder]

        return self._with_session_retry(_do)

    def download_model(self, folder, filename, progress_callback=None):
        """Download a model file from the NAS. Returns the local cache path.
        Skips download if the file is already cached.
        progress_callback(bytes_downloaded, total_bytes) is called during download."""
        cache_folder = os.path.join(self._cache_dir, folder)
        local_path = os.path.join(cache_folder, filename)

        if os.path.exists(local_path):
            logger.info(f"Cache hit: {local_path}")
            return local_path

        def _do():
            self._require_auth()
            remote_path = f"{self._resolve_folder_path(folder)}/{filename}"
            resp = requests.get(
                f"{self._api_url}/webapi/entry.cgi",
                params={
                    "api": "SYNO.FileStation.Download",
                    "version": "2",
                    "method": "download",
                    "path": remote_path,
                    "mode": "download",
                    "_sid": self._sid,
                },
                timeout=600,
                stream=True,
                verify=False,
            )
            resp.raise_for_status()

            # JSON content-type means the API returned an error, not a file
            content_type = resp.headers.get("Content-Type", "")
            if "application/json" in content_type:
                data = resp.json()
                self._check_response(data)
                raise SynologyAPIError("Download returned unexpected JSON response")

            total_size = int(resp.headers.get("Content-Length", 0))
            downloaded = 0

            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            tmp_path = local_path + ".tmp"
            try:
                with open(tmp_path, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=8 * 1024 * 1024):
                        if chunk:
                            f.write(chunk)
                            downloaded += len(chunk)
                            if progress_callback and total_size > 0:
                                progress_callback(downloaded, total_size)
                os.rename(tmp_path, local_path)
            except Exception:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                raise

            logger.info(f"Downloaded: {remote_path} -> {local_path}")
            return local_path

        return self._with_session_retry(_do)

# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_client = None
_client_lock = threading.Lock()

def get_client():
    """Lazy singleton factory for the Synology client."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                config = load_config()
                cache_dir = config.get("cache_dir") or _default_cache_dir()
                _client = SynologyClient(cache_dir=cache_dir)
                _client._models_base_path = config.get("models_base_path", "/volume1/models")
                folder_paths = config.get("folder_paths", {})
                if folder_paths:
                    _client._folder_paths = {k: v for k, v in folder_paths.items() if v}

                # Auto-login if credentials are available from config/env
                api_url = config.get("api_url")
                username = config.get("username")
                password = config.get("password")
                if api_url and username and password:
                    try:
                        _client.login(username, password, api_url)
                        logger.info("Auto-login from config/environment succeeded")
                    except Exception as e:
                        logger.warning(f"Auto-login failed: {e}")
    return _client
