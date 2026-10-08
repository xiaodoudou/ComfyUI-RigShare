"""Server stats: every metric is optional and never raises."""

from rigshare_core import stats


class Queue:
    def __init__(self, running, pending):
        self.running, self.pending = running, pending

    def get_current_queue_volatile(self):
        return self.running, self.pending


class Server:
    def __init__(self, queue):
        self.prompt_queue = queue


def test_queue_items_order_and_node_count():
    server = Server(Queue([(1, "r1", {"1": {}, "2": {}})], [(5, "p5", {"1": {}}), (3, "p3", {})]))
    items = stats.queue_items(server)
    assert [(i["id"], i["status"], i["nodes"]) for i in items] == [("r1", "running", 2), ("p3", "pending", 0), ("p5", "pending", 1)]


def test_queue_items_survive_odd_entries_and_missing_queue():
    assert stats.queue_items(Server(Queue([(1,)], [(9,)]))) == []
    assert stats.queue_items(object()) is None


def test_queue_counts_with_fallback():
    assert stats._queue(Server(Queue([1], [2, 3]))) == {"running": 1, "pending": 2}

    class Old:
        def get_tasks_remaining(self):
            return 4
    assert stats._queue(Server(Old())) == {"running": 0, "pending": 4}
    assert stats._queue(object()) is None


def test_collect_stats_without_psutil_or_gpu(monkeypatch):
    monkeypatch.setattr(stats, "psutil", None)
    monkeypatch.setattr(stats, "pynvml", None)
    out = stats.collect_stats(Server(Queue([], [])))
    assert out["gpus"] == [] and "cpu" not in out and out["queue"] == {"running": 0, "pending": 0}
    assert stats.collect_stats() == {"gpus": []}
