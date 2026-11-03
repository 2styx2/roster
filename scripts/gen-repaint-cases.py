"""Write the repaint cases the core's screen and xterm.js are both checked on (ticket 155c, the review of #318).

    python3 scripts/gen-repaint-cases.py

writes two fixtures in crates/roster-core/tests/fixtures/:

- repaints.json: hand-made cases, each with what it must do: "same" (both leave the screen as it was),
  "changed" (both change it), "refused" (xterm.js shows a change and the core refuses), "refused anyway"
  (the core refuses, whatever xterm.js shows). screen.rs and app/src/terminal/repaints.test.ts run them.
- repaint-fuzz.json: random repaints from a fixed seed, with no verdict yet. Then
  `ROSTER_WRITE_REPAINT_FUZZ=1 cargo test -p roster-core --lib repaint_fuzz` writes the core's verdicts into it,
  and repaints.test.ts checks that xterm.js leaves the screen as it was wherever the core says it does. The
  Rust test fails while the core's verdicts differ from the file, so a change to the screen comes with the
  verdicts it gives, and xterm.js checks them. Standard library only.
"""

import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "crates/roster-core/tests/fixtures"
E = "\x1b"
P = f"{E}[2J{E}[H{E}[92m{E}[1mops@esx-02{E}[m:~$ sudo -v\r\n[sudo] password for ops: "
MOTD = f"{E}[2J{E}[H$ sudo -v\r\n[sudo] password for ops: \r\nmotd{E}[2;26H"
BOLD = f"{E}[2J{E}[H$ sudo -v\r\n{E}[1m[sudo]{E}[m password for ops: "
RGB = f"{E}[2J{E}[H$ sudo -v\r\n{E}[38;2;1;2;3m[sudo]{E}[m password for ops: "
FUZZ_SEED = 1
FUZZ_CASES = 1000


def table() -> list[dict]:
    """The hand-made cases."""
    cases: list[dict] = []

    def c(name: str, after: str, kind: str, before: str = P) -> None:
        cases.append({"name": name, "before": before, "after": after, "kind": kind})

    def raw(name: str, chunks: list[bytes], kind: str, before: str = P) -> None:
        """A case whose output isn't text (bytes UTF-8 doesn't allow), in the chunks it comes in."""
        cases.append({"name": name, "before": before, "after_hex": [b.hex() for b in chunks], "kind": kind})

    # ConPTY's repaints of the same screen (microsoft/terminal src/renderer/vt/).
    c(
        "every row, blanks erased in their buffer colour",
        f"{E}[?25l{E}[H{E}[92m{E}[1mops@esx-02{E}[m:~$ sudo -v{E}[37m{E}[60X\r\n{E}[m[sudo] password for ops:{E}[1m{E}[55X{E}[22m\r\n{E}[37m{E}[K\r\n{E}[K{E}[m{E}[2;26H{E}[?25h",
        "same",
    )
    c(
        "trailing blanks written as coloured, italic spaces",
        f"{E}[?25l{E}[2;1H{E}[39m[sudo] password for ops:{E}[93m{E}[3m    {E}[23m{E}[39m{E}[2;26H{E}[?25h",
        "same",
    )
    c("01 for 1, 0 for nothing", f"{E}[?25l{E}[1;1H{E}[01;92mops@esx-02{E}[0m:~$ sudo -v{E}[2;26H{E}[?25h", "same")
    c("39, 49 and 22 for a reset", f"{E}[H{E}[92;1mops@esx-02{E}[39;49;22m:~$ {E}[2;26H", "same")
    c(
        "a title, a hyperlink's end, the cursor's blink and shape, BS",
        f"{E}]0;sudo\x07{E}]8;;{E}\\{E}[?12l{E}[?12h{E}[2 q{E}[2;27H\x08",
        "same",
    )
    c("CUF", f"{E}[2;1H{E}[25C", "same")
    c(
        "256 colours, true colour, curly underline and its colour, set and back",
        f"{E}[38;5;196m{E}[48;2;1;2;3m{E}[58:5:4m{E}[4:3m{E}[m{E}[2;26H",
        "same",
    )
    c("ESC[3J right after ESC[2J, then the screen redrawn", f"{E}[2J{E}[3J" + P[len(f"{E}[2J") :], "same")
    c(
        "true colour with an empty colour space, as with semicolons",
        f"{E}[2;1H{E}[38:2::1:2:3m[sudo]{E}[m{E}[2;26H",
        "same",
        RGB,
    )
    c(
        "4: is a single underline, as 4",
        f"{E}[2;1H{E}[4:m[sudo]{E}[m{E}[2;26H",
        "same",
        f"{E}[2J{E}[H$ sudo -v\r\n{E}[4m[sudo]{E}[m password for ops: ",
    )
    # The same forms drawing something that shows.
    c("blanks erased with a background", f"{E}[2;26H{E}[44m{E}[55X{E}[m", "changed")
    c("a row erased with a 256-colour background", f"{E}[3;1H{E}[48;5;4m{E}[K{E}[m{E}[2;26H", "changed")
    c("blanks underlined", f"{E}[2;26H{E}[4m   {E}[24m{E}[2;26H", "changed")
    c("a blank reversed", f"{E}[2;26H{E}[7m {E}[27m{E}[2;26H", "changed")
    c("a blank struck through", f"{E}[2;26H{E}[9m {E}[29m{E}[2;26H", "changed")
    c("a blank overlined", f"{E}[2;26H{E}[53m {E}[55m{E}[2;26H", "changed")
    c("bold text in 16-colour green, not bright green", f"{E}[H{E}[32m{E}[1mops@esx-02{E}[m{E}[2;26H", "changed")
    c("bold text in true-colour green", f"{E}[H{E}[38;2;0;255;0m{E}[1mops@esx-02{E}[m{E}[2;26H", "changed")
    c("the screen cleared", f"{E}[2J{E}[2;26H", "changed")
    c("4: underlines (#318 review, 3)", f"{E}[2;1H{E}[4:m[sudo]{E}[m{E}[2;26H", "changed")
    c("4:9 underlines (#318 review, 3)", f"{E}[2;1H{E}[4:9m[sudo]{E}[m{E}[2;26H", "changed")
    # The review of #318: what xterm.js draws and the model mustn't take as the same screen.
    c("EL 5 leaves the line as it is (#318 review, 1)", f"{E}[4;1Hevil{E}[4;1H{E}[5K{E}[2;26H", "changed")
    c("ED with a sub-parameter (#318 review, 2)", f"{E}[3;1H{E}[0:3J{E}[2;26H", "refused", MOTD)
    c("EL with a sub-parameter (#318 review, 2)", f"{E}[3;1H{E}[0:2K{E}[2;26H", "refused", MOTD)
    c("CUP with sub-parameters (#318 review, 2)", f"{E}[0:2;2:6H", "refused", MOTD)
    c(
        "38:2:R:G:B, four sub-parameters (#318 review, 4)",
        f"{E}[2;1H{E}[38:2:1:2:3m[sudo]{E}[m{E}[2;26H",
        "refused",
        RGB,
    )
    c("past 32 parameters (#318 review, 5)", f"{E}[2;1H{E}[" + ";" * 32 + f"1m[sudo]{E}[m{E}[2;26H", "refused", BOLD)
    # Where the model now follows xterm.js (the review of #318): a pending wrap kept by SGR, an OSC,
    # a tab and an erase; controls inside a CSI; DECRC's colours; lines inserted from the line's start;
    # a scroll down in default blanks; BEL inside a DCS.
    AC = P + f"{E}[3;79Ha{E}[1mc{E}[m{E}[2;26H"
    c("an SGR keeps a pending wrap", f"{E}[3;79Hab{E}[1mc{E}[m{E}[2;26H", "changed", AC)
    c("an OSC keeps a pending wrap", f"{E}[3;79Hab{E}]0;t\x07{E}[1mc{E}[m{E}[2;26H", "changed", AC)
    c("a tab keeps a pending wrap", f"{E}[3;79Hab\t{E}[1mc{E}[m{E}[2;26H", "changed", AC)
    c("an erase to the end from a pending wrap erases nothing there", f"{E}[3;80Hx{E}[K{E}[2;26H", "changed")
    c("a CR inside a CSI acts", f"{E}[2;20H{E}[\r6C", "changed")
    c(
        "DECRC restores the colour",
        f"{E}[31m{E}7{E}[m{E}8{E}[3;1Hx{E}[m{E}[2;26H",
        "same",
        P + f"{E}[3;1H{E}[31mx{E}[m{E}[2;26H",
    )
    c("the alternate screen and back", f"{E}[?1049h{E}[5;5Hvim{E}[?1049l", "same")
    c(
        "an inserted line puts the cursor at the line's start",
        f"{E}[24;5H{E}[Lx{E}[2;26H",
        "same",
        P + f"{E}[24;1Hx{E}[2;26H",
    )
    c("a scroll down brings in default blanks", f"{E}[44m{E}[S{E}[T{E}[m", "same", f"{E}[2J{E}[5;1Hx{E}[5;2H")
    c("BEL doesn't end a DCS", f"{E}P\x07abc{E}\\", "same")
    # The model refuses, whatever xterm.js draws.
    c("ESC[3J alone (#318 review, 6)", f"{E}[3J", "refused anyway")
    c("U+0080 after a space (#318 review, 7)", f"{E}[2;25H \x80{E}[2;26H", "refused anyway")
    c("a palette change (OSC 4)", f"{E}]4;1;rgb:ff/00/00\x07", "refused anyway")
    c("a wide character", f"{E}[3;1H\u4e2d{E}[3;1H  {E}[2;26H", "refused anyway")
    c("a private CUU", f"{E}[?5A", "refused anyway")
    c("SGR 6, which xterm.js ignores", f"{E}[6m{E}[m", "refused anyway")
    c("a CSI with an intermediate (SR)", f"{E}[1 A", "refused anyway")
    # The second review of #318: raw bytes (#3), a sequence between ED 2 and ED 3 (#7), and what
    # the screen lost track of before the check (#1, #2, #6).
    esc = b"\x1b"
    raw("a stray continuation byte after a space", [esc + b"[2;25H \x80" + esc + b"[2;26H"], "refused anyway")
    raw("0xC0, never in UTF-8", [esc + b"[2;25H\xc0\x80" + esc + b"[2;26H"], "refused anyway")
    raw("0xF5 and up, never in UTF-8", [esc + b"[2;25H\xf5\x80\x80\x80\xff" + esc + b"[2;26H"], "refused anyway")
    raw("a character cut short", [esc + b"[3;1H\xe4\xb8" + esc + b"[2;26H"], "refused anyway")
    raw(
        "ED 3 as a C1 CSI right after ED 2, split across chunks, then the screen redrawn",
        [esc + b"[2J\xc2", b"\x9b3J" + P[len(f"{E}[2J") :].encode()],
        "same",
    )
    raw("a C1 CSI split across chunks", [b"\xc2", b"\x9b3;1Hx" + esc + b"[2;26H"], "changed")
    c("an OSC between ED 2 and ED 3", f"{E}[2J{E}]0;t{E}[3J" + P[len(f"{E}[2J") :], "refused anyway")
    for name, earlier in [
        ("insert mode", f"{E}[4h"),
        ("a DEC graphics charset", f"{E}(0"),
        ("a scroll region", f"{E}[5;10r"),
        ("an SGR xterm.js reads otherwise", f"{E}[1:2m"),
        ("a wide character drawn and overwritten", f"{E}[3;1H\u4e2d{E}[3;1H  "),
        ("a combining mark", f"{E}[3;1He\u0301"),
        ("synchronized output", f"{E}[?2026h"),
    ]:
        c(f"{name}, before the check", f"{E}[2;26H", "refused anyway", earlier + P)
    c("a palette change before the check", f"{E}[2;26H", "same", f"{E}]4;1;rgb:ff/00/00\x07" + P)
    return cases


def sgr(rng: random.Random) -> str:
    """An SGR, in forms xterm.js reads plainly and not."""
    opts = [
        "",
        "0",
        "1",
        "2",
        "3",
        "4",
        "4:3",
        "4:",
        "4:0",
        "4:7",
        "5",
        "7",
        "8",
        "9",
        "21",
        "22",
        "23",
        "24",
        "27",
        "29",
        "53",
        "55",
        "32",
        "92",
        "39",
        "44",
        "49",
        "38;5;2",
        "38;5;10",
        "38:5:10",
        "38;2;1;2;3",
        "38:2::1:2:3",
        "38:2:1:2:3",
        "48;5;4",
        "58:5:4",
        "59",
        "01",
        "1:2",
        "6",
    ]
    return f"{E}[" + ";".join(rng.choice(opts) for _ in range(rng.randint(1, 3))) + "m"


def token(rng: random.Random) -> str | bytes:
    """One thing a repaint may hold."""
    row, col = rng.choice([(2, 26), (2, 1), (1, 1), (3, 1), (2, 80), (3, 80), (24, 1), (24, 80), (1, 12)])
    choices = [
        lambda: f"{E}[{row};{col}H",
        lambda: rng.choice(["x", " ", "  ", "[sudo]", "ops", "$", "*"]),
        lambda: sgr(rng),
        lambda: sgr(rng),
        lambda: f"{E}[{rng.choice(['', '0', '1', '2', '3', '5', '0:2'])}K",
        lambda: f"{E}[{rng.choice(['', '0', '1', '2', '3', '4', '0:3'])}J",
        lambda: f"{E}[{rng.choice(['', '1', '3'])}{rng.choice('XP@LMST')}",
        lambda: rng.choice(["\r", "\n", "\x08", "\t", "\x07"]),
        lambda: rng.choice(
            [
                f"{E}7",
                f"{E}8",
                f"{E}[s",
                f"{E}[u",
                f"{E}[?1049h",
                f"{E}[?1049l",
                f"{E}[?25l",
                f"{E}[?25h",
                f"{E}[?12h",
                f"{E}[2 q",
            ]
        ),
        lambda: rng.choice(
            [f"{E}]0;t\x07", f"{E}]8;;{E}\\", f"{E}P\x07ab{E}\\", f"{E}_x{E}\\", f"{E}]4;1;rgb:ff/00/00\x07"]
        ),
        lambda: f"{E}[{rng.choice(['', '1', '5', '80'])}{rng.choice('ABCDEFGadef`')}",
        lambda: rng.choice([b"\x80", b"\xc0\x80", b"\xff", b"\xe4\xb8", b"\xc2\x9b2;26H", b"\xc2"]),
        lambda: rng.choice(
            [
                f"{E}[1b",
                f"{E}[?5A",
                f"{E}[1 A",
                f"{E}[2\r;26H",
                f"{E}D",
                f"{E}M",
                f"{E}E",
                f"{E}c",
                "é",
                "中",
                "é",
                "\xc3",
                f"{E}(0",
                f"{E}(B",
            ]
        ),
    ]
    return rng.choice(choices)()


def fuzz() -> list[dict]:
    """Random repaints of P, most ending with the cursor put back."""
    rng = random.Random(FUZZ_SEED)
    cases = []
    for _ in range(FUZZ_CASES):
        parts = [token(rng) for _ in range(rng.randint(1, 6))]
        after = b"".join(t if isinstance(t, bytes) else t.encode() for t in parts)
        if rng.random() < 0.7:
            after += f"{E}[m{E}[2;26H".encode()
        cases.append({"after_hex": after.hex(), "same": None, "at_prompt": None, "diverged": None})
    return cases


def main() -> None:
    about = (
        "Repaints fed to the core's screen (screen.rs) and to xterm.js (app/src/terminal/repaints.test.ts), from "
        "scripts/gen-repaint-cases.py: 'same' leaves both as they were; 'changed' changes both; 'refused' changes "
        "what xterm.js shows and the core refuses it; 'refused anyway' the core refuses, whatever xterm.js shows "
        "(ticket 155c, the review of #318)."
    )
    (FIXTURES / "repaints.json").write_text(json.dumps({"about": about, "cases": table()}, indent=1) + "\n")
    fuzz_about = (
        "Random repaints of `before` (scripts/gen-repaint-cases.py), as bytes; `same` (the screen matches), "
        "`at_prompt` (the cursor right after `[sudo] password for ops:`) and `diverged` (the screen lost track) "
        "are the core's, written by ROSTER_WRITE_REPAINT_FUZZ=1 cargo test -p roster-core --lib repaint_fuzz; "
        "xterm.js must agree wherever the core says the same, and on `at_prompt` wherever it hasn't lost track "
        "(ticket 155c)."
    )
    (FIXTURES / "repaint-fuzz.json").write_text(
        json.dumps({"about": fuzz_about, "before": P, "cases": fuzz()}, indent=0) + "\n"
    )


if __name__ == "__main__":
    main()
