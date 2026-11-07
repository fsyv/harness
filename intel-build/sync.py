"""Snapshot an upstream release with the maintained overlay and preserve this fork's automation."""
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
from common import REPOSITORY, UPSTREAM, api, outputs, recipe_hash, run, select_tag, version_key


def main():
    control = Path.cwd().resolve()
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY or os.environ.get("GITHUB_REF") != "refs/heads/intel":
        raise RuntimeError("Run this workflow on fsyv/harness's intel branch")
    controller_sha = run("git", "rev-parse", "HEAD", cwd=control)
    remote_head = run("git", "ls-remote", "origin", "refs/heads/intel", cwd=control).split()[0]
    if remote_head != controller_sha:
        raise RuntimeError("The intel branch moved; run the workflow again from its new head")
    tag, upstream_sha = select_tag(run("git", "ls-remote", "--tags", f"https://github.com/{UPSTREAM}.git", "refs/tags/dsh-v*"),
                                   os.environ.get("INPUT_TAG", "").strip())
    recipe = recipe_hash(control)
    state_path = control / "intel-build/state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    previous = state.get("last_success", {})
    already_built = previous.get("upstream_sha") == upstream_sha and previous.get("recipe_hash") == recipe
    if already_built:
        release = api(f"repos/{REPOSITORY}/releases/tags/{previous['release_tag']}", missing=True)
        already_built = release is not None and not release["draft"] and bool(release["assets"])
    build = not already_built or os.environ.get("INPUT_FORCE") == "true"
    now = datetime.now(timezone.utc)
    product = tag.removeprefix("dsh-v")
    prefix = product + ("." if "-" in product else "-test.")
    version = prefix + f"{now:%Y%m%d}.{os.environ['GITHUB_RUN_NUMBER']}.{os.environ['GITHUB_RUN_ATTEMPT']}"
    version_key(version)
    run("git", "fetch", "--depth=1", f"https://github.com/{UPSTREAM}.git", f"refs/tags/{tag}", cwd=control)
    fetched = run("git", "rev-parse", "FETCH_HEAD^{commit}", cwd=control)
    if fetched != upstream_sha:
        raise RuntimeError("Upstream tag moved during selection")
    root = Path(tempfile.mkdtemp(prefix="harness-source-", dir=os.environ["RUNNER_TEMP"])) / "source"
    run("git", "worktree", "add", "--detach", str(root), upstream_sha, cwd=control)
    try:
        # Only the maintained fork workflows survive an upstream refresh.
        shutil.rmtree(root / ".github/workflows")
        shutil.copytree(control / ".github/workflows", root / ".github/workflows")
        if (root / "intel-build").exists():
            raise RuntimeError("Upstream now owns intel-build; review the overlay destination")
        shutil.copytree(control / "intel-build", root / "intel-build", ignore=shutil.ignore_patterns("__pycache__"))
        spec = importlib.util.spec_from_file_location("intel_overlay", control / "intel-build/apply.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.apply(root, control / "intel-build")
        if json.loads((root / "package.json").read_text())["version"] != product:
            raise RuntimeError("Upstream tag and package version disagree")
        state.update({"checked_at": now.isoformat(), "upstream_tag": tag, "upstream_sha": upstream_sha,
                      "recipe_hash": recipe, "build_version": version})
        (root / "intel-build/state.json").write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        run("git", "add", "--all", cwd=root)
        tree = run("git", "write-tree", cwd=root)
        identity = {**os.environ, "GIT_AUTHOR_NAME": "github-actions[bot]", "GIT_COMMITTER_NAME": "github-actions[bot]",
                    "GIT_AUTHOR_EMAIL": "41898282+github-actions[bot]@users.noreply.github.com",
                    "GIT_COMMITTER_EMAIL": "41898282+github-actions[bot]@users.noreply.github.com"}
        commit = run("git", "commit-tree", tree, "-p", controller_sha, cwd=root, env=identity,
                     input=f"Sync {tag} for the Intel desktop build [skip ci]\n")
        run("gh", "auth", "setup-git", capture=False)
        run("git", "push", "origin", f"{commit}:refs/heads/intel", cwd=control, capture=False)
        outputs({"build": str(build).lower(), "commit": commit, "tag": tag, "upstream_sha": upstream_sha,
                 "version": version, "recipe_hash": recipe, "release_tag": "v" + version})
    finally:
        run("git", "worktree", "remove", "--force", str(root), cwd=control, capture=False)


if __name__ == "__main__":
    main()
