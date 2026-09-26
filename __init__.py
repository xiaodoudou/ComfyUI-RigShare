import logging
import os

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

try:
    import folder_paths
    from server import PromptServer
except ImportError:  # imported outside ComfyUI, e.g. by the test runner
    folder_paths = PromptServer = None


def data_folder():
    return os.environ.get("RIGSHARE_DATA_DIR") or os.path.join(folder_paths.base_path, "rigshare")


def workflows_dir():
    """ComfyUI's workflows folder for the (single) default user."""
    try:
        user_root = folder_paths.get_public_user_directory("default")
    except Exception:
        user_root = None
    return os.path.join(user_root or os.path.join(folder_paths.get_user_directory(), "default"), "workflows")


if PromptServer is not None and hasattr(PromptServer, "instance"):
    try:
        from .rigshare_core.store import Store
        from .rigshare_core.hub import Hub
        from .rigshare_core.workspace import Workspace
        from .rigshare_core import routes

        folder = data_folder()
        os.makedirs(folder, exist_ok=True)
        store = Store(folder)
        hub = Hub(store, PromptServer.instance)
        hub.workspace = Workspace(store, workflows_dir())
        routes.setup(PromptServer.instance, store, hub)
        logging.info(f"[RigShare] ready, data in {folder}")
    except Exception as e:
        logging.exception(f"[RigShare] failed to start: {e}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
