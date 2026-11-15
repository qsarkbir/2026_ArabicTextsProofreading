"""Tracks open browser tabs so the server can exit once the last one is gone."""
import threading

BYE_GRACE = 30    # seconds after the last tab said goodbye
SILENT_GRACE = 180  # seconds after a tab's last heartbeat (background tabs are throttled)


class Presence:
    def __init__(self):
        self.lock = threading.Lock()
        self.clients = {}  # id -> [last contact time, said bye]
        self.inflight = 0

    def beat(self, client, now):
        with self.lock:
            self.clients[client] = [now, False]

    def bye(self, client, now):
        with self.lock:
            self.clients[client] = [now, True]

    def request_started(self):
        with self.lock:
            self.inflight += 1

    def request_finished(self):
        with self.lock:
            self.inflight = max(0, self.inflight - 1)

    def should_exit(self, now):
        """True once a tab has connected, every tab is gone, and nothing is being served."""
        with self.lock:
            if not self.clients or self.inflight:
                return False
            return all(t + (BYE_GRACE if left else SILENT_GRACE) <= now for t, left in self.clients.values())
