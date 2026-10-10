'use strict';

const assert = require('assert');
const supertest = require('supertest');
const helper = require('node-red-node-test-helper');
const { sign } = require('../nodes/lib/lock-protocol');
const { startErpMock, startMqttBroker, waitFor } = require('./helpers');

const configNode = require('../nodes/inwendo-erp-config');
const erpNode = require('../nodes/inwendo-erp');
const triggerNode = require('../nodes/inwendo-erp-trigger');
const bridgeNode = require('../nodes/inwendo-erp-lock-bridge');
const lockNode = require('../nodes/inwendo-erp-lock');
const lockResultNode = require('../nodes/inwendo-erp-lock-result');
const accessCheckNode = require('../nodes/inwendo-erp-access-check');
const bookingScheduleNode = require('../nodes/inwendo-erp-booking-schedule');

/** RED.httpNode of the test runtime: the routes of the trigger and the push bridge. */
let httpNode = null;
function captureHttpNode(RED) {
	httpNode = RED.httpNode;
}

const ALL_NODES = [captureHttpNode, configNode, erpNode, triggerNode, bridgeNode, lockNode, lockResultNode, accessCheckNode, bookingScheduleNode];
const INSTANCE = 'nr-test-instance-1';
const SECRET = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

helper.init(require.resolve('node-red'));

function lockCommand(overrides = {}) {
	return {
		type: 'iw_lock_command',
		instance_id: INSTANCE,
		lock_id: 'front_door',
		smart_lock_id: 7,
		command: 'open',
		ts: Math.floor(Date.now() / 1000),
		nonce: Math.random().toString(16).slice(2) + Date.now(),
		...overrides,
	};
}

function credentials(erp) {
	return {
		server: { apiToken: 'jwt-token' },
		bridge: { secret: SECRET },
	};
}

describe('inwendo erp nodes', function () {
	let erp;
	let broker;

	before(function (done) { helper.startServer(done); });
	after(function (done) { helper.stopServer(done); });
	afterEach(async function () {
		await helper.unload();
		if (erp) {
			await erp.close();
			erp = null;
		}
		if (broker) {
			await broker.close();
			broker = null;
		}
	});

	describe('inwendo-erp', function () {
		it('gets many entries with a limit', async function () {
			erp = await startErpMock({ 'GET /api/crm/crmcompanies': () => ({ body: [{ id: 1 }, { id: 2 }, { id: 3 }] }) });
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 'n1', type: 'inwendo-erp', server: 'server', resource: 'company', operation: 'getAll', limit: 2, searchString: 'ACME', wires: [['out']] },
				{ id: 'out', type: 'helper' },
			], credentials(erp));
			const out = helper.getNode('out');
			const received = new Promise((resolve) => out.on('input', resolve));
			helper.getNode('n1').receive({});
			const msg = await received;

			assert.deepStrictEqual(msg.payload, [{ id: 1 }, { id: 2 }]);
			assert.deepStrictEqual(erp.requests[0].query, { searchString: 'ACME', page: '0', pageSize: '2' });
		});

		it('creates with the payload in the form block and updates with PATCH', async function () {
			erp = await startErpMock({
				'POST /api/crm/crmpeople': (request) => ({ body: { id: 9, ...request.body.crmperson } }),
				'PATCH /api/crm/crmpeople/9': () => ({ body: { id: 9 } }),
			});
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 'n1', type: 'inwendo-erp', server: 'server', resource: 'person', operation: 'create', wires: [['out']] },
				{ id: 'out', type: 'helper' },
			], credentials(erp));
			const out = helper.getNode('out');
			const node = helper.getNode('n1');

			let received = new Promise((resolve) => out.on('input', resolve));
			node.receive({ payload: { firstName: 'Erika', lastName: 'Mustermann' } });
			assert.strictEqual((await received).payload.id, 9);
			assert.deepStrictEqual(erp.requests[0].body, { crmperson: { firstName: 'Erika', lastName: 'Mustermann' } });

			out.removeAllListeners('input');
			received = new Promise((resolve) => out.on('input', resolve));
			node.receive({ operation: 'update', id: 9, payload: { email: 'erika@example.com' } });
			await received;
			assert.strictEqual(erp.requests[1].method, 'PATCH');
			assert.deepStrictEqual(erp.requests[1].body, { crmperson: { email: 'erika@example.com' } });
		});

		it('downloads PDFs and opens smart locks', async function () {
			erp = await startErpMock({
				'GET /api/invoice/invoices/4/pdf': () => ({ body: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }),
				'POST /api/event/smart_lock/7/unlock': () => ({ body: { success: true } }),
			});
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 'n1', type: 'inwendo-erp', server: 'server', resource: 'invoice', operation: 'getPdf', wires: [['out']] },
				{ id: 'out', type: 'helper' },
			], credentials(erp));
			const out = helper.getNode('out');
			let received = new Promise((resolve) => out.on('input', resolve));
			helper.getNode('n1').receive({ id: 4 });
			const pdf = await received;
			assert.ok(Buffer.isBuffer(pdf.payload));
			assert.strictEqual(pdf.payload.toString(), '%PDF-1.4');
			assert.strictEqual(pdf.filename, 'invoice-4.pdf');

			out.removeAllListeners('input');
			received = new Promise((resolve) => out.on('input', resolve));
			helper.getNode('n1').receive({ resource: 'smartLock', operation: 'unlock', id: 7 });
			assert.deepStrictEqual((await received).payload, { success: true });
		});

		it('fails without id and with the ERP error', async function () {
			erp = await startErpMock({ 'GET /api/crm/tickets/3': () => ({ status: 400, headers: { 'X-IW-ERROR-CODE': '404', 'X-IW-ERROR-JSON': '["not found"]' } }) });
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 'n1', type: 'inwendo-erp', server: 'server', resource: 'ticket', operation: 'get', wires: [['out']] },
				{ id: 'out', type: 'helper' },
			], credentials(erp));
			const errors = [];
			const node = helper.getNode('n1');
			node.on('call:error', (call) => errors.push(call.args[0]));
			node.receive({});
			node.receive({ id: 3 });
			await waitFor(() => errors.length === 2);
			const messages = errors.map((error) => String(error.message || error)).sort();
			assert.match(messages.join('|'), /needs an id/);
			assert.match(messages.join('|'), /error 404: \["not found"\]/);
		});
	});

	describe('inwendo-erp: more resources', function () {
		async function loadErpNode(routes, nodeConfig) {
			erp = await startErpMock(routes);
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 'n1', type: 'inwendo-erp', server: 'server', wires: [['out']], ...nodeConfig },
				{ id: 'out', type: 'helper' },
			], credentials(erp));
			return helper.getNode('n1');
		}

		function request(node, msg) {
			const out = helper.getNode('out');
			out.removeAllListeners('input');
			const received = new Promise((resolve) => out.on('input', resolve));
			node.receive(msg);
			return received;
		}

		it('reads and writes attendance list entries of a list', async function () {
			const node = await loadErpNode({
				'GET /api/event/attendancelist/9/entries': () => ({ body: [{ id: 31 }] }),
				'POST /api/event/attendancelist/9/entry': (req) => ({ body: { id: 32, ...req.body.data } }),
				'PATCH /api/event/attendancelist/32/entry': () => ({ body: { id: 32 } }),
			}, { resource: 'attendanceListEntry', operation: 'getAll', parentId: '9', limit: 10 });

			assert.deepStrictEqual((await request(node, {})).payload, [{ id: 31 }]);
			await request(node, { operation: 'create', payload: { name: 'Gast' } });
			assert.deepStrictEqual(erp.requests[1].body, { data: { name: 'Gast' } });
			await request(node, { operation: 'update', id: 32, payload: { end: '2026-10-11 19:00' } });
			assert.strictEqual(erp.requests[2].method, 'PATCH');
		});

		it('returns inventory loans, sets counter values and clocks in', async function () {
			const node = await loadErpNode({
				'PATCH /api/event/inventory_loan/4/return': () => ({ body: { id: 4, state: 'RETURNED' } }),
				'GET /api/event/inventory_loan_availability/7': (req) => ({ body: { quantity: 3, used: 1, available: 2, query: req.query } }),
				'PATCH /api/event/base_bookable_usage_counter/3': () => ({ body: { id: 3, counter_value: 1240.2 } }),
				'POST /api/time/shift_plan_entry/5/clock_in': () => ({ body: { id: 99, start: '2026-10-11T08:00:00+02:00' } }),
				'GET /api/notification/user_notification': () => ({ body: [{ id: 6, read: false }] }),
				'PUT /api/notification/user_notification/6': () => ({ body: { id: 6, read: true } }),
			}, { resource: 'inventoryLoan', operation: 'returnLoan' });

			assert.strictEqual((await request(node, { id: 4, payload: { condition: 'ok', retained_amount: 0 } })).payload.state, 'RETURNED');
			assert.deepStrictEqual(erp.requests[0].body, { data: { condition: 'ok', retained_amount: 0 } });

			const availability = await request(node, { operation: 'availability', id: 7, query: { start: '2026-10-11 10:00', end: '2026-10-11 12:00' } });
			assert.strictEqual(availability.payload.available, 2);
			assert.deepStrictEqual(availability.payload.query, { start: '2026-10-11 10:00', end: '2026-10-11 12:00' });

			await request(node, { resource: 'usageCounter', operation: 'setValue', id: 3, payload: 1240.2 });
			assert.deepStrictEqual(erp.requests[2].body, { data: { counterValue: 1240.2 } });

			assert.strictEqual((await request(node, { resource: 'shiftPlanEntry', operation: 'clockIn', id: 5 })).payload.id, 99);

			assert.deepStrictEqual((await request(node, { resource: 'userNotification', operation: 'get', id: 6 })).payload, { id: 6, read: false });
			assert.strictEqual(erp.requests[4].query.id, '6');
			await request(node, { resource: 'userNotification', operation: 'markRead', id: 6 });
			assert.deepStrictEqual(erp.requests[5].body, { data: { read: true } });
		});

		it('reads the occupancy and shows a function switched off in the ERP', async function () {
			let enabled = true;
			const node = await loadErpNode({
				'GET /api/event/bookable_occupancy': (req) => (enabled
					? { body: { generated_at: 'now', bookables: [{ id: Number(req.query.bookable), occupied: true }] } }
					: { status: 400, headers: { 'X-IW-ERROR-CODE': '404', 'X-IW-ERROR-JSON': '["feature disabled: integration_occupancy_api_enabled"]' } }),
			}, { resource: 'occupancy', operation: 'getOccupancy', entityId: '7' });

			assert.strictEqual((await request(node, {})).payload.bookables[0].occupied, true);
			assert.strictEqual(erp.requests[0].query.bookable, '7');

			enabled = false;
			const errors = [];
			const statuses = [];
			node.on('call:error', (call) => errors.push(call.args[0]));
			node.on('call:status', (call) => statuses.push(call.args[0]));
			node.receive({});
			await waitFor(() => errors.length === 1);
			assert.match(String(errors[0].message || errors[0]), /Funktion im ERP deaktiviert: integration_occupancy_api_enabled/);
			assert.deepStrictEqual(statuses[statuses.length - 1], { fill: 'red', shape: 'ring', text: 'Funktion im ERP deaktiviert: integration_occupancy_api_enabled' });
		});

		it('rejects operations a resource does not offer', async function () {
			const node = await loadErpNode({}, { resource: 'occupancy', operation: 'getOccupancy' });
			const errors = [];
			node.on('call:error', (call) => errors.push(call.args[0]));
			node.receive({ operation: 'create', payload: { a: 1 } });
			node.receive({ resource: 'attendanceListEntry', operation: 'getAll' });
			await waitFor(() => errors.length === 2);
			const messages = errors.map((error) => String(error.message || error)).join('|');
			assert.match(messages, /Occupancy does not support create/);
			assert.match(messages, /needs the Attendance list ID/);
			assert.strictEqual(erp.requests.length, 0);
		});
	});

	describe('inwendo-erp-trigger', function () {
		it('registers its webhook and passes matching events with the right token', async function () {
			erp = await startErpMock({ 'POST /api/nodered/webhook': () => ({ body: { status: 'registered', webhook_id: 3 } }) });
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 't1', type: 'inwendo-erp-trigger', server: 'server', entityType: 'CRMCompany', action: 'update', publicUrl: 'https://nodered.example.com/', wires: [['out']] },
				{ id: 'out', type: 'helper' },
			], credentials(erp));
			await waitFor(() => erp.requests.length === 1);
			const registration = erp.requests[0].body;
			assert.strictEqual(registration.webhook_url, 'https://nodered.example.com/inwendo-erp/webhook/t1');
			assert.strictEqual(registration.reference_class_name, 'CRMCompany');
			assert.strictEqual(registration.database_action, 'update');

			const received = [];
			helper.getNode('out').on('input', (msg) => received.push(msg));
			await supertest(httpNode).post('/inwendo-erp/webhook/t1').set('X-IW-Webhook-Token', 'wrong').send({ iw_action: 'update' }).expect(401);
			await supertest(httpNode).post('/inwendo-erp/webhook/t1').set('X-IW-Webhook-Token', registration.webhook_token).set('Content-Type', 'application/json')
				.send(JSON.stringify({ iw_action: 'create', iw_entity_short_class: 'CRMCompany' })).expect(200);
			await supertest(httpNode).post('/inwendo-erp/webhook/t1').set('X-IW-Webhook-Token', registration.webhook_token).set('Content-Type', 'application/json')
				.send(JSON.stringify({ iw_action: 'update', iw_entity_short_class: 'CRMCompany', id: 5 })).expect(200);
			await waitFor(() => received.length === 1);
			assert.strictEqual(received[0].payload.id, 5);
			assert.strictEqual(received[0].topic, 'CRMCompany/update');
		});
	});

	describe('inwendo-erp-trigger over the ERP MQTT broker', function () {
		it('registers with delivery mqtt, receives the events on the topic and unregisters', async function () {
			broker = await startMqttBroker();
			const topic = 'erp.example.com/nodered/x/events';
			erp = await startErpMock({
				'POST /api/nodered/webhook': () => ({
					body: {
						status: 'registered', webhook_id: 5,
						mqtt: { url: broker.url, username: 'nodered@erp', password: 'mqtt-jwt', client_id: 'erp_trigger', topic, valid_until: new Date(Date.now() + 30 * 86400000).toISOString() },
					},
				}),
				'DELETE /api/nodered/webhook': () => ({ body: { status: 'unregistered', count: 1 } }),
			});
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 't1', type: 'inwendo-erp-trigger', server: 'server', entityType: 'SmartLockLog', action: 'create', delivery: 'mqtt', instanceId: 'nr-trg-abcdef', publicUrl: '', wires: [['out']] },
				{ id: 'out', type: 'helper' },
			], credentials(erp));
			const statuses = [];
			helper.getNode('t1').on('call:status', (call) => statuses.push(call.args[0]));
			await waitFor(() => broker.aedes.connectedClients === 1);
			await waitFor(() => statuses.some((status) => status.text === 'connected (mqtt)'));

			const registration = erp.requests[0].body;
			assert.strictEqual(registration.delivery, 'mqtt');
			assert.match(registration.instance_id, /^[A-Za-z0-9_-]{8,64}$/);
			assert.strictEqual(registration.webhook_url, undefined);
			assert.strictEqual(registration.reference_class_name, 'SmartLockLog');
			assert.strictEqual(registration.database_action, 'create');

			const received = [];
			helper.getNode('out').on('input', (msg) => received.push(msg));
			const webhookData = { type: 'access', smart_lock_id: 4, smart_lock_name: 'Haupteingang', action: 'unlock', success: true, person_id: 55, person_name: 'Max Mustermann', source: 'app', at: '2026-10-11T18:00:00+02:00' };
			await broker.publish(topic, JSON.stringify({ iw_action: 'update', iw_entity_class: 'Inwendo\\EventBundle\\Entity\\SmartLockLog', iw_entity_short_class: 'smart_lock_log', iw_entity_id: 8 }));
			await broker.publish(topic, 'no json');
			await broker.publish(topic, JSON.stringify({ iw_action: 'create', iw_entity_class: 'Inwendo\\EventBundle\\Entity\\SmartLockLog', iw_entity_short_class: 'smart_lock_log', iw_entity_id: 9, webhook_data: webhookData }));
			await waitFor(() => received.length === 1);
			assert.strictEqual(received[0].payload.iw_entity_id, 9);
			assert.deepStrictEqual(received[0].webhookData, webhookData);
			assert.strictEqual(received[0].topic, 'smart_lock_log/create');

			await helper.getNode('t1').close(true);
			const removal = erp.requests.find((request) => request.method === 'DELETE');
			assert.deepStrictEqual(removal.body, { instance_id: registration.instance_id });
		});

		it('shows a trigger delivery switched off in the ERP', async function () {
			erp = await startErpMock({
				'POST /api/nodered/webhook': () => ({ status: 400, headers: { 'X-IW-ERROR-CODE': '404', 'X-IW-ERROR-JSON': '["feature disabled: integration_mqtt_trigger_enabled"]' } }),
			});
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 't1', type: 'inwendo-erp-trigger', server: 'server', entityType: 'all', action: 'all', delivery: 'mqtt', wires: [['out']] },
				{ id: 'out', type: 'helper' },
			], credentials(erp));
			const node = helper.getNode('t1');
			const statuses = [];
			const errors = [];
			node.on('call:status', (call) => statuses.push(call.args[0]));
			node.on('call:error', (call) => errors.push(call.args[0]));
			await waitFor(() => statuses.length > 0);
			assert.deepStrictEqual(statuses[statuses.length - 1], { fill: 'red', shape: 'ring', text: 'Funktion im ERP deaktiviert: integration_mqtt_trigger_enabled' });
			assert.strictEqual(errors.length, 0);
			// no retry storm: checked again the next day
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.strictEqual(erp.requests.length, 1);
		});
	});

	describe('inwendo-erp-booking-schedule', function () {
		function timedEvent(type, overrides = {}) {
			return {
				iw_action: type,
				iw_entity_class: 'Inwendo\\EventBundle\\Entity\\BaseBooking',
				iw_entity_short_class: 'booking',
				iw_entity_id: 123,
				iw_timed_event: {
					type, due_at: '2026-10-11T18:00:00+02:00', booking_id: 123, booking_title: 'Training U12',
					start: '2026-10-11T18:00:00+02:00', end: '2026-10-11T19:30:00+02:00',
					bookable_id: 7, bookable_name: 'Halle 1', location_id: 2, location_name: 'Sportzentrum',
					participants: 14, pre_start_minutes: 30, post_end_minutes: 15, ...overrides,
				},
				data: { id: 123 },
			};
		}

		it('registers for the timed events and passes those of its bookables', async function () {
			erp = await startErpMock({ 'POST /api/nodered/webhook': () => ({ body: { status: 'registered', webhook_id: 4 } }) });
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 's1', type: 'inwendo-erp-booking-schedule', server: 'server', mode: 'erp', delivery: 'https', publicUrl: 'https://nodered.example.com', eventType: 'all', bookables: 'Halle 1', wires: [['out']] },
				{ id: 'out', type: 'helper' },
			], credentials(erp));
			await waitFor(() => erp.requests.length === 1);
			const registration = erp.requests[0].body;
			assert.strictEqual(registration.database_action, 'booking_timed');
			assert.strictEqual(registration.reference_class_name, 'BaseBooking');
			assert.strictEqual(registration.webhook_url, 'https://nodered.example.com/inwendo-erp/webhook/s1');

			const received = [];
			helper.getNode('out').on('input', (msg) => received.push(msg));
			const post = (body) => supertest(httpNode).post('/inwendo-erp/webhook/s1').set('X-IW-Webhook-Token', registration.webhook_token)
				.set('Content-Type', 'application/json').send(JSON.stringify(body)).expect(200);
			await post(timedEvent('booking_start', { bookable_id: 8, bookable_name: 'Halle 2' }));
			await post({ iw_action: 'update', iw_entity_short_class: 'booking', data: {} });
			await post(timedEvent('booking_pre_start'));
			await waitFor(() => received.length === 1);
			assert.strictEqual(received[0].topic, 'Halle 1/booking_pre_start');
			assert.strictEqual(received[0].payload.participants, 14);
			assert.strictEqual(received[0].eventType, 'booking_pre_start');
			assert.deepStrictEqual(received[0].booking, { id: 123 });
			assert.strictEqual(received[0].source, 'erp');
		});

		it('registers for one event type and shows when the ERP has the timed events switched off', async function () {
			erp = await startErpMock({
				'POST /api/nodered/webhook': () => ({ status: 400, headers: { 'X-IW-ERROR-CODE': '404', 'X-IW-ERROR-JSON': '["feature disabled: integration_booking_timed_events_enabled"]' } }),
			});
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 's1', type: 'inwendo-erp-booking-schedule', server: 'server', mode: 'erp', delivery: 'mqtt', eventType: 'booking_end', wires: [['out']] },
				{ id: 'out', type: 'helper' },
			], credentials(erp));
			const node = helper.getNode('s1');
			const statuses = [];
			node.on('call:status', (call) => statuses.push(call.args[0]));
			await waitFor(() => statuses.length > 0);
			assert.strictEqual(erp.requests[0].body.database_action, 'booking_end');
			assert.strictEqual(erp.requests[0].body.delivery, 'mqtt');
			assert.strictEqual(statuses[statuses.length - 1].text, 'Funktion im ERP deaktiviert: integration_booking_timed_events_enabled');
		});

		it('reads the bookings and sends the events itself (fallback)', async function () {
			const start = new Date(Date.now() + 300);
			const end = new Date(Date.now() + 600);
			erp = await startErpMock({
				'GET /api/event/base_booking': (req) => ({
					body: Number(req.query.page) > 0 ? [] : [
						{ id: 1, name: 'Training', start_time: start.toISOString(), end_time: end.toISOString(), deleted: false, baseBookable: { id: 7, name: 'Halle 1' }, baseLocation: { id: 2, name: 'Sportzentrum' } },
						{ id: 2, name: 'Abgesagt', start_time: start.toISOString(), end_time: end.toISOString(), deleted: false, booking_status: 'FCS_CANCELLED_BY_BLOCKING', baseBookable: { id: 7, name: 'Halle 1' } },
					],
					headers: { 'X-IW-MAX-PAGES': '1' },
				}),
			});
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 's1', type: 'inwendo-erp-booking-schedule', server: 'server', mode: 'poll', eventType: 'all', bookables: '7', preStartMinutes: 0, postEndMinutes: 0, pollInterval: 5, wires: [['out']] },
				{ id: 'out', type: 'helper' },
			], credentials(erp));
			const received = [];
			helper.getNode('out').on('input', (msg) => received.push(msg));
			await waitFor(() => received.length === 4);
			assert.deepStrictEqual(received.map((msg) => msg.topic), ['Halle 1/booking_pre_start', 'Halle 1/booking_start', 'Halle 1/booking_end', 'Halle 1/booking_post_end']);
			assert.strictEqual(received[1].payload.booking_id, 1);
			assert.strictEqual(received[1].payload.location_name, 'Sportzentrum');
			assert.strictEqual(received[1].booking.name, 'Training');
			assert.strictEqual(received[1].source, 'poll');
			const query = erp.requests[0].query;
			assert.strictEqual(query.baseBookableIN, '7');
			assert.match(query.startTimeCMP, /^lte,IW_DATE_TIME_\d+$/);
		});
	});

	describe('lock bridge over MQTT', function () {
		async function loadBridge(lockOptions = {}, extraNodes = []) {
			broker = await startMqttBroker();
			const topic = `erp/nodered/${INSTANCE}/command`;
			erp = await startErpMock({
				'POST /api/nodered/smart_lock/register': () => ({
					body: {
						status: 'created', connection_id: 5, locks: 1, smart_locks: 1,
						mqtt: { url: broker.url, username: 'nodered@erp', password: 'mqtt-jwt', client_id: 'erp_nodered', topic },
					},
				}),
				'POST /api/nodered/smart_lock/commands/31/result': () => ({ body: { status: 'succeeded' } }),
				'DELETE /api/nodered/smart_lock/register': () => ({ body: { status: 'unregistered' } }),
			});
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 'bridge', type: 'inwendo-erp-lock-bridge', server: 'server', name: 'Vereinsheim', instanceId: INSTANCE, delivery: 'mqtt' },
				{ id: 'lock', type: 'inwendo-erp-lock', bridge: 'bridge', lockId: 'front_door', lockName: 'Haupteingang', unlockMethod: 'qr_code', wires: [['out']], ...lockOptions },
				{ id: 'out', type: 'helper' },
				...extraNodes,
			], credentials(erp));
			const bridge = helper.getNode('bridge');
			await waitFor(() => bridge.mqttClient && bridge.mqttClient.connected && broker.aedes.connectedClients === 1);
			// the subscription is set up right after connecting
			await new Promise((resolve) => setTimeout(resolve, 100));
			return { topic, bridge };
		}

		function envelope(command, secret = SECRET) {
			const body = JSON.stringify(command);
			return JSON.stringify({ body, signature: sign(body, secret) });
		}

		it('registers the locks and executes signed commands from MQTT', async function () {
			const { topic } = await loadBridge();
			const registration = erp.requests.find((request) => request.path === '/api/nodered/smart_lock/register').body;
			assert.strictEqual(registration.instance_id, INSTANCE);
			assert.strictEqual(registration.secret, SECRET);
			assert.strictEqual(registration.delivery, 'mqtt');
			assert.deepStrictEqual(registration.locks, [{ id: 'front_door', name: 'Haupteingang', state: 'unknown', unlock_method: 'qr_code' }]);

			const received = [];
			helper.getNode('out').on('input', (msg) => received.push(msg));
			await broker.publish(topic, envelope(lockCommand({ command_id: 31, valid_seconds: 30 })));
			await waitFor(() => received.length === 1);
			assert.strictEqual(received[0].payload.command, 'open');
			assert.strictEqual(received[0].payload.command_id, 31);
			assert.strictEqual(received[0].payload.smart_lock_id, 7);

			const result = await waitFor(() => erp.requests.find((request) => request.path === '/api/nodered/smart_lock/commands/31/result'));
			assert.strictEqual(result.body.success, true);
			assert.strictEqual(result.body.secret, SECRET);
		});

		it('ignores unsigned commands and reports expired ones as failed', async function () {
			const { topic } = await loadBridge();
			const received = [];
			helper.getNode('out').on('input', (msg) => received.push(msg));

			await broker.publish(topic, envelope(lockCommand({ command_id: 31 }), 'f'.repeat(64)));
			await broker.publish(topic, envelope(lockCommand({ command_id: 31, valid_seconds: 30, ts: Math.floor(Date.now() / 1000) - 120 })));
			const result = await waitFor(() => erp.requests.find((request) => request.path === '/api/nodered/smart_lock/commands/31/result'));
			assert.strictEqual(result.body.success, false);
			assert.strictEqual(result.body.message, 'command expired');
			assert.strictEqual(received.length, 0);
		});

		it('waits for the lock result node', async function () {
			const { topic } = await loadBridge({ confirm: 'manual', resultTimeout: 5 }, [{ id: 'done', type: 'inwendo-erp-lock-result' }]);
			// the flow behind the lock: the relay reports a failure
			helper.getNode('out').on('input', (msg) => {
				helper.getNode('done').receive({ ...msg, success: false, message: 'relay offline', state: 'jammed' });
			});
			await broker.publish(topic, envelope(lockCommand({ command_id: 31, valid_seconds: 30 })));
			const result = await waitFor(() => erp.requests.find((request) => request.path === '/api/nodered/smart_lock/commands/31/result'));
			assert.deepStrictEqual({ success: result.body.success, message: result.body.message, state: result.body.state }, { success: false, message: 'relay offline', state: 'jammed' });
		});

		it('reports lock states with the registration and unregisters when removed', async function () {
			const { bridge } = await loadBridge();
			helper.getNode('lock').receive({ payload: 'Locked' });
			await waitFor(() => erp.requests.filter((request) => request.path === '/api/nodered/smart_lock/register' && request.method === 'POST').length === 2);
			const second = erp.requests.filter((request) => request.method === 'POST' && request.path === '/api/nodered/smart_lock/register')[1];
			assert.strictEqual(second.body.locks[0].state, 'locked');

			await bridge.close(true);
			assert.ok(erp.requests.find((request) => request.method === 'DELETE'));
		});
	});

	describe('lock bridge with push', function () {
		it('executes signed push commands and answers with the result', async function () {
			erp = await startErpMock({ 'POST /api/nodered/smart_lock/register': () => ({ body: { status: 'created', smart_locks: 1 } }) });
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 'bridge', type: 'inwendo-erp-lock-bridge', server: 'server', instanceId: INSTANCE, delivery: 'push', publicUrl: 'https://nodered.example.com' },
				{ id: 'lock', type: 'inwendo-erp-lock', bridge: 'bridge', lockId: 'front_door', wires: [['out']] },
				{ id: 'out', type: 'helper' },
			], credentials(erp));
			await waitFor(() => erp.requests.length === 1);
			assert.strictEqual(erp.requests[0].body.webhook_url, `https://nodered.example.com/inwendo-erp/lock/${INSTANCE}`);
			assert.strictEqual(erp.requests[0].body.delivery, 'push');

			const body = JSON.stringify(lockCommand({ command: 'lock' }));
			const received = new Promise((resolve) => helper.getNode('out').on('input', resolve));
			const response = await supertest(httpNode).post(`/inwendo-erp/lock/${INSTANCE}`).set('Content-Type', 'application/json').set('X-IW-Signature', sign(body, SECRET)).send(body).expect(200);
			assert.strictEqual(response.body.success, true);
			assert.strictEqual((await received).payload.command, 'lock');

			// the same command again is a replay
			await supertest(httpNode).post(`/inwendo-erp/lock/${INSTANCE}`).set('Content-Type', 'application/json').set('X-IW-Signature', sign(body, SECRET)).send(body).expect(400);
			await supertest(httpNode).post(`/inwendo-erp/lock/${INSTANCE}`).set('Content-Type', 'application/json').set('X-IW-Signature', '0'.repeat(64)).send(body).expect(401);
		});
	});

	describe('inwendo-erp-access-check', function () {
		it('sends the credential and routes the answer', async function () {
			erp = await startErpMock({
				'POST /api/nodered/smart_lock/register': () => ({ body: { status: 'created', smart_locks: 1, mqtt: null } }),
				'POST /api/nodered/smart_lock/check_access': (request) => ({
					body: request.body.credential === '04A1B2C3'
						? { granted: true, reason: 'granted', person: { id: 4, name: 'Erika Mustermann' }, smart_lock: { id: 7 } }
						: { granted: false, reason: 'unknown_credential', person: null, smart_lock: { id: 7 } },
				}),
			});
			await helper.load(ALL_NODES, [
				{ id: 'server', type: 'inwendo-erp-config', host: erp.host },
				{ id: 'bridge', type: 'inwendo-erp-lock-bridge', server: 'server', instanceId: INSTANCE, delivery: 'push', publicUrl: 'https://nodered.example.com' },
				{ id: 'check', type: 'inwendo-erp-access-check', target: 'bridgeLock', bridge: 'bridge', lockId: 'front_door', credentialType: 'auto', wires: [['granted'], ['denied']] },
				{ id: 'check2', type: 'inwendo-erp-access-check', target: 'smartLock', server: 'server', smartLockId: '12', open: true, credentialType: 'card', wires: [['granted'], ['denied']] },
				{ id: 'granted', type: 'helper' },
				{ id: 'denied', type: 'helper' },
			], credentials(erp));
			const granted = [];
			const denied = [];
			helper.getNode('granted').on('input', (msg) => granted.push(msg));
			helper.getNode('denied').on('input', (msg) => denied.push(msg));

			helper.getNode('check').receive({ payload: Buffer.from('04A1B2C3\r\n') });
			helper.getNode('check').receive({ payload: 'UNKNOWN' });
			helper.getNode('check2').receive({ payload: 4711 });
			await waitFor(() => granted.length + denied.length === 3);

			const checks = erp.requests.filter((request) => request.path === '/api/nodered/smart_lock/check_access').map((request) => request.body);
			assert.deepStrictEqual(checks.find((body) => body.credential === '04A1B2C3'), { credential: '04A1B2C3', credential_type: 'auto', open: false, instance_id: INSTANCE, lock_id: 'front_door' });
			assert.deepStrictEqual(checks.find((body) => body.credential === '4711'), { credential: '4711', credential_type: 'card', open: true, smart_lock_id: 12 });
			assert.strictEqual(granted.length, 1);
			assert.strictEqual(granted[0].granted, true);
			assert.strictEqual(granted[0].person.name, 'Erika Mustermann');
			assert.strictEqual(denied.length, 2);
			assert.strictEqual(denied[0].payload.reason, 'unknown_credential');
		});
	});
});
