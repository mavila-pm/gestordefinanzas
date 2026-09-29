from pathlib import Path
import shutil, subprocess, sys
brand=Path(__file__).resolve().parents[1]
dst=Path.cwd()/"VELSUNO_REBUILD"
if dst.exists(): raise SystemExit("Choose an empty working directory; VELSUNO_REBUILD already exists.")
(dst/"work").mkdir(parents=True)
shutil.copytree(brand,dst/"output"/"VELSUNO")
for n in ["build.py","book.py","docs.py"]:shutil.copy2(brand/"source"/n,dst/"work"/n)
shutil.copy2(brand/"fonts"/"Manrope-variable.ttf",dst/"work"/"Manrope.ttf")
for n in ["build.py","book.py","docs.py"]:subprocess.run([sys.executable,"work/"+n],cwd=dst,check=True)
print(dst/"output"/"VELSUNO")
