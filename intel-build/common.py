"""Version selection and GitHub API operations for the personal Intel release."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPOSITORY = "fsyv/harness"
UPSTREAM = "deepseek-ai/deepseek-harness"
FEED_TAG = "intel-updates"
VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\Z")


def version_key(version):
    match = VERSION.fullmatch(version)
    if not match:
        raise ValueError(f"Unsupported version: {version}")
    major, minor, patch, pre = match.groups()
    parts = (pre or "").split(".") if pre else []
    if any(p.isdigit() and len(p) > 1 and p.startswith("0") for p in parts):
        raise ValueError(f"Invalid prerelease number: {version}")
    return (int(major), int(minor), int(patch), not bool(pre),
            tuple((0, int(p)) if p.isdigit() else (1, p) for p in parts))


def select_tag(remote_text, requested=""):
    refs = dict(line.split(None, 1)[::-1] for line in remote_text.splitlines() if line.strip())
    candidates = {}
    for ref, sha in refs.items():
        if not ref.startswith("refs/tags/dsh-v") or ref.endswith("^{}"):
            continue
        tag = ref.removeprefix("refs/tags/")
        try:
            key = version_key(tag.removeprefix("dsh-v"))
        except ValueError:
            continue
        commit = refs.get(ref + "^{}", sha)
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("Invalid upstream commit")
        candidates[tag] = (key, commit)
    if requested:
        if requested not in candidates:
            raise ValueError(f"Upstream tag not found: {requested}")
        tag = requested
    else:
        if not candidates:
            raise ValueError("No supported dsh-v* tags found")
        tag = max(candidates, key=lambda name: candidates[name][0])
    return tag, candidates[tag][1]


def run(*args, cwd=None, capture=True, input=None, env=None):
    result = subprocess.run(args, cwd=cwd, input=input, text=True, check=True,
                            stdout=subprocess.PIPE if capture else None, env=env)
    return result.stdout.strip() if capture else None


def api(path, method="GET", data=None, missing=False):
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    token = os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode() if data is not None else None
    request = Request("https://api.github.com/" + path, data=body, method=method, headers=headers)
    try:
        with urlopen(request, timeout=60) as response:
            return json.load(response)
    except HTTPError as error:
        if missing and error.code == 404:
            return None
        raise RuntimeError(f"GitHub {method} {path}: HTTP {error.code}") from error


def recipe_hash(root):
    digest = hashlib.sha256()
    files = list((root / "intel-build").rglob("*")) + [root / ".github/workflows/intel-release.yml"]
    for path in sorted(files):
        if not path.is_file() or path.name == "state.json" or "__pycache__" in path.parts:
            continue
        digest.update(path.relative_to(root).as_posix().encode() + b"\0" + path.read_bytes())
    return digest.hexdigest()


def outputs(values):
    target = os.environ.get("GITHUB_OUTPUT")
    if target:
        with open(target, "a", encoding="utf-8") as file:
            for key, value in values.items():
                if "\n" in str(value):
                    raise ValueError("Multiline workflow output rejected")
                file.write(f"{key}={value}\n")
    print(json.dumps(values, indent=2))
