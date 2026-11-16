# Synthetic dependency barrier, not a provider or a production startup override.
import builtins, os, sys

original_import = builtins.__import__
fixture = sys.argv[1]
sys.argv = sys.argv[1:]

def checked_import(name, *args, **kwargs):
    if name in ('pathlib', 'threading'):
        with open(os.path.join(sys.argv[1], 'fixture-import-blocked'), 'w') as mark:
            mark.write(name)
        sys.stderr.write('PULT_CLAUDE_OPTIONAL_IMPORT_BLOCKED\n')
        sys.stderr.flush()
        # Never consume native input or manufacture an ACK. The actual worker's
        # existing deadline and owned cleanup must stop this blocked process.
        read, write = os.pipe()
        os.read(read, 1)
        raise AssertionError('unreachable dependency barrier')
    return original_import(name, *args, **kwargs)

builtins.__import__ = checked_import
with open(fixture) as source:
    code = compile(source.read(), fixture, 'exec')
exec(code, {'__name__': '__main__', '__file__': fixture})
