'use strict';

const crypto = require('crypto');
const mqtt = require('mqtt');

/**
 * Subscription to one topic on the ERP's MQTT broker (websocket over TLS), with the access the ERP
 * hands out on registration ({url, username, password, client_id, topic}). Used by the lock bridge
 * (commands) and by the trigger nodes (webhook events over MQTT).
 *
 * A renewed password of the same broker / topic / user is used for the next reconnect; the running
 * connection stays. Another broker, topic or user opens a new connection.
 */
class ErpMqttSubscription {
	/**
	 * @param {{
	 *   clientIdBase: string,
	 *   onMessage: function(string, string): void,
	 *   onState?: function(string, Error=): void,
	 *   factory?: function(string, object): object,
	 * }} options
	 *   onState gets "subscribed", "subscribe_failed", "disconnected" or "error".
	 */
	constructor({ clientIdBase, onMessage, onState, factory }) {
		this.clientIdBase = clientIdBase;
		this.onMessage = onMessage;
		this.onState = onState || (() => {});
		this.factory = factory || ((url, options) => mqtt.connect(url, options));
		this.client = null;
		this.access = null;
		this.closed = false;
	}

	get connected() {
		return !!(this.client && this.client.connected);
	}

	/** @returns {boolean} false when the access is not usable */
	update(access) {
		if (this.closed || !access || !access.url || !access.topic) {
			return false;
		}
		const previous = this.access;
		const changed = !previous || previous.url !== access.url || previous.topic !== access.topic || previous.username !== access.username;
		this.access = access;
		if (this.client && !changed) {
			this.client.options.password = access.password;
			return true;
		}
		if (this.client) {
			this.client.end(true);
		}

		const client = this.factory(access.url, {
			username: access.username,
			password: access.password,
			clientId: `${access.client_id || this.clientIdBase}_${crypto.randomBytes(3).toString('hex')}`,
			clean: true,
			keepalive: 60,
			reconnectPeriod: 5000,
			connectTimeout: 15000,
			protocolVersion: 4,
		});
		this.client = client;
		client.on('connect', () => {
			client.subscribe(access.topic, { qos: 0 }, (error) => {
				if (client !== this.client) {
					return;
				}
				this.onState(error ? 'subscribe_failed' : 'subscribed', error);
			});
		});
		client.on('close', () => {
			if (!this.closed && client === this.client) {
				this.onState('disconnected');
			}
		});
		client.on('error', (error) => {
			if (client === this.client) {
				this.onState('error', error);
			}
		});
		client.on('message', (topic, message) => this.onMessage(message.toString('utf8'), topic));
		return true;
	}

	end() {
		this.closed = true;
		if (this.client) {
			this.client.end(true);
			this.client = null;
		}
	}
}

module.exports = { ErpMqttSubscription };
