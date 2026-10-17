"""Create a Chrome Web Store ZIP from an explicit runtime-only allowlist."""
from pathlib import Path
import hashlib
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
files = [
    'manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js',
    'download.html', 'download.js', 'styles.css', 'lib/hls.js',
    'lib/downloader.js', 'lib/auth.js', *manifest['icons'].values(),
]
assert manifest['manifest_version'] == 3
assert len(manifest['description']) <= 132
for name in files:
    source = ROOT / name
    assert source.is_file(), f'Missing runtime resource: {name}'
    assert ROOT in source.resolve().parents, f'Outside project: {name}'
    if source.suffix in {'.js', '.html', '.css', '.json'}:
        text = source.read_text(encoding='utf-8')
        assert not re.search(r'HS256-[A-Za-z0-9_-]{16,}', text), f'Possible hardcoded signed token: {name}'
        assert not re.search(r'(?:/Users/|C:\\Users\\)', text, re.I), f'Private debug reference: {name}'
output = ROOT / 'dist' / f'liucun-m3u8-{manifest["version"]}-chrome-web-store.zip'
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(set(files)):
        archive.write(ROOT / name, name)
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert 'manifest.json' in archive.namelist(), 'Manifest must be at the ZIP root.'
    assert set(archive.namelist()) == set(files)
digest = hashlib.sha256(output.read_bytes()).hexdigest()
report = {
    'version': manifest['version'], 'zip': output.name,
    'sha256': digest, 'files': sorted(set(files)),
    'root_manifest': True, 'published': False,
    'note': 'Runtime packaging validation only; not a security certification or store approval.',
}
report_path = ROOT / 'store' / 'PACKAGE_REPORT.json'
report_path.parent.mkdir(parents=True, exist_ok=True)
report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'Created {output.name}: {len(set(files))} runtime files, root manifest verified.')
print(f'SHA-256: {digest}')
