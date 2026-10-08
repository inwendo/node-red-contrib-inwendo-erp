'use strict';

const CREDENTIAL_TYPES = ['auto', 'access_code', 'member_card', 'card'];

module.exports = function (RED) {
	/**
	 * Asks the ERP whether a credential a reader read (app QR code, member card QR, RFID card number)
	 * may open a lock. Output 1: access granted, output 2: denied. msg.payload is the answer of the ERP.
	 */
	function InwendoErpAccessCheckNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;
		const target = config.target === 'smartLock' ? 'smartLock' : 'bridgeLock';
		const bridge = target === 'bridgeLock' ? RED.nodes.getNode(config.bridge) : null;
		const server = target === 'smartLock' ? RED.nodes.getNode(config.server) : bridge && bridge.server;

		node.on('input', async (msg, send, done) => {
			const credential = credentialOf(msg.payload);
			if (!credential) {
				done(new Error('msg.payload must be the credential the reader read (string, number or Buffer)'));
				return;
			}
			if (!server) {
				done(new Error('inwendo ERP connection is not configured'));
				return;
			}
			const credentialType = msg.credentialType || config.credentialType || 'auto';
			if (!CREDENTIAL_TYPES.includes(credentialType)) {
				done(new Error(`credentialType must be one of ${CREDENTIAL_TYPES.join(', ')}`));
				return;
			}

			const body = { credential, credential_type: credentialType, open: (msg.open !== undefined ? msg.open : config.open) === true };
			const smartLockId = msg.smartLockId !== undefined ? msg.smartLockId : config.smartLockId;
			if (target === 'smartLock' || msg.smartLockId !== undefined) {
				if (smartLockId === undefined || smartLockId === null || String(smartLockId).trim() === '') {
					done(new Error('Smart lock id missing (node setting or msg.smartLockId)'));
					return;
				}
				body.smart_lock_id = Number(smartLockId);
			} else {
				if (!bridge) {
					done(new Error('Lock bridge is not configured'));
					return;
				}
				body.instance_id = bridge.instanceId;
				body.lock_id = msg.lockId || config.lockId;
			}

			try {
				node.status({ fill: 'blue', shape: 'dot', text: 'checking' });
				const answer = await server.client.request('POST', '/api/nodered/smart_lock/check_access', { body });
				msg.credential = credential;
				msg.payload = answer;
				msg.granted = answer && answer.granted === true;
				msg.person = answer && answer.person;
				const time = new Date().toLocaleTimeString();
				node.status(msg.granted
					? { fill: 'green', shape: 'dot', text: `granted ${time}` }
					: { fill: 'red', shape: 'dot', text: `${(answer && answer.reason) || 'denied'} ${time}` });
				send(msg.granted ? [msg, null] : [null, msg]);
				done();
			} catch (error) {
				node.status({ fill: 'red', shape: 'ring', text: error.erpCode === 404 ? 'lock not synced in ERP' : 'error' });
				done(error);
			}
		});
	}

	RED.nodes.registerType('inwendo-erp-access-check', InwendoErpAccessCheckNode);
};

/**
 * The credential as string: readers send strings, numbers or Buffers, often with a line break.
 */
function credentialOf(payload) {
	let value = payload;
	if (Buffer.isBuffer(value)) {
		value = value.toString('utf8');
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		value = String(value);
	}
	if (typeof value !== 'string') {
		return null;
	}
	value = value.replace(/[\r\n\t\0]+/g, '').trim();
	return value !== '' && value.length <= 2048 ? value : null;
}

module.exports.credentialOf = credentialOf;
