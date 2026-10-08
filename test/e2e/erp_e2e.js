'use strict';

/**
 * Runs the nodes in a Node-RED test runtime against a live inwendo ERP and its MQTT broker:
 * the bridge registers a lock, the test syncs it into an ERP smart lock, opens it through the
 * ERP API and expects the command at the lock node (over MQTT) and the result in the ERP.
 *
 * Environment:
 *   IW_E2E_ERP_HOST   ERP base URL, e.g. https://127.0.0.1:8443
 *   IW_E2E_ERP_TOKEN  API token (JWT) of a super admin, scope event, "allow super admin functions"
 * Skipped without them. The ERP must have MQTT configured (MQTT_HOST, MQTT_WSS_PORT, MQTT_TCP_PORT).
 */

const assert = require('assert');
const crypto = require('crypto');
const helper = require('node-red-node-test-helper');
const { ErpClient } = require('../../nodes/lib/erp-client');
const { waitFor } = require('../helpers');

const HOST = process.env.IW_E2E_ERP_HOST;
const TOKEN = process.env.IW_E2E_ERP_TOKEN;

helper.init(require.resolve('node-red'));

const NODES = [
	require('../../nodes/inwendo-erp-config'),
	require('../../nodes/inwendo-erp'),
	require('../../nodes/inwendo-erp-lock-bridge'),
	require('../../nodes/inwendo-erp-lock'),
	require('../../nodes/inwendo-erp-access-check'),
];

(HOST && TOKEN ? describe : describe.skip)('against a live ERP', function () {
	this.timeout(60000);
	const instanceId = `nr-e2e-${crypto.randomBytes(6).toString('hex')}`;
	const secret = crypto.randomBytes(32).toString('hex');
	const erp = new ErpClient({ host: HOST, apiToken: TOKEN });

	before(function (done) {
		helper.startServer(done);
	});
	after(async function () {
		await helper.unload();
		await new Promise((resolve) => helper.stopServer(resolve));
	});

	it('opens a Node-RED lock from the ERP over MQTT and reports the result', async function () {
		await helper.load(NODES, [
			{ id: 'server', type: 'inwendo-erp-config', host: HOST },
			{ id: 'bridge', type: 'inwendo-erp-lock-bridge', server: 'server', name: 'Node-RED E2E', instanceId, delivery: 'mqtt' },
			{ id: 'lock', type: 'inwendo-erp-lock', bridge: 'bridge', lockId: 'e2e_door', lockName: 'E2E Tür', wires: [['out']] },
			{ id: 'check', type: 'inwendo-erp-access-check', target: 'bridgeLock', bridge: 'bridge', lockId: 'e2e_door', wires: [['granted'], ['denied']] },
			{ id: 'out', type: 'helper' },
			{ id: 'granted', type: 'helper' },
			{ id: 'denied', type: 'helper' },
		], { server: { apiToken: TOKEN }, bridge: { secret } });

		const bridge = helper.getNode('bridge');
		await waitFor(() => bridge.registered && bridge.mqttClient && bridge.mqttClient.connected, 20000);

		// the administrator syncs the lock into an ERP smart lock
		const sync = await erp.request('POST', `/api/event/smart_lock_connection/${bridge.connectionId}/sync_devices.json`, { body: {} });
		const smartLockId = sync.devices.find((device) => device.providerDeviceId === 'e2e_door').id;
		await new Promise((resolve) => setTimeout(resolve, 500)); // subscription

		const commands = [];
		helper.getNode('out').on('input', (msg) => commands.push(msg));
		const unlock = await erp.request('POST', `/api/event/smart_lock/${smartLockId}/unlock.json`, { body: {} });
		assert.strictEqual(unlock.success, true);
		await waitFor(() => commands.length === 1, 10000);
		assert.strictEqual(commands[0].payload.command, 'open');
		assert.strictEqual(commands[0].payload.smart_lock_id, smartLockId);

		// a credential nobody has is denied
		const denied = [];
		helper.getNode('denied').on('input', (msg) => denied.push(msg));
		helper.getNode('check').receive({ payload: `UNKNOWN-${instanceId}` });
		await waitFor(() => denied.length === 1, 10000);
		assert.strictEqual(denied[0].payload.reason, 'unknown_credential');

		const log = await erp.request('GET', '/api/event/smart_lock_log.json', { qs: { smartLock: smartLockId } });
		assert.ok(log.some((entry) => entry.action === 'unlock' && entry.source === 'app'));
		assert.ok(log.some((entry) => entry.action === 'access_denied' && entry.source === 'nodered'));

		await bridge.close(true);
	});
});
