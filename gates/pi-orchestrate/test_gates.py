import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from gates import cache_directory, run

GATES = Path(__file__).with_name('gates.py')


class GatesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pi-gates-test-')
        self.home = Path(self.temp.name).resolve()
        self.repo = self.home / 'repo'
        self.repo.mkdir()
        scratch = self.home / 'tmp'
        scratch.mkdir()
        self.env = dict(os.environ, HOME=str(self.home), TMPDIR=str(scratch))
        for name in ('SKIP', 'PREK_SKIP', 'GITLEAKS_CONFIG', 'GITLEAKS_CONFIG_TOML', 'PRE_COMMIT_ALLOW_NO_CONFIG'):
            self.env.pop(name, None)
        self.cmd('git', 'init', '-q')
        self.cmd('git', 'config', 'user.name', 'Local Test')
        self.cmd('git', 'config', 'user.email', 'test@example.invalid')
        (self.repo / 'prek.toml').write_text('''[[repos]]
repo = "local"
[[repos.hooks]]
id = "syntax"
name = "syntax"
language = "system"
entry = "python3 --version"
pass_filenames = false
always_run = true
''')
        (self.repo / 'source.py').write_text('value = 1\n')
        self.cmd('git', 'add', 'prek.toml', 'source.py')
        self.cmd('git', 'commit', '-qm', 'test: initialiser')
        self.base = self.cmd('git', 'rev-parse', 'HEAD').stdout.strip()
        self.cmd('jj', 'git', 'init', '--colocate')
        self.cmd('jj', 'config', 'set', '--repo', 'user.name', 'Local Test')
        self.cmd('jj', 'config', 'set', '--repo', 'user.email', 'test@example.invalid')
        self.cmd('jj', 'describe', '-m', 'test: candidat')
        self.cmd('jj', 'metaedit', '--update-author')
        self.id = hashlib.sha256(str(self.repo).encode()).hexdigest()[:20]
        self.policy = self.home / '.config/pi-orchestrate/projects' / f'{self.id}.json'
        self.policy.parent.mkdir(parents=True)
        self.set_policy([[sys.executable, '-c', 'assert __import__("pathlib").Path("source.py").exists()']])

    def tearDown(self):
        self.temp.cleanup()

    def cmd(self, *args):
        return subprocess.run(args, cwd=self.repo, env=self.env, text=True, capture_output=True, check=True)

    def set_policy(self, required):
        self.policy.write_text(json.dumps({'root': str(self.repo), 'required': required}))

    def gate(self, mode='full'):
        return subprocess.run([sys.executable, str(GATES), mode, self.base], cwd=self.repo, env=self.env, text=True, capture_output=True, timeout=60, check=False)

    def receipt(self):
        base = Path(self.env['TMPDIR']) if (self.env.get('PI_CONFINED') == '1' or self.env.get('CODEX_SANDBOX')) else self.home / '.cache'
        return base / 'pi-orchestrate/gates' / self.id / 'approved.json'

    def test_full_creates_sha_bound_receipt_without_publishing(self):
        before = self.cmd('git', 'status', '--porcelain').stdout
        result = self.gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(self.receipt().read_text())
        self.assertEqual(data['head'], self.cmd('jj', 'log', '--no-graph', '-r', '@', '-T', 'commit_id').stdout)
        self.assertFalse(data['publicationAuthorized'])
        self.assertFalse(data['reviewApproved'])
        self.assertEqual(before, self.cmd('git', 'status', '--porcelain').stdout)

    def test_failing_required_command_blocks_and_clears_receipt(self):
        result = self.gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.set_policy([[sys.executable, '-c', 'raise SystemExit(3)']])
        self.assertNotEqual(self.gate().returncode, 0)
        self.assertFalse(self.receipt().exists())

    def test_changed_hook_policy_is_blocked(self):
        with (self.repo / 'prek.toml').open('a') as file:
            file.write('\n# modified by task\n')
        result = self.gate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Politique prek/secrets modifiée', result.stderr)

    def test_untracked_dependency_cannot_make_gates_pass(self):
        self.cmd('jj', 'config', 'set', '--repo', 'snapshot.auto-track', 'none()')
        (self.repo / 'untracked.py').write_text('value = 1\n')
        self.set_policy([[sys.executable, '-c', 'assert __import__("pathlib").Path("untracked.py").exists()']])
        result = self.gate()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.receipt().exists())

    def test_gate_modifying_candidate_is_rejected(self):
        self.set_policy([[sys.executable, '-c', '__import__("pathlib").Path("source.py").write_text("changed")']])
        result = self.gate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('modifié la copie propre', result.stderr)
        self.assertEqual((self.repo / 'source.py').read_text(), 'value = 1\n')

    def test_checkout_during_gate_is_rejected(self):
        self.set_policy([['git', 'checkout', '--detach', self.base]])
        result = self.gate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('révision de la copie a changé', result.stderr)
        self.assertFalse(self.receipt().exists())

    def test_empty_required_policy_is_rejected(self):
        first = self.gate()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertTrue(self.receipt().exists())
        self.set_policy([])
        self.assertNotEqual(self.gate().returncode, 0)
        self.assertFalse(self.receipt().exists())

    def test_legacy_lock_blocks_new_runner(self):
        cache = self.receipt().parent
        cache.mkdir(parents=True)
        (cache / 'validation.lock').mkdir()
        result = self.gate('quick')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ancien format', result.stderr)

    def test_successful_parent_cannot_leave_background_descendants(self):
        marker = self.home / 'survived'
        ready = self.home / 'ready'
        child = (f'import signal,time,pathlib; signal.signal(signal.SIGTERM,signal.SIG_IGN); '
                 f'pathlib.Path({str(ready)!r}).write_text("ready"); time.sleep(1); '
                 f'pathlib.Path({str(marker)!r}).write_text("bad")')
        parent = (f'import subprocess,sys,time,pathlib; '
                  f'subprocess.Popen([sys.executable,"-c",{child!r}],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); '
                  f'path=pathlib.Path({str(ready)!r})\nwhile not path.exists(): time.sleep(0.01)')
        with self.assertRaisesRegex(RuntimeError, 'descendants'):
            run([sys.executable, '-c', parent], self.home, timeout=5)
        time.sleep(1.1)
        self.assertFalse(marker.exists())

    def test_timeout_kills_descendant_ignoring_term(self):
        marker = self.home / 'survived'
        ready = self.home / 'ready'
        child = (f'import signal,time,pathlib; signal.signal(signal.SIGTERM,signal.SIG_IGN); '
                 f'pathlib.Path({str(ready)!r}).write_text("ready"); time.sleep(1); '
                 f'pathlib.Path({str(marker)!r}).write_text("bad")')
        parent = f'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",{child!r}]); time.sleep(30)'
        with self.assertRaises(subprocess.TimeoutExpired):
            run([sys.executable, '-c', parent], self.home, timeout=0.5)
        self.assertTrue(ready.exists())
        time.sleep(1)
        self.assertFalse(marker.exists())

    def test_concurrency_sigterm_and_lock_recovery(self):
        ready = self.home / 'ready'
        marker = self.home / 'survived'
        child = (f'import signal,time,pathlib; signal.signal(signal.SIGTERM,signal.SIG_IGN); '
                 f'pathlib.Path({str(ready)!r}).write_text("ready"); time.sleep(2); '
                 f'pathlib.Path({str(marker)!r}).write_text("bad")')
        parent = f'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",{child!r}]); time.sleep(30)'
        self.set_policy([[sys.executable, '-c', parent]])
        process = subprocess.Popen([sys.executable, str(GATES), 'full', self.base],
                                   cwd=self.repo, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 15
            while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(ready.exists(), 'Le processus requis doit réellement avoir démarré')
            contender = self.gate('quick')
            self.assertNotEqual(contender.returncode, 0)
            self.assertIn('déjà en cours', contender.stderr)
            process.terminate()
            process.communicate(timeout=5)
            self.assertNotEqual(process.returncode, 0)
            self.assertFalse(self.receipt().exists())
            time.sleep(2)
            self.assertFalse(marker.exists())
            result = self.gate('quick')
            self.assertEqual(result.returncode, 0, result.stderr)
        finally:
            if process.poll() is None:
                process.terminate()
                process.communicate(timeout=5)

    def test_quick_never_creates_full_receipt(self):
        result = self.gate('quick')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.receipt().exists())


class CacheTest(unittest.TestCase):
    def test_confined_cache_uses_private_scratch_not_home(self):
        root = Path('/project')
        suffix = Path('pi-orchestrate/gates') / hashlib.sha256(str(root).encode()).hexdigest()[:20]
        for env in ({'PI_CONFINED': '1', 'CODEX_SANDBOX': ''}, {'PI_CONFINED': '', 'CODEX_SANDBOX': 'fixture'}):
            with patch.dict(os.environ, env), patch('tempfile.gettempdir', return_value='/private/scratch'):
                self.assertEqual(cache_directory(root), Path('/private/scratch') / suffix)
        with patch.dict(os.environ, {'PI_CONFINED': '', 'CODEX_SANDBOX': ''}), patch('pathlib.Path.home', return_value=Path('/home/fixture')):
            self.assertEqual(cache_directory(root), Path('/home/fixture/.cache') / suffix)


if __name__ == '__main__':
    unittest.main()
