"""Recover the organizer GET hyperlink from the supplied guide, without logging it."""
from pathlib import Path
from pypdf import PdfReader
from urllib.parse import urlparse, parse_qs
import os
import argparse

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description='Recover the provided guide hyperlink into ignored server .env.')
parser.add_argument('--guide', type=Path, required=True)
args = parser.parse_args()
reader = PdfReader(args.guide)
matches = []
for page in reader.pages:
    for ref in page.get('/Annots', []):
        action = ref.get_object().get('/A', {})
        uri = str(action.get('/URI', ''))
        if uri.startswith('https://') and ('group_id' in parse_qs(urlparse(uri).query) or 'group_id=' in uri):
            matches.append(uri)
if len(set(matches)) != 1:
    print(f'Organizer link recovery: expected 1, found {len(set(matches))}; URL not printed.')
    raise SystemExit(1)
target = root / '.env'
existing = target.read_text(encoding='utf-8') if target.exists() else ''
if 'CQA_ORGANIZER_URL=' not in existing:
    with target.open('a', encoding='utf-8') as stream:
        stream.write(f'\nCQA_ORGANIZER_URL={matches[0]}\n')
print('Organizer signed URL stored in ignored server-side .env; value hidden.')
print(f'Gemini key present in inherited environment: {bool(os.environ.get("GEMINI_API_KEY"))}; value hidden.')
