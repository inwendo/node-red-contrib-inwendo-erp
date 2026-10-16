# node-red-contrib-inwendo-erp

[Node-RED](https://nodered.org/) nodes for the [inwendo ERP](https://www.inwendo.de/):

- **API token login** and the ERP functions of the n8n node: read, create and update ERP data, PDFs,
  generic API requests, and a trigger for ERP webhooks (https or over the ERP's MQTT broker).
- **More ERP data**: inventory loans, attendance lists, shift plan (clock in / out), occupancy of the
  bookables, usage counters, notifications.
- **Booking schedule**: a message before a booking starts, at its start, at its end and after it ended –
  preheat a hall, switch the floodlight, unlock a door.
- **Check-in** at the entrance with a card / QR reader (attendance list or staff time clock).
- **Smart locks in both directions**
  - *ERP → Node-RED*: locks defined in Node-RED become ERP smart locks. When a user with access taps
    *open* in the app (or through the API / Home Assistant), Node-RED gets the command and switches the
    relay, motor lock, door opener, Shelly, GPIO ...
  - *Node-RED → ERP*: a barcode, QR or RFID reader at Node-RED reads a number, the ERP checks the access
    with the same rules as the app and answers yes or no; the flow continues with the answer.

Requires an ERP version with the `/api/nodered/*` endpoints.

## Install

```bash
cd ~/.node-red
npm install node-red-contrib-inwendo-erp
```

or in the editor: *Manage palette → Install → node-red-contrib-inwendo-erp*. Node.js 18 or newer.

## Nodes

| Node | Purpose |
|---|---|
| **inwendo-erp-config** | ERP host and API token (JWT). "Test token" calls `/api/base/api_access_token_test`. |
| **inwendo erp** | Resources Booking, Company, Event, Event Sign-Up, Invoice, News Article, Offer, Person, Project, Smart Lock, Smart Lock Log, Ticket, Time Entry, Webhook – operations Get, Get Many (limit or all pages), Create, Update (PATCH), Get PDF; smart locks also Unlock, Lock, Status. New: Inventory Loan, Attendance List, Attendance List Entry, Shift Plan Entry, Occupancy, Usage Counter, Notification (see below). Plus *Generic API Request*. |
| **inwendo erp trigger** | Starts a flow when an ERP entity is created / updated / deleted. Registers its webhook on deploy; delivery as https webhook or over the ERP's MQTT broker. |
| **inwendo erp booking schedule** | Starts a flow before / at the start / at the end / after the end of bookings (`booking_pre_start`, `booking_start`, `booking_end`, `booking_post_end`), optionally for some bookables only. |
| **inwendo erp check-in** | `msg.payload` = card number / QR code → attendance list check-in / check-out or staff clock in / out; output 1 *done*, output 2 *refused*. |
| **inwendo-erp-lock-bridge** | Config node: connects the locks of this Node-RED to the ERP (MQTT or https push). |
| **inwendo erp lock** | One lock. Outputs the ERP commands (`open`, `lock`); input: the lock state. |
| **inwendo erp lock result** | Reports the result of a command (for locks set to wait for the result). |
| **inwendo erp access check** | `msg.payload` = what the reader read → output 1 *granted*, output 2 *denied*. |

Settings of the `inwendo erp` node can be overridden per message (`msg.resource`, `msg.operation`,
`msg.id`, `msg.query`, `msg.searchString`, `msg.limit`, `msg.method`, `msg.endpoint`); `msg.payload`
holds the fields for create / update. ERP errors are thrown with the ERP error code and message
(`X-IW-ERROR-CODE` / `X-IW-ERROR-JSON`), use a *catch* node.

### Functions behind ERP settings

Newer ERP functions are switched off by default. When the ERP answers *feature disabled* (HTTP 400 with
`X-IW-ERROR-CODE: 404` and `X-IW-ERROR-JSON: ["feature disabled: <setting>"]`), the node shows the red status
**Funktion im ERP deaktiviert: &lt;setting&gt;** instead of an error code. Trigger and booking schedule log it once
and check again the next day; switch the setting on in the ERP and deploy again to start at once.

| ERP setting | Needed for |
|---|---|
| `integration_booking_timed_events_enabled` | booking schedule, source *ERP sends the events* |
| `integration_mqtt_trigger_enabled` | trigger / booking schedule with delivery *ERP MQTT broker* |
| `integration_occupancy_api_enabled` | resource Occupancy |
| `event_inventory_enabled` | resource Inventory Loan |
| `shift_planning_enabled`, `shift_clocking_enabled` | Shift Plan Entry, Clock In / Clock Out |

### More resources

| Resource | Operations | ERP endpoint |
|---|---|---|
| Inventory Loan | Get, Get Many (`state` LENT / RETURNED / OVERDUE, `bookable`, `booking`, `person`), Create (hand-over from a booking: `{"booking": 12, "quantity": 1, "due_at": "…"}`), Return, Extend (`{"due_at": "…"}`), Stock Overview, Availability (ID = bookable, `msg.query = {start, end}`) | `/api/event/inventory_loan`, `…_stock`, `…_availability/{bookable}` |
| Attendance List | Get, Get Many, Create, Update | `/api/event/attendancelist` |
| Attendance List Entry | Get, Update; Get Many and Create of a list (*List ID* / `msg.parentId`) | `/api/event/attendancelist/{list}/entries`, `…/{list}/entry`, `…/{entry}/entry` |
| Shift Plan Entry | Get, Get Many, Create, Update, Clock In, Clock Out (own shifts of the token's user) | `/api/time/shift_plan_entry` |
| Occupancy | Get Occupancy (ID optional: bookable ids `7,8`): occupied now, current / next booking, lead / lag time, opening hours | `GET /api/event/bookable_occupancy` |
| Usage Counter | Get, Get Many, Create, Update, Set Value (`msg.payload` = reading) | `/api/event/base_bookable_usage_counter` |
| Notification | Get, Get Many, Mark as Read (notifications of the token's person) | `/api/notification/user_notification` |

## API token

Create the token in the ERP under **Settings → API Access Tokens**, long-lived:

| Feature | Scope |
|---|---|
| Lock bridge, lock, access check | **Event – Write** |
| Trigger, booking schedule (source *ERP*) | **Webhook – Write** |
| Booking schedule (source *Node-RED reads the bookings*) | **Event Booking – Read** |
| Check-in: attendance list / staff clock | **Attendance scanner** (`eas`) / **Work time entry scanner** (`wtes`) – Write |
| Inventory Loan | **Event Booking** (Read, Edit for create / return / extend) |
| Usage Counter | **Maintenance** |
| Attendance List (Entry) | **Event** |
| Shift Plan Entry | **Time** (Clock In / Out: a login with an own shift) |
| Notification | **Notification** (read), the token's person for *Mark as Read* |
| inwendo erp node | the scopes of the resources (CRM, CRM Project, Ticket, Time, Billing, Event, Event Booking, Media; Webhook + *allow admin functions* for the webhook resource) |
| Smart Lock Unlock / Lock | the token's user needs access to the lock (as in the app) |

Optional hardening: a separate token for Node-RED with the URL path restriction `/api/nodered/.*`.

## Smart locks

### Set up

1. Add an **inwendo erp lock** node, create a **lock bridge** for it (name, ERP connection, delivery).
   Instance ID and secret are generated when the bridge dialog opens; they identify this Node-RED in
   the ERP, do not copy them to another Node-RED.
2. Give every lock a unique **Lock ID** (`front_door`) and its name in the ERP. *In the app*: *Open
   button* (the ERP sends `open`) or *QR code* (the app shows a QR code, a scanner at the door checks it).
3. Deploy. The bridge registers its locks (`/api/nodered/smart_lock/register`); the ERP shows a smart
   lock connection with provider *Node-RED*. Open it and run **Sync devices** once (and again after you
   add locks). Grant the access to the new smart locks as usual: self service, bookable, employment
   contract or booking.
4. Wire the lock node to your relay. A message with a lock state (`locked`, `unlocked`, `open`,
   `jammed`, …) as payload into the lock node reports the state to the ERP.

### Delivery of commands

| Delivery | When | How |
|---|---|---|
| **MQTT** (default) | Node-RED behind NAT / without public address | With the registration the ERP hands out access to its MQTT broker (websocket over TLS, read access to the topic of this bridge only, renewed every 10 minutes). The ERP publishes every command; the bridge reports the result over https. Only outgoing connections. |
| **Push** | Node-RED reachable via https from the internet | The ERP posts every command to `<Public URL>/inwendo-erp/lock/<instance id>` and gets the result as answer. |

Every command is signed (HMAC-SHA256 of the JSON body with the bridge secret, as `X-IW-Signature`
or in the MQTT message) and carries a timestamp and a nonce. The bridge rejects unsigned, replayed and
old commands: a command is executed at most 30 seconds (plus 30 seconds clock difference) after the
user tapped *open*. Keep the clock of the Node-RED host synchronized (NTP).

With *Report success when the message is sent* the lock confirms every command at once. With *Wait for
an "inwendo erp lock result" node* the flow reports the result: keep `msg._inwendoLock` on the message
and set `msg.success` (`false` + `msg.message` for an error, `msg.state` for the new state).

### Access check of a reader

Send what the reader read into **inwendo erp access check** (`msg.payload`, string, number or Buffer;
line breaks are removed). The ERP accepts:

| Credential | Source |
|---|---|
| `access_code` | the QR code the app shows for exactly this lock (locks with *In the app: QR code*, valid 5 minutes) |
| `member_card` | the QR code of the digital member card (also as `…/verify/<code>` link) |
| `card` | RFID / chip card number stored at the person (*member card number*, as for Gantner readers) |

`auto` detects the type. The plain member number is not accepted: it can be guessed. The ERP checks with
the rules of the app (super admin, self service rights of the person's login, bookable, employment
contract, booking ±1 h) and writes the smart lock log (source *nodered*). The answer in `msg.payload`:

```json
{
  "granted": true,
  "reason": "granted",
  "credential_type": "card",
  "smart_lock": { "id": 12, "name": "Haupteingang" },
  "person": { "id": 345, "name": "Erika Mustermann" },
  "opened": null
}
```

`reason` for a denial: `unknown_credential`, `no_access`, `invalid_code`, `code_expired`.

The check can also target **any ERP smart lock by id** (e.g. a Nuki door with an RFID reader at
Node-RED); with *ERP opens the lock* the ERP opens it itself when access is granted (`opened`).

## Trigger

| Delivery | How |
|---|---|
| **HTTPS webhook** | The trigger needs the **public https base URL** of this Node-RED; the ERP calls `<Public URL>/inwendo-erp/webhook/<node id>` with a token generated on every deploy. |
| **ERP MQTT broker** | No public URL: the node registers with `{"delivery": "mqtt", "instance_id": …}`, the ERP returns access to its broker (wss, username / password / client id, topic, `valid_until`). The node subscribes and registers again every 24 h and before the access runs out. ERP setting `integration_mqtt_trigger_enabled`. |

Changes Node-RED makes itself (requests carry `X-IW-Trigger-Source: nodered`) are not reported back.
Removing the node removes the webhook. Events of smart lock logs and attendance list entries carry a summary in
`msg.webhookData` (`type` `access` / `check_in`, lock or list, person, …).

Entity types: Booking, Company, Event, Event Sign-Up, Invoice, News Article, Offer, Person, Project, Smart Lock
Log, Ticket, Time Entry and Attendance List, Attendance List Entry (check-in), Bookable, Usage Counter, Booking Real
Usage, Booking Substitution, Inventory Loan, Membership Pause Request, Shift Exchange Request, Shift Plan Entry,
Smart Lock, Notification, Work Time Entry.

## Booking schedule

Sends `msg.topic = "<bookable name>/<event type>"` and `msg.payload` = the timed event:

```json
{
  "type": "booking_start",
  "due_at": "2026-10-11T18:00:00+02:00",
  "booking_id": 123, "booking_title": "Training U12",
  "start": "2026-10-11T18:00:00+02:00", "end": "2026-10-11T19:30:00+02:00",
  "bookable_id": 7, "bookable_name": "Halle 1",
  "location_id": 2, "location_name": "Sportzentrum",
  "participants": 14, "pre_start_minutes": 30, "post_end_minutes": 15
}
```

| Source | How |
|---|---|
| **ERP sends the events** (recommended) | Trigger webhook with `database_action` `booking_timed` (or one type) over the ERP MQTT broker or https. The ERP checks every minute (an event can be 1–2 minutes late, never twice) and skips cancelled bookings. Lead / lag time per bookable (addon data `automation_pre_start_minutes` / `automation_post_end_minutes`) or the ERP settings (30 / 15 minutes). ERP setting `integration_booking_timed_events_enabled`. |
| **Node-RED reads the bookings** (fallback) | Works with every ERP: reads `GET /api/event/base_booking` every few minutes and schedules the events with the lead / lag time of the node. Moved or cancelled bookings are rescheduled or dropped; after a restart, events up to 2 minutes late are still sent. `participants` is `null`. |

## Check-in

`msg.payload` = what the reader read (card number stored at the person, member number, QR code of the digital
member card – also as `…/verify/<code>` link; for the staff clock the QR code of the employment contract).

| Mode | ERP endpoint | Output 1 |
|---|---|---|
| Attendance list | `GET /api/event/scanner/attendancelist/{list}/{person}` | `msg.action` `check_in` / `check_out` (the next scan checks out, not within 60 s) |
| Staff clock | `GET /api/time/work_entry_scanner/{person}` | `msg.action` `clock_in` / `clock_out` |

`msg.payload` is the attendance list entry / work time entry, `msg.person` the scanned identifier plus id and name
when the ERP answer has them (the attendance list scanner returns no person data). Output 2 gets refusals with
`msg.payload.reason`: `unknown_person`, `scanned_too_often`, `list_not_found`, `no_employment_contract`,
`no_permission`, `invalid_entry`, `refused`. Network and server errors are thrown.

## Examples

*Import → Examples → node-red-contrib-inwendo-erp*:

| Example | What it does |
|---|---|
| `door-with-reader` | A door the ERP opens and a card reader in front of it. |
| `preheat-hall-before-booking` | Booking schedule (ERP events over MQTT) → MQTT thermostat: 21 °C before a booking, 16 °C after it. |
| `floodlight-during-bookings` | Booking schedule (fallback, reads the bookings) → floodlight relay on at the start, off after the end. |
| `rfid-reader-access-relay` | RFID reader → access check of an ERP smart lock → relay opens 3 s, LED / buzzer when denied. |
| `check-in-at-the-entrance` | Card / QR reader → attendance list check-in / check-out → welcome / goodbye / refused. |
| `virtual-locks` | Two virtual locks without hardware (a door the app opens, a room with a QR scanner) behind an MQTT lock bridge: they confirm, lock themselves again after 5 s and can be jammed; a reader (inject node or `POST /virtual-locks/front_door/reader`) checks a card. `GET /virtual-locks` shows their state and history. Also on developer.vynst.de. |

## Development

```bash
npm install
npm run lint
npm test                    # nodes against a mock ERP and a real MQTT broker (aedes)
IW_E2E_ERP_HOST=https://erp.example.com IW_E2E_ERP_TOKEN=<jwt> npm run test:e2e
```

The E2E tests need a super admin token (scope event, *allow super admin functions*) and an ERP with
MQTT configured; they register a lock, sync it, open it through the ERP and check a credential, read occupancy,
inventory stock and bookings, check refused check-ins and connect trigger / booking schedule over the ERP MQTT
broker. Tests of functions switched off in the ERP are skipped.

`examples/virtual-locks.json` is generated by `e2e/scripts/export-node-red-example.mjs` of
inwendo/servercontrolpanel, whose E2E suite runs this package in a real Node-RED against the ERP with
that flow (`e2e/tests/api/nodered-runtime.spec.ts`); regenerate it there instead of editing it here.

## License

MIT
