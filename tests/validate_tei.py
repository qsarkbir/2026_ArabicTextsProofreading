"""Validate representative exports: python -m tests.validate_tei /path/to/tei_all.rng."""
import sys
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


if __name__ == '__main__':
    main()
