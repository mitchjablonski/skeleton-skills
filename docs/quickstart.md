# skel quickstart

Default mode, for agents and humans. The agent runs every `skel` command; the
human reviews, decides, and answers Claude Code's permission prompts.

1. **Human:** set up the project once with `skel install`, then restart
   Claude Code so it loads the hooks and deny rules (see
   [Install](../README.md#install)).
2. **Agent:** `skel init "<title>"`, write the skeleton (real files and
   signatures, every body a fenced `SKEL_TODO` stub), then `skel serve` and
   give the human the whole URL, including `#t=…` (`skel review` writes a
   static page instead).
3. **Human:** review the page and paste the copied feedback, or say yes in
   chat.
4. **Agent:** apply every comment. After the human approves, run
   `skel approve`: bare when they said yes in chat, or
   `skel approve --reviewed <version>` with the version from the feedback
   they pasted. Never pass a version the human didn't give you. Its
   permission prompt is the human's approval, so run it only after their yes.
5. **Agent, per step:** `skel next`, fill only inside the active fences,
   test, then `skel done`.
6. **Agent:** run the full project test suite, then ask the human whether to
   finalize. **Human:** yes. **Agent:** `skel finalize`. The human answers
   its permission prompt only after explicitly agreeing to finalize.

When skel refuses:
- **`done`, `SKEL_TODO` left:** finish that step's fences.
- **`done` or `finalize`, drift** (a `file:line` diff outside the fences, a
  whitespace-only change, or a new, changed or deleted file): restore only the
  reported lines. Or propose the structural change; once the human agrees,
  `skel reshape`, edit, and get the new version approved.
- **The hook asks about, or refuses, an edit outside the fence:** that's a
  skeleton change. Propose it, and don't retry it another way.
- **`approve`, a diff since the reviewed version:** tell the human what
  changed and have them reload the page and look again. Then approve with the
  new `--reviewed` from their paste, or bare after a new yes in chat.
- **A step filled without `skel next`:** `skel start <id> --force` reopens it,
  so `skel done` can check it.
