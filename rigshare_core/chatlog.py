"""Chat history: an append-only log, read back one page at a time.

Messages are stored one JSON object per line in ``chat.jsonl``. Each gets a
sequence number (``seq``, its position in the log), so clients can ask for
"the 50 messages before #1234" while scrolling back. Only the byte offset of
each line is kept in memory, so the history can grow without limit.
"""

import json
import logging
import os
import threading

log = logging.getLogger("ComfyUI-RigShare")


class ChatLog:
    def __init__(self, folder, keep=0, legacy=None):
        """``keep`` > 0 trims the log to that many messages at startup (0 keeps everything).
        ``legacy``: messages from the old ``chat.json``, imported once."""
        self.path = os.path.join(folder, "chat.jsonl")
        self._lock = threading.Lock()
        if legacy and not os.path.exists(self.path):
            with open(self.path, "w", encoding="utf-8") as f:
                for msg in legacy:
                    if isinstance(msg, dict):
                        f.write(json.dumps({k: v for k, v in msg.items() if k != "seq"}, ensure_ascii=False) + "\n")
        self.offsets = []
        self._index()
        if keep and len(self.offsets) > keep:
            self._trim(keep)

    def _index(self):
        self.offsets = []
        if not os.path.exists(self.path):
            return
        torn = None
        with open(self.path, "rb") as f:
            pos = 0
            for line in f:
                if not line.endswith(b"\n"):
                    torn = pos  # cut short by a crash mid-write
                elif line.strip():
                    self.offsets.append(pos)
                pos += len(line)
        if torn is not None:
            with open(self.path, "r+b") as f:
                f.truncate(torn)

    def _trim(self, keep):
        messages = self.read(len(self.offsets) - keep, len(self.offsets))
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for msg in messages:
                msg.pop("seq", None)
                f.write(json.dumps(msg, ensure_ascii=False) + "\n")
        os.replace(tmp, self.path)
        self._index()

    def clear(self):
        """Delete the whole history; numbering starts again at 0."""
        with self._lock:
            with open(self.path, "w", encoding="utf-8"):
                pass
            self.offsets = []

    def __len__(self):
        return len(self.offsets)

    def append(self, msg):
        """Store a message; returns it with its ``seq``."""
        with self._lock:
            msg = {**msg, "seq": len(self.offsets)}
            data = (json.dumps({k: v for k, v in msg.items() if k != "seq"}, ensure_ascii=False) + "\n").encode("utf-8")
            try:
                with open(self.path, "ab") as f:
                    pos = f.tell()
                    f.write(data)
                self.offsets.append(pos)
            except OSError as e:
                log.error(f"[RigShare] could not save chat message: {e}")
            return msg

    def read(self, start, end):
        """Messages ``start`` <= seq < ``end``."""
        start, end = max(0, start), min(end, len(self.offsets))
        if start >= end:
            return []
        out = []
        with open(self.path, "rb") as f:
            f.seek(self.offsets[start])
            for seq in range(start, end):
                line = f.readline()
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                msg["seq"] = seq
                out.append(msg)
        return out

    def page(self, before=None, limit=50):
        """The ``limit`` messages before ``before`` (newest when None), oldest first,
        and whether older ones exist."""
        end = len(self.offsets) if before is None else max(0, min(int(before), len(self.offsets)))
        start = max(0, end - max(1, min(int(limit), 200)))
        return self.read(start, end), start > 0
