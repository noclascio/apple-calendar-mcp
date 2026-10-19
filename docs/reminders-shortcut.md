# Apple Reminders through your iPhone (iOS 27)

Apple has no cloud API for modern Reminders lists. The only lists reachable over CalDAV are frozen pre-2019 ones, so this Worker uses your iPhone as the bridge instead. A Shortcut on the phone posts your open reminders to the Worker and creates any reminders your assistants have queued. The phone is always on, so your Mac can stay closed.

These steps were written while building it on iOS 27, with screenshots at every stage. Where iOS 27 differs from older versions, this guide follows iOS 27.

What the assistants get:

- `reminders_list` (MCP) or `GET /api/reminders` (HTTP): your open reminders as of the last sync, with `syncedAt` and `ageMinutes`.
- `reminders_create` or `POST /api/reminders`: queues a new reminder. The phone creates it on the next sync.
- `reminders_pending_changes`: what is queued and not yet applied.

Completing or deleting reminders from the assistants is not supported. iOS Shortcuts has no action to mark a reminder complete.

## 1. Worker setup (one time)

1. In Cloudflare, open the Worker, Settings tab, Runtime variables and secrets, Add variable.
2. Key `SHORTCUT_TOKEN`. Value: a random password of **at least 24 characters**. Shorter values are refused and the Shortcut will report "SHORTCUT_TOKEN is not configured". Secret checked. Production checked. Add variable and deploy.
3. The next build creates the `REMINDERS_KV` storage on its own.

You will type this token on the phone, so a passphrase of four or five random words joined by dashes is easier than a 32-character string. It is used by this Shortcut only; changing it later breaks nothing else.

Your sync address is your Worker address plus `/shortcut/sync`, for example `https://apple-calendar-mcp.<you>.workers.dev/shortcut/sync`.

## 2. Build the Shortcut on the iPhone

Open the Shortcuts app, tap **+**, name it anything you like (this guide says **Reminders Sync**). Actions are added by typing their name into the **Search** bar at the bottom of the editor. A new action lands at the bottom of the list; drag it by its title to move it.

### 2.1 Find Reminders

Search `Find Reminders` and add it. It appears as **Find Reminders where** with a default filter row that reads **List is Choose**.

- Tap the word **List** in that row. A menu of properties opens. Choose **Is Not Completed**.
- The row now reads just **Is Not Completed**. There is no separate value to set; on iOS 27 completion is a single choice, not a field plus a value.
- Leave **Sort by** as None and **Limit** off.

### 2.2 Repeat with Each

Search `Repeat with Each` and add it. It fills in **Repeat with each item in Reminders** on its own and brings an **End Repeat** with it.

### 2.3 Text (inside the repeat)

Search `Text` and add it. Drag it so it sits between **Repeat with each item** and **End Repeat**; it indents when it is inside the loop.

Tap inside the Text box. The keyboard opens with a row of variables above it. Build one line with six fields separated by three pipes, `|||`:

1. Tap **Repeat Item** in the variable row to insert it.
2. Type `|||`.
3. Tap **Repeat Item** again, then tap the pill you just inserted. A sheet opens listing the reminder's properties. Choose **List**. Type `|||`.
4. Repeat Item, choose **Due Date**. Do not look for a date format option; there is none on iOS 27 and the Worker parses the phone's default text, such as "Oct 20, 2026 at 2:00 PM". Type `|||`.
5. Repeat Item, choose **Priority**. Type `|||`.
6. Repeat Item, choose **Is Flagged**. If that property is not offered, type the word `No` instead. Type `|||`.
7. Repeat Item, choose **Notes**.

Quirks seen on iOS 27:

- The first pill may stay labelled **Repeat Item** even after you choose Title, and other pills sometimes snap back to **Repeat Item** when tapped again. A bare Repeat Item renders as the reminder's title, so the first field is fine either way. If Priority or Is Flagged revert, leave them; the Worker treats unrecognised values there as "none" and "no". The fields that matter are List, Due Date and Notes.
- Multi-line notes are fine. The Worker folds continuation lines back into the right reminder.

### 2.4 Combine Text

Search `Combine Text` and add it, after End Repeat. It should fill in with **Repeat Results**. Set the separator to **New Lines**.

### 2.5 Get Contents of URL

Search `Get Contents of URL` and add it after Combine Text. Tap it to expand its settings, then:

- **URL**: your sync address from step 1.
- **Method**: POST.
- **Headers**: tap Add new header. Key `Authorization`. Value the word `Bearer`, one space, then your `SHORTCUT_TOKEN`. If an empty second header row appears, remove it with its red minus.
- **Request Body**: Form. Tap Add new field, choose Text. Key `payload`. Value: tap the box, then tap **Combined Text** in the variable row.

### 2.6 Read the Worker's reply

Search `Get Dictionary Value` and add it after Get Contents of URL. Set it to **Get Value for `commands` in Contents of URL**: tap the first blue pill and choose Value, type `commands` in the key box, and the last pill should already say Contents of URL.

### 2.7 Create the queued reminders

1. Search `Repeat with Each` and add a second loop. It should fill in **Dictionary Value**.
2. Search `Get Dictionary Value` and add another one. Drag it inside this second loop. In it, tap the grey **Key** box and type `title`. Its last pill should read **Repeat Item**; if it shows anything else, tap it and pick Repeat Item from the variable row. If a Repeat Item pill lands in the key box by mistake, tap the pill, choose Clear Variable, then type `title`.
3. Search `Add New Reminder` and add it. Drag it inside the second loop, below the Get Dictionary Value you just placed. Tap its grey **Reminder** placeholder and choose **Dictionary Value** from the variable row. Leave the list as your default list.

Notes and due dates on queued reminders are optional. To add them, repeat step 2 for `notes` and `due` and attach each Dictionary Value through the arrow on the right of Add New Reminder.

### 2.8 Test it

Search `Show Result` and add it at the very bottom. Tap its box and choose **Contents of URL**. Now tap the **Play** button. Allow Reminders access and the connection to your Worker address when asked, choosing Always Allow where offered. A box appears with the Worker's reply: `stored` is how many reminders it received, `syncedAt` is when. If instead it says the token is not configured, the Worker's secret is shorter than 24 characters or not under Production.

Once it works, remove Show Result so automations run silently.

## 3. Make it run on its own (iOS 27)

On iOS 27 you describe an automation in words and the system builds it. Open the Shortcuts app, **Automation** tab, tap **+**, and type:

```
When I close the Reminders app, run the Reminders Sync shortcut immediately without asking and without notifying me.
```

Use your shortcut's real name. Check the result:

- The trigger should read **When Reminders is Closed**.
- The action should read **Run** followed by **your shortcut's name**. The builder sometimes invents a wrapper named after the request, such as "Run Reminders Sync on Close"; if you see that, tap the pill and pick your actual shortcut from the list.
- There is no Run Immediately or Ask Before Running toggle on this kind of automation in iOS 27. It just runs.

Tap Done. Test: open Reminders, add or change something, swipe up to leave the app. The sync runs within seconds.

Optional, same way: `Every day at 7 AM, run the Reminders Sync shortcut immediately without asking and without notifying me.` Make one per time if it only accepts one time each.

Automations live on one device. Set them up on the iPhone only.

## 4. Check it from the agents

Ask an assistant for `reminders_list` (or `GET /api/reminders`). You should see your lists and open reminders with a fresh `syncedAt`. Two things to know when checking:

- The storage behind the Worker takes up to about a minute to show a new write everywhere. Right after a sync an agent can still see the previous time. Wait a minute and ask again in a new message.
- Agents that connected before the Reminders tools existed keep the old tool list. For ChatGPT and Dots, add the connector again (under a new name if the old one cannot be removed) and start a new conversation. Instinct uses the HTTP API and has no such cache.

Then ask an assistant to queue a reminder called "Bridge test", open and close Reminders on the phone, and confirm it appeared.

## Privacy

The Worker stores the snapshot of your open reminders and the queue in your own Cloudflare KV namespace. Nothing is sent anywhere else. The `SHORTCUT_TOKEN` is the only credential the phone holds; rotate it in Cloudflare and in the Shortcut's header to cut the phone off.
