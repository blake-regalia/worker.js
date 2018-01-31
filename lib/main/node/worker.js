const cp = require('child_process');
const path = require('path');

const ipc = require('./ipc.js');

let i_worker = 0;

// Worker abstraction
module.exports = class node_worker extends ipc {
	constructor(p_source, h_options={}) {
		// prep args
		let a_args = h_options.args || [];

		// push source to front of args
		a_args.unshift(p_source);

		// push node args to front
		if(h_options.node_args) a_args.unshift(...h_options.node_args);

		// spawn child process
		let u_proc = cp.spawn(process.execPath, a_args, {
			env: {
				WORKER_DEPTH: 1,
				WORKER_INDEX: i_worker++,
				MASTER_ORIGIN: module.parent.parent.parent.filename,
			},
			cwd: h_options.cwd || path.dirname(p_source),
			stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'pipe'],
		});

		// create ipc
		super(u_proc.stdio[4], module.parent.parent.filename);

		// save process
		Object.assign(this, {
			proc: u_proc,
		});
	}

	send_port(d_port, h_msg) {
		// set a link to process
		this.proc.on('exit', () => {
			require('./channel.js').kill(d_port.ipc.server);
		});

		// send port and message over ipc message
		this.proc.send(h_msg, d_port);
	}

	terminate(s_kill='SIGTERM') {
		let u_proc = this.proc;
		return new Promise((f_resolve, f_reject) => {
			u_proc.on('exit', (x_code, s_signal) => {
				f_resolve(x_code, s_signal);
			});

			u_proc.on('error', (e_kill) => {
				f_reject(e_kill);
			});

			u_proc.kill(s_kill);
		});
	}
};
