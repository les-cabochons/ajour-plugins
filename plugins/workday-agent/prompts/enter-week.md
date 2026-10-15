# Enter the week of {{weekOf}} in Workday

You enter the user's Ajour lines for the week of {{weekOf}} in their Workday timesheet. Workday saves each entry when you confirm its dialog. There is no Submit step: do not look for one and do not click "Submit".

Keep a list of what you entered, what was already there, and what you skipped. The final summary uses it.

## 1. Read the week

1. Send update_session: "Reading the week of {{weekOf}}."
2. Call get_submit_lines with weekOf {{weekOf}}, groupBy "day-task" and onlyUnsubmitted true. Each section is a day, with its date. Each line in it has a project, a task, hours, comments, a lineId and unsubmittedEntryIds. A line may also have projectFullName and projectProperties. Use projectProperties["workday-agent"].code and .name for Workday; they already hold the defaults. Never use projectName to find a project: it is a short name only Ajour knows.
3. Ajour gives hours as decimal numbers with a dot, such as 0.75. Workday writes and reads hours with a decimal comma: 45 minutes is 0,75 and 7.5 hours is 7,5. Convert when you type hours in Workday, and when you compare Workday's hours with Ajour's.
4. No line to enter: end the session as done with "Nothing to enter." and stop.

## 2. Check the pace

Look at the pace block. When pace.status is "on-pace", say nothing and go on.

Otherwise ask, with the choices "Enter" and "Stop". Write the question with the numbers, for example:

- over: "You have 41.5 h this week, 4 over the 37.5 h target. Enter anyway?"
- under: "You have 12 h this week, 18 h expected by today. Enter anyway?"

"Stop" ends the session as cancelled with "Stopped at the pace check."

## 3. Open the timesheet

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

## 4. Enter each line

Work day by day, Monday first. Send update_session when you start each day, for example "Tuesday: 3 lines."

For each line:

1. Find the line's time type in Workday. Match the project by projectProperties["workday-agent"].code first, then projectProperties["workday-agent"].name, then projectFullName. If a line has neither projectProperties nor projectFullName, match the project by projectCode. Match the task by taskName.
2. Look at that day and that time type for an entry whose comment ends with the line's lineId.
   - Found, with the same hours: it is already entered. Call mark_entries_submitted with the line's unsubmittedEntryIds and go on.
   - Found, with other hours: correct the hours to the line's hours, confirm, then mark the entries.
3. An entry on that day and time type that looks the same but has no lineId, or another lineId: ask, with the choices "Same entry, mark it", "Different, add mine" and "Skip". Name the day, the time type, and both hours and comments in the question.
4. Otherwise add a new entry. Workday's page may be in English or French.
   - Open the entry dialog from the day itself: click the empty area of that day's column in the week calendar, below any existing entries. Workday shows a blue "Enter Time" or "Entrer des heures" block there; click it if the first click only showed the block. Do not use the "Actions" menu, it is slower.
   - time type: the one you found;
   - hours: the line's hours with a decimal comma, such as 0,75 for 0.75. Never type a dot;
   - comment: the line's comments, then " · ", then the lineId. With no comments, the comment is the lineId alone.
   Confirm the dialog. Take a snapshot and check the entry shows in the day with the right hours. Then call mark_entries_submitted with the line's unsubmittedEntryIds.
5. The time type is not found:
   - Workday offers a short list of close matches: ask which one, with each match as a choice plus "Skip".
   - Otherwise skip the line.
   For a skipped line, call mark_entries_not_submitted on any entry IDs you marked for it, and note the reason.
   When you skip a line because its project is not found, say in the summary that the user can set the Workday name or code in the project's Workday section in Ajour.
6. Workday shows an error on save: read the message. If it names a field you can fix, fix it once. Otherwise cancel the dialog, call mark_entries_not_submitted on any entry IDs you marked for the line, note the error, and go on with the next line.

Never delete an entry in Workday that has no lineId of the current week. Those are the user's own.

## 5. Review the totals

1. Send update_session: "Checking the totals."
2. Call get_submit_lines again with weekOf {{weekOf}}, groupBy "day" and onlyUnsubmitted false. These are Ajour's hours per day, including lines entered in earlier runs.
3. Read Workday's total hours per day for the week.
4. Compare each day.
   - All days match: end the session as done.
   - Some days differ: ask, with the choices "Update Workday", "I'll fix Ajour" and "Leave it". List each difference on its own line, for example "Tue: Ajour 7.5 h, Workday 8 h". Name the time types involved when you can tell.
     - "Update Workday": fix the entries that carry a lineId from this week, then review again. Do not change entries without one; ask about those instead.
     - "I'll fix Ajour" and "Leave it": end the session as done with the differences in the summary.

## 6. Summary

End the session with a short summary:

- the number of lines entered, already there, and skipped;
- each skipped line with its day, project, task and reason;
- the review result: "Totals match" or the list of differences.

For example: "Entered 9 lines, 2 already there. Skipped 1: Wed, Acme · Support, not found in Workday. Totals match."
