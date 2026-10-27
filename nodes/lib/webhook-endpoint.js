'use strict';

const crypto = require('crypto');
const { readRawBody, publicUrl, removeRoute } = require('./http');
const { WebhookRegistration, triggerInstanceId } = require('./webhook-registration');

/**
 * Webhook of a trigger node in the ERP and how its events reach Node-RED: the https route
 * <Public URL>/inwendo-erp/webhook/<node id> (token checked) or the MQTT topic the ERP hands out.
 * Shared by the trigger and the booking schedule node.
 *
 * @returns {{registration: WebhookRegistration|null, close: function(boolean): Promise<void>}}
 */
function createWebhookEndpoint(RED, node, { server, delivery, publicUrl: baseUrl, instanceId, referenceClassName, databaseAction, onEvent }) {
	const mqtt = delivery === 'mqtt';
	const path = `/inwendo-erp/webhook/${node.id}`;
	// a fresh token for every start: the registration is idempotent and updates it in place
	const token = crypto.randomBytes(24).toString('hex');
	const webhookUrl = !mqtt && baseUrl ? publicUrl(baseUrl, RED.settings.httpNodeRoot, path) : null;
	let routed = false;

	if (!server) {
		node.status({ fill: 'red', shape: 'ring', text: 'no ERP connection' });
		return { registration: null, close: async () => {} };
	}
	if (!mqtt) {
		if (!webhookUrl || !/^https:\/\//i.test(webhookUrl)) {
			node.status({ fill: 'red', shape: 'ring', text: 'public https URL missing' });
			node.error('The ERP needs the public https:// base URL of this Node-RED to call the webhook (or choose delivery over the ERP MQTT broker)');
			return { registration: null, close: async () => {} };
		}
		RED.httpNode.post(path, async (req, res) => {
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
			onEvent(body);
		});
		routed = true;
	}

	const registration = new WebhookRegistration({
		node,
		server,
		delivery: mqtt ? 'mqtt' : 'https',
		instanceId: triggerInstanceId(instanceId, node.id),
		webhookUrl,
		referenceClassName,
		databaseAction,
		token,
		onEvent,
	});
	registration.register();

	return {
		registration,
		close: async (removed) => {
			if (routed) {
				removeRoute(RED.httpNode, path, 'post');
			}
			await registration.close(removed);
		},
	};
}

function timingSafeEqualString(a, b) {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = { createWebhookEndpoint };
