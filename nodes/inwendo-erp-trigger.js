'use strict';

const crypto = require('crypto');
const { readRawBody, publicUrl, removeRoute } = require('./lib/http');

module.exports = function (RED) {
	/**
	 * Starts a flow when an ERP entity is created, updated or deleted (like the n8n trigger). On deploy
	 * the node registers its webhook at /api/nodered/webhook; when the node is removed, it removes it.
	 * The ERP must reach Node-RED: the public base URL is the https address of this Node-RED.
	 */
	function InwendoErpTriggerNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;
		const server = RED.nodes.getNode(config.server);
		const entityType = config.entityType || 'all';
		const action = config.action || 'all';
		const path = `/inwendo-erp/webhook/${node.id}`;
		// a fresh token for every start: the registration is idempotent and updates it in place
		const token = crypto.randomBytes(24).toString('hex');
		const webhookUrl = config.publicUrl ? publicUrl(config.publicUrl, RED.settings.httpNodeRoot, path) : null;

		const handler = async (req, res) => {
			if (!timingSafeEqualString(String(req.headers['x-iw-webhook-token'] || ''), token)) {
				res.status(401).send('Unauthorized');
				return;
			}
			let body;
			try {
				const raw = await readRawBody(req);
				body = raw ? JSON.parse(raw) : {};
			} catch (error) {
				res.status(400).send('Invalid JSON');
				return;
			}
			res.status(200).send('OK');

			if (!matches(body, entityType, action)) {
				return;
			}
			node.send({
				payload: body,
				topic: `${body.iw_entity_short_class || ''}/${body.iw_action || ''}`,
				entityType: body.iw_entity_short_class,
				action: body.iw_action,
			});
		};
		RED.httpNode.post(path, handler);

		async function register() {
			if (!server) {
				node.status({ fill: 'red', shape: 'ring', text: 'no ERP connection' });
				return;
			}
			if (!webhookUrl || !/^https:\/\//i.test(webhookUrl)) {
				node.status({ fill: 'red', shape: 'ring', text: 'public https URL missing' });
				node.error('The ERP needs the public https:// base URL of this Node-RED to call the webhook');
				return;
			}
			try {
				await server.client.request('POST', '/api/nodered/webhook', {
					body: {
						webhook_url: webhookUrl,
						reference_class_name: entityType === 'all' ? null : entityType,
						database_action: action === 'all' ? null : action,
						webhook_token: token,
					},
				});
				node.status({ fill: 'green', shape: 'dot', text: 'registered' });
			} catch (error) {
				node.status({ fill: 'red', shape: 'ring', text: 'registration failed' });
				node.error(`Webhook registration failed: ${error.message}`);
			}
		}

		register();

		node.on('close', async (removed, done) => {
			removeRoute(RED.httpNode, path, 'post');
			if (removed && server && webhookUrl) {
				try {
					await server.client.request('DELETE', '/api/nodered/webhook', { body: { webhook_url: webhookUrl } });
				} catch (error) {
					node.warn(`Webhook could not be removed from the ERP: ${error.message}`);
				}
			}
			done();
		});
	}

	RED.nodes.registerType('inwendo-erp-trigger', InwendoErpTriggerNode);
};

/**
 * Entity filter as in the n8n trigger: the class name without namespace must match
 * ("TimeEntry" must not match "WorkTimeEntry").
 */
function matches(body, entityType, action) {
	if (entityType !== 'all') {
		const className = String(body.iw_entity_class || '').split('\\').pop();
		if (className !== entityType && body.iw_entity_short_class !== entityType) {
			return false;
		}
	}
	return action === 'all' || body.iw_action === action;
}

function timingSafeEqualString(a, b) {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports.matches = matches;
