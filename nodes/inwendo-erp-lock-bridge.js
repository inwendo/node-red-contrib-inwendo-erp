'use strict';

const mqtt = require('mqtt');
const { ErpMqttSubscription } = require('./lib/mqtt-subscription');
const {
	SIGNATURE_HEADER,
	INSTANCE_ID_PATTERN,
	NonceCache,
	verifyPushCommand,
} = require('./lib/lock-protocol');
const { readRawBody, publicUrl, removeRoute } = require('./lib/http');

/** How often the bridge registers its locks again (heals a lost registration, renews the MQTT password). */
const REREGISTER_MS = 10 * 60 * 1000;
const REGISTER_DEBOUNCE_MS = 500;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

module.exports = function (RED) {
	/**
	 * Offers the locks of this Node-RED (the "inwendo erp lock" nodes) to the ERP and receives their
	 * signed commands: over the ERP's MQTT broker (works behind NAT) or as https push requests.
	 */
	function InwendoErpLockBridgeNode(config) {
		RED.nodes.createNode(this, config);
		const bridge = this;
		bridge.server = RED.nodes.getNode(config.server);
		bridge.name = config.name || 'Node-RED';
		bridge.instanceId = config.instanceId;
		bridge.secret = bridge.credentials ? bridge.credentials.secret : undefined;
		bridge.delivery = config.delivery === 'push' ? 'push' : 'mqtt';
		bridge.pushPath = `/inwendo-erp/lock/${bridge.instanceId}`;
		bridge.webhookUrl = bridge.delivery === 'push' && config.publicUrl
			? publicUrl(config.publicUrl, RED.settings.httpNodeRoot, bridge.pushPath)
			: null;
		bridge.locks = new Map();
		bridge.registered = false;
		bridge.closed = false;
		bridge.lastStatus = { fill: 'grey', shape: 'ring', text: 'connecting' };

		const nonces = new NonceCache();
		let registerTimer = null;
		let reregisterTimer = null;
		let failures = 0;

		bridge.configError = validate();

		function validate() {
			if (!bridge.server) {
				return 'no ERP connection';
			}
			if (!INSTANCE_ID_PATTERN.test(String(bridge.instanceId || ''))) {
				return 'invalid instance id';
			}
			if (!bridge.secret || bridge.secret.length < 32) {
				return 'secret missing (open and save the bridge)';
			}
			if (bridge.delivery === 'push' && !/^https:\/\//i.test(String(bridge.webhookUrl || ''))) {
				return 'push needs the public https URL';
			}
			return null;
		}

		bridge.setStatus = function (status) {
			bridge.lastStatus = status;
			for (const lock of bridge.locks.values()) {
				lock.showBridgeStatus(status);
			}
		};

		bridge.registerLock = function (lock) {
			const existing = bridge.locks.get(lock.lockId);
			if (existing && existing !== lock) {
				lock.warn(`Lock id ${lock.lockId} is used by another lock node of this bridge; the last one wins`);
			}
			bridge.locks.set(lock.lockId, lock);
			lock.showBridgeStatus(bridge.configError ? { fill: 'red', shape: 'ring', text: bridge.configError } : bridge.lastStatus);
			bridge.scheduleRegister();
		};

		bridge.unregisterLock = function (lock) {
			if (bridge.locks.get(lock.lockId) === lock) {
				bridge.locks.delete(lock.lockId);
				if (!bridge.closed) {
					bridge.scheduleRegister();
				}
			}
		};

		bridge.scheduleRegister = function () {
			if (bridge.configError || bridge.closed) {
				return;
			}
			clearTimeout(registerTimer);
			registerTimer = setTimeout(() => bridge.register(), REGISTER_DEBOUNCE_MS);
		};

		bridge.lockDefinitions = function () {
			return Array.from(bridge.locks.values()).map((lock) => ({
				id: lock.lockId,
				name: lock.lockName,
				state: lock.state,
				unlock_method: lock.unlockMethod,
			}));
		};

		function connectedStatus() {
			return { fill: 'green', shape: 'dot', text: bridge.delivery === 'push' ? 'connected (push)' : 'connected (mqtt)' };
		}

		bridge.register = async function () {
			clearTimeout(reregisterTimer);
			try {
				const result = await bridge.server.client.request('POST', '/api/nodered/smart_lock/register', {
					body: {
						instance_id: bridge.instanceId,
						secret: bridge.secret,
						name: bridge.name,
						delivery: bridge.delivery,
						webhook_url: bridge.webhookUrl,
						locks: bridge.lockDefinitions(),
					},
				});
				failures = 0;
				bridge.registered = true;
				bridge.connectionId = result && result.connection_id;
				bridge.synced = !!(result && result.smart_locks > 0);
				if (bridge.delivery === 'mqtt') {
					connectMqtt(result && result.mqtt);
				}
				updateStatus();
			} catch (error) {
				failures++;
				bridge.registered = false;
				bridge.setStatus({ fill: 'red', shape: 'ring', text: error.erpCode === 403 ? 'instance registered with another secret' : 'registration failed' });
				bridge.error(`Lock registration failed: ${error.message}`);
			}
			if (!bridge.closed) {
				reregisterTimer = setTimeout(() => bridge.register(), bridge.registered ? REREGISTER_MS : backoff());
			}
		};

		function updateStatus() {
			if (!bridge.registered) {
				return;
			}
			if (bridge.delivery === 'mqtt' && !(bridge.mqttClient && bridge.mqttClient.connected)) {
				bridge.setStatus({ fill: 'yellow', shape: 'ring', text: 'MQTT connecting' });
			} else if (!bridge.synced) {
				bridge.setStatus({ fill: 'yellow', shape: 'dot', text: 'registered, sync devices in the ERP' });
			} else {
				bridge.setStatus(connectedStatus());
			}
		}

		function backoff() {
			return Math.min(MAX_BACKOFF_MS, 5000 * Math.pow(2, Math.min(failures, 6)));
		}

		/** Hook for tests; by default the mqtt package. */
		bridge.mqttFactory = (url, options) => mqtt.connect(url, options);

		const subscription = new ErpMqttSubscription({
			clientIdBase: bridge.instanceId,
			factory: (url, options) => bridge.mqttFactory(url, options),
			onMessage: (text) => bridge.handleMqttMessage(text),
			onState: (state, error) => {
				if (state === 'subscribed') {
					updateStatus();
				} else if (state === 'subscribe_failed') {
					bridge.error(`MQTT subscribe failed: ${error.message}`);
					bridge.setStatus({ fill: 'red', shape: 'ring', text: 'MQTT subscribe failed' });
				} else if (state === 'disconnected') {
					bridge.setStatus({ fill: 'red', shape: 'ring', text: 'MQTT disconnected' });
				} else if (state === 'error') {
					bridge.warn(`MQTT: ${error.message}`);
				}
			},
		});
		/** The MQTT client of the bridge (tests and the E2E test wait for its connection). */
		Object.defineProperty(bridge, 'mqttClient', { get: () => subscription.client });

		/**
		 * Connects to the ERP's broker with the access of the last registration. A renewed password
		 * is used for the next reconnect; the connection itself stays.
		 */
		function connectMqtt(access) {
			if (!subscription.update(access)) {
				bridge.error('The ERP did not return MQTT access for this bridge');
			}
		}

		bridge.handleMqttMessage = async function (text) {
			let envelope;
			try {
				envelope = JSON.parse(text);
			} catch (error) {
				bridge.warn('MQTT: message is no JSON');
				return;
			}
			const checked = verifyPushCommand({
				rawBody: envelope && typeof envelope.body === 'string' ? envelope.body : '',
				signature: envelope && envelope.signature,
				secret: bridge.secret,
				instanceId: bridge.instanceId,
				nonces,
			});
			if (!checked.ok) {
				bridge.warn(`MQTT: command rejected (${checked.error})`);
				if (checked.command && checked.command.command_id !== undefined) {
					reportResult(checked.command, { success: false, message: checked.error });
				}
				return;
			}
			const outcome = await bridge.dispatch(checked.command);
			if (checked.command.command_id !== undefined) {
				reportResult(checked.command, outcome);
			}
		};

		async function reportResult(command, outcome) {
			try {
				await bridge.server.client.request('POST', `/api/nodered/smart_lock/commands/${encodeURIComponent(command.command_id)}/result`, {
					body: {
						instance_id: bridge.instanceId,
						secret: bridge.secret,
						success: outcome.success === true,
						state: outcome.state,
						message: outcome.message,
					},
				});
			} catch (error) {
				bridge.warn(`Reporting the result of command ${command.command_id} failed: ${error.message}`);
			}
		}

		/**
		 * Hands a command to its lock node.
		 *
		 * @returns {Promise<{success: boolean, state?: string, message?: string}>}
		 */
		bridge.dispatch = async function (command) {
			const lock = bridge.locks.get(command.lock_id);
			if (!lock) {
				return { success: false, message: `unknown lock ${command.lock_id}` };
			}
			try {
				return await lock.execute(command);
			} catch (error) {
				return { success: false, message: error.message };
			}
		};

		// push: the ERP posts signed commands, the answer tells it whether the lock executed it
		if (bridge.delivery === 'push' && !bridge.configError) {
			RED.httpNode.post(bridge.pushPath, async (req, res) => {
				let rawBody;
				try {
					rawBody = await readRawBody(req);
				} catch (error) {
					res.status(400).json({ success: false, error: 'invalid body' });
					return;
				}
				const checked = verifyPushCommand({
					rawBody,
					signature: req.headers[SIGNATURE_HEADER],
					secret: bridge.secret,
					instanceId: bridge.instanceId,
					nonces,
				});
				if (!checked.ok) {
					res.status(checked.status).json({ success: false, error: checked.error });
					return;
				}
				const outcome = await bridge.dispatch(checked.command);
				res.status(200).json({ success: outcome.success === true, state: outcome.state, error: outcome.success ? undefined : outcome.message });
			});
		}

		if (bridge.configError) {
			bridge.setStatus({ fill: 'red', shape: 'ring', text: bridge.configError });
		}

		bridge.on('close', async (removed, done) => {
			bridge.closed = true;
			clearTimeout(registerTimer);
			clearTimeout(reregisterTimer);
			removeRoute(RED.httpNode, bridge.pushPath, 'post');
			subscription.end();
			if (removed && !bridge.configError) {
				try {
					await bridge.server.client.request('DELETE', '/api/nodered/smart_lock/register', {
						body: { instance_id: bridge.instanceId, secret: bridge.secret },
					});
				} catch (error) {
					bridge.warn(`Removing the locks from the ERP failed: ${error.message}`);
				}
			}
			done();
		});
	}

	RED.nodes.registerType('inwendo-erp-lock-bridge', InwendoErpLockBridgeNode, {
		credentials: {
			secret: { type: 'password' },
		},
	});
};
