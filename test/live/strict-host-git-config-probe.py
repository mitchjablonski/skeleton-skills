#!/usr/bin/env python3
"""Opt-in, bounded Linux hostile-Git-config source discovery experiment."""
import argparse
import importlib.util
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
MAX = 32768
TIMEOUT = 15


class CleanupUnproven(RuntimeError):
    pass


class Arguments(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def limits():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX, MAX))
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))


def run(command, base, env):
    """Retain the group leader until group cleanup; never kill a reused PGID."""
    with tempfile.TemporaryFile(dir=base) as out, tempfile.TemporaryFile(dir=base) as err:
        child = subprocess.Popen(list(map(str, command)), cwd=base, env=env,
                                 stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                 start_new_session=True, close_fds=True, preexec_fn=limits)
        try:
            deadline = time.monotonic() + TIMEOUT
            while True:
                status = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if status is not None:
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError('command timed out')
                time.sleep(.01)
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError as exc:
                raise CleanupUnproven('process group cleanup failed') from exc
            try:
                child.wait(timeout=5)
            except (OSError, subprocess.SubprocessError) as exc:
                raise CleanupUnproven('child reaping failed') from exc
        out.seek(0); err.seek(0)
        stdout, stderr = out.read(MAX + 1), err.read(MAX + 1)
        if len(stdout) > MAX or len(stderr) > MAX:
            raise RuntimeError('command output exceeded bound')
        if child.returncode:
            raise RuntimeError('command failed (%d): %s' % (child.returncode, stderr.decode('utf-8', 'replace')[:1024]))
        return stdout.decode('utf-8')


def fixture(base, git, env, scope, node):
    tree = base / scope; tree.mkdir()
    sentinels = base / (scope + '-sentinels'); sentinels.mkdir()
    helpers = base / (scope + '-helpers'); helpers.mkdir()
    hooks = helpers / 'hooks'; hooks.mkdir()
    scripts = {
        'fsmonitor': '#!/bin/sh\nprintf x >> "$PROBE_SENTINELS/fsmonitor"\nprintf "token\\000"\n',
        'clean': '#!/bin/sh\nprintf x >> "$PROBE_SENTINELS/clean"\n/bin/cat\n',
        'smudge': '#!/bin/sh\nprintf x >> "$PROBE_SENTINELS/smudge"\n/bin/cat\n',
        'pre-commit': '#!/bin/sh\nprintf x >> "$PROBE_SENTINELS/pre-commit"\n',
    }
    for name, content in scripts.items():
        target = hooks / name if name == 'pre-commit' else helpers / name
        target.write_text(content); target.chmod(0o700)
    current = dict(env, PROBE_SENTINELS=str(sentinels))

    def g(repo, *args):
        return run([git, '-C', repo, *args], base, current)

    repos = [tree, tree / 'nested']
    for repo in repos:
        repo.mkdir(exist_ok=True)
        g(repo, 'init', '--quiet', '--template=')
        (repo / 'tracked.js').write_text('export const tracked = 1;\n')
        (repo / 'filtered.js').write_text('export const filtered = 1;\n')
        (repo / '.gitattributes').write_text('filtered.js filter=probe\n')
        (repo / '.gitignore').write_text('ignored.js\n')
        g(repo, '-c', 'core.fsmonitor=false', 'add', 'tracked.js', 'filtered.js', '.gitattributes', '.gitignore')
        (repo / 'untracked.js').write_text('export const untracked = 1;\n')
        (repo / 'ignored.js').write_text('export const ignored = 1;\n')
    module = (ROOT / 'lib/source-set.mjs').as_uri()
    script = ('import {discoverSource} from ' + json.dumps(module) + ';'
              'const r=discoverSource(process.argv[1],{withIgnored:true});'
              'console.log(JSON.stringify({mode:r.mode,eligible:[...r.eligible].sort(),'
              'nested:r.nested,ignored:r.ignored}));')
    baseline = json.loads(run([node, '--input-type=module', '-e', script, tree], base, current))
    config = {
        'core.fsmonitor': str(helpers / 'fsmonitor'),
        'core.hooksPath': str(hooks),
        'filter.probe.clean': str(helpers / 'clean'),
        'filter.probe.smudge': str(helpers / 'smudge'),
        'filter.probe.required': 'true',
    }
    for repo in ([tree] if scope == 'global' else repos):
        for key, value in config.items():
            g(repo, 'config', '--global' if scope == 'global' else '--local', key, value)
    # These are commands that actually consult the configured helpers. Discovery
    # itself does not commit, add, or checkout, so hook/filter absence alone is weak.
    controls = {}
    for repo in repos:
        g(repo, 'status', '--porcelain')
        (repo / 'filtered.js').write_text('export const filtered = 2;\n')
        g(repo, 'add', 'filtered.js')
        g(repo, '-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid',
          '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'fixture')
        (repo / 'filtered.js').unlink()
        g(repo, 'checkout-index', '--force', 'filtered.js')
        observed_controls = {name: (sentinels / name).is_file() for name in scripts}
        label = 'root' if repo == tree else 'nested'
        controls[label] = observed_controls
        if not all(observed_controls.values()):
            raise RuntimeError('helper positive control failed: ' + json.dumps(controls))
        for file in sentinels.iterdir():
            file.unlink()
    observed = json.loads(run([node, '--input-type=module', '-e', script, tree], base, current))
    expected = sorted(prefix + name for prefix in ('', 'nested/') for name in
                      ('.gitattributes', '.gitignore', 'filtered.js', 'tracked.js', 'untracked.js'))
    executed = sorted(file.name for file in sentinels.iterdir())
    checks = {
        'positiveControlsTriggered': all(all(items.values()) for items in controls.values()),
        'gitDiscovery': observed.get('mode') == 'git',
        'matchesNeutralBaseline': observed == baseline,
        'exactMembership': observed.get('eligible') == expected,
        'nestedRepositoryDiscovered': observed.get('nested') == ['nested'],
        'ignoredFilesObserved': observed.get('ignored', {}).get('count') == 2,
        'noConfiguredHelperSentinelsDuringDiscovery': executed == [],
    }
    return {'scope': scope, 'checks': checks, 'positiveControls': controls,
            'executedDuringDiscovery': executed, 'neutralBaseline': baseline, 'discovery': observed}


def main():
    result = {'ok': False, 'strictState': 'unverified',
              'scope': 'fixed disposable hostile Git configuration source-discovery probe',
              'limitations': ['Windows Git and mounted-path behavior untested',
                              'Sentinel observations do not establish universal non-execution or containment']}
    base = None
    cleanup_proven = True
    try:
        parser = Arguments(description=__doc__)
        parser.add_argument('--node', required=True)
        parser.add_argument('--node-sha256', required=True)
        args = parser.parse_args()
        if sys.platform != 'linux':
            raise RuntimeError('Linux/WSL Linux Python required; Windows Git is untested')
        spec = importlib.util.spec_from_file_location('host_git_pin', ROOT / 'test/live/strict-client-probe.py')
        pin = importlib.util.module_from_spec(spec); spec.loader.exec_module(pin)
        node, digest, error = pin.validate_pin(args.node, args.node_sha256, 'node')
        if error:
            result.update(error)
            return result, 2
        git = shutil.which('git', path='/usr/bin:/bin')
        if not git:
            raise RuntimeError('system Linux Git unavailable')
        base = pathlib.Path(tempfile.mkdtemp(prefix='skel-host-git-')).resolve()
        home = base / 'home'; home.mkdir(mode=0o700)
        env = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'USERPROFILE': str(home),
               'XDG_CONFIG_HOME': str(home / '.config'), 'XDG_STATE_HOME': str(home / 'state'),
               'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': str(home / '.gitconfig'),
               'GIT_TERMINAL_PROMPT': '0', 'LC_ALL': 'C', 'TZ': 'UTC'}
        result['gitVersion'] = run([git, '--version'], base, env).strip()
        result['nodeSha256'] = digest
        result['cases'] = []
        for scope in ('global', 'local'):
            (home / '.gitconfig').write_text('')
            result['cases'].append(fixture(base, git, env, scope, node))
        result['ok'] = all(all(case['checks'].values()) for case in result['cases'])
        return result, 0 if result['ok'] else 1
    except CleanupUnproven as exc:
        cleanup_proven = False
        result['error'] = str(exc)
        result['retainedScratch'] = str(base)
        return result, 1
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as exc:
        result['error'] = str(exc)[:2048]
        return result, 1
    finally:
        if base is not None and cleanup_proven:
            try:
                shutil.rmtree(base)
            except OSError:
                result['ok'] = False
                result['retainedScratch'] = str(base)
                result['error'] = 'scratch removal failed'


if __name__ == '__main__':
    answer, code = main()
    print(json.dumps(answer, sort_keys=True))
    sys.exit(code if answer.get('ok') else (code or 1))

