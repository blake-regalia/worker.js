(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
const {
	K_SELF,
	webworkerify,
	stream,
	ports,
} = require('./locals.js');

const util = require('util');
const manifest = require('./manifest.js');
const result = require('./result.js');

let i_subworker_spawn = 1;
let h_subworkers = {};
class latent_subworker {
	static connect(h_msg) {
		h_subworkers[h_msg.id].connect(h_msg);
	}

	constructor() {
		Object.assign(this, {
			id: i_subworker_spawn,
			messages: [],
			master_key: 0,
			port: null,
		});

		h_subworkers[i_subworker_spawn++] = this;
	}

	connect(h_msg) {
		let {
			master_key: i_master,
			port: d_port,
		} = h_msg;

		Object.assign(this, {
			master_key: i_master,
			port: d_port,
		});

		// bind events
		d_port.onmessage = (...a_args) => {
			this.onmessage(...a_args);
		};
		d_port.onmessageerror = (...a_args) => {
			this.onmessageerror(...a_args);
		};

		// process message queue
		while (this.messages.length) {
			d_port.postMessage(...this.messages.shift());
		}
	}

	postMessage(...a_args) {
		if (this.port) {
			this.port.postMessage(...a_args);
		} else {
			this.messages.push(a_args);
		}
	}

	onmessage() {
		throw new Error('received message from subworker before its port was connected');
	}

	onmessageerror() {
		throw new Error('received message error from subworker before its port was connected');
	}

	terminate() {
		this.port.close();
		K_SELF.postMessage({
			type: 'terminate',
			master_key: this.master_key,
		});
	}

	webworkerify(z_import, a_browserify, h_options = {}) {
		let s_source = webworkerify(z_import, a_browserify, h_options);

		K_SELF.postMessage({
			type: 'spawn',
			source: s_source,
			options: h_options,
		});
	}
}


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
		if (!(i_task in h_store)) {
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
		if (!(i_task in this.worker_store)) return;

		// return whatever value is there
		return this.worker_store[i_task][s_key];
	}

	emit(s_key, ...a_args) {
		// only if the event is registered
		if (s_key in this.events) {
			let a_args_send = [];
			let a_transfer_paths = [];

			// merge args
			let n_args = a_args.length;
			for (let i_arg = 0; i_arg < n_args; i_arg++) {
				let z_arg = a_args[i_arg];

				// result
				if (z_arg instanceof manifest) {
					a_args_send.push(z_arg.data);
					if (z_arg.transfer_paths) {
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

		K_SELF.event('error', (e_worker) => {
			throw new Error(e_worker);
		});

		this.set_port(K_SELF);
	}

	debug(s_type, ...a_info) {
		// console.warn(`S${this.id} ${s_type} ${a_info.length? '('+a_info.join(', ')+')': '-'}`);
	}

	// resolves promises and wraps results
	resolve(z_result, fk_resolve) {
		// a promise was returned
		if (z_result instanceof Promise) {
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

	throw (e_throw) {
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
			inherit: i_inherit = 0,
			receive: i_receive = 0,
			hold: b_hold = false,
			events: h_events = {},
		} = h_msg;

		this.debug('<< task:' + s_task, i_task);

		// no such task
		if (!(s_task in h_tasks)) {
			return this.throw(new Error(`dedicated worker has no such task registered as '${s_task}'`));
		}

		// inherit store from previous task
		if (i_inherit) {
			let h_store = this.store;
			h_store[i_task] = h_store[i_inherit];
			delete h_store[i_inherit];
		}

		// receive data from previous task
		if (i_receive) {
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
		} catch (e_exec) {
			e_exec.message = `worker threw an error while executing task '${s_task}':\n${e_exec.message}`;
			return this.throw(e_exec);
		}

		// hold result data and await further instructions from master
		if (b_hold) {
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

		this.debug('<< receive:' + i_import, h_task_ready.id, d_port.name);

		// import data
		let z_data_import = this.results[i_import].data[0];

		// free to gc
		delete this.results[i_import];

		// task ready args
		let a_args_task_ready = h_task_ready.args;

		// import is secondary
		if (!b_primary) a_args_task_ready.unshift(z_data_import);

		this.debug('setup', util.inspect(a_args_task_ready, {
			depth: null
		}));

		// set up message handler on port
		d_port.events({
			message: (d_msg_receive) => {
				this.debug('<< relay/receive', d_port.name);

				// close port on both sides
				d_port.close();

				// push message to front of args
				a_args_task_ready.unshift(d_msg_receive.data);

				// import is primary
				if (b_primary) a_args_task_ready.unshift(z_data_import);

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
		latent_subworker.connect(h_msg);
	}

	set_port(d_port) {
		this.port = d_port;

		d_port.events({
			message: (d_msg) => {
				// debugger;
				let h_msg = d_msg.data;

				// handle message
				let s_handle = 'handle_' + h_msg.type;
				if (s_handle in this) {
					this[s_handle](h_msg);
				}
				// missing handle name in message
				else {
					throw new Error('dedicated worker received a message it does not know how to handle: ' + d_msg);
				}
			},

			messageerror: (e_msg) => {
				throw e_msg;
			},
		});
	}
};
},{"./locals.js":3,"./manifest.js":4,"./result.js":6,"util":25}],2:[function(require,module,exports){
const {
	N_CORES,
	HP_WORKER_NOTIFICATION,
	DC_CHANNEL,
} = require('./locals.js');

const manifest = require('./manifest.js');
let worker;


const XM_STRATEGY_EQUAL = 1 << 0;

const XM_STRATEGY_ORDERED_GROUPS_BALANCED = 1 << 2;
const XM_STRATEGY_ORDERED_GROUPS_BIASED = 1 << 3;

const XM_STRATEGY_ORDERED_GROUPS = XM_STRATEGY_ORDERED_GROUPS_BALANCED | XM_STRATEGY_ORDERED_GROUPS_BIASED;

const XM_DISTRIBUTION_CONSTANT = 1 << 0;


class lock {
	constructor(b_unlocked = false) {
		Object.assign(this, {
			unlocked: b_unlocked,
			queue: [],
		});
	}

	wait(fk_unlock) {
		// already unlocked
		if (this.unlocked) {
			fk_unlock();
		}
		// currently locked, add to queue
		else {
			this.queue.push(fk_unlock);
		}
	}

	unlock() {
		// update state
		this.unlocked = true;

		// update field before executing callbacks
		let a_queue = this.queue;
		this.queue = [];

		// process callback queue
		a_queue.forEach((fk_unlock) => {
			fk_unlock();
		});
	}
}


class group {
	constructor(p_source, n_workers = N_CORES, h_worker_options = {}) {
		// no worker count given; default to number of cores
		if (!n_workers) n_workers = N_CORES;

		// negative number given; subtract from core count
		if (n_workers < 0) n_workers = Math.max(1, N_CORES + n_workers);

		// make workers
		let a_workers = [];
		let hm_roster = new WeakMap();
		for (let i_worker = 0; i_worker < n_workers; i_worker++) {
			// make new worker
			let k_worker = new worker({
				source: p_source,
				id: i_worker,
				master: this,
				options: Object.assign({
					args: [String.fromCharCode(65 + i_worker)],
				}, h_worker_options),
			});

			// add to worker list
			a_workers.push(k_worker);

			// reserve a queue for it in roster
			hm_roster.set(k_worker, []);
		}

		Object.assign(this, {
			source: p_source,
			worker_count: n_workers,
			workers: a_workers,
			roster: hm_roster,
			wait_list: [],
			locks: {},
			next_worker_summon: 0,
		});
	}

	data(a_items) {
		return new armed_group(this, this.balance(a_items));
	}

	use(a_subsets) {
		if (a_subsets.length > this.worker_count) {
			throw new RangeError(`too many subsets given for number of workers: ${a_subsets.length} subsets > ${this.worker_count} workers`);
		}

		return new armed_group(this, a_subsets);
	}

	wait(z_key, z_unlock) {
		let fk_unlock = z_unlock;

		// unlock is another lock
		if ('string' === typeof z_unlock) {
			fk_unlock = () => {
				this.unlock(z_unlock);
			};
		}
		// unlock is array of locks
		else if (Array.isArray(z_unlock)) {
			fk_unlock = () => {
				this.unlock(z_unlock);
			};
		}

		// series of keys to wait for
		if (Array.isArray(z_key)) {
			let i_key = 0;
			let n_keys = z_key.length;
			let f_next = () => {
				if (i_key === n_keys) fk_unlock();
				else this.wait(z_key[i_key++], f_next);
			};

			f_next();
		}
		// no such lock; but that's okay ;) create lock implicitly
		else if (!(z_key in this.locks)) {
			let k_lock = this.locks[z_key] = new lock();
			k_lock.wait(fk_unlock);
		}
		// add to wait queue
		else {
			this.locks[z_key].wait(fk_unlock);
		}
	}

	unlock(z_key) {
		// list of keys to unlock
		if (Array.isArray(z_key)) {
			z_key.forEach(z_key_ => this.unlock(z_key_));
		}
		// indivudal key
		else {
			// no such lock yet
			if (!(z_key in this.locks)) {
				this.locks[z_key] = new lock(true);
			}
			// unlock
			else {
				this.locks[z_key].unlock();
			}
		}
	}

	balance(a_items) {
		return divide(a_items, this.worker_count, XM_STRATEGY_EQUAL);
	}

	balance_ordered_groups(a_groups, h_divide) {
		return divide(a_groups, this.worker_count, XM_STRATEGY_ORDERED_GROUPS_BALANCED, h_divide);
	}

	bias_ordered_groups(a_groups, h_divide) {
		return divide(a_groups, this.worker_count, XM_STRATEGY_ORDERED_GROUPS_BIASED, h_divide);
	}

	divisions(n_items) {
		let n_workers = this.worker_count;

		// do not assign worker to do nothing
		if (n_items < n_workers) n_workers = n_items;

		// how many times to divide the items
		let n_divisions = n_workers - 1;

		// ideal number of items per worker
		let x_items_per_worker = n_items / n_workers;

		// item indices where to make divisions
		let a_divisions = [];
		for (let i_division = 1; i_division <= n_divisions; i_division++) {
			a_divisions.push(Math.round(i_division * x_items_per_worker));
		}

		return a_divisions;
	}

	* divider(c_items_remain, xm_distribution = XM_DISTRIBUTION_CONSTANT) {
		let c_workers_remain = this.worker_count;

		// items per worker
		let n_items_per_division = Math.floor(c_items_remain / c_workers_remain);

		// constant distribution
		if (XM_DISTRIBUTION_CONSTANT === xm_distribution) {
			let c_items = 0;

			// iteratively find indexes to divide at
			for (;;) {
				// divide here
				if (++c_items >= n_items_per_division) {
					// dividing now would cause item overflow
					if (!--c_workers_remain) {
						// don't create any more divisions
						for (;;) yield false;
					}

					// division okay
					yield true;

					// how many items remain
					c_items_remain -= c_items;

					// reset item count for new worker
					c_items = 0;

					// recalculate target items per worker
					n_items_per_division = Math.floor(c_items_remain / c_workers_remain);
				}
				// push item
				else {
					yield false;
				}
			}
		}
	}


	// latent(h_dispatch) {
	// 	let {
	// 		task: s_task,
	// 		args: a_args_dispatch=[],
	// 		task_count: n_tasks=this.worker_count,
	// 		events: h_events_dispatch,
	// 	} = h_dispatch;

	// 	let i_subset = 0;

	// 	// prepare to deal with results
	// 	let k_planner = new active_group(this, n_tasks, (a_args=[], a_transfer=null) => {
	// 		// summon workers one at a time
	// 		this.summon_workers(1, (k_worker) => {
	// 			// result handler was not used; auto-end it
	// 			if(!k_planner.used) k_planner.end();

	// 			// make result handler
	// 			let fk_result = k_planner.mk_result(k_worker, i_subset++);

	// 			// make worker-specific events
	// 			let h_events_worker = this.event_router(h_events_dispatch, i_subset);

	// 			// execute worker on this part of data
	// 			k_worker.exec({
	// 				task: s_task,
	// 				args: [...a_args_dispatch, ...a_args],
	// 				transfer: a_transfer,
	// 				hold: k_planner.upstream_hold,
	// 				events: h_events_worker,
	// 			}, fk_result);
	// 		});
	// 	});

	// 	// let user bind handler
	// 	return k_planner;
	// }

	schedule(k_worker, f_run) {
		// worker available immediately
		if (k_worker.available) {
			f_run();
		}
		// push to priority queue
		else {
			this.roster.get(k_worker).push(f_run);
		}
	}

	assign_worker(k_worker, h_task, fk_task) {
		// once it is time to run the task on the given worker
		this.schedule(k_worker, () => {
			k_worker.exec(h_task, (...a_args) => {
				// worker just made itself available
				this.worker_available(k_worker);

				// callback
				fk_task(...a_args);
			});
		});
	}

	relay(h_relay, fk_result) {
		let {
			sender: {
				worker: k_worker_sender,
				task_id: i_task_sender,
			},
			receiver: {
				worker: k_worker_receiver,
				task_id: i_task_receiver,
			},
			receiver_primary: b_receiver_primary,
			task_ready: h_task_ready,
		} = h_relay;

		let s_sender = 'S' + String.fromCharCode(65 + k_worker_sender.id);
		let s_receiver = 'S' + String.fromCharCode(65 + k_worker_receiver.id);

		// create message channel
		let k_channel = new DC_CHANNEL(s_sender, s_receiver);

		if (k_worker_sender === k_worker_receiver) debugger;

		// console.warn(`M/relay/receive [${i_task_sender}] => ${i_task_receiver}`);

		// schedule receiver worker to receive data and then run task
		this.schedule(k_worker_receiver, () => {
			k_channel.port_2((d_port) => {
				k_worker_receiver.receive(d_port, {
					import: i_task_receiver,
					primary: b_receiver_primary,
					task_ready: h_task_ready,
				}, (...a_args) => {
					// worker just made itself available
					this.worker_available(k_worker_receiver);

					// callback
					fk_result(...a_args);
				});
			});
		});

		// schedule sender worker to relay data to receiver worker
		this.schedule(k_worker_sender, () => {
			k_channel.port_1((d_port) => {
				k_worker_sender.relay(i_task_sender, d_port, String.fromCharCode(65 + k_worker_receiver.id));

				// no result needed from relay; worker is available after message posts
				setTimeout(() => {
					this.worker_available(k_worker_sender);
				}, 0);
			});
		});

	}

	summon_workers(n_summons, fk_worker) {
		let a_workers = this.workers;
		let n_workers = this.worker_count;

		let c_summoned = 0;

		// start by looking for available workers
		let i_next_worker_summon = this.next_worker_summon;

		for (let i_worker = 0; i_worker < n_workers && c_summoned < n_summons; i_worker++) {
			let i_worker_call = (i_worker + i_next_worker_summon) % n_workers;
			let k_worker = a_workers[i_worker_call];

			// worker available immediately
			if (k_worker.available) {
				// set next worker to summon
				this.next_worker_summon = i_worker_call + 1;

				// save summon index
				let i_subset = c_summoned++;

				// allow downstream handler to be established first
				setTimeout(() => {
					// console.info(' => '+k_worker.id);
					fk_worker(k_worker, i_subset);
				}, 0);
			}
		}

		// there are remaining summons
		if (c_summoned < n_summons) {
			// queue for notification when workers become available
			this.wait_list.push({
				tasks_remaining: n_summons - c_summoned,
				each(k_worker) {
					fk_worker(k_worker, c_summoned++);
				},
			});
		}
	}

	worker_available(k_worker) {
		// this worker has priority tasks waiting for it
		let a_queue = this.roster.get(k_worker);
		if (a_queue.length) {
			// fifo pop and call
			let fk_worker = a_queue.shift();
			fk_worker();
		}
		// there is a wait list
		else if (this.wait_list.length) {
			// top of queue
			let h_patient = this.wait_list[0];

			// assign worker next task
			h_patient.each(k_worker);

			// this patient is satisfied; fifo pop
			if (0 === --h_patient.tasks_remaining) this.wait_list.shift();
		}
		// otherwise, free worker
		else {
			k_worker.available = true;
		}
	}

	kill(s_kill) {
		return Promise.all(this.workers.map((k_worker) => k_worker.kill(s_kill)));
	}
}


class armed_group {
	constructor(k_group, a_subsets) {
		Object.assign(this, {
			group: k_group,
			subsets: a_subsets,
		});
	}

	map(s_task, z_args = [], h_events_map = {}) {
		let {
			group: k_group,
			subsets: a_subsets,
		} = this;

		// how many subsets to process
		let nl_subsets = a_subsets.length;

		// prepare to deal with results
		let k_action = new active_group(k_group, nl_subsets);

		// create manifest object
		let k_manifest = manifest.from(z_args);

		// summon workers as they become available
		k_group.summon_workers(nl_subsets, (k_worker, i_subset) => {
			// if(h_dispatch.debug) debugger;

			// result handler was not used; auto-end it
			if (!k_action.piped) k_action.end();

			// make result handler
			let fk_result = k_action.mk_result(k_worker, i_subset);

			// make worker-specific events
			let h_events_worker = this.event_router(h_events_map, i_subset);

			// push subset to front of args
			let k_manifest_worker = k_manifest.prepend(a_subsets[i_subset]);

			// execute worker on next part of data
			k_worker.exec({
				task: s_task,
				manifest: k_manifest_worker,
				hold: k_action.upstream_hold,
				events: h_events_worker,
			}, fk_result);
		});

		// let user bind a handler
		return k_action;
	}

	event_router(h_events, i_subset) {
		if (!h_events) return null;

		// make a new hash that pushes worker index in front of callback args
		let h_events_local = {};
		for (let s_event in h_events) {
			let f_event = h_events[s_event];
			h_events_local[s_event] = (...a_args) => {
				f_event(i_subset, ...a_args);
			};
		}

		return h_events_local;
	}
}


class active_group {
	constructor(k_group, n_tasks, f_push = null) {
		Object.assign(this, {
			group: k_group,
			task_count: n_tasks,

			// whether or not the user has routed this stream yet
			piped: false,

			// link to next action downstream
			downstream: null,

			// whether or not the action upstream should hold data in worker
			upstream_hold: false,

			result_count: 0,

			result_callback: null,
			complete_callback: null,

			push: f_push || (() => {
				throw new Error(`cannot '.push()' here`);
			}),
			carry: null,

			reductions: null,
			reduce_task: null,

			results: null,
			sequence_index: 0,
		});
	}

	thru(s_task, z_args = [], h_events = null) {
		Object.assign(this, {
			piped: true,
			route: this.route_thru,
			upstream_hold: true,
			next_task: {
				task: s_task,
				manifest: manifest.from(z_args),
				events: h_events,
			},
		});

		return this.completable();
	}

	each(fk_result, fk_complete = null) {
		Object.assign(this, {
			piped: true,
			route: this.route_each,
			result_callback: fk_result,
			complete_callback: fk_complete,
		});

		return this.completable();
	}

	series(fk_result, fk_complete = null) {
		Object.assign(this, {
			piped: true,
			route: this.route_series,
			result_callback: fk_result,
			complete_callback: fk_complete,
			results: new Array(this.task_count),
		});

		return this.completable();
	}

	reduce(s_task, z_args = [], h_events = null) {
		return new Promise((f_resolve) => {
			Object.assign(this, {
				piped: true,
				route: this.route_reduce,
				complete_callback: f_resolve,
				upstream_hold: this.task_count > 1, // set `hold` flag for upstream sending its task
				reductions: new convergent_pairwise_tree(this.task_count),
				reduce_task: {
					task: s_task,
					manifest: new manifest(z_args),
					events: h_events,
					hold: true, // assume another reduction will be performed by default
				},
			});
		});
	}

	// results not handled
	route() {
		console.warn('result from worker was not handled! make sure to bind a handler before going async. use `.ignore()` if you do not care about the result');
	}

	route_thru(hp_notification, i_subset, k_worker, i_task) {
		// create specific task for worker to receive data from its previous task
		let h_task = Object.assign({
			receive: i_task,
			hold: this.downstream.upstream_hold,
		}, this.next_task);

		// assign worker new task
		this.group.assign_worker(k_worker, h_task, (...a_args) => {
			// mk result
			let f_result = this.downstream.mk_result(k_worker, i_subset);

			// trigger result
			f_result(...a_args);
		});
	}

	// return results immediately
	route_each(z_result, i_subset, k_worker, i_task) {
		this.handle_result_callback(z_result, i_subset, k_worker, i_task);

		// this was the last result
		if (++this.result_count === this.task_count && 'function' === typeof this.complete_callback) {
			this.complete_callback();
		}
	}

	route_series(z_result, i_subset, k_worker, i_task) {
		let {
			task_count: n_tasks,
			result_callback: fk_result,
			sequence_index: i_sequence,
			results: a_results,
		} = this;

		// result arrived while we were waiting for it
		if (i_subset === i_sequence) {
			// while there are results to process
			for (;;) {
				// process result
				this.handle_result_callback(z_result, i_sequence, k_worker, i_task);

				// reached end of sequence; that was last result
				if (++i_sequence === n_tasks) {
					// completion callback
					if ('function' === typeof this.complete_callback) {
						this.complete_callback();
					}

					// exit loop and save sequence index
					break;
				}

				// next result not yet ready
				let h_next_result = a_results[i_sequence];
				if (!h_next_result) break;

				// else; onto next result
				z_result = h_next_result;

				// release to gc
				a_results[i_sequence] = null;
			}
		}
		// not yet ready to process this result
		else {
			// store it for now
			a_results[i_subset] = z_result;
		}

		// update sequence index
		this.sequence_index = i_sequence;
	}

	route_reduce(hp_notification, i_subset, k_worker, i_task) {
		// debugger;

		// node initiation
		let h_canopy_node = this.reductions.ray(i_subset, {
			worker: k_worker,
			task_id: i_task,
		});

		// start at canopy node
		this.reduce_result(hp_notification, h_canopy_node);
	}

	// each time a worker completes
	reduce_result(z_result, h_node) {
		let {
			group: k_group,
			reductions: k_pairwise_tree,
			reduce_task: h_task_ready,
		} = this;

		// final result
		if (HP_WORKER_NOTIFICATION !== z_result) {
			let z_completion = this.complete_callback(z_result);

			// add to outer stream
			if (z_completion instanceof active_group) {
				let k_lake = this.lake();
				let fk_lake = k_lake.complete_callback;
				let hp_lock = Symbol('key');

				z_completion.end(() => {
					k_group.unlock(hp_lock);
				});

				// rewrap completion callback function
				k_lake.complete_callback = () => {
					k_group.wait(hp_lock, () => {
						fk_lake();
					});
				};
			}
		}
		// notification
		else {
			// able to perform a reduction
			let h_merge = k_pairwise_tree.commit(h_node);
			if (h_merge) {
				let k_worker = h_node.item.worker;

				// this reduction will be the last one; do not hold result
				if (h_merge.makes_root) {
					h_task_ready = Object.assign({}, h_task_ready);
					h_task_ready.hold = false;
				}

				// after reduction;
				let fk_reduction = (z_result_reduction, i_task_reduction, k_worker_reduction) => {
					// recurse on reduction; update sender for callback scope
					this.reduce_result(z_result_reduction, Object.assign(h_merge.node, {
						item: {
							worker: k_worker_reduction,
							task_id: i_task_reduction,
						},
					}));
				};

				// give reduction task to worker that finished earlier; pass to the right
				if (k_worker === h_merge.left.worker) {
					k_group.relay({
						sender: h_node.item,
						receiver: h_merge.right,
						receiver_primary: false,
						task_ready: h_task_ready,
					}, fk_reduction);
				}
				// pass to the left
				else {
					k_group.relay({
						sender: h_node.item,
						receiver: h_merge.left,
						receiver_primary: true,
						task_ready: h_task_ready,
					}, fk_reduction);
				}
			}
		}
	}

	route_end() {
		// this was the last result
		if (++this.result_count === this.task_count && 'function' === typeof this.complete_callback) {
			this.complete_callback();
		}
	}

	completable() {
		let fk_complete = this.complete_callback;

		// nothing to reduce; complete after establishing downstream
		if (!this.task_count && 'function' === typeof fk_complete) {
			setTimeout(fk_complete, 0);
		}

		return this.downstream = new active_group(this.group, this.task_count, this.push);
	}

	handle_result_callback(z_result, i_subset, k_worker, i_task) {
		let k_downstream = this.downstream;

		// apply callback and capture return
		let z_return = this.result_callback(z_result, i_subset);

		// downstream is expecting data for next task
		if (k_downstream && k_downstream.piped) {
			// nothing was returned; reuse input data
			if (undefined === z_return) {
				// downstream action was expecting worker to hold data
				if (k_downstream.upstream_hold) {
					throw 'not yet implemented';
				} else {
					k_downstream.route(z_result, i_subset, k_worker, i_task);
				}
			}
			// returned promise
			else if (z_return instanceof Promise) {
				z_return
					// await promise resolve
					.then((z_carry) => {
						k_downstream.route(z_carry, i_subset, k_worker, i_task);
					})
					// catch promise reject
					.catch((e_reject) => {
						throw new Error('uncaught rejection');
					});
			}
			// returned error
			else if (z_return instanceof Error) {
				throw new Error('not yet implemented');
			}
			// returned immediately
			else {
				k_downstream.route(z_return, i_subset, k_worker, i_task);
			}
		}
		// something was returned though
		else if (undefined !== z_return) {
			console.warn('a task stream handler return some value but it cannot be carried because downstream is not expecting task data');
			debugger;
		}
	}

	end(fk_complete = null) {
		Object.assign(this, {
			piped: true,
			route: this.route_end,
			complete_callback: fk_complete,
		});
	}


	mk_result(k_worker, i_subset) {
		// for when a result arrives
		return (z_result, i_task) => {
			// this worker just made itself available
			this.group.worker_available(k_worker);

			// route the result
			this.route(z_result, i_subset, k_worker, i_task);
		};
	}

	// traverse all the way downstream
	lake() {
		let k_downstream = this;
		for (;;) {
			if (k_downstream.downstream) k_downstream = k_downstream.downstream;
			else break;
		}
		return k_downstream;
	}
}


function divide(a_things, n_workers, xm_strategy, h_divide = {}) {
	let nl_things = a_things.length;

	let {
		item_count: c_items_remain = nl_things,
		open: f_open = null,
		seal: f_seal = null,
		quantify: f_quantify = () => {
			throw new Error(`must provide function for key 'quantify' when using '.balance_ordered_groups()'`);
		},
	} = h_divide;

	let a_tasks = [];

	if (Array.isArray(a_things)) {
		// do not assign workers to nothing
		if (nl_things < n_workers) n_workers = nl_things;

		// items per worker
		let x_items_per_worker = Math.floor(c_items_remain / n_workers);

		// distribute items equally
		if (XM_STRATEGY_EQUAL === xm_strategy) {
			// start index of slice
			let i_start = 0;

			// each worker
			for (let i_worker = 0; i_worker < n_workers; i_worker++) {
				// find end index of worker; ensure all items find a worker
				let i_end = (i_worker === n_workers - 1) ? nl_things : i_start + x_items_per_worker;

				// extract slice from things and push to divisions
				a_tasks.push(a_things.slice(i_start, i_end));

				// advance index for next division
				i_start = i_end;

				// update number of items remaining
				c_items_remain -= x_items_per_worker;

				// recalculate target items per worker
				x_items_per_worker = Math.floor(c_items_remain / (n_workers - i_worker - 1));
			}
		}
		// ordered groups
		else if (XM_STRATEGY_ORDERED_GROUPS & xm_strategy) {
			let i_worker = 0;
			let c_worker_items = 0;

			// open new task item list
			let a_task_items = [];
			let z_task_data = f_open ? f_open(a_task_items) : a_task_items;

			// each group
			for (let i_group = 0; i_group < nl_things; i_group++) {
				let h_group = a_things[i_group];
				let n_group_items = f_quantify(h_group);

				// adding this to current worker would exceed target load (make sure this isn't final worker)
				let n_worker_items_preview = n_group_items + c_worker_items;
				if ((n_worker_items_preview > x_items_per_worker) && i_worker < n_workers - 1) {
					let b_advance_group = false;

					// balance mode
					if (XM_STRATEGY_ORDERED_GROUPS_BALANCED === xm_strategy) {
						// preview is closer to target; add task item to worker before advancing
						if ((n_worker_items_preview - x_items_per_worker) < (x_items_per_worker - c_worker_items)) {
							a_task_items.push(h_group);
							c_worker_items = n_worker_items_preview;

							// advance group after new task
							b_advance_group = true;
						}
					}

					// add task item to output (transforming it when appropriate)
					a_tasks.push(f_seal ? f_seal(z_task_data) : z_task_data);

					// next task item list
					a_task_items = [];
					c_items_remain -= c_worker_items;
					x_items_per_worker = c_items_remain / (n_workers - (++i_worker));
					c_worker_items = 0;

					// task item open
					z_task_data = f_open ? f_open(a_task_items) : a_task_items;

					// advance group
					if (b_advance_group) continue;
				}

				// add task to list
				a_task_items.push(h_group);
				c_worker_items += n_group_items;
			}

			// add final task item
			a_tasks.push(f_seal ? f_seal(z_task_data) : z_task_data);
		}
		// unknown strategy
		else {
			throw new RangeError('no such strategy');
		}
	}
	// typed array
	else if ('byteLength' in a_things) {
		// divide 
		throw 'not yet implemented';
	}
	// unsupported type
	else {
		throw new Error('worker can only divide data in arrays (either plain or typed)');
	}

	return a_tasks;
}


class convergent_pairwise_tree {
	constructor(n_items) {
		let a_canopy = [];
		for (let i_item = 0; i_item < n_items; i_item++) {
			a_canopy.push({
				ready: false,
				up: null,
				item: null,
				left: i_item - 1,
				right: i_item + 1,
			});
		}

		Object.assign(this, {
			item_count: n_items,
			canopy: a_canopy,
		});
	}

	ray(i_item, z_item) {
		let h_node = this.canopy[i_item];
		h_node.item = z_item;
		return h_node;
	}

	top(h_top) {
		for (;;) {
			let h_up = h_top.up;
			if (h_up) h_top = h_up;
			else break;
		}
		return h_top;
	}

	merge(h_left, h_right) {
		let n_items = this.item_count;

		let h_node = {
			ready: false,
			up: null,
			item: null,
			left: h_left.left,
			right: h_right.right,
		};

		h_left.up = h_right.up = h_node;

		return {
			node: h_node,
			left: h_left.item,
			right: h_right.item,
			makes_root: -1 === h_left.left && n_items === h_right.right,
		};
	}

	commit(h_node) {
		let n_items = this.item_count;
		let a_canopy = this.canopy;

		// left edge of list
		if (-1 === h_node.left) {
			// tree root was handed to commit
			if (h_node.right === n_items) {
				throw new Error('cannot commit root!');
			}

			// neighbor on right side
			let h_right = this.top(a_canopy[h_node.right]);

			// neighbor is ready!
			if (h_right.ready) {
				return this.merge(h_node, h_right);
			}
			// neighbor is busy/not ready; mark this item as ready
			else {
				h_node.ready = true;
			}
		}
		// right edge of list
		else if (n_items === h_node.right) {
			// neighbor on left side
			let h_left = this.top(a_canopy[h_node.left]);

			// neighbor is ready
			if (h_left.ready) {
				return this.merge(h_left, h_node);
			}
			// neighbor is busy/not ready; mark this item as ready
			else {
				h_node.ready = true;
			}
		}
		// somewhere in the middle
		else {
			// start with left neighbor
			let h_left = this.top(a_canopy[h_node.left]);

			// neighbor is ready
			if (h_left.ready) {
				return this.merge(h_left, h_node);
			}
			// neighbor is busy/not ready
			else {
				// try right neighbor
				let h_right = this.top(a_canopy[h_node.right]);

				// neighbor is ready
				if (h_right.ready) {
					return this.merge(h_node, h_right);
				}
				// neighbor is busy/not ready; mark this item as ready
				else {
					h_node.ready = true;
				}
			}
		}

		return null;
	}
}


module.exports = function(dc_worker) {
	worker = dc_worker;
	return group;
};
},{"./locals.js":3,"./manifest.js":4}],3:[function(require,module,exports){
(function (process){
// deduce the runtime environment
const [B_BROWSER, B_BROWSERIFY] = (() => 'undefined' === typeof process ?
	[true, false] :
	(process.browser ?
		[true, true] :
		('undefined' === process.versions || 'undefined' === process.versions.node ?
			[true, false] :
			[false, false])))();


const locals = Object.assign({
	B_BROWSER,
	B_BROWSERIFY,

	HP_WORKER_NOTIFICATION: Symbol('worker notification'),
}, B_BROWSER ? require('../browser/locals.js') : require('../node/locals.js'));


locals.webworkerify = function(z_import, h_config = {}) {
	const [F_FUNCTION_BUNDLE, H_SOURCES, H_CACHE] = h_config.browserify;
	let s_worker_key = '';
	for (let s_cache_key in H_CACHE) {
		let z_exports = H_CACHE[s_cache_key].exports;
		if (z_import === z_exports || z_import === z_exports.default) {
			s_worker_key = s_cache_key;
			break;
		}
	}

	if (!s_worker_key) {
		s_worker_key = Math.floor(Math.pow(16, 8) * Math.random()).toString(16);
		let h_cache_worker = {};
		for (let s_key_cache in H_SOURCES) {
			h_cache_worker[s_key_cache] = s_key_cache;
		}
		H_SOURCES[s_worker_key] = [
			new Function(['require', 'module', 'exports'], `(${z_import})(self);`),
			h_cache_worker,
		];
	}

	let s_source_key = Math.floor(Math.pow(16, 8) * Math.random()).toString(16);
	H_SOURCES[s_source_key] = [
		new Function(['require'], `
			let f = require(${JSON.stringify(s_worker_key)});
			// debugger;
			// (f.default? f.default: f)(self);
		`),
		{
			[s_worker_key]: s_worker_key
		},
	];

	let h_worker_sources = {};

	function resolve_sources(s_key) {
		h_worker_sources[s_key] = true;
		let h_source = H_SOURCES[s_key][1];
		for (let p_dependency in h_source) {
			let s_dependency_key = h_source[p_dependency];
			if (!h_worker_sources[s_dependency_key]) {
				resolve_sources(s_dependency_key);
			}
		}
	}
	resolve_sources(s_source_key);

	let s_source = `(${F_FUNCTION_BUNDLE})({
		${Object.keys(h_worker_sources).map((s_key) => {
			let a_source = H_SOURCES[s_key];
			return JSON.stringify(s_key)
				+`:[${a_source[0]},${JSON.stringify(a_source[1])}]`;
		})}
	}, {}, [${JSON.stringify(s_source_key)}])`;

	let d_blob = new Blob([s_source], {
		type: 'text/javascript'
	});
	if (h_config.bare) {
		return d_blob;
	}
	let p_worker_url = URL.createObjectURL(d_blob);
	let d_worker = new locals.DC_WORKER(p_worker_url, h_config.worker_options);
	// d_worker.objectURL = p_worker_url;
	// d_worker.source = d_blob;
	d_worker.source = s_source;
	return d_worker;
};


module.exports = locals;
}).call(this,require('_process'))

},{"../browser/locals.js":9,"../node/locals.js":18,"_process":22}],4:[function(require,module,exports){
const {
	sharing,
} = require('./locals.js');

module.exports = class manifest {
	static from(z_other) {
		// manifest
		if (z_other instanceof manifest) {
			return z_other;
		}
		// any
		else {
			return new manifest(z_other, []);
		}
	}

	constructor(a_data = [], z_transfer_paths = true) {
		// not an array
		if (!Array.isArray(a_data)) {
			throw new Error('a manifest represents an array of arguments; pass the constructor an array');
		}

		// not a list; find transfers manually
		let a_transfer_paths = z_transfer_paths;
		if (!Array.isArray(a_transfer_paths)) {
			a_transfer_paths = this.extract(a_data);
		}
		// only check top level
		else {
			let a_transfers = [];
			for (let i_datum = 0, nl_data = a_data.length; i_datum < nl_data; i_datum++) {
				let z_datum = a_data[i_datum];

				// shareable item
				if (sharing(z_datum)) a_transfers.push([i_datum]);
			}

			// solidify transfers
			if (a_transfers.length) {
				a_transfer_paths = a_transfers;
			}
		}

		Object.assign(this, {
			data: a_data,
			transfer_paths: a_transfer_paths,
		});
	}

	extract(z_data, a_path = [], zi_path_last = null) {
		// protect against [object] null
		if (!z_data) return [];

		// set of paths
		let a_paths = [];

		// object
		if ('object' === typeof z_data) {
			// copy path
			a_path = a_path.slice();

			// commit to it
			if (null !== zi_path_last) a_path.push(zi_path_last);

			// plain object literal
			if (Object === z_data.constructor) {
				// scan over enumerable properties
				for (let s_property in z_data) {
					// extract data and transfers by recursing on property
					a_paths.push(...this.extract(z_data[s_property], a_path, s_property));
				}
			}
			// array
			else if (Array.isArray(z_data)) {
				// empty array
				if (!z_data.length) return [];

				// scan over each item
				z_data.forEach((z_item, i_item) => {
					// extract data and transfers by recursing on item
					a_paths.push(...this.extract(z_item, a_path, i_item));
				});
			}
			// shareable data
			else if (sharing(z_data)) {
				return [a_path];
			}
		}

		// return paths
		return a_paths;
	}

	prepend(z_arg) {
		// copy items
		let a_items = this.data.slice();

		// copy transfer paths
		let a_transfer_paths = this.transfer_paths.slice();

		// push a manifest to front
		if (z_arg instanceof manifest) {
			// add its contents as a single item
			a_items.unshift(z_arg.data);

			// how many paths to offset import by
			let nl_paths = a_transfer_paths.length;

			// update import paths (primary index needs update)
			let a_import_paths = z_arg.transfer_paths;
			a_import_paths.forEach((a_path) => {
				a_path[0] += nl_paths;
			});

			// append its transfer paths
			a_transfer_paths.push(a_import_paths);
		}
		// anything else
		else {
			// just add to front
			a_items.unshift(z_arg);
		}

		// create new manifest
		return new manifest(a_items, a_transfer_paths);
	}

	paths(...a_unshift) {
		return this.transfer_paths.map((a_path) => {
			return [...a_unshift, ...a_path];
		});
	}
};
},{"./locals.js":3}],5:[function(require,module,exports){
const {
	N_CORES,
} = require('./locals.js');

module.exports = class pool {
	constructor(p_source, n_workers = N_CORES, h_worker_options = {}) {
		// no worker count given; default to number of cores
		if (!n_workers) n_workers = N_CORES;

		// fields
		Object.assign(this, {
			source: p_source,
			limit: n_workers,
			workers: [],
			history: [],
			wait_list: [],
		});
	}

	run(s_task, a_args, h_events) {
		this.history.push(new Promise(async (f_resolve, f_reject) => {
			// summon a worker
			let k_worker = await this.summon();

			// run this task
			let z_result;
			try {
				z_result = await k_worker.run(s_task, a_args, h_events);
			}
			// error while running task
			catch (e_run) {
				return f_reject(e_run);
			}
			// worker is available now
			finally {
				let a_wait_list = this.wait_list;

				// at least one task is queued
				if (a_wait_list.length) {
					a_wait_list.shift()(k_worker);
				}
			}

			// resolve promise
			f_resolve(z_result);
		}));
	}

	async kill(s_signal) {
		return await Promise.all(this.workers.map((k_worker) => k_worker.kill(s_signal)));
	}

	start() {
		this.history.length = 0;
	}

	async stop() {
		// cache history
		let a_history = this.history;

		// reset start point
		this.start();

		// await all promises to finish
		return await Promise.all(a_history);
	}

	async summon() {
		let a_workers = this.workers;

		// each worker
		for (let i_worker = 0, nl_workers = a_workers.length; i_worker < nl_workers; i_worker++) {
			let k_worker = a_workers[i_worker];

			// worker not busy
			if (!k_worker.busy) {
				return k_worker;
			}
		}

		// room to grow
		if (a_workers.length < this.limit) {
			// create new worker
			let k_worker = new worker({
				source: p_source,
				id: a_workers.length,
				master: this,
				options: h_worker_options,
			});

			// add to pool
			a_workers.push(k_worker);

			// it's available now
			return k_worker;
		}

		// queue for notification when workers become available
		this.wait_list.push((k_worker) => {
			fk_worker(k_worker, c_summoned++);
		});
	}
};
},{"./locals.js":3}],6:[function(require,module,exports){
const manifest = require('./manifest.js');

module.exports = class result extends manifest {
	static from(z_item) {
		if (z_item instanceof result) {
			return z_item;
		} else {
			return new result(z_item);
		}
	}

	constructor(z_result, z_transfer_paths = true) {
		super([z_result], z_transfer_paths);
	}

	prepend() {
		throw new Error('cannot prepend a result');
	}
};
},{"./manifest.js":4}],7:[function(require,module,exports){
const events = require('./events.js');

module.exports = class channel extends MessageChannel {
	port_1(fk_port) {
		fk_port(events(this.port1));
	}

	port_2(fk_port) {
		fk_port(events(this.port2));
	}
};
},{"./events.js":8}],8:[function(require,module,exports){
module.exports = (dz_thing) => {
	Object.assign(dz_thing, {
		events(h_events) {
			for (let s_event in h_events) {
				this['on' + s_event] = h_events[s_event];
			}
		},

		event(s_event, f_event) {
			this['on' + s_event] = f_event;
		},
	});

	return dz_thing;
};
},{}],9:[function(require,module,exports){
module.exports = {
	K_SELF: require('./self.js'),
	DC_WORKER: 'undefined' === typeof Worker ? undefined : require('./worker.js'),
	DC_CHANNEL: require('./channel.js'),
	H_TYPED_ARRAYS: require('./typed-arrays.js'),
	N_CORES: navigator.hardwareConcurrency || 1,
	sharing: require('./sharing.js'),
	stream: require('./stream.js'),
	ports: require('./ports.js'),
};
},{"./channel.js":7,"./ports.js":10,"./self.js":11,"./sharing.js":12,"./stream.js":13,"./typed-arrays.js":14,"./worker.js":15}],10:[function(require,module,exports){
const events = require('./events.js');

module.exports = (d_port) => events(d_port);
},{"./events.js":8}],11:[function(require,module,exports){
const events = require('./events.js');

events(self);

self.args = [
	(Math.random() + '').slice(2, 8),
];

module.exports = self;
},{"./events.js":8}],12:[function(require,module,exports){
const $_SHAREABLE = Symbol('shareable');

function extract(z_data, as_transfers = null) {
	// protect against [object] null
	if (!z_data) return [];

	// set of transfer objects
	if (!as_transfers) as_transfers = new Set();

	// object
	if ('object' === typeof z_data) {
		// plain object literal
		if (Object === z_data.constructor) {
			// scan over enumerable properties
			for (let s_property in z_data) {
				// add each transferable from recursion to own set
				extract(z_data[s_property], as_transfers);
			}
		}
		// array
		else if (Array.isArray(z_data)) {
			// scan over each item
			z_data.forEach((z_item) => {
				// add each transferable from recursion to own set
				extract(z_item, as_transfers);
			});
		}
		// typed array, data view or array buffer
		else if (ArrayBuffer.isView(z_data)) {
			as_transfers.add(z_data.buffer);
		}
		// array buffer
		else if (z_data instanceof ArrayBuffer) {
			as_transfers.add(z_data);
		}
		// message port
		else if (z_data instanceof MessagePort) {
			as_transfers.add(z_data);
		}
		// image bitmap
		else if (z_data instanceof ImageBitmap) {
			as_transfers.add(z_data);
		}
	}
	// function
	else if ('function' === typeof z_data) {
		// scan over enumerable properties
		for (let s_property in z_data) {
			// add each transferable from recursion to own set
			extract(z_data[s_property], as_transfers);
		}
	}
	// nothing
	else {
		return [];
	}

	// convert set to array
	return Array.from(as_transfers);
}

module.exports = Object.assign(function(z_object) {
	return ArrayBuffer.isView(z_object) ||
		z_object instanceof ArrayBuffer ||
		z_object instanceof MessagePort ||
		z_object instanceof ImageBitmap;
}, {
	$_SHAREABLE,

	extract,
});
},{}],13:[function(require,module,exports){
const events = require('events');

class readable_stream extends events.EventEmitter {
	constructor() {
		super();

		Object.assign(this, {
			decoder: null,
			paused: false,
			consumed: 0,
		});
	}

	setEncoding(s_encoding) {
		this.decoder = new TextDecoder(s_encoding);
	}

	pause() {
		this.paused = true;
	}

	resume() {
		this.paused = false;
		this.next_chunk();
	}

	chunk(at_chunk, b_eof) {
		let nl_chunk = at_chunk.length;
		this.consumed += nl_chunk;

		// decode data
		if (this.decoder) {
			let s_data;
			try {
				s_data = this.decoder.decode(at_chunk, {
					stream: !b_eof
				});
			} catch (e_decode) {
				this.emit('error', e_decode);
			}

			this.emit('data', s_data, at_chunk);
		}
		// no encoding
		else {
			this.emit('data', at_chunk, at_chunk);
		}

		// end of file
		if (b_eof) {
			setTimeout(() => {
				this.emit('end');
			}, 0);
		}
		// request more data
		else if (!this.paused) {
			this.next_chunk();
		}
	}
}

Object.assign(readable_stream.prototype, {
	emitsByteCounts: true,
});

class readable_stream_via_port extends readable_stream {
	constructor(d_port) {
		super();

		// message handling
		d_port.onmessage = (d_msg) => {
			let {
				content: at_content,
				eof: b_eof,
			} = d_msg.data;

			// start timing
			this.started = performance.now();

			// process chunk
			this.chunk(at_content, b_eof);
		};

		Object.assign(this, {
			port: d_port,
			started: 0,
		});
	}

	setEncoding(s_encoding) {
		this.decoder = new TextDecoder(s_encoding);
	}

	next_chunk() {
		let t_elapsed = performance.now() - this.started;

		// console.log('S ==> [ACK / next chunk]');

		this.port.postMessage({
			posted: performance.now(),
			elapsed: t_elapsed,
		});
	}

	// pause() {

	// }

	// resume(b_dont_unpause=false) {
	// 	let t_elapsed = performance.now() - this.started;

	// 	self.postMessage({
	// 		elapsed: t_elapsed,
	// 	});
	// }

	// pipe(y_writable) {
	// 	this.on('data', (z_chunk) => {
	// 		let b_capacity = y_writable.write(z_chunk);

	// 		// fetch next chunk; otherwise await drain
	// 		if(false !== b_capacity) {
	// 			this.resume(true);
	// 		}
	// 	});

	// 	y_writable.on('drain', () => {
	// 		this.resume(true);
	// 	});

	// 	y_writable.emit('pipe', this);
	// }
}



class readable_stream_via_object_url extends readable_stream {
	constructor(p_object_url, h_config = {}) {
		super();

		fetch(p_object_url)
			.then(d_res => d_res.blob())
			.then((dfb_input) => {
				if (this.onblob) this.onblob(dfb_input);
				let k_blob_reader = this.blob_reader = new blob_reader(this, dfb_input, h_config);
				this.on('end', () => {
					debugger;
					URL.revokeObjectURL(p_object_url);
				});
				k_blob_reader.next_chunk();
			});

		Object.assign(this, {
			blob_reader: null,
			object_url: p_object_url,
		});
	}

	next_chunk() {
		this.blob_reader.next_chunk();
	}

	// on(s_event, fk_event) {
	// 	super.on(s_event, fk_event);

	// 	if('data' === s_event) {
	// 		if(!this.blob) {
	// 			this.on_blob = this.resume;
	// 		}
	// 		else {
	// 			this.resume();
	// 		}
	// 	}
	// }
}

class transfer_stream {
	constructor() {
		let d_channel = new MessageChannel();
		let d_port = d_channel.port1;

		d_port.onmessage = (d_msg) => {
			let t_elapsed_main = this.elapsed;

			let {
				posted: t_posted,
				elapsed: t_elapsed_other,
			} = d_msg.data;

			// console.log(' ++ parse: '+t_elapsed_other);
			this.receiver_elapsed += t_elapsed_other;

			// console.log('M <== [ACK / next chunk]; buffer: '+(!!this.buffer)+'; busy: '+this.receiver_busy+'; eof:'+this.reader.eof);  //posted @'+t_posted);

			// receiver is free
			this.receiver_busy = false;

			// chunk ready to go
			if (this.buffer) {
				this.send(this.buffer, this.buffer_eof);
				this.buffer = null;
			}

			// reader is not busy
			if (!this.reader.busy) {
				this.reader.next_chunk();
			}
		};

		Object.assign(this, {
			main_port: d_port,
			other_port: d_channel.port2,
			elapsed: 0,
			reader: null,
			buffer: null,
			buffer_eof: true,
			receiver_busy: false,
			receiver_elapsed: 0,
		});
	}

	send(at_chunk, b_eof = true) {
		this.receiver_busy = true;

		// console.log('M ==> [chunk]');

		// send to receiver
		this.main_port.postMessage({
			content: at_chunk,
			eof: b_eof,
		}, [at_chunk.buffer]);
	}

	chunk(at_chunk, b_eof = true) {
		// console.log('blob chunk ready to send; buffer: '+(!!this.buffer)+'; busy: '+this.receiver_busy);

		// receiver is busy, queue in buffer
		if (this.receiver_busy) {
			this.buffer = at_chunk;
			this.buffer_eof = b_eof;
		}
		// receiver available; send immediately
		else {
			// prefetch next chunk
			if (!this.buffer && !this.reader.eof) {
				this.reader.next_chunk();
			}

			this.send(at_chunk, b_eof);
		}
	}

	blob(dfb_input, h_config = {}) {
		this.reader = new blob_reader(this, dfb_input, h_config);

		// start sending
		this.reader.next_chunk();
	}
}

class blob_reader {
	constructor(k_parent, dfb_input, h_config = {}) {
		let dfr_reader = new FileReader();
		dfr_reader.onload = (d_event) => {
			this.busy = false;
			// let b_eof = false;
			// if(++this.chunks_read === this.chunks_loaded) b_eof = this.eof;
			k_parent.chunk(new Uint8Array(d_event.target.result), this.eof);
		};

		Object.assign(this, {
			eof: false,
			busy: false,
			read_index: 0,
			chunk_size: h_config.chunk_size || h_config.chunkSize || 1024 * 1024 * 1, // 1 MiB
			content: dfb_input,
			content_length: dfb_input.size,
			file_reader: dfr_reader,
			chunks_loaded: 0,
			chunks_read: 0,
		});
	}

	next_chunk() {
		let {
			read_index: i_read,
			chunk_size: n_chunk_size,
			content: dfb_content,
			content_length: nl_content,
		} = this;

		let i_end = i_read + n_chunk_size;
		if (i_end >= nl_content) {
			i_end = nl_content;
			this.eof = true;
		}

		this.busy = true;
		this.chunks_loaded += 1;

		let dfb_slice = dfb_content.slice(i_read, i_end);
		this.read_index = i_end;

		this.file_reader.readAsArrayBuffer(dfb_slice);
	}
}


module.exports = Object.assign(function(z_input = null) {
	if (z_input) {
		// make readable stream from object url's blob
		if ('string' === typeof z_input) {
			return new readable_stream_via_object_url(z_input);
		}
		// make readable stream atop port
		else if (z_input instanceof MessagePort) {
			return new readable_stream_via_port(z_input);
		}
	}
	// transfer a stream
	else {
		return new transfer_stream();
	}
}, {
	handler: class handler {},
});
},{"events":20}],14:[function(require,module,exports){
const sharing = require('./sharing.js');
const TypedArray = Object.getPrototypeOf(Object.getPrototypeOf(new Uint8Array(0))).constructor;





class Int8ArrayS extends Int8Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if ('number' === typeof z_arg_0) {
			// create shared memory segment
			at_self = new Int8Array(new SharedArrayBuffer(s_how));

		}
		// typed array constructor
		else if (z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if (sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				// create shared memory segment
				at_self = new Int8Array(new SharedArrayBuffer(s_how));

				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if (z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if (undefined === nl_array) {
				nl_array = z_arg_0.length - nb_offset;
			}

			// array size in bytes
			let nb_array = nl_array;

			// create shared memory segment
			let dsb = new SharedArrayBuffer(nb_array);

			// create typed array
			at_self = new Int8Array(dsb, 0, nb_array);

			// create copy src
			let at_src = new Int8Array(z_arg_0, nb_offset, nl_array);

			// copy data over
			at_self.set(at_src);
		}

		// create self
		super(at_self);

		// save fields
		Object.assign(this, h_this);
	}

	base(...a_args) {
		return new Int8Array(...a_args);
	}
}

// static field
Object.assign(Int8ArrayS.prototype, {
	[sharing.$_SHAREABLE]: 1,
});


class Uint8ArrayS extends Uint8Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if ('number' === typeof z_arg_0) {
			// create shared memory segment
			at_self = new Uint8Array(new SharedArrayBuffer(s_how));

		}
		// typed array constructor
		else if (z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if (sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				// create shared memory segment
				at_self = new Uint8Array(new SharedArrayBuffer(s_how));

				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if (z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if (undefined === nl_array) {
				nl_array = z_arg_0.length - nb_offset;
			}

			// array size in bytes
			let nb_array = nl_array;

			// create shared memory segment
			let dsb = new SharedArrayBuffer(nb_array);

			// create typed array
			at_self = new Uint8Array(dsb, 0, nb_array);

			// create copy src
			let at_src = new Uint8Array(z_arg_0, nb_offset, nl_array);

			// copy data over
			at_self.set(at_src);
		}

		// create self
		super(at_self);

		// save fields
		Object.assign(this, h_this);
	}

	base(...a_args) {
		return new Uint8Array(...a_args);
	}
}

// static field
Object.assign(Uint8ArrayS.prototype, {
	[sharing.$_SHAREABLE]: 1,
});


class Uint8ClampedArrayS extends Uint8ClampedArray {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if ('number' === typeof z_arg_0) {
			// create shared memory segment
			at_self = new Uint8ClampedArray(new SharedArrayBuffer(s_how));

		}
		// typed array constructor
		else if (z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if (sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				// create shared memory segment
				at_self = new Uint8ClampedArray(new SharedArrayBuffer(s_how));

				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if (z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if (undefined === nl_array) {
				nl_array = z_arg_0.length - nb_offset;
			}

			// array size in bytes
			let nb_array = nl_array;

			// create shared memory segment
			let dsb = new SharedArrayBuffer(nb_array);

			// create typed array
			at_self = new Uint8ClampedArray(dsb, 0, nb_array);

			// create copy src
			let at_src = new Uint8ClampedArray(z_arg_0, nb_offset, nl_array);

			// copy data over
			at_self.set(at_src);
		}

		// create self
		super(at_self);

		// save fields
		Object.assign(this, h_this);
	}

	base(...a_args) {
		return new Uint8ClampedArray(...a_args);
	}
}

// static field
Object.assign(Uint8ClampedArrayS.prototype, {
	[sharing.$_SHAREABLE]: 1,
});


class Int16ArrayS extends Int16Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if ('number' === typeof z_arg_0) {
			// create shared memory segment
			at_self = new Int16Array(new SharedArrayBuffer(s_how));

		}
		// typed array constructor
		else if (z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if (sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				// create shared memory segment
				at_self = new Int16Array(new SharedArrayBuffer(s_how));

				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if (z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if (undefined === nl_array) {
				nl_array = z_arg_0.length - nb_offset;
			}

			// array size in bytes
			let nb_array = nl_array << 1;

			// create shared memory segment
			let dsb = new SharedArrayBuffer(nb_array);

			// create typed array
			at_self = new Int16Array(dsb, 0, nb_array);

			// create copy src
			let at_src = new Int16Array(z_arg_0, nb_offset, nl_array);

			// copy data over
			at_self.set(at_src);
		}

		// create self
		super(at_self);

		// save fields
		Object.assign(this, h_this);
	}

	base(...a_args) {
		return new Int16Array(...a_args);
	}
}

// static field
Object.assign(Int16ArrayS.prototype, {
	[sharing.$_SHAREABLE]: 1,
});


class Uint16ArrayS extends Uint16Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if ('number' === typeof z_arg_0) {
			// create shared memory segment
			at_self = new Uint16Array(new SharedArrayBuffer(s_how));

		}
		// typed array constructor
		else if (z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if (sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				// create shared memory segment
				at_self = new Uint16Array(new SharedArrayBuffer(s_how));

				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if (z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if (undefined === nl_array) {
				nl_array = z_arg_0.length - nb_offset;
			}

			// array size in bytes
			let nb_array = nl_array << 1;

			// create shared memory segment
			let dsb = new SharedArrayBuffer(nb_array);

			// create typed array
			at_self = new Uint16Array(dsb, 0, nb_array);

			// create copy src
			let at_src = new Uint16Array(z_arg_0, nb_offset, nl_array);

			// copy data over
			at_self.set(at_src);
		}

		// create self
		super(at_self);

		// save fields
		Object.assign(this, h_this);
	}

	base(...a_args) {
		return new Uint16Array(...a_args);
	}
}

// static field
Object.assign(Uint16ArrayS.prototype, {
	[sharing.$_SHAREABLE]: 1,
});


class Int32ArrayS extends Int32Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if ('number' === typeof z_arg_0) {
			// create shared memory segment
			at_self = new Int32Array(new SharedArrayBuffer(s_how));

		}
		// typed array constructor
		else if (z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if (sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				// create shared memory segment
				at_self = new Int32Array(new SharedArrayBuffer(s_how));

				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if (z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if (undefined === nl_array) {
				nl_array = z_arg_0.length - nb_offset;
			}

			// array size in bytes
			let nb_array = nl_array << 2;

			// create shared memory segment
			let dsb = new SharedArrayBuffer(nb_array);

			// create typed array
			at_self = new Int32Array(dsb, 0, nb_array);

			// create copy src
			let at_src = new Int32Array(z_arg_0, nb_offset, nl_array);

			// copy data over
			at_self.set(at_src);
		}

		// create self
		super(at_self);

		// save fields
		Object.assign(this, h_this);
	}

	base(...a_args) {
		return new Int32Array(...a_args);
	}
}

// static field
Object.assign(Int32ArrayS.prototype, {
	[sharing.$_SHAREABLE]: 1,
});


class Uint32ArrayS extends Uint32Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if ('number' === typeof z_arg_0) {
			// create shared memory segment
			at_self = new Uint32Array(new SharedArrayBuffer(s_how));

		}
		// typed array constructor
		else if (z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if (sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				// create shared memory segment
				at_self = new Uint32Array(new SharedArrayBuffer(s_how));

				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if (z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if (undefined === nl_array) {
				nl_array = z_arg_0.length - nb_offset;
			}

			// array size in bytes
			let nb_array = nl_array << 2;

			// create shared memory segment
			let dsb = new SharedArrayBuffer(nb_array);

			// create typed array
			at_self = new Uint32Array(dsb, 0, nb_array);

			// create copy src
			let at_src = new Uint32Array(z_arg_0, nb_offset, nl_array);

			// copy data over
			at_self.set(at_src);
		}

		// create self
		super(at_self);

		// save fields
		Object.assign(this, h_this);
	}

	base(...a_args) {
		return new Uint32Array(...a_args);
	}
}

// static field
Object.assign(Uint32ArrayS.prototype, {
	[sharing.$_SHAREABLE]: 1,
});


class Float32ArrayS extends Float32Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if ('number' === typeof z_arg_0) {
			// create shared memory segment
			at_self = new Float32Array(new SharedArrayBuffer(s_how));

		}
		// typed array constructor
		else if (z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if (sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				// create shared memory segment
				at_self = new Float32Array(new SharedArrayBuffer(s_how));

				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if (z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if (undefined === nl_array) {
				nl_array = z_arg_0.length - nb_offset;
			}

			// array size in bytes
			let nb_array = nl_array << 2;

			// create shared memory segment
			let dsb = new SharedArrayBuffer(nb_array);

			// create typed array
			at_self = new Float32Array(dsb, 0, nb_array);

			// create copy src
			let at_src = new Float32Array(z_arg_0, nb_offset, nl_array);

			// copy data over
			at_self.set(at_src);
		}

		// create self
		super(at_self);

		// save fields
		Object.assign(this, h_this);
	}

	base(...a_args) {
		return new Float32Array(...a_args);
	}
}

// static field
Object.assign(Float32ArrayS.prototype, {
	[sharing.$_SHAREABLE]: 1,
});


class Float64ArrayS extends Float64Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if ('number' === typeof z_arg_0) {
			// create shared memory segment
			at_self = new Float64Array(new SharedArrayBuffer(s_how));

		}
		// typed array constructor
		else if (z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if (sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				// create shared memory segment
				at_self = new Float64Array(new SharedArrayBuffer(s_how));

				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if (z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if (undefined === nl_array) {
				nl_array = z_arg_0.length - nb_offset;
			}

			// array size in bytes
			let nb_array = nl_array << 4;

			// create shared memory segment
			let dsb = new SharedArrayBuffer(nb_array);

			// create typed array
			at_self = new Float64Array(dsb, 0, nb_array);

			// create copy src
			let at_src = new Float64Array(z_arg_0, nb_offset, nl_array);

			// copy data over
			at_self.set(at_src);
		}

		// create self
		super(at_self);

		// save fields
		Object.assign(this, h_this);
	}

	base(...a_args) {
		return new Float64Array(...a_args);
	}
}

// static field
Object.assign(Float64ArrayS.prototype, {
	[sharing.$_SHAREABLE]: 1,
});



// globals
module.exports = {
	exports: {
		ArrayBufferS: SharedArrayBuffer,
		ArrayBufferT: ArrayBuffer,
		Int8ArrayS: Int8ArrayS,
		Int8ArrayT: Int8Array,
		Uint8ArrayS: Uint8ArrayS,
		Uint8ArrayT: Uint8Array,
		Uint8ClampedArrayS: Uint8ClampedArrayS,
		Uint8ClampedArrayT: Uint8ClampedArray,
		Int16ArrayS: Int16ArrayS,
		Int16ArrayT: Int16Array,
		Uint16ArrayS: Uint16ArrayS,
		Uint16ArrayT: Uint16Array,
		Int32ArrayS: Int32ArrayS,
		Int32ArrayT: Int32Array,
		Uint32ArrayS: Uint32ArrayS,
		Uint32ArrayT: Uint32Array,
		Float32ArrayS: Float32ArrayS,
		Float32ArrayT: Float32Array,
		Float64ArrayS: Float64ArrayS,
		Float64ArrayT: Float64Array,
	},
};
},{"./sharing.js":12}],15:[function(require,module,exports){
const events = require('./events.js');
const sharing = require('./sharing.js');

class worker extends Worker {

	postPort(d_port, h_msg, a_transfer_paths = []) {
		// append port to transfer paths
		a_transfer_paths.push(['port']);

		// send
		this.postMessage(Object.assign({
			port: d_port,
		}, h_msg), a_transfer_paths);
	}

	postMessage(h_msg, a_transfer_paths) {
		let a_transfers = [];
		for (let i_transfer_path = 0, nl_transfer_paths = a_transfer_paths.length; i_transfer_path < nl_transfer_paths; i_transfer_path++) {
			let a_path = a_transfer_paths[i_transfer_path];

			let z_walk = h_msg;
			for (let i_step = 0, nl_path = a_path.length; i_step < nl_path; i_step++) {
				z_walk = z_walk[a_path[i_step]];
			}

			a_transfers.push(...sharing.extract(z_walk));
		}

		super.postMessage(h_msg, a_transfers);
	}
}

events(worker.prototype);

module.exports = worker;
},{"./events.js":8,"./sharing.js":12}],16:[function(require,module,exports){
(function (process){
const path = require('path');

// local classes / globals
const {
	K_SELF,
	DC_WORKER,
	DC_CHANNEL,
	H_TYPED_ARRAYS,
	B_BROWSER,
	B_BROWSERIFY,
	HP_WORKER_NOTIFICATION,
	stream,
	webworkerify,
} = require('./all/locals.js');

const dedicated = require('./all/dedicated.js');
const manifest = require('./all/manifest.js');
const pool = require('./all/pool.js');
const result = require('./all/result.js');

// Worker is supported
const B_WORKER_SUPPORTED = ('undefined' !== typeof DC_WORKER);

// context bitmasks
const XM_CONTEXT_PROCESS_PARENT = 1 << 0;
const XM_CONTEXT_PROCESS_CHILD = 1 << 1;
const XM_CONTEXT_WINDOW = 1 << 2;
const XM_CONTEXT_WORKER_DEDICATED = 1 << 3;
const XM_CONTEXT_WORKER_SERVICE = 1 << 4;
const XM_CONTEXT_WORKER_SHARED = 1 << 5;

const XM_CONTEXT_WORKER = XM_CONTEXT_WORKER_DEDICATED | XM_CONTEXT_WORKER_SERVICE | XM_CONTEXT_WORKER_SHARED;

// set the current context
const X_CONTEXT_TYPE = !B_BROWSER ?
	(process.env.WORKER_DEPTH ? XM_CONTEXT_PROCESS_CHILD : XM_CONTEXT_PROCESS_PARENT) :
	('undefined' !== typeof document ?
		XM_CONTEXT_WINDOW :
		('DedicatedWorkerGlobalScope' in self ?
			XM_CONTEXT_WORKER_DEDICATED :
			('SharedWorkerGlobalScope' in self ?
				XM_CONTEXT_WORKER_SHARED :
				('ServiceWorkerGlobalScope' in self ?
					XM_CONTEXT_WORKER_SERVICE :
					0))));

// unrecognized context
if (!X_CONTEXT_TYPE) {
	throw new Error('failed to determine what is the current environment/context');
}

// spawns a Worker
let spawn_worker = B_WORKER_SUPPORTED ?
	(!B_BROWSERIFY ?
		(p_source, h_options) => new DC_WORKER(p_source, h_options) :
		(p_source, h_options) => {
			console.error(`Fatal error: since you are using browserify, you need to include explicit 'require()' statements for any scripts you intend to spawn as workers from this thread`);
			console.warn(`try using the following instead:\n\nconst worker = require('worker').scopify(require, () => {\n` +
				`\trequire('${p_source}');\n\t// ... and any other scripts you will spawn from this thread\n` +
				`}, 'undefined' !== typeof arguments && arguments);`);

			throw new Error(`Cannot spawn worker '${p_source}'`);
		}) :
	(p_source, h_options) => {
		// we're inside a worker
		if (X_CONTEXT_TYPE & XM_CONTEXT_WORKER) {
			console.error(`Fatal error: browser does not support subworkers; failed to spawn '${p_source}'\n` +
				'Fortunately worker.js has a solution  ;)');
			console.warn(`try using the following in your worker script to support subworkers:\n\n` +
				`const worker = require('worker').scopify(require, () => {\n` +
				`\trequire('${p_source}');\n` +
				`\t// ... and any other scripts you will spawn from this thread\n` +
				`}, 'undefined' !== typeof arguments && arguments);`);
		}

		throw new Error(`Cannot spawn worker ${p_source}; 'Worker' is undefined`);
	};


let i_guid = 0;

class worker extends stream.handler {
	static from_source(p_source) {
		return new worker({
			source: p_source,
		});
	}

	constructor(h_config) {
		super();

		let {
			source: p_source,
			id: i_id = -1,
			master: k_master = null,
			options: h_options = {},
		} = h_config;

		// resolve source relative to master
		let pa_source = B_BROWSER ?
			p_source :
			path.resolve(path.dirname(module.parent.filename), p_source);

		// make worker
		let d_worker;
		try {
			d_worker = spawn_worker(pa_source, h_options);
		} catch (e_spawn) {
			let e_msg = new Error('failed to spawn worker: ');
			e_msg.stack = e_spawn.stack;
			throw e_msg;
		}

		d_worker.events({
			error(e_worker) {
				if (e_worker instanceof ErrorEvent) {
					if ('lineno' in e_worker && 'source' in d_worker) {
						let a_lines = d_worker.source.split('\n');
						let i_line_err = e_worker.lineno;
						let a_debug = a_lines.slice(Math.max(0, i_line_err - 2), Math.min(a_lines.length - 1, i_line_err + 2))
							.map((s_line, i_line) => (1 === i_line ? '*' : ' ') + ((i_line_err + i_line - 1) + '').padStart(5) + ': ' + s_line);

						// recreate error message
						e_worker = new Error(e_worker.message + `Error thrown in worker:\n${a_debug.join('\n')}`);
					}

					if (this.task_error) {
						this.task_error(e_worker);
					} else {
						throw e_worker;
					}
				} else if (this.task_error) {
					this.task_error(e_worker);
				} else {
					throw new Error(`an error occured on worker... but the 'error' event callback did not receive an ErrorEvent object! try inspecting console`);
				}
			},

			// when there is an error creating/communicating with worker
			messageerror: (e_action) => {
				throw new Error(e_action);
			},

			// when a worker responds
			message: (d_msg) => {
				let h_msg = d_msg.data;

				// handle message
				let s_handle = 'handle_' + h_msg.type;
				if (s_handle in this) {
					this[s_handle](h_msg);
				} else {
					throw new Error(`worker sent a message that has no defined handler: '${h_msg.type}'`);
				}
			},
		});

		Object.assign(this, {
			source: p_source,
			id: i_id,
			master: k_master,
			port: d_worker,
			busy: false,
			available: true,
			tasks_assigned: 0,
			callbacks: {},
			events: {},
			subworkers: [],
			task_error: null,
		});
	}

	debug(s_type, ...a_info) {
		// console.warn(`M${String.fromCharCode(65+this.id)} ${s_type} ${a_info.length? '('+a_info.join(', ')+')': '-'}`);
	}

	handle_close_server(h_msg) {
		DC_CHANNEL.kill(h_msg.server);
	}

	handle_respond(h_msg) {
		let h_callbacks = this.callbacks;

		// no longer busy
		this.busy = false;

		// grab task id
		let i_task = h_msg.id;

		this.debug('<< respond', i_task);

		// execute callback
		h_callbacks[i_task](h_msg.data, i_task, this);

		// free callback
		delete h_callbacks[i_task];
	}

	handle_notify(h_msg) {
		h_msg.data = HP_WORKER_NOTIFICATION;

		// no longer busy
		this.busy = false;

		this.debug('<< notify');

		this.handle_respond(h_msg);
	}

	handle_event(h_msg) {
		// event is guaranteed to be here; just callback with data
		this.events[h_msg.id][h_msg.event](...h_msg.args);
	}

	handle_error(h_msg) {
		let h_error = h_msg.error;
		let e_msg = new Error(h_error.message);
		e_msg.stack = h_error.stack;

		if (this.task_error) {
			this.task_error(e_msg);
		} else {
			throw e_msg;
		}
	}

	handle_spawn(h_msg) {
		let p_source = path.join(path.dirname(this.source), h_msg.source);
		if ('/' !== p_source[0]) p_source = './' + p_source;

		p_source = h_msg.source;
		let d_subworker = spawn_worker(p_source);
		let i_subworker = this.subworkers.push(d_subworker) - 1;

		d_subworker.event('error', (e_worker) => {
			this.port.postMessage({
				type: 'subworker_error',
				error: {
					message: e_worker.message,
					filename: e_worker.filename,
					lineno: e_worker.lineno,
				},
			});
		});

		let k_channel = new DC_CHANNEL();

		k_channel.port_1((d_port) => {
			this.port.postPort(d_port, {
				type: 'subworker',
				id: h_msg.id,
				master_key: i_subworker,
			});
		});

		k_channel.port_2((d_port) => {
			d_subworker.postPort(d_port, {
				type: 'owner',
			});
		});
	}

	handle_ping() {
		K_SELF.postMessage({
			type: 'pong',
		});
	}

	handle_terminate(h_msg) {
		this.subworkers[h_msg.master_key].terminate();
	}

	prepare(h_task, fk_task, a_roots = []) {
		let i_task = ++i_guid;

		let {
			task: s_task,
			manifest: k_manifest,
			receive: i_receive = 0,
			inherit: i_inherit = 0,
			hold: b_hold = false,
			events: h_events = null,
		} = h_task;

		// save callback
		this.callbacks[i_task] = fk_task;

		// save events
		if (h_events) {
			this.events[i_task] = h_events;

			// what to send
			let h_events_send = {};
			for (let s_key in h_events) {
				h_events_send[s_key] = 1;
			}
			h_events = h_events_send;
		}

		// send task
		return {
			msg: {
				type: 'task',
				id: i_task,
				task: s_task,
				args: k_manifest.data,
				receive: i_receive,
				inherit: i_inherit,
				hold: b_hold,
				events: h_events,
			},
			paths: k_manifest.paths(...a_roots, 'args'),
		};
	}

	exec(h_task_exec, fk_task) {
		// mark worker as busy
		this.busy = true;

		// prepare final task descriptor
		let h_task = this.prepare(h_task_exec, fk_task);

		this.debug('exec:' + h_task.msg.id);

		// post to worker
		this.port.postMessage(h_task.msg, h_task.paths);
	}

	// assign a task to the worker
	run(s_task, z_args, h_events, fk_run) {
		// prepare final task descriptor
		let h_exec = {
			task: s_task,
			manifest: manifest.from(z_args),
			events: h_events,
		};

		// previous run task
		if (this.prev_run_task) {
			h_exec.inherit = this.prev_run_task;
		}

		// execute task
		let dp_exec = new Promise((f_resolve, f_reject) => {
			this.task_error = f_reject;
			this.exec(h_exec, (z_result, i_task) => {
				this.prev_run_task = i_task;
				this.task_error = null;
				f_resolve(z_result);
			});
		});

		// embedded resolve/reject
		if ('function' === typeof fk_run) {
			dp_exec.then((z_result) => {
				fk_run(null, z_result);
			}).catch((e_exec) => {
				fk_run(e_exec);
			});
		}
		// promise
		else {
			return dp_exec;
		}
	}

	receive(d_port, h_receive, fk_task) {
		let h_task = this.prepare(h_receive.task_ready, fk_task, ['task_ready']);

		this.debug('>> receive:' + h_receive.import, h_task.msg.id, d_port.name);

		this.port.postPort(d_port, {
			type: 'receive',
			import: h_receive.import,
			primary: h_receive.primary,
			task_ready: h_task.msg,
		}, [...(h_task.paths || [])]);
	}

	relay(i_task_sender, d_port, s_receiver) {
		this.debug('>> relay', i_task_sender, d_port.name);

		this.port.postPort(d_port, {
			type: 'relay',
			id: i_task_sender,
		});
	}

	kill(s_kill) {
		if (B_BROWSER) {
			return new Promise((f_resolve) => {
				this.port.terminate();
				f_resolve();
			});
		} else {
			return this.port.terminate(s_kill);
		}
	}
}


const mk_new = (dc) => function(...a_args) {
	return new dc(...a_args);
};

// now import anyhing that depends on worker
const group = require('./all/group.js')(worker);

const H_EXPORTS = {
	spawn(...a_args) {
		return worker.from_source(...a_args);
	},

	new: (...a_args) => new worker(...a_args),
	group: mk_new(group),
	pool: mk_new(pool),
	dedicated: mk_new(dedicated),
	manifest: mk_new(manifest),
	result: mk_new(result),
	// stream: mk_new(writable_stream),

	// states
	browser: B_BROWSER,
	browserify: B_BROWSERIFY,
	// depth: WORKER_DEPTH

	// import typed arrays into the given scope
	globals: (h_scope = {}) => Object.assign(h_scope, H_TYPED_ARRAYS.exports),

	// for compatibility with browserify
	scopify(f_require, a_sources, d_arguments) {
		// browserify arguments
		let a_browserify = d_arguments ? [d_arguments[3], d_arguments[4], d_arguments[5]] : null;

		// running in browserify
		if (B_BROWSERIFY) {
			// change how a worker is spawned
			spawn_worker = (p_source, h_options) => {
				// workaround for chromium bug that cannot spawn subworkers
				if (!B_WORKER_SUPPORTED) {
					let k_subworker = new latent_subworker();

					// send message to master requesting spawn of new worker
					K_SELF.postMessage({
						type: 'spawn',
						id: k_subworker.id,
						source: p_source,
						options: h_options,
					});

					return k_subworker;
				}
				// worker is defined
				else {
					let z_import = f_require(p_source);
					return webworkerify(z_import, {
						browserify: a_browserify,
					});
				}
			};
		}

		// normal exports
		return H_EXPORTS;
	},

	// get stream() {
	// 	delete this.stream;
	// 	return this.stream = require('./stream.js');
	// },

	merge_sorted(a_a, a_b, f_cmp) {
		// output list
		let a_out = [];

		// index of next item from each list
		let i_a = 0;
		let i_b = 0;

		// current item from each list
		let z_a = a_a[0];
		let z_b = a_b[0];

		// final index of each list
		let ih_a = a_a.length - 1;
		let ih_b = a_b.length - 1;

		// merge
		for (;;) {
			// a wins
			if (f_cmp(z_a, z_b) < 0) {
				// add to output list
				a_out.push(z_a);

				// reached end of a
				if (i_a === ih_a) break;

				// next item from a
				z_a = a_a[++i_a];
			}
			// b wins
			else {
				// add to output list
				a_out.push(z_b);

				// reached end of b
				if (i_b === ih_b) break;

				// next item from b
				z_b = a_b[++i_b];
			}
		}

		// a finished first
		if (i_a === ih_a) {
			// append remainder of b
			a_out.push(a_b.slice(i_b));
		}
		// b finished first
		else {
			// append remainder of a
			a_out.push(a_a.slice(i_a));
		}

		// result
		return a_out;
	},
};

module.exports = Object.assign(function(...a_args) {
	// called from worker
	if (XM_CONTEXT_WORKER & X_CONTEXT_TYPE) {
		// dedicated worker
		if (XM_CONTEXT_WORKER_DEDICATED === X_CONTEXT_TYPE) {
			return new dedicated(...a_args);
		}
		// shared worker
		else if (XM_CONTEXT_WORKER_SHARED === X_CONTEXT_TYPE) {
			// return new shared(...a_args);
		}
		// service worker
		else if (XM_CONTEXT_WORKER_SERVICE === X_CONTEXT_TYPE) {
			// return new service(...a_args);
		}
	}
	// child process; dedicated worker
	else if (XM_CONTEXT_PROCESS_CHILD === X_CONTEXT_TYPE) {
		return new dedicated(...a_args);
	}
	// master
	else {
		return worker.from_source(...a_args);
	}
}, H_EXPORTS);
}).call(this,require('_process'))

},{"./all/dedicated.js":1,"./all/group.js":2,"./all/locals.js":3,"./all/manifest.js":4,"./all/pool.js":5,"./all/result.js":6,"_process":22,"path":21}],17:[function(require,module,exports){
(function (global){
'use strict';

// compare and isBuffer taken from https://github.com/feross/buffer/blob/680e9e5e488f22aac27599a57dc844a6315928dd/index.js
// original notice:

/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */
function compare(a, b) {
  if (a === b) {
    return 0;
  }

  var x = a.length;
  var y = b.length;

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i];
      y = b[i];
      break;
    }
  }

  if (x < y) {
    return -1;
  }
  if (y < x) {
    return 1;
  }
  return 0;
}
function isBuffer(b) {
  if (global.Buffer && typeof global.Buffer.isBuffer === 'function') {
    return global.Buffer.isBuffer(b);
  }
  return !!(b != null && b._isBuffer);
}

// based on node assert, original notice:

// http://wiki.commonjs.org/wiki/Unit_Testing/1.0
//
// THIS IS NOT TESTED NOR LIKELY TO WORK OUTSIDE V8!
//
// Originally from narwhal.js (http://narwhaljs.org)
// Copyright (c) 2009 Thomas Robinson <280north.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the 'Software'), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

var util = require('util/');
var hasOwn = Object.prototype.hasOwnProperty;
var pSlice = Array.prototype.slice;
var functionsHaveNames = (function () {
  return function foo() {}.name === 'foo';
}());
function pToString (obj) {
  return Object.prototype.toString.call(obj);
}
function isView(arrbuf) {
  if (isBuffer(arrbuf)) {
    return false;
  }
  if (typeof global.ArrayBuffer !== 'function') {
    return false;
  }
  if (typeof ArrayBuffer.isView === 'function') {
    return ArrayBuffer.isView(arrbuf);
  }
  if (!arrbuf) {
    return false;
  }
  if (arrbuf instanceof DataView) {
    return true;
  }
  if (arrbuf.buffer && arrbuf.buffer instanceof ArrayBuffer) {
    return true;
  }
  return false;
}
// 1. The assert module provides functions that throw
// AssertionError's when particular conditions are not met. The
// assert module must conform to the following interface.

var assert = module.exports = ok;

// 2. The AssertionError is defined in assert.
// new assert.AssertionError({ message: message,
//                             actual: actual,
//                             expected: expected })

var regex = /\s*function\s+([^\(\s]*)\s*/;
// based on https://github.com/ljharb/function.prototype.name/blob/adeeeec8bfcc6068b187d7d9fb3d5bb1d3a30899/implementation.js
function getName(func) {
  if (!util.isFunction(func)) {
    return;
  }
  if (functionsHaveNames) {
    return func.name;
  }
  var str = func.toString();
  var match = str.match(regex);
  return match && match[1];
}
assert.AssertionError = function AssertionError(options) {
  this.name = 'AssertionError';
  this.actual = options.actual;
  this.expected = options.expected;
  this.operator = options.operator;
  if (options.message) {
    this.message = options.message;
    this.generatedMessage = false;
  } else {
    this.message = getMessage(this);
    this.generatedMessage = true;
  }
  var stackStartFunction = options.stackStartFunction || fail;
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, stackStartFunction);
  } else {
    // non v8 browsers so we can have a stacktrace
    var err = new Error();
    if (err.stack) {
      var out = err.stack;

      // try to strip useless frames
      var fn_name = getName(stackStartFunction);
      var idx = out.indexOf('\n' + fn_name);
      if (idx >= 0) {
        // once we have located the function frame
        // we need to strip out everything before it (and its line)
        var next_line = out.indexOf('\n', idx + 1);
        out = out.substring(next_line + 1);
      }

      this.stack = out;
    }
  }
};

// assert.AssertionError instanceof Error
util.inherits(assert.AssertionError, Error);

function truncate(s, n) {
  if (typeof s === 'string') {
    return s.length < n ? s : s.slice(0, n);
  } else {
    return s;
  }
}
function inspect(something) {
  if (functionsHaveNames || !util.isFunction(something)) {
    return util.inspect(something);
  }
  var rawname = getName(something);
  var name = rawname ? ': ' + rawname : '';
  return '[Function' +  name + ']';
}
function getMessage(self) {
  return truncate(inspect(self.actual), 128) + ' ' +
         self.operator + ' ' +
         truncate(inspect(self.expected), 128);
}

// At present only the three keys mentioned above are used and
// understood by the spec. Implementations or sub modules can pass
// other keys to the AssertionError's constructor - they will be
// ignored.

// 3. All of the following functions must throw an AssertionError
// when a corresponding condition is not met, with a message that
// may be undefined if not provided.  All assertion methods provide
// both the actual and expected values to the assertion error for
// display purposes.

function fail(actual, expected, message, operator, stackStartFunction) {
  throw new assert.AssertionError({
    message: message,
    actual: actual,
    expected: expected,
    operator: operator,
    stackStartFunction: stackStartFunction
  });
}

// EXTENSION! allows for well behaved errors defined elsewhere.
assert.fail = fail;

// 4. Pure assertion tests whether a value is truthy, as determined
// by !!guard.
// assert.ok(guard, message_opt);
// This statement is equivalent to assert.equal(true, !!guard,
// message_opt);. To test strictly for the value true, use
// assert.strictEqual(true, guard, message_opt);.

function ok(value, message) {
  if (!value) fail(value, true, message, '==', assert.ok);
}
assert.ok = ok;

// 5. The equality assertion tests shallow, coercive equality with
// ==.
// assert.equal(actual, expected, message_opt);

assert.equal = function equal(actual, expected, message) {
  if (actual != expected) fail(actual, expected, message, '==', assert.equal);
};

// 6. The non-equality assertion tests for whether two objects are not equal
// with != assert.notEqual(actual, expected, message_opt);

assert.notEqual = function notEqual(actual, expected, message) {
  if (actual == expected) {
    fail(actual, expected, message, '!=', assert.notEqual);
  }
};

// 7. The equivalence assertion tests a deep equality relation.
// assert.deepEqual(actual, expected, message_opt);

assert.deepEqual = function deepEqual(actual, expected, message) {
  if (!_deepEqual(actual, expected, false)) {
    fail(actual, expected, message, 'deepEqual', assert.deepEqual);
  }
};

assert.deepStrictEqual = function deepStrictEqual(actual, expected, message) {
  if (!_deepEqual(actual, expected, true)) {
    fail(actual, expected, message, 'deepStrictEqual', assert.deepStrictEqual);
  }
};

function _deepEqual(actual, expected, strict, memos) {
  // 7.1. All identical values are equivalent, as determined by ===.
  if (actual === expected) {
    return true;
  } else if (isBuffer(actual) && isBuffer(expected)) {
    return compare(actual, expected) === 0;

  // 7.2. If the expected value is a Date object, the actual value is
  // equivalent if it is also a Date object that refers to the same time.
  } else if (util.isDate(actual) && util.isDate(expected)) {
    return actual.getTime() === expected.getTime();

  // 7.3 If the expected value is a RegExp object, the actual value is
  // equivalent if it is also a RegExp object with the same source and
  // properties (`global`, `multiline`, `lastIndex`, `ignoreCase`).
  } else if (util.isRegExp(actual) && util.isRegExp(expected)) {
    return actual.source === expected.source &&
           actual.global === expected.global &&
           actual.multiline === expected.multiline &&
           actual.lastIndex === expected.lastIndex &&
           actual.ignoreCase === expected.ignoreCase;

  // 7.4. Other pairs that do not both pass typeof value == 'object',
  // equivalence is determined by ==.
  } else if ((actual === null || typeof actual !== 'object') &&
             (expected === null || typeof expected !== 'object')) {
    return strict ? actual === expected : actual == expected;

  // If both values are instances of typed arrays, wrap their underlying
  // ArrayBuffers in a Buffer each to increase performance
  // This optimization requires the arrays to have the same type as checked by
  // Object.prototype.toString (aka pToString). Never perform binary
  // comparisons for Float*Arrays, though, since e.g. +0 === -0 but their
  // bit patterns are not identical.
  } else if (isView(actual) && isView(expected) &&
             pToString(actual) === pToString(expected) &&
             !(actual instanceof Float32Array ||
               actual instanceof Float64Array)) {
    return compare(new Uint8Array(actual.buffer),
                   new Uint8Array(expected.buffer)) === 0;

  // 7.5 For all other Object pairs, including Array objects, equivalence is
  // determined by having the same number of owned properties (as verified
  // with Object.prototype.hasOwnProperty.call), the same set of keys
  // (although not necessarily the same order), equivalent values for every
  // corresponding key, and an identical 'prototype' property. Note: this
  // accounts for both named and indexed properties on Arrays.
  } else if (isBuffer(actual) !== isBuffer(expected)) {
    return false;
  } else {
    memos = memos || {actual: [], expected: []};

    var actualIndex = memos.actual.indexOf(actual);
    if (actualIndex !== -1) {
      if (actualIndex === memos.expected.indexOf(expected)) {
        return true;
      }
    }

    memos.actual.push(actual);
    memos.expected.push(expected);

    return objEquiv(actual, expected, strict, memos);
  }
}

function isArguments(object) {
  return Object.prototype.toString.call(object) == '[object Arguments]';
}

function objEquiv(a, b, strict, actualVisitedObjects) {
  if (a === null || a === undefined || b === null || b === undefined)
    return false;
  // if one is a primitive, the other must be same
  if (util.isPrimitive(a) || util.isPrimitive(b))
    return a === b;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b))
    return false;
  var aIsArgs = isArguments(a);
  var bIsArgs = isArguments(b);
  if ((aIsArgs && !bIsArgs) || (!aIsArgs && bIsArgs))
    return false;
  if (aIsArgs) {
    a = pSlice.call(a);
    b = pSlice.call(b);
    return _deepEqual(a, b, strict);
  }
  var ka = objectKeys(a);
  var kb = objectKeys(b);
  var key, i;
  // having the same number of owned properties (keys incorporates
  // hasOwnProperty)
  if (ka.length !== kb.length)
    return false;
  //the same set of keys (although not necessarily the same order),
  ka.sort();
  kb.sort();
  //~~~cheap key test
  for (i = ka.length - 1; i >= 0; i--) {
    if (ka[i] !== kb[i])
      return false;
  }
  //equivalent values for every corresponding key, and
  //~~~possibly expensive deep test
  for (i = ka.length - 1; i >= 0; i--) {
    key = ka[i];
    if (!_deepEqual(a[key], b[key], strict, actualVisitedObjects))
      return false;
  }
  return true;
}

// 8. The non-equivalence assertion tests for any deep inequality.
// assert.notDeepEqual(actual, expected, message_opt);

assert.notDeepEqual = function notDeepEqual(actual, expected, message) {
  if (_deepEqual(actual, expected, false)) {
    fail(actual, expected, message, 'notDeepEqual', assert.notDeepEqual);
  }
};

assert.notDeepStrictEqual = notDeepStrictEqual;
function notDeepStrictEqual(actual, expected, message) {
  if (_deepEqual(actual, expected, true)) {
    fail(actual, expected, message, 'notDeepStrictEqual', notDeepStrictEqual);
  }
}


// 9. The strict equality assertion tests strict equality, as determined by ===.
// assert.strictEqual(actual, expected, message_opt);

assert.strictEqual = function strictEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(actual, expected, message, '===', assert.strictEqual);
  }
};

// 10. The strict non-equality assertion tests for strict inequality, as
// determined by !==.  assert.notStrictEqual(actual, expected, message_opt);

assert.notStrictEqual = function notStrictEqual(actual, expected, message) {
  if (actual === expected) {
    fail(actual, expected, message, '!==', assert.notStrictEqual);
  }
};

function expectedException(actual, expected) {
  if (!actual || !expected) {
    return false;
  }

  if (Object.prototype.toString.call(expected) == '[object RegExp]') {
    return expected.test(actual);
  }

  try {
    if (actual instanceof expected) {
      return true;
    }
  } catch (e) {
    // Ignore.  The instanceof check doesn't work for arrow functions.
  }

  if (Error.isPrototypeOf(expected)) {
    return false;
  }

  return expected.call({}, actual) === true;
}

function _tryBlock(block) {
  var error;
  try {
    block();
  } catch (e) {
    error = e;
  }
  return error;
}

function _throws(shouldThrow, block, expected, message) {
  var actual;

  if (typeof block !== 'function') {
    throw new TypeError('"block" argument must be a function');
  }

  if (typeof expected === 'string') {
    message = expected;
    expected = null;
  }

  actual = _tryBlock(block);

  message = (expected && expected.name ? ' (' + expected.name + ').' : '.') +
            (message ? ' ' + message : '.');

  if (shouldThrow && !actual) {
    fail(actual, expected, 'Missing expected exception' + message);
  }

  var userProvidedMessage = typeof message === 'string';
  var isUnwantedException = !shouldThrow && util.isError(actual);
  var isUnexpectedException = !shouldThrow && actual && !expected;

  if ((isUnwantedException &&
      userProvidedMessage &&
      expectedException(actual, expected)) ||
      isUnexpectedException) {
    fail(actual, expected, 'Got unwanted exception' + message);
  }

  if ((shouldThrow && actual && expected &&
      !expectedException(actual, expected)) || (!shouldThrow && actual)) {
    throw actual;
  }
}

// 11. Expected to throw an error:
// assert.throws(block, Error_opt, message_opt);

assert.throws = function(block, /*optional*/error, /*optional*/message) {
  _throws(true, block, error, message);
};

// EXTENSION! This is annoying to write outside this module.
assert.doesNotThrow = function(block, /*optional*/error, /*optional*/message) {
  _throws(false, block, error, message);
};

assert.ifError = function(err) { if (err) throw err; };

var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) {
    if (hasOwn.call(obj, key)) keys.push(key);
  }
  return keys;
};

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"util/":25}],18:[function(require,module,exports){

},{}],19:[function(require,module,exports){
arguments[4][18][0].apply(exports,arguments)
},{"dup":18}],20:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      } else {
        // At least give some kind of context to the user
        var err = new Error('Uncaught, unspecified "error" event. (' + er + ')');
        err.context = er;
        throw err;
      }
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    args = Array.prototype.slice.call(arguments, 1);
    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else if (listeners) {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.prototype.listenerCount = function(type) {
  if (this._events) {
    var evlistener = this._events[type];

    if (isFunction(evlistener))
      return 1;
    else if (evlistener)
      return evlistener.length;
  }
  return 0;
};

EventEmitter.listenerCount = function(emitter, type) {
  return emitter.listenerCount(type);
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],21:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// resolves . and .. elements in a path array with directory names there
// must be no slashes, empty elements, or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = parts.length - 1; i >= 0; i--) {
    var last = parts[i];
    if (last === '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (allowAboveRoot) {
    for (; up--; up) {
      parts.unshift('..');
    }
  }

  return parts;
}

// Split a filename into [root, dir, basename, ext], unix version
// 'root' is just a slash, or nothing.
var splitPathRe =
    /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
var splitPath = function(filename) {
  return splitPathRe.exec(filename).slice(1);
};

// path.resolve([from ...], to)
// posix version
exports.resolve = function() {
  var resolvedPath = '',
      resolvedAbsolute = false;

  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    var path = (i >= 0) ? arguments[i] : process.cwd();

    // Skip empty and invalid entries
    if (typeof path !== 'string') {
      throw new TypeError('Arguments to path.resolve must be strings');
    } else if (!path) {
      continue;
    }

    resolvedPath = path + '/' + resolvedPath;
    resolvedAbsolute = path.charAt(0) === '/';
  }

  // At this point the path should be resolved to a full absolute path, but
  // handle relative paths to be safe (might happen when process.cwd() fails)

  // Normalize the path
  resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
    return !!p;
  }), !resolvedAbsolute).join('/');

  return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
};

// path.normalize(path)
// posix version
exports.normalize = function(path) {
  var isAbsolute = exports.isAbsolute(path),
      trailingSlash = substr(path, -1) === '/';

  // Normalize the path
  path = normalizeArray(filter(path.split('/'), function(p) {
    return !!p;
  }), !isAbsolute).join('/');

  if (!path && !isAbsolute) {
    path = '.';
  }
  if (path && trailingSlash) {
    path += '/';
  }

  return (isAbsolute ? '/' : '') + path;
};

// posix version
exports.isAbsolute = function(path) {
  return path.charAt(0) === '/';
};

// posix version
exports.join = function() {
  var paths = Array.prototype.slice.call(arguments, 0);
  return exports.normalize(filter(paths, function(p, index) {
    if (typeof p !== 'string') {
      throw new TypeError('Arguments to path.join must be strings');
    }
    return p;
  }).join('/'));
};


// path.relative(from, to)
// posix version
exports.relative = function(from, to) {
  from = exports.resolve(from).substr(1);
  to = exports.resolve(to).substr(1);

  function trim(arr) {
    var start = 0;
    for (; start < arr.length; start++) {
      if (arr[start] !== '') break;
    }

    var end = arr.length - 1;
    for (; end >= 0; end--) {
      if (arr[end] !== '') break;
    }

    if (start > end) return [];
    return arr.slice(start, end - start + 1);
  }

  var fromParts = trim(from.split('/'));
  var toParts = trim(to.split('/'));

  var length = Math.min(fromParts.length, toParts.length);
  var samePartsLength = length;
  for (var i = 0; i < length; i++) {
    if (fromParts[i] !== toParts[i]) {
      samePartsLength = i;
      break;
    }
  }

  var outputParts = [];
  for (var i = samePartsLength; i < fromParts.length; i++) {
    outputParts.push('..');
  }

  outputParts = outputParts.concat(toParts.slice(samePartsLength));

  return outputParts.join('/');
};

exports.sep = '/';
exports.delimiter = ':';

exports.dirname = function(path) {
  var result = splitPath(path),
      root = result[0],
      dir = result[1];

  if (!root && !dir) {
    // No dirname whatsoever
    return '.';
  }

  if (dir) {
    // It has a dirname, strip trailing slash
    dir = dir.substr(0, dir.length - 1);
  }

  return root + dir;
};


exports.basename = function(path, ext) {
  var f = splitPath(path)[2];
  // TODO: make this comparison case-insensitive on windows?
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
};


exports.extname = function(path) {
  return splitPath(path)[3];
};

function filter (xs, f) {
    if (xs.filter) return xs.filter(f);
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        if (f(xs[i], i, xs)) res.push(xs[i]);
    }
    return res;
}

// String.prototype.substr - negative index don't work in IE8
var substr = 'ab'.substr(-1) === 'b'
    ? function (str, start, len) { return str.substr(start, len) }
    : function (str, start, len) {
        if (start < 0) start = str.length + start;
        return str.substr(start, len);
    }
;

}).call(this,require('_process'))

},{"_process":22}],22:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],23:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],24:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],25:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = require('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = require('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"./support/isBuffer":24,"_process":22,"inherits":23}],26:[function(require,module,exports){
/* global describe it */
const assert = require('assert');
const deq = (z_expect, z_actual) => {
	assert.deepStrictEqual(z_actual, z_expect);
};
const eq = (z_expect, z_actual) => {
	assert.strictEqual(z_actual, z_expect);
};
const fs = require('fs');

const worker = require('../../dist/main/module.js').scopify(require, () => {
	require('./workers/basic.js');
}, 'undefined' !== typeof arguments && arguments);

const spawn = (s_name='basic') => worker.spawn(`./workers/${s_name}.js`);
const group = (n_workers, s_name='basic') => worker.group(`./workers/${s_name}.js`, n_workers);

const run = async (...a_args) => {
	let k_worker = spawn();
	let z_result = await k_worker.run(...a_args);
	await k_worker.kill();
	return z_result;
};


describe('worker', () => {

	it('runs', async () => {
		eq('yeh', await run('reverse_string', ['hey']));
	});

	it('twice', async () => {
		let k_worker = spawn();
		let s_yeh = await k_worker.run('reverse_string', ['hey']);
		eq('hey', await run('reverse_string', [s_yeh]));
		await k_worker.kill();
	});

	it('terminates', (fke_test) => {
		let k_worker = spawn();
		k_worker.run('wait', [[5000]])
			.then(() => fke_test('worker did not terminate before finishing task'))
			.catch((e_run) => {
				fke_test(e_run);
			});
		setTimeout(async () => {
			await k_worker.kill();
			fke_test();
		}, 100);
	});

	it('catches', (fke_test) => {
		let k_worker = spawn();
		k_worker.run('fail')
			.then(() => fke_test('error not caught by master'))
			.catch(async (e_run) => {
				assert(e_run.message.includes('no such task'));
				await k_worker.kill();
				fke_test();
			});
	});

	it('events', async () => {
		let h_convo = {
			greet: 'hi',
			chat: 'how r u',
			yell: 'ahh!',
			apologize: 'sorry',
			forgive: 'mmk',
			exit: 'kbye',
		};

		let a_data = [];
		let h_responses = {};
		let c_responses = 0;
		Object.keys(h_convo).forEach((s_key, i_key) => {
			a_data.push({
				name: s_key,
				data: h_convo[s_key],
				wait: i_key? 100: 0,
			});

			h_responses[s_key] = (s_msg) => {
				eq(h_convo[s_key], s_msg);
				c_responses += 1;
			};
		});

		let k_worker = spawn();
		await k_worker.run('events', [a_data], h_responses);
		await k_worker.kill();
		eq(a_data.length, c_responses);
	});

	it('store', async () => {
		let k_worker = spawn();
		await k_worker.run('store', [[{test:'value'}]]);
		let a_values = await k_worker.run('fetch', [['test']]);
		await k_worker.kill();
		eq('value', a_values[0]);
	});
});


describe('group', () => {

	it('map/thru', (fke_test) => {
		let a_seq = [8, 1, 7, 4, 3, 5, 2, 6];
		let k_group = group(a_seq.length);
		k_group
			.data(a_seq)
			.map('multiply', [2])
			.thru('add', [3])
			.each((x_n, i_n) => {
				eq((a_seq[i_n]*2)+3, x_n[0]);
			}, async () => {
				await k_group.kill();
				fke_test();
			});
	});

	it('map/each', (fke_test) => {
		let a_seq = [8, 1, 7, 4, 3, 5, 2, 6].map(x => x*100);
		let k_group = group(a_seq.length);
		k_group
			.data(a_seq)
			.map('wait')
			.each((x_n, i_n) => {
				eq(a_seq[i_n], x_n);
			}, async () => {
				await k_group.kill();
				fke_test();
			});
	});

	it('map/series', (fke_test) => {
		let a_seq = [8, 1, 7, 4, 3, 5, 2, 6].map(x => x*100);
		let a_res = [];
		let k_group = group(a_seq.length);
		k_group
			.data(a_seq)
			.map('wait')
			.series((x_n) => {
				a_res.push(x_n);
			}, async () => {
				await k_group.kill();
				deq(a_seq, a_res);
				fke_test();
			});
	});

	it('map/reduce #4', (fke_test) => {
		let s_src = 'abcdefghijklmnopqrstuvwxyz';
		let k_group = group(4);
		k_group
			.data(s_src.split(''))
			.map('concat')
			.reduce('merge_concat').then(async (s_final) => {
				await k_group.kill();
				eq(s_src, s_final);
				fke_test();
			});
	});

	it('map/reduce #8', (fke_test) => {
		let s_src = 'abcdefghijklmnopqrstuvwxyz';
		let k_group = group(8);
		k_group
			.data(s_src.split(''))
			.map('concat')
			.reduce('merge_concat').then(async (s_final) => {
				await k_group.kill();
				eq(s_src, s_final);
				fke_test();
			});
	});

	it('events', (fke_test) => {
		let h_convo = {
			greet: 'hi',
			chat: 'how r u',
			yell: 'ahh!',
			apologize: 'sorry',
			forgive: 'mmk',
			exit: 'kbye',
		};

		let a_data = [];
		let h_responses = {};
		let c_responses = 0;
		Object.keys(h_convo).forEach((s_key, i_key) => {
			a_data.push({
				name: s_key,
				data: h_convo[s_key],
				wait: i_key? 500: 0,
			});

			h_responses[s_key] = (i_subset, s_msg) => {
				eq(h_convo[s_key], s_msg);
				c_responses += 1;
			};
		});

		let k_group = group(3);
		k_group
			.data(a_data)
			.map('events', [], h_responses)
			.end(async () => {
				await k_group.kill();
				eq(a_data.length, c_responses);
				fke_test();
			});
	});

	it('store', () => {
		let k_group = group(2);
		k_group
			.data([[100, 0, 0, 0]])
			.map('pass')
			// .thru('pass')
			.reduce('sum').then(async (a_v) => {
				await k_group.kill();
			});
	});

});


describe('aux', () => {

	if(!worker.browser) {
		it('transfers', async () => {
			let km_args = worker.manifest([fs.readFileSync('./package.json')]);
			let n_length = await run('count', km_args);

			assert(n_length > 0);
		});
	}

	it('typed-array', async () => {
		let at_test = new Uint8Array(10);
		at_test[0] = 7;
		at_test[1] = 5;
		let km_args = worker.manifest([at_test, 1]);
		let n_at = await run('at', km_args);
		eq(5, n_at);
	});

	// it('streams', async () => {
	// 	let ds_words = fs.createReadStream('/usr/share/dict/words', 'utf8');
	// 	let n_newlines = await run('count_str', [ds_words, '\n']);
	// 	console.log(n_newlines);
	// 	// eq('worker', s_package_name);
	// });
});



},{"../../dist/main/module.js":16,"./workers/basic.js":27,"assert":17,"fs":19}],27:[function(require,module,exports){
const worker = require('../../../dist/main/module.js');

worker.dedicated({
	reverse_string: s => s.split('').reverse().join(''),

	at: (a, i) => a[i],

	wait: (a_wait) => new Promise((f_resolve) => {
		let t_wait = a_wait[0];

		setTimeout(() => {
			f_resolve(t_wait);
		}, t_wait);
	}),

	concat: a => a.join(''),

	merge_concat: (s_a, s_b) => s_a + s_b,

	events(a_evts) {
		return Promise.all(
			a_evts.map((h_evt) => new Promise((f_resolve, f_reject) => {
				setTimeout(() => {
					this.emit(h_evt.name, h_evt.data);
					f_resolve();
				}, h_evt.wait + 600);
			}))
		);
	},

	store(a_store) {
		a_store.forEach((h_store) => {
			for(let s_key in h_store) {
				this.put(s_key, h_store[s_key]);
			}
		});
	},

	fetch(a_keys) {
		return a_keys.map(s_key => this.get(s_key));
	},

	pass(a_wait) {
		return Promise.all(a_wait.map(x_wait => new Promise((f_resolve, f_reject) => {
			setTimeout(() => {
				let c_val = (this.get('dig') || 0) + 1;
				this.put('dig', c_val);
				f_resolve(c_val);
			}, x_wait);
		})));
	},

	multiply: (a, x_multiplier) => a.map(x => x * x_multiplier),

	add: (a, x_add) => a.map(x => x + x_add),

	// sum: (x_a, x_b) => x_a + x_b,

	sum: (a_a, a_b) => [a_a.reduce((c, x) => c + x, 0) + a_b.reduce((c, x) => c + x, 0)],

	count: (a) => a.reduce((c, x) => c + x, 0),

	count_str(ds_input, s_str) {
		return new Promise((f_resolve, f_reject) => {
			let c_occurrences = 0;
			ds_input.on('data', (s_chunk) => {
				console.log('occurrences: '+c_occurrences);
				c_occurrences += s_chunk.split(s_str).length - 1;
			});

			ds_input.on('end', () => {
				console.log('end');
				f_resolve(c_occurrences);
			});

			ds_input.on('error', (e_stream) => {
				console.error(e_stream);
				f_reject(e_stream);
			});
		});
	},

	write(ds_out, a_range) {
		for(let i=a_range[0]; i<a_range[1]; i++) {
			ds_out.write(i+'\n');
		}
	},
});

},{"../../../dist/main/module.js":16}]},{},[26])
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJkaXN0L21haW4vYWxsL2RlZGljYXRlZC5qcyIsImRpc3QvbWFpbi9hbGwvZ3JvdXAuanMiLCJkaXN0L21haW4vYWxsL2xvY2Fscy5qcyIsImRpc3QvbWFpbi9hbGwvbWFuaWZlc3QuanMiLCJkaXN0L21haW4vYWxsL3Bvb2wuanMiLCJkaXN0L21haW4vYWxsL3Jlc3VsdC5qcyIsImRpc3QvbWFpbi9icm93c2VyL2NoYW5uZWwuanMiLCJkaXN0L21haW4vYnJvd3Nlci9ldmVudHMuanMiLCJkaXN0L21haW4vYnJvd3Nlci9sb2NhbHMuanMiLCJkaXN0L21haW4vYnJvd3Nlci9wb3J0cy5qcyIsImRpc3QvbWFpbi9icm93c2VyL3NlbGYuanMiLCJkaXN0L21haW4vYnJvd3Nlci9zaGFyaW5nLmpzIiwiZGlzdC9tYWluL2Jyb3dzZXIvc3RyZWFtLmpzIiwiZGlzdC9tYWluL2Jyb3dzZXIvdHlwZWQtYXJyYXlzLmpzIiwiZGlzdC9tYWluL2Jyb3dzZXIvd29ya2VyLmpzIiwiZGlzdC9tYWluL21vZHVsZS5qcyIsIm5vZGVfbW9kdWxlcy9hc3NlcnQvYXNzZXJ0LmpzIiwibm9kZV9tb2R1bGVzL2Jyb3dzZXItcmVzb2x2ZS9lbXB0eS5qcyIsIm5vZGVfbW9kdWxlcy9ldmVudHMvZXZlbnRzLmpzIiwibm9kZV9tb2R1bGVzL3BhdGgtYnJvd3NlcmlmeS9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9wcm9jZXNzL2Jyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvdXRpbC9ub2RlX21vZHVsZXMvaW5oZXJpdHMvaW5oZXJpdHNfYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy91dGlsL3N1cHBvcnQvaXNCdWZmZXJCcm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL3V0aWwvdXRpbC5qcyIsInRlc3QvbWFpbi9tb2R1bGUuanMiLCJ0ZXN0L21haW4vd29ya2Vycy9iYXNpYy5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNaQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUNsa0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDMUZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BJQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0R0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1RBO0FBQ0E7QUFDQTs7QUNGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0RUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyVUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzFyQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDbENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7O0FDemlCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDMWVBOzs7O0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUM5U0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDaE9BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeExBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDMWtCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDalFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dmFyIGY9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKTt0aHJvdyBmLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsZn12YXIgbD1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwobC5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxsLGwuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiY29uc3Qge1xuXHRLX1NFTEYsXG5cdHdlYndvcmtlcmlmeSxcblx0c3RyZWFtLFxuXHRwb3J0cyxcbn0gPSByZXF1aXJlKCcuL2xvY2Fscy5qcycpO1xuXG5jb25zdCB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuY29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKCcuL21hbmlmZXN0LmpzJyk7XG5jb25zdCByZXN1bHQgPSByZXF1aXJlKCcuL3Jlc3VsdC5qcycpO1xuXG5sZXQgaV9zdWJ3b3JrZXJfc3Bhd24gPSAxO1xubGV0IGhfc3Vid29ya2VycyA9IHt9O1xuY2xhc3MgbGF0ZW50X3N1YndvcmtlciB7XG5cdHN0YXRpYyBjb25uZWN0KGhfbXNnKSB7XG5cdFx0aF9zdWJ3b3JrZXJzW2hfbXNnLmlkXS5jb25uZWN0KGhfbXNnKTtcblx0fVxuXG5cdGNvbnN0cnVjdG9yKCkge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0aWQ6IGlfc3Vid29ya2VyX3NwYXduLFxuXHRcdFx0bWVzc2FnZXM6IFtdLFxuXHRcdFx0bWFzdGVyX2tleTogMCxcblx0XHRcdHBvcnQ6IG51bGwsXG5cdFx0fSk7XG5cblx0XHRoX3N1YndvcmtlcnNbaV9zdWJ3b3JrZXJfc3Bhd24rK10gPSB0aGlzO1xuXHR9XG5cblx0Y29ubmVjdChoX21zZykge1xuXHRcdGxldCB7XG5cdFx0XHRtYXN0ZXJfa2V5OiBpX21hc3Rlcixcblx0XHRcdHBvcnQ6IGRfcG9ydCxcblx0XHR9ID0gaF9tc2c7XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdG1hc3Rlcl9rZXk6IGlfbWFzdGVyLFxuXHRcdFx0cG9ydDogZF9wb3J0LFxuXHRcdH0pO1xuXG5cdFx0Ly8gYmluZCBldmVudHNcblx0XHRkX3BvcnQub25tZXNzYWdlID0gKC4uLmFfYXJncykgPT4ge1xuXHRcdFx0dGhpcy5vbm1lc3NhZ2UoLi4uYV9hcmdzKTtcblx0XHR9O1xuXHRcdGRfcG9ydC5vbm1lc3NhZ2VlcnJvciA9ICguLi5hX2FyZ3MpID0+IHtcblx0XHRcdHRoaXMub25tZXNzYWdlZXJyb3IoLi4uYV9hcmdzKTtcblx0XHR9O1xuXG5cdFx0Ly8gcHJvY2VzcyBtZXNzYWdlIHF1ZXVlXG5cdFx0d2hpbGUgKHRoaXMubWVzc2FnZXMubGVuZ3RoKSB7XG5cdFx0XHRkX3BvcnQucG9zdE1lc3NhZ2UoLi4udGhpcy5tZXNzYWdlcy5zaGlmdCgpKTtcblx0XHR9XG5cdH1cblxuXHRwb3N0TWVzc2FnZSguLi5hX2FyZ3MpIHtcblx0XHRpZiAodGhpcy5wb3J0KSB7XG5cdFx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2UoLi4uYV9hcmdzKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5tZXNzYWdlcy5wdXNoKGFfYXJncyk7XG5cdFx0fVxuXHR9XG5cblx0b25tZXNzYWdlKCkge1xuXHRcdHRocm93IG5ldyBFcnJvcigncmVjZWl2ZWQgbWVzc2FnZSBmcm9tIHN1YndvcmtlciBiZWZvcmUgaXRzIHBvcnQgd2FzIGNvbm5lY3RlZCcpO1xuXHR9XG5cblx0b25tZXNzYWdlZXJyb3IoKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKCdyZWNlaXZlZCBtZXNzYWdlIGVycm9yIGZyb20gc3Vid29ya2VyIGJlZm9yZSBpdHMgcG9ydCB3YXMgY29ubmVjdGVkJyk7XG5cdH1cblxuXHR0ZXJtaW5hdGUoKSB7XG5cdFx0dGhpcy5wb3J0LmNsb3NlKCk7XG5cdFx0S19TRUxGLnBvc3RNZXNzYWdlKHtcblx0XHRcdHR5cGU6ICd0ZXJtaW5hdGUnLFxuXHRcdFx0bWFzdGVyX2tleTogdGhpcy5tYXN0ZXJfa2V5LFxuXHRcdH0pO1xuXHR9XG5cblx0d2Vid29ya2VyaWZ5KHpfaW1wb3J0LCBhX2Jyb3dzZXJpZnksIGhfb3B0aW9ucyA9IHt9KSB7XG5cdFx0bGV0IHNfc291cmNlID0gd2Vid29ya2VyaWZ5KHpfaW1wb3J0LCBhX2Jyb3dzZXJpZnksIGhfb3B0aW9ucyk7XG5cblx0XHRLX1NFTEYucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0dHlwZTogJ3NwYXduJyxcblx0XHRcdHNvdXJjZTogc19zb3VyY2UsXG5cdFx0XHRvcHRpb25zOiBoX29wdGlvbnMsXG5cdFx0fSk7XG5cdH1cbn1cblxuXG5jbGFzcyBoZWxwZXIge1xuXHRjb25zdHJ1Y3RvcihrX3dvcmtlciwgaV90YXNrLCBoX2V2ZW50cykge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0d29ya2VyOiBrX3dvcmtlcixcblx0XHRcdHRhc2tfaWQ6IGlfdGFzayxcblx0XHRcdGV2ZW50czogaF9ldmVudHMsXG5cdFx0XHR3b3JrZXJfc3RvcmU6IGtfd29ya2VyLnN0b3JlLFxuXHRcdFx0dGFza3M6IGtfd29ya2VyLnRhc2tzLFxuXHRcdH0pO1xuXHR9XG5cblx0cHV0KHNfa2V5LCB6X2RhdGEpIHtcblx0XHRsZXQgaF9zdG9yZSA9IHRoaXMud29ya2VyX3N0b3JlO1xuXHRcdGxldCBpX3Rhc2sgPSB0aGlzLnRhc2tfaWQ7XG5cblx0XHQvLyBmaXJzdCBpdGVtIGluIHRoaXMgdGFzaydzIHN0b3JlXG5cdFx0aWYgKCEoaV90YXNrIGluIGhfc3RvcmUpKSB7XG5cdFx0XHRoX3N0b3JlW2lfdGFza10gPSB7XG5cdFx0XHRcdFtzX2tleV06IHpfZGF0YSxcblx0XHRcdH07XG5cdFx0fVxuXHRcdC8vIG5vdCBmaXJzdCBpdGVtOyBhZGQgaXRcblx0XHRlbHNlIHtcblx0XHRcdGhfc3RvcmVbaV90YXNrXVtzX2tleV0gPSB6X2RhdGE7XG5cdFx0fVxuXHR9XG5cblx0Z2V0KHNfa2V5KSB7XG5cdFx0bGV0IGlfdGFzayA9IHRoaXMudGFza19pZDtcblxuXHRcdC8vIHRoaXMgdGFzayBjaGFpbiB3YXMgbmV2ZXIgd3JpdHRlbiB0b1xuXHRcdGlmICghKGlfdGFzayBpbiB0aGlzLndvcmtlcl9zdG9yZSkpIHJldHVybjtcblxuXHRcdC8vIHJldHVybiB3aGF0ZXZlciB2YWx1ZSBpcyB0aGVyZVxuXHRcdHJldHVybiB0aGlzLndvcmtlcl9zdG9yZVtpX3Rhc2tdW3Nfa2V5XTtcblx0fVxuXG5cdGVtaXQoc19rZXksIC4uLmFfYXJncykge1xuXHRcdC8vIG9ubHkgaWYgdGhlIGV2ZW50IGlzIHJlZ2lzdGVyZWRcblx0XHRpZiAoc19rZXkgaW4gdGhpcy5ldmVudHMpIHtcblx0XHRcdGxldCBhX2FyZ3Nfc2VuZCA9IFtdO1xuXHRcdFx0bGV0IGFfdHJhbnNmZXJfcGF0aHMgPSBbXTtcblxuXHRcdFx0Ly8gbWVyZ2UgYXJnc1xuXHRcdFx0bGV0IG5fYXJncyA9IGFfYXJncy5sZW5ndGg7XG5cdFx0XHRmb3IgKGxldCBpX2FyZyA9IDA7IGlfYXJnIDwgbl9hcmdzOyBpX2FyZysrKSB7XG5cdFx0XHRcdGxldCB6X2FyZyA9IGFfYXJnc1tpX2FyZ107XG5cblx0XHRcdFx0Ly8gcmVzdWx0XG5cdFx0XHRcdGlmICh6X2FyZyBpbnN0YW5jZW9mIG1hbmlmZXN0KSB7XG5cdFx0XHRcdFx0YV9hcmdzX3NlbmQucHVzaCh6X2FyZy5kYXRhKTtcblx0XHRcdFx0XHRpZiAoel9hcmcudHJhbnNmZXJfcGF0aHMpIHtcblx0XHRcdFx0XHRcdGxldCBubF9wYXRocyA9IGFfdHJhbnNmZXJfcGF0aHMubGVuZ3RoO1xuXHRcdFx0XHRcdFx0bGV0IGFfaW1wb3J0X3BhdGhzID0gel9hcmcudHJhbnNmZXJfcGF0aHM7XG5cdFx0XHRcdFx0XHRhX2ltcG9ydF9wYXRocy5mb3JFYWNoKChhX3BhdGgpID0+IHtcblx0XHRcdFx0XHRcdFx0YV9wYXRoWzBdICs9IG5sX3BhdGhzO1xuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRhX3RyYW5zZmVyX3BhdGhzLnB1c2goLi4uYV9pbXBvcnRfcGF0aHMpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBwb3N0YWJsZVxuXHRcdFx0XHRlbHNlIHtcblx0XHRcdFx0XHRhX2FyZ3Nfc2VuZC5wdXNoKHpfYXJnKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBzZW5kIG1lc3NhZ2Vcblx0XHRcdEtfU0VMRi5wb3N0TWVzc2FnZSh7XG5cdFx0XHRcdHR5cGU6ICdldmVudCcsXG5cdFx0XHRcdGlkOiB0aGlzLnRhc2tfaWQsXG5cdFx0XHRcdGV2ZW50OiBzX2tleSxcblx0XHRcdFx0YXJnczogYV9hcmdzX3NlbmQsXG5cdFx0XHR9LCBhX3RyYW5zZmVyX3BhdGhzKTtcblx0XHR9XG5cdH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBjbGFzcyBkZWRpY2F0ZWQgZXh0ZW5kcyBzdHJlYW0uaGFuZGxlciB7XG5cdGNvbnN0cnVjdG9yKGhfdGFza3MpIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHR0YXNrczogaF90YXNrcyxcblx0XHRcdHN0b3JlOiB7fSxcblx0XHRcdHJlc3VsdHM6IHt9LFxuXHRcdFx0cG9ydDogS19TRUxGLFxuXHRcdFx0aWQ6IEtfU0VMRi5hcmdzWzBdLFxuXHRcdH0pO1xuXG5cdFx0S19TRUxGLmV2ZW50KCdlcnJvcicsIChlX3dvcmtlcikgPT4ge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGVfd29ya2VyKTtcblx0XHR9KTtcblxuXHRcdHRoaXMuc2V0X3BvcnQoS19TRUxGKTtcblx0fVxuXG5cdGRlYnVnKHNfdHlwZSwgLi4uYV9pbmZvKSB7XG5cdFx0Ly8gY29uc29sZS53YXJuKGBTJHt0aGlzLmlkfSAke3NfdHlwZX0gJHthX2luZm8ubGVuZ3RoPyAnKCcrYV9pbmZvLmpvaW4oJywgJykrJyknOiAnLSd9YCk7XG5cdH1cblxuXHQvLyByZXNvbHZlcyBwcm9taXNlcyBhbmQgd3JhcHMgcmVzdWx0c1xuXHRyZXNvbHZlKHpfcmVzdWx0LCBma19yZXNvbHZlKSB7XG5cdFx0Ly8gYSBwcm9taXNlIHdhcyByZXR1cm5lZFxuXHRcdGlmICh6X3Jlc3VsdCBpbnN0YW5jZW9mIFByb21pc2UpIHtcblx0XHRcdHpfcmVzdWx0XG5cdFx0XHRcdC8vIG9uY2UgaXRzIHJlYWR5OyByZXNvbHZlIHVzaW5nIHJlc3VsdFxuXHRcdFx0XHQudGhlbigoel9kYXRhKSA9PiB7XG5cdFx0XHRcdFx0ZmtfcmVzb2x2ZShyZXN1bHQuZnJvbSh6X2RhdGEpKTtcblx0XHRcdFx0fSlcblx0XHRcdFx0Ly8gb3IgY2F0Y2ggaWYgdGhlcmUgd2FzIGEgc3ludGF4IGVycm9yIC8gZXRjLlxuXHRcdFx0XHQuY2F0Y2goKGVfcmVzb2x2ZSkgPT4ge1xuXHRcdFx0XHRcdHRoaXMudGhyb3coZV9yZXNvbHZlKTtcblx0XHRcdFx0fSk7XG5cdFx0fVxuXHRcdC8vIHN5bmNcblx0XHRlbHNlIHtcblx0XHRcdHJldHVybiBma19yZXNvbHZlKHJlc3VsdC5mcm9tKHpfcmVzdWx0KSk7XG5cdFx0fVxuXHR9XG5cblx0dGhyb3cgKGVfdGhyb3cpIHtcblx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0dHlwZTogJ2Vycm9yJyxcblx0XHRcdGVycm9yOiB7XG5cdFx0XHRcdG1lc3NhZ2U6IGVfdGhyb3cubWVzc2FnZSxcblx0XHRcdFx0c3RhY2s6IGVfdGhyb3cuc3RhY2ssXG5cdFx0XHR9LFxuXHRcdH0pO1xuXHR9XG5cblx0Ly8gdHlwaWNhbCBleGVjdXRlLWFuZC1yZXNwb25kIHRhc2tcblx0aGFuZGxlX3Rhc2soaF9tc2cpIHtcblx0XHRsZXQgaF90YXNrcyA9IHRoaXMudGFza3M7XG5cblx0XHRsZXQge1xuXHRcdFx0aWQ6IGlfdGFzayxcblx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHRcdGFyZ3M6IGFfYXJncyxcblx0XHRcdGluaGVyaXQ6IGlfaW5oZXJpdCA9IDAsXG5cdFx0XHRyZWNlaXZlOiBpX3JlY2VpdmUgPSAwLFxuXHRcdFx0aG9sZDogYl9ob2xkID0gZmFsc2UsXG5cdFx0XHRldmVudHM6IGhfZXZlbnRzID0ge30sXG5cdFx0fSA9IGhfbXNnO1xuXG5cdFx0dGhpcy5kZWJ1ZygnPDwgdGFzazonICsgc190YXNrLCBpX3Rhc2spO1xuXG5cdFx0Ly8gbm8gc3VjaCB0YXNrXG5cdFx0aWYgKCEoc190YXNrIGluIGhfdGFza3MpKSB7XG5cdFx0XHRyZXR1cm4gdGhpcy50aHJvdyhuZXcgRXJyb3IoYGRlZGljYXRlZCB3b3JrZXIgaGFzIG5vIHN1Y2ggdGFzayByZWdpc3RlcmVkIGFzICcke3NfdGFza30nYCkpO1xuXHRcdH1cblxuXHRcdC8vIGluaGVyaXQgc3RvcmUgZnJvbSBwcmV2aW91cyB0YXNrXG5cdFx0aWYgKGlfaW5oZXJpdCkge1xuXHRcdFx0bGV0IGhfc3RvcmUgPSB0aGlzLnN0b3JlO1xuXHRcdFx0aF9zdG9yZVtpX3Rhc2tdID0gaF9zdG9yZVtpX2luaGVyaXRdO1xuXHRcdFx0ZGVsZXRlIGhfc3RvcmVbaV9pbmhlcml0XTtcblx0XHR9XG5cblx0XHQvLyByZWNlaXZlIGRhdGEgZnJvbSBwcmV2aW91cyB0YXNrXG5cdFx0aWYgKGlfcmVjZWl2ZSkge1xuXHRcdFx0bGV0IGhfcmVzdWx0cyA9IHRoaXMucmVzdWx0cztcblxuXHRcdFx0Ly8gcHVzaCB0byBmcm9udCBvZiBhcmdzXG5cdFx0XHRhX2FyZ3MudW5zaGlmdChoX3Jlc3VsdHNbaV9yZWNlaXZlXS5kYXRhWzBdKTtcblxuXHRcdFx0Ly8gZnJlZSB0byBnY1xuXHRcdFx0ZGVsZXRlIGhfcmVzdWx0c1tpX3JlY2VpdmVdO1xuXHRcdH1cblxuXHRcdC8vIGV4ZWN1dGUgZ2l2ZW4gdGFza1xuXHRcdGxldCB6X3Jlc3VsdDtcblx0XHR0cnkge1xuXHRcdFx0el9yZXN1bHQgPSBoX3Rhc2tzW3NfdGFza10uYXBwbHkobmV3IGhlbHBlcih0aGlzLCBpX3Rhc2ssIGhfZXZlbnRzKSwgYV9hcmdzKTtcblx0XHR9IGNhdGNoIChlX2V4ZWMpIHtcblx0XHRcdGVfZXhlYy5tZXNzYWdlID0gYHdvcmtlciB0aHJldyBhbiBlcnJvciB3aGlsZSBleGVjdXRpbmcgdGFzayAnJHtzX3Rhc2t9JzpcXG4ke2VfZXhlYy5tZXNzYWdlfWA7XG5cdFx0XHRyZXR1cm4gdGhpcy50aHJvdyhlX2V4ZWMpO1xuXHRcdH1cblxuXHRcdC8vIGhvbGQgcmVzdWx0IGRhdGEgYW5kIGF3YWl0IGZ1cnRoZXIgaW5zdHJ1Y3Rpb25zIGZyb20gbWFzdGVyXG5cdFx0aWYgKGJfaG9sZCkge1xuXHRcdFx0dGhpcy5yZXNvbHZlKHpfcmVzdWx0LCAoa19yZXN1bHQpID0+IHtcblx0XHRcdFx0Ly8gc3RvcmUgcmVzdWx0XG5cdFx0XHRcdHRoaXMucmVzdWx0c1tpX3Rhc2tdID0ga19yZXN1bHQ7XG5cblx0XHRcdFx0Ly8gc3VibWl0IG5vdGlmaWNhdGlvbiB0byBtYXN0ZXJcblx0XHRcdFx0dGhpcy5wb3J0LnBvc3RNZXNzYWdlKHtcblx0XHRcdFx0XHR0eXBlOiAnbm90aWZ5Jyxcblx0XHRcdFx0XHRpZDogaV90YXNrLFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHR0aGlzLmRlYnVnKCc+PiBub3RpZnknLCBpX3Rhc2spO1xuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdC8vIHNlbmQgcmVzdWx0IGJhY2sgdG8gbWFzdGVyIGFzIHNvb24gYXMgaXRzIHJlYWR5XG5cdFx0ZWxzZSB7XG5cdFx0XHR0aGlzLnJlc29sdmUoel9yZXN1bHQsIChrX3Jlc3VsdCkgPT4ge1xuXHRcdFx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0XHRcdHR5cGU6ICdyZXNwb25kJyxcblx0XHRcdFx0XHRpZDogaV90YXNrLFxuXHRcdFx0XHRcdGRhdGE6IGtfcmVzdWx0LmRhdGFbMF0sXG5cdFx0XHRcdH0sIGtfcmVzdWx0LnBhdGhzKCdkYXRhJykpO1xuXG5cdFx0XHRcdHRoaXMuZGVidWcoJz4+IHJlc3BvbmQnLCBpX3Rhc2spO1xuXHRcdFx0fSk7XG5cdFx0fVxuXHR9XG5cblx0Ly8gc2VuZCByZXN1bHQgZGF0YSB0byBzaWJsaW5nXG5cdGhhbmRsZV9yZWxheShoX21zZykge1xuXHRcdGxldCBoX3Jlc3VsdHMgPSB0aGlzLnJlc3VsdHM7XG5cblx0XHRsZXQge1xuXHRcdFx0aWQ6IGlfdGFzayxcblx0XHRcdHBvcnQ6IGRfcG9ydCxcblx0XHR9ID0gaF9tc2c7XG5cblx0XHQvLyBjb25zb2xlLmRpcihkX3BvcnQpO1xuXHRcdHRoaXMuZGVidWcoJzw8IHJlbGF5JywgaV90YXNrLCBkX3BvcnQubmFtZSk7XG5cblx0XHQvLyBncmFiIHJlc3VsdFxuXHRcdGxldCBrX3Jlc3VsdCA9IGhfcmVzdWx0c1tpX3Rhc2tdO1xuXG5cdFx0Ly8gZm9yd2FyZCB0byBnaXZlbiBwb3J0XG5cdFx0ZF9wb3J0LnBvc3RNZXNzYWdlKGtfcmVzdWx0LmRhdGFbMF0sIGtfcmVzdWx0LnRyYW5zZmVyX3BhdGhzKTtcblxuXHRcdC8vIGZyZWUgdG8gZ2Ncblx0XHRkZWxldGUgaF9yZXN1bHRzW2lfdGFza107XG5cdH1cblxuXHQvLyByZWNlaXZlIGRhdGEgZnJvbSBzaWJsaW5nIGFuZCB0aGVuIGV4ZWN1dGUgcmVhZHkgdGFza1xuXHRoYW5kbGVfcmVjZWl2ZShoX21zZykge1xuXHRcdGxldCB7XG5cdFx0XHRwb3J0OiBkX3BvcnQsXG5cdFx0XHRpbXBvcnQ6IGlfaW1wb3J0LFxuXHRcdFx0cHJpbWFyeTogYl9wcmltYXJ5LFxuXHRcdFx0dGFza19yZWFkeTogaF90YXNrX3JlYWR5LFxuXHRcdH0gPSBoX21zZztcblxuXHRcdC8vIGFjY2VwdCBwb3J0XG5cdFx0cG9ydHMoZF9wb3J0KTtcblxuXHRcdHRoaXMuZGVidWcoJzw8IHJlY2VpdmU6JyArIGlfaW1wb3J0LCBoX3Rhc2tfcmVhZHkuaWQsIGRfcG9ydC5uYW1lKTtcblxuXHRcdC8vIGltcG9ydCBkYXRhXG5cdFx0bGV0IHpfZGF0YV9pbXBvcnQgPSB0aGlzLnJlc3VsdHNbaV9pbXBvcnRdLmRhdGFbMF07XG5cblx0XHQvLyBmcmVlIHRvIGdjXG5cdFx0ZGVsZXRlIHRoaXMucmVzdWx0c1tpX2ltcG9ydF07XG5cblx0XHQvLyB0YXNrIHJlYWR5IGFyZ3Ncblx0XHRsZXQgYV9hcmdzX3Rhc2tfcmVhZHkgPSBoX3Rhc2tfcmVhZHkuYXJncztcblxuXHRcdC8vIGltcG9ydCBpcyBzZWNvbmRhcnlcblx0XHRpZiAoIWJfcHJpbWFyeSkgYV9hcmdzX3Rhc2tfcmVhZHkudW5zaGlmdCh6X2RhdGFfaW1wb3J0KTtcblxuXHRcdHRoaXMuZGVidWcoJ3NldHVwJywgdXRpbC5pbnNwZWN0KGFfYXJnc190YXNrX3JlYWR5LCB7XG5cdFx0XHRkZXB0aDogbnVsbFxuXHRcdH0pKTtcblxuXHRcdC8vIHNldCB1cCBtZXNzYWdlIGhhbmRsZXIgb24gcG9ydFxuXHRcdGRfcG9ydC5ldmVudHMoe1xuXHRcdFx0bWVzc2FnZTogKGRfbXNnX3JlY2VpdmUpID0+IHtcblx0XHRcdFx0dGhpcy5kZWJ1ZygnPDwgcmVsYXkvcmVjZWl2ZScsIGRfcG9ydC5uYW1lKTtcblxuXHRcdFx0XHQvLyBjbG9zZSBwb3J0IG9uIGJvdGggc2lkZXNcblx0XHRcdFx0ZF9wb3J0LmNsb3NlKCk7XG5cblx0XHRcdFx0Ly8gcHVzaCBtZXNzYWdlIHRvIGZyb250IG9mIGFyZ3Ncblx0XHRcdFx0YV9hcmdzX3Rhc2tfcmVhZHkudW5zaGlmdChkX21zZ19yZWNlaXZlLmRhdGEpO1xuXG5cdFx0XHRcdC8vIGltcG9ydCBpcyBwcmltYXJ5XG5cdFx0XHRcdGlmIChiX3ByaW1hcnkpIGFfYXJnc190YXNrX3JlYWR5LnVuc2hpZnQoel9kYXRhX2ltcG9ydCk7XG5cblx0XHRcdFx0Ly8gZmlyZSByZWFkeSB0YXNrXG5cdFx0XHRcdHRoaXMuaGFuZGxlX3Rhc2soaF90YXNrX3JlYWR5KTtcblx0XHRcdH0sXG5cblx0XHRcdG1lc3NhZ2VlcnJvcjogKGVfbXNnKSA9PiB7XG5cdFx0XHRcdHRocm93IGVfbXNnO1xuXHRcdFx0fSxcblx0XHR9KTtcblx0fVxuXG5cdGhhbmRsZV9waW5nKCkge1xuXHRcdHRoaXMucG9ydC5wb3N0TWVzc2FnZSh7XG5cdFx0XHR0eXBlOiAncG9uZycsXG5cdFx0fSk7XG5cdH1cblxuXHRoYW5kbGVfb3duZXIoaF9tc2cpIHtcblx0XHR0aGlzLnNldF9wb3J0KHBvcnRzKGhfbXNnLnBvcnQpKTtcblx0fVxuXG5cdGhhbmRsZV9zdWJ3b3JrZXIoaF9tc2cpIHtcblx0XHRsYXRlbnRfc3Vid29ya2VyLmNvbm5lY3QoaF9tc2cpO1xuXHR9XG5cblx0c2V0X3BvcnQoZF9wb3J0KSB7XG5cdFx0dGhpcy5wb3J0ID0gZF9wb3J0O1xuXG5cdFx0ZF9wb3J0LmV2ZW50cyh7XG5cdFx0XHRtZXNzYWdlOiAoZF9tc2cpID0+IHtcblx0XHRcdFx0Ly8gZGVidWdnZXI7XG5cdFx0XHRcdGxldCBoX21zZyA9IGRfbXNnLmRhdGE7XG5cblx0XHRcdFx0Ly8gaGFuZGxlIG1lc3NhZ2Vcblx0XHRcdFx0bGV0IHNfaGFuZGxlID0gJ2hhbmRsZV8nICsgaF9tc2cudHlwZTtcblx0XHRcdFx0aWYgKHNfaGFuZGxlIGluIHRoaXMpIHtcblx0XHRcdFx0XHR0aGlzW3NfaGFuZGxlXShoX21zZyk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gbWlzc2luZyBoYW5kbGUgbmFtZSBpbiBtZXNzYWdlXG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcignZGVkaWNhdGVkIHdvcmtlciByZWNlaXZlZCBhIG1lc3NhZ2UgaXQgZG9lcyBub3Qga25vdyBob3cgdG8gaGFuZGxlOiAnICsgZF9tc2cpO1xuXHRcdFx0XHR9XG5cdFx0XHR9LFxuXG5cdFx0XHRtZXNzYWdlZXJyb3I6IChlX21zZykgPT4ge1xuXHRcdFx0XHR0aHJvdyBlX21zZztcblx0XHRcdH0sXG5cdFx0fSk7XG5cdH1cbn07IiwiY29uc3Qge1xuXHROX0NPUkVTLFxuXHRIUF9XT1JLRVJfTk9USUZJQ0FUSU9OLFxuXHREQ19DSEFOTkVMLFxufSA9IHJlcXVpcmUoJy4vbG9jYWxzLmpzJyk7XG5cbmNvbnN0IG1hbmlmZXN0ID0gcmVxdWlyZSgnLi9tYW5pZmVzdC5qcycpO1xubGV0IHdvcmtlcjtcblxuXG5jb25zdCBYTV9TVFJBVEVHWV9FUVVBTCA9IDEgPDwgMDtcblxuY29uc3QgWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQkFMQU5DRUQgPSAxIDw8IDI7XG5jb25zdCBYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQU19CSUFTRUQgPSAxIDw8IDM7XG5cbmNvbnN0IFhNX1NUUkFURUdZX09SREVSRURfR1JPVVBTID0gWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQkFMQU5DRUQgfCBYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQU19CSUFTRUQ7XG5cbmNvbnN0IFhNX0RJU1RSSUJVVElPTl9DT05TVEFOVCA9IDEgPDwgMDtcblxuXG5jbGFzcyBsb2NrIHtcblx0Y29uc3RydWN0b3IoYl91bmxvY2tlZCA9IGZhbHNlKSB7XG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHR1bmxvY2tlZDogYl91bmxvY2tlZCxcblx0XHRcdHF1ZXVlOiBbXSxcblx0XHR9KTtcblx0fVxuXG5cdHdhaXQoZmtfdW5sb2NrKSB7XG5cdFx0Ly8gYWxyZWFkeSB1bmxvY2tlZFxuXHRcdGlmICh0aGlzLnVubG9ja2VkKSB7XG5cdFx0XHRma191bmxvY2soKTtcblx0XHR9XG5cdFx0Ly8gY3VycmVudGx5IGxvY2tlZCwgYWRkIHRvIHF1ZXVlXG5cdFx0ZWxzZSB7XG5cdFx0XHR0aGlzLnF1ZXVlLnB1c2goZmtfdW5sb2NrKTtcblx0XHR9XG5cdH1cblxuXHR1bmxvY2soKSB7XG5cdFx0Ly8gdXBkYXRlIHN0YXRlXG5cdFx0dGhpcy51bmxvY2tlZCA9IHRydWU7XG5cblx0XHQvLyB1cGRhdGUgZmllbGQgYmVmb3JlIGV4ZWN1dGluZyBjYWxsYmFja3Ncblx0XHRsZXQgYV9xdWV1ZSA9IHRoaXMucXVldWU7XG5cdFx0dGhpcy5xdWV1ZSA9IFtdO1xuXG5cdFx0Ly8gcHJvY2VzcyBjYWxsYmFjayBxdWV1ZVxuXHRcdGFfcXVldWUuZm9yRWFjaCgoZmtfdW5sb2NrKSA9PiB7XG5cdFx0XHRma191bmxvY2soKTtcblx0XHR9KTtcblx0fVxufVxuXG5cbmNsYXNzIGdyb3VwIHtcblx0Y29uc3RydWN0b3IocF9zb3VyY2UsIG5fd29ya2VycyA9IE5fQ09SRVMsIGhfd29ya2VyX29wdGlvbnMgPSB7fSkge1xuXHRcdC8vIG5vIHdvcmtlciBjb3VudCBnaXZlbjsgZGVmYXVsdCB0byBudW1iZXIgb2YgY29yZXNcblx0XHRpZiAoIW5fd29ya2Vycykgbl93b3JrZXJzID0gTl9DT1JFUztcblxuXHRcdC8vIG5lZ2F0aXZlIG51bWJlciBnaXZlbjsgc3VidHJhY3QgZnJvbSBjb3JlIGNvdW50XG5cdFx0aWYgKG5fd29ya2VycyA8IDApIG5fd29ya2VycyA9IE1hdGgubWF4KDEsIE5fQ09SRVMgKyBuX3dvcmtlcnMpO1xuXG5cdFx0Ly8gbWFrZSB3b3JrZXJzXG5cdFx0bGV0IGFfd29ya2VycyA9IFtdO1xuXHRcdGxldCBobV9yb3N0ZXIgPSBuZXcgV2Vha01hcCgpO1xuXHRcdGZvciAobGV0IGlfd29ya2VyID0gMDsgaV93b3JrZXIgPCBuX3dvcmtlcnM7IGlfd29ya2VyKyspIHtcblx0XHRcdC8vIG1ha2UgbmV3IHdvcmtlclxuXHRcdFx0bGV0IGtfd29ya2VyID0gbmV3IHdvcmtlcih7XG5cdFx0XHRcdHNvdXJjZTogcF9zb3VyY2UsXG5cdFx0XHRcdGlkOiBpX3dvcmtlcixcblx0XHRcdFx0bWFzdGVyOiB0aGlzLFxuXHRcdFx0XHRvcHRpb25zOiBPYmplY3QuYXNzaWduKHtcblx0XHRcdFx0XHRhcmdzOiBbU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIGlfd29ya2VyKV0sXG5cdFx0XHRcdH0sIGhfd29ya2VyX29wdGlvbnMpLFxuXHRcdFx0fSk7XG5cblx0XHRcdC8vIGFkZCB0byB3b3JrZXIgbGlzdFxuXHRcdFx0YV93b3JrZXJzLnB1c2goa193b3JrZXIpO1xuXG5cdFx0XHQvLyByZXNlcnZlIGEgcXVldWUgZm9yIGl0IGluIHJvc3RlclxuXHRcdFx0aG1fcm9zdGVyLnNldChrX3dvcmtlciwgW10pO1xuXHRcdH1cblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0c291cmNlOiBwX3NvdXJjZSxcblx0XHRcdHdvcmtlcl9jb3VudDogbl93b3JrZXJzLFxuXHRcdFx0d29ya2VyczogYV93b3JrZXJzLFxuXHRcdFx0cm9zdGVyOiBobV9yb3N0ZXIsXG5cdFx0XHR3YWl0X2xpc3Q6IFtdLFxuXHRcdFx0bG9ja3M6IHt9LFxuXHRcdFx0bmV4dF93b3JrZXJfc3VtbW9uOiAwLFxuXHRcdH0pO1xuXHR9XG5cblx0ZGF0YShhX2l0ZW1zKSB7XG5cdFx0cmV0dXJuIG5ldyBhcm1lZF9ncm91cCh0aGlzLCB0aGlzLmJhbGFuY2UoYV9pdGVtcykpO1xuXHR9XG5cblx0dXNlKGFfc3Vic2V0cykge1xuXHRcdGlmIChhX3N1YnNldHMubGVuZ3RoID4gdGhpcy53b3JrZXJfY291bnQpIHtcblx0XHRcdHRocm93IG5ldyBSYW5nZUVycm9yKGB0b28gbWFueSBzdWJzZXRzIGdpdmVuIGZvciBudW1iZXIgb2Ygd29ya2VyczogJHthX3N1YnNldHMubGVuZ3RofSBzdWJzZXRzID4gJHt0aGlzLndvcmtlcl9jb3VudH0gd29ya2Vyc2ApO1xuXHRcdH1cblxuXHRcdHJldHVybiBuZXcgYXJtZWRfZ3JvdXAodGhpcywgYV9zdWJzZXRzKTtcblx0fVxuXG5cdHdhaXQoel9rZXksIHpfdW5sb2NrKSB7XG5cdFx0bGV0IGZrX3VubG9jayA9IHpfdW5sb2NrO1xuXG5cdFx0Ly8gdW5sb2NrIGlzIGFub3RoZXIgbG9ja1xuXHRcdGlmICgnc3RyaW5nJyA9PT0gdHlwZW9mIHpfdW5sb2NrKSB7XG5cdFx0XHRma191bmxvY2sgPSAoKSA9PiB7XG5cdFx0XHRcdHRoaXMudW5sb2NrKHpfdW5sb2NrKTtcblx0XHRcdH07XG5cdFx0fVxuXHRcdC8vIHVubG9jayBpcyBhcnJheSBvZiBsb2Nrc1xuXHRcdGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoel91bmxvY2spKSB7XG5cdFx0XHRma191bmxvY2sgPSAoKSA9PiB7XG5cdFx0XHRcdHRoaXMudW5sb2NrKHpfdW5sb2NrKTtcblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0Ly8gc2VyaWVzIG9mIGtleXMgdG8gd2FpdCBmb3Jcblx0XHRpZiAoQXJyYXkuaXNBcnJheSh6X2tleSkpIHtcblx0XHRcdGxldCBpX2tleSA9IDA7XG5cdFx0XHRsZXQgbl9rZXlzID0gel9rZXkubGVuZ3RoO1xuXHRcdFx0bGV0IGZfbmV4dCA9ICgpID0+IHtcblx0XHRcdFx0aWYgKGlfa2V5ID09PSBuX2tleXMpIGZrX3VubG9jaygpO1xuXHRcdFx0XHRlbHNlIHRoaXMud2FpdCh6X2tleVtpX2tleSsrXSwgZl9uZXh0KTtcblx0XHRcdH07XG5cblx0XHRcdGZfbmV4dCgpO1xuXHRcdH1cblx0XHQvLyBubyBzdWNoIGxvY2s7IGJ1dCB0aGF0J3Mgb2theSA7KSBjcmVhdGUgbG9jayBpbXBsaWNpdGx5XG5cdFx0ZWxzZSBpZiAoISh6X2tleSBpbiB0aGlzLmxvY2tzKSkge1xuXHRcdFx0bGV0IGtfbG9jayA9IHRoaXMubG9ja3Nbel9rZXldID0gbmV3IGxvY2soKTtcblx0XHRcdGtfbG9jay53YWl0KGZrX3VubG9jayk7XG5cdFx0fVxuXHRcdC8vIGFkZCB0byB3YWl0IHF1ZXVlXG5cdFx0ZWxzZSB7XG5cdFx0XHR0aGlzLmxvY2tzW3pfa2V5XS53YWl0KGZrX3VubG9jayk7XG5cdFx0fVxuXHR9XG5cblx0dW5sb2NrKHpfa2V5KSB7XG5cdFx0Ly8gbGlzdCBvZiBrZXlzIHRvIHVubG9ja1xuXHRcdGlmIChBcnJheS5pc0FycmF5KHpfa2V5KSkge1xuXHRcdFx0el9rZXkuZm9yRWFjaCh6X2tleV8gPT4gdGhpcy51bmxvY2soel9rZXlfKSk7XG5cdFx0fVxuXHRcdC8vIGluZGl2dWRhbCBrZXlcblx0XHRlbHNlIHtcblx0XHRcdC8vIG5vIHN1Y2ggbG9jayB5ZXRcblx0XHRcdGlmICghKHpfa2V5IGluIHRoaXMubG9ja3MpKSB7XG5cdFx0XHRcdHRoaXMubG9ja3Nbel9rZXldID0gbmV3IGxvY2sodHJ1ZSk7XG5cdFx0XHR9XG5cdFx0XHQvLyB1bmxvY2tcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHR0aGlzLmxvY2tzW3pfa2V5XS51bmxvY2soKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRiYWxhbmNlKGFfaXRlbXMpIHtcblx0XHRyZXR1cm4gZGl2aWRlKGFfaXRlbXMsIHRoaXMud29ya2VyX2NvdW50LCBYTV9TVFJBVEVHWV9FUVVBTCk7XG5cdH1cblxuXHRiYWxhbmNlX29yZGVyZWRfZ3JvdXBzKGFfZ3JvdXBzLCBoX2RpdmlkZSkge1xuXHRcdHJldHVybiBkaXZpZGUoYV9ncm91cHMsIHRoaXMud29ya2VyX2NvdW50LCBYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQU19CQUxBTkNFRCwgaF9kaXZpZGUpO1xuXHR9XG5cblx0Ymlhc19vcmRlcmVkX2dyb3VwcyhhX2dyb3VwcywgaF9kaXZpZGUpIHtcblx0XHRyZXR1cm4gZGl2aWRlKGFfZ3JvdXBzLCB0aGlzLndvcmtlcl9jb3VudCwgWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQklBU0VELCBoX2RpdmlkZSk7XG5cdH1cblxuXHRkaXZpc2lvbnMobl9pdGVtcykge1xuXHRcdGxldCBuX3dvcmtlcnMgPSB0aGlzLndvcmtlcl9jb3VudDtcblxuXHRcdC8vIGRvIG5vdCBhc3NpZ24gd29ya2VyIHRvIGRvIG5vdGhpbmdcblx0XHRpZiAobl9pdGVtcyA8IG5fd29ya2Vycykgbl93b3JrZXJzID0gbl9pdGVtcztcblxuXHRcdC8vIGhvdyBtYW55IHRpbWVzIHRvIGRpdmlkZSB0aGUgaXRlbXNcblx0XHRsZXQgbl9kaXZpc2lvbnMgPSBuX3dvcmtlcnMgLSAxO1xuXG5cdFx0Ly8gaWRlYWwgbnVtYmVyIG9mIGl0ZW1zIHBlciB3b3JrZXJcblx0XHRsZXQgeF9pdGVtc19wZXJfd29ya2VyID0gbl9pdGVtcyAvIG5fd29ya2VycztcblxuXHRcdC8vIGl0ZW0gaW5kaWNlcyB3aGVyZSB0byBtYWtlIGRpdmlzaW9uc1xuXHRcdGxldCBhX2RpdmlzaW9ucyA9IFtdO1xuXHRcdGZvciAobGV0IGlfZGl2aXNpb24gPSAxOyBpX2RpdmlzaW9uIDw9IG5fZGl2aXNpb25zOyBpX2RpdmlzaW9uKyspIHtcblx0XHRcdGFfZGl2aXNpb25zLnB1c2goTWF0aC5yb3VuZChpX2RpdmlzaW9uICogeF9pdGVtc19wZXJfd29ya2VyKSk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGFfZGl2aXNpb25zO1xuXHR9XG5cblx0KiBkaXZpZGVyKGNfaXRlbXNfcmVtYWluLCB4bV9kaXN0cmlidXRpb24gPSBYTV9ESVNUUklCVVRJT05fQ09OU1RBTlQpIHtcblx0XHRsZXQgY193b3JrZXJzX3JlbWFpbiA9IHRoaXMud29ya2VyX2NvdW50O1xuXG5cdFx0Ly8gaXRlbXMgcGVyIHdvcmtlclxuXHRcdGxldCBuX2l0ZW1zX3Blcl9kaXZpc2lvbiA9IE1hdGguZmxvb3IoY19pdGVtc19yZW1haW4gLyBjX3dvcmtlcnNfcmVtYWluKTtcblxuXHRcdC8vIGNvbnN0YW50IGRpc3RyaWJ1dGlvblxuXHRcdGlmIChYTV9ESVNUUklCVVRJT05fQ09OU1RBTlQgPT09IHhtX2Rpc3RyaWJ1dGlvbikge1xuXHRcdFx0bGV0IGNfaXRlbXMgPSAwO1xuXG5cdFx0XHQvLyBpdGVyYXRpdmVseSBmaW5kIGluZGV4ZXMgdG8gZGl2aWRlIGF0XG5cdFx0XHRmb3IgKDs7KSB7XG5cdFx0XHRcdC8vIGRpdmlkZSBoZXJlXG5cdFx0XHRcdGlmICgrK2NfaXRlbXMgPj0gbl9pdGVtc19wZXJfZGl2aXNpb24pIHtcblx0XHRcdFx0XHQvLyBkaXZpZGluZyBub3cgd291bGQgY2F1c2UgaXRlbSBvdmVyZmxvd1xuXHRcdFx0XHRcdGlmICghLS1jX3dvcmtlcnNfcmVtYWluKSB7XG5cdFx0XHRcdFx0XHQvLyBkb24ndCBjcmVhdGUgYW55IG1vcmUgZGl2aXNpb25zXG5cdFx0XHRcdFx0XHRmb3IgKDs7KSB5aWVsZCBmYWxzZTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHQvLyBkaXZpc2lvbiBva2F5XG5cdFx0XHRcdFx0eWllbGQgdHJ1ZTtcblxuXHRcdFx0XHRcdC8vIGhvdyBtYW55IGl0ZW1zIHJlbWFpblxuXHRcdFx0XHRcdGNfaXRlbXNfcmVtYWluIC09IGNfaXRlbXM7XG5cblx0XHRcdFx0XHQvLyByZXNldCBpdGVtIGNvdW50IGZvciBuZXcgd29ya2VyXG5cdFx0XHRcdFx0Y19pdGVtcyA9IDA7XG5cblx0XHRcdFx0XHQvLyByZWNhbGN1bGF0ZSB0YXJnZXQgaXRlbXMgcGVyIHdvcmtlclxuXHRcdFx0XHRcdG5faXRlbXNfcGVyX2RpdmlzaW9uID0gTWF0aC5mbG9vcihjX2l0ZW1zX3JlbWFpbiAvIGNfd29ya2Vyc19yZW1haW4pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIHB1c2ggaXRlbVxuXHRcdFx0XHRlbHNlIHtcblx0XHRcdFx0XHR5aWVsZCBmYWxzZTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cblx0Ly8gbGF0ZW50KGhfZGlzcGF0Y2gpIHtcblx0Ly8gXHRsZXQge1xuXHQvLyBcdFx0dGFzazogc190YXNrLFxuXHQvLyBcdFx0YXJnczogYV9hcmdzX2Rpc3BhdGNoPVtdLFxuXHQvLyBcdFx0dGFza19jb3VudDogbl90YXNrcz10aGlzLndvcmtlcl9jb3VudCxcblx0Ly8gXHRcdGV2ZW50czogaF9ldmVudHNfZGlzcGF0Y2gsXG5cdC8vIFx0fSA9IGhfZGlzcGF0Y2g7XG5cblx0Ly8gXHRsZXQgaV9zdWJzZXQgPSAwO1xuXG5cdC8vIFx0Ly8gcHJlcGFyZSB0byBkZWFsIHdpdGggcmVzdWx0c1xuXHQvLyBcdGxldCBrX3BsYW5uZXIgPSBuZXcgYWN0aXZlX2dyb3VwKHRoaXMsIG5fdGFza3MsIChhX2FyZ3M9W10sIGFfdHJhbnNmZXI9bnVsbCkgPT4ge1xuXHQvLyBcdFx0Ly8gc3VtbW9uIHdvcmtlcnMgb25lIGF0IGEgdGltZVxuXHQvLyBcdFx0dGhpcy5zdW1tb25fd29ya2VycygxLCAoa193b3JrZXIpID0+IHtcblx0Ly8gXHRcdFx0Ly8gcmVzdWx0IGhhbmRsZXIgd2FzIG5vdCB1c2VkOyBhdXRvLWVuZCBpdFxuXHQvLyBcdFx0XHRpZigha19wbGFubmVyLnVzZWQpIGtfcGxhbm5lci5lbmQoKTtcblxuXHQvLyBcdFx0XHQvLyBtYWtlIHJlc3VsdCBoYW5kbGVyXG5cdC8vIFx0XHRcdGxldCBma19yZXN1bHQgPSBrX3BsYW5uZXIubWtfcmVzdWx0KGtfd29ya2VyLCBpX3N1YnNldCsrKTtcblxuXHQvLyBcdFx0XHQvLyBtYWtlIHdvcmtlci1zcGVjaWZpYyBldmVudHNcblx0Ly8gXHRcdFx0bGV0IGhfZXZlbnRzX3dvcmtlciA9IHRoaXMuZXZlbnRfcm91dGVyKGhfZXZlbnRzX2Rpc3BhdGNoLCBpX3N1YnNldCk7XG5cblx0Ly8gXHRcdFx0Ly8gZXhlY3V0ZSB3b3JrZXIgb24gdGhpcyBwYXJ0IG9mIGRhdGFcblx0Ly8gXHRcdFx0a193b3JrZXIuZXhlYyh7XG5cdC8vIFx0XHRcdFx0dGFzazogc190YXNrLFxuXHQvLyBcdFx0XHRcdGFyZ3M6IFsuLi5hX2FyZ3NfZGlzcGF0Y2gsIC4uLmFfYXJnc10sXG5cdC8vIFx0XHRcdFx0dHJhbnNmZXI6IGFfdHJhbnNmZXIsXG5cdC8vIFx0XHRcdFx0aG9sZDoga19wbGFubmVyLnVwc3RyZWFtX2hvbGQsXG5cdC8vIFx0XHRcdFx0ZXZlbnRzOiBoX2V2ZW50c193b3JrZXIsXG5cdC8vIFx0XHRcdH0sIGZrX3Jlc3VsdCk7XG5cdC8vIFx0XHR9KTtcblx0Ly8gXHR9KTtcblxuXHQvLyBcdC8vIGxldCB1c2VyIGJpbmQgaGFuZGxlclxuXHQvLyBcdHJldHVybiBrX3BsYW5uZXI7XG5cdC8vIH1cblxuXHRzY2hlZHVsZShrX3dvcmtlciwgZl9ydW4pIHtcblx0XHQvLyB3b3JrZXIgYXZhaWxhYmxlIGltbWVkaWF0ZWx5XG5cdFx0aWYgKGtfd29ya2VyLmF2YWlsYWJsZSkge1xuXHRcdFx0Zl9ydW4oKTtcblx0XHR9XG5cdFx0Ly8gcHVzaCB0byBwcmlvcml0eSBxdWV1ZVxuXHRcdGVsc2Uge1xuXHRcdFx0dGhpcy5yb3N0ZXIuZ2V0KGtfd29ya2VyKS5wdXNoKGZfcnVuKTtcblx0XHR9XG5cdH1cblxuXHRhc3NpZ25fd29ya2VyKGtfd29ya2VyLCBoX3Rhc2ssIGZrX3Rhc2spIHtcblx0XHQvLyBvbmNlIGl0IGlzIHRpbWUgdG8gcnVuIHRoZSB0YXNrIG9uIHRoZSBnaXZlbiB3b3JrZXJcblx0XHR0aGlzLnNjaGVkdWxlKGtfd29ya2VyLCAoKSA9PiB7XG5cdFx0XHRrX3dvcmtlci5leGVjKGhfdGFzaywgKC4uLmFfYXJncykgPT4ge1xuXHRcdFx0XHQvLyB3b3JrZXIganVzdCBtYWRlIGl0c2VsZiBhdmFpbGFibGVcblx0XHRcdFx0dGhpcy53b3JrZXJfYXZhaWxhYmxlKGtfd29ya2VyKTtcblxuXHRcdFx0XHQvLyBjYWxsYmFja1xuXHRcdFx0XHRma190YXNrKC4uLmFfYXJncyk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblx0fVxuXG5cdHJlbGF5KGhfcmVsYXksIGZrX3Jlc3VsdCkge1xuXHRcdGxldCB7XG5cdFx0XHRzZW5kZXI6IHtcblx0XHRcdFx0d29ya2VyOiBrX3dvcmtlcl9zZW5kZXIsXG5cdFx0XHRcdHRhc2tfaWQ6IGlfdGFza19zZW5kZXIsXG5cdFx0XHR9LFxuXHRcdFx0cmVjZWl2ZXI6IHtcblx0XHRcdFx0d29ya2VyOiBrX3dvcmtlcl9yZWNlaXZlcixcblx0XHRcdFx0dGFza19pZDogaV90YXNrX3JlY2VpdmVyLFxuXHRcdFx0fSxcblx0XHRcdHJlY2VpdmVyX3ByaW1hcnk6IGJfcmVjZWl2ZXJfcHJpbWFyeSxcblx0XHRcdHRhc2tfcmVhZHk6IGhfdGFza19yZWFkeSxcblx0XHR9ID0gaF9yZWxheTtcblxuXHRcdGxldCBzX3NlbmRlciA9ICdTJyArIFN0cmluZy5mcm9tQ2hhckNvZGUoNjUgKyBrX3dvcmtlcl9zZW5kZXIuaWQpO1xuXHRcdGxldCBzX3JlY2VpdmVyID0gJ1MnICsgU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIGtfd29ya2VyX3JlY2VpdmVyLmlkKTtcblxuXHRcdC8vIGNyZWF0ZSBtZXNzYWdlIGNoYW5uZWxcblx0XHRsZXQga19jaGFubmVsID0gbmV3IERDX0NIQU5ORUwoc19zZW5kZXIsIHNfcmVjZWl2ZXIpO1xuXG5cdFx0aWYgKGtfd29ya2VyX3NlbmRlciA9PT0ga193b3JrZXJfcmVjZWl2ZXIpIGRlYnVnZ2VyO1xuXG5cdFx0Ly8gY29uc29sZS53YXJuKGBNL3JlbGF5L3JlY2VpdmUgWyR7aV90YXNrX3NlbmRlcn1dID0+ICR7aV90YXNrX3JlY2VpdmVyfWApO1xuXG5cdFx0Ly8gc2NoZWR1bGUgcmVjZWl2ZXIgd29ya2VyIHRvIHJlY2VpdmUgZGF0YSBhbmQgdGhlbiBydW4gdGFza1xuXHRcdHRoaXMuc2NoZWR1bGUoa193b3JrZXJfcmVjZWl2ZXIsICgpID0+IHtcblx0XHRcdGtfY2hhbm5lbC5wb3J0XzIoKGRfcG9ydCkgPT4ge1xuXHRcdFx0XHRrX3dvcmtlcl9yZWNlaXZlci5yZWNlaXZlKGRfcG9ydCwge1xuXHRcdFx0XHRcdGltcG9ydDogaV90YXNrX3JlY2VpdmVyLFxuXHRcdFx0XHRcdHByaW1hcnk6IGJfcmVjZWl2ZXJfcHJpbWFyeSxcblx0XHRcdFx0XHR0YXNrX3JlYWR5OiBoX3Rhc2tfcmVhZHksXG5cdFx0XHRcdH0sICguLi5hX2FyZ3MpID0+IHtcblx0XHRcdFx0XHQvLyB3b3JrZXIganVzdCBtYWRlIGl0c2VsZiBhdmFpbGFibGVcblx0XHRcdFx0XHR0aGlzLndvcmtlcl9hdmFpbGFibGUoa193b3JrZXJfcmVjZWl2ZXIpO1xuXG5cdFx0XHRcdFx0Ly8gY2FsbGJhY2tcblx0XHRcdFx0XHRma19yZXN1bHQoLi4uYV9hcmdzKTtcblx0XHRcdFx0fSk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdC8vIHNjaGVkdWxlIHNlbmRlciB3b3JrZXIgdG8gcmVsYXkgZGF0YSB0byByZWNlaXZlciB3b3JrZXJcblx0XHR0aGlzLnNjaGVkdWxlKGtfd29ya2VyX3NlbmRlciwgKCkgPT4ge1xuXHRcdFx0a19jaGFubmVsLnBvcnRfMSgoZF9wb3J0KSA9PiB7XG5cdFx0XHRcdGtfd29ya2VyX3NlbmRlci5yZWxheShpX3Rhc2tfc2VuZGVyLCBkX3BvcnQsIFN0cmluZy5mcm9tQ2hhckNvZGUoNjUgKyBrX3dvcmtlcl9yZWNlaXZlci5pZCkpO1xuXG5cdFx0XHRcdC8vIG5vIHJlc3VsdCBuZWVkZWQgZnJvbSByZWxheTsgd29ya2VyIGlzIGF2YWlsYWJsZSBhZnRlciBtZXNzYWdlIHBvc3RzXG5cdFx0XHRcdHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHRcdHRoaXMud29ya2VyX2F2YWlsYWJsZShrX3dvcmtlcl9zZW5kZXIpO1xuXHRcdFx0XHR9LCAwKTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXG5cdH1cblxuXHRzdW1tb25fd29ya2VycyhuX3N1bW1vbnMsIGZrX3dvcmtlcikge1xuXHRcdGxldCBhX3dvcmtlcnMgPSB0aGlzLndvcmtlcnM7XG5cdFx0bGV0IG5fd29ya2VycyA9IHRoaXMud29ya2VyX2NvdW50O1xuXG5cdFx0bGV0IGNfc3VtbW9uZWQgPSAwO1xuXG5cdFx0Ly8gc3RhcnQgYnkgbG9va2luZyBmb3IgYXZhaWxhYmxlIHdvcmtlcnNcblx0XHRsZXQgaV9uZXh0X3dvcmtlcl9zdW1tb24gPSB0aGlzLm5leHRfd29ya2VyX3N1bW1vbjtcblxuXHRcdGZvciAobGV0IGlfd29ya2VyID0gMDsgaV93b3JrZXIgPCBuX3dvcmtlcnMgJiYgY19zdW1tb25lZCA8IG5fc3VtbW9uczsgaV93b3JrZXIrKykge1xuXHRcdFx0bGV0IGlfd29ya2VyX2NhbGwgPSAoaV93b3JrZXIgKyBpX25leHRfd29ya2VyX3N1bW1vbikgJSBuX3dvcmtlcnM7XG5cdFx0XHRsZXQga193b3JrZXIgPSBhX3dvcmtlcnNbaV93b3JrZXJfY2FsbF07XG5cblx0XHRcdC8vIHdvcmtlciBhdmFpbGFibGUgaW1tZWRpYXRlbHlcblx0XHRcdGlmIChrX3dvcmtlci5hdmFpbGFibGUpIHtcblx0XHRcdFx0Ly8gc2V0IG5leHQgd29ya2VyIHRvIHN1bW1vblxuXHRcdFx0XHR0aGlzLm5leHRfd29ya2VyX3N1bW1vbiA9IGlfd29ya2VyX2NhbGwgKyAxO1xuXG5cdFx0XHRcdC8vIHNhdmUgc3VtbW9uIGluZGV4XG5cdFx0XHRcdGxldCBpX3N1YnNldCA9IGNfc3VtbW9uZWQrKztcblxuXHRcdFx0XHQvLyBhbGxvdyBkb3duc3RyZWFtIGhhbmRsZXIgdG8gYmUgZXN0YWJsaXNoZWQgZmlyc3Rcblx0XHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0Ly8gY29uc29sZS5pbmZvKCcgPT4gJytrX3dvcmtlci5pZCk7XG5cdFx0XHRcdFx0Zmtfd29ya2VyKGtfd29ya2VyLCBpX3N1YnNldCk7XG5cdFx0XHRcdH0sIDApO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIHRoZXJlIGFyZSByZW1haW5pbmcgc3VtbW9uc1xuXHRcdGlmIChjX3N1bW1vbmVkIDwgbl9zdW1tb25zKSB7XG5cdFx0XHQvLyBxdWV1ZSBmb3Igbm90aWZpY2F0aW9uIHdoZW4gd29ya2VycyBiZWNvbWUgYXZhaWxhYmxlXG5cdFx0XHR0aGlzLndhaXRfbGlzdC5wdXNoKHtcblx0XHRcdFx0dGFza3NfcmVtYWluaW5nOiBuX3N1bW1vbnMgLSBjX3N1bW1vbmVkLFxuXHRcdFx0XHRlYWNoKGtfd29ya2VyKSB7XG5cdFx0XHRcdFx0Zmtfd29ya2VyKGtfd29ya2VyLCBjX3N1bW1vbmVkKyspO1xuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cdFx0fVxuXHR9XG5cblx0d29ya2VyX2F2YWlsYWJsZShrX3dvcmtlcikge1xuXHRcdC8vIHRoaXMgd29ya2VyIGhhcyBwcmlvcml0eSB0YXNrcyB3YWl0aW5nIGZvciBpdFxuXHRcdGxldCBhX3F1ZXVlID0gdGhpcy5yb3N0ZXIuZ2V0KGtfd29ya2VyKTtcblx0XHRpZiAoYV9xdWV1ZS5sZW5ndGgpIHtcblx0XHRcdC8vIGZpZm8gcG9wIGFuZCBjYWxsXG5cdFx0XHRsZXQgZmtfd29ya2VyID0gYV9xdWV1ZS5zaGlmdCgpO1xuXHRcdFx0Zmtfd29ya2VyKCk7XG5cdFx0fVxuXHRcdC8vIHRoZXJlIGlzIGEgd2FpdCBsaXN0XG5cdFx0ZWxzZSBpZiAodGhpcy53YWl0X2xpc3QubGVuZ3RoKSB7XG5cdFx0XHQvLyB0b3Agb2YgcXVldWVcblx0XHRcdGxldCBoX3BhdGllbnQgPSB0aGlzLndhaXRfbGlzdFswXTtcblxuXHRcdFx0Ly8gYXNzaWduIHdvcmtlciBuZXh0IHRhc2tcblx0XHRcdGhfcGF0aWVudC5lYWNoKGtfd29ya2VyKTtcblxuXHRcdFx0Ly8gdGhpcyBwYXRpZW50IGlzIHNhdGlzZmllZDsgZmlmbyBwb3Bcblx0XHRcdGlmICgwID09PSAtLWhfcGF0aWVudC50YXNrc19yZW1haW5pbmcpIHRoaXMud2FpdF9saXN0LnNoaWZ0KCk7XG5cdFx0fVxuXHRcdC8vIG90aGVyd2lzZSwgZnJlZSB3b3JrZXJcblx0XHRlbHNlIHtcblx0XHRcdGtfd29ya2VyLmF2YWlsYWJsZSA9IHRydWU7XG5cdFx0fVxuXHR9XG5cblx0a2lsbChzX2tpbGwpIHtcblx0XHRyZXR1cm4gUHJvbWlzZS5hbGwodGhpcy53b3JrZXJzLm1hcCgoa193b3JrZXIpID0+IGtfd29ya2VyLmtpbGwoc19raWxsKSkpO1xuXHR9XG59XG5cblxuY2xhc3MgYXJtZWRfZ3JvdXAge1xuXHRjb25zdHJ1Y3RvcihrX2dyb3VwLCBhX3N1YnNldHMpIHtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdGdyb3VwOiBrX2dyb3VwLFxuXHRcdFx0c3Vic2V0czogYV9zdWJzZXRzLFxuXHRcdH0pO1xuXHR9XG5cblx0bWFwKHNfdGFzaywgel9hcmdzID0gW10sIGhfZXZlbnRzX21hcCA9IHt9KSB7XG5cdFx0bGV0IHtcblx0XHRcdGdyb3VwOiBrX2dyb3VwLFxuXHRcdFx0c3Vic2V0czogYV9zdWJzZXRzLFxuXHRcdH0gPSB0aGlzO1xuXG5cdFx0Ly8gaG93IG1hbnkgc3Vic2V0cyB0byBwcm9jZXNzXG5cdFx0bGV0IG5sX3N1YnNldHMgPSBhX3N1YnNldHMubGVuZ3RoO1xuXG5cdFx0Ly8gcHJlcGFyZSB0byBkZWFsIHdpdGggcmVzdWx0c1xuXHRcdGxldCBrX2FjdGlvbiA9IG5ldyBhY3RpdmVfZ3JvdXAoa19ncm91cCwgbmxfc3Vic2V0cyk7XG5cblx0XHQvLyBjcmVhdGUgbWFuaWZlc3Qgb2JqZWN0XG5cdFx0bGV0IGtfbWFuaWZlc3QgPSBtYW5pZmVzdC5mcm9tKHpfYXJncyk7XG5cblx0XHQvLyBzdW1tb24gd29ya2VycyBhcyB0aGV5IGJlY29tZSBhdmFpbGFibGVcblx0XHRrX2dyb3VwLnN1bW1vbl93b3JrZXJzKG5sX3N1YnNldHMsIChrX3dvcmtlciwgaV9zdWJzZXQpID0+IHtcblx0XHRcdC8vIGlmKGhfZGlzcGF0Y2guZGVidWcpIGRlYnVnZ2VyO1xuXG5cdFx0XHQvLyByZXN1bHQgaGFuZGxlciB3YXMgbm90IHVzZWQ7IGF1dG8tZW5kIGl0XG5cdFx0XHRpZiAoIWtfYWN0aW9uLnBpcGVkKSBrX2FjdGlvbi5lbmQoKTtcblxuXHRcdFx0Ly8gbWFrZSByZXN1bHQgaGFuZGxlclxuXHRcdFx0bGV0IGZrX3Jlc3VsdCA9IGtfYWN0aW9uLm1rX3Jlc3VsdChrX3dvcmtlciwgaV9zdWJzZXQpO1xuXG5cdFx0XHQvLyBtYWtlIHdvcmtlci1zcGVjaWZpYyBldmVudHNcblx0XHRcdGxldCBoX2V2ZW50c193b3JrZXIgPSB0aGlzLmV2ZW50X3JvdXRlcihoX2V2ZW50c19tYXAsIGlfc3Vic2V0KTtcblxuXHRcdFx0Ly8gcHVzaCBzdWJzZXQgdG8gZnJvbnQgb2YgYXJnc1xuXHRcdFx0bGV0IGtfbWFuaWZlc3Rfd29ya2VyID0ga19tYW5pZmVzdC5wcmVwZW5kKGFfc3Vic2V0c1tpX3N1YnNldF0pO1xuXG5cdFx0XHQvLyBleGVjdXRlIHdvcmtlciBvbiBuZXh0IHBhcnQgb2YgZGF0YVxuXHRcdFx0a193b3JrZXIuZXhlYyh7XG5cdFx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHRcdFx0bWFuaWZlc3Q6IGtfbWFuaWZlc3Rfd29ya2VyLFxuXHRcdFx0XHRob2xkOiBrX2FjdGlvbi51cHN0cmVhbV9ob2xkLFxuXHRcdFx0XHRldmVudHM6IGhfZXZlbnRzX3dvcmtlcixcblx0XHRcdH0sIGZrX3Jlc3VsdCk7XG5cdFx0fSk7XG5cblx0XHQvLyBsZXQgdXNlciBiaW5kIGEgaGFuZGxlclxuXHRcdHJldHVybiBrX2FjdGlvbjtcblx0fVxuXG5cdGV2ZW50X3JvdXRlcihoX2V2ZW50cywgaV9zdWJzZXQpIHtcblx0XHRpZiAoIWhfZXZlbnRzKSByZXR1cm4gbnVsbDtcblxuXHRcdC8vIG1ha2UgYSBuZXcgaGFzaCB0aGF0IHB1c2hlcyB3b3JrZXIgaW5kZXggaW4gZnJvbnQgb2YgY2FsbGJhY2sgYXJnc1xuXHRcdGxldCBoX2V2ZW50c19sb2NhbCA9IHt9O1xuXHRcdGZvciAobGV0IHNfZXZlbnQgaW4gaF9ldmVudHMpIHtcblx0XHRcdGxldCBmX2V2ZW50ID0gaF9ldmVudHNbc19ldmVudF07XG5cdFx0XHRoX2V2ZW50c19sb2NhbFtzX2V2ZW50XSA9ICguLi5hX2FyZ3MpID0+IHtcblx0XHRcdFx0Zl9ldmVudChpX3N1YnNldCwgLi4uYV9hcmdzKTtcblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGhfZXZlbnRzX2xvY2FsO1xuXHR9XG59XG5cblxuY2xhc3MgYWN0aXZlX2dyb3VwIHtcblx0Y29uc3RydWN0b3Ioa19ncm91cCwgbl90YXNrcywgZl9wdXNoID0gbnVsbCkge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0Z3JvdXA6IGtfZ3JvdXAsXG5cdFx0XHR0YXNrX2NvdW50OiBuX3Rhc2tzLFxuXG5cdFx0XHQvLyB3aGV0aGVyIG9yIG5vdCB0aGUgdXNlciBoYXMgcm91dGVkIHRoaXMgc3RyZWFtIHlldFxuXHRcdFx0cGlwZWQ6IGZhbHNlLFxuXG5cdFx0XHQvLyBsaW5rIHRvIG5leHQgYWN0aW9uIGRvd25zdHJlYW1cblx0XHRcdGRvd25zdHJlYW06IG51bGwsXG5cblx0XHRcdC8vIHdoZXRoZXIgb3Igbm90IHRoZSBhY3Rpb24gdXBzdHJlYW0gc2hvdWxkIGhvbGQgZGF0YSBpbiB3b3JrZXJcblx0XHRcdHVwc3RyZWFtX2hvbGQ6IGZhbHNlLFxuXG5cdFx0XHRyZXN1bHRfY291bnQ6IDAsXG5cblx0XHRcdHJlc3VsdF9jYWxsYmFjazogbnVsbCxcblx0XHRcdGNvbXBsZXRlX2NhbGxiYWNrOiBudWxsLFxuXG5cdFx0XHRwdXNoOiBmX3B1c2ggfHwgKCgpID0+IHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBjYW5ub3QgJy5wdXNoKCknIGhlcmVgKTtcblx0XHRcdH0pLFxuXHRcdFx0Y2Fycnk6IG51bGwsXG5cblx0XHRcdHJlZHVjdGlvbnM6IG51bGwsXG5cdFx0XHRyZWR1Y2VfdGFzazogbnVsbCxcblxuXHRcdFx0cmVzdWx0czogbnVsbCxcblx0XHRcdHNlcXVlbmNlX2luZGV4OiAwLFxuXHRcdH0pO1xuXHR9XG5cblx0dGhydShzX3Rhc2ssIHpfYXJncyA9IFtdLCBoX2V2ZW50cyA9IG51bGwpIHtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdHBpcGVkOiB0cnVlLFxuXHRcdFx0cm91dGU6IHRoaXMucm91dGVfdGhydSxcblx0XHRcdHVwc3RyZWFtX2hvbGQ6IHRydWUsXG5cdFx0XHRuZXh0X3Rhc2s6IHtcblx0XHRcdFx0dGFzazogc190YXNrLFxuXHRcdFx0XHRtYW5pZmVzdDogbWFuaWZlc3QuZnJvbSh6X2FyZ3MpLFxuXHRcdFx0XHRldmVudHM6IGhfZXZlbnRzLFxuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdHJldHVybiB0aGlzLmNvbXBsZXRhYmxlKCk7XG5cdH1cblxuXHRlYWNoKGZrX3Jlc3VsdCwgZmtfY29tcGxldGUgPSBudWxsKSB7XG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRwaXBlZDogdHJ1ZSxcblx0XHRcdHJvdXRlOiB0aGlzLnJvdXRlX2VhY2gsXG5cdFx0XHRyZXN1bHRfY2FsbGJhY2s6IGZrX3Jlc3VsdCxcblx0XHRcdGNvbXBsZXRlX2NhbGxiYWNrOiBma19jb21wbGV0ZSxcblx0XHR9KTtcblxuXHRcdHJldHVybiB0aGlzLmNvbXBsZXRhYmxlKCk7XG5cdH1cblxuXHRzZXJpZXMoZmtfcmVzdWx0LCBma19jb21wbGV0ZSA9IG51bGwpIHtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdHBpcGVkOiB0cnVlLFxuXHRcdFx0cm91dGU6IHRoaXMucm91dGVfc2VyaWVzLFxuXHRcdFx0cmVzdWx0X2NhbGxiYWNrOiBma19yZXN1bHQsXG5cdFx0XHRjb21wbGV0ZV9jYWxsYmFjazogZmtfY29tcGxldGUsXG5cdFx0XHRyZXN1bHRzOiBuZXcgQXJyYXkodGhpcy50YXNrX2NvdW50KSxcblx0XHR9KTtcblxuXHRcdHJldHVybiB0aGlzLmNvbXBsZXRhYmxlKCk7XG5cdH1cblxuXHRyZWR1Y2Uoc190YXNrLCB6X2FyZ3MgPSBbXSwgaF9ldmVudHMgPSBudWxsKSB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChmX3Jlc29sdmUpID0+IHtcblx0XHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0XHRwaXBlZDogdHJ1ZSxcblx0XHRcdFx0cm91dGU6IHRoaXMucm91dGVfcmVkdWNlLFxuXHRcdFx0XHRjb21wbGV0ZV9jYWxsYmFjazogZl9yZXNvbHZlLFxuXHRcdFx0XHR1cHN0cmVhbV9ob2xkOiB0aGlzLnRhc2tfY291bnQgPiAxLCAvLyBzZXQgYGhvbGRgIGZsYWcgZm9yIHVwc3RyZWFtIHNlbmRpbmcgaXRzIHRhc2tcblx0XHRcdFx0cmVkdWN0aW9uczogbmV3IGNvbnZlcmdlbnRfcGFpcndpc2VfdHJlZSh0aGlzLnRhc2tfY291bnQpLFxuXHRcdFx0XHRyZWR1Y2VfdGFzazoge1xuXHRcdFx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHRcdFx0XHRtYW5pZmVzdDogbmV3IG1hbmlmZXN0KHpfYXJncyksXG5cdFx0XHRcdFx0ZXZlbnRzOiBoX2V2ZW50cyxcblx0XHRcdFx0XHRob2xkOiB0cnVlLCAvLyBhc3N1bWUgYW5vdGhlciByZWR1Y3Rpb24gd2lsbCBiZSBwZXJmb3JtZWQgYnkgZGVmYXVsdFxuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH1cblxuXHQvLyByZXN1bHRzIG5vdCBoYW5kbGVkXG5cdHJvdXRlKCkge1xuXHRcdGNvbnNvbGUud2FybigncmVzdWx0IGZyb20gd29ya2VyIHdhcyBub3QgaGFuZGxlZCEgbWFrZSBzdXJlIHRvIGJpbmQgYSBoYW5kbGVyIGJlZm9yZSBnb2luZyBhc3luYy4gdXNlIGAuaWdub3JlKClgIGlmIHlvdSBkbyBub3QgY2FyZSBhYm91dCB0aGUgcmVzdWx0Jyk7XG5cdH1cblxuXHRyb3V0ZV90aHJ1KGhwX25vdGlmaWNhdGlvbiwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spIHtcblx0XHQvLyBjcmVhdGUgc3BlY2lmaWMgdGFzayBmb3Igd29ya2VyIHRvIHJlY2VpdmUgZGF0YSBmcm9tIGl0cyBwcmV2aW91cyB0YXNrXG5cdFx0bGV0IGhfdGFzayA9IE9iamVjdC5hc3NpZ24oe1xuXHRcdFx0cmVjZWl2ZTogaV90YXNrLFxuXHRcdFx0aG9sZDogdGhpcy5kb3duc3RyZWFtLnVwc3RyZWFtX2hvbGQsXG5cdFx0fSwgdGhpcy5uZXh0X3Rhc2spO1xuXG5cdFx0Ly8gYXNzaWduIHdvcmtlciBuZXcgdGFza1xuXHRcdHRoaXMuZ3JvdXAuYXNzaWduX3dvcmtlcihrX3dvcmtlciwgaF90YXNrLCAoLi4uYV9hcmdzKSA9PiB7XG5cdFx0XHQvLyBtayByZXN1bHRcblx0XHRcdGxldCBmX3Jlc3VsdCA9IHRoaXMuZG93bnN0cmVhbS5ta19yZXN1bHQoa193b3JrZXIsIGlfc3Vic2V0KTtcblxuXHRcdFx0Ly8gdHJpZ2dlciByZXN1bHRcblx0XHRcdGZfcmVzdWx0KC4uLmFfYXJncyk7XG5cdFx0fSk7XG5cdH1cblxuXHQvLyByZXR1cm4gcmVzdWx0cyBpbW1lZGlhdGVseVxuXHRyb3V0ZV9lYWNoKHpfcmVzdWx0LCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzaykge1xuXHRcdHRoaXMuaGFuZGxlX3Jlc3VsdF9jYWxsYmFjayh6X3Jlc3VsdCwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spO1xuXG5cdFx0Ly8gdGhpcyB3YXMgdGhlIGxhc3QgcmVzdWx0XG5cdFx0aWYgKCsrdGhpcy5yZXN1bHRfY291bnQgPT09IHRoaXMudGFza19jb3VudCAmJiAnZnVuY3Rpb24nID09PSB0eXBlb2YgdGhpcy5jb21wbGV0ZV9jYWxsYmFjaykge1xuXHRcdFx0dGhpcy5jb21wbGV0ZV9jYWxsYmFjaygpO1xuXHRcdH1cblx0fVxuXG5cdHJvdXRlX3Nlcmllcyh6X3Jlc3VsdCwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spIHtcblx0XHRsZXQge1xuXHRcdFx0dGFza19jb3VudDogbl90YXNrcyxcblx0XHRcdHJlc3VsdF9jYWxsYmFjazogZmtfcmVzdWx0LFxuXHRcdFx0c2VxdWVuY2VfaW5kZXg6IGlfc2VxdWVuY2UsXG5cdFx0XHRyZXN1bHRzOiBhX3Jlc3VsdHMsXG5cdFx0fSA9IHRoaXM7XG5cblx0XHQvLyByZXN1bHQgYXJyaXZlZCB3aGlsZSB3ZSB3ZXJlIHdhaXRpbmcgZm9yIGl0XG5cdFx0aWYgKGlfc3Vic2V0ID09PSBpX3NlcXVlbmNlKSB7XG5cdFx0XHQvLyB3aGlsZSB0aGVyZSBhcmUgcmVzdWx0cyB0byBwcm9jZXNzXG5cdFx0XHRmb3IgKDs7KSB7XG5cdFx0XHRcdC8vIHByb2Nlc3MgcmVzdWx0XG5cdFx0XHRcdHRoaXMuaGFuZGxlX3Jlc3VsdF9jYWxsYmFjayh6X3Jlc3VsdCwgaV9zZXF1ZW5jZSwga193b3JrZXIsIGlfdGFzayk7XG5cblx0XHRcdFx0Ly8gcmVhY2hlZCBlbmQgb2Ygc2VxdWVuY2U7IHRoYXQgd2FzIGxhc3QgcmVzdWx0XG5cdFx0XHRcdGlmICgrK2lfc2VxdWVuY2UgPT09IG5fdGFza3MpIHtcblx0XHRcdFx0XHQvLyBjb21wbGV0aW9uIGNhbGxiYWNrXG5cdFx0XHRcdFx0aWYgKCdmdW5jdGlvbicgPT09IHR5cGVvZiB0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKSB7XG5cdFx0XHRcdFx0XHR0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKCk7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gZXhpdCBsb29wIGFuZCBzYXZlIHNlcXVlbmNlIGluZGV4XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBuZXh0IHJlc3VsdCBub3QgeWV0IHJlYWR5XG5cdFx0XHRcdGxldCBoX25leHRfcmVzdWx0ID0gYV9yZXN1bHRzW2lfc2VxdWVuY2VdO1xuXHRcdFx0XHRpZiAoIWhfbmV4dF9yZXN1bHQpIGJyZWFrO1xuXG5cdFx0XHRcdC8vIGVsc2U7IG9udG8gbmV4dCByZXN1bHRcblx0XHRcdFx0el9yZXN1bHQgPSBoX25leHRfcmVzdWx0O1xuXG5cdFx0XHRcdC8vIHJlbGVhc2UgdG8gZ2Ncblx0XHRcdFx0YV9yZXN1bHRzW2lfc2VxdWVuY2VdID0gbnVsbDtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gbm90IHlldCByZWFkeSB0byBwcm9jZXNzIHRoaXMgcmVzdWx0XG5cdFx0ZWxzZSB7XG5cdFx0XHQvLyBzdG9yZSBpdCBmb3Igbm93XG5cdFx0XHRhX3Jlc3VsdHNbaV9zdWJzZXRdID0gel9yZXN1bHQ7XG5cdFx0fVxuXG5cdFx0Ly8gdXBkYXRlIHNlcXVlbmNlIGluZGV4XG5cdFx0dGhpcy5zZXF1ZW5jZV9pbmRleCA9IGlfc2VxdWVuY2U7XG5cdH1cblxuXHRyb3V0ZV9yZWR1Y2UoaHBfbm90aWZpY2F0aW9uLCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzaykge1xuXHRcdC8vIGRlYnVnZ2VyO1xuXG5cdFx0Ly8gbm9kZSBpbml0aWF0aW9uXG5cdFx0bGV0IGhfY2Fub3B5X25vZGUgPSB0aGlzLnJlZHVjdGlvbnMucmF5KGlfc3Vic2V0LCB7XG5cdFx0XHR3b3JrZXI6IGtfd29ya2VyLFxuXHRcdFx0dGFza19pZDogaV90YXNrLFxuXHRcdH0pO1xuXG5cdFx0Ly8gc3RhcnQgYXQgY2Fub3B5IG5vZGVcblx0XHR0aGlzLnJlZHVjZV9yZXN1bHQoaHBfbm90aWZpY2F0aW9uLCBoX2Nhbm9weV9ub2RlKTtcblx0fVxuXG5cdC8vIGVhY2ggdGltZSBhIHdvcmtlciBjb21wbGV0ZXNcblx0cmVkdWNlX3Jlc3VsdCh6X3Jlc3VsdCwgaF9ub2RlKSB7XG5cdFx0bGV0IHtcblx0XHRcdGdyb3VwOiBrX2dyb3VwLFxuXHRcdFx0cmVkdWN0aW9uczoga19wYWlyd2lzZV90cmVlLFxuXHRcdFx0cmVkdWNlX3Rhc2s6IGhfdGFza19yZWFkeSxcblx0XHR9ID0gdGhpcztcblxuXHRcdC8vIGZpbmFsIHJlc3VsdFxuXHRcdGlmIChIUF9XT1JLRVJfTk9USUZJQ0FUSU9OICE9PSB6X3Jlc3VsdCkge1xuXHRcdFx0bGV0IHpfY29tcGxldGlvbiA9IHRoaXMuY29tcGxldGVfY2FsbGJhY2soel9yZXN1bHQpO1xuXG5cdFx0XHQvLyBhZGQgdG8gb3V0ZXIgc3RyZWFtXG5cdFx0XHRpZiAoel9jb21wbGV0aW9uIGluc3RhbmNlb2YgYWN0aXZlX2dyb3VwKSB7XG5cdFx0XHRcdGxldCBrX2xha2UgPSB0aGlzLmxha2UoKTtcblx0XHRcdFx0bGV0IGZrX2xha2UgPSBrX2xha2UuY29tcGxldGVfY2FsbGJhY2s7XG5cdFx0XHRcdGxldCBocF9sb2NrID0gU3ltYm9sKCdrZXknKTtcblxuXHRcdFx0XHR6X2NvbXBsZXRpb24uZW5kKCgpID0+IHtcblx0XHRcdFx0XHRrX2dyb3VwLnVubG9jayhocF9sb2NrKTtcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0Ly8gcmV3cmFwIGNvbXBsZXRpb24gY2FsbGJhY2sgZnVuY3Rpb25cblx0XHRcdFx0a19sYWtlLmNvbXBsZXRlX2NhbGxiYWNrID0gKCkgPT4ge1xuXHRcdFx0XHRcdGtfZ3JvdXAud2FpdChocF9sb2NrLCAoKSA9PiB7XG5cdFx0XHRcdFx0XHRma19sYWtlKCk7XG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIG5vdGlmaWNhdGlvblxuXHRcdGVsc2Uge1xuXHRcdFx0Ly8gYWJsZSB0byBwZXJmb3JtIGEgcmVkdWN0aW9uXG5cdFx0XHRsZXQgaF9tZXJnZSA9IGtfcGFpcndpc2VfdHJlZS5jb21taXQoaF9ub2RlKTtcblx0XHRcdGlmIChoX21lcmdlKSB7XG5cdFx0XHRcdGxldCBrX3dvcmtlciA9IGhfbm9kZS5pdGVtLndvcmtlcjtcblxuXHRcdFx0XHQvLyB0aGlzIHJlZHVjdGlvbiB3aWxsIGJlIHRoZSBsYXN0IG9uZTsgZG8gbm90IGhvbGQgcmVzdWx0XG5cdFx0XHRcdGlmIChoX21lcmdlLm1ha2VzX3Jvb3QpIHtcblx0XHRcdFx0XHRoX3Rhc2tfcmVhZHkgPSBPYmplY3QuYXNzaWduKHt9LCBoX3Rhc2tfcmVhZHkpO1xuXHRcdFx0XHRcdGhfdGFza19yZWFkeS5ob2xkID0gZmFsc2U7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBhZnRlciByZWR1Y3Rpb247XG5cdFx0XHRcdGxldCBma19yZWR1Y3Rpb24gPSAoel9yZXN1bHRfcmVkdWN0aW9uLCBpX3Rhc2tfcmVkdWN0aW9uLCBrX3dvcmtlcl9yZWR1Y3Rpb24pID0+IHtcblx0XHRcdFx0XHQvLyByZWN1cnNlIG9uIHJlZHVjdGlvbjsgdXBkYXRlIHNlbmRlciBmb3IgY2FsbGJhY2sgc2NvcGVcblx0XHRcdFx0XHR0aGlzLnJlZHVjZV9yZXN1bHQoel9yZXN1bHRfcmVkdWN0aW9uLCBPYmplY3QuYXNzaWduKGhfbWVyZ2Uubm9kZSwge1xuXHRcdFx0XHRcdFx0aXRlbToge1xuXHRcdFx0XHRcdFx0XHR3b3JrZXI6IGtfd29ya2VyX3JlZHVjdGlvbixcblx0XHRcdFx0XHRcdFx0dGFza19pZDogaV90YXNrX3JlZHVjdGlvbixcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0fSkpO1xuXHRcdFx0XHR9O1xuXG5cdFx0XHRcdC8vIGdpdmUgcmVkdWN0aW9uIHRhc2sgdG8gd29ya2VyIHRoYXQgZmluaXNoZWQgZWFybGllcjsgcGFzcyB0byB0aGUgcmlnaHRcblx0XHRcdFx0aWYgKGtfd29ya2VyID09PSBoX21lcmdlLmxlZnQud29ya2VyKSB7XG5cdFx0XHRcdFx0a19ncm91cC5yZWxheSh7XG5cdFx0XHRcdFx0XHRzZW5kZXI6IGhfbm9kZS5pdGVtLFxuXHRcdFx0XHRcdFx0cmVjZWl2ZXI6IGhfbWVyZ2UucmlnaHQsXG5cdFx0XHRcdFx0XHRyZWNlaXZlcl9wcmltYXJ5OiBmYWxzZSxcblx0XHRcdFx0XHRcdHRhc2tfcmVhZHk6IGhfdGFza19yZWFkeSxcblx0XHRcdFx0XHR9LCBma19yZWR1Y3Rpb24pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIHBhc3MgdG8gdGhlIGxlZnRcblx0XHRcdFx0ZWxzZSB7XG5cdFx0XHRcdFx0a19ncm91cC5yZWxheSh7XG5cdFx0XHRcdFx0XHRzZW5kZXI6IGhfbm9kZS5pdGVtLFxuXHRcdFx0XHRcdFx0cmVjZWl2ZXI6IGhfbWVyZ2UubGVmdCxcblx0XHRcdFx0XHRcdHJlY2VpdmVyX3ByaW1hcnk6IHRydWUsXG5cdFx0XHRcdFx0XHR0YXNrX3JlYWR5OiBoX3Rhc2tfcmVhZHksXG5cdFx0XHRcdFx0fSwgZmtfcmVkdWN0aW9uKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHJvdXRlX2VuZCgpIHtcblx0XHQvLyB0aGlzIHdhcyB0aGUgbGFzdCByZXN1bHRcblx0XHRpZiAoKyt0aGlzLnJlc3VsdF9jb3VudCA9PT0gdGhpcy50YXNrX2NvdW50ICYmICdmdW5jdGlvbicgPT09IHR5cGVvZiB0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKSB7XG5cdFx0XHR0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKCk7XG5cdFx0fVxuXHR9XG5cblx0Y29tcGxldGFibGUoKSB7XG5cdFx0bGV0IGZrX2NvbXBsZXRlID0gdGhpcy5jb21wbGV0ZV9jYWxsYmFjaztcblxuXHRcdC8vIG5vdGhpbmcgdG8gcmVkdWNlOyBjb21wbGV0ZSBhZnRlciBlc3RhYmxpc2hpbmcgZG93bnN0cmVhbVxuXHRcdGlmICghdGhpcy50YXNrX2NvdW50ICYmICdmdW5jdGlvbicgPT09IHR5cGVvZiBma19jb21wbGV0ZSkge1xuXHRcdFx0c2V0VGltZW91dChma19jb21wbGV0ZSwgMCk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHRoaXMuZG93bnN0cmVhbSA9IG5ldyBhY3RpdmVfZ3JvdXAodGhpcy5ncm91cCwgdGhpcy50YXNrX2NvdW50LCB0aGlzLnB1c2gpO1xuXHR9XG5cblx0aGFuZGxlX3Jlc3VsdF9jYWxsYmFjayh6X3Jlc3VsdCwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spIHtcblx0XHRsZXQga19kb3duc3RyZWFtID0gdGhpcy5kb3duc3RyZWFtO1xuXG5cdFx0Ly8gYXBwbHkgY2FsbGJhY2sgYW5kIGNhcHR1cmUgcmV0dXJuXG5cdFx0bGV0IHpfcmV0dXJuID0gdGhpcy5yZXN1bHRfY2FsbGJhY2soel9yZXN1bHQsIGlfc3Vic2V0KTtcblxuXHRcdC8vIGRvd25zdHJlYW0gaXMgZXhwZWN0aW5nIGRhdGEgZm9yIG5leHQgdGFza1xuXHRcdGlmIChrX2Rvd25zdHJlYW0gJiYga19kb3duc3RyZWFtLnBpcGVkKSB7XG5cdFx0XHQvLyBub3RoaW5nIHdhcyByZXR1cm5lZDsgcmV1c2UgaW5wdXQgZGF0YVxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gel9yZXR1cm4pIHtcblx0XHRcdFx0Ly8gZG93bnN0cmVhbSBhY3Rpb24gd2FzIGV4cGVjdGluZyB3b3JrZXIgdG8gaG9sZCBkYXRhXG5cdFx0XHRcdGlmIChrX2Rvd25zdHJlYW0udXBzdHJlYW1faG9sZCkge1xuXHRcdFx0XHRcdHRocm93ICdub3QgeWV0IGltcGxlbWVudGVkJztcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRrX2Rvd25zdHJlYW0ucm91dGUoel9yZXN1bHQsIGlfc3Vic2V0LCBrX3dvcmtlciwgaV90YXNrKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0Ly8gcmV0dXJuZWQgcHJvbWlzZVxuXHRcdFx0ZWxzZSBpZiAoel9yZXR1cm4gaW5zdGFuY2VvZiBQcm9taXNlKSB7XG5cdFx0XHRcdHpfcmV0dXJuXG5cdFx0XHRcdFx0Ly8gYXdhaXQgcHJvbWlzZSByZXNvbHZlXG5cdFx0XHRcdFx0LnRoZW4oKHpfY2FycnkpID0+IHtcblx0XHRcdFx0XHRcdGtfZG93bnN0cmVhbS5yb3V0ZSh6X2NhcnJ5LCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzayk7XG5cdFx0XHRcdFx0fSlcblx0XHRcdFx0XHQvLyBjYXRjaCBwcm9taXNlIHJlamVjdFxuXHRcdFx0XHRcdC5jYXRjaCgoZV9yZWplY3QpID0+IHtcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcigndW5jYXVnaHQgcmVqZWN0aW9uJyk7XG5cdFx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0XHQvLyByZXR1cm5lZCBlcnJvclxuXHRcdFx0ZWxzZSBpZiAoel9yZXR1cm4gaW5zdGFuY2VvZiBFcnJvcikge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ25vdCB5ZXQgaW1wbGVtZW50ZWQnKTtcblx0XHRcdH1cblx0XHRcdC8vIHJldHVybmVkIGltbWVkaWF0ZWx5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0a19kb3duc3RyZWFtLnJvdXRlKHpfcmV0dXJuLCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzayk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIHNvbWV0aGluZyB3YXMgcmV0dXJuZWQgdGhvdWdoXG5cdFx0ZWxzZSBpZiAodW5kZWZpbmVkICE9PSB6X3JldHVybikge1xuXHRcdFx0Y29uc29sZS53YXJuKCdhIHRhc2sgc3RyZWFtIGhhbmRsZXIgcmV0dXJuIHNvbWUgdmFsdWUgYnV0IGl0IGNhbm5vdCBiZSBjYXJyaWVkIGJlY2F1c2UgZG93bnN0cmVhbSBpcyBub3QgZXhwZWN0aW5nIHRhc2sgZGF0YScpO1xuXHRcdFx0ZGVidWdnZXI7XG5cdFx0fVxuXHR9XG5cblx0ZW5kKGZrX2NvbXBsZXRlID0gbnVsbCkge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0cGlwZWQ6IHRydWUsXG5cdFx0XHRyb3V0ZTogdGhpcy5yb3V0ZV9lbmQsXG5cdFx0XHRjb21wbGV0ZV9jYWxsYmFjazogZmtfY29tcGxldGUsXG5cdFx0fSk7XG5cdH1cblxuXG5cdG1rX3Jlc3VsdChrX3dvcmtlciwgaV9zdWJzZXQpIHtcblx0XHQvLyBmb3Igd2hlbiBhIHJlc3VsdCBhcnJpdmVzXG5cdFx0cmV0dXJuICh6X3Jlc3VsdCwgaV90YXNrKSA9PiB7XG5cdFx0XHQvLyB0aGlzIHdvcmtlciBqdXN0IG1hZGUgaXRzZWxmIGF2YWlsYWJsZVxuXHRcdFx0dGhpcy5ncm91cC53b3JrZXJfYXZhaWxhYmxlKGtfd29ya2VyKTtcblxuXHRcdFx0Ly8gcm91dGUgdGhlIHJlc3VsdFxuXHRcdFx0dGhpcy5yb3V0ZSh6X3Jlc3VsdCwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spO1xuXHRcdH07XG5cdH1cblxuXHQvLyB0cmF2ZXJzZSBhbGwgdGhlIHdheSBkb3duc3RyZWFtXG5cdGxha2UoKSB7XG5cdFx0bGV0IGtfZG93bnN0cmVhbSA9IHRoaXM7XG5cdFx0Zm9yICg7Oykge1xuXHRcdFx0aWYgKGtfZG93bnN0cmVhbS5kb3duc3RyZWFtKSBrX2Rvd25zdHJlYW0gPSBrX2Rvd25zdHJlYW0uZG93bnN0cmVhbTtcblx0XHRcdGVsc2UgYnJlYWs7XG5cdFx0fVxuXHRcdHJldHVybiBrX2Rvd25zdHJlYW07XG5cdH1cbn1cblxuXG5mdW5jdGlvbiBkaXZpZGUoYV90aGluZ3MsIG5fd29ya2VycywgeG1fc3RyYXRlZ3ksIGhfZGl2aWRlID0ge30pIHtcblx0bGV0IG5sX3RoaW5ncyA9IGFfdGhpbmdzLmxlbmd0aDtcblxuXHRsZXQge1xuXHRcdGl0ZW1fY291bnQ6IGNfaXRlbXNfcmVtYWluID0gbmxfdGhpbmdzLFxuXHRcdG9wZW46IGZfb3BlbiA9IG51bGwsXG5cdFx0c2VhbDogZl9zZWFsID0gbnVsbCxcblx0XHRxdWFudGlmeTogZl9xdWFudGlmeSA9ICgpID0+IHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihgbXVzdCBwcm92aWRlIGZ1bmN0aW9uIGZvciBrZXkgJ3F1YW50aWZ5JyB3aGVuIHVzaW5nICcuYmFsYW5jZV9vcmRlcmVkX2dyb3VwcygpJ2ApO1xuXHRcdH0sXG5cdH0gPSBoX2RpdmlkZTtcblxuXHRsZXQgYV90YXNrcyA9IFtdO1xuXG5cdGlmIChBcnJheS5pc0FycmF5KGFfdGhpbmdzKSkge1xuXHRcdC8vIGRvIG5vdCBhc3NpZ24gd29ya2VycyB0byBub3RoaW5nXG5cdFx0aWYgKG5sX3RoaW5ncyA8IG5fd29ya2Vycykgbl93b3JrZXJzID0gbmxfdGhpbmdzO1xuXG5cdFx0Ly8gaXRlbXMgcGVyIHdvcmtlclxuXHRcdGxldCB4X2l0ZW1zX3Blcl93b3JrZXIgPSBNYXRoLmZsb29yKGNfaXRlbXNfcmVtYWluIC8gbl93b3JrZXJzKTtcblxuXHRcdC8vIGRpc3RyaWJ1dGUgaXRlbXMgZXF1YWxseVxuXHRcdGlmIChYTV9TVFJBVEVHWV9FUVVBTCA9PT0geG1fc3RyYXRlZ3kpIHtcblx0XHRcdC8vIHN0YXJ0IGluZGV4IG9mIHNsaWNlXG5cdFx0XHRsZXQgaV9zdGFydCA9IDA7XG5cblx0XHRcdC8vIGVhY2ggd29ya2VyXG5cdFx0XHRmb3IgKGxldCBpX3dvcmtlciA9IDA7IGlfd29ya2VyIDwgbl93b3JrZXJzOyBpX3dvcmtlcisrKSB7XG5cdFx0XHRcdC8vIGZpbmQgZW5kIGluZGV4IG9mIHdvcmtlcjsgZW5zdXJlIGFsbCBpdGVtcyBmaW5kIGEgd29ya2VyXG5cdFx0XHRcdGxldCBpX2VuZCA9IChpX3dvcmtlciA9PT0gbl93b3JrZXJzIC0gMSkgPyBubF90aGluZ3MgOiBpX3N0YXJ0ICsgeF9pdGVtc19wZXJfd29ya2VyO1xuXG5cdFx0XHRcdC8vIGV4dHJhY3Qgc2xpY2UgZnJvbSB0aGluZ3MgYW5kIHB1c2ggdG8gZGl2aXNpb25zXG5cdFx0XHRcdGFfdGFza3MucHVzaChhX3RoaW5ncy5zbGljZShpX3N0YXJ0LCBpX2VuZCkpO1xuXG5cdFx0XHRcdC8vIGFkdmFuY2UgaW5kZXggZm9yIG5leHQgZGl2aXNpb25cblx0XHRcdFx0aV9zdGFydCA9IGlfZW5kO1xuXG5cdFx0XHRcdC8vIHVwZGF0ZSBudW1iZXIgb2YgaXRlbXMgcmVtYWluaW5nXG5cdFx0XHRcdGNfaXRlbXNfcmVtYWluIC09IHhfaXRlbXNfcGVyX3dvcmtlcjtcblxuXHRcdFx0XHQvLyByZWNhbGN1bGF0ZSB0YXJnZXQgaXRlbXMgcGVyIHdvcmtlclxuXHRcdFx0XHR4X2l0ZW1zX3Blcl93b3JrZXIgPSBNYXRoLmZsb29yKGNfaXRlbXNfcmVtYWluIC8gKG5fd29ya2VycyAtIGlfd29ya2VyIC0gMSkpO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBvcmRlcmVkIGdyb3Vwc1xuXHRcdGVsc2UgaWYgKFhNX1NUUkFURUdZX09SREVSRURfR1JPVVBTICYgeG1fc3RyYXRlZ3kpIHtcblx0XHRcdGxldCBpX3dvcmtlciA9IDA7XG5cdFx0XHRsZXQgY193b3JrZXJfaXRlbXMgPSAwO1xuXG5cdFx0XHQvLyBvcGVuIG5ldyB0YXNrIGl0ZW0gbGlzdFxuXHRcdFx0bGV0IGFfdGFza19pdGVtcyA9IFtdO1xuXHRcdFx0bGV0IHpfdGFza19kYXRhID0gZl9vcGVuID8gZl9vcGVuKGFfdGFza19pdGVtcykgOiBhX3Rhc2tfaXRlbXM7XG5cblx0XHRcdC8vIGVhY2ggZ3JvdXBcblx0XHRcdGZvciAobGV0IGlfZ3JvdXAgPSAwOyBpX2dyb3VwIDwgbmxfdGhpbmdzOyBpX2dyb3VwKyspIHtcblx0XHRcdFx0bGV0IGhfZ3JvdXAgPSBhX3RoaW5nc1tpX2dyb3VwXTtcblx0XHRcdFx0bGV0IG5fZ3JvdXBfaXRlbXMgPSBmX3F1YW50aWZ5KGhfZ3JvdXApO1xuXG5cdFx0XHRcdC8vIGFkZGluZyB0aGlzIHRvIGN1cnJlbnQgd29ya2VyIHdvdWxkIGV4Y2VlZCB0YXJnZXQgbG9hZCAobWFrZSBzdXJlIHRoaXMgaXNuJ3QgZmluYWwgd29ya2VyKVxuXHRcdFx0XHRsZXQgbl93b3JrZXJfaXRlbXNfcHJldmlldyA9IG5fZ3JvdXBfaXRlbXMgKyBjX3dvcmtlcl9pdGVtcztcblx0XHRcdFx0aWYgKChuX3dvcmtlcl9pdGVtc19wcmV2aWV3ID4geF9pdGVtc19wZXJfd29ya2VyKSAmJiBpX3dvcmtlciA8IG5fd29ya2VycyAtIDEpIHtcblx0XHRcdFx0XHRsZXQgYl9hZHZhbmNlX2dyb3VwID0gZmFsc2U7XG5cblx0XHRcdFx0XHQvLyBiYWxhbmNlIG1vZGVcblx0XHRcdFx0XHRpZiAoWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQkFMQU5DRUQgPT09IHhtX3N0cmF0ZWd5KSB7XG5cdFx0XHRcdFx0XHQvLyBwcmV2aWV3IGlzIGNsb3NlciB0byB0YXJnZXQ7IGFkZCB0YXNrIGl0ZW0gdG8gd29ya2VyIGJlZm9yZSBhZHZhbmNpbmdcblx0XHRcdFx0XHRcdGlmICgobl93b3JrZXJfaXRlbXNfcHJldmlldyAtIHhfaXRlbXNfcGVyX3dvcmtlcikgPCAoeF9pdGVtc19wZXJfd29ya2VyIC0gY193b3JrZXJfaXRlbXMpKSB7XG5cdFx0XHRcdFx0XHRcdGFfdGFza19pdGVtcy5wdXNoKGhfZ3JvdXApO1xuXHRcdFx0XHRcdFx0XHRjX3dvcmtlcl9pdGVtcyA9IG5fd29ya2VyX2l0ZW1zX3ByZXZpZXc7XG5cblx0XHRcdFx0XHRcdFx0Ly8gYWR2YW5jZSBncm91cCBhZnRlciBuZXcgdGFza1xuXHRcdFx0XHRcdFx0XHRiX2FkdmFuY2VfZ3JvdXAgPSB0cnVlO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdC8vIGFkZCB0YXNrIGl0ZW0gdG8gb3V0cHV0ICh0cmFuc2Zvcm1pbmcgaXQgd2hlbiBhcHByb3ByaWF0ZSlcblx0XHRcdFx0XHRhX3Rhc2tzLnB1c2goZl9zZWFsID8gZl9zZWFsKHpfdGFza19kYXRhKSA6IHpfdGFza19kYXRhKTtcblxuXHRcdFx0XHRcdC8vIG5leHQgdGFzayBpdGVtIGxpc3Rcblx0XHRcdFx0XHRhX3Rhc2tfaXRlbXMgPSBbXTtcblx0XHRcdFx0XHRjX2l0ZW1zX3JlbWFpbiAtPSBjX3dvcmtlcl9pdGVtcztcblx0XHRcdFx0XHR4X2l0ZW1zX3Blcl93b3JrZXIgPSBjX2l0ZW1zX3JlbWFpbiAvIChuX3dvcmtlcnMgLSAoKytpX3dvcmtlcikpO1xuXHRcdFx0XHRcdGNfd29ya2VyX2l0ZW1zID0gMDtcblxuXHRcdFx0XHRcdC8vIHRhc2sgaXRlbSBvcGVuXG5cdFx0XHRcdFx0el90YXNrX2RhdGEgPSBmX29wZW4gPyBmX29wZW4oYV90YXNrX2l0ZW1zKSA6IGFfdGFza19pdGVtcztcblxuXHRcdFx0XHRcdC8vIGFkdmFuY2UgZ3JvdXBcblx0XHRcdFx0XHRpZiAoYl9hZHZhbmNlX2dyb3VwKSBjb250aW51ZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIGFkZCB0YXNrIHRvIGxpc3Rcblx0XHRcdFx0YV90YXNrX2l0ZW1zLnB1c2goaF9ncm91cCk7XG5cdFx0XHRcdGNfd29ya2VyX2l0ZW1zICs9IG5fZ3JvdXBfaXRlbXM7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFkZCBmaW5hbCB0YXNrIGl0ZW1cblx0XHRcdGFfdGFza3MucHVzaChmX3NlYWwgPyBmX3NlYWwoel90YXNrX2RhdGEpIDogel90YXNrX2RhdGEpO1xuXHRcdH1cblx0XHQvLyB1bmtub3duIHN0cmF0ZWd5XG5cdFx0ZWxzZSB7XG5cdFx0XHR0aHJvdyBuZXcgUmFuZ2VFcnJvcignbm8gc3VjaCBzdHJhdGVneScpO1xuXHRcdH1cblx0fVxuXHQvLyB0eXBlZCBhcnJheVxuXHRlbHNlIGlmICgnYnl0ZUxlbmd0aCcgaW4gYV90aGluZ3MpIHtcblx0XHQvLyBkaXZpZGUgXG5cdFx0dGhyb3cgJ25vdCB5ZXQgaW1wbGVtZW50ZWQnO1xuXHR9XG5cdC8vIHVuc3VwcG9ydGVkIHR5cGVcblx0ZWxzZSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKCd3b3JrZXIgY2FuIG9ubHkgZGl2aWRlIGRhdGEgaW4gYXJyYXlzIChlaXRoZXIgcGxhaW4gb3IgdHlwZWQpJyk7XG5cdH1cblxuXHRyZXR1cm4gYV90YXNrcztcbn1cblxuXG5jbGFzcyBjb252ZXJnZW50X3BhaXJ3aXNlX3RyZWUge1xuXHRjb25zdHJ1Y3RvcihuX2l0ZW1zKSB7XG5cdFx0bGV0IGFfY2Fub3B5ID0gW107XG5cdFx0Zm9yIChsZXQgaV9pdGVtID0gMDsgaV9pdGVtIDwgbl9pdGVtczsgaV9pdGVtKyspIHtcblx0XHRcdGFfY2Fub3B5LnB1c2goe1xuXHRcdFx0XHRyZWFkeTogZmFsc2UsXG5cdFx0XHRcdHVwOiBudWxsLFxuXHRcdFx0XHRpdGVtOiBudWxsLFxuXHRcdFx0XHRsZWZ0OiBpX2l0ZW0gLSAxLFxuXHRcdFx0XHRyaWdodDogaV9pdGVtICsgMSxcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0aXRlbV9jb3VudDogbl9pdGVtcyxcblx0XHRcdGNhbm9weTogYV9jYW5vcHksXG5cdFx0fSk7XG5cdH1cblxuXHRyYXkoaV9pdGVtLCB6X2l0ZW0pIHtcblx0XHRsZXQgaF9ub2RlID0gdGhpcy5jYW5vcHlbaV9pdGVtXTtcblx0XHRoX25vZGUuaXRlbSA9IHpfaXRlbTtcblx0XHRyZXR1cm4gaF9ub2RlO1xuXHR9XG5cblx0dG9wKGhfdG9wKSB7XG5cdFx0Zm9yICg7Oykge1xuXHRcdFx0bGV0IGhfdXAgPSBoX3RvcC51cDtcblx0XHRcdGlmIChoX3VwKSBoX3RvcCA9IGhfdXA7XG5cdFx0XHRlbHNlIGJyZWFrO1xuXHRcdH1cblx0XHRyZXR1cm4gaF90b3A7XG5cdH1cblxuXHRtZXJnZShoX2xlZnQsIGhfcmlnaHQpIHtcblx0XHRsZXQgbl9pdGVtcyA9IHRoaXMuaXRlbV9jb3VudDtcblxuXHRcdGxldCBoX25vZGUgPSB7XG5cdFx0XHRyZWFkeTogZmFsc2UsXG5cdFx0XHR1cDogbnVsbCxcblx0XHRcdGl0ZW06IG51bGwsXG5cdFx0XHRsZWZ0OiBoX2xlZnQubGVmdCxcblx0XHRcdHJpZ2h0OiBoX3JpZ2h0LnJpZ2h0LFxuXHRcdH07XG5cblx0XHRoX2xlZnQudXAgPSBoX3JpZ2h0LnVwID0gaF9ub2RlO1xuXG5cdFx0cmV0dXJuIHtcblx0XHRcdG5vZGU6IGhfbm9kZSxcblx0XHRcdGxlZnQ6IGhfbGVmdC5pdGVtLFxuXHRcdFx0cmlnaHQ6IGhfcmlnaHQuaXRlbSxcblx0XHRcdG1ha2VzX3Jvb3Q6IC0xID09PSBoX2xlZnQubGVmdCAmJiBuX2l0ZW1zID09PSBoX3JpZ2h0LnJpZ2h0LFxuXHRcdH07XG5cdH1cblxuXHRjb21taXQoaF9ub2RlKSB7XG5cdFx0bGV0IG5faXRlbXMgPSB0aGlzLml0ZW1fY291bnQ7XG5cdFx0bGV0IGFfY2Fub3B5ID0gdGhpcy5jYW5vcHk7XG5cblx0XHQvLyBsZWZ0IGVkZ2Ugb2YgbGlzdFxuXHRcdGlmICgtMSA9PT0gaF9ub2RlLmxlZnQpIHtcblx0XHRcdC8vIHRyZWUgcm9vdCB3YXMgaGFuZGVkIHRvIGNvbW1pdFxuXHRcdFx0aWYgKGhfbm9kZS5yaWdodCA9PT0gbl9pdGVtcykge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ2Nhbm5vdCBjb21taXQgcm9vdCEnKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gbmVpZ2hib3Igb24gcmlnaHQgc2lkZVxuXHRcdFx0bGV0IGhfcmlnaHQgPSB0aGlzLnRvcChhX2Nhbm9weVtoX25vZGUucmlnaHRdKTtcblxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgcmVhZHkhXG5cdFx0XHRpZiAoaF9yaWdodC5yZWFkeSkge1xuXHRcdFx0XHRyZXR1cm4gdGhpcy5tZXJnZShoX25vZGUsIGhfcmlnaHQpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgYnVzeS9ub3QgcmVhZHk7IG1hcmsgdGhpcyBpdGVtIGFzIHJlYWR5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0aF9ub2RlLnJlYWR5ID0gdHJ1ZTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gcmlnaHQgZWRnZSBvZiBsaXN0XG5cdFx0ZWxzZSBpZiAobl9pdGVtcyA9PT0gaF9ub2RlLnJpZ2h0KSB7XG5cdFx0XHQvLyBuZWlnaGJvciBvbiBsZWZ0IHNpZGVcblx0XHRcdGxldCBoX2xlZnQgPSB0aGlzLnRvcChhX2Nhbm9weVtoX25vZGUubGVmdF0pO1xuXG5cdFx0XHQvLyBuZWlnaGJvciBpcyByZWFkeVxuXHRcdFx0aWYgKGhfbGVmdC5yZWFkeSkge1xuXHRcdFx0XHRyZXR1cm4gdGhpcy5tZXJnZShoX2xlZnQsIGhfbm9kZSk7XG5cdFx0XHR9XG5cdFx0XHQvLyBuZWlnaGJvciBpcyBidXN5L25vdCByZWFkeTsgbWFyayB0aGlzIGl0ZW0gYXMgcmVhZHlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHRoX25vZGUucmVhZHkgPSB0cnVlO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBzb21ld2hlcmUgaW4gdGhlIG1pZGRsZVxuXHRcdGVsc2Uge1xuXHRcdFx0Ly8gc3RhcnQgd2l0aCBsZWZ0IG5laWdoYm9yXG5cdFx0XHRsZXQgaF9sZWZ0ID0gdGhpcy50b3AoYV9jYW5vcHlbaF9ub2RlLmxlZnRdKTtcblxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgcmVhZHlcblx0XHRcdGlmIChoX2xlZnQucmVhZHkpIHtcblx0XHRcdFx0cmV0dXJuIHRoaXMubWVyZ2UoaF9sZWZ0LCBoX25vZGUpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgYnVzeS9ub3QgcmVhZHlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyB0cnkgcmlnaHQgbmVpZ2hib3Jcblx0XHRcdFx0bGV0IGhfcmlnaHQgPSB0aGlzLnRvcChhX2Nhbm9weVtoX25vZGUucmlnaHRdKTtcblxuXHRcdFx0XHQvLyBuZWlnaGJvciBpcyByZWFkeVxuXHRcdFx0XHRpZiAoaF9yaWdodC5yZWFkeSkge1xuXHRcdFx0XHRcdHJldHVybiB0aGlzLm1lcmdlKGhfbm9kZSwgaF9yaWdodCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gbmVpZ2hib3IgaXMgYnVzeS9ub3QgcmVhZHk7IG1hcmsgdGhpcyBpdGVtIGFzIHJlYWR5XG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdGhfbm9kZS5yZWFkeSA9IHRydWU7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHRyZXR1cm4gbnVsbDtcblx0fVxufVxuXG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oZGNfd29ya2VyKSB7XG5cdHdvcmtlciA9IGRjX3dvcmtlcjtcblx0cmV0dXJuIGdyb3VwO1xufTsiLCIvLyBkZWR1Y2UgdGhlIHJ1bnRpbWUgZW52aXJvbm1lbnRcbmNvbnN0IFtCX0JST1dTRVIsIEJfQlJPV1NFUklGWV0gPSAoKCkgPT4gJ3VuZGVmaW5lZCcgPT09IHR5cGVvZiBwcm9jZXNzID9cblx0W3RydWUsIGZhbHNlXSA6XG5cdChwcm9jZXNzLmJyb3dzZXIgP1xuXHRcdFt0cnVlLCB0cnVlXSA6XG5cdFx0KCd1bmRlZmluZWQnID09PSBwcm9jZXNzLnZlcnNpb25zIHx8ICd1bmRlZmluZWQnID09PSBwcm9jZXNzLnZlcnNpb25zLm5vZGUgP1xuXHRcdFx0W3RydWUsIGZhbHNlXSA6XG5cdFx0XHRbZmFsc2UsIGZhbHNlXSkpKSgpO1xuXG5cbmNvbnN0IGxvY2FscyA9IE9iamVjdC5hc3NpZ24oe1xuXHRCX0JST1dTRVIsXG5cdEJfQlJPV1NFUklGWSxcblxuXHRIUF9XT1JLRVJfTk9USUZJQ0FUSU9OOiBTeW1ib2woJ3dvcmtlciBub3RpZmljYXRpb24nKSxcbn0sIEJfQlJPV1NFUiA/IHJlcXVpcmUoJy4uL2Jyb3dzZXIvbG9jYWxzLmpzJykgOiByZXF1aXJlKCcuLi9ub2RlL2xvY2Fscy5qcycpKTtcblxuXG5sb2NhbHMud2Vid29ya2VyaWZ5ID0gZnVuY3Rpb24oel9pbXBvcnQsIGhfY29uZmlnID0ge30pIHtcblx0Y29uc3QgW0ZfRlVOQ1RJT05fQlVORExFLCBIX1NPVVJDRVMsIEhfQ0FDSEVdID0gaF9jb25maWcuYnJvd3NlcmlmeTtcblx0bGV0IHNfd29ya2VyX2tleSA9ICcnO1xuXHRmb3IgKGxldCBzX2NhY2hlX2tleSBpbiBIX0NBQ0hFKSB7XG5cdFx0bGV0IHpfZXhwb3J0cyA9IEhfQ0FDSEVbc19jYWNoZV9rZXldLmV4cG9ydHM7XG5cdFx0aWYgKHpfaW1wb3J0ID09PSB6X2V4cG9ydHMgfHwgel9pbXBvcnQgPT09IHpfZXhwb3J0cy5kZWZhdWx0KSB7XG5cdFx0XHRzX3dvcmtlcl9rZXkgPSBzX2NhY2hlX2tleTtcblx0XHRcdGJyZWFrO1xuXHRcdH1cblx0fVxuXG5cdGlmICghc193b3JrZXJfa2V5KSB7XG5cdFx0c193b3JrZXJfa2V5ID0gTWF0aC5mbG9vcihNYXRoLnBvdygxNiwgOCkgKiBNYXRoLnJhbmRvbSgpKS50b1N0cmluZygxNik7XG5cdFx0bGV0IGhfY2FjaGVfd29ya2VyID0ge307XG5cdFx0Zm9yIChsZXQgc19rZXlfY2FjaGUgaW4gSF9TT1VSQ0VTKSB7XG5cdFx0XHRoX2NhY2hlX3dvcmtlcltzX2tleV9jYWNoZV0gPSBzX2tleV9jYWNoZTtcblx0XHR9XG5cdFx0SF9TT1VSQ0VTW3Nfd29ya2VyX2tleV0gPSBbXG5cdFx0XHRuZXcgRnVuY3Rpb24oWydyZXF1aXJlJywgJ21vZHVsZScsICdleHBvcnRzJ10sIGAoJHt6X2ltcG9ydH0pKHNlbGYpO2ApLFxuXHRcdFx0aF9jYWNoZV93b3JrZXIsXG5cdFx0XTtcblx0fVxuXG5cdGxldCBzX3NvdXJjZV9rZXkgPSBNYXRoLmZsb29yKE1hdGgucG93KDE2LCA4KSAqIE1hdGgucmFuZG9tKCkpLnRvU3RyaW5nKDE2KTtcblx0SF9TT1VSQ0VTW3Nfc291cmNlX2tleV0gPSBbXG5cdFx0bmV3IEZ1bmN0aW9uKFsncmVxdWlyZSddLCBgXG5cdFx0XHRsZXQgZiA9IHJlcXVpcmUoJHtKU09OLnN0cmluZ2lmeShzX3dvcmtlcl9rZXkpfSk7XG5cdFx0XHQvLyBkZWJ1Z2dlcjtcblx0XHRcdC8vIChmLmRlZmF1bHQ/IGYuZGVmYXVsdDogZikoc2VsZik7XG5cdFx0YCksXG5cdFx0e1xuXHRcdFx0W3Nfd29ya2VyX2tleV06IHNfd29ya2VyX2tleVxuXHRcdH0sXG5cdF07XG5cblx0bGV0IGhfd29ya2VyX3NvdXJjZXMgPSB7fTtcblxuXHRmdW5jdGlvbiByZXNvbHZlX3NvdXJjZXMoc19rZXkpIHtcblx0XHRoX3dvcmtlcl9zb3VyY2VzW3Nfa2V5XSA9IHRydWU7XG5cdFx0bGV0IGhfc291cmNlID0gSF9TT1VSQ0VTW3Nfa2V5XVsxXTtcblx0XHRmb3IgKGxldCBwX2RlcGVuZGVuY3kgaW4gaF9zb3VyY2UpIHtcblx0XHRcdGxldCBzX2RlcGVuZGVuY3lfa2V5ID0gaF9zb3VyY2VbcF9kZXBlbmRlbmN5XTtcblx0XHRcdGlmICghaF93b3JrZXJfc291cmNlc1tzX2RlcGVuZGVuY3lfa2V5XSkge1xuXHRcdFx0XHRyZXNvbHZlX3NvdXJjZXMoc19kZXBlbmRlbmN5X2tleSk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cdHJlc29sdmVfc291cmNlcyhzX3NvdXJjZV9rZXkpO1xuXG5cdGxldCBzX3NvdXJjZSA9IGAoJHtGX0ZVTkNUSU9OX0JVTkRMRX0pKHtcblx0XHQke09iamVjdC5rZXlzKGhfd29ya2VyX3NvdXJjZXMpLm1hcCgoc19rZXkpID0+IHtcblx0XHRcdGxldCBhX3NvdXJjZSA9IEhfU09VUkNFU1tzX2tleV07XG5cdFx0XHRyZXR1cm4gSlNPTi5zdHJpbmdpZnkoc19rZXkpXG5cdFx0XHRcdCtgOlske2Ffc291cmNlWzBdfSwke0pTT04uc3RyaW5naWZ5KGFfc291cmNlWzFdKX1dYDtcblx0XHR9KX1cblx0fSwge30sIFske0pTT04uc3RyaW5naWZ5KHNfc291cmNlX2tleSl9XSlgO1xuXG5cdGxldCBkX2Jsb2IgPSBuZXcgQmxvYihbc19zb3VyY2VdLCB7XG5cdFx0dHlwZTogJ3RleHQvamF2YXNjcmlwdCdcblx0fSk7XG5cdGlmIChoX2NvbmZpZy5iYXJlKSB7XG5cdFx0cmV0dXJuIGRfYmxvYjtcblx0fVxuXHRsZXQgcF93b3JrZXJfdXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChkX2Jsb2IpO1xuXHRsZXQgZF93b3JrZXIgPSBuZXcgbG9jYWxzLkRDX1dPUktFUihwX3dvcmtlcl91cmwsIGhfY29uZmlnLndvcmtlcl9vcHRpb25zKTtcblx0Ly8gZF93b3JrZXIub2JqZWN0VVJMID0gcF93b3JrZXJfdXJsO1xuXHQvLyBkX3dvcmtlci5zb3VyY2UgPSBkX2Jsb2I7XG5cdGRfd29ya2VyLnNvdXJjZSA9IHNfc291cmNlO1xuXHRyZXR1cm4gZF93b3JrZXI7XG59O1xuXG5cbm1vZHVsZS5leHBvcnRzID0gbG9jYWxzOyIsImNvbnN0IHtcblx0c2hhcmluZyxcbn0gPSByZXF1aXJlKCcuL2xvY2Fscy5qcycpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGNsYXNzIG1hbmlmZXN0IHtcblx0c3RhdGljIGZyb20oel9vdGhlcikge1xuXHRcdC8vIG1hbmlmZXN0XG5cdFx0aWYgKHpfb3RoZXIgaW5zdGFuY2VvZiBtYW5pZmVzdCkge1xuXHRcdFx0cmV0dXJuIHpfb3RoZXI7XG5cdFx0fVxuXHRcdC8vIGFueVxuXHRcdGVsc2Uge1xuXHRcdFx0cmV0dXJuIG5ldyBtYW5pZmVzdCh6X290aGVyLCBbXSk7XG5cdFx0fVxuXHR9XG5cblx0Y29uc3RydWN0b3IoYV9kYXRhID0gW10sIHpfdHJhbnNmZXJfcGF0aHMgPSB0cnVlKSB7XG5cdFx0Ly8gbm90IGFuIGFycmF5XG5cdFx0aWYgKCFBcnJheS5pc0FycmF5KGFfZGF0YSkpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcignYSBtYW5pZmVzdCByZXByZXNlbnRzIGFuIGFycmF5IG9mIGFyZ3VtZW50czsgcGFzcyB0aGUgY29uc3RydWN0b3IgYW4gYXJyYXknKTtcblx0XHR9XG5cblx0XHQvLyBub3QgYSBsaXN0OyBmaW5kIHRyYW5zZmVycyBtYW51YWxseVxuXHRcdGxldCBhX3RyYW5zZmVyX3BhdGhzID0gel90cmFuc2Zlcl9wYXRocztcblx0XHRpZiAoIUFycmF5LmlzQXJyYXkoYV90cmFuc2Zlcl9wYXRocykpIHtcblx0XHRcdGFfdHJhbnNmZXJfcGF0aHMgPSB0aGlzLmV4dHJhY3QoYV9kYXRhKTtcblx0XHR9XG5cdFx0Ly8gb25seSBjaGVjayB0b3AgbGV2ZWxcblx0XHRlbHNlIHtcblx0XHRcdGxldCBhX3RyYW5zZmVycyA9IFtdO1xuXHRcdFx0Zm9yIChsZXQgaV9kYXR1bSA9IDAsIG5sX2RhdGEgPSBhX2RhdGEubGVuZ3RoOyBpX2RhdHVtIDwgbmxfZGF0YTsgaV9kYXR1bSsrKSB7XG5cdFx0XHRcdGxldCB6X2RhdHVtID0gYV9kYXRhW2lfZGF0dW1dO1xuXG5cdFx0XHRcdC8vIHNoYXJlYWJsZSBpdGVtXG5cdFx0XHRcdGlmIChzaGFyaW5nKHpfZGF0dW0pKSBhX3RyYW5zZmVycy5wdXNoKFtpX2RhdHVtXSk7XG5cdFx0XHR9XG5cblx0XHRcdC8vIHNvbGlkaWZ5IHRyYW5zZmVyc1xuXHRcdFx0aWYgKGFfdHJhbnNmZXJzLmxlbmd0aCkge1xuXHRcdFx0XHRhX3RyYW5zZmVyX3BhdGhzID0gYV90cmFuc2ZlcnM7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRkYXRhOiBhX2RhdGEsXG5cdFx0XHR0cmFuc2Zlcl9wYXRoczogYV90cmFuc2Zlcl9wYXRocyxcblx0XHR9KTtcblx0fVxuXG5cdGV4dHJhY3Qoel9kYXRhLCBhX3BhdGggPSBbXSwgemlfcGF0aF9sYXN0ID0gbnVsbCkge1xuXHRcdC8vIHByb3RlY3QgYWdhaW5zdCBbb2JqZWN0XSBudWxsXG5cdFx0aWYgKCF6X2RhdGEpIHJldHVybiBbXTtcblxuXHRcdC8vIHNldCBvZiBwYXRoc1xuXHRcdGxldCBhX3BhdGhzID0gW107XG5cblx0XHQvLyBvYmplY3Rcblx0XHRpZiAoJ29iamVjdCcgPT09IHR5cGVvZiB6X2RhdGEpIHtcblx0XHRcdC8vIGNvcHkgcGF0aFxuXHRcdFx0YV9wYXRoID0gYV9wYXRoLnNsaWNlKCk7XG5cblx0XHRcdC8vIGNvbW1pdCB0byBpdFxuXHRcdFx0aWYgKG51bGwgIT09IHppX3BhdGhfbGFzdCkgYV9wYXRoLnB1c2goemlfcGF0aF9sYXN0KTtcblxuXHRcdFx0Ly8gcGxhaW4gb2JqZWN0IGxpdGVyYWxcblx0XHRcdGlmIChPYmplY3QgPT09IHpfZGF0YS5jb25zdHJ1Y3Rvcikge1xuXHRcdFx0XHQvLyBzY2FuIG92ZXIgZW51bWVyYWJsZSBwcm9wZXJ0aWVzXG5cdFx0XHRcdGZvciAobGV0IHNfcHJvcGVydHkgaW4gel9kYXRhKSB7XG5cdFx0XHRcdFx0Ly8gZXh0cmFjdCBkYXRhIGFuZCB0cmFuc2ZlcnMgYnkgcmVjdXJzaW5nIG9uIHByb3BlcnR5XG5cdFx0XHRcdFx0YV9wYXRocy5wdXNoKC4uLnRoaXMuZXh0cmFjdCh6X2RhdGFbc19wcm9wZXJ0eV0sIGFfcGF0aCwgc19wcm9wZXJ0eSkpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHQvLyBhcnJheVxuXHRcdFx0ZWxzZSBpZiAoQXJyYXkuaXNBcnJheSh6X2RhdGEpKSB7XG5cdFx0XHRcdC8vIGVtcHR5IGFycmF5XG5cdFx0XHRcdGlmICghel9kYXRhLmxlbmd0aCkgcmV0dXJuIFtdO1xuXG5cdFx0XHRcdC8vIHNjYW4gb3ZlciBlYWNoIGl0ZW1cblx0XHRcdFx0el9kYXRhLmZvckVhY2goKHpfaXRlbSwgaV9pdGVtKSA9PiB7XG5cdFx0XHRcdFx0Ly8gZXh0cmFjdCBkYXRhIGFuZCB0cmFuc2ZlcnMgYnkgcmVjdXJzaW5nIG9uIGl0ZW1cblx0XHRcdFx0XHRhX3BhdGhzLnB1c2goLi4udGhpcy5leHRyYWN0KHpfaXRlbSwgYV9wYXRoLCBpX2l0ZW0pKTtcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0XHQvLyBzaGFyZWFibGUgZGF0YVxuXHRcdFx0ZWxzZSBpZiAoc2hhcmluZyh6X2RhdGEpKSB7XG5cdFx0XHRcdHJldHVybiBbYV9wYXRoXTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyByZXR1cm4gcGF0aHNcblx0XHRyZXR1cm4gYV9wYXRocztcblx0fVxuXG5cdHByZXBlbmQoel9hcmcpIHtcblx0XHQvLyBjb3B5IGl0ZW1zXG5cdFx0bGV0IGFfaXRlbXMgPSB0aGlzLmRhdGEuc2xpY2UoKTtcblxuXHRcdC8vIGNvcHkgdHJhbnNmZXIgcGF0aHNcblx0XHRsZXQgYV90cmFuc2Zlcl9wYXRocyA9IHRoaXMudHJhbnNmZXJfcGF0aHMuc2xpY2UoKTtcblxuXHRcdC8vIHB1c2ggYSBtYW5pZmVzdCB0byBmcm9udFxuXHRcdGlmICh6X2FyZyBpbnN0YW5jZW9mIG1hbmlmZXN0KSB7XG5cdFx0XHQvLyBhZGQgaXRzIGNvbnRlbnRzIGFzIGEgc2luZ2xlIGl0ZW1cblx0XHRcdGFfaXRlbXMudW5zaGlmdCh6X2FyZy5kYXRhKTtcblxuXHRcdFx0Ly8gaG93IG1hbnkgcGF0aHMgdG8gb2Zmc2V0IGltcG9ydCBieVxuXHRcdFx0bGV0IG5sX3BhdGhzID0gYV90cmFuc2Zlcl9wYXRocy5sZW5ndGg7XG5cblx0XHRcdC8vIHVwZGF0ZSBpbXBvcnQgcGF0aHMgKHByaW1hcnkgaW5kZXggbmVlZHMgdXBkYXRlKVxuXHRcdFx0bGV0IGFfaW1wb3J0X3BhdGhzID0gel9hcmcudHJhbnNmZXJfcGF0aHM7XG5cdFx0XHRhX2ltcG9ydF9wYXRocy5mb3JFYWNoKChhX3BhdGgpID0+IHtcblx0XHRcdFx0YV9wYXRoWzBdICs9IG5sX3BhdGhzO1xuXHRcdFx0fSk7XG5cblx0XHRcdC8vIGFwcGVuZCBpdHMgdHJhbnNmZXIgcGF0aHNcblx0XHRcdGFfdHJhbnNmZXJfcGF0aHMucHVzaChhX2ltcG9ydF9wYXRocyk7XG5cdFx0fVxuXHRcdC8vIGFueXRoaW5nIGVsc2Vcblx0XHRlbHNlIHtcblx0XHRcdC8vIGp1c3QgYWRkIHRvIGZyb250XG5cdFx0XHRhX2l0ZW1zLnVuc2hpZnQoel9hcmcpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBuZXcgbWFuaWZlc3Rcblx0XHRyZXR1cm4gbmV3IG1hbmlmZXN0KGFfaXRlbXMsIGFfdHJhbnNmZXJfcGF0aHMpO1xuXHR9XG5cblx0cGF0aHMoLi4uYV91bnNoaWZ0KSB7XG5cdFx0cmV0dXJuIHRoaXMudHJhbnNmZXJfcGF0aHMubWFwKChhX3BhdGgpID0+IHtcblx0XHRcdHJldHVybiBbLi4uYV91bnNoaWZ0LCAuLi5hX3BhdGhdO1xuXHRcdH0pO1xuXHR9XG59OyIsImNvbnN0IHtcblx0Tl9DT1JFUyxcbn0gPSByZXF1aXJlKCcuL2xvY2Fscy5qcycpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGNsYXNzIHBvb2wge1xuXHRjb25zdHJ1Y3RvcihwX3NvdXJjZSwgbl93b3JrZXJzID0gTl9DT1JFUywgaF93b3JrZXJfb3B0aW9ucyA9IHt9KSB7XG5cdFx0Ly8gbm8gd29ya2VyIGNvdW50IGdpdmVuOyBkZWZhdWx0IHRvIG51bWJlciBvZiBjb3Jlc1xuXHRcdGlmICghbl93b3JrZXJzKSBuX3dvcmtlcnMgPSBOX0NPUkVTO1xuXG5cdFx0Ly8gZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdFx0bGltaXQ6IG5fd29ya2Vycyxcblx0XHRcdHdvcmtlcnM6IFtdLFxuXHRcdFx0aGlzdG9yeTogW10sXG5cdFx0XHR3YWl0X2xpc3Q6IFtdLFxuXHRcdH0pO1xuXHR9XG5cblx0cnVuKHNfdGFzaywgYV9hcmdzLCBoX2V2ZW50cykge1xuXHRcdHRoaXMuaGlzdG9yeS5wdXNoKG5ldyBQcm9taXNlKGFzeW5jIChmX3Jlc29sdmUsIGZfcmVqZWN0KSA9PiB7XG5cdFx0XHQvLyBzdW1tb24gYSB3b3JrZXJcblx0XHRcdGxldCBrX3dvcmtlciA9IGF3YWl0IHRoaXMuc3VtbW9uKCk7XG5cblx0XHRcdC8vIHJ1biB0aGlzIHRhc2tcblx0XHRcdGxldCB6X3Jlc3VsdDtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdHpfcmVzdWx0ID0gYXdhaXQga193b3JrZXIucnVuKHNfdGFzaywgYV9hcmdzLCBoX2V2ZW50cyk7XG5cdFx0XHR9XG5cdFx0XHQvLyBlcnJvciB3aGlsZSBydW5uaW5nIHRhc2tcblx0XHRcdGNhdGNoIChlX3J1bikge1xuXHRcdFx0XHRyZXR1cm4gZl9yZWplY3QoZV9ydW4pO1xuXHRcdFx0fVxuXHRcdFx0Ly8gd29ya2VyIGlzIGF2YWlsYWJsZSBub3dcblx0XHRcdGZpbmFsbHkge1xuXHRcdFx0XHRsZXQgYV93YWl0X2xpc3QgPSB0aGlzLndhaXRfbGlzdDtcblxuXHRcdFx0XHQvLyBhdCBsZWFzdCBvbmUgdGFzayBpcyBxdWV1ZWRcblx0XHRcdFx0aWYgKGFfd2FpdF9saXN0Lmxlbmd0aCkge1xuXHRcdFx0XHRcdGFfd2FpdF9saXN0LnNoaWZ0KCkoa193b3JrZXIpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIHJlc29sdmUgcHJvbWlzZVxuXHRcdFx0Zl9yZXNvbHZlKHpfcmVzdWx0KTtcblx0XHR9KSk7XG5cdH1cblxuXHRhc3luYyBraWxsKHNfc2lnbmFsKSB7XG5cdFx0cmV0dXJuIGF3YWl0IFByb21pc2UuYWxsKHRoaXMud29ya2Vycy5tYXAoKGtfd29ya2VyKSA9PiBrX3dvcmtlci5raWxsKHNfc2lnbmFsKSkpO1xuXHR9XG5cblx0c3RhcnQoKSB7XG5cdFx0dGhpcy5oaXN0b3J5Lmxlbmd0aCA9IDA7XG5cdH1cblxuXHRhc3luYyBzdG9wKCkge1xuXHRcdC8vIGNhY2hlIGhpc3Rvcnlcblx0XHRsZXQgYV9oaXN0b3J5ID0gdGhpcy5oaXN0b3J5O1xuXG5cdFx0Ly8gcmVzZXQgc3RhcnQgcG9pbnRcblx0XHR0aGlzLnN0YXJ0KCk7XG5cblx0XHQvLyBhd2FpdCBhbGwgcHJvbWlzZXMgdG8gZmluaXNoXG5cdFx0cmV0dXJuIGF3YWl0IFByb21pc2UuYWxsKGFfaGlzdG9yeSk7XG5cdH1cblxuXHRhc3luYyBzdW1tb24oKSB7XG5cdFx0bGV0IGFfd29ya2VycyA9IHRoaXMud29ya2VycztcblxuXHRcdC8vIGVhY2ggd29ya2VyXG5cdFx0Zm9yIChsZXQgaV93b3JrZXIgPSAwLCBubF93b3JrZXJzID0gYV93b3JrZXJzLmxlbmd0aDsgaV93b3JrZXIgPCBubF93b3JrZXJzOyBpX3dvcmtlcisrKSB7XG5cdFx0XHRsZXQga193b3JrZXIgPSBhX3dvcmtlcnNbaV93b3JrZXJdO1xuXG5cdFx0XHQvLyB3b3JrZXIgbm90IGJ1c3lcblx0XHRcdGlmICgha193b3JrZXIuYnVzeSkge1xuXHRcdFx0XHRyZXR1cm4ga193b3JrZXI7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gcm9vbSB0byBncm93XG5cdFx0aWYgKGFfd29ya2Vycy5sZW5ndGggPCB0aGlzLmxpbWl0KSB7XG5cdFx0XHQvLyBjcmVhdGUgbmV3IHdvcmtlclxuXHRcdFx0bGV0IGtfd29ya2VyID0gbmV3IHdvcmtlcih7XG5cdFx0XHRcdHNvdXJjZTogcF9zb3VyY2UsXG5cdFx0XHRcdGlkOiBhX3dvcmtlcnMubGVuZ3RoLFxuXHRcdFx0XHRtYXN0ZXI6IHRoaXMsXG5cdFx0XHRcdG9wdGlvbnM6IGhfd29ya2VyX29wdGlvbnMsXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gYWRkIHRvIHBvb2xcblx0XHRcdGFfd29ya2Vycy5wdXNoKGtfd29ya2VyKTtcblxuXHRcdFx0Ly8gaXQncyBhdmFpbGFibGUgbm93XG5cdFx0XHRyZXR1cm4ga193b3JrZXI7XG5cdFx0fVxuXG5cdFx0Ly8gcXVldWUgZm9yIG5vdGlmaWNhdGlvbiB3aGVuIHdvcmtlcnMgYmVjb21lIGF2YWlsYWJsZVxuXHRcdHRoaXMud2FpdF9saXN0LnB1c2goKGtfd29ya2VyKSA9PiB7XG5cdFx0XHRma193b3JrZXIoa193b3JrZXIsIGNfc3VtbW9uZWQrKyk7XG5cdFx0fSk7XG5cdH1cbn07IiwiY29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKCcuL21hbmlmZXN0LmpzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gY2xhc3MgcmVzdWx0IGV4dGVuZHMgbWFuaWZlc3Qge1xuXHRzdGF0aWMgZnJvbSh6X2l0ZW0pIHtcblx0XHRpZiAoel9pdGVtIGluc3RhbmNlb2YgcmVzdWx0KSB7XG5cdFx0XHRyZXR1cm4gel9pdGVtO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRyZXR1cm4gbmV3IHJlc3VsdCh6X2l0ZW0pO1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0cnVjdG9yKHpfcmVzdWx0LCB6X3RyYW5zZmVyX3BhdGhzID0gdHJ1ZSkge1xuXHRcdHN1cGVyKFt6X3Jlc3VsdF0sIHpfdHJhbnNmZXJfcGF0aHMpO1xuXHR9XG5cblx0cHJlcGVuZCgpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ2Nhbm5vdCBwcmVwZW5kIGEgcmVzdWx0Jyk7XG5cdH1cbn07IiwiY29uc3QgZXZlbnRzID0gcmVxdWlyZSgnLi9ldmVudHMuanMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBjbGFzcyBjaGFubmVsIGV4dGVuZHMgTWVzc2FnZUNoYW5uZWwge1xuXHRwb3J0XzEoZmtfcG9ydCkge1xuXHRcdGZrX3BvcnQoZXZlbnRzKHRoaXMucG9ydDEpKTtcblx0fVxuXG5cdHBvcnRfMihma19wb3J0KSB7XG5cdFx0ZmtfcG9ydChldmVudHModGhpcy5wb3J0MikpO1xuXHR9XG59OyIsIm1vZHVsZS5leHBvcnRzID0gKGR6X3RoaW5nKSA9PiB7XG5cdE9iamVjdC5hc3NpZ24oZHpfdGhpbmcsIHtcblx0XHRldmVudHMoaF9ldmVudHMpIHtcblx0XHRcdGZvciAobGV0IHNfZXZlbnQgaW4gaF9ldmVudHMpIHtcblx0XHRcdFx0dGhpc1snb24nICsgc19ldmVudF0gPSBoX2V2ZW50c1tzX2V2ZW50XTtcblx0XHRcdH1cblx0XHR9LFxuXG5cdFx0ZXZlbnQoc19ldmVudCwgZl9ldmVudCkge1xuXHRcdFx0dGhpc1snb24nICsgc19ldmVudF0gPSBmX2V2ZW50O1xuXHRcdH0sXG5cdH0pO1xuXG5cdHJldHVybiBkel90aGluZztcbn07IiwibW9kdWxlLmV4cG9ydHMgPSB7XG5cdEtfU0VMRjogcmVxdWlyZSgnLi9zZWxmLmpzJyksXG5cdERDX1dPUktFUjogJ3VuZGVmaW5lZCcgPT09IHR5cGVvZiBXb3JrZXIgPyB1bmRlZmluZWQgOiByZXF1aXJlKCcuL3dvcmtlci5qcycpLFxuXHREQ19DSEFOTkVMOiByZXF1aXJlKCcuL2NoYW5uZWwuanMnKSxcblx0SF9UWVBFRF9BUlJBWVM6IHJlcXVpcmUoJy4vdHlwZWQtYXJyYXlzLmpzJyksXG5cdE5fQ09SRVM6IG5hdmlnYXRvci5oYXJkd2FyZUNvbmN1cnJlbmN5IHx8IDEsXG5cdHNoYXJpbmc6IHJlcXVpcmUoJy4vc2hhcmluZy5qcycpLFxuXHRzdHJlYW06IHJlcXVpcmUoJy4vc3RyZWFtLmpzJyksXG5cdHBvcnRzOiByZXF1aXJlKCcuL3BvcnRzLmpzJyksXG59OyIsImNvbnN0IGV2ZW50cyA9IHJlcXVpcmUoJy4vZXZlbnRzLmpzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gKGRfcG9ydCkgPT4gZXZlbnRzKGRfcG9ydCk7IiwiY29uc3QgZXZlbnRzID0gcmVxdWlyZSgnLi9ldmVudHMuanMnKTtcblxuZXZlbnRzKHNlbGYpO1xuXG5zZWxmLmFyZ3MgPSBbXG5cdChNYXRoLnJhbmRvbSgpICsgJycpLnNsaWNlKDIsIDgpLFxuXTtcblxubW9kdWxlLmV4cG9ydHMgPSBzZWxmOyIsImNvbnN0ICRfU0hBUkVBQkxFID0gU3ltYm9sKCdzaGFyZWFibGUnKTtcblxuZnVuY3Rpb24gZXh0cmFjdCh6X2RhdGEsIGFzX3RyYW5zZmVycyA9IG51bGwpIHtcblx0Ly8gcHJvdGVjdCBhZ2FpbnN0IFtvYmplY3RdIG51bGxcblx0aWYgKCF6X2RhdGEpIHJldHVybiBbXTtcblxuXHQvLyBzZXQgb2YgdHJhbnNmZXIgb2JqZWN0c1xuXHRpZiAoIWFzX3RyYW5zZmVycykgYXNfdHJhbnNmZXJzID0gbmV3IFNldCgpO1xuXG5cdC8vIG9iamVjdFxuXHRpZiAoJ29iamVjdCcgPT09IHR5cGVvZiB6X2RhdGEpIHtcblx0XHQvLyBwbGFpbiBvYmplY3QgbGl0ZXJhbFxuXHRcdGlmIChPYmplY3QgPT09IHpfZGF0YS5jb25zdHJ1Y3Rvcikge1xuXHRcdFx0Ly8gc2NhbiBvdmVyIGVudW1lcmFibGUgcHJvcGVydGllc1xuXHRcdFx0Zm9yIChsZXQgc19wcm9wZXJ0eSBpbiB6X2RhdGEpIHtcblx0XHRcdFx0Ly8gYWRkIGVhY2ggdHJhbnNmZXJhYmxlIGZyb20gcmVjdXJzaW9uIHRvIG93biBzZXRcblx0XHRcdFx0ZXh0cmFjdCh6X2RhdGFbc19wcm9wZXJ0eV0sIGFzX3RyYW5zZmVycyk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5XG5cdFx0ZWxzZSBpZiAoQXJyYXkuaXNBcnJheSh6X2RhdGEpKSB7XG5cdFx0XHQvLyBzY2FuIG92ZXIgZWFjaCBpdGVtXG5cdFx0XHR6X2RhdGEuZm9yRWFjaCgoel9pdGVtKSA9PiB7XG5cdFx0XHRcdC8vIGFkZCBlYWNoIHRyYW5zZmVyYWJsZSBmcm9tIHJlY3Vyc2lvbiB0byBvd24gc2V0XG5cdFx0XHRcdGV4dHJhY3Qoel9pdGVtLCBhc190cmFuc2ZlcnMpO1xuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5LCBkYXRhIHZpZXcgb3IgYXJyYXkgYnVmZmVyXG5cdFx0ZWxzZSBpZiAoQXJyYXlCdWZmZXIuaXNWaWV3KHpfZGF0YSkpIHtcblx0XHRcdGFzX3RyYW5zZmVycy5hZGQoel9kYXRhLmJ1ZmZlcik7XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlclxuXHRcdGVsc2UgaWYgKHpfZGF0YSBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHRhc190cmFuc2ZlcnMuYWRkKHpfZGF0YSk7XG5cdFx0fVxuXHRcdC8vIG1lc3NhZ2UgcG9ydFxuXHRcdGVsc2UgaWYgKHpfZGF0YSBpbnN0YW5jZW9mIE1lc3NhZ2VQb3J0KSB7XG5cdFx0XHRhc190cmFuc2ZlcnMuYWRkKHpfZGF0YSk7XG5cdFx0fVxuXHRcdC8vIGltYWdlIGJpdG1hcFxuXHRcdGVsc2UgaWYgKHpfZGF0YSBpbnN0YW5jZW9mIEltYWdlQml0bWFwKSB7XG5cdFx0XHRhc190cmFuc2ZlcnMuYWRkKHpfZGF0YSk7XG5cdFx0fVxuXHR9XG5cdC8vIGZ1bmN0aW9uXG5cdGVsc2UgaWYgKCdmdW5jdGlvbicgPT09IHR5cGVvZiB6X2RhdGEpIHtcblx0XHQvLyBzY2FuIG92ZXIgZW51bWVyYWJsZSBwcm9wZXJ0aWVzXG5cdFx0Zm9yIChsZXQgc19wcm9wZXJ0eSBpbiB6X2RhdGEpIHtcblx0XHRcdC8vIGFkZCBlYWNoIHRyYW5zZmVyYWJsZSBmcm9tIHJlY3Vyc2lvbiB0byBvd24gc2V0XG5cdFx0XHRleHRyYWN0KHpfZGF0YVtzX3Byb3BlcnR5XSwgYXNfdHJhbnNmZXJzKTtcblx0XHR9XG5cdH1cblx0Ly8gbm90aGluZ1xuXHRlbHNlIHtcblx0XHRyZXR1cm4gW107XG5cdH1cblxuXHQvLyBjb252ZXJ0IHNldCB0byBhcnJheVxuXHRyZXR1cm4gQXJyYXkuZnJvbShhc190cmFuc2ZlcnMpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE9iamVjdC5hc3NpZ24oZnVuY3Rpb24oel9vYmplY3QpIHtcblx0cmV0dXJuIEFycmF5QnVmZmVyLmlzVmlldyh6X29iamVjdCkgfHxcblx0XHR6X29iamVjdCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyIHx8XG5cdFx0el9vYmplY3QgaW5zdGFuY2VvZiBNZXNzYWdlUG9ydCB8fFxuXHRcdHpfb2JqZWN0IGluc3RhbmNlb2YgSW1hZ2VCaXRtYXA7XG59LCB7XG5cdCRfU0hBUkVBQkxFLFxuXG5cdGV4dHJhY3QsXG59KTsiLCJjb25zdCBldmVudHMgPSByZXF1aXJlKCdldmVudHMnKTtcblxuY2xhc3MgcmVhZGFibGVfc3RyZWFtIGV4dGVuZHMgZXZlbnRzLkV2ZW50RW1pdHRlciB7XG5cdGNvbnN0cnVjdG9yKCkge1xuXHRcdHN1cGVyKCk7XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdGRlY29kZXI6IG51bGwsXG5cdFx0XHRwYXVzZWQ6IGZhbHNlLFxuXHRcdFx0Y29uc3VtZWQ6IDAsXG5cdFx0fSk7XG5cdH1cblxuXHRzZXRFbmNvZGluZyhzX2VuY29kaW5nKSB7XG5cdFx0dGhpcy5kZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKHNfZW5jb2RpbmcpO1xuXHR9XG5cblx0cGF1c2UoKSB7XG5cdFx0dGhpcy5wYXVzZWQgPSB0cnVlO1xuXHR9XG5cblx0cmVzdW1lKCkge1xuXHRcdHRoaXMucGF1c2VkID0gZmFsc2U7XG5cdFx0dGhpcy5uZXh0X2NodW5rKCk7XG5cdH1cblxuXHRjaHVuayhhdF9jaHVuaywgYl9lb2YpIHtcblx0XHRsZXQgbmxfY2h1bmsgPSBhdF9jaHVuay5sZW5ndGg7XG5cdFx0dGhpcy5jb25zdW1lZCArPSBubF9jaHVuaztcblxuXHRcdC8vIGRlY29kZSBkYXRhXG5cdFx0aWYgKHRoaXMuZGVjb2Rlcikge1xuXHRcdFx0bGV0IHNfZGF0YTtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdHNfZGF0YSA9IHRoaXMuZGVjb2Rlci5kZWNvZGUoYXRfY2h1bmssIHtcblx0XHRcdFx0XHRzdHJlYW06ICFiX2VvZlxuXHRcdFx0XHR9KTtcblx0XHRcdH0gY2F0Y2ggKGVfZGVjb2RlKSB7XG5cdFx0XHRcdHRoaXMuZW1pdCgnZXJyb3InLCBlX2RlY29kZSk7XG5cdFx0XHR9XG5cblx0XHRcdHRoaXMuZW1pdCgnZGF0YScsIHNfZGF0YSwgYXRfY2h1bmspO1xuXHRcdH1cblx0XHQvLyBubyBlbmNvZGluZ1xuXHRcdGVsc2Uge1xuXHRcdFx0dGhpcy5lbWl0KCdkYXRhJywgYXRfY2h1bmssIGF0X2NodW5rKTtcblx0XHR9XG5cblx0XHQvLyBlbmQgb2YgZmlsZVxuXHRcdGlmIChiX2VvZikge1xuXHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdHRoaXMuZW1pdCgnZW5kJyk7XG5cdFx0XHR9LCAwKTtcblx0XHR9XG5cdFx0Ly8gcmVxdWVzdCBtb3JlIGRhdGFcblx0XHRlbHNlIGlmICghdGhpcy5wYXVzZWQpIHtcblx0XHRcdHRoaXMubmV4dF9jaHVuaygpO1xuXHRcdH1cblx0fVxufVxuXG5PYmplY3QuYXNzaWduKHJlYWRhYmxlX3N0cmVhbS5wcm90b3R5cGUsIHtcblx0ZW1pdHNCeXRlQ291bnRzOiB0cnVlLFxufSk7XG5cbmNsYXNzIHJlYWRhYmxlX3N0cmVhbV92aWFfcG9ydCBleHRlbmRzIHJlYWRhYmxlX3N0cmVhbSB7XG5cdGNvbnN0cnVjdG9yKGRfcG9ydCkge1xuXHRcdHN1cGVyKCk7XG5cblx0XHQvLyBtZXNzYWdlIGhhbmRsaW5nXG5cdFx0ZF9wb3J0Lm9ubWVzc2FnZSA9IChkX21zZykgPT4ge1xuXHRcdFx0bGV0IHtcblx0XHRcdFx0Y29udGVudDogYXRfY29udGVudCxcblx0XHRcdFx0ZW9mOiBiX2VvZixcblx0XHRcdH0gPSBkX21zZy5kYXRhO1xuXG5cdFx0XHQvLyBzdGFydCB0aW1pbmdcblx0XHRcdHRoaXMuc3RhcnRlZCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuXG5cdFx0XHQvLyBwcm9jZXNzIGNodW5rXG5cdFx0XHR0aGlzLmNodW5rKGF0X2NvbnRlbnQsIGJfZW9mKTtcblx0XHR9O1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRwb3J0OiBkX3BvcnQsXG5cdFx0XHRzdGFydGVkOiAwLFxuXHRcdH0pO1xuXHR9XG5cblx0c2V0RW5jb2Rpbmcoc19lbmNvZGluZykge1xuXHRcdHRoaXMuZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcihzX2VuY29kaW5nKTtcblx0fVxuXG5cdG5leHRfY2h1bmsoKSB7XG5cdFx0bGV0IHRfZWxhcHNlZCA9IHBlcmZvcm1hbmNlLm5vdygpIC0gdGhpcy5zdGFydGVkO1xuXG5cdFx0Ly8gY29uc29sZS5sb2coJ1MgPT0+IFtBQ0sgLyBuZXh0IGNodW5rXScpO1xuXG5cdFx0dGhpcy5wb3J0LnBvc3RNZXNzYWdlKHtcblx0XHRcdHBvc3RlZDogcGVyZm9ybWFuY2Uubm93KCksXG5cdFx0XHRlbGFwc2VkOiB0X2VsYXBzZWQsXG5cdFx0fSk7XG5cdH1cblxuXHQvLyBwYXVzZSgpIHtcblxuXHQvLyB9XG5cblx0Ly8gcmVzdW1lKGJfZG9udF91bnBhdXNlPWZhbHNlKSB7XG5cdC8vIFx0bGV0IHRfZWxhcHNlZCA9IHBlcmZvcm1hbmNlLm5vdygpIC0gdGhpcy5zdGFydGVkO1xuXG5cdC8vIFx0c2VsZi5wb3N0TWVzc2FnZSh7XG5cdC8vIFx0XHRlbGFwc2VkOiB0X2VsYXBzZWQsXG5cdC8vIFx0fSk7XG5cdC8vIH1cblxuXHQvLyBwaXBlKHlfd3JpdGFibGUpIHtcblx0Ly8gXHR0aGlzLm9uKCdkYXRhJywgKHpfY2h1bmspID0+IHtcblx0Ly8gXHRcdGxldCBiX2NhcGFjaXR5ID0geV93cml0YWJsZS53cml0ZSh6X2NodW5rKTtcblxuXHQvLyBcdFx0Ly8gZmV0Y2ggbmV4dCBjaHVuazsgb3RoZXJ3aXNlIGF3YWl0IGRyYWluXG5cdC8vIFx0XHRpZihmYWxzZSAhPT0gYl9jYXBhY2l0eSkge1xuXHQvLyBcdFx0XHR0aGlzLnJlc3VtZSh0cnVlKTtcblx0Ly8gXHRcdH1cblx0Ly8gXHR9KTtcblxuXHQvLyBcdHlfd3JpdGFibGUub24oJ2RyYWluJywgKCkgPT4ge1xuXHQvLyBcdFx0dGhpcy5yZXN1bWUodHJ1ZSk7XG5cdC8vIFx0fSk7XG5cblx0Ly8gXHR5X3dyaXRhYmxlLmVtaXQoJ3BpcGUnLCB0aGlzKTtcblx0Ly8gfVxufVxuXG5cblxuY2xhc3MgcmVhZGFibGVfc3RyZWFtX3ZpYV9vYmplY3RfdXJsIGV4dGVuZHMgcmVhZGFibGVfc3RyZWFtIHtcblx0Y29uc3RydWN0b3IocF9vYmplY3RfdXJsLCBoX2NvbmZpZyA9IHt9KSB7XG5cdFx0c3VwZXIoKTtcblxuXHRcdGZldGNoKHBfb2JqZWN0X3VybClcblx0XHRcdC50aGVuKGRfcmVzID0+IGRfcmVzLmJsb2IoKSlcblx0XHRcdC50aGVuKChkZmJfaW5wdXQpID0+IHtcblx0XHRcdFx0aWYgKHRoaXMub25ibG9iKSB0aGlzLm9uYmxvYihkZmJfaW5wdXQpO1xuXHRcdFx0XHRsZXQga19ibG9iX3JlYWRlciA9IHRoaXMuYmxvYl9yZWFkZXIgPSBuZXcgYmxvYl9yZWFkZXIodGhpcywgZGZiX2lucHV0LCBoX2NvbmZpZyk7XG5cdFx0XHRcdHRoaXMub24oJ2VuZCcsICgpID0+IHtcblx0XHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdFx0XHRVUkwucmV2b2tlT2JqZWN0VVJMKHBfb2JqZWN0X3VybCk7XG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRrX2Jsb2JfcmVhZGVyLm5leHRfY2h1bmsoKTtcblx0XHRcdH0pO1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRibG9iX3JlYWRlcjogbnVsbCxcblx0XHRcdG9iamVjdF91cmw6IHBfb2JqZWN0X3VybCxcblx0XHR9KTtcblx0fVxuXG5cdG5leHRfY2h1bmsoKSB7XG5cdFx0dGhpcy5ibG9iX3JlYWRlci5uZXh0X2NodW5rKCk7XG5cdH1cblxuXHQvLyBvbihzX2V2ZW50LCBma19ldmVudCkge1xuXHQvLyBcdHN1cGVyLm9uKHNfZXZlbnQsIGZrX2V2ZW50KTtcblxuXHQvLyBcdGlmKCdkYXRhJyA9PT0gc19ldmVudCkge1xuXHQvLyBcdFx0aWYoIXRoaXMuYmxvYikge1xuXHQvLyBcdFx0XHR0aGlzLm9uX2Jsb2IgPSB0aGlzLnJlc3VtZTtcblx0Ly8gXHRcdH1cblx0Ly8gXHRcdGVsc2Uge1xuXHQvLyBcdFx0XHR0aGlzLnJlc3VtZSgpO1xuXHQvLyBcdFx0fVxuXHQvLyBcdH1cblx0Ly8gfVxufVxuXG5jbGFzcyB0cmFuc2Zlcl9zdHJlYW0ge1xuXHRjb25zdHJ1Y3RvcigpIHtcblx0XHRsZXQgZF9jaGFubmVsID0gbmV3IE1lc3NhZ2VDaGFubmVsKCk7XG5cdFx0bGV0IGRfcG9ydCA9IGRfY2hhbm5lbC5wb3J0MTtcblxuXHRcdGRfcG9ydC5vbm1lc3NhZ2UgPSAoZF9tc2cpID0+IHtcblx0XHRcdGxldCB0X2VsYXBzZWRfbWFpbiA9IHRoaXMuZWxhcHNlZDtcblxuXHRcdFx0bGV0IHtcblx0XHRcdFx0cG9zdGVkOiB0X3Bvc3RlZCxcblx0XHRcdFx0ZWxhcHNlZDogdF9lbGFwc2VkX290aGVyLFxuXHRcdFx0fSA9IGRfbXNnLmRhdGE7XG5cblx0XHRcdC8vIGNvbnNvbGUubG9nKCcgKysgcGFyc2U6ICcrdF9lbGFwc2VkX290aGVyKTtcblx0XHRcdHRoaXMucmVjZWl2ZXJfZWxhcHNlZCArPSB0X2VsYXBzZWRfb3RoZXI7XG5cblx0XHRcdC8vIGNvbnNvbGUubG9nKCdNIDw9PSBbQUNLIC8gbmV4dCBjaHVua107IGJ1ZmZlcjogJysoISF0aGlzLmJ1ZmZlcikrJzsgYnVzeTogJyt0aGlzLnJlY2VpdmVyX2J1c3krJzsgZW9mOicrdGhpcy5yZWFkZXIuZW9mKTsgIC8vcG9zdGVkIEAnK3RfcG9zdGVkKTtcblxuXHRcdFx0Ly8gcmVjZWl2ZXIgaXMgZnJlZVxuXHRcdFx0dGhpcy5yZWNlaXZlcl9idXN5ID0gZmFsc2U7XG5cblx0XHRcdC8vIGNodW5rIHJlYWR5IHRvIGdvXG5cdFx0XHRpZiAodGhpcy5idWZmZXIpIHtcblx0XHRcdFx0dGhpcy5zZW5kKHRoaXMuYnVmZmVyLCB0aGlzLmJ1ZmZlcl9lb2YpO1xuXHRcdFx0XHR0aGlzLmJ1ZmZlciA9IG51bGw7XG5cdFx0XHR9XG5cblx0XHRcdC8vIHJlYWRlciBpcyBub3QgYnVzeVxuXHRcdFx0aWYgKCF0aGlzLnJlYWRlci5idXN5KSB7XG5cdFx0XHRcdHRoaXMucmVhZGVyLm5leHRfY2h1bmsoKTtcblx0XHRcdH1cblx0XHR9O1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRtYWluX3BvcnQ6IGRfcG9ydCxcblx0XHRcdG90aGVyX3BvcnQ6IGRfY2hhbm5lbC5wb3J0Mixcblx0XHRcdGVsYXBzZWQ6IDAsXG5cdFx0XHRyZWFkZXI6IG51bGwsXG5cdFx0XHRidWZmZXI6IG51bGwsXG5cdFx0XHRidWZmZXJfZW9mOiB0cnVlLFxuXHRcdFx0cmVjZWl2ZXJfYnVzeTogZmFsc2UsXG5cdFx0XHRyZWNlaXZlcl9lbGFwc2VkOiAwLFxuXHRcdH0pO1xuXHR9XG5cblx0c2VuZChhdF9jaHVuaywgYl9lb2YgPSB0cnVlKSB7XG5cdFx0dGhpcy5yZWNlaXZlcl9idXN5ID0gdHJ1ZTtcblxuXHRcdC8vIGNvbnNvbGUubG9nKCdNID09PiBbY2h1bmtdJyk7XG5cblx0XHQvLyBzZW5kIHRvIHJlY2VpdmVyXG5cdFx0dGhpcy5tYWluX3BvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0Y29udGVudDogYXRfY2h1bmssXG5cdFx0XHRlb2Y6IGJfZW9mLFxuXHRcdH0sIFthdF9jaHVuay5idWZmZXJdKTtcblx0fVxuXG5cdGNodW5rKGF0X2NodW5rLCBiX2VvZiA9IHRydWUpIHtcblx0XHQvLyBjb25zb2xlLmxvZygnYmxvYiBjaHVuayByZWFkeSB0byBzZW5kOyBidWZmZXI6ICcrKCEhdGhpcy5idWZmZXIpKyc7IGJ1c3k6ICcrdGhpcy5yZWNlaXZlcl9idXN5KTtcblxuXHRcdC8vIHJlY2VpdmVyIGlzIGJ1c3ksIHF1ZXVlIGluIGJ1ZmZlclxuXHRcdGlmICh0aGlzLnJlY2VpdmVyX2J1c3kpIHtcblx0XHRcdHRoaXMuYnVmZmVyID0gYXRfY2h1bms7XG5cdFx0XHR0aGlzLmJ1ZmZlcl9lb2YgPSBiX2VvZjtcblx0XHR9XG5cdFx0Ly8gcmVjZWl2ZXIgYXZhaWxhYmxlOyBzZW5kIGltbWVkaWF0ZWx5XG5cdFx0ZWxzZSB7XG5cdFx0XHQvLyBwcmVmZXRjaCBuZXh0IGNodW5rXG5cdFx0XHRpZiAoIXRoaXMuYnVmZmVyICYmICF0aGlzLnJlYWRlci5lb2YpIHtcblx0XHRcdFx0dGhpcy5yZWFkZXIubmV4dF9jaHVuaygpO1xuXHRcdFx0fVxuXG5cdFx0XHR0aGlzLnNlbmQoYXRfY2h1bmssIGJfZW9mKTtcblx0XHR9XG5cdH1cblxuXHRibG9iKGRmYl9pbnB1dCwgaF9jb25maWcgPSB7fSkge1xuXHRcdHRoaXMucmVhZGVyID0gbmV3IGJsb2JfcmVhZGVyKHRoaXMsIGRmYl9pbnB1dCwgaF9jb25maWcpO1xuXG5cdFx0Ly8gc3RhcnQgc2VuZGluZ1xuXHRcdHRoaXMucmVhZGVyLm5leHRfY2h1bmsoKTtcblx0fVxufVxuXG5jbGFzcyBibG9iX3JlYWRlciB7XG5cdGNvbnN0cnVjdG9yKGtfcGFyZW50LCBkZmJfaW5wdXQsIGhfY29uZmlnID0ge30pIHtcblx0XHRsZXQgZGZyX3JlYWRlciA9IG5ldyBGaWxlUmVhZGVyKCk7XG5cdFx0ZGZyX3JlYWRlci5vbmxvYWQgPSAoZF9ldmVudCkgPT4ge1xuXHRcdFx0dGhpcy5idXN5ID0gZmFsc2U7XG5cdFx0XHQvLyBsZXQgYl9lb2YgPSBmYWxzZTtcblx0XHRcdC8vIGlmKCsrdGhpcy5jaHVua3NfcmVhZCA9PT0gdGhpcy5jaHVua3NfbG9hZGVkKSBiX2VvZiA9IHRoaXMuZW9mO1xuXHRcdFx0a19wYXJlbnQuY2h1bmsobmV3IFVpbnQ4QXJyYXkoZF9ldmVudC50YXJnZXQucmVzdWx0KSwgdGhpcy5lb2YpO1xuXHRcdH07XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdGVvZjogZmFsc2UsXG5cdFx0XHRidXN5OiBmYWxzZSxcblx0XHRcdHJlYWRfaW5kZXg6IDAsXG5cdFx0XHRjaHVua19zaXplOiBoX2NvbmZpZy5jaHVua19zaXplIHx8IGhfY29uZmlnLmNodW5rU2l6ZSB8fCAxMDI0ICogMTAyNCAqIDEsIC8vIDEgTWlCXG5cdFx0XHRjb250ZW50OiBkZmJfaW5wdXQsXG5cdFx0XHRjb250ZW50X2xlbmd0aDogZGZiX2lucHV0LnNpemUsXG5cdFx0XHRmaWxlX3JlYWRlcjogZGZyX3JlYWRlcixcblx0XHRcdGNodW5rc19sb2FkZWQ6IDAsXG5cdFx0XHRjaHVua3NfcmVhZDogMCxcblx0XHR9KTtcblx0fVxuXG5cdG5leHRfY2h1bmsoKSB7XG5cdFx0bGV0IHtcblx0XHRcdHJlYWRfaW5kZXg6IGlfcmVhZCxcblx0XHRcdGNodW5rX3NpemU6IG5fY2h1bmtfc2l6ZSxcblx0XHRcdGNvbnRlbnQ6IGRmYl9jb250ZW50LFxuXHRcdFx0Y29udGVudF9sZW5ndGg6IG5sX2NvbnRlbnQsXG5cdFx0fSA9IHRoaXM7XG5cblx0XHRsZXQgaV9lbmQgPSBpX3JlYWQgKyBuX2NodW5rX3NpemU7XG5cdFx0aWYgKGlfZW5kID49IG5sX2NvbnRlbnQpIHtcblx0XHRcdGlfZW5kID0gbmxfY29udGVudDtcblx0XHRcdHRoaXMuZW9mID0gdHJ1ZTtcblx0XHR9XG5cblx0XHR0aGlzLmJ1c3kgPSB0cnVlO1xuXHRcdHRoaXMuY2h1bmtzX2xvYWRlZCArPSAxO1xuXG5cdFx0bGV0IGRmYl9zbGljZSA9IGRmYl9jb250ZW50LnNsaWNlKGlfcmVhZCwgaV9lbmQpO1xuXHRcdHRoaXMucmVhZF9pbmRleCA9IGlfZW5kO1xuXG5cdFx0dGhpcy5maWxlX3JlYWRlci5yZWFkQXNBcnJheUJ1ZmZlcihkZmJfc2xpY2UpO1xuXHR9XG59XG5cblxubW9kdWxlLmV4cG9ydHMgPSBPYmplY3QuYXNzaWduKGZ1bmN0aW9uKHpfaW5wdXQgPSBudWxsKSB7XG5cdGlmICh6X2lucHV0KSB7XG5cdFx0Ly8gbWFrZSByZWFkYWJsZSBzdHJlYW0gZnJvbSBvYmplY3QgdXJsJ3MgYmxvYlxuXHRcdGlmICgnc3RyaW5nJyA9PT0gdHlwZW9mIHpfaW5wdXQpIHtcblx0XHRcdHJldHVybiBuZXcgcmVhZGFibGVfc3RyZWFtX3ZpYV9vYmplY3RfdXJsKHpfaW5wdXQpO1xuXHRcdH1cblx0XHQvLyBtYWtlIHJlYWRhYmxlIHN0cmVhbSBhdG9wIHBvcnRcblx0XHRlbHNlIGlmICh6X2lucHV0IGluc3RhbmNlb2YgTWVzc2FnZVBvcnQpIHtcblx0XHRcdHJldHVybiBuZXcgcmVhZGFibGVfc3RyZWFtX3ZpYV9wb3J0KHpfaW5wdXQpO1xuXHRcdH1cblx0fVxuXHQvLyB0cmFuc2ZlciBhIHN0cmVhbVxuXHRlbHNlIHtcblx0XHRyZXR1cm4gbmV3IHRyYW5zZmVyX3N0cmVhbSgpO1xuXHR9XG59LCB7XG5cdGhhbmRsZXI6IGNsYXNzIGhhbmRsZXIge30sXG59KTsiLCJjb25zdCBzaGFyaW5nID0gcmVxdWlyZSgnLi9zaGFyaW5nLmpzJyk7XG5jb25zdCBUeXBlZEFycmF5ID0gT2JqZWN0LmdldFByb3RvdHlwZU9mKE9iamVjdC5nZXRQcm90b3R5cGVPZihuZXcgVWludDhBcnJheSgwKSkpLmNvbnN0cnVjdG9yO1xuXG5cblxuXG5cbmNsYXNzIEludDhBcnJheVMgZXh0ZW5kcyBJbnQ4QXJyYXkge1xuXHRjb25zdHJ1Y3Rvcih6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KSB7XG5cdFx0Ly8gdGhpc1xuXHRcdGxldCBoX3RoaXMgPSB7fTtcblxuXHRcdC8vIHNlbGZcblx0XHRsZXQgYXRfc2VsZjtcblxuXG5cdFx0Ly8gbGVuZ3RoIGNvbnN0cnVjdG9yXG5cdFx0aWYgKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQ4QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZiAoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0XHRhdF9zZWxmID0gbmV3IEludDhBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0XHRhdF9zZWxmLnNldCh6X2FyZ18wKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyIGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXk7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgSW50OEFycmF5KGRzYiwgMCwgbmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgY29weSBzcmNcblx0XHRcdGxldCBhdF9zcmMgPSBuZXcgSW50OEFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgSW50OEFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKEludDhBcnJheVMucHJvdG90eXBlLCB7XG5cdFtzaGFyaW5nLiRfU0hBUkVBQkxFXTogMSxcbn0pO1xuXG5cbmNsYXNzIFVpbnQ4QXJyYXlTIGV4dGVuZHMgVWludDhBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZiAoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQ4QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZiAoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQ4QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmICh1bmRlZmluZWQgPT09IG5sX2FycmF5KSB7XG5cdFx0XHRcdG5sX2FycmF5ID0gel9hcmdfMC5sZW5ndGggLSBuYl9vZmZzZXQ7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFycmF5IHNpemUgaW4gYnl0ZXNcblx0XHRcdGxldCBuYl9hcnJheSA9IG5sX2FycmF5O1xuXG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRsZXQgZHNiID0gbmV3IFNoYXJlZEFycmF5QnVmZmVyKG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIHR5cGVkIGFycmF5XG5cdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQ4QXJyYXkoZHNiLCAwLCBuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSBjb3B5IHNyY1xuXHRcdFx0bGV0IGF0X3NyYyA9IG5ldyBVaW50OEFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgVWludDhBcnJheSguLi5hX2FyZ3MpO1xuXHR9XG59XG5cbi8vIHN0YXRpYyBmaWVsZFxuT2JqZWN0LmFzc2lnbihVaW50OEFycmF5Uy5wcm90b3R5cGUsIHtcblx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdOiAxLFxufSk7XG5cblxuY2xhc3MgVWludDhDbGFtcGVkQXJyYXlTIGV4dGVuZHMgVWludDhDbGFtcGVkQXJyYXkge1xuXHRjb25zdHJ1Y3Rvcih6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KSB7XG5cdFx0Ly8gdGhpc1xuXHRcdGxldCBoX3RoaXMgPSB7fTtcblxuXHRcdC8vIHNlbGZcblx0XHRsZXQgYXRfc2VsZjtcblxuXG5cdFx0Ly8gbGVuZ3RoIGNvbnN0cnVjdG9yXG5cdFx0aWYgKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50OENsYW1wZWRBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmIChzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhDbGFtcGVkQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmICh1bmRlZmluZWQgPT09IG5sX2FycmF5KSB7XG5cdFx0XHRcdG5sX2FycmF5ID0gel9hcmdfMC5sZW5ndGggLSBuYl9vZmZzZXQ7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFycmF5IHNpemUgaW4gYnl0ZXNcblx0XHRcdGxldCBuYl9hcnJheSA9IG5sX2FycmF5O1xuXG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRsZXQgZHNiID0gbmV3IFNoYXJlZEFycmF5QnVmZmVyKG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIHR5cGVkIGFycmF5XG5cdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQ4Q2xhbXBlZEFycmF5KGRzYiwgMCwgbmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgY29weSBzcmNcblx0XHRcdGxldCBhdF9zcmMgPSBuZXcgVWludDhDbGFtcGVkQXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBVaW50OENsYW1wZWRBcnJheSguLi5hX2FyZ3MpO1xuXHR9XG59XG5cbi8vIHN0YXRpYyBmaWVsZFxuT2JqZWN0LmFzc2lnbihVaW50OENsYW1wZWRBcnJheVMucHJvdG90eXBlLCB7XG5cdFtzaGFyaW5nLiRfU0hBUkVBQkxFXTogMSxcbn0pO1xuXG5cbmNsYXNzIEludDE2QXJyYXlTIGV4dGVuZHMgSW50MTZBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZiAoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRhdF9zZWxmID0gbmV3IEludDE2QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZiAoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0XHRhdF9zZWxmID0gbmV3IEludDE2QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmICh1bmRlZmluZWQgPT09IG5sX2FycmF5KSB7XG5cdFx0XHRcdG5sX2FycmF5ID0gel9hcmdfMC5sZW5ndGggLSBuYl9vZmZzZXQ7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFycmF5IHNpemUgaW4gYnl0ZXNcblx0XHRcdGxldCBuYl9hcnJheSA9IG5sX2FycmF5IDw8IDE7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgSW50MTZBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IEludDE2QXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBJbnQxNkFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKEludDE2QXJyYXlTLnByb3RvdHlwZSwge1xuXHRbc2hhcmluZy4kX1NIQVJFQUJMRV06IDEsXG59KTtcblxuXG5jbGFzcyBVaW50MTZBcnJheVMgZXh0ZW5kcyBVaW50MTZBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZiAoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQxNkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYgKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50MTZBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0XHRhdF9zZWxmLnNldCh6X2FyZ18wKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyIGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXkgPDwgMTtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50MTZBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IFVpbnQxNkFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgVWludDE2QXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oVWludDE2QXJyYXlTLnByb3RvdHlwZSwge1xuXHRbc2hhcmluZy4kX1NIQVJFQUJMRV06IDEsXG59KTtcblxuXG5jbGFzcyBJbnQzMkFycmF5UyBleHRlbmRzIEludDMyQXJyYXkge1xuXHRjb25zdHJ1Y3Rvcih6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KSB7XG5cdFx0Ly8gdGhpc1xuXHRcdGxldCBoX3RoaXMgPSB7fTtcblxuXHRcdC8vIHNlbGZcblx0XHRsZXQgYXRfc2VsZjtcblxuXG5cdFx0Ly8gbGVuZ3RoIGNvbnN0cnVjdG9yXG5cdFx0aWYgKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQzMkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYgKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQzMkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHtcblx0XHRcdC8vIGZvcmNlIG9mZnNldFxuXHRcdFx0bmJfb2Zmc2V0ID0gbmJfb2Zmc2V0IHx8IDA7XG5cblx0XHRcdC8vIG5vIGxlbmd0aDsgZGVkdWNlIGl0IGZyb20gb2Zmc2V0XG5cdFx0XHRpZiAodW5kZWZpbmVkID09PSBubF9hcnJheSkge1xuXHRcdFx0XHRubF9hcnJheSA9IHpfYXJnXzAubGVuZ3RoIC0gbmJfb2Zmc2V0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhcnJheSBzaXplIGluIGJ5dGVzXG5cdFx0XHRsZXQgbmJfYXJyYXkgPSBubF9hcnJheSA8PCAyO1xuXG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRsZXQgZHNiID0gbmV3IFNoYXJlZEFycmF5QnVmZmVyKG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIHR5cGVkIGFycmF5XG5cdFx0XHRhdF9zZWxmID0gbmV3IEludDMyQXJyYXkoZHNiLCAwLCBuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSBjb3B5IHNyY1xuXHRcdFx0bGV0IGF0X3NyYyA9IG5ldyBJbnQzMkFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgSW50MzJBcnJheSguLi5hX2FyZ3MpO1xuXHR9XG59XG5cbi8vIHN0YXRpYyBmaWVsZFxuT2JqZWN0LmFzc2lnbihJbnQzMkFycmF5Uy5wcm90b3R5cGUsIHtcblx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdOiAxLFxufSk7XG5cblxuY2xhc3MgVWludDMyQXJyYXlTIGV4dGVuZHMgVWludDMyQXJyYXkge1xuXHRjb25zdHJ1Y3Rvcih6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KSB7XG5cdFx0Ly8gdGhpc1xuXHRcdGxldCBoX3RoaXMgPSB7fTtcblxuXHRcdC8vIHNlbGZcblx0XHRsZXQgYXRfc2VsZjtcblxuXG5cdFx0Ly8gbGVuZ3RoIGNvbnN0cnVjdG9yXG5cdFx0aWYgKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50MzJBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmIChzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDMyQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmICh1bmRlZmluZWQgPT09IG5sX2FycmF5KSB7XG5cdFx0XHRcdG5sX2FycmF5ID0gel9hcmdfMC5sZW5ndGggLSBuYl9vZmZzZXQ7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFycmF5IHNpemUgaW4gYnl0ZXNcblx0XHRcdGxldCBuYl9hcnJheSA9IG5sX2FycmF5IDw8IDI7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDMyQXJyYXkoZHNiLCAwLCBuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSBjb3B5IHNyY1xuXHRcdFx0bGV0IGF0X3NyYyA9IG5ldyBVaW50MzJBcnJheSh6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KTtcblxuXHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdGF0X3NlbGYuc2V0KGF0X3NyYyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIHNlbGZcblx0XHRzdXBlcihhdF9zZWxmKTtcblxuXHRcdC8vIHNhdmUgZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCBoX3RoaXMpO1xuXHR9XG5cblx0YmFzZSguLi5hX2FyZ3MpIHtcblx0XHRyZXR1cm4gbmV3IFVpbnQzMkFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKFVpbnQzMkFycmF5Uy5wcm90b3R5cGUsIHtcblx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdOiAxLFxufSk7XG5cblxuY2xhc3MgRmxvYXQzMkFycmF5UyBleHRlbmRzIEZsb2F0MzJBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZiAoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRhdF9zZWxmID0gbmV3IEZsb2F0MzJBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmIChzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgRmxvYXQzMkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHtcblx0XHRcdC8vIGZvcmNlIG9mZnNldFxuXHRcdFx0bmJfb2Zmc2V0ID0gbmJfb2Zmc2V0IHx8IDA7XG5cblx0XHRcdC8vIG5vIGxlbmd0aDsgZGVkdWNlIGl0IGZyb20gb2Zmc2V0XG5cdFx0XHRpZiAodW5kZWZpbmVkID09PSBubF9hcnJheSkge1xuXHRcdFx0XHRubF9hcnJheSA9IHpfYXJnXzAubGVuZ3RoIC0gbmJfb2Zmc2V0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhcnJheSBzaXplIGluIGJ5dGVzXG5cdFx0XHRsZXQgbmJfYXJyYXkgPSBubF9hcnJheSA8PCAyO1xuXG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRsZXQgZHNiID0gbmV3IFNoYXJlZEFycmF5QnVmZmVyKG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIHR5cGVkIGFycmF5XG5cdFx0XHRhdF9zZWxmID0gbmV3IEZsb2F0MzJBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IEZsb2F0MzJBcnJheSh6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KTtcblxuXHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdGF0X3NlbGYuc2V0KGF0X3NyYyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIHNlbGZcblx0XHRzdXBlcihhdF9zZWxmKTtcblxuXHRcdC8vIHNhdmUgZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCBoX3RoaXMpO1xuXHR9XG5cblx0YmFzZSguLi5hX2FyZ3MpIHtcblx0XHRyZXR1cm4gbmV3IEZsb2F0MzJBcnJheSguLi5hX2FyZ3MpO1xuXHR9XG59XG5cbi8vIHN0YXRpYyBmaWVsZFxuT2JqZWN0LmFzc2lnbihGbG9hdDMyQXJyYXlTLnByb3RvdHlwZSwge1xuXHRbc2hhcmluZy4kX1NIQVJFQUJMRV06IDEsXG59KTtcblxuXG5jbGFzcyBGbG9hdDY0QXJyYXlTIGV4dGVuZHMgRmxvYXQ2NEFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmICgnbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGF0X3NlbGYgPSBuZXcgRmxvYXQ2NEFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYgKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBGbG9hdDY0QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmICh1bmRlZmluZWQgPT09IG5sX2FycmF5KSB7XG5cdFx0XHRcdG5sX2FycmF5ID0gel9hcmdfMC5sZW5ndGggLSBuYl9vZmZzZXQ7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFycmF5IHNpemUgaW4gYnl0ZXNcblx0XHRcdGxldCBuYl9hcnJheSA9IG5sX2FycmF5IDw8IDQ7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgRmxvYXQ2NEFycmF5KGRzYiwgMCwgbmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgY29weSBzcmNcblx0XHRcdGxldCBhdF9zcmMgPSBuZXcgRmxvYXQ2NEFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgRmxvYXQ2NEFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKEZsb2F0NjRBcnJheVMucHJvdG90eXBlLCB7XG5cdFtzaGFyaW5nLiRfU0hBUkVBQkxFXTogMSxcbn0pO1xuXG5cblxuLy8gZ2xvYmFsc1xubW9kdWxlLmV4cG9ydHMgPSB7XG5cdGV4cG9ydHM6IHtcblx0XHRBcnJheUJ1ZmZlclM6IFNoYXJlZEFycmF5QnVmZmVyLFxuXHRcdEFycmF5QnVmZmVyVDogQXJyYXlCdWZmZXIsXG5cdFx0SW50OEFycmF5UzogSW50OEFycmF5Uyxcblx0XHRJbnQ4QXJyYXlUOiBJbnQ4QXJyYXksXG5cdFx0VWludDhBcnJheVM6IFVpbnQ4QXJyYXlTLFxuXHRcdFVpbnQ4QXJyYXlUOiBVaW50OEFycmF5LFxuXHRcdFVpbnQ4Q2xhbXBlZEFycmF5UzogVWludDhDbGFtcGVkQXJyYXlTLFxuXHRcdFVpbnQ4Q2xhbXBlZEFycmF5VDogVWludDhDbGFtcGVkQXJyYXksXG5cdFx0SW50MTZBcnJheVM6IEludDE2QXJyYXlTLFxuXHRcdEludDE2QXJyYXlUOiBJbnQxNkFycmF5LFxuXHRcdFVpbnQxNkFycmF5UzogVWludDE2QXJyYXlTLFxuXHRcdFVpbnQxNkFycmF5VDogVWludDE2QXJyYXksXG5cdFx0SW50MzJBcnJheVM6IEludDMyQXJyYXlTLFxuXHRcdEludDMyQXJyYXlUOiBJbnQzMkFycmF5LFxuXHRcdFVpbnQzMkFycmF5UzogVWludDMyQXJyYXlTLFxuXHRcdFVpbnQzMkFycmF5VDogVWludDMyQXJyYXksXG5cdFx0RmxvYXQzMkFycmF5UzogRmxvYXQzMkFycmF5Uyxcblx0XHRGbG9hdDMyQXJyYXlUOiBGbG9hdDMyQXJyYXksXG5cdFx0RmxvYXQ2NEFycmF5UzogRmxvYXQ2NEFycmF5Uyxcblx0XHRGbG9hdDY0QXJyYXlUOiBGbG9hdDY0QXJyYXksXG5cdH0sXG59OyIsImNvbnN0IGV2ZW50cyA9IHJlcXVpcmUoJy4vZXZlbnRzLmpzJyk7XG5jb25zdCBzaGFyaW5nID0gcmVxdWlyZSgnLi9zaGFyaW5nLmpzJyk7XG5cbmNsYXNzIHdvcmtlciBleHRlbmRzIFdvcmtlciB7XG5cblx0cG9zdFBvcnQoZF9wb3J0LCBoX21zZywgYV90cmFuc2Zlcl9wYXRocyA9IFtdKSB7XG5cdFx0Ly8gYXBwZW5kIHBvcnQgdG8gdHJhbnNmZXIgcGF0aHNcblx0XHRhX3RyYW5zZmVyX3BhdGhzLnB1c2goWydwb3J0J10pO1xuXG5cdFx0Ly8gc2VuZFxuXHRcdHRoaXMucG9zdE1lc3NhZ2UoT2JqZWN0LmFzc2lnbih7XG5cdFx0XHRwb3J0OiBkX3BvcnQsXG5cdFx0fSwgaF9tc2cpLCBhX3RyYW5zZmVyX3BhdGhzKTtcblx0fVxuXG5cdHBvc3RNZXNzYWdlKGhfbXNnLCBhX3RyYW5zZmVyX3BhdGhzKSB7XG5cdFx0bGV0IGFfdHJhbnNmZXJzID0gW107XG5cdFx0Zm9yIChsZXQgaV90cmFuc2Zlcl9wYXRoID0gMCwgbmxfdHJhbnNmZXJfcGF0aHMgPSBhX3RyYW5zZmVyX3BhdGhzLmxlbmd0aDsgaV90cmFuc2Zlcl9wYXRoIDwgbmxfdHJhbnNmZXJfcGF0aHM7IGlfdHJhbnNmZXJfcGF0aCsrKSB7XG5cdFx0XHRsZXQgYV9wYXRoID0gYV90cmFuc2Zlcl9wYXRoc1tpX3RyYW5zZmVyX3BhdGhdO1xuXG5cdFx0XHRsZXQgel93YWxrID0gaF9tc2c7XG5cdFx0XHRmb3IgKGxldCBpX3N0ZXAgPSAwLCBubF9wYXRoID0gYV9wYXRoLmxlbmd0aDsgaV9zdGVwIDwgbmxfcGF0aDsgaV9zdGVwKyspIHtcblx0XHRcdFx0el93YWxrID0gel93YWxrW2FfcGF0aFtpX3N0ZXBdXTtcblx0XHRcdH1cblxuXHRcdFx0YV90cmFuc2ZlcnMucHVzaCguLi5zaGFyaW5nLmV4dHJhY3Qoel93YWxrKSk7XG5cdFx0fVxuXG5cdFx0c3VwZXIucG9zdE1lc3NhZ2UoaF9tc2csIGFfdHJhbnNmZXJzKTtcblx0fVxufVxuXG5ldmVudHMod29ya2VyLnByb3RvdHlwZSk7XG5cbm1vZHVsZS5leHBvcnRzID0gd29ya2VyOyIsImNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5cbi8vIGxvY2FsIGNsYXNzZXMgLyBnbG9iYWxzXG5jb25zdCB7XG5cdEtfU0VMRixcblx0RENfV09SS0VSLFxuXHREQ19DSEFOTkVMLFxuXHRIX1RZUEVEX0FSUkFZUyxcblx0Ql9CUk9XU0VSLFxuXHRCX0JST1dTRVJJRlksXG5cdEhQX1dPUktFUl9OT1RJRklDQVRJT04sXG5cdHN0cmVhbSxcblx0d2Vid29ya2VyaWZ5LFxufSA9IHJlcXVpcmUoJy4vYWxsL2xvY2Fscy5qcycpO1xuXG5jb25zdCBkZWRpY2F0ZWQgPSByZXF1aXJlKCcuL2FsbC9kZWRpY2F0ZWQuanMnKTtcbmNvbnN0IG1hbmlmZXN0ID0gcmVxdWlyZSgnLi9hbGwvbWFuaWZlc3QuanMnKTtcbmNvbnN0IHBvb2wgPSByZXF1aXJlKCcuL2FsbC9wb29sLmpzJyk7XG5jb25zdCByZXN1bHQgPSByZXF1aXJlKCcuL2FsbC9yZXN1bHQuanMnKTtcblxuLy8gV29ya2VyIGlzIHN1cHBvcnRlZFxuY29uc3QgQl9XT1JLRVJfU1VQUE9SVEVEID0gKCd1bmRlZmluZWQnICE9PSB0eXBlb2YgRENfV09SS0VSKTtcblxuLy8gY29udGV4dCBiaXRtYXNrc1xuY29uc3QgWE1fQ09OVEVYVF9QUk9DRVNTX1BBUkVOVCA9IDEgPDwgMDtcbmNvbnN0IFhNX0NPTlRFWFRfUFJPQ0VTU19DSElMRCA9IDEgPDwgMTtcbmNvbnN0IFhNX0NPTlRFWFRfV0lORE9XID0gMSA8PCAyO1xuY29uc3QgWE1fQ09OVEVYVF9XT1JLRVJfREVESUNBVEVEID0gMSA8PCAzO1xuY29uc3QgWE1fQ09OVEVYVF9XT1JLRVJfU0VSVklDRSA9IDEgPDwgNDtcbmNvbnN0IFhNX0NPTlRFWFRfV09SS0VSX1NIQVJFRCA9IDEgPDwgNTtcblxuY29uc3QgWE1fQ09OVEVYVF9XT1JLRVIgPSBYTV9DT05URVhUX1dPUktFUl9ERURJQ0FURUQgfCBYTV9DT05URVhUX1dPUktFUl9TRVJWSUNFIHwgWE1fQ09OVEVYVF9XT1JLRVJfU0hBUkVEO1xuXG4vLyBzZXQgdGhlIGN1cnJlbnQgY29udGV4dFxuY29uc3QgWF9DT05URVhUX1RZUEUgPSAhQl9CUk9XU0VSID9cblx0KHByb2Nlc3MuZW52LldPUktFUl9ERVBUSCA/IFhNX0NPTlRFWFRfUFJPQ0VTU19DSElMRCA6IFhNX0NPTlRFWFRfUFJPQ0VTU19QQVJFTlQpIDpcblx0KCd1bmRlZmluZWQnICE9PSB0eXBlb2YgZG9jdW1lbnQgP1xuXHRcdFhNX0NPTlRFWFRfV0lORE9XIDpcblx0XHQoJ0RlZGljYXRlZFdvcmtlckdsb2JhbFNjb3BlJyBpbiBzZWxmID9cblx0XHRcdFhNX0NPTlRFWFRfV09SS0VSX0RFRElDQVRFRCA6XG5cdFx0XHQoJ1NoYXJlZFdvcmtlckdsb2JhbFNjb3BlJyBpbiBzZWxmID9cblx0XHRcdFx0WE1fQ09OVEVYVF9XT1JLRVJfU0hBUkVEIDpcblx0XHRcdFx0KCdTZXJ2aWNlV29ya2VyR2xvYmFsU2NvcGUnIGluIHNlbGYgP1xuXHRcdFx0XHRcdFhNX0NPTlRFWFRfV09SS0VSX1NFUlZJQ0UgOlxuXHRcdFx0XHRcdDApKSkpO1xuXG4vLyB1bnJlY29nbml6ZWQgY29udGV4dFxuaWYgKCFYX0NPTlRFWFRfVFlQRSkge1xuXHR0aHJvdyBuZXcgRXJyb3IoJ2ZhaWxlZCB0byBkZXRlcm1pbmUgd2hhdCBpcyB0aGUgY3VycmVudCBlbnZpcm9ubWVudC9jb250ZXh0Jyk7XG59XG5cbi8vIHNwYXducyBhIFdvcmtlclxubGV0IHNwYXduX3dvcmtlciA9IEJfV09SS0VSX1NVUFBPUlRFRCA/XG5cdCghQl9CUk9XU0VSSUZZID9cblx0XHQocF9zb3VyY2UsIGhfb3B0aW9ucykgPT4gbmV3IERDX1dPUktFUihwX3NvdXJjZSwgaF9vcHRpb25zKSA6XG5cdFx0KHBfc291cmNlLCBoX29wdGlvbnMpID0+IHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoYEZhdGFsIGVycm9yOiBzaW5jZSB5b3UgYXJlIHVzaW5nIGJyb3dzZXJpZnksIHlvdSBuZWVkIHRvIGluY2x1ZGUgZXhwbGljaXQgJ3JlcXVpcmUoKScgc3RhdGVtZW50cyBmb3IgYW55IHNjcmlwdHMgeW91IGludGVuZCB0byBzcGF3biBhcyB3b3JrZXJzIGZyb20gdGhpcyB0aHJlYWRgKTtcblx0XHRcdGNvbnNvbGUud2FybihgdHJ5IHVzaW5nIHRoZSBmb2xsb3dpbmcgaW5zdGVhZDpcXG5cXG5jb25zdCB3b3JrZXIgPSByZXF1aXJlKCd3b3JrZXInKS5zY29waWZ5KHJlcXVpcmUsICgpID0+IHtcXG5gICtcblx0XHRcdFx0YFxcdHJlcXVpcmUoJyR7cF9zb3VyY2V9Jyk7XFxuXFx0Ly8gLi4uIGFuZCBhbnkgb3RoZXIgc2NyaXB0cyB5b3Ugd2lsbCBzcGF3biBmcm9tIHRoaXMgdGhyZWFkXFxuYCArXG5cdFx0XHRcdGB9LCAndW5kZWZpbmVkJyAhPT0gdHlwZW9mIGFyZ3VtZW50cyAmJiBhcmd1bWVudHMpO2ApO1xuXG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBzcGF3biB3b3JrZXIgJyR7cF9zb3VyY2V9J2ApO1xuXHRcdH0pIDpcblx0KHBfc291cmNlLCBoX29wdGlvbnMpID0+IHtcblx0XHQvLyB3ZSdyZSBpbnNpZGUgYSB3b3JrZXJcblx0XHRpZiAoWF9DT05URVhUX1RZUEUgJiBYTV9DT05URVhUX1dPUktFUikge1xuXHRcdFx0Y29uc29sZS5lcnJvcihgRmF0YWwgZXJyb3I6IGJyb3dzZXIgZG9lcyBub3Qgc3VwcG9ydCBzdWJ3b3JrZXJzOyBmYWlsZWQgdG8gc3Bhd24gJyR7cF9zb3VyY2V9J1xcbmAgK1xuXHRcdFx0XHQnRm9ydHVuYXRlbHkgd29ya2VyLmpzIGhhcyBhIHNvbHV0aW9uICA7KScpO1xuXHRcdFx0Y29uc29sZS53YXJuKGB0cnkgdXNpbmcgdGhlIGZvbGxvd2luZyBpbiB5b3VyIHdvcmtlciBzY3JpcHQgdG8gc3VwcG9ydCBzdWJ3b3JrZXJzOlxcblxcbmAgK1xuXHRcdFx0XHRgY29uc3Qgd29ya2VyID0gcmVxdWlyZSgnd29ya2VyJykuc2NvcGlmeShyZXF1aXJlLCAoKSA9PiB7XFxuYCArXG5cdFx0XHRcdGBcXHRyZXF1aXJlKCcke3Bfc291cmNlfScpO1xcbmAgK1xuXHRcdFx0XHRgXFx0Ly8gLi4uIGFuZCBhbnkgb3RoZXIgc2NyaXB0cyB5b3Ugd2lsbCBzcGF3biBmcm9tIHRoaXMgdGhyZWFkXFxuYCArXG5cdFx0XHRcdGB9LCAndW5kZWZpbmVkJyAhPT0gdHlwZW9mIGFyZ3VtZW50cyAmJiBhcmd1bWVudHMpO2ApO1xuXHRcdH1cblxuXHRcdHRocm93IG5ldyBFcnJvcihgQ2Fubm90IHNwYXduIHdvcmtlciAke3Bfc291cmNlfTsgJ1dvcmtlcicgaXMgdW5kZWZpbmVkYCk7XG5cdH07XG5cblxubGV0IGlfZ3VpZCA9IDA7XG5cbmNsYXNzIHdvcmtlciBleHRlbmRzIHN0cmVhbS5oYW5kbGVyIHtcblx0c3RhdGljIGZyb21fc291cmNlKHBfc291cmNlKSB7XG5cdFx0cmV0dXJuIG5ldyB3b3JrZXIoe1xuXHRcdFx0c291cmNlOiBwX3NvdXJjZSxcblx0XHR9KTtcblx0fVxuXG5cdGNvbnN0cnVjdG9yKGhfY29uZmlnKSB7XG5cdFx0c3VwZXIoKTtcblxuXHRcdGxldCB7XG5cdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdFx0aWQ6IGlfaWQgPSAtMSxcblx0XHRcdG1hc3Rlcjoga19tYXN0ZXIgPSBudWxsLFxuXHRcdFx0b3B0aW9uczogaF9vcHRpb25zID0ge30sXG5cdFx0fSA9IGhfY29uZmlnO1xuXG5cdFx0Ly8gcmVzb2x2ZSBzb3VyY2UgcmVsYXRpdmUgdG8gbWFzdGVyXG5cdFx0bGV0IHBhX3NvdXJjZSA9IEJfQlJPV1NFUiA/XG5cdFx0XHRwX3NvdXJjZSA6XG5cdFx0XHRwYXRoLnJlc29sdmUocGF0aC5kaXJuYW1lKG1vZHVsZS5wYXJlbnQuZmlsZW5hbWUpLCBwX3NvdXJjZSk7XG5cblx0XHQvLyBtYWtlIHdvcmtlclxuXHRcdGxldCBkX3dvcmtlcjtcblx0XHR0cnkge1xuXHRcdFx0ZF93b3JrZXIgPSBzcGF3bl93b3JrZXIocGFfc291cmNlLCBoX29wdGlvbnMpO1xuXHRcdH0gY2F0Y2ggKGVfc3Bhd24pIHtcblx0XHRcdGxldCBlX21zZyA9IG5ldyBFcnJvcignZmFpbGVkIHRvIHNwYXduIHdvcmtlcjogJyk7XG5cdFx0XHRlX21zZy5zdGFjayA9IGVfc3Bhd24uc3RhY2s7XG5cdFx0XHR0aHJvdyBlX21zZztcblx0XHR9XG5cblx0XHRkX3dvcmtlci5ldmVudHMoe1xuXHRcdFx0ZXJyb3IoZV93b3JrZXIpIHtcblx0XHRcdFx0aWYgKGVfd29ya2VyIGluc3RhbmNlb2YgRXJyb3JFdmVudCkge1xuXHRcdFx0XHRcdGlmICgnbGluZW5vJyBpbiBlX3dvcmtlciAmJiAnc291cmNlJyBpbiBkX3dvcmtlcikge1xuXHRcdFx0XHRcdFx0bGV0IGFfbGluZXMgPSBkX3dvcmtlci5zb3VyY2Uuc3BsaXQoJ1xcbicpO1xuXHRcdFx0XHRcdFx0bGV0IGlfbGluZV9lcnIgPSBlX3dvcmtlci5saW5lbm87XG5cdFx0XHRcdFx0XHRsZXQgYV9kZWJ1ZyA9IGFfbGluZXMuc2xpY2UoTWF0aC5tYXgoMCwgaV9saW5lX2VyciAtIDIpLCBNYXRoLm1pbihhX2xpbmVzLmxlbmd0aCAtIDEsIGlfbGluZV9lcnIgKyAyKSlcblx0XHRcdFx0XHRcdFx0Lm1hcCgoc19saW5lLCBpX2xpbmUpID0+ICgxID09PSBpX2xpbmUgPyAnKicgOiAnICcpICsgKChpX2xpbmVfZXJyICsgaV9saW5lIC0gMSkgKyAnJykucGFkU3RhcnQoNSkgKyAnOiAnICsgc19saW5lKTtcblxuXHRcdFx0XHRcdFx0Ly8gcmVjcmVhdGUgZXJyb3IgbWVzc2FnZVxuXHRcdFx0XHRcdFx0ZV93b3JrZXIgPSBuZXcgRXJyb3IoZV93b3JrZXIubWVzc2FnZSArIGBFcnJvciB0aHJvd24gaW4gd29ya2VyOlxcbiR7YV9kZWJ1Zy5qb2luKCdcXG4nKX1gKTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRpZiAodGhpcy50YXNrX2Vycm9yKSB7XG5cdFx0XHRcdFx0XHR0aGlzLnRhc2tfZXJyb3IoZV93b3JrZXIpO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHR0aHJvdyBlX3dvcmtlcjtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gZWxzZSBpZiAodGhpcy50YXNrX2Vycm9yKSB7XG5cdFx0XHRcdFx0dGhpcy50YXNrX2Vycm9yKGVfd29ya2VyKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYGFuIGVycm9yIG9jY3VyZWQgb24gd29ya2VyLi4uIGJ1dCB0aGUgJ2Vycm9yJyBldmVudCBjYWxsYmFjayBkaWQgbm90IHJlY2VpdmUgYW4gRXJyb3JFdmVudCBvYmplY3QhIHRyeSBpbnNwZWN0aW5nIGNvbnNvbGVgKTtcblx0XHRcdFx0fVxuXHRcdFx0fSxcblxuXHRcdFx0Ly8gd2hlbiB0aGVyZSBpcyBhbiBlcnJvciBjcmVhdGluZy9jb21tdW5pY2F0aW5nIHdpdGggd29ya2VyXG5cdFx0XHRtZXNzYWdlZXJyb3I6IChlX2FjdGlvbikgPT4ge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoZV9hY3Rpb24pO1xuXHRcdFx0fSxcblxuXHRcdFx0Ly8gd2hlbiBhIHdvcmtlciByZXNwb25kc1xuXHRcdFx0bWVzc2FnZTogKGRfbXNnKSA9PiB7XG5cdFx0XHRcdGxldCBoX21zZyA9IGRfbXNnLmRhdGE7XG5cblx0XHRcdFx0Ly8gaGFuZGxlIG1lc3NhZ2Vcblx0XHRcdFx0bGV0IHNfaGFuZGxlID0gJ2hhbmRsZV8nICsgaF9tc2cudHlwZTtcblx0XHRcdFx0aWYgKHNfaGFuZGxlIGluIHRoaXMpIHtcblx0XHRcdFx0XHR0aGlzW3NfaGFuZGxlXShoX21zZyk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGB3b3JrZXIgc2VudCBhIG1lc3NhZ2UgdGhhdCBoYXMgbm8gZGVmaW5lZCBoYW5kbGVyOiAnJHtoX21zZy50eXBlfSdgKTtcblx0XHRcdFx0fVxuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0c291cmNlOiBwX3NvdXJjZSxcblx0XHRcdGlkOiBpX2lkLFxuXHRcdFx0bWFzdGVyOiBrX21hc3Rlcixcblx0XHRcdHBvcnQ6IGRfd29ya2VyLFxuXHRcdFx0YnVzeTogZmFsc2UsXG5cdFx0XHRhdmFpbGFibGU6IHRydWUsXG5cdFx0XHR0YXNrc19hc3NpZ25lZDogMCxcblx0XHRcdGNhbGxiYWNrczoge30sXG5cdFx0XHRldmVudHM6IHt9LFxuXHRcdFx0c3Vid29ya2VyczogW10sXG5cdFx0XHR0YXNrX2Vycm9yOiBudWxsLFxuXHRcdH0pO1xuXHR9XG5cblx0ZGVidWcoc190eXBlLCAuLi5hX2luZm8pIHtcblx0XHQvLyBjb25zb2xlLndhcm4oYE0ke1N0cmluZy5mcm9tQ2hhckNvZGUoNjUrdGhpcy5pZCl9ICR7c190eXBlfSAke2FfaW5mby5sZW5ndGg/ICcoJythX2luZm8uam9pbignLCAnKSsnKSc6ICctJ31gKTtcblx0fVxuXG5cdGhhbmRsZV9jbG9zZV9zZXJ2ZXIoaF9tc2cpIHtcblx0XHREQ19DSEFOTkVMLmtpbGwoaF9tc2cuc2VydmVyKTtcblx0fVxuXG5cdGhhbmRsZV9yZXNwb25kKGhfbXNnKSB7XG5cdFx0bGV0IGhfY2FsbGJhY2tzID0gdGhpcy5jYWxsYmFja3M7XG5cblx0XHQvLyBubyBsb25nZXIgYnVzeVxuXHRcdHRoaXMuYnVzeSA9IGZhbHNlO1xuXG5cdFx0Ly8gZ3JhYiB0YXNrIGlkXG5cdFx0bGV0IGlfdGFzayA9IGhfbXNnLmlkO1xuXG5cdFx0dGhpcy5kZWJ1ZygnPDwgcmVzcG9uZCcsIGlfdGFzayk7XG5cblx0XHQvLyBleGVjdXRlIGNhbGxiYWNrXG5cdFx0aF9jYWxsYmFja3NbaV90YXNrXShoX21zZy5kYXRhLCBpX3Rhc2ssIHRoaXMpO1xuXG5cdFx0Ly8gZnJlZSBjYWxsYmFja1xuXHRcdGRlbGV0ZSBoX2NhbGxiYWNrc1tpX3Rhc2tdO1xuXHR9XG5cblx0aGFuZGxlX25vdGlmeShoX21zZykge1xuXHRcdGhfbXNnLmRhdGEgPSBIUF9XT1JLRVJfTk9USUZJQ0FUSU9OO1xuXG5cdFx0Ly8gbm8gbG9uZ2VyIGJ1c3lcblx0XHR0aGlzLmJ1c3kgPSBmYWxzZTtcblxuXHRcdHRoaXMuZGVidWcoJzw8IG5vdGlmeScpO1xuXG5cdFx0dGhpcy5oYW5kbGVfcmVzcG9uZChoX21zZyk7XG5cdH1cblxuXHRoYW5kbGVfZXZlbnQoaF9tc2cpIHtcblx0XHQvLyBldmVudCBpcyBndWFyYW50ZWVkIHRvIGJlIGhlcmU7IGp1c3QgY2FsbGJhY2sgd2l0aCBkYXRhXG5cdFx0dGhpcy5ldmVudHNbaF9tc2cuaWRdW2hfbXNnLmV2ZW50XSguLi5oX21zZy5hcmdzKTtcblx0fVxuXG5cdGhhbmRsZV9lcnJvcihoX21zZykge1xuXHRcdGxldCBoX2Vycm9yID0gaF9tc2cuZXJyb3I7XG5cdFx0bGV0IGVfbXNnID0gbmV3IEVycm9yKGhfZXJyb3IubWVzc2FnZSk7XG5cdFx0ZV9tc2cuc3RhY2sgPSBoX2Vycm9yLnN0YWNrO1xuXG5cdFx0aWYgKHRoaXMudGFza19lcnJvcikge1xuXHRcdFx0dGhpcy50YXNrX2Vycm9yKGVfbXNnKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhyb3cgZV9tc2c7XG5cdFx0fVxuXHR9XG5cblx0aGFuZGxlX3NwYXduKGhfbXNnKSB7XG5cdFx0bGV0IHBfc291cmNlID0gcGF0aC5qb2luKHBhdGguZGlybmFtZSh0aGlzLnNvdXJjZSksIGhfbXNnLnNvdXJjZSk7XG5cdFx0aWYgKCcvJyAhPT0gcF9zb3VyY2VbMF0pIHBfc291cmNlID0gJy4vJyArIHBfc291cmNlO1xuXG5cdFx0cF9zb3VyY2UgPSBoX21zZy5zb3VyY2U7XG5cdFx0bGV0IGRfc3Vid29ya2VyID0gc3Bhd25fd29ya2VyKHBfc291cmNlKTtcblx0XHRsZXQgaV9zdWJ3b3JrZXIgPSB0aGlzLnN1YndvcmtlcnMucHVzaChkX3N1YndvcmtlcikgLSAxO1xuXG5cdFx0ZF9zdWJ3b3JrZXIuZXZlbnQoJ2Vycm9yJywgKGVfd29ya2VyKSA9PiB7XG5cdFx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0XHR0eXBlOiAnc3Vid29ya2VyX2Vycm9yJyxcblx0XHRcdFx0ZXJyb3I6IHtcblx0XHRcdFx0XHRtZXNzYWdlOiBlX3dvcmtlci5tZXNzYWdlLFxuXHRcdFx0XHRcdGZpbGVuYW1lOiBlX3dvcmtlci5maWxlbmFtZSxcblx0XHRcdFx0XHRsaW5lbm86IGVfd29ya2VyLmxpbmVubyxcblx0XHRcdFx0fSxcblx0XHRcdH0pO1xuXHRcdH0pO1xuXG5cdFx0bGV0IGtfY2hhbm5lbCA9IG5ldyBEQ19DSEFOTkVMKCk7XG5cblx0XHRrX2NoYW5uZWwucG9ydF8xKChkX3BvcnQpID0+IHtcblx0XHRcdHRoaXMucG9ydC5wb3N0UG9ydChkX3BvcnQsIHtcblx0XHRcdFx0dHlwZTogJ3N1YndvcmtlcicsXG5cdFx0XHRcdGlkOiBoX21zZy5pZCxcblx0XHRcdFx0bWFzdGVyX2tleTogaV9zdWJ3b3JrZXIsXG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdGtfY2hhbm5lbC5wb3J0XzIoKGRfcG9ydCkgPT4ge1xuXHRcdFx0ZF9zdWJ3b3JrZXIucG9zdFBvcnQoZF9wb3J0LCB7XG5cdFx0XHRcdHR5cGU6ICdvd25lcicsXG5cdFx0XHR9KTtcblx0XHR9KTtcblx0fVxuXG5cdGhhbmRsZV9waW5nKCkge1xuXHRcdEtfU0VMRi5wb3N0TWVzc2FnZSh7XG5cdFx0XHR0eXBlOiAncG9uZycsXG5cdFx0fSk7XG5cdH1cblxuXHRoYW5kbGVfdGVybWluYXRlKGhfbXNnKSB7XG5cdFx0dGhpcy5zdWJ3b3JrZXJzW2hfbXNnLm1hc3Rlcl9rZXldLnRlcm1pbmF0ZSgpO1xuXHR9XG5cblx0cHJlcGFyZShoX3Rhc2ssIGZrX3Rhc2ssIGFfcm9vdHMgPSBbXSkge1xuXHRcdGxldCBpX3Rhc2sgPSArK2lfZ3VpZDtcblxuXHRcdGxldCB7XG5cdFx0XHR0YXNrOiBzX3Rhc2ssXG5cdFx0XHRtYW5pZmVzdDoga19tYW5pZmVzdCxcblx0XHRcdHJlY2VpdmU6IGlfcmVjZWl2ZSA9IDAsXG5cdFx0XHRpbmhlcml0OiBpX2luaGVyaXQgPSAwLFxuXHRcdFx0aG9sZDogYl9ob2xkID0gZmFsc2UsXG5cdFx0XHRldmVudHM6IGhfZXZlbnRzID0gbnVsbCxcblx0XHR9ID0gaF90YXNrO1xuXG5cdFx0Ly8gc2F2ZSBjYWxsYmFja1xuXHRcdHRoaXMuY2FsbGJhY2tzW2lfdGFza10gPSBma190YXNrO1xuXG5cdFx0Ly8gc2F2ZSBldmVudHNcblx0XHRpZiAoaF9ldmVudHMpIHtcblx0XHRcdHRoaXMuZXZlbnRzW2lfdGFza10gPSBoX2V2ZW50cztcblxuXHRcdFx0Ly8gd2hhdCB0byBzZW5kXG5cdFx0XHRsZXQgaF9ldmVudHNfc2VuZCA9IHt9O1xuXHRcdFx0Zm9yIChsZXQgc19rZXkgaW4gaF9ldmVudHMpIHtcblx0XHRcdFx0aF9ldmVudHNfc2VuZFtzX2tleV0gPSAxO1xuXHRcdFx0fVxuXHRcdFx0aF9ldmVudHMgPSBoX2V2ZW50c19zZW5kO1xuXHRcdH1cblxuXHRcdC8vIHNlbmQgdGFza1xuXHRcdHJldHVybiB7XG5cdFx0XHRtc2c6IHtcblx0XHRcdFx0dHlwZTogJ3Rhc2snLFxuXHRcdFx0XHRpZDogaV90YXNrLFxuXHRcdFx0XHR0YXNrOiBzX3Rhc2ssXG5cdFx0XHRcdGFyZ3M6IGtfbWFuaWZlc3QuZGF0YSxcblx0XHRcdFx0cmVjZWl2ZTogaV9yZWNlaXZlLFxuXHRcdFx0XHRpbmhlcml0OiBpX2luaGVyaXQsXG5cdFx0XHRcdGhvbGQ6IGJfaG9sZCxcblx0XHRcdFx0ZXZlbnRzOiBoX2V2ZW50cyxcblx0XHRcdH0sXG5cdFx0XHRwYXRoczoga19tYW5pZmVzdC5wYXRocyguLi5hX3Jvb3RzLCAnYXJncycpLFxuXHRcdH07XG5cdH1cblxuXHRleGVjKGhfdGFza19leGVjLCBma190YXNrKSB7XG5cdFx0Ly8gbWFyayB3b3JrZXIgYXMgYnVzeVxuXHRcdHRoaXMuYnVzeSA9IHRydWU7XG5cblx0XHQvLyBwcmVwYXJlIGZpbmFsIHRhc2sgZGVzY3JpcHRvclxuXHRcdGxldCBoX3Rhc2sgPSB0aGlzLnByZXBhcmUoaF90YXNrX2V4ZWMsIGZrX3Rhc2spO1xuXG5cdFx0dGhpcy5kZWJ1ZygnZXhlYzonICsgaF90YXNrLm1zZy5pZCk7XG5cblx0XHQvLyBwb3N0IHRvIHdvcmtlclxuXHRcdHRoaXMucG9ydC5wb3N0TWVzc2FnZShoX3Rhc2subXNnLCBoX3Rhc2sucGF0aHMpO1xuXHR9XG5cblx0Ly8gYXNzaWduIGEgdGFzayB0byB0aGUgd29ya2VyXG5cdHJ1bihzX3Rhc2ssIHpfYXJncywgaF9ldmVudHMsIGZrX3J1bikge1xuXHRcdC8vIHByZXBhcmUgZmluYWwgdGFzayBkZXNjcmlwdG9yXG5cdFx0bGV0IGhfZXhlYyA9IHtcblx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHRcdG1hbmlmZXN0OiBtYW5pZmVzdC5mcm9tKHpfYXJncyksXG5cdFx0XHRldmVudHM6IGhfZXZlbnRzLFxuXHRcdH07XG5cblx0XHQvLyBwcmV2aW91cyBydW4gdGFza1xuXHRcdGlmICh0aGlzLnByZXZfcnVuX3Rhc2spIHtcblx0XHRcdGhfZXhlYy5pbmhlcml0ID0gdGhpcy5wcmV2X3J1bl90YXNrO1xuXHRcdH1cblxuXHRcdC8vIGV4ZWN1dGUgdGFza1xuXHRcdGxldCBkcF9leGVjID0gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSwgZl9yZWplY3QpID0+IHtcblx0XHRcdHRoaXMudGFza19lcnJvciA9IGZfcmVqZWN0O1xuXHRcdFx0dGhpcy5leGVjKGhfZXhlYywgKHpfcmVzdWx0LCBpX3Rhc2spID0+IHtcblx0XHRcdFx0dGhpcy5wcmV2X3J1bl90YXNrID0gaV90YXNrO1xuXHRcdFx0XHR0aGlzLnRhc2tfZXJyb3IgPSBudWxsO1xuXHRcdFx0XHRmX3Jlc29sdmUoel9yZXN1bHQpO1xuXHRcdFx0fSk7XG5cdFx0fSk7XG5cblx0XHQvLyBlbWJlZGRlZCByZXNvbHZlL3JlamVjdFxuXHRcdGlmICgnZnVuY3Rpb24nID09PSB0eXBlb2YgZmtfcnVuKSB7XG5cdFx0XHRkcF9leGVjLnRoZW4oKHpfcmVzdWx0KSA9PiB7XG5cdFx0XHRcdGZrX3J1bihudWxsLCB6X3Jlc3VsdCk7XG5cdFx0XHR9KS5jYXRjaCgoZV9leGVjKSA9PiB7XG5cdFx0XHRcdGZrX3J1bihlX2V4ZWMpO1xuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdC8vIHByb21pc2Vcblx0XHRlbHNlIHtcblx0XHRcdHJldHVybiBkcF9leGVjO1xuXHRcdH1cblx0fVxuXG5cdHJlY2VpdmUoZF9wb3J0LCBoX3JlY2VpdmUsIGZrX3Rhc2spIHtcblx0XHRsZXQgaF90YXNrID0gdGhpcy5wcmVwYXJlKGhfcmVjZWl2ZS50YXNrX3JlYWR5LCBma190YXNrLCBbJ3Rhc2tfcmVhZHknXSk7XG5cblx0XHR0aGlzLmRlYnVnKCc+PiByZWNlaXZlOicgKyBoX3JlY2VpdmUuaW1wb3J0LCBoX3Rhc2subXNnLmlkLCBkX3BvcnQubmFtZSk7XG5cblx0XHR0aGlzLnBvcnQucG9zdFBvcnQoZF9wb3J0LCB7XG5cdFx0XHR0eXBlOiAncmVjZWl2ZScsXG5cdFx0XHRpbXBvcnQ6IGhfcmVjZWl2ZS5pbXBvcnQsXG5cdFx0XHRwcmltYXJ5OiBoX3JlY2VpdmUucHJpbWFyeSxcblx0XHRcdHRhc2tfcmVhZHk6IGhfdGFzay5tc2csXG5cdFx0fSwgWy4uLihoX3Rhc2sucGF0aHMgfHwgW10pXSk7XG5cdH1cblxuXHRyZWxheShpX3Rhc2tfc2VuZGVyLCBkX3BvcnQsIHNfcmVjZWl2ZXIpIHtcblx0XHR0aGlzLmRlYnVnKCc+PiByZWxheScsIGlfdGFza19zZW5kZXIsIGRfcG9ydC5uYW1lKTtcblxuXHRcdHRoaXMucG9ydC5wb3N0UG9ydChkX3BvcnQsIHtcblx0XHRcdHR5cGU6ICdyZWxheScsXG5cdFx0XHRpZDogaV90YXNrX3NlbmRlcixcblx0XHR9KTtcblx0fVxuXG5cdGtpbGwoc19raWxsKSB7XG5cdFx0aWYgKEJfQlJPV1NFUikge1xuXHRcdFx0cmV0dXJuIG5ldyBQcm9taXNlKChmX3Jlc29sdmUpID0+IHtcblx0XHRcdFx0dGhpcy5wb3J0LnRlcm1pbmF0ZSgpO1xuXHRcdFx0XHRmX3Jlc29sdmUoKTtcblx0XHRcdH0pO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRyZXR1cm4gdGhpcy5wb3J0LnRlcm1pbmF0ZShzX2tpbGwpO1xuXHRcdH1cblx0fVxufVxuXG5cbmNvbnN0IG1rX25ldyA9IChkYykgPT4gZnVuY3Rpb24oLi4uYV9hcmdzKSB7XG5cdHJldHVybiBuZXcgZGMoLi4uYV9hcmdzKTtcbn07XG5cbi8vIG5vdyBpbXBvcnQgYW55aGluZyB0aGF0IGRlcGVuZHMgb24gd29ya2VyXG5jb25zdCBncm91cCA9IHJlcXVpcmUoJy4vYWxsL2dyb3VwLmpzJykod29ya2VyKTtcblxuY29uc3QgSF9FWFBPUlRTID0ge1xuXHRzcGF3biguLi5hX2FyZ3MpIHtcblx0XHRyZXR1cm4gd29ya2VyLmZyb21fc291cmNlKC4uLmFfYXJncyk7XG5cdH0sXG5cblx0bmV3OiAoLi4uYV9hcmdzKSA9PiBuZXcgd29ya2VyKC4uLmFfYXJncyksXG5cdGdyb3VwOiBta19uZXcoZ3JvdXApLFxuXHRwb29sOiBta19uZXcocG9vbCksXG5cdGRlZGljYXRlZDogbWtfbmV3KGRlZGljYXRlZCksXG5cdG1hbmlmZXN0OiBta19uZXcobWFuaWZlc3QpLFxuXHRyZXN1bHQ6IG1rX25ldyhyZXN1bHQpLFxuXHQvLyBzdHJlYW06IG1rX25ldyh3cml0YWJsZV9zdHJlYW0pLFxuXG5cdC8vIHN0YXRlc1xuXHRicm93c2VyOiBCX0JST1dTRVIsXG5cdGJyb3dzZXJpZnk6IEJfQlJPV1NFUklGWSxcblx0Ly8gZGVwdGg6IFdPUktFUl9ERVBUSFxuXG5cdC8vIGltcG9ydCB0eXBlZCBhcnJheXMgaW50byB0aGUgZ2l2ZW4gc2NvcGVcblx0Z2xvYmFsczogKGhfc2NvcGUgPSB7fSkgPT4gT2JqZWN0LmFzc2lnbihoX3Njb3BlLCBIX1RZUEVEX0FSUkFZUy5leHBvcnRzKSxcblxuXHQvLyBmb3IgY29tcGF0aWJpbGl0eSB3aXRoIGJyb3dzZXJpZnlcblx0c2NvcGlmeShmX3JlcXVpcmUsIGFfc291cmNlcywgZF9hcmd1bWVudHMpIHtcblx0XHQvLyBicm93c2VyaWZ5IGFyZ3VtZW50c1xuXHRcdGxldCBhX2Jyb3dzZXJpZnkgPSBkX2FyZ3VtZW50cyA/IFtkX2FyZ3VtZW50c1szXSwgZF9hcmd1bWVudHNbNF0sIGRfYXJndW1lbnRzWzVdXSA6IG51bGw7XG5cblx0XHQvLyBydW5uaW5nIGluIGJyb3dzZXJpZnlcblx0XHRpZiAoQl9CUk9XU0VSSUZZKSB7XG5cdFx0XHQvLyBjaGFuZ2UgaG93IGEgd29ya2VyIGlzIHNwYXduZWRcblx0XHRcdHNwYXduX3dvcmtlciA9IChwX3NvdXJjZSwgaF9vcHRpb25zKSA9PiB7XG5cdFx0XHRcdC8vIHdvcmthcm91bmQgZm9yIGNocm9taXVtIGJ1ZyB0aGF0IGNhbm5vdCBzcGF3biBzdWJ3b3JrZXJzXG5cdFx0XHRcdGlmICghQl9XT1JLRVJfU1VQUE9SVEVEKSB7XG5cdFx0XHRcdFx0bGV0IGtfc3Vid29ya2VyID0gbmV3IGxhdGVudF9zdWJ3b3JrZXIoKTtcblxuXHRcdFx0XHRcdC8vIHNlbmQgbWVzc2FnZSB0byBtYXN0ZXIgcmVxdWVzdGluZyBzcGF3biBvZiBuZXcgd29ya2VyXG5cdFx0XHRcdFx0S19TRUxGLnBvc3RNZXNzYWdlKHtcblx0XHRcdFx0XHRcdHR5cGU6ICdzcGF3bicsXG5cdFx0XHRcdFx0XHRpZDoga19zdWJ3b3JrZXIuaWQsXG5cdFx0XHRcdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdFx0XHRcdFx0b3B0aW9uczogaF9vcHRpb25zLFxuXHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0cmV0dXJuIGtfc3Vid29ya2VyO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIHdvcmtlciBpcyBkZWZpbmVkXG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdGxldCB6X2ltcG9ydCA9IGZfcmVxdWlyZShwX3NvdXJjZSk7XG5cdFx0XHRcdFx0cmV0dXJuIHdlYndvcmtlcmlmeSh6X2ltcG9ydCwge1xuXHRcdFx0XHRcdFx0YnJvd3NlcmlmeTogYV9icm93c2VyaWZ5LFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdC8vIG5vcm1hbCBleHBvcnRzXG5cdFx0cmV0dXJuIEhfRVhQT1JUUztcblx0fSxcblxuXHQvLyBnZXQgc3RyZWFtKCkge1xuXHQvLyBcdGRlbGV0ZSB0aGlzLnN0cmVhbTtcblx0Ly8gXHRyZXR1cm4gdGhpcy5zdHJlYW0gPSByZXF1aXJlKCcuL3N0cmVhbS5qcycpO1xuXHQvLyB9LFxuXG5cdG1lcmdlX3NvcnRlZChhX2EsIGFfYiwgZl9jbXApIHtcblx0XHQvLyBvdXRwdXQgbGlzdFxuXHRcdGxldCBhX291dCA9IFtdO1xuXG5cdFx0Ly8gaW5kZXggb2YgbmV4dCBpdGVtIGZyb20gZWFjaCBsaXN0XG5cdFx0bGV0IGlfYSA9IDA7XG5cdFx0bGV0IGlfYiA9IDA7XG5cblx0XHQvLyBjdXJyZW50IGl0ZW0gZnJvbSBlYWNoIGxpc3Rcblx0XHRsZXQgel9hID0gYV9hWzBdO1xuXHRcdGxldCB6X2IgPSBhX2JbMF07XG5cblx0XHQvLyBmaW5hbCBpbmRleCBvZiBlYWNoIGxpc3Rcblx0XHRsZXQgaWhfYSA9IGFfYS5sZW5ndGggLSAxO1xuXHRcdGxldCBpaF9iID0gYV9iLmxlbmd0aCAtIDE7XG5cblx0XHQvLyBtZXJnZVxuXHRcdGZvciAoOzspIHtcblx0XHRcdC8vIGEgd2luc1xuXHRcdFx0aWYgKGZfY21wKHpfYSwgel9iKSA8IDApIHtcblx0XHRcdFx0Ly8gYWRkIHRvIG91dHB1dCBsaXN0XG5cdFx0XHRcdGFfb3V0LnB1c2goel9hKTtcblxuXHRcdFx0XHQvLyByZWFjaGVkIGVuZCBvZiBhXG5cdFx0XHRcdGlmIChpX2EgPT09IGloX2EpIGJyZWFrO1xuXG5cdFx0XHRcdC8vIG5leHQgaXRlbSBmcm9tIGFcblx0XHRcdFx0el9hID0gYV9hWysraV9hXTtcblx0XHRcdH1cblx0XHRcdC8vIGIgd2luc1xuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdC8vIGFkZCB0byBvdXRwdXQgbGlzdFxuXHRcdFx0XHRhX291dC5wdXNoKHpfYik7XG5cblx0XHRcdFx0Ly8gcmVhY2hlZCBlbmQgb2YgYlxuXHRcdFx0XHRpZiAoaV9iID09PSBpaF9iKSBicmVhaztcblxuXHRcdFx0XHQvLyBuZXh0IGl0ZW0gZnJvbSBiXG5cdFx0XHRcdHpfYiA9IGFfYlsrK2lfYl07XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gYSBmaW5pc2hlZCBmaXJzdFxuXHRcdGlmIChpX2EgPT09IGloX2EpIHtcblx0XHRcdC8vIGFwcGVuZCByZW1haW5kZXIgb2YgYlxuXHRcdFx0YV9vdXQucHVzaChhX2Iuc2xpY2UoaV9iKSk7XG5cdFx0fVxuXHRcdC8vIGIgZmluaXNoZWQgZmlyc3Rcblx0XHRlbHNlIHtcblx0XHRcdC8vIGFwcGVuZCByZW1haW5kZXIgb2YgYVxuXHRcdFx0YV9vdXQucHVzaChhX2Euc2xpY2UoaV9hKSk7XG5cdFx0fVxuXG5cdFx0Ly8gcmVzdWx0XG5cdFx0cmV0dXJuIGFfb3V0O1xuXHR9LFxufTtcblxubW9kdWxlLmV4cG9ydHMgPSBPYmplY3QuYXNzaWduKGZ1bmN0aW9uKC4uLmFfYXJncykge1xuXHQvLyBjYWxsZWQgZnJvbSB3b3JrZXJcblx0aWYgKFhNX0NPTlRFWFRfV09SS0VSICYgWF9DT05URVhUX1RZUEUpIHtcblx0XHQvLyBkZWRpY2F0ZWQgd29ya2VyXG5cdFx0aWYgKFhNX0NPTlRFWFRfV09SS0VSX0RFRElDQVRFRCA9PT0gWF9DT05URVhUX1RZUEUpIHtcblx0XHRcdHJldHVybiBuZXcgZGVkaWNhdGVkKC4uLmFfYXJncyk7XG5cdFx0fVxuXHRcdC8vIHNoYXJlZCB3b3JrZXJcblx0XHRlbHNlIGlmIChYTV9DT05URVhUX1dPUktFUl9TSEFSRUQgPT09IFhfQ09OVEVYVF9UWVBFKSB7XG5cdFx0XHQvLyByZXR1cm4gbmV3IHNoYXJlZCguLi5hX2FyZ3MpO1xuXHRcdH1cblx0XHQvLyBzZXJ2aWNlIHdvcmtlclxuXHRcdGVsc2UgaWYgKFhNX0NPTlRFWFRfV09SS0VSX1NFUlZJQ0UgPT09IFhfQ09OVEVYVF9UWVBFKSB7XG5cdFx0XHQvLyByZXR1cm4gbmV3IHNlcnZpY2UoLi4uYV9hcmdzKTtcblx0XHR9XG5cdH1cblx0Ly8gY2hpbGQgcHJvY2VzczsgZGVkaWNhdGVkIHdvcmtlclxuXHRlbHNlIGlmIChYTV9DT05URVhUX1BST0NFU1NfQ0hJTEQgPT09IFhfQ09OVEVYVF9UWVBFKSB7XG5cdFx0cmV0dXJuIG5ldyBkZWRpY2F0ZWQoLi4uYV9hcmdzKTtcblx0fVxuXHQvLyBtYXN0ZXJcblx0ZWxzZSB7XG5cdFx0cmV0dXJuIHdvcmtlci5mcm9tX3NvdXJjZSguLi5hX2FyZ3MpO1xuXHR9XG59LCBIX0VYUE9SVFMpOyIsIid1c2Ugc3RyaWN0JztcblxuLy8gY29tcGFyZSBhbmQgaXNCdWZmZXIgdGFrZW4gZnJvbSBodHRwczovL2dpdGh1Yi5jb20vZmVyb3NzL2J1ZmZlci9ibG9iLzY4MGU5ZTVlNDg4ZjIyYWFjMjc1OTlhNTdkYzg0NGE2MzE1OTI4ZGQvaW5kZXguanNcbi8vIG9yaWdpbmFsIG5vdGljZTpcblxuLyohXG4gKiBUaGUgYnVmZmVyIG1vZHVsZSBmcm9tIG5vZGUuanMsIGZvciB0aGUgYnJvd3Nlci5cbiAqXG4gKiBAYXV0aG9yICAgRmVyb3NzIEFib3VraGFkaWplaCA8ZmVyb3NzQGZlcm9zcy5vcmc+IDxodHRwOi8vZmVyb3NzLm9yZz5cbiAqIEBsaWNlbnNlICBNSVRcbiAqL1xuZnVuY3Rpb24gY29tcGFyZShhLCBiKSB7XG4gIGlmIChhID09PSBiKSB7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICB2YXIgeCA9IGEubGVuZ3RoO1xuICB2YXIgeSA9IGIubGVuZ3RoO1xuXG4gIGZvciAodmFyIGkgPSAwLCBsZW4gPSBNYXRoLm1pbih4LCB5KTsgaSA8IGxlbjsgKytpKSB7XG4gICAgaWYgKGFbaV0gIT09IGJbaV0pIHtcbiAgICAgIHggPSBhW2ldO1xuICAgICAgeSA9IGJbaV07XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICBpZiAoeCA8IHkpIHtcbiAgICByZXR1cm4gLTE7XG4gIH1cbiAgaWYgKHkgPCB4KSB7XG4gICAgcmV0dXJuIDE7XG4gIH1cbiAgcmV0dXJuIDA7XG59XG5mdW5jdGlvbiBpc0J1ZmZlcihiKSB7XG4gIGlmIChnbG9iYWwuQnVmZmVyICYmIHR5cGVvZiBnbG9iYWwuQnVmZmVyLmlzQnVmZmVyID09PSAnZnVuY3Rpb24nKSB7XG4gICAgcmV0dXJuIGdsb2JhbC5CdWZmZXIuaXNCdWZmZXIoYik7XG4gIH1cbiAgcmV0dXJuICEhKGIgIT0gbnVsbCAmJiBiLl9pc0J1ZmZlcik7XG59XG5cbi8vIGJhc2VkIG9uIG5vZGUgYXNzZXJ0LCBvcmlnaW5hbCBub3RpY2U6XG5cbi8vIGh0dHA6Ly93aWtpLmNvbW1vbmpzLm9yZy93aWtpL1VuaXRfVGVzdGluZy8xLjBcbi8vXG4vLyBUSElTIElTIE5PVCBURVNURUQgTk9SIExJS0VMWSBUTyBXT1JLIE9VVFNJREUgVjghXG4vL1xuLy8gT3JpZ2luYWxseSBmcm9tIG5hcndoYWwuanMgKGh0dHA6Ly9uYXJ3aGFsanMub3JnKVxuLy8gQ29weXJpZ2h0IChjKSAyMDA5IFRob21hcyBSb2JpbnNvbiA8Mjgwbm9ydGguY29tPlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbi8vIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlICdTb2Z0d2FyZScpLCB0b1xuLy8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGVcbi8vIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vclxuLy8gc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcbi8vIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW5cbi8vIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCAnQVMgSVMnLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SXG4vLyBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcbi8vIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxuLy8gQVVUSE9SUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU5cbi8vIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT05cbi8vIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG52YXIgdXRpbCA9IHJlcXVpcmUoJ3V0aWwvJyk7XG52YXIgaGFzT3duID0gT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eTtcbnZhciBwU2xpY2UgPSBBcnJheS5wcm90b3R5cGUuc2xpY2U7XG52YXIgZnVuY3Rpb25zSGF2ZU5hbWVzID0gKGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIGZvbygpIHt9Lm5hbWUgPT09ICdmb28nO1xufSgpKTtcbmZ1bmN0aW9uIHBUb1N0cmluZyAob2JqKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwob2JqKTtcbn1cbmZ1bmN0aW9uIGlzVmlldyhhcnJidWYpIHtcbiAgaWYgKGlzQnVmZmVyKGFycmJ1ZikpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgaWYgKHR5cGVvZiBnbG9iYWwuQXJyYXlCdWZmZXIgIT09ICdmdW5jdGlvbicpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgaWYgKHR5cGVvZiBBcnJheUJ1ZmZlci5pc1ZpZXcgPT09ICdmdW5jdGlvbicpIHtcbiAgICByZXR1cm4gQXJyYXlCdWZmZXIuaXNWaWV3KGFycmJ1Zik7XG4gIH1cbiAgaWYgKCFhcnJidWYpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgaWYgKGFycmJ1ZiBpbnN0YW5jZW9mIERhdGFWaWV3KSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKGFycmJ1Zi5idWZmZXIgJiYgYXJyYnVmLmJ1ZmZlciBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuLy8gMS4gVGhlIGFzc2VydCBtb2R1bGUgcHJvdmlkZXMgZnVuY3Rpb25zIHRoYXQgdGhyb3dcbi8vIEFzc2VydGlvbkVycm9yJ3Mgd2hlbiBwYXJ0aWN1bGFyIGNvbmRpdGlvbnMgYXJlIG5vdCBtZXQuIFRoZVxuLy8gYXNzZXJ0IG1vZHVsZSBtdXN0IGNvbmZvcm0gdG8gdGhlIGZvbGxvd2luZyBpbnRlcmZhY2UuXG5cbnZhciBhc3NlcnQgPSBtb2R1bGUuZXhwb3J0cyA9IG9rO1xuXG4vLyAyLiBUaGUgQXNzZXJ0aW9uRXJyb3IgaXMgZGVmaW5lZCBpbiBhc3NlcnQuXG4vLyBuZXcgYXNzZXJ0LkFzc2VydGlvbkVycm9yKHsgbWVzc2FnZTogbWVzc2FnZSxcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhY3R1YWw6IGFjdHVhbCxcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHBlY3RlZDogZXhwZWN0ZWQgfSlcblxudmFyIHJlZ2V4ID0gL1xccypmdW5jdGlvblxccysoW15cXChcXHNdKilcXHMqLztcbi8vIGJhc2VkIG9uIGh0dHBzOi8vZ2l0aHViLmNvbS9samhhcmIvZnVuY3Rpb24ucHJvdG90eXBlLm5hbWUvYmxvYi9hZGVlZWVjOGJmY2M2MDY4YjE4N2Q3ZDlmYjNkNWJiMWQzYTMwODk5L2ltcGxlbWVudGF0aW9uLmpzXG5mdW5jdGlvbiBnZXROYW1lKGZ1bmMpIHtcbiAgaWYgKCF1dGlsLmlzRnVuY3Rpb24oZnVuYykpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGZ1bmN0aW9uc0hhdmVOYW1lcykge1xuICAgIHJldHVybiBmdW5jLm5hbWU7XG4gIH1cbiAgdmFyIHN0ciA9IGZ1bmMudG9TdHJpbmcoKTtcbiAgdmFyIG1hdGNoID0gc3RyLm1hdGNoKHJlZ2V4KTtcbiAgcmV0dXJuIG1hdGNoICYmIG1hdGNoWzFdO1xufVxuYXNzZXJ0LkFzc2VydGlvbkVycm9yID0gZnVuY3Rpb24gQXNzZXJ0aW9uRXJyb3Iob3B0aW9ucykge1xuICB0aGlzLm5hbWUgPSAnQXNzZXJ0aW9uRXJyb3InO1xuICB0aGlzLmFjdHVhbCA9IG9wdGlvbnMuYWN0dWFsO1xuICB0aGlzLmV4cGVjdGVkID0gb3B0aW9ucy5leHBlY3RlZDtcbiAgdGhpcy5vcGVyYXRvciA9IG9wdGlvbnMub3BlcmF0b3I7XG4gIGlmIChvcHRpb25zLm1lc3NhZ2UpIHtcbiAgICB0aGlzLm1lc3NhZ2UgPSBvcHRpb25zLm1lc3NhZ2U7XG4gICAgdGhpcy5nZW5lcmF0ZWRNZXNzYWdlID0gZmFsc2U7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5tZXNzYWdlID0gZ2V0TWVzc2FnZSh0aGlzKTtcbiAgICB0aGlzLmdlbmVyYXRlZE1lc3NhZ2UgPSB0cnVlO1xuICB9XG4gIHZhciBzdGFja1N0YXJ0RnVuY3Rpb24gPSBvcHRpb25zLnN0YWNrU3RhcnRGdW5jdGlvbiB8fCBmYWlsO1xuICBpZiAoRXJyb3IuY2FwdHVyZVN0YWNrVHJhY2UpIHtcbiAgICBFcnJvci5jYXB0dXJlU3RhY2tUcmFjZSh0aGlzLCBzdGFja1N0YXJ0RnVuY3Rpb24pO1xuICB9IGVsc2Uge1xuICAgIC8vIG5vbiB2OCBicm93c2VycyBzbyB3ZSBjYW4gaGF2ZSBhIHN0YWNrdHJhY2VcbiAgICB2YXIgZXJyID0gbmV3IEVycm9yKCk7XG4gICAgaWYgKGVyci5zdGFjaykge1xuICAgICAgdmFyIG91dCA9IGVyci5zdGFjaztcblxuICAgICAgLy8gdHJ5IHRvIHN0cmlwIHVzZWxlc3MgZnJhbWVzXG4gICAgICB2YXIgZm5fbmFtZSA9IGdldE5hbWUoc3RhY2tTdGFydEZ1bmN0aW9uKTtcbiAgICAgIHZhciBpZHggPSBvdXQuaW5kZXhPZignXFxuJyArIGZuX25hbWUpO1xuICAgICAgaWYgKGlkeCA+PSAwKSB7XG4gICAgICAgIC8vIG9uY2Ugd2UgaGF2ZSBsb2NhdGVkIHRoZSBmdW5jdGlvbiBmcmFtZVxuICAgICAgICAvLyB3ZSBuZWVkIHRvIHN0cmlwIG91dCBldmVyeXRoaW5nIGJlZm9yZSBpdCAoYW5kIGl0cyBsaW5lKVxuICAgICAgICB2YXIgbmV4dF9saW5lID0gb3V0LmluZGV4T2YoJ1xcbicsIGlkeCArIDEpO1xuICAgICAgICBvdXQgPSBvdXQuc3Vic3RyaW5nKG5leHRfbGluZSArIDEpO1xuICAgICAgfVxuXG4gICAgICB0aGlzLnN0YWNrID0gb3V0O1xuICAgIH1cbiAgfVxufTtcblxuLy8gYXNzZXJ0LkFzc2VydGlvbkVycm9yIGluc3RhbmNlb2YgRXJyb3JcbnV0aWwuaW5oZXJpdHMoYXNzZXJ0LkFzc2VydGlvbkVycm9yLCBFcnJvcik7XG5cbmZ1bmN0aW9uIHRydW5jYXRlKHMsIG4pIHtcbiAgaWYgKHR5cGVvZiBzID09PSAnc3RyaW5nJykge1xuICAgIHJldHVybiBzLmxlbmd0aCA8IG4gPyBzIDogcy5zbGljZSgwLCBuKTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gcztcbiAgfVxufVxuZnVuY3Rpb24gaW5zcGVjdChzb21ldGhpbmcpIHtcbiAgaWYgKGZ1bmN0aW9uc0hhdmVOYW1lcyB8fCAhdXRpbC5pc0Z1bmN0aW9uKHNvbWV0aGluZykpIHtcbiAgICByZXR1cm4gdXRpbC5pbnNwZWN0KHNvbWV0aGluZyk7XG4gIH1cbiAgdmFyIHJhd25hbWUgPSBnZXROYW1lKHNvbWV0aGluZyk7XG4gIHZhciBuYW1lID0gcmF3bmFtZSA/ICc6ICcgKyByYXduYW1lIDogJyc7XG4gIHJldHVybiAnW0Z1bmN0aW9uJyArICBuYW1lICsgJ10nO1xufVxuZnVuY3Rpb24gZ2V0TWVzc2FnZShzZWxmKSB7XG4gIHJldHVybiB0cnVuY2F0ZShpbnNwZWN0KHNlbGYuYWN0dWFsKSwgMTI4KSArICcgJyArXG4gICAgICAgICBzZWxmLm9wZXJhdG9yICsgJyAnICtcbiAgICAgICAgIHRydW5jYXRlKGluc3BlY3Qoc2VsZi5leHBlY3RlZCksIDEyOCk7XG59XG5cbi8vIEF0IHByZXNlbnQgb25seSB0aGUgdGhyZWUga2V5cyBtZW50aW9uZWQgYWJvdmUgYXJlIHVzZWQgYW5kXG4vLyB1bmRlcnN0b29kIGJ5IHRoZSBzcGVjLiBJbXBsZW1lbnRhdGlvbnMgb3Igc3ViIG1vZHVsZXMgY2FuIHBhc3Ncbi8vIG90aGVyIGtleXMgdG8gdGhlIEFzc2VydGlvbkVycm9yJ3MgY29uc3RydWN0b3IgLSB0aGV5IHdpbGwgYmVcbi8vIGlnbm9yZWQuXG5cbi8vIDMuIEFsbCBvZiB0aGUgZm9sbG93aW5nIGZ1bmN0aW9ucyBtdXN0IHRocm93IGFuIEFzc2VydGlvbkVycm9yXG4vLyB3aGVuIGEgY29ycmVzcG9uZGluZyBjb25kaXRpb24gaXMgbm90IG1ldCwgd2l0aCBhIG1lc3NhZ2UgdGhhdFxuLy8gbWF5IGJlIHVuZGVmaW5lZCBpZiBub3QgcHJvdmlkZWQuICBBbGwgYXNzZXJ0aW9uIG1ldGhvZHMgcHJvdmlkZVxuLy8gYm90aCB0aGUgYWN0dWFsIGFuZCBleHBlY3RlZCB2YWx1ZXMgdG8gdGhlIGFzc2VydGlvbiBlcnJvciBmb3Jcbi8vIGRpc3BsYXkgcHVycG9zZXMuXG5cbmZ1bmN0aW9uIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgb3BlcmF0b3IsIHN0YWNrU3RhcnRGdW5jdGlvbikge1xuICB0aHJvdyBuZXcgYXNzZXJ0LkFzc2VydGlvbkVycm9yKHtcbiAgICBtZXNzYWdlOiBtZXNzYWdlLFxuICAgIGFjdHVhbDogYWN0dWFsLFxuICAgIGV4cGVjdGVkOiBleHBlY3RlZCxcbiAgICBvcGVyYXRvcjogb3BlcmF0b3IsXG4gICAgc3RhY2tTdGFydEZ1bmN0aW9uOiBzdGFja1N0YXJ0RnVuY3Rpb25cbiAgfSk7XG59XG5cbi8vIEVYVEVOU0lPTiEgYWxsb3dzIGZvciB3ZWxsIGJlaGF2ZWQgZXJyb3JzIGRlZmluZWQgZWxzZXdoZXJlLlxuYXNzZXJ0LmZhaWwgPSBmYWlsO1xuXG4vLyA0LiBQdXJlIGFzc2VydGlvbiB0ZXN0cyB3aGV0aGVyIGEgdmFsdWUgaXMgdHJ1dGh5LCBhcyBkZXRlcm1pbmVkXG4vLyBieSAhIWd1YXJkLlxuLy8gYXNzZXJ0Lm9rKGd1YXJkLCBtZXNzYWdlX29wdCk7XG4vLyBUaGlzIHN0YXRlbWVudCBpcyBlcXVpdmFsZW50IHRvIGFzc2VydC5lcXVhbCh0cnVlLCAhIWd1YXJkLFxuLy8gbWVzc2FnZV9vcHQpOy4gVG8gdGVzdCBzdHJpY3RseSBmb3IgdGhlIHZhbHVlIHRydWUsIHVzZVxuLy8gYXNzZXJ0LnN0cmljdEVxdWFsKHRydWUsIGd1YXJkLCBtZXNzYWdlX29wdCk7LlxuXG5mdW5jdGlvbiBvayh2YWx1ZSwgbWVzc2FnZSkge1xuICBpZiAoIXZhbHVlKSBmYWlsKHZhbHVlLCB0cnVlLCBtZXNzYWdlLCAnPT0nLCBhc3NlcnQub2spO1xufVxuYXNzZXJ0Lm9rID0gb2s7XG5cbi8vIDUuIFRoZSBlcXVhbGl0eSBhc3NlcnRpb24gdGVzdHMgc2hhbGxvdywgY29lcmNpdmUgZXF1YWxpdHkgd2l0aFxuLy8gPT0uXG4vLyBhc3NlcnQuZXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZV9vcHQpO1xuXG5hc3NlcnQuZXF1YWwgPSBmdW5jdGlvbiBlcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmIChhY3R1YWwgIT0gZXhwZWN0ZWQpIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJz09JywgYXNzZXJ0LmVxdWFsKTtcbn07XG5cbi8vIDYuIFRoZSBub24tZXF1YWxpdHkgYXNzZXJ0aW9uIHRlc3RzIGZvciB3aGV0aGVyIHR3byBvYmplY3RzIGFyZSBub3QgZXF1YWxcbi8vIHdpdGggIT0gYXNzZXJ0Lm5vdEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2Vfb3B0KTtcblxuYXNzZXJ0Lm5vdEVxdWFsID0gZnVuY3Rpb24gbm90RXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICBpZiAoYWN0dWFsID09IGV4cGVjdGVkKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnIT0nLCBhc3NlcnQubm90RXF1YWwpO1xuICB9XG59O1xuXG4vLyA3LiBUaGUgZXF1aXZhbGVuY2UgYXNzZXJ0aW9uIHRlc3RzIGEgZGVlcCBlcXVhbGl0eSByZWxhdGlvbi5cbi8vIGFzc2VydC5kZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZV9vcHQpO1xuXG5hc3NlcnQuZGVlcEVxdWFsID0gZnVuY3Rpb24gZGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgaWYgKCFfZGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIGZhbHNlKSkge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJ2RlZXBFcXVhbCcsIGFzc2VydC5kZWVwRXF1YWwpO1xuICB9XG59O1xuXG5hc3NlcnQuZGVlcFN0cmljdEVxdWFsID0gZnVuY3Rpb24gZGVlcFN0cmljdEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgaWYgKCFfZGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIHRydWUpKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnZGVlcFN0cmljdEVxdWFsJywgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCk7XG4gIH1cbn07XG5cbmZ1bmN0aW9uIF9kZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgc3RyaWN0LCBtZW1vcykge1xuICAvLyA3LjEuIEFsbCBpZGVudGljYWwgdmFsdWVzIGFyZSBlcXVpdmFsZW50LCBhcyBkZXRlcm1pbmVkIGJ5ID09PS5cbiAgaWYgKGFjdHVhbCA9PT0gZXhwZWN0ZWQpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBlbHNlIGlmIChpc0J1ZmZlcihhY3R1YWwpICYmIGlzQnVmZmVyKGV4cGVjdGVkKSkge1xuICAgIHJldHVybiBjb21wYXJlKGFjdHVhbCwgZXhwZWN0ZWQpID09PSAwO1xuXG4gIC8vIDcuMi4gSWYgdGhlIGV4cGVjdGVkIHZhbHVlIGlzIGEgRGF0ZSBvYmplY3QsIHRoZSBhY3R1YWwgdmFsdWUgaXNcbiAgLy8gZXF1aXZhbGVudCBpZiBpdCBpcyBhbHNvIGEgRGF0ZSBvYmplY3QgdGhhdCByZWZlcnMgdG8gdGhlIHNhbWUgdGltZS5cbiAgfSBlbHNlIGlmICh1dGlsLmlzRGF0ZShhY3R1YWwpICYmIHV0aWwuaXNEYXRlKGV4cGVjdGVkKSkge1xuICAgIHJldHVybiBhY3R1YWwuZ2V0VGltZSgpID09PSBleHBlY3RlZC5nZXRUaW1lKCk7XG5cbiAgLy8gNy4zIElmIHRoZSBleHBlY3RlZCB2YWx1ZSBpcyBhIFJlZ0V4cCBvYmplY3QsIHRoZSBhY3R1YWwgdmFsdWUgaXNcbiAgLy8gZXF1aXZhbGVudCBpZiBpdCBpcyBhbHNvIGEgUmVnRXhwIG9iamVjdCB3aXRoIHRoZSBzYW1lIHNvdXJjZSBhbmRcbiAgLy8gcHJvcGVydGllcyAoYGdsb2JhbGAsIGBtdWx0aWxpbmVgLCBgbGFzdEluZGV4YCwgYGlnbm9yZUNhc2VgKS5cbiAgfSBlbHNlIGlmICh1dGlsLmlzUmVnRXhwKGFjdHVhbCkgJiYgdXRpbC5pc1JlZ0V4cChleHBlY3RlZCkpIHtcbiAgICByZXR1cm4gYWN0dWFsLnNvdXJjZSA9PT0gZXhwZWN0ZWQuc291cmNlICYmXG4gICAgICAgICAgIGFjdHVhbC5nbG9iYWwgPT09IGV4cGVjdGVkLmdsb2JhbCAmJlxuICAgICAgICAgICBhY3R1YWwubXVsdGlsaW5lID09PSBleHBlY3RlZC5tdWx0aWxpbmUgJiZcbiAgICAgICAgICAgYWN0dWFsLmxhc3RJbmRleCA9PT0gZXhwZWN0ZWQubGFzdEluZGV4ICYmXG4gICAgICAgICAgIGFjdHVhbC5pZ25vcmVDYXNlID09PSBleHBlY3RlZC5pZ25vcmVDYXNlO1xuXG4gIC8vIDcuNC4gT3RoZXIgcGFpcnMgdGhhdCBkbyBub3QgYm90aCBwYXNzIHR5cGVvZiB2YWx1ZSA9PSAnb2JqZWN0JyxcbiAgLy8gZXF1aXZhbGVuY2UgaXMgZGV0ZXJtaW5lZCBieSA9PS5cbiAgfSBlbHNlIGlmICgoYWN0dWFsID09PSBudWxsIHx8IHR5cGVvZiBhY3R1YWwgIT09ICdvYmplY3QnKSAmJlxuICAgICAgICAgICAgIChleHBlY3RlZCA9PT0gbnVsbCB8fCB0eXBlb2YgZXhwZWN0ZWQgIT09ICdvYmplY3QnKSkge1xuICAgIHJldHVybiBzdHJpY3QgPyBhY3R1YWwgPT09IGV4cGVjdGVkIDogYWN0dWFsID09IGV4cGVjdGVkO1xuXG4gIC8vIElmIGJvdGggdmFsdWVzIGFyZSBpbnN0YW5jZXMgb2YgdHlwZWQgYXJyYXlzLCB3cmFwIHRoZWlyIHVuZGVybHlpbmdcbiAgLy8gQXJyYXlCdWZmZXJzIGluIGEgQnVmZmVyIGVhY2ggdG8gaW5jcmVhc2UgcGVyZm9ybWFuY2VcbiAgLy8gVGhpcyBvcHRpbWl6YXRpb24gcmVxdWlyZXMgdGhlIGFycmF5cyB0byBoYXZlIHRoZSBzYW1lIHR5cGUgYXMgY2hlY2tlZCBieVxuICAvLyBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nIChha2EgcFRvU3RyaW5nKS4gTmV2ZXIgcGVyZm9ybSBiaW5hcnlcbiAgLy8gY29tcGFyaXNvbnMgZm9yIEZsb2F0KkFycmF5cywgdGhvdWdoLCBzaW5jZSBlLmcuICswID09PSAtMCBidXQgdGhlaXJcbiAgLy8gYml0IHBhdHRlcm5zIGFyZSBub3QgaWRlbnRpY2FsLlxuICB9IGVsc2UgaWYgKGlzVmlldyhhY3R1YWwpICYmIGlzVmlldyhleHBlY3RlZCkgJiZcbiAgICAgICAgICAgICBwVG9TdHJpbmcoYWN0dWFsKSA9PT0gcFRvU3RyaW5nKGV4cGVjdGVkKSAmJlxuICAgICAgICAgICAgICEoYWN0dWFsIGluc3RhbmNlb2YgRmxvYXQzMkFycmF5IHx8XG4gICAgICAgICAgICAgICBhY3R1YWwgaW5zdGFuY2VvZiBGbG9hdDY0QXJyYXkpKSB7XG4gICAgcmV0dXJuIGNvbXBhcmUobmV3IFVpbnQ4QXJyYXkoYWN0dWFsLmJ1ZmZlciksXG4gICAgICAgICAgICAgICAgICAgbmV3IFVpbnQ4QXJyYXkoZXhwZWN0ZWQuYnVmZmVyKSkgPT09IDA7XG5cbiAgLy8gNy41IEZvciBhbGwgb3RoZXIgT2JqZWN0IHBhaXJzLCBpbmNsdWRpbmcgQXJyYXkgb2JqZWN0cywgZXF1aXZhbGVuY2UgaXNcbiAgLy8gZGV0ZXJtaW5lZCBieSBoYXZpbmcgdGhlIHNhbWUgbnVtYmVyIG9mIG93bmVkIHByb3BlcnRpZXMgKGFzIHZlcmlmaWVkXG4gIC8vIHdpdGggT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKSwgdGhlIHNhbWUgc2V0IG9mIGtleXNcbiAgLy8gKGFsdGhvdWdoIG5vdCBuZWNlc3NhcmlseSB0aGUgc2FtZSBvcmRlciksIGVxdWl2YWxlbnQgdmFsdWVzIGZvciBldmVyeVxuICAvLyBjb3JyZXNwb25kaW5nIGtleSwgYW5kIGFuIGlkZW50aWNhbCAncHJvdG90eXBlJyBwcm9wZXJ0eS4gTm90ZTogdGhpc1xuICAvLyBhY2NvdW50cyBmb3IgYm90aCBuYW1lZCBhbmQgaW5kZXhlZCBwcm9wZXJ0aWVzIG9uIEFycmF5cy5cbiAgfSBlbHNlIGlmIChpc0J1ZmZlcihhY3R1YWwpICE9PSBpc0J1ZmZlcihleHBlY3RlZCkpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH0gZWxzZSB7XG4gICAgbWVtb3MgPSBtZW1vcyB8fCB7YWN0dWFsOiBbXSwgZXhwZWN0ZWQ6IFtdfTtcblxuICAgIHZhciBhY3R1YWxJbmRleCA9IG1lbW9zLmFjdHVhbC5pbmRleE9mKGFjdHVhbCk7XG4gICAgaWYgKGFjdHVhbEluZGV4ICE9PSAtMSkge1xuICAgICAgaWYgKGFjdHVhbEluZGV4ID09PSBtZW1vcy5leHBlY3RlZC5pbmRleE9mKGV4cGVjdGVkKSkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBtZW1vcy5hY3R1YWwucHVzaChhY3R1YWwpO1xuICAgIG1lbW9zLmV4cGVjdGVkLnB1c2goZXhwZWN0ZWQpO1xuXG4gICAgcmV0dXJuIG9iakVxdWl2KGFjdHVhbCwgZXhwZWN0ZWQsIHN0cmljdCwgbWVtb3MpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGlzQXJndW1lbnRzKG9iamVjdCkge1xuICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKG9iamVjdCkgPT0gJ1tvYmplY3QgQXJndW1lbnRzXSc7XG59XG5cbmZ1bmN0aW9uIG9iakVxdWl2KGEsIGIsIHN0cmljdCwgYWN0dWFsVmlzaXRlZE9iamVjdHMpIHtcbiAgaWYgKGEgPT09IG51bGwgfHwgYSA9PT0gdW5kZWZpbmVkIHx8IGIgPT09IG51bGwgfHwgYiA9PT0gdW5kZWZpbmVkKVxuICAgIHJldHVybiBmYWxzZTtcbiAgLy8gaWYgb25lIGlzIGEgcHJpbWl0aXZlLCB0aGUgb3RoZXIgbXVzdCBiZSBzYW1lXG4gIGlmICh1dGlsLmlzUHJpbWl0aXZlKGEpIHx8IHV0aWwuaXNQcmltaXRpdmUoYikpXG4gICAgcmV0dXJuIGEgPT09IGI7XG4gIGlmIChzdHJpY3QgJiYgT2JqZWN0LmdldFByb3RvdHlwZU9mKGEpICE9PSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoYikpXG4gICAgcmV0dXJuIGZhbHNlO1xuICB2YXIgYUlzQXJncyA9IGlzQXJndW1lbnRzKGEpO1xuICB2YXIgYklzQXJncyA9IGlzQXJndW1lbnRzKGIpO1xuICBpZiAoKGFJc0FyZ3MgJiYgIWJJc0FyZ3MpIHx8ICghYUlzQXJncyAmJiBiSXNBcmdzKSlcbiAgICByZXR1cm4gZmFsc2U7XG4gIGlmIChhSXNBcmdzKSB7XG4gICAgYSA9IHBTbGljZS5jYWxsKGEpO1xuICAgIGIgPSBwU2xpY2UuY2FsbChiKTtcbiAgICByZXR1cm4gX2RlZXBFcXVhbChhLCBiLCBzdHJpY3QpO1xuICB9XG4gIHZhciBrYSA9IG9iamVjdEtleXMoYSk7XG4gIHZhciBrYiA9IG9iamVjdEtleXMoYik7XG4gIHZhciBrZXksIGk7XG4gIC8vIGhhdmluZyB0aGUgc2FtZSBudW1iZXIgb2Ygb3duZWQgcHJvcGVydGllcyAoa2V5cyBpbmNvcnBvcmF0ZXNcbiAgLy8gaGFzT3duUHJvcGVydHkpXG4gIGlmIChrYS5sZW5ndGggIT09IGtiLmxlbmd0aClcbiAgICByZXR1cm4gZmFsc2U7XG4gIC8vdGhlIHNhbWUgc2V0IG9mIGtleXMgKGFsdGhvdWdoIG5vdCBuZWNlc3NhcmlseSB0aGUgc2FtZSBvcmRlciksXG4gIGthLnNvcnQoKTtcbiAga2Iuc29ydCgpO1xuICAvL35+fmNoZWFwIGtleSB0ZXN0XG4gIGZvciAoaSA9IGthLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgaWYgKGthW2ldICE9PSBrYltpXSlcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICAvL2VxdWl2YWxlbnQgdmFsdWVzIGZvciBldmVyeSBjb3JyZXNwb25kaW5nIGtleSwgYW5kXG4gIC8vfn5+cG9zc2libHkgZXhwZW5zaXZlIGRlZXAgdGVzdFxuICBmb3IgKGkgPSBrYS5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGtleSA9IGthW2ldO1xuICAgIGlmICghX2RlZXBFcXVhbChhW2tleV0sIGJba2V5XSwgc3RyaWN0LCBhY3R1YWxWaXNpdGVkT2JqZWN0cykpXG4gICAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIDguIFRoZSBub24tZXF1aXZhbGVuY2UgYXNzZXJ0aW9uIHRlc3RzIGZvciBhbnkgZGVlcCBpbmVxdWFsaXR5LlxuLy8gYXNzZXJ0Lm5vdERlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlX29wdCk7XG5cbmFzc2VydC5ub3REZWVwRXF1YWwgPSBmdW5jdGlvbiBub3REZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICBpZiAoX2RlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBmYWxzZSkpIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsICdub3REZWVwRXF1YWwnLCBhc3NlcnQubm90RGVlcEVxdWFsKTtcbiAgfVxufTtcblxuYXNzZXJ0Lm5vdERlZXBTdHJpY3RFcXVhbCA9IG5vdERlZXBTdHJpY3RFcXVhbDtcbmZ1bmN0aW9uIG5vdERlZXBTdHJpY3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmIChfZGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIHRydWUpKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnbm90RGVlcFN0cmljdEVxdWFsJywgbm90RGVlcFN0cmljdEVxdWFsKTtcbiAgfVxufVxuXG5cbi8vIDkuIFRoZSBzdHJpY3QgZXF1YWxpdHkgYXNzZXJ0aW9uIHRlc3RzIHN0cmljdCBlcXVhbGl0eSwgYXMgZGV0ZXJtaW5lZCBieSA9PT0uXG4vLyBhc3NlcnQuc3RyaWN0RXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZV9vcHQpO1xuXG5hc3NlcnQuc3RyaWN0RXF1YWwgPSBmdW5jdGlvbiBzdHJpY3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmIChhY3R1YWwgIT09IGV4cGVjdGVkKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnPT09JywgYXNzZXJ0LnN0cmljdEVxdWFsKTtcbiAgfVxufTtcblxuLy8gMTAuIFRoZSBzdHJpY3Qgbm9uLWVxdWFsaXR5IGFzc2VydGlvbiB0ZXN0cyBmb3Igc3RyaWN0IGluZXF1YWxpdHksIGFzXG4vLyBkZXRlcm1pbmVkIGJ5ICE9PS4gIGFzc2VydC5ub3RTdHJpY3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlX29wdCk7XG5cbmFzc2VydC5ub3RTdHJpY3RFcXVhbCA9IGZ1bmN0aW9uIG5vdFN0cmljdEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgaWYgKGFjdHVhbCA9PT0gZXhwZWN0ZWQpIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsICchPT0nLCBhc3NlcnQubm90U3RyaWN0RXF1YWwpO1xuICB9XG59O1xuXG5mdW5jdGlvbiBleHBlY3RlZEV4Y2VwdGlvbihhY3R1YWwsIGV4cGVjdGVkKSB7XG4gIGlmICghYWN0dWFsIHx8ICFleHBlY3RlZCkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGlmIChPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoZXhwZWN0ZWQpID09ICdbb2JqZWN0IFJlZ0V4cF0nKSB7XG4gICAgcmV0dXJuIGV4cGVjdGVkLnRlc3QoYWN0dWFsKTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgaWYgKGFjdHVhbCBpbnN0YW5jZW9mIGV4cGVjdGVkKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICAvLyBJZ25vcmUuICBUaGUgaW5zdGFuY2VvZiBjaGVjayBkb2Vzbid0IHdvcmsgZm9yIGFycm93IGZ1bmN0aW9ucy5cbiAgfVxuXG4gIGlmIChFcnJvci5pc1Byb3RvdHlwZU9mKGV4cGVjdGVkKSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIHJldHVybiBleHBlY3RlZC5jYWxsKHt9LCBhY3R1YWwpID09PSB0cnVlO1xufVxuXG5mdW5jdGlvbiBfdHJ5QmxvY2soYmxvY2spIHtcbiAgdmFyIGVycm9yO1xuICB0cnkge1xuICAgIGJsb2NrKCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBlcnJvciA9IGU7XG4gIH1cbiAgcmV0dXJuIGVycm9yO1xufVxuXG5mdW5jdGlvbiBfdGhyb3dzKHNob3VsZFRocm93LCBibG9jaywgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgdmFyIGFjdHVhbDtcblxuICBpZiAodHlwZW9mIGJsb2NrICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignXCJibG9ja1wiIGFyZ3VtZW50IG11c3QgYmUgYSBmdW5jdGlvbicpO1xuICB9XG5cbiAgaWYgKHR5cGVvZiBleHBlY3RlZCA9PT0gJ3N0cmluZycpIHtcbiAgICBtZXNzYWdlID0gZXhwZWN0ZWQ7XG4gICAgZXhwZWN0ZWQgPSBudWxsO1xuICB9XG5cbiAgYWN0dWFsID0gX3RyeUJsb2NrKGJsb2NrKTtcblxuICBtZXNzYWdlID0gKGV4cGVjdGVkICYmIGV4cGVjdGVkLm5hbWUgPyAnICgnICsgZXhwZWN0ZWQubmFtZSArICcpLicgOiAnLicpICtcbiAgICAgICAgICAgIChtZXNzYWdlID8gJyAnICsgbWVzc2FnZSA6ICcuJyk7XG5cbiAgaWYgKHNob3VsZFRocm93ICYmICFhY3R1YWwpIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsICdNaXNzaW5nIGV4cGVjdGVkIGV4Y2VwdGlvbicgKyBtZXNzYWdlKTtcbiAgfVxuXG4gIHZhciB1c2VyUHJvdmlkZWRNZXNzYWdlID0gdHlwZW9mIG1lc3NhZ2UgPT09ICdzdHJpbmcnO1xuICB2YXIgaXNVbndhbnRlZEV4Y2VwdGlvbiA9ICFzaG91bGRUaHJvdyAmJiB1dGlsLmlzRXJyb3IoYWN0dWFsKTtcbiAgdmFyIGlzVW5leHBlY3RlZEV4Y2VwdGlvbiA9ICFzaG91bGRUaHJvdyAmJiBhY3R1YWwgJiYgIWV4cGVjdGVkO1xuXG4gIGlmICgoaXNVbndhbnRlZEV4Y2VwdGlvbiAmJlxuICAgICAgdXNlclByb3ZpZGVkTWVzc2FnZSAmJlxuICAgICAgZXhwZWN0ZWRFeGNlcHRpb24oYWN0dWFsLCBleHBlY3RlZCkpIHx8XG4gICAgICBpc1VuZXhwZWN0ZWRFeGNlcHRpb24pIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsICdHb3QgdW53YW50ZWQgZXhjZXB0aW9uJyArIG1lc3NhZ2UpO1xuICB9XG5cbiAgaWYgKChzaG91bGRUaHJvdyAmJiBhY3R1YWwgJiYgZXhwZWN0ZWQgJiZcbiAgICAgICFleHBlY3RlZEV4Y2VwdGlvbihhY3R1YWwsIGV4cGVjdGVkKSkgfHwgKCFzaG91bGRUaHJvdyAmJiBhY3R1YWwpKSB7XG4gICAgdGhyb3cgYWN0dWFsO1xuICB9XG59XG5cbi8vIDExLiBFeHBlY3RlZCB0byB0aHJvdyBhbiBlcnJvcjpcbi8vIGFzc2VydC50aHJvd3MoYmxvY2ssIEVycm9yX29wdCwgbWVzc2FnZV9vcHQpO1xuXG5hc3NlcnQudGhyb3dzID0gZnVuY3Rpb24oYmxvY2ssIC8qb3B0aW9uYWwqL2Vycm9yLCAvKm9wdGlvbmFsKi9tZXNzYWdlKSB7XG4gIF90aHJvd3ModHJ1ZSwgYmxvY2ssIGVycm9yLCBtZXNzYWdlKTtcbn07XG5cbi8vIEVYVEVOU0lPTiEgVGhpcyBpcyBhbm5veWluZyB0byB3cml0ZSBvdXRzaWRlIHRoaXMgbW9kdWxlLlxuYXNzZXJ0LmRvZXNOb3RUaHJvdyA9IGZ1bmN0aW9uKGJsb2NrLCAvKm9wdGlvbmFsKi9lcnJvciwgLypvcHRpb25hbCovbWVzc2FnZSkge1xuICBfdGhyb3dzKGZhbHNlLCBibG9jaywgZXJyb3IsIG1lc3NhZ2UpO1xufTtcblxuYXNzZXJ0LmlmRXJyb3IgPSBmdW5jdGlvbihlcnIpIHsgaWYgKGVycikgdGhyb3cgZXJyOyB9O1xuXG52YXIgb2JqZWN0S2V5cyA9IE9iamVjdC5rZXlzIHx8IGZ1bmN0aW9uIChvYmopIHtcbiAgdmFyIGtleXMgPSBbXTtcbiAgZm9yICh2YXIga2V5IGluIG9iaikge1xuICAgIGlmIChoYXNPd24uY2FsbChvYmosIGtleSkpIGtleXMucHVzaChrZXkpO1xuICB9XG4gIHJldHVybiBrZXlzO1xufTtcbiIsIiIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG5mdW5jdGlvbiBFdmVudEVtaXR0ZXIoKSB7XG4gIHRoaXMuX2V2ZW50cyA9IHRoaXMuX2V2ZW50cyB8fCB7fTtcbiAgdGhpcy5fbWF4TGlzdGVuZXJzID0gdGhpcy5fbWF4TGlzdGVuZXJzIHx8IHVuZGVmaW5lZDtcbn1cbm1vZHVsZS5leHBvcnRzID0gRXZlbnRFbWl0dGVyO1xuXG4vLyBCYWNrd2FyZHMtY29tcGF0IHdpdGggbm9kZSAwLjEwLnhcbkV2ZW50RW1pdHRlci5FdmVudEVtaXR0ZXIgPSBFdmVudEVtaXR0ZXI7XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuX2V2ZW50cyA9IHVuZGVmaW5lZDtcbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuX21heExpc3RlbmVycyA9IHVuZGVmaW5lZDtcblxuLy8gQnkgZGVmYXVsdCBFdmVudEVtaXR0ZXJzIHdpbGwgcHJpbnQgYSB3YXJuaW5nIGlmIG1vcmUgdGhhbiAxMCBsaXN0ZW5lcnMgYXJlXG4vLyBhZGRlZCB0byBpdC4gVGhpcyBpcyBhIHVzZWZ1bCBkZWZhdWx0IHdoaWNoIGhlbHBzIGZpbmRpbmcgbWVtb3J5IGxlYWtzLlxuRXZlbnRFbWl0dGVyLmRlZmF1bHRNYXhMaXN0ZW5lcnMgPSAxMDtcblxuLy8gT2J2aW91c2x5IG5vdCBhbGwgRW1pdHRlcnMgc2hvdWxkIGJlIGxpbWl0ZWQgdG8gMTAuIFRoaXMgZnVuY3Rpb24gYWxsb3dzXG4vLyB0aGF0IHRvIGJlIGluY3JlYXNlZC4gU2V0IHRvIHplcm8gZm9yIHVubGltaXRlZC5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuc2V0TWF4TGlzdGVuZXJzID0gZnVuY3Rpb24obikge1xuICBpZiAoIWlzTnVtYmVyKG4pIHx8IG4gPCAwIHx8IGlzTmFOKG4pKVxuICAgIHRocm93IFR5cGVFcnJvcignbiBtdXN0IGJlIGEgcG9zaXRpdmUgbnVtYmVyJyk7XG4gIHRoaXMuX21heExpc3RlbmVycyA9IG47XG4gIHJldHVybiB0aGlzO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5lbWl0ID0gZnVuY3Rpb24odHlwZSkge1xuICB2YXIgZXIsIGhhbmRsZXIsIGxlbiwgYXJncywgaSwgbGlzdGVuZXJzO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzKVxuICAgIHRoaXMuX2V2ZW50cyA9IHt9O1xuXG4gIC8vIElmIHRoZXJlIGlzIG5vICdlcnJvcicgZXZlbnQgbGlzdGVuZXIgdGhlbiB0aHJvdy5cbiAgaWYgKHR5cGUgPT09ICdlcnJvcicpIHtcbiAgICBpZiAoIXRoaXMuX2V2ZW50cy5lcnJvciB8fFxuICAgICAgICAoaXNPYmplY3QodGhpcy5fZXZlbnRzLmVycm9yKSAmJiAhdGhpcy5fZXZlbnRzLmVycm9yLmxlbmd0aCkpIHtcbiAgICAgIGVyID0gYXJndW1lbnRzWzFdO1xuICAgICAgaWYgKGVyIGluc3RhbmNlb2YgRXJyb3IpIHtcbiAgICAgICAgdGhyb3cgZXI7IC8vIFVuaGFuZGxlZCAnZXJyb3InIGV2ZW50XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBBdCBsZWFzdCBnaXZlIHNvbWUga2luZCBvZiBjb250ZXh0IHRvIHRoZSB1c2VyXG4gICAgICAgIHZhciBlcnIgPSBuZXcgRXJyb3IoJ1VuY2F1Z2h0LCB1bnNwZWNpZmllZCBcImVycm9yXCIgZXZlbnQuICgnICsgZXIgKyAnKScpO1xuICAgICAgICBlcnIuY29udGV4dCA9IGVyO1xuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaGFuZGxlciA9IHRoaXMuX2V2ZW50c1t0eXBlXTtcblxuICBpZiAoaXNVbmRlZmluZWQoaGFuZGxlcikpXG4gICAgcmV0dXJuIGZhbHNlO1xuXG4gIGlmIChpc0Z1bmN0aW9uKGhhbmRsZXIpKSB7XG4gICAgc3dpdGNoIChhcmd1bWVudHMubGVuZ3RoKSB7XG4gICAgICAvLyBmYXN0IGNhc2VzXG4gICAgICBjYXNlIDE6XG4gICAgICAgIGhhbmRsZXIuY2FsbCh0aGlzKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDI6XG4gICAgICAgIGhhbmRsZXIuY2FsbCh0aGlzLCBhcmd1bWVudHNbMV0pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgMzpcbiAgICAgICAgaGFuZGxlci5jYWxsKHRoaXMsIGFyZ3VtZW50c1sxXSwgYXJndW1lbnRzWzJdKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICAvLyBzbG93ZXJcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpO1xuICAgICAgICBoYW5kbGVyLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgIH1cbiAgfSBlbHNlIGlmIChpc09iamVjdChoYW5kbGVyKSkge1xuICAgIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpO1xuICAgIGxpc3RlbmVycyA9IGhhbmRsZXIuc2xpY2UoKTtcbiAgICBsZW4gPSBsaXN0ZW5lcnMubGVuZ3RoO1xuICAgIGZvciAoaSA9IDA7IGkgPCBsZW47IGkrKylcbiAgICAgIGxpc3RlbmVyc1tpXS5hcHBseSh0aGlzLCBhcmdzKTtcbiAgfVxuXG4gIHJldHVybiB0cnVlO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5hZGRMaXN0ZW5lciA9IGZ1bmN0aW9uKHR5cGUsIGxpc3RlbmVyKSB7XG4gIHZhciBtO1xuXG4gIGlmICghaXNGdW5jdGlvbihsaXN0ZW5lcikpXG4gICAgdGhyb3cgVHlwZUVycm9yKCdsaXN0ZW5lciBtdXN0IGJlIGEgZnVuY3Rpb24nKTtcblxuICBpZiAoIXRoaXMuX2V2ZW50cylcbiAgICB0aGlzLl9ldmVudHMgPSB7fTtcblxuICAvLyBUbyBhdm9pZCByZWN1cnNpb24gaW4gdGhlIGNhc2UgdGhhdCB0eXBlID09PSBcIm5ld0xpc3RlbmVyXCIhIEJlZm9yZVxuICAvLyBhZGRpbmcgaXQgdG8gdGhlIGxpc3RlbmVycywgZmlyc3QgZW1pdCBcIm5ld0xpc3RlbmVyXCIuXG4gIGlmICh0aGlzLl9ldmVudHMubmV3TGlzdGVuZXIpXG4gICAgdGhpcy5lbWl0KCduZXdMaXN0ZW5lcicsIHR5cGUsXG4gICAgICAgICAgICAgIGlzRnVuY3Rpb24obGlzdGVuZXIubGlzdGVuZXIpID9cbiAgICAgICAgICAgICAgbGlzdGVuZXIubGlzdGVuZXIgOiBsaXN0ZW5lcik7XG5cbiAgaWYgKCF0aGlzLl9ldmVudHNbdHlwZV0pXG4gICAgLy8gT3B0aW1pemUgdGhlIGNhc2Ugb2Ygb25lIGxpc3RlbmVyLiBEb24ndCBuZWVkIHRoZSBleHRyYSBhcnJheSBvYmplY3QuXG4gICAgdGhpcy5fZXZlbnRzW3R5cGVdID0gbGlzdGVuZXI7XG4gIGVsc2UgaWYgKGlzT2JqZWN0KHRoaXMuX2V2ZW50c1t0eXBlXSkpXG4gICAgLy8gSWYgd2UndmUgYWxyZWFkeSBnb3QgYW4gYXJyYXksIGp1c3QgYXBwZW5kLlxuICAgIHRoaXMuX2V2ZW50c1t0eXBlXS5wdXNoKGxpc3RlbmVyKTtcbiAgZWxzZVxuICAgIC8vIEFkZGluZyB0aGUgc2Vjb25kIGVsZW1lbnQsIG5lZWQgdG8gY2hhbmdlIHRvIGFycmF5LlxuICAgIHRoaXMuX2V2ZW50c1t0eXBlXSA9IFt0aGlzLl9ldmVudHNbdHlwZV0sIGxpc3RlbmVyXTtcblxuICAvLyBDaGVjayBmb3IgbGlzdGVuZXIgbGVha1xuICBpZiAoaXNPYmplY3QodGhpcy5fZXZlbnRzW3R5cGVdKSAmJiAhdGhpcy5fZXZlbnRzW3R5cGVdLndhcm5lZCkge1xuICAgIGlmICghaXNVbmRlZmluZWQodGhpcy5fbWF4TGlzdGVuZXJzKSkge1xuICAgICAgbSA9IHRoaXMuX21heExpc3RlbmVycztcbiAgICB9IGVsc2Uge1xuICAgICAgbSA9IEV2ZW50RW1pdHRlci5kZWZhdWx0TWF4TGlzdGVuZXJzO1xuICAgIH1cblxuICAgIGlmIChtICYmIG0gPiAwICYmIHRoaXMuX2V2ZW50c1t0eXBlXS5sZW5ndGggPiBtKSB7XG4gICAgICB0aGlzLl9ldmVudHNbdHlwZV0ud2FybmVkID0gdHJ1ZTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJyhub2RlKSB3YXJuaW5nOiBwb3NzaWJsZSBFdmVudEVtaXR0ZXIgbWVtb3J5ICcgK1xuICAgICAgICAgICAgICAgICAgICAnbGVhayBkZXRlY3RlZC4gJWQgbGlzdGVuZXJzIGFkZGVkLiAnICtcbiAgICAgICAgICAgICAgICAgICAgJ1VzZSBlbWl0dGVyLnNldE1heExpc3RlbmVycygpIHRvIGluY3JlYXNlIGxpbWl0LicsXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50c1t0eXBlXS5sZW5ndGgpO1xuICAgICAgaWYgKHR5cGVvZiBjb25zb2xlLnRyYWNlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIC8vIG5vdCBzdXBwb3J0ZWQgaW4gSUUgMTBcbiAgICAgICAgY29uc29sZS50cmFjZSgpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB0aGlzO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5vbiA9IEV2ZW50RW1pdHRlci5wcm90b3R5cGUuYWRkTGlzdGVuZXI7XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUub25jZSA9IGZ1bmN0aW9uKHR5cGUsIGxpc3RlbmVyKSB7XG4gIGlmICghaXNGdW5jdGlvbihsaXN0ZW5lcikpXG4gICAgdGhyb3cgVHlwZUVycm9yKCdsaXN0ZW5lciBtdXN0IGJlIGEgZnVuY3Rpb24nKTtcblxuICB2YXIgZmlyZWQgPSBmYWxzZTtcblxuICBmdW5jdGlvbiBnKCkge1xuICAgIHRoaXMucmVtb3ZlTGlzdGVuZXIodHlwZSwgZyk7XG5cbiAgICBpZiAoIWZpcmVkKSB7XG4gICAgICBmaXJlZCA9IHRydWU7XG4gICAgICBsaXN0ZW5lci5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgIH1cbiAgfVxuXG4gIGcubGlzdGVuZXIgPSBsaXN0ZW5lcjtcbiAgdGhpcy5vbih0eXBlLCBnKTtcblxuICByZXR1cm4gdGhpcztcbn07XG5cbi8vIGVtaXRzIGEgJ3JlbW92ZUxpc3RlbmVyJyBldmVudCBpZmYgdGhlIGxpc3RlbmVyIHdhcyByZW1vdmVkXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLnJlbW92ZUxpc3RlbmVyID0gZnVuY3Rpb24odHlwZSwgbGlzdGVuZXIpIHtcbiAgdmFyIGxpc3QsIHBvc2l0aW9uLCBsZW5ndGgsIGk7XG5cbiAgaWYgKCFpc0Z1bmN0aW9uKGxpc3RlbmVyKSlcbiAgICB0aHJvdyBUeXBlRXJyb3IoJ2xpc3RlbmVyIG11c3QgYmUgYSBmdW5jdGlvbicpO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzIHx8ICF0aGlzLl9ldmVudHNbdHlwZV0pXG4gICAgcmV0dXJuIHRoaXM7XG5cbiAgbGlzdCA9IHRoaXMuX2V2ZW50c1t0eXBlXTtcbiAgbGVuZ3RoID0gbGlzdC5sZW5ndGg7XG4gIHBvc2l0aW9uID0gLTE7XG5cbiAgaWYgKGxpc3QgPT09IGxpc3RlbmVyIHx8XG4gICAgICAoaXNGdW5jdGlvbihsaXN0Lmxpc3RlbmVyKSAmJiBsaXN0Lmxpc3RlbmVyID09PSBsaXN0ZW5lcikpIHtcbiAgICBkZWxldGUgdGhpcy5fZXZlbnRzW3R5cGVdO1xuICAgIGlmICh0aGlzLl9ldmVudHMucmVtb3ZlTGlzdGVuZXIpXG4gICAgICB0aGlzLmVtaXQoJ3JlbW92ZUxpc3RlbmVyJywgdHlwZSwgbGlzdGVuZXIpO1xuXG4gIH0gZWxzZSBpZiAoaXNPYmplY3QobGlzdCkpIHtcbiAgICBmb3IgKGkgPSBsZW5ndGg7IGktLSA+IDA7KSB7XG4gICAgICBpZiAobGlzdFtpXSA9PT0gbGlzdGVuZXIgfHxcbiAgICAgICAgICAobGlzdFtpXS5saXN0ZW5lciAmJiBsaXN0W2ldLmxpc3RlbmVyID09PSBsaXN0ZW5lcikpIHtcbiAgICAgICAgcG9zaXRpb24gPSBpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAocG9zaXRpb24gPCAwKVxuICAgICAgcmV0dXJuIHRoaXM7XG5cbiAgICBpZiAobGlzdC5sZW5ndGggPT09IDEpIHtcbiAgICAgIGxpc3QubGVuZ3RoID0gMDtcbiAgICAgIGRlbGV0ZSB0aGlzLl9ldmVudHNbdHlwZV07XG4gICAgfSBlbHNlIHtcbiAgICAgIGxpc3Quc3BsaWNlKHBvc2l0aW9uLCAxKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5fZXZlbnRzLnJlbW92ZUxpc3RlbmVyKVxuICAgICAgdGhpcy5lbWl0KCdyZW1vdmVMaXN0ZW5lcicsIHR5cGUsIGxpc3RlbmVyKTtcbiAgfVxuXG4gIHJldHVybiB0aGlzO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5yZW1vdmVBbGxMaXN0ZW5lcnMgPSBmdW5jdGlvbih0eXBlKSB7XG4gIHZhciBrZXksIGxpc3RlbmVycztcblxuICBpZiAoIXRoaXMuX2V2ZW50cylcbiAgICByZXR1cm4gdGhpcztcblxuICAvLyBub3QgbGlzdGVuaW5nIGZvciByZW1vdmVMaXN0ZW5lciwgbm8gbmVlZCB0byBlbWl0XG4gIGlmICghdGhpcy5fZXZlbnRzLnJlbW92ZUxpc3RlbmVyKSB7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDApXG4gICAgICB0aGlzLl9ldmVudHMgPSB7fTtcbiAgICBlbHNlIGlmICh0aGlzLl9ldmVudHNbdHlwZV0pXG4gICAgICBkZWxldGUgdGhpcy5fZXZlbnRzW3R5cGVdO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLy8gZW1pdCByZW1vdmVMaXN0ZW5lciBmb3IgYWxsIGxpc3RlbmVycyBvbiBhbGwgZXZlbnRzXG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgZm9yIChrZXkgaW4gdGhpcy5fZXZlbnRzKSB7XG4gICAgICBpZiAoa2V5ID09PSAncmVtb3ZlTGlzdGVuZXInKSBjb250aW51ZTtcbiAgICAgIHRoaXMucmVtb3ZlQWxsTGlzdGVuZXJzKGtleSk7XG4gICAgfVxuICAgIHRoaXMucmVtb3ZlQWxsTGlzdGVuZXJzKCdyZW1vdmVMaXN0ZW5lcicpO1xuICAgIHRoaXMuX2V2ZW50cyA9IHt9O1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgbGlzdGVuZXJzID0gdGhpcy5fZXZlbnRzW3R5cGVdO1xuXG4gIGlmIChpc0Z1bmN0aW9uKGxpc3RlbmVycykpIHtcbiAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKHR5cGUsIGxpc3RlbmVycyk7XG4gIH0gZWxzZSBpZiAobGlzdGVuZXJzKSB7XG4gICAgLy8gTElGTyBvcmRlclxuICAgIHdoaWxlIChsaXN0ZW5lcnMubGVuZ3RoKVxuICAgICAgdGhpcy5yZW1vdmVMaXN0ZW5lcih0eXBlLCBsaXN0ZW5lcnNbbGlzdGVuZXJzLmxlbmd0aCAtIDFdKTtcbiAgfVxuICBkZWxldGUgdGhpcy5fZXZlbnRzW3R5cGVdO1xuXG4gIHJldHVybiB0aGlzO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5saXN0ZW5lcnMgPSBmdW5jdGlvbih0eXBlKSB7XG4gIHZhciByZXQ7XG4gIGlmICghdGhpcy5fZXZlbnRzIHx8ICF0aGlzLl9ldmVudHNbdHlwZV0pXG4gICAgcmV0ID0gW107XG4gIGVsc2UgaWYgKGlzRnVuY3Rpb24odGhpcy5fZXZlbnRzW3R5cGVdKSlcbiAgICByZXQgPSBbdGhpcy5fZXZlbnRzW3R5cGVdXTtcbiAgZWxzZVxuICAgIHJldCA9IHRoaXMuX2V2ZW50c1t0eXBlXS5zbGljZSgpO1xuICByZXR1cm4gcmV0O1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5saXN0ZW5lckNvdW50ID0gZnVuY3Rpb24odHlwZSkge1xuICBpZiAodGhpcy5fZXZlbnRzKSB7XG4gICAgdmFyIGV2bGlzdGVuZXIgPSB0aGlzLl9ldmVudHNbdHlwZV07XG5cbiAgICBpZiAoaXNGdW5jdGlvbihldmxpc3RlbmVyKSlcbiAgICAgIHJldHVybiAxO1xuICAgIGVsc2UgaWYgKGV2bGlzdGVuZXIpXG4gICAgICByZXR1cm4gZXZsaXN0ZW5lci5sZW5ndGg7XG4gIH1cbiAgcmV0dXJuIDA7XG59O1xuXG5FdmVudEVtaXR0ZXIubGlzdGVuZXJDb3VudCA9IGZ1bmN0aW9uKGVtaXR0ZXIsIHR5cGUpIHtcbiAgcmV0dXJuIGVtaXR0ZXIubGlzdGVuZXJDb3VudCh0eXBlKTtcbn07XG5cbmZ1bmN0aW9uIGlzRnVuY3Rpb24oYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnZnVuY3Rpb24nO1xufVxuXG5mdW5jdGlvbiBpc051bWJlcihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdudW1iZXInO1xufVxuXG5mdW5jdGlvbiBpc09iamVjdChhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdvYmplY3QnICYmIGFyZyAhPT0gbnVsbDtcbn1cblxuZnVuY3Rpb24gaXNVbmRlZmluZWQoYXJnKSB7XG4gIHJldHVybiBhcmcgPT09IHZvaWQgMDtcbn1cbiIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG4vLyByZXNvbHZlcyAuIGFuZCAuLiBlbGVtZW50cyBpbiBhIHBhdGggYXJyYXkgd2l0aCBkaXJlY3RvcnkgbmFtZXMgdGhlcmVcbi8vIG11c3QgYmUgbm8gc2xhc2hlcywgZW1wdHkgZWxlbWVudHMsIG9yIGRldmljZSBuYW1lcyAoYzpcXCkgaW4gdGhlIGFycmF5XG4vLyAoc28gYWxzbyBubyBsZWFkaW5nIGFuZCB0cmFpbGluZyBzbGFzaGVzIC0gaXQgZG9lcyBub3QgZGlzdGluZ3Vpc2hcbi8vIHJlbGF0aXZlIGFuZCBhYnNvbHV0ZSBwYXRocylcbmZ1bmN0aW9uIG5vcm1hbGl6ZUFycmF5KHBhcnRzLCBhbGxvd0Fib3ZlUm9vdCkge1xuICAvLyBpZiB0aGUgcGF0aCB0cmllcyB0byBnbyBhYm92ZSB0aGUgcm9vdCwgYHVwYCBlbmRzIHVwID4gMFxuICB2YXIgdXAgPSAwO1xuICBmb3IgKHZhciBpID0gcGFydHMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICB2YXIgbGFzdCA9IHBhcnRzW2ldO1xuICAgIGlmIChsYXN0ID09PSAnLicpIHtcbiAgICAgIHBhcnRzLnNwbGljZShpLCAxKTtcbiAgICB9IGVsc2UgaWYgKGxhc3QgPT09ICcuLicpIHtcbiAgICAgIHBhcnRzLnNwbGljZShpLCAxKTtcbiAgICAgIHVwKys7XG4gICAgfSBlbHNlIGlmICh1cCkge1xuICAgICAgcGFydHMuc3BsaWNlKGksIDEpO1xuICAgICAgdXAtLTtcbiAgICB9XG4gIH1cblxuICAvLyBpZiB0aGUgcGF0aCBpcyBhbGxvd2VkIHRvIGdvIGFib3ZlIHRoZSByb290LCByZXN0b3JlIGxlYWRpbmcgLi5zXG4gIGlmIChhbGxvd0Fib3ZlUm9vdCkge1xuICAgIGZvciAoOyB1cC0tOyB1cCkge1xuICAgICAgcGFydHMudW5zaGlmdCgnLi4nKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcGFydHM7XG59XG5cbi8vIFNwbGl0IGEgZmlsZW5hbWUgaW50byBbcm9vdCwgZGlyLCBiYXNlbmFtZSwgZXh0XSwgdW5peCB2ZXJzaW9uXG4vLyAncm9vdCcgaXMganVzdCBhIHNsYXNoLCBvciBub3RoaW5nLlxudmFyIHNwbGl0UGF0aFJlID1cbiAgICAvXihcXC8/fCkoW1xcc1xcU10qPykoKD86XFwuezEsMn18W15cXC9dKz98KShcXC5bXi5cXC9dKnwpKSg/OltcXC9dKikkLztcbnZhciBzcGxpdFBhdGggPSBmdW5jdGlvbihmaWxlbmFtZSkge1xuICByZXR1cm4gc3BsaXRQYXRoUmUuZXhlYyhmaWxlbmFtZSkuc2xpY2UoMSk7XG59O1xuXG4vLyBwYXRoLnJlc29sdmUoW2Zyb20gLi4uXSwgdG8pXG4vLyBwb3NpeCB2ZXJzaW9uXG5leHBvcnRzLnJlc29sdmUgPSBmdW5jdGlvbigpIHtcbiAgdmFyIHJlc29sdmVkUGF0aCA9ICcnLFxuICAgICAgcmVzb2x2ZWRBYnNvbHV0ZSA9IGZhbHNlO1xuXG4gIGZvciAodmFyIGkgPSBhcmd1bWVudHMubGVuZ3RoIC0gMTsgaSA+PSAtMSAmJiAhcmVzb2x2ZWRBYnNvbHV0ZTsgaS0tKSB7XG4gICAgdmFyIHBhdGggPSAoaSA+PSAwKSA/IGFyZ3VtZW50c1tpXSA6IHByb2Nlc3MuY3dkKCk7XG5cbiAgICAvLyBTa2lwIGVtcHR5IGFuZCBpbnZhbGlkIGVudHJpZXNcbiAgICBpZiAodHlwZW9mIHBhdGggIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdBcmd1bWVudHMgdG8gcGF0aC5yZXNvbHZlIG11c3QgYmUgc3RyaW5ncycpO1xuICAgIH0gZWxzZSBpZiAoIXBhdGgpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIHJlc29sdmVkUGF0aCA9IHBhdGggKyAnLycgKyByZXNvbHZlZFBhdGg7XG4gICAgcmVzb2x2ZWRBYnNvbHV0ZSA9IHBhdGguY2hhckF0KDApID09PSAnLyc7XG4gIH1cblxuICAvLyBBdCB0aGlzIHBvaW50IHRoZSBwYXRoIHNob3VsZCBiZSByZXNvbHZlZCB0byBhIGZ1bGwgYWJzb2x1dGUgcGF0aCwgYnV0XG4gIC8vIGhhbmRsZSByZWxhdGl2ZSBwYXRocyB0byBiZSBzYWZlIChtaWdodCBoYXBwZW4gd2hlbiBwcm9jZXNzLmN3ZCgpIGZhaWxzKVxuXG4gIC8vIE5vcm1hbGl6ZSB0aGUgcGF0aFxuICByZXNvbHZlZFBhdGggPSBub3JtYWxpemVBcnJheShmaWx0ZXIocmVzb2x2ZWRQYXRoLnNwbGl0KCcvJyksIGZ1bmN0aW9uKHApIHtcbiAgICByZXR1cm4gISFwO1xuICB9KSwgIXJlc29sdmVkQWJzb2x1dGUpLmpvaW4oJy8nKTtcblxuICByZXR1cm4gKChyZXNvbHZlZEFic29sdXRlID8gJy8nIDogJycpICsgcmVzb2x2ZWRQYXRoKSB8fCAnLic7XG59O1xuXG4vLyBwYXRoLm5vcm1hbGl6ZShwYXRoKVxuLy8gcG9zaXggdmVyc2lvblxuZXhwb3J0cy5ub3JtYWxpemUgPSBmdW5jdGlvbihwYXRoKSB7XG4gIHZhciBpc0Fic29sdXRlID0gZXhwb3J0cy5pc0Fic29sdXRlKHBhdGgpLFxuICAgICAgdHJhaWxpbmdTbGFzaCA9IHN1YnN0cihwYXRoLCAtMSkgPT09ICcvJztcblxuICAvLyBOb3JtYWxpemUgdGhlIHBhdGhcbiAgcGF0aCA9IG5vcm1hbGl6ZUFycmF5KGZpbHRlcihwYXRoLnNwbGl0KCcvJyksIGZ1bmN0aW9uKHApIHtcbiAgICByZXR1cm4gISFwO1xuICB9KSwgIWlzQWJzb2x1dGUpLmpvaW4oJy8nKTtcblxuICBpZiAoIXBhdGggJiYgIWlzQWJzb2x1dGUpIHtcbiAgICBwYXRoID0gJy4nO1xuICB9XG4gIGlmIChwYXRoICYmIHRyYWlsaW5nU2xhc2gpIHtcbiAgICBwYXRoICs9ICcvJztcbiAgfVxuXG4gIHJldHVybiAoaXNBYnNvbHV0ZSA/ICcvJyA6ICcnKSArIHBhdGg7XG59O1xuXG4vLyBwb3NpeCB2ZXJzaW9uXG5leHBvcnRzLmlzQWJzb2x1dGUgPSBmdW5jdGlvbihwYXRoKSB7XG4gIHJldHVybiBwYXRoLmNoYXJBdCgwKSA9PT0gJy8nO1xufTtcblxuLy8gcG9zaXggdmVyc2lvblxuZXhwb3J0cy5qb2luID0gZnVuY3Rpb24oKSB7XG4gIHZhciBwYXRocyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMCk7XG4gIHJldHVybiBleHBvcnRzLm5vcm1hbGl6ZShmaWx0ZXIocGF0aHMsIGZ1bmN0aW9uKHAsIGluZGV4KSB7XG4gICAgaWYgKHR5cGVvZiBwICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignQXJndW1lbnRzIHRvIHBhdGguam9pbiBtdXN0IGJlIHN0cmluZ3MnKTtcbiAgICB9XG4gICAgcmV0dXJuIHA7XG4gIH0pLmpvaW4oJy8nKSk7XG59O1xuXG5cbi8vIHBhdGgucmVsYXRpdmUoZnJvbSwgdG8pXG4vLyBwb3NpeCB2ZXJzaW9uXG5leHBvcnRzLnJlbGF0aXZlID0gZnVuY3Rpb24oZnJvbSwgdG8pIHtcbiAgZnJvbSA9IGV4cG9ydHMucmVzb2x2ZShmcm9tKS5zdWJzdHIoMSk7XG4gIHRvID0gZXhwb3J0cy5yZXNvbHZlKHRvKS5zdWJzdHIoMSk7XG5cbiAgZnVuY3Rpb24gdHJpbShhcnIpIHtcbiAgICB2YXIgc3RhcnQgPSAwO1xuICAgIGZvciAoOyBzdGFydCA8IGFyci5sZW5ndGg7IHN0YXJ0KyspIHtcbiAgICAgIGlmIChhcnJbc3RhcnRdICE9PSAnJykgYnJlYWs7XG4gICAgfVxuXG4gICAgdmFyIGVuZCA9IGFyci5sZW5ndGggLSAxO1xuICAgIGZvciAoOyBlbmQgPj0gMDsgZW5kLS0pIHtcbiAgICAgIGlmIChhcnJbZW5kXSAhPT0gJycpIGJyZWFrO1xuICAgIH1cblxuICAgIGlmIChzdGFydCA+IGVuZCkgcmV0dXJuIFtdO1xuICAgIHJldHVybiBhcnIuc2xpY2Uoc3RhcnQsIGVuZCAtIHN0YXJ0ICsgMSk7XG4gIH1cblxuICB2YXIgZnJvbVBhcnRzID0gdHJpbShmcm9tLnNwbGl0KCcvJykpO1xuICB2YXIgdG9QYXJ0cyA9IHRyaW0odG8uc3BsaXQoJy8nKSk7XG5cbiAgdmFyIGxlbmd0aCA9IE1hdGgubWluKGZyb21QYXJ0cy5sZW5ndGgsIHRvUGFydHMubGVuZ3RoKTtcbiAgdmFyIHNhbWVQYXJ0c0xlbmd0aCA9IGxlbmd0aDtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGg7IGkrKykge1xuICAgIGlmIChmcm9tUGFydHNbaV0gIT09IHRvUGFydHNbaV0pIHtcbiAgICAgIHNhbWVQYXJ0c0xlbmd0aCA9IGk7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICB2YXIgb3V0cHV0UGFydHMgPSBbXTtcbiAgZm9yICh2YXIgaSA9IHNhbWVQYXJ0c0xlbmd0aDsgaSA8IGZyb21QYXJ0cy5sZW5ndGg7IGkrKykge1xuICAgIG91dHB1dFBhcnRzLnB1c2goJy4uJyk7XG4gIH1cblxuICBvdXRwdXRQYXJ0cyA9IG91dHB1dFBhcnRzLmNvbmNhdCh0b1BhcnRzLnNsaWNlKHNhbWVQYXJ0c0xlbmd0aCkpO1xuXG4gIHJldHVybiBvdXRwdXRQYXJ0cy5qb2luKCcvJyk7XG59O1xuXG5leHBvcnRzLnNlcCA9ICcvJztcbmV4cG9ydHMuZGVsaW1pdGVyID0gJzonO1xuXG5leHBvcnRzLmRpcm5hbWUgPSBmdW5jdGlvbihwYXRoKSB7XG4gIHZhciByZXN1bHQgPSBzcGxpdFBhdGgocGF0aCksXG4gICAgICByb290ID0gcmVzdWx0WzBdLFxuICAgICAgZGlyID0gcmVzdWx0WzFdO1xuXG4gIGlmICghcm9vdCAmJiAhZGlyKSB7XG4gICAgLy8gTm8gZGlybmFtZSB3aGF0c29ldmVyXG4gICAgcmV0dXJuICcuJztcbiAgfVxuXG4gIGlmIChkaXIpIHtcbiAgICAvLyBJdCBoYXMgYSBkaXJuYW1lLCBzdHJpcCB0cmFpbGluZyBzbGFzaFxuICAgIGRpciA9IGRpci5zdWJzdHIoMCwgZGlyLmxlbmd0aCAtIDEpO1xuICB9XG5cbiAgcmV0dXJuIHJvb3QgKyBkaXI7XG59O1xuXG5cbmV4cG9ydHMuYmFzZW5hbWUgPSBmdW5jdGlvbihwYXRoLCBleHQpIHtcbiAgdmFyIGYgPSBzcGxpdFBhdGgocGF0aClbMl07XG4gIC8vIFRPRE86IG1ha2UgdGhpcyBjb21wYXJpc29uIGNhc2UtaW5zZW5zaXRpdmUgb24gd2luZG93cz9cbiAgaWYgKGV4dCAmJiBmLnN1YnN0cigtMSAqIGV4dC5sZW5ndGgpID09PSBleHQpIHtcbiAgICBmID0gZi5zdWJzdHIoMCwgZi5sZW5ndGggLSBleHQubGVuZ3RoKTtcbiAgfVxuICByZXR1cm4gZjtcbn07XG5cblxuZXhwb3J0cy5leHRuYW1lID0gZnVuY3Rpb24ocGF0aCkge1xuICByZXR1cm4gc3BsaXRQYXRoKHBhdGgpWzNdO1xufTtcblxuZnVuY3Rpb24gZmlsdGVyICh4cywgZikge1xuICAgIGlmICh4cy5maWx0ZXIpIHJldHVybiB4cy5maWx0ZXIoZik7XG4gICAgdmFyIHJlcyA9IFtdO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgeHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKGYoeHNbaV0sIGksIHhzKSkgcmVzLnB1c2goeHNbaV0pO1xuICAgIH1cbiAgICByZXR1cm4gcmVzO1xufVxuXG4vLyBTdHJpbmcucHJvdG90eXBlLnN1YnN0ciAtIG5lZ2F0aXZlIGluZGV4IGRvbid0IHdvcmsgaW4gSUU4XG52YXIgc3Vic3RyID0gJ2FiJy5zdWJzdHIoLTEpID09PSAnYidcbiAgICA/IGZ1bmN0aW9uIChzdHIsIHN0YXJ0LCBsZW4pIHsgcmV0dXJuIHN0ci5zdWJzdHIoc3RhcnQsIGxlbikgfVxuICAgIDogZnVuY3Rpb24gKHN0ciwgc3RhcnQsIGxlbikge1xuICAgICAgICBpZiAoc3RhcnQgPCAwKSBzdGFydCA9IHN0ci5sZW5ndGggKyBzdGFydDtcbiAgICAgICAgcmV0dXJuIHN0ci5zdWJzdHIoc3RhcnQsIGxlbik7XG4gICAgfVxuO1xuIiwiLy8gc2hpbSBmb3IgdXNpbmcgcHJvY2VzcyBpbiBicm93c2VyXG52YXIgcHJvY2VzcyA9IG1vZHVsZS5leHBvcnRzID0ge307XG5cbi8vIGNhY2hlZCBmcm9tIHdoYXRldmVyIGdsb2JhbCBpcyBwcmVzZW50IHNvIHRoYXQgdGVzdCBydW5uZXJzIHRoYXQgc3R1YiBpdFxuLy8gZG9uJ3QgYnJlYWsgdGhpbmdzLiAgQnV0IHdlIG5lZWQgdG8gd3JhcCBpdCBpbiBhIHRyeSBjYXRjaCBpbiBjYXNlIGl0IGlzXG4vLyB3cmFwcGVkIGluIHN0cmljdCBtb2RlIGNvZGUgd2hpY2ggZG9lc24ndCBkZWZpbmUgYW55IGdsb2JhbHMuICBJdCdzIGluc2lkZSBhXG4vLyBmdW5jdGlvbiBiZWNhdXNlIHRyeS9jYXRjaGVzIGRlb3B0aW1pemUgaW4gY2VydGFpbiBlbmdpbmVzLlxuXG52YXIgY2FjaGVkU2V0VGltZW91dDtcbnZhciBjYWNoZWRDbGVhclRpbWVvdXQ7XG5cbmZ1bmN0aW9uIGRlZmF1bHRTZXRUaW1vdXQoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdzZXRUaW1lb3V0IGhhcyBub3QgYmVlbiBkZWZpbmVkJyk7XG59XG5mdW5jdGlvbiBkZWZhdWx0Q2xlYXJUaW1lb3V0ICgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ2NsZWFyVGltZW91dCBoYXMgbm90IGJlZW4gZGVmaW5lZCcpO1xufVxuKGZ1bmN0aW9uICgpIHtcbiAgICB0cnkge1xuICAgICAgICBpZiAodHlwZW9mIHNldFRpbWVvdXQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGNhY2hlZFNldFRpbWVvdXQgPSBzZXRUaW1lb3V0O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY2FjaGVkU2V0VGltZW91dCA9IGRlZmF1bHRTZXRUaW1vdXQ7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNhY2hlZFNldFRpbWVvdXQgPSBkZWZhdWx0U2V0VGltb3V0O1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICBpZiAodHlwZW9mIGNsZWFyVGltZW91dCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FjaGVkQ2xlYXJUaW1lb3V0ID0gY2xlYXJUaW1lb3V0O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY2FjaGVkQ2xlYXJUaW1lb3V0ID0gZGVmYXVsdENsZWFyVGltZW91dDtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY2FjaGVkQ2xlYXJUaW1lb3V0ID0gZGVmYXVsdENsZWFyVGltZW91dDtcbiAgICB9XG59ICgpKVxuZnVuY3Rpb24gcnVuVGltZW91dChmdW4pIHtcbiAgICBpZiAoY2FjaGVkU2V0VGltZW91dCA9PT0gc2V0VGltZW91dCkge1xuICAgICAgICAvL25vcm1hbCBlbnZpcm9tZW50cyBpbiBzYW5lIHNpdHVhdGlvbnNcbiAgICAgICAgcmV0dXJuIHNldFRpbWVvdXQoZnVuLCAwKTtcbiAgICB9XG4gICAgLy8gaWYgc2V0VGltZW91dCB3YXNuJ3QgYXZhaWxhYmxlIGJ1dCB3YXMgbGF0dGVyIGRlZmluZWRcbiAgICBpZiAoKGNhY2hlZFNldFRpbWVvdXQgPT09IGRlZmF1bHRTZXRUaW1vdXQgfHwgIWNhY2hlZFNldFRpbWVvdXQpICYmIHNldFRpbWVvdXQpIHtcbiAgICAgICAgY2FjaGVkU2V0VGltZW91dCA9IHNldFRpbWVvdXQ7XG4gICAgICAgIHJldHVybiBzZXRUaW1lb3V0KGZ1biwgMCk7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIC8vIHdoZW4gd2hlbiBzb21lYm9keSBoYXMgc2NyZXdlZCB3aXRoIHNldFRpbWVvdXQgYnV0IG5vIEkuRS4gbWFkZG5lc3NcbiAgICAgICAgcmV0dXJuIGNhY2hlZFNldFRpbWVvdXQoZnVuLCAwKTtcbiAgICB9IGNhdGNoKGUpe1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8gV2hlbiB3ZSBhcmUgaW4gSS5FLiBidXQgdGhlIHNjcmlwdCBoYXMgYmVlbiBldmFsZWQgc28gSS5FLiBkb2Vzbid0IHRydXN0IHRoZSBnbG9iYWwgb2JqZWN0IHdoZW4gY2FsbGVkIG5vcm1hbGx5XG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkU2V0VGltZW91dC5jYWxsKG51bGwsIGZ1biwgMCk7XG4gICAgICAgIH0gY2F0Y2goZSl7XG4gICAgICAgICAgICAvLyBzYW1lIGFzIGFib3ZlIGJ1dCB3aGVuIGl0J3MgYSB2ZXJzaW9uIG9mIEkuRS4gdGhhdCBtdXN0IGhhdmUgdGhlIGdsb2JhbCBvYmplY3QgZm9yICd0aGlzJywgaG9wZnVsbHkgb3VyIGNvbnRleHQgY29ycmVjdCBvdGhlcndpc2UgaXQgd2lsbCB0aHJvdyBhIGdsb2JhbCBlcnJvclxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZFNldFRpbWVvdXQuY2FsbCh0aGlzLCBmdW4sIDApO1xuICAgICAgICB9XG4gICAgfVxuXG5cbn1cbmZ1bmN0aW9uIHJ1bkNsZWFyVGltZW91dChtYXJrZXIpIHtcbiAgICBpZiAoY2FjaGVkQ2xlYXJUaW1lb3V0ID09PSBjbGVhclRpbWVvdXQpIHtcbiAgICAgICAgLy9ub3JtYWwgZW52aXJvbWVudHMgaW4gc2FuZSBzaXR1YXRpb25zXG4gICAgICAgIHJldHVybiBjbGVhclRpbWVvdXQobWFya2VyKTtcbiAgICB9XG4gICAgLy8gaWYgY2xlYXJUaW1lb3V0IHdhc24ndCBhdmFpbGFibGUgYnV0IHdhcyBsYXR0ZXIgZGVmaW5lZFxuICAgIGlmICgoY2FjaGVkQ2xlYXJUaW1lb3V0ID09PSBkZWZhdWx0Q2xlYXJUaW1lb3V0IHx8ICFjYWNoZWRDbGVhclRpbWVvdXQpICYmIGNsZWFyVGltZW91dCkge1xuICAgICAgICBjYWNoZWRDbGVhclRpbWVvdXQgPSBjbGVhclRpbWVvdXQ7XG4gICAgICAgIHJldHVybiBjbGVhclRpbWVvdXQobWFya2VyKTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgLy8gd2hlbiB3aGVuIHNvbWVib2R5IGhhcyBzY3Jld2VkIHdpdGggc2V0VGltZW91dCBidXQgbm8gSS5FLiBtYWRkbmVzc1xuICAgICAgICByZXR1cm4gY2FjaGVkQ2xlYXJUaW1lb3V0KG1hcmtlcik7XG4gICAgfSBjYXRjaCAoZSl7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBXaGVuIHdlIGFyZSBpbiBJLkUuIGJ1dCB0aGUgc2NyaXB0IGhhcyBiZWVuIGV2YWxlZCBzbyBJLkUuIGRvZXNuJ3QgIHRydXN0IHRoZSBnbG9iYWwgb2JqZWN0IHdoZW4gY2FsbGVkIG5vcm1hbGx5XG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkQ2xlYXJUaW1lb3V0LmNhbGwobnVsbCwgbWFya2VyKTtcbiAgICAgICAgfSBjYXRjaCAoZSl7XG4gICAgICAgICAgICAvLyBzYW1lIGFzIGFib3ZlIGJ1dCB3aGVuIGl0J3MgYSB2ZXJzaW9uIG9mIEkuRS4gdGhhdCBtdXN0IGhhdmUgdGhlIGdsb2JhbCBvYmplY3QgZm9yICd0aGlzJywgaG9wZnVsbHkgb3VyIGNvbnRleHQgY29ycmVjdCBvdGhlcndpc2UgaXQgd2lsbCB0aHJvdyBhIGdsb2JhbCBlcnJvci5cbiAgICAgICAgICAgIC8vIFNvbWUgdmVyc2lvbnMgb2YgSS5FLiBoYXZlIGRpZmZlcmVudCBydWxlcyBmb3IgY2xlYXJUaW1lb3V0IHZzIHNldFRpbWVvdXRcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWRDbGVhclRpbWVvdXQuY2FsbCh0aGlzLCBtYXJrZXIpO1xuICAgICAgICB9XG4gICAgfVxuXG5cblxufVxudmFyIHF1ZXVlID0gW107XG52YXIgZHJhaW5pbmcgPSBmYWxzZTtcbnZhciBjdXJyZW50UXVldWU7XG52YXIgcXVldWVJbmRleCA9IC0xO1xuXG5mdW5jdGlvbiBjbGVhblVwTmV4dFRpY2soKSB7XG4gICAgaWYgKCFkcmFpbmluZyB8fCAhY3VycmVudFF1ZXVlKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZHJhaW5pbmcgPSBmYWxzZTtcbiAgICBpZiAoY3VycmVudFF1ZXVlLmxlbmd0aCkge1xuICAgICAgICBxdWV1ZSA9IGN1cnJlbnRRdWV1ZS5jb25jYXQocXVldWUpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHF1ZXVlSW5kZXggPSAtMTtcbiAgICB9XG4gICAgaWYgKHF1ZXVlLmxlbmd0aCkge1xuICAgICAgICBkcmFpblF1ZXVlKCk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBkcmFpblF1ZXVlKCkge1xuICAgIGlmIChkcmFpbmluZykge1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIHZhciB0aW1lb3V0ID0gcnVuVGltZW91dChjbGVhblVwTmV4dFRpY2spO1xuICAgIGRyYWluaW5nID0gdHJ1ZTtcblxuICAgIHZhciBsZW4gPSBxdWV1ZS5sZW5ndGg7XG4gICAgd2hpbGUobGVuKSB7XG4gICAgICAgIGN1cnJlbnRRdWV1ZSA9IHF1ZXVlO1xuICAgICAgICBxdWV1ZSA9IFtdO1xuICAgICAgICB3aGlsZSAoKytxdWV1ZUluZGV4IDwgbGVuKSB7XG4gICAgICAgICAgICBpZiAoY3VycmVudFF1ZXVlKSB7XG4gICAgICAgICAgICAgICAgY3VycmVudFF1ZXVlW3F1ZXVlSW5kZXhdLnJ1bigpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHF1ZXVlSW5kZXggPSAtMTtcbiAgICAgICAgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIH1cbiAgICBjdXJyZW50UXVldWUgPSBudWxsO1xuICAgIGRyYWluaW5nID0gZmFsc2U7XG4gICAgcnVuQ2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xufVxuXG5wcm9jZXNzLm5leHRUaWNrID0gZnVuY3Rpb24gKGZ1bikge1xuICAgIHZhciBhcmdzID0gbmV3IEFycmF5KGFyZ3VtZW50cy5sZW5ndGggLSAxKTtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgZm9yICh2YXIgaSA9IDE7IGkgPCBhcmd1bWVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIGFyZ3NbaSAtIDFdID0gYXJndW1lbnRzW2ldO1xuICAgICAgICB9XG4gICAgfVxuICAgIHF1ZXVlLnB1c2gobmV3IEl0ZW0oZnVuLCBhcmdzKSk7XG4gICAgaWYgKHF1ZXVlLmxlbmd0aCA9PT0gMSAmJiAhZHJhaW5pbmcpIHtcbiAgICAgICAgcnVuVGltZW91dChkcmFpblF1ZXVlKTtcbiAgICB9XG59O1xuXG4vLyB2OCBsaWtlcyBwcmVkaWN0aWJsZSBvYmplY3RzXG5mdW5jdGlvbiBJdGVtKGZ1biwgYXJyYXkpIHtcbiAgICB0aGlzLmZ1biA9IGZ1bjtcbiAgICB0aGlzLmFycmF5ID0gYXJyYXk7XG59XG5JdGVtLnByb3RvdHlwZS5ydW4gPSBmdW5jdGlvbiAoKSB7XG4gICAgdGhpcy5mdW4uYXBwbHkobnVsbCwgdGhpcy5hcnJheSk7XG59O1xucHJvY2Vzcy50aXRsZSA9ICdicm93c2VyJztcbnByb2Nlc3MuYnJvd3NlciA9IHRydWU7XG5wcm9jZXNzLmVudiA9IHt9O1xucHJvY2Vzcy5hcmd2ID0gW107XG5wcm9jZXNzLnZlcnNpb24gPSAnJzsgLy8gZW1wdHkgc3RyaW5nIHRvIGF2b2lkIHJlZ2V4cCBpc3N1ZXNcbnByb2Nlc3MudmVyc2lvbnMgPSB7fTtcblxuZnVuY3Rpb24gbm9vcCgpIHt9XG5cbnByb2Nlc3Mub24gPSBub29wO1xucHJvY2Vzcy5hZGRMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLm9uY2UgPSBub29wO1xucHJvY2Vzcy5vZmYgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUFsbExpc3RlbmVycyA9IG5vb3A7XG5wcm9jZXNzLmVtaXQgPSBub29wO1xucHJvY2Vzcy5wcmVwZW5kTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5wcmVwZW5kT25jZUxpc3RlbmVyID0gbm9vcDtcblxucHJvY2Vzcy5saXN0ZW5lcnMgPSBmdW5jdGlvbiAobmFtZSkgeyByZXR1cm4gW10gfVxuXG5wcm9jZXNzLmJpbmRpbmcgPSBmdW5jdGlvbiAobmFtZSkge1xuICAgIHRocm93IG5ldyBFcnJvcigncHJvY2Vzcy5iaW5kaW5nIGlzIG5vdCBzdXBwb3J0ZWQnKTtcbn07XG5cbnByb2Nlc3MuY3dkID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gJy8nIH07XG5wcm9jZXNzLmNoZGlyID0gZnVuY3Rpb24gKGRpcikge1xuICAgIHRocm93IG5ldyBFcnJvcigncHJvY2Vzcy5jaGRpciBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xucHJvY2Vzcy51bWFzayA9IGZ1bmN0aW9uKCkgeyByZXR1cm4gMDsgfTtcbiIsImlmICh0eXBlb2YgT2JqZWN0LmNyZWF0ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAvLyBpbXBsZW1lbnRhdGlvbiBmcm9tIHN0YW5kYXJkIG5vZGUuanMgJ3V0aWwnIG1vZHVsZVxuICBtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGluaGVyaXRzKGN0b3IsIHN1cGVyQ3Rvcikge1xuICAgIGN0b3Iuc3VwZXJfID0gc3VwZXJDdG9yXG4gICAgY3Rvci5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKHN1cGVyQ3Rvci5wcm90b3R5cGUsIHtcbiAgICAgIGNvbnN0cnVjdG9yOiB7XG4gICAgICAgIHZhbHVlOiBjdG9yLFxuICAgICAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICAgICAgd3JpdGFibGU6IHRydWUsXG4gICAgICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZVxuICAgICAgfVxuICAgIH0pO1xuICB9O1xufSBlbHNlIHtcbiAgLy8gb2xkIHNjaG9vbCBzaGltIGZvciBvbGQgYnJvd3NlcnNcbiAgbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBpbmhlcml0cyhjdG9yLCBzdXBlckN0b3IpIHtcbiAgICBjdG9yLnN1cGVyXyA9IHN1cGVyQ3RvclxuICAgIHZhciBUZW1wQ3RvciA9IGZ1bmN0aW9uICgpIHt9XG4gICAgVGVtcEN0b3IucHJvdG90eXBlID0gc3VwZXJDdG9yLnByb3RvdHlwZVxuICAgIGN0b3IucHJvdG90eXBlID0gbmV3IFRlbXBDdG9yKClcbiAgICBjdG9yLnByb3RvdHlwZS5jb25zdHJ1Y3RvciA9IGN0b3JcbiAgfVxufVxuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBpc0J1ZmZlcihhcmcpIHtcbiAgcmV0dXJuIGFyZyAmJiB0eXBlb2YgYXJnID09PSAnb2JqZWN0J1xuICAgICYmIHR5cGVvZiBhcmcuY29weSA9PT0gJ2Z1bmN0aW9uJ1xuICAgICYmIHR5cGVvZiBhcmcuZmlsbCA9PT0gJ2Z1bmN0aW9uJ1xuICAgICYmIHR5cGVvZiBhcmcucmVhZFVJbnQ4ID09PSAnZnVuY3Rpb24nO1xufSIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG52YXIgZm9ybWF0UmVnRXhwID0gLyVbc2RqJV0vZztcbmV4cG9ydHMuZm9ybWF0ID0gZnVuY3Rpb24oZikge1xuICBpZiAoIWlzU3RyaW5nKGYpKSB7XG4gICAgdmFyIG9iamVjdHMgPSBbXTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgb2JqZWN0cy5wdXNoKGluc3BlY3QoYXJndW1lbnRzW2ldKSk7XG4gICAgfVxuICAgIHJldHVybiBvYmplY3RzLmpvaW4oJyAnKTtcbiAgfVxuXG4gIHZhciBpID0gMTtcbiAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gIHZhciBsZW4gPSBhcmdzLmxlbmd0aDtcbiAgdmFyIHN0ciA9IFN0cmluZyhmKS5yZXBsYWNlKGZvcm1hdFJlZ0V4cCwgZnVuY3Rpb24oeCkge1xuICAgIGlmICh4ID09PSAnJSUnKSByZXR1cm4gJyUnO1xuICAgIGlmIChpID49IGxlbikgcmV0dXJuIHg7XG4gICAgc3dpdGNoICh4KSB7XG4gICAgICBjYXNlICclcyc6IHJldHVybiBTdHJpbmcoYXJnc1tpKytdKTtcbiAgICAgIGNhc2UgJyVkJzogcmV0dXJuIE51bWJlcihhcmdzW2krK10pO1xuICAgICAgY2FzZSAnJWonOlxuICAgICAgICB0cnkge1xuICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShhcmdzW2krK10pO1xuICAgICAgICB9IGNhdGNoIChfKSB7XG4gICAgICAgICAgcmV0dXJuICdbQ2lyY3VsYXJdJztcbiAgICAgICAgfVxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIHg7XG4gICAgfVxuICB9KTtcbiAgZm9yICh2YXIgeCA9IGFyZ3NbaV07IGkgPCBsZW47IHggPSBhcmdzWysraV0pIHtcbiAgICBpZiAoaXNOdWxsKHgpIHx8ICFpc09iamVjdCh4KSkge1xuICAgICAgc3RyICs9ICcgJyArIHg7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0ciArPSAnICcgKyBpbnNwZWN0KHgpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gc3RyO1xufTtcblxuXG4vLyBNYXJrIHRoYXQgYSBtZXRob2Qgc2hvdWxkIG5vdCBiZSB1c2VkLlxuLy8gUmV0dXJucyBhIG1vZGlmaWVkIGZ1bmN0aW9uIHdoaWNoIHdhcm5zIG9uY2UgYnkgZGVmYXVsdC5cbi8vIElmIC0tbm8tZGVwcmVjYXRpb24gaXMgc2V0LCB0aGVuIGl0IGlzIGEgbm8tb3AuXG5leHBvcnRzLmRlcHJlY2F0ZSA9IGZ1bmN0aW9uKGZuLCBtc2cpIHtcbiAgLy8gQWxsb3cgZm9yIGRlcHJlY2F0aW5nIHRoaW5ncyBpbiB0aGUgcHJvY2VzcyBvZiBzdGFydGluZyB1cC5cbiAgaWYgKGlzVW5kZWZpbmVkKGdsb2JhbC5wcm9jZXNzKSkge1xuICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgIHJldHVybiBleHBvcnRzLmRlcHJlY2F0ZShmbiwgbXNnKS5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgIH07XG4gIH1cblxuICBpZiAocHJvY2Vzcy5ub0RlcHJlY2F0aW9uID09PSB0cnVlKSB7XG4gICAgcmV0dXJuIGZuO1xuICB9XG5cbiAgdmFyIHdhcm5lZCA9IGZhbHNlO1xuICBmdW5jdGlvbiBkZXByZWNhdGVkKCkge1xuICAgIGlmICghd2FybmVkKSB7XG4gICAgICBpZiAocHJvY2Vzcy50aHJvd0RlcHJlY2F0aW9uKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihtc2cpO1xuICAgICAgfSBlbHNlIGlmIChwcm9jZXNzLnRyYWNlRGVwcmVjYXRpb24pIHtcbiAgICAgICAgY29uc29sZS50cmFjZShtc2cpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihtc2cpO1xuICAgICAgfVxuICAgICAgd2FybmVkID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gIH1cblxuICByZXR1cm4gZGVwcmVjYXRlZDtcbn07XG5cblxudmFyIGRlYnVncyA9IHt9O1xudmFyIGRlYnVnRW52aXJvbjtcbmV4cG9ydHMuZGVidWdsb2cgPSBmdW5jdGlvbihzZXQpIHtcbiAgaWYgKGlzVW5kZWZpbmVkKGRlYnVnRW52aXJvbikpXG4gICAgZGVidWdFbnZpcm9uID0gcHJvY2Vzcy5lbnYuTk9ERV9ERUJVRyB8fCAnJztcbiAgc2V0ID0gc2V0LnRvVXBwZXJDYXNlKCk7XG4gIGlmICghZGVidWdzW3NldF0pIHtcbiAgICBpZiAobmV3IFJlZ0V4cCgnXFxcXGInICsgc2V0ICsgJ1xcXFxiJywgJ2knKS50ZXN0KGRlYnVnRW52aXJvbikpIHtcbiAgICAgIHZhciBwaWQgPSBwcm9jZXNzLnBpZDtcbiAgICAgIGRlYnVnc1tzZXRdID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIHZhciBtc2cgPSBleHBvcnRzLmZvcm1hdC5hcHBseShleHBvcnRzLCBhcmd1bWVudHMpO1xuICAgICAgICBjb25zb2xlLmVycm9yKCclcyAlZDogJXMnLCBzZXQsIHBpZCwgbXNnKTtcbiAgICAgIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIGRlYnVnc1tzZXRdID0gZnVuY3Rpb24oKSB7fTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGRlYnVnc1tzZXRdO1xufTtcblxuXG4vKipcbiAqIEVjaG9zIHRoZSB2YWx1ZSBvZiBhIHZhbHVlLiBUcnlzIHRvIHByaW50IHRoZSB2YWx1ZSBvdXRcbiAqIGluIHRoZSBiZXN0IHdheSBwb3NzaWJsZSBnaXZlbiB0aGUgZGlmZmVyZW50IHR5cGVzLlxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBvYmogVGhlIG9iamVjdCB0byBwcmludCBvdXQuXG4gKiBAcGFyYW0ge09iamVjdH0gb3B0cyBPcHRpb25hbCBvcHRpb25zIG9iamVjdCB0aGF0IGFsdGVycyB0aGUgb3V0cHV0LlxuICovXG4vKiBsZWdhY3k6IG9iaiwgc2hvd0hpZGRlbiwgZGVwdGgsIGNvbG9ycyovXG5mdW5jdGlvbiBpbnNwZWN0KG9iaiwgb3B0cykge1xuICAvLyBkZWZhdWx0IG9wdGlvbnNcbiAgdmFyIGN0eCA9IHtcbiAgICBzZWVuOiBbXSxcbiAgICBzdHlsaXplOiBzdHlsaXplTm9Db2xvclxuICB9O1xuICAvLyBsZWdhY3kuLi5cbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPj0gMykgY3R4LmRlcHRoID0gYXJndW1lbnRzWzJdO1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+PSA0KSBjdHguY29sb3JzID0gYXJndW1lbnRzWzNdO1xuICBpZiAoaXNCb29sZWFuKG9wdHMpKSB7XG4gICAgLy8gbGVnYWN5Li4uXG4gICAgY3R4LnNob3dIaWRkZW4gPSBvcHRzO1xuICB9IGVsc2UgaWYgKG9wdHMpIHtcbiAgICAvLyBnb3QgYW4gXCJvcHRpb25zXCIgb2JqZWN0XG4gICAgZXhwb3J0cy5fZXh0ZW5kKGN0eCwgb3B0cyk7XG4gIH1cbiAgLy8gc2V0IGRlZmF1bHQgb3B0aW9uc1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LnNob3dIaWRkZW4pKSBjdHguc2hvd0hpZGRlbiA9IGZhbHNlO1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LmRlcHRoKSkgY3R4LmRlcHRoID0gMjtcbiAgaWYgKGlzVW5kZWZpbmVkKGN0eC5jb2xvcnMpKSBjdHguY29sb3JzID0gZmFsc2U7XG4gIGlmIChpc1VuZGVmaW5lZChjdHguY3VzdG9tSW5zcGVjdCkpIGN0eC5jdXN0b21JbnNwZWN0ID0gdHJ1ZTtcbiAgaWYgKGN0eC5jb2xvcnMpIGN0eC5zdHlsaXplID0gc3R5bGl6ZVdpdGhDb2xvcjtcbiAgcmV0dXJuIGZvcm1hdFZhbHVlKGN0eCwgb2JqLCBjdHguZGVwdGgpO1xufVxuZXhwb3J0cy5pbnNwZWN0ID0gaW5zcGVjdDtcblxuXG4vLyBodHRwOi8vZW4ud2lraXBlZGlhLm9yZy93aWtpL0FOU0lfZXNjYXBlX2NvZGUjZ3JhcGhpY3Ncbmluc3BlY3QuY29sb3JzID0ge1xuICAnYm9sZCcgOiBbMSwgMjJdLFxuICAnaXRhbGljJyA6IFszLCAyM10sXG4gICd1bmRlcmxpbmUnIDogWzQsIDI0XSxcbiAgJ2ludmVyc2UnIDogWzcsIDI3XSxcbiAgJ3doaXRlJyA6IFszNywgMzldLFxuICAnZ3JleScgOiBbOTAsIDM5XSxcbiAgJ2JsYWNrJyA6IFszMCwgMzldLFxuICAnYmx1ZScgOiBbMzQsIDM5XSxcbiAgJ2N5YW4nIDogWzM2LCAzOV0sXG4gICdncmVlbicgOiBbMzIsIDM5XSxcbiAgJ21hZ2VudGEnIDogWzM1LCAzOV0sXG4gICdyZWQnIDogWzMxLCAzOV0sXG4gICd5ZWxsb3cnIDogWzMzLCAzOV1cbn07XG5cbi8vIERvbid0IHVzZSAnYmx1ZScgbm90IHZpc2libGUgb24gY21kLmV4ZVxuaW5zcGVjdC5zdHlsZXMgPSB7XG4gICdzcGVjaWFsJzogJ2N5YW4nLFxuICAnbnVtYmVyJzogJ3llbGxvdycsXG4gICdib29sZWFuJzogJ3llbGxvdycsXG4gICd1bmRlZmluZWQnOiAnZ3JleScsXG4gICdudWxsJzogJ2JvbGQnLFxuICAnc3RyaW5nJzogJ2dyZWVuJyxcbiAgJ2RhdGUnOiAnbWFnZW50YScsXG4gIC8vIFwibmFtZVwiOiBpbnRlbnRpb25hbGx5IG5vdCBzdHlsaW5nXG4gICdyZWdleHAnOiAncmVkJ1xufTtcblxuXG5mdW5jdGlvbiBzdHlsaXplV2l0aENvbG9yKHN0ciwgc3R5bGVUeXBlKSB7XG4gIHZhciBzdHlsZSA9IGluc3BlY3Quc3R5bGVzW3N0eWxlVHlwZV07XG5cbiAgaWYgKHN0eWxlKSB7XG4gICAgcmV0dXJuICdcXHUwMDFiWycgKyBpbnNwZWN0LmNvbG9yc1tzdHlsZV1bMF0gKyAnbScgKyBzdHIgK1xuICAgICAgICAgICAnXFx1MDAxYlsnICsgaW5zcGVjdC5jb2xvcnNbc3R5bGVdWzFdICsgJ20nO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBzdHI7XG4gIH1cbn1cblxuXG5mdW5jdGlvbiBzdHlsaXplTm9Db2xvcihzdHIsIHN0eWxlVHlwZSkge1xuICByZXR1cm4gc3RyO1xufVxuXG5cbmZ1bmN0aW9uIGFycmF5VG9IYXNoKGFycmF5KSB7XG4gIHZhciBoYXNoID0ge307XG5cbiAgYXJyYXkuZm9yRWFjaChmdW5jdGlvbih2YWwsIGlkeCkge1xuICAgIGhhc2hbdmFsXSA9IHRydWU7XG4gIH0pO1xuXG4gIHJldHVybiBoYXNoO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdFZhbHVlKGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcykge1xuICAvLyBQcm92aWRlIGEgaG9vayBmb3IgdXNlci1zcGVjaWZpZWQgaW5zcGVjdCBmdW5jdGlvbnMuXG4gIC8vIENoZWNrIHRoYXQgdmFsdWUgaXMgYW4gb2JqZWN0IHdpdGggYW4gaW5zcGVjdCBmdW5jdGlvbiBvbiBpdFxuICBpZiAoY3R4LmN1c3RvbUluc3BlY3QgJiZcbiAgICAgIHZhbHVlICYmXG4gICAgICBpc0Z1bmN0aW9uKHZhbHVlLmluc3BlY3QpICYmXG4gICAgICAvLyBGaWx0ZXIgb3V0IHRoZSB1dGlsIG1vZHVsZSwgaXQncyBpbnNwZWN0IGZ1bmN0aW9uIGlzIHNwZWNpYWxcbiAgICAgIHZhbHVlLmluc3BlY3QgIT09IGV4cG9ydHMuaW5zcGVjdCAmJlxuICAgICAgLy8gQWxzbyBmaWx0ZXIgb3V0IGFueSBwcm90b3R5cGUgb2JqZWN0cyB1c2luZyB0aGUgY2lyY3VsYXIgY2hlY2suXG4gICAgICAhKHZhbHVlLmNvbnN0cnVjdG9yICYmIHZhbHVlLmNvbnN0cnVjdG9yLnByb3RvdHlwZSA9PT0gdmFsdWUpKSB7XG4gICAgdmFyIHJldCA9IHZhbHVlLmluc3BlY3QocmVjdXJzZVRpbWVzLCBjdHgpO1xuICAgIGlmICghaXNTdHJpbmcocmV0KSkge1xuICAgICAgcmV0ID0gZm9ybWF0VmFsdWUoY3R4LCByZXQsIHJlY3Vyc2VUaW1lcyk7XG4gICAgfVxuICAgIHJldHVybiByZXQ7XG4gIH1cblxuICAvLyBQcmltaXRpdmUgdHlwZXMgY2Fubm90IGhhdmUgcHJvcGVydGllc1xuICB2YXIgcHJpbWl0aXZlID0gZm9ybWF0UHJpbWl0aXZlKGN0eCwgdmFsdWUpO1xuICBpZiAocHJpbWl0aXZlKSB7XG4gICAgcmV0dXJuIHByaW1pdGl2ZTtcbiAgfVxuXG4gIC8vIExvb2sgdXAgdGhlIGtleXMgb2YgdGhlIG9iamVjdC5cbiAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyh2YWx1ZSk7XG4gIHZhciB2aXNpYmxlS2V5cyA9IGFycmF5VG9IYXNoKGtleXMpO1xuXG4gIGlmIChjdHguc2hvd0hpZGRlbikge1xuICAgIGtleXMgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlOYW1lcyh2YWx1ZSk7XG4gIH1cblxuICAvLyBJRSBkb2Vzbid0IG1ha2UgZXJyb3IgZmllbGRzIG5vbi1lbnVtZXJhYmxlXG4gIC8vIGh0dHA6Ly9tc2RuLm1pY3Jvc29mdC5jb20vZW4tdXMvbGlicmFyeS9pZS9kd3c1MnNidCh2PXZzLjk0KS5hc3B4XG4gIGlmIChpc0Vycm9yKHZhbHVlKVxuICAgICAgJiYgKGtleXMuaW5kZXhPZignbWVzc2FnZScpID49IDAgfHwga2V5cy5pbmRleE9mKCdkZXNjcmlwdGlvbicpID49IDApKSB7XG4gICAgcmV0dXJuIGZvcm1hdEVycm9yKHZhbHVlKTtcbiAgfVxuXG4gIC8vIFNvbWUgdHlwZSBvZiBvYmplY3Qgd2l0aG91dCBwcm9wZXJ0aWVzIGNhbiBiZSBzaG9ydGN1dHRlZC5cbiAgaWYgKGtleXMubGVuZ3RoID09PSAwKSB7XG4gICAgaWYgKGlzRnVuY3Rpb24odmFsdWUpKSB7XG4gICAgICB2YXIgbmFtZSA9IHZhbHVlLm5hbWUgPyAnOiAnICsgdmFsdWUubmFtZSA6ICcnO1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKCdbRnVuY3Rpb24nICsgbmFtZSArICddJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gICAgaWYgKGlzUmVnRXhwKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKFJlZ0V4cC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSksICdyZWdleHAnKTtcbiAgICB9XG4gICAgaWYgKGlzRGF0ZSh2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZShEYXRlLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKSwgJ2RhdGUnKTtcbiAgICB9XG4gICAgaWYgKGlzRXJyb3IodmFsdWUpKSB7XG4gICAgICByZXR1cm4gZm9ybWF0RXJyb3IodmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIHZhciBiYXNlID0gJycsIGFycmF5ID0gZmFsc2UsIGJyYWNlcyA9IFsneycsICd9J107XG5cbiAgLy8gTWFrZSBBcnJheSBzYXkgdGhhdCB0aGV5IGFyZSBBcnJheVxuICBpZiAoaXNBcnJheSh2YWx1ZSkpIHtcbiAgICBhcnJheSA9IHRydWU7XG4gICAgYnJhY2VzID0gWydbJywgJ10nXTtcbiAgfVxuXG4gIC8vIE1ha2UgZnVuY3Rpb25zIHNheSB0aGF0IHRoZXkgYXJlIGZ1bmN0aW9uc1xuICBpZiAoaXNGdW5jdGlvbih2YWx1ZSkpIHtcbiAgICB2YXIgbiA9IHZhbHVlLm5hbWUgPyAnOiAnICsgdmFsdWUubmFtZSA6ICcnO1xuICAgIGJhc2UgPSAnIFtGdW5jdGlvbicgKyBuICsgJ10nO1xuICB9XG5cbiAgLy8gTWFrZSBSZWdFeHBzIHNheSB0aGF0IHRoZXkgYXJlIFJlZ0V4cHNcbiAgaWYgKGlzUmVnRXhwKHZhbHVlKSkge1xuICAgIGJhc2UgPSAnICcgKyBSZWdFeHAucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpO1xuICB9XG5cbiAgLy8gTWFrZSBkYXRlcyB3aXRoIHByb3BlcnRpZXMgZmlyc3Qgc2F5IHRoZSBkYXRlXG4gIGlmIChpc0RhdGUodmFsdWUpKSB7XG4gICAgYmFzZSA9ICcgJyArIERhdGUucHJvdG90eXBlLnRvVVRDU3RyaW5nLmNhbGwodmFsdWUpO1xuICB9XG5cbiAgLy8gTWFrZSBlcnJvciB3aXRoIG1lc3NhZ2UgZmlyc3Qgc2F5IHRoZSBlcnJvclxuICBpZiAoaXNFcnJvcih2YWx1ZSkpIHtcbiAgICBiYXNlID0gJyAnICsgZm9ybWF0RXJyb3IodmFsdWUpO1xuICB9XG5cbiAgaWYgKGtleXMubGVuZ3RoID09PSAwICYmICghYXJyYXkgfHwgdmFsdWUubGVuZ3RoID09IDApKSB7XG4gICAgcmV0dXJuIGJyYWNlc1swXSArIGJhc2UgKyBicmFjZXNbMV07XG4gIH1cblxuICBpZiAocmVjdXJzZVRpbWVzIDwgMCkge1xuICAgIGlmIChpc1JlZ0V4cCh2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZShSZWdFeHAucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpLCAncmVnZXhwJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZSgnW09iamVjdF0nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgfVxuXG4gIGN0eC5zZWVuLnB1c2godmFsdWUpO1xuXG4gIHZhciBvdXRwdXQ7XG4gIGlmIChhcnJheSkge1xuICAgIG91dHB1dCA9IGZvcm1hdEFycmF5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleXMpO1xuICB9IGVsc2Uge1xuICAgIG91dHB1dCA9IGtleXMubWFwKGZ1bmN0aW9uKGtleSkge1xuICAgICAgcmV0dXJuIGZvcm1hdFByb3BlcnR5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleSwgYXJyYXkpO1xuICAgIH0pO1xuICB9XG5cbiAgY3R4LnNlZW4ucG9wKCk7XG5cbiAgcmV0dXJuIHJlZHVjZVRvU2luZ2xlU3RyaW5nKG91dHB1dCwgYmFzZSwgYnJhY2VzKTtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRQcmltaXRpdmUoY3R4LCB2YWx1ZSkge1xuICBpZiAoaXNVbmRlZmluZWQodmFsdWUpKVxuICAgIHJldHVybiBjdHguc3R5bGl6ZSgndW5kZWZpbmVkJywgJ3VuZGVmaW5lZCcpO1xuICBpZiAoaXNTdHJpbmcodmFsdWUpKSB7XG4gICAgdmFyIHNpbXBsZSA9ICdcXCcnICsgSlNPTi5zdHJpbmdpZnkodmFsdWUpLnJlcGxhY2UoL15cInxcIiQvZywgJycpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFxcXFwiL2csICdcIicpICsgJ1xcJyc7XG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKHNpbXBsZSwgJ3N0cmluZycpO1xuICB9XG4gIGlmIChpc051bWJlcih2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCcnICsgdmFsdWUsICdudW1iZXInKTtcbiAgaWYgKGlzQm9vbGVhbih2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCcnICsgdmFsdWUsICdib29sZWFuJyk7XG4gIC8vIEZvciBzb21lIHJlYXNvbiB0eXBlb2YgbnVsbCBpcyBcIm9iamVjdFwiLCBzbyBzcGVjaWFsIGNhc2UgaGVyZS5cbiAgaWYgKGlzTnVsbCh2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCdudWxsJywgJ251bGwnKTtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRFcnJvcih2YWx1ZSkge1xuICByZXR1cm4gJ1snICsgRXJyb3IucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpICsgJ10nO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdEFycmF5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleXMpIHtcbiAgdmFyIG91dHB1dCA9IFtdO1xuICBmb3IgKHZhciBpID0gMCwgbCA9IHZhbHVlLmxlbmd0aDsgaSA8IGw7ICsraSkge1xuICAgIGlmIChoYXNPd25Qcm9wZXJ0eSh2YWx1ZSwgU3RyaW5nKGkpKSkge1xuICAgICAgb3V0cHV0LnB1c2goZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cyxcbiAgICAgICAgICBTdHJpbmcoaSksIHRydWUpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgb3V0cHV0LnB1c2goJycpO1xuICAgIH1cbiAgfVxuICBrZXlzLmZvckVhY2goZnVuY3Rpb24oa2V5KSB7XG4gICAgaWYgKCFrZXkubWF0Y2goL15cXGQrJC8pKSB7XG4gICAgICBvdXRwdXQucHVzaChmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLFxuICAgICAgICAgIGtleSwgdHJ1ZSkpO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBvdXRwdXQ7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5LCBhcnJheSkge1xuICB2YXIgbmFtZSwgc3RyLCBkZXNjO1xuICBkZXNjID0gT2JqZWN0LmdldE93blByb3BlcnR5RGVzY3JpcHRvcih2YWx1ZSwga2V5KSB8fCB7IHZhbHVlOiB2YWx1ZVtrZXldIH07XG4gIGlmIChkZXNjLmdldCkge1xuICAgIGlmIChkZXNjLnNldCkge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tHZXR0ZXIvU2V0dGVyXScsICdzcGVjaWFsJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0ciA9IGN0eC5zdHlsaXplKCdbR2V0dGVyXScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGlmIChkZXNjLnNldCkge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tTZXR0ZXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH1cbiAgaWYgKCFoYXNPd25Qcm9wZXJ0eSh2aXNpYmxlS2V5cywga2V5KSkge1xuICAgIG5hbWUgPSAnWycgKyBrZXkgKyAnXSc7XG4gIH1cbiAgaWYgKCFzdHIpIHtcbiAgICBpZiAoY3R4LnNlZW4uaW5kZXhPZihkZXNjLnZhbHVlKSA8IDApIHtcbiAgICAgIGlmIChpc051bGwocmVjdXJzZVRpbWVzKSkge1xuICAgICAgICBzdHIgPSBmb3JtYXRWYWx1ZShjdHgsIGRlc2MudmFsdWUsIG51bGwpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc3RyID0gZm9ybWF0VmFsdWUoY3R4LCBkZXNjLnZhbHVlLCByZWN1cnNlVGltZXMgLSAxKTtcbiAgICAgIH1cbiAgICAgIGlmIChzdHIuaW5kZXhPZignXFxuJykgPiAtMSkge1xuICAgICAgICBpZiAoYXJyYXkpIHtcbiAgICAgICAgICBzdHIgPSBzdHIuc3BsaXQoJ1xcbicpLm1hcChmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgICAgICByZXR1cm4gJyAgJyArIGxpbmU7XG4gICAgICAgICAgfSkuam9pbignXFxuJykuc3Vic3RyKDIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHN0ciA9ICdcXG4nICsgc3RyLnNwbGl0KCdcXG4nKS5tYXAoZnVuY3Rpb24obGluZSkge1xuICAgICAgICAgICAgcmV0dXJuICcgICAnICsgbGluZTtcbiAgICAgICAgICB9KS5qb2luKCdcXG4nKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW0NpcmN1bGFyXScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9XG4gIGlmIChpc1VuZGVmaW5lZChuYW1lKSkge1xuICAgIGlmIChhcnJheSAmJiBrZXkubWF0Y2goL15cXGQrJC8pKSB7XG4gICAgICByZXR1cm4gc3RyO1xuICAgIH1cbiAgICBuYW1lID0gSlNPTi5zdHJpbmdpZnkoJycgKyBrZXkpO1xuICAgIGlmIChuYW1lLm1hdGNoKC9eXCIoW2EtekEtWl9dW2EtekEtWl8wLTldKilcIiQvKSkge1xuICAgICAgbmFtZSA9IG5hbWUuc3Vic3RyKDEsIG5hbWUubGVuZ3RoIC0gMik7XG4gICAgICBuYW1lID0gY3R4LnN0eWxpemUobmFtZSwgJ25hbWUnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbmFtZSA9IG5hbWUucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpXG4gICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXFxcXCIvZywgJ1wiJylcbiAgICAgICAgICAgICAgICAgLnJlcGxhY2UoLyheXCJ8XCIkKS9nLCBcIidcIik7XG4gICAgICBuYW1lID0gY3R4LnN0eWxpemUobmFtZSwgJ3N0cmluZycpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBuYW1lICsgJzogJyArIHN0cjtcbn1cblxuXG5mdW5jdGlvbiByZWR1Y2VUb1NpbmdsZVN0cmluZyhvdXRwdXQsIGJhc2UsIGJyYWNlcykge1xuICB2YXIgbnVtTGluZXNFc3QgPSAwO1xuICB2YXIgbGVuZ3RoID0gb3V0cHV0LnJlZHVjZShmdW5jdGlvbihwcmV2LCBjdXIpIHtcbiAgICBudW1MaW5lc0VzdCsrO1xuICAgIGlmIChjdXIuaW5kZXhPZignXFxuJykgPj0gMCkgbnVtTGluZXNFc3QrKztcbiAgICByZXR1cm4gcHJldiArIGN1ci5yZXBsYWNlKC9cXHUwMDFiXFxbXFxkXFxkP20vZywgJycpLmxlbmd0aCArIDE7XG4gIH0sIDApO1xuXG4gIGlmIChsZW5ndGggPiA2MCkge1xuICAgIHJldHVybiBicmFjZXNbMF0gK1xuICAgICAgICAgICAoYmFzZSA9PT0gJycgPyAnJyA6IGJhc2UgKyAnXFxuICcpICtcbiAgICAgICAgICAgJyAnICtcbiAgICAgICAgICAgb3V0cHV0LmpvaW4oJyxcXG4gICcpICtcbiAgICAgICAgICAgJyAnICtcbiAgICAgICAgICAgYnJhY2VzWzFdO1xuICB9XG5cbiAgcmV0dXJuIGJyYWNlc1swXSArIGJhc2UgKyAnICcgKyBvdXRwdXQuam9pbignLCAnKSArICcgJyArIGJyYWNlc1sxXTtcbn1cblxuXG4vLyBOT1RFOiBUaGVzZSB0eXBlIGNoZWNraW5nIGZ1bmN0aW9ucyBpbnRlbnRpb25hbGx5IGRvbid0IHVzZSBgaW5zdGFuY2VvZmBcbi8vIGJlY2F1c2UgaXQgaXMgZnJhZ2lsZSBhbmQgY2FuIGJlIGVhc2lseSBmYWtlZCB3aXRoIGBPYmplY3QuY3JlYXRlKClgLlxuZnVuY3Rpb24gaXNBcnJheShhcikge1xuICByZXR1cm4gQXJyYXkuaXNBcnJheShhcik7XG59XG5leHBvcnRzLmlzQXJyYXkgPSBpc0FycmF5O1xuXG5mdW5jdGlvbiBpc0Jvb2xlYW4oYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnYm9vbGVhbic7XG59XG5leHBvcnRzLmlzQm9vbGVhbiA9IGlzQm9vbGVhbjtcblxuZnVuY3Rpb24gaXNOdWxsKGFyZykge1xuICByZXR1cm4gYXJnID09PSBudWxsO1xufVxuZXhwb3J0cy5pc051bGwgPSBpc051bGw7XG5cbmZ1bmN0aW9uIGlzTnVsbE9yVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09IG51bGw7XG59XG5leHBvcnRzLmlzTnVsbE9yVW5kZWZpbmVkID0gaXNOdWxsT3JVbmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGlzTnVtYmVyKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ251bWJlcic7XG59XG5leHBvcnRzLmlzTnVtYmVyID0gaXNOdW1iZXI7XG5cbmZ1bmN0aW9uIGlzU3RyaW5nKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ3N0cmluZyc7XG59XG5leHBvcnRzLmlzU3RyaW5nID0gaXNTdHJpbmc7XG5cbmZ1bmN0aW9uIGlzU3ltYm9sKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ3N5bWJvbCc7XG59XG5leHBvcnRzLmlzU3ltYm9sID0gaXNTeW1ib2w7XG5cbmZ1bmN0aW9uIGlzVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09PSB2b2lkIDA7XG59XG5leHBvcnRzLmlzVW5kZWZpbmVkID0gaXNVbmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGlzUmVnRXhwKHJlKSB7XG4gIHJldHVybiBpc09iamVjdChyZSkgJiYgb2JqZWN0VG9TdHJpbmcocmUpID09PSAnW29iamVjdCBSZWdFeHBdJztcbn1cbmV4cG9ydHMuaXNSZWdFeHAgPSBpc1JlZ0V4cDtcblxuZnVuY3Rpb24gaXNPYmplY3QoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgIT09IG51bGw7XG59XG5leHBvcnRzLmlzT2JqZWN0ID0gaXNPYmplY3Q7XG5cbmZ1bmN0aW9uIGlzRGF0ZShkKSB7XG4gIHJldHVybiBpc09iamVjdChkKSAmJiBvYmplY3RUb1N0cmluZyhkKSA9PT0gJ1tvYmplY3QgRGF0ZV0nO1xufVxuZXhwb3J0cy5pc0RhdGUgPSBpc0RhdGU7XG5cbmZ1bmN0aW9uIGlzRXJyb3IoZSkge1xuICByZXR1cm4gaXNPYmplY3QoZSkgJiZcbiAgICAgIChvYmplY3RUb1N0cmluZyhlKSA9PT0gJ1tvYmplY3QgRXJyb3JdJyB8fCBlIGluc3RhbmNlb2YgRXJyb3IpO1xufVxuZXhwb3J0cy5pc0Vycm9yID0gaXNFcnJvcjtcblxuZnVuY3Rpb24gaXNGdW5jdGlvbihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdmdW5jdGlvbic7XG59XG5leHBvcnRzLmlzRnVuY3Rpb24gPSBpc0Z1bmN0aW9uO1xuXG5mdW5jdGlvbiBpc1ByaW1pdGl2ZShhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gbnVsbCB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ2Jvb2xlYW4nIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnbnVtYmVyJyB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ3N0cmluZycgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdzeW1ib2wnIHx8ICAvLyBFUzYgc3ltYm9sXG4gICAgICAgICB0eXBlb2YgYXJnID09PSAndW5kZWZpbmVkJztcbn1cbmV4cG9ydHMuaXNQcmltaXRpdmUgPSBpc1ByaW1pdGl2ZTtcblxuZXhwb3J0cy5pc0J1ZmZlciA9IHJlcXVpcmUoJy4vc3VwcG9ydC9pc0J1ZmZlcicpO1xuXG5mdW5jdGlvbiBvYmplY3RUb1N0cmluZyhvKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwobyk7XG59XG5cblxuZnVuY3Rpb24gcGFkKG4pIHtcbiAgcmV0dXJuIG4gPCAxMCA/ICcwJyArIG4udG9TdHJpbmcoMTApIDogbi50b1N0cmluZygxMCk7XG59XG5cblxudmFyIG1vbnRocyA9IFsnSmFuJywgJ0ZlYicsICdNYXInLCAnQXByJywgJ01heScsICdKdW4nLCAnSnVsJywgJ0F1ZycsICdTZXAnLFxuICAgICAgICAgICAgICAnT2N0JywgJ05vdicsICdEZWMnXTtcblxuLy8gMjYgRmViIDE2OjE5OjM0XG5mdW5jdGlvbiB0aW1lc3RhbXAoKSB7XG4gIHZhciBkID0gbmV3IERhdGUoKTtcbiAgdmFyIHRpbWUgPSBbcGFkKGQuZ2V0SG91cnMoKSksXG4gICAgICAgICAgICAgIHBhZChkLmdldE1pbnV0ZXMoKSksXG4gICAgICAgICAgICAgIHBhZChkLmdldFNlY29uZHMoKSldLmpvaW4oJzonKTtcbiAgcmV0dXJuIFtkLmdldERhdGUoKSwgbW9udGhzW2QuZ2V0TW9udGgoKV0sIHRpbWVdLmpvaW4oJyAnKTtcbn1cblxuXG4vLyBsb2cgaXMganVzdCBhIHRoaW4gd3JhcHBlciB0byBjb25zb2xlLmxvZyB0aGF0IHByZXBlbmRzIGEgdGltZXN0YW1wXG5leHBvcnRzLmxvZyA9IGZ1bmN0aW9uKCkge1xuICBjb25zb2xlLmxvZygnJXMgLSAlcycsIHRpbWVzdGFtcCgpLCBleHBvcnRzLmZvcm1hdC5hcHBseShleHBvcnRzLCBhcmd1bWVudHMpKTtcbn07XG5cblxuLyoqXG4gKiBJbmhlcml0IHRoZSBwcm90b3R5cGUgbWV0aG9kcyBmcm9tIG9uZSBjb25zdHJ1Y3RvciBpbnRvIGFub3RoZXIuXG4gKlxuICogVGhlIEZ1bmN0aW9uLnByb3RvdHlwZS5pbmhlcml0cyBmcm9tIGxhbmcuanMgcmV3cml0dGVuIGFzIGEgc3RhbmRhbG9uZVxuICogZnVuY3Rpb24gKG5vdCBvbiBGdW5jdGlvbi5wcm90b3R5cGUpLiBOT1RFOiBJZiB0aGlzIGZpbGUgaXMgdG8gYmUgbG9hZGVkXG4gKiBkdXJpbmcgYm9vdHN0cmFwcGluZyB0aGlzIGZ1bmN0aW9uIG5lZWRzIHRvIGJlIHJld3JpdHRlbiB1c2luZyBzb21lIG5hdGl2ZVxuICogZnVuY3Rpb25zIGFzIHByb3RvdHlwZSBzZXR1cCB1c2luZyBub3JtYWwgSmF2YVNjcmlwdCBkb2VzIG5vdCB3b3JrIGFzXG4gKiBleHBlY3RlZCBkdXJpbmcgYm9vdHN0cmFwcGluZyAoc2VlIG1pcnJvci5qcyBpbiByMTE0OTAzKS5cbiAqXG4gKiBAcGFyYW0ge2Z1bmN0aW9ufSBjdG9yIENvbnN0cnVjdG9yIGZ1bmN0aW9uIHdoaWNoIG5lZWRzIHRvIGluaGVyaXQgdGhlXG4gKiAgICAgcHJvdG90eXBlLlxuICogQHBhcmFtIHtmdW5jdGlvbn0gc3VwZXJDdG9yIENvbnN0cnVjdG9yIGZ1bmN0aW9uIHRvIGluaGVyaXQgcHJvdG90eXBlIGZyb20uXG4gKi9cbmV4cG9ydHMuaW5oZXJpdHMgPSByZXF1aXJlKCdpbmhlcml0cycpO1xuXG5leHBvcnRzLl9leHRlbmQgPSBmdW5jdGlvbihvcmlnaW4sIGFkZCkge1xuICAvLyBEb24ndCBkbyBhbnl0aGluZyBpZiBhZGQgaXNuJ3QgYW4gb2JqZWN0XG4gIGlmICghYWRkIHx8ICFpc09iamVjdChhZGQpKSByZXR1cm4gb3JpZ2luO1xuXG4gIHZhciBrZXlzID0gT2JqZWN0LmtleXMoYWRkKTtcbiAgdmFyIGkgPSBrZXlzLmxlbmd0aDtcbiAgd2hpbGUgKGktLSkge1xuICAgIG9yaWdpbltrZXlzW2ldXSA9IGFkZFtrZXlzW2ldXTtcbiAgfVxuICByZXR1cm4gb3JpZ2luO1xufTtcblxuZnVuY3Rpb24gaGFzT3duUHJvcGVydHkob2JqLCBwcm9wKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob2JqLCBwcm9wKTtcbn1cbiIsIi8qIGdsb2JhbCBkZXNjcmliZSBpdCAqL1xuY29uc3QgYXNzZXJ0ID0gcmVxdWlyZSgnYXNzZXJ0Jyk7XG5jb25zdCBkZXEgPSAoel9leHBlY3QsIHpfYWN0dWFsKSA9PiB7XG5cdGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoel9hY3R1YWwsIHpfZXhwZWN0KTtcbn07XG5jb25zdCBlcSA9ICh6X2V4cGVjdCwgel9hY3R1YWwpID0+IHtcblx0YXNzZXJ0LnN0cmljdEVxdWFsKHpfYWN0dWFsLCB6X2V4cGVjdCk7XG59O1xuY29uc3QgZnMgPSByZXF1aXJlKCdmcycpO1xuXG5jb25zdCB3b3JrZXIgPSByZXF1aXJlKCcuLi8uLi9kaXN0L21haW4vbW9kdWxlLmpzJykuc2NvcGlmeShyZXF1aXJlLCAoKSA9PiB7XG5cdHJlcXVpcmUoJy4vd29ya2Vycy9iYXNpYy5qcycpO1xufSwgJ3VuZGVmaW5lZCcgIT09IHR5cGVvZiBhcmd1bWVudHMgJiYgYXJndW1lbnRzKTtcblxuY29uc3Qgc3Bhd24gPSAoc19uYW1lPSdiYXNpYycpID0+IHdvcmtlci5zcGF3bihgLi93b3JrZXJzLyR7c19uYW1lfS5qc2ApO1xuY29uc3QgZ3JvdXAgPSAobl93b3JrZXJzLCBzX25hbWU9J2Jhc2ljJykgPT4gd29ya2VyLmdyb3VwKGAuL3dvcmtlcnMvJHtzX25hbWV9LmpzYCwgbl93b3JrZXJzKTtcblxuY29uc3QgcnVuID0gYXN5bmMgKC4uLmFfYXJncykgPT4ge1xuXHRsZXQga193b3JrZXIgPSBzcGF3bigpO1xuXHRsZXQgel9yZXN1bHQgPSBhd2FpdCBrX3dvcmtlci5ydW4oLi4uYV9hcmdzKTtcblx0YXdhaXQga193b3JrZXIua2lsbCgpO1xuXHRyZXR1cm4gel9yZXN1bHQ7XG59O1xuXG5cbmRlc2NyaWJlKCd3b3JrZXInLCAoKSA9PiB7XG5cblx0aXQoJ3J1bnMnLCBhc3luYyAoKSA9PiB7XG5cdFx0ZXEoJ3llaCcsIGF3YWl0IHJ1bigncmV2ZXJzZV9zdHJpbmcnLCBbJ2hleSddKSk7XG5cdH0pO1xuXG5cdGl0KCd0d2ljZScsIGFzeW5jICgpID0+IHtcblx0XHRsZXQga193b3JrZXIgPSBzcGF3bigpO1xuXHRcdGxldCBzX3llaCA9IGF3YWl0IGtfd29ya2VyLnJ1bigncmV2ZXJzZV9zdHJpbmcnLCBbJ2hleSddKTtcblx0XHRlcSgnaGV5JywgYXdhaXQgcnVuKCdyZXZlcnNlX3N0cmluZycsIFtzX3llaF0pKTtcblx0XHRhd2FpdCBrX3dvcmtlci5raWxsKCk7XG5cdH0pO1xuXG5cdGl0KCd0ZXJtaW5hdGVzJywgKGZrZV90ZXN0KSA9PiB7XG5cdFx0bGV0IGtfd29ya2VyID0gc3Bhd24oKTtcblx0XHRrX3dvcmtlci5ydW4oJ3dhaXQnLCBbWzUwMDBdXSlcblx0XHRcdC50aGVuKCgpID0+IGZrZV90ZXN0KCd3b3JrZXIgZGlkIG5vdCB0ZXJtaW5hdGUgYmVmb3JlIGZpbmlzaGluZyB0YXNrJykpXG5cdFx0XHQuY2F0Y2goKGVfcnVuKSA9PiB7XG5cdFx0XHRcdGZrZV90ZXN0KGVfcnVuKTtcblx0XHRcdH0pO1xuXHRcdHNldFRpbWVvdXQoYXN5bmMgKCkgPT4ge1xuXHRcdFx0YXdhaXQga193b3JrZXIua2lsbCgpO1xuXHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHR9LCAxMDApO1xuXHR9KTtcblxuXHRpdCgnY2F0Y2hlcycsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBrX3dvcmtlciA9IHNwYXduKCk7XG5cdFx0a193b3JrZXIucnVuKCdmYWlsJylcblx0XHRcdC50aGVuKCgpID0+IGZrZV90ZXN0KCdlcnJvciBub3QgY2F1Z2h0IGJ5IG1hc3RlcicpKVxuXHRcdFx0LmNhdGNoKGFzeW5jIChlX3J1bikgPT4ge1xuXHRcdFx0XHRhc3NlcnQoZV9ydW4ubWVzc2FnZS5pbmNsdWRlcygnbm8gc3VjaCB0YXNrJykpO1xuXHRcdFx0XHRhd2FpdCBrX3dvcmtlci5raWxsKCk7XG5cdFx0XHRcdGZrZV90ZXN0KCk7XG5cdFx0XHR9KTtcblx0fSk7XG5cblx0aXQoJ2V2ZW50cycsIGFzeW5jICgpID0+IHtcblx0XHRsZXQgaF9jb252byA9IHtcblx0XHRcdGdyZWV0OiAnaGknLFxuXHRcdFx0Y2hhdDogJ2hvdyByIHUnLFxuXHRcdFx0eWVsbDogJ2FoaCEnLFxuXHRcdFx0YXBvbG9naXplOiAnc29ycnknLFxuXHRcdFx0Zm9yZ2l2ZTogJ21taycsXG5cdFx0XHRleGl0OiAna2J5ZScsXG5cdFx0fTtcblxuXHRcdGxldCBhX2RhdGEgPSBbXTtcblx0XHRsZXQgaF9yZXNwb25zZXMgPSB7fTtcblx0XHRsZXQgY19yZXNwb25zZXMgPSAwO1xuXHRcdE9iamVjdC5rZXlzKGhfY29udm8pLmZvckVhY2goKHNfa2V5LCBpX2tleSkgPT4ge1xuXHRcdFx0YV9kYXRhLnB1c2goe1xuXHRcdFx0XHRuYW1lOiBzX2tleSxcblx0XHRcdFx0ZGF0YTogaF9jb252b1tzX2tleV0sXG5cdFx0XHRcdHdhaXQ6IGlfa2V5PyAxMDA6IDAsXG5cdFx0XHR9KTtcblxuXHRcdFx0aF9yZXNwb25zZXNbc19rZXldID0gKHNfbXNnKSA9PiB7XG5cdFx0XHRcdGVxKGhfY29udm9bc19rZXldLCBzX21zZyk7XG5cdFx0XHRcdGNfcmVzcG9uc2VzICs9IDE7XG5cdFx0XHR9O1xuXHRcdH0pO1xuXG5cdFx0bGV0IGtfd29ya2VyID0gc3Bhd24oKTtcblx0XHRhd2FpdCBrX3dvcmtlci5ydW4oJ2V2ZW50cycsIFthX2RhdGFdLCBoX3Jlc3BvbnNlcyk7XG5cdFx0YXdhaXQga193b3JrZXIua2lsbCgpO1xuXHRcdGVxKGFfZGF0YS5sZW5ndGgsIGNfcmVzcG9uc2VzKTtcblx0fSk7XG5cblx0aXQoJ3N0b3JlJywgYXN5bmMgKCkgPT4ge1xuXHRcdGxldCBrX3dvcmtlciA9IHNwYXduKCk7XG5cdFx0YXdhaXQga193b3JrZXIucnVuKCdzdG9yZScsIFtbe3Rlc3Q6J3ZhbHVlJ31dXSk7XG5cdFx0bGV0IGFfdmFsdWVzID0gYXdhaXQga193b3JrZXIucnVuKCdmZXRjaCcsIFtbJ3Rlc3QnXV0pO1xuXHRcdGF3YWl0IGtfd29ya2VyLmtpbGwoKTtcblx0XHRlcSgndmFsdWUnLCBhX3ZhbHVlc1swXSk7XG5cdH0pO1xufSk7XG5cblxuZGVzY3JpYmUoJ2dyb3VwJywgKCkgPT4ge1xuXG5cdGl0KCdtYXAvdGhydScsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBhX3NlcSA9IFs4LCAxLCA3LCA0LCAzLCA1LCAyLCA2XTtcblx0XHRsZXQga19ncm91cCA9IGdyb3VwKGFfc2VxLmxlbmd0aCk7XG5cdFx0a19ncm91cFxuXHRcdFx0LmRhdGEoYV9zZXEpXG5cdFx0XHQubWFwKCdtdWx0aXBseScsIFsyXSlcblx0XHRcdC50aHJ1KCdhZGQnLCBbM10pXG5cdFx0XHQuZWFjaCgoeF9uLCBpX24pID0+IHtcblx0XHRcdFx0ZXEoKGFfc2VxW2lfbl0qMikrMywgeF9uWzBdKTtcblx0XHRcdH0sIGFzeW5jICgpID0+IHtcblx0XHRcdFx0YXdhaXQga19ncm91cC5raWxsKCk7XG5cdFx0XHRcdGZrZV90ZXN0KCk7XG5cdFx0XHR9KTtcblx0fSk7XG5cblx0aXQoJ21hcC9lYWNoJywgKGZrZV90ZXN0KSA9PiB7XG5cdFx0bGV0IGFfc2VxID0gWzgsIDEsIDcsIDQsIDMsIDUsIDIsIDZdLm1hcCh4ID0+IHgqMTAwKTtcblx0XHRsZXQga19ncm91cCA9IGdyb3VwKGFfc2VxLmxlbmd0aCk7XG5cdFx0a19ncm91cFxuXHRcdFx0LmRhdGEoYV9zZXEpXG5cdFx0XHQubWFwKCd3YWl0Jylcblx0XHRcdC5lYWNoKCh4X24sIGlfbikgPT4ge1xuXHRcdFx0XHRlcShhX3NlcVtpX25dLCB4X24pO1xuXHRcdFx0fSwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRhd2FpdCBrX2dyb3VwLmtpbGwoKTtcblx0XHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxuXHRpdCgnbWFwL3NlcmllcycsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBhX3NlcSA9IFs4LCAxLCA3LCA0LCAzLCA1LCAyLCA2XS5tYXAoeCA9PiB4KjEwMCk7XG5cdFx0bGV0IGFfcmVzID0gW107XG5cdFx0bGV0IGtfZ3JvdXAgPSBncm91cChhX3NlcS5sZW5ndGgpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKGFfc2VxKVxuXHRcdFx0Lm1hcCgnd2FpdCcpXG5cdFx0XHQuc2VyaWVzKCh4X24pID0+IHtcblx0XHRcdFx0YV9yZXMucHVzaCh4X24pO1xuXHRcdFx0fSwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRhd2FpdCBrX2dyb3VwLmtpbGwoKTtcblx0XHRcdFx0ZGVxKGFfc2VxLCBhX3Jlcyk7XG5cdFx0XHRcdGZrZV90ZXN0KCk7XG5cdFx0XHR9KTtcblx0fSk7XG5cblx0aXQoJ21hcC9yZWR1Y2UgIzQnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQgc19zcmMgPSAnYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXonO1xuXHRcdGxldCBrX2dyb3VwID0gZ3JvdXAoNCk7XG5cdFx0a19ncm91cFxuXHRcdFx0LmRhdGEoc19zcmMuc3BsaXQoJycpKVxuXHRcdFx0Lm1hcCgnY29uY2F0Jylcblx0XHRcdC5yZWR1Y2UoJ21lcmdlX2NvbmNhdCcpLnRoZW4oYXN5bmMgKHNfZmluYWwpID0+IHtcblx0XHRcdFx0YXdhaXQga19ncm91cC5raWxsKCk7XG5cdFx0XHRcdGVxKHNfc3JjLCBzX2ZpbmFsKTtcblx0XHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxuXHRpdCgnbWFwL3JlZHVjZSAjOCcsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBzX3NyYyA9ICdhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eic7XG5cdFx0bGV0IGtfZ3JvdXAgPSBncm91cCg4KTtcblx0XHRrX2dyb3VwXG5cdFx0XHQuZGF0YShzX3NyYy5zcGxpdCgnJykpXG5cdFx0XHQubWFwKCdjb25jYXQnKVxuXHRcdFx0LnJlZHVjZSgnbWVyZ2VfY29uY2F0JykudGhlbihhc3luYyAoc19maW5hbCkgPT4ge1xuXHRcdFx0XHRhd2FpdCBrX2dyb3VwLmtpbGwoKTtcblx0XHRcdFx0ZXEoc19zcmMsIHNfZmluYWwpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdldmVudHMnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQgaF9jb252byA9IHtcblx0XHRcdGdyZWV0OiAnaGknLFxuXHRcdFx0Y2hhdDogJ2hvdyByIHUnLFxuXHRcdFx0eWVsbDogJ2FoaCEnLFxuXHRcdFx0YXBvbG9naXplOiAnc29ycnknLFxuXHRcdFx0Zm9yZ2l2ZTogJ21taycsXG5cdFx0XHRleGl0OiAna2J5ZScsXG5cdFx0fTtcblxuXHRcdGxldCBhX2RhdGEgPSBbXTtcblx0XHRsZXQgaF9yZXNwb25zZXMgPSB7fTtcblx0XHRsZXQgY19yZXNwb25zZXMgPSAwO1xuXHRcdE9iamVjdC5rZXlzKGhfY29udm8pLmZvckVhY2goKHNfa2V5LCBpX2tleSkgPT4ge1xuXHRcdFx0YV9kYXRhLnB1c2goe1xuXHRcdFx0XHRuYW1lOiBzX2tleSxcblx0XHRcdFx0ZGF0YTogaF9jb252b1tzX2tleV0sXG5cdFx0XHRcdHdhaXQ6IGlfa2V5PyA1MDA6IDAsXG5cdFx0XHR9KTtcblxuXHRcdFx0aF9yZXNwb25zZXNbc19rZXldID0gKGlfc3Vic2V0LCBzX21zZykgPT4ge1xuXHRcdFx0XHRlcShoX2NvbnZvW3Nfa2V5XSwgc19tc2cpO1xuXHRcdFx0XHRjX3Jlc3BvbnNlcyArPSAxO1xuXHRcdFx0fTtcblx0XHR9KTtcblxuXHRcdGxldCBrX2dyb3VwID0gZ3JvdXAoMyk7XG5cdFx0a19ncm91cFxuXHRcdFx0LmRhdGEoYV9kYXRhKVxuXHRcdFx0Lm1hcCgnZXZlbnRzJywgW10sIGhfcmVzcG9uc2VzKVxuXHRcdFx0LmVuZChhc3luYyAoKSA9PiB7XG5cdFx0XHRcdGF3YWl0IGtfZ3JvdXAua2lsbCgpO1xuXHRcdFx0XHRlcShhX2RhdGEubGVuZ3RoLCBjX3Jlc3BvbnNlcyk7XG5cdFx0XHRcdGZrZV90ZXN0KCk7XG5cdFx0XHR9KTtcblx0fSk7XG5cblx0aXQoJ3N0b3JlJywgKCkgPT4ge1xuXHRcdGxldCBrX2dyb3VwID0gZ3JvdXAoMik7XG5cdFx0a19ncm91cFxuXHRcdFx0LmRhdGEoW1sxMDAsIDAsIDAsIDBdXSlcblx0XHRcdC5tYXAoJ3Bhc3MnKVxuXHRcdFx0Ly8gLnRocnUoJ3Bhc3MnKVxuXHRcdFx0LnJlZHVjZSgnc3VtJykudGhlbihhc3luYyAoYV92KSA9PiB7XG5cdFx0XHRcdGF3YWl0IGtfZ3JvdXAua2lsbCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG59KTtcblxuXG5kZXNjcmliZSgnYXV4JywgKCkgPT4ge1xuXG5cdGlmKCF3b3JrZXIuYnJvd3Nlcikge1xuXHRcdGl0KCd0cmFuc2ZlcnMnLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRsZXQga21fYXJncyA9IHdvcmtlci5tYW5pZmVzdChbZnMucmVhZEZpbGVTeW5jKCcuL3BhY2thZ2UuanNvbicpXSk7XG5cdFx0XHRsZXQgbl9sZW5ndGggPSBhd2FpdCBydW4oJ2NvdW50Jywga21fYXJncyk7XG5cblx0XHRcdGFzc2VydChuX2xlbmd0aCA+IDApO1xuXHRcdH0pO1xuXHR9XG5cblx0aXQoJ3R5cGVkLWFycmF5JywgYXN5bmMgKCkgPT4ge1xuXHRcdGxldCBhdF90ZXN0ID0gbmV3IFVpbnQ4QXJyYXkoMTApO1xuXHRcdGF0X3Rlc3RbMF0gPSA3O1xuXHRcdGF0X3Rlc3RbMV0gPSA1O1xuXHRcdGxldCBrbV9hcmdzID0gd29ya2VyLm1hbmlmZXN0KFthdF90ZXN0LCAxXSk7XG5cdFx0bGV0IG5fYXQgPSBhd2FpdCBydW4oJ2F0Jywga21fYXJncyk7XG5cdFx0ZXEoNSwgbl9hdCk7XG5cdH0pO1xuXG5cdC8vIGl0KCdzdHJlYW1zJywgYXN5bmMgKCkgPT4ge1xuXHQvLyBcdGxldCBkc193b3JkcyA9IGZzLmNyZWF0ZVJlYWRTdHJlYW0oJy91c3Ivc2hhcmUvZGljdC93b3JkcycsICd1dGY4Jyk7XG5cdC8vIFx0bGV0IG5fbmV3bGluZXMgPSBhd2FpdCBydW4oJ2NvdW50X3N0cicsIFtkc193b3JkcywgJ1xcbiddKTtcblx0Ly8gXHRjb25zb2xlLmxvZyhuX25ld2xpbmVzKTtcblx0Ly8gXHQvLyBlcSgnd29ya2VyJywgc19wYWNrYWdlX25hbWUpO1xuXHQvLyB9KTtcbn0pO1xuXG5cbiIsImNvbnN0IHdvcmtlciA9IHJlcXVpcmUoJy4uLy4uLy4uL2Rpc3QvbWFpbi9tb2R1bGUuanMnKTtcblxud29ya2VyLmRlZGljYXRlZCh7XG5cdHJldmVyc2Vfc3RyaW5nOiBzID0+IHMuc3BsaXQoJycpLnJldmVyc2UoKS5qb2luKCcnKSxcblxuXHRhdDogKGEsIGkpID0+IGFbaV0sXG5cblx0d2FpdDogKGFfd2FpdCkgPT4gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSkgPT4ge1xuXHRcdGxldCB0X3dhaXQgPSBhX3dhaXRbMF07XG5cblx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdGZfcmVzb2x2ZSh0X3dhaXQpO1xuXHRcdH0sIHRfd2FpdCk7XG5cdH0pLFxuXG5cdGNvbmNhdDogYSA9PiBhLmpvaW4oJycpLFxuXG5cdG1lcmdlX2NvbmNhdDogKHNfYSwgc19iKSA9PiBzX2EgKyBzX2IsXG5cblx0ZXZlbnRzKGFfZXZ0cykge1xuXHRcdHJldHVybiBQcm9taXNlLmFsbChcblx0XHRcdGFfZXZ0cy5tYXAoKGhfZXZ0KSA9PiBuZXcgUHJvbWlzZSgoZl9yZXNvbHZlLCBmX3JlamVjdCkgPT4ge1xuXHRcdFx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0XHR0aGlzLmVtaXQoaF9ldnQubmFtZSwgaF9ldnQuZGF0YSk7XG5cdFx0XHRcdFx0Zl9yZXNvbHZlKCk7XG5cdFx0XHRcdH0sIGhfZXZ0LndhaXQgKyA2MDApO1xuXHRcdFx0fSkpXG5cdFx0KTtcblx0fSxcblxuXHRzdG9yZShhX3N0b3JlKSB7XG5cdFx0YV9zdG9yZS5mb3JFYWNoKChoX3N0b3JlKSA9PiB7XG5cdFx0XHRmb3IobGV0IHNfa2V5IGluIGhfc3RvcmUpIHtcblx0XHRcdFx0dGhpcy5wdXQoc19rZXksIGhfc3RvcmVbc19rZXldKTtcblx0XHRcdH1cblx0XHR9KTtcblx0fSxcblxuXHRmZXRjaChhX2tleXMpIHtcblx0XHRyZXR1cm4gYV9rZXlzLm1hcChzX2tleSA9PiB0aGlzLmdldChzX2tleSkpO1xuXHR9LFxuXG5cdHBhc3MoYV93YWl0KSB7XG5cdFx0cmV0dXJuIFByb21pc2UuYWxsKGFfd2FpdC5tYXAoeF93YWl0ID0+IG5ldyBQcm9taXNlKChmX3Jlc29sdmUsIGZfcmVqZWN0KSA9PiB7XG5cdFx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0bGV0IGNfdmFsID0gKHRoaXMuZ2V0KCdkaWcnKSB8fCAwKSArIDE7XG5cdFx0XHRcdHRoaXMucHV0KCdkaWcnLCBjX3ZhbCk7XG5cdFx0XHRcdGZfcmVzb2x2ZShjX3ZhbCk7XG5cdFx0XHR9LCB4X3dhaXQpO1xuXHRcdH0pKSk7XG5cdH0sXG5cblx0bXVsdGlwbHk6IChhLCB4X211bHRpcGxpZXIpID0+IGEubWFwKHggPT4geCAqIHhfbXVsdGlwbGllciksXG5cblx0YWRkOiAoYSwgeF9hZGQpID0+IGEubWFwKHggPT4geCArIHhfYWRkKSxcblxuXHQvLyBzdW06ICh4X2EsIHhfYikgPT4geF9hICsgeF9iLFxuXG5cdHN1bTogKGFfYSwgYV9iKSA9PiBbYV9hLnJlZHVjZSgoYywgeCkgPT4gYyArIHgsIDApICsgYV9iLnJlZHVjZSgoYywgeCkgPT4gYyArIHgsIDApXSxcblxuXHRjb3VudDogKGEpID0+IGEucmVkdWNlKChjLCB4KSA9PiBjICsgeCwgMCksXG5cblx0Y291bnRfc3RyKGRzX2lucHV0LCBzX3N0cikge1xuXHRcdHJldHVybiBuZXcgUHJvbWlzZSgoZl9yZXNvbHZlLCBmX3JlamVjdCkgPT4ge1xuXHRcdFx0bGV0IGNfb2NjdXJyZW5jZXMgPSAwO1xuXHRcdFx0ZHNfaW5wdXQub24oJ2RhdGEnLCAoc19jaHVuaykgPT4ge1xuXHRcdFx0XHRjb25zb2xlLmxvZygnb2NjdXJyZW5jZXM6ICcrY19vY2N1cnJlbmNlcyk7XG5cdFx0XHRcdGNfb2NjdXJyZW5jZXMgKz0gc19jaHVuay5zcGxpdChzX3N0cikubGVuZ3RoIC0gMTtcblx0XHRcdH0pO1xuXG5cdFx0XHRkc19pbnB1dC5vbignZW5kJywgKCkgPT4ge1xuXHRcdFx0XHRjb25zb2xlLmxvZygnZW5kJyk7XG5cdFx0XHRcdGZfcmVzb2x2ZShjX29jY3VycmVuY2VzKTtcblx0XHRcdH0pO1xuXG5cdFx0XHRkc19pbnB1dC5vbignZXJyb3InLCAoZV9zdHJlYW0pID0+IHtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihlX3N0cmVhbSk7XG5cdFx0XHRcdGZfcmVqZWN0KGVfc3RyZWFtKTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9LFxuXG5cdHdyaXRlKGRzX291dCwgYV9yYW5nZSkge1xuXHRcdGZvcihsZXQgaT1hX3JhbmdlWzBdOyBpPGFfcmFuZ2VbMV07IGkrKykge1xuXHRcdFx0ZHNfb3V0LndyaXRlKGkrJ1xcbicpO1xuXHRcdH1cblx0fSxcbn0pO1xuIl19
