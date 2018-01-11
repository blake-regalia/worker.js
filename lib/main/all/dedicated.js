const {
	K_SELF,
	stream,
	ports,
} = require('./locals.js');

const util = require('util');
const manifest = require('./manifest.js');
const result = require('./result.js');

class helper {
	constructor(k_worker, i_task, h_events) {
		Object.assign(this, {
			worker: k_worker,
			task_id: i_task,
			events: h_events,
			worker_store: k_worker.store,
			tasks: k_worker.tasks,
		});
	}

	put(s_key, z_data) {
		let h_store = this.worker_store;
		let i_task = this.task_id;

		// first item in this task's store
		if(!(i_task in h_store)) {
			h_store[i_task] = {
				[s_key]: z_data,
			};
		}
		// not first item; add it
		else {
			h_store[i_task][s_key] = z_data;
		}
	}

	get(s_key) {
		let i_task = this.task_id;

		// this task chain was never written to
		if(!(i_task in this.worker_store)) return;

		// return whatever value is there
		return this.worker_store[i_task][s_key];
	}

	emit(s_key, ...a_args) {
		// only if the event is registered
		if(s_key in this.events) {
			let a_args_send = [];
			let a_transfer_paths = [];

			// merge args
			let n_args = a_args.length;
			for(let i_arg=0; i_arg<n_args; i_arg++) {
				let z_arg = a_args[i_arg];

				// result
				if(z_arg instanceof manifest) {
					a_args_send.push(z_arg.data);
					if(z_arg.transfer_paths) {
						let nl_paths = a_transfer_paths.length;
						let a_import_paths = z_arg.transfer_paths;
						a_import_paths.forEach((a_path) => {
							a_path[0] += nl_paths;
						});
						a_transfer_paths.push(...a_import_paths);
					}
				}
				// postable
				else {
					a_args_send.push(z_arg);
				}
			}

			// send message
			K_SELF.postMessage({
				type: 'event',
				id: this.task_id,
				event: s_key,
				args: a_args_send,
			}, a_transfer_paths);
		}
	}
}

module.exports = class dedicated extends stream.handler {
	constructor(h_tasks) {
		super();

		Object.assign(this, {
			tasks: h_tasks,
			store: {},
			results: {},
			port: K_SELF,
			id: K_SELF.args[0],
		});

		K_SELF.on('error', (e_worker) => {
			this.throw(e_worker);
		});

		this.set_port(K_SELF);
	}

	debug(s_type, ...a_info) {
		// console.warn(`S${this.id} ${s_type} ${a_info.length? '('+a_info.join(', ')+')': '-'}`);
	}

	// resolves promises and wraps results
	resolve(z_result, fk_resolve) {
		// a promise was returned
		if(z_result instanceof Promise) {
			z_result
				// once its ready; resolve using result
				.then((z_data) => {
					fk_resolve(result.from(z_data));
				})
				// or catch if there was a syntax error / etc.
				.catch((e_resolve) => {
					this.throw(e_resolve);
				});
		}
		// sync
		else {
			return fk_resolve(result.from(z_result));
		}
	}

	throw(e_throw) {
		this.port.postMessage({
			type: 'error',
			error: {
				message: e_throw.message,
				stack: e_throw.stack,
			},
		});
	}

	// typical execute-and-respond task
	handle_task(h_msg) {
		let h_tasks = this.tasks;

		let {
			id: i_task,
			task: s_task,
			args: a_args,
			inherit: i_inherit=0,
			receive: i_receive=0,
			hold: b_hold=false,
			events: h_events={},
		} = h_msg;

		this.debug('<< task:'+s_task, i_task);

		// no such task
		if(!(s_task in h_tasks)) {
			return this.throw(new Error(`dedicated worker has no such task registered as '${s_task}'`));
		}

		// inherit store from previous task
		if(i_inherit) {
			let h_store = this.store;
			h_store[i_task] = h_store[i_inherit];
			delete h_store[i_inherit];
		}

		// receive data from previous task
		if(i_receive) {
			let h_results = this.results;

			// push to front of args
			a_args.unshift(h_results[i_receive].data[0]);

			// free to gc
			delete h_results[i_receive];
		}

		// execute given task
		let z_result;
		try {
			z_result = h_tasks[s_task].apply(new helper(this, i_task, h_events), a_args);
		}
		catch(e_exec) {
			e_exec.message = `worker threw an error while executing task '${s_task}':\n${e_exec.message}`;
			return this.throw(e_exec);
		}

		// hold result data and await further instructions from master
		if(b_hold) {
			this.resolve(z_result, (k_result) => {
				// store result
				this.results[i_task] = k_result;

				// submit notification to master
				this.port.postMessage({
					type: 'notify',
					id: i_task,
				});

				this.debug('>> notify', i_task);
			});
		}
		// send result back to master as soon as its ready
		else {
			this.resolve(z_result, (k_result) => {
				this.port.postMessage({
					type: 'respond',
					id: i_task,
					data: k_result.data[0],
				}, k_result.paths('data'));

				this.debug('>> respond', i_task);
			});
		}
	}

	// send result data to sibling
	handle_relay(h_msg) {
		let h_results = this.results;

		let {
			id: i_task,
			port: d_port,
		} = h_msg;

		// console.dir(d_port);
		this.debug('<< relay', i_task, d_port.name);

		// grab result
		let k_result = h_results[i_task];

		// forward to given port
		d_port.postMessage(k_result.data[0], k_result.transfer_paths);

		// free to gc
		delete h_results[i_task];
	}

	// receive data from sibling and then execute ready task
	handle_receive(h_msg) {
		let {
			port: d_port,
			import: i_import,
			primary: b_primary,
			task_ready: h_task_ready,
		} = h_msg;

		// accept port
		ports(d_port);

		this.debug('<< receive:'+i_import, h_task_ready.id, d_port.name);

		// import data
		let z_data_import = this.results[i_import].data[0];

		// free to gc
		delete this.results[i_import];

		// task ready args
		let a_args_task_ready = h_task_ready.args;

		// import is secondary
		if(!b_primary) a_args_task_ready.unshift(z_data_import);

		this.debug('setup', util.inspect(a_args_task_ready, {depth:null}));

		// set up message handler on port
		d_port.on({
			message: (d_msg_receive) => {
				this.debug('<< relay/receive', d_port.name);

				// close port on both sides
				d_port.close();

				// push message to front of args
				a_args_task_ready.unshift(d_msg_receive.data);

				// import is primary
				if(b_primary) a_args_task_ready.unshift(z_data_import);

				// fire ready task
				this.handle_task(h_task_ready);
			},

			messageerror: (e_msg) => {
				throw e_msg;
			},
		});
	}

	handle_ping() {
		this.port.postMessage({
			type: 'pong',
		});
	}

	handle_owner(h_msg) {
		this.set_port(ports(h_msg.port));
	}

	handle_subworker(h_msg) {
		require('../browser/latent-subworker.js').connect(h_msg);
	}

	set_port(d_port) {
		this.port = d_port;

		d_port.on({
			message: (d_msg) => {
				// debugger;
				let h_msg = d_msg.data;

				// handle message
				let s_handle = 'handle_'+h_msg.type;
				if(s_handle in this) {
					this[s_handle](h_msg);
				}
				// missing handle name in message
				else {
					throw new Error('dedicated worker received a message it does not know how to handle: '+d_msg);
				}
			},

			messageerror: (e_msg) => {
				throw e_msg;
			},
		});
	}
};
