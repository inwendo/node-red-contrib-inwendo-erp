'use strict';

const { resolveResult } = require('./lib/lock-protocol');

module.exports = function (RED) {
	/**
	 * Reports the result of a lock command to the ERP (lock nodes with "wait for a result node").
	 * msg.success (or a boolean msg.payload) is the result, msg.state the new lock state and
	 * msg.message an error text. The message must still carry msg._inwendoLock of the lock node.
	 */
	function InwendoErpLockResultNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;

		node.on('input', (msg, send, done) => {
			const key = msg._inwendoLock && msg._inwendoLock.key;
			if (!key) {
				done(new Error('msg._inwendoLock is missing: the message must come from a vynst lock node'));
				return;
			}
			let success = true;
			if (typeof msg.success === 'boolean') {
				success = msg.success;
			} else if (typeof msg.payload === 'boolean') {
				success = msg.payload;
			}
			const result = {
				success,
				state: typeof msg.state === 'string' ? msg.state : undefined,
				message: typeof msg.message === 'string' ? msg.message : (msg.error && msg.error.message) || undefined,
			};
			if (!resolveResult(key, result)) {
				node.warn('The command is no longer waiting for a result (timeout or confirmed already)');
			}
			node.status({ fill: success ? 'green' : 'red', shape: 'dot', text: success ? 'success' : 'failed' });
			done();
		});
	}

	RED.nodes.registerType('inwendo-erp-lock-result', InwendoErpLockResultNode);
};
