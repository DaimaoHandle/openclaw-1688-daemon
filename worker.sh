#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

pkill -f "$(basename "$SCRIPT_DIR")/daemon.js" 2>/dev/null || true
rm -f daemon.lock
python3 - <<'PY'
import json
from pathlib import Path
p=Path('state.json')
state={'handled': {}, 'startupBaseline': {}, 'lastRunAt': None}
if p.exists():
    try:
        old=json.loads(p.read_text())
        state['handled']=old.get('handled', {})
    except Exception:
        pass
p.write_text(json.dumps(state, ensure_ascii=False, indent=2))
PY
exec node daemon.js
