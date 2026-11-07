"""Publish verified installers, advance the generic update feed, then record success."""
import base64
import json
import os
from pathlib import Path
from urllib.parse import quote
from common import REPOSITORY, FEED_TAG, api, run, version_key


root = Path(os.environ["RUNNER_TEMP"]) / "intel-release"
info = json.loads((root / "build-info.json").read_text())
tag = "v" + info["version"]
notes = root.parent / "intel-release-notes.md"
notes.write_text(
    f"Personal Intel macOS build of [{info['upstreamTag']}](https://github.com/deepseek-ai/deepseek-harness/tree/{info['upstreamTag']}).\n\n"
    f"Source: `{info['sourceCommit']}`; upstream: `{info['upstreamCommit']}`.\n\n"
    "Download the DMG for the first installation. Subsequent releases download in the app and ask before restarting. "
    "This build uses a persistent personal signing certificate and is not notarized by Apple. "
    "On first launch, macOS may require Allow Anyway in Privacy & Security. Install in a directory your account can update.\n\n"
    "The ZIP and nightly-mac.yml are used by the updater. SHA256SUMS verifies the release assets.\n",
    encoding="utf-8")
existing = api(f"repos/{REPOSITORY}/releases/tags/{quote(tag, safe='')}", missing=True)
if existing and not existing["draft"]:
    raise RuntimeError("This version is already published; refusing to replace installed update bytes")
if not existing:
    run("gh", "release", "create", tag, "--repo", REPOSITORY, "--target", info["sourceCommit"],
        "--draft", "--prerelease", "--title", f"Intel macOS {info['version']}", "--notes-file", str(notes), capture=False)
run("gh", "release", "upload", tag, *[str(path) for path in sorted(root.iterdir()) if path.is_file()],
    "--repo", REPOSITORY, "--clobber", capture=False)
run("gh", "release", "edit", tag, "--repo", REPOSITORY, "--draft=false", "--latest=false", capture=False)

# The feed contains only metadata; immutable ZIPs remain in their versioned releases.
state_file = api(f"repos/{REPOSITORY}/contents/intel-build/state.json?ref=intel")
state = json.loads(base64.b64decode(state_file["content"]))
previous = state.get("last_success", {})
if previous and version_key(info["version"]) <= version_key(previous["version"]):
    print("Published the requested older build without moving the update feed backwards.")
else:
    feed = api(f"repos/{REPOSITORY}/releases/tags/{FEED_TAG}", missing=True)
    if not feed:
        run("gh", "release", "create", FEED_TAG, "--repo", REPOSITORY, "--target", info["sourceCommit"],
            "--prerelease", "--title", "Intel desktop update feed", "--notes", "Update metadata for the personal Intel desktop build.", capture=False)
    run("gh", "release", "upload", FEED_TAG, str(root / "nightly-mac.yml"), "--repo", REPOSITORY, "--clobber", capture=False)
    run("gh", "release", "edit", FEED_TAG, "--repo", REPOSITORY, "--notes",
        f"Current Intel release: https://github.com/{REPOSITORY}/releases/tag/{tag}", capture=False)
    state["last_success"] = {"version": info["version"], "release_tag": tag, "upstream_sha": info["upstreamCommit"],
                             "recipe_hash": info["recipeHash"], "source_commit": info["sourceCommit"]}
    api(f"repos/{REPOSITORY}/contents/intel-build/state.json", "PUT", {
        "branch": "intel", "sha": state_file["sha"], "message": f"Record Intel release {info['version']} [skip ci]",
        "content": base64.b64encode((json.dumps(state, indent=2) + "\n").encode()).decode(),
    })
print(f"Published https://github.com/{REPOSITORY}/releases/tag/{tag}")
