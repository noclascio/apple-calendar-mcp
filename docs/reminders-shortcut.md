# Apple Reminders through your iPhone

Apple has no cloud API for modern Reminders lists, so this Worker uses your iPhone as the bridge. A Shortcut on the phone posts your open reminders to the Worker and creates any reminders your AI assistants have queued. The phone is always on, so your Mac can stay closed.

What the assistants get:

- `reminders_list`: your open reminders as of the last sync, with `syncedAt` and `ageMinutes`.
- `reminders_create`: queues a new reminder. The phone creates it on the next sync.
- `reminders_pending_changes`: what is queued and not yet applied.

Completing or deleting reminders from the assistants is not supported. iOS Shortcuts has no action to mark a reminder complete.

## 1. Worker setup (one time)

1. In Cloudflare, open the Worker, Settings tab, Runtime variables and secrets, Add variable.
2. Key `SHORTCUT_TOKEN`. Value: a new random password of at least 24 characters from your password manager. Secret checked. Add variable and deploy.
3. The next build creates the `REMINDERS_KV` storage on its own.

Your sync address is your Worker address plus `/shortcut/sync`, for example `https://apple-calendar-mcp.<you>.workers.dev/shortcut/sync`.

## 2. Build the Shortcut on the iPhone (about 10 minutes)

Open the Shortcuts app, tap **+**, name it **Apple Reminders Sync**. Add these actions in order. Names in bold are the actions to search for.

1. **Find Reminders**. Set the filter to *Is Completed* **is** *No*. Leave Sort by as Due Date if offered.
2. **Repeat with Each**. Input: the *Reminders* from step 1. Everything in steps 3 and 4 goes inside the repeat.
3. **Text**. Inside the text box build one line using the magic variable *Repeat Item* for each field, with the characters `|||` between fields. Tap *Repeat Item* and change its detail each time:

   ```
   Repeat Item (Title)|||Repeat Item (List)|||Repeat Item (Due Date)|||Repeat Item (Priority)|||Repeat Item (Is Flagged)|||Repeat Item (Notes)
   ```

   For the Due Date field, tap the variable, choose **Due Date**, then set its format to **ISO 8601** and turn on **Include ISO 8601 Time**. If your iOS version has no *Is Flagged* detail, type `No` in that spot instead.
4. Nothing else inside the repeat. End Repeat.
5. **Combine Text**. Input: *Repeat Results*. Combine with **New Lines**.
6. **Get Contents of URL**. URL: your sync address. Tap *Show More*. Method **POST**. Headers: add `Authorization` with value `Bearer <your SHORTCUT_TOKEN>`. Request Body **Form**. Add one field: key `payload`, type Text, value *Combined Text*.
7. **Get Dictionary Value**. Get **Value** for key `commands` in *Contents of URL*.
8. **Repeat with Each**. Input: *Dictionary Value* from step 7. Inside the repeat:
9. **Get Dictionary Value**: key `title` in *Repeat Item*. Then three more of the same action for keys `list`, `due`, and `notes`.
10. **Add New Reminder**. Title: the `title` value. Tap *Show More*. Notes: the `notes` value. Alert: **Date**, and pick the `due` value as the date. List: the `list` value if the field accepts a variable; otherwise choose your default list.
11. End Repeat.

Tap the shortcut's settings and turn off **Show in Share Sheet**. Run it once by hand. It will ask for permission to read Reminders and to contact your Worker address. Allow both, choosing *Always Allow* for the URL.

## 3. Make it run on its own

In Shortcuts, Automation tab, **+**.

- **Time of Day**: pick 7:00 AM, choose **Run Immediately**, turn off *Notify When Run*, select Apple Reminders Sync. Repeat for 12:00 PM, 5:00 PM, and 9:00 PM, or whatever cadence you want.
- **App**: choose Reminders, **Is Closed**, Run Immediately, select Apple Reminders Sync. This refreshes the snapshot right after you edit reminders, and it is also how queued reminders land fast: open Reminders, close it, and anything your assistants queued appears.

Automations live on one device. Set them up on the iPhone only, so two devices never post competing snapshots.

## 4. Check it

Ask one of your assistants to call `reminders_list`. You should see your lists, your open reminders, and an `ageMinutes` close to the last automation run. Then ask it to queue a test reminder, open and close Reminders on the phone, and confirm the reminder appeared.

## Privacy

The Worker stores the snapshot of your open reminders and the queue in your own Cloudflare KV namespace. Nothing is sent anywhere else. The `SHORTCUT_TOKEN` is the only credential the phone holds; rotate it in Cloudflare and in the Shortcut's header to cut the phone off.
