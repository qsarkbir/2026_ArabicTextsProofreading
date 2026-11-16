"""Validate representative exports: python -m tests.validate_tei /path/to/tei_all.rng [dir-with-xml ...].

Checks the built-in samples and the Python output for tests/fixtures/tei; every .xml in the extra directories
(CI passes the output of tests/tei_fixtures.js, i.e. static/local/tei.js) is validated as well."""
import json
import sys
from pathlib import Path
from lxml import etree
from proofreader import openiti
from proofreader.exporters import tei


def main():
    schema = etree.RelaxNG(etree.parse(sys.argv[1]))
    project = {'uri':'fixture', 'title':'Synthetic & <edition>', 'author':'Synthetic author',
               'bibliography':{'edition':'Synthetic source', 'rights':'Test data'}, 'source':None}
    samples = [
        '# one PageV01P001\n~~ two\n# left %~% right\nPageV01P002\n',
        '### | Chapter\n# hello PageV01P001\nTAIL',
        '### |EDITOR|\n# editorial PageV01P001\n',
        '### $ unknown\n# hello PageV01P001',
        'PageV01P001\nPageV02P001\n',
    ]
    for text in samples:
        data, _ = tei.export(project, openiti.split(text), {'edits':{}, 'status':{'0':{'note':'note & <literal>'}}})
        schema.assertValid(etree.fromstring(data))
    print(f'PASS {len(samples)} exports validated against TEI Relax NG')
    fixtures = json.loads((Path(__file__).parent / 'fixtures' / 'tei' / 'expected.json').read_text(encoding='utf-8'))
    xml = [(name, r['xml'].encode('utf-8')) for name, r in fixtures.items() if 'xml' in r]
    for folder in sys.argv[2:]:
        files = sorted(Path(folder).glob('*.xml'))
        if not files:
            raise SystemExit(f'no .xml files in {folder}')
        xml += [(f'{folder}/{f.name}', f.read_bytes()) for f in files]
    for name, data in xml:
        try:
            schema.assertValid(etree.fromstring(data))
        except etree.DocumentInvalid as e:
            raise SystemExit(f'INVALID {name}: {e}')
    print(f'PASS {len(xml)} fixture exports validated (Python fixtures and any extra directories)')


if __name__ == '__main__':
    main()
