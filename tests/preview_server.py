"""Isolated browser fixture: python -m tests.preview_server (no external OCR)."""
import struct
import os
import tempfile
import zlib
from pathlib import Path
from http.server import ThreadingHTTPServer

from proofreader import ocr, server, sources, store, providers


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


def jpx_pdf(pages=2):
    """A scanned-book style PDF: each page is one JPEG 2000 image (JPXDecode), which pdf.js decodes with its WebAssembly decoder."""
    jp2 = (Path(__file__).parent / 'fixtures' / 'pdf' / 'page.jp2').read_bytes()
    objs = [b'<< /Type /Catalog /Pages 2 0 R >>',
            b'<< /Type /Pages /Kids [%s] /Count %d >>' % (b' '.join(b'%d 0 R' % (4 + 3 * i) for i in range(pages)), pages),
            b'<< /Type /XObject /Subtype /Image /Width 120 /Height 160 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /JPXDecode /Length %d >>\nstream\n%s\nendstream' % (len(jp2), jp2)]
    for i in range(pages):
        stream = b'q 600 0 0 800 0 0 cm /Im1 Do Q'
        objs.append(b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im1 3 0 R >> >> /Contents %d 0 R >>' % (5 + 3 * i))
        objs.append(b'<< /Length %d >>\nstream\n%s\nendstream' % (len(stream), stream))
        objs.append(b'<< >>')
    out, offsets = b'%PDF-1.5\n', []
    for n, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += b'%d 0 obj\n%s\nendobj\n' % (n, obj)
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1) + b''.join(b'%010d 00000 n \n' % o for o in offsets)
    return out + b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%EOF\n' % (len(objs) + 1, xref)


class PreviewHandler(server.Handler):
    failed_once = False

    def do_PUT(self):
        if not PreviewHandler.failed_once:
            PreviewHandler.failed_once = True
            self.body()
            return self._send(503, b'{"error":"Simulated temporary save failure"}', 'application/json')
        return super().do_PUT()


def synthetic_png(width=600, height=800):
    """A plain page-coloured PNG with a dark band, standing in for a scan (cached and served as an image)."""
    rows = b''.join(b'\x00' + (b'\x40' if 80 <= y < 120 else b'\xf4') * width for y in range(height))
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def main():
    with tempfile.TemporaryDirectory(prefix='preview-', dir=Path(__file__).parent) as tmp:
        store.ROOT = Path(tmp)
        ocr.available = lambda: False
        providers.catalog = lambda: {
            'anthropic': {'label':'Anthropic', 'available':False, 'reason':'検証用：無効', 'models':{}, 'default':''},
            'openai': {'label':'OpenAI（合成データ）', 'available':True, 'reason':'', 'models':{}, 'default':'fixture-model'},
        }
        providers.transcribe = lambda *args, **kwargs: {'text':'alpha beta extra', 'model':'fixture-model', 'provider':'openai', 'truncated':False}
        sources.fetch_scan = lambda src, idx, width=1600: (synthetic_png(), 'image/png')
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
        port = int(os.environ.get('PROOF_PREVIEW_PORT', '8772'))
        with ThreadingHTTPServer(('127.0.0.1', port), PreviewHandler) as http:
            print(f'UI fixture: http://127.0.0.1:{port}/#/p/ui-fixture/0 and #/p/pdf-fixture/0', flush=True)
            try:
                http.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == '__main__':
    main()
