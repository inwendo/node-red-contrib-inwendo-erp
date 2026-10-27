# Changelog

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
