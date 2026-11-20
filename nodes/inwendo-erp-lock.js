'use strict';

const { LOCK_ID_PATTERN, LOCK_STATES, waitForResult } = require('./lib/lock-protocol');

/** Longest group opening the node accepts (the ERP allows less), and the shortest impulse interval. */
const GROUP_OPEN_MAX_SECONDS = 4 * 60 * 60;
const GROUP_OPEN_MIN_PULSE_SECONDS = 1;
const GROUP_OPEN_DEFAULT_PULSE_SECONDS = 4;

module.exports = function (RED) {
	/**
	 * One lock offered to the ERP. Sends a message for every command of the ERP
	 * (msg.payload.command = "open" or "lock"); a message with a lock state as payload
	 * ("locked", "unlocked", ...) reports the state to the ERP.
	 *
	 * With "let the group in" (config.groupOpen) the node also takes group_open / group_close and keeps the
	 * time itself, so a lost ERP connection never leaves the door open: mode hold_open sends "hold_open"
	 * at the start and "lock" at the end, mode pulse sends an "open" every pulse_seconds until the end.
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
		node.groupOpen = config.groupOpen === true || config.groupOpen === 'true';
		/** The running group opening: {mode, until (ms), pulseSeconds}, null while none runs. */
		node.groupOpening = null;
		let groupEndTimer = null;
		let groupPulseTimer = null;

		node.showBridgeStatus = function (status) {
			node.status(status);
		};

		/**
		 * @returns {Promise<{success: boolean, state?: string, message?: string}>}
		 */
		node.execute = async function (command) {
			if (command.command === 'group_open') {
				return groupOpen(command);
			}
			if (command.command === 'group_close') {
				return groupClose(command);
			}
			return sendCommand(command.command, command);
		};

		/**
		 * Sends one command message; with "wait for a result node" the result of the flow is returned.
		 *
		 * @param {string} name the command of the message (open, lock, hold_open)
		 * @param {object} command the ERP command (null for the impulses and the end of a group opening)
		 * @param {object} [group] the running group opening, added as msg.payload.group
		 */
		async function sendCommand(name, command, group) {
			const key = `${bridge.instanceId}:${command && command.command_id !== undefined ? command.command_id : command ? command.nonce : `group-${Date.now()}-${Math.random()}`}`;
			if (!group) {
				node.status({ fill: 'blue', shape: 'dot', text: `${name} ${new Date().toLocaleTimeString()}` });
			}
			const result = command && node.confirm === 'manual' ? waitForResult(key, node.resultTimeoutMs) : null;
			const payload = {
				command: name,
				lock_id: node.lockId,
				smart_lock_id: command ? command.smart_lock_id : node.smartLockId,
				command_id: command ? command.command_id : undefined,
			};
			if (group) {
				payload.group = { mode: group.mode, until: new Date(group.until).toISOString(), pulse_seconds: group.pulseSeconds };
			}
			node.send({ topic: name, payload, _inwendoLock: { key } });
			if (!result) {
				return { success: true, state: node.state };
			}
			const outcome = await result;
			if (outcome.state && LOCK_STATES.includes(outcome.state)) {
				node.state = outcome.state;
			}
			if (!outcome.success) {
				node.status({ fill: 'red', shape: 'ring', text: `${name} failed` });
			}
			return outcome;
		}

		function stopGroupTimers() {
			clearTimeout(groupEndTimer);
			clearInterval(groupPulseTimer);
			groupEndTimer = null;
			groupPulseTimer = null;
		}

		function showGroupStatus() {
			const until = new Date(node.groupOpening.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			node.status({ fill: 'green', shape: 'dot', text: `group ${node.groupOpening.mode === 'pulse' ? 'impulses' : 'open'} until ${until}` });
		}

		/** The time is over: hold_open locks again, pulse simply stops. */
		function endGroupOpening() {
			const ended = node.groupOpening;
			stopGroupTimers();
			node.groupOpening = null;
			if (ended && ended.mode === 'hold_open') {
				sendCommand('lock', null, ended);
			}
			node.status({ fill: 'grey', shape: 'dot', text: `group closed ${new Date().toLocaleTimeString()}` });
		}

		/**
		 * Starts or extends the group opening: from now for duration_seconds. A second group_open sets the new
		 * end (as the ERP shows it) and keeps the door open without a second "hold_open".
		 */
		async function groupOpen(command) {
			if (!node.groupOpen) {
				return { success: false, message: 'let the group in is not switched on at this lock' };
			}
			const seconds = Math.round(Number(command.duration_seconds));
			if (!Number.isFinite(seconds) || seconds < 1 || seconds > GROUP_OPEN_MAX_SECONDS) {
				return { success: false, message: `duration_seconds must be between 1 and ${GROUP_OPEN_MAX_SECONDS}` };
			}
			const mode = command.mode === 'pulse' ? 'pulse' : 'hold_open';
			const pulse = Math.round(Number(command.pulse_seconds));
			const pulseSeconds = Number.isFinite(pulse) && pulse >= GROUP_OPEN_MIN_PULSE_SECONDS ? pulse : GROUP_OPEN_DEFAULT_PULSE_SECONDS;
			const previous = node.groupOpening;
			stopGroupTimers();
			const group = { mode, until: Date.now() + seconds * 1000, pulseSeconds };
			node.groupOpening = group;
			node.smartLockId = command.smart_lock_id;
			groupEndTimer = setTimeout(endGroupOpening, seconds * 1000);

			let outcome = { success: true, state: node.state };
			if (mode === 'pulse') {
				if (previous && previous.mode === 'hold_open') {
					// switched from staying open to impulses: lock first
					sendCommand('lock', null, previous);
				}
				outcome = await sendCommand('open', command, group);
				groupPulseTimer = setInterval(() => {
					if (node.groupOpening === group) {
						sendCommand('open', null, group);
					}
				}, pulseSeconds * 1000);
			} else if (!previous || previous.mode !== 'hold_open') {
				outcome = await sendCommand('hold_open', command, group);
			}
			if (!outcome.success && node.groupOpening === group) {
				// the flow could not open the door: nothing counts as open
				stopGroupTimers();
				node.groupOpening = null;
				if (mode === 'hold_open') {
					sendCommand('lock', null, group);
				}
				return outcome;
			}
			showGroupStatus();
			return outcome;
		}

		/** Ends a running group opening now; hold_open locks again. Without a running one it locks anyway. */
		async function groupClose(command) {
			if (!node.groupOpen) {
				return { success: false, message: 'let the group in is not switched on at this lock' };
			}
			const ended = node.groupOpening;
			stopGroupTimers();
			node.groupOpening = null;
			const outcome = ended && ended.mode === 'pulse'
				? { success: true, state: node.state }
				: await sendCommand('lock', command, ended || undefined);
			node.status({ fill: 'grey', shape: 'dot', text: `group closed ${new Date().toLocaleTimeString()}` });
			return outcome;
		}

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
			const running = node.groupOpening;
			stopGroupTimers();
			node.groupOpening = null;
			if (running && running.mode === 'hold_open') {
				// a redeploy or stop must not leave the door open
				sendCommand('lock', null, running);
			}
			bridge.unregisterLock(node);
			done();
		});
	}

	RED.nodes.registerType('inwendo-erp-lock', InwendoErpLockNode);
};
