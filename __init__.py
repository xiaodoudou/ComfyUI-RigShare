import logging
import os

import folder_paths
from server import PromptServer

from .rigshare_core.store import Store
from .rigshare_core.hub import Hub
from .rigshare_core import routes

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"


def data_folder():
    return os.environ.get("RIGSHARE_DATA_DIR") or os.path.join(folder_paths.base_path, "rigshare")


if hasattr(PromptServer, "instance"):
    try:
        folder = data_folder()
        os.makedirs(folder, exist_ok=True)
        store = Store(folder)
        hub = Hub(store, PromptServer.instance)
        routes.setup(PromptServer.instance, store, hub)
        logging.info(f"[RigShare] ready, data in {folder}")
    except Exception as e:
        logging.exception(f"[RigShare] failed to start: {e}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
