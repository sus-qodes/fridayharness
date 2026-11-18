# Changelog

All notable changes, one section per milestone tag. Format: what changed for someone using or building Friday.

## Unreleased — the trial's fault list, part 7: screens for people

From the trial: "what is this token last tool… whats the use of user to know this?", a button standing out of a goal card, "no way to come back to this agent screen", and switching projects that looked like the app starting again.

- **Agent cards say who, what and what for.** Each card has the agent's name and job, one sentence for what it is doing ("Working on “Settings screens”", "Waiting for you on …", "Free: it starts a task by itself"), the file it is on, and the model with what it has spent so far. Tokens and how long its last action took are in that line's tooltip. "Reported" and "Unverified" are gone: "Friday watches only" or "Checks not confirmed" is said when it matters, with the explanation in the tooltip, and nothing when Friday checks every action, which is the usual.
- **Your projects, in one menu.** The project's name opens the projects you opened lately, with "open now", "Friday running" or "folder not found", and "Open another folder…". Choosing one switches in this window and says so.
- **A way back from the model choices.** "Open the model choices" and "Connect Antigravity" in Start an agent now have a Back button, and what you had typed is there when you come back.
- **The checks card in plain words.** It is "Your project’s tests", it says they are optional and what Friday still checks without them, and a project with none is told that is fine while it is starting.
- **Nothing sticks out of a goal card.** Cancelling a goal is a small button with its words in its tooltip, "Change this goal…" is "Change…", and the footer cuts a button short rather than letting it out of the card. The "Agents" label is drawn above the cards.
- **Messages do not pile up.** The same message said again replaces itself, and three at most stand at once.

## Unreleased — the trial's fault list, part 6: what you see is true

From the trial: a goal that had landed still said "Ready to land" half an hour later, an agent card counted 14k tokens for $0.98, and a task in the project folder showed 13 changed files for one.

- **A landed goal says "Landed".** Its card changes the moment it lands. A goal you merged yourself, in git or in VS Code, is noticed within half a minute and says "Landed" too; there is no "Mark as landed" to press any more. A goal whose tasks changed nothing is not taken for landed.
- **The landing dialog is written for people.** It is titled "Land this goal", "Landed" or "Review and commit", by what there is to do. Merging by hand is folded away under "Merge it yourself instead", and the line saying Friday never merges, beside the button that merges, is gone. "What Friday did" reads "Tasks that passed their checks", "Work the checks sent back", "Times an agent asked you", "Agents that stopped midway", "What the agents used".
- **Land warns when an agent is at work in your folder.** "antigravity-1 is working in your project folder right now": the question says so and its button reads "Land anyway". Landing by itself waits until that work is done.
- **Tokens are counted one way for every agent.** The whole prompt, what was read from and written to the cache included, plus the answer. Claude's figures left the cache out, which is most of the work, so they looked small beside their cost; Codex's included it. Codex reports no cost, and Friday does not guess one.
- **A task in your project folder counts only its own changes.** Friday's setup files and your own edits are left out, as its checks already left them out.
- **Why this agent, why this model.** Each task says it: "Why claude-1: the best fit of the free agents. Why Claude Opus 5.5: you chose it for every task (Settings → Models)." When one model is chosen for everything, the Models page says what it costs beside a less costly one.
- **The code graph has no error codes for what is not there yet.** A file a task made in its own copy shows "Nothing to show yet: it appears once the goal is landed". The button is only offered for files.
- **"No related tests" is said less often, and only when true.** A test that reaches a file through an index or a package's entry counts as testing it. The note says it is worth a look, not a failure.

## Unreleased — the trial's fault list, part 5: agents at work at the same time

In the trial seven goals ran, and at no moment were two agents at work. Every plan listed the project's changelog, and a task waited for every running task that might touch one of its files.

- **Tasks that share a few files run side by side.** Each agent Friday starts works in a copy of its own, so two tasks may both add to a list of routes, a file of texts or a changelog, as long as each also has files that are its own. Two tasks whose work is in the very same files still run one after the other. An agent you run yourself (Antigravity, Claude Code in an editor) works in your project folder, so on shared files it still waits its turn.
- **Two additions at the same place are both kept.** Git calls it a conflict when two tasks each add a line at the end of the same list. Friday keeps both, the earlier task's first, and checks the result as it checks any merged work. Only where both sides added and neither changed a line that was there: never in a lockfile, a file both created, or a file one of them deleted.
- **A real collision goes back to the agent, not to you.** Friday merges the other tasks' work into the agent's copy and leaves the colliding file with both versions marked. The agent finishes it by editing, with no git command, and a claim is refused while a mark is left. The same when work passes its checks alone and fails once merged: the agent gets the other work and the name of the failing check. After two tries you are asked, with **Let the agent fix it** as the first button. The number is `integration.back_to_agent` in config.yaml; 0 asks you at once, as before.
- **The planner splits work by itself, and stops chaining.** It is told that a shared file is no reason to run tasks one after another, to give independent parts a task each, and how many agents can work at once right now. A small goal is still one task, and so is work in parts that would run one after another anyway because only one agent is connected. A plan you write yourself is checked by the same rule.
- **A task that has not started says why.** "Waits for “Wizard screens” (claude-1 is working on it)", "next for claude-1, after …", "no agent is free right now", "Friday is paused". The waiting list says "Your turn" only when prompting your agent would start the task; before, it said so for a task that could not start.
- **Each task gets the whole of what the tasks before it reported**, no longer the first 320 characters. And it is told which files it shares with tasks running beside it, and to only add its own lines there.
- **An agent stopped at the edge of its task's files asks you.** The card names the file outside the task's files and offers **Allow this file…** (for the rest of the task) first, then **Just this edit**, or Deny. The agent goes on with the rest meanwhile and is told your answer; a no is not asked about again. Before, it was refused and told how to ask, and usually wrote somewhere else instead. Files the project's policy or the agent's team keeps are refused as they were.
- **The plan's files include what the project's own rules require.** The planner is told to put into a task's files every file its documents say such work must change.
- **Each goal card tells its story.** What needs you first, then who is working on what, what waits and why, and what is finished, one line per task.

## Unreleased — the trial's fault list, part 4: one question, asked by Friday

In the trial's recording, twenty-four seconds on one Settings page brought up six grey Windows boxes, each listing every setting again, and one "Trust" switched on a setting that had been cancelled a moment before.

- **Friday asks in a window of its own.** The grey Windows message box is gone from approving, trusting, cancelling and landing. The question appears in a small Friday window over the window you clicked in. The keyboard starts on Cancel, and the button that says yes answers a moment late, so a click that was on its way elsewhere decides nothing. It is still the desktop app that writes the question and takes the answer, never the page: a page that asked cannot answer itself. Where that window cannot be opened, the system's box asks, so no question is skipped.
- **One question for one decision.** Starting an agent from its own dialog, or changing one there, is not asked about a second time; it is only when that gives the agent the whole machine, or raises or removes its spending limit. Halting is asked once, in the Halt dialog. Cancelling a task from the list is asked once. Trusting from Settings → Permissions is asked once.
- **Trust is per setting.** Switching one thing on asks you to trust that one thing, and nothing else that happens to wait is trusted with it. Switching one off leaves the others in force; before, they stopped applying until you trusted the shorter list again. Settings → Permissions shows each setting as "in force", or with its own "Trust this one".
- **What stays as strict as it was.** A setting applies on a computer only once the person there has trusted exactly it: the same setting with another value, or set in another file, is asked about again, and so is one that was switched off and on again. A trust given to a whole list before this change keeps working.

## Unreleased — the trial's fault list, part 3: a question is answered, a small task just starts

In the trial "Explain how menu price revisions work" cost a planner call, a plan with a rationale and six criteria to approve, three minutes of waiting for that approval, then the build, the types, the lint and 565 tests on a change of no file, and ended at "Ready to land" with nothing to land.

- **Ask.** Type a question and choose Ask on the goal line, or "Just answer this" in the New goal dialog. One agent reads the project and answers; it changes nothing. There is no plan to approve, none of the project's checks runs, and nothing waits to be landed.
- **The answer is read in Friday.** Its card says who is answering, then "Read the answer"; the answer is laid out with its headings, lists and code, and can be copied. "Your answer is ready" joins what waits for you, shows its first lines in the Notch, and comes as a notification. A question that got no answer says so, with "Ask again".
- **Do.** For something small enough for one agent: it starts at once on what you typed, with no planner call and no plan to wait for. Its work is checked and landed as any other. "Do" on the goal line, "Do it now, one agent" in the dialog.
- **Plan** is what a goal was before, and stays the default. No plan a model wrote starts without your approval unless you turned that on.
- **A question is checked without a click, on every computer.** The check is that nothing was changed; it runs no code of the project, so it needs none of the trust that checking work automatically needs. An agent that changed a file while answering fails it, and so does any task that only reads.
- **An agent's result has room for the answer**, beside its one-sentence summary. Claude Code, Codex and the agents you run all hand it in; the text is kept as a file of its own, not in the event log.

## Unreleased — the trial's fault list, part 2: fewer questions

From the fifteen commands the trial put on a person's screen. Thirteen of them needed no answer.

- **Commands that only read are not asked about.** The test runner behind `timeout`, the formatter run as `npm exec -- prettier --check`, `Get-Process`, a `grep` whose pattern holds an escaped quote, and the way Codex quotes a PowerShell command were each read as "a command Friday does not recognise". What such a wrapper hides is still found: the same wrapper around a delete asks.
- **A temporary file is not a change to your project.** `> "$TEMP/lint.txt"` and `cp … /tmp/x` asked for leave to "commit and change branches".
- **A command that changes files is judged by its files.** `sed -i`, `mkdir`, `cp`, `mv` and `> file` were filed under "commit and change branches". They are a kind of their own now. When the command names its files and they are the task's own, it runs as an edit of them does. Outside them the card says which file it would change and why that needs you, under every setting: a change outside a task's own files always asks. When Friday cannot tell from the command which files (a pattern, a script), it says so and asks; Settings → Permissions has a switch for exactly those commands. A project that let agents commit without asking no longer lets them change files with a command by the same switch.
- **An agent that asks leave for what needs none is told so at once**, and what to do when its own sandbox stopped the command. Codex waited twice for a person to allow the project's own tests, which Friday had allowed all along.
- **"Allow for this task" is one click and one confirmation**, from the list and from the Notch. It opened a second view with a button to hold, and then a pop-up; from the Notch that view opened behind it. A high-risk request keeps the full view, which the Notch now opens in the Studio.
- **The Notch does not sit on the Canvas and Settings tabs.** In the desktop app they stand beside the project's name.
- **Checks fit the change.** A task that changed nothing runs none of the project's checks. A task that changed only documents (`.md`, `.rst`, `.adoc`) runs the lint checks, and not the build, the types or the tests; a check that reads documents says so with `on_documents: true`. A merge that brings only documents into the goal is checked by the same rule. In the trial a question that changed no file, and two edited Markdown files, each waited for 565 tests.

## Unreleased — the trial's fault list, part 1: nothing leaves you stuck

From a day of real work with three agents on one project. Each of these left a person waiting with no way forward inside the app.

- **An approval reaches the agent that asked.** When you approve what an agent asked for, it is told at once, in the middle of its work, and goes on. Before, the agent had been told the request was declined and to end as blocked, and nothing told it when you said yes: you approved, and the task stayed where it was.
- **One need, one card.** An agent that asks again for what already waits for you adds its reason to the card that is there. The same command with `2>&1` or `| tail -20` at its end is the same request, not a second one. A request an agent makes through Friday's own tool is filed as what the command is; it used to be filed under a name the agent made up, which no approval ever matched.
- **Cards and questions end with their task.** An approval request closes when the attempt that asked has ended. A question nobody answered is dropped when its task is finished; one that still stands is put to you as "claude-1 asked you something 10 minutes ago and is still waiting", with the question, and no ids or timestamps.
- **An agent you run that stops is said so at once.** When Antigravity, or Claude Code in your editor, ends its turn on an error (out of quota, its servers busy) the waiting list says which, with what to do: wait, or give the task to another agent. When it asks you something in its own window because of a rule of Friday's, the list says that too. Before, the task read "running" for as long as you looked at it.
- **"Done" is not taken from an agent that has just said it is blocked.** A Claude session that is resumed first answers a notice of its own with an empty reply; Friday took that reply for the result of the task. An agent that ends its turn without saying anything is recorded as blocked, with that reason, for Claude and for Codex.
- **A task goes to the agent of the role its plan names.** A frontend task was given to a backend agent that could start by itself while the frontend agent waited for its person. The role comes first again.
- **Approve works on the first click.** A press on a card that had just opened, or that you had scrolled, was dropped without a word, and "Ready in a moment" stayed for as long as the mouse did not move. A card that is still opening keeps your pointer; your own scroll asks only that it has come to rest; a press a moment early is kept and acts when the wait is over; a press on a card nobody had pointed at counts as pointing, so the next one decides. What is unchanged: a card that appears under a resting cursor does not take the click meant for what was there before.
- **A confirmation opens over the window you clicked in.** Asked from the Notch, it opened behind it.
- **Files in the way of a landing can be set aside from the app.** "Commit them or set them aside first" was all the dialog said, and the files were often not yours: an agent you ran in your folder had left them, and the task was finished elsewhere. The dialog now says whose they are as far as Friday's records know, and "Set them aside and land" keeps a copy of each exactly as it is, clears the way and lands the goal. If the landing does not happen, every file is written back. Afterwards "Put them back" is in the same dialog; it never writes over a file you changed since. No stash and no branch of yours is touched, and files an agent is working on in the folder right now are never taken from under it.
- **Handing a task to another agent keeps everything the first one wrote.** Only the files Friday's hooks had seen were kept, so files written by a command (a generator, an install) were lost to the next agent. Every file in the task's scope that was written since the attempt began is kept now; a change you had there before it is yours and is left out.
- **A lockfile that a clean install refuses does not land.** The project's checks run where the packages are already installed, so a `package-lock.json` that `npm ci` rejects passed all of them, landed, and broke the install of every later task folder. When a task changes `package.json` or the lockfile, Friday now asks npm whether a clean install would work, without installing anything, and fails the task with npm's own words and what to do when it would not.
- **A project whose packages cannot be installed is said to you, once, with a repair.** When the install fails in a new task folder because the lockfile is out of step, the waiting list says so and "Have an agent repair it" starts a goal for exactly that file. Before, only the agents were told, in every folder, and each installed by itself. The question closes by itself when an install works again.

## Unreleased — a real project, part 2: settings a person can read at a glance

- **Run the checks now.** Settings → Checks has a button that runs your project's checks on the project as it is, before any agent changes anything, in a copy of Friday's own that is prepared the way an agent's work is checked. It shows each check as it runs, what a failing one printed, and one sentence on what the result means. A required check that already fails would send every task back whatever the work, and you now find that out first.
- **Every check says whether it is required or advisory, and one click changes it.** A required check must pass; an advisory one is run and shown and holds nothing back. A required check showed no word at all, and changing it meant editing a file.
- **Switches that say where they stand.** "Check the work automatically" and "Start plans without asking me" were a "Turn on" button with a tick, which read as already on, and became a link of another kind once on. They are now one switch that reads Off or On.
- **The chosen option is marked.** The choice of when finished work is put into your project, and the ticked settings files, carry a filled mark and an outline; the chosen one was only a shade lighter.
- **Planning through Claude Code shows an estimate, once.** The figure read "Spent today", twice on one page. It is what the planning would cost at list prices: with a Claude subscription nothing extra is billed for it. The page now says so.
- **The version line says when this build was made.** "Friday 0.1.0" was the same on a copy installed days earlier, so nothing on screen told the two apart.
- **A project with no settings file gets one line about it**, not a paragraph about a problem it does not have. "Add" carries a plus, not a tick.

## Unreleased — a real project, part 1: the settings file its tests read

- **A project whose tests read a `.env` file can be checked.** Each agent Friday starts works in its own copy of the project, and Friday checks combined work in a copy of its own. A copy is made from version control, so a settings file the project keeps out of it was in none of them: every test that read it failed there, in the agent's hands and in Friday's, though the work was right. Settings → Checks now has "Settings files for agents' copies": Friday lists the settings files it found, and the copies get the ones you tick. In `config.yaml` this is `worktrees.files`.
- **You decide, on each computer.** Programs an agent runs in its copy can read what the copy was given, so the list waits for your approval like every other setting that loosens something. Until then the agent is told that its copy lacks the file, so it does not take a failing check for a fault of its work.
- **Your real keys can stay in your folder.** Save a version of the file without them as `.env.agents.local` and tick that one: the copies get it under the name `.env`, and your own `.env` is not copied anywhere.
- **What it never does.** It reads no file outside the project, writes over no file of the project, and puts the file only where the copy's own ignore rules keep it out of a commit. Nothing of a file's content is logged or recorded, and agents are still kept from opening a `.env` file themselves.

## Unreleased — agents working together, part 12: a session that reconnects, and words for a person

- **An agent that reconnects in the same conversation can take work again.** When Friday was restarted, or the app reloaded its connection, in the middle of a conversation, the new session read "no Friday hook has reached the daemon" and could take no task until you started a new conversation: its hooks were still counted for the session that had ended. They now follow it to the session that is there.
- **What an agent passes on to you leads with the app, not a command.** Three messages an agent relays (a session Friday cannot check yet, a question that waits for you, a step that waits for your decision) told you to run a terminal command. They now say where it is done in Friday, with the command after it for those who use one.

## Unreleased — agents working together, part 11: three things said in time

- **An agent you run that has gone quiet is pointed out.** When Antigravity, or Claude Code in your editor, holds a task as running and nothing was reported on it for fifteen minutes, it is listed with what waits for you: its window may be closed, or it may be waiting on a prompt of its own. Friday does not take the task away by itself; the task's own page gives it to another agent.
- **"Prompt it there" names the app.** The hint after an answer said "Agents connected from VS Code", also for Antigravity. It now says which app, and what to type.
- **The plan review says when tasks would change the same files.** Two tasks that do not depend on each other and may write the same files are never run together, so such a plan is slower than it looks. The review names them before you approve.

## Unreleased — agents working together, part 10: what one agent leaves for the next

- **The next agent is told what the earlier tasks did.** A task that depends on others gets one line for each: who did it and what that agent reported, from Friday's own records, with no model call and no list of files to open. Before, it was told only that it was "plan task X".
- **Work left half-done in your project folder is not lost.** When an agent you run there is closed in the middle of a task and the task goes to someone else, the files Friday's hooks saw it change are saved first. The next agent's own folder starts with them, as edits to look at and finish, and it is told so. Your folder is left exactly as it was.
- **The sample shop installs.** Its three packages had no package files, so the install failed in every task folder and every task carried a warning.
- **"Not installed" is no longer said of a tool that is installed.** Where Friday has only not seen a tool connected yet, it says that.

## Unreleased — agents working together, part 9: a file you changed too

Friday never writes over a file you changed in your project folder. Until now it left the file as it was and told only the agent, which then built on your version without you knowing.

- **The agent in your folder waits, and Friday asks you.** When the goal's finished work changes a file you changed yourself, the task does not start. A question appears with each such file and three buttons: **Keep mine**, **Take the finished one**, and **Show both** to compare them first.
- **Taking the finished one saves yours first.** **Put mine back** restores it exactly as it was.
- **A choice is remembered** for the finished version it was made against, and asked again only if the goal changes that file once more. When every file is decided the question closes by itself, and you prompt the agent in your editor again.

## Unreleased — agents working together, part 8: landing without a click

A finished goal always waited for a click on Land. That stays the default, and it is now a choice.

- **Settings → Checks has "Put finished work into my project"**, one choice of three: **Ask me**, **When the whole goal has passed**, or **Each task as it passes**. The two automatic choices are trusted on this computer before they apply, like the other things a project may ask for.
- **A tick on the plan's Approve does it for one goal**: "When every task of this goal has passed its checks, put it into my project without asking".
- **Unchecked work never lands by itself.** Nothing lands automatically in a project without a required check, nor while Friday is paused. Every revision on a goal's branch has already passed the project's checks in Friday's own checkout, so what lands was checked as a whole.
- **A file you changed yourself always stops it.** Nothing is touched then, the reason is recorded, and the goal waits for its Land button as before. Friday never pushes.

## Unreleased — agents working together, part 7: a check that could not run is not the agent's mistake

- **When a project check cannot even start on this computer, nobody is sent back to fix it.** The program a check names may not be installed, or the check may be misspelt in the settings. Nothing of the agent's work was judged then, yet the task counted as failed and went back to its agent, again and again, until it read "keeps failing verification". Friday now asks you at the first such failure, says which check could not start and what the computer said, and offers **Open the checks** and **Send it back to the agent** (once it is put right). It joins the case already handled, where the project's packages were not installed.
- **One plan through three agents is a test now**: two agents Friday starts and one in the project folder, with every step that broke in the live run of 2026-11-17 asserted. It uses no model.

## Unreleased — agents working together, part 6: your turn

- **Friday says when it is your turn.** A task kept for an agent you run yourself (Antigravity, Claude Code in an editor) starts only when you prompt that agent, and the card only said "for antigravity-1". It is now listed with what waits for you: "Your turn in Antigravity", which agent takes the task, and what to type there (`/friday`). It shows in the Notch, in the Studio's waiting list and as one notification, and it counts in the status line.
- **One click gives the task to someone else.** "Let another agent take it" on the Notch card frees the task, and an agent that starts by itself takes it when one is free.

## Unreleased — agents working together, part 5: who gets a task

In the live run of 2026-11-17 Friday kept an open task fifteen minutes for an Antigravity nobody was looking at, while Codex was idle; and a task that came back after its agent was closed was taken by nobody.

- **An agent that starts by itself goes first.** Claude Code and Codex, started by Friday, begin a task the moment they get it; an agent you run yourself (Antigravity, Claude Code in an editor) waits until you prompt it. Friday now gives a task to the second kind only when no free agent of the first kind can take it, whatever their scores. The decision says so.
- **A task kept for an agent that waits for you is kept two minutes, not fifteen.** If nobody prompts that agent, the task is free again for whoever is free. A task you gave to an agent yourself still stays until you change it.
- **A task that comes back gets the next free agent**, also one that is not part of a goal: after its agent was lost or closed, or after it was released. A task you made ready yourself without choosing an agent still waits for you to choose.

## Unreleased — agents working together, part 4: finished work comes to your folder

The hand-over in the other direction. An agent you run in your own project folder (Antigravity, Claude Code in an editor) works on what that folder holds, while the agents Friday starts hand their checked work to the goal's branch. In the live run of 2026-11-17 such an agent was asked to describe code that was not in its folder.

- **Before your own agent takes a task of a goal, Friday writes that goal's finished work into your folder.** Only files the goal changed, and only work that passed its check. They show as uncommitted changes; your branch and your staged changes are not touched. The agent is told what was put there, and that those files are not its own to claim.
- **A file you changed is never written over.** One you edited, staged, left untracked or committed yourself stays exactly as it is; the agent is told which files those are and to tell you. The old version of every file Friday does replace is the committed one, so `git restore` brings it back.
- **The check then judges only what the task changes.** With nothing in the way, the attempt starts from the goal's revision, so what Friday brought in is not counted as the task's change, and its own work lands on the goal's branch without a merge.
- An agent's claim shows a note that comes with its context, before the context.

Not yet: the three-button notice for a file that is in the way (keep mine, take theirs, show both); for now the agent tells you.

## Unreleased — agents working together, part 3: one copy of Friday

Found in the same live run: the coding tools a person opens themselves were starting a copy of Friday installed on 2026-10-31, while the desktop app ran the current one. An Antigravity session then registered under the wrong name, showed as two agents and was refused work, and the setup check said "ok".

- **Opening the desktop app makes those tools use the app's own copy of Friday.** At start the app compares the copy it runs with the one the machine's record names for Antigravity, Claude Code, Cursor and Gemini CLI, and rewrites the record when they differ. Before, it did so only when the record was missing or broken.
- **The setup check of each tool warns when another copy would be started**, in words: which copy, when it was set up, and that opening the desktop app once, or running friday setup, switches them.

## Unreleased — agents working together, part 2

The other half of the hand-over: work an agent does in your own project folder (Antigravity, Claude Code in an editor) now reaches the agents Friday starts. In the live run of 2026-11-17 it stayed uncommitted in the folder, so the next task's folder was cut without it and its agent reported itself blocked.

- **Work made in your project folder reaches the goal.** When such a task passes its check, Friday keeps a commit of that task's own files only (the ones its hooks saw it write, or its claim lists) and brings it to the goal's branch like any other task's work. Your folder, its staged changes and its branch are not touched, and nothing of yours or of another session is taken. The tasks that depend on it wait for that, and then start in a folder that has it.
- **It is checked again away from your folder.** The revision it becomes on the goal's branch is run through the project's checks in Friday's own checkout before the branch moves, so what else lies in your folder cannot decide the result.
- **Landing goes over files your folder already holds.** A file the goal changes that your folder already has, uncommitted, with exactly the goal's content is no longer "in the way": the branch moves forward over it and the file is not rewritten. A file you changed differently still stops the landing, by name, and nothing is touched. When your branch has commits the goal does not have, such files have to be committed first, and Friday says so.
- The check's note on uncommitted changes says what happens to them in a project folder.

Not yet: bringing the other agents' finished work into your folder before your own agent starts a task, and a "Mark passed" by hand keeps no copy of folder work.

## Unreleased — agents working together, part 1

Found by running Claude Code, Codex and a stand-in for Antigravity on one plan (2026-11-17): a task that was restarted because an earlier task's work was missing started again without it, and bringing that work in by hand made its check fail.

- **A task's folder takes in the goal's finished work before every new attempt.** A task Friday starts works in its own folder, cut when the task first began. When the task is restarted, given to another agent or sent back after a refused claim, Friday first merges what the goal branch gained since then into that folder, keeping the agent's uncommitted edits. Before, the folder was used as it stood.
- **The check then measures from that point.** What came in from the goal is not counted as the task's own change, so it can no longer fail the check as "changed outside the write scope".
- **A collision goes to the agent, not to you.** When the goal's work and the task's edits change the same lines, nothing in the folder is touched: the attempt is not started, the task goes back with both sides of each file as its note, and the next attempt resolves it.

The refresh itself was written on 2026-10-31 on a branch that was never merged; here it is brought in and widened from "after a refused claim" to every new attempt.

## Unreleased — the Notch folds back up

- **The open Notch card has a button that rolls it back up.** A handle with an upward arrow sits in the middle of the card's lower edge, between Sound and Open Studio: one click folds the card back into the pill at the top of the screen. It is what `Esc` does, and what "Later" does on a request; a card that showed a notice, or nothing at all, had no button for it.

## Unreleased — loose ends, part 3

- **What you allowed for a task can be seen, and taken back.** "Allow for this task" lets an agent do the same thing again without asking; once given, such an allowance was nowhere in the app, and taking it back was a terminal command. The task inspector lists the ones that still hold under "Allowed for this task" (the act in words, exactly what, and how long it holds), each with **Take back** (`POST approvals/:aid/revoke`): the agent asks again the next time. The heading shows only while there is something under it. The list comes from a route of its own (`GET tasks/:tid/approvals`, the task's granted approvals): the desktop shell still never forwards the whole list of approvals.
- **The Claude Code setup says that Claude Code keeps its own prompts**: it may still ask before an edit or a command, in its panel, whatever Friday allows.

## Unreleased — loose ends, part 2

- **A refusal says what to do, not which command to type.** Friday's refusals name a terminal command in brackets for what they suggest ("Reject it ("friday plan reject") and ask for a new one ("friday goal replan")"), and the toast showed them, for example on approving a plan version that had gone out of date. The brackets are left out: the sentence stands without them, and the interface has a button for each.
- **A plan you proposed yourself is not announced to you.** Pressing Propose in the plan editor raised "A plan waits for your review". It still waits in the list; the notification is for a plan someone else (the planner) proposed.
- **Stopping an agent in the middle of a task asks first**, with what it is working on and what happens to the task. An idle agent stops as before.
- **A computer without Node.js is told so.** The desktop app asked where Friday is installed, again and again, when Friday's own files were there and Node.js was not. It now says that Node.js is needed, where to get it, and looks again.

## Unreleased — loose ends, part 1

The remaining medium and low findings of the 2026-11-17 review, the ones a person meets first.

- **Something opened from Settings is shown.** With Settings open, the header's Messages, "Waiting for you", a result of the palette or a notice opened a drawer behind the Settings view, where nobody saw it. Opening any of them shows the board again.
- **A task that is not moving has a way out besides Cancel.** A task an agent holds and does nothing with (connected, and idle) offered Cancel alone. "Not moving?…" opens the recovery dialog, which gives the task to another agent or starts it again, with the work so far kept. It is a quiet button: a task that runs well needs none of it.
- **A deleted task folder is made again from the app.** When a task's folder is gone (deleted by hand, by a clean-up tool), Verify refused with a terminal command, and the task could be neither checked nor finished. The Verify dialog now says the folder is gone and offers **Create the folder again** (from the task's branch: committed work is kept, uncommitted work is lost); the recovery dialog offers the same, and says the task's and the agent's state in words.
- **After a landing, the finished task folders can go.** The landing dialog of a landed goal offers "Clean up finished task folders" (the folders with no uncommitted work), which was a command in the palette.
- **An agent that stops on its own says so.** An agent Friday started that crashed, or was signed out, ended silently: its row read "exited" to whoever opened Agents. Friday records whether an end was asked for (`requested` on `agent.process_exited`), and the Studio says "claude-1 stopped on its own", until it is read. A remembered agent that does not start with Friday (`agent.autostart_failed`) says so too, with why.
- **The tour's Notch step** says where the Notch is in the desktop app, where the Studio has none to point at.

Already in place and checked off: the plan editor keeps a draft that was closed by accident; landing says a commit hook or a missing git name in words and takes back a half-done merge; turning automatic checks on checks the work that already waits.

## Unreleased — plain words, part 3

- **An error says what went wrong first.** A refusal read "COS-2002: approval is already granted", the code before the words. It reads "approval is already granted (COS-2002)": the code stays, last, for whoever reports the error. The same on the connection strip.
- **The checklist lists what there is to do.** "Friday is running" stood first, always ticked, and made the count read one better than it was; it is gone.
- **An agent's row** keeps its process id and exit code in the tooltip of the line, not in the line.
- **A proposed plan** keeps why it was proposed ("Trigger: …") under "Why this version was proposed".
- **Settings** says "Friday is running" where it said "Ready · 127.0.0.1:4310" (the address is in the tooltip, and under About), names its version without the API number, and says what a trusted list means in place of its hash, which is in the tooltip.

## Unreleased — plain words, part 2

- **An approval says what the agent asks as the act it is.** The card and the full view named it as the policy does, in a monospaced line ("shell.git.commit", "package.install"). They read "Asks to: Commit or change branches", "Install packages"; the policy's name is in the tooltip, and what exactly would run is shown in full under "Exactly this", with the agent's own reason under "The agent’s reason". The tray's row, the notification and the history use the same words. A capability Friday has no words for is shown as written.
- **The "settings changed" banner names settings, not keys.** It listed the keys of config.yaml ("providers.anthropic.allow_remote needs a restart to apply"), which Settings now changes from buttons. It says "The project’s settings changed: planning with an Anthropic key needs a restart to apply", each setting once, with the keys in the tooltip; a key Friday has no name for is shown as written.
- **A goal's state is a word** ("Active", "Completed"), not the daemon's constant. "The main checkout" is "your project folder" or "your own branch"; "held at the tool boundary" is said as what it means; the Agents panel's "MCP connected", "Hooks seen" and "Enforcement" are "Connected to Friday", "Friday sees what it does" and "What Friday can stop"; "context packet" is what the agent was given.

## Unreleased — plain words, part 1

The 2026-11-17 review of what the app says to someone who never opened a terminal. Nothing behaves differently; the words, and what is shown, changed.

- **Settings reads as what each thing is.** "Autonomous Planner Status", "Provider Readiness", "Configuration & Spending Bounds", "Git Worktree Management", "Daemon Lifecycle", "Engine Controls", "Dynamic Island Timings" and "System & Architecture" are "The planner", "Can Friday write plans?", "Plan with an Anthropic API key", "Task folders", "Friday itself", "Restart or stop", "The Notch" and "About this Friday". The pages are Appearance, Notifications, Sound, Planner, Models, Checks, Permissions, Friday, Desktop app and About, under General, Planning and agents, and This computer. Each line under a title says what the setting does, in place of how it is built.
- **The planner is said as who writes the plans**: "Claude Opus 5.5, with your Anthropic API key", "through your Claude Code sign-in", "a model on this computer", in place of "anthropic · claude-opus-5-5 (remote)"; the key as "Stored on this computer" in place of "stored". In the desktop app the terminal steps for a key are under a fold, since the buttons do them.
- **"Friday" plans.** The part that writes plans was named as the code names it, "the Master Brain", on buttons, cards, notifications and the checklist. It is "Friday" where Friday acts ("Let Friday plan", "Friday proposed a plan") and "Friday's planner" where a message or a question comes from it.
- **A task has a folder, not a worktree.** "Worktree" is "task folder" on every screen, with one sentence in Settings → Friday on what it is; "Prune clean worktrees" is "Clean up finished task folders". An agent is "started by Friday" or "connected from VS Code", not "spawned" or "attached".
- **The settings a computer trusts are said as what they allow.** The list, and each confirmation before trusting, showed lines such as "verification.auto_on_completion: false → true". Each known setting now leads with what it allows ("Finished work is checked automatically", "Agents may install packages without asking"), followed by the exact setting and its file, since trust is recorded in exactly that. The desktop's own dialog says the same. A setting Friday has no words for is shown as written.
- **Ids left the cards.** A task's and a goal's id were a chip on every card and stood before the task's name in sentences ("task_29jxbk8t · Add discount codes"). They are in the tooltip and in the task inspector; cards, lists and the palette show names. An agent's card names the task it works on.
- **Desktop dialogs** (halt, cancel, restart, stop, allow spending, trust) use the same words: task folders, "the agents Friday started", "on this computer".
- "What the CLI would do" on a question's card is "The same from a terminal".

Changed on purpose: `taskLine` answers the summary alone; the question of `action_failed` begins "Friday's planner could not finish".

## Unreleased — ease of use, part 6: another project without a terminal

- **"Open another project…"** in the desktop app: in the tray's menu, on the project's name in the Studio's header (a button there, with the folder in its tooltip), and in the command palette. The app held one project for as long as it ran; another one meant Quit and a start from a terminal with `--project`, and a second launch for another folder only said so. Each of these now shows the folder picker, offers "Set up Friday here" for a folder that is not a project yet, and asks what the project that was open should do, as Quit does: keep its Friday running (agents there keep working) or stop it. Cancelling at any point leaves everything as it was, the remembered project included.
- A second launch with `--project` for another folder opens that project in the running app, after the same question, in place of a dialog that said to quit first.
- Both windows load again when the project changes (`project-changed`), so the board, the stream and the preferences are the new project's; the tray's Pause reads "Pause" again.

In a browser nothing changes: a page belongs to the Friday it was opened from, so the name stays a name and the palette has no such command.

## Unreleased — ease of use, part 5: Settings

Findings of the 2026-11-17 review of Settings: what a person could set only in a terminal or by editing config.yaml, and what Settings still built that nobody saw.

- **The project's own checks are set in Settings → Checks.** Verification ran only Friday's own checks (scope, credentials, evidence) until someone wrote `verification.checks` into config.yaml by hand; the checklist's fix for "No project checks" was "Open config.yaml". The page lists the checks the project has, with what each runs, and the ones Friday found in the scripts of package.json (tests, lint, type check, build; never a watcher or npm's placeholder), run through the package manager the lockfile names. Each is added with one click, or all at once, and removed again (`GET` and `POST config/checks`). The page sends names only: the daemon builds each command from what it read itself. config.yaml changes only where the list stands, comments and line endings kept; removing the last check leaves the file as it was, byte for byte.
- **What agents may do without asking is set in Settings → Permissions.** An agent that runs a command to install a package, commit, delete a file, download, stop a program, or one Friday does not recognise, waits for approval each time; whether it should was `autonomy` in config.yaml and a terminal command to trust it. Each kind is said in words with **Ask me** or **Allow**. Allowing is a loosening: written to config.yaml and in force on a computer only once the list is trusted there, as before. Pushing, force-pushing and publishing always ask, and reading secrets is never allowed: the daemon takes no such setting from a page (`ASKABLE_COMMAND_CLASSES`, held to the policy's defaults by a test).
- **"Start plans without asking me"** in Settings → Planner (`master_brain.auto_approve`), with the same trust. A plan the planner has a question about still waits.
- **Every such switch turns off again**, automatic checks included; before, a setting turned on in Settings could only be turned off in config.yaml. Trust covers one list, so turning one setting off would silently stop the others applying: Friday asks for the ones that stay on again, at once, and says why.
- **What planning may spend can be changed, and turned off.** Once spending was allowed, the page showed the limit and nothing more; a new limit and taking the approval back were terminal commands. Settings → Planner now says the limit that holds and what was spent today, changes the limit through the desktop's own dialog (a browser is given the command), and **Turn spending off** takes this computer's approval back (`POST brain/deny-remote`; it only tightens, and holds from the next planning call). A limit above the project's own is said not to hold, with the way to raise the project's, which the team shares.
- **Planning with an Anthropic key no longer needs a line written into config.yaml.** "Allow it for this project…" asks, says the setting is the project's and shared, sets it, and restarts Friday.
- **The old Settings drawer is gone.** The Settings view replaced it, and it stayed registered: every "Open Settings" built it behind the view, hidden, where it read the policy and the shortcuts a second time and held the keyboard's layer, so Esc closed it before it left Settings. `openDrawer` of kind `settings` opens the view and leaves no drawer behind it.
- Settings → "Policy & Trust" is **Permissions**; the list a computer trusts is said in words ("Waiting for your trust", what trusting means) in place of "Pending Trust Verification" and "SHA-256".

Changed on purpose: `EDITABLE_SETTINGS` grew from four to thirteen, each still gated (a loosening by trust, spending by this machine's approval); `BrainStatusView` has `auto_approve_requested` and `spending`; the checklist's "No project checks" leads to Settings → Checks.

## Unreleased — ease of use, part 4: checks you can read

Findings of the 2026-11-17 review of verification, as a person meets it.

- **"Show output" on a check.** What a project's check printed was kept and shown nowhere: a failed test read "exit 1". A check that kept its output now has **Show output**, in the task inspector and in the Verify dialog, which reads it on request (`GET artifacts/:id`: the operator only, one file by its id, credentials redacted) and shows the end of it, where a failing check says what failed, with which lines those are when the output was long.
- **What a check found, in words.** Friday's own checks were named as the daemon writes them (`friday.diff`) over a line of rule codes ("2 changed file(s); failed: diff.outside_team_scope"). They go by what they check ("Changes stay where the task may work", "No credentials in the changes", "The work was run"), and each finding is its sentence with the files it is about, the failures before what is only worth a look. The code stays in the tooltip.
- **A failed install is told apart from failed work.** When a task folder's dependencies could not be installed, the agent worked on, the project's checks failed for want of them, and Friday treated that as the work failing: the task went back to its agent to fail the same way, until it read "A task keeps failing verification". The verdict now says so ("the project's dependencies were not installed in this task's folder (npm exited with 1), so a failing check may be the setup and not the work"), and the planner neither sends the task back nor revises the plan: it asks at the first such failure (`setup_failed`). A failure of Friday's own checks alone (scope, credentials, evidence) is the work's whatever the install did.
- **The card for it leads with the way out.** "A task's dependencies were not installed" says it is most likely the setup, gives the install's reason, and offers **Install again** (`POST tasks/:tid/setup`, also `friday task setup <task>`), which runs the install in the folder as it stands and says what it did, with the end of what it printed when it fails again; then **Send it back to the agent**, whose next result is checked in the installed folder; the folder in VS Code; and Cancel task. A failed task cannot be checked again as it stands, so no button says it can. The install is not run while an agent works in the folder.

Changed on purpose: `EscalationReason` has `setup_failed`, answered by a decision and never by a revision; `worktree.setup_ran` is an observation; the page asks for an artifact by its id alone, since the desktop shell forwards no path with an encoded character.

## Unreleased — ease of use, part 3: planning

Findings of the 2026-11-17 review of goals and planning.

- **The plan editor says what a plan is, and opens on one that can be sent.** It opened blank, and a one-task plan still wanted a key, a kind, a role, criteria and a write scope before Friday would take it. A first plan now opens on one task filled in from the goal (what it delivers, when it is done, free to change the whole project) under two lines on what a plan is; it can be proposed as it stands. A task added to it follows the one before and may change the whole project, so a list reads "first this, then that"; tasks that should run side by side are a choice (clear "Depends on", give each its folders). A folder added to "the whole project" narrows the task to that folder.
- **"Advanced" holds what a person seldom changes** (key, kind, role, priority, risk, read scope) and opens by itself when one of those is wrong. The first task is no longer asked what it depends on.
- **"Edit before approving…"** on a proposed plan opens it in the editor as it was proposed, a first plan as its tasks and a revision as the changes it makes; proposing the edited plan replaces the proposal. Before, a proposed plan was approve or reject, and the editor started from nothing.
- **"Reject and ask again"** rejects a proposal and asks the planner for a new one from the note (shown while a planner is ready). A note sent with the rejection of a first plan used to go nowhere.
- **"Change this goal…"** on the card of a goal whose plan runs: what should be different, in the person's words, for the planner (`POST goals/:gid/replan`), or the editor to write the change. Either way the result is a version reviewed before anything starts. Nothing on the card led to changing a running goal before.
- **A planner that could not plan says why, with the buttons that fit.** The card showed the daemon's sentence with the goal's id and the provider's message, and the same two buttons whatever had happened. It now says "Friday could not plan this goal" and, from what the provider said, that the planner is signed out, reached a usage limit, is not set up, has used today's spending limit, or answered with nothing Friday could use; then **Try again** (with an optional note) while a planner is ready, **Write the plan myself**, and **Planner settings** where the cause is fixed there. The daemon's own words are under "Details".
- **The planner's model can be chosen** in Settings → Planner: Friday's default (Claude Opus 5.5), Claude Sonnet 5.5 at about half the cost, or Claude Fable 5.2. Like how a person plans, it is kept on their computer (`planner.json`, beside the planner; `POST brain/planner-choice` takes `model`), is used from the next plan with no restart, and a model Friday has no price for is refused, since a plan it could not count against the spending limit is one it does not make.

Changed on purpose: `choosePlanner(ref, null)` removes this machine's planner and keeps its model; the planner's status has `model_choice`; a modal request may carry `seed: 'proposed'`.

## Unreleased — ease of use, part 2: who does the work, and on which model

Findings of the 2026-11-17 review of model choice and of which agent takes a task, with the owner's decisions.

- **"Assign to" is followed.** A task a person gave to an agent could wait for good: routing decided again whether it might run there, and refused where the ranking had no entry for that agent's host in the task's role, where the role was one it did not know ("fullstack"), or where a model was pinned that the agent cannot run. Nothing said so at the moment of assigning. A person's choice of agent now stands: the ranking only chooses the model (the one it has for that host, else the agent's own), and a pin the agent cannot run is set aside and said in the decision. It holds for a task kept for a busy agent and for the rework of such an attempt. A hard constraint (local only, sensitive work), a host that is signed out or at its limit, and a split nobody has decided still stop it.
- **Every agent Friday can start takes every kind of work.** Codex had no place in two roles of the ranking (frontend, and review and security), so such a task could not be done by it at all. It now stands in both, after the ranked entries and before Antigravity, so no existing order changes (registry `2026-11-17.1`).
- **A task with no agent to run it says why, and leads with the way out.** The card showed the decision's own sentence ("no dispatchable candidate for role "frontend_engineer" on this harness"), a "Why" button and a list of every model id in the catalog, the dearest first and most of them runnable by no agent on the machine; it fixed one task at a time. It now says what is wrong in words, lists the connected agents the task can be given to (**Run it on claude-1 (Claude Code)**, with "busy now" or "your editor" where that applies; `offers` in `GET routing/explain/:tid`), and offers **Start an agent** when none can take it. **Choose a model…** lists models by name with the app that runs each, the everyday one first, for this task or for every task of its kind. The decision's own words are under "Details".
- **One choice for "use this model for everything".** Settings → Models (was "Routing & Pins") opens on *Which model does the work?*: let Friday choose, or always use one model. Before, the same took a pin per kind of work through a form with a free-text role, where a mistyped role matched nothing and said nothing. A model for one kind of work or one task is a fold underneath, with kinds to pick from and each choice listed in words ("Frontend and UI → Claude Sonnet 5.5", a task by its summary, not its id).
- **A model choice no longer blocks agents you run in your own editor.** A pin cannot be applied to a session that chooses its own model (Antigravity, Claude Code in VS Code), and a pin of a model such a host does not run stopped every task there. It is set aside for that session, the decision says so, and the page says the choice does not reach those agents. An agent Friday gives its model to is held to a pin as before.
- **The model list is current.** Claude Fable 5.2 is in the catalog (and in the planner's prices, without which the planner could not count a call against the budget and refused the model) and takes Fable 5.1's place in the ranking, at a lower price; Haiku 5.5's context window is 1M, not 200K. Pickers show only models an agent Friday starts can run, or ones the project declared itself.

Changed on purpose: a routing decision's `source` may be `assignment`; `RunRouter` is told `assigned`; the readiness callback of `decideRoute` may be asked about a host alone (a null model).

## Unreleased — ease of use, part 1: starting and connecting agents

Findings of the 2026-11-17 review of starting and connecting agents, with the owner's decisions on which hosts to offer and on the spending limit.

- **Only hosts that work can be chosen.** "Start agent" offers Claude Code and Codex. OpenCode, the Cursor CLI and the Gemini CLI are listed as "coming soon" and cannot be picked: each could not take whole kinds of work, or refused a personal account, and a person learned it from a task that never started. Antigravity stays listed as the app a person opens themselves.
- **The spending limit follows how you pay.** Every Claude Code agent stopped an attempt at $1, a default nobody chose, which ended larger tasks half way. The limit is now a choice of none or an amount: none for a subscription's sign-in, which is not charged per attempt, and $5 for an API key or when Friday cannot tell (up to $1000). Friday reads how each host is signed in from its own files and environment, without starting it and without a model call (`sign_in` on a host), shows it under the Host field ("Signed in with a subscription: nothing is charged per attempt", or "Friday found no sign-in for Claude Code on this computer"), and reads it again when an agent starts, so a host check from hours ago never leaves a paid key without a limit. The $1 of agents made before is dropped; one a person set is kept.
- **"Edit" on a remembered agent.** Its role, options and whether it starts with Friday are changed in place (`POST agent-processes/:key/update`); before, raising a limit meant forgetting the agent and making a new one. A new limit applies from the agent's next attempt without the agent starting again (`--remembered-limit`); everything else from its next start. In the desktop app the change is shown in the shell's own dialog first, as a start is, with the limit in words.
- **A stop at the limit asks, keeps the work, and has one button.** Claude Code stopped at its cap read "the Claude Code turn ended: error_max_budget_usd", and the task was given to an agent again, to spend the same and stop at the same place, until it was handed over as failed. The stop is now said as what it is ("claude-1 stopped at its spending limit: this attempt cost $5.03, and reached the limit of $5 per attempt. The work so far is kept."), nothing runs again on its own, and **Raise the limit and continue…** saves a higher limit (or none) and lets the task continue from the work the attempt left. For an agent started by hand, the dialog says its limit cannot be changed there and offers to continue once it has been.
- **Each connected app has its own name.** Claude Code in VS Code and Antigravity read one name (`dev-1`) from one file, so whichever connected second was a "shadow" that could take no task, and the advice was a terminal variable. Antigravity now has its own (`antigravity-1`, `hosts.antigravity` in the private `agent.json`, read by its hooks and its MCP server; every setup keeps the other's entry), its dialog proposes it and refuses a name another agent works under, and a shadow's row says what it means and what to do. A machine set up before keeps working as it did until Antigravity is connected again.
- **The setup dialogs say whether the app is connected.** The Claude Code dialog read fields the check never sends, so it showed badges beside codes such as `cc.mcp-json`. Both dialogs now give one sentence ("Ready. Friday checks what Claude Code does before it happens", "Connected, with gaps…", "Not connected yet…"), then only what needs attention, each with what to do in the dialog's own terms ("Apply this setup again: Preview, then Apply" in place of a terminal command); what passed is folded away.
- **Claude Code is found where it is installed.** With the npm install, `where claude` lists only npm's shims, which cannot be run without a shell: Friday said Claude Code was not installed unless the VS Code extension happened to be there. The program behind a shim is now found, as are the native installer's `~/.local/bin`, an install made while Friday runs (the PATH a new program would get), the usual folders on macOS and Linux, and the extension of VS Code Insiders and Cursor. A version new enough to start agents is preferred over an older one found first, which used to hide it. A remembered agent whose program has gone (an extension replaced by its next version) is looked for again when it starts, not only on "Check again".

Changed on purpose: `validateOptions('claude-code', {})` no longer adds `max_budget_usd: 1` (a limit nobody set stays undecided until the start); `agent.error` may carry `spending_cap`; `agents.json` has a `version`.

## Unreleased — stability pass, part 6: Settings that change what they say, and nothing else

Findings of the 2026-11-16 review of the Settings switches added the day before, and the owner's decision that how a person plans is theirs, not the team's.

- **How you plan is kept on your computer.** "Use Claude Code to plan" wrote `master_brain.provider` and a budget into the tracked `config.yaml`: committed, it switched every teammate's planner, whose own then read "not ready". The choice is now this machine's (`POST brain/planner-choice`, kept beside the spending approval in Friday's private folder; `claude-code`, `anthropic`, `none`, or null for what the project's `config.yaml` says), read when Friday starts. The status says both (`choice`), and a restart is asked for only while the running planner is another one. Your daily limit is the one you approve on this machine; the project's own limit still holds it. **I'll write plans myself** is the same choice, set to none.
- **One thing stays the project's, and is said to be:** whether the project allows planning through Claude Code at all (`providers.claude-code.allow_remote`). Where it does not, the switch asks first, says the setting is in the file your team shares, and changes only that.
- **The switch checks before it changes anything.** With Claude Code not found it changed the provider, asked for the spending, restarted Friday (stopping its agents), and offered the same button again. It now says "Friday did not find Claude Code on this computer", changes nothing, and offers the restart that makes Friday look again. It restarts only when it has to, and no longer when only this machine's approval was missing.
- **"Trust and turn on" trusts automatic checks, not something else.** The switch read "not trusted yet" from any setting of the project that waited for trust (a sandbox, an operation), so its button trusted that and never turned automatic checks on. It now reads the setting itself (`verification.auto_requested` in the snapshot), sets it when it is not asked for, and trusts only when it is among what the confirmation lists.
- **The Planner page shows what applies.** Beside a planner that is, or is about to be, Claude Code, the Anthropic key steps are gone: their "Allow spending" approved Anthropic. Elsewhere that button names the provider the planner runs.
- **Settings no longer redraws on every event.** The Planner page compared the planner's whole status, which carries the event counters, so it was drawn again on every event: a budget being typed was lost, and each drawing left listeners behind for as long as the Studio ran. It follows what it shows, and each tab ends what it subscribed to when it is drawn again or left.
- **An edit of `config.yaml` changes the lines it has to.** The file was written whole through the YAML library: a comment's spacing, a two-line comment's place and long lines changed with every switch, in a file a team tracks. A value is now replaced where it stands and a missing key is added as new lines; line endings (CRLF on a Windows checkout) and a byte-order mark are kept. A section that is empty or written on one line is still handled; one that is a value or a reference to another is refused in words, as is a file that is read-only or held by another program (no stray `.tmp` file). Whatever was written is read back: it must be the old configuration with exactly these settings set, or nothing is written.
- Smaller: the policy card is read again when what is trusted changes; in a browser the terminal step for this machine's approval stays in view until it is taken; the checklist's "An agent is connected" counts sessions that are there, not ones that left.

## Unreleased — stability pass, part 5: an agent that is signed out or at its limit says so, with the way back

Findings of the 2026-11-16 review of connecting and running agents.

- **A failed sign-in no longer locks a host out behind a terminal command.** A host that once said "not signed in" was refused every later task: the record has no expiry, only a completed attempt shows a sign-in (and routing gave the host none), and only `friday readiness clear` ended it, so signing in again changed nothing. The board now says what keeps each host out (`host_blocks` in the snapshot: a failed sign-in, or a bench with its end), and the routing question's card and the Agents drawer show it in plain words with one button: **I signed in: try again**, or **Try again now** for a bench. The desktop forwards `readiness/clear`. A host still signed out fails its next attempt and is kept out again.
- **Lifting a block offers the waiting tasks again at once** (`readiness.invalidated` starts delegation), not at the next unrelated event.
- **A subscription's usage limit is a limit, not the work's failure.** "Claude AI usage limit reached|<time>", "5-hour limit reached ∙ resets 3pm" and "You've hit your limit · resets 5pm" were read as the task failing, so it was retried at once on the same host and handed to a person as failed. They are now a rate limit that benches the host until the time it names (the moment after the bar, or the time of day on this machine's clock; a day at most), and the board says until when.
- **A subscription's expired sign-in is a sign-in problem** ("OAuth token has expired", "Please run /login"). What a task's own tests print ("session expired", "token expired", "recursion limit reached") is not taken for either.

Not done as first listed: an agent that starts again does not lift its host's failed sign-in by itself. The reviewed rule is that it stays until the host is seen signed in or a person clears it (two tests hold it), and any second agent of the host starting would have lifted it; the button is that clearing, one click.

## Unreleased — stability pass, part 4: goals that can end, questions that go away, drafts that stay

Findings of the 2026-11-16 review of goals and planning.

- **A planner that cannot be called is no planner.** The Master Brain took a configured model for a planner that plans. In the default setup (provider `anthropic`, no key, no consent) every failed check was answered with a planning call that was refused and a "Friday cannot plan" question, where a setup with no planner at all sends the task back to its agent. What Friday does now follows what the status says (`plannerReady`: no consent, no key, a local model not named): a failed task is reworked with verification's note, a human's task cancel starts no revision, and a goal that asks for a plan is told why there is none without a model call. The status' `auto_approve` is what is in force (set and trusted), not the raw setting.
- **Questions about planning go away when they are answered by what happened.** "Friday cannot plan this goal", "the plan cannot be read", "today's budget is spent" and "a planning action failed" stayed in "Waiting for you" after a person wrote or approved the plan, and answering a stale one later started a revision nobody asked for. They are answered as moot when a person proposes the plan or a plan is approved, and every question of a goal when it is cancelled or completed.
- **"Cancel goal…" on the goal card**, for a goal that is open or running. Only an integration conflict's card offered it, so a goal nobody wanted stayed on the board for good. Its unfinished tasks are cancelled and its agents stopped; the goal branch and its commits are kept.
- **Cancelling a task other tasks wait for asks what becomes of them.** A task that depends on a cancelled one never starts, so its goal never finished and nothing said why. The card, the inspector and the question card now name the waiting tasks and ask: **cancel them too** (through every level) or **keep them**, in which case they no longer wait for it and start once their other prerequisites are done (`dependents: cancel | release` on `tasks/:tid/cancel`; the desktop's dialog says the choice). Backing out at the confirmation changes nothing.
- **The plan editor keeps what you typed.** Esc, the close button or another dialog opening over it lost the whole draft. A dialog's content may now say whether it may close (`beforeClose`): the editor asks "Close the plan editor?" once something was typed, and a draft that is closed anyway is kept for its goal and brought back when the editor opens again, with **Start over**. Proposing the plan drops it.

## Unreleased — stability pass, part 3: checks that mean what they say, and work that is not left waiting unseen

Findings of the 2026-11-16 review of verification and of what waits for a person.

- **A merged revision is checked with the project's dependencies installed.** When two tasks of a goal ran in parallel, the second needed a real merge, and Friday checked the merged revision in its own checkout, which had no `node_modules`: the project's tests failed there ("Cannot find module…"), again on every retry and on "Integrate my repair", and the goal never completed. That checkout now gets its dependencies as a task worktree does (the same setup and dependency cache), kept while the manifest and lockfile are the same and cleared when they change. When they could not be installed, a failing check says so instead of blaming the merged work alone. `tests/integration/goal-integration.test.ts` has the case; it fails without the fix.
- **A check the claim itself reports as failed is not evidence.** A claim listing `tests: failed` and nothing else passed Friday's evidence check, since any named check counted. It is now refused ("the only check(s) the claim lists failed by its own word"), and a failed one beside real evidence is noted (`evidence.claimed_failed`).
- **"Passed" says when only Friday's own checks ran.** With no project checks set, a verification is Friday's part alone (scope, credentials, evidence): the task inspector says "Checked by Friday only…", and the "Check the work automatically" switch says so too.
- **Work that waits for you is counted.** With automatic checks off (the default), a finished task waited at "Ready for verification" while the header said "0 waiting for you", and a completed goal raised nothing. "Waiting for you" (the header, the rail, the pill, the tray, the title) now lists **Work to verify** and **Goal ready to land**, each opening its dialog, and each is announced once. With automatic checks on, a task still waiting after a minute is listed too. Work made in the project folder itself is not listed as "to land".
- **Turning automatic checks on checks what already waits.** Claims that waited when the switch was turned on (and trusted) were checked only after a restart or a resume; they are verified at once.

## Unreleased — stability pass, part 2: landing never touches what is yours, and says what is in the way

Findings of the 2026-11-16 review of "Land into my branch" (each reproduced against a real repository in `tests/integration/goal-integration.test.ts`).

- **A merge, rebase or cherry-pick of your own is never touched.** Landing while you were halfway through your own merge ran `git merge --abort` on it and then said "nothing was changed": your resolution was gone. Land now refuses before git runs when the folder is in the middle of one, and only ever takes back a merge it started itself.
- **Changes in the way are named before anyone clicks.** `GET goals/:gid/land` says what Land would do: the branch it lands into by name, or what is in the way with the files (uncommitted changes to files the goal changes, an uncommitted file where the goal adds one, staged changes, a detached HEAD). The dialog shows it, with **Check again**; the button reads "Land into main".
- **Every way git can refuse ends the same way: nothing changed, and a plain reason.** Git's exit code 2 (local changes, a locked file) fell through as a generic error and could leave stray files. A conflict, a commit hook that refuses the merge commit, a missing git name and email, a fast-forward-only repository, a locked file and the time limit are each said in a sentence, git's own words after it; whatever the attempt left among the files it was writing is put back, and what could not be is named.
- **Work made in the project folder itself is not "ready to land".** A goal worked by a session attached from an editor (Antigravity, Claude Code in VS Code), or with worktrees off, has no goal branch: its work is already in the folder. The card now reads **Review and commit**, and the dialog says so and lists what is not committed yet, instead of "0 commits" and a failing Land. A goal that mixes both says which part is where.
- **The board knows a goal was landed.** The card reads "Landed into main" (`goal_landing` in the snapshot) instead of "Ready to land" for ever; a merge made by hand can be marked as landed from the dialog.
- Smaller: `fast_forward` was always false; one landing runs at a time per project; the desktop waits 180 s and the browser 180 s for a merge the daemon gives 120 s, so its own answer is what arrives; the desktop's dialog names the branch and is not shown when nothing would merge; Land is disabled when the goal branch brings no commits; the dialog shows the daemon's notes about the branch.

## Unreleased — stability pass, part 1: the desktop app opens, says why it cannot, and starts again

Findings of the 2026-11-16 review of what a person meets first (five read-only reviews; each finding re-read in the code before it was fixed).

- **A launch by hand opens the Studio.** The window was created hidden and only the tray, the Notch or a second launch showed it, so a first start ended with a tray icon and a pill. `boot` now shows it once the project is chosen, or with "No project is open". The sign-in entry passes `--background` and stays in the tray; an entry written before still counts as on.
- **A cancelled folder picker is not a dead end.** The "No project is open" screen has **Choose a project folder…** (`choose_project_folder`), and no longer speaks of shortcuts and `--project`.
- **A Friday that stopped is started from the Studio.** The strip said "open it again from its shortcut or the desktop app" inside the desktop app, and Try again only reconnected to the dead daemon. The shell's `stopped` or `failed` now shows on the strip at once ("Friday has stopped for this project…") with **Start Friday**, which restarts it through the shell.
- **A failed start says why.** The Studio showed "Friday stopped while starting (exit code 1)" alone; it now adds the last line the daemon wrote (shown with hidden characters visible, 300 characters at most) and offers **Open config.yaml** and **Open the log** (`open_project_file`: VS Code, or Notepad without it).
- **Cancel is not an error.** Cancelling one of the shell's own confirmations (land, trust, stop, approve…) raised a red toast "DESKTOP-1003: you cancelled it in the confirmation dialog", and the same text beside the form. `act` and `actWithError` now treat it as nothing done.
- **No restart into a broken config.** Settings' and the planner switch's **Restart Friday** refuse, with the reason, while `config.yaml` as it stands cannot be read: the running Friday keeps its settings, and one started again would stop at once.
- **A file that does not open says so.** "Open in VS Code" and "Open config.yaml" did nothing without VS Code; the shell's refusal is now a toast.
- The planner switch no longer says "Friday restarts with the new planner" when the restart was cancelled.

## Unreleased — fewer terminal steps: plan with Claude Code, check work automatically, land a goal

- **"Plan with your Claude Code sign-in" in Settings → Planner:** while the planner is not ready, one button sets `master_brain.provider: claude-code`, `providers.claude-code.allow_remote: true` and a daily limit in `config.yaml` (default $2), then the desktop asks, in its own dialog, to allow this machine to spend that much through Claude Code and restarts Friday. No API key is involved: planning uses the installed Claude Code as it is signed in. In a browser the page sets `config.yaml` and shows the one terminal step left for this machine (`friday brain allow-remote --provider claude-code --budget N`). Plans still wait for a person's approval. The desktop's `allow_spending` takes the provider (`anthropic` or `claude-code`).
- **"Check the work automatically" in Settings → Policy:** one switch sets `verification.auto_on_completion: true`, then asks for this clone's trust in the change, the shell's dialog on the desktop and a confirmation in a browser, as `friday policy trust` would. A loosening still applies only once trusted (ADR-0029 §6); a setting already asked for but not trusted shows "Trust and turn on".
- **The daemon edits a few settings itself:** `POST config/settings` takes `{ set: { key: value } }` for the keys in `EDITABLE_SETTINGS` (the four above), validates the whole file as Friday reads it, keeps its comments and layout, writes it whole, and records `config.edited`. Any other key, a value of the wrong type, or a file that does not parse is refused and nothing is written.
- **"Land into my branch" in Ready to land:** a person's click merges a completed goal's branch into the branch the project folder has checked out, as `git merge` there would, after a confirmation (the desktop's own dialog names the branch, its commits and files). It is all or nothing: a conflict or any refusal by git aborts the merge, changes nothing and says why; a branch already merged answers "nothing to land". It records `goal.landed`. Friday still never merges on its own, and the VS Code and git steps stay beside the button. The daemon serves it at `POST goals/:gid/land`; the desktop shell confirms that route itself.

## Unreleased — a plan names the agent a task is for

- **"Assign to" in the plan editor:** each task can name one agent (Friday decides by role when it names none). The choice is kept with the plan version (`assign_to` on its tasks; migration 28 adds the column) and shown in the plan review, and when the plan is approved the task is created reserved for that agent, a human's reservation that does not expire. Before, delegation gave each task to any free agent, so a task meant for Antigravity, which waits for its person to type `/friday`, went to whichever agent Friday runs was free first.
- **A person's choice only:** the schema a planner model is given leaves `assign_to` out, and what a model writes has it cleared, in a first plan and in a revision's new tasks.
- **The task card offers every agent Friday knows:** its Assign (Reassign once held) menu lists agents that are not connected too, marked so, Antigravity's saying it waits for `/friday`; giving a task to one reserves it.
- `tests/scenarios/antigravity-attach.test.ts` has a plan with one task for Antigravity beside a free agent Friday runs: the free agent takes only the other task, and Antigravity claims its own with `/friday`. Without `assign_to` the same scenario hands the Antigravity task to the free agent.

## Unreleased — Antigravity connects from the Agents drawer

- **A "Connect" button for Antigravity:** the Agents drawer has an Antigravity card beside "Claude Code in VS Code". Connect previews every file `friday harness config antigravity` would write, applies them on confirm, shows the doctor's answer and then the steps in Antigravity (open the folder yourself, trust it, allow the friday tools, tell the agent to take its task). A connected session shows in the list as "attached in Antigravity". The daemon serves it at `agent-setup/antigravity` (GET previews, POST applies), and the desktop shell forwards those two routes.
- **`/friday` in Antigravity:** `friday harness config antigravity` also writes a skill, `.agents/skills/friday/SKILL.md`, which Antigravity offers as the command `/friday`: it takes the session's next Friday task, works it and claims it. Each `/friday` is one task and ends by naming what waits next; nothing loops over the queue or waits for work, since a personal account's session is one its person drives. A skill named friday that the project already has is left alone (`ag.skill` in the doctor says which is there).
- **What the first live sessions showed (CLI 1.4.4, then 1.5.9), and what changed for each:**
  - *Hooks run in `.agents/`.* Antigravity starts a hook in the folder of `hooks.json`, so the command's path named `.agents/.friday/harness/antigravity/hook.mjs` and every hook ended with "Cannot find module". Friday now writes a three-line file at that path that runs the tracked launcher, so the command works from either folder (`ag.hook-shim` in the doctor).
  - *A reply without a decision is a denial.* The `{}` Friday sent for "no objection" was read as "tool call denied by pre-tool hook", so no call ran. Antigravity has no reply that leaves a call to its own rules without asking its person, and saying `ask` for every step cost a session thirty to forty prompts. **The owner decided (2026-11-16): for Antigravity alone, a call Friday's own rules pass, and each of Friday's own tools, is answered `allow`.** A call Friday did not judge (a tool it has no rule for, or any call while Friday is down) is `ask`; what its rules refuse or want a human for is `deny` or `force_ask` as before; `auto_approve` is never sent. Every other attached host still gets no decision, and its own rules apply.
  - *No task could start there.* The role registry named Antigravity as a host and gave it no candidate, so every claim ended "no dispatchable candidate for role … on this harness". The owner added it: `gemini-3.8-flash` on `antigravity`, last in each working role (registry `2026-11-16.1`, catalog `2026-11-16.1`). It reorders nothing, and the route is advisory, since the session's person picks its model.
  - *A refused claim sent the agent probing Friday.* The `/friday` skill now says to report what Friday said and stop, and not to run the `friday` command or read its files.
  - *A rehearsal exists.* `tests/scenarios/antigravity-attach.test.ts` plays a whole session against a real daemon (hooks from `.agents/`, the MCP server of `mcp_config.json`, the tool names of CLI 1.5, the skill's steps) in a project with Friday's files committed and in one without: connect, claim, edit in scope with no prompt, refusals where they belong, claim, verification passed.
  - *CLI 1.5 renamed the file tools.* `read_file`, `edit_file` and `write_file` are judged like `view_file`, `replace_file_content` and `write_to_file` before them; `edit_file` and `write_file` were passing unjudged.
  - *MCP tools are called two ways.* `call_mcp_tool` (the lazy default, carrying the server and the tool) and `mcp_<server>_<tool>` (eager) are both read, so Friday's own tools are left to its protocol and another server's are asked about.
  - The hook launcher is 0.2.1; run `friday harness config <host>` again in a project to update its copy.
- **Still no Start button, and the card says why:** Antigravity's terms keep a personal account to the Antigravity its owner runs themselves, so Friday never launches it; it gives the session tasks, judges its tool calls through the hooks and verifies the work. Support stays experimental until a live session has been recorded.

## Unreleased — review of 2026-10-22, R8 and R9: a long line is readable, a member body is one element

- **`artifact.read` reads a line longer than one answer in slices:** when the first line to return is longer than the 16,000-character budget, the answer carries its slice and `cut: { line, col }`, and `col` with `offset` reads that line on; the same for a matched line under `find`. The tool's words say how (R8; such a line used to come back empty, with nothing to retry).
- **A member patch is exactly one element of the body:** the probe counts every element of the class or interface body it parsed the new text in, a static block or a second member included, not only what the declaration walk recognizes (R9; `m() {}` followed by `static { … }` used to pass as one declaration).

## Unreleased — review of 2026-10-22, R7: a shadowed name is nobody's edge

- **The reference walk tracks the names bound nearer than the file's declarations:** a function's parameters and type parameters, a block's own `const`, `let`, `var`, functions and classes, a loop's and a catch clause's bindings, a class's or type's type parameters. A call, construction, type use or JSX element of such a name is recorded as shadowed and the graph links it to nothing, and a member call on such a value is a name-only reference like any unknown object (R7: `use(target: () => number) { target() }` used to read as an exact edge to the imported `target`, and a blast radius reached `use` with high confidence). The facts format is 3; an older `facts.db` is discarded.

## Unreleased — review of 2026-10-22, R5 and R6: stale classifications dropped, dependency labels made stable

- **A classification answers the decision it was asked for, under the intent it was made for:** the Master Brain records its answer with the blocked decision's id and intent version, and the state refuses it as stale when the contract moved on meanwhile (an intent change reopened it, a human chose); the job ends saying so and the contract in force has already queued its own question. An intent change now also reopens a classification still awaited, not only a role a model chose (R5). The classifier's input carries the project's objective, constraints and outcomes beside the goal's.
- **Dependency labels are rewritten to stable keys at validation:** `role-2` or a role name becomes the node's key, the role or `<role>-<n>` for a repeat, the same key a split names its parts by, so a stored proposal with positional labels can be approved (R6; it used to be refused at the split).

## Unreleased — review of 2026-10-22, R3 and R4: no pin past a role decision, no old sign-in over a new failure

- **A pinned model no longer dispatches a task whose role is unresolved:** the role decision (a proposed multi-role DAG awaiting a split, a classification still required, no role at all) is checked before any pin, so choosing a model is no approval of a decomposition (R3; the project pin used to return first).
- **Sign-in evidence is read by time, not by level:** a host-wide sign-in failure newer than a model's seven-day pass blocks that model too, an expired pass never shadows an indefinite failure, and a model's pass newer than the failure lets that model back while the host's other models wait (R4; a model's old pass used to win over the host's newer failure). `docs/routing.md` says so.

## Unreleased — review of 2026-10-22, R2: a symbolic patch never loses another's write

- **Friday's patches of one file run one at a time** (a per-file lock in the daemon), so two planned side by side land one after the other, each on the other's result: the review's parallel patches of `a` and `b` had both answered `written` while `a`'s was overwritten. **Before writing, the file is read again** and must equal what the plan was made from, else the patch is refused as changed meanwhile and nothing is written; **the task must still be the agent's** with a live attempt after the planning's awaits, else `denied`; the file is **replaced in one step** (written beside it, renamed over it). ADR-0039 §3 records the commit boundary.

## Unreleased — review of 2026-10-22, R1: graph answers under the recipient's read permission

- **One read rule for every projection of code:** the context compiler's permission check (the task's and team's read scopes, `deny.read`, the protected locations, a link judged by its target) is now `createReadFilter` in `@friday/context`, and the daemon's `graph.query`, `graph.blast_radius` and `graph.skeleton` apply it to the caller, judged after the graph work under the policy as it is then. A symbol in a withheld file is withheld whole; a shown symbol names only readable callers, callees and tests; a file query of a withheld file is `permission_denied`; a search never lists one; a blast radius never names one and a withheld seed is no seed; a skeleton of one comes back as "not a file you may read", and skeleton text is redacted as a packet excerpt is. A human's read grant opens a file through `friday_request_context`, never through the graph, so none is spent there (review R1, reproduced with a sentinel in `.claude/hidden.ts` and a `deny.read` on the frontend).

## Unreleased — review of 2026-10-22, R10: no repository code in an untrusted worktree install

- **pnpm installs pass `--ignore-pnpmfile`** beside `--ignore-scripts` on a clone that has not trusted the policy: pnpm loads the repository's `.pnpmfile.cjs` before installing anything, which `--ignore-scripts` alone left in (`docs/reviews/2026-10-22-main-merge-review.md`, R10, reproduced with a marker-writing hook). **Yarn installs wait for trust:** a `.yarnrc` `yarn-path` or a `.yarnrc.yml` `yarnPath` or `plugins` entry runs JavaScript from the repository and no flag stops it, so a `yarn.lock` is refused with the reason until `allow_scripts: true` is trusted. npm and bun keep `--ignore-scripts`. The policy guide says what each manager's flags keep out, instead of claiming no project code runs.

## Unreleased — the live host checks of 2026-10-22, and two fixes they found

- **Checked live on this machine** (`docs/measurements/2026-10-22-live-hosts.md`): `friday setup` and `friday hosts setup` wired Claude Code 2.1.306, Codex 0.162.1, Gemini CLI 0.65.0 and OpenCode 2.1.2; every doctor ran with the daemon up; Claude Code (attached, headless, haiku) and Codex (spawn mode, unelevated Windows sandbox) each did a small task that verification passed. Gemini CLI refuses the owner's consumer account itself; OpenCode 2.1.2 is refused by the profile pinned to 1.19.3; Antigravity is configured and doctored (no headless mode); Cursor and DeepSeek are not installed here.
- **Codex gets the bare model name:** the registry's `openai/gpt-6.1-sol` is sent to Codex as `gpt-6.1-sol` (a ChatGPT account refuses the prefixed name) and reported back under the registry's name; a model the host cannot serve ("model … is not supported", "unknown model", "model_not_found") is a host failure, `runtime_unavailable`, benched and failed over, instead of a fatal agent error that asks a human.
- **Readiness evidence is no longer erased across witnesses:** a new observation supersedes only the earlier rows of the same session, or of the same source when there is no session; a session's end takes only its own rows, so the doctor's day-long check and a claim's week still count afterwards. A bench still replaces the earlier bench whoever made it. Found when a Gemini session's end left Claude Code reading as "not installed".

## Unreleased — the owner's rulings of 2026-10-22

- **ADR-0036, ADR-0037, ADR-0038 and ADR-0039 are accepted** by the owner. Symbolic patching stays under test: the testing phase decides whether it is kept.
- **Two more tools for spawned sessions, for the testing phase:** `friday_blast_radius` and `friday_symbolic_patch` join the compact set (seven tools now), one line each; whether they cost more than they save is measured there and they are removed if they do. The rules of a spawned session name them like the others.
- **Phase 7.2 is skipped:** a test suite with repositories in it, designed for the testing phase, replaces the reruns against the baseline.

## Unreleased — Phase 8B, the handoff completion record

- **`docs/plans/2026-10-22-handoff-completion-record.md`:** for each area the handoff asked for, what exists, where its evidence is, and what stays open (Phase 7.2's reruns, the live host gates of the plan's §8, the owner's acceptance of ADR-0036 to ADR-0039, whether a spawned session gets any of the six attached-only tools, vectors and patch insertion for a later measurement). The plan's status points at it; a 2026-10-22 amendment at the head of `docs/BUILD_PLAN.md` names the program's ADRs and says which of its older sections they supersede.
- **The validation set of the closure, run on 2026-10-22:** typecheck (28 tasks), build (26 tasks), the portability check and the whitespace check clean; `pnpm test:all` (every unit, integration and end-to-end suite) 283 files passed and 17 skipped, 2,957 tests passed and 27 skipped (the skipped ones are the live gates that need a host, a model or a human), in 13 minutes on this machine.

## Unreleased — Phase 8A, symbolic patching (ADR-0039, proposed)

- **One declaration replaced by name:** the RPC method `symbol.patch` and the tool `friday_symbolic_patch` (attached sessions, deferred, listed only with a code graph) replace a function, class, method, field, interface, type, enum, namespace or single-variable statement by its name (`Parent.member` for a member) without rewriting the file. The boundary comes from a fresh parse of the file at the moment of the patch, never from the graph's recorded lines; the patch is refused, with the reason and the candidates, unless exactly one declaration matches (the `kind` and `line` an agent read may narrow it), the new text is one declaration of the same name and a compatible kind, and the whole file still parses afterwards. The `export` prefix stays as it is; adding or removing an export, inserting or deleting a declaration, and a file that does not parse are the editor's. `dry_run` previews the lines replaced and the text in and out.
- **A host write like any other:** the patch is judged by the one tool judge (the task's write scope, the protected paths, a human where the policy asks, with `denied` and `approval_required` as answers), written with the file's own line endings, recorded on the attempt as a completed tool call with its changed path, and verified with the claim. The file's SHA-256 before and after are in the answer. The spawned set is unchanged; the CLI gains nothing.
- **The evidence the plan asked for:** `docs/measurements/2026-10-22-symbol-ranges.md`. On this repository 8,191 of 8,222 recorded symbols were located again exactly in a fresh parse, none at a different end line, none ambiguous; the 31 others are anonymous default exports, which have no name to patch by. A second repository on this machine agrees (1,851 of 1,860).

## Unreleased — Phase 6B, the handoff's surfaces as Friday tools (ADR-0038, proposed)

- **Five tools for an attached session, none always loaded:** `friday_graph_query` (a symbol by name, a file by path, or words, on the code graph of the agent's checkout; every answer names the graph version), `friday_blast_radius` (what a change to files, symbols or the working tree's diff would reach, with confidence; guesses only on request), `friday_skeleton_read` (up to five files with their bodies folded), `friday_ccr_retrieve` (lines of the raw, redacted output of an operation run or a verification check of the agent's own task, or of a message to it; bounded, and the answer says how to read on) and `friday_mem_learn_from_failure` (a lesson from a resolved failure of the task, recorded with the failure as its origin in Friday's own words; promoted only by a human or by the task's verification passing later). The nineteen tools are unchanged; the spawned set of five is unchanged. The four graph and output tools are listed only when the daemon can answer them (`GET /me` says so; the host hears the list changed). `friday_run_operation` names the artifact that keeps the whole output. The server instructions name the five and stay under 2,000 characters.
- **The handoff's twelve names, mapped:** five are these tools; `plan_decompose_dag`, `plan_log_iteration`, `plan_verify_gate`, `mem_recall_context`, `mem_commit_fact` and `opt_exec_filtered` are the goal flow, `friday_report_progress`, `friday_claim_done`, `friday_recall`, `friday_remember` and the operations gateway under other names (ADR-0038 §4); `graph_symbolic_patch` waits for Phase 8. Guide: `docs/mcp-tools.md`.
- **The prompt wrapper of a spawned session** is now a tested rule: the static rules come first and the task last, they name only the Friday tools the session has, and none of the new tools; `friday-local-mcp` starts the same server, so it offers the same tools. Phase 6 is complete.

## Unreleased — Phase 6A, what the daemon answers behind the handoff's tools (ADR-0038, proposed)

- **Four RPC methods for a registered agent:** `graph.query` (a symbol by name, a file by path, or words: the code graph of the agent's own checkout, with the graph's version on every answer), `graph.blast_radius` (what a change to files, symbols or the working tree's diff would reach, with confidence), `graph.skeleton` (up to five files with their bodies folded, the ones the graph lacks named), and `artifact.read` (lines of the raw, redacted output of an operation run or a verification check of a task the agent holds or held, or of a message delivered to it; at most 400 lines and 16,000 characters per call, `find` for the matching lines only; anything else is refused). `GET /me` says what the daemon can answer (`capabilities.graph`, `capabilities.artifacts`).
- **A lesson learned from a failure keeps the failure:** `learning.propose` takes `from_failure` (a verification of the task that failed, by default its latest, or an operation run that failed), and Friday writes the proposal's `origin` from its own records: the failed checks and their summaries, or the operation and its summary, never the agent's words. A passed verification, a running operation or another task's failure is refused. The proposal is promoted as before, by a human or by the task's verification passing later; the failure itself promotes nothing. The promoted memory carries `origin:<kind>:<id>` among its tags; `friday learning show` prints the origin. Migration 27 adds the column.
- **The rework note names each failed check's raw output** (`artifact:<id>`), so a lesson can say where it comes from.

## Unreleased — Phase 5C, the questions asked of the code graph (ADR-0037, proposed)

- **`friday graph symbol <name>`:** each match with its file and lines, kind, signature, whether it is exported, who calls, constructs, types or renders it (resolved edges with their certainty), what it uses, the tests of its file, and, apart, the name-only matches (guesses, labelled). Bounded: 20 matches, 50 edges each, and it says when cut.
- **`friday graph blast-radius <path>… [--symbol file#name] [--diff] [--depth] [--names]`:** what a change would reach upstream, to a depth, each hit with a confidence from the edges it came by (`high` exact, `medium` inferred, `low` name-only) and what it was reached from; the seeds say why a change may break others (an exported symbol called from another area, a shared contract). Name-only matches come in only with `--names`. It lists; it judges nothing.
- **`friday graph skeleton <file> [--level 2]`:** the file with its bodies folded, line numbers kept: L1 imports, exports and each declaration's first line; L2 also doc comments and exported interfaces, types and enums whole. A context view only. **`friday graph search <words>`** ranks symbols and files by their words.
- **For agents:** `friday_request_context` answers `kind: "symbol"` (query: the name) with the lookup, alone like a file request; `scope_files` with `query: "skeleton"` adds each scope file's L1 skeleton. Nothing is sent unasked. Phase 5 is complete; the handoff's tool names (`graph_query_context`, `graph_blast_radius`, `opt_skeleton_read`) arrive as projections of these queries in Phase 6. Guide: `docs/graph.md`.

## Unreleased — Phase 5B, the code graph knows when nothing changed, and answers keywords (ADR-0037, proposed)

- **A Merkle tree over the files git sees** (`.friday/graph/merkle.db`): the BLAKE3 of each file, kept with its size and time so an unchanged file is never read again; folder hashes from their children; the root hash names the tree and is recorded on the graph. "Did anything change" costs a stat per file. When git could not vouch for a checkout (an approximate identity, many dirty files), an unchanged tree keeps the last graph instead of rebuilding it, and a changed tree names the files to read again. Git's source identity stays the authority on what the checkout is; the tree only accelerates the graph's own staleness check. `@noble/hashes` (pure JavaScript, no install scripts) provides BLAKE3.
- **Keyword search over the graph** (`.friday/graph/search.db`, SQLite FTS5 with BM25): one row per symbol (its name's words, its path, its signature) and one per file (its path's words, its area, the names it exports); identifiers are split at case changes and separators, so `checkoutService` is found by `checkout`; every word is required first, any word second; symbols rank above files on a tie. Rebuilt with each graph; `friday graph reindex` rebuilds everything. No vectors: they wait for a measurement that shows keyword and graph retrieval miss things. The daemon's graph service exposes `search()`; the command and the context request that read it come with 5C.

## Unreleased — Phase 5A, the code graph knows the symbols inside files (ADR-0037, proposed)

- **Symbols are facts of a file:** functions, classes with their methods and fields, interfaces, type aliases, enums, variables and namespaces, each with its line range, whether it is exported (as a declaration, the default, or in an `export { … }` list), its parent and a one-line signature; beside them, what each import binds and what the file calls, constructs, uses as a type, renders as JSX or calls through a member. Facts stay content-addressed (format 2; an older `facts.db` is discarded) and the incremental build keeps unchanged files' symbols as it keeps their imports.
- **Edges between symbols, never guessed:** a reference to a local symbol is an edge within the file; one to an imported name follows the import's file edge to the symbol the target declares and exports (exact, or inferred when the import was); `this.m()` resolves inside the class; `ns.f()` through a namespace import. Anything else is unsupported with its reason (an unsupported import, a re-export the target does not define, a namespace member, or a member call on a value whose type the graph does not know, kept by name alone and labelled so). Queries on `CodeGraph`: `symbolsOf`, `findSymbols`, `callersOf`, `calleesOf`, `nameReferences`, `enclosingSymbol`; `friday graph` counts symbols and their edges. The commands and the context request that read them come with 5C.

## Unreleased — Phase 4, the coding tools on a machine wired to Friday once (ADR-0036, proposed)

- **`friday hosts setup`:** one `friday` MCP server entry in each installed tool's own user configuration (Claude Code `~/.claude.json`, Cursor `~/.cursor/mcp.json`, Gemini CLI `~/.gemini/settings.json`, OpenCode `~/.config/opencode/opencode.json`, Codex `~/.codex/config.toml`, DeepSeek Harness `~/.deepseek-harness/config.yaml`), pointing at a launcher Friday owns in its state folder. From then on the tool reaches Friday in every repository on the machine; where there is no Friday project the server says so and does nothing else. Merge-only (JSON keys kept; TOML and YAML get one marked block and are never parsed), backed up once a day, atomic, byte-stable when nothing changes, `friday hosts remove` takes it back out, a hand-written entry is reported `manual` and never touched, a tool that is not installed is never written blind.
- **`friday hosts`** reports each tool: installed, the machine entry, this project's attach files, the next step; the report is also written to the state folder. `friday init` runs the setup once the machine is set up (`--no-hosts` skips); `friday setup` writes the launcher. An installed and configured host counts as detected and configured in readiness for a day when the project's daemon runs.
- **DeepSeek Harness skeleton** (`@friday/adapter-deepseek`): detection of `dsh`, its configuration block, a doctor; it spawns and attaches nothing, and stays non-dispatchable in the registry until someone has seen it work. Antigravity keeps project-local files only.
- **`friday-local-mcp`** is the launcher's name and the setup surface; the server entry stays `friday`, so tools keep their `mcp__friday__…` names. OpenCode sessions started from a user entry now register under their own name.

## Unreleased — Phase 7.1, dependencies installed in a fresh task worktree

- **No attempt waits mid-run for an install:** before the agent starts, Friday installs the worktree's dependencies in the execution profile: the install the lockfile calls for (pnpm, npm, yarn or bun; frozen, offline first, lifecycle scripts ignored, so no project code runs), or the project's own `worktrees.setup.command`. The project's own command and `allow_scripts: true` are loosenings that wait for `friday policy trust`; a declared command this clone has not trusted is refused, never replaced by a guess. Nothing runs when there is no `package.json`, no lockfile, or `node_modules` already.
- **Nothing is installed silently:** `run.workspace_ready` records what ran, how long and how it ended (output redacted), `friday task inspect` shows it, and an agent whose dependencies could not be installed is told so in its `task.start` note. `worktrees.setup.on_failure: fail` declines the attempt instead and asks a human. The worktree timeout follows the install's `timeout_s` (default 600 s).
- The large multi-file rerun the plan asks for (Phase 7) still waits for the owner: it needs the Edutube repositories and paid model calls.

## Unreleased — Phase 2.3, a multi-role proposal is approved by splitting the task (ADR-0035 §5)

- **`friday task split <task>`:** a human approves the classifier's multi-role proposal by splitting the task into one task per role, in dependency order; each part carries the proposal's summary for its role and the original's kind, scope, acceptance criteria, priority, risk and goal, and the roles' `depends_on` become task dependencies. The original is cancelled as split, naming its parts, and whatever depended on it now depends on the split's last parts (`task.dependencies_changed`). A standalone task's parts carry a `human` role and are READY when the original was; a task of a goal is split through a plan revision the same approval approves, so the planner stays the one authority for a goal's tasks and the parts carry the plan's role. Neither asks the classifier again. Route: `POST tasks/:tid/split`; event: `task.split`.

## Unreleased — Phase 2.2, a host that fails is benched and the work moves down the ranking (ADR-0035)

- **Host failures have a kind:** an agent error may say why the host failed (`failure: { kind, retry_after_s? }`: `start`, `auth`, `rate_limit`, `transport`, `timeout`, `runtime_unavailable`). The Claude Code and Codex adapters classify what they can recognize (not signed in, rate limited with the wait the host asked for, a host that could not launch, a process that died mid-turn); a turn the host ended with an error of its own stays a work failure. Friday classifies what it sees itself: a decline before work started is `start`, a `task.start` never acknowledged is `timeout`, a session that did not come back within the reconnect window is `transport`.
- **A failing host is benched, never the work:** a sign-in failure keeps the host out until it is seen signed in again or `friday readiness clear <host>`; a rate limit benches the model until its reset time, else 30 minutes; a failed start, a lost process or a timeout benches the host and model for 10 minutes. Failed verifications, failing checks, policy denials, scope violations and agent errors without a kind bench nothing. `friday readiness` shows benches with their end; `friday readiness clear <host> [--model <m>]` lifts one.
- **Failover rides on recovery:** the attempt is reassigned as before (two automatic switches, then a human), and because the bench was recorded first, the next route skips the failed host for the next rank. The next route's receipt and `friday routing explain` name the failed attempt, its host, model and failure (`failover:`); the next attempt's handoff summary opens with "Stopped: the previous attempt on … stopped (…); it is benched until …. This attempt runs on ….".

## Unreleased — Phase 2.1, routing dispatches only to hosts this machine has seen (ADR-0035)

- **Readiness is evidence, not a declaration:** Friday records what it has seen of each host and model on this machine: a session that registers shows its host installed, configured and connected to Friday while the session lives; an attempt that ends in a completion claim shows the host and model signed in for seven days, renewed by each claim; `friday harness doctor claude-code` and `friday harness doctor codex` record what they found for a day, when the daemon is running. Evidence is event-sourced (`readiness.recorded`, `readiness.invalidated`, table `readiness_evidence`, migration 26) and replays.
- **Routing filters on it and never reorders:** after pins and hard constraints, an unready candidate is excluded with a reason and the next rank is considered; when every candidate is out, the route blocks with the reasons. Under the owner's loose rule a sign-in never seen is tried; a paid live check is never required. A dry run judges each candidate on its own host, so `friday routing explain` says which hosts could take the work now. A pinned model needs a ready host too.
- **`friday readiness`** lists every host and model the ranking names (and every host seen) with its verdict, live sessions, sign-in, bench and the reason it is out; `--evidence` shows the observations; `friday readiness clear <host> [--model <m>]` lifts a bench or a failed sign-in. Routing receipts and `routing explain` carry the readiness checks made. Benches and automatic failover follow in slice 2.2.

## Unreleased — M14.10, the code graph builds from its last build

- **A rebuild reads only what git cannot vouch for:** the graph of a checkout starts from the last graph of that checkout and keeps a file's facts unread when its content is unchanged: with the same HEAD, when it was dirty at neither build; across commits, when the commits do not differ in it. Every edge is still resolved from scratch, so a new file, a deleted one, a changed `exports` map or a tsconfig that appeared reach every importer. An approximate identity (too many dirty files to hash) or a different checkout reads everything, as before. Measured: a rebuild after one edit takes a quarter to a third of a warm full build on this repository, a quarter on a 200-file monorepo; the two graphs are equal in every node, edge, skipped file and contract (`docs/measurements/2026-10-20-incremental-graph.md`).
- `friday graph` says how many files were kept from the last graph, beside the parsed and cached counts. The daemon reads a checkout's identity once per rebuild, not twice.

## Unreleased — M14.9, the code graph reads the workspace's configuration

- **A package's whole `exports` map is followed:** `@shop/db/schema`, `@shop/api/modules/*` and the like resolve to their files, with the conditions Friday reads (`development`, `import`, `types`, `default`, `require`, `node`) and Node's longest-prefix rule for patterns. A subpath the map does not export, a key set to `null`, a key with none of those conditions and a target outside the package are still unsupported edges, each saying why. A package without an exports map exposes its files by path.
- **Build outputs lead to their sources, where the package says so:** an export that names `./dist/src/schema.d.ts` resolves to `src/schema.ts` when the package's `tsconfig.build.json` (else `tsconfig.json`) declares both `outDir` and `rootDir`. Without them the edge stays unsupported, and its reason names the tsconfig and the missing field. Nothing assumes `src`.
- **tsconfig `paths` resolve as TypeScript applies them:** the nearest `tsconfig.json` above a file governs it, `baseUrl` and relative `extends` are honoured, targets are tried in order, and paths come before workspace packages. A path whose targets name no file is unsupported, with the mapping in its reason.
- Every edge this adds is `inferred`, with the declaration behind it in its reason; `graph explain` and `scope_files` show it. Measured on a monorepo that exports `dist`: 126 unsupported edges of 574 became 0, and 12 shared contracts appeared where none was found; the graph build takes 5 to 35 ms more. Record: `docs/measurements/2026-10-20-workspace-resolution.md`.

## Unreleased — M14.8, the cheap fixes of the core audit

- **A file asked for through `friday_request_context` now arrives:** the tool sends the path it was given as the request's path (it sent it as a query the compiler never read, so every file request answered "names no paths"). `history` takes a path the same way.
- **The planner's cache survives a commit:** the revision and the recent commits are sent after the cached project context, not inside it, so a commit no longer rebuilds the provider's cache. They stay in every planning call, as source material.
- **A small task names its files:** cost-class routing sends the cheapest agent only to a low-risk task that may change one to three named files; a scope with a glob (`backend/**`, `**`) is of unknown size and is routed by the score.
- **A plan cannot ask for an edit it forbids:** a criterion that asks to change a named file outside the task's write scope is a validation error the planner repairs; criteria about running or passing a file are not edits.
- **Context requests cache better and read git once:** a request's answer is reused across unrelated memory or inbox changes (the code, the policy, the grants and the task's state still key it), and each compile reads the working tree's status once.

## Unreleased — M14.7, a minimal first packet

- **The first packet of a session names no files:** it carries who the agent is, the task, its criteria, the checks that will judge it, what it may change (`write:`) and one line against exploring broadly, with the project's memory and, for a rework, the handoff summary. The read-scope list, the related code and the recent commits left it: when measured, every file named got opened whether the task needed it or not, at 40% more cost and no gain in correctness.
- **A context request is answered alone:** `friday_request_context` with `scope_files` (the files the task may change, each once with what the graph knows of it, and the code the graph relates to them), `file` or `history` returns that material and nothing of the task packet; `task` and `decision` keep the task's context; `symbol` stays unsupported. The first packet lists no uncommitted paths either: its head line counts them, and `scope_files` marks the changed ones. `friday context explain` of a task shows the packet as the agent got it.
- **`friday context explain <task> --files`** shows what an agent's `scope_files` request is answered with: the files the task may change and the code related to them, with each file's reason. Without the flag, the command explains the packet the agent was given, which names no files.
- The context evals (`FRIDAY_TEST_BENCH=1`) score the first packet by default; `FRIDAY_EVAL_REQUEST=scope_files` scores the request that now holds the related files.

## Unreleased — the exploration measurement

- **Measured on a large repository** (`tests/scenarios/exploration.live.test.ts`, 20 Haiku sessions on clones of Friday itself): a plain Claude Code session spends 8 to 11% of its input on searches and reads of files it never changes, so a better map of the code can save a tenth of a session at most; Friday's full packet made sessions 40% dearer, because its file lists get read; a minimal packet (the task, its criteria, its write scope, one line against exploring) was as right as the full one, 20% cheaper, with 60% fewer reads of unchanged files. Record: `docs/measurements/2026-10-20-exploration.md`. The graph-query tool and mandatory workflow proposed for worker IDEs are not built: measured, not worth it.

## Unreleased — M14.5, is a small local model worth it (OpenCode checkpoint E)

- **Measured on this machine:** three small task kinds of the fixture shop, done by OpenCode alone and under Friday on `qwen2.5:7b`, judged by the same hidden checks (`tests/scenarios/opencode-e.live.test.ts`). No task ended right: OpenCode alone ran out of its 20 minutes on one and changed nothing on another, and under Friday the model's edit broke the project's tests and verification refused it. A small local model is not worth sending tasks to on this processor; OpenCode stays experimental.

## Unreleased — M14.4, OpenCode as a worker (experimental)

- **OpenCode takes Friday's tasks on a model on this machine:** `friday harness run opencode --model-url http://127.0.0.1:11434/v1 --model qwen2.5:7b` registers a worker (cost class free) that runs each attempt in its own controlled OpenCode server and session, with every call judged for that task and run. The task goes as one prompt with its packet; the last answer is the claim (plain words; `BLOCKED: …` when it cannot finish), with the worktree's changed paths and what the model calls cost. A cancellation stops the session with no call after it and ends its server; a restarted worker resumes its runs in a new session under the policy of that moment. It passes the eleven-case harness conformance suite against a scripted server, and live on `qwen2.5:7b` a task reached its claim, a cancelled session made no call after the stop, and a lost worker's run resumed in a new session and claimed. The session's completed writes are reported as observed before the claim. `harness run opencode` without the two flags is still the no-model preflight.
- **What the live runs fixed:** the final answer is plain words, since a small model asked for JSON wrote its tool calls as JSON text (LESSONS HX-40); one missed poll while the model takes every processor no longer ends an attempt (HX-41); closing the worker waits for attempts still ending, so no private profile is left (HX-42).

## Unreleased — M14.6, the packet names the project's checks

- **An agent is told which checks will judge its claim:** every task packet's acceptance section names the checks Friday's verification runs for the task, with their commands (`Friday verifies a claim with these project checks; run them before you claim: - tests: node --test … - rules: node scripts/check.mjs`). An agent kept to its task's files no longer misses a project rule that only a check enforces. A change of the checks compiles a new packet. Token cost: one line per configured check in each task packet.
- **Agents may run those checks:** a command that is exactly one of the project's checks, and that no other rule knows (a project's own script such as `node scripts/check.mjs`), is judged as a test run instead of asking a human. A check written as a deletion, a push or a fetch is still judged as what it does. On the trap goal, both of Friday's agents then ran the rule check before claiming and both tasks were right on the first try, in 46 s against 77 s (`docs/measurements/2026-10-19-benefit-trap.md`).

## Unreleased — M14.3, a goal where something goes wrong

- **The benefit comparison has a trap goal** (`FRIDAY_BENEFIT_GOAL=trap`): receipts and refunds with the currency symbol first, in a shop whose formatter another area relies on and whose rules a check of its own enforces. On Haiku every way shipped both tasks right; Friday's verification refused a claim that broke a project rule its tests could not see, and the rework fixed it in one edit. The plain sessions avoided that mistake by reading the project's decisions, which Friday's packet did not point its agent to. Record: `docs/measurements/2026-10-19-benefit-trap.md`.

## Unreleased — M14.2, cost classes live

- **Cost classes checked with a real host** (`tests/scenarios/cost-classes.live.test.ts`): a small, low-risk task went to the agent limited to claude-haiku-5-5 as the cheapest capable agent; its claim, refused by a human, was reserved for and reworked by the agent limited to claude-sonnet-5-5 and passed verification. Record: `docs/measurements/2026-10-19-cost-classes.md`.

## Unreleased — M14.1, the leftovers

- **Settings Hub:** the trust question lists exactly what is trusted and its hash; Stop Friday says how to start it again; the Friday and About pages follow the board; the notification refusals say where to allow them again; the browser session note and the clean-up hint are back.
- **OpenCode refusals say why:** a session Friday did not bind, a call it does not judge, a replayed call, a check that failed or came late, and Friday's own policy reason, instead of one generic message.
- **Tests that only timed out on a busy machine** wait for their state or have ceilings that hold under load (LESSONS T-109, T-110).

## Unreleased — the Settings Hub completed

- **What the Settings drawer offered is back in the Settings Hub:** in the desktop app, Planner stores the provider key in Windows' own prompt and allows spending with its own dialog, with the daily budget box and *Open config.yaml in VS Code*; the Planner page follows the planner's state; shortcuts are named by what they do and say why one is not active; starting at sign-in shows the shell's answer and puts a refused change back. Leaving Settings by Esc or Ctrl+comma no longer leaves the old Settings panel over the canvas.

## Unreleased — OpenCode checkpoint C (experimental)

- **Friday's refusals shown in front of a live model:** with the owner's permission, OpenCode 1.19.3 ran with Ollama's `qwen2.5:7b` on this machine, its own permissions open, and Friday's plugin as the only gate. The allowed write happened; a write outside the task's scope, a read of a fake `.env`, a shell write, a mock MCP tool, and writes under a failing check, a hanging check, an unbound session, a cancelled task and a stopped daemon were all refused with nothing written (`tests/scenarios/opencode-c.live.test.ts`, `docs/integration/opencode.md`). OpenCode stays experimental and L1 unverified until its lifecycle (checkpoint D) is recorded.

## Unreleased — OpenCode A/B (experimental)

- Added experimental OpenCode checkpoints A/B: a pinned 1.19.3 no-model server/session preflight with private configuration, plugin readiness and effective-config checks; a fail-closed before-tool plugin and fixture-tested translator using the existing tool.check policy; harness config/doctor/run dispatch, scripted-host conformance and an optional native no-model check. OpenCode remains L1 unverified. Model prompt submission, task polling and autonomous-worker discovery are disabled; no live model enforcement, coding-quality or busy-lifecycle claim is made.

## Unreleased — M13, fewer sessions and fewer tokens per goal

- **A small goal is one task:** the Master Brain's plan prompt (`plan-3`) keeps work one agent can finish as one task, and Friday merges a first plan of two or three tasks that would only run one after another into one, saying so in the plan's rationale. Plans you write, or ask for with feedback, are never merged. On the benefit comparison's goal: 38% less input than as two tasks, and as fast as one plain session.
- **A rework continues its session:** when the agent that did the work reworks it, spawned Claude Code (`--resume`) and Codex (`thread/resume`) continue the session that did the work, told why the claim was refused; a session the host cannot resume is replaced by a new one. Measured: 43% less input and half the calls for the rework.
- **Cost classes:** every agent is `free`, `cheap` or `standard` (`friday harness run claude-code|codex --cost-class`, else its model's class from the registry; `--models` limits the models routing may run for it). A small, low-risk task goes to the cheapest capable agent of its role, and a refused claim is reworked by a stronger agent when one is free.
- **A forgiving final answer:** a spawned session's final answer needs only its status; the changed paths come from the worktree. No missing or added field makes Claude Code refuse an answer.
- **Slimmer tools in spawned sessions:** Friday's tools are described in one line each, with only the fields an agent needs, and `friday_run_operation` only where the project declares an operation. With the final answer above: 943 tokens fewer in every call.
- **Measured:** `docs/measurements/2026-10-19-fewer-sessions.md`; the benefit comparison has a `friday-one` arm and the baseline a rework variant (`FRIDAY_TOKEN_BASELINE_REWORK`).

## Unreleased — the benefit comparison

- **Measured whether Friday helps:** `tests/scenarios/benefit.live.test.ts` (gated by `FRIDAY_BENEFIT`) does one goal three ways on the same host and model (one plain Claude Code session, two plain sessions at once in one folder, and Friday with two spawned agents) and judges each result by the same hidden checks no agent sees. The first record (`docs/measurements/2026-10-18-benefit.md`): on an easy goal of two tasks on one shared file, all three got everything right; Friday spent 51% more input and took 1.7 times as long as one session, and 17% less input than two sessions working at once, where the shared file collided in both runs and one session reported itself blocked with the work done.

## Unreleased — M10b, fewer tokens per call

- **The first message of a spawned attempt says it once:** a spawned Claude Code or Codex attempt is told which task to start and that its contract, acceptance criteria and scope are in its instructions, instead of being given the task's text a second time. Measured twice against the token baseline, every call of an attempt is 413 tokens smaller (`docs/measurements/2026-10-18-token-baseline-m10b.md`). When the packet cannot be compiled, the message still carries the task's text.
- **Measured:** of a spawned Claude Code call (about 16,350 tokens at the first call), Friday sends about 2,000; the rest is the host's own prompt, tools and per-session context.

## Unreleased — M8b, three further hosts

Cursor, Antigravity and Gemini CLI can work under Friday, each `experimental` until it is tried with a real login; nothing signs in on its own.

- **One hook launcher for every host:** `node hook.mjs <vendor> <event>` (Claude Code's form unchanged), a small module per host that reads its input and writes its reply, and one judgment for all; Friday's answer is deny, ask where the host honours it, context at session start, or nothing, never allow. The daemon's route is `/hooks/<vendor>/<event>`. A host's hooks and its `friday` MCP server make one session whichever reaches Friday first, and each session's level comes from its own hooks.
- **Cursor** (attach and spawn): `friday harness config cursor` writes fail-closed hooks for every tool, the `friday` server and an always-applied rule; `friday harness doctor cursor` checks them without starting Cursor; `friday harness run cursor` drives the Cursor CLI headless in a task's worktree, with Friday's hooks and its tools for spawned agents from a plugin folder. Cursor is `enforcing` on 3.24 or later (CLI 2026.10.16 or later).
- **Antigravity** (attach only): `friday harness config antigravity` writes Friday's hook group, the `friday` server and an `AGENTS.md` block; Friday answers deny or `force_ask`, never an approval. It is `unverified` until a run shows what a failing hook does.
- **Gemini CLI** (attach and spawn): `friday harness config gemini` writes Friday's hooks and the `friday` server into `.gemini/settings.json` and a `GEMINI.md` block; `friday harness run gemini` drives Gemini CLI headless with Friday's hooks, its own approvals off and the tools Friday cannot judge denied. It is `degraded`: a hook that fails lets the call through. Gemini CLI no longer serves consumer accounts, so a paid key is needed.
- **Protections for every host:** the folders where Gemini CLI and Antigravity read hook commands (`.gemini/`, `.agents/`) and programs named `node` or `git` at the project root are protected like Claude Code's settings; a shell call that runs inside, or changes into, `.friday`, `.git` or Friday's state folder is refused; Gemini CLI's `web_fetch` is judged by every URL it would fetch; a stop is held only when the agent ended its own turn, never after a human's abort; with Friday down, a session Friday spawned is refused at once.
- **The CLI and the Studio** list all four hosts: `friday harness hosts`, the start-agent dialog, the agent cards and `friday doctor`.

## Unreleased — M12, the optimizations

What already exists became cheaper to run or quicker to start; Friday's role does not change, and nothing here spends model tokens beyond the Master Brain's bounded calls.

- **Planning on your own machine:** `master_brain.provider: local` plans with a model your Ollama or LM Studio server runs, with no key, no remote consent and no budget, at a cost of $0.00, while every call's tokens are still recorded. The server must be at a loopback address (`providers.local.base_url`, default `http://127.0.0.1:11434/v1`); other addresses are refused when the configuration is read, and redirects are never followed. Friday sends the plan's JSON schema so the server's grammar enforces task keys and roles, falls back to JSON mode on a server that refuses a schema, and applies the same validation, repair attempt and approval as with Claude. `friday doctor` checks the server and the model, `friday brain status` names them and says the budget is none, and `friday models` lists the model as local. Checked live with `qwen2.5:7b` on a laptop processor: a valid plan in 1.7 minutes.
- **The ceiling on delegated work:** a task never holds more authority than what delegated it. A plan's task is held to the scope the project declares for its role: cut to what lies inside, with a note the reviewer sees, or refused when nothing fits, when the plan is proposed (the Master Brain's drafts are checked before the proposal) and again when it is approved. While a task runs, a write outside both its scope and its role's scope is refused by the hooks with the ceiling named, a permission request for it is refused at once instead of being put to you, and verification fails such a change whatever was approved.
- **The handoff summary:** an attempt that continues a task after a crash, a reassignment, a restart or a rework starts from a fixed summary built from Friday's records (goal and constraints, what was done, what was checked, what was decided, what is next, the files changed), at most 1,500 characters and never dropped by the packet budget; a resumed session gets it at SessionStart.
- **Two agent tools:** `friday_list_peers` tells an agent who works on its goal, and `friday_message_receipt` whether a message it sent was delivered, read or answered, per recipient; both read Friday's records. Friday's tools number 19, and `friday harness config claude-code` refreshes the skill (template version 5).
- **One command to start:** `friday start` makes the folder a Friday project when it is not one, starts Friday hidden when it is not running, and opens the Studio signed in, in three lines at most; `--desktop` opens the desktop app when it is installed, and `--no-open` prints the address. `pnpm pack:release` bundles Friday into `dist-release/friday-<version>.tgz` and checks it by installing it into a temporary folder and running `friday --version`, `friday setup` and `friday start` in a fresh repository; `npm install -g ./friday-<version>.tgz` installs Friday on a machine with Node and Git. `friday init` now points to `friday start`. The desktop app has a per-user installer, `Friday Desktop_0.1.0_x64-setup.exe`, which installs it into `%LOCALAPPDATA%\Friday Desktop` without administrator rights, apart from Friday's private state folder; `friday start --desktop` finds it there.
- **Context evals:** sixteen tasks written against Friday's own repository measure what the context compiler hands an agent, offline and without a model (`FRIDAY_TEST_BENCH=1`): 59% mean required-context recall at the claim budget with a declared read scope, every protected and out-of-scope file kept out, every delivered packet within budget, each miss named with its cause (`docs/measurements/2026-10-18-context-evals.md`). The set's own checks run in every full test run.
- **What Friday did for a goal:** the goal card shows one line, with each fact on its own row in its tooltip; the landing dialog lists them under "What Friday did", and `friday goal show` prints them: tasks verified, completion claims the checks refused and the rework that followed, actions held for you and actions the policy refused, sessions lost and recovered, the hosts' reported tokens and cost and from how many attempts, and Friday's own planning calls. A figure nobody reported is never shown as 0. `GET goals/:gid` carries them as `summary`.
- **Large repositories:** a context record too large for one event is cut to fit, with a note; a claim whose context cannot be delivered still answers with the task and the reason; a compile builds the handoff summary once, reads only the task's own approvals and questions, and reads the source identity once.

## Unreleased — M11, finishing the built milestones

What the built milestones had left open is closed; none of it spends model tokens.

- **Commands:** the judge reads `xargs` as the command it runs with its arguments, in every shell: `find … | xargs grep -l x` runs without a human, `find … | xargs rm -rf` is refused as `rm -rf` would be. In a POSIX shell a `case … esac` is judged by what its word and patterns substitute and by every branch's commands. A word that only passes a command on (`sudo`, `env`, `nohup`, `exec`) no longer hides a shell wrapper, and `env` alone is refused as `printenv` is. An `xargs` whose command is its input, and a wrapper run in the background, ask a human.
- **Configuration:** Friday reads `.friday/config.yaml` again whenever it changes and applies at once every setting it reads where it is used: scopes, autonomy and risk (what loosens still waits for `friday policy trust`), verification checks, conflict-prone files, recovery limits, routing, the agent messaging limits, and the Master Brain's model, effort, token limit and replan limits. The settings captured at start (project, daemon, leases, worktrees, providers, the Master Brain's provider) keep their start values, and the Studio's banner and `friday status` name exactly which changed key still needs a restart. Each read is recorded as a `config.reloaded` event.
- **Interface:** the Notch pill's waiting chip shows the rail through the same door as the header's count; opening Project memory from a "memories need review" row scrolls to that section, which says so when nothing needs review any more; a message awaiting your reply raises a notification as an approval does, under the same toggle and limit, and clicking it opens Messages at that delivery.
- **Codex usage:** the Codex adapter records what each run attempt cost from the app-server's token-usage notifications (the last count wins), with the model the thread reported and the turns the adapter ran; `friday usage` shows Codex attempts with their host fields. Each host's counters are kept as the host reports them.
- **A spending cap per task:** `routing.task_budget_usd` in `.friday/config.yaml`; unset means no cap. Friday passes the cap to the Claude Code sessions it starts (`--max-budget-usd`, the smaller of the agent's own cap and the task's) and, for every host, stops an attempt whose reported cost reaches the cap, once, recording the figures and asking you what to do next; the task waits for you and is never run again on its own. Finished work the session reports right after the stop is kept as a claim, not run again. `friday usage` shows the cap beside the cost of an attempt the cap stopped.

## Unreleased — M9k, the clearer interface

A product review of the interface as built judged each of its 204 surfaces on whether it earns its place on the screen ([the review](docs/reviews/2026-10-17-ui-product-clarity.md)); the owner took its recommended option on all six of its decisions. The first screen now holds what a person decides and watches daily, and what explains or tunes Friday is one click or one typed word away. Nothing is removed from the code: every surface that left the first screen is still reachable where the review's section 6 says, and a test opens it there. An adversarial review of the built result found 16 things, every one fixed with a test. The interface plan is at revision 3 ([PLAN.md](docs/frontend/PLAN.md) §7, FD-31 to FD-36), with ERRATA F41 to F44, ADR-0033 amended (still Proposed) and [lessons](docs/frontend/LESSONS.md) UI-97 to UI-112.

- **The first screen holds 20 fixed controls** (21 with the Notch pill in a browser), down from about 27, counted by a test over the rendered shell. A header of eight: the project's name (the folder path in its tooltip), the state dot (the address in its tooltip), Running (the status sentence in its tooltip: what runs, what waits for you and why, what is ready, to verify or failed, how many agents are connected), Waiting for you, Search, Messages, a More (…) menu with Project memory, Code graph and About, and the gear. A dock of four: New goal, Agents, Pause/Resume, Halt. The header's Memory, Code graph, Routing and Worktrees items and the dock's Search, gear and Mute left the screen: Memory and the Code graph are in the More menu and the palette, Routing in Settings → Routing, the worktrees count in Settings → Friday and About, Search and the gear in the header, Mute in Settings → Sound, the palette, the desktop Notch's footer and the tray.
- **One name per thing:** *Messages*, *Project memory*, the inspector's tabs *Overview · Changes · History · What the agent was given*, *Live stream: <key>*, *Allow for this task…*, one vocabulary for a grant's reach (*Once / For this attempt / For this task*, on the card, in the full view and in the toast), *Reply to <agent>* on every reply box, *Open Studio* and *Open this in Studio* on the desktop Notch. The agent pods and the Agents drawer say *Enforced*, *Reported*, *Watched* or *Unverified*, with the level in the tooltip; the level codes appear nowhere else.
- **The board:** the task card loses its branch row and opens its diff from the `+N −M` figure and a *Changes* hover action; the minimap appears only while a card lies outside the view; the zoom toolbar gains a *Finished goals* toggle and, after a card was dragged, *Tidy*; in a Studio narrower than 900 px the two toggles are icons. The live stream opens on Errors after a failure. The plan editor's JSON tools sit behind a *More* fold. The config-changed banner says how to restart from where you are (a Restart Friday button on the desktop; Open Settings in a browser).
- **Settings regrouped:** Notifications first, with its test button; Sound; Look and Notch, with the Notch timings under an Advanced fold; Planner; Routing is the pins' home, with the routing mode word; Policy; Friday holds Stop, Restart, Log out, "Worktrees in use: N" and *Clean up released worktrees*; Desktop app; About shows Friday's version, the interface's version and API, the project, the folder, the address and the worktrees in use. The palette's housekeeping commands (Prune, Reindex, Stop Friday, Reset moved cards) appear when typed, not in the empty list; Zoom in and Zoom out left the palette (the toolbar, the wheel and the keys zoom).
- **The Agents drawer** shows one list of agents, each row saying whether Friday started it or it attached in VS Code, connected or not, its process state, enforcement and model, with Stop, Start again, Forget and an Output fold as they apply; the installed hosts live in the Start dialog's Host field, with *Check again*, and in the drawer only when none is found; the dialog's host options sit under an Options fold. The routing question card keeps its Pin, with the line "Pins are kept in Settings → Routing."
- **The Notch in a browser** is its pill: the task tag opens the task, the file ticker the diff, the waiting chip the rail; it never opens a card. **The desktop Notch** keeps its card; its quick prompt is one goal line ("Describe a goal…", Enter, "Create a goal: …? Press Enter") with no command words, and the card shows a notice with a door for a proposed plan, a message awaiting your reply, memories to review and a policy change to trust.
- **Waiting for you is one list everywhere:** the header count, the title badge, the Notch chip, the desktop tray and the rail read the same list, which now includes proposed plans and three new kinds: a message awaiting your reply, memories needing review and a policy loosening not yet trusted. The three new rows open where they are decided: the Messages drawer at that message, Project memory at Needs review, Settings → Policy. Getting started gains "Get notified while this tab is hidden" and, when it applies, "Trust this project's policy".
- **The desktop tray's** tooltip and first menu item carry the status sentence, cut at 119 characters.
- **For anyone building on the API:** the board snapshot gains `memories_to_review` (a number) and `policy_untrusted` (a boolean, from the daemon's policy trust).

## Unreleased — M10a, the token baseline

The baseline was run twice on 2026-10-18 and recorded in `docs/measurements/2026-10-18-token-baseline.md`: both tasks verified on their first attempt in both runs; 75,005 input-side tokens per verified task (the two runs 1.9% apart), 4 API calls per task, 3.25 whole-file reads per task, about $0.01 notional per run. A call carries the whole context again, about 17,000 to 20,000 tokens, of which Friday's rules, packet, tools and first message are about 2,450; what the agents read is about 2% of the input side. The next change, M10b, removes a call per task.

Friday now joins what each run attempt cost with what it was given. `friday usage [--goal <id>] [--task <id>] [--json]` and `GET /usage` show, per attempt, the host's reported input and output tokens, cache reads and writes, cost, turns and model, the weight of the context packets delivered to it, its context requests by kind, its tool calls by kind (read, edit, shell, web, Friday; and whole-file against ranged reads) and the verification verdict. A host that reports nothing shows unknown values, never zeros, and the totals say how many attempts reported. This row is the yardstick every later change to context handling is measured against.

- **What counts for an attempt:** only what its own session did. A second live session of the same agent (a shadow, or one restarted during the reconnect grace) reads the same task and gets its own packet at its start; the hooks no longer record its tool calls against the attempt, and the row counts neither its packet nor its calls. The rules for a task worked on twice (a boundary packet goes to the earlier attempt, once; an attempt never shows another attempt's verdict) are tested.
- **Context requests:** Friday records a `context.requested` event when a request arrives, before the compiler answers or refuses it, so the row counts a refused request too.
- **Totals:** `host_reported` says how many attempts sent a usage report at all; `reporters` says how many each token total sums, since a host may leave a field out (an older report without the cache fields, an error result with a cost and no counts). The CLI prints "(from N of M)" next to a total whose reporters differ, and its legend says which "-" means the host did not report and which means nothing to show.
- **The Claude spawn adapter** keeps the host's usage report with the report of how the turn ended, so an outage at that moment loses neither.
- **The baseline run** (`tests/scenarios/token-baseline.live.test.ts`, gated by `FRIDAY_TOKEN_BASELINE`): two spawned Claude Code sessions do the gift-card goal of a hand-written plan (`tests/fixtures/baseline/giftcard-plan.json`) on a fresh fixture-shop copy, pinned to `claude-haiku-5-5`, each attempt capped at `--max-budget-usd 0.25` and the whole run by a turn budget; a dry mode starts the real Claude Code and refuses its first message, so no model is called; everything the run showed is saved outside the repository whatever happens, and the run passes only when every usage row is complete. `docs/measurements/README.md` says how to run it and how to read a row.

## Unreleased — M9, the user interface

Friday can be used from a browser for daily work: `friday ui` (or `friday ui --start` and `friday shortcut`, which start Friday when it is not running) opens the Studio signed in ([the plan](docs/frontend/PLAN.md)).

- **The Studio:** goals, tasks and agents on a canvas, with an inspector, the diff, the code graph, memory and a live terminal; approvals and questions in a Decisions tray beside it; plans written in the page or proposed by the Master Brain, approved on the board; verification, integration and landing; pause, resume and halt in the dock; the Notch at the top with Blip.
- **Starting agents:** Claude Code or Codex started from the Agents drawer, remembered as profiles that start again with Friday.
- **Sign-in:** a one-time link opened through a file in the private folder, so the code is on no command line; a session per tab, at most 12 hours; a page served under a path new at every start, never cached, so nothing an earlier program left on the address runs in it.
- **Daemon:** pause, resume and halt by effect; spawned agents continue in their run after a human decides; Friday's own questions act by kind and close when their cause is resolved; verification runs Friday's own checks when a project has none.
- **Tests:** `tests/ui-e2e` drives the real page in the installed Edge or Chrome against a real Friday (`FRIDAY_TEST_UI_E2E=1`), including a day in the life from `friday init` to a verified, integrated goal across a restart. What those runs found is fixed and recorded ([lessons](docs/frontend/LESSONS.md) UI-43 to UI-52).
- **The desktop app (Windows, `apps/desktop`):** a Tauri 2 shell that floats the Notch over the editor, keeps the Studio in its own window and a tray icon, starts Friday when it is not running, and forwards only an allowlist of routes from its pages, which hold no credential. Built per user with Rust's GNU toolchain ([steps](apps/desktop/README.md)).
- **Review of the interface** ([record](docs/reviews/2026-10-17-ui-interface-review.md)): 25 defects fixed, each with a test. Plans are approved in their review, where every task's instructions are shown in full. Hidden characters are marked the same way everywhere, and an escape never hides the text after it. Events are no longer lost when a snapshot read gets ahead of the stream. A decision made on the page is not undone by an older snapshot. The desktop app confirms every route that cancels, restarts or launches. A resume held through a long pause is still sent. On Windows, Friday never starts `git` or `explorer.exe` from the repository folder.
- **Fix:** a loose task a human reserved for a spawned agent (`friday task create --assign <agent> --ready`) was never started; Friday now starts it when that agent is free (LESSONS D-51).
- **Deep review of the interface** ([record](docs/reviews/2026-10-17-frontend-deep-review.md)): 13 findings and 12 problems found in their fixes, each fixed with a test (LESSONS UI-73 to UI-96):
  - **Goals:** a goal whose plan editor was closed, or created from the quick prompt, offers **Write the plan** on its card and in the palette; progress counts every task of the goal, also those finished days ago.
  - **The board:** a failed read is retried by itself; questions appear the moment they are asked; the stream never replays old history into sounds; each task card shows its tool calls, live.
  - **Dialogs and the diff:** "Open the diff" from verification, landing or an approval opens in front and goes back; a removed final newline shows as a change.
  - **Preferences** (sound, motion, outfit, node positions) survive a restart: Friday keeps them per project, and the desktop app shares them; notifications stay per browser address, where permission to notify belongs.
  - **The desktop app:** long verifications no longer time out after 15 minutes; the Notch's Settings, Routing and file links open the right place; the Planner's key and spending dialogs are in Settings; **Start Friday when I sign in**; **Send a test notification**, which says only what the app can know.

## Unreleased — the recorded live MVP demonstration

Part 12 §18 ran once with two real hosts: Claude Code 2.1.301 and Codex 0.162.1, both spawned, on one goal ([the record](docs/integration/mvp-demo.md#recorded-live-2026-10-16)). Two tasks ran in parallel worktrees; the shared contract's change reached only the backend agent; the Codex adapter was killed mid-turn and the same run resumed in the same Codex thread, with Friday's tools; a failed verification was reworked; both tasks were verified and integrated, and the goal completed. What it found is fixed, each with a regression that failed before the change (LESSONS D-49, D-50):

- **Fix:** `friday context explain <task>` compiled a new packet for the human asking, who may read more than the agent, and showed it as the task's context. It now explains the newest packet the task's agent was given; `--fresh` compiles a preview, labelled as compiled for a human.
- **Fix:** a Master Brain question about a failed task stayed open after the human reworked the task, and the goal completed with it pending. When a task is sent back for rework, completed or cancelled, Friday closes its open failure questions as no longer needed, and that answer starts no revision.

## Unreleased — the interactive Claude Code check

Claude Code 2.1.300 in the VS Code panel ran two tasks end to end, both verified COMPLETED. What it found is fixed, each with a regression that failed before the change ([the guide](docs/integration/claude-code.md), LESSONS D-41 to D-45):

- **Approvals:** the panel declines Friday's in-panel approval form without showing it, and Friday counted that as the human's refusal. Only a filled-in form counts now; a decline leaves the request pending for `friday approve`.
- **Verification:** a session working in the main checkout had no base commit, so what it committed during the task escaped the diff and secret checks. Its run now starts from the commit its checkout was at when it claimed.
- **Policy files:** a new or changed file in `.friday/policies/` applied only after a reload or a restart. Friday reads them again when they change; `config.yaml` still needs a restart.
- **Commands:**
  - bash loops over files, `command -v`, `[ … ]` and `read` are judged as reads, so they no longer ask;
  - **Fix:** commands in backticks (`` echo `rm -rf x` ``), `find -delete`, `find -exec`, and a leading `$x` in bash passed as reads. Each is judged as what it runs, by the shell the host names.
- **From the owner's hands-on tests:**
  - **Fix:** approving a request now resumes the task its agent set waiting for it, and an operation refused for a waiting task says why.
  - **Fix:** `friday plan propose --goal X` failed, and `plan approve --goal X` approved the newest goal's plan instead of X's.
  - **Delegation:** a task that names a role goes to a free agent of that role when there is one; experience decides among them.

## Unreleased — M8a.5, the M8 readiness review

A review of M8a found 7 gaps; each is closed, those that were defects with a regression that failed before the change ([disposition](docs/reviews/2026-10-15-m8-readiness-review-disposition.md)).

- **Commands:**
  - **Fix:** a value PowerShell only prints, written into a file (`'x' > f`, `$x > f`), passed as a read. A redirection into a file now needs a human's decision at every depth of a command.
  - **Fix:** a numbered stream (`2> f`) or a quoted target was never seen as a write.
- **Spawn adapters (Codex and Claude Code) keep serving Friday:**
  - **Fix:** one failed poll stopped every later instruction, cancellations included, while the heartbeat kept the harness looking healthy. The loop now keeps polling.
  - After a whole lease without hearing Friday, an adapter ends its hosts' work, and registers again once Friday answers.
  - A daemon started again on another port is found.
- **Fix: a start Friday no longer wants starts nothing.** Friday's answer to an acknowledgement now says which runs are current (`current`). A start cancelled, expired or reassigned before the answer ends the host prepared for it.
- **Fix: Claude Code's startup check can no longer lose to a quick result.** It decides when the report arrives; a report that leaves out what the session runs with is refused.
- **Fix: how an attempt ended is no longer lost.**
  - It is kept until Friday records it, on disk with `friday harness run`, and tried with one idempotency key.
  - A spawn adapter started again is told to resume its running tasks. Before, it was told only about tasks Friday had already judged lost.
- **Friday's tools in spawned sessions.** Codex and Claude Code sessions that Friday starts can now reach the agents whose work relates to theirs, answer them with facts, ask Friday for context and permissions, and have a declared operation run (`friday_communicate`, `friday_request_context`, `friday_request_permission`, `friday_run_operation`).
  - Codex gets them as client-served tools (experimental in 0.162.1).
  - Claude Code gets them from an MCP server the adapter serves, its only one.
  - Messages reaching a session say their id, so it can answer.
- **Live checks are gates.** A live check passes only when every behaviour it names was observed. A case it did not run fails as not run, and one that fails keeps the rest of the approved turns. Claude's live cases are selected with `FRIDAY_CLAUDE_LIVE_CASES` (`work`, `restart`).
- **The live MVP script** starts with a checklist that calls no model: the Codex sandbox, fixed models and spending, a hand-written plan, and what to record.

## Unreleased — M8a, a second host

- **M8a.1, one judgment for every host** (ADR-0032):
  - **New protocol method `tool.check`.** A spawn adapter asks Friday before its host runs a command or changes a file. It gets the same answer Claude Code's hooks get, from the same code. Where a human decides, Friday records one pending approval for exactly that action; once you approve it, the action goes through once.
  - **Commands are judged inside their shell wrapper** (`"C:\…\powershell.exe" -Command '…'`, `cmd /c`, `bash -lc`), every part of them. **Fix:** before, a redirect inside `bash -lc` counted as a read, and `printenv` inside it was not refused.
  - **Fix:** a request to run a command is judged as that command. Before, a recursive delete naming an absolute path could not be approved.
  - `task.resume` tells the adapter which host session to resume.
  - Hosts that speak over stdio run inside Friday's process groups.
- **M8a.2, Codex works for Friday** (`friday harness run codex --agent <key>`, guide: `docs/integration/codex.md`):
  - **Its own host.** Each task attempt gets its own Codex app-server, in the task's worktree, inside a Friday process group. Cancelling a task stops it and everything it started.
  - **Friday decides.** Every command and file change Codex asks about is decided by Friday's policy. Friday answers only accept or decline. What a human must decide waits for `friday approve`.
  - **Settings pinned on every thread:** Codex's approvals come to Friday, never to its own reviewer. The model Friday routed is used, and the model Codex reports is recorded.
  - **Messages** for the agent reach its running turn.
  - **Finishing.** A turn's end becomes a completion claim for verification, a blocked result, or an error.
  - **Doctor.** `friday harness doctor codex` checks the executable, its app-server and its sandbox, without calling a model.
  - Writes Codex makes without asking, and its own delegation, are reported, not hidden.
- **M8a.4, the MVP demonstration:** `tests/scenarios/mvp-demo.test.ts` runs the spec's MVP script end to end with Claude Code and Codex on one project. That covers the plan, parallel worktrees, each agent's context, a contract change routed only to the agent it concerns, tests, one harness killed and recovered, verification, integration and the verified goal. `docs/integration/mvp-demo.md` is the same script for a recorded run with real hosts.
- **M8a.3, Claude Code in spawn mode:** `friday harness run claude-code` lets Friday start your installed Claude Code (2.1.300 or newer) itself for the tasks it gives an agent. Each run attempt is one headless session in the task's worktree, ended with the attempt, on cancel, or when you stop the adapter. The session:
  - reads no settings files of yours or the repository's;
  - has only the tools Friday's hooks judge, and no MCP servers or skills.

  Friday decides every tool call: what a human decides waits for `friday approve`, and the session is told no until then. A restarted adapter resumes the same session. `--max-budget-usd` caps each attempt's spending.
- **Stopping Friday lets work in flight finish:** an integration or a task worktree job that is still running when the daemon stops now finishes first (within a minute), instead of being cut off with no record and leaving git working in your checkout.
- **The live Codex check:** Friday's Codex adapter ran against the real Codex in six turns the owner approved (`tests/scenarios/codex.live.test.ts`, results in `docs/integration/codex.md`). What it changed:
  - Friday's Codex threads no longer carry your own Codex tools (plugins, ChatGPT apps, MCP servers, web search), and a repository's own Codex configuration no longer applies in them; nothing is written to your Codex configuration.
  - A run's first turn starts only once Friday knows the run started. An error before that frees the task instead of leaving it stuck.
  - Context for a host without Friday's tools no longer names them.
  - Friday's command policy judges what PowerShell blocks run, so Codex's reads on Windows pass and the writes inside them do not.
  - `friday harness doctor codex` starts a command in Codex's sandbox to see whether it works. `friday harness run codex` takes `--windows-sandbox` and `--service-tier`.
- **The live Claude spawn check:** Friday ran your installed Claude Code (2.1.300) in three turns the owner approved (`tests/scenarios/claude-spawn.live.test.ts`, results in `docs/integration/claude-code.md`). The third turn ran a task end to end, for $0.006: Friday judged every tool call, a message reached the running turn, and verification completed the task. What it changed:
  - **Fix:** Claude Code adds a tool, `StructuredOutput`, for the final answer. Friday ended every session that reported it; it now expects that tool and allows it.
  - Friday now also checks the plugins and skills a session reports. Claude Code's own built-in plugins are accepted; any other plugin, or any skill, ends the attempt before a tool runs.
  - Friday's rules for spawned sessions, Claude Code's and Codex's, now say to change files with the file tools, not shell commands. They also say a refused call is Friday's decision: the agent should not get the same effect another way.
  - The guide says where Claude Code keeps each session's transcript (`~/.claude/projects`, one folder per worktree).

## Unreleased — M7.1e, the follow-up review of M7.1

A follow-up review of M7.1 found 7 more gaps in authority and continuation. Each is fixed, with a regression that failed before the change ([disposition](docs/reviews/2026-10-15-m7-1-review-disposition.md)).

- **Context:**
  - A packet is delivered only under the authority it was compiled under: the policy, the agent's read grants, and its task and attempt. If any of them changes meanwhile, the packet is compiled again; after three changes the request is refused (`COS-5000`) instead of answered with a stale packet.
  - A file shown only because of your exact-path approval now spends it: a one-use approval opens one packet.
  - History lists only commits that change a file the agent may read.
- **Verification** checks its authority as the very last step before the verdict, so a policy tightened during its final reads of the checkout interrupts it.
- **Integration:**
  - `friday integrate <task>` retries a failed integration from the same verified commit, including after Friday committed the work and stopped before recording the integration.
  - **New:** `friday integrate <task> --repaired` integrates your repair of a conflict on the task branch, after the checks pass on what would land.
- **Restore:**
  - **New:** `friday recover <task> --action rebind` brings finished work from a lost clone into this one and keeps the task's state: a claim waiting to be verified, a verification the backup caught midway, or verified work waiting to be integrated. A claim comes only with the work it lists.
  - `friday restore` checks the backup's database (its hash, then a copy's integrity, project, event head and schema) before it changes anything; a damaged or swapped database is refused.
- No migration.

## Unreleased — M7.1 cross-milestone stabilization

The M7 review looked at the joints between milestones and found 17 gaps; each is fixed or decided, with a regression that failed before the change ([disposition](docs/reviews/2026-10-14-m7-review-disposition.md)).

- **Verified means verified:**
  - Integration commits exactly the git tree a verification judged, never what is in the folder by then, and a merge whose checks change its checkout fails.
  - Evidence Friday cannot read (an unreadable checkout, an unknown base, a failed read after the checks) interrupts a verification instead of passing it.
  - Verification applies the project's deny rules and team scopes as the hooks do, honours a human's exact-path approval, records the policy version, and is interrupted by a policy change. **Breaking:** a verification recorded before M7.1 has no tree; verify such a task again before it is integrated.
- **Operations obey their authority and their lifetime:** an operation starts only if its task, attempt, session, approval, policy, definition and role still hold when it starts; cancelling, releasing or recovering the task stops it and every process it started (a job object on Windows, a process group elsewhere), confirmed before the worktree is reused.
- **Clones and backups:**
  - A restored clone works only in its own checkouts and asks you about work that was in another clone.
  - `friday backup` now also holds the code of Friday's work: its branches, preserved attempts and the uncommitted work of task worktrees (`code.bundle`, format 2). `friday restore` adds it to the clone without moving any of its refs back, and `friday recover <task> --action reassign` brings a task's work into a worktree there. Without the code, Friday says what is missing instead of starting over silently. See [docs/runbooks/backup.md](docs/runbooks/backup.md).
- **Routing:**
  - A route that forbids the work starts nothing (`COS-7003 routing_blocked`), is recorded once, and asks you once; a host reporting a model its constraints exclude has its attempt ended.
  - **Breaking:** secret-sensitive work runs only on a local model you pinned for it with `--sensitive`; a general pin no longer counts.
  - Laya is reached only at a literal loopback address, never through a redirect, within one deadline for its whole answer, and its answers are validated. Delegation waits for a task's open Laya question, bounded by its deadline.
  - `friday models` separates measured results (a model seen running) from assumed ones, and compares results under the same checks and host version.
- **Context:** packets apply the same read policy as the hooks and are compiled again when it changes; the size you ask for is the size of the packet delivered, or the answer says what it needs (`COS-5002`); requests for files, scope, history and decisions are honoured.
- **Memory** keeps case: correcting `UserID` to `userId` is a new fact, not a duplicate.
- **Fix:** a command or check argument naming a folder next to Friday's state folder whose name starts the same way was refused as private.
- Migrations v19, v20 and v21.

## Unreleased — M7 model routing

- **Every run is routed to a model, and the reason is recorded:** your pins first (`friday routing pin` for a task, role, kind or the project, with an expiry), then hard constraints (local only, sensitive work, vision, what the harness can run), then how well each model fits what the task needs, its verified track record once it has enough results, cost and speed by `routing.optimize`, and the guide's preferences. See [docs/routing.md](docs/routing.md).
- **Control or advice:** a harness that applies models (`model_control: set`) gets the model in `task.start`; an attached Claude Code session gets it as a suggestion when it claims the task. The model that actually ran is recorded (adapters report it; Claude Code at session start).
- **Evidence:** each verification result counts for the model that ran, per kind of task. `friday models` shows the registry and the track records; `friday routing explain <task>` shows each decision with its candidates, constraints and fallbacks.
- **Delegation** prefers the agent whose harness can run the better model for the task, at its cost.
- **Laya** (optional, on this machine): asked when a task becomes ready; its choice counts only after `friday laya calibrate` fitted a threshold for its checkpoint, and routing goes on without it when it does not answer.
- Decision: ADR-0031.

## Unreleased — M6 security

- **M6a, permissions that mean one thing:**
  - Agents ask for **capabilities** from one catalogue (`file.write`, `shell.git.push`, `network.read`, `secret.resolve`, …), each with a risk tier you can change (`risk:` in `.friday/config.yaml`).
  - **Requests are judged first.** What the task's scope and the autonomy settings allow is answered at once ("no approval needed"); what is never allowed, such as handing a raw secret to an agent, is refused at once; only real decisions wait for you.
  - **An approval is bound** to the task, the agent's attempt, the exact target and the policy in force. By default it covers **one** use; approve with `--for run` or `--for task` to let it reach further, and `--ttl` to set how long it lasts. A changed policy retires older approvals. Every use is recorded, and `friday approvals revoke <id>` stops later ones.
  - `friday approvals` shows the risk, the task, the reach and the uses. The status page can approve once or reject.
  - Decision: ADR-0027.
- **M6b, the project's own policy, behind a trust boundary:**
  - **Fix:** settings in the tracked `config.yaml` that widen what agents may do (such as `autonomy: { git.push: auto }`, a lower `security.enforcement_required`, `reservations.mode: off`, `master_brain.auto_approve`) were applied as written. A cloned repository could loosen Friday's rules on your machine.
  - Now anything tracked files **loosen waits for your trust** on this clone: `friday policy trust` shows exactly what, `--yes` applies it, and a later change needs trust again. Anything they **restrict applies at once**.
  - **Policy files** in `.friday/policies/*.yaml`: autonomy, risk tiers, **deny rules** (paths no agent changes or reads without a human approving that path) and **team scopes** (the only paths agents of a role may change). See [docs/policy.md](docs/policy.md).
  - `friday policy show`, `friday policy trust`, `friday policy validate`. A file that does not parse applies nothing and is reported.
  - Approvals granted under a policy stop counting when it changes.
  - Decision: ADR-0028.
- **M6c, secrets used without being handed out:**
  - **Operations:** a project declares, under `operations:` in `.friday/config.yaml` or a policy file, the work that needs a secret: a fixed command, its variables, and the stored secrets it needs by name (`credentials: { STRIPE_SECRET_KEY: stripe-test }`). An agent runs one with `friday_run_operation`; Friday runs it with the secret and returns the outcome and the end of the output with the secret removed, in plain form and in common encodings. An agent that asks for the secret itself is refused and pointed at the operation.
  - An operation is loosening: it applies only after `friday policy trust`, and again after any change to it. One that uses a secret needs your approval for each run by default; the request shows what the task changed since it started.
  - **Secrets are encrypted with DPAPI** for your Windows user (`friday secrets set`); elsewhere they stay in a file only you can read. `friday secrets list` shows how each is kept.
  - **Checks run in the execution profile:** a binary from a short list (`node`, `npm`, `pnpm`, `git`, `python`, …), never one inside the project; a minimal environment instead of yours; a time limit for the whole process tree. A check may declare its own `env`; `execution.binaries` and `execution.env_passthrough` add more, after trust. **Breaking:** a check that relied on a variable of your environment, or on a binary off the list, now fails with the reason until you declare it.
  - **Automatic verification:** `verification.auto_on_completion: true` verifies a completion claim at once, after trust (it runs agent-written code without you).
  - `friday operations`, `friday operations runs`, `friday operations show <run>`.
  - **Fix:** the memory search index named a column the memory table does not have; searches worked, but rebuilding or reading the index failed (migration v16).
  - Decision: ADR-0029.
- **M6d, other MCP servers' tools, approvals in Claude Code, the security suite:**
  - **Fix:** tools of other MCP servers (`mcp__<server>__<tool>`) were not seen by Friday's hook, so a filesystem or shell MCP server could reach Friday's files or rewrite `.claude/settings.json`. Now every MCP tool passes the hook: one given a protected location is denied even with the daemon down, and the project sets a level per server (`mcp: servers:`; `review` by default, `auto` after trust, `manual`, `never`). Run `friday harness config claude-code` again to install the new matcher; `friday harness doctor` reports the old one.
  - **Approve in Claude Code:** for a low- or medium-risk request, Friday asks you in Claude Code's own dialog when it offers one; your answer covers one use. High-risk requests stay on `friday approve` and the status page. `approvals.elicitation: false` turns the dialog off.
  - The capability `mcp.call` asks for a tool the project set to `manual`.
  - **The security suite:** every security case of the spec (Part 11 §14) has an end-to-end test that checks the forbidden effect did not happen; `docs/security/model.md` maps each case to its test.
  - Decision: ADR-0030.

## Unreleased — M5 verification, recovery, worktrees

- **M5a, one checkout per task:**
  - A spawn-mode run gets its **own git worktree** on its own branch `friday/<task_id>`, in a per-user folder beside Friday's state (`%LOCALAPPDATA%\friday-worktrees` on Windows). The run's `task.start` names it as the working directory. Agents working in parallel no longer share one checkout, and the main checkout's `git status` stays clean.
  - The worktree is prepared before the task starts. A crash during preparation is retried; an existing worktree and branch are reused, never created twice; a failure returns the task to READY with the reason.
  - **Sessions you start yourself:** `friday task worktree <task>` prepares the task's worktree and says where to open it. A Claude Code session started there is recorded in that checkout, can claim only that task, and can write only there. Friday's runtime files in the main checkout stay protected from it.
  - Context packets, the code graph and the single-live-writer rule work per checkout: one live writer per worktree.
  - When a task ends, its worktree is **released**, or **preserved** when it holds uncommitted work. `friday worktrees` lists them with their changes; `friday worktrees prune` removes released, clean ones and keeps their branches.
  - `worktrees.mode: off` in `.friday/config.yaml` keeps every run in the main checkout.
  - **Fixes:** the patterns that protect Friday's private folder also matched `friday-worktrees`; the MCP server reported the main checkout as every session's folder; a file whose only difference was a line-ending conversion (common on Windows with `core.autocrlf=true`) counted as an uncommitted change; a NUL byte in `packages/git/src/root.ts` made git treat it as binary. The portability check now refuses NUL bytes in text files.
  - Decision: ADR-0023.
- **M5b, verification that says what it verified:**
  - `friday verify` runs the checks in the checkout the task worked in (its worktree, or the main checkout) and records exactly what it judged: the checkout, its commit, a hash of any uncommitted changes, the commit the work started from, and the task's kind. If the code changes while the checks run, the result is thrown away and the task waits to be verified again.
  - **Friday's own checks run first and run no project code.** `friday.diff` fails changes outside the task's write scope or to Friday's protected files, and warns when the completion claim and the actual changes disagree. In the shared main checkout it judges only the changes the session was seen making or claimed, and lists the rest. `friday.secrets` fails credentials in well-known formats written into changed files, naming file and line, never the value.
  - **Checks by task kind:** `task_kinds` limits a check to some kinds of tasks; `required: false` makes it advisory.
  - **Related tests first:** with `targeted_args` (where `{files}` stands for the test files), a check first runs the tests the code graph relates to the change, and skips the full run when they fail. Changed files that no test covers are listed.
  - A verification cut short by a daemon restart no longer leaves the task stuck in VERIFYING: it returns to READY_FOR_VERIFICATION.
  - `friday verify` and `friday task inspect` show the verified code and every finding.
  - Decision: ADR-0024.
- **M5c, conflict-prone files and goal branches:**
  - **File reservations.** Files listed in `reservations.required` (lockfiles, migrations, shared contracts) are changed by one task at a time. The first write through Friday's hooks reserves them for its task; a write from another task is refused, naming the holder, and recorded as an ownership conflict. Runs without hooks are checked the same way when they are verified. A reservation ends when its task's work is integrated or the task is cancelled, and expires when the task stands still for 30 minutes (`reservations.ttl_ms`). `friday reserve <pattern> --task <task>`, `friday reservations`, `friday reservations release <id>`.
  - **Goal branches.** Each goal gets a branch `friday/goal-<goal>`. When one of its tasks completes, Friday commits the verified work on the task branch (in the agent's name, never yours), then brings it into the goal branch: a fast-forward when the branch has not moved, otherwise a merge that is verified again in Friday's own checkout before the branch moves. A conflict or a failing merged revision leaves the goal branch as it was and asks you. Your main checkout and your own branches are never touched; you land the goal branch yourself (`git merge friday/goal-<goal>`).
  - **Dependencies see integrated work.** A task that depends on others starts only once their work is in the goal branch, and its worktree starts from it.
  - **A goal completes** only when the work of all its tasks is integrated.
  - `friday integrations [--goal <goal>]` lists every attempt; `friday integrate <task>` tries again after you resolved a problem.
  - Fix: an attach session started in a task worktree now records the worktree's base commit, so verification sees what it committed.
  - Decision: ADR-0025.
- **M5d, recovering lost and failed attempts:**
  - `friday recover <task>` shows what Friday knows about a task's last attempt: the session (status, last heartbeat, whether its process still runs on this machine, how long it may still come back), the last activity, the worktree's commits and uncommitted files, agent errors and preserved states, with the options and a recommendation.
  - **Nothing is lost.** Before an attempt is reassigned or restarted, the worktree's full state, untracked files included, is kept under `refs/friday/preserved/<task>/attempt-<n>`, without changing the worktree.
  - **Reassign** gives the task to the next agent in the same worktree and branch, so it continues from the work left there; no second branch is made. **Restart** first puts the worktree back at its last commit. Also `needs-human` and `cancel`.
  - **The old attempt is fenced:** its run ends, nothing more is delivered to it, its late results are refused, and Friday's hooks refuse writes into the task's worktree from any session that does not hold the task.
  - **Automatic, with limits:** when a lost session's reconnect window passes, or an attempt ends in a fatal agent error, Friday reassigns the task, up to `recovery.max_retries` (2) more attempts and as long as the same error does not keep repeating (`recovery.max_same_error_retries`, 1). Then, or when the old process still runs on this machine, it asks you once.
  - Runbook: [docs/runbooks/recovery.md](docs/runbooks/recovery.md). Decision: ADR-0026.

## Unreleased — M4 context engine

- **M4a, the code as it is in each checkout:**
  - `@friday/git` reads one execution root (the main checkout now, a task worktree from M5): status, branch and upstream, worktrees, log and line counts.
  - The **dirty-content identity** names "the code as it is here": the HEAD commit plus a hash of the content of every uncommitted change. An edit changes it, a timestamp alone does not, and undoing the edit restores it. Context caching (M4d) and verification (M5) build on it.
  - Friday never takes git's index lock while reading. **Fix:** the context Friday gives a session at start used plain `git status`, which could rewrite the index while an agent was committing.
  - Decision: ADR-0019.
- **M4b, the code graph:**
  - `@friday/code-graph` parses TypeScript and JavaScript with tree-sitter (WebAssembly, no native build), and links every file to what it imports. Each link is labelled **exact** (a relative path that exists), **inferred** (a workspace package's entry), or **unsupported**: aliases, package subpaths, computed `import()`/`require()` and missing files are reported, never guessed.
  - It knows each file's consumers, its tests, its area (the nearest package), and the **shared contracts** that other areas depend on.
  - Parse results are cached by file content in `.friday/graph/`, so an edit re-parses one file, and worktrees share the cache. Friday's own repository (218 files) builds in under a second.
  - `friday graph` (summary, contracts, what is not resolved), `friday graph query <file> [--depth n]`, `friday graph reindex`.
  - Decision: ADR-0020.
- **M4c, project memory:**
  - Decisions, conventions, constraints and lessons are recorded with their scope (project, team, agent, task, session), who recorded them and how much they count: a human's are human-approved, the Master Brain's and agents' are unverified.
  - A newer memory on the same subject supersedes an older one only when it has more authority (or the same author updates it); the old one is kept, marked superseded. **A human-approved decision is never replaced automatically**: a contradicting memory waits for review. A task's memory never changes project memory.
  - Agents write only their own task, agent and session memory.
  - Search ranks by text relevance, authority, verification, recency and reuse; approved decisions do not fade, guesses do.
  - `friday memory add|search|review|show|approve|supersede|retract`.
  - Decision: ADR-0021.
- **M4d, context that explains itself:**
  - `@friday/context` replaces the M1 context stub. Every packet is compiled in the order of the spec: permissions first, then the task, the code as it is now (including uncommitted work), the files related through the code graph (consumers, tests, shared contracts), memory, and waiting messages.
  - Sources are ranked by authority (git state and the task first, human decisions before guesses). The budget never cuts identity, the task contract, scope, the human's requirements or the protocol reminder.
  - Files the task may not read are never gathered and never named.
  - Packets are cached by what they depend on: an uncommitted edit, a new memory or a status change gives a new packet; a tool completion does not. A stored packet says when it is stale and why.
  - **`friday context explain <task|ctx>`** lists every file with its reason and rule, what the budget cut, how many sources permission withheld, memory conflicts and what was not resolved.
  - Agents can **remember and recall** through Friday: `friday_remember`, `friday_recall` (MCP) and `memory.record`, `memory.search` (protocol), within their own scopes.
  - Decision: ADR-0022.

## Unreleased — M3.5 second-harness spike (Codex app-server)

- **Codex app-server 0.162.1, tried for real** (8 short turns on the owner's ChatGPT plan, approved): it registers, takes Friday's context and tasks, asks for approval before commands and file writes (and respects a refusal), resumes after its process dies, and reports its model and any reroute. Report: [docs/integration/codex-spike.md](docs/integration/codex-spike.md).
- **Cancelling a turn does not stop the command Codex started**, and Codex does not report its process id, so the M8 adapter ends the process tree itself.
- **Conformance is vendor-neutral and checks behaviour:** adapters implement `ConformanceHarness`; the cancel case now proves the work stopped, and a self-check shows a host that ignores cancellation fails it.
- Recorded protocol catalogue and sanitized transcripts in `tests/fixtures/codex/v0.162.1/`; spike scripts in `scripts/spikes/codex/`.

## Unreleased — M3.1 stabilization (M3 review 2026-10-14)

An independent review of M3 found nine gaps (R01–R09). All were confirmed: R01–R06 by failing regressions written before the fixes, R07–R09 by source review and measurement ([disposition](docs/reviews/2026-10-14-m3-review-disposition.md), plan H.8).

- **One rule for every address (R01):** an agent reaches a role only within related work, and a delayed delivery goes to a related task, not to any agent of that role. Humans still reach any agent of a role.
- **Only an authorized reply settles a request (R02):** `response_to` is accepted only on responses, by the protocol and by the service.
- **Only the receiving session acknowledges (R03):** shadow sessions are refused, and a delivery must be read before it is acknowledged. A restarted session receives what its predecessor left, at once.
- **Crash-safe escalation (R04):** an escalation commits with its marker, and an answer with its reply. Answers recorded without a reply by older builds are sent.
- **Answered questions stop asking (R05):** the other recipients' deliveries become `resolved`. Those who had read the question get a short "Resolved:" note from Friday, and the Stop hook no longer holds a session for it.
- **Relocatable snapshots (R06):** snapshots are JSON Lines files recorded relative to the artifacts folder, so a moved or restored project still finds them.
- **A verified backup (R07):**
  - built in a staging folder and renamed when complete;
  - credentials removed;
  - a manifest read from the copy, with every artifact's sha256;
  - links not followed, and missing artifacts reported.
- **Restore and restart (R08):** `friday restore --from <dir>` checks the backup, sets the current state aside and puts the backup in. At the next start, sessions register again and get one lease to come back. An interrupted model call needs this clone's approval before it is retried. Replay output is an inspection copy Friday refuses to run on.
- **Maintenance no longer holds the daemon (R09):** reads use a second connection, copies use SQLite's online backup in steps, and rebuilds run in batches. On 160,001 events the longest stall fell from 5.5 s to 187 ms. A paused or sleeping machine no longer marks every session lost.
- **Portability:** `pnpm check:portability:local` also checks untracked files before they are staged.

## Unreleased — M3 communication authority, replay and backup

- **M3a, messages through Friday:**
  - Agents send with `friday_communicate`: to an agent, `role:<role>` (Friday picks a related agent with that role), `task:<id>`, `dependencies`, `dependents`, `master` or `human`.
  - Friday routes only between related work and refuses the rest.
  - Every message has one delivery per recipient, read with `friday_check_inbox` (reserved for the session, delivered again if not acknowledged, dead-lettered after five tries) and acknowledged with `friday_acknowledge`, only by its own recipient.
  - A request settles when it is answered, and the answer shares its correlation id.
  - Inbox items say who sent them, how their work relates to yours and how far to trust them; no message ever grants authority.
  - Humans use `friday say`, `friday inbox human|master|<agent>` and `friday messages`.
  - The Master Brain reads what is addressed to it and uses the reported facts when it revises a plan.
  - Decision: ADR-0017; guide: [docs/messaging.md](docs/messaging.md).
- **M3b, delivery under failure:**
  - Messages expire visibly after 24 hours.
  - An unanswered blocking request reaches a human at its deadline, and the human's answer becomes the reply.
  - A full inbox refuses low-value notifications (`COS-2005`) but never requests or urgent messages; senders learn when a recipient is not attached.
  - Claude Code sessions are held at their next stop while urgent messages are unread.
  - The Master Brain's place in the event log is a durable consumer (`event_consumers`).
- **M3c, snapshots, replay and backup:**
  - `friday events snapshot` captures the domain tables with an integrity hash.
  - `friday events replay --into <dir> [--snapshot <id>]` rebuilds everything in an isolated copy (no credentials, nothing sent or started) and says whether it equals the live state.
  - `friday backup --into <dir>` makes a consistent copy of the database and artifacts with a manifest.
  - Corrupt, interrupted, foreign and old snapshots are refused.
  - Decision: ADR-0018; runbook: [docs/runbooks/backup.md](docs/runbooks/backup.md).
- **Gate:** the M3 scenario on fixture-shop (Part 12 §3/§4: role routing, minimal recipient context, correlated answers with facts, an unrelated agent refused; replay equals live).

## Unreleased — M2.5 stabilization (review 2026-10-14)

An independent review found twelve gaps in M1 and M2. All were confirmed in the source and handled ([disposition](docs/reviews/2026-10-14-review-disposition.md), plan H.6).

- **Links and junctions:** policy checks the path a tool names and its real target, so a junction inside a scope no longer reaches other scopes, Friday's runtime files or private state. This holds with the daemon down too.
- **Private folders are verified:**
  - Windows ACLs are read and repaired so only you, SYSTEM and Administrators can open Friday's tokens and keys; POSIX folders need the owner and modes 0700/0600.
  - Friday refuses to write secrets elsewhere.
  - `friday doctor` reports verified access.
- **Planning sends less, and only where you chose:**
  - Context comes from real paths inside the project, skips protected files, is bounded and redacted, and is marked as untrusted source material.
  - Remote planning needs your approval per clone (`friday brain allow-remote [--budget]`, `deny-remote`).
  - The key's endpoint is yours to set (`friday secrets set <name> --base-url`); `base_url` in `config.yaml` is ignored.
- **Honest costs:**
  - Refused or cut-off answers are recorded with their cost; unknown costs are null with a worst-case estimate.
  - Models without a price are not called.
  - The budget is checked before every attempt, including the repair.
- **A Master Brain that survives restarts:**
  - Work is a durable job written with the cursor, and coordination is derived from state.
  - Model calls run in their own lane, so a slow model never stalls delegation.
  - Interrupted calls are recorded and retried, and failing actions are retried, then escalated.
  - A second failure while a revision waits is kept, and a rejected revision with failed tasks asks you how to continue.
- **Fresh approvals:** approving a revision re-checks it against the live plan and tasks; a stale one is refused with `COS-2008` and nothing changes.
- **Your requirements stay yours:** the planner's additions are stored apart. Your constraints and outcomes go into every planning call and every agent's context.
- **Reservations end:** reservations made by delegation or rework expire (15 minutes) or end with their agent's session; `friday task unreserve` releases any reservation.
- **Enforcement from evidence:**
  - A Claude Code session is L1 only after its hooks reach Friday, and is `enforcing`, `degraded` or `unverified` by host version.
  - `security.enforcement_required` and `require_enforcing_hooks` are enforced (`COS-3007`).
  - `friday_whoami` says what the session really has.
- **Smaller fixes:**
  - verification checks no longer inherit API keys or tokens;
  - `friday_acknowledge` says honestly that messaging arrives in M3.
- **Decisions:** ADR-0014 (execution root and worktree location, for M4 and M5), ADR-0015 and ADR-0016. The plan's M3–M8 sections are rewritten with checkpoints, a snapshot contract, revision-bound verification, a second-harness spike (M3.5) and an M8 split.
- **Tests:** 378 across 16 packages.

## Unreleased — M2 Master Brain

- **Goals and plans:** `friday goal create` turns a request into a goal and the Master Brain proposes plan v1. Each task has acceptance criteria, a write scope, a role and dependencies. You approve or reject each version (`friday plan approve|reject`), compare versions (`friday plan diff`), or write the plan yourself (`friday plan propose --file`).
- **Approval** creates the tasks in one transaction. Tasks without open dependencies become READY; dependents start when their prerequisites complete.
- **Delegation** is a deterministic score (role fit, context, record, locality). Spawn-mode agents get the task directly; Claude Code sessions get a reservation. Tasks that would overlap running writes wait.
- **Revisions and questions:** a failed verification produces a revision that reworks, drops or adds tasks. The Master Brain asks a human instead of guessing: on ambiguous intent, on repeated failures, at the revision limit, when no planner is available, after an invalid plan, and over budget. Each question carries the six fields of Part 03 §11.
- **Claude as the planner:** the Anthropic Messages API with structured outputs and a cached project context; `claude-opus-5-5` by default.
  - Planning happens only with `providers.anthropic.allow_remote: true` and a key from `friday secrets set anthropic`, stored per user outside every repository.
  - A daily budget applies, and every call is a `model.called` event with tokens and cost.
  - `provider: fake` replays scripted answers; `provider: none` means humans write plans.
- **More:**
  - the CLI commands `goals`, `goal show|replan|cancel`, `brain status|run-once|calls` and `secrets set|list|remove`;
  - goals and questions on the status page;
  - the goal, rework notes and human decisions in each agent's context;
  - read-only review and research tasks.
- **Tests:** 343 across 16 packages. They cover the planner core, the Master Brain against a real database (including replay), the API and CLI with two parallel agents, the Anthropic provider against a local stand-in, and the M2 gate on fixture-shop with a real `friday run`.

## M1 event spine, daemon, CLI and Claude Code attach

- **Core spine:** protocol schemas with generated JSON Schema and a drift test; the task state machine (Part 14 plus `HARNESS_LOST`, release and wait transitions); an append-only SQLite event store with per-project sequences, redaction and replay; a command bus whose projector is the only writer of domain tables.
- **Daemon (`friday run`):** one per project on `127.0.0.1`, discovery and tokens in the per-user private directory, three token classes, Host and Origin checks, payload limits, leases and reconnect, a durable outbox with poll and SSE delivery, and a read-only status page at `/ui`.
- **CLI (`friday`):** `setup`, `init`, `run`, `status`, `doctor`, `tasks`, `task create|inspect|ready|assign|release|cancel|rework`, `verify`, `harnesses`, `agents`, `events tail`, `approvals`, `escalations`, `token rotate`, `ui`, `daemon stop`, `harness config|doctor claude-code`, and `fixture init`.
- **Policy:** sensitive path classes decided locally by the hook launcher (so they hold with the daemon down), task write scopes, the single-live-writer rule, shell command classes with an autonomy table, and network review.
- **Verification:** `friday verify` runs the project's checks; a completion claim never completes a task by itself.
- **`friday-mcp`:** 14 tools (5 always loaded), resources, prompts and server instructions; it registers as a harness and links to the session's hooks.
- **Claude Code attach:** `friday harness config claude-code` writes the hook launcher, the MCP entry, the hooks, the `friday` skill and an optional `CLAUDE.md` block, with nothing secret or machine-specific in them. Re-runs are idempotent, `--remove` is exact, and `--scope local` and `--print` are supported. `friday harness doctor claude-code` reports the enforcement level reached, including Claude Code folder trust.
- **fixture-shop:** a small demo repository with a byte-identical history on every OS.
- **Tests:** 281 across 15 packages, including conformance, hook contract tests from recorded Claude Code payloads, the bundled launcher end to end, tool coverage, secret scans, worktree discovery, and the M1 demo as a deterministic scenario.
- **Verified live** with Claude Code 2.1.296 (headless): claim, scoped edits, policy denials, verification, COMPLETED.

## M0 skeleton

- Monorepo with pnpm 12 workspaces, Turbo, TypeScript 5.9 project references, Vitest 5 projects and Biome.
- Package skeletons for every M1 package: protocol, core, db, events, state, sdk, policy, verification, mcp-server, generic and Claude Code adapters, daemon, CLI.
- Test helpers in `@friday/test-support`: short temp workspaces with Windows-safe cleanup (including SQLite WAL files), process-tree killing, a fake clock, and deterministic git.
- `.friday/.gitignore` template with a test proving runtime files are ignored and config, policies and harness files stay trackable.
- Claude Code spike against 2.1.296: hook fail-closed behaviour, session linking, tool names and subagent hooks verified; 21 scrubbed hook fixtures recorded.
- CI on Windows and Linux (Node 22 and 24; Node 26 non-blocking), a cache-free install job, and a portability job.
- Documentation: the 16-part specification, errata, ADR-0001 to ADR-0012, security model skeleton, spike results, the plan review, and the build plan.
