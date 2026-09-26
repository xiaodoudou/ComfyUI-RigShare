"""Server resource usage for the panel: CPU, RAM, GPUs and the prompt queue.

psutil and pynvml ship with most ComfyUI installs (ComfyUI-Crystools and many
others depend on them); every metric is optional and skipped if unavailable.
"""

import logging
import warnings

log = logging.getLogger("ComfyUI-RigShare")

try:
    import psutil
except ImportError:
    psutil = None

try:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        import pynvml
    pynvml.nvmlInit()
except Exception:
    pynvml = None

GB = 1024 ** 3


def _gpus():
    if not pynvml:
        return []
    out = []
    for i in range(pynvml.nvmlDeviceGetCount()):
        h = pynvml.nvmlDeviceGetHandleByIndex(i)
        name = pynvml.nvmlDeviceGetName(h)
        if isinstance(name, bytes):
            name = name.decode()
        mem = pynvml.nvmlDeviceGetMemoryInfo(h)
        gpu = {"index": i, "name": name.replace("NVIDIA ", "").replace("GeForce ", ""),
               "util": pynvml.nvmlDeviceGetUtilizationRates(h).gpu,
               "vram_used": round(mem.used / GB, 2), "vram_total": round(mem.total / GB, 2)}
        try:
            gpu["temp"] = pynvml.nvmlDeviceGetTemperature(h, pynvml.NVML_TEMPERATURE_GPU)
        except Exception:
            pass
        try:
            gpu["power"] = round(pynvml.nvmlDeviceGetPowerUsage(h) / 1000)
            gpu["power_limit"] = round(pynvml.nvmlDeviceGetEnforcedPowerLimit(h) / 1000)
        except Exception:
            pass
        out.append(gpu)
    return out


def queue_items(server):
    """Running and pending prompts: [{id, number, status, nodes}], running first."""
    try:
        running, pending = server.prompt_queue.get_current_queue_volatile()
    except Exception:
        return None
    items = []
    for status, entries in (("running", running), ("pending", sorted(pending, key=lambda e: e[0]))):
        for entry in entries:
            try:
                prompt = entry[2] if isinstance(entry[2], dict) else {}
                items.append({"id": entry[1], "number": entry[0], "status": status, "nodes": len(prompt)})
            except (IndexError, TypeError):
                continue
    return items


def _queue(server):
    try:
        running, pending = server.prompt_queue.get_current_queue_volatile()
        return {"running": len(running), "pending": len(pending)}
    except Exception:
        try:
            return {"running": 0, "pending": server.prompt_queue.get_tasks_remaining()}
        except Exception:
            return None


def collect_stats(server=None):
    stats = {}
    if psutil:
        stats["cpu"] = psutil.cpu_percent(interval=None)
        vm = psutil.virtual_memory()
        stats["ram_used"] = round((vm.total - vm.available) / GB, 1)
        stats["ram_total"] = round(vm.total / GB, 1)
    try:
        stats["gpus"] = _gpus()
    except Exception as e:
        log.debug(f"[RigShare] GPU stats failed: {e}")
        stats["gpus"] = []
    if server is not None:
        stats["queue"] = _queue(server)
        stats["queue_items"] = queue_items(server)
    return stats
