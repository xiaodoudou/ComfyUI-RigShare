"""Chat history: append-only log paged by sequence number."""

import json
import os

from rigshare_core.chatlog import ChatLog


def test_pages_back_through_the_whole_history(tmp_path):
    chat = ChatLog(str(tmp_path))
    for i in range(130):
        assert chat.append({"text": f"m{i}", "ts": i})["seq"] == i
    page, more = chat.page(limit=50)
    assert [m["text"] for m in page] == [f"m{i}" for i in range(80, 130)] and more
    seen = page
    while more:
        page, more = chat.page(before=seen[0]["seq"], limit=50)
        seen = page + seen
    assert [m["seq"] for m in seen] == list(range(130)), "every message exactly once, in order"
    assert chat.page(before=0) == ([], False)


def test_survives_restart_a_torn_line_and_imports_old_chat(tmp_path):
    folder = str(tmp_path)
    chat = ChatLog(folder, legacy=[{"text": "old 1"}, {"text": "old 2"}])
    chat.append({"text": "new"})
    with open(os.path.join(folder, "chat.jsonl"), "ab") as f:
        f.write(b'{"text": "torn')  # the server died mid-write
    chat = ChatLog(folder, legacy=[{"text": "never imported twice"}])
    assert [m["text"] for m in chat.page()[0]] == ["old 1", "old 2", "new"]
    chat.append({"text": "after"})
    assert chat.page()[0][-1] == {"text": "after", "seq": 3}


def test_optional_trim_and_unicode(tmp_path):
    chat = ChatLog(str(tmp_path))
    for i in range(10):
        chat.append({"text": f"héllo {i} 🎉"})
    chat = ChatLog(str(tmp_path), keep=4)
    assert [m["text"] for m in chat.page()[0]] == [f"héllo {i} 🎉" for i in range(6, 10)]
    assert len(chat) == 4
