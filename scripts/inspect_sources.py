"""Extract source PDFs locally; never prints signed URLs or original call data."""
from pathlib import Path
import hashlib
import json
import re
import argparse
from collections import Counter
from pypdf import PdfReader

root = Path(__file__).resolve().parents[1]
out = root / 'private' / 'source-audit'
out.mkdir(parents=True, exist_ok=True)
parser = argparse.ArgumentParser(description='Read-only local audit of the supplied official materials.')
parser.add_argument('--pdf-dir', type=Path, required=True)
parser.add_argument('--dev-json', type=Path, required=True)
args = parser.parse_args()
base = args.pdf_dir
for name in ('CQA_Chat_Quality_Checklist 1.pdf', 'Data 2 (1) 1.pdf', 'CQA_Hackathon_Student_Guide_v3 1.pdf'):
    source = base / name
    reader = PdfReader(source)
    pages = [f'\n=== PAGE {i + 1} ===\n{p.extract_text()}' for i, p in enumerate(reader.pages)]
    (out / f'{source.stem}.txt').write_text('\n'.join(pages), encoding='utf-8')
    print(json.dumps({'file': name, 'pages': len(pages), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}, ensure_ascii=False))
source = args.dev_json
raw = source.read_text(encoding='utf-8-sig')
data = json.loads(raw)
records = data['data']['records']
print(json.dumps({'group': data['data']['dataset_group_id'], 'declared_count': data['data']['total_records'], 'count': len(records), 'channels': dict(Counter(r['channel'] for r in records)), 'languages': dict(Counter(r['language'] for r in records)), 'speakers': dict(Counter(m['speaker'] for r in records for m in r['transcript'])), 'duplicate_timestamps': sum(len(r['transcript']) - len(set(m['timestamp'] for m in r['transcript'])) for r in records), 'empty_transcripts': sum(not r['transcript'] for r in records), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}, ensure_ascii=False))
