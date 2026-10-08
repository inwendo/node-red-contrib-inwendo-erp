'use strict';

const assert = require('assert');
const { ErpClient, InwendoErpError, buildUrl } = require('../nodes/lib/erp-client');
const { NonceCache, sign, verifyPushCommand } = require('../nodes/lib/lock-protocol');
const { wrapBody } = require('../nodes/lib/resources');
const { matches } = require('../nodes/inwendo-erp-trigger');
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

	it('filters trigger events like the n8n trigger', function () {
		const body = { iw_entity_class: 'Inwendo\\TimeTrackingBundle\\Entity\\WorkTimeEntry', iw_action: 'update' };
		assert.strictEqual(matches(body, 'TimeEntry', 'all'), false);
		assert.strictEqual(matches(body, 'WorkTimeEntry', 'update'), true);
		assert.strictEqual(matches(body, 'all', 'create'), false);
	});

	it('cleans what readers send', function () {
		assert.strictEqual(credentialOf(Buffer.from('04A1B2C3\r\n')), '04A1B2C3');
		assert.strictEqual(credentialOf(12345), '12345');
		assert.strictEqual(credentialOf('  '), null);
		assert.strictEqual(credentialOf({}), null);
	});
});
