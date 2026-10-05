"""Gates jj sur copie propre du SHA candidat. Aucune publication ni sandbox OS."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def stop_group(process):
    """Arrête aussi les descendants même si le parent termine avant eux."""
    group_was_alive = False
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)
            group_was_alive = True
        except ProcessLookupError:
            pass
        if sig == signal.SIGTERM:
            try:
                process.communicate(timeout=0.25)
            except subprocess.TimeoutExpired:
                pass
    process.communicate()
    return group_was_alive


def run(args, cwd, timeout=1800):
    # Groupe distinct : annuler le runner ne doit pas abandonner un hook/Cargo.
    with subprocess.Popen(args, cwd=cwd, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, start_new_session=True) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except BaseException:
            stop_group(process)
            raise
        # communicate a déjà récolté le parent ; un groupe restant est un orphelin.
        descendants = stop_group(process)
        if process.returncode:
            raise RuntimeError(f"Échec {args[0]} {args[1:3]} (code {process.returncode})\n{stderr[-1500:]}")
        if descendants:
            raise RuntimeError(f'{args[0]} : parent terminé avec descendants encore actifs')
    return stdout.strip()


def key(root):
    return hashlib.sha256(str(root).encode()).hexdigest()[:20]


def configuration(root):
    path = Path.home() / '.config/pi-orchestrate/projects' / f'{key(root)}.json'
    raw = path.read_bytes()
    data = json.loads(raw)
    if data.get('root') != str(root) or not data.get('required'):
        raise RuntimeError(f"Politique absente/incomplète : {path}")
    for argv in data['required']:
        if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
            raise RuntimeError('Commande de gate invalide dans la politique')
    return data, hashlib.sha256(raw).hexdigest()


def revision(root, rev):
    value = run(['jj', '--no-pager', 'log', '--no-graph', '-r', rev, '-T', 'commit_id'], root)
    if not re.fullmatch(r'[0-9a-f]{40,64}', value):
        raise RuntimeError('Une révision doit désigner exactement un commit')
    return value


def cache_directory(root):
    base = Path(tempfile.gettempdir()) if (os.environ.get('PI_CONFINED') == '1' or os.environ.get('CODEX_SANDBOX')) else Path.home() / '.cache'
    return base / 'pi-orchestrate/gates' / key(root)


def gates(mode='full', base='trunk()'):
    root = Path(run(['jj', '--ignore-working-copy', 'root'], Path.cwd())).resolve()
    cache = cache_directory(root)
    if (os.environ.get('PI_CONFINED') == '1' or os.environ.get('CODEX_SANDBOX')):
        os.environ['PREK_HOME'] = str(Path(tempfile.gettempdir()) / 'prek')
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    if any((cache / name).exists() for name in ('validation.lock', 'lock')):
        raise RuntimeError('Verrou ancien format présent : vérifier l’arrêt de l’ancien runner avant nettoyage manuel')
    # Verrou noyau : libéré même sur arrêt brutal, sans suppression/race du fichier.
    lock = cache / 'validation.flock'
    with lock.open('a') as handle:
        lock.chmod(0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError(f'Validation déjà en cours : {lock}') from None
        (cache / 'approved.json').unlink(missing_ok=True)
        return validate(mode, base, root, cache)


def candidate_unchanged(candidate, head):
    if run(['git', 'rev-parse', 'HEAD'], candidate) != head:
        raise RuntimeError('La révision de la copie a changé pendant un gate')
    if run(['git', 'status', '--porcelain', '--untracked-files=all'], candidate):
        raise RuntimeError('Hooks/gates ont modifié la copie propre : corriger les sources et relancer')
    run(['git', 'diff', '--exit-code', head, '--'], candidate)


def preflight(mode, base, root):
    if mode not in ('quick', 'full', 'dry-run'):
        raise RuntimeError('Usage: pi-prek [quick|full|dry-run] [base-jj]')
    bypasses = ('SKIP', 'PREK_SKIP', 'PRE_COMMIT_ALLOW_NO_CONFIG', 'GITLEAKS_CONFIG', 'GITLEAKS_CONFIG_TOML')
    if any(os.environ.get(v) for v in bypasses):
        raise RuntimeError('Variable de contournement des gates présente')
    git_root = Path(run(['git', 'rev-parse', '--show-toplevel'], root)).resolve()
    if root != git_root or not (root / '.git').is_dir():
        raise RuntimeError('Cette version exige un dépôt jj/Git colocaté avec .git directory')
    policy, policy_hash = configuration(root)
    head, ancestor = revision(root, '@'), revision(root, base)
    run(['git', 'merge-base', '--is-ancestor', ancestor, head], root)
    conflicts = run(['jj', '--no-pager', 'log', '--no-graph', '-r', f'conflicts() & {ancestor}..{head}', '-T', 'commit_id'], root)
    if conflicts:
        raise RuntimeError('Conflits jj dans les commits candidats')
    author = run(['git', 'show', '-s', '--format=%an%n%ae', head], root).splitlines()
    if len(author) != 2 or not all(author):
        raise RuntimeError('Identité auteur vide')
    protected = ['prek.toml', '.pre-commit-config.yaml', '.pre-commit-config.yml', '.gitleaks.toml', '.gitleaksignore']
    if run(['git', 'diff', '--name-only', ancestor, head, '--', *protected], root):
        raise RuntimeError('Politique prek/secrets modifiée : revue humaine requise avant validation')
    return policy, policy_hash, head, ancestor


def prepare_candidate(root, candidate, head, ancestor):
    run(['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--no-hardlinks', '--no-checkout', str(root), str(candidate)], root)
    run(['git', '-c', 'core.hooksPath=/dev/null', 'fetch', str(root), head], candidate)
    run(['git', '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', head], candidate)
    run(['git', 'remote', 'remove', 'origin'], candidate)
    cfg = candidate / '.gitleaks.toml'
    secret_args = ['--config', str(cfg)] if cfg.exists() else []
    common = ['--redact', '--no-banner', '--ignore-gitleaks-allow', '--timeout', '120', *secret_args]
    run(['gitleaks', 'git', *common, f'--log-opts={ancestor}..{head}', '.'], candidate)
    # Scanner l'arbre exact avant génération des artefacts de compilation.
    run(['gitleaks', 'dir', *common, '.'], candidate)


def validate(mode, base, root, cache):
    policy, policy_hash, head, ancestor = preflight(mode, base, root)
    stages = ['pre-commit'] if mode == 'quick' else ['pre-commit', 'manual', 'pre-push']
    commands = [['prek', 'run', '--all-files', '--stage', stage] for stage in stages]
    if mode == 'dry-run':
        for argv in commands:
            print(run([*argv, '--dry-run'], root))
        print('Commandes obligatoires :', json.dumps(policy['required']))
        print('Simulation : aucun reçu de validation.')
        return None
    if mode == 'full':
        commands.extend(policy['required'])
    with tempfile.TemporaryDirectory(prefix='candidate-', dir=cache) as temp:
        candidate = Path(temp) / 'repo'
        prepare_candidate(root, candidate, head, ancestor)
        for argv in commands:
            candidate_unchanged(candidate, head)
            run(argv, candidate)
            candidate_unchanged(candidate, head)
        if revision(root, '@') != head or configuration(root)[1] != policy_hash:
            raise RuntimeError('Candidat ou politique modifié pendant les gates : reçu refusé')
        data = {'root': str(root), 'head': head, 'base': ancestor, 'policyHash': policy_hash,
                'mode': mode, 'commands': commands, 'validatedAt': datetime.now(timezone.utc).isoformat(),
                'reviewApproved': False, 'publicationAuthorized': False}
        if mode == 'full':
            receipt = cache / 'approved.json'
            pending = cache / 'approved.pending.json'
            pending.write_text(json.dumps(data, indent=2))
            pending.chmod(0o600)
            pending.replace(receipt)
            print(f'Gates complets réussis. Reçu : {receipt}')
        else:
            print('Gates rapides réussis, aucun reçu de publication.')
        print('Aucun push/merge. Review du même SHA encore obligatoire.')
        return data


def interrupted(signum, _frame):
    # InterruptedError serait absorbée comme EINTR par selectors/communicate.
    raise RuntimeError(f'Gates interrompus par signal {signum}')


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        gates(*(sys.argv[1:] or ['full']))
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f'BLOQUÉ : {exc}', file=sys.stderr)
        sys.exit(1)
