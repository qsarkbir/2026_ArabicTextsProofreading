"""Isolated browser fixture: python -m tests.preview_server (no external OCR)."""
import tempfile
from pathlib import Path
from http.server import ThreadingHTTPServer

from proofreader import ocr, server, store


def synthetic_pdf(pages):
    """A tiny PDF with one labelled page per image, for the PDF code paths."""
    objs = [b'<< /Type /Catalog /Pages 2 0 R >>',
            b'<< /Type /Pages /Kids [%s] /Count %d >>' % (b' '.join(b'%d 0 R' % (4 + 2 * i) for i in range(pages)), pages),
            b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    for i in range(pages):
        stream = b'BT /F1 40 Tf 60 700 Td (Synthetic PDF page %d) Tj ET' % (i + 1)
        objs.append(b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>' % (5 + 2 * i))
        objs.append(b'<< /Length %d >>\nstream\n%s\nendstream' % (len(stream), stream))
    out, offsets = b'%PDF-1.4\n', []
    for n, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += b'%d 0 obj\n%s\nendobj\n' % (n, obj)
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1) + b''.join(b'%010d 00000 n \n' % o for o in offsets)
    return out + b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%EOF\n' % (len(objs) + 1, xref)


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
        q = store.create({'uri': 'pdf-fixture', 'meta': {}, 'text': 'one PageV01P001\ntwo PageV01P002\nthree PageV01P003\n'})
        store.file_path(q['slug'], 'fixture.pdf').write_bytes(synthetic_pdf(5))
        q['source'] = {'type': 'pdf', 'file': 'fixture.pdf', 'revision': 'fixture', 'title': 'PDF fixture', 'count': 5}
        store.save_project(q['slug'], q)
        with ThreadingHTTPServer(('127.0.0.1', 8772), PreviewHandler) as http:
            print('UI fixture: http://127.0.0.1:8772/#/p/ui-fixture/0 and #/p/pdf-fixture/0', flush=True)
            try:
                http.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == '__main__':
    main()
