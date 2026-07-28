---
name: prose-style
description: How documentation prose should read for low reader effort. Use when writing or editing any doc or page, when asked to make something clearer, simpler, or more readable, when someone says a page "reads weird", when tightening prose, or when reviewing writing.
---

# Prose style

This skill governs **how a page reads**, not where a fact belongs or whether it
is true. Placement and staleness are a separate question; correctness is a
separate question again.

Goal: low cognitive load. Tell the reader what things are. Stay concise; explain
only where detail is needed. No flowery padding. Headings are scanned first;
detail is found where needed. Use an analogy only when it earns its place.

Not a goal: "sounding human", or scoring well on an AI-writing detector. Those
detectors key on genre, so an argumentative technical document scores the same
whoever wrote it. Optimising for one changes how a page sounds without changing
how much work it costs to read. Write rules that reduce the reader's work.

## Rules

1. **Headings are the interface.** A heading says what the section *gives*, not
   a topic label. Prefer a takeaway headline — "Retries stop after the third
   failure" over "Retry behaviour"; "Your existing config keeps working" over
   "Migration". Someone reading only the headings should get the argument.

   The takeaway form is the Narrative form (rule 11). The other two registers
   take other forms, and forcing the takeaway onto them costs more than it buys:

   - **Instruction: a bare infinitive naming the action.** "Create an instance",
     not "Creating an instance" and not "You can create an instance". The
     heading *is* the step.
   - **Reference: the lookup key itself** — see the exception below.

   One cost to hold in view: a takeaway heading often drops the word a searcher
   would type. "Your existing config keeps working" beats "Migration" for a
   reader scanning the argument, and loses to it for a reader who arrived from a
   search box. Where a page's traffic is search, keep the keyword in the heading
   and put the takeaway in the lead sentence.

   **Exception: when the heading IS a lookup key, the key is the takeaway.** An
   API signature, a version number, a verbatim error string, a config option, a
   CLI flag — the reader is scanning for that exact token, and replacing it with
   a sentence makes the page unusable. Leave the key and put the takeaway in the
   lead sentence instead. On a reference page that is most of the headings, and
   the "reading only the headings gives you the argument" test does not apply:
   such a page has no argument, it has an index.

2. **Lead with the point.** The first sentence of a section *is* the conclusion.
   Detail follows. Never build up to it.

   With a takeaway heading, the lead sentence goes one level more specific
   rather than repeating it — the heading claims, the sentence says on what.
   That is what rule 5's ban on restating your own heading means; it is not an
   instruction to bury the conclusion.

3. **Say what the thing IS, early and plainly.** Before mechanism, one
   definitional sentence a newcomer could repeat. Definition first, how second.
   You may not invent a definition the page does not already support — flag the
   gap and name the missing term instead. Every pass under this skill is a
   wording pass; see the Gate.

4. **Altitude rule.** Every fact has a home section. If the reader does not need
   a number to make the decision *this page* serves, it is flying too high.

   Two limits, because this is the rule most often misapplied. It is a
   *structural* observation, not an edit: this skill never moves a fact off a
   page, it reports that the fact looks misplaced. And a report is only useful
   when you can name where it belongs. With one page, or no map of the others,
   keep the fact and say it looks out of place.

5. **Concision without amputation.** Short paragraphs, 2–4 sentences, one
   thought each. Cut throat-clearing and any sentence that restates its own
   heading. Keep load-bearing qualifiers — as their own short sentence if
   needed.

6. **No flowery nonsense — two bans:**
   - **Meta-narration** — sentences about the document, not the subject
     ("stated plainly", "this page does not pretend otherwise", "one feature
     deserves emphasis"). Delete. Never write a replacement for it; if it
     happened to carry a fact, that fact moves into the surrounding prose.
   - **Performed sincerity** — sentences whose job is to cast the writer as
     honest rather than to convey a fact. Antithesis zingers ("it isn't X, it's
     Y"), announced candour, announced simplicity. Fix: state the fact, cite the
     evidence, stop. Disclosure *is* the credibility; narrating the disclosure
     destroys it.

   Detection for both: if deleting the sentence removes no fact, delete it.
   Both bans apply to headings as well — an "it isn't X, it's Y" heading is the
   same move in the most-read position on the page.

7. **Plain verbs, no nominalisations.** "utilisation of" / "deployment of" /
   "formalisation of" → find the verb. Things get bought, run, read, blocked.

8. **Jargon: define on first use, then use freely — or do not use it.** A term
   that appears once on a page → plain English, no definition theatre. Where a
   term is load-bearing and undefined, you cannot invent the definition (rule 3)
   and you cannot drop the term — flag it as an undefined term the page needs.

9. **Analogies only when they earn it.** One good analogy can replace a
   definitional paragraph. A forced analogy costs more than it saves. If the
   plain sentence is clear, ship the plain sentence.

10. **Say it once.** State a mechanic in its home section; cross-reference
    elsewhere. Repetition is padding.

11. **Register follows the reader's job, and holds within a section.** Ask what
    the reader is doing on this page, not what kind of page it is called. Three
    jobs — and the split between the last two is the one that gets missed.
    - **Narrative** — the reader is *deciding* or *understanding*, and reads
      start to finish. Continuous prose; one thought leads to the next; no
      bolded paragraph lead-ins; no staccato fragment chains. **The subject is
      the reader's situation.**
    - **Instruction** — the reader is *doing*, and follows along. Numbered
      imperative steps, one action each, conditions before the action. **The
      subject is the reader** — stated ("you run…") or implied by the imperative
      ("Run…"). A tool-side subject here is a real defect.
    - **Reference** — the reader is *looking something up*, and scans for the
      one entry they need. Headings are lookup keys (rule 1's exception);
      tables, short lines, code blocks. Description is neutral: no instruction,
      no argument. **The subject is the machinery, and that is correct.** A
      reference entry describes a thing, so the thing is what the sentence is
      about, and the page is ordered by the shape of the thing. Rewriting the
      `--json` entry to be about the reader makes it unfindable.

    Instruction and Reference both scan, which is why they get merged — an
    earlier version of this rule merged them. They differ in *who the sentence is
    about*, and that difference decides whether a tool-side subject is a defect
    or the specification. Diátaxis and Carroll's minimalism research split them
    the same way, thirty years apart, one from theory and one from lab studies.

    Most pages are one of the three, and drifting between them mid-paragraph is
    what makes a page feel machine-made. But a genuinely mixed page is normal —
    a tutorial that argues for an approach and then lists the steps, an
    explanation with a parameter table at the end. **Do not flatten one to
    satisfy this rule.** Hold the register within each section and let the
    section boundary carry the switch. Guessing which register a whole page "is"
    when the answer is both means the rule is being applied at the wrong scale.

12. **Read-aloud test.** Read the section as if to a colleague. Anywhere you run
    out of breath or lose the thread, rewrite.

## Banned / preferred

| Pattern | Delete or rewrite |
|---|---|
| Meta: "stated plainly", "this page does not…", "one feature deserves emphasis", "what this page is for/not" as throat-clear | Delete the sentence. Put the content under a takeaway heading if it carries a fact. |
| Performed sincerity: "Claims are cheap…", "It isn't X, it's Y", "honest answer is", "we will not pretend" | State the fact and evidence; stop. |
| Nominalisation: "utilisation of X", "deployment of Y", "the formalisation of" | Use the verb: use X, deploy Y, formalise. |
| Hedge stack: "may potentially somewhat", "it is possible that it might" | One qualifier max, or cut. |
| Throat-clear: "It is worth noting that", "To understand X, one must first…" | Start with the point. |
| Heading restatement as first sentence | Cut; open with the next fact. |

## What counts as a heading

Rule 1 covers every string the reader scans before committing to a section:
section headings, and the page's own title and one-line description wherever the
site stores them (frontmatter, a config file, a docstring). A title that labels
a topic wastes the most-read string on the page.

## Revision workflow

1. **Believe** — one sentence: what must the reader believe after this section?
2. **Facts** — list every load-bearing fact, command, number, and path the
   section must not drop. Claims stay byte-identical.
3. **Rewrite top-down** — takeaway heading → lead sentence = conclusion →
   detail → cut the bans from rule 6.
4. **Diff facts** — every item from step 2 still present; no new invented claims.
   A fact that rule 4 says belongs elsewhere still counts as present: report the
   misplacement, do not silently drop it.
5. **Read aloud** — fix breath and thread breaks (rule 12).
6. **Report** — return four things, not one: the revised prose; word count
   before → after; every gap and misplacement you flagged under rules 3, 4 and
   8; and any fact you suspect is wrong (the Gate). A report that returns only
   prose silently drops the other three.

   This skill produces a rewrite for its caller to apply. It does not edit
   files, and an agent running it may have no write access at all.

## Gate

A pass that changes a path, command, number, quoted transcript, or verified
claim is a defect. Report the suspected error; do not "fix" facts under this
skill.

Headings are also link targets. A heading is usually an anchor other pages,
bookmarks, and navigation configs point at, and a title is often the sidebar
label. Rewriting one can break inbound links without touching a single fact —
so flag heading changes as needing a redirect or reference sweep, and say so in
the report.
