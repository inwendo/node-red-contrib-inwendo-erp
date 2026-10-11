'use strict';

/**
 * The newer nodes against a live inwendo ERP: resources (occupancy, inventory stock), the booking
 * query of the booking schedule fallback, check-in refusals and trigger delivery over the ERP's
 * MQTT broker. Functions switched off in the ERP ("feature disabled: <setting>") skip their test.
 *
 * Environment: IW_E2E_ERP_HOST, IW_E2E_ERP_TOKEN (super admin token, see erp_e2e.js). Skipped without them.
 */

const assert = require('assert');
const helper = require('node-red-node-test-helper');
const { ErpClient, featureDisabledSetting } = require('../../nodes/lib/erp-client');
const { pollQuery, parseBookableFilter } = require('../../nodes/lib/booking-schedule');
const { execute } = require('../../nodes/inwendo-erp');
const { waitFor } = require('../helpers');

const HOST = process.env.IW_E2E_ERP_HOST;
const TOKEN = process.env.IW_E2E_ERP_TOKEN;

helper.init(require.resolve('node-red'));

const NODES = [
	require('../../nodes/inwendo-erp-config'),
	require('../../nodes/inwendo-erp-trigger'),
	require('../../nodes/inwendo-erp-booking-schedule'),
	require('../../nodes/inwendo-erp-check-in'),
];

(HOST && TOKEN ? describe : describe.skip)('newer nodes against a live ERP', function () {
	this.timeout(60000);
	const client = new ErpClient({ host: HOST, apiToken: TOKEN });

	before(function (done) {
		helper.startServer(done);
	});
	afterEach(async function () {
		await helper.unload();
	});
	after(function (done) {
		helper.stopServer(done);
	});

	/** Runs an operation of the inwendo erp node; skips the test when the ERP has the function switched off. */
	async function run(context, config, msg = {}) {
		try {
			return (await execute(client, config, msg)).payload;
		} catch (error) {
			if (featureDisabledSetting(error)) {
				context.skip();
			}
			throw error;
		}
	}

	it('reads the occupancy of the bookables', async function () {
		const occupancy = await run(this, { resource: 'occupancy', operation: 'getOccupancy' });
		assert.ok(Array.isArray(occupancy.bookables));
	});

	it('reads the inventory stock', async function () {
		const stock = await run(this, { resource: 'inventoryLoan', operation: 'stock' });
		assert.ok(Array.isArray(stock));
	});

	it('reads the bookings with the query of the booking schedule fallback', async function () {
		const qs = pollQuery({ now: Date.now(), horizonMs: 24 * 60 * 60 * 1000, preStartMinutes: 30, postEndMinutes: 15, bookables: parseBookableFilter('') });
		const bookings = await client.requestAllItems('/api/event/base_booking', qs);
		assert.ok(Array.isArray(bookings));
		for (const booking of bookings) {
			assert.ok(booking.start_time && booking.end_time, 'bookings carry start_time / end_time');
		}
	});

	it('refuses unknown cards at the staff clock and unknown attendance lists', async function () {
		await helper.load(NODES, [
			{ id: 'server', type: 'inwendo-erp-config', host: HOST },
			{ id: 'clock', type: 'inwendo-erp-check-in', server: 'server', mode: 'staffClock', wires: [['ok'], ['refused']] },
			{ id: 'list', type: 'inwendo-erp-check-in', server: 'server', mode: 'attendanceList', listId: 'e2e-no-such-list', wires: [['ok'], ['refused']] },
			{ id: 'ok', type: 'helper' },
			{ id: 'refused', type: 'helper' },
		], { server: { apiToken: TOKEN } });
		const refused = [];
		helper.getNode('refused').on('input', (msg) => refused.push(msg));
		helper.getNode('clock').receive({ payload: `E2E-UNKNOWN-${Date.now()}` });
		helper.getNode('list').receive({ payload: `E2E-UNKNOWN-${Date.now()}` });
		await waitFor(() => refused.length === 2, 20000);
		const reasons = refused.map((msg) => msg.payload.reason).sort();
		assert.deepStrictEqual(reasons, ['list_not_found', 'unknown_person']);
	});

	for (const type of ['inwendo-erp-trigger', 'inwendo-erp-booking-schedule']) {
		it(`${type}: receives its events over the ERP MQTT broker`, async function () {
			await helper.load(NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: HOST },
				{ id: 't1', type, server: 'server', delivery: 'mqtt', mode: 'erp', entityType: 'CRMCompany', action: 'update', eventType: 'all', instanceId: 'nr-trg-e2e', wires: [['out']] },
				{ id: 'out', type: 'helper' },
			], { server: { apiToken: TOKEN } });
			const node = helper.getNode('t1');
			const statuses = [];
			node.on('call:status', (call) => statuses.push(call.args[0]));
			const last = await waitFor(() => statuses.find((status) => /connected \(mqtt\)|deaktiviert|failed/.test(status.text)), 30000);
			if (/deaktiviert/.test(last.text)) {
				this.skip();
			}
			assert.strictEqual(last.text, 'connected (mqtt)');
			if (type === 'inwendo-erp-trigger') {
				// a change in the ERP reaches the flow: ERP queue -> ERP MQTT broker -> node
				const sent = [];
				helper.getNode('out').on('input', (msg) => sent.push(msg));
				// changed like from the office: the ErpClient sends X-IW-Trigger-Source: nodered, and the
				// ERP never reports a change back to the client that made it
				const office = (method, path, body) => fetch(`${HOST}${path}`, {
					method,
					headers: { 'x-iw-jwt-token': TOKEN, 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}).then((res) => res.json());
				const company = await office('POST', '/api/crm/crmcompanies', { crmcompany: { companyName: `nr-trg-e2e ${Date.now()}` } });
				await office('PATCH', `/api/crm/crmcompanies/${company.id}`, { crmcompany: { shortName: 'NRT' } });
				const msg = await waitFor(() => sent.find((m) => m.payload.iw_entity_id === company.id), 30000);
				assert.strictEqual(msg.action, 'update');
				assert.strictEqual(msg.topic, `${msg.entityType}/update`);
			}
			await node.close(true);
		});
	}
});
