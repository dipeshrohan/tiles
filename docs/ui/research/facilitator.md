# Facilitator's script

What the moderator says and does in one 60-minute session of [the study](README.md). Read the words in quotes as they are, so every participant hears the same thing; the rest is what to do. One moderator runs the session; a note-taker, where there is one, keeps the clock and the scoring sheet.

## Contents

- [Before the participant arrives](#before-the-participant-arrives)
- [Welcome and consent (5 min)](#welcome-and-consent-5-min)
- [The tasks (40 min)](#the-tasks-40-min)
- [Helping](#helping)
- [The questionnaire (5 min)](#the-questionnaire-5-min)
- [Debrief (10 min)](#debrief-10-min)
- [After the participant leaves](#after-the-participant-leaves)

## Before the participant arrives

- [ ] Tiles reset and the plant loaded within the last 30 minutes ([setup](setup.md#before-each-session)), so the warnings are a few hours old, not a day.
- [ ] The participant's browser on the welcome for their code ([the participant's browser](setup.md#the-participants-browser)), at 1440 × 900.
- [ ] `batches.csv` on the desktop.
- [ ] The screen and voice recording ready, not started.
- [ ] Printed: the [consent form](consent.md), the [task cards](cards.md) in order, the [questionnaire](README.md#the-questionnaire).
- [ ] The round's scoring sheet open: `tasks.csv` (with `errors`), `sus.csv` and `participants.csv` from [template/](template/).
- [ ] A stopwatch, or the recording's clock.

## Welcome and consent (5 min)

"Thanks for coming. I'm going to ask you to try some everyday tasks in Tiles, a program for the plant's data. We're testing Tiles, not you: if something is hard, that's what we need to find out, and nothing you do can be wrong."

"Please think aloud as you go: say what you're looking for, what you expect to happen, and what surprises you. I'll stay quiet most of the time; that's on purpose. If you get stuck, keep trying the way you would at work. I'll step in if I need to."

"The data here is made up. Nothing you change reaches a real plant, so try whatever you like."

Hand over the [consent form](consent.md). "This says what we record and what happens to it. Take your time, and ask about anything." Once it is signed, start the recording and say the participant code and the date aloud, never their name.

## The tasks (40 min)

"I'll read each task from a card and leave the card with you. Tell me when you think you're done. Some tasks have a time limit; if we reach it I'll ask you to stop, and that's fine."

For each card, in the order of [the task cards](cards.md): `first-page`, `home-now`, `triage`, `plot`, `commit`, `correlate`, `copilot`, `site`.

1. Read the card aloud and put it down. Start the clock.
2. Watch, and note what they do. If they go quiet for half a minute: "What are you thinking now?" That is a prompt, not a hint.
3. Stop the clock when they say "done", or at the time limit: "Let's stop this one there; thank you."
4. If they asked a question on the way, answer it now (unless the next task depends on it).
5. Before the next card, put Tiles where that card starts (most start on Home: open it from the menu yourself). For the commit task, approve the change request once the clock has stopped; for the site task, make them an organisation admin before the card ([during the session](setup.md#during-the-session)).

Run short of time: drop `copilot`, then `correlate`, and note it in their row. Never drop `first-page`; it can only be done once.

## Helping

Don't, unless the participant has been stuck for a minute, or asks twice. Then, in this order, stopping at the first that works:

1. "What would you try next?"
2. "Where would you expect to find that?"
3. Point to the area of the screen (the menu, the page), without naming the control.
4. Name the page or the control.

Any of 3 or 4 makes the task `assisted`; 1 and 2 don't. Write what was said in `notes`. Questions to answer straight away, without it counting: what a word on the card means (`ng` is scrapped), and whether the data is real (it isn't).

Neutral replies to "Is this right?": "What do you think?", or "Do what you'd do at work."

## The questionnaire (5 min)

Before any discussion, so the debrief doesn't colour the answers: "Here are ten statements about Tiles. For each, circle how much you agree, from 1 for strongly disagree to 5 for strongly agree. Go with your first reaction." Hand over [the questionnaire](README.md#the-questionnaire), in their language. Check all ten are answered, one number each.

## Debrief (10 min)

Ask these in order, and follow up on anything they bring up:

1. "What was the hardest part?"
2. "Was there anything you expected to find that wasn't there?"
3. "If you could change one thing in Tiles, what would it be?"
4. "Which of today's tasks is closest to what you do in a normal week? How do you do it now?"
5. "Anything I should have asked and didn't?"

Then: "Thank you, that's everything. What you found today goes straight into what we change next." Stop the recording.

## After the participant leaves

- Finish their rows in `tasks.csv` (one per task tried, with `outcome`, `seconds` for a success, `errors` and `notes`), `sus.csv` and `participants.csv`, from the notes and the recording, the same day.
- Note each problem seen, with the task and how badly it hit (blocks the task, slows it, annoys), for the report's problem list.
- Check the [consent form](consent.md)'s ticks before keeping any quote or clip.
- Reset Tiles for the next participant.
