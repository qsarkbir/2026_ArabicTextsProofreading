"""Isolated browser fixture: python -m tests.preview_server (no external OCR)."""
import tempfile
from pathlib import Path
from http.server import ThreadingHTTPServer

from proofreader import ocr, server, store


class PreviewHandler(server.Handler):
    failed_once = False

    def do_GET(self):
        if self.path.startswith('/scan/'):
            return self._send(200, b'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="white"/><text x="50" y="100" font-size="32">Synthetic scan for UI testing</text></svg>', 'image/svg+xml')
        return super().do_GET()

    def do_PUT(self):
        if not PreviewHandler.failed_once:
            PreviewHandler.failed_once = True
            self.body()
            return self._send(503, b'{"error":"Simulated temporary save failure"}', 'application/json')
        return super().do_PUT()


def main():
    with tempfile.TemporaryDirectory(prefix='preview-', dir=Path(__file__).parent) as tmp:
        store.ROOT = Path(tmp)
        ocr.available = lambda: False
        p = store.create({'uri': 'ui-fixture', 'meta': {}, 'text': '#META#Header#End#\r\nalpha beta PageV01P001\r\ngamma delta PageV01P002\r\n'})
        p['source'] = {'type': 'ia', 'id': 'synthetic', 'revision': 'fixture', 'title': 'UI test fixture',
                       'pages': [{'label': str(i + 1), 'service': f'http://127.0.0.1:8772/scan/{i}', 'w': 600, 'h': 800} for i in range(4)]}
        p['anchors'] = [[1, 2]]
        store.save_project(p['slug'], p)
        store.ocr_put(p['slug'], 0, {'text': 'alpha beta extra', 'image_index': 0, 'image_key': server.image_for(p, 0)['key'], 'model': 'fixture'})
        with ThreadingHTTPServer(('127.0.0.1', 8772), PreviewHandler) as http:
            print('UI fixture: http://127.0.0.1:8772/#/p/ui-fixture/0', flush=True)
            try:
                http.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == '__main__':
    main()
