"""Build the downloadable source bundle from the current firmware checkout."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
source = root / "firmware" / "m5sticks3-motion"
destination = root / "dist" / "firmware"
destination.mkdir(parents=True, exist_ok=True)
files = [source / name for name in ("platformio.ini", "LICENSE", "SETUP.md", "BUILD-INFO.txt")]
files += sorted((source / "src").rglob("*"))
with ZipFile(destination / "M5StickS3-Motion.zip", "w", ZIP_DEFLATED) as archive:
    for file in files:
        if file.is_file():
            archive.write(file, file.relative_to(source).as_posix())
(destination / "SETUP.md").write_bytes((source / "SETUP.md").read_bytes())
print("Packaged M5StickS3 firmware source and setup instructions")
