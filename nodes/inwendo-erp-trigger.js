'use strict';

const { createWebhookEndpoint } = require('./lib/webhook-endpoint');

module.exports = function (RED) {
	/**
	 * Starts a flow when an ERP entity is created, updated or deleted (like the n8n trigger). On deploy
	 * the node registers its webhook at /api/nodered/webhook; when the node is removed, it removes it.
	 * Delivery: https (the ERP calls the public https URL of this Node-RED) or the ERP's MQTT broker
	 * (only outgoing connections, ERP setting integration_mqtt_trigger_enabled).
	 */
	function InwendoErpTriggerNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;
		const server = RED.nodes.getNode(config.server);
		const entityType = config.entityType || 'all';
		const action = config.action || 'all';

		const endpoint = createWebhookEndpoint(RED, node, {
			server,
			delivery: config.delivery,
			publicUrl: config.publicUrl,
			instanceId: config.instanceId,
			referenceClassName: entityType === 'all' ? null : entityType,
			databaseAction: action === 'all' ? null : action,
			onEvent: (body) => {
				if (!matches(body, entityType, action)) {
					return;
				}
				node.send({
					payload: body,
					topic: `${body.iw_entity_short_class || ''}/${body.iw_action || ''}`,
					entityType: body.iw_entity_short_class,
					action: body.iw_action,
					// summary of smart lock log / check-in events (the ERP sends no entity data for them)
					webhookData: body.webhook_data,
				});
			},
		});
		node.on('close', (removed, done) => endpoint.close(removed).then(() => done(), () => done()));
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

module.exports.matches = matches;
