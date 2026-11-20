# Changelog

## 0.4.0

- *Let the group in* at the **vynst lock** node (check box, off by default): the lock reports
  `group_open` to the ERP and executes `group_open` / `group_close` for a turnstile. Mode *stays open*
  sends `hold_open` and `lock` at the end, mode *single impulses* an `open` every `pulse_seconds`. The node
  keeps the time itself, so a lost ERP connection never leaves the turnstile open.

## 0.3.1

- New example `new-ticket-notification` (trigger + vynst node), so every node has an example.
- Local publishes work again (provenance only from the workflow); repository url normalized.

## 0.3.0

- First release on npm, as `@inwendo/node-red-vynst` (scoped name as Node-RED recommends for new packages).
  The node types (`inwendo-erp-*`) stay the same, so existing flows keep working.
- Product name in the editor: palette category *vynst (inwendo ERP)*, nodes *vynst*, *vynst trigger*,
  *vynst lock* ...
- Publishing from GitHub Actions only, with npm trusted publishing (no token) and provenance.

## 0.2.0

- Booking schedule, check-in, occupancy, usage counters, inventory loans, attendance lists, shift plan,
  notifications; trigger over MQTT; virtual locks example.

## 0.1.0

- ERP node, trigger, smart locks in both directions (lock bridge, lock, lock result, access check).
