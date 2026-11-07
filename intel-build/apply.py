"""Apply the maintained Intel overlay to a clean upstream tag; reject changed integration points."""
from pathlib import Path
import shutil
import sys


def replace_once(path: Path, before: str, after: str) -> None:
    text = path.read_text(encoding="utf-8")
    if text.count(before) != 1:
        raise RuntimeError(f"Upstream integration changed: {path}; expected exactly one {before!r}")
    path.write_text(text.replace(before, after), encoding="utf-8", newline="\n")


def apply(root: Path, recipe: Path) -> None:
    main = root / "apps/desktop/src/main.ts"
    replace_once(main,
        "import { DesktopUpdateSchedule, resolveDesktopUpdateScheduleConfig } from './update-schedule.ts'",
        "import { DesktopUpdateSchedule, resolveDesktopUpdateScheduleConfig } from './update-schedule.ts'\n"
        "import { communityUpdateClient } from './community-updates.ts'")
    replace_once(main,
        "new DesktopUpdateSchedule(updates, resolveDesktopUpdateScheduleConfig(process.env))",
        "new DesktopUpdateSchedule(communityUpdateClient(updates), resolveDesktopUpdateScheduleConfig(process.env))")
    replace_once(root / "apps/desktop/electron-builder.config.mjs",
        "export default createElectronBuilderConfig()",
        "import { communityPackageConfig } from './scripts/community-package.mjs'\n"
        "export default communityPackageConfig(createElectronBuilderConfig())")
    for source in sorted((recipe / "overlay").rglob("*")):
        if source.is_file():
            target = root / source.relative_to(recipe / "overlay")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)


if __name__ == "__main__":
    apply(Path(sys.argv[1]).resolve(), Path(__file__).resolve().parent)
