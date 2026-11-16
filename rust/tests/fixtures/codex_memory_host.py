"""Actual MCP fixture at an explicitly owned unit-test daemon home."""
from pathlib import Path
import sys
source = Path(__file__).with_name('codex_memory.py').read_text()
assert "pult = native.parent.parent / 'home'" in source
source = source.replace("pult = native.parent.parent / 'home'", "pult = Path(sys.argv[1])")
exec(compile(source, 'codex_memory.py', 'exec'))
