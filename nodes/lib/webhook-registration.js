'use strict';

const crypto = require('crypto');

const { ErpMqttSubscription } = require('./mqtt-subscription');
const { featureDisabledSetting, featureDisabledText } = require('./erp-client');

/** Registered again every day: heals a lost webhook and renews the MQTT password (valid 30 days). */
const REREGISTER_MS = 24 * 60 * 60 * 1000;
/** Renew this long before the MQTT access runs out. */
const RENEW_BEFORE_MS = 60 * 60 * 1000;
const MIN_REREGISTER_MS = 60 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const DELIVERIES = ['https', 'mqtt'];

/**
 * Time until the next registration: every 24 h, earlier when the MQTT access runs out before.
 */
function nextRegistrationDelay(validUntil, now = Date.now()) {
	const until = validUntil ? Date.parse(validUntil) : NaN;
	if (!Number.isFinite(until)) {
		return REREGISTER_MS;
	}
	return Math.max(MIN_REREGISTER_MS, Math.min(REREGISTER_MS, until - now - RENEW_BEFORE_MS));
}

/**
 * Instance id of a trigger delivered over MQTT (8-64 characters of A-Z a-z 0-9 _ -): derived from
 * the random id generated in the editor and the node id, so a copied node (same editor id, new node
 * id) and the same flow in another Node-RED (other editor id) get their own webhook in the ERP.
 */
function triggerInstanceId(configured, nodeId) {
	const hash = crypto.createHash('sha256').update(`${String(configured || '')}|${String(nodeId || '')}`).digest('hex');
	return `nrt-${hash.slice(0, 32)}`;
}

/**
 * The webhook of a trigger node in the ERP (/api/nodered/webhook), delivered as https POST to
 * Node-RED (the node serves the route) or over the ERP's MQTT broker (no public URL needed).
 *
 * The registration is repeated every 24 h and before the MQTT access runs out; failures are retried
 * with backoff. A function switched off in the ERP shows "Funktion im ERP deaktiviert: <setting>",
 * is logged once and checked again the next day.
 */
class WebhookRegistration {
	/**
	 * @param {{
	 *   node: object, server: object,
	 *   delivery: 'https'|'mqtt', instanceId?: string, webhookUrl?: string,
	 *   referenceClassName: string|null, databaseAction: string|null, token: string,
	 *   onEvent: function(object): void,
	 *   mqttFactory?: function(string, object): object,
	 * }} options
	 */
	constructor(options) {
		this.node = options.node;
		this.server = options.server;
		this.delivery = DELIVERIES.includes(options.delivery) ? options.delivery : 'https';
		this.instanceId = options.instanceId;
		this.webhookUrl = options.webhookUrl;
		this.referenceClassName = options.referenceClassName;
		this.databaseAction = options.databaseAction;
		this.token = options.token;
		this.onEvent = options.onEvent;
		this.timer = null;
		this.failures = 0;
		this.closed = false;
		this.registered = false;
		this.disabledSetting = null;
		this.subscription = this.delivery === 'mqtt'
			? new ErpMqttSubscription({
				clientIdBase: this.instanceId,
				factory: options.mqttFactory,
				onMessage: (text) => this.handleMessage(text),
				onState: (state, error) => this.handleMqttState(state, error),
			})
			: null;
	}

	status(status) {
		this.node.status(status);
	}

	registrationBody() {
		const body = {
			reference_class_name: this.referenceClassName,
			database_action: this.databaseAction,
			webhook_token: this.token,
		};
		if (this.delivery === 'mqtt') {
			body.delivery = 'mqtt';
			body.instance_id = this.instanceId;
		} else {
			body.webhook_url = this.webhookUrl;
		}
		return body;
	}

	/** @returns {Promise<void>} */
	async register() {
		clearTimeout(this.timer);
		if (this.closed) {
			return;
		}
		let delay;
		try {
			const result = await this.server.client.request('POST', '/api/nodered/webhook', { body: this.registrationBody() });
			if (this.closed) {
				return;
			}
			this.failures = 0;
			this.registered = true;
			this.disabledSetting = null;
			const access = result && result.mqtt;
			if (this.delivery === 'mqtt') {
				if (!this.subscription.update(access)) {
					throw new Error('the ERP returned no MQTT access for the trigger');
				}
				if (!this.subscription.connected) {
					this.status({ fill: 'yellow', shape: 'ring', text: 'registered, MQTT connecting' });
				}
			} else {
				this.status({ fill: 'green', shape: 'dot', text: 'registered' });
			}
			delay = nextRegistrationDelay(access && access.valid_until);
		} catch (error) {
			if (this.closed) {
				return;
			}
			this.registered = false;
			const setting = featureDisabledSetting(error);
			if (setting) {
				if (this.disabledSetting !== setting) {
					this.node.log(`${featureDisabledText(setting)} – the trigger stays inactive until the setting is switched on`);
				}
				this.disabledSetting = setting;
				this.status({ fill: 'red', shape: 'ring', text: featureDisabledText(setting) });
				delay = REREGISTER_MS;
			} else {
				this.failures++;
				this.status({ fill: 'red', shape: 'ring', text: 'registration failed' });
				this.node.error(`Webhook registration failed: ${error.message}`);
				delay = Math.min(MAX_BACKOFF_MS, 5000 * Math.pow(2, Math.min(this.failures - 1, 8)));
			}
		}
		this.timer = setTimeout(() => this.register(), delay);
	}

	handleMqttState(state, error) {
		if (this.closed) {
			return;
		}
		if (state === 'subscribed') {
			this.status({ fill: 'green', shape: 'dot', text: 'connected (mqtt)' });
		} else if (state === 'subscribe_failed') {
			this.node.error(`MQTT subscribe failed: ${error.message}`);
			this.status({ fill: 'red', shape: 'ring', text: 'MQTT subscribe failed' });
		} else if (state === 'disconnected') {
			this.status({ fill: 'red', shape: 'ring', text: 'MQTT disconnected' });
		} else if (state === 'error') {
			this.node.warn(`MQTT: ${error.message}`);
		}
	}

	/** An event the ERP published on the broker: the same JSON as the https webhook body. */
	handleMessage(text) {
		let body;
		try {
			body = JSON.parse(text);
		} catch (error) {
			this.node.warn('MQTT: event is no JSON');
			return;
		}
		if (body && typeof body === 'object' && !Array.isArray(body)) {
			this.onEvent(body);
		}
	}

	/** Stops the timers and the MQTT connection; a removed node also removes its webhook. */
	async close(removed) {
		this.closed = true;
		clearTimeout(this.timer);
		if (this.subscription) {
			this.subscription.end();
		}
		if (!removed || !this.server) {
			return;
		}
		const body = this.delivery === 'mqtt' ? { instance_id: this.instanceId } : { webhook_url: this.webhookUrl };
		try {
			await this.server.client.request('DELETE', '/api/nodered/webhook', { body });
		} catch (error) {
			if (!featureDisabledSetting(error)) {
				this.node.warn(`Webhook could not be removed from the ERP: ${error.message}`);
			}
		}
	}
}

module.exports = { WebhookRegistration, nextRegistrationDelay, triggerInstanceId, REREGISTER_MS, DELIVERIES };
