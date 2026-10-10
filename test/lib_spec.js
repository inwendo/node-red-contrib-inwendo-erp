'use strict';

const assert = require('assert');
const { ErpClient, InwendoErpError, buildUrl, featureDisabledSetting } = require('../nodes/lib/erp-client');
const { NonceCache, sign, verifyPushCommand } = require('../nodes/lib/lock-protocol');
const fs = require('fs');
const path = require('path');
const { RESOURCES, wrapBody, operationsOf, needsId, pathOf, counterValueBody } = require('../nodes/lib/resources');
const { matches } = require('../nodes/inwendo-erp-trigger');
const { nextRegistrationDelay, triggerInstanceId, REREGISTER_MS } = require('../nodes/lib/webhook-registration');
const { TRIGGER_ENTITY_TYPES } = require('../nodes/lib/resources');
const { credentialOf } = require('../nodes/inwendo-erp-access-check');
const { startErpMock } = require('./helpers');

const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function command(overrides = {}) {
	return {
		type: 'iw_lock_command',
		instance_id: 'nr-instance-1',
		lock_id: 'front_door',
		command: 'open',
		ts: Math.floor(Date.now() / 1000),
		nonce: Math.random().toString(16).slice(2),
		...overrides,
	};
}

describe('erp client', function () {
	let erp;
	afterEach(async () => erp && erp.close());

	it('sends the API token and the trigger source', async function () {
		erp = await startErpMock({ 'GET /api/crm/crmcompanies/5': () => ({ body: { id: 5 } }) });
		const client = new ErpClient({ host: erp.host, apiToken: 'jwt-token' });

		assert.deepStrictEqual(await client.request('GET', '/api/crm/crmcompanies/5'), { id: 5 });
		assert.strictEqual(erp.requests[0].headers['x-iw-jwt-token'], 'jwt-token');
		assert.strictEqual(erp.requests[0].headers['x-iw-trigger-source'], 'nodered');
	});

	it('reports the ERP error code and message', async function () {
		erp = await startErpMock({
			'POST /api/nodered/smart_lock/register': () => ({ status: 400, headers: { 'X-IW-ERROR-CODE': '403', 'X-IW-ERROR-JSON': '["secret does not match"]' } }),
		});
		const client = new ErpClient({ host: erp.host, apiToken: 'jwt-token' });

		await assert.rejects(client.request('POST', '/api/nodered/smart_lock/register', { body: {} }), (error) => {
			assert.ok(error instanceof InwendoErpError);
			assert.strictEqual(error.erpCode, 403);
			assert.match(error.message, /secret does not match/);
			return true;
		});
	});

	it('reads all pages with the reported page count', async function () {
		erp = await startErpMock({
			'GET /api/crm/crmpeople': (request) => ({ body: [{ id: Number(request.query.page) }], headers: { 'X-IW-MAX-PAGES': '3' } }),
		});
		const client = new ErpClient({ host: erp.host, apiToken: 'jwt-token' });

		assert.deepStrictEqual(await client.requestAllItems('/api/crm/crmpeople', { searchString: 'x' }), [{ id: 0 }, { id: 1 }, { id: 2 }]);
		assert.strictEqual(erp.requests[0].query.withMaxPageNumber, 'nodered');
		assert.strictEqual(erp.requests[0].query.searchString, 'x');
	});

	it('detects functions switched off in the ERP by the error headers', async function () {
		erp = await startErpMock({
			'GET /api/event/bookable_occupancy': () => ({ status: 400, headers: { 'X-IW-ERROR-CODE': '404', 'X-IW-ERROR-JSON': '["feature disabled: integration_occupancy_api_enabled"]' } }),
			'GET /api/crm/tickets/3': () => ({ status: 400, headers: { 'X-IW-ERROR-CODE': '404', 'X-IW-ERROR-JSON': '["not found"]' } }),
			'GET /api/event/inventory_loan': () => ({ status: 400, headers: { 'X-IW-ERROR-CODE': '1585', 'X-IW-ERROR-JSON': '{"message":"Inventory loans are switched off"}' } }),
		});
		const client = new ErpClient({ host: erp.host, apiToken: 'jwt-token' });
		const errorOf = (path) => client.request('GET', path).then(() => null, (error) => error);

		assert.strictEqual(featureDisabledSetting(await errorOf('/api/event/bookable_occupancy')), 'integration_occupancy_api_enabled');
		assert.strictEqual(featureDisabledSetting(await errorOf('/api/crm/tickets/3')), null);
		assert.strictEqual(featureDisabledSetting(await errorOf('/api/event/inventory_loan')), 'event_inventory_enabled');
		assert.strictEqual(featureDisabledSetting(new Error('x')), null);
	});

	it('adds https to a host without scheme', function () {
		assert.strictEqual(buildUrl('demo.iw-erp.de/', '/api/x', { a: 1, b: '' }), 'https://demo.iw-erp.de/api/x?a=1');
	});
});

describe('lock protocol', function () {
	it('accepts a signed command once', function () {
		const nonces = new NonceCache();
		const body = JSON.stringify(command({ nonce: 'abc' }));
		const options = { rawBody: body, signature: sign(body, SECRET), secret: SECRET, instanceId: 'nr-instance-1', nonces };

		assert.strictEqual(verifyPushCommand(options).ok, true);
		assert.strictEqual(verifyPushCommand(options).error, 'command replayed');
	});

	it('rejects changed bodies, other instances and old commands', function () {
		const nonces = new NonceCache();
		const body = JSON.stringify(command());
		assert.strictEqual(verifyPushCommand({ rawBody: body.replace('open', 'lock'), signature: sign(body, SECRET), secret: SECRET, instanceId: 'nr-instance-1', nonces }).error, 'invalid signature');

		const other = JSON.stringify(command({ instance_id: 'nr-other-1' }));
		assert.strictEqual(verifyPushCommand({ rawBody: other, signature: sign(other, SECRET), secret: SECRET, instanceId: 'nr-instance-1', nonces }).ok, false);

		const old = JSON.stringify(command({ ts: Math.floor(Date.now() / 1000) - 61, valid_seconds: 30 }));
		const result = verifyPushCommand({ rawBody: old, signature: sign(old, SECRET), secret: SECRET, instanceId: 'nr-instance-1', nonces });
		assert.strictEqual(result.error, 'command expired');
		assert.strictEqual(result.command.lock_id, 'front_door');
	});

	it('allows some clock difference', function () {
		const body = JSON.stringify(command({ ts: Math.floor(Date.now() / 1000) - 50, valid_seconds: 30 }));
		assert.strictEqual(verifyPushCommand({ rawBody: body, signature: sign(body, SECRET), secret: SECRET, instanceId: 'nr-instance-1', nonces: new NonceCache() }).ok, true);
	});
});

describe('helpers', function () {
	it('wraps bodies in the form block once', function () {
		assert.deepStrictEqual(wrapBody('company', { companyName: 'ACME' }), { crmcompany: { companyName: 'ACME' } });
		assert.deepStrictEqual(wrapBody('company', { crmcompany: { companyName: 'ACME' } }), { crmcompany: { companyName: 'ACME' } });
		assert.deepStrictEqual(wrapBody('booking', { name: 'x' }), { data: { name: 'x' } });
	});

	it('builds the paths of the resources', function () {
		assert.strictEqual(pathOf('attendanceListEntry', 'getAll', { parentId: 9 }), '/api/event/attendancelist/9/entries');
		assert.strictEqual(pathOf('attendanceListEntry', 'create', { parentId: 9 }), '/api/event/attendancelist/9/entry');
		assert.strictEqual(pathOf('attendanceListEntry', 'update', { id: 31 }), '/api/event/attendancelist/31/entry');
		assert.strictEqual(pathOf('inventoryLoan', 'returnLoan', { id: 4 }), '/api/event/inventory_loan/4/return');
		assert.strictEqual(pathOf('inventoryLoan', 'stock', {}), '/api/event/inventory_loan_stock');
		assert.strictEqual(pathOf('inventoryLoan', 'availability', { id: 7 }), '/api/event/inventory_loan_availability/7');
		assert.strictEqual(pathOf('shiftPlanEntry', 'clockOut', { id: 5 }), '/api/time/shift_plan_entry/5/clock_out');
		assert.strictEqual(pathOf('usageCounter', 'setValue', { id: 3 }), '/api/event/base_bookable_usage_counter/3');
		assert.strictEqual(pathOf('occupancy', 'getOccupancy', {}), '/api/event/bookable_occupancy');
		assert.strictEqual(pathOf('company', 'get', { id: ' 5 ' }), '/api/crm/crmcompanies/5');
		assert.strictEqual(needsId('occupancy', 'getOccupancy'), false);
		assert.strictEqual(needsId('inventoryLoan', 'stock'), false);
		assert.strictEqual(needsId('userNotification', 'markRead'), true);
	});

	it('reads the usage counter value', function () {
		assert.deepStrictEqual(counterValueBody(1240.2), { data: { counterValue: 1240.2 } });
		assert.deepStrictEqual(counterValueBody('1240,5'), { data: { counterValue: 1240.5 } });
		assert.deepStrictEqual(counterValueBody({ value: 7 }), { data: { counterValue: 7 } });
		assert.throws(() => counterValueBody('abc'), /needs the reading/);
		assert.throws(() => counterValueBody(''), /needs the reading/);
	});

	it('offers the same resources and operations in the editor', function () {
		const html = fs.readFileSync(path.join(__dirname, '../nodes/inwendo-erp.html'), 'utf8');
		const block = html.slice(html.indexOf('const RESOURCES = {'), html.indexOf('const OPERATIONS = {'));
		const editor = Function(`'use strict'; ${block.replace('const RESOURCES =', 'return')}`)();
		assert.deepStrictEqual(Object.keys(editor).sort(), Object.keys(RESOURCES).sort());
		for (const [resource, entry] of Object.entries(editor)) {
			assert.strictEqual(entry[0], RESOURCES[resource].label, resource);
			assert.deepStrictEqual(entry[1], operationsOf(resource), resource);
			const withoutId = entry[2] || ['getAll', 'create'];
			for (const operation of entry[1]) {
				assert.strictEqual(!withoutId.includes(operation), needsId(resource, operation), `${resource} ${operation}`);
			}
		}
	});

	it('filters trigger events like the n8n trigger', function () {
		const body = { iw_entity_class: 'Inwendo\\TimeTrackingBundle\\Entity\\WorkTimeEntry', iw_action: 'update' };
		assert.strictEqual(matches(body, 'TimeEntry', 'all'), false);
		assert.strictEqual(matches(body, 'WorkTimeEntry', 'update'), true);
		assert.strictEqual(matches(body, 'all', 'create'), false);
		// check-in events: the short class is "attendancelistentry", the class name decides
		const checkIn = { iw_entity_class: 'Inwendo\\EventBundle\\Entity\\AttendanceListEntry', iw_entity_short_class: 'attendancelistentry', iw_action: 'create' };
		assert.strictEqual(matches(checkIn, 'AttendanceListEntry', 'create'), true);
		assert.strictEqual(matches(checkIn, 'AttendanceList', 'all'), false);
	});

	it('registers triggers again every day and before the MQTT access runs out', function () {
		const now = Date.parse('2026-10-11T12:00:00Z');
		assert.strictEqual(nextRegistrationDelay(null, now), REREGISTER_MS);
		assert.strictEqual(nextRegistrationDelay('2026-11-10T12:00:00Z', now), REREGISTER_MS);
		assert.strictEqual(nextRegistrationDelay('2026-10-11T15:00:00Z', now), 2 * 60 * 60 * 1000);
		assert.strictEqual(nextRegistrationDelay('2026-10-11T12:00:00Z', now), 60 * 1000);
		assert.strictEqual(nextRegistrationDelay('garbage', now), REREGISTER_MS);
	});

	it('gives every trigger its own MQTT instance id', function () {
		const id = triggerInstanceId('nr-trg-0011', 'a1b2c3');
		assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
		assert.strictEqual(triggerInstanceId('nr-trg-0011', 'a1b2c3'), id);
		assert.notStrictEqual(triggerInstanceId('nr-trg-0011', 'ffff'), id);
		assert.notStrictEqual(triggerInstanceId('nr-trg-0022', 'a1b2c3'), id);
	});

	it('offers the trigger entity types in the editor', function () {
		const html = fs.readFileSync(path.join(__dirname, '../nodes/inwendo-erp-trigger.html'), 'utf8');
		const block = html.slice(html.indexOf('const ENTITY_TYPES = ['), html.indexOf('];', html.indexOf('const ENTITY_TYPES = [')) + 2);
		const editor = Function(`'use strict'; ${block.replace('const ENTITY_TYPES =', 'return')}`)();
		assert.deepStrictEqual(Object.fromEntries(editor), TRIGGER_ENTITY_TYPES);
	});

	it('cleans what readers send', function () {
		assert.strictEqual(credentialOf(Buffer.from('04A1B2C3\r\n')), '04A1B2C3');
		assert.strictEqual(credentialOf(12345), '12345');
		assert.strictEqual(credentialOf('  '), null);
		assert.strictEqual(credentialOf({}), null);
	});
});
