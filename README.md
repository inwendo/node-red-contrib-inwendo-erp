# node-red-contrib-inwendo-erp

[Node-RED](https://nodered.org/) nodes for the [inwendo ERP](https://www.inwendo.de/):

- **API token login** and the ERP functions of the n8n node: read, create and update ERP data, PDFs,
  generic API requests, and a trigger for ERP webhooks.
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
| **inwendo erp** | Resources Booking, Company, Event, Event Sign-Up, Invoice, News Article, Offer, Person, Project, Smart Lock, Smart Lock Log, Ticket, Time Entry, Webhook – operations Get, Get Many (limit or all pages), Create, Update (PATCH), Get PDF; smart locks also Unlock, Lock, Status. Plus *Generic API Request*. |
| **inwendo erp trigger** | Starts a flow when an ERP entity is created / updated / deleted. Registers its webhook on deploy. |
| **inwendo-erp-lock-bridge** | Config node: connects the locks of this Node-RED to the ERP (MQTT or https push). |
| **inwendo erp lock** | One lock. Outputs the ERP commands (`open`, `lock`); input: the lock state. |
| **inwendo erp lock result** | Reports the result of a command (for locks set to wait for the result). |
| **inwendo erp access check** | `msg.payload` = what the reader read → output 1 *granted*, output 2 *denied*. |

Settings of the `inwendo erp` node can be overridden per message (`msg.resource`, `msg.operation`,
`msg.id`, `msg.query`, `msg.searchString`, `msg.limit`, `msg.method`, `msg.endpoint`); `msg.payload`
holds the fields for create / update. ERP errors are thrown with the ERP error code and message
(`X-IW-ERROR-CODE` / `X-IW-ERROR-JSON`), use a *catch* node.

## API token

Create the token in the ERP under **Settings → API Access Tokens**, long-lived:

| Feature | Scope |
|---|---|
| Lock bridge, lock, access check | **Event – Write** |
| Trigger | **Webhook – Write** |
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

### Example

`examples/door-with-reader.json` (*Import → Examples → node-red-contrib-inwendo-erp*): a door the ERP
opens and a card reader in front of it.

## Trigger

The trigger needs the **public https base URL** of this Node-RED; the ERP calls
`<Public URL>/inwendo-erp/webhook/<node id>` with a token generated on every deploy. Changes Node-RED
makes itself (requests carry `X-IW-Trigger-Source: nodered`) are not reported back. Removing the node
removes the webhook.

## Development

```bash
npm install
npm run lint
npm test                    # nodes against a mock ERP and a real MQTT broker (aedes)
IW_E2E_ERP_HOST=https://erp.example.com IW_E2E_ERP_TOKEN=<jwt> npm run test:e2e
```

The E2E test needs a super admin token (scope event, *allow super admin functions*) and an ERP with
MQTT configured; it registers a lock, syncs it, opens it through the ERP and checks a credential.

## License

MIT
