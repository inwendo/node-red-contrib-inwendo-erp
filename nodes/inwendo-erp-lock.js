'use strict';

const { LOCK_ID_PATTERN, LOCK_STATES, waitForResult } = require('./lib/lock-protocol');

module.exports = function (RED) {
	/**
	 * One lock offered to the ERP. Sends a message for every command of the ERP
	 * (msg.payload.command = "open" or "lock"); a message with a lock state as payload
	 * ("locked", "unlocked", ...) reports the state to the ERP.
	 */
	function InwendoErpLockNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;
		const bridge = RED.nodes.getNode(config.bridge);
		node.lockId = String(config.lockId || '').trim();
		node.lockName = config.lockName || config.name || node.lockId;
		node.unlockMethod = config.unlockMethod === 'qr_code' ? 'qr_code' : 'remote';
		node.confirm = config.confirm === 'manual' ? 'manual' : 'auto';
		node.resultTimeoutMs = Math.min(25, Math.max(1, parseFloat(config.resultTimeout) || 10)) * 1000;
		node.state = 'unknown';

		node.showBridgeStatus = function (status) {
			node.status(status);
		};

		/**
		 * @returns {Promise<{success: boolean, state?: string, message?: string}>}
		 */
		node.execute = async function (command) {
			const key = `${bridge.instanceId}:${command.command_id !== undefined ? command.command_id : command.nonce}`;
			node.status({ fill: 'blue', shape: 'dot', text: `${command.command} ${new Date().toLocaleTimeString()}` });
			const result = node.confirm === 'manual' ? waitForResult(key, node.resultTimeoutMs) : null;
			node.send({
				topic: command.command,
				payload: {
					command: command.command,
					lock_id: command.lock_id,
					smart_lock_id: command.smart_lock_id,
					command_id: command.command_id,
				},
				_inwendoLock: { key },
			});
			if (!result) {
				return { success: true, state: node.state };
			}
			const outcome = await result;
			if (outcome.state && LOCK_STATES.includes(outcome.state)) {
				node.state = outcome.state;
			}
			if (!outcome.success) {
				node.status({ fill: 'red', shape: 'ring', text: `${command.command} failed` });
			}
			return outcome;
		};

		if (!bridge) {
			node.status({ fill: 'red', shape: 'ring', text: 'no lock bridge' });
			return;
		}
		if (!LOCK_ID_PATTERN.test(node.lockId)) {
			node.status({ fill: 'red', shape: 'ring', text: 'invalid lock id' });
			return;
		}

		node.on('input', (msg, send, done) => {
			const state = typeof msg.payload === 'string' ? msg.payload.trim().toLowerCase() : null;
			if (!state || !LOCK_STATES.includes(state)) {
				done(new Error(`msg.payload must be a lock state: ${LOCK_STATES.join(', ')}`));
				return;
			}
			if (state !== node.state) {
				node.state = state;
				// the states reach the ERP with the registration
				bridge.scheduleRegister();
			}
			done();
		});

		bridge.registerLock(node);
		node.on('close', (done) => {
			bridge.unregisterLock(node);
			done();
		});
	}

	RED.nodes.registerType('inwendo-erp-lock', InwendoErpLockNode);
};
