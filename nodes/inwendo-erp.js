'use strict';

const { RESOURCES, OPERATIONS, LOCK_OPERATIONS, wrapBody, operationsOf, needsId, needsParent, pathOf } = require('./lib/resources');
const { featureDisabledSetting, featureDisabledText } = require('./lib/erp-client');

const GENERIC = 'genericRequest';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

module.exports = function (RED) {
	/**
	 * Reads and writes ERP data, like the n8n action node. Settings of the node can be overridden
	 * per message: msg.resource, msg.operation, msg.id, msg.query, msg.method, msg.endpoint;
	 * msg.payload is the body of create / update / generic requests.
	 */
	function InwendoErpNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;
		const server = RED.nodes.getNode(config.server);

		node.on('input', async (msg, send, done) => {
			if (!server) {
				done(new Error('vynst (inwendo ERP) connection is not configured'));
				return;
			}
			try {
				node.status({ fill: 'blue', shape: 'dot', text: 'request' });
				const result = await execute(server.client, config, msg);
				Object.assign(msg, result);
				node.status({});
				send(msg);
				done();
			} catch (error) {
				const disabled = featureDisabledSetting(error);
				msg.error = { message: error.message, statusCode: error.statusCode, erpCode: error.erpCode, erpDetails: error.erpDetails };
				if (disabled) {
					// the function is switched off in the ERP settings: a clear hint instead of an error code
					msg.error.featureDisabled = disabled;
					node.status({ fill: 'red', shape: 'ring', text: featureDisabledText(disabled) });
					done(new Error(featureDisabledText(disabled)));
					return;
				}
				node.status({ fill: 'red', shape: 'ring', text: error.erpCode ? `error ${error.erpCode}` : 'error' });
				done(error);
			}
		});
	}

	RED.nodes.registerType('inwendo-erp', InwendoErpNode);
};

function pick(msgValue, configValue) {
	return msgValue !== undefined && msgValue !== null && msgValue !== '' ? msgValue : configValue;
}

/**
 * @returns {Promise<object>} the message properties to set (payload, filename, contentType)
 */
async function execute(client, config, msg) {
	const resource = pick(msg.resource, config.resource);
	if (resource === GENERIC) {
		const method = String(pick(msg.method, config.method) || 'GET').toUpperCase();
		const endpoint = pick(msg.endpoint, config.endpoint);
		if (!METHODS.includes(method)) {
			throw new Error(`Unknown HTTP method: ${method}`);
		}
		if (!endpoint || !String(endpoint).startsWith('/')) {
			throw new Error('Endpoint must be a path like /api/crm/crmcompanies');
		}
		const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? msg.payload : undefined;
		return { payload: await client.request(method, endpoint, { body: isObject(body) || Array.isArray(body) ? body : undefined, qs: msg.query }) };
	}

	const definition = RESOURCES[resource];
	if (!definition) {
		throw new Error(`Unknown resource: ${resource}`);
	}
	const operation = pick(msg.operation, config.operation);
	if (!OPERATIONS.includes(operation)) {
		throw new Error(`Unknown operation: ${operation}`);
	}
	if (!operationsOf(resource).includes(operation)) {
		throw new Error(`${definition.label} does not support ${operation}`);
	}
	const id = pick(msg.id, config.entityId);
	if (needsId(resource, operation) && isBlank(id)) {
		throw new Error(`${definition.label}: ${operation} needs an id (node setting or msg.id)`);
	}
	const parentId = pick(msg.parentId, config.parentId);
	if (needsParent(resource, operation) && isBlank(parentId)) {
		throw new Error(`${definition.label}: ${operation} needs the ${definition.parent.label} (node setting or msg.parentId)`);
	}
	const path = pathOf(resource, operation, { id, parentId });

	const action = definition.actions && definition.actions[operation];
	if (action) {
		return { payload: await executeAction(client, resource, action, { id, msg, path }) };
	}

	switch (operation) {
		case 'get': {
			if (definition.getByListFilter) {
				const items = await client.request('GET', definition.path, { qs: { ...(isObject(msg.query) ? msg.query : {}), id: String(id).trim() } });
				const item = Array.isArray(items) ? items.find((entry) => entry && String(entry.id) === String(id).trim()) : null;
				if (!item) {
					throw new Error(`${definition.label} ${id} not found`);
				}
				return { payload: item };
			}
			return { payload: await client.request('GET', path, { qs: msg.query }) };
		}
		case 'getAll': {
			const qs = { ...(isObject(msg.query) ? msg.query : {}) };
			const searchString = pick(msg.searchString, config.searchString);
			if (searchString) {
				qs.searchString = searchString;
			}
			if (config.returnAll === true || msg.returnAll === true) {
				return { payload: await client.requestAllItems(path, qs) };
			}
			// the ERP only honours pageSize together with a (0-based) page
			const limit = Math.max(1, parseInt(pick(msg.limit, config.limit), 10) || 50);
			qs.page = qs.page !== undefined ? qs.page : '0';
			qs.pageSize = String(limit);
			const items = await client.request('GET', path, { qs });
			return { payload: Array.isArray(items) ? items.slice(0, limit) : items };
		}
		case 'create':
		case 'update': {
			if (definition.readOnly || (operation === 'update' && definition.noUpdate)) {
				throw new Error(`${definition.label} cannot be changed through the API`);
			}
			if (!isObject(msg.payload) || Object.keys(msg.payload).length === 0) {
				throw new Error(`${definition.label}: ${operation} needs the fields as object in msg.payload`);
			}
			// PATCH only changes the given fields; PUT would clear all others
			return { payload: await client.request(operation === 'create' ? 'POST' : 'PATCH', path, { body: wrapBody(resource, msg.payload) }) };
		}
		case 'getPdf': {
			if (!definition.pdf) {
				throw new Error(`${definition.label} has no PDF`);
			}
			const response = await client.requestFull('GET', `${path}/pdf`, { binary: true });
			return {
				payload: response.body,
				filename: `${resource}-${id}.pdf`,
				contentType: response.headers.get('content-type') || 'application/pdf',
			};
		}
		default: {
			if (!LOCK_OPERATIONS.includes(operation) || !definition.lockActions) {
				throw new Error(`${definition.label} does not support ${operation}`);
			}
			if (operation === 'status') {
				return { payload: await client.request('GET', `${path}/status`) };
			}
			return { payload: await client.request('POST', `${path}/${operation}`, { body: {} }) };
		}
	}
}

/**
 * Further operations of a resource (inventory loan return, clock in, usage counter value, ...).
 */
async function executeAction(client, resource, action, { id, msg, path }) {
	const qs = { ...(isObject(msg.query) ? msg.query : {}) };
	if (action.idQuery && !isBlank(id)) {
		qs[action.idQuery] = String(id).trim();
	}
	let body;
	if (typeof action.body === 'function') {
		body = action.body(msg.payload);
	} else if (action.body === 'payload') {
		if (isObject(msg.payload) && Object.keys(msg.payload).length > 0) {
			body = wrapBody(resource, msg.payload);
		} else if (action.requiresBody) {
			throw new Error(`${RESOURCES[resource].label}: the fields are missing in msg.payload`);
		} else {
			body = {};
		}
	}
	return client.request(action.method, path, { body, qs });
}

function isBlank(value) {
	return value === undefined || value === null || String(value).trim() === '';
}

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

module.exports.execute = execute;
