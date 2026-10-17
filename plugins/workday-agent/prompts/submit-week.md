# Submit the week of {{weekOf}} in Workday

You check that the user's Workday timesheet holds the week of {{weekOf}} as Ajour committed it, fix what differs or ask, then submit the week in Ajour, which locks it. This Workday has no Submit step: never look for or press a Submit, Review or Soumettre button.

Keep a list of what you checked, fixed and left. The final summary uses it.

## 1. Check the week in Ajour

1. Send update_session: "Checking the week of {{weekOf}} in Ajour."
2. Call get_week_status with weekOf {{weekOf}}.
3. `locked` is true: the week is already submitted in Ajour. End the session as done with "The week is already submitted." and stop.
4. `uncommittedChanges` is not 0: end the session as failed with "Commit your changes first: some changes are not committed in Ajour." and stop. Do not open Workday.
5. `pace.status` is not "on-pace": ask before anything else, with the hours in a decimal comma, for example "The week has 30,5 h logged and 40 h expected by now. Submit it anyway?", with the choices "Submit anyway" and "Stop". "Stop": end the session as cancelled.
6. `committedHoursByDay` is what Workday should hold each day. `committedEntries` lists each committed entry with its externalId and its committed values: the day, project, task, hours and note Workday should have. In the rules below, a committed entry's values read like a change's values.
7. A change may have projectFullName and projectProperties. Use projectProperties["workday-agent"].code and .name for Workday; they already hold the defaults. Never use projectName to find a project: it is a short name only Ajour knows.
8. Ajour gives hours as decimal numbers with a dot, such as 0.75. Workday writes and reads hours with a decimal comma: 45 minutes is 0,75 and 7.5 hours is 7,5. Convert when you type hours in Workday, and when you compare Workday's hours with Ajour's.

## 2. Open the timesheet

1. Send update_session: "Opening Workday."
2. Open {{settings.timesheetUrl}}.
3. A sign-in page: try to get through it without the user first. Send update_session: "Signing in to Workday."
   - Workday's own page offers a single sign-on button, such as "Sign in with SSO" or the company's name: click it.
   - An account picker lists "{{settings.username}}": click that account.
   - A field asks for an email or a username, and "{{settings.username}}" is not empty: type it and press Next or Continue.
   - Wait a few seconds after each step and take a new snapshot. The identity provider often signs in alone when Chrome still has its session.
   - The page asks for a password, a code, a number to match or an approval, or the username is empty and a field needs it: stop there. Never type in that page. Ask the user to sign in in the Chrome window, with the choices "Done" and "Stop". "Done": take a new snapshot and go on. "Stop": end the session as cancelled.
   - Do not try the same step more than twice. A loop back to the same page means you ask the user.
4. Go to the week that holds {{weekOf}}. Use Workday's own week picker or its previous and next week arrows. Check the dates in the page header match the week before you enter anything.
5. The week cannot be found, or the page is not a timesheet: end the session as failed and say what the page shows.

## 3. Compare day by day

Send update_session: "Comparing Workday with Ajour."

Find a change's time type in Workday. Match the project by projectProperties["workday-agent"].code first, then projectProperties["workday-agent"].name, then projectFullName. If a change has neither projectProperties nor projectFullName, match the project by projectCode. Match the task by taskName.

The comment of an entry Ajour committed is the note, then " · ", then the externalId. With no note, the comment is the externalId alone.

For each day, Monday first, compare Workday's total for the day with committedHoursByDay, and each Workday entry whose comment ends with an externalId from committedEntries with that entry's committed values. Note every difference:

- A committed entry with no Workday entry whose comment ends with its externalId.
- A Workday entry with one of these externalIds whose day, time type, hours or comment differs from the committed values.
- A Workday entry on a day of this week whose comment ends with "ajour:" and an ID that is not in committedEntries. It may belong to another week or another Ajour: report it, never delete it.
- A day whose total still differs once those are counted. The difference comes from entries without an Ajour ID, the user's own.

No difference: go to step 5.

## 4. Ask about the differences

Ask once, listing each difference with its day, project, task, and hours in Workday and in Ajour. For example: "Workday differs from Ajour on 2 days. Tue, Acme · Build: Workday has 2 h, Ajour committed 1,5 h. Thu: Workday has 1 h more, from an entry without an Ajour ID." List each entry whose Ajour ID is not in committedEntries with its day, time type, hours and comment, and say you will leave it alone. Offer the choices "Update Workday", "I'll fix Ajour" and "Leave it".

- "Update Workday": make each Workday entry with one of this week's externalIds match its committed values, and add each committed entry Workday lacks. Never delete an entry whose Ajour ID is not in committedEntries: leave it and note it for the summary, for the user to check. Send update_session when you start each day. Then compare again, once. Differences left only from entries without an Ajour ID, or with an Ajour ID not in committedEntries, do not stop the submission: note them for the summary. Any other difference left: do not loop. Ask with the choices "Leave it" and "Stop". "Leave it": go on and note it for the summary. "Stop": end the session as cancelled.
- "I'll fix Ajour": end the session as cancelled with "Change the entries in Ajour, commit them, then run Check Workday and submit again." Do not submit.
- "Leave it": go on with the differences as they are, and note them for the summary.

To add an entry, open the entry dialog from the day itself. Workday's page may be in English or French. Click the empty area of that day's column in the week calendar, below any existing entries. Workday shows a blue "Enter Time" or "Entrer des heures" block there; click it if the first click only showed the block. Do not use the "Actions" menu, it is slower. Fill the dialog in this order, because Workday clears the hours when the time type changes:
   1. Pick the time type first. Wait about two seconds with browser_wait_for, then take a snapshot and check the time type shows and the dialog has settled.
   2. Type the hours with a decimal comma such as 0,75 (never type a dot), then the comment.
   3. Take a snapshot and check the hours are still there before you confirm. If they are empty, type them again.
   The same applies when you edit an entry and change its time type: set the time type, wait, then set the hours. Confirm the dialog. Take a snapshot and check the entry shows in the day with the right hours.

Workday shows an error on save: read the message. If it names a field you can fix, fix it once. Otherwise cancel the dialog, note the error, and ask with the choices "Leave it" and "Stop". "Stop" ends the session as failed.

Never delete or change an entry in Workday whose Ajour ID is not in committedEntries, or that has no Ajour ID. Those are the user's own, or belong to another week or another Ajour.

## 5. Submit in Ajour

Call submit_week with weekOf {{weekOf}}. Ajour refuses: end the session as failed with Ajour's reason.

## 6. Summary

End the session with what you did, for example: "Workday matched Ajour. Submitted the week in Ajour." or "Updated 2 Workday entries to match Ajour, then submitted the week in Ajour." List each difference you left, with its day, and each day whose total differs because of entries without an Ajour ID, and each entry with an Ajour ID not in committedEntries, with its day, hours and comment, for the user to check.
