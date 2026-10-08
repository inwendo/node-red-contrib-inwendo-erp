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

/** RED.httpNode of the test runtime: the routes of the trigger and the push bridge. */
let httpNode = null;
function captureHttpNode(RED) {
	httpNode = RED.httpNode;
}

const ALL_NODES = [captureHttpNode, configNode, erpNode, triggerNode, bridgeNode, lockNode, lockResultNode, accessCheckNode];
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
