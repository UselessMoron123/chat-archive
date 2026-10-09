# Agent instructions

## Archives (.zip / .rar / .partN.rar / .7z)
Do NOT probe for unrar/7z/apt/pip. Just run:

    tools/extract.sh "<archive>" /tmp/extracted

- Extract to /tmp (or another git-ignored dir), never into the repo tree, and never commit tool folders.
- /tmp is wiped between turns: re-run the script at the start of each turn (it takes about 3 s).
- For multi-volume archives, any part works. The script switches to part1 itself.
- Nested archives get listed at the end. Run the script again on each one.
