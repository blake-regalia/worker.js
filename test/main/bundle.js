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

	stream,
	// stream: mk_new(writable_stream),
	// get stream() {
	// 	delete this.stream;
	// 	return this.stream = require('./stream.js');
	// },

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJkaXN0L21haW4vYWxsL2RlZGljYXRlZC5qcyIsImRpc3QvbWFpbi9hbGwvZ3JvdXAuanMiLCJkaXN0L21haW4vYWxsL2xvY2Fscy5qcyIsImRpc3QvbWFpbi9hbGwvbWFuaWZlc3QuanMiLCJkaXN0L21haW4vYWxsL3Bvb2wuanMiLCJkaXN0L21haW4vYWxsL3Jlc3VsdC5qcyIsImRpc3QvbWFpbi9icm93c2VyL2NoYW5uZWwuanMiLCJkaXN0L21haW4vYnJvd3Nlci9ldmVudHMuanMiLCJkaXN0L21haW4vYnJvd3Nlci9sb2NhbHMuanMiLCJkaXN0L21haW4vYnJvd3Nlci9wb3J0cy5qcyIsImRpc3QvbWFpbi9icm93c2VyL3NlbGYuanMiLCJkaXN0L21haW4vYnJvd3Nlci9zaGFyaW5nLmpzIiwiZGlzdC9tYWluL2Jyb3dzZXIvc3RyZWFtLmpzIiwiZGlzdC9tYWluL2Jyb3dzZXIvdHlwZWQtYXJyYXlzLmpzIiwiZGlzdC9tYWluL2Jyb3dzZXIvd29ya2VyLmpzIiwiZGlzdC9tYWluL21vZHVsZS5qcyIsIm5vZGVfbW9kdWxlcy9hc3NlcnQvYXNzZXJ0LmpzIiwibm9kZV9tb2R1bGVzL2Jyb3dzZXItcmVzb2x2ZS9lbXB0eS5qcyIsIm5vZGVfbW9kdWxlcy9ldmVudHMvZXZlbnRzLmpzIiwibm9kZV9tb2R1bGVzL3BhdGgtYnJvd3NlcmlmeS9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9wcm9jZXNzL2Jyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvdXRpbC9ub2RlX21vZHVsZXMvaW5oZXJpdHMvaW5oZXJpdHNfYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy91dGlsL3N1cHBvcnQvaXNCdWZmZXJCcm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL3V0aWwvdXRpbC5qcyIsInRlc3QvbWFpbi9tb2R1bGUuanMiLCJ0ZXN0L21haW4vd29ya2Vycy9iYXNpYy5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNaQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUNsa0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDMUZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BJQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0R0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1RBO0FBQ0E7QUFDQTs7QUNGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0RUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyVUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzFyQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDbENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7QUMxaUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMxZUE7Ozs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQzlTQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUNoT0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4TEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMxa0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqUUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCJjb25zdCB7XG5cdEtfU0VMRixcblx0d2Vid29ya2VyaWZ5LFxuXHRzdHJlYW0sXG5cdHBvcnRzLFxufSA9IHJlcXVpcmUoJy4vbG9jYWxzLmpzJyk7XG5cbmNvbnN0IHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5jb25zdCBtYW5pZmVzdCA9IHJlcXVpcmUoJy4vbWFuaWZlc3QuanMnKTtcbmNvbnN0IHJlc3VsdCA9IHJlcXVpcmUoJy4vcmVzdWx0LmpzJyk7XG5cbmxldCBpX3N1Yndvcmtlcl9zcGF3biA9IDE7XG5sZXQgaF9zdWJ3b3JrZXJzID0ge307XG5jbGFzcyBsYXRlbnRfc3Vid29ya2VyIHtcblx0c3RhdGljIGNvbm5lY3QoaF9tc2cpIHtcblx0XHRoX3N1YndvcmtlcnNbaF9tc2cuaWRdLmNvbm5lY3QoaF9tc2cpO1xuXHR9XG5cblx0Y29uc3RydWN0b3IoKSB7XG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRpZDogaV9zdWJ3b3JrZXJfc3Bhd24sXG5cdFx0XHRtZXNzYWdlczogW10sXG5cdFx0XHRtYXN0ZXJfa2V5OiAwLFxuXHRcdFx0cG9ydDogbnVsbCxcblx0XHR9KTtcblxuXHRcdGhfc3Vid29ya2Vyc1tpX3N1Yndvcmtlcl9zcGF3bisrXSA9IHRoaXM7XG5cdH1cblxuXHRjb25uZWN0KGhfbXNnKSB7XG5cdFx0bGV0IHtcblx0XHRcdG1hc3Rlcl9rZXk6IGlfbWFzdGVyLFxuXHRcdFx0cG9ydDogZF9wb3J0LFxuXHRcdH0gPSBoX21zZztcblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0bWFzdGVyX2tleTogaV9tYXN0ZXIsXG5cdFx0XHRwb3J0OiBkX3BvcnQsXG5cdFx0fSk7XG5cblx0XHQvLyBiaW5kIGV2ZW50c1xuXHRcdGRfcG9ydC5vbm1lc3NhZ2UgPSAoLi4uYV9hcmdzKSA9PiB7XG5cdFx0XHR0aGlzLm9ubWVzc2FnZSguLi5hX2FyZ3MpO1xuXHRcdH07XG5cdFx0ZF9wb3J0Lm9ubWVzc2FnZWVycm9yID0gKC4uLmFfYXJncykgPT4ge1xuXHRcdFx0dGhpcy5vbm1lc3NhZ2VlcnJvciguLi5hX2FyZ3MpO1xuXHRcdH07XG5cblx0XHQvLyBwcm9jZXNzIG1lc3NhZ2UgcXVldWVcblx0XHR3aGlsZSAodGhpcy5tZXNzYWdlcy5sZW5ndGgpIHtcblx0XHRcdGRfcG9ydC5wb3N0TWVzc2FnZSguLi50aGlzLm1lc3NhZ2VzLnNoaWZ0KCkpO1xuXHRcdH1cblx0fVxuXG5cdHBvc3RNZXNzYWdlKC4uLmFfYXJncykge1xuXHRcdGlmICh0aGlzLnBvcnQpIHtcblx0XHRcdHRoaXMucG9ydC5wb3N0TWVzc2FnZSguLi5hX2FyZ3MpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLm1lc3NhZ2VzLnB1c2goYV9hcmdzKTtcblx0XHR9XG5cdH1cblxuXHRvbm1lc3NhZ2UoKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKCdyZWNlaXZlZCBtZXNzYWdlIGZyb20gc3Vid29ya2VyIGJlZm9yZSBpdHMgcG9ydCB3YXMgY29ubmVjdGVkJyk7XG5cdH1cblxuXHRvbm1lc3NhZ2VlcnJvcigpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ3JlY2VpdmVkIG1lc3NhZ2UgZXJyb3IgZnJvbSBzdWJ3b3JrZXIgYmVmb3JlIGl0cyBwb3J0IHdhcyBjb25uZWN0ZWQnKTtcblx0fVxuXG5cdHRlcm1pbmF0ZSgpIHtcblx0XHR0aGlzLnBvcnQuY2xvc2UoKTtcblx0XHRLX1NFTEYucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0dHlwZTogJ3Rlcm1pbmF0ZScsXG5cdFx0XHRtYXN0ZXJfa2V5OiB0aGlzLm1hc3Rlcl9rZXksXG5cdFx0fSk7XG5cdH1cblxuXHR3ZWJ3b3JrZXJpZnkoel9pbXBvcnQsIGFfYnJvd3NlcmlmeSwgaF9vcHRpb25zID0ge30pIHtcblx0XHRsZXQgc19zb3VyY2UgPSB3ZWJ3b3JrZXJpZnkoel9pbXBvcnQsIGFfYnJvd3NlcmlmeSwgaF9vcHRpb25zKTtcblxuXHRcdEtfU0VMRi5wb3N0TWVzc2FnZSh7XG5cdFx0XHR0eXBlOiAnc3Bhd24nLFxuXHRcdFx0c291cmNlOiBzX3NvdXJjZSxcblx0XHRcdG9wdGlvbnM6IGhfb3B0aW9ucyxcblx0XHR9KTtcblx0fVxufVxuXG5cbmNsYXNzIGhlbHBlciB7XG5cdGNvbnN0cnVjdG9yKGtfd29ya2VyLCBpX3Rhc2ssIGhfZXZlbnRzKSB7XG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHR3b3JrZXI6IGtfd29ya2VyLFxuXHRcdFx0dGFza19pZDogaV90YXNrLFxuXHRcdFx0ZXZlbnRzOiBoX2V2ZW50cyxcblx0XHRcdHdvcmtlcl9zdG9yZToga193b3JrZXIuc3RvcmUsXG5cdFx0XHR0YXNrczoga193b3JrZXIudGFza3MsXG5cdFx0fSk7XG5cdH1cblxuXHRwdXQoc19rZXksIHpfZGF0YSkge1xuXHRcdGxldCBoX3N0b3JlID0gdGhpcy53b3JrZXJfc3RvcmU7XG5cdFx0bGV0IGlfdGFzayA9IHRoaXMudGFza19pZDtcblxuXHRcdC8vIGZpcnN0IGl0ZW0gaW4gdGhpcyB0YXNrJ3Mgc3RvcmVcblx0XHRpZiAoIShpX3Rhc2sgaW4gaF9zdG9yZSkpIHtcblx0XHRcdGhfc3RvcmVbaV90YXNrXSA9IHtcblx0XHRcdFx0W3Nfa2V5XTogel9kYXRhLFxuXHRcdFx0fTtcblx0XHR9XG5cdFx0Ly8gbm90IGZpcnN0IGl0ZW07IGFkZCBpdFxuXHRcdGVsc2Uge1xuXHRcdFx0aF9zdG9yZVtpX3Rhc2tdW3Nfa2V5XSA9IHpfZGF0YTtcblx0XHR9XG5cdH1cblxuXHRnZXQoc19rZXkpIHtcblx0XHRsZXQgaV90YXNrID0gdGhpcy50YXNrX2lkO1xuXG5cdFx0Ly8gdGhpcyB0YXNrIGNoYWluIHdhcyBuZXZlciB3cml0dGVuIHRvXG5cdFx0aWYgKCEoaV90YXNrIGluIHRoaXMud29ya2VyX3N0b3JlKSkgcmV0dXJuO1xuXG5cdFx0Ly8gcmV0dXJuIHdoYXRldmVyIHZhbHVlIGlzIHRoZXJlXG5cdFx0cmV0dXJuIHRoaXMud29ya2VyX3N0b3JlW2lfdGFza11bc19rZXldO1xuXHR9XG5cblx0ZW1pdChzX2tleSwgLi4uYV9hcmdzKSB7XG5cdFx0Ly8gb25seSBpZiB0aGUgZXZlbnQgaXMgcmVnaXN0ZXJlZFxuXHRcdGlmIChzX2tleSBpbiB0aGlzLmV2ZW50cykge1xuXHRcdFx0bGV0IGFfYXJnc19zZW5kID0gW107XG5cdFx0XHRsZXQgYV90cmFuc2Zlcl9wYXRocyA9IFtdO1xuXG5cdFx0XHQvLyBtZXJnZSBhcmdzXG5cdFx0XHRsZXQgbl9hcmdzID0gYV9hcmdzLmxlbmd0aDtcblx0XHRcdGZvciAobGV0IGlfYXJnID0gMDsgaV9hcmcgPCBuX2FyZ3M7IGlfYXJnKyspIHtcblx0XHRcdFx0bGV0IHpfYXJnID0gYV9hcmdzW2lfYXJnXTtcblxuXHRcdFx0XHQvLyByZXN1bHRcblx0XHRcdFx0aWYgKHpfYXJnIGluc3RhbmNlb2YgbWFuaWZlc3QpIHtcblx0XHRcdFx0XHRhX2FyZ3Nfc2VuZC5wdXNoKHpfYXJnLmRhdGEpO1xuXHRcdFx0XHRcdGlmICh6X2FyZy50cmFuc2Zlcl9wYXRocykge1xuXHRcdFx0XHRcdFx0bGV0IG5sX3BhdGhzID0gYV90cmFuc2Zlcl9wYXRocy5sZW5ndGg7XG5cdFx0XHRcdFx0XHRsZXQgYV9pbXBvcnRfcGF0aHMgPSB6X2FyZy50cmFuc2Zlcl9wYXRocztcblx0XHRcdFx0XHRcdGFfaW1wb3J0X3BhdGhzLmZvckVhY2goKGFfcGF0aCkgPT4ge1xuXHRcdFx0XHRcdFx0XHRhX3BhdGhbMF0gKz0gbmxfcGF0aHM7XG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdGFfdHJhbnNmZXJfcGF0aHMucHVzaCguLi5hX2ltcG9ydF9wYXRocyk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIHBvc3RhYmxlXG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdGFfYXJnc19zZW5kLnB1c2goel9hcmcpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIHNlbmQgbWVzc2FnZVxuXHRcdFx0S19TRUxGLnBvc3RNZXNzYWdlKHtcblx0XHRcdFx0dHlwZTogJ2V2ZW50Jyxcblx0XHRcdFx0aWQ6IHRoaXMudGFza19pZCxcblx0XHRcdFx0ZXZlbnQ6IHNfa2V5LFxuXHRcdFx0XHRhcmdzOiBhX2FyZ3Nfc2VuZCxcblx0XHRcdH0sIGFfdHJhbnNmZXJfcGF0aHMpO1xuXHRcdH1cblx0fVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGNsYXNzIGRlZGljYXRlZCBleHRlbmRzIHN0cmVhbS5oYW5kbGVyIHtcblx0Y29uc3RydWN0b3IoaF90YXNrcykge1xuXHRcdHN1cGVyKCk7XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdHRhc2tzOiBoX3Rhc2tzLFxuXHRcdFx0c3RvcmU6IHt9LFxuXHRcdFx0cmVzdWx0czoge30sXG5cdFx0XHRwb3J0OiBLX1NFTEYsXG5cdFx0XHRpZDogS19TRUxGLmFyZ3NbMF0sXG5cdFx0fSk7XG5cblx0XHRLX1NFTEYuZXZlbnQoJ2Vycm9yJywgKGVfd29ya2VyKSA9PiB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoZV93b3JrZXIpO1xuXHRcdH0pO1xuXG5cdFx0dGhpcy5zZXRfcG9ydChLX1NFTEYpO1xuXHR9XG5cblx0ZGVidWcoc190eXBlLCAuLi5hX2luZm8pIHtcblx0XHQvLyBjb25zb2xlLndhcm4oYFMke3RoaXMuaWR9ICR7c190eXBlfSAke2FfaW5mby5sZW5ndGg/ICcoJythX2luZm8uam9pbignLCAnKSsnKSc6ICctJ31gKTtcblx0fVxuXG5cdC8vIHJlc29sdmVzIHByb21pc2VzIGFuZCB3cmFwcyByZXN1bHRzXG5cdHJlc29sdmUoel9yZXN1bHQsIGZrX3Jlc29sdmUpIHtcblx0XHQvLyBhIHByb21pc2Ugd2FzIHJldHVybmVkXG5cdFx0aWYgKHpfcmVzdWx0IGluc3RhbmNlb2YgUHJvbWlzZSkge1xuXHRcdFx0el9yZXN1bHRcblx0XHRcdFx0Ly8gb25jZSBpdHMgcmVhZHk7IHJlc29sdmUgdXNpbmcgcmVzdWx0XG5cdFx0XHRcdC50aGVuKCh6X2RhdGEpID0+IHtcblx0XHRcdFx0XHRma19yZXNvbHZlKHJlc3VsdC5mcm9tKHpfZGF0YSkpO1xuXHRcdFx0XHR9KVxuXHRcdFx0XHQvLyBvciBjYXRjaCBpZiB0aGVyZSB3YXMgYSBzeW50YXggZXJyb3IgLyBldGMuXG5cdFx0XHRcdC5jYXRjaCgoZV9yZXNvbHZlKSA9PiB7XG5cdFx0XHRcdFx0dGhpcy50aHJvdyhlX3Jlc29sdmUpO1xuXHRcdFx0XHR9KTtcblx0XHR9XG5cdFx0Ly8gc3luY1xuXHRcdGVsc2Uge1xuXHRcdFx0cmV0dXJuIGZrX3Jlc29sdmUocmVzdWx0LmZyb20oel9yZXN1bHQpKTtcblx0XHR9XG5cdH1cblxuXHR0aHJvdyAoZV90aHJvdykge1xuXHRcdHRoaXMucG9ydC5wb3N0TWVzc2FnZSh7XG5cdFx0XHR0eXBlOiAnZXJyb3InLFxuXHRcdFx0ZXJyb3I6IHtcblx0XHRcdFx0bWVzc2FnZTogZV90aHJvdy5tZXNzYWdlLFxuXHRcdFx0XHRzdGFjazogZV90aHJvdy5zdGFjayxcblx0XHRcdH0sXG5cdFx0fSk7XG5cdH1cblxuXHQvLyB0eXBpY2FsIGV4ZWN1dGUtYW5kLXJlc3BvbmQgdGFza1xuXHRoYW5kbGVfdGFzayhoX21zZykge1xuXHRcdGxldCBoX3Rhc2tzID0gdGhpcy50YXNrcztcblxuXHRcdGxldCB7XG5cdFx0XHRpZDogaV90YXNrLFxuXHRcdFx0dGFzazogc190YXNrLFxuXHRcdFx0YXJnczogYV9hcmdzLFxuXHRcdFx0aW5oZXJpdDogaV9pbmhlcml0ID0gMCxcblx0XHRcdHJlY2VpdmU6IGlfcmVjZWl2ZSA9IDAsXG5cdFx0XHRob2xkOiBiX2hvbGQgPSBmYWxzZSxcblx0XHRcdGV2ZW50czogaF9ldmVudHMgPSB7fSxcblx0XHR9ID0gaF9tc2c7XG5cblx0XHR0aGlzLmRlYnVnKCc8PCB0YXNrOicgKyBzX3Rhc2ssIGlfdGFzayk7XG5cblx0XHQvLyBubyBzdWNoIHRhc2tcblx0XHRpZiAoIShzX3Rhc2sgaW4gaF90YXNrcykpIHtcblx0XHRcdHJldHVybiB0aGlzLnRocm93KG5ldyBFcnJvcihgZGVkaWNhdGVkIHdvcmtlciBoYXMgbm8gc3VjaCB0YXNrIHJlZ2lzdGVyZWQgYXMgJyR7c190YXNrfSdgKSk7XG5cdFx0fVxuXG5cdFx0Ly8gaW5oZXJpdCBzdG9yZSBmcm9tIHByZXZpb3VzIHRhc2tcblx0XHRpZiAoaV9pbmhlcml0KSB7XG5cdFx0XHRsZXQgaF9zdG9yZSA9IHRoaXMuc3RvcmU7XG5cdFx0XHRoX3N0b3JlW2lfdGFza10gPSBoX3N0b3JlW2lfaW5oZXJpdF07XG5cdFx0XHRkZWxldGUgaF9zdG9yZVtpX2luaGVyaXRdO1xuXHRcdH1cblxuXHRcdC8vIHJlY2VpdmUgZGF0YSBmcm9tIHByZXZpb3VzIHRhc2tcblx0XHRpZiAoaV9yZWNlaXZlKSB7XG5cdFx0XHRsZXQgaF9yZXN1bHRzID0gdGhpcy5yZXN1bHRzO1xuXG5cdFx0XHQvLyBwdXNoIHRvIGZyb250IG9mIGFyZ3Ncblx0XHRcdGFfYXJncy51bnNoaWZ0KGhfcmVzdWx0c1tpX3JlY2VpdmVdLmRhdGFbMF0pO1xuXG5cdFx0XHQvLyBmcmVlIHRvIGdjXG5cdFx0XHRkZWxldGUgaF9yZXN1bHRzW2lfcmVjZWl2ZV07XG5cdFx0fVxuXG5cdFx0Ly8gZXhlY3V0ZSBnaXZlbiB0YXNrXG5cdFx0bGV0IHpfcmVzdWx0O1xuXHRcdHRyeSB7XG5cdFx0XHR6X3Jlc3VsdCA9IGhfdGFza3Nbc190YXNrXS5hcHBseShuZXcgaGVscGVyKHRoaXMsIGlfdGFzaywgaF9ldmVudHMpLCBhX2FyZ3MpO1xuXHRcdH0gY2F0Y2ggKGVfZXhlYykge1xuXHRcdFx0ZV9leGVjLm1lc3NhZ2UgPSBgd29ya2VyIHRocmV3IGFuIGVycm9yIHdoaWxlIGV4ZWN1dGluZyB0YXNrICcke3NfdGFza30nOlxcbiR7ZV9leGVjLm1lc3NhZ2V9YDtcblx0XHRcdHJldHVybiB0aGlzLnRocm93KGVfZXhlYyk7XG5cdFx0fVxuXG5cdFx0Ly8gaG9sZCByZXN1bHQgZGF0YSBhbmQgYXdhaXQgZnVydGhlciBpbnN0cnVjdGlvbnMgZnJvbSBtYXN0ZXJcblx0XHRpZiAoYl9ob2xkKSB7XG5cdFx0XHR0aGlzLnJlc29sdmUoel9yZXN1bHQsIChrX3Jlc3VsdCkgPT4ge1xuXHRcdFx0XHQvLyBzdG9yZSByZXN1bHRcblx0XHRcdFx0dGhpcy5yZXN1bHRzW2lfdGFza10gPSBrX3Jlc3VsdDtcblxuXHRcdFx0XHQvLyBzdWJtaXQgbm90aWZpY2F0aW9uIHRvIG1hc3RlclxuXHRcdFx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0XHRcdHR5cGU6ICdub3RpZnknLFxuXHRcdFx0XHRcdGlkOiBpX3Rhc2ssXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdHRoaXMuZGVidWcoJz4+IG5vdGlmeScsIGlfdGFzayk7XG5cdFx0XHR9KTtcblx0XHR9XG5cdFx0Ly8gc2VuZCByZXN1bHQgYmFjayB0byBtYXN0ZXIgYXMgc29vbiBhcyBpdHMgcmVhZHlcblx0XHRlbHNlIHtcblx0XHRcdHRoaXMucmVzb2x2ZSh6X3Jlc3VsdCwgKGtfcmVzdWx0KSA9PiB7XG5cdFx0XHRcdHRoaXMucG9ydC5wb3N0TWVzc2FnZSh7XG5cdFx0XHRcdFx0dHlwZTogJ3Jlc3BvbmQnLFxuXHRcdFx0XHRcdGlkOiBpX3Rhc2ssXG5cdFx0XHRcdFx0ZGF0YToga19yZXN1bHQuZGF0YVswXSxcblx0XHRcdFx0fSwga19yZXN1bHQucGF0aHMoJ2RhdGEnKSk7XG5cblx0XHRcdFx0dGhpcy5kZWJ1ZygnPj4gcmVzcG9uZCcsIGlfdGFzayk7XG5cdFx0XHR9KTtcblx0XHR9XG5cdH1cblxuXHQvLyBzZW5kIHJlc3VsdCBkYXRhIHRvIHNpYmxpbmdcblx0aGFuZGxlX3JlbGF5KGhfbXNnKSB7XG5cdFx0bGV0IGhfcmVzdWx0cyA9IHRoaXMucmVzdWx0cztcblxuXHRcdGxldCB7XG5cdFx0XHRpZDogaV90YXNrLFxuXHRcdFx0cG9ydDogZF9wb3J0LFxuXHRcdH0gPSBoX21zZztcblxuXHRcdC8vIGNvbnNvbGUuZGlyKGRfcG9ydCk7XG5cdFx0dGhpcy5kZWJ1ZygnPDwgcmVsYXknLCBpX3Rhc2ssIGRfcG9ydC5uYW1lKTtcblxuXHRcdC8vIGdyYWIgcmVzdWx0XG5cdFx0bGV0IGtfcmVzdWx0ID0gaF9yZXN1bHRzW2lfdGFza107XG5cblx0XHQvLyBmb3J3YXJkIHRvIGdpdmVuIHBvcnRcblx0XHRkX3BvcnQucG9zdE1lc3NhZ2Uoa19yZXN1bHQuZGF0YVswXSwga19yZXN1bHQudHJhbnNmZXJfcGF0aHMpO1xuXG5cdFx0Ly8gZnJlZSB0byBnY1xuXHRcdGRlbGV0ZSBoX3Jlc3VsdHNbaV90YXNrXTtcblx0fVxuXG5cdC8vIHJlY2VpdmUgZGF0YSBmcm9tIHNpYmxpbmcgYW5kIHRoZW4gZXhlY3V0ZSByZWFkeSB0YXNrXG5cdGhhbmRsZV9yZWNlaXZlKGhfbXNnKSB7XG5cdFx0bGV0IHtcblx0XHRcdHBvcnQ6IGRfcG9ydCxcblx0XHRcdGltcG9ydDogaV9pbXBvcnQsXG5cdFx0XHRwcmltYXJ5OiBiX3ByaW1hcnksXG5cdFx0XHR0YXNrX3JlYWR5OiBoX3Rhc2tfcmVhZHksXG5cdFx0fSA9IGhfbXNnO1xuXG5cdFx0Ly8gYWNjZXB0IHBvcnRcblx0XHRwb3J0cyhkX3BvcnQpO1xuXG5cdFx0dGhpcy5kZWJ1ZygnPDwgcmVjZWl2ZTonICsgaV9pbXBvcnQsIGhfdGFza19yZWFkeS5pZCwgZF9wb3J0Lm5hbWUpO1xuXG5cdFx0Ly8gaW1wb3J0IGRhdGFcblx0XHRsZXQgel9kYXRhX2ltcG9ydCA9IHRoaXMucmVzdWx0c1tpX2ltcG9ydF0uZGF0YVswXTtcblxuXHRcdC8vIGZyZWUgdG8gZ2Ncblx0XHRkZWxldGUgdGhpcy5yZXN1bHRzW2lfaW1wb3J0XTtcblxuXHRcdC8vIHRhc2sgcmVhZHkgYXJnc1xuXHRcdGxldCBhX2FyZ3NfdGFza19yZWFkeSA9IGhfdGFza19yZWFkeS5hcmdzO1xuXG5cdFx0Ly8gaW1wb3J0IGlzIHNlY29uZGFyeVxuXHRcdGlmICghYl9wcmltYXJ5KSBhX2FyZ3NfdGFza19yZWFkeS51bnNoaWZ0KHpfZGF0YV9pbXBvcnQpO1xuXG5cdFx0dGhpcy5kZWJ1Zygnc2V0dXAnLCB1dGlsLmluc3BlY3QoYV9hcmdzX3Rhc2tfcmVhZHksIHtcblx0XHRcdGRlcHRoOiBudWxsXG5cdFx0fSkpO1xuXG5cdFx0Ly8gc2V0IHVwIG1lc3NhZ2UgaGFuZGxlciBvbiBwb3J0XG5cdFx0ZF9wb3J0LmV2ZW50cyh7XG5cdFx0XHRtZXNzYWdlOiAoZF9tc2dfcmVjZWl2ZSkgPT4ge1xuXHRcdFx0XHR0aGlzLmRlYnVnKCc8PCByZWxheS9yZWNlaXZlJywgZF9wb3J0Lm5hbWUpO1xuXG5cdFx0XHRcdC8vIGNsb3NlIHBvcnQgb24gYm90aCBzaWRlc1xuXHRcdFx0XHRkX3BvcnQuY2xvc2UoKTtcblxuXHRcdFx0XHQvLyBwdXNoIG1lc3NhZ2UgdG8gZnJvbnQgb2YgYXJnc1xuXHRcdFx0XHRhX2FyZ3NfdGFza19yZWFkeS51bnNoaWZ0KGRfbXNnX3JlY2VpdmUuZGF0YSk7XG5cblx0XHRcdFx0Ly8gaW1wb3J0IGlzIHByaW1hcnlcblx0XHRcdFx0aWYgKGJfcHJpbWFyeSkgYV9hcmdzX3Rhc2tfcmVhZHkudW5zaGlmdCh6X2RhdGFfaW1wb3J0KTtcblxuXHRcdFx0XHQvLyBmaXJlIHJlYWR5IHRhc2tcblx0XHRcdFx0dGhpcy5oYW5kbGVfdGFzayhoX3Rhc2tfcmVhZHkpO1xuXHRcdFx0fSxcblxuXHRcdFx0bWVzc2FnZWVycm9yOiAoZV9tc2cpID0+IHtcblx0XHRcdFx0dGhyb3cgZV9tc2c7XG5cdFx0XHR9LFxuXHRcdH0pO1xuXHR9XG5cblx0aGFuZGxlX3BpbmcoKSB7XG5cdFx0dGhpcy5wb3J0LnBvc3RNZXNzYWdlKHtcblx0XHRcdHR5cGU6ICdwb25nJyxcblx0XHR9KTtcblx0fVxuXG5cdGhhbmRsZV9vd25lcihoX21zZykge1xuXHRcdHRoaXMuc2V0X3BvcnQocG9ydHMoaF9tc2cucG9ydCkpO1xuXHR9XG5cblx0aGFuZGxlX3N1YndvcmtlcihoX21zZykge1xuXHRcdGxhdGVudF9zdWJ3b3JrZXIuY29ubmVjdChoX21zZyk7XG5cdH1cblxuXHRzZXRfcG9ydChkX3BvcnQpIHtcblx0XHR0aGlzLnBvcnQgPSBkX3BvcnQ7XG5cblx0XHRkX3BvcnQuZXZlbnRzKHtcblx0XHRcdG1lc3NhZ2U6IChkX21zZykgPT4ge1xuXHRcdFx0XHQvLyBkZWJ1Z2dlcjtcblx0XHRcdFx0bGV0IGhfbXNnID0gZF9tc2cuZGF0YTtcblxuXHRcdFx0XHQvLyBoYW5kbGUgbWVzc2FnZVxuXHRcdFx0XHRsZXQgc19oYW5kbGUgPSAnaGFuZGxlXycgKyBoX21zZy50eXBlO1xuXHRcdFx0XHRpZiAoc19oYW5kbGUgaW4gdGhpcykge1xuXHRcdFx0XHRcdHRoaXNbc19oYW5kbGVdKGhfbXNnKTtcblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBtaXNzaW5nIGhhbmRsZSBuYW1lIGluIG1lc3NhZ2Vcblx0XHRcdFx0ZWxzZSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdkZWRpY2F0ZWQgd29ya2VyIHJlY2VpdmVkIGEgbWVzc2FnZSBpdCBkb2VzIG5vdCBrbm93IGhvdyB0byBoYW5kbGU6ICcgKyBkX21zZyk7XG5cdFx0XHRcdH1cblx0XHRcdH0sXG5cblx0XHRcdG1lc3NhZ2VlcnJvcjogKGVfbXNnKSA9PiB7XG5cdFx0XHRcdHRocm93IGVfbXNnO1xuXHRcdFx0fSxcblx0XHR9KTtcblx0fVxufTsiLCJjb25zdCB7XG5cdE5fQ09SRVMsXG5cdEhQX1dPUktFUl9OT1RJRklDQVRJT04sXG5cdERDX0NIQU5ORUwsXG59ID0gcmVxdWlyZSgnLi9sb2NhbHMuanMnKTtcblxuY29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKCcuL21hbmlmZXN0LmpzJyk7XG5sZXQgd29ya2VyO1xuXG5cbmNvbnN0IFhNX1NUUkFURUdZX0VRVUFMID0gMSA8PCAwO1xuXG5jb25zdCBYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQU19CQUxBTkNFRCA9IDEgPDwgMjtcbmNvbnN0IFhNX1NUUkFURUdZX09SREVSRURfR1JPVVBTX0JJQVNFRCA9IDEgPDwgMztcblxuY29uc3QgWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFMgPSBYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQU19CQUxBTkNFRCB8IFhNX1NUUkFURUdZX09SREVSRURfR1JPVVBTX0JJQVNFRDtcblxuY29uc3QgWE1fRElTVFJJQlVUSU9OX0NPTlNUQU5UID0gMSA8PCAwO1xuXG5cbmNsYXNzIGxvY2sge1xuXHRjb25zdHJ1Y3RvcihiX3VubG9ja2VkID0gZmFsc2UpIHtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdHVubG9ja2VkOiBiX3VubG9ja2VkLFxuXHRcdFx0cXVldWU6IFtdLFxuXHRcdH0pO1xuXHR9XG5cblx0d2FpdChma191bmxvY2spIHtcblx0XHQvLyBhbHJlYWR5IHVubG9ja2VkXG5cdFx0aWYgKHRoaXMudW5sb2NrZWQpIHtcblx0XHRcdGZrX3VubG9jaygpO1xuXHRcdH1cblx0XHQvLyBjdXJyZW50bHkgbG9ja2VkLCBhZGQgdG8gcXVldWVcblx0XHRlbHNlIHtcblx0XHRcdHRoaXMucXVldWUucHVzaChma191bmxvY2spO1xuXHRcdH1cblx0fVxuXG5cdHVubG9jaygpIHtcblx0XHQvLyB1cGRhdGUgc3RhdGVcblx0XHR0aGlzLnVubG9ja2VkID0gdHJ1ZTtcblxuXHRcdC8vIHVwZGF0ZSBmaWVsZCBiZWZvcmUgZXhlY3V0aW5nIGNhbGxiYWNrc1xuXHRcdGxldCBhX3F1ZXVlID0gdGhpcy5xdWV1ZTtcblx0XHR0aGlzLnF1ZXVlID0gW107XG5cblx0XHQvLyBwcm9jZXNzIGNhbGxiYWNrIHF1ZXVlXG5cdFx0YV9xdWV1ZS5mb3JFYWNoKChma191bmxvY2spID0+IHtcblx0XHRcdGZrX3VubG9jaygpO1xuXHRcdH0pO1xuXHR9XG59XG5cblxuY2xhc3MgZ3JvdXAge1xuXHRjb25zdHJ1Y3RvcihwX3NvdXJjZSwgbl93b3JrZXJzID0gTl9DT1JFUywgaF93b3JrZXJfb3B0aW9ucyA9IHt9KSB7XG5cdFx0Ly8gbm8gd29ya2VyIGNvdW50IGdpdmVuOyBkZWZhdWx0IHRvIG51bWJlciBvZiBjb3Jlc1xuXHRcdGlmICghbl93b3JrZXJzKSBuX3dvcmtlcnMgPSBOX0NPUkVTO1xuXG5cdFx0Ly8gbmVnYXRpdmUgbnVtYmVyIGdpdmVuOyBzdWJ0cmFjdCBmcm9tIGNvcmUgY291bnRcblx0XHRpZiAobl93b3JrZXJzIDwgMCkgbl93b3JrZXJzID0gTWF0aC5tYXgoMSwgTl9DT1JFUyArIG5fd29ya2Vycyk7XG5cblx0XHQvLyBtYWtlIHdvcmtlcnNcblx0XHRsZXQgYV93b3JrZXJzID0gW107XG5cdFx0bGV0IGhtX3Jvc3RlciA9IG5ldyBXZWFrTWFwKCk7XG5cdFx0Zm9yIChsZXQgaV93b3JrZXIgPSAwOyBpX3dvcmtlciA8IG5fd29ya2VyczsgaV93b3JrZXIrKykge1xuXHRcdFx0Ly8gbWFrZSBuZXcgd29ya2VyXG5cdFx0XHRsZXQga193b3JrZXIgPSBuZXcgd29ya2VyKHtcblx0XHRcdFx0c291cmNlOiBwX3NvdXJjZSxcblx0XHRcdFx0aWQ6IGlfd29ya2VyLFxuXHRcdFx0XHRtYXN0ZXI6IHRoaXMsXG5cdFx0XHRcdG9wdGlvbnM6IE9iamVjdC5hc3NpZ24oe1xuXHRcdFx0XHRcdGFyZ3M6IFtTdHJpbmcuZnJvbUNoYXJDb2RlKDY1ICsgaV93b3JrZXIpXSxcblx0XHRcdFx0fSwgaF93b3JrZXJfb3B0aW9ucyksXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gYWRkIHRvIHdvcmtlciBsaXN0XG5cdFx0XHRhX3dvcmtlcnMucHVzaChrX3dvcmtlcik7XG5cblx0XHRcdC8vIHJlc2VydmUgYSBxdWV1ZSBmb3IgaXQgaW4gcm9zdGVyXG5cdFx0XHRobV9yb3N0ZXIuc2V0KGtfd29ya2VyLCBbXSk7XG5cdFx0fVxuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdFx0d29ya2VyX2NvdW50OiBuX3dvcmtlcnMsXG5cdFx0XHR3b3JrZXJzOiBhX3dvcmtlcnMsXG5cdFx0XHRyb3N0ZXI6IGhtX3Jvc3Rlcixcblx0XHRcdHdhaXRfbGlzdDogW10sXG5cdFx0XHRsb2Nrczoge30sXG5cdFx0XHRuZXh0X3dvcmtlcl9zdW1tb246IDAsXG5cdFx0fSk7XG5cdH1cblxuXHRkYXRhKGFfaXRlbXMpIHtcblx0XHRyZXR1cm4gbmV3IGFybWVkX2dyb3VwKHRoaXMsIHRoaXMuYmFsYW5jZShhX2l0ZW1zKSk7XG5cdH1cblxuXHR1c2UoYV9zdWJzZXRzKSB7XG5cdFx0aWYgKGFfc3Vic2V0cy5sZW5ndGggPiB0aGlzLndvcmtlcl9jb3VudCkge1xuXHRcdFx0dGhyb3cgbmV3IFJhbmdlRXJyb3IoYHRvbyBtYW55IHN1YnNldHMgZ2l2ZW4gZm9yIG51bWJlciBvZiB3b3JrZXJzOiAke2Ffc3Vic2V0cy5sZW5ndGh9IHN1YnNldHMgPiAke3RoaXMud29ya2VyX2NvdW50fSB3b3JrZXJzYCk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIG5ldyBhcm1lZF9ncm91cCh0aGlzLCBhX3N1YnNldHMpO1xuXHR9XG5cblx0d2FpdCh6X2tleSwgel91bmxvY2spIHtcblx0XHRsZXQgZmtfdW5sb2NrID0gel91bmxvY2s7XG5cblx0XHQvLyB1bmxvY2sgaXMgYW5vdGhlciBsb2NrXG5cdFx0aWYgKCdzdHJpbmcnID09PSB0eXBlb2Ygel91bmxvY2spIHtcblx0XHRcdGZrX3VubG9jayA9ICgpID0+IHtcblx0XHRcdFx0dGhpcy51bmxvY2soel91bmxvY2spO1xuXHRcdFx0fTtcblx0XHR9XG5cdFx0Ly8gdW5sb2NrIGlzIGFycmF5IG9mIGxvY2tzXG5cdFx0ZWxzZSBpZiAoQXJyYXkuaXNBcnJheSh6X3VubG9jaykpIHtcblx0XHRcdGZrX3VubG9jayA9ICgpID0+IHtcblx0XHRcdFx0dGhpcy51bmxvY2soel91bmxvY2spO1xuXHRcdFx0fTtcblx0XHR9XG5cblx0XHQvLyBzZXJpZXMgb2Yga2V5cyB0byB3YWl0IGZvclxuXHRcdGlmIChBcnJheS5pc0FycmF5KHpfa2V5KSkge1xuXHRcdFx0bGV0IGlfa2V5ID0gMDtcblx0XHRcdGxldCBuX2tleXMgPSB6X2tleS5sZW5ndGg7XG5cdFx0XHRsZXQgZl9uZXh0ID0gKCkgPT4ge1xuXHRcdFx0XHRpZiAoaV9rZXkgPT09IG5fa2V5cykgZmtfdW5sb2NrKCk7XG5cdFx0XHRcdGVsc2UgdGhpcy53YWl0KHpfa2V5W2lfa2V5KytdLCBmX25leHQpO1xuXHRcdFx0fTtcblxuXHRcdFx0Zl9uZXh0KCk7XG5cdFx0fVxuXHRcdC8vIG5vIHN1Y2ggbG9jazsgYnV0IHRoYXQncyBva2F5IDspIGNyZWF0ZSBsb2NrIGltcGxpY2l0bHlcblx0XHRlbHNlIGlmICghKHpfa2V5IGluIHRoaXMubG9ja3MpKSB7XG5cdFx0XHRsZXQga19sb2NrID0gdGhpcy5sb2Nrc1t6X2tleV0gPSBuZXcgbG9jaygpO1xuXHRcdFx0a19sb2NrLndhaXQoZmtfdW5sb2NrKTtcblx0XHR9XG5cdFx0Ly8gYWRkIHRvIHdhaXQgcXVldWVcblx0XHRlbHNlIHtcblx0XHRcdHRoaXMubG9ja3Nbel9rZXldLndhaXQoZmtfdW5sb2NrKTtcblx0XHR9XG5cdH1cblxuXHR1bmxvY2soel9rZXkpIHtcblx0XHQvLyBsaXN0IG9mIGtleXMgdG8gdW5sb2NrXG5cdFx0aWYgKEFycmF5LmlzQXJyYXkoel9rZXkpKSB7XG5cdFx0XHR6X2tleS5mb3JFYWNoKHpfa2V5XyA9PiB0aGlzLnVubG9jayh6X2tleV8pKTtcblx0XHR9XG5cdFx0Ly8gaW5kaXZ1ZGFsIGtleVxuXHRcdGVsc2Uge1xuXHRcdFx0Ly8gbm8gc3VjaCBsb2NrIHlldFxuXHRcdFx0aWYgKCEoel9rZXkgaW4gdGhpcy5sb2NrcykpIHtcblx0XHRcdFx0dGhpcy5sb2Nrc1t6X2tleV0gPSBuZXcgbG9jayh0cnVlKTtcblx0XHRcdH1cblx0XHRcdC8vIHVubG9ja1xuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdHRoaXMubG9ja3Nbel9rZXldLnVubG9jaygpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdGJhbGFuY2UoYV9pdGVtcykge1xuXHRcdHJldHVybiBkaXZpZGUoYV9pdGVtcywgdGhpcy53b3JrZXJfY291bnQsIFhNX1NUUkFURUdZX0VRVUFMKTtcblx0fVxuXG5cdGJhbGFuY2Vfb3JkZXJlZF9ncm91cHMoYV9ncm91cHMsIGhfZGl2aWRlKSB7XG5cdFx0cmV0dXJuIGRpdmlkZShhX2dyb3VwcywgdGhpcy53b3JrZXJfY291bnQsIFhNX1NUUkFURUdZX09SREVSRURfR1JPVVBTX0JBTEFOQ0VELCBoX2RpdmlkZSk7XG5cdH1cblxuXHRiaWFzX29yZGVyZWRfZ3JvdXBzKGFfZ3JvdXBzLCBoX2RpdmlkZSkge1xuXHRcdHJldHVybiBkaXZpZGUoYV9ncm91cHMsIHRoaXMud29ya2VyX2NvdW50LCBYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQU19CSUFTRUQsIGhfZGl2aWRlKTtcblx0fVxuXG5cdGRpdmlzaW9ucyhuX2l0ZW1zKSB7XG5cdFx0bGV0IG5fd29ya2VycyA9IHRoaXMud29ya2VyX2NvdW50O1xuXG5cdFx0Ly8gZG8gbm90IGFzc2lnbiB3b3JrZXIgdG8gZG8gbm90aGluZ1xuXHRcdGlmIChuX2l0ZW1zIDwgbl93b3JrZXJzKSBuX3dvcmtlcnMgPSBuX2l0ZW1zO1xuXG5cdFx0Ly8gaG93IG1hbnkgdGltZXMgdG8gZGl2aWRlIHRoZSBpdGVtc1xuXHRcdGxldCBuX2RpdmlzaW9ucyA9IG5fd29ya2VycyAtIDE7XG5cblx0XHQvLyBpZGVhbCBudW1iZXIgb2YgaXRlbXMgcGVyIHdvcmtlclxuXHRcdGxldCB4X2l0ZW1zX3Blcl93b3JrZXIgPSBuX2l0ZW1zIC8gbl93b3JrZXJzO1xuXG5cdFx0Ly8gaXRlbSBpbmRpY2VzIHdoZXJlIHRvIG1ha2UgZGl2aXNpb25zXG5cdFx0bGV0IGFfZGl2aXNpb25zID0gW107XG5cdFx0Zm9yIChsZXQgaV9kaXZpc2lvbiA9IDE7IGlfZGl2aXNpb24gPD0gbl9kaXZpc2lvbnM7IGlfZGl2aXNpb24rKykge1xuXHRcdFx0YV9kaXZpc2lvbnMucHVzaChNYXRoLnJvdW5kKGlfZGl2aXNpb24gKiB4X2l0ZW1zX3Blcl93b3JrZXIpKTtcblx0XHR9XG5cblx0XHRyZXR1cm4gYV9kaXZpc2lvbnM7XG5cdH1cblxuXHQqIGRpdmlkZXIoY19pdGVtc19yZW1haW4sIHhtX2Rpc3RyaWJ1dGlvbiA9IFhNX0RJU1RSSUJVVElPTl9DT05TVEFOVCkge1xuXHRcdGxldCBjX3dvcmtlcnNfcmVtYWluID0gdGhpcy53b3JrZXJfY291bnQ7XG5cblx0XHQvLyBpdGVtcyBwZXIgd29ya2VyXG5cdFx0bGV0IG5faXRlbXNfcGVyX2RpdmlzaW9uID0gTWF0aC5mbG9vcihjX2l0ZW1zX3JlbWFpbiAvIGNfd29ya2Vyc19yZW1haW4pO1xuXG5cdFx0Ly8gY29uc3RhbnQgZGlzdHJpYnV0aW9uXG5cdFx0aWYgKFhNX0RJU1RSSUJVVElPTl9DT05TVEFOVCA9PT0geG1fZGlzdHJpYnV0aW9uKSB7XG5cdFx0XHRsZXQgY19pdGVtcyA9IDA7XG5cblx0XHRcdC8vIGl0ZXJhdGl2ZWx5IGZpbmQgaW5kZXhlcyB0byBkaXZpZGUgYXRcblx0XHRcdGZvciAoOzspIHtcblx0XHRcdFx0Ly8gZGl2aWRlIGhlcmVcblx0XHRcdFx0aWYgKCsrY19pdGVtcyA+PSBuX2l0ZW1zX3Blcl9kaXZpc2lvbikge1xuXHRcdFx0XHRcdC8vIGRpdmlkaW5nIG5vdyB3b3VsZCBjYXVzZSBpdGVtIG92ZXJmbG93XG5cdFx0XHRcdFx0aWYgKCEtLWNfd29ya2Vyc19yZW1haW4pIHtcblx0XHRcdFx0XHRcdC8vIGRvbid0IGNyZWF0ZSBhbnkgbW9yZSBkaXZpc2lvbnNcblx0XHRcdFx0XHRcdGZvciAoOzspIHlpZWxkIGZhbHNlO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdC8vIGRpdmlzaW9uIG9rYXlcblx0XHRcdFx0XHR5aWVsZCB0cnVlO1xuXG5cdFx0XHRcdFx0Ly8gaG93IG1hbnkgaXRlbXMgcmVtYWluXG5cdFx0XHRcdFx0Y19pdGVtc19yZW1haW4gLT0gY19pdGVtcztcblxuXHRcdFx0XHRcdC8vIHJlc2V0IGl0ZW0gY291bnQgZm9yIG5ldyB3b3JrZXJcblx0XHRcdFx0XHRjX2l0ZW1zID0gMDtcblxuXHRcdFx0XHRcdC8vIHJlY2FsY3VsYXRlIHRhcmdldCBpdGVtcyBwZXIgd29ya2VyXG5cdFx0XHRcdFx0bl9pdGVtc19wZXJfZGl2aXNpb24gPSBNYXRoLmZsb29yKGNfaXRlbXNfcmVtYWluIC8gY193b3JrZXJzX3JlbWFpbik7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gcHVzaCBpdGVtXG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdHlpZWxkIGZhbHNlO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblxuXHQvLyBsYXRlbnQoaF9kaXNwYXRjaCkge1xuXHQvLyBcdGxldCB7XG5cdC8vIFx0XHR0YXNrOiBzX3Rhc2ssXG5cdC8vIFx0XHRhcmdzOiBhX2FyZ3NfZGlzcGF0Y2g9W10sXG5cdC8vIFx0XHR0YXNrX2NvdW50OiBuX3Rhc2tzPXRoaXMud29ya2VyX2NvdW50LFxuXHQvLyBcdFx0ZXZlbnRzOiBoX2V2ZW50c19kaXNwYXRjaCxcblx0Ly8gXHR9ID0gaF9kaXNwYXRjaDtcblxuXHQvLyBcdGxldCBpX3N1YnNldCA9IDA7XG5cblx0Ly8gXHQvLyBwcmVwYXJlIHRvIGRlYWwgd2l0aCByZXN1bHRzXG5cdC8vIFx0bGV0IGtfcGxhbm5lciA9IG5ldyBhY3RpdmVfZ3JvdXAodGhpcywgbl90YXNrcywgKGFfYXJncz1bXSwgYV90cmFuc2Zlcj1udWxsKSA9PiB7XG5cdC8vIFx0XHQvLyBzdW1tb24gd29ya2VycyBvbmUgYXQgYSB0aW1lXG5cdC8vIFx0XHR0aGlzLnN1bW1vbl93b3JrZXJzKDEsIChrX3dvcmtlcikgPT4ge1xuXHQvLyBcdFx0XHQvLyByZXN1bHQgaGFuZGxlciB3YXMgbm90IHVzZWQ7IGF1dG8tZW5kIGl0XG5cdC8vIFx0XHRcdGlmKCFrX3BsYW5uZXIudXNlZCkga19wbGFubmVyLmVuZCgpO1xuXG5cdC8vIFx0XHRcdC8vIG1ha2UgcmVzdWx0IGhhbmRsZXJcblx0Ly8gXHRcdFx0bGV0IGZrX3Jlc3VsdCA9IGtfcGxhbm5lci5ta19yZXN1bHQoa193b3JrZXIsIGlfc3Vic2V0KyspO1xuXG5cdC8vIFx0XHRcdC8vIG1ha2Ugd29ya2VyLXNwZWNpZmljIGV2ZW50c1xuXHQvLyBcdFx0XHRsZXQgaF9ldmVudHNfd29ya2VyID0gdGhpcy5ldmVudF9yb3V0ZXIoaF9ldmVudHNfZGlzcGF0Y2gsIGlfc3Vic2V0KTtcblxuXHQvLyBcdFx0XHQvLyBleGVjdXRlIHdvcmtlciBvbiB0aGlzIHBhcnQgb2YgZGF0YVxuXHQvLyBcdFx0XHRrX3dvcmtlci5leGVjKHtcblx0Ly8gXHRcdFx0XHR0YXNrOiBzX3Rhc2ssXG5cdC8vIFx0XHRcdFx0YXJnczogWy4uLmFfYXJnc19kaXNwYXRjaCwgLi4uYV9hcmdzXSxcblx0Ly8gXHRcdFx0XHR0cmFuc2ZlcjogYV90cmFuc2Zlcixcblx0Ly8gXHRcdFx0XHRob2xkOiBrX3BsYW5uZXIudXBzdHJlYW1faG9sZCxcblx0Ly8gXHRcdFx0XHRldmVudHM6IGhfZXZlbnRzX3dvcmtlcixcblx0Ly8gXHRcdFx0fSwgZmtfcmVzdWx0KTtcblx0Ly8gXHRcdH0pO1xuXHQvLyBcdH0pO1xuXG5cdC8vIFx0Ly8gbGV0IHVzZXIgYmluZCBoYW5kbGVyXG5cdC8vIFx0cmV0dXJuIGtfcGxhbm5lcjtcblx0Ly8gfVxuXG5cdHNjaGVkdWxlKGtfd29ya2VyLCBmX3J1bikge1xuXHRcdC8vIHdvcmtlciBhdmFpbGFibGUgaW1tZWRpYXRlbHlcblx0XHRpZiAoa193b3JrZXIuYXZhaWxhYmxlKSB7XG5cdFx0XHRmX3J1bigpO1xuXHRcdH1cblx0XHQvLyBwdXNoIHRvIHByaW9yaXR5IHF1ZXVlXG5cdFx0ZWxzZSB7XG5cdFx0XHR0aGlzLnJvc3Rlci5nZXQoa193b3JrZXIpLnB1c2goZl9ydW4pO1xuXHRcdH1cblx0fVxuXG5cdGFzc2lnbl93b3JrZXIoa193b3JrZXIsIGhfdGFzaywgZmtfdGFzaykge1xuXHRcdC8vIG9uY2UgaXQgaXMgdGltZSB0byBydW4gdGhlIHRhc2sgb24gdGhlIGdpdmVuIHdvcmtlclxuXHRcdHRoaXMuc2NoZWR1bGUoa193b3JrZXIsICgpID0+IHtcblx0XHRcdGtfd29ya2VyLmV4ZWMoaF90YXNrLCAoLi4uYV9hcmdzKSA9PiB7XG5cdFx0XHRcdC8vIHdvcmtlciBqdXN0IG1hZGUgaXRzZWxmIGF2YWlsYWJsZVxuXHRcdFx0XHR0aGlzLndvcmtlcl9hdmFpbGFibGUoa193b3JrZXIpO1xuXG5cdFx0XHRcdC8vIGNhbGxiYWNrXG5cdFx0XHRcdGZrX3Rhc2soLi4uYV9hcmdzKTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9XG5cblx0cmVsYXkoaF9yZWxheSwgZmtfcmVzdWx0KSB7XG5cdFx0bGV0IHtcblx0XHRcdHNlbmRlcjoge1xuXHRcdFx0XHR3b3JrZXI6IGtfd29ya2VyX3NlbmRlcixcblx0XHRcdFx0dGFza19pZDogaV90YXNrX3NlbmRlcixcblx0XHRcdH0sXG5cdFx0XHRyZWNlaXZlcjoge1xuXHRcdFx0XHR3b3JrZXI6IGtfd29ya2VyX3JlY2VpdmVyLFxuXHRcdFx0XHR0YXNrX2lkOiBpX3Rhc2tfcmVjZWl2ZXIsXG5cdFx0XHR9LFxuXHRcdFx0cmVjZWl2ZXJfcHJpbWFyeTogYl9yZWNlaXZlcl9wcmltYXJ5LFxuXHRcdFx0dGFza19yZWFkeTogaF90YXNrX3JlYWR5LFxuXHRcdH0gPSBoX3JlbGF5O1xuXG5cdFx0bGV0IHNfc2VuZGVyID0gJ1MnICsgU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIGtfd29ya2VyX3NlbmRlci5pZCk7XG5cdFx0bGV0IHNfcmVjZWl2ZXIgPSAnUycgKyBTdHJpbmcuZnJvbUNoYXJDb2RlKDY1ICsga193b3JrZXJfcmVjZWl2ZXIuaWQpO1xuXG5cdFx0Ly8gY3JlYXRlIG1lc3NhZ2UgY2hhbm5lbFxuXHRcdGxldCBrX2NoYW5uZWwgPSBuZXcgRENfQ0hBTk5FTChzX3NlbmRlciwgc19yZWNlaXZlcik7XG5cblx0XHRpZiAoa193b3JrZXJfc2VuZGVyID09PSBrX3dvcmtlcl9yZWNlaXZlcikgZGVidWdnZXI7XG5cblx0XHQvLyBjb25zb2xlLndhcm4oYE0vcmVsYXkvcmVjZWl2ZSBbJHtpX3Rhc2tfc2VuZGVyfV0gPT4gJHtpX3Rhc2tfcmVjZWl2ZXJ9YCk7XG5cblx0XHQvLyBzY2hlZHVsZSByZWNlaXZlciB3b3JrZXIgdG8gcmVjZWl2ZSBkYXRhIGFuZCB0aGVuIHJ1biB0YXNrXG5cdFx0dGhpcy5zY2hlZHVsZShrX3dvcmtlcl9yZWNlaXZlciwgKCkgPT4ge1xuXHRcdFx0a19jaGFubmVsLnBvcnRfMigoZF9wb3J0KSA9PiB7XG5cdFx0XHRcdGtfd29ya2VyX3JlY2VpdmVyLnJlY2VpdmUoZF9wb3J0LCB7XG5cdFx0XHRcdFx0aW1wb3J0OiBpX3Rhc2tfcmVjZWl2ZXIsXG5cdFx0XHRcdFx0cHJpbWFyeTogYl9yZWNlaXZlcl9wcmltYXJ5LFxuXHRcdFx0XHRcdHRhc2tfcmVhZHk6IGhfdGFza19yZWFkeSxcblx0XHRcdFx0fSwgKC4uLmFfYXJncykgPT4ge1xuXHRcdFx0XHRcdC8vIHdvcmtlciBqdXN0IG1hZGUgaXRzZWxmIGF2YWlsYWJsZVxuXHRcdFx0XHRcdHRoaXMud29ya2VyX2F2YWlsYWJsZShrX3dvcmtlcl9yZWNlaXZlcik7XG5cblx0XHRcdFx0XHQvLyBjYWxsYmFja1xuXHRcdFx0XHRcdGZrX3Jlc3VsdCguLi5hX2FyZ3MpO1xuXHRcdFx0XHR9KTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXG5cdFx0Ly8gc2NoZWR1bGUgc2VuZGVyIHdvcmtlciB0byByZWxheSBkYXRhIHRvIHJlY2VpdmVyIHdvcmtlclxuXHRcdHRoaXMuc2NoZWR1bGUoa193b3JrZXJfc2VuZGVyLCAoKSA9PiB7XG5cdFx0XHRrX2NoYW5uZWwucG9ydF8xKChkX3BvcnQpID0+IHtcblx0XHRcdFx0a193b3JrZXJfc2VuZGVyLnJlbGF5KGlfdGFza19zZW5kZXIsIGRfcG9ydCwgU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIGtfd29ya2VyX3JlY2VpdmVyLmlkKSk7XG5cblx0XHRcdFx0Ly8gbm8gcmVzdWx0IG5lZWRlZCBmcm9tIHJlbGF5OyB3b3JrZXIgaXMgYXZhaWxhYmxlIGFmdGVyIG1lc3NhZ2UgcG9zdHNcblx0XHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0dGhpcy53b3JrZXJfYXZhaWxhYmxlKGtfd29ya2VyX3NlbmRlcik7XG5cdFx0XHRcdH0sIDApO1xuXHRcdFx0fSk7XG5cdFx0fSk7XG5cblx0fVxuXG5cdHN1bW1vbl93b3JrZXJzKG5fc3VtbW9ucywgZmtfd29ya2VyKSB7XG5cdFx0bGV0IGFfd29ya2VycyA9IHRoaXMud29ya2Vycztcblx0XHRsZXQgbl93b3JrZXJzID0gdGhpcy53b3JrZXJfY291bnQ7XG5cblx0XHRsZXQgY19zdW1tb25lZCA9IDA7XG5cblx0XHQvLyBzdGFydCBieSBsb29raW5nIGZvciBhdmFpbGFibGUgd29ya2Vyc1xuXHRcdGxldCBpX25leHRfd29ya2VyX3N1bW1vbiA9IHRoaXMubmV4dF93b3JrZXJfc3VtbW9uO1xuXG5cdFx0Zm9yIChsZXQgaV93b3JrZXIgPSAwOyBpX3dvcmtlciA8IG5fd29ya2VycyAmJiBjX3N1bW1vbmVkIDwgbl9zdW1tb25zOyBpX3dvcmtlcisrKSB7XG5cdFx0XHRsZXQgaV93b3JrZXJfY2FsbCA9IChpX3dvcmtlciArIGlfbmV4dF93b3JrZXJfc3VtbW9uKSAlIG5fd29ya2Vycztcblx0XHRcdGxldCBrX3dvcmtlciA9IGFfd29ya2Vyc1tpX3dvcmtlcl9jYWxsXTtcblxuXHRcdFx0Ly8gd29ya2VyIGF2YWlsYWJsZSBpbW1lZGlhdGVseVxuXHRcdFx0aWYgKGtfd29ya2VyLmF2YWlsYWJsZSkge1xuXHRcdFx0XHQvLyBzZXQgbmV4dCB3b3JrZXIgdG8gc3VtbW9uXG5cdFx0XHRcdHRoaXMubmV4dF93b3JrZXJfc3VtbW9uID0gaV93b3JrZXJfY2FsbCArIDE7XG5cblx0XHRcdFx0Ly8gc2F2ZSBzdW1tb24gaW5kZXhcblx0XHRcdFx0bGV0IGlfc3Vic2V0ID0gY19zdW1tb25lZCsrO1xuXG5cdFx0XHRcdC8vIGFsbG93IGRvd25zdHJlYW0gaGFuZGxlciB0byBiZSBlc3RhYmxpc2hlZCBmaXJzdFxuXHRcdFx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0XHQvLyBjb25zb2xlLmluZm8oJyA9PiAnK2tfd29ya2VyLmlkKTtcblx0XHRcdFx0XHRma193b3JrZXIoa193b3JrZXIsIGlfc3Vic2V0KTtcblx0XHRcdFx0fSwgMCk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gdGhlcmUgYXJlIHJlbWFpbmluZyBzdW1tb25zXG5cdFx0aWYgKGNfc3VtbW9uZWQgPCBuX3N1bW1vbnMpIHtcblx0XHRcdC8vIHF1ZXVlIGZvciBub3RpZmljYXRpb24gd2hlbiB3b3JrZXJzIGJlY29tZSBhdmFpbGFibGVcblx0XHRcdHRoaXMud2FpdF9saXN0LnB1c2goe1xuXHRcdFx0XHR0YXNrc19yZW1haW5pbmc6IG5fc3VtbW9ucyAtIGNfc3VtbW9uZWQsXG5cdFx0XHRcdGVhY2goa193b3JrZXIpIHtcblx0XHRcdFx0XHRma193b3JrZXIoa193b3JrZXIsIGNfc3VtbW9uZWQrKyk7XG5cdFx0XHRcdH0sXG5cdFx0XHR9KTtcblx0XHR9XG5cdH1cblxuXHR3b3JrZXJfYXZhaWxhYmxlKGtfd29ya2VyKSB7XG5cdFx0Ly8gdGhpcyB3b3JrZXIgaGFzIHByaW9yaXR5IHRhc2tzIHdhaXRpbmcgZm9yIGl0XG5cdFx0bGV0IGFfcXVldWUgPSB0aGlzLnJvc3Rlci5nZXQoa193b3JrZXIpO1xuXHRcdGlmIChhX3F1ZXVlLmxlbmd0aCkge1xuXHRcdFx0Ly8gZmlmbyBwb3AgYW5kIGNhbGxcblx0XHRcdGxldCBma193b3JrZXIgPSBhX3F1ZXVlLnNoaWZ0KCk7XG5cdFx0XHRma193b3JrZXIoKTtcblx0XHR9XG5cdFx0Ly8gdGhlcmUgaXMgYSB3YWl0IGxpc3Rcblx0XHRlbHNlIGlmICh0aGlzLndhaXRfbGlzdC5sZW5ndGgpIHtcblx0XHRcdC8vIHRvcCBvZiBxdWV1ZVxuXHRcdFx0bGV0IGhfcGF0aWVudCA9IHRoaXMud2FpdF9saXN0WzBdO1xuXG5cdFx0XHQvLyBhc3NpZ24gd29ya2VyIG5leHQgdGFza1xuXHRcdFx0aF9wYXRpZW50LmVhY2goa193b3JrZXIpO1xuXG5cdFx0XHQvLyB0aGlzIHBhdGllbnQgaXMgc2F0aXNmaWVkOyBmaWZvIHBvcFxuXHRcdFx0aWYgKDAgPT09IC0taF9wYXRpZW50LnRhc2tzX3JlbWFpbmluZykgdGhpcy53YWl0X2xpc3Quc2hpZnQoKTtcblx0XHR9XG5cdFx0Ly8gb3RoZXJ3aXNlLCBmcmVlIHdvcmtlclxuXHRcdGVsc2Uge1xuXHRcdFx0a193b3JrZXIuYXZhaWxhYmxlID0gdHJ1ZTtcblx0XHR9XG5cdH1cblxuXHRraWxsKHNfa2lsbCkge1xuXHRcdHJldHVybiBQcm9taXNlLmFsbCh0aGlzLndvcmtlcnMubWFwKChrX3dvcmtlcikgPT4ga193b3JrZXIua2lsbChzX2tpbGwpKSk7XG5cdH1cbn1cblxuXG5jbGFzcyBhcm1lZF9ncm91cCB7XG5cdGNvbnN0cnVjdG9yKGtfZ3JvdXAsIGFfc3Vic2V0cykge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0Z3JvdXA6IGtfZ3JvdXAsXG5cdFx0XHRzdWJzZXRzOiBhX3N1YnNldHMsXG5cdFx0fSk7XG5cdH1cblxuXHRtYXAoc190YXNrLCB6X2FyZ3MgPSBbXSwgaF9ldmVudHNfbWFwID0ge30pIHtcblx0XHRsZXQge1xuXHRcdFx0Z3JvdXA6IGtfZ3JvdXAsXG5cdFx0XHRzdWJzZXRzOiBhX3N1YnNldHMsXG5cdFx0fSA9IHRoaXM7XG5cblx0XHQvLyBob3cgbWFueSBzdWJzZXRzIHRvIHByb2Nlc3Ncblx0XHRsZXQgbmxfc3Vic2V0cyA9IGFfc3Vic2V0cy5sZW5ndGg7XG5cblx0XHQvLyBwcmVwYXJlIHRvIGRlYWwgd2l0aCByZXN1bHRzXG5cdFx0bGV0IGtfYWN0aW9uID0gbmV3IGFjdGl2ZV9ncm91cChrX2dyb3VwLCBubF9zdWJzZXRzKTtcblxuXHRcdC8vIGNyZWF0ZSBtYW5pZmVzdCBvYmplY3Rcblx0XHRsZXQga19tYW5pZmVzdCA9IG1hbmlmZXN0LmZyb20oel9hcmdzKTtcblxuXHRcdC8vIHN1bW1vbiB3b3JrZXJzIGFzIHRoZXkgYmVjb21lIGF2YWlsYWJsZVxuXHRcdGtfZ3JvdXAuc3VtbW9uX3dvcmtlcnMobmxfc3Vic2V0cywgKGtfd29ya2VyLCBpX3N1YnNldCkgPT4ge1xuXHRcdFx0Ly8gaWYoaF9kaXNwYXRjaC5kZWJ1ZykgZGVidWdnZXI7XG5cblx0XHRcdC8vIHJlc3VsdCBoYW5kbGVyIHdhcyBub3QgdXNlZDsgYXV0by1lbmQgaXRcblx0XHRcdGlmICgha19hY3Rpb24ucGlwZWQpIGtfYWN0aW9uLmVuZCgpO1xuXG5cdFx0XHQvLyBtYWtlIHJlc3VsdCBoYW5kbGVyXG5cdFx0XHRsZXQgZmtfcmVzdWx0ID0ga19hY3Rpb24ubWtfcmVzdWx0KGtfd29ya2VyLCBpX3N1YnNldCk7XG5cblx0XHRcdC8vIG1ha2Ugd29ya2VyLXNwZWNpZmljIGV2ZW50c1xuXHRcdFx0bGV0IGhfZXZlbnRzX3dvcmtlciA9IHRoaXMuZXZlbnRfcm91dGVyKGhfZXZlbnRzX21hcCwgaV9zdWJzZXQpO1xuXG5cdFx0XHQvLyBwdXNoIHN1YnNldCB0byBmcm9udCBvZiBhcmdzXG5cdFx0XHRsZXQga19tYW5pZmVzdF93b3JrZXIgPSBrX21hbmlmZXN0LnByZXBlbmQoYV9zdWJzZXRzW2lfc3Vic2V0XSk7XG5cblx0XHRcdC8vIGV4ZWN1dGUgd29ya2VyIG9uIG5leHQgcGFydCBvZiBkYXRhXG5cdFx0XHRrX3dvcmtlci5leGVjKHtcblx0XHRcdFx0dGFzazogc190YXNrLFxuXHRcdFx0XHRtYW5pZmVzdDoga19tYW5pZmVzdF93b3JrZXIsXG5cdFx0XHRcdGhvbGQ6IGtfYWN0aW9uLnVwc3RyZWFtX2hvbGQsXG5cdFx0XHRcdGV2ZW50czogaF9ldmVudHNfd29ya2VyLFxuXHRcdFx0fSwgZmtfcmVzdWx0KTtcblx0XHR9KTtcblxuXHRcdC8vIGxldCB1c2VyIGJpbmQgYSBoYW5kbGVyXG5cdFx0cmV0dXJuIGtfYWN0aW9uO1xuXHR9XG5cblx0ZXZlbnRfcm91dGVyKGhfZXZlbnRzLCBpX3N1YnNldCkge1xuXHRcdGlmICghaF9ldmVudHMpIHJldHVybiBudWxsO1xuXG5cdFx0Ly8gbWFrZSBhIG5ldyBoYXNoIHRoYXQgcHVzaGVzIHdvcmtlciBpbmRleCBpbiBmcm9udCBvZiBjYWxsYmFjayBhcmdzXG5cdFx0bGV0IGhfZXZlbnRzX2xvY2FsID0ge307XG5cdFx0Zm9yIChsZXQgc19ldmVudCBpbiBoX2V2ZW50cykge1xuXHRcdFx0bGV0IGZfZXZlbnQgPSBoX2V2ZW50c1tzX2V2ZW50XTtcblx0XHRcdGhfZXZlbnRzX2xvY2FsW3NfZXZlbnRdID0gKC4uLmFfYXJncykgPT4ge1xuXHRcdFx0XHRmX2V2ZW50KGlfc3Vic2V0LCAuLi5hX2FyZ3MpO1xuXHRcdFx0fTtcblx0XHR9XG5cblx0XHRyZXR1cm4gaF9ldmVudHNfbG9jYWw7XG5cdH1cbn1cblxuXG5jbGFzcyBhY3RpdmVfZ3JvdXAge1xuXHRjb25zdHJ1Y3RvcihrX2dyb3VwLCBuX3Rhc2tzLCBmX3B1c2ggPSBudWxsKSB7XG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRncm91cDoga19ncm91cCxcblx0XHRcdHRhc2tfY291bnQ6IG5fdGFza3MsXG5cblx0XHRcdC8vIHdoZXRoZXIgb3Igbm90IHRoZSB1c2VyIGhhcyByb3V0ZWQgdGhpcyBzdHJlYW0geWV0XG5cdFx0XHRwaXBlZDogZmFsc2UsXG5cblx0XHRcdC8vIGxpbmsgdG8gbmV4dCBhY3Rpb24gZG93bnN0cmVhbVxuXHRcdFx0ZG93bnN0cmVhbTogbnVsbCxcblxuXHRcdFx0Ly8gd2hldGhlciBvciBub3QgdGhlIGFjdGlvbiB1cHN0cmVhbSBzaG91bGQgaG9sZCBkYXRhIGluIHdvcmtlclxuXHRcdFx0dXBzdHJlYW1faG9sZDogZmFsc2UsXG5cblx0XHRcdHJlc3VsdF9jb3VudDogMCxcblxuXHRcdFx0cmVzdWx0X2NhbGxiYWNrOiBudWxsLFxuXHRcdFx0Y29tcGxldGVfY2FsbGJhY2s6IG51bGwsXG5cblx0XHRcdHB1c2g6IGZfcHVzaCB8fCAoKCkgPT4ge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYGNhbm5vdCAnLnB1c2goKScgaGVyZWApO1xuXHRcdFx0fSksXG5cdFx0XHRjYXJyeTogbnVsbCxcblxuXHRcdFx0cmVkdWN0aW9uczogbnVsbCxcblx0XHRcdHJlZHVjZV90YXNrOiBudWxsLFxuXG5cdFx0XHRyZXN1bHRzOiBudWxsLFxuXHRcdFx0c2VxdWVuY2VfaW5kZXg6IDAsXG5cdFx0fSk7XG5cdH1cblxuXHR0aHJ1KHNfdGFzaywgel9hcmdzID0gW10sIGhfZXZlbnRzID0gbnVsbCkge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0cGlwZWQ6IHRydWUsXG5cdFx0XHRyb3V0ZTogdGhpcy5yb3V0ZV90aHJ1LFxuXHRcdFx0dXBzdHJlYW1faG9sZDogdHJ1ZSxcblx0XHRcdG5leHRfdGFzazoge1xuXHRcdFx0XHR0YXNrOiBzX3Rhc2ssXG5cdFx0XHRcdG1hbmlmZXN0OiBtYW5pZmVzdC5mcm9tKHpfYXJncyksXG5cdFx0XHRcdGV2ZW50czogaF9ldmVudHMsXG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0cmV0dXJuIHRoaXMuY29tcGxldGFibGUoKTtcblx0fVxuXG5cdGVhY2goZmtfcmVzdWx0LCBma19jb21wbGV0ZSA9IG51bGwpIHtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdHBpcGVkOiB0cnVlLFxuXHRcdFx0cm91dGU6IHRoaXMucm91dGVfZWFjaCxcblx0XHRcdHJlc3VsdF9jYWxsYmFjazogZmtfcmVzdWx0LFxuXHRcdFx0Y29tcGxldGVfY2FsbGJhY2s6IGZrX2NvbXBsZXRlLFxuXHRcdH0pO1xuXG5cdFx0cmV0dXJuIHRoaXMuY29tcGxldGFibGUoKTtcblx0fVxuXG5cdHNlcmllcyhma19yZXN1bHQsIGZrX2NvbXBsZXRlID0gbnVsbCkge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0cGlwZWQ6IHRydWUsXG5cdFx0XHRyb3V0ZTogdGhpcy5yb3V0ZV9zZXJpZXMsXG5cdFx0XHRyZXN1bHRfY2FsbGJhY2s6IGZrX3Jlc3VsdCxcblx0XHRcdGNvbXBsZXRlX2NhbGxiYWNrOiBma19jb21wbGV0ZSxcblx0XHRcdHJlc3VsdHM6IG5ldyBBcnJheSh0aGlzLnRhc2tfY291bnQpLFxuXHRcdH0pO1xuXG5cdFx0cmV0dXJuIHRoaXMuY29tcGxldGFibGUoKTtcblx0fVxuXG5cdHJlZHVjZShzX3Rhc2ssIHpfYXJncyA9IFtdLCBoX2V2ZW50cyA9IG51bGwpIHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSkgPT4ge1xuXHRcdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRcdHBpcGVkOiB0cnVlLFxuXHRcdFx0XHRyb3V0ZTogdGhpcy5yb3V0ZV9yZWR1Y2UsXG5cdFx0XHRcdGNvbXBsZXRlX2NhbGxiYWNrOiBmX3Jlc29sdmUsXG5cdFx0XHRcdHVwc3RyZWFtX2hvbGQ6IHRoaXMudGFza19jb3VudCA+IDEsIC8vIHNldCBgaG9sZGAgZmxhZyBmb3IgdXBzdHJlYW0gc2VuZGluZyBpdHMgdGFza1xuXHRcdFx0XHRyZWR1Y3Rpb25zOiBuZXcgY29udmVyZ2VudF9wYWlyd2lzZV90cmVlKHRoaXMudGFza19jb3VudCksXG5cdFx0XHRcdHJlZHVjZV90YXNrOiB7XG5cdFx0XHRcdFx0dGFzazogc190YXNrLFxuXHRcdFx0XHRcdG1hbmlmZXN0OiBuZXcgbWFuaWZlc3Qoel9hcmdzKSxcblx0XHRcdFx0XHRldmVudHM6IGhfZXZlbnRzLFxuXHRcdFx0XHRcdGhvbGQ6IHRydWUsIC8vIGFzc3VtZSBhbm90aGVyIHJlZHVjdGlvbiB3aWxsIGJlIHBlcmZvcm1lZCBieSBkZWZhdWx0XG5cdFx0XHRcdH0sXG5cdFx0XHR9KTtcblx0XHR9KTtcblx0fVxuXG5cdC8vIHJlc3VsdHMgbm90IGhhbmRsZWRcblx0cm91dGUoKSB7XG5cdFx0Y29uc29sZS53YXJuKCdyZXN1bHQgZnJvbSB3b3JrZXIgd2FzIG5vdCBoYW5kbGVkISBtYWtlIHN1cmUgdG8gYmluZCBhIGhhbmRsZXIgYmVmb3JlIGdvaW5nIGFzeW5jLiB1c2UgYC5pZ25vcmUoKWAgaWYgeW91IGRvIG5vdCBjYXJlIGFib3V0IHRoZSByZXN1bHQnKTtcblx0fVxuXG5cdHJvdXRlX3RocnUoaHBfbm90aWZpY2F0aW9uLCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzaykge1xuXHRcdC8vIGNyZWF0ZSBzcGVjaWZpYyB0YXNrIGZvciB3b3JrZXIgdG8gcmVjZWl2ZSBkYXRhIGZyb20gaXRzIHByZXZpb3VzIHRhc2tcblx0XHRsZXQgaF90YXNrID0gT2JqZWN0LmFzc2lnbih7XG5cdFx0XHRyZWNlaXZlOiBpX3Rhc2ssXG5cdFx0XHRob2xkOiB0aGlzLmRvd25zdHJlYW0udXBzdHJlYW1faG9sZCxcblx0XHR9LCB0aGlzLm5leHRfdGFzayk7XG5cblx0XHQvLyBhc3NpZ24gd29ya2VyIG5ldyB0YXNrXG5cdFx0dGhpcy5ncm91cC5hc3NpZ25fd29ya2VyKGtfd29ya2VyLCBoX3Rhc2ssICguLi5hX2FyZ3MpID0+IHtcblx0XHRcdC8vIG1rIHJlc3VsdFxuXHRcdFx0bGV0IGZfcmVzdWx0ID0gdGhpcy5kb3duc3RyZWFtLm1rX3Jlc3VsdChrX3dvcmtlciwgaV9zdWJzZXQpO1xuXG5cdFx0XHQvLyB0cmlnZ2VyIHJlc3VsdFxuXHRcdFx0Zl9yZXN1bHQoLi4uYV9hcmdzKTtcblx0XHR9KTtcblx0fVxuXG5cdC8vIHJldHVybiByZXN1bHRzIGltbWVkaWF0ZWx5XG5cdHJvdXRlX2VhY2goel9yZXN1bHQsIGlfc3Vic2V0LCBrX3dvcmtlciwgaV90YXNrKSB7XG5cdFx0dGhpcy5oYW5kbGVfcmVzdWx0X2NhbGxiYWNrKHpfcmVzdWx0LCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzayk7XG5cblx0XHQvLyB0aGlzIHdhcyB0aGUgbGFzdCByZXN1bHRcblx0XHRpZiAoKyt0aGlzLnJlc3VsdF9jb3VudCA9PT0gdGhpcy50YXNrX2NvdW50ICYmICdmdW5jdGlvbicgPT09IHR5cGVvZiB0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKSB7XG5cdFx0XHR0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKCk7XG5cdFx0fVxuXHR9XG5cblx0cm91dGVfc2VyaWVzKHpfcmVzdWx0LCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzaykge1xuXHRcdGxldCB7XG5cdFx0XHR0YXNrX2NvdW50OiBuX3Rhc2tzLFxuXHRcdFx0cmVzdWx0X2NhbGxiYWNrOiBma19yZXN1bHQsXG5cdFx0XHRzZXF1ZW5jZV9pbmRleDogaV9zZXF1ZW5jZSxcblx0XHRcdHJlc3VsdHM6IGFfcmVzdWx0cyxcblx0XHR9ID0gdGhpcztcblxuXHRcdC8vIHJlc3VsdCBhcnJpdmVkIHdoaWxlIHdlIHdlcmUgd2FpdGluZyBmb3IgaXRcblx0XHRpZiAoaV9zdWJzZXQgPT09IGlfc2VxdWVuY2UpIHtcblx0XHRcdC8vIHdoaWxlIHRoZXJlIGFyZSByZXN1bHRzIHRvIHByb2Nlc3Ncblx0XHRcdGZvciAoOzspIHtcblx0XHRcdFx0Ly8gcHJvY2VzcyByZXN1bHRcblx0XHRcdFx0dGhpcy5oYW5kbGVfcmVzdWx0X2NhbGxiYWNrKHpfcmVzdWx0LCBpX3NlcXVlbmNlLCBrX3dvcmtlciwgaV90YXNrKTtcblxuXHRcdFx0XHQvLyByZWFjaGVkIGVuZCBvZiBzZXF1ZW5jZTsgdGhhdCB3YXMgbGFzdCByZXN1bHRcblx0XHRcdFx0aWYgKCsraV9zZXF1ZW5jZSA9PT0gbl90YXNrcykge1xuXHRcdFx0XHRcdC8vIGNvbXBsZXRpb24gY2FsbGJhY2tcblx0XHRcdFx0XHRpZiAoJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIHRoaXMuY29tcGxldGVfY2FsbGJhY2spIHtcblx0XHRcdFx0XHRcdHRoaXMuY29tcGxldGVfY2FsbGJhY2soKTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHQvLyBleGl0IGxvb3AgYW5kIHNhdmUgc2VxdWVuY2UgaW5kZXhcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIG5leHQgcmVzdWx0IG5vdCB5ZXQgcmVhZHlcblx0XHRcdFx0bGV0IGhfbmV4dF9yZXN1bHQgPSBhX3Jlc3VsdHNbaV9zZXF1ZW5jZV07XG5cdFx0XHRcdGlmICghaF9uZXh0X3Jlc3VsdCkgYnJlYWs7XG5cblx0XHRcdFx0Ly8gZWxzZTsgb250byBuZXh0IHJlc3VsdFxuXHRcdFx0XHR6X3Jlc3VsdCA9IGhfbmV4dF9yZXN1bHQ7XG5cblx0XHRcdFx0Ly8gcmVsZWFzZSB0byBnY1xuXHRcdFx0XHRhX3Jlc3VsdHNbaV9zZXF1ZW5jZV0gPSBudWxsO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBub3QgeWV0IHJlYWR5IHRvIHByb2Nlc3MgdGhpcyByZXN1bHRcblx0XHRlbHNlIHtcblx0XHRcdC8vIHN0b3JlIGl0IGZvciBub3dcblx0XHRcdGFfcmVzdWx0c1tpX3N1YnNldF0gPSB6X3Jlc3VsdDtcblx0XHR9XG5cblx0XHQvLyB1cGRhdGUgc2VxdWVuY2UgaW5kZXhcblx0XHR0aGlzLnNlcXVlbmNlX2luZGV4ID0gaV9zZXF1ZW5jZTtcblx0fVxuXG5cdHJvdXRlX3JlZHVjZShocF9ub3RpZmljYXRpb24sIGlfc3Vic2V0LCBrX3dvcmtlciwgaV90YXNrKSB7XG5cdFx0Ly8gZGVidWdnZXI7XG5cblx0XHQvLyBub2RlIGluaXRpYXRpb25cblx0XHRsZXQgaF9jYW5vcHlfbm9kZSA9IHRoaXMucmVkdWN0aW9ucy5yYXkoaV9zdWJzZXQsIHtcblx0XHRcdHdvcmtlcjoga193b3JrZXIsXG5cdFx0XHR0YXNrX2lkOiBpX3Rhc2ssXG5cdFx0fSk7XG5cblx0XHQvLyBzdGFydCBhdCBjYW5vcHkgbm9kZVxuXHRcdHRoaXMucmVkdWNlX3Jlc3VsdChocF9ub3RpZmljYXRpb24sIGhfY2Fub3B5X25vZGUpO1xuXHR9XG5cblx0Ly8gZWFjaCB0aW1lIGEgd29ya2VyIGNvbXBsZXRlc1xuXHRyZWR1Y2VfcmVzdWx0KHpfcmVzdWx0LCBoX25vZGUpIHtcblx0XHRsZXQge1xuXHRcdFx0Z3JvdXA6IGtfZ3JvdXAsXG5cdFx0XHRyZWR1Y3Rpb25zOiBrX3BhaXJ3aXNlX3RyZWUsXG5cdFx0XHRyZWR1Y2VfdGFzazogaF90YXNrX3JlYWR5LFxuXHRcdH0gPSB0aGlzO1xuXG5cdFx0Ly8gZmluYWwgcmVzdWx0XG5cdFx0aWYgKEhQX1dPUktFUl9OT1RJRklDQVRJT04gIT09IHpfcmVzdWx0KSB7XG5cdFx0XHRsZXQgel9jb21wbGV0aW9uID0gdGhpcy5jb21wbGV0ZV9jYWxsYmFjayh6X3Jlc3VsdCk7XG5cblx0XHRcdC8vIGFkZCB0byBvdXRlciBzdHJlYW1cblx0XHRcdGlmICh6X2NvbXBsZXRpb24gaW5zdGFuY2VvZiBhY3RpdmVfZ3JvdXApIHtcblx0XHRcdFx0bGV0IGtfbGFrZSA9IHRoaXMubGFrZSgpO1xuXHRcdFx0XHRsZXQgZmtfbGFrZSA9IGtfbGFrZS5jb21wbGV0ZV9jYWxsYmFjaztcblx0XHRcdFx0bGV0IGhwX2xvY2sgPSBTeW1ib2woJ2tleScpO1xuXG5cdFx0XHRcdHpfY29tcGxldGlvbi5lbmQoKCkgPT4ge1xuXHRcdFx0XHRcdGtfZ3JvdXAudW5sb2NrKGhwX2xvY2spO1xuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHQvLyByZXdyYXAgY29tcGxldGlvbiBjYWxsYmFjayBmdW5jdGlvblxuXHRcdFx0XHRrX2xha2UuY29tcGxldGVfY2FsbGJhY2sgPSAoKSA9PiB7XG5cdFx0XHRcdFx0a19ncm91cC53YWl0KGhwX2xvY2ssICgpID0+IHtcblx0XHRcdFx0XHRcdGZrX2xha2UoKTtcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gbm90aWZpY2F0aW9uXG5cdFx0ZWxzZSB7XG5cdFx0XHQvLyBhYmxlIHRvIHBlcmZvcm0gYSByZWR1Y3Rpb25cblx0XHRcdGxldCBoX21lcmdlID0ga19wYWlyd2lzZV90cmVlLmNvbW1pdChoX25vZGUpO1xuXHRcdFx0aWYgKGhfbWVyZ2UpIHtcblx0XHRcdFx0bGV0IGtfd29ya2VyID0gaF9ub2RlLml0ZW0ud29ya2VyO1xuXG5cdFx0XHRcdC8vIHRoaXMgcmVkdWN0aW9uIHdpbGwgYmUgdGhlIGxhc3Qgb25lOyBkbyBub3QgaG9sZCByZXN1bHRcblx0XHRcdFx0aWYgKGhfbWVyZ2UubWFrZXNfcm9vdCkge1xuXHRcdFx0XHRcdGhfdGFza19yZWFkeSA9IE9iamVjdC5hc3NpZ24oe30sIGhfdGFza19yZWFkeSk7XG5cdFx0XHRcdFx0aF90YXNrX3JlYWR5LmhvbGQgPSBmYWxzZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIGFmdGVyIHJlZHVjdGlvbjtcblx0XHRcdFx0bGV0IGZrX3JlZHVjdGlvbiA9ICh6X3Jlc3VsdF9yZWR1Y3Rpb24sIGlfdGFza19yZWR1Y3Rpb24sIGtfd29ya2VyX3JlZHVjdGlvbikgPT4ge1xuXHRcdFx0XHRcdC8vIHJlY3Vyc2Ugb24gcmVkdWN0aW9uOyB1cGRhdGUgc2VuZGVyIGZvciBjYWxsYmFjayBzY29wZVxuXHRcdFx0XHRcdHRoaXMucmVkdWNlX3Jlc3VsdCh6X3Jlc3VsdF9yZWR1Y3Rpb24sIE9iamVjdC5hc3NpZ24oaF9tZXJnZS5ub2RlLCB7XG5cdFx0XHRcdFx0XHRpdGVtOiB7XG5cdFx0XHRcdFx0XHRcdHdvcmtlcjoga193b3JrZXJfcmVkdWN0aW9uLFxuXHRcdFx0XHRcdFx0XHR0YXNrX2lkOiBpX3Rhc2tfcmVkdWN0aW9uLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHR9KSk7XG5cdFx0XHRcdH07XG5cblx0XHRcdFx0Ly8gZ2l2ZSByZWR1Y3Rpb24gdGFzayB0byB3b3JrZXIgdGhhdCBmaW5pc2hlZCBlYXJsaWVyOyBwYXNzIHRvIHRoZSByaWdodFxuXHRcdFx0XHRpZiAoa193b3JrZXIgPT09IGhfbWVyZ2UubGVmdC53b3JrZXIpIHtcblx0XHRcdFx0XHRrX2dyb3VwLnJlbGF5KHtcblx0XHRcdFx0XHRcdHNlbmRlcjogaF9ub2RlLml0ZW0sXG5cdFx0XHRcdFx0XHRyZWNlaXZlcjogaF9tZXJnZS5yaWdodCxcblx0XHRcdFx0XHRcdHJlY2VpdmVyX3ByaW1hcnk6IGZhbHNlLFxuXHRcdFx0XHRcdFx0dGFza19yZWFkeTogaF90YXNrX3JlYWR5LFxuXHRcdFx0XHRcdH0sIGZrX3JlZHVjdGlvbik7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gcGFzcyB0byB0aGUgbGVmdFxuXHRcdFx0XHRlbHNlIHtcblx0XHRcdFx0XHRrX2dyb3VwLnJlbGF5KHtcblx0XHRcdFx0XHRcdHNlbmRlcjogaF9ub2RlLml0ZW0sXG5cdFx0XHRcdFx0XHRyZWNlaXZlcjogaF9tZXJnZS5sZWZ0LFxuXHRcdFx0XHRcdFx0cmVjZWl2ZXJfcHJpbWFyeTogdHJ1ZSxcblx0XHRcdFx0XHRcdHRhc2tfcmVhZHk6IGhfdGFza19yZWFkeSxcblx0XHRcdFx0XHR9LCBma19yZWR1Y3Rpb24pO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0cm91dGVfZW5kKCkge1xuXHRcdC8vIHRoaXMgd2FzIHRoZSBsYXN0IHJlc3VsdFxuXHRcdGlmICgrK3RoaXMucmVzdWx0X2NvdW50ID09PSB0aGlzLnRhc2tfY291bnQgJiYgJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIHRoaXMuY29tcGxldGVfY2FsbGJhY2spIHtcblx0XHRcdHRoaXMuY29tcGxldGVfY2FsbGJhY2soKTtcblx0XHR9XG5cdH1cblxuXHRjb21wbGV0YWJsZSgpIHtcblx0XHRsZXQgZmtfY29tcGxldGUgPSB0aGlzLmNvbXBsZXRlX2NhbGxiYWNrO1xuXG5cdFx0Ly8gbm90aGluZyB0byByZWR1Y2U7IGNvbXBsZXRlIGFmdGVyIGVzdGFibGlzaGluZyBkb3duc3RyZWFtXG5cdFx0aWYgKCF0aGlzLnRhc2tfY291bnQgJiYgJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIGZrX2NvbXBsZXRlKSB7XG5cdFx0XHRzZXRUaW1lb3V0KGZrX2NvbXBsZXRlLCAwKTtcblx0XHR9XG5cblx0XHRyZXR1cm4gdGhpcy5kb3duc3RyZWFtID0gbmV3IGFjdGl2ZV9ncm91cCh0aGlzLmdyb3VwLCB0aGlzLnRhc2tfY291bnQsIHRoaXMucHVzaCk7XG5cdH1cblxuXHRoYW5kbGVfcmVzdWx0X2NhbGxiYWNrKHpfcmVzdWx0LCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzaykge1xuXHRcdGxldCBrX2Rvd25zdHJlYW0gPSB0aGlzLmRvd25zdHJlYW07XG5cblx0XHQvLyBhcHBseSBjYWxsYmFjayBhbmQgY2FwdHVyZSByZXR1cm5cblx0XHRsZXQgel9yZXR1cm4gPSB0aGlzLnJlc3VsdF9jYWxsYmFjayh6X3Jlc3VsdCwgaV9zdWJzZXQpO1xuXG5cdFx0Ly8gZG93bnN0cmVhbSBpcyBleHBlY3RpbmcgZGF0YSBmb3IgbmV4dCB0YXNrXG5cdFx0aWYgKGtfZG93bnN0cmVhbSAmJiBrX2Rvd25zdHJlYW0ucGlwZWQpIHtcblx0XHRcdC8vIG5vdGhpbmcgd2FzIHJldHVybmVkOyByZXVzZSBpbnB1dCBkYXRhXG5cdFx0XHRpZiAodW5kZWZpbmVkID09PSB6X3JldHVybikge1xuXHRcdFx0XHQvLyBkb3duc3RyZWFtIGFjdGlvbiB3YXMgZXhwZWN0aW5nIHdvcmtlciB0byBob2xkIGRhdGFcblx0XHRcdFx0aWYgKGtfZG93bnN0cmVhbS51cHN0cmVhbV9ob2xkKSB7XG5cdFx0XHRcdFx0dGhyb3cgJ25vdCB5ZXQgaW1wbGVtZW50ZWQnO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGtfZG93bnN0cmVhbS5yb3V0ZSh6X3Jlc3VsdCwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHQvLyByZXR1cm5lZCBwcm9taXNlXG5cdFx0XHRlbHNlIGlmICh6X3JldHVybiBpbnN0YW5jZW9mIFByb21pc2UpIHtcblx0XHRcdFx0el9yZXR1cm5cblx0XHRcdFx0XHQvLyBhd2FpdCBwcm9taXNlIHJlc29sdmVcblx0XHRcdFx0XHQudGhlbigoel9jYXJyeSkgPT4ge1xuXHRcdFx0XHRcdFx0a19kb3duc3RyZWFtLnJvdXRlKHpfY2FycnksIGlfc3Vic2V0LCBrX3dvcmtlciwgaV90YXNrKTtcblx0XHRcdFx0XHR9KVxuXHRcdFx0XHRcdC8vIGNhdGNoIHByb21pc2UgcmVqZWN0XG5cdFx0XHRcdFx0LmNhdGNoKChlX3JlamVjdCkgPT4ge1xuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCd1bmNhdWdodCByZWplY3Rpb24nKTtcblx0XHRcdFx0XHR9KTtcblx0XHRcdH1cblx0XHRcdC8vIHJldHVybmVkIGVycm9yXG5cdFx0XHRlbHNlIGlmICh6X3JldHVybiBpbnN0YW5jZW9mIEVycm9yKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcignbm90IHlldCBpbXBsZW1lbnRlZCcpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gcmV0dXJuZWQgaW1tZWRpYXRlbHlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHRrX2Rvd25zdHJlYW0ucm91dGUoel9yZXR1cm4sIGlfc3Vic2V0LCBrX3dvcmtlciwgaV90YXNrKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gc29tZXRoaW5nIHdhcyByZXR1cm5lZCB0aG91Z2hcblx0XHRlbHNlIGlmICh1bmRlZmluZWQgIT09IHpfcmV0dXJuKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oJ2EgdGFzayBzdHJlYW0gaGFuZGxlciByZXR1cm4gc29tZSB2YWx1ZSBidXQgaXQgY2Fubm90IGJlIGNhcnJpZWQgYmVjYXVzZSBkb3duc3RyZWFtIGlzIG5vdCBleHBlY3RpbmcgdGFzayBkYXRhJyk7XG5cdFx0XHRkZWJ1Z2dlcjtcblx0XHR9XG5cdH1cblxuXHRlbmQoZmtfY29tcGxldGUgPSBudWxsKSB7XG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRwaXBlZDogdHJ1ZSxcblx0XHRcdHJvdXRlOiB0aGlzLnJvdXRlX2VuZCxcblx0XHRcdGNvbXBsZXRlX2NhbGxiYWNrOiBma19jb21wbGV0ZSxcblx0XHR9KTtcblx0fVxuXG5cblx0bWtfcmVzdWx0KGtfd29ya2VyLCBpX3N1YnNldCkge1xuXHRcdC8vIGZvciB3aGVuIGEgcmVzdWx0IGFycml2ZXNcblx0XHRyZXR1cm4gKHpfcmVzdWx0LCBpX3Rhc2spID0+IHtcblx0XHRcdC8vIHRoaXMgd29ya2VyIGp1c3QgbWFkZSBpdHNlbGYgYXZhaWxhYmxlXG5cdFx0XHR0aGlzLmdyb3VwLndvcmtlcl9hdmFpbGFibGUoa193b3JrZXIpO1xuXG5cdFx0XHQvLyByb3V0ZSB0aGUgcmVzdWx0XG5cdFx0XHR0aGlzLnJvdXRlKHpfcmVzdWx0LCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzayk7XG5cdFx0fTtcblx0fVxuXG5cdC8vIHRyYXZlcnNlIGFsbCB0aGUgd2F5IGRvd25zdHJlYW1cblx0bGFrZSgpIHtcblx0XHRsZXQga19kb3duc3RyZWFtID0gdGhpcztcblx0XHRmb3IgKDs7KSB7XG5cdFx0XHRpZiAoa19kb3duc3RyZWFtLmRvd25zdHJlYW0pIGtfZG93bnN0cmVhbSA9IGtfZG93bnN0cmVhbS5kb3duc3RyZWFtO1xuXHRcdFx0ZWxzZSBicmVhaztcblx0XHR9XG5cdFx0cmV0dXJuIGtfZG93bnN0cmVhbTtcblx0fVxufVxuXG5cbmZ1bmN0aW9uIGRpdmlkZShhX3RoaW5ncywgbl93b3JrZXJzLCB4bV9zdHJhdGVneSwgaF9kaXZpZGUgPSB7fSkge1xuXHRsZXQgbmxfdGhpbmdzID0gYV90aGluZ3MubGVuZ3RoO1xuXG5cdGxldCB7XG5cdFx0aXRlbV9jb3VudDogY19pdGVtc19yZW1haW4gPSBubF90aGluZ3MsXG5cdFx0b3BlbjogZl9vcGVuID0gbnVsbCxcblx0XHRzZWFsOiBmX3NlYWwgPSBudWxsLFxuXHRcdHF1YW50aWZ5OiBmX3F1YW50aWZ5ID0gKCkgPT4ge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBtdXN0IHByb3ZpZGUgZnVuY3Rpb24gZm9yIGtleSAncXVhbnRpZnknIHdoZW4gdXNpbmcgJy5iYWxhbmNlX29yZGVyZWRfZ3JvdXBzKCknYCk7XG5cdFx0fSxcblx0fSA9IGhfZGl2aWRlO1xuXG5cdGxldCBhX3Rhc2tzID0gW107XG5cblx0aWYgKEFycmF5LmlzQXJyYXkoYV90aGluZ3MpKSB7XG5cdFx0Ly8gZG8gbm90IGFzc2lnbiB3b3JrZXJzIHRvIG5vdGhpbmdcblx0XHRpZiAobmxfdGhpbmdzIDwgbl93b3JrZXJzKSBuX3dvcmtlcnMgPSBubF90aGluZ3M7XG5cblx0XHQvLyBpdGVtcyBwZXIgd29ya2VyXG5cdFx0bGV0IHhfaXRlbXNfcGVyX3dvcmtlciA9IE1hdGguZmxvb3IoY19pdGVtc19yZW1haW4gLyBuX3dvcmtlcnMpO1xuXG5cdFx0Ly8gZGlzdHJpYnV0ZSBpdGVtcyBlcXVhbGx5XG5cdFx0aWYgKFhNX1NUUkFURUdZX0VRVUFMID09PSB4bV9zdHJhdGVneSkge1xuXHRcdFx0Ly8gc3RhcnQgaW5kZXggb2Ygc2xpY2Vcblx0XHRcdGxldCBpX3N0YXJ0ID0gMDtcblxuXHRcdFx0Ly8gZWFjaCB3b3JrZXJcblx0XHRcdGZvciAobGV0IGlfd29ya2VyID0gMDsgaV93b3JrZXIgPCBuX3dvcmtlcnM7IGlfd29ya2VyKyspIHtcblx0XHRcdFx0Ly8gZmluZCBlbmQgaW5kZXggb2Ygd29ya2VyOyBlbnN1cmUgYWxsIGl0ZW1zIGZpbmQgYSB3b3JrZXJcblx0XHRcdFx0bGV0IGlfZW5kID0gKGlfd29ya2VyID09PSBuX3dvcmtlcnMgLSAxKSA/IG5sX3RoaW5ncyA6IGlfc3RhcnQgKyB4X2l0ZW1zX3Blcl93b3JrZXI7XG5cblx0XHRcdFx0Ly8gZXh0cmFjdCBzbGljZSBmcm9tIHRoaW5ncyBhbmQgcHVzaCB0byBkaXZpc2lvbnNcblx0XHRcdFx0YV90YXNrcy5wdXNoKGFfdGhpbmdzLnNsaWNlKGlfc3RhcnQsIGlfZW5kKSk7XG5cblx0XHRcdFx0Ly8gYWR2YW5jZSBpbmRleCBmb3IgbmV4dCBkaXZpc2lvblxuXHRcdFx0XHRpX3N0YXJ0ID0gaV9lbmQ7XG5cblx0XHRcdFx0Ly8gdXBkYXRlIG51bWJlciBvZiBpdGVtcyByZW1haW5pbmdcblx0XHRcdFx0Y19pdGVtc19yZW1haW4gLT0geF9pdGVtc19wZXJfd29ya2VyO1xuXG5cdFx0XHRcdC8vIHJlY2FsY3VsYXRlIHRhcmdldCBpdGVtcyBwZXIgd29ya2VyXG5cdFx0XHRcdHhfaXRlbXNfcGVyX3dvcmtlciA9IE1hdGguZmxvb3IoY19pdGVtc19yZW1haW4gLyAobl93b3JrZXJzIC0gaV93b3JrZXIgLSAxKSk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIG9yZGVyZWQgZ3JvdXBzXG5cdFx0ZWxzZSBpZiAoWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFMgJiB4bV9zdHJhdGVneSkge1xuXHRcdFx0bGV0IGlfd29ya2VyID0gMDtcblx0XHRcdGxldCBjX3dvcmtlcl9pdGVtcyA9IDA7XG5cblx0XHRcdC8vIG9wZW4gbmV3IHRhc2sgaXRlbSBsaXN0XG5cdFx0XHRsZXQgYV90YXNrX2l0ZW1zID0gW107XG5cdFx0XHRsZXQgel90YXNrX2RhdGEgPSBmX29wZW4gPyBmX29wZW4oYV90YXNrX2l0ZW1zKSA6IGFfdGFza19pdGVtcztcblxuXHRcdFx0Ly8gZWFjaCBncm91cFxuXHRcdFx0Zm9yIChsZXQgaV9ncm91cCA9IDA7IGlfZ3JvdXAgPCBubF90aGluZ3M7IGlfZ3JvdXArKykge1xuXHRcdFx0XHRsZXQgaF9ncm91cCA9IGFfdGhpbmdzW2lfZ3JvdXBdO1xuXHRcdFx0XHRsZXQgbl9ncm91cF9pdGVtcyA9IGZfcXVhbnRpZnkoaF9ncm91cCk7XG5cblx0XHRcdFx0Ly8gYWRkaW5nIHRoaXMgdG8gY3VycmVudCB3b3JrZXIgd291bGQgZXhjZWVkIHRhcmdldCBsb2FkIChtYWtlIHN1cmUgdGhpcyBpc24ndCBmaW5hbCB3b3JrZXIpXG5cdFx0XHRcdGxldCBuX3dvcmtlcl9pdGVtc19wcmV2aWV3ID0gbl9ncm91cF9pdGVtcyArIGNfd29ya2VyX2l0ZW1zO1xuXHRcdFx0XHRpZiAoKG5fd29ya2VyX2l0ZW1zX3ByZXZpZXcgPiB4X2l0ZW1zX3Blcl93b3JrZXIpICYmIGlfd29ya2VyIDwgbl93b3JrZXJzIC0gMSkge1xuXHRcdFx0XHRcdGxldCBiX2FkdmFuY2VfZ3JvdXAgPSBmYWxzZTtcblxuXHRcdFx0XHRcdC8vIGJhbGFuY2UgbW9kZVxuXHRcdFx0XHRcdGlmIChYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQU19CQUxBTkNFRCA9PT0geG1fc3RyYXRlZ3kpIHtcblx0XHRcdFx0XHRcdC8vIHByZXZpZXcgaXMgY2xvc2VyIHRvIHRhcmdldDsgYWRkIHRhc2sgaXRlbSB0byB3b3JrZXIgYmVmb3JlIGFkdmFuY2luZ1xuXHRcdFx0XHRcdFx0aWYgKChuX3dvcmtlcl9pdGVtc19wcmV2aWV3IC0geF9pdGVtc19wZXJfd29ya2VyKSA8ICh4X2l0ZW1zX3Blcl93b3JrZXIgLSBjX3dvcmtlcl9pdGVtcykpIHtcblx0XHRcdFx0XHRcdFx0YV90YXNrX2l0ZW1zLnB1c2goaF9ncm91cCk7XG5cdFx0XHRcdFx0XHRcdGNfd29ya2VyX2l0ZW1zID0gbl93b3JrZXJfaXRlbXNfcHJldmlldztcblxuXHRcdFx0XHRcdFx0XHQvLyBhZHZhbmNlIGdyb3VwIGFmdGVyIG5ldyB0YXNrXG5cdFx0XHRcdFx0XHRcdGJfYWR2YW5jZV9ncm91cCA9IHRydWU7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gYWRkIHRhc2sgaXRlbSB0byBvdXRwdXQgKHRyYW5zZm9ybWluZyBpdCB3aGVuIGFwcHJvcHJpYXRlKVxuXHRcdFx0XHRcdGFfdGFza3MucHVzaChmX3NlYWwgPyBmX3NlYWwoel90YXNrX2RhdGEpIDogel90YXNrX2RhdGEpO1xuXG5cdFx0XHRcdFx0Ly8gbmV4dCB0YXNrIGl0ZW0gbGlzdFxuXHRcdFx0XHRcdGFfdGFza19pdGVtcyA9IFtdO1xuXHRcdFx0XHRcdGNfaXRlbXNfcmVtYWluIC09IGNfd29ya2VyX2l0ZW1zO1xuXHRcdFx0XHRcdHhfaXRlbXNfcGVyX3dvcmtlciA9IGNfaXRlbXNfcmVtYWluIC8gKG5fd29ya2VycyAtICgrK2lfd29ya2VyKSk7XG5cdFx0XHRcdFx0Y193b3JrZXJfaXRlbXMgPSAwO1xuXG5cdFx0XHRcdFx0Ly8gdGFzayBpdGVtIG9wZW5cblx0XHRcdFx0XHR6X3Rhc2tfZGF0YSA9IGZfb3BlbiA/IGZfb3BlbihhX3Rhc2tfaXRlbXMpIDogYV90YXNrX2l0ZW1zO1xuXG5cdFx0XHRcdFx0Ly8gYWR2YW5jZSBncm91cFxuXHRcdFx0XHRcdGlmIChiX2FkdmFuY2VfZ3JvdXApIGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gYWRkIHRhc2sgdG8gbGlzdFxuXHRcdFx0XHRhX3Rhc2tfaXRlbXMucHVzaChoX2dyb3VwKTtcblx0XHRcdFx0Y193b3JrZXJfaXRlbXMgKz0gbl9ncm91cF9pdGVtcztcblx0XHRcdH1cblxuXHRcdFx0Ly8gYWRkIGZpbmFsIHRhc2sgaXRlbVxuXHRcdFx0YV90YXNrcy5wdXNoKGZfc2VhbCA/IGZfc2VhbCh6X3Rhc2tfZGF0YSkgOiB6X3Rhc2tfZGF0YSk7XG5cdFx0fVxuXHRcdC8vIHVua25vd24gc3RyYXRlZ3lcblx0XHRlbHNlIHtcblx0XHRcdHRocm93IG5ldyBSYW5nZUVycm9yKCdubyBzdWNoIHN0cmF0ZWd5Jyk7XG5cdFx0fVxuXHR9XG5cdC8vIHR5cGVkIGFycmF5XG5cdGVsc2UgaWYgKCdieXRlTGVuZ3RoJyBpbiBhX3RoaW5ncykge1xuXHRcdC8vIGRpdmlkZSBcblx0XHR0aHJvdyAnbm90IHlldCBpbXBsZW1lbnRlZCc7XG5cdH1cblx0Ly8gdW5zdXBwb3J0ZWQgdHlwZVxuXHRlbHNlIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ3dvcmtlciBjYW4gb25seSBkaXZpZGUgZGF0YSBpbiBhcnJheXMgKGVpdGhlciBwbGFpbiBvciB0eXBlZCknKTtcblx0fVxuXG5cdHJldHVybiBhX3Rhc2tzO1xufVxuXG5cbmNsYXNzIGNvbnZlcmdlbnRfcGFpcndpc2VfdHJlZSB7XG5cdGNvbnN0cnVjdG9yKG5faXRlbXMpIHtcblx0XHRsZXQgYV9jYW5vcHkgPSBbXTtcblx0XHRmb3IgKGxldCBpX2l0ZW0gPSAwOyBpX2l0ZW0gPCBuX2l0ZW1zOyBpX2l0ZW0rKykge1xuXHRcdFx0YV9jYW5vcHkucHVzaCh7XG5cdFx0XHRcdHJlYWR5OiBmYWxzZSxcblx0XHRcdFx0dXA6IG51bGwsXG5cdFx0XHRcdGl0ZW06IG51bGwsXG5cdFx0XHRcdGxlZnQ6IGlfaXRlbSAtIDEsXG5cdFx0XHRcdHJpZ2h0OiBpX2l0ZW0gKyAxLFxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRpdGVtX2NvdW50OiBuX2l0ZW1zLFxuXHRcdFx0Y2Fub3B5OiBhX2Nhbm9weSxcblx0XHR9KTtcblx0fVxuXG5cdHJheShpX2l0ZW0sIHpfaXRlbSkge1xuXHRcdGxldCBoX25vZGUgPSB0aGlzLmNhbm9weVtpX2l0ZW1dO1xuXHRcdGhfbm9kZS5pdGVtID0gel9pdGVtO1xuXHRcdHJldHVybiBoX25vZGU7XG5cdH1cblxuXHR0b3AoaF90b3ApIHtcblx0XHRmb3IgKDs7KSB7XG5cdFx0XHRsZXQgaF91cCA9IGhfdG9wLnVwO1xuXHRcdFx0aWYgKGhfdXApIGhfdG9wID0gaF91cDtcblx0XHRcdGVsc2UgYnJlYWs7XG5cdFx0fVxuXHRcdHJldHVybiBoX3RvcDtcblx0fVxuXG5cdG1lcmdlKGhfbGVmdCwgaF9yaWdodCkge1xuXHRcdGxldCBuX2l0ZW1zID0gdGhpcy5pdGVtX2NvdW50O1xuXG5cdFx0bGV0IGhfbm9kZSA9IHtcblx0XHRcdHJlYWR5OiBmYWxzZSxcblx0XHRcdHVwOiBudWxsLFxuXHRcdFx0aXRlbTogbnVsbCxcblx0XHRcdGxlZnQ6IGhfbGVmdC5sZWZ0LFxuXHRcdFx0cmlnaHQ6IGhfcmlnaHQucmlnaHQsXG5cdFx0fTtcblxuXHRcdGhfbGVmdC51cCA9IGhfcmlnaHQudXAgPSBoX25vZGU7XG5cblx0XHRyZXR1cm4ge1xuXHRcdFx0bm9kZTogaF9ub2RlLFxuXHRcdFx0bGVmdDogaF9sZWZ0Lml0ZW0sXG5cdFx0XHRyaWdodDogaF9yaWdodC5pdGVtLFxuXHRcdFx0bWFrZXNfcm9vdDogLTEgPT09IGhfbGVmdC5sZWZ0ICYmIG5faXRlbXMgPT09IGhfcmlnaHQucmlnaHQsXG5cdFx0fTtcblx0fVxuXG5cdGNvbW1pdChoX25vZGUpIHtcblx0XHRsZXQgbl9pdGVtcyA9IHRoaXMuaXRlbV9jb3VudDtcblx0XHRsZXQgYV9jYW5vcHkgPSB0aGlzLmNhbm9weTtcblxuXHRcdC8vIGxlZnQgZWRnZSBvZiBsaXN0XG5cdFx0aWYgKC0xID09PSBoX25vZGUubGVmdCkge1xuXHRcdFx0Ly8gdHJlZSByb290IHdhcyBoYW5kZWQgdG8gY29tbWl0XG5cdFx0XHRpZiAoaF9ub2RlLnJpZ2h0ID09PSBuX2l0ZW1zKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcignY2Fubm90IGNvbW1pdCByb290IScpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBuZWlnaGJvciBvbiByaWdodCBzaWRlXG5cdFx0XHRsZXQgaF9yaWdodCA9IHRoaXMudG9wKGFfY2Fub3B5W2hfbm9kZS5yaWdodF0pO1xuXG5cdFx0XHQvLyBuZWlnaGJvciBpcyByZWFkeSFcblx0XHRcdGlmIChoX3JpZ2h0LnJlYWR5KSB7XG5cdFx0XHRcdHJldHVybiB0aGlzLm1lcmdlKGhfbm9kZSwgaF9yaWdodCk7XG5cdFx0XHR9XG5cdFx0XHQvLyBuZWlnaGJvciBpcyBidXN5L25vdCByZWFkeTsgbWFyayB0aGlzIGl0ZW0gYXMgcmVhZHlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHRoX25vZGUucmVhZHkgPSB0cnVlO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyByaWdodCBlZGdlIG9mIGxpc3Rcblx0XHRlbHNlIGlmIChuX2l0ZW1zID09PSBoX25vZGUucmlnaHQpIHtcblx0XHRcdC8vIG5laWdoYm9yIG9uIGxlZnQgc2lkZVxuXHRcdFx0bGV0IGhfbGVmdCA9IHRoaXMudG9wKGFfY2Fub3B5W2hfbm9kZS5sZWZ0XSk7XG5cblx0XHRcdC8vIG5laWdoYm9yIGlzIHJlYWR5XG5cdFx0XHRpZiAoaF9sZWZ0LnJlYWR5KSB7XG5cdFx0XHRcdHJldHVybiB0aGlzLm1lcmdlKGhfbGVmdCwgaF9ub2RlKTtcblx0XHRcdH1cblx0XHRcdC8vIG5laWdoYm9yIGlzIGJ1c3kvbm90IHJlYWR5OyBtYXJrIHRoaXMgaXRlbSBhcyByZWFkeVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdGhfbm9kZS5yZWFkeSA9IHRydWU7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIHNvbWV3aGVyZSBpbiB0aGUgbWlkZGxlXG5cdFx0ZWxzZSB7XG5cdFx0XHQvLyBzdGFydCB3aXRoIGxlZnQgbmVpZ2hib3Jcblx0XHRcdGxldCBoX2xlZnQgPSB0aGlzLnRvcChhX2Nhbm9weVtoX25vZGUubGVmdF0pO1xuXG5cdFx0XHQvLyBuZWlnaGJvciBpcyByZWFkeVxuXHRcdFx0aWYgKGhfbGVmdC5yZWFkeSkge1xuXHRcdFx0XHRyZXR1cm4gdGhpcy5tZXJnZShoX2xlZnQsIGhfbm9kZSk7XG5cdFx0XHR9XG5cdFx0XHQvLyBuZWlnaGJvciBpcyBidXN5L25vdCByZWFkeVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdC8vIHRyeSByaWdodCBuZWlnaGJvclxuXHRcdFx0XHRsZXQgaF9yaWdodCA9IHRoaXMudG9wKGFfY2Fub3B5W2hfbm9kZS5yaWdodF0pO1xuXG5cdFx0XHRcdC8vIG5laWdoYm9yIGlzIHJlYWR5XG5cdFx0XHRcdGlmIChoX3JpZ2h0LnJlYWR5KSB7XG5cdFx0XHRcdFx0cmV0dXJuIHRoaXMubWVyZ2UoaF9ub2RlLCBoX3JpZ2h0KTtcblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBuZWlnaGJvciBpcyBidXN5L25vdCByZWFkeTsgbWFyayB0aGlzIGl0ZW0gYXMgcmVhZHlcblx0XHRcdFx0ZWxzZSB7XG5cdFx0XHRcdFx0aF9ub2RlLnJlYWR5ID0gdHJ1ZTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHJldHVybiBudWxsO1xuXHR9XG59XG5cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihkY193b3JrZXIpIHtcblx0d29ya2VyID0gZGNfd29ya2VyO1xuXHRyZXR1cm4gZ3JvdXA7XG59OyIsIi8vIGRlZHVjZSB0aGUgcnVudGltZSBlbnZpcm9ubWVudFxuY29uc3QgW0JfQlJPV1NFUiwgQl9CUk9XU0VSSUZZXSA9ICgoKSA9PiAndW5kZWZpbmVkJyA9PT0gdHlwZW9mIHByb2Nlc3MgP1xuXHRbdHJ1ZSwgZmFsc2VdIDpcblx0KHByb2Nlc3MuYnJvd3NlciA/XG5cdFx0W3RydWUsIHRydWVdIDpcblx0XHQoJ3VuZGVmaW5lZCcgPT09IHByb2Nlc3MudmVyc2lvbnMgfHwgJ3VuZGVmaW5lZCcgPT09IHByb2Nlc3MudmVyc2lvbnMubm9kZSA/XG5cdFx0XHRbdHJ1ZSwgZmFsc2VdIDpcblx0XHRcdFtmYWxzZSwgZmFsc2VdKSkpKCk7XG5cblxuY29uc3QgbG9jYWxzID0gT2JqZWN0LmFzc2lnbih7XG5cdEJfQlJPV1NFUixcblx0Ql9CUk9XU0VSSUZZLFxuXG5cdEhQX1dPUktFUl9OT1RJRklDQVRJT046IFN5bWJvbCgnd29ya2VyIG5vdGlmaWNhdGlvbicpLFxufSwgQl9CUk9XU0VSID8gcmVxdWlyZSgnLi4vYnJvd3Nlci9sb2NhbHMuanMnKSA6IHJlcXVpcmUoJy4uL25vZGUvbG9jYWxzLmpzJykpO1xuXG5cbmxvY2Fscy53ZWJ3b3JrZXJpZnkgPSBmdW5jdGlvbih6X2ltcG9ydCwgaF9jb25maWcgPSB7fSkge1xuXHRjb25zdCBbRl9GVU5DVElPTl9CVU5ETEUsIEhfU09VUkNFUywgSF9DQUNIRV0gPSBoX2NvbmZpZy5icm93c2VyaWZ5O1xuXHRsZXQgc193b3JrZXJfa2V5ID0gJyc7XG5cdGZvciAobGV0IHNfY2FjaGVfa2V5IGluIEhfQ0FDSEUpIHtcblx0XHRsZXQgel9leHBvcnRzID0gSF9DQUNIRVtzX2NhY2hlX2tleV0uZXhwb3J0cztcblx0XHRpZiAoel9pbXBvcnQgPT09IHpfZXhwb3J0cyB8fCB6X2ltcG9ydCA9PT0gel9leHBvcnRzLmRlZmF1bHQpIHtcblx0XHRcdHNfd29ya2VyX2tleSA9IHNfY2FjaGVfa2V5O1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXHR9XG5cblx0aWYgKCFzX3dvcmtlcl9rZXkpIHtcblx0XHRzX3dvcmtlcl9rZXkgPSBNYXRoLmZsb29yKE1hdGgucG93KDE2LCA4KSAqIE1hdGgucmFuZG9tKCkpLnRvU3RyaW5nKDE2KTtcblx0XHRsZXQgaF9jYWNoZV93b3JrZXIgPSB7fTtcblx0XHRmb3IgKGxldCBzX2tleV9jYWNoZSBpbiBIX1NPVVJDRVMpIHtcblx0XHRcdGhfY2FjaGVfd29ya2VyW3Nfa2V5X2NhY2hlXSA9IHNfa2V5X2NhY2hlO1xuXHRcdH1cblx0XHRIX1NPVVJDRVNbc193b3JrZXJfa2V5XSA9IFtcblx0XHRcdG5ldyBGdW5jdGlvbihbJ3JlcXVpcmUnLCAnbW9kdWxlJywgJ2V4cG9ydHMnXSwgYCgke3pfaW1wb3J0fSkoc2VsZik7YCksXG5cdFx0XHRoX2NhY2hlX3dvcmtlcixcblx0XHRdO1xuXHR9XG5cblx0bGV0IHNfc291cmNlX2tleSA9IE1hdGguZmxvb3IoTWF0aC5wb3coMTYsIDgpICogTWF0aC5yYW5kb20oKSkudG9TdHJpbmcoMTYpO1xuXHRIX1NPVVJDRVNbc19zb3VyY2Vfa2V5XSA9IFtcblx0XHRuZXcgRnVuY3Rpb24oWydyZXF1aXJlJ10sIGBcblx0XHRcdGxldCBmID0gcmVxdWlyZSgke0pTT04uc3RyaW5naWZ5KHNfd29ya2VyX2tleSl9KTtcblx0XHRcdC8vIGRlYnVnZ2VyO1xuXHRcdFx0Ly8gKGYuZGVmYXVsdD8gZi5kZWZhdWx0OiBmKShzZWxmKTtcblx0XHRgKSxcblx0XHR7XG5cdFx0XHRbc193b3JrZXJfa2V5XTogc193b3JrZXJfa2V5XG5cdFx0fSxcblx0XTtcblxuXHRsZXQgaF93b3JrZXJfc291cmNlcyA9IHt9O1xuXG5cdGZ1bmN0aW9uIHJlc29sdmVfc291cmNlcyhzX2tleSkge1xuXHRcdGhfd29ya2VyX3NvdXJjZXNbc19rZXldID0gdHJ1ZTtcblx0XHRsZXQgaF9zb3VyY2UgPSBIX1NPVVJDRVNbc19rZXldWzFdO1xuXHRcdGZvciAobGV0IHBfZGVwZW5kZW5jeSBpbiBoX3NvdXJjZSkge1xuXHRcdFx0bGV0IHNfZGVwZW5kZW5jeV9rZXkgPSBoX3NvdXJjZVtwX2RlcGVuZGVuY3ldO1xuXHRcdFx0aWYgKCFoX3dvcmtlcl9zb3VyY2VzW3NfZGVwZW5kZW5jeV9rZXldKSB7XG5cdFx0XHRcdHJlc29sdmVfc291cmNlcyhzX2RlcGVuZGVuY3lfa2V5KTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblx0cmVzb2x2ZV9zb3VyY2VzKHNfc291cmNlX2tleSk7XG5cblx0bGV0IHNfc291cmNlID0gYCgke0ZfRlVOQ1RJT05fQlVORExFfSkoe1xuXHRcdCR7T2JqZWN0LmtleXMoaF93b3JrZXJfc291cmNlcykubWFwKChzX2tleSkgPT4ge1xuXHRcdFx0bGV0IGFfc291cmNlID0gSF9TT1VSQ0VTW3Nfa2V5XTtcblx0XHRcdHJldHVybiBKU09OLnN0cmluZ2lmeShzX2tleSlcblx0XHRcdFx0K2A6WyR7YV9zb3VyY2VbMF19LCR7SlNPTi5zdHJpbmdpZnkoYV9zb3VyY2VbMV0pfV1gO1xuXHRcdH0pfVxuXHR9LCB7fSwgWyR7SlNPTi5zdHJpbmdpZnkoc19zb3VyY2Vfa2V5KX1dKWA7XG5cblx0bGV0IGRfYmxvYiA9IG5ldyBCbG9iKFtzX3NvdXJjZV0sIHtcblx0XHR0eXBlOiAndGV4dC9qYXZhc2NyaXB0J1xuXHR9KTtcblx0aWYgKGhfY29uZmlnLmJhcmUpIHtcblx0XHRyZXR1cm4gZF9ibG9iO1xuXHR9XG5cdGxldCBwX3dvcmtlcl91cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKGRfYmxvYik7XG5cdGxldCBkX3dvcmtlciA9IG5ldyBsb2NhbHMuRENfV09SS0VSKHBfd29ya2VyX3VybCwgaF9jb25maWcud29ya2VyX29wdGlvbnMpO1xuXHQvLyBkX3dvcmtlci5vYmplY3RVUkwgPSBwX3dvcmtlcl91cmw7XG5cdC8vIGRfd29ya2VyLnNvdXJjZSA9IGRfYmxvYjtcblx0ZF93b3JrZXIuc291cmNlID0gc19zb3VyY2U7XG5cdHJldHVybiBkX3dvcmtlcjtcbn07XG5cblxubW9kdWxlLmV4cG9ydHMgPSBsb2NhbHM7IiwiY29uc3Qge1xuXHRzaGFyaW5nLFxufSA9IHJlcXVpcmUoJy4vbG9jYWxzLmpzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gY2xhc3MgbWFuaWZlc3Qge1xuXHRzdGF0aWMgZnJvbSh6X290aGVyKSB7XG5cdFx0Ly8gbWFuaWZlc3Rcblx0XHRpZiAoel9vdGhlciBpbnN0YW5jZW9mIG1hbmlmZXN0KSB7XG5cdFx0XHRyZXR1cm4gel9vdGhlcjtcblx0XHR9XG5cdFx0Ly8gYW55XG5cdFx0ZWxzZSB7XG5cdFx0XHRyZXR1cm4gbmV3IG1hbmlmZXN0KHpfb3RoZXIsIFtdKTtcblx0XHR9XG5cdH1cblxuXHRjb25zdHJ1Y3RvcihhX2RhdGEgPSBbXSwgel90cmFuc2Zlcl9wYXRocyA9IHRydWUpIHtcblx0XHQvLyBub3QgYW4gYXJyYXlcblx0XHRpZiAoIUFycmF5LmlzQXJyYXkoYV9kYXRhKSkge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKCdhIG1hbmlmZXN0IHJlcHJlc2VudHMgYW4gYXJyYXkgb2YgYXJndW1lbnRzOyBwYXNzIHRoZSBjb25zdHJ1Y3RvciBhbiBhcnJheScpO1xuXHRcdH1cblxuXHRcdC8vIG5vdCBhIGxpc3Q7IGZpbmQgdHJhbnNmZXJzIG1hbnVhbGx5XG5cdFx0bGV0IGFfdHJhbnNmZXJfcGF0aHMgPSB6X3RyYW5zZmVyX3BhdGhzO1xuXHRcdGlmICghQXJyYXkuaXNBcnJheShhX3RyYW5zZmVyX3BhdGhzKSkge1xuXHRcdFx0YV90cmFuc2Zlcl9wYXRocyA9IHRoaXMuZXh0cmFjdChhX2RhdGEpO1xuXHRcdH1cblx0XHQvLyBvbmx5IGNoZWNrIHRvcCBsZXZlbFxuXHRcdGVsc2Uge1xuXHRcdFx0bGV0IGFfdHJhbnNmZXJzID0gW107XG5cdFx0XHRmb3IgKGxldCBpX2RhdHVtID0gMCwgbmxfZGF0YSA9IGFfZGF0YS5sZW5ndGg7IGlfZGF0dW0gPCBubF9kYXRhOyBpX2RhdHVtKyspIHtcblx0XHRcdFx0bGV0IHpfZGF0dW0gPSBhX2RhdGFbaV9kYXR1bV07XG5cblx0XHRcdFx0Ly8gc2hhcmVhYmxlIGl0ZW1cblx0XHRcdFx0aWYgKHNoYXJpbmcoel9kYXR1bSkpIGFfdHJhbnNmZXJzLnB1c2goW2lfZGF0dW1dKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gc29saWRpZnkgdHJhbnNmZXJzXG5cdFx0XHRpZiAoYV90cmFuc2ZlcnMubGVuZ3RoKSB7XG5cdFx0XHRcdGFfdHJhbnNmZXJfcGF0aHMgPSBhX3RyYW5zZmVycztcblx0XHRcdH1cblx0XHR9XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdGRhdGE6IGFfZGF0YSxcblx0XHRcdHRyYW5zZmVyX3BhdGhzOiBhX3RyYW5zZmVyX3BhdGhzLFxuXHRcdH0pO1xuXHR9XG5cblx0ZXh0cmFjdCh6X2RhdGEsIGFfcGF0aCA9IFtdLCB6aV9wYXRoX2xhc3QgPSBudWxsKSB7XG5cdFx0Ly8gcHJvdGVjdCBhZ2FpbnN0IFtvYmplY3RdIG51bGxcblx0XHRpZiAoIXpfZGF0YSkgcmV0dXJuIFtdO1xuXG5cdFx0Ly8gc2V0IG9mIHBhdGhzXG5cdFx0bGV0IGFfcGF0aHMgPSBbXTtcblxuXHRcdC8vIG9iamVjdFxuXHRcdGlmICgnb2JqZWN0JyA9PT0gdHlwZW9mIHpfZGF0YSkge1xuXHRcdFx0Ly8gY29weSBwYXRoXG5cdFx0XHRhX3BhdGggPSBhX3BhdGguc2xpY2UoKTtcblxuXHRcdFx0Ly8gY29tbWl0IHRvIGl0XG5cdFx0XHRpZiAobnVsbCAhPT0gemlfcGF0aF9sYXN0KSBhX3BhdGgucHVzaCh6aV9wYXRoX2xhc3QpO1xuXG5cdFx0XHQvLyBwbGFpbiBvYmplY3QgbGl0ZXJhbFxuXHRcdFx0aWYgKE9iamVjdCA9PT0gel9kYXRhLmNvbnN0cnVjdG9yKSB7XG5cdFx0XHRcdC8vIHNjYW4gb3ZlciBlbnVtZXJhYmxlIHByb3BlcnRpZXNcblx0XHRcdFx0Zm9yIChsZXQgc19wcm9wZXJ0eSBpbiB6X2RhdGEpIHtcblx0XHRcdFx0XHQvLyBleHRyYWN0IGRhdGEgYW5kIHRyYW5zZmVycyBieSByZWN1cnNpbmcgb24gcHJvcGVydHlcblx0XHRcdFx0XHRhX3BhdGhzLnB1c2goLi4udGhpcy5leHRyYWN0KHpfZGF0YVtzX3Byb3BlcnR5XSwgYV9wYXRoLCBzX3Byb3BlcnR5KSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdC8vIGFycmF5XG5cdFx0XHRlbHNlIGlmIChBcnJheS5pc0FycmF5KHpfZGF0YSkpIHtcblx0XHRcdFx0Ly8gZW1wdHkgYXJyYXlcblx0XHRcdFx0aWYgKCF6X2RhdGEubGVuZ3RoKSByZXR1cm4gW107XG5cblx0XHRcdFx0Ly8gc2NhbiBvdmVyIGVhY2ggaXRlbVxuXHRcdFx0XHR6X2RhdGEuZm9yRWFjaCgoel9pdGVtLCBpX2l0ZW0pID0+IHtcblx0XHRcdFx0XHQvLyBleHRyYWN0IGRhdGEgYW5kIHRyYW5zZmVycyBieSByZWN1cnNpbmcgb24gaXRlbVxuXHRcdFx0XHRcdGFfcGF0aHMucHVzaCguLi50aGlzLmV4dHJhY3Qoel9pdGVtLCBhX3BhdGgsIGlfaXRlbSkpO1xuXHRcdFx0XHR9KTtcblx0XHRcdH1cblx0XHRcdC8vIHNoYXJlYWJsZSBkYXRhXG5cdFx0XHRlbHNlIGlmIChzaGFyaW5nKHpfZGF0YSkpIHtcblx0XHRcdFx0cmV0dXJuIFthX3BhdGhdO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIHJldHVybiBwYXRoc1xuXHRcdHJldHVybiBhX3BhdGhzO1xuXHR9XG5cblx0cHJlcGVuZCh6X2FyZykge1xuXHRcdC8vIGNvcHkgaXRlbXNcblx0XHRsZXQgYV9pdGVtcyA9IHRoaXMuZGF0YS5zbGljZSgpO1xuXG5cdFx0Ly8gY29weSB0cmFuc2ZlciBwYXRoc1xuXHRcdGxldCBhX3RyYW5zZmVyX3BhdGhzID0gdGhpcy50cmFuc2Zlcl9wYXRocy5zbGljZSgpO1xuXG5cdFx0Ly8gcHVzaCBhIG1hbmlmZXN0IHRvIGZyb250XG5cdFx0aWYgKHpfYXJnIGluc3RhbmNlb2YgbWFuaWZlc3QpIHtcblx0XHRcdC8vIGFkZCBpdHMgY29udGVudHMgYXMgYSBzaW5nbGUgaXRlbVxuXHRcdFx0YV9pdGVtcy51bnNoaWZ0KHpfYXJnLmRhdGEpO1xuXG5cdFx0XHQvLyBob3cgbWFueSBwYXRocyB0byBvZmZzZXQgaW1wb3J0IGJ5XG5cdFx0XHRsZXQgbmxfcGF0aHMgPSBhX3RyYW5zZmVyX3BhdGhzLmxlbmd0aDtcblxuXHRcdFx0Ly8gdXBkYXRlIGltcG9ydCBwYXRocyAocHJpbWFyeSBpbmRleCBuZWVkcyB1cGRhdGUpXG5cdFx0XHRsZXQgYV9pbXBvcnRfcGF0aHMgPSB6X2FyZy50cmFuc2Zlcl9wYXRocztcblx0XHRcdGFfaW1wb3J0X3BhdGhzLmZvckVhY2goKGFfcGF0aCkgPT4ge1xuXHRcdFx0XHRhX3BhdGhbMF0gKz0gbmxfcGF0aHM7XG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gYXBwZW5kIGl0cyB0cmFuc2ZlciBwYXRoc1xuXHRcdFx0YV90cmFuc2Zlcl9wYXRocy5wdXNoKGFfaW1wb3J0X3BhdGhzKTtcblx0XHR9XG5cdFx0Ly8gYW55dGhpbmcgZWxzZVxuXHRcdGVsc2Uge1xuXHRcdFx0Ly8ganVzdCBhZGQgdG8gZnJvbnRcblx0XHRcdGFfaXRlbXMudW5zaGlmdCh6X2FyZyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIG5ldyBtYW5pZmVzdFxuXHRcdHJldHVybiBuZXcgbWFuaWZlc3QoYV9pdGVtcywgYV90cmFuc2Zlcl9wYXRocyk7XG5cdH1cblxuXHRwYXRocyguLi5hX3Vuc2hpZnQpIHtcblx0XHRyZXR1cm4gdGhpcy50cmFuc2Zlcl9wYXRocy5tYXAoKGFfcGF0aCkgPT4ge1xuXHRcdFx0cmV0dXJuIFsuLi5hX3Vuc2hpZnQsIC4uLmFfcGF0aF07XG5cdFx0fSk7XG5cdH1cbn07IiwiY29uc3Qge1xuXHROX0NPUkVTLFxufSA9IHJlcXVpcmUoJy4vbG9jYWxzLmpzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gY2xhc3MgcG9vbCB7XG5cdGNvbnN0cnVjdG9yKHBfc291cmNlLCBuX3dvcmtlcnMgPSBOX0NPUkVTLCBoX3dvcmtlcl9vcHRpb25zID0ge30pIHtcblx0XHQvLyBubyB3b3JrZXIgY291bnQgZ2l2ZW47IGRlZmF1bHQgdG8gbnVtYmVyIG9mIGNvcmVzXG5cdFx0aWYgKCFuX3dvcmtlcnMpIG5fd29ya2VycyA9IE5fQ09SRVM7XG5cblx0XHQvLyBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdHNvdXJjZTogcF9zb3VyY2UsXG5cdFx0XHRsaW1pdDogbl93b3JrZXJzLFxuXHRcdFx0d29ya2VyczogW10sXG5cdFx0XHRoaXN0b3J5OiBbXSxcblx0XHRcdHdhaXRfbGlzdDogW10sXG5cdFx0fSk7XG5cdH1cblxuXHRydW4oc190YXNrLCBhX2FyZ3MsIGhfZXZlbnRzKSB7XG5cdFx0dGhpcy5oaXN0b3J5LnB1c2gobmV3IFByb21pc2UoYXN5bmMgKGZfcmVzb2x2ZSwgZl9yZWplY3QpID0+IHtcblx0XHRcdC8vIHN1bW1vbiBhIHdvcmtlclxuXHRcdFx0bGV0IGtfd29ya2VyID0gYXdhaXQgdGhpcy5zdW1tb24oKTtcblxuXHRcdFx0Ly8gcnVuIHRoaXMgdGFza1xuXHRcdFx0bGV0IHpfcmVzdWx0O1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0el9yZXN1bHQgPSBhd2FpdCBrX3dvcmtlci5ydW4oc190YXNrLCBhX2FyZ3MsIGhfZXZlbnRzKTtcblx0XHRcdH1cblx0XHRcdC8vIGVycm9yIHdoaWxlIHJ1bm5pbmcgdGFza1xuXHRcdFx0Y2F0Y2ggKGVfcnVuKSB7XG5cdFx0XHRcdHJldHVybiBmX3JlamVjdChlX3J1bik7XG5cdFx0XHR9XG5cdFx0XHQvLyB3b3JrZXIgaXMgYXZhaWxhYmxlIG5vd1xuXHRcdFx0ZmluYWxseSB7XG5cdFx0XHRcdGxldCBhX3dhaXRfbGlzdCA9IHRoaXMud2FpdF9saXN0O1xuXG5cdFx0XHRcdC8vIGF0IGxlYXN0IG9uZSB0YXNrIGlzIHF1ZXVlZFxuXHRcdFx0XHRpZiAoYV93YWl0X2xpc3QubGVuZ3RoKSB7XG5cdFx0XHRcdFx0YV93YWl0X2xpc3Quc2hpZnQoKShrX3dvcmtlcik7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gcmVzb2x2ZSBwcm9taXNlXG5cdFx0XHRmX3Jlc29sdmUoel9yZXN1bHQpO1xuXHRcdH0pKTtcblx0fVxuXG5cdGFzeW5jIGtpbGwoc19zaWduYWwpIHtcblx0XHRyZXR1cm4gYXdhaXQgUHJvbWlzZS5hbGwodGhpcy53b3JrZXJzLm1hcCgoa193b3JrZXIpID0+IGtfd29ya2VyLmtpbGwoc19zaWduYWwpKSk7XG5cdH1cblxuXHRzdGFydCgpIHtcblx0XHR0aGlzLmhpc3RvcnkubGVuZ3RoID0gMDtcblx0fVxuXG5cdGFzeW5jIHN0b3AoKSB7XG5cdFx0Ly8gY2FjaGUgaGlzdG9yeVxuXHRcdGxldCBhX2hpc3RvcnkgPSB0aGlzLmhpc3Rvcnk7XG5cblx0XHQvLyByZXNldCBzdGFydCBwb2ludFxuXHRcdHRoaXMuc3RhcnQoKTtcblxuXHRcdC8vIGF3YWl0IGFsbCBwcm9taXNlcyB0byBmaW5pc2hcblx0XHRyZXR1cm4gYXdhaXQgUHJvbWlzZS5hbGwoYV9oaXN0b3J5KTtcblx0fVxuXG5cdGFzeW5jIHN1bW1vbigpIHtcblx0XHRsZXQgYV93b3JrZXJzID0gdGhpcy53b3JrZXJzO1xuXG5cdFx0Ly8gZWFjaCB3b3JrZXJcblx0XHRmb3IgKGxldCBpX3dvcmtlciA9IDAsIG5sX3dvcmtlcnMgPSBhX3dvcmtlcnMubGVuZ3RoOyBpX3dvcmtlciA8IG5sX3dvcmtlcnM7IGlfd29ya2VyKyspIHtcblx0XHRcdGxldCBrX3dvcmtlciA9IGFfd29ya2Vyc1tpX3dvcmtlcl07XG5cblx0XHRcdC8vIHdvcmtlciBub3QgYnVzeVxuXHRcdFx0aWYgKCFrX3dvcmtlci5idXN5KSB7XG5cdFx0XHRcdHJldHVybiBrX3dvcmtlcjtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyByb29tIHRvIGdyb3dcblx0XHRpZiAoYV93b3JrZXJzLmxlbmd0aCA8IHRoaXMubGltaXQpIHtcblx0XHRcdC8vIGNyZWF0ZSBuZXcgd29ya2VyXG5cdFx0XHRsZXQga193b3JrZXIgPSBuZXcgd29ya2VyKHtcblx0XHRcdFx0c291cmNlOiBwX3NvdXJjZSxcblx0XHRcdFx0aWQ6IGFfd29ya2Vycy5sZW5ndGgsXG5cdFx0XHRcdG1hc3RlcjogdGhpcyxcblx0XHRcdFx0b3B0aW9uczogaF93b3JrZXJfb3B0aW9ucyxcblx0XHRcdH0pO1xuXG5cdFx0XHQvLyBhZGQgdG8gcG9vbFxuXHRcdFx0YV93b3JrZXJzLnB1c2goa193b3JrZXIpO1xuXG5cdFx0XHQvLyBpdCdzIGF2YWlsYWJsZSBub3dcblx0XHRcdHJldHVybiBrX3dvcmtlcjtcblx0XHR9XG5cblx0XHQvLyBxdWV1ZSBmb3Igbm90aWZpY2F0aW9uIHdoZW4gd29ya2VycyBiZWNvbWUgYXZhaWxhYmxlXG5cdFx0dGhpcy53YWl0X2xpc3QucHVzaCgoa193b3JrZXIpID0+IHtcblx0XHRcdGZrX3dvcmtlcihrX3dvcmtlciwgY19zdW1tb25lZCsrKTtcblx0XHR9KTtcblx0fVxufTsiLCJjb25zdCBtYW5pZmVzdCA9IHJlcXVpcmUoJy4vbWFuaWZlc3QuanMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBjbGFzcyByZXN1bHQgZXh0ZW5kcyBtYW5pZmVzdCB7XG5cdHN0YXRpYyBmcm9tKHpfaXRlbSkge1xuXHRcdGlmICh6X2l0ZW0gaW5zdGFuY2VvZiByZXN1bHQpIHtcblx0XHRcdHJldHVybiB6X2l0ZW07XG5cdFx0fSBlbHNlIHtcblx0XHRcdHJldHVybiBuZXcgcmVzdWx0KHpfaXRlbSk7XG5cdFx0fVxuXHR9XG5cblx0Y29uc3RydWN0b3Ioel9yZXN1bHQsIHpfdHJhbnNmZXJfcGF0aHMgPSB0cnVlKSB7XG5cdFx0c3VwZXIoW3pfcmVzdWx0XSwgel90cmFuc2Zlcl9wYXRocyk7XG5cdH1cblxuXHRwcmVwZW5kKCkge1xuXHRcdHRocm93IG5ldyBFcnJvcignY2Fubm90IHByZXBlbmQgYSByZXN1bHQnKTtcblx0fVxufTsiLCJjb25zdCBldmVudHMgPSByZXF1aXJlKCcuL2V2ZW50cy5qcycpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGNsYXNzIGNoYW5uZWwgZXh0ZW5kcyBNZXNzYWdlQ2hhbm5lbCB7XG5cdHBvcnRfMShma19wb3J0KSB7XG5cdFx0ZmtfcG9ydChldmVudHModGhpcy5wb3J0MSkpO1xuXHR9XG5cblx0cG9ydF8yKGZrX3BvcnQpIHtcblx0XHRma19wb3J0KGV2ZW50cyh0aGlzLnBvcnQyKSk7XG5cdH1cbn07IiwibW9kdWxlLmV4cG9ydHMgPSAoZHpfdGhpbmcpID0+IHtcblx0T2JqZWN0LmFzc2lnbihkel90aGluZywge1xuXHRcdGV2ZW50cyhoX2V2ZW50cykge1xuXHRcdFx0Zm9yIChsZXQgc19ldmVudCBpbiBoX2V2ZW50cykge1xuXHRcdFx0XHR0aGlzWydvbicgKyBzX2V2ZW50XSA9IGhfZXZlbnRzW3NfZXZlbnRdO1xuXHRcdFx0fVxuXHRcdH0sXG5cblx0XHRldmVudChzX2V2ZW50LCBmX2V2ZW50KSB7XG5cdFx0XHR0aGlzWydvbicgKyBzX2V2ZW50XSA9IGZfZXZlbnQ7XG5cdFx0fSxcblx0fSk7XG5cblx0cmV0dXJuIGR6X3RoaW5nO1xufTsiLCJtb2R1bGUuZXhwb3J0cyA9IHtcblx0S19TRUxGOiByZXF1aXJlKCcuL3NlbGYuanMnKSxcblx0RENfV09SS0VSOiAndW5kZWZpbmVkJyA9PT0gdHlwZW9mIFdvcmtlciA/IHVuZGVmaW5lZCA6IHJlcXVpcmUoJy4vd29ya2VyLmpzJyksXG5cdERDX0NIQU5ORUw6IHJlcXVpcmUoJy4vY2hhbm5lbC5qcycpLFxuXHRIX1RZUEVEX0FSUkFZUzogcmVxdWlyZSgnLi90eXBlZC1hcnJheXMuanMnKSxcblx0Tl9DT1JFUzogbmF2aWdhdG9yLmhhcmR3YXJlQ29uY3VycmVuY3kgfHwgMSxcblx0c2hhcmluZzogcmVxdWlyZSgnLi9zaGFyaW5nLmpzJyksXG5cdHN0cmVhbTogcmVxdWlyZSgnLi9zdHJlYW0uanMnKSxcblx0cG9ydHM6IHJlcXVpcmUoJy4vcG9ydHMuanMnKSxcbn07IiwiY29uc3QgZXZlbnRzID0gcmVxdWlyZSgnLi9ldmVudHMuanMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSAoZF9wb3J0KSA9PiBldmVudHMoZF9wb3J0KTsiLCJjb25zdCBldmVudHMgPSByZXF1aXJlKCcuL2V2ZW50cy5qcycpO1xuXG5ldmVudHMoc2VsZik7XG5cbnNlbGYuYXJncyA9IFtcblx0KE1hdGgucmFuZG9tKCkgKyAnJykuc2xpY2UoMiwgOCksXG5dO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHNlbGY7IiwiY29uc3QgJF9TSEFSRUFCTEUgPSBTeW1ib2woJ3NoYXJlYWJsZScpO1xuXG5mdW5jdGlvbiBleHRyYWN0KHpfZGF0YSwgYXNfdHJhbnNmZXJzID0gbnVsbCkge1xuXHQvLyBwcm90ZWN0IGFnYWluc3QgW29iamVjdF0gbnVsbFxuXHRpZiAoIXpfZGF0YSkgcmV0dXJuIFtdO1xuXG5cdC8vIHNldCBvZiB0cmFuc2ZlciBvYmplY3RzXG5cdGlmICghYXNfdHJhbnNmZXJzKSBhc190cmFuc2ZlcnMgPSBuZXcgU2V0KCk7XG5cblx0Ly8gb2JqZWN0XG5cdGlmICgnb2JqZWN0JyA9PT0gdHlwZW9mIHpfZGF0YSkge1xuXHRcdC8vIHBsYWluIG9iamVjdCBsaXRlcmFsXG5cdFx0aWYgKE9iamVjdCA9PT0gel9kYXRhLmNvbnN0cnVjdG9yKSB7XG5cdFx0XHQvLyBzY2FuIG92ZXIgZW51bWVyYWJsZSBwcm9wZXJ0aWVzXG5cdFx0XHRmb3IgKGxldCBzX3Byb3BlcnR5IGluIHpfZGF0YSkge1xuXHRcdFx0XHQvLyBhZGQgZWFjaCB0cmFuc2ZlcmFibGUgZnJvbSByZWN1cnNpb24gdG8gb3duIHNldFxuXHRcdFx0XHRleHRyYWN0KHpfZGF0YVtzX3Byb3BlcnR5XSwgYXNfdHJhbnNmZXJzKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXlcblx0XHRlbHNlIGlmIChBcnJheS5pc0FycmF5KHpfZGF0YSkpIHtcblx0XHRcdC8vIHNjYW4gb3ZlciBlYWNoIGl0ZW1cblx0XHRcdHpfZGF0YS5mb3JFYWNoKCh6X2l0ZW0pID0+IHtcblx0XHRcdFx0Ly8gYWRkIGVhY2ggdHJhbnNmZXJhYmxlIGZyb20gcmVjdXJzaW9uIHRvIG93biBzZXRcblx0XHRcdFx0ZXh0cmFjdCh6X2l0ZW0sIGFzX3RyYW5zZmVycyk7XG5cdFx0XHR9KTtcblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXksIGRhdGEgdmlldyBvciBhcnJheSBidWZmZXJcblx0XHRlbHNlIGlmIChBcnJheUJ1ZmZlci5pc1ZpZXcoel9kYXRhKSkge1xuXHRcdFx0YXNfdHJhbnNmZXJzLmFkZCh6X2RhdGEuYnVmZmVyKTtcblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyXG5cdFx0ZWxzZSBpZiAoel9kYXRhIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHtcblx0XHRcdGFzX3RyYW5zZmVycy5hZGQoel9kYXRhKTtcblx0XHR9XG5cdFx0Ly8gbWVzc2FnZSBwb3J0XG5cdFx0ZWxzZSBpZiAoel9kYXRhIGluc3RhbmNlb2YgTWVzc2FnZVBvcnQpIHtcblx0XHRcdGFzX3RyYW5zZmVycy5hZGQoel9kYXRhKTtcblx0XHR9XG5cdFx0Ly8gaW1hZ2UgYml0bWFwXG5cdFx0ZWxzZSBpZiAoel9kYXRhIGluc3RhbmNlb2YgSW1hZ2VCaXRtYXApIHtcblx0XHRcdGFzX3RyYW5zZmVycy5hZGQoel9kYXRhKTtcblx0XHR9XG5cdH1cblx0Ly8gZnVuY3Rpb25cblx0ZWxzZSBpZiAoJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIHpfZGF0YSkge1xuXHRcdC8vIHNjYW4gb3ZlciBlbnVtZXJhYmxlIHByb3BlcnRpZXNcblx0XHRmb3IgKGxldCBzX3Byb3BlcnR5IGluIHpfZGF0YSkge1xuXHRcdFx0Ly8gYWRkIGVhY2ggdHJhbnNmZXJhYmxlIGZyb20gcmVjdXJzaW9uIHRvIG93biBzZXRcblx0XHRcdGV4dHJhY3Qoel9kYXRhW3NfcHJvcGVydHldLCBhc190cmFuc2ZlcnMpO1xuXHRcdH1cblx0fVxuXHQvLyBub3RoaW5nXG5cdGVsc2Uge1xuXHRcdHJldHVybiBbXTtcblx0fVxuXG5cdC8vIGNvbnZlcnQgc2V0IHRvIGFycmF5XG5cdHJldHVybiBBcnJheS5mcm9tKGFzX3RyYW5zZmVycyk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gT2JqZWN0LmFzc2lnbihmdW5jdGlvbih6X29iamVjdCkge1xuXHRyZXR1cm4gQXJyYXlCdWZmZXIuaXNWaWV3KHpfb2JqZWN0KSB8fFxuXHRcdHpfb2JqZWN0IGluc3RhbmNlb2YgQXJyYXlCdWZmZXIgfHxcblx0XHR6X29iamVjdCBpbnN0YW5jZW9mIE1lc3NhZ2VQb3J0IHx8XG5cdFx0el9vYmplY3QgaW5zdGFuY2VvZiBJbWFnZUJpdG1hcDtcbn0sIHtcblx0JF9TSEFSRUFCTEUsXG5cblx0ZXh0cmFjdCxcbn0pOyIsImNvbnN0IGV2ZW50cyA9IHJlcXVpcmUoJ2V2ZW50cycpO1xuXG5jbGFzcyByZWFkYWJsZV9zdHJlYW0gZXh0ZW5kcyBldmVudHMuRXZlbnRFbWl0dGVyIHtcblx0Y29uc3RydWN0b3IoKSB7XG5cdFx0c3VwZXIoKTtcblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0ZGVjb2RlcjogbnVsbCxcblx0XHRcdHBhdXNlZDogZmFsc2UsXG5cdFx0XHRjb25zdW1lZDogMCxcblx0XHR9KTtcblx0fVxuXG5cdHNldEVuY29kaW5nKHNfZW5jb2RpbmcpIHtcblx0XHR0aGlzLmRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoc19lbmNvZGluZyk7XG5cdH1cblxuXHRwYXVzZSgpIHtcblx0XHR0aGlzLnBhdXNlZCA9IHRydWU7XG5cdH1cblxuXHRyZXN1bWUoKSB7XG5cdFx0dGhpcy5wYXVzZWQgPSBmYWxzZTtcblx0XHR0aGlzLm5leHRfY2h1bmsoKTtcblx0fVxuXG5cdGNodW5rKGF0X2NodW5rLCBiX2VvZikge1xuXHRcdGxldCBubF9jaHVuayA9IGF0X2NodW5rLmxlbmd0aDtcblx0XHR0aGlzLmNvbnN1bWVkICs9IG5sX2NodW5rO1xuXG5cdFx0Ly8gZGVjb2RlIGRhdGFcblx0XHRpZiAodGhpcy5kZWNvZGVyKSB7XG5cdFx0XHRsZXQgc19kYXRhO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0c19kYXRhID0gdGhpcy5kZWNvZGVyLmRlY29kZShhdF9jaHVuaywge1xuXHRcdFx0XHRcdHN0cmVhbTogIWJfZW9mXG5cdFx0XHRcdH0pO1xuXHRcdFx0fSBjYXRjaCAoZV9kZWNvZGUpIHtcblx0XHRcdFx0dGhpcy5lbWl0KCdlcnJvcicsIGVfZGVjb2RlKTtcblx0XHRcdH1cblxuXHRcdFx0dGhpcy5lbWl0KCdkYXRhJywgc19kYXRhLCBhdF9jaHVuayk7XG5cdFx0fVxuXHRcdC8vIG5vIGVuY29kaW5nXG5cdFx0ZWxzZSB7XG5cdFx0XHR0aGlzLmVtaXQoJ2RhdGEnLCBhdF9jaHVuaywgYXRfY2h1bmspO1xuXHRcdH1cblxuXHRcdC8vIGVuZCBvZiBmaWxlXG5cdFx0aWYgKGJfZW9mKSB7XG5cdFx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0dGhpcy5lbWl0KCdlbmQnKTtcblx0XHRcdH0sIDApO1xuXHRcdH1cblx0XHQvLyByZXF1ZXN0IG1vcmUgZGF0YVxuXHRcdGVsc2UgaWYgKCF0aGlzLnBhdXNlZCkge1xuXHRcdFx0dGhpcy5uZXh0X2NodW5rKCk7XG5cdFx0fVxuXHR9XG59XG5cbk9iamVjdC5hc3NpZ24ocmVhZGFibGVfc3RyZWFtLnByb3RvdHlwZSwge1xuXHRlbWl0c0J5dGVDb3VudHM6IHRydWUsXG59KTtcblxuY2xhc3MgcmVhZGFibGVfc3RyZWFtX3ZpYV9wb3J0IGV4dGVuZHMgcmVhZGFibGVfc3RyZWFtIHtcblx0Y29uc3RydWN0b3IoZF9wb3J0KSB7XG5cdFx0c3VwZXIoKTtcblxuXHRcdC8vIG1lc3NhZ2UgaGFuZGxpbmdcblx0XHRkX3BvcnQub25tZXNzYWdlID0gKGRfbXNnKSA9PiB7XG5cdFx0XHRsZXQge1xuXHRcdFx0XHRjb250ZW50OiBhdF9jb250ZW50LFxuXHRcdFx0XHRlb2Y6IGJfZW9mLFxuXHRcdFx0fSA9IGRfbXNnLmRhdGE7XG5cblx0XHRcdC8vIHN0YXJ0IHRpbWluZ1xuXHRcdFx0dGhpcy5zdGFydGVkID0gcGVyZm9ybWFuY2Uubm93KCk7XG5cblx0XHRcdC8vIHByb2Nlc3MgY2h1bmtcblx0XHRcdHRoaXMuY2h1bmsoYXRfY29udGVudCwgYl9lb2YpO1xuXHRcdH07XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdHBvcnQ6IGRfcG9ydCxcblx0XHRcdHN0YXJ0ZWQ6IDAsXG5cdFx0fSk7XG5cdH1cblxuXHRzZXRFbmNvZGluZyhzX2VuY29kaW5nKSB7XG5cdFx0dGhpcy5kZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKHNfZW5jb2RpbmcpO1xuXHR9XG5cblx0bmV4dF9jaHVuaygpIHtcblx0XHRsZXQgdF9lbGFwc2VkID0gcGVyZm9ybWFuY2Uubm93KCkgLSB0aGlzLnN0YXJ0ZWQ7XG5cblx0XHQvLyBjb25zb2xlLmxvZygnUyA9PT4gW0FDSyAvIG5leHQgY2h1bmtdJyk7XG5cblx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0cG9zdGVkOiBwZXJmb3JtYW5jZS5ub3coKSxcblx0XHRcdGVsYXBzZWQ6IHRfZWxhcHNlZCxcblx0XHR9KTtcblx0fVxuXG5cdC8vIHBhdXNlKCkge1xuXG5cdC8vIH1cblxuXHQvLyByZXN1bWUoYl9kb250X3VucGF1c2U9ZmFsc2UpIHtcblx0Ly8gXHRsZXQgdF9lbGFwc2VkID0gcGVyZm9ybWFuY2Uubm93KCkgLSB0aGlzLnN0YXJ0ZWQ7XG5cblx0Ly8gXHRzZWxmLnBvc3RNZXNzYWdlKHtcblx0Ly8gXHRcdGVsYXBzZWQ6IHRfZWxhcHNlZCxcblx0Ly8gXHR9KTtcblx0Ly8gfVxuXG5cdC8vIHBpcGUoeV93cml0YWJsZSkge1xuXHQvLyBcdHRoaXMub24oJ2RhdGEnLCAoel9jaHVuaykgPT4ge1xuXHQvLyBcdFx0bGV0IGJfY2FwYWNpdHkgPSB5X3dyaXRhYmxlLndyaXRlKHpfY2h1bmspO1xuXG5cdC8vIFx0XHQvLyBmZXRjaCBuZXh0IGNodW5rOyBvdGhlcndpc2UgYXdhaXQgZHJhaW5cblx0Ly8gXHRcdGlmKGZhbHNlICE9PSBiX2NhcGFjaXR5KSB7XG5cdC8vIFx0XHRcdHRoaXMucmVzdW1lKHRydWUpO1xuXHQvLyBcdFx0fVxuXHQvLyBcdH0pO1xuXG5cdC8vIFx0eV93cml0YWJsZS5vbignZHJhaW4nLCAoKSA9PiB7XG5cdC8vIFx0XHR0aGlzLnJlc3VtZSh0cnVlKTtcblx0Ly8gXHR9KTtcblxuXHQvLyBcdHlfd3JpdGFibGUuZW1pdCgncGlwZScsIHRoaXMpO1xuXHQvLyB9XG59XG5cblxuXG5jbGFzcyByZWFkYWJsZV9zdHJlYW1fdmlhX29iamVjdF91cmwgZXh0ZW5kcyByZWFkYWJsZV9zdHJlYW0ge1xuXHRjb25zdHJ1Y3RvcihwX29iamVjdF91cmwsIGhfY29uZmlnID0ge30pIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0ZmV0Y2gocF9vYmplY3RfdXJsKVxuXHRcdFx0LnRoZW4oZF9yZXMgPT4gZF9yZXMuYmxvYigpKVxuXHRcdFx0LnRoZW4oKGRmYl9pbnB1dCkgPT4ge1xuXHRcdFx0XHRpZiAodGhpcy5vbmJsb2IpIHRoaXMub25ibG9iKGRmYl9pbnB1dCk7XG5cdFx0XHRcdGxldCBrX2Jsb2JfcmVhZGVyID0gdGhpcy5ibG9iX3JlYWRlciA9IG5ldyBibG9iX3JlYWRlcih0aGlzLCBkZmJfaW5wdXQsIGhfY29uZmlnKTtcblx0XHRcdFx0dGhpcy5vbignZW5kJywgKCkgPT4ge1xuXHRcdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0XHRcdFVSTC5yZXZva2VPYmplY3RVUkwocF9vYmplY3RfdXJsKTtcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGtfYmxvYl9yZWFkZXIubmV4dF9jaHVuaygpO1xuXHRcdFx0fSk7XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdGJsb2JfcmVhZGVyOiBudWxsLFxuXHRcdFx0b2JqZWN0X3VybDogcF9vYmplY3RfdXJsLFxuXHRcdH0pO1xuXHR9XG5cblx0bmV4dF9jaHVuaygpIHtcblx0XHR0aGlzLmJsb2JfcmVhZGVyLm5leHRfY2h1bmsoKTtcblx0fVxuXG5cdC8vIG9uKHNfZXZlbnQsIGZrX2V2ZW50KSB7XG5cdC8vIFx0c3VwZXIub24oc19ldmVudCwgZmtfZXZlbnQpO1xuXG5cdC8vIFx0aWYoJ2RhdGEnID09PSBzX2V2ZW50KSB7XG5cdC8vIFx0XHRpZighdGhpcy5ibG9iKSB7XG5cdC8vIFx0XHRcdHRoaXMub25fYmxvYiA9IHRoaXMucmVzdW1lO1xuXHQvLyBcdFx0fVxuXHQvLyBcdFx0ZWxzZSB7XG5cdC8vIFx0XHRcdHRoaXMucmVzdW1lKCk7XG5cdC8vIFx0XHR9XG5cdC8vIFx0fVxuXHQvLyB9XG59XG5cbmNsYXNzIHRyYW5zZmVyX3N0cmVhbSB7XG5cdGNvbnN0cnVjdG9yKCkge1xuXHRcdGxldCBkX2NoYW5uZWwgPSBuZXcgTWVzc2FnZUNoYW5uZWwoKTtcblx0XHRsZXQgZF9wb3J0ID0gZF9jaGFubmVsLnBvcnQxO1xuXG5cdFx0ZF9wb3J0Lm9ubWVzc2FnZSA9IChkX21zZykgPT4ge1xuXHRcdFx0bGV0IHRfZWxhcHNlZF9tYWluID0gdGhpcy5lbGFwc2VkO1xuXG5cdFx0XHRsZXQge1xuXHRcdFx0XHRwb3N0ZWQ6IHRfcG9zdGVkLFxuXHRcdFx0XHRlbGFwc2VkOiB0X2VsYXBzZWRfb3RoZXIsXG5cdFx0XHR9ID0gZF9tc2cuZGF0YTtcblxuXHRcdFx0Ly8gY29uc29sZS5sb2coJyArKyBwYXJzZTogJyt0X2VsYXBzZWRfb3RoZXIpO1xuXHRcdFx0dGhpcy5yZWNlaXZlcl9lbGFwc2VkICs9IHRfZWxhcHNlZF9vdGhlcjtcblxuXHRcdFx0Ly8gY29uc29sZS5sb2coJ00gPD09IFtBQ0sgLyBuZXh0IGNodW5rXTsgYnVmZmVyOiAnKyghIXRoaXMuYnVmZmVyKSsnOyBidXN5OiAnK3RoaXMucmVjZWl2ZXJfYnVzeSsnOyBlb2Y6Jyt0aGlzLnJlYWRlci5lb2YpOyAgLy9wb3N0ZWQgQCcrdF9wb3N0ZWQpO1xuXG5cdFx0XHQvLyByZWNlaXZlciBpcyBmcmVlXG5cdFx0XHR0aGlzLnJlY2VpdmVyX2J1c3kgPSBmYWxzZTtcblxuXHRcdFx0Ly8gY2h1bmsgcmVhZHkgdG8gZ29cblx0XHRcdGlmICh0aGlzLmJ1ZmZlcikge1xuXHRcdFx0XHR0aGlzLnNlbmQodGhpcy5idWZmZXIsIHRoaXMuYnVmZmVyX2VvZik7XG5cdFx0XHRcdHRoaXMuYnVmZmVyID0gbnVsbDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gcmVhZGVyIGlzIG5vdCBidXN5XG5cdFx0XHRpZiAoIXRoaXMucmVhZGVyLmJ1c3kpIHtcblx0XHRcdFx0dGhpcy5yZWFkZXIubmV4dF9jaHVuaygpO1xuXHRcdFx0fVxuXHRcdH07XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdG1haW5fcG9ydDogZF9wb3J0LFxuXHRcdFx0b3RoZXJfcG9ydDogZF9jaGFubmVsLnBvcnQyLFxuXHRcdFx0ZWxhcHNlZDogMCxcblx0XHRcdHJlYWRlcjogbnVsbCxcblx0XHRcdGJ1ZmZlcjogbnVsbCxcblx0XHRcdGJ1ZmZlcl9lb2Y6IHRydWUsXG5cdFx0XHRyZWNlaXZlcl9idXN5OiBmYWxzZSxcblx0XHRcdHJlY2VpdmVyX2VsYXBzZWQ6IDAsXG5cdFx0fSk7XG5cdH1cblxuXHRzZW5kKGF0X2NodW5rLCBiX2VvZiA9IHRydWUpIHtcblx0XHR0aGlzLnJlY2VpdmVyX2J1c3kgPSB0cnVlO1xuXG5cdFx0Ly8gY29uc29sZS5sb2coJ00gPT0+IFtjaHVua10nKTtcblxuXHRcdC8vIHNlbmQgdG8gcmVjZWl2ZXJcblx0XHR0aGlzLm1haW5fcG9ydC5wb3N0TWVzc2FnZSh7XG5cdFx0XHRjb250ZW50OiBhdF9jaHVuayxcblx0XHRcdGVvZjogYl9lb2YsXG5cdFx0fSwgW2F0X2NodW5rLmJ1ZmZlcl0pO1xuXHR9XG5cblx0Y2h1bmsoYXRfY2h1bmssIGJfZW9mID0gdHJ1ZSkge1xuXHRcdC8vIGNvbnNvbGUubG9nKCdibG9iIGNodW5rIHJlYWR5IHRvIHNlbmQ7IGJ1ZmZlcjogJysoISF0aGlzLmJ1ZmZlcikrJzsgYnVzeTogJyt0aGlzLnJlY2VpdmVyX2J1c3kpO1xuXG5cdFx0Ly8gcmVjZWl2ZXIgaXMgYnVzeSwgcXVldWUgaW4gYnVmZmVyXG5cdFx0aWYgKHRoaXMucmVjZWl2ZXJfYnVzeSkge1xuXHRcdFx0dGhpcy5idWZmZXIgPSBhdF9jaHVuaztcblx0XHRcdHRoaXMuYnVmZmVyX2VvZiA9IGJfZW9mO1xuXHRcdH1cblx0XHQvLyByZWNlaXZlciBhdmFpbGFibGU7IHNlbmQgaW1tZWRpYXRlbHlcblx0XHRlbHNlIHtcblx0XHRcdC8vIHByZWZldGNoIG5leHQgY2h1bmtcblx0XHRcdGlmICghdGhpcy5idWZmZXIgJiYgIXRoaXMucmVhZGVyLmVvZikge1xuXHRcdFx0XHR0aGlzLnJlYWRlci5uZXh0X2NodW5rKCk7XG5cdFx0XHR9XG5cblx0XHRcdHRoaXMuc2VuZChhdF9jaHVuaywgYl9lb2YpO1xuXHRcdH1cblx0fVxuXG5cdGJsb2IoZGZiX2lucHV0LCBoX2NvbmZpZyA9IHt9KSB7XG5cdFx0dGhpcy5yZWFkZXIgPSBuZXcgYmxvYl9yZWFkZXIodGhpcywgZGZiX2lucHV0LCBoX2NvbmZpZyk7XG5cblx0XHQvLyBzdGFydCBzZW5kaW5nXG5cdFx0dGhpcy5yZWFkZXIubmV4dF9jaHVuaygpO1xuXHR9XG59XG5cbmNsYXNzIGJsb2JfcmVhZGVyIHtcblx0Y29uc3RydWN0b3Ioa19wYXJlbnQsIGRmYl9pbnB1dCwgaF9jb25maWcgPSB7fSkge1xuXHRcdGxldCBkZnJfcmVhZGVyID0gbmV3IEZpbGVSZWFkZXIoKTtcblx0XHRkZnJfcmVhZGVyLm9ubG9hZCA9IChkX2V2ZW50KSA9PiB7XG5cdFx0XHR0aGlzLmJ1c3kgPSBmYWxzZTtcblx0XHRcdC8vIGxldCBiX2VvZiA9IGZhbHNlO1xuXHRcdFx0Ly8gaWYoKyt0aGlzLmNodW5rc19yZWFkID09PSB0aGlzLmNodW5rc19sb2FkZWQpIGJfZW9mID0gdGhpcy5lb2Y7XG5cdFx0XHRrX3BhcmVudC5jaHVuayhuZXcgVWludDhBcnJheShkX2V2ZW50LnRhcmdldC5yZXN1bHQpLCB0aGlzLmVvZik7XG5cdFx0fTtcblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0ZW9mOiBmYWxzZSxcblx0XHRcdGJ1c3k6IGZhbHNlLFxuXHRcdFx0cmVhZF9pbmRleDogMCxcblx0XHRcdGNodW5rX3NpemU6IGhfY29uZmlnLmNodW5rX3NpemUgfHwgaF9jb25maWcuY2h1bmtTaXplIHx8IDEwMjQgKiAxMDI0ICogMSwgLy8gMSBNaUJcblx0XHRcdGNvbnRlbnQ6IGRmYl9pbnB1dCxcblx0XHRcdGNvbnRlbnRfbGVuZ3RoOiBkZmJfaW5wdXQuc2l6ZSxcblx0XHRcdGZpbGVfcmVhZGVyOiBkZnJfcmVhZGVyLFxuXHRcdFx0Y2h1bmtzX2xvYWRlZDogMCxcblx0XHRcdGNodW5rc19yZWFkOiAwLFxuXHRcdH0pO1xuXHR9XG5cblx0bmV4dF9jaHVuaygpIHtcblx0XHRsZXQge1xuXHRcdFx0cmVhZF9pbmRleDogaV9yZWFkLFxuXHRcdFx0Y2h1bmtfc2l6ZTogbl9jaHVua19zaXplLFxuXHRcdFx0Y29udGVudDogZGZiX2NvbnRlbnQsXG5cdFx0XHRjb250ZW50X2xlbmd0aDogbmxfY29udGVudCxcblx0XHR9ID0gdGhpcztcblxuXHRcdGxldCBpX2VuZCA9IGlfcmVhZCArIG5fY2h1bmtfc2l6ZTtcblx0XHRpZiAoaV9lbmQgPj0gbmxfY29udGVudCkge1xuXHRcdFx0aV9lbmQgPSBubF9jb250ZW50O1xuXHRcdFx0dGhpcy5lb2YgPSB0cnVlO1xuXHRcdH1cblxuXHRcdHRoaXMuYnVzeSA9IHRydWU7XG5cdFx0dGhpcy5jaHVua3NfbG9hZGVkICs9IDE7XG5cblx0XHRsZXQgZGZiX3NsaWNlID0gZGZiX2NvbnRlbnQuc2xpY2UoaV9yZWFkLCBpX2VuZCk7XG5cdFx0dGhpcy5yZWFkX2luZGV4ID0gaV9lbmQ7XG5cblx0XHR0aGlzLmZpbGVfcmVhZGVyLnJlYWRBc0FycmF5QnVmZmVyKGRmYl9zbGljZSk7XG5cdH1cbn1cblxuXG5tb2R1bGUuZXhwb3J0cyA9IE9iamVjdC5hc3NpZ24oZnVuY3Rpb24oel9pbnB1dCA9IG51bGwpIHtcblx0aWYgKHpfaW5wdXQpIHtcblx0XHQvLyBtYWtlIHJlYWRhYmxlIHN0cmVhbSBmcm9tIG9iamVjdCB1cmwncyBibG9iXG5cdFx0aWYgKCdzdHJpbmcnID09PSB0eXBlb2Ygel9pbnB1dCkge1xuXHRcdFx0cmV0dXJuIG5ldyByZWFkYWJsZV9zdHJlYW1fdmlhX29iamVjdF91cmwoel9pbnB1dCk7XG5cdFx0fVxuXHRcdC8vIG1ha2UgcmVhZGFibGUgc3RyZWFtIGF0b3AgcG9ydFxuXHRcdGVsc2UgaWYgKHpfaW5wdXQgaW5zdGFuY2VvZiBNZXNzYWdlUG9ydCkge1xuXHRcdFx0cmV0dXJuIG5ldyByZWFkYWJsZV9zdHJlYW1fdmlhX3BvcnQoel9pbnB1dCk7XG5cdFx0fVxuXHR9XG5cdC8vIHRyYW5zZmVyIGEgc3RyZWFtXG5cdGVsc2Uge1xuXHRcdHJldHVybiBuZXcgdHJhbnNmZXJfc3RyZWFtKCk7XG5cdH1cbn0sIHtcblx0aGFuZGxlcjogY2xhc3MgaGFuZGxlciB7fSxcbn0pOyIsImNvbnN0IHNoYXJpbmcgPSByZXF1aXJlKCcuL3NoYXJpbmcuanMnKTtcbmNvbnN0IFR5cGVkQXJyYXkgPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoT2JqZWN0LmdldFByb3RvdHlwZU9mKG5ldyBVaW50OEFycmF5KDApKSkuY29uc3RydWN0b3I7XG5cblxuXG5cblxuY2xhc3MgSW50OEFycmF5UyBleHRlbmRzIEludDhBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZiAoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRhdF9zZWxmID0gbmV3IEludDhBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmIChzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgSW50OEFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHtcblx0XHRcdC8vIGZvcmNlIG9mZnNldFxuXHRcdFx0bmJfb2Zmc2V0ID0gbmJfb2Zmc2V0IHx8IDA7XG5cblx0XHRcdC8vIG5vIGxlbmd0aDsgZGVkdWNlIGl0IGZyb20gb2Zmc2V0XG5cdFx0XHRpZiAodW5kZWZpbmVkID09PSBubF9hcnJheSkge1xuXHRcdFx0XHRubF9hcnJheSA9IHpfYXJnXzAubGVuZ3RoIC0gbmJfb2Zmc2V0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhcnJheSBzaXplIGluIGJ5dGVzXG5cdFx0XHRsZXQgbmJfYXJyYXkgPSBubF9hcnJheTtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQ4QXJyYXkoZHNiLCAwLCBuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSBjb3B5IHNyY1xuXHRcdFx0bGV0IGF0X3NyYyA9IG5ldyBJbnQ4QXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBJbnQ4QXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oSW50OEFycmF5Uy5wcm90b3R5cGUsIHtcblx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdOiAxLFxufSk7XG5cblxuY2xhc3MgVWludDhBcnJheVMgZXh0ZW5kcyBVaW50OEFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmICgnbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmIChzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0XHRhdF9zZWxmLnNldCh6X2FyZ18wKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyIGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXk7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IFVpbnQ4QXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBVaW50OEFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKFVpbnQ4QXJyYXlTLnByb3RvdHlwZSwge1xuXHRbc2hhcmluZy4kX1NIQVJFQUJMRV06IDEsXG59KTtcblxuXG5jbGFzcyBVaW50OENsYW1wZWRBcnJheVMgZXh0ZW5kcyBVaW50OENsYW1wZWRBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZiAoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQ4Q2xhbXBlZEFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYgKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50OENsYW1wZWRBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0XHRhdF9zZWxmLnNldCh6X2FyZ18wKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyIGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXk7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhDbGFtcGVkQXJyYXkoZHNiLCAwLCBuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSBjb3B5IHNyY1xuXHRcdFx0bGV0IGF0X3NyYyA9IG5ldyBVaW50OENsYW1wZWRBcnJheSh6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KTtcblxuXHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdGF0X3NlbGYuc2V0KGF0X3NyYyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIHNlbGZcblx0XHRzdXBlcihhdF9zZWxmKTtcblxuXHRcdC8vIHNhdmUgZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCBoX3RoaXMpO1xuXHR9XG5cblx0YmFzZSguLi5hX2FyZ3MpIHtcblx0XHRyZXR1cm4gbmV3IFVpbnQ4Q2xhbXBlZEFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKFVpbnQ4Q2xhbXBlZEFycmF5Uy5wcm90b3R5cGUsIHtcblx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdOiAxLFxufSk7XG5cblxuY2xhc3MgSW50MTZBcnJheVMgZXh0ZW5kcyBJbnQxNkFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmICgnbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGF0X3NlbGYgPSBuZXcgSW50MTZBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmIChzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgSW50MTZBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0XHRhdF9zZWxmLnNldCh6X2FyZ18wKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyIGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXkgPDwgMTtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQxNkFycmF5KGRzYiwgMCwgbmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgY29weSBzcmNcblx0XHRcdGxldCBhdF9zcmMgPSBuZXcgSW50MTZBcnJheSh6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KTtcblxuXHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdGF0X3NlbGYuc2V0KGF0X3NyYyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIHNlbGZcblx0XHRzdXBlcihhdF9zZWxmKTtcblxuXHRcdC8vIHNhdmUgZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCBoX3RoaXMpO1xuXHR9XG5cblx0YmFzZSguLi5hX2FyZ3MpIHtcblx0XHRyZXR1cm4gbmV3IEludDE2QXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oSW50MTZBcnJheVMucHJvdG90eXBlLCB7XG5cdFtzaGFyaW5nLiRfU0hBUkVBQkxFXTogMSxcbn0pO1xuXG5cbmNsYXNzIFVpbnQxNkFycmF5UyBleHRlbmRzIFVpbnQxNkFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmICgnbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDE2QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZiAoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQxNkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHtcblx0XHRcdC8vIGZvcmNlIG9mZnNldFxuXHRcdFx0bmJfb2Zmc2V0ID0gbmJfb2Zmc2V0IHx8IDA7XG5cblx0XHRcdC8vIG5vIGxlbmd0aDsgZGVkdWNlIGl0IGZyb20gb2Zmc2V0XG5cdFx0XHRpZiAodW5kZWZpbmVkID09PSBubF9hcnJheSkge1xuXHRcdFx0XHRubF9hcnJheSA9IHpfYXJnXzAubGVuZ3RoIC0gbmJfb2Zmc2V0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhcnJheSBzaXplIGluIGJ5dGVzXG5cdFx0XHRsZXQgbmJfYXJyYXkgPSBubF9hcnJheSA8PCAxO1xuXG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRsZXQgZHNiID0gbmV3IFNoYXJlZEFycmF5QnVmZmVyKG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIHR5cGVkIGFycmF5XG5cdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQxNkFycmF5KGRzYiwgMCwgbmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgY29weSBzcmNcblx0XHRcdGxldCBhdF9zcmMgPSBuZXcgVWludDE2QXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBVaW50MTZBcnJheSguLi5hX2FyZ3MpO1xuXHR9XG59XG5cbi8vIHN0YXRpYyBmaWVsZFxuT2JqZWN0LmFzc2lnbihVaW50MTZBcnJheVMucHJvdG90eXBlLCB7XG5cdFtzaGFyaW5nLiRfU0hBUkVBQkxFXTogMSxcbn0pO1xuXG5cbmNsYXNzIEludDMyQXJyYXlTIGV4dGVuZHMgSW50MzJBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZiAoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRhdF9zZWxmID0gbmV3IEludDMyQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZiAoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0XHRhdF9zZWxmID0gbmV3IEludDMyQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmICh1bmRlZmluZWQgPT09IG5sX2FycmF5KSB7XG5cdFx0XHRcdG5sX2FycmF5ID0gel9hcmdfMC5sZW5ndGggLSBuYl9vZmZzZXQ7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFycmF5IHNpemUgaW4gYnl0ZXNcblx0XHRcdGxldCBuYl9hcnJheSA9IG5sX2FycmF5IDw8IDI7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgSW50MzJBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IEludDMyQXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBJbnQzMkFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKEludDMyQXJyYXlTLnByb3RvdHlwZSwge1xuXHRbc2hhcmluZy4kX1NIQVJFQUJMRV06IDEsXG59KTtcblxuXG5jbGFzcyBVaW50MzJBcnJheVMgZXh0ZW5kcyBVaW50MzJBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZiAoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQzMkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYgKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50MzJBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0XHRhdF9zZWxmLnNldCh6X2FyZ18wKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyIGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXkgPDwgMjtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50MzJBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IFVpbnQzMkFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgVWludDMyQXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oVWludDMyQXJyYXlTLnByb3RvdHlwZSwge1xuXHRbc2hhcmluZy4kX1NIQVJFQUJMRV06IDEsXG59KTtcblxuXG5jbGFzcyBGbG9hdDMyQXJyYXlTIGV4dGVuZHMgRmxvYXQzMkFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmICgnbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGF0X3NlbGYgPSBuZXcgRmxvYXQzMkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYgKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBGbG9hdDMyQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmICh1bmRlZmluZWQgPT09IG5sX2FycmF5KSB7XG5cdFx0XHRcdG5sX2FycmF5ID0gel9hcmdfMC5sZW5ndGggLSBuYl9vZmZzZXQ7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFycmF5IHNpemUgaW4gYnl0ZXNcblx0XHRcdGxldCBuYl9hcnJheSA9IG5sX2FycmF5IDw8IDI7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgRmxvYXQzMkFycmF5KGRzYiwgMCwgbmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgY29weSBzcmNcblx0XHRcdGxldCBhdF9zcmMgPSBuZXcgRmxvYXQzMkFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgRmxvYXQzMkFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKEZsb2F0MzJBcnJheVMucHJvdG90eXBlLCB7XG5cdFtzaGFyaW5nLiRfU0hBUkVBQkxFXTogMSxcbn0pO1xuXG5cbmNsYXNzIEZsb2F0NjRBcnJheVMgZXh0ZW5kcyBGbG9hdDY0QXJyYXkge1xuXHRjb25zdHJ1Y3Rvcih6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KSB7XG5cdFx0Ly8gdGhpc1xuXHRcdGxldCBoX3RoaXMgPSB7fTtcblxuXHRcdC8vIHNlbGZcblx0XHRsZXQgYXRfc2VsZjtcblxuXG5cdFx0Ly8gbGVuZ3RoIGNvbnN0cnVjdG9yXG5cdFx0aWYgKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0YXRfc2VsZiA9IG5ldyBGbG9hdDY0QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZiAoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0XHRhdF9zZWxmID0gbmV3IEZsb2F0NjRBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0XHRhdF9zZWxmLnNldCh6X2FyZ18wKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyIGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXkgPDwgNDtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBGbG9hdDY0QXJyYXkoZHNiLCAwLCBuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSBjb3B5IHNyY1xuXHRcdFx0bGV0IGF0X3NyYyA9IG5ldyBGbG9hdDY0QXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBGbG9hdDY0QXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oRmxvYXQ2NEFycmF5Uy5wcm90b3R5cGUsIHtcblx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdOiAxLFxufSk7XG5cblxuXG4vLyBnbG9iYWxzXG5tb2R1bGUuZXhwb3J0cyA9IHtcblx0ZXhwb3J0czoge1xuXHRcdEFycmF5QnVmZmVyUzogU2hhcmVkQXJyYXlCdWZmZXIsXG5cdFx0QXJyYXlCdWZmZXJUOiBBcnJheUJ1ZmZlcixcblx0XHRJbnQ4QXJyYXlTOiBJbnQ4QXJyYXlTLFxuXHRcdEludDhBcnJheVQ6IEludDhBcnJheSxcblx0XHRVaW50OEFycmF5UzogVWludDhBcnJheVMsXG5cdFx0VWludDhBcnJheVQ6IFVpbnQ4QXJyYXksXG5cdFx0VWludDhDbGFtcGVkQXJyYXlTOiBVaW50OENsYW1wZWRBcnJheVMsXG5cdFx0VWludDhDbGFtcGVkQXJyYXlUOiBVaW50OENsYW1wZWRBcnJheSxcblx0XHRJbnQxNkFycmF5UzogSW50MTZBcnJheVMsXG5cdFx0SW50MTZBcnJheVQ6IEludDE2QXJyYXksXG5cdFx0VWludDE2QXJyYXlTOiBVaW50MTZBcnJheVMsXG5cdFx0VWludDE2QXJyYXlUOiBVaW50MTZBcnJheSxcblx0XHRJbnQzMkFycmF5UzogSW50MzJBcnJheVMsXG5cdFx0SW50MzJBcnJheVQ6IEludDMyQXJyYXksXG5cdFx0VWludDMyQXJyYXlTOiBVaW50MzJBcnJheVMsXG5cdFx0VWludDMyQXJyYXlUOiBVaW50MzJBcnJheSxcblx0XHRGbG9hdDMyQXJyYXlTOiBGbG9hdDMyQXJyYXlTLFxuXHRcdEZsb2F0MzJBcnJheVQ6IEZsb2F0MzJBcnJheSxcblx0XHRGbG9hdDY0QXJyYXlTOiBGbG9hdDY0QXJyYXlTLFxuXHRcdEZsb2F0NjRBcnJheVQ6IEZsb2F0NjRBcnJheSxcblx0fSxcbn07IiwiY29uc3QgZXZlbnRzID0gcmVxdWlyZSgnLi9ldmVudHMuanMnKTtcbmNvbnN0IHNoYXJpbmcgPSByZXF1aXJlKCcuL3NoYXJpbmcuanMnKTtcblxuY2xhc3Mgd29ya2VyIGV4dGVuZHMgV29ya2VyIHtcblxuXHRwb3N0UG9ydChkX3BvcnQsIGhfbXNnLCBhX3RyYW5zZmVyX3BhdGhzID0gW10pIHtcblx0XHQvLyBhcHBlbmQgcG9ydCB0byB0cmFuc2ZlciBwYXRoc1xuXHRcdGFfdHJhbnNmZXJfcGF0aHMucHVzaChbJ3BvcnQnXSk7XG5cblx0XHQvLyBzZW5kXG5cdFx0dGhpcy5wb3N0TWVzc2FnZShPYmplY3QuYXNzaWduKHtcblx0XHRcdHBvcnQ6IGRfcG9ydCxcblx0XHR9LCBoX21zZyksIGFfdHJhbnNmZXJfcGF0aHMpO1xuXHR9XG5cblx0cG9zdE1lc3NhZ2UoaF9tc2csIGFfdHJhbnNmZXJfcGF0aHMpIHtcblx0XHRsZXQgYV90cmFuc2ZlcnMgPSBbXTtcblx0XHRmb3IgKGxldCBpX3RyYW5zZmVyX3BhdGggPSAwLCBubF90cmFuc2Zlcl9wYXRocyA9IGFfdHJhbnNmZXJfcGF0aHMubGVuZ3RoOyBpX3RyYW5zZmVyX3BhdGggPCBubF90cmFuc2Zlcl9wYXRoczsgaV90cmFuc2Zlcl9wYXRoKyspIHtcblx0XHRcdGxldCBhX3BhdGggPSBhX3RyYW5zZmVyX3BhdGhzW2lfdHJhbnNmZXJfcGF0aF07XG5cblx0XHRcdGxldCB6X3dhbGsgPSBoX21zZztcblx0XHRcdGZvciAobGV0IGlfc3RlcCA9IDAsIG5sX3BhdGggPSBhX3BhdGgubGVuZ3RoOyBpX3N0ZXAgPCBubF9wYXRoOyBpX3N0ZXArKykge1xuXHRcdFx0XHR6X3dhbGsgPSB6X3dhbGtbYV9wYXRoW2lfc3RlcF1dO1xuXHRcdFx0fVxuXG5cdFx0XHRhX3RyYW5zZmVycy5wdXNoKC4uLnNoYXJpbmcuZXh0cmFjdCh6X3dhbGspKTtcblx0XHR9XG5cblx0XHRzdXBlci5wb3N0TWVzc2FnZShoX21zZywgYV90cmFuc2ZlcnMpO1xuXHR9XG59XG5cbmV2ZW50cyh3b3JrZXIucHJvdG90eXBlKTtcblxubW9kdWxlLmV4cG9ydHMgPSB3b3JrZXI7IiwiY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcblxuLy8gbG9jYWwgY2xhc3NlcyAvIGdsb2JhbHNcbmNvbnN0IHtcblx0S19TRUxGLFxuXHREQ19XT1JLRVIsXG5cdERDX0NIQU5ORUwsXG5cdEhfVFlQRURfQVJSQVlTLFxuXHRCX0JST1dTRVIsXG5cdEJfQlJPV1NFUklGWSxcblx0SFBfV09SS0VSX05PVElGSUNBVElPTixcblx0c3RyZWFtLFxuXHR3ZWJ3b3JrZXJpZnksXG59ID0gcmVxdWlyZSgnLi9hbGwvbG9jYWxzLmpzJyk7XG5cbmNvbnN0IGRlZGljYXRlZCA9IHJlcXVpcmUoJy4vYWxsL2RlZGljYXRlZC5qcycpO1xuY29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKCcuL2FsbC9tYW5pZmVzdC5qcycpO1xuY29uc3QgcG9vbCA9IHJlcXVpcmUoJy4vYWxsL3Bvb2wuanMnKTtcbmNvbnN0IHJlc3VsdCA9IHJlcXVpcmUoJy4vYWxsL3Jlc3VsdC5qcycpO1xuXG4vLyBXb3JrZXIgaXMgc3VwcG9ydGVkXG5jb25zdCBCX1dPUktFUl9TVVBQT1JURUQgPSAoJ3VuZGVmaW5lZCcgIT09IHR5cGVvZiBEQ19XT1JLRVIpO1xuXG4vLyBjb250ZXh0IGJpdG1hc2tzXG5jb25zdCBYTV9DT05URVhUX1BST0NFU1NfUEFSRU5UID0gMSA8PCAwO1xuY29uc3QgWE1fQ09OVEVYVF9QUk9DRVNTX0NISUxEID0gMSA8PCAxO1xuY29uc3QgWE1fQ09OVEVYVF9XSU5ET1cgPSAxIDw8IDI7XG5jb25zdCBYTV9DT05URVhUX1dPUktFUl9ERURJQ0FURUQgPSAxIDw8IDM7XG5jb25zdCBYTV9DT05URVhUX1dPUktFUl9TRVJWSUNFID0gMSA8PCA0O1xuY29uc3QgWE1fQ09OVEVYVF9XT1JLRVJfU0hBUkVEID0gMSA8PCA1O1xuXG5jb25zdCBYTV9DT05URVhUX1dPUktFUiA9IFhNX0NPTlRFWFRfV09SS0VSX0RFRElDQVRFRCB8IFhNX0NPTlRFWFRfV09SS0VSX1NFUlZJQ0UgfCBYTV9DT05URVhUX1dPUktFUl9TSEFSRUQ7XG5cbi8vIHNldCB0aGUgY3VycmVudCBjb250ZXh0XG5jb25zdCBYX0NPTlRFWFRfVFlQRSA9ICFCX0JST1dTRVIgP1xuXHQocHJvY2Vzcy5lbnYuV09SS0VSX0RFUFRIID8gWE1fQ09OVEVYVF9QUk9DRVNTX0NISUxEIDogWE1fQ09OVEVYVF9QUk9DRVNTX1BBUkVOVCkgOlxuXHQoJ3VuZGVmaW5lZCcgIT09IHR5cGVvZiBkb2N1bWVudCA/XG5cdFx0WE1fQ09OVEVYVF9XSU5ET1cgOlxuXHRcdCgnRGVkaWNhdGVkV29ya2VyR2xvYmFsU2NvcGUnIGluIHNlbGYgP1xuXHRcdFx0WE1fQ09OVEVYVF9XT1JLRVJfREVESUNBVEVEIDpcblx0XHRcdCgnU2hhcmVkV29ya2VyR2xvYmFsU2NvcGUnIGluIHNlbGYgP1xuXHRcdFx0XHRYTV9DT05URVhUX1dPUktFUl9TSEFSRUQgOlxuXHRcdFx0XHQoJ1NlcnZpY2VXb3JrZXJHbG9iYWxTY29wZScgaW4gc2VsZiA/XG5cdFx0XHRcdFx0WE1fQ09OVEVYVF9XT1JLRVJfU0VSVklDRSA6XG5cdFx0XHRcdFx0MCkpKSk7XG5cbi8vIHVucmVjb2duaXplZCBjb250ZXh0XG5pZiAoIVhfQ09OVEVYVF9UWVBFKSB7XG5cdHRocm93IG5ldyBFcnJvcignZmFpbGVkIHRvIGRldGVybWluZSB3aGF0IGlzIHRoZSBjdXJyZW50IGVudmlyb25tZW50L2NvbnRleHQnKTtcbn1cblxuLy8gc3Bhd25zIGEgV29ya2VyXG5sZXQgc3Bhd25fd29ya2VyID0gQl9XT1JLRVJfU1VQUE9SVEVEID9cblx0KCFCX0JST1dTRVJJRlkgP1xuXHRcdChwX3NvdXJjZSwgaF9vcHRpb25zKSA9PiBuZXcgRENfV09SS0VSKHBfc291cmNlLCBoX29wdGlvbnMpIDpcblx0XHQocF9zb3VyY2UsIGhfb3B0aW9ucykgPT4ge1xuXHRcdFx0Y29uc29sZS5lcnJvcihgRmF0YWwgZXJyb3I6IHNpbmNlIHlvdSBhcmUgdXNpbmcgYnJvd3NlcmlmeSwgeW91IG5lZWQgdG8gaW5jbHVkZSBleHBsaWNpdCAncmVxdWlyZSgpJyBzdGF0ZW1lbnRzIGZvciBhbnkgc2NyaXB0cyB5b3UgaW50ZW5kIHRvIHNwYXduIGFzIHdvcmtlcnMgZnJvbSB0aGlzIHRocmVhZGApO1xuXHRcdFx0Y29uc29sZS53YXJuKGB0cnkgdXNpbmcgdGhlIGZvbGxvd2luZyBpbnN0ZWFkOlxcblxcbmNvbnN0IHdvcmtlciA9IHJlcXVpcmUoJ3dvcmtlcicpLnNjb3BpZnkocmVxdWlyZSwgKCkgPT4ge1xcbmAgK1xuXHRcdFx0XHRgXFx0cmVxdWlyZSgnJHtwX3NvdXJjZX0nKTtcXG5cXHQvLyAuLi4gYW5kIGFueSBvdGhlciBzY3JpcHRzIHlvdSB3aWxsIHNwYXduIGZyb20gdGhpcyB0aHJlYWRcXG5gICtcblx0XHRcdFx0YH0sICd1bmRlZmluZWQnICE9PSB0eXBlb2YgYXJndW1lbnRzICYmIGFyZ3VtZW50cyk7YCk7XG5cblx0XHRcdHRocm93IG5ldyBFcnJvcihgQ2Fubm90IHNwYXduIHdvcmtlciAnJHtwX3NvdXJjZX0nYCk7XG5cdFx0fSkgOlxuXHQocF9zb3VyY2UsIGhfb3B0aW9ucykgPT4ge1xuXHRcdC8vIHdlJ3JlIGluc2lkZSBhIHdvcmtlclxuXHRcdGlmIChYX0NPTlRFWFRfVFlQRSAmIFhNX0NPTlRFWFRfV09SS0VSKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBGYXRhbCBlcnJvcjogYnJvd3NlciBkb2VzIG5vdCBzdXBwb3J0IHN1YndvcmtlcnM7IGZhaWxlZCB0byBzcGF3biAnJHtwX3NvdXJjZX0nXFxuYCArXG5cdFx0XHRcdCdGb3J0dW5hdGVseSB3b3JrZXIuanMgaGFzIGEgc29sdXRpb24gIDspJyk7XG5cdFx0XHRjb25zb2xlLndhcm4oYHRyeSB1c2luZyB0aGUgZm9sbG93aW5nIGluIHlvdXIgd29ya2VyIHNjcmlwdCB0byBzdXBwb3J0IHN1YndvcmtlcnM6XFxuXFxuYCArXG5cdFx0XHRcdGBjb25zdCB3b3JrZXIgPSByZXF1aXJlKCd3b3JrZXInKS5zY29waWZ5KHJlcXVpcmUsICgpID0+IHtcXG5gICtcblx0XHRcdFx0YFxcdHJlcXVpcmUoJyR7cF9zb3VyY2V9Jyk7XFxuYCArXG5cdFx0XHRcdGBcXHQvLyAuLi4gYW5kIGFueSBvdGhlciBzY3JpcHRzIHlvdSB3aWxsIHNwYXduIGZyb20gdGhpcyB0aHJlYWRcXG5gICtcblx0XHRcdFx0YH0sICd1bmRlZmluZWQnICE9PSB0eXBlb2YgYXJndW1lbnRzICYmIGFyZ3VtZW50cyk7YCk7XG5cdFx0fVxuXG5cdFx0dGhyb3cgbmV3IEVycm9yKGBDYW5ub3Qgc3Bhd24gd29ya2VyICR7cF9zb3VyY2V9OyAnV29ya2VyJyBpcyB1bmRlZmluZWRgKTtcblx0fTtcblxuXG5sZXQgaV9ndWlkID0gMDtcblxuY2xhc3Mgd29ya2VyIGV4dGVuZHMgc3RyZWFtLmhhbmRsZXIge1xuXHRzdGF0aWMgZnJvbV9zb3VyY2UocF9zb3VyY2UpIHtcblx0XHRyZXR1cm4gbmV3IHdvcmtlcih7XG5cdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdH0pO1xuXHR9XG5cblx0Y29uc3RydWN0b3IoaF9jb25maWcpIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0bGV0IHtcblx0XHRcdHNvdXJjZTogcF9zb3VyY2UsXG5cdFx0XHRpZDogaV9pZCA9IC0xLFxuXHRcdFx0bWFzdGVyOiBrX21hc3RlciA9IG51bGwsXG5cdFx0XHRvcHRpb25zOiBoX29wdGlvbnMgPSB7fSxcblx0XHR9ID0gaF9jb25maWc7XG5cblx0XHQvLyByZXNvbHZlIHNvdXJjZSByZWxhdGl2ZSB0byBtYXN0ZXJcblx0XHRsZXQgcGFfc291cmNlID0gQl9CUk9XU0VSID9cblx0XHRcdHBfc291cmNlIDpcblx0XHRcdHBhdGgucmVzb2x2ZShwYXRoLmRpcm5hbWUobW9kdWxlLnBhcmVudC5maWxlbmFtZSksIHBfc291cmNlKTtcblxuXHRcdC8vIG1ha2Ugd29ya2VyXG5cdFx0bGV0IGRfd29ya2VyO1xuXHRcdHRyeSB7XG5cdFx0XHRkX3dvcmtlciA9IHNwYXduX3dvcmtlcihwYV9zb3VyY2UsIGhfb3B0aW9ucyk7XG5cdFx0fSBjYXRjaCAoZV9zcGF3bikge1xuXHRcdFx0bGV0IGVfbXNnID0gbmV3IEVycm9yKCdmYWlsZWQgdG8gc3Bhd24gd29ya2VyOiAnKTtcblx0XHRcdGVfbXNnLnN0YWNrID0gZV9zcGF3bi5zdGFjaztcblx0XHRcdHRocm93IGVfbXNnO1xuXHRcdH1cblxuXHRcdGRfd29ya2VyLmV2ZW50cyh7XG5cdFx0XHRlcnJvcihlX3dvcmtlcikge1xuXHRcdFx0XHRpZiAoZV93b3JrZXIgaW5zdGFuY2VvZiBFcnJvckV2ZW50KSB7XG5cdFx0XHRcdFx0aWYgKCdsaW5lbm8nIGluIGVfd29ya2VyICYmICdzb3VyY2UnIGluIGRfd29ya2VyKSB7XG5cdFx0XHRcdFx0XHRsZXQgYV9saW5lcyA9IGRfd29ya2VyLnNvdXJjZS5zcGxpdCgnXFxuJyk7XG5cdFx0XHRcdFx0XHRsZXQgaV9saW5lX2VyciA9IGVfd29ya2VyLmxpbmVubztcblx0XHRcdFx0XHRcdGxldCBhX2RlYnVnID0gYV9saW5lcy5zbGljZShNYXRoLm1heCgwLCBpX2xpbmVfZXJyIC0gMiksIE1hdGgubWluKGFfbGluZXMubGVuZ3RoIC0gMSwgaV9saW5lX2VyciArIDIpKVxuXHRcdFx0XHRcdFx0XHQubWFwKChzX2xpbmUsIGlfbGluZSkgPT4gKDEgPT09IGlfbGluZSA/ICcqJyA6ICcgJykgKyAoKGlfbGluZV9lcnIgKyBpX2xpbmUgLSAxKSArICcnKS5wYWRTdGFydCg1KSArICc6ICcgKyBzX2xpbmUpO1xuXG5cdFx0XHRcdFx0XHQvLyByZWNyZWF0ZSBlcnJvciBtZXNzYWdlXG5cdFx0XHRcdFx0XHRlX3dvcmtlciA9IG5ldyBFcnJvcihlX3dvcmtlci5tZXNzYWdlICsgYEVycm9yIHRocm93biBpbiB3b3JrZXI6XFxuJHthX2RlYnVnLmpvaW4oJ1xcbicpfWApO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGlmICh0aGlzLnRhc2tfZXJyb3IpIHtcblx0XHRcdFx0XHRcdHRoaXMudGFza19lcnJvcihlX3dvcmtlcik7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHRocm93IGVfd29ya2VyO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBlbHNlIGlmICh0aGlzLnRhc2tfZXJyb3IpIHtcblx0XHRcdFx0XHR0aGlzLnRhc2tfZXJyb3IoZV93b3JrZXIpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgYW4gZXJyb3Igb2NjdXJlZCBvbiB3b3JrZXIuLi4gYnV0IHRoZSAnZXJyb3InIGV2ZW50IGNhbGxiYWNrIGRpZCBub3QgcmVjZWl2ZSBhbiBFcnJvckV2ZW50IG9iamVjdCEgdHJ5IGluc3BlY3RpbmcgY29uc29sZWApO1xuXHRcdFx0XHR9XG5cdFx0XHR9LFxuXG5cdFx0XHQvLyB3aGVuIHRoZXJlIGlzIGFuIGVycm9yIGNyZWF0aW5nL2NvbW11bmljYXRpbmcgd2l0aCB3b3JrZXJcblx0XHRcdG1lc3NhZ2VlcnJvcjogKGVfYWN0aW9uKSA9PiB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihlX2FjdGlvbik7XG5cdFx0XHR9LFxuXG5cdFx0XHQvLyB3aGVuIGEgd29ya2VyIHJlc3BvbmRzXG5cdFx0XHRtZXNzYWdlOiAoZF9tc2cpID0+IHtcblx0XHRcdFx0bGV0IGhfbXNnID0gZF9tc2cuZGF0YTtcblxuXHRcdFx0XHQvLyBoYW5kbGUgbWVzc2FnZVxuXHRcdFx0XHRsZXQgc19oYW5kbGUgPSAnaGFuZGxlXycgKyBoX21zZy50eXBlO1xuXHRcdFx0XHRpZiAoc19oYW5kbGUgaW4gdGhpcykge1xuXHRcdFx0XHRcdHRoaXNbc19oYW5kbGVdKGhfbXNnKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYHdvcmtlciBzZW50IGEgbWVzc2FnZSB0aGF0IGhhcyBubyBkZWZpbmVkIGhhbmRsZXI6ICcke2hfbXNnLnR5cGV9J2ApO1xuXHRcdFx0XHR9XG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdFx0aWQ6IGlfaWQsXG5cdFx0XHRtYXN0ZXI6IGtfbWFzdGVyLFxuXHRcdFx0cG9ydDogZF93b3JrZXIsXG5cdFx0XHRidXN5OiBmYWxzZSxcblx0XHRcdGF2YWlsYWJsZTogdHJ1ZSxcblx0XHRcdHRhc2tzX2Fzc2lnbmVkOiAwLFxuXHRcdFx0Y2FsbGJhY2tzOiB7fSxcblx0XHRcdGV2ZW50czoge30sXG5cdFx0XHRzdWJ3b3JrZXJzOiBbXSxcblx0XHRcdHRhc2tfZXJyb3I6IG51bGwsXG5cdFx0fSk7XG5cdH1cblxuXHRkZWJ1ZyhzX3R5cGUsIC4uLmFfaW5mbykge1xuXHRcdC8vIGNvbnNvbGUud2FybihgTSR7U3RyaW5nLmZyb21DaGFyQ29kZSg2NSt0aGlzLmlkKX0gJHtzX3R5cGV9ICR7YV9pbmZvLmxlbmd0aD8gJygnK2FfaW5mby5qb2luKCcsICcpKycpJzogJy0nfWApO1xuXHR9XG5cblx0aGFuZGxlX2Nsb3NlX3NlcnZlcihoX21zZykge1xuXHRcdERDX0NIQU5ORUwua2lsbChoX21zZy5zZXJ2ZXIpO1xuXHR9XG5cblx0aGFuZGxlX3Jlc3BvbmQoaF9tc2cpIHtcblx0XHRsZXQgaF9jYWxsYmFja3MgPSB0aGlzLmNhbGxiYWNrcztcblxuXHRcdC8vIG5vIGxvbmdlciBidXN5XG5cdFx0dGhpcy5idXN5ID0gZmFsc2U7XG5cblx0XHQvLyBncmFiIHRhc2sgaWRcblx0XHRsZXQgaV90YXNrID0gaF9tc2cuaWQ7XG5cblx0XHR0aGlzLmRlYnVnKCc8PCByZXNwb25kJywgaV90YXNrKTtcblxuXHRcdC8vIGV4ZWN1dGUgY2FsbGJhY2tcblx0XHRoX2NhbGxiYWNrc1tpX3Rhc2tdKGhfbXNnLmRhdGEsIGlfdGFzaywgdGhpcyk7XG5cblx0XHQvLyBmcmVlIGNhbGxiYWNrXG5cdFx0ZGVsZXRlIGhfY2FsbGJhY2tzW2lfdGFza107XG5cdH1cblxuXHRoYW5kbGVfbm90aWZ5KGhfbXNnKSB7XG5cdFx0aF9tc2cuZGF0YSA9IEhQX1dPUktFUl9OT1RJRklDQVRJT047XG5cblx0XHQvLyBubyBsb25nZXIgYnVzeVxuXHRcdHRoaXMuYnVzeSA9IGZhbHNlO1xuXG5cdFx0dGhpcy5kZWJ1ZygnPDwgbm90aWZ5Jyk7XG5cblx0XHR0aGlzLmhhbmRsZV9yZXNwb25kKGhfbXNnKTtcblx0fVxuXG5cdGhhbmRsZV9ldmVudChoX21zZykge1xuXHRcdC8vIGV2ZW50IGlzIGd1YXJhbnRlZWQgdG8gYmUgaGVyZTsganVzdCBjYWxsYmFjayB3aXRoIGRhdGFcblx0XHR0aGlzLmV2ZW50c1toX21zZy5pZF1baF9tc2cuZXZlbnRdKC4uLmhfbXNnLmFyZ3MpO1xuXHR9XG5cblx0aGFuZGxlX2Vycm9yKGhfbXNnKSB7XG5cdFx0bGV0IGhfZXJyb3IgPSBoX21zZy5lcnJvcjtcblx0XHRsZXQgZV9tc2cgPSBuZXcgRXJyb3IoaF9lcnJvci5tZXNzYWdlKTtcblx0XHRlX21zZy5zdGFjayA9IGhfZXJyb3Iuc3RhY2s7XG5cblx0XHRpZiAodGhpcy50YXNrX2Vycm9yKSB7XG5cdFx0XHR0aGlzLnRhc2tfZXJyb3IoZV9tc2cpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aHJvdyBlX21zZztcblx0XHR9XG5cdH1cblxuXHRoYW5kbGVfc3Bhd24oaF9tc2cpIHtcblx0XHRsZXQgcF9zb3VyY2UgPSBwYXRoLmpvaW4ocGF0aC5kaXJuYW1lKHRoaXMuc291cmNlKSwgaF9tc2cuc291cmNlKTtcblx0XHRpZiAoJy8nICE9PSBwX3NvdXJjZVswXSkgcF9zb3VyY2UgPSAnLi8nICsgcF9zb3VyY2U7XG5cblx0XHRwX3NvdXJjZSA9IGhfbXNnLnNvdXJjZTtcblx0XHRsZXQgZF9zdWJ3b3JrZXIgPSBzcGF3bl93b3JrZXIocF9zb3VyY2UpO1xuXHRcdGxldCBpX3N1YndvcmtlciA9IHRoaXMuc3Vid29ya2Vycy5wdXNoKGRfc3Vid29ya2VyKSAtIDE7XG5cblx0XHRkX3N1Yndvcmtlci5ldmVudCgnZXJyb3InLCAoZV93b3JrZXIpID0+IHtcblx0XHRcdHRoaXMucG9ydC5wb3N0TWVzc2FnZSh7XG5cdFx0XHRcdHR5cGU6ICdzdWJ3b3JrZXJfZXJyb3InLFxuXHRcdFx0XHRlcnJvcjoge1xuXHRcdFx0XHRcdG1lc3NhZ2U6IGVfd29ya2VyLm1lc3NhZ2UsXG5cdFx0XHRcdFx0ZmlsZW5hbWU6IGVfd29ya2VyLmZpbGVuYW1lLFxuXHRcdFx0XHRcdGxpbmVubzogZV93b3JrZXIubGluZW5vLFxuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cblx0XHRsZXQga19jaGFubmVsID0gbmV3IERDX0NIQU5ORUwoKTtcblxuXHRcdGtfY2hhbm5lbC5wb3J0XzEoKGRfcG9ydCkgPT4ge1xuXHRcdFx0dGhpcy5wb3J0LnBvc3RQb3J0KGRfcG9ydCwge1xuXHRcdFx0XHR0eXBlOiAnc3Vid29ya2VyJyxcblx0XHRcdFx0aWQ6IGhfbXNnLmlkLFxuXHRcdFx0XHRtYXN0ZXJfa2V5OiBpX3N1Yndvcmtlcixcblx0XHRcdH0pO1xuXHRcdH0pO1xuXG5cdFx0a19jaGFubmVsLnBvcnRfMigoZF9wb3J0KSA9PiB7XG5cdFx0XHRkX3N1Yndvcmtlci5wb3N0UG9ydChkX3BvcnQsIHtcblx0XHRcdFx0dHlwZTogJ293bmVyJyxcblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9XG5cblx0aGFuZGxlX3BpbmcoKSB7XG5cdFx0S19TRUxGLnBvc3RNZXNzYWdlKHtcblx0XHRcdHR5cGU6ICdwb25nJyxcblx0XHR9KTtcblx0fVxuXG5cdGhhbmRsZV90ZXJtaW5hdGUoaF9tc2cpIHtcblx0XHR0aGlzLnN1YndvcmtlcnNbaF9tc2cubWFzdGVyX2tleV0udGVybWluYXRlKCk7XG5cdH1cblxuXHRwcmVwYXJlKGhfdGFzaywgZmtfdGFzaywgYV9yb290cyA9IFtdKSB7XG5cdFx0bGV0IGlfdGFzayA9ICsraV9ndWlkO1xuXG5cdFx0bGV0IHtcblx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHRcdG1hbmlmZXN0OiBrX21hbmlmZXN0LFxuXHRcdFx0cmVjZWl2ZTogaV9yZWNlaXZlID0gMCxcblx0XHRcdGluaGVyaXQ6IGlfaW5oZXJpdCA9IDAsXG5cdFx0XHRob2xkOiBiX2hvbGQgPSBmYWxzZSxcblx0XHRcdGV2ZW50czogaF9ldmVudHMgPSBudWxsLFxuXHRcdH0gPSBoX3Rhc2s7XG5cblx0XHQvLyBzYXZlIGNhbGxiYWNrXG5cdFx0dGhpcy5jYWxsYmFja3NbaV90YXNrXSA9IGZrX3Rhc2s7XG5cblx0XHQvLyBzYXZlIGV2ZW50c1xuXHRcdGlmIChoX2V2ZW50cykge1xuXHRcdFx0dGhpcy5ldmVudHNbaV90YXNrXSA9IGhfZXZlbnRzO1xuXG5cdFx0XHQvLyB3aGF0IHRvIHNlbmRcblx0XHRcdGxldCBoX2V2ZW50c19zZW5kID0ge307XG5cdFx0XHRmb3IgKGxldCBzX2tleSBpbiBoX2V2ZW50cykge1xuXHRcdFx0XHRoX2V2ZW50c19zZW5kW3Nfa2V5XSA9IDE7XG5cdFx0XHR9XG5cdFx0XHRoX2V2ZW50cyA9IGhfZXZlbnRzX3NlbmQ7XG5cdFx0fVxuXG5cdFx0Ly8gc2VuZCB0YXNrXG5cdFx0cmV0dXJuIHtcblx0XHRcdG1zZzoge1xuXHRcdFx0XHR0eXBlOiAndGFzaycsXG5cdFx0XHRcdGlkOiBpX3Rhc2ssXG5cdFx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHRcdFx0YXJnczoga19tYW5pZmVzdC5kYXRhLFxuXHRcdFx0XHRyZWNlaXZlOiBpX3JlY2VpdmUsXG5cdFx0XHRcdGluaGVyaXQ6IGlfaW5oZXJpdCxcblx0XHRcdFx0aG9sZDogYl9ob2xkLFxuXHRcdFx0XHRldmVudHM6IGhfZXZlbnRzLFxuXHRcdFx0fSxcblx0XHRcdHBhdGhzOiBrX21hbmlmZXN0LnBhdGhzKC4uLmFfcm9vdHMsICdhcmdzJyksXG5cdFx0fTtcblx0fVxuXG5cdGV4ZWMoaF90YXNrX2V4ZWMsIGZrX3Rhc2spIHtcblx0XHQvLyBtYXJrIHdvcmtlciBhcyBidXN5XG5cdFx0dGhpcy5idXN5ID0gdHJ1ZTtcblxuXHRcdC8vIHByZXBhcmUgZmluYWwgdGFzayBkZXNjcmlwdG9yXG5cdFx0bGV0IGhfdGFzayA9IHRoaXMucHJlcGFyZShoX3Rhc2tfZXhlYywgZmtfdGFzayk7XG5cblx0XHR0aGlzLmRlYnVnKCdleGVjOicgKyBoX3Rhc2subXNnLmlkKTtcblxuXHRcdC8vIHBvc3QgdG8gd29ya2VyXG5cdFx0dGhpcy5wb3J0LnBvc3RNZXNzYWdlKGhfdGFzay5tc2csIGhfdGFzay5wYXRocyk7XG5cdH1cblxuXHQvLyBhc3NpZ24gYSB0YXNrIHRvIHRoZSB3b3JrZXJcblx0cnVuKHNfdGFzaywgel9hcmdzLCBoX2V2ZW50cywgZmtfcnVuKSB7XG5cdFx0Ly8gcHJlcGFyZSBmaW5hbCB0YXNrIGRlc2NyaXB0b3Jcblx0XHRsZXQgaF9leGVjID0ge1xuXHRcdFx0dGFzazogc190YXNrLFxuXHRcdFx0bWFuaWZlc3Q6IG1hbmlmZXN0LmZyb20oel9hcmdzKSxcblx0XHRcdGV2ZW50czogaF9ldmVudHMsXG5cdFx0fTtcblxuXHRcdC8vIHByZXZpb3VzIHJ1biB0YXNrXG5cdFx0aWYgKHRoaXMucHJldl9ydW5fdGFzaykge1xuXHRcdFx0aF9leGVjLmluaGVyaXQgPSB0aGlzLnByZXZfcnVuX3Rhc2s7XG5cdFx0fVxuXG5cdFx0Ly8gZXhlY3V0ZSB0YXNrXG5cdFx0bGV0IGRwX2V4ZWMgPSBuZXcgUHJvbWlzZSgoZl9yZXNvbHZlLCBmX3JlamVjdCkgPT4ge1xuXHRcdFx0dGhpcy50YXNrX2Vycm9yID0gZl9yZWplY3Q7XG5cdFx0XHR0aGlzLmV4ZWMoaF9leGVjLCAoel9yZXN1bHQsIGlfdGFzaykgPT4ge1xuXHRcdFx0XHR0aGlzLnByZXZfcnVuX3Rhc2sgPSBpX3Rhc2s7XG5cdFx0XHRcdHRoaXMudGFza19lcnJvciA9IG51bGw7XG5cdFx0XHRcdGZfcmVzb2x2ZSh6X3Jlc3VsdCk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdC8vIGVtYmVkZGVkIHJlc29sdmUvcmVqZWN0XG5cdFx0aWYgKCdmdW5jdGlvbicgPT09IHR5cGVvZiBma19ydW4pIHtcblx0XHRcdGRwX2V4ZWMudGhlbigoel9yZXN1bHQpID0+IHtcblx0XHRcdFx0ZmtfcnVuKG51bGwsIHpfcmVzdWx0KTtcblx0XHRcdH0pLmNhdGNoKChlX2V4ZWMpID0+IHtcblx0XHRcdFx0ZmtfcnVuKGVfZXhlYyk7XG5cdFx0XHR9KTtcblx0XHR9XG5cdFx0Ly8gcHJvbWlzZVxuXHRcdGVsc2Uge1xuXHRcdFx0cmV0dXJuIGRwX2V4ZWM7XG5cdFx0fVxuXHR9XG5cblx0cmVjZWl2ZShkX3BvcnQsIGhfcmVjZWl2ZSwgZmtfdGFzaykge1xuXHRcdGxldCBoX3Rhc2sgPSB0aGlzLnByZXBhcmUoaF9yZWNlaXZlLnRhc2tfcmVhZHksIGZrX3Rhc2ssIFsndGFza19yZWFkeSddKTtcblxuXHRcdHRoaXMuZGVidWcoJz4+IHJlY2VpdmU6JyArIGhfcmVjZWl2ZS5pbXBvcnQsIGhfdGFzay5tc2cuaWQsIGRfcG9ydC5uYW1lKTtcblxuXHRcdHRoaXMucG9ydC5wb3N0UG9ydChkX3BvcnQsIHtcblx0XHRcdHR5cGU6ICdyZWNlaXZlJyxcblx0XHRcdGltcG9ydDogaF9yZWNlaXZlLmltcG9ydCxcblx0XHRcdHByaW1hcnk6IGhfcmVjZWl2ZS5wcmltYXJ5LFxuXHRcdFx0dGFza19yZWFkeTogaF90YXNrLm1zZyxcblx0XHR9LCBbLi4uKGhfdGFzay5wYXRocyB8fCBbXSldKTtcblx0fVxuXG5cdHJlbGF5KGlfdGFza19zZW5kZXIsIGRfcG9ydCwgc19yZWNlaXZlcikge1xuXHRcdHRoaXMuZGVidWcoJz4+IHJlbGF5JywgaV90YXNrX3NlbmRlciwgZF9wb3J0Lm5hbWUpO1xuXG5cdFx0dGhpcy5wb3J0LnBvc3RQb3J0KGRfcG9ydCwge1xuXHRcdFx0dHlwZTogJ3JlbGF5Jyxcblx0XHRcdGlkOiBpX3Rhc2tfc2VuZGVyLFxuXHRcdH0pO1xuXHR9XG5cblx0a2lsbChzX2tpbGwpIHtcblx0XHRpZiAoQl9CUk9XU0VSKSB7XG5cdFx0XHRyZXR1cm4gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSkgPT4ge1xuXHRcdFx0XHR0aGlzLnBvcnQudGVybWluYXRlKCk7XG5cdFx0XHRcdGZfcmVzb2x2ZSgpO1xuXHRcdFx0fSk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHJldHVybiB0aGlzLnBvcnQudGVybWluYXRlKHNfa2lsbCk7XG5cdFx0fVxuXHR9XG59XG5cblxuY29uc3QgbWtfbmV3ID0gKGRjKSA9PiBmdW5jdGlvbiguLi5hX2FyZ3MpIHtcblx0cmV0dXJuIG5ldyBkYyguLi5hX2FyZ3MpO1xufTtcblxuLy8gbm93IGltcG9ydCBhbnloaW5nIHRoYXQgZGVwZW5kcyBvbiB3b3JrZXJcbmNvbnN0IGdyb3VwID0gcmVxdWlyZSgnLi9hbGwvZ3JvdXAuanMnKSh3b3JrZXIpO1xuXG5jb25zdCBIX0VYUE9SVFMgPSB7XG5cdHNwYXduKC4uLmFfYXJncykge1xuXHRcdHJldHVybiB3b3JrZXIuZnJvbV9zb3VyY2UoLi4uYV9hcmdzKTtcblx0fSxcblxuXHRuZXc6ICguLi5hX2FyZ3MpID0+IG5ldyB3b3JrZXIoLi4uYV9hcmdzKSxcblx0Z3JvdXA6IG1rX25ldyhncm91cCksXG5cdHBvb2w6IG1rX25ldyhwb29sKSxcblx0ZGVkaWNhdGVkOiBta19uZXcoZGVkaWNhdGVkKSxcblx0bWFuaWZlc3Q6IG1rX25ldyhtYW5pZmVzdCksXG5cdHJlc3VsdDogbWtfbmV3KHJlc3VsdCksXG5cblx0c3RyZWFtLFxuXHQvLyBzdHJlYW06IG1rX25ldyh3cml0YWJsZV9zdHJlYW0pLFxuXHQvLyBnZXQgc3RyZWFtKCkge1xuXHQvLyBcdGRlbGV0ZSB0aGlzLnN0cmVhbTtcblx0Ly8gXHRyZXR1cm4gdGhpcy5zdHJlYW0gPSByZXF1aXJlKCcuL3N0cmVhbS5qcycpO1xuXHQvLyB9LFxuXG5cdC8vIHN0YXRlc1xuXHRicm93c2VyOiBCX0JST1dTRVIsXG5cdGJyb3dzZXJpZnk6IEJfQlJPV1NFUklGWSxcblx0Ly8gZGVwdGg6IFdPUktFUl9ERVBUSFxuXG5cdC8vIGltcG9ydCB0eXBlZCBhcnJheXMgaW50byB0aGUgZ2l2ZW4gc2NvcGVcblx0Z2xvYmFsczogKGhfc2NvcGUgPSB7fSkgPT4gT2JqZWN0LmFzc2lnbihoX3Njb3BlLCBIX1RZUEVEX0FSUkFZUy5leHBvcnRzKSxcblxuXHQvLyBmb3IgY29tcGF0aWJpbGl0eSB3aXRoIGJyb3dzZXJpZnlcblx0c2NvcGlmeShmX3JlcXVpcmUsIGFfc291cmNlcywgZF9hcmd1bWVudHMpIHtcblx0XHQvLyBicm93c2VyaWZ5IGFyZ3VtZW50c1xuXHRcdGxldCBhX2Jyb3dzZXJpZnkgPSBkX2FyZ3VtZW50cyA/IFtkX2FyZ3VtZW50c1szXSwgZF9hcmd1bWVudHNbNF0sIGRfYXJndW1lbnRzWzVdXSA6IG51bGw7XG5cblx0XHQvLyBydW5uaW5nIGluIGJyb3dzZXJpZnlcblx0XHRpZiAoQl9CUk9XU0VSSUZZKSB7XG5cdFx0XHQvLyBjaGFuZ2UgaG93IGEgd29ya2VyIGlzIHNwYXduZWRcblx0XHRcdHNwYXduX3dvcmtlciA9IChwX3NvdXJjZSwgaF9vcHRpb25zKSA9PiB7XG5cdFx0XHRcdC8vIHdvcmthcm91bmQgZm9yIGNocm9taXVtIGJ1ZyB0aGF0IGNhbm5vdCBzcGF3biBzdWJ3b3JrZXJzXG5cdFx0XHRcdGlmICghQl9XT1JLRVJfU1VQUE9SVEVEKSB7XG5cdFx0XHRcdFx0bGV0IGtfc3Vid29ya2VyID0gbmV3IGxhdGVudF9zdWJ3b3JrZXIoKTtcblxuXHRcdFx0XHRcdC8vIHNlbmQgbWVzc2FnZSB0byBtYXN0ZXIgcmVxdWVzdGluZyBzcGF3biBvZiBuZXcgd29ya2VyXG5cdFx0XHRcdFx0S19TRUxGLnBvc3RNZXNzYWdlKHtcblx0XHRcdFx0XHRcdHR5cGU6ICdzcGF3bicsXG5cdFx0XHRcdFx0XHRpZDoga19zdWJ3b3JrZXIuaWQsXG5cdFx0XHRcdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdFx0XHRcdFx0b3B0aW9uczogaF9vcHRpb25zLFxuXHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0cmV0dXJuIGtfc3Vid29ya2VyO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIHdvcmtlciBpcyBkZWZpbmVkXG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdGxldCB6X2ltcG9ydCA9IGZfcmVxdWlyZShwX3NvdXJjZSk7XG5cdFx0XHRcdFx0cmV0dXJuIHdlYndvcmtlcmlmeSh6X2ltcG9ydCwge1xuXHRcdFx0XHRcdFx0YnJvd3NlcmlmeTogYV9icm93c2VyaWZ5LFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdC8vIG5vcm1hbCBleHBvcnRzXG5cdFx0cmV0dXJuIEhfRVhQT1JUUztcblx0fSxcblxuXHRtZXJnZV9zb3J0ZWQoYV9hLCBhX2IsIGZfY21wKSB7XG5cdFx0Ly8gb3V0cHV0IGxpc3Rcblx0XHRsZXQgYV9vdXQgPSBbXTtcblxuXHRcdC8vIGluZGV4IG9mIG5leHQgaXRlbSBmcm9tIGVhY2ggbGlzdFxuXHRcdGxldCBpX2EgPSAwO1xuXHRcdGxldCBpX2IgPSAwO1xuXG5cdFx0Ly8gY3VycmVudCBpdGVtIGZyb20gZWFjaCBsaXN0XG5cdFx0bGV0IHpfYSA9IGFfYVswXTtcblx0XHRsZXQgel9iID0gYV9iWzBdO1xuXG5cdFx0Ly8gZmluYWwgaW5kZXggb2YgZWFjaCBsaXN0XG5cdFx0bGV0IGloX2EgPSBhX2EubGVuZ3RoIC0gMTtcblx0XHRsZXQgaWhfYiA9IGFfYi5sZW5ndGggLSAxO1xuXG5cdFx0Ly8gbWVyZ2Vcblx0XHRmb3IgKDs7KSB7XG5cdFx0XHQvLyBhIHdpbnNcblx0XHRcdGlmIChmX2NtcCh6X2EsIHpfYikgPCAwKSB7XG5cdFx0XHRcdC8vIGFkZCB0byBvdXRwdXQgbGlzdFxuXHRcdFx0XHRhX291dC5wdXNoKHpfYSk7XG5cblx0XHRcdFx0Ly8gcmVhY2hlZCBlbmQgb2YgYVxuXHRcdFx0XHRpZiAoaV9hID09PSBpaF9hKSBicmVhaztcblxuXHRcdFx0XHQvLyBuZXh0IGl0ZW0gZnJvbSBhXG5cdFx0XHRcdHpfYSA9IGFfYVsrK2lfYV07XG5cdFx0XHR9XG5cdFx0XHQvLyBiIHdpbnNcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyBhZGQgdG8gb3V0cHV0IGxpc3Rcblx0XHRcdFx0YV9vdXQucHVzaCh6X2IpO1xuXG5cdFx0XHRcdC8vIHJlYWNoZWQgZW5kIG9mIGJcblx0XHRcdFx0aWYgKGlfYiA9PT0gaWhfYikgYnJlYWs7XG5cblx0XHRcdFx0Ly8gbmV4dCBpdGVtIGZyb20gYlxuXHRcdFx0XHR6X2IgPSBhX2JbKytpX2JdO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIGEgZmluaXNoZWQgZmlyc3Rcblx0XHRpZiAoaV9hID09PSBpaF9hKSB7XG5cdFx0XHQvLyBhcHBlbmQgcmVtYWluZGVyIG9mIGJcblx0XHRcdGFfb3V0LnB1c2goYV9iLnNsaWNlKGlfYikpO1xuXHRcdH1cblx0XHQvLyBiIGZpbmlzaGVkIGZpcnN0XG5cdFx0ZWxzZSB7XG5cdFx0XHQvLyBhcHBlbmQgcmVtYWluZGVyIG9mIGFcblx0XHRcdGFfb3V0LnB1c2goYV9hLnNsaWNlKGlfYSkpO1xuXHRcdH1cblxuXHRcdC8vIHJlc3VsdFxuXHRcdHJldHVybiBhX291dDtcblx0fSxcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gT2JqZWN0LmFzc2lnbihmdW5jdGlvbiguLi5hX2FyZ3MpIHtcblx0Ly8gY2FsbGVkIGZyb20gd29ya2VyXG5cdGlmIChYTV9DT05URVhUX1dPUktFUiAmIFhfQ09OVEVYVF9UWVBFKSB7XG5cdFx0Ly8gZGVkaWNhdGVkIHdvcmtlclxuXHRcdGlmIChYTV9DT05URVhUX1dPUktFUl9ERURJQ0FURUQgPT09IFhfQ09OVEVYVF9UWVBFKSB7XG5cdFx0XHRyZXR1cm4gbmV3IGRlZGljYXRlZCguLi5hX2FyZ3MpO1xuXHRcdH1cblx0XHQvLyBzaGFyZWQgd29ya2VyXG5cdFx0ZWxzZSBpZiAoWE1fQ09OVEVYVF9XT1JLRVJfU0hBUkVEID09PSBYX0NPTlRFWFRfVFlQRSkge1xuXHRcdFx0Ly8gcmV0dXJuIG5ldyBzaGFyZWQoLi4uYV9hcmdzKTtcblx0XHR9XG5cdFx0Ly8gc2VydmljZSB3b3JrZXJcblx0XHRlbHNlIGlmIChYTV9DT05URVhUX1dPUktFUl9TRVJWSUNFID09PSBYX0NPTlRFWFRfVFlQRSkge1xuXHRcdFx0Ly8gcmV0dXJuIG5ldyBzZXJ2aWNlKC4uLmFfYXJncyk7XG5cdFx0fVxuXHR9XG5cdC8vIGNoaWxkIHByb2Nlc3M7IGRlZGljYXRlZCB3b3JrZXJcblx0ZWxzZSBpZiAoWE1fQ09OVEVYVF9QUk9DRVNTX0NISUxEID09PSBYX0NPTlRFWFRfVFlQRSkge1xuXHRcdHJldHVybiBuZXcgZGVkaWNhdGVkKC4uLmFfYXJncyk7XG5cdH1cblx0Ly8gbWFzdGVyXG5cdGVsc2Uge1xuXHRcdHJldHVybiB3b3JrZXIuZnJvbV9zb3VyY2UoLi4uYV9hcmdzKTtcblx0fVxufSwgSF9FWFBPUlRTKTsiLCIndXNlIHN0cmljdCc7XG5cbi8vIGNvbXBhcmUgYW5kIGlzQnVmZmVyIHRha2VuIGZyb20gaHR0cHM6Ly9naXRodWIuY29tL2Zlcm9zcy9idWZmZXIvYmxvYi82ODBlOWU1ZTQ4OGYyMmFhYzI3NTk5YTU3ZGM4NDRhNjMxNTkyOGRkL2luZGV4LmpzXG4vLyBvcmlnaW5hbCBub3RpY2U6XG5cbi8qIVxuICogVGhlIGJ1ZmZlciBtb2R1bGUgZnJvbSBub2RlLmpzLCBmb3IgdGhlIGJyb3dzZXIuXG4gKlxuICogQGF1dGhvciAgIEZlcm9zcyBBYm91a2hhZGlqZWggPGZlcm9zc0BmZXJvc3Mub3JnPiA8aHR0cDovL2Zlcm9zcy5vcmc+XG4gKiBAbGljZW5zZSAgTUlUXG4gKi9cbmZ1bmN0aW9uIGNvbXBhcmUoYSwgYikge1xuICBpZiAoYSA9PT0gYikge1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgdmFyIHggPSBhLmxlbmd0aDtcbiAgdmFyIHkgPSBiLmxlbmd0aDtcblxuICBmb3IgKHZhciBpID0gMCwgbGVuID0gTWF0aC5taW4oeCwgeSk7IGkgPCBsZW47ICsraSkge1xuICAgIGlmIChhW2ldICE9PSBiW2ldKSB7XG4gICAgICB4ID0gYVtpXTtcbiAgICAgIHkgPSBiW2ldO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgaWYgKHggPCB5KSB7XG4gICAgcmV0dXJuIC0xO1xuICB9XG4gIGlmICh5IDwgeCkge1xuICAgIHJldHVybiAxO1xuICB9XG4gIHJldHVybiAwO1xufVxuZnVuY3Rpb24gaXNCdWZmZXIoYikge1xuICBpZiAoZ2xvYmFsLkJ1ZmZlciAmJiB0eXBlb2YgZ2xvYmFsLkJ1ZmZlci5pc0J1ZmZlciA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiBnbG9iYWwuQnVmZmVyLmlzQnVmZmVyKGIpO1xuICB9XG4gIHJldHVybiAhIShiICE9IG51bGwgJiYgYi5faXNCdWZmZXIpO1xufVxuXG4vLyBiYXNlZCBvbiBub2RlIGFzc2VydCwgb3JpZ2luYWwgbm90aWNlOlxuXG4vLyBodHRwOi8vd2lraS5jb21tb25qcy5vcmcvd2lraS9Vbml0X1Rlc3RpbmcvMS4wXG4vL1xuLy8gVEhJUyBJUyBOT1QgVEVTVEVEIE5PUiBMSUtFTFkgVE8gV09SSyBPVVRTSURFIFY4IVxuLy9cbi8vIE9yaWdpbmFsbHkgZnJvbSBuYXJ3aGFsLmpzIChodHRwOi8vbmFyd2hhbGpzLm9yZylcbi8vIENvcHlyaWdodCAoYykgMjAwOSBUaG9tYXMgUm9iaW5zb24gPDI4MG5vcnRoLmNvbT5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XG4vLyBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSAnU29mdHdhcmUnKSwgdG9cbi8vIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlXG4vLyByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Jcbi8vIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzXG4vLyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4vLyBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgJ0FTIElTJywgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuLy8gSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4vLyBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcbi8vIEFVVEhPUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOXG4vLyBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OXG4vLyBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxudmFyIHV0aWwgPSByZXF1aXJlKCd1dGlsLycpO1xudmFyIGhhc093biA9IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHk7XG52YXIgcFNsaWNlID0gQXJyYXkucHJvdG90eXBlLnNsaWNlO1xudmFyIGZ1bmN0aW9uc0hhdmVOYW1lcyA9IChmdW5jdGlvbiAoKSB7XG4gIHJldHVybiBmdW5jdGlvbiBmb28oKSB7fS5uYW1lID09PSAnZm9vJztcbn0oKSk7XG5mdW5jdGlvbiBwVG9TdHJpbmcgKG9iaikge1xuICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKG9iaik7XG59XG5mdW5jdGlvbiBpc1ZpZXcoYXJyYnVmKSB7XG4gIGlmIChpc0J1ZmZlcihhcnJidWYpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmICh0eXBlb2YgZ2xvYmFsLkFycmF5QnVmZmVyICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmICh0eXBlb2YgQXJyYXlCdWZmZXIuaXNWaWV3ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgcmV0dXJuIEFycmF5QnVmZmVyLmlzVmlldyhhcnJidWYpO1xuICB9XG4gIGlmICghYXJyYnVmKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmIChhcnJidWYgaW5zdGFuY2VvZiBEYXRhVmlldykge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmIChhcnJidWYuYnVmZmVyICYmIGFycmJ1Zi5idWZmZXIgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cbi8vIDEuIFRoZSBhc3NlcnQgbW9kdWxlIHByb3ZpZGVzIGZ1bmN0aW9ucyB0aGF0IHRocm93XG4vLyBBc3NlcnRpb25FcnJvcidzIHdoZW4gcGFydGljdWxhciBjb25kaXRpb25zIGFyZSBub3QgbWV0LiBUaGVcbi8vIGFzc2VydCBtb2R1bGUgbXVzdCBjb25mb3JtIHRvIHRoZSBmb2xsb3dpbmcgaW50ZXJmYWNlLlxuXG52YXIgYXNzZXJ0ID0gbW9kdWxlLmV4cG9ydHMgPSBvaztcblxuLy8gMi4gVGhlIEFzc2VydGlvbkVycm9yIGlzIGRlZmluZWQgaW4gYXNzZXJ0LlxuLy8gbmV3IGFzc2VydC5Bc3NlcnRpb25FcnJvcih7IG1lc3NhZ2U6IG1lc3NhZ2UsXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYWN0dWFsOiBhY3R1YWwsXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhwZWN0ZWQ6IGV4cGVjdGVkIH0pXG5cbnZhciByZWdleCA9IC9cXHMqZnVuY3Rpb25cXHMrKFteXFwoXFxzXSopXFxzKi87XG4vLyBiYXNlZCBvbiBodHRwczovL2dpdGh1Yi5jb20vbGpoYXJiL2Z1bmN0aW9uLnByb3RvdHlwZS5uYW1lL2Jsb2IvYWRlZWVlYzhiZmNjNjA2OGIxODdkN2Q5ZmIzZDViYjFkM2EzMDg5OS9pbXBsZW1lbnRhdGlvbi5qc1xuZnVuY3Rpb24gZ2V0TmFtZShmdW5jKSB7XG4gIGlmICghdXRpbC5pc0Z1bmN0aW9uKGZ1bmMpKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChmdW5jdGlvbnNIYXZlTmFtZXMpIHtcbiAgICByZXR1cm4gZnVuYy5uYW1lO1xuICB9XG4gIHZhciBzdHIgPSBmdW5jLnRvU3RyaW5nKCk7XG4gIHZhciBtYXRjaCA9IHN0ci5tYXRjaChyZWdleCk7XG4gIHJldHVybiBtYXRjaCAmJiBtYXRjaFsxXTtcbn1cbmFzc2VydC5Bc3NlcnRpb25FcnJvciA9IGZ1bmN0aW9uIEFzc2VydGlvbkVycm9yKG9wdGlvbnMpIHtcbiAgdGhpcy5uYW1lID0gJ0Fzc2VydGlvbkVycm9yJztcbiAgdGhpcy5hY3R1YWwgPSBvcHRpb25zLmFjdHVhbDtcbiAgdGhpcy5leHBlY3RlZCA9IG9wdGlvbnMuZXhwZWN0ZWQ7XG4gIHRoaXMub3BlcmF0b3IgPSBvcHRpb25zLm9wZXJhdG9yO1xuICBpZiAob3B0aW9ucy5tZXNzYWdlKSB7XG4gICAgdGhpcy5tZXNzYWdlID0gb3B0aW9ucy5tZXNzYWdlO1xuICAgIHRoaXMuZ2VuZXJhdGVkTWVzc2FnZSA9IGZhbHNlO1xuICB9IGVsc2Uge1xuICAgIHRoaXMubWVzc2FnZSA9IGdldE1lc3NhZ2UodGhpcyk7XG4gICAgdGhpcy5nZW5lcmF0ZWRNZXNzYWdlID0gdHJ1ZTtcbiAgfVxuICB2YXIgc3RhY2tTdGFydEZ1bmN0aW9uID0gb3B0aW9ucy5zdGFja1N0YXJ0RnVuY3Rpb24gfHwgZmFpbDtcbiAgaWYgKEVycm9yLmNhcHR1cmVTdGFja1RyYWNlKSB7XG4gICAgRXJyb3IuY2FwdHVyZVN0YWNrVHJhY2UodGhpcywgc3RhY2tTdGFydEZ1bmN0aW9uKTtcbiAgfSBlbHNlIHtcbiAgICAvLyBub24gdjggYnJvd3NlcnMgc28gd2UgY2FuIGhhdmUgYSBzdGFja3RyYWNlXG4gICAgdmFyIGVyciA9IG5ldyBFcnJvcigpO1xuICAgIGlmIChlcnIuc3RhY2spIHtcbiAgICAgIHZhciBvdXQgPSBlcnIuc3RhY2s7XG5cbiAgICAgIC8vIHRyeSB0byBzdHJpcCB1c2VsZXNzIGZyYW1lc1xuICAgICAgdmFyIGZuX25hbWUgPSBnZXROYW1lKHN0YWNrU3RhcnRGdW5jdGlvbik7XG4gICAgICB2YXIgaWR4ID0gb3V0LmluZGV4T2YoJ1xcbicgKyBmbl9uYW1lKTtcbiAgICAgIGlmIChpZHggPj0gMCkge1xuICAgICAgICAvLyBvbmNlIHdlIGhhdmUgbG9jYXRlZCB0aGUgZnVuY3Rpb24gZnJhbWVcbiAgICAgICAgLy8gd2UgbmVlZCB0byBzdHJpcCBvdXQgZXZlcnl0aGluZyBiZWZvcmUgaXQgKGFuZCBpdHMgbGluZSlcbiAgICAgICAgdmFyIG5leHRfbGluZSA9IG91dC5pbmRleE9mKCdcXG4nLCBpZHggKyAxKTtcbiAgICAgICAgb3V0ID0gb3V0LnN1YnN0cmluZyhuZXh0X2xpbmUgKyAxKTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5zdGFjayA9IG91dDtcbiAgICB9XG4gIH1cbn07XG5cbi8vIGFzc2VydC5Bc3NlcnRpb25FcnJvciBpbnN0YW5jZW9mIEVycm9yXG51dGlsLmluaGVyaXRzKGFzc2VydC5Bc3NlcnRpb25FcnJvciwgRXJyb3IpO1xuXG5mdW5jdGlvbiB0cnVuY2F0ZShzLCBuKSB7XG4gIGlmICh0eXBlb2YgcyA9PT0gJ3N0cmluZycpIHtcbiAgICByZXR1cm4gcy5sZW5ndGggPCBuID8gcyA6IHMuc2xpY2UoMCwgbik7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIHM7XG4gIH1cbn1cbmZ1bmN0aW9uIGluc3BlY3Qoc29tZXRoaW5nKSB7XG4gIGlmIChmdW5jdGlvbnNIYXZlTmFtZXMgfHwgIXV0aWwuaXNGdW5jdGlvbihzb21ldGhpbmcpKSB7XG4gICAgcmV0dXJuIHV0aWwuaW5zcGVjdChzb21ldGhpbmcpO1xuICB9XG4gIHZhciByYXduYW1lID0gZ2V0TmFtZShzb21ldGhpbmcpO1xuICB2YXIgbmFtZSA9IHJhd25hbWUgPyAnOiAnICsgcmF3bmFtZSA6ICcnO1xuICByZXR1cm4gJ1tGdW5jdGlvbicgKyAgbmFtZSArICddJztcbn1cbmZ1bmN0aW9uIGdldE1lc3NhZ2Uoc2VsZikge1xuICByZXR1cm4gdHJ1bmNhdGUoaW5zcGVjdChzZWxmLmFjdHVhbCksIDEyOCkgKyAnICcgK1xuICAgICAgICAgc2VsZi5vcGVyYXRvciArICcgJyArXG4gICAgICAgICB0cnVuY2F0ZShpbnNwZWN0KHNlbGYuZXhwZWN0ZWQpLCAxMjgpO1xufVxuXG4vLyBBdCBwcmVzZW50IG9ubHkgdGhlIHRocmVlIGtleXMgbWVudGlvbmVkIGFib3ZlIGFyZSB1c2VkIGFuZFxuLy8gdW5kZXJzdG9vZCBieSB0aGUgc3BlYy4gSW1wbGVtZW50YXRpb25zIG9yIHN1YiBtb2R1bGVzIGNhbiBwYXNzXG4vLyBvdGhlciBrZXlzIHRvIHRoZSBBc3NlcnRpb25FcnJvcidzIGNvbnN0cnVjdG9yIC0gdGhleSB3aWxsIGJlXG4vLyBpZ25vcmVkLlxuXG4vLyAzLiBBbGwgb2YgdGhlIGZvbGxvd2luZyBmdW5jdGlvbnMgbXVzdCB0aHJvdyBhbiBBc3NlcnRpb25FcnJvclxuLy8gd2hlbiBhIGNvcnJlc3BvbmRpbmcgY29uZGl0aW9uIGlzIG5vdCBtZXQsIHdpdGggYSBtZXNzYWdlIHRoYXRcbi8vIG1heSBiZSB1bmRlZmluZWQgaWYgbm90IHByb3ZpZGVkLiAgQWxsIGFzc2VydGlvbiBtZXRob2RzIHByb3ZpZGVcbi8vIGJvdGggdGhlIGFjdHVhbCBhbmQgZXhwZWN0ZWQgdmFsdWVzIHRvIHRoZSBhc3NlcnRpb24gZXJyb3IgZm9yXG4vLyBkaXNwbGF5IHB1cnBvc2VzLlxuXG5mdW5jdGlvbiBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsIG9wZXJhdG9yLCBzdGFja1N0YXJ0RnVuY3Rpb24pIHtcbiAgdGhyb3cgbmV3IGFzc2VydC5Bc3NlcnRpb25FcnJvcih7XG4gICAgbWVzc2FnZTogbWVzc2FnZSxcbiAgICBhY3R1YWw6IGFjdHVhbCxcbiAgICBleHBlY3RlZDogZXhwZWN0ZWQsXG4gICAgb3BlcmF0b3I6IG9wZXJhdG9yLFxuICAgIHN0YWNrU3RhcnRGdW5jdGlvbjogc3RhY2tTdGFydEZ1bmN0aW9uXG4gIH0pO1xufVxuXG4vLyBFWFRFTlNJT04hIGFsbG93cyBmb3Igd2VsbCBiZWhhdmVkIGVycm9ycyBkZWZpbmVkIGVsc2V3aGVyZS5cbmFzc2VydC5mYWlsID0gZmFpbDtcblxuLy8gNC4gUHVyZSBhc3NlcnRpb24gdGVzdHMgd2hldGhlciBhIHZhbHVlIGlzIHRydXRoeSwgYXMgZGV0ZXJtaW5lZFxuLy8gYnkgISFndWFyZC5cbi8vIGFzc2VydC5vayhndWFyZCwgbWVzc2FnZV9vcHQpO1xuLy8gVGhpcyBzdGF0ZW1lbnQgaXMgZXF1aXZhbGVudCB0byBhc3NlcnQuZXF1YWwodHJ1ZSwgISFndWFyZCxcbi8vIG1lc3NhZ2Vfb3B0KTsuIFRvIHRlc3Qgc3RyaWN0bHkgZm9yIHRoZSB2YWx1ZSB0cnVlLCB1c2Vcbi8vIGFzc2VydC5zdHJpY3RFcXVhbCh0cnVlLCBndWFyZCwgbWVzc2FnZV9vcHQpOy5cblxuZnVuY3Rpb24gb2sodmFsdWUsIG1lc3NhZ2UpIHtcbiAgaWYgKCF2YWx1ZSkgZmFpbCh2YWx1ZSwgdHJ1ZSwgbWVzc2FnZSwgJz09JywgYXNzZXJ0Lm9rKTtcbn1cbmFzc2VydC5vayA9IG9rO1xuXG4vLyA1LiBUaGUgZXF1YWxpdHkgYXNzZXJ0aW9uIHRlc3RzIHNoYWxsb3csIGNvZXJjaXZlIGVxdWFsaXR5IHdpdGhcbi8vID09LlxuLy8gYXNzZXJ0LmVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2Vfb3B0KTtcblxuYXNzZXJ0LmVxdWFsID0gZnVuY3Rpb24gZXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICBpZiAoYWN0dWFsICE9IGV4cGVjdGVkKSBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsICc9PScsIGFzc2VydC5lcXVhbCk7XG59O1xuXG4vLyA2LiBUaGUgbm9uLWVxdWFsaXR5IGFzc2VydGlvbiB0ZXN0cyBmb3Igd2hldGhlciB0d28gb2JqZWN0cyBhcmUgbm90IGVxdWFsXG4vLyB3aXRoICE9IGFzc2VydC5ub3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlX29wdCk7XG5cbmFzc2VydC5ub3RFcXVhbCA9IGZ1bmN0aW9uIG5vdEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgaWYgKGFjdHVhbCA9PSBleHBlY3RlZCkge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJyE9JywgYXNzZXJ0Lm5vdEVxdWFsKTtcbiAgfVxufTtcblxuLy8gNy4gVGhlIGVxdWl2YWxlbmNlIGFzc2VydGlvbiB0ZXN0cyBhIGRlZXAgZXF1YWxpdHkgcmVsYXRpb24uXG4vLyBhc3NlcnQuZGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2Vfb3B0KTtcblxuYXNzZXJ0LmRlZXBFcXVhbCA9IGZ1bmN0aW9uIGRlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmICghX2RlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBmYWxzZSkpIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsICdkZWVwRXF1YWwnLCBhc3NlcnQuZGVlcEVxdWFsKTtcbiAgfVxufTtcblxuYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCA9IGZ1bmN0aW9uIGRlZXBTdHJpY3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmICghX2RlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCB0cnVlKSkge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJ2RlZXBTdHJpY3RFcXVhbCcsIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwpO1xuICB9XG59O1xuXG5mdW5jdGlvbiBfZGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIHN0cmljdCwgbWVtb3MpIHtcbiAgLy8gNy4xLiBBbGwgaWRlbnRpY2FsIHZhbHVlcyBhcmUgZXF1aXZhbGVudCwgYXMgZGV0ZXJtaW5lZCBieSA9PT0uXG4gIGlmIChhY3R1YWwgPT09IGV4cGVjdGVkKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gZWxzZSBpZiAoaXNCdWZmZXIoYWN0dWFsKSAmJiBpc0J1ZmZlcihleHBlY3RlZCkpIHtcbiAgICByZXR1cm4gY29tcGFyZShhY3R1YWwsIGV4cGVjdGVkKSA9PT0gMDtcblxuICAvLyA3LjIuIElmIHRoZSBleHBlY3RlZCB2YWx1ZSBpcyBhIERhdGUgb2JqZWN0LCB0aGUgYWN0dWFsIHZhbHVlIGlzXG4gIC8vIGVxdWl2YWxlbnQgaWYgaXQgaXMgYWxzbyBhIERhdGUgb2JqZWN0IHRoYXQgcmVmZXJzIHRvIHRoZSBzYW1lIHRpbWUuXG4gIH0gZWxzZSBpZiAodXRpbC5pc0RhdGUoYWN0dWFsKSAmJiB1dGlsLmlzRGF0ZShleHBlY3RlZCkpIHtcbiAgICByZXR1cm4gYWN0dWFsLmdldFRpbWUoKSA9PT0gZXhwZWN0ZWQuZ2V0VGltZSgpO1xuXG4gIC8vIDcuMyBJZiB0aGUgZXhwZWN0ZWQgdmFsdWUgaXMgYSBSZWdFeHAgb2JqZWN0LCB0aGUgYWN0dWFsIHZhbHVlIGlzXG4gIC8vIGVxdWl2YWxlbnQgaWYgaXQgaXMgYWxzbyBhIFJlZ0V4cCBvYmplY3Qgd2l0aCB0aGUgc2FtZSBzb3VyY2UgYW5kXG4gIC8vIHByb3BlcnRpZXMgKGBnbG9iYWxgLCBgbXVsdGlsaW5lYCwgYGxhc3RJbmRleGAsIGBpZ25vcmVDYXNlYCkuXG4gIH0gZWxzZSBpZiAodXRpbC5pc1JlZ0V4cChhY3R1YWwpICYmIHV0aWwuaXNSZWdFeHAoZXhwZWN0ZWQpKSB7XG4gICAgcmV0dXJuIGFjdHVhbC5zb3VyY2UgPT09IGV4cGVjdGVkLnNvdXJjZSAmJlxuICAgICAgICAgICBhY3R1YWwuZ2xvYmFsID09PSBleHBlY3RlZC5nbG9iYWwgJiZcbiAgICAgICAgICAgYWN0dWFsLm11bHRpbGluZSA9PT0gZXhwZWN0ZWQubXVsdGlsaW5lICYmXG4gICAgICAgICAgIGFjdHVhbC5sYXN0SW5kZXggPT09IGV4cGVjdGVkLmxhc3RJbmRleCAmJlxuICAgICAgICAgICBhY3R1YWwuaWdub3JlQ2FzZSA9PT0gZXhwZWN0ZWQuaWdub3JlQ2FzZTtcblxuICAvLyA3LjQuIE90aGVyIHBhaXJzIHRoYXQgZG8gbm90IGJvdGggcGFzcyB0eXBlb2YgdmFsdWUgPT0gJ29iamVjdCcsXG4gIC8vIGVxdWl2YWxlbmNlIGlzIGRldGVybWluZWQgYnkgPT0uXG4gIH0gZWxzZSBpZiAoKGFjdHVhbCA9PT0gbnVsbCB8fCB0eXBlb2YgYWN0dWFsICE9PSAnb2JqZWN0JykgJiZcbiAgICAgICAgICAgICAoZXhwZWN0ZWQgPT09IG51bGwgfHwgdHlwZW9mIGV4cGVjdGVkICE9PSAnb2JqZWN0JykpIHtcbiAgICByZXR1cm4gc3RyaWN0ID8gYWN0dWFsID09PSBleHBlY3RlZCA6IGFjdHVhbCA9PSBleHBlY3RlZDtcblxuICAvLyBJZiBib3RoIHZhbHVlcyBhcmUgaW5zdGFuY2VzIG9mIHR5cGVkIGFycmF5cywgd3JhcCB0aGVpciB1bmRlcmx5aW5nXG4gIC8vIEFycmF5QnVmZmVycyBpbiBhIEJ1ZmZlciBlYWNoIHRvIGluY3JlYXNlIHBlcmZvcm1hbmNlXG4gIC8vIFRoaXMgb3B0aW1pemF0aW9uIHJlcXVpcmVzIHRoZSBhcnJheXMgdG8gaGF2ZSB0aGUgc2FtZSB0eXBlIGFzIGNoZWNrZWQgYnlcbiAgLy8gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZyAoYWthIHBUb1N0cmluZykuIE5ldmVyIHBlcmZvcm0gYmluYXJ5XG4gIC8vIGNvbXBhcmlzb25zIGZvciBGbG9hdCpBcnJheXMsIHRob3VnaCwgc2luY2UgZS5nLiArMCA9PT0gLTAgYnV0IHRoZWlyXG4gIC8vIGJpdCBwYXR0ZXJucyBhcmUgbm90IGlkZW50aWNhbC5cbiAgfSBlbHNlIGlmIChpc1ZpZXcoYWN0dWFsKSAmJiBpc1ZpZXcoZXhwZWN0ZWQpICYmXG4gICAgICAgICAgICAgcFRvU3RyaW5nKGFjdHVhbCkgPT09IHBUb1N0cmluZyhleHBlY3RlZCkgJiZcbiAgICAgICAgICAgICAhKGFjdHVhbCBpbnN0YW5jZW9mIEZsb2F0MzJBcnJheSB8fFxuICAgICAgICAgICAgICAgYWN0dWFsIGluc3RhbmNlb2YgRmxvYXQ2NEFycmF5KSkge1xuICAgIHJldHVybiBjb21wYXJlKG5ldyBVaW50OEFycmF5KGFjdHVhbC5idWZmZXIpLFxuICAgICAgICAgICAgICAgICAgIG5ldyBVaW50OEFycmF5KGV4cGVjdGVkLmJ1ZmZlcikpID09PSAwO1xuXG4gIC8vIDcuNSBGb3IgYWxsIG90aGVyIE9iamVjdCBwYWlycywgaW5jbHVkaW5nIEFycmF5IG9iamVjdHMsIGVxdWl2YWxlbmNlIGlzXG4gIC8vIGRldGVybWluZWQgYnkgaGF2aW5nIHRoZSBzYW1lIG51bWJlciBvZiBvd25lZCBwcm9wZXJ0aWVzIChhcyB2ZXJpZmllZFxuICAvLyB3aXRoIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCksIHRoZSBzYW1lIHNldCBvZiBrZXlzXG4gIC8vIChhbHRob3VnaCBub3QgbmVjZXNzYXJpbHkgdGhlIHNhbWUgb3JkZXIpLCBlcXVpdmFsZW50IHZhbHVlcyBmb3IgZXZlcnlcbiAgLy8gY29ycmVzcG9uZGluZyBrZXksIGFuZCBhbiBpZGVudGljYWwgJ3Byb3RvdHlwZScgcHJvcGVydHkuIE5vdGU6IHRoaXNcbiAgLy8gYWNjb3VudHMgZm9yIGJvdGggbmFtZWQgYW5kIGluZGV4ZWQgcHJvcGVydGllcyBvbiBBcnJheXMuXG4gIH0gZWxzZSBpZiAoaXNCdWZmZXIoYWN0dWFsKSAhPT0gaXNCdWZmZXIoZXhwZWN0ZWQpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9IGVsc2Uge1xuICAgIG1lbW9zID0gbWVtb3MgfHwge2FjdHVhbDogW10sIGV4cGVjdGVkOiBbXX07XG5cbiAgICB2YXIgYWN0dWFsSW5kZXggPSBtZW1vcy5hY3R1YWwuaW5kZXhPZihhY3R1YWwpO1xuICAgIGlmIChhY3R1YWxJbmRleCAhPT0gLTEpIHtcbiAgICAgIGlmIChhY3R1YWxJbmRleCA9PT0gbWVtb3MuZXhwZWN0ZWQuaW5kZXhPZihleHBlY3RlZCkpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgbWVtb3MuYWN0dWFsLnB1c2goYWN0dWFsKTtcbiAgICBtZW1vcy5leHBlY3RlZC5wdXNoKGV4cGVjdGVkKTtcblxuICAgIHJldHVybiBvYmpFcXVpdihhY3R1YWwsIGV4cGVjdGVkLCBzdHJpY3QsIG1lbW9zKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpc0FyZ3VtZW50cyhvYmplY3QpIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChvYmplY3QpID09ICdbb2JqZWN0IEFyZ3VtZW50c10nO1xufVxuXG5mdW5jdGlvbiBvYmpFcXVpdihhLCBiLCBzdHJpY3QsIGFjdHVhbFZpc2l0ZWRPYmplY3RzKSB7XG4gIGlmIChhID09PSBudWxsIHx8IGEgPT09IHVuZGVmaW5lZCB8fCBiID09PSBudWxsIHx8IGIgPT09IHVuZGVmaW5lZClcbiAgICByZXR1cm4gZmFsc2U7XG4gIC8vIGlmIG9uZSBpcyBhIHByaW1pdGl2ZSwgdGhlIG90aGVyIG11c3QgYmUgc2FtZVxuICBpZiAodXRpbC5pc1ByaW1pdGl2ZShhKSB8fCB1dGlsLmlzUHJpbWl0aXZlKGIpKVxuICAgIHJldHVybiBhID09PSBiO1xuICBpZiAoc3RyaWN0ICYmIE9iamVjdC5nZXRQcm90b3R5cGVPZihhKSAhPT0gT2JqZWN0LmdldFByb3RvdHlwZU9mKGIpKVxuICAgIHJldHVybiBmYWxzZTtcbiAgdmFyIGFJc0FyZ3MgPSBpc0FyZ3VtZW50cyhhKTtcbiAgdmFyIGJJc0FyZ3MgPSBpc0FyZ3VtZW50cyhiKTtcbiAgaWYgKChhSXNBcmdzICYmICFiSXNBcmdzKSB8fCAoIWFJc0FyZ3MgJiYgYklzQXJncykpXG4gICAgcmV0dXJuIGZhbHNlO1xuICBpZiAoYUlzQXJncykge1xuICAgIGEgPSBwU2xpY2UuY2FsbChhKTtcbiAgICBiID0gcFNsaWNlLmNhbGwoYik7XG4gICAgcmV0dXJuIF9kZWVwRXF1YWwoYSwgYiwgc3RyaWN0KTtcbiAgfVxuICB2YXIga2EgPSBvYmplY3RLZXlzKGEpO1xuICB2YXIga2IgPSBvYmplY3RLZXlzKGIpO1xuICB2YXIga2V5LCBpO1xuICAvLyBoYXZpbmcgdGhlIHNhbWUgbnVtYmVyIG9mIG93bmVkIHByb3BlcnRpZXMgKGtleXMgaW5jb3Jwb3JhdGVzXG4gIC8vIGhhc093blByb3BlcnR5KVxuICBpZiAoa2EubGVuZ3RoICE9PSBrYi5sZW5ndGgpXG4gICAgcmV0dXJuIGZhbHNlO1xuICAvL3RoZSBzYW1lIHNldCBvZiBrZXlzIChhbHRob3VnaCBub3QgbmVjZXNzYXJpbHkgdGhlIHNhbWUgb3JkZXIpLFxuICBrYS5zb3J0KCk7XG4gIGtiLnNvcnQoKTtcbiAgLy9+fn5jaGVhcCBrZXkgdGVzdFxuICBmb3IgKGkgPSBrYS5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGlmIChrYVtpXSAhPT0ga2JbaV0pXG4gICAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgLy9lcXVpdmFsZW50IHZhbHVlcyBmb3IgZXZlcnkgY29ycmVzcG9uZGluZyBrZXksIGFuZFxuICAvL35+fnBvc3NpYmx5IGV4cGVuc2l2ZSBkZWVwIHRlc3RcbiAgZm9yIChpID0ga2EubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICBrZXkgPSBrYVtpXTtcbiAgICBpZiAoIV9kZWVwRXF1YWwoYVtrZXldLCBiW2tleV0sIHN0cmljdCwgYWN0dWFsVmlzaXRlZE9iamVjdHMpKVxuICAgICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyA4LiBUaGUgbm9uLWVxdWl2YWxlbmNlIGFzc2VydGlvbiB0ZXN0cyBmb3IgYW55IGRlZXAgaW5lcXVhbGl0eS5cbi8vIGFzc2VydC5ub3REZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZV9vcHQpO1xuXG5hc3NlcnQubm90RGVlcEVxdWFsID0gZnVuY3Rpb24gbm90RGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgaWYgKF9kZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgZmFsc2UpKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnbm90RGVlcEVxdWFsJywgYXNzZXJ0Lm5vdERlZXBFcXVhbCk7XG4gIH1cbn07XG5cbmFzc2VydC5ub3REZWVwU3RyaWN0RXF1YWwgPSBub3REZWVwU3RyaWN0RXF1YWw7XG5mdW5jdGlvbiBub3REZWVwU3RyaWN0RXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICBpZiAoX2RlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCB0cnVlKSkge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJ25vdERlZXBTdHJpY3RFcXVhbCcsIG5vdERlZXBTdHJpY3RFcXVhbCk7XG4gIH1cbn1cblxuXG4vLyA5LiBUaGUgc3RyaWN0IGVxdWFsaXR5IGFzc2VydGlvbiB0ZXN0cyBzdHJpY3QgZXF1YWxpdHksIGFzIGRldGVybWluZWQgYnkgPT09LlxuLy8gYXNzZXJ0LnN0cmljdEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2Vfb3B0KTtcblxuYXNzZXJ0LnN0cmljdEVxdWFsID0gZnVuY3Rpb24gc3RyaWN0RXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICBpZiAoYWN0dWFsICE9PSBleHBlY3RlZCkge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJz09PScsIGFzc2VydC5zdHJpY3RFcXVhbCk7XG4gIH1cbn07XG5cbi8vIDEwLiBUaGUgc3RyaWN0IG5vbi1lcXVhbGl0eSBhc3NlcnRpb24gdGVzdHMgZm9yIHN0cmljdCBpbmVxdWFsaXR5LCBhc1xuLy8gZGV0ZXJtaW5lZCBieSAhPT0uICBhc3NlcnQubm90U3RyaWN0RXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZV9vcHQpO1xuXG5hc3NlcnQubm90U3RyaWN0RXF1YWwgPSBmdW5jdGlvbiBub3RTdHJpY3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmIChhY3R1YWwgPT09IGV4cGVjdGVkKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnIT09JywgYXNzZXJ0Lm5vdFN0cmljdEVxdWFsKTtcbiAgfVxufTtcblxuZnVuY3Rpb24gZXhwZWN0ZWRFeGNlcHRpb24oYWN0dWFsLCBleHBlY3RlZCkge1xuICBpZiAoIWFjdHVhbCB8fCAhZXhwZWN0ZWQpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBpZiAoT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKGV4cGVjdGVkKSA9PSAnW29iamVjdCBSZWdFeHBdJykge1xuICAgIHJldHVybiBleHBlY3RlZC50ZXN0KGFjdHVhbCk7XG4gIH1cblxuICB0cnkge1xuICAgIGlmIChhY3R1YWwgaW5zdGFuY2VvZiBleHBlY3RlZCkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgLy8gSWdub3JlLiAgVGhlIGluc3RhbmNlb2YgY2hlY2sgZG9lc24ndCB3b3JrIGZvciBhcnJvdyBmdW5jdGlvbnMuXG4gIH1cblxuICBpZiAoRXJyb3IuaXNQcm90b3R5cGVPZihleHBlY3RlZCkpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICByZXR1cm4gZXhwZWN0ZWQuY2FsbCh7fSwgYWN0dWFsKSA9PT0gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gX3RyeUJsb2NrKGJsb2NrKSB7XG4gIHZhciBlcnJvcjtcbiAgdHJ5IHtcbiAgICBibG9jaygpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgZXJyb3IgPSBlO1xuICB9XG4gIHJldHVybiBlcnJvcjtcbn1cblxuZnVuY3Rpb24gX3Rocm93cyhzaG91bGRUaHJvdywgYmxvY2ssIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIHZhciBhY3R1YWw7XG5cbiAgaWYgKHR5cGVvZiBibG9jayAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1wiYmxvY2tcIiBhcmd1bWVudCBtdXN0IGJlIGEgZnVuY3Rpb24nKTtcbiAgfVxuXG4gIGlmICh0eXBlb2YgZXhwZWN0ZWQgPT09ICdzdHJpbmcnKSB7XG4gICAgbWVzc2FnZSA9IGV4cGVjdGVkO1xuICAgIGV4cGVjdGVkID0gbnVsbDtcbiAgfVxuXG4gIGFjdHVhbCA9IF90cnlCbG9jayhibG9jayk7XG5cbiAgbWVzc2FnZSA9IChleHBlY3RlZCAmJiBleHBlY3RlZC5uYW1lID8gJyAoJyArIGV4cGVjdGVkLm5hbWUgKyAnKS4nIDogJy4nKSArXG4gICAgICAgICAgICAobWVzc2FnZSA/ICcgJyArIG1lc3NhZ2UgOiAnLicpO1xuXG4gIGlmIChzaG91bGRUaHJvdyAmJiAhYWN0dWFsKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCAnTWlzc2luZyBleHBlY3RlZCBleGNlcHRpb24nICsgbWVzc2FnZSk7XG4gIH1cblxuICB2YXIgdXNlclByb3ZpZGVkTWVzc2FnZSA9IHR5cGVvZiBtZXNzYWdlID09PSAnc3RyaW5nJztcbiAgdmFyIGlzVW53YW50ZWRFeGNlcHRpb24gPSAhc2hvdWxkVGhyb3cgJiYgdXRpbC5pc0Vycm9yKGFjdHVhbCk7XG4gIHZhciBpc1VuZXhwZWN0ZWRFeGNlcHRpb24gPSAhc2hvdWxkVGhyb3cgJiYgYWN0dWFsICYmICFleHBlY3RlZDtcblxuICBpZiAoKGlzVW53YW50ZWRFeGNlcHRpb24gJiZcbiAgICAgIHVzZXJQcm92aWRlZE1lc3NhZ2UgJiZcbiAgICAgIGV4cGVjdGVkRXhjZXB0aW9uKGFjdHVhbCwgZXhwZWN0ZWQpKSB8fFxuICAgICAgaXNVbmV4cGVjdGVkRXhjZXB0aW9uKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCAnR290IHVud2FudGVkIGV4Y2VwdGlvbicgKyBtZXNzYWdlKTtcbiAgfVxuXG4gIGlmICgoc2hvdWxkVGhyb3cgJiYgYWN0dWFsICYmIGV4cGVjdGVkICYmXG4gICAgICAhZXhwZWN0ZWRFeGNlcHRpb24oYWN0dWFsLCBleHBlY3RlZCkpIHx8ICghc2hvdWxkVGhyb3cgJiYgYWN0dWFsKSkge1xuICAgIHRocm93IGFjdHVhbDtcbiAgfVxufVxuXG4vLyAxMS4gRXhwZWN0ZWQgdG8gdGhyb3cgYW4gZXJyb3I6XG4vLyBhc3NlcnQudGhyb3dzKGJsb2NrLCBFcnJvcl9vcHQsIG1lc3NhZ2Vfb3B0KTtcblxuYXNzZXJ0LnRocm93cyA9IGZ1bmN0aW9uKGJsb2NrLCAvKm9wdGlvbmFsKi9lcnJvciwgLypvcHRpb25hbCovbWVzc2FnZSkge1xuICBfdGhyb3dzKHRydWUsIGJsb2NrLCBlcnJvciwgbWVzc2FnZSk7XG59O1xuXG4vLyBFWFRFTlNJT04hIFRoaXMgaXMgYW5ub3lpbmcgdG8gd3JpdGUgb3V0c2lkZSB0aGlzIG1vZHVsZS5cbmFzc2VydC5kb2VzTm90VGhyb3cgPSBmdW5jdGlvbihibG9jaywgLypvcHRpb25hbCovZXJyb3IsIC8qb3B0aW9uYWwqL21lc3NhZ2UpIHtcbiAgX3Rocm93cyhmYWxzZSwgYmxvY2ssIGVycm9yLCBtZXNzYWdlKTtcbn07XG5cbmFzc2VydC5pZkVycm9yID0gZnVuY3Rpb24oZXJyKSB7IGlmIChlcnIpIHRocm93IGVycjsgfTtcblxudmFyIG9iamVjdEtleXMgPSBPYmplY3Qua2V5cyB8fCBmdW5jdGlvbiAob2JqKSB7XG4gIHZhciBrZXlzID0gW107XG4gIGZvciAodmFyIGtleSBpbiBvYmopIHtcbiAgICBpZiAoaGFzT3duLmNhbGwob2JqLCBrZXkpKSBrZXlzLnB1c2goa2V5KTtcbiAgfVxuICByZXR1cm4ga2V5cztcbn07XG4iLCIiLCIvLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxuZnVuY3Rpb24gRXZlbnRFbWl0dGVyKCkge1xuICB0aGlzLl9ldmVudHMgPSB0aGlzLl9ldmVudHMgfHwge307XG4gIHRoaXMuX21heExpc3RlbmVycyA9IHRoaXMuX21heExpc3RlbmVycyB8fCB1bmRlZmluZWQ7XG59XG5tb2R1bGUuZXhwb3J0cyA9IEV2ZW50RW1pdHRlcjtcblxuLy8gQmFja3dhcmRzLWNvbXBhdCB3aXRoIG5vZGUgMC4xMC54XG5FdmVudEVtaXR0ZXIuRXZlbnRFbWl0dGVyID0gRXZlbnRFbWl0dGVyO1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLl9ldmVudHMgPSB1bmRlZmluZWQ7XG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLl9tYXhMaXN0ZW5lcnMgPSB1bmRlZmluZWQ7XG5cbi8vIEJ5IGRlZmF1bHQgRXZlbnRFbWl0dGVycyB3aWxsIHByaW50IGEgd2FybmluZyBpZiBtb3JlIHRoYW4gMTAgbGlzdGVuZXJzIGFyZVxuLy8gYWRkZWQgdG8gaXQuIFRoaXMgaXMgYSB1c2VmdWwgZGVmYXVsdCB3aGljaCBoZWxwcyBmaW5kaW5nIG1lbW9yeSBsZWFrcy5cbkV2ZW50RW1pdHRlci5kZWZhdWx0TWF4TGlzdGVuZXJzID0gMTA7XG5cbi8vIE9idmlvdXNseSBub3QgYWxsIEVtaXR0ZXJzIHNob3VsZCBiZSBsaW1pdGVkIHRvIDEwLiBUaGlzIGZ1bmN0aW9uIGFsbG93c1xuLy8gdGhhdCB0byBiZSBpbmNyZWFzZWQuIFNldCB0byB6ZXJvIGZvciB1bmxpbWl0ZWQuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLnNldE1heExpc3RlbmVycyA9IGZ1bmN0aW9uKG4pIHtcbiAgaWYgKCFpc051bWJlcihuKSB8fCBuIDwgMCB8fCBpc05hTihuKSlcbiAgICB0aHJvdyBUeXBlRXJyb3IoJ24gbXVzdCBiZSBhIHBvc2l0aXZlIG51bWJlcicpO1xuICB0aGlzLl9tYXhMaXN0ZW5lcnMgPSBuO1xuICByZXR1cm4gdGhpcztcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuZW1pdCA9IGZ1bmN0aW9uKHR5cGUpIHtcbiAgdmFyIGVyLCBoYW5kbGVyLCBsZW4sIGFyZ3MsIGksIGxpc3RlbmVycztcblxuICBpZiAoIXRoaXMuX2V2ZW50cylcbiAgICB0aGlzLl9ldmVudHMgPSB7fTtcblxuICAvLyBJZiB0aGVyZSBpcyBubyAnZXJyb3InIGV2ZW50IGxpc3RlbmVyIHRoZW4gdGhyb3cuXG4gIGlmICh0eXBlID09PSAnZXJyb3InKSB7XG4gICAgaWYgKCF0aGlzLl9ldmVudHMuZXJyb3IgfHxcbiAgICAgICAgKGlzT2JqZWN0KHRoaXMuX2V2ZW50cy5lcnJvcikgJiYgIXRoaXMuX2V2ZW50cy5lcnJvci5sZW5ndGgpKSB7XG4gICAgICBlciA9IGFyZ3VtZW50c1sxXTtcbiAgICAgIGlmIChlciBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICAgIHRocm93IGVyOyAvLyBVbmhhbmRsZWQgJ2Vycm9yJyBldmVudFxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gQXQgbGVhc3QgZ2l2ZSBzb21lIGtpbmQgb2YgY29udGV4dCB0byB0aGUgdXNlclxuICAgICAgICB2YXIgZXJyID0gbmV3IEVycm9yKCdVbmNhdWdodCwgdW5zcGVjaWZpZWQgXCJlcnJvclwiIGV2ZW50LiAoJyArIGVyICsgJyknKTtcbiAgICAgICAgZXJyLmNvbnRleHQgPSBlcjtcbiAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGhhbmRsZXIgPSB0aGlzLl9ldmVudHNbdHlwZV07XG5cbiAgaWYgKGlzVW5kZWZpbmVkKGhhbmRsZXIpKVxuICAgIHJldHVybiBmYWxzZTtcblxuICBpZiAoaXNGdW5jdGlvbihoYW5kbGVyKSkge1xuICAgIHN3aXRjaCAoYXJndW1lbnRzLmxlbmd0aCkge1xuICAgICAgLy8gZmFzdCBjYXNlc1xuICAgICAgY2FzZSAxOlxuICAgICAgICBoYW5kbGVyLmNhbGwodGhpcyk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAyOlxuICAgICAgICBoYW5kbGVyLmNhbGwodGhpcywgYXJndW1lbnRzWzFdKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDM6XG4gICAgICAgIGhhbmRsZXIuY2FsbCh0aGlzLCBhcmd1bWVudHNbMV0sIGFyZ3VtZW50c1syXSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgLy8gc2xvd2VyXG4gICAgICBkZWZhdWx0OlxuICAgICAgICBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcbiAgICAgICAgaGFuZGxlci5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAoaXNPYmplY3QoaGFuZGxlcikpIHtcbiAgICBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcbiAgICBsaXN0ZW5lcnMgPSBoYW5kbGVyLnNsaWNlKCk7XG4gICAgbGVuID0gbGlzdGVuZXJzLmxlbmd0aDtcbiAgICBmb3IgKGkgPSAwOyBpIDwgbGVuOyBpKyspXG4gICAgICBsaXN0ZW5lcnNbaV0uYXBwbHkodGhpcywgYXJncyk7XG4gIH1cblxuICByZXR1cm4gdHJ1ZTtcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuYWRkTGlzdGVuZXIgPSBmdW5jdGlvbih0eXBlLCBsaXN0ZW5lcikge1xuICB2YXIgbTtcblxuICBpZiAoIWlzRnVuY3Rpb24obGlzdGVuZXIpKVxuICAgIHRocm93IFR5cGVFcnJvcignbGlzdGVuZXIgbXVzdCBiZSBhIGZ1bmN0aW9uJyk7XG5cbiAgaWYgKCF0aGlzLl9ldmVudHMpXG4gICAgdGhpcy5fZXZlbnRzID0ge307XG5cbiAgLy8gVG8gYXZvaWQgcmVjdXJzaW9uIGluIHRoZSBjYXNlIHRoYXQgdHlwZSA9PT0gXCJuZXdMaXN0ZW5lclwiISBCZWZvcmVcbiAgLy8gYWRkaW5nIGl0IHRvIHRoZSBsaXN0ZW5lcnMsIGZpcnN0IGVtaXQgXCJuZXdMaXN0ZW5lclwiLlxuICBpZiAodGhpcy5fZXZlbnRzLm5ld0xpc3RlbmVyKVxuICAgIHRoaXMuZW1pdCgnbmV3TGlzdGVuZXInLCB0eXBlLFxuICAgICAgICAgICAgICBpc0Z1bmN0aW9uKGxpc3RlbmVyLmxpc3RlbmVyKSA/XG4gICAgICAgICAgICAgIGxpc3RlbmVyLmxpc3RlbmVyIDogbGlzdGVuZXIpO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzW3R5cGVdKVxuICAgIC8vIE9wdGltaXplIHRoZSBjYXNlIG9mIG9uZSBsaXN0ZW5lci4gRG9uJ3QgbmVlZCB0aGUgZXh0cmEgYXJyYXkgb2JqZWN0LlxuICAgIHRoaXMuX2V2ZW50c1t0eXBlXSA9IGxpc3RlbmVyO1xuICBlbHNlIGlmIChpc09iamVjdCh0aGlzLl9ldmVudHNbdHlwZV0pKVxuICAgIC8vIElmIHdlJ3ZlIGFscmVhZHkgZ290IGFuIGFycmF5LCBqdXN0IGFwcGVuZC5cbiAgICB0aGlzLl9ldmVudHNbdHlwZV0ucHVzaChsaXN0ZW5lcik7XG4gIGVsc2VcbiAgICAvLyBBZGRpbmcgdGhlIHNlY29uZCBlbGVtZW50LCBuZWVkIHRvIGNoYW5nZSB0byBhcnJheS5cbiAgICB0aGlzLl9ldmVudHNbdHlwZV0gPSBbdGhpcy5fZXZlbnRzW3R5cGVdLCBsaXN0ZW5lcl07XG5cbiAgLy8gQ2hlY2sgZm9yIGxpc3RlbmVyIGxlYWtcbiAgaWYgKGlzT2JqZWN0KHRoaXMuX2V2ZW50c1t0eXBlXSkgJiYgIXRoaXMuX2V2ZW50c1t0eXBlXS53YXJuZWQpIHtcbiAgICBpZiAoIWlzVW5kZWZpbmVkKHRoaXMuX21heExpc3RlbmVycykpIHtcbiAgICAgIG0gPSB0aGlzLl9tYXhMaXN0ZW5lcnM7XG4gICAgfSBlbHNlIHtcbiAgICAgIG0gPSBFdmVudEVtaXR0ZXIuZGVmYXVsdE1heExpc3RlbmVycztcbiAgICB9XG5cbiAgICBpZiAobSAmJiBtID4gMCAmJiB0aGlzLl9ldmVudHNbdHlwZV0ubGVuZ3RoID4gbSkge1xuICAgICAgdGhpcy5fZXZlbnRzW3R5cGVdLndhcm5lZCA9IHRydWU7XG4gICAgICBjb25zb2xlLmVycm9yKCcobm9kZSkgd2FybmluZzogcG9zc2libGUgRXZlbnRFbWl0dGVyIG1lbW9yeSAnICtcbiAgICAgICAgICAgICAgICAgICAgJ2xlYWsgZGV0ZWN0ZWQuICVkIGxpc3RlbmVycyBhZGRlZC4gJyArXG4gICAgICAgICAgICAgICAgICAgICdVc2UgZW1pdHRlci5zZXRNYXhMaXN0ZW5lcnMoKSB0byBpbmNyZWFzZSBsaW1pdC4nLFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHNbdHlwZV0ubGVuZ3RoKTtcbiAgICAgIGlmICh0eXBlb2YgY29uc29sZS50cmFjZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAvLyBub3Qgc3VwcG9ydGVkIGluIElFIDEwXG4gICAgICAgIGNvbnNvbGUudHJhY2UoKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gdGhpcztcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUub24gPSBFdmVudEVtaXR0ZXIucHJvdG90eXBlLmFkZExpc3RlbmVyO1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLm9uY2UgPSBmdW5jdGlvbih0eXBlLCBsaXN0ZW5lcikge1xuICBpZiAoIWlzRnVuY3Rpb24obGlzdGVuZXIpKVxuICAgIHRocm93IFR5cGVFcnJvcignbGlzdGVuZXIgbXVzdCBiZSBhIGZ1bmN0aW9uJyk7XG5cbiAgdmFyIGZpcmVkID0gZmFsc2U7XG5cbiAgZnVuY3Rpb24gZygpIHtcbiAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKHR5cGUsIGcpO1xuXG4gICAgaWYgKCFmaXJlZCkge1xuICAgICAgZmlyZWQgPSB0cnVlO1xuICAgICAgbGlzdGVuZXIuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICB9XG4gIH1cblxuICBnLmxpc3RlbmVyID0gbGlzdGVuZXI7XG4gIHRoaXMub24odHlwZSwgZyk7XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG4vLyBlbWl0cyBhICdyZW1vdmVMaXN0ZW5lcicgZXZlbnQgaWZmIHRoZSBsaXN0ZW5lciB3YXMgcmVtb3ZlZFxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5yZW1vdmVMaXN0ZW5lciA9IGZ1bmN0aW9uKHR5cGUsIGxpc3RlbmVyKSB7XG4gIHZhciBsaXN0LCBwb3NpdGlvbiwgbGVuZ3RoLCBpO1xuXG4gIGlmICghaXNGdW5jdGlvbihsaXN0ZW5lcikpXG4gICAgdGhyb3cgVHlwZUVycm9yKCdsaXN0ZW5lciBtdXN0IGJlIGEgZnVuY3Rpb24nKTtcblxuICBpZiAoIXRoaXMuX2V2ZW50cyB8fCAhdGhpcy5fZXZlbnRzW3R5cGVdKVxuICAgIHJldHVybiB0aGlzO1xuXG4gIGxpc3QgPSB0aGlzLl9ldmVudHNbdHlwZV07XG4gIGxlbmd0aCA9IGxpc3QubGVuZ3RoO1xuICBwb3NpdGlvbiA9IC0xO1xuXG4gIGlmIChsaXN0ID09PSBsaXN0ZW5lciB8fFxuICAgICAgKGlzRnVuY3Rpb24obGlzdC5saXN0ZW5lcikgJiYgbGlzdC5saXN0ZW5lciA9PT0gbGlzdGVuZXIpKSB7XG4gICAgZGVsZXRlIHRoaXMuX2V2ZW50c1t0eXBlXTtcbiAgICBpZiAodGhpcy5fZXZlbnRzLnJlbW92ZUxpc3RlbmVyKVxuICAgICAgdGhpcy5lbWl0KCdyZW1vdmVMaXN0ZW5lcicsIHR5cGUsIGxpc3RlbmVyKTtcblxuICB9IGVsc2UgaWYgKGlzT2JqZWN0KGxpc3QpKSB7XG4gICAgZm9yIChpID0gbGVuZ3RoOyBpLS0gPiAwOykge1xuICAgICAgaWYgKGxpc3RbaV0gPT09IGxpc3RlbmVyIHx8XG4gICAgICAgICAgKGxpc3RbaV0ubGlzdGVuZXIgJiYgbGlzdFtpXS5saXN0ZW5lciA9PT0gbGlzdGVuZXIpKSB7XG4gICAgICAgIHBvc2l0aW9uID0gaTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHBvc2l0aW9uIDwgMClcbiAgICAgIHJldHVybiB0aGlzO1xuXG4gICAgaWYgKGxpc3QubGVuZ3RoID09PSAxKSB7XG4gICAgICBsaXN0Lmxlbmd0aCA9IDA7XG4gICAgICBkZWxldGUgdGhpcy5fZXZlbnRzW3R5cGVdO1xuICAgIH0gZWxzZSB7XG4gICAgICBsaXN0LnNwbGljZShwb3NpdGlvbiwgMSk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuX2V2ZW50cy5yZW1vdmVMaXN0ZW5lcilcbiAgICAgIHRoaXMuZW1pdCgncmVtb3ZlTGlzdGVuZXInLCB0eXBlLCBsaXN0ZW5lcik7XG4gIH1cblxuICByZXR1cm4gdGhpcztcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUucmVtb3ZlQWxsTGlzdGVuZXJzID0gZnVuY3Rpb24odHlwZSkge1xuICB2YXIga2V5LCBsaXN0ZW5lcnM7XG5cbiAgaWYgKCF0aGlzLl9ldmVudHMpXG4gICAgcmV0dXJuIHRoaXM7XG5cbiAgLy8gbm90IGxpc3RlbmluZyBmb3IgcmVtb3ZlTGlzdGVuZXIsIG5vIG5lZWQgdG8gZW1pdFxuICBpZiAoIXRoaXMuX2V2ZW50cy5yZW1vdmVMaXN0ZW5lcikge1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAwKVxuICAgICAgdGhpcy5fZXZlbnRzID0ge307XG4gICAgZWxzZSBpZiAodGhpcy5fZXZlbnRzW3R5cGVdKVxuICAgICAgZGVsZXRlIHRoaXMuX2V2ZW50c1t0eXBlXTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIGVtaXQgcmVtb3ZlTGlzdGVuZXIgZm9yIGFsbCBsaXN0ZW5lcnMgb24gYWxsIGV2ZW50c1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgIGZvciAoa2V5IGluIHRoaXMuX2V2ZW50cykge1xuICAgICAgaWYgKGtleSA9PT0gJ3JlbW92ZUxpc3RlbmVyJykgY29udGludWU7XG4gICAgICB0aGlzLnJlbW92ZUFsbExpc3RlbmVycyhrZXkpO1xuICAgIH1cbiAgICB0aGlzLnJlbW92ZUFsbExpc3RlbmVycygncmVtb3ZlTGlzdGVuZXInKTtcbiAgICB0aGlzLl9ldmVudHMgPSB7fTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGxpc3RlbmVycyA9IHRoaXMuX2V2ZW50c1t0eXBlXTtcblxuICBpZiAoaXNGdW5jdGlvbihsaXN0ZW5lcnMpKSB7XG4gICAgdGhpcy5yZW1vdmVMaXN0ZW5lcih0eXBlLCBsaXN0ZW5lcnMpO1xuICB9IGVsc2UgaWYgKGxpc3RlbmVycykge1xuICAgIC8vIExJRk8gb3JkZXJcbiAgICB3aGlsZSAobGlzdGVuZXJzLmxlbmd0aClcbiAgICAgIHRoaXMucmVtb3ZlTGlzdGVuZXIodHlwZSwgbGlzdGVuZXJzW2xpc3RlbmVycy5sZW5ndGggLSAxXSk7XG4gIH1cbiAgZGVsZXRlIHRoaXMuX2V2ZW50c1t0eXBlXTtcblxuICByZXR1cm4gdGhpcztcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUubGlzdGVuZXJzID0gZnVuY3Rpb24odHlwZSkge1xuICB2YXIgcmV0O1xuICBpZiAoIXRoaXMuX2V2ZW50cyB8fCAhdGhpcy5fZXZlbnRzW3R5cGVdKVxuICAgIHJldCA9IFtdO1xuICBlbHNlIGlmIChpc0Z1bmN0aW9uKHRoaXMuX2V2ZW50c1t0eXBlXSkpXG4gICAgcmV0ID0gW3RoaXMuX2V2ZW50c1t0eXBlXV07XG4gIGVsc2VcbiAgICByZXQgPSB0aGlzLl9ldmVudHNbdHlwZV0uc2xpY2UoKTtcbiAgcmV0dXJuIHJldDtcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUubGlzdGVuZXJDb3VudCA9IGZ1bmN0aW9uKHR5cGUpIHtcbiAgaWYgKHRoaXMuX2V2ZW50cykge1xuICAgIHZhciBldmxpc3RlbmVyID0gdGhpcy5fZXZlbnRzW3R5cGVdO1xuXG4gICAgaWYgKGlzRnVuY3Rpb24oZXZsaXN0ZW5lcikpXG4gICAgICByZXR1cm4gMTtcbiAgICBlbHNlIGlmIChldmxpc3RlbmVyKVxuICAgICAgcmV0dXJuIGV2bGlzdGVuZXIubGVuZ3RoO1xuICB9XG4gIHJldHVybiAwO1xufTtcblxuRXZlbnRFbWl0dGVyLmxpc3RlbmVyQ291bnQgPSBmdW5jdGlvbihlbWl0dGVyLCB0eXBlKSB7XG4gIHJldHVybiBlbWl0dGVyLmxpc3RlbmVyQ291bnQodHlwZSk7XG59O1xuXG5mdW5jdGlvbiBpc0Z1bmN0aW9uKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ2Z1bmN0aW9uJztcbn1cblxuZnVuY3Rpb24gaXNOdW1iZXIoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnbnVtYmVyJztcbn1cblxuZnVuY3Rpb24gaXNPYmplY3QoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgIT09IG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09PSB2b2lkIDA7XG59XG4iLCIvLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxuLy8gcmVzb2x2ZXMgLiBhbmQgLi4gZWxlbWVudHMgaW4gYSBwYXRoIGFycmF5IHdpdGggZGlyZWN0b3J5IG5hbWVzIHRoZXJlXG4vLyBtdXN0IGJlIG5vIHNsYXNoZXMsIGVtcHR5IGVsZW1lbnRzLCBvciBkZXZpY2UgbmFtZXMgKGM6XFwpIGluIHRoZSBhcnJheVxuLy8gKHNvIGFsc28gbm8gbGVhZGluZyBhbmQgdHJhaWxpbmcgc2xhc2hlcyAtIGl0IGRvZXMgbm90IGRpc3Rpbmd1aXNoXG4vLyByZWxhdGl2ZSBhbmQgYWJzb2x1dGUgcGF0aHMpXG5mdW5jdGlvbiBub3JtYWxpemVBcnJheShwYXJ0cywgYWxsb3dBYm92ZVJvb3QpIHtcbiAgLy8gaWYgdGhlIHBhdGggdHJpZXMgdG8gZ28gYWJvdmUgdGhlIHJvb3QsIGB1cGAgZW5kcyB1cCA+IDBcbiAgdmFyIHVwID0gMDtcbiAgZm9yICh2YXIgaSA9IHBhcnRzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgdmFyIGxhc3QgPSBwYXJ0c1tpXTtcbiAgICBpZiAobGFzdCA9PT0gJy4nKSB7XG4gICAgICBwYXJ0cy5zcGxpY2UoaSwgMSk7XG4gICAgfSBlbHNlIGlmIChsYXN0ID09PSAnLi4nKSB7XG4gICAgICBwYXJ0cy5zcGxpY2UoaSwgMSk7XG4gICAgICB1cCsrO1xuICAgIH0gZWxzZSBpZiAodXApIHtcbiAgICAgIHBhcnRzLnNwbGljZShpLCAxKTtcbiAgICAgIHVwLS07XG4gICAgfVxuICB9XG5cbiAgLy8gaWYgdGhlIHBhdGggaXMgYWxsb3dlZCB0byBnbyBhYm92ZSB0aGUgcm9vdCwgcmVzdG9yZSBsZWFkaW5nIC4uc1xuICBpZiAoYWxsb3dBYm92ZVJvb3QpIHtcbiAgICBmb3IgKDsgdXAtLTsgdXApIHtcbiAgICAgIHBhcnRzLnVuc2hpZnQoJy4uJyk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHBhcnRzO1xufVxuXG4vLyBTcGxpdCBhIGZpbGVuYW1lIGludG8gW3Jvb3QsIGRpciwgYmFzZW5hbWUsIGV4dF0sIHVuaXggdmVyc2lvblxuLy8gJ3Jvb3QnIGlzIGp1c3QgYSBzbGFzaCwgb3Igbm90aGluZy5cbnZhciBzcGxpdFBhdGhSZSA9XG4gICAgL14oXFwvP3wpKFtcXHNcXFNdKj8pKCg/OlxcLnsxLDJ9fFteXFwvXSs/fCkoXFwuW14uXFwvXSp8KSkoPzpbXFwvXSopJC87XG52YXIgc3BsaXRQYXRoID0gZnVuY3Rpb24oZmlsZW5hbWUpIHtcbiAgcmV0dXJuIHNwbGl0UGF0aFJlLmV4ZWMoZmlsZW5hbWUpLnNsaWNlKDEpO1xufTtcblxuLy8gcGF0aC5yZXNvbHZlKFtmcm9tIC4uLl0sIHRvKVxuLy8gcG9zaXggdmVyc2lvblxuZXhwb3J0cy5yZXNvbHZlID0gZnVuY3Rpb24oKSB7XG4gIHZhciByZXNvbHZlZFBhdGggPSAnJyxcbiAgICAgIHJlc29sdmVkQWJzb2x1dGUgPSBmYWxzZTtcblxuICBmb3IgKHZhciBpID0gYXJndW1lbnRzLmxlbmd0aCAtIDE7IGkgPj0gLTEgJiYgIXJlc29sdmVkQWJzb2x1dGU7IGktLSkge1xuICAgIHZhciBwYXRoID0gKGkgPj0gMCkgPyBhcmd1bWVudHNbaV0gOiBwcm9jZXNzLmN3ZCgpO1xuXG4gICAgLy8gU2tpcCBlbXB0eSBhbmQgaW52YWxpZCBlbnRyaWVzXG4gICAgaWYgKHR5cGVvZiBwYXRoICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignQXJndW1lbnRzIHRvIHBhdGgucmVzb2x2ZSBtdXN0IGJlIHN0cmluZ3MnKTtcbiAgICB9IGVsc2UgaWYgKCFwYXRoKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICByZXNvbHZlZFBhdGggPSBwYXRoICsgJy8nICsgcmVzb2x2ZWRQYXRoO1xuICAgIHJlc29sdmVkQWJzb2x1dGUgPSBwYXRoLmNoYXJBdCgwKSA9PT0gJy8nO1xuICB9XG5cbiAgLy8gQXQgdGhpcyBwb2ludCB0aGUgcGF0aCBzaG91bGQgYmUgcmVzb2x2ZWQgdG8gYSBmdWxsIGFic29sdXRlIHBhdGgsIGJ1dFxuICAvLyBoYW5kbGUgcmVsYXRpdmUgcGF0aHMgdG8gYmUgc2FmZSAobWlnaHQgaGFwcGVuIHdoZW4gcHJvY2Vzcy5jd2QoKSBmYWlscylcblxuICAvLyBOb3JtYWxpemUgdGhlIHBhdGhcbiAgcmVzb2x2ZWRQYXRoID0gbm9ybWFsaXplQXJyYXkoZmlsdGVyKHJlc29sdmVkUGF0aC5zcGxpdCgnLycpLCBmdW5jdGlvbihwKSB7XG4gICAgcmV0dXJuICEhcDtcbiAgfSksICFyZXNvbHZlZEFic29sdXRlKS5qb2luKCcvJyk7XG5cbiAgcmV0dXJuICgocmVzb2x2ZWRBYnNvbHV0ZSA/ICcvJyA6ICcnKSArIHJlc29sdmVkUGF0aCkgfHwgJy4nO1xufTtcblxuLy8gcGF0aC5ub3JtYWxpemUocGF0aClcbi8vIHBvc2l4IHZlcnNpb25cbmV4cG9ydHMubm9ybWFsaXplID0gZnVuY3Rpb24ocGF0aCkge1xuICB2YXIgaXNBYnNvbHV0ZSA9IGV4cG9ydHMuaXNBYnNvbHV0ZShwYXRoKSxcbiAgICAgIHRyYWlsaW5nU2xhc2ggPSBzdWJzdHIocGF0aCwgLTEpID09PSAnLyc7XG5cbiAgLy8gTm9ybWFsaXplIHRoZSBwYXRoXG4gIHBhdGggPSBub3JtYWxpemVBcnJheShmaWx0ZXIocGF0aC5zcGxpdCgnLycpLCBmdW5jdGlvbihwKSB7XG4gICAgcmV0dXJuICEhcDtcbiAgfSksICFpc0Fic29sdXRlKS5qb2luKCcvJyk7XG5cbiAgaWYgKCFwYXRoICYmICFpc0Fic29sdXRlKSB7XG4gICAgcGF0aCA9ICcuJztcbiAgfVxuICBpZiAocGF0aCAmJiB0cmFpbGluZ1NsYXNoKSB7XG4gICAgcGF0aCArPSAnLyc7XG4gIH1cblxuICByZXR1cm4gKGlzQWJzb2x1dGUgPyAnLycgOiAnJykgKyBwYXRoO1xufTtcblxuLy8gcG9zaXggdmVyc2lvblxuZXhwb3J0cy5pc0Fic29sdXRlID0gZnVuY3Rpb24ocGF0aCkge1xuICByZXR1cm4gcGF0aC5jaGFyQXQoMCkgPT09ICcvJztcbn07XG5cbi8vIHBvc2l4IHZlcnNpb25cbmV4cG9ydHMuam9pbiA9IGZ1bmN0aW9uKCkge1xuICB2YXIgcGF0aHMgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDApO1xuICByZXR1cm4gZXhwb3J0cy5ub3JtYWxpemUoZmlsdGVyKHBhdGhzLCBmdW5jdGlvbihwLCBpbmRleCkge1xuICAgIGlmICh0eXBlb2YgcCAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0FyZ3VtZW50cyB0byBwYXRoLmpvaW4gbXVzdCBiZSBzdHJpbmdzJyk7XG4gICAgfVxuICAgIHJldHVybiBwO1xuICB9KS5qb2luKCcvJykpO1xufTtcblxuXG4vLyBwYXRoLnJlbGF0aXZlKGZyb20sIHRvKVxuLy8gcG9zaXggdmVyc2lvblxuZXhwb3J0cy5yZWxhdGl2ZSA9IGZ1bmN0aW9uKGZyb20sIHRvKSB7XG4gIGZyb20gPSBleHBvcnRzLnJlc29sdmUoZnJvbSkuc3Vic3RyKDEpO1xuICB0byA9IGV4cG9ydHMucmVzb2x2ZSh0bykuc3Vic3RyKDEpO1xuXG4gIGZ1bmN0aW9uIHRyaW0oYXJyKSB7XG4gICAgdmFyIHN0YXJ0ID0gMDtcbiAgICBmb3IgKDsgc3RhcnQgPCBhcnIubGVuZ3RoOyBzdGFydCsrKSB7XG4gICAgICBpZiAoYXJyW3N0YXJ0XSAhPT0gJycpIGJyZWFrO1xuICAgIH1cblxuICAgIHZhciBlbmQgPSBhcnIubGVuZ3RoIC0gMTtcbiAgICBmb3IgKDsgZW5kID49IDA7IGVuZC0tKSB7XG4gICAgICBpZiAoYXJyW2VuZF0gIT09ICcnKSBicmVhaztcbiAgICB9XG5cbiAgICBpZiAoc3RhcnQgPiBlbmQpIHJldHVybiBbXTtcbiAgICByZXR1cm4gYXJyLnNsaWNlKHN0YXJ0LCBlbmQgLSBzdGFydCArIDEpO1xuICB9XG5cbiAgdmFyIGZyb21QYXJ0cyA9IHRyaW0oZnJvbS5zcGxpdCgnLycpKTtcbiAgdmFyIHRvUGFydHMgPSB0cmltKHRvLnNwbGl0KCcvJykpO1xuXG4gIHZhciBsZW5ndGggPSBNYXRoLm1pbihmcm9tUGFydHMubGVuZ3RoLCB0b1BhcnRzLmxlbmd0aCk7XG4gIHZhciBzYW1lUGFydHNMZW5ndGggPSBsZW5ndGg7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuZ3RoOyBpKyspIHtcbiAgICBpZiAoZnJvbVBhcnRzW2ldICE9PSB0b1BhcnRzW2ldKSB7XG4gICAgICBzYW1lUGFydHNMZW5ndGggPSBpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgdmFyIG91dHB1dFBhcnRzID0gW107XG4gIGZvciAodmFyIGkgPSBzYW1lUGFydHNMZW5ndGg7IGkgPCBmcm9tUGFydHMubGVuZ3RoOyBpKyspIHtcbiAgICBvdXRwdXRQYXJ0cy5wdXNoKCcuLicpO1xuICB9XG5cbiAgb3V0cHV0UGFydHMgPSBvdXRwdXRQYXJ0cy5jb25jYXQodG9QYXJ0cy5zbGljZShzYW1lUGFydHNMZW5ndGgpKTtcblxuICByZXR1cm4gb3V0cHV0UGFydHMuam9pbignLycpO1xufTtcblxuZXhwb3J0cy5zZXAgPSAnLyc7XG5leHBvcnRzLmRlbGltaXRlciA9ICc6JztcblxuZXhwb3J0cy5kaXJuYW1lID0gZnVuY3Rpb24ocGF0aCkge1xuICB2YXIgcmVzdWx0ID0gc3BsaXRQYXRoKHBhdGgpLFxuICAgICAgcm9vdCA9IHJlc3VsdFswXSxcbiAgICAgIGRpciA9IHJlc3VsdFsxXTtcblxuICBpZiAoIXJvb3QgJiYgIWRpcikge1xuICAgIC8vIE5vIGRpcm5hbWUgd2hhdHNvZXZlclxuICAgIHJldHVybiAnLic7XG4gIH1cblxuICBpZiAoZGlyKSB7XG4gICAgLy8gSXQgaGFzIGEgZGlybmFtZSwgc3RyaXAgdHJhaWxpbmcgc2xhc2hcbiAgICBkaXIgPSBkaXIuc3Vic3RyKDAsIGRpci5sZW5ndGggLSAxKTtcbiAgfVxuXG4gIHJldHVybiByb290ICsgZGlyO1xufTtcblxuXG5leHBvcnRzLmJhc2VuYW1lID0gZnVuY3Rpb24ocGF0aCwgZXh0KSB7XG4gIHZhciBmID0gc3BsaXRQYXRoKHBhdGgpWzJdO1xuICAvLyBUT0RPOiBtYWtlIHRoaXMgY29tcGFyaXNvbiBjYXNlLWluc2Vuc2l0aXZlIG9uIHdpbmRvd3M/XG4gIGlmIChleHQgJiYgZi5zdWJzdHIoLTEgKiBleHQubGVuZ3RoKSA9PT0gZXh0KSB7XG4gICAgZiA9IGYuc3Vic3RyKDAsIGYubGVuZ3RoIC0gZXh0Lmxlbmd0aCk7XG4gIH1cbiAgcmV0dXJuIGY7XG59O1xuXG5cbmV4cG9ydHMuZXh0bmFtZSA9IGZ1bmN0aW9uKHBhdGgpIHtcbiAgcmV0dXJuIHNwbGl0UGF0aChwYXRoKVszXTtcbn07XG5cbmZ1bmN0aW9uIGZpbHRlciAoeHMsIGYpIHtcbiAgICBpZiAoeHMuZmlsdGVyKSByZXR1cm4geHMuZmlsdGVyKGYpO1xuICAgIHZhciByZXMgPSBbXTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHhzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGlmIChmKHhzW2ldLCBpLCB4cykpIHJlcy5wdXNoKHhzW2ldKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlcztcbn1cblxuLy8gU3RyaW5nLnByb3RvdHlwZS5zdWJzdHIgLSBuZWdhdGl2ZSBpbmRleCBkb24ndCB3b3JrIGluIElFOFxudmFyIHN1YnN0ciA9ICdhYicuc3Vic3RyKC0xKSA9PT0gJ2InXG4gICAgPyBmdW5jdGlvbiAoc3RyLCBzdGFydCwgbGVuKSB7IHJldHVybiBzdHIuc3Vic3RyKHN0YXJ0LCBsZW4pIH1cbiAgICA6IGZ1bmN0aW9uIChzdHIsIHN0YXJ0LCBsZW4pIHtcbiAgICAgICAgaWYgKHN0YXJ0IDwgMCkgc3RhcnQgPSBzdHIubGVuZ3RoICsgc3RhcnQ7XG4gICAgICAgIHJldHVybiBzdHIuc3Vic3RyKHN0YXJ0LCBsZW4pO1xuICAgIH1cbjtcbiIsIi8vIHNoaW0gZm9yIHVzaW5nIHByb2Nlc3MgaW4gYnJvd3NlclxudmFyIHByb2Nlc3MgPSBtb2R1bGUuZXhwb3J0cyA9IHt9O1xuXG4vLyBjYWNoZWQgZnJvbSB3aGF0ZXZlciBnbG9iYWwgaXMgcHJlc2VudCBzbyB0aGF0IHRlc3QgcnVubmVycyB0aGF0IHN0dWIgaXRcbi8vIGRvbid0IGJyZWFrIHRoaW5ncy4gIEJ1dCB3ZSBuZWVkIHRvIHdyYXAgaXQgaW4gYSB0cnkgY2F0Y2ggaW4gY2FzZSBpdCBpc1xuLy8gd3JhcHBlZCBpbiBzdHJpY3QgbW9kZSBjb2RlIHdoaWNoIGRvZXNuJ3QgZGVmaW5lIGFueSBnbG9iYWxzLiAgSXQncyBpbnNpZGUgYVxuLy8gZnVuY3Rpb24gYmVjYXVzZSB0cnkvY2F0Y2hlcyBkZW9wdGltaXplIGluIGNlcnRhaW4gZW5naW5lcy5cblxudmFyIGNhY2hlZFNldFRpbWVvdXQ7XG52YXIgY2FjaGVkQ2xlYXJUaW1lb3V0O1xuXG5mdW5jdGlvbiBkZWZhdWx0U2V0VGltb3V0KCkge1xuICAgIHRocm93IG5ldyBFcnJvcignc2V0VGltZW91dCBoYXMgbm90IGJlZW4gZGVmaW5lZCcpO1xufVxuZnVuY3Rpb24gZGVmYXVsdENsZWFyVGltZW91dCAoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdjbGVhclRpbWVvdXQgaGFzIG5vdCBiZWVuIGRlZmluZWQnKTtcbn1cbihmdW5jdGlvbiAoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKHR5cGVvZiBzZXRUaW1lb3V0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gc2V0VGltZW91dDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNhY2hlZFNldFRpbWVvdXQgPSBkZWZhdWx0U2V0VGltb3V0O1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gZGVmYXVsdFNldFRpbW91dDtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKHR5cGVvZiBjbGVhclRpbWVvdXQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGNsZWFyVGltZW91dDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGRlZmF1bHRDbGVhclRpbWVvdXQ7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGRlZmF1bHRDbGVhclRpbWVvdXQ7XG4gICAgfVxufSAoKSlcbmZ1bmN0aW9uIHJ1blRpbWVvdXQoZnVuKSB7XG4gICAgaWYgKGNhY2hlZFNldFRpbWVvdXQgPT09IHNldFRpbWVvdXQpIHtcbiAgICAgICAgLy9ub3JtYWwgZW52aXJvbWVudHMgaW4gc2FuZSBzaXR1YXRpb25zXG4gICAgICAgIHJldHVybiBzZXRUaW1lb3V0KGZ1biwgMCk7XG4gICAgfVxuICAgIC8vIGlmIHNldFRpbWVvdXQgd2Fzbid0IGF2YWlsYWJsZSBidXQgd2FzIGxhdHRlciBkZWZpbmVkXG4gICAgaWYgKChjYWNoZWRTZXRUaW1lb3V0ID09PSBkZWZhdWx0U2V0VGltb3V0IHx8ICFjYWNoZWRTZXRUaW1lb3V0KSAmJiBzZXRUaW1lb3V0KSB7XG4gICAgICAgIGNhY2hlZFNldFRpbWVvdXQgPSBzZXRUaW1lb3V0O1xuICAgICAgICByZXR1cm4gc2V0VGltZW91dChmdW4sIDApO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICAvLyB3aGVuIHdoZW4gc29tZWJvZHkgaGFzIHNjcmV3ZWQgd2l0aCBzZXRUaW1lb3V0IGJ1dCBubyBJLkUuIG1hZGRuZXNzXG4gICAgICAgIHJldHVybiBjYWNoZWRTZXRUaW1lb3V0KGZ1biwgMCk7XG4gICAgfSBjYXRjaChlKXtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIFdoZW4gd2UgYXJlIGluIEkuRS4gYnV0IHRoZSBzY3JpcHQgaGFzIGJlZW4gZXZhbGVkIHNvIEkuRS4gZG9lc24ndCB0cnVzdCB0aGUgZ2xvYmFsIG9iamVjdCB3aGVuIGNhbGxlZCBub3JtYWxseVxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZFNldFRpbWVvdXQuY2FsbChudWxsLCBmdW4sIDApO1xuICAgICAgICB9IGNhdGNoKGUpe1xuICAgICAgICAgICAgLy8gc2FtZSBhcyBhYm92ZSBidXQgd2hlbiBpdCdzIGEgdmVyc2lvbiBvZiBJLkUuIHRoYXQgbXVzdCBoYXZlIHRoZSBnbG9iYWwgb2JqZWN0IGZvciAndGhpcycsIGhvcGZ1bGx5IG91ciBjb250ZXh0IGNvcnJlY3Qgb3RoZXJ3aXNlIGl0IHdpbGwgdGhyb3cgYSBnbG9iYWwgZXJyb3JcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWRTZXRUaW1lb3V0LmNhbGwodGhpcywgZnVuLCAwKTtcbiAgICAgICAgfVxuICAgIH1cblxuXG59XG5mdW5jdGlvbiBydW5DbGVhclRpbWVvdXQobWFya2VyKSB7XG4gICAgaWYgKGNhY2hlZENsZWFyVGltZW91dCA9PT0gY2xlYXJUaW1lb3V0KSB7XG4gICAgICAgIC8vbm9ybWFsIGVudmlyb21lbnRzIGluIHNhbmUgc2l0dWF0aW9uc1xuICAgICAgICByZXR1cm4gY2xlYXJUaW1lb3V0KG1hcmtlcik7XG4gICAgfVxuICAgIC8vIGlmIGNsZWFyVGltZW91dCB3YXNuJ3QgYXZhaWxhYmxlIGJ1dCB3YXMgbGF0dGVyIGRlZmluZWRcbiAgICBpZiAoKGNhY2hlZENsZWFyVGltZW91dCA9PT0gZGVmYXVsdENsZWFyVGltZW91dCB8fCAhY2FjaGVkQ2xlYXJUaW1lb3V0KSAmJiBjbGVhclRpbWVvdXQpIHtcbiAgICAgICAgY2FjaGVkQ2xlYXJUaW1lb3V0ID0gY2xlYXJUaW1lb3V0O1xuICAgICAgICByZXR1cm4gY2xlYXJUaW1lb3V0KG1hcmtlcik7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIC8vIHdoZW4gd2hlbiBzb21lYm9keSBoYXMgc2NyZXdlZCB3aXRoIHNldFRpbWVvdXQgYnV0IG5vIEkuRS4gbWFkZG5lc3NcbiAgICAgICAgcmV0dXJuIGNhY2hlZENsZWFyVGltZW91dChtYXJrZXIpO1xuICAgIH0gY2F0Y2ggKGUpe1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8gV2hlbiB3ZSBhcmUgaW4gSS5FLiBidXQgdGhlIHNjcmlwdCBoYXMgYmVlbiBldmFsZWQgc28gSS5FLiBkb2Vzbid0ICB0cnVzdCB0aGUgZ2xvYmFsIG9iamVjdCB3aGVuIGNhbGxlZCBub3JtYWxseVxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZENsZWFyVGltZW91dC5jYWxsKG51bGwsIG1hcmtlcik7XG4gICAgICAgIH0gY2F0Y2ggKGUpe1xuICAgICAgICAgICAgLy8gc2FtZSBhcyBhYm92ZSBidXQgd2hlbiBpdCdzIGEgdmVyc2lvbiBvZiBJLkUuIHRoYXQgbXVzdCBoYXZlIHRoZSBnbG9iYWwgb2JqZWN0IGZvciAndGhpcycsIGhvcGZ1bGx5IG91ciBjb250ZXh0IGNvcnJlY3Qgb3RoZXJ3aXNlIGl0IHdpbGwgdGhyb3cgYSBnbG9iYWwgZXJyb3IuXG4gICAgICAgICAgICAvLyBTb21lIHZlcnNpb25zIG9mIEkuRS4gaGF2ZSBkaWZmZXJlbnQgcnVsZXMgZm9yIGNsZWFyVGltZW91dCB2cyBzZXRUaW1lb3V0XG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkQ2xlYXJUaW1lb3V0LmNhbGwodGhpcywgbWFya2VyKTtcbiAgICAgICAgfVxuICAgIH1cblxuXG5cbn1cbnZhciBxdWV1ZSA9IFtdO1xudmFyIGRyYWluaW5nID0gZmFsc2U7XG52YXIgY3VycmVudFF1ZXVlO1xudmFyIHF1ZXVlSW5kZXggPSAtMTtcblxuZnVuY3Rpb24gY2xlYW5VcE5leHRUaWNrKCkge1xuICAgIGlmICghZHJhaW5pbmcgfHwgIWN1cnJlbnRRdWV1ZSkge1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGRyYWluaW5nID0gZmFsc2U7XG4gICAgaWYgKGN1cnJlbnRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgcXVldWUgPSBjdXJyZW50UXVldWUuY29uY2F0KHF1ZXVlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgfVxuICAgIGlmIChxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgZHJhaW5RdWV1ZSgpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gZHJhaW5RdWV1ZSgpIHtcbiAgICBpZiAoZHJhaW5pbmcpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgdGltZW91dCA9IHJ1blRpbWVvdXQoY2xlYW5VcE5leHRUaWNrKTtcbiAgICBkcmFpbmluZyA9IHRydWU7XG5cbiAgICB2YXIgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIHdoaWxlKGxlbikge1xuICAgICAgICBjdXJyZW50UXVldWUgPSBxdWV1ZTtcbiAgICAgICAgcXVldWUgPSBbXTtcbiAgICAgICAgd2hpbGUgKCsrcXVldWVJbmRleCA8IGxlbikge1xuICAgICAgICAgICAgaWYgKGN1cnJlbnRRdWV1ZSkge1xuICAgICAgICAgICAgICAgIGN1cnJlbnRRdWV1ZVtxdWV1ZUluZGV4XS5ydW4oKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgICAgIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB9XG4gICAgY3VycmVudFF1ZXVlID0gbnVsbDtcbiAgICBkcmFpbmluZyA9IGZhbHNlO1xuICAgIHJ1bkNsZWFyVGltZW91dCh0aW1lb3V0KTtcbn1cblxucHJvY2Vzcy5uZXh0VGljayA9IGZ1bmN0aW9uIChmdW4pIHtcbiAgICB2YXIgYXJncyA9IG5ldyBBcnJheShhcmd1bWVudHMubGVuZ3RoIC0gMSk7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAxKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAxOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBhcmdzW2kgLSAxXSA9IGFyZ3VtZW50c1tpXTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBxdWV1ZS5wdXNoKG5ldyBJdGVtKGZ1biwgYXJncykpO1xuICAgIGlmIChxdWV1ZS5sZW5ndGggPT09IDEgJiYgIWRyYWluaW5nKSB7XG4gICAgICAgIHJ1blRpbWVvdXQoZHJhaW5RdWV1ZSk7XG4gICAgfVxufTtcblxuLy8gdjggbGlrZXMgcHJlZGljdGlibGUgb2JqZWN0c1xuZnVuY3Rpb24gSXRlbShmdW4sIGFycmF5KSB7XG4gICAgdGhpcy5mdW4gPSBmdW47XG4gICAgdGhpcy5hcnJheSA9IGFycmF5O1xufVxuSXRlbS5wcm90b3R5cGUucnVuID0gZnVuY3Rpb24gKCkge1xuICAgIHRoaXMuZnVuLmFwcGx5KG51bGwsIHRoaXMuYXJyYXkpO1xufTtcbnByb2Nlc3MudGl0bGUgPSAnYnJvd3Nlcic7XG5wcm9jZXNzLmJyb3dzZXIgPSB0cnVlO1xucHJvY2Vzcy5lbnYgPSB7fTtcbnByb2Nlc3MuYXJndiA9IFtdO1xucHJvY2Vzcy52ZXJzaW9uID0gJyc7IC8vIGVtcHR5IHN0cmluZyB0byBhdm9pZCByZWdleHAgaXNzdWVzXG5wcm9jZXNzLnZlcnNpb25zID0ge307XG5cbmZ1bmN0aW9uIG5vb3AoKSB7fVxuXG5wcm9jZXNzLm9uID0gbm9vcDtcbnByb2Nlc3MuYWRkTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5vbmNlID0gbm9vcDtcbnByb2Nlc3Mub2ZmID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVBbGxMaXN0ZW5lcnMgPSBub29wO1xucHJvY2Vzcy5lbWl0ID0gbm9vcDtcbnByb2Nlc3MucHJlcGVuZExpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3MucHJlcGVuZE9uY2VMaXN0ZW5lciA9IG5vb3A7XG5cbnByb2Nlc3MubGlzdGVuZXJzID0gZnVuY3Rpb24gKG5hbWUpIHsgcmV0dXJuIFtdIH1cblxucHJvY2Vzcy5iaW5kaW5nID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuYmluZGluZyBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xuXG5wcm9jZXNzLmN3ZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICcvJyB9O1xucHJvY2Vzcy5jaGRpciA9IGZ1bmN0aW9uIChkaXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuY2hkaXIgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcbnByb2Nlc3MudW1hc2sgPSBmdW5jdGlvbigpIHsgcmV0dXJuIDA7IH07XG4iLCJpZiAodHlwZW9mIE9iamVjdC5jcmVhdGUgPT09ICdmdW5jdGlvbicpIHtcbiAgLy8gaW1wbGVtZW50YXRpb24gZnJvbSBzdGFuZGFyZCBub2RlLmpzICd1dGlsJyBtb2R1bGVcbiAgbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBpbmhlcml0cyhjdG9yLCBzdXBlckN0b3IpIHtcbiAgICBjdG9yLnN1cGVyXyA9IHN1cGVyQ3RvclxuICAgIGN0b3IucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShzdXBlckN0b3IucHJvdG90eXBlLCB7XG4gICAgICBjb25zdHJ1Y3Rvcjoge1xuICAgICAgICB2YWx1ZTogY3RvcixcbiAgICAgICAgZW51bWVyYWJsZTogZmFsc2UsXG4gICAgICAgIHdyaXRhYmxlOiB0cnVlLFxuICAgICAgICBjb25maWd1cmFibGU6IHRydWVcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcbn0gZWxzZSB7XG4gIC8vIG9sZCBzY2hvb2wgc2hpbSBmb3Igb2xkIGJyb3dzZXJzXG4gIG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gaW5oZXJpdHMoY3Rvciwgc3VwZXJDdG9yKSB7XG4gICAgY3Rvci5zdXBlcl8gPSBzdXBlckN0b3JcbiAgICB2YXIgVGVtcEN0b3IgPSBmdW5jdGlvbiAoKSB7fVxuICAgIFRlbXBDdG9yLnByb3RvdHlwZSA9IHN1cGVyQ3Rvci5wcm90b3R5cGVcbiAgICBjdG9yLnByb3RvdHlwZSA9IG5ldyBUZW1wQ3RvcigpXG4gICAgY3Rvci5wcm90b3R5cGUuY29uc3RydWN0b3IgPSBjdG9yXG4gIH1cbn1cbiIsIm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gaXNCdWZmZXIoYXJnKSB7XG4gIHJldHVybiBhcmcgJiYgdHlwZW9mIGFyZyA9PT0gJ29iamVjdCdcbiAgICAmJiB0eXBlb2YgYXJnLmNvcHkgPT09ICdmdW5jdGlvbidcbiAgICAmJiB0eXBlb2YgYXJnLmZpbGwgPT09ICdmdW5jdGlvbidcbiAgICAmJiB0eXBlb2YgYXJnLnJlYWRVSW50OCA9PT0gJ2Z1bmN0aW9uJztcbn0iLCIvLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxudmFyIGZvcm1hdFJlZ0V4cCA9IC8lW3NkaiVdL2c7XG5leHBvcnRzLmZvcm1hdCA9IGZ1bmN0aW9uKGYpIHtcbiAgaWYgKCFpc1N0cmluZyhmKSkge1xuICAgIHZhciBvYmplY3RzID0gW107XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBhcmd1bWVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIG9iamVjdHMucHVzaChpbnNwZWN0KGFyZ3VtZW50c1tpXSkpO1xuICAgIH1cbiAgICByZXR1cm4gb2JqZWN0cy5qb2luKCcgJyk7XG4gIH1cblxuICB2YXIgaSA9IDE7XG4gIHZhciBhcmdzID0gYXJndW1lbnRzO1xuICB2YXIgbGVuID0gYXJncy5sZW5ndGg7XG4gIHZhciBzdHIgPSBTdHJpbmcoZikucmVwbGFjZShmb3JtYXRSZWdFeHAsIGZ1bmN0aW9uKHgpIHtcbiAgICBpZiAoeCA9PT0gJyUlJykgcmV0dXJuICclJztcbiAgICBpZiAoaSA+PSBsZW4pIHJldHVybiB4O1xuICAgIHN3aXRjaCAoeCkge1xuICAgICAgY2FzZSAnJXMnOiByZXR1cm4gU3RyaW5nKGFyZ3NbaSsrXSk7XG4gICAgICBjYXNlICclZCc6IHJldHVybiBOdW1iZXIoYXJnc1tpKytdKTtcbiAgICAgIGNhc2UgJyVqJzpcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoYXJnc1tpKytdKTtcbiAgICAgICAgfSBjYXRjaCAoXykge1xuICAgICAgICAgIHJldHVybiAnW0NpcmN1bGFyXSc7XG4gICAgICAgIH1cbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHJldHVybiB4O1xuICAgIH1cbiAgfSk7XG4gIGZvciAodmFyIHggPSBhcmdzW2ldOyBpIDwgbGVuOyB4ID0gYXJnc1srK2ldKSB7XG4gICAgaWYgKGlzTnVsbCh4KSB8fCAhaXNPYmplY3QoeCkpIHtcbiAgICAgIHN0ciArPSAnICcgKyB4O1xuICAgIH0gZWxzZSB7XG4gICAgICBzdHIgKz0gJyAnICsgaW5zcGVjdCh4KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHN0cjtcbn07XG5cblxuLy8gTWFyayB0aGF0IGEgbWV0aG9kIHNob3VsZCBub3QgYmUgdXNlZC5cbi8vIFJldHVybnMgYSBtb2RpZmllZCBmdW5jdGlvbiB3aGljaCB3YXJucyBvbmNlIGJ5IGRlZmF1bHQuXG4vLyBJZiAtLW5vLWRlcHJlY2F0aW9uIGlzIHNldCwgdGhlbiBpdCBpcyBhIG5vLW9wLlxuZXhwb3J0cy5kZXByZWNhdGUgPSBmdW5jdGlvbihmbiwgbXNnKSB7XG4gIC8vIEFsbG93IGZvciBkZXByZWNhdGluZyB0aGluZ3MgaW4gdGhlIHByb2Nlc3Mgb2Ygc3RhcnRpbmcgdXAuXG4gIGlmIChpc1VuZGVmaW5lZChnbG9iYWwucHJvY2VzcykpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICByZXR1cm4gZXhwb3J0cy5kZXByZWNhdGUoZm4sIG1zZykuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICB9O1xuICB9XG5cbiAgaWYgKHByb2Nlc3Mubm9EZXByZWNhdGlvbiA9PT0gdHJ1ZSkge1xuICAgIHJldHVybiBmbjtcbiAgfVxuXG4gIHZhciB3YXJuZWQgPSBmYWxzZTtcbiAgZnVuY3Rpb24gZGVwcmVjYXRlZCgpIHtcbiAgICBpZiAoIXdhcm5lZCkge1xuICAgICAgaWYgKHByb2Nlc3MudGhyb3dEZXByZWNhdGlvbikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IobXNnKTtcbiAgICAgIH0gZWxzZSBpZiAocHJvY2Vzcy50cmFjZURlcHJlY2F0aW9uKSB7XG4gICAgICAgIGNvbnNvbGUudHJhY2UobXNnKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IobXNnKTtcbiAgICAgIH1cbiAgICAgIHdhcm5lZCA9IHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICB9XG5cbiAgcmV0dXJuIGRlcHJlY2F0ZWQ7XG59O1xuXG5cbnZhciBkZWJ1Z3MgPSB7fTtcbnZhciBkZWJ1Z0Vudmlyb247XG5leHBvcnRzLmRlYnVnbG9nID0gZnVuY3Rpb24oc2V0KSB7XG4gIGlmIChpc1VuZGVmaW5lZChkZWJ1Z0Vudmlyb24pKVxuICAgIGRlYnVnRW52aXJvbiA9IHByb2Nlc3MuZW52Lk5PREVfREVCVUcgfHwgJyc7XG4gIHNldCA9IHNldC50b1VwcGVyQ2FzZSgpO1xuICBpZiAoIWRlYnVnc1tzZXRdKSB7XG4gICAgaWYgKG5ldyBSZWdFeHAoJ1xcXFxiJyArIHNldCArICdcXFxcYicsICdpJykudGVzdChkZWJ1Z0Vudmlyb24pKSB7XG4gICAgICB2YXIgcGlkID0gcHJvY2Vzcy5waWQ7XG4gICAgICBkZWJ1Z3Nbc2V0XSA9IGZ1bmN0aW9uKCkge1xuICAgICAgICB2YXIgbXNnID0gZXhwb3J0cy5mb3JtYXQuYXBwbHkoZXhwb3J0cywgYXJndW1lbnRzKTtcbiAgICAgICAgY29uc29sZS5lcnJvcignJXMgJWQ6ICVzJywgc2V0LCBwaWQsIG1zZyk7XG4gICAgICB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBkZWJ1Z3Nbc2V0XSA9IGZ1bmN0aW9uKCkge307XG4gICAgfVxuICB9XG4gIHJldHVybiBkZWJ1Z3Nbc2V0XTtcbn07XG5cblxuLyoqXG4gKiBFY2hvcyB0aGUgdmFsdWUgb2YgYSB2YWx1ZS4gVHJ5cyB0byBwcmludCB0aGUgdmFsdWUgb3V0XG4gKiBpbiB0aGUgYmVzdCB3YXkgcG9zc2libGUgZ2l2ZW4gdGhlIGRpZmZlcmVudCB0eXBlcy5cbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gb2JqIFRoZSBvYmplY3QgdG8gcHJpbnQgb3V0LlxuICogQHBhcmFtIHtPYmplY3R9IG9wdHMgT3B0aW9uYWwgb3B0aW9ucyBvYmplY3QgdGhhdCBhbHRlcnMgdGhlIG91dHB1dC5cbiAqL1xuLyogbGVnYWN5OiBvYmosIHNob3dIaWRkZW4sIGRlcHRoLCBjb2xvcnMqL1xuZnVuY3Rpb24gaW5zcGVjdChvYmosIG9wdHMpIHtcbiAgLy8gZGVmYXVsdCBvcHRpb25zXG4gIHZhciBjdHggPSB7XG4gICAgc2VlbjogW10sXG4gICAgc3R5bGl6ZTogc3R5bGl6ZU5vQ29sb3JcbiAgfTtcbiAgLy8gbGVnYWN5Li4uXG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID49IDMpIGN0eC5kZXB0aCA9IGFyZ3VtZW50c1syXTtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPj0gNCkgY3R4LmNvbG9ycyA9IGFyZ3VtZW50c1szXTtcbiAgaWYgKGlzQm9vbGVhbihvcHRzKSkge1xuICAgIC8vIGxlZ2FjeS4uLlxuICAgIGN0eC5zaG93SGlkZGVuID0gb3B0cztcbiAgfSBlbHNlIGlmIChvcHRzKSB7XG4gICAgLy8gZ290IGFuIFwib3B0aW9uc1wiIG9iamVjdFxuICAgIGV4cG9ydHMuX2V4dGVuZChjdHgsIG9wdHMpO1xuICB9XG4gIC8vIHNldCBkZWZhdWx0IG9wdGlvbnNcbiAgaWYgKGlzVW5kZWZpbmVkKGN0eC5zaG93SGlkZGVuKSkgY3R4LnNob3dIaWRkZW4gPSBmYWxzZTtcbiAgaWYgKGlzVW5kZWZpbmVkKGN0eC5kZXB0aCkpIGN0eC5kZXB0aCA9IDI7XG4gIGlmIChpc1VuZGVmaW5lZChjdHguY29sb3JzKSkgY3R4LmNvbG9ycyA9IGZhbHNlO1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LmN1c3RvbUluc3BlY3QpKSBjdHguY3VzdG9tSW5zcGVjdCA9IHRydWU7XG4gIGlmIChjdHguY29sb3JzKSBjdHguc3R5bGl6ZSA9IHN0eWxpemVXaXRoQ29sb3I7XG4gIHJldHVybiBmb3JtYXRWYWx1ZShjdHgsIG9iaiwgY3R4LmRlcHRoKTtcbn1cbmV4cG9ydHMuaW5zcGVjdCA9IGluc3BlY3Q7XG5cblxuLy8gaHR0cDovL2VuLndpa2lwZWRpYS5vcmcvd2lraS9BTlNJX2VzY2FwZV9jb2RlI2dyYXBoaWNzXG5pbnNwZWN0LmNvbG9ycyA9IHtcbiAgJ2JvbGQnIDogWzEsIDIyXSxcbiAgJ2l0YWxpYycgOiBbMywgMjNdLFxuICAndW5kZXJsaW5lJyA6IFs0LCAyNF0sXG4gICdpbnZlcnNlJyA6IFs3LCAyN10sXG4gICd3aGl0ZScgOiBbMzcsIDM5XSxcbiAgJ2dyZXknIDogWzkwLCAzOV0sXG4gICdibGFjaycgOiBbMzAsIDM5XSxcbiAgJ2JsdWUnIDogWzM0LCAzOV0sXG4gICdjeWFuJyA6IFszNiwgMzldLFxuICAnZ3JlZW4nIDogWzMyLCAzOV0sXG4gICdtYWdlbnRhJyA6IFszNSwgMzldLFxuICAncmVkJyA6IFszMSwgMzldLFxuICAneWVsbG93JyA6IFszMywgMzldXG59O1xuXG4vLyBEb24ndCB1c2UgJ2JsdWUnIG5vdCB2aXNpYmxlIG9uIGNtZC5leGVcbmluc3BlY3Quc3R5bGVzID0ge1xuICAnc3BlY2lhbCc6ICdjeWFuJyxcbiAgJ251bWJlcic6ICd5ZWxsb3cnLFxuICAnYm9vbGVhbic6ICd5ZWxsb3cnLFxuICAndW5kZWZpbmVkJzogJ2dyZXknLFxuICAnbnVsbCc6ICdib2xkJyxcbiAgJ3N0cmluZyc6ICdncmVlbicsXG4gICdkYXRlJzogJ21hZ2VudGEnLFxuICAvLyBcIm5hbWVcIjogaW50ZW50aW9uYWxseSBub3Qgc3R5bGluZ1xuICAncmVnZXhwJzogJ3JlZCdcbn07XG5cblxuZnVuY3Rpb24gc3R5bGl6ZVdpdGhDb2xvcihzdHIsIHN0eWxlVHlwZSkge1xuICB2YXIgc3R5bGUgPSBpbnNwZWN0LnN0eWxlc1tzdHlsZVR5cGVdO1xuXG4gIGlmIChzdHlsZSkge1xuICAgIHJldHVybiAnXFx1MDAxYlsnICsgaW5zcGVjdC5jb2xvcnNbc3R5bGVdWzBdICsgJ20nICsgc3RyICtcbiAgICAgICAgICAgJ1xcdTAwMWJbJyArIGluc3BlY3QuY29sb3JzW3N0eWxlXVsxXSArICdtJztcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gc3RyO1xuICB9XG59XG5cblxuZnVuY3Rpb24gc3R5bGl6ZU5vQ29sb3Ioc3RyLCBzdHlsZVR5cGUpIHtcbiAgcmV0dXJuIHN0cjtcbn1cblxuXG5mdW5jdGlvbiBhcnJheVRvSGFzaChhcnJheSkge1xuICB2YXIgaGFzaCA9IHt9O1xuXG4gIGFycmF5LmZvckVhY2goZnVuY3Rpb24odmFsLCBpZHgpIHtcbiAgICBoYXNoW3ZhbF0gPSB0cnVlO1xuICB9KTtcblxuICByZXR1cm4gaGFzaDtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRWYWx1ZShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMpIHtcbiAgLy8gUHJvdmlkZSBhIGhvb2sgZm9yIHVzZXItc3BlY2lmaWVkIGluc3BlY3QgZnVuY3Rpb25zLlxuICAvLyBDaGVjayB0aGF0IHZhbHVlIGlzIGFuIG9iamVjdCB3aXRoIGFuIGluc3BlY3QgZnVuY3Rpb24gb24gaXRcbiAgaWYgKGN0eC5jdXN0b21JbnNwZWN0ICYmXG4gICAgICB2YWx1ZSAmJlxuICAgICAgaXNGdW5jdGlvbih2YWx1ZS5pbnNwZWN0KSAmJlxuICAgICAgLy8gRmlsdGVyIG91dCB0aGUgdXRpbCBtb2R1bGUsIGl0J3MgaW5zcGVjdCBmdW5jdGlvbiBpcyBzcGVjaWFsXG4gICAgICB2YWx1ZS5pbnNwZWN0ICE9PSBleHBvcnRzLmluc3BlY3QgJiZcbiAgICAgIC8vIEFsc28gZmlsdGVyIG91dCBhbnkgcHJvdG90eXBlIG9iamVjdHMgdXNpbmcgdGhlIGNpcmN1bGFyIGNoZWNrLlxuICAgICAgISh2YWx1ZS5jb25zdHJ1Y3RvciAmJiB2YWx1ZS5jb25zdHJ1Y3Rvci5wcm90b3R5cGUgPT09IHZhbHVlKSkge1xuICAgIHZhciByZXQgPSB2YWx1ZS5pbnNwZWN0KHJlY3Vyc2VUaW1lcywgY3R4KTtcbiAgICBpZiAoIWlzU3RyaW5nKHJldCkpIHtcbiAgICAgIHJldCA9IGZvcm1hdFZhbHVlKGN0eCwgcmV0LCByZWN1cnNlVGltZXMpO1xuICAgIH1cbiAgICByZXR1cm4gcmV0O1xuICB9XG5cbiAgLy8gUHJpbWl0aXZlIHR5cGVzIGNhbm5vdCBoYXZlIHByb3BlcnRpZXNcbiAgdmFyIHByaW1pdGl2ZSA9IGZvcm1hdFByaW1pdGl2ZShjdHgsIHZhbHVlKTtcbiAgaWYgKHByaW1pdGl2ZSkge1xuICAgIHJldHVybiBwcmltaXRpdmU7XG4gIH1cblxuICAvLyBMb29rIHVwIHRoZSBrZXlzIG9mIHRoZSBvYmplY3QuXG4gIHZhciBrZXlzID0gT2JqZWN0LmtleXModmFsdWUpO1xuICB2YXIgdmlzaWJsZUtleXMgPSBhcnJheVRvSGFzaChrZXlzKTtcblxuICBpZiAoY3R4LnNob3dIaWRkZW4pIHtcbiAgICBrZXlzID0gT2JqZWN0LmdldE93blByb3BlcnR5TmFtZXModmFsdWUpO1xuICB9XG5cbiAgLy8gSUUgZG9lc24ndCBtYWtlIGVycm9yIGZpZWxkcyBub24tZW51bWVyYWJsZVxuICAvLyBodHRwOi8vbXNkbi5taWNyb3NvZnQuY29tL2VuLXVzL2xpYnJhcnkvaWUvZHd3NTJzYnQodj12cy45NCkuYXNweFxuICBpZiAoaXNFcnJvcih2YWx1ZSlcbiAgICAgICYmIChrZXlzLmluZGV4T2YoJ21lc3NhZ2UnKSA+PSAwIHx8IGtleXMuaW5kZXhPZignZGVzY3JpcHRpb24nKSA+PSAwKSkge1xuICAgIHJldHVybiBmb3JtYXRFcnJvcih2YWx1ZSk7XG4gIH1cblxuICAvLyBTb21lIHR5cGUgb2Ygb2JqZWN0IHdpdGhvdXQgcHJvcGVydGllcyBjYW4gYmUgc2hvcnRjdXR0ZWQuXG4gIGlmIChrZXlzLmxlbmd0aCA9PT0gMCkge1xuICAgIGlmIChpc0Z1bmN0aW9uKHZhbHVlKSkge1xuICAgICAgdmFyIG5hbWUgPSB2YWx1ZS5uYW1lID8gJzogJyArIHZhbHVlLm5hbWUgOiAnJztcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZSgnW0Z1bmN0aW9uJyArIG5hbWUgKyAnXScsICdzcGVjaWFsJyk7XG4gICAgfVxuICAgIGlmIChpc1JlZ0V4cCh2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZShSZWdFeHAucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpLCAncmVnZXhwJyk7XG4gICAgfVxuICAgIGlmIChpc0RhdGUodmFsdWUpKSB7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoRGF0ZS5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSksICdkYXRlJyk7XG4gICAgfVxuICAgIGlmIChpc0Vycm9yKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGZvcm1hdEVycm9yKHZhbHVlKTtcbiAgICB9XG4gIH1cblxuICB2YXIgYmFzZSA9ICcnLCBhcnJheSA9IGZhbHNlLCBicmFjZXMgPSBbJ3snLCAnfSddO1xuXG4gIC8vIE1ha2UgQXJyYXkgc2F5IHRoYXQgdGhleSBhcmUgQXJyYXlcbiAgaWYgKGlzQXJyYXkodmFsdWUpKSB7XG4gICAgYXJyYXkgPSB0cnVlO1xuICAgIGJyYWNlcyA9IFsnWycsICddJ107XG4gIH1cblxuICAvLyBNYWtlIGZ1bmN0aW9ucyBzYXkgdGhhdCB0aGV5IGFyZSBmdW5jdGlvbnNcbiAgaWYgKGlzRnVuY3Rpb24odmFsdWUpKSB7XG4gICAgdmFyIG4gPSB2YWx1ZS5uYW1lID8gJzogJyArIHZhbHVlLm5hbWUgOiAnJztcbiAgICBiYXNlID0gJyBbRnVuY3Rpb24nICsgbiArICddJztcbiAgfVxuXG4gIC8vIE1ha2UgUmVnRXhwcyBzYXkgdGhhdCB0aGV5IGFyZSBSZWdFeHBzXG4gIGlmIChpc1JlZ0V4cCh2YWx1ZSkpIHtcbiAgICBiYXNlID0gJyAnICsgUmVnRXhwLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKTtcbiAgfVxuXG4gIC8vIE1ha2UgZGF0ZXMgd2l0aCBwcm9wZXJ0aWVzIGZpcnN0IHNheSB0aGUgZGF0ZVxuICBpZiAoaXNEYXRlKHZhbHVlKSkge1xuICAgIGJhc2UgPSAnICcgKyBEYXRlLnByb3RvdHlwZS50b1VUQ1N0cmluZy5jYWxsKHZhbHVlKTtcbiAgfVxuXG4gIC8vIE1ha2UgZXJyb3Igd2l0aCBtZXNzYWdlIGZpcnN0IHNheSB0aGUgZXJyb3JcbiAgaWYgKGlzRXJyb3IodmFsdWUpKSB7XG4gICAgYmFzZSA9ICcgJyArIGZvcm1hdEVycm9yKHZhbHVlKTtcbiAgfVxuXG4gIGlmIChrZXlzLmxlbmd0aCA9PT0gMCAmJiAoIWFycmF5IHx8IHZhbHVlLmxlbmd0aCA9PSAwKSkge1xuICAgIHJldHVybiBicmFjZXNbMF0gKyBiYXNlICsgYnJhY2VzWzFdO1xuICB9XG5cbiAgaWYgKHJlY3Vyc2VUaW1lcyA8IDApIHtcbiAgICBpZiAoaXNSZWdFeHAodmFsdWUpKSB7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoUmVnRXhwLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKSwgJ3JlZ2V4cCcpO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoJ1tPYmplY3RdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH1cblxuICBjdHguc2Vlbi5wdXNoKHZhbHVlKTtcblxuICB2YXIgb3V0cHV0O1xuICBpZiAoYXJyYXkpIHtcbiAgICBvdXRwdXQgPSBmb3JtYXRBcnJheShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLCBrZXlzKTtcbiAgfSBlbHNlIHtcbiAgICBvdXRwdXQgPSBrZXlzLm1hcChmdW5jdGlvbihrZXkpIHtcbiAgICAgIHJldHVybiBmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLCBrZXksIGFycmF5KTtcbiAgICB9KTtcbiAgfVxuXG4gIGN0eC5zZWVuLnBvcCgpO1xuXG4gIHJldHVybiByZWR1Y2VUb1NpbmdsZVN0cmluZyhvdXRwdXQsIGJhc2UsIGJyYWNlcyk7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0UHJpbWl0aXZlKGN0eCwgdmFsdWUpIHtcbiAgaWYgKGlzVW5kZWZpbmVkKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJ3VuZGVmaW5lZCcsICd1bmRlZmluZWQnKTtcbiAgaWYgKGlzU3RyaW5nKHZhbHVlKSkge1xuICAgIHZhciBzaW1wbGUgPSAnXFwnJyArIEpTT04uc3RyaW5naWZ5KHZhbHVlKS5yZXBsYWNlKC9eXCJ8XCIkL2csICcnKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLnJlcGxhY2UoL1xcXFxcIi9nLCAnXCInKSArICdcXCcnO1xuICAgIHJldHVybiBjdHguc3R5bGl6ZShzaW1wbGUsICdzdHJpbmcnKTtcbiAgfVxuICBpZiAoaXNOdW1iZXIodmFsdWUpKVxuICAgIHJldHVybiBjdHguc3R5bGl6ZSgnJyArIHZhbHVlLCAnbnVtYmVyJyk7XG4gIGlmIChpc0Jvb2xlYW4odmFsdWUpKVxuICAgIHJldHVybiBjdHguc3R5bGl6ZSgnJyArIHZhbHVlLCAnYm9vbGVhbicpO1xuICAvLyBGb3Igc29tZSByZWFzb24gdHlwZW9mIG51bGwgaXMgXCJvYmplY3RcIiwgc28gc3BlY2lhbCBjYXNlIGhlcmUuXG4gIGlmIChpc051bGwodmFsdWUpKVxuICAgIHJldHVybiBjdHguc3R5bGl6ZSgnbnVsbCcsICdudWxsJyk7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0RXJyb3IodmFsdWUpIHtcbiAgcmV0dXJuICdbJyArIEVycm9yLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKSArICddJztcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRBcnJheShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLCBrZXlzKSB7XG4gIHZhciBvdXRwdXQgPSBbXTtcbiAgZm9yICh2YXIgaSA9IDAsIGwgPSB2YWx1ZS5sZW5ndGg7IGkgPCBsOyArK2kpIHtcbiAgICBpZiAoaGFzT3duUHJvcGVydHkodmFsdWUsIFN0cmluZyhpKSkpIHtcbiAgICAgIG91dHB1dC5wdXNoKGZvcm1hdFByb3BlcnR5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsXG4gICAgICAgICAgU3RyaW5nKGkpLCB0cnVlKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG91dHB1dC5wdXNoKCcnKTtcbiAgICB9XG4gIH1cbiAga2V5cy5mb3JFYWNoKGZ1bmN0aW9uKGtleSkge1xuICAgIGlmICgha2V5Lm1hdGNoKC9eXFxkKyQvKSkge1xuICAgICAgb3V0cHV0LnB1c2goZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cyxcbiAgICAgICAgICBrZXksIHRydWUpKTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gb3V0cHV0O1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdFByb3BlcnR5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleSwgYXJyYXkpIHtcbiAgdmFyIG5hbWUsIHN0ciwgZGVzYztcbiAgZGVzYyA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IodmFsdWUsIGtleSkgfHwgeyB2YWx1ZTogdmFsdWVba2V5XSB9O1xuICBpZiAoZGVzYy5nZXQpIHtcbiAgICBpZiAoZGVzYy5zZXQpIHtcbiAgICAgIHN0ciA9IGN0eC5zdHlsaXplKCdbR2V0dGVyL1NldHRlcl0nLCAnc3BlY2lhbCcpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW0dldHRlcl0nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBpZiAoZGVzYy5zZXQpIHtcbiAgICAgIHN0ciA9IGN0eC5zdHlsaXplKCdbU2V0dGVyXScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9XG4gIGlmICghaGFzT3duUHJvcGVydHkodmlzaWJsZUtleXMsIGtleSkpIHtcbiAgICBuYW1lID0gJ1snICsga2V5ICsgJ10nO1xuICB9XG4gIGlmICghc3RyKSB7XG4gICAgaWYgKGN0eC5zZWVuLmluZGV4T2YoZGVzYy52YWx1ZSkgPCAwKSB7XG4gICAgICBpZiAoaXNOdWxsKHJlY3Vyc2VUaW1lcykpIHtcbiAgICAgICAgc3RyID0gZm9ybWF0VmFsdWUoY3R4LCBkZXNjLnZhbHVlLCBudWxsKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHN0ciA9IGZvcm1hdFZhbHVlKGN0eCwgZGVzYy52YWx1ZSwgcmVjdXJzZVRpbWVzIC0gMSk7XG4gICAgICB9XG4gICAgICBpZiAoc3RyLmluZGV4T2YoJ1xcbicpID4gLTEpIHtcbiAgICAgICAgaWYgKGFycmF5KSB7XG4gICAgICAgICAgc3RyID0gc3RyLnNwbGl0KCdcXG4nKS5tYXAoZnVuY3Rpb24obGluZSkge1xuICAgICAgICAgICAgcmV0dXJuICcgICcgKyBsaW5lO1xuICAgICAgICAgIH0pLmpvaW4oJ1xcbicpLnN1YnN0cigyKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBzdHIgPSAnXFxuJyArIHN0ci5zcGxpdCgnXFxuJykubWFwKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgICAgICAgIHJldHVybiAnICAgJyArIGxpbmU7XG4gICAgICAgICAgfSkuam9pbignXFxuJyk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tDaXJjdWxhcl0nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgfVxuICBpZiAoaXNVbmRlZmluZWQobmFtZSkpIHtcbiAgICBpZiAoYXJyYXkgJiYga2V5Lm1hdGNoKC9eXFxkKyQvKSkge1xuICAgICAgcmV0dXJuIHN0cjtcbiAgICB9XG4gICAgbmFtZSA9IEpTT04uc3RyaW5naWZ5KCcnICsga2V5KTtcbiAgICBpZiAobmFtZS5tYXRjaCgvXlwiKFthLXpBLVpfXVthLXpBLVpfMC05XSopXCIkLykpIHtcbiAgICAgIG5hbWUgPSBuYW1lLnN1YnN0cigxLCBuYW1lLmxlbmd0aCAtIDIpO1xuICAgICAgbmFtZSA9IGN0eC5zdHlsaXplKG5hbWUsICduYW1lJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG5hbWUgPSBuYW1lLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKVxuICAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFxcXFwiL2csICdcIicpXG4gICAgICAgICAgICAgICAgIC5yZXBsYWNlKC8oXlwifFwiJCkvZywgXCInXCIpO1xuICAgICAgbmFtZSA9IGN0eC5zdHlsaXplKG5hbWUsICdzdHJpbmcnKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gbmFtZSArICc6ICcgKyBzdHI7XG59XG5cblxuZnVuY3Rpb24gcmVkdWNlVG9TaW5nbGVTdHJpbmcob3V0cHV0LCBiYXNlLCBicmFjZXMpIHtcbiAgdmFyIG51bUxpbmVzRXN0ID0gMDtcbiAgdmFyIGxlbmd0aCA9IG91dHB1dC5yZWR1Y2UoZnVuY3Rpb24ocHJldiwgY3VyKSB7XG4gICAgbnVtTGluZXNFc3QrKztcbiAgICBpZiAoY3VyLmluZGV4T2YoJ1xcbicpID49IDApIG51bUxpbmVzRXN0Kys7XG4gICAgcmV0dXJuIHByZXYgKyBjdXIucmVwbGFjZSgvXFx1MDAxYlxcW1xcZFxcZD9tL2csICcnKS5sZW5ndGggKyAxO1xuICB9LCAwKTtcblxuICBpZiAobGVuZ3RoID4gNjApIHtcbiAgICByZXR1cm4gYnJhY2VzWzBdICtcbiAgICAgICAgICAgKGJhc2UgPT09ICcnID8gJycgOiBiYXNlICsgJ1xcbiAnKSArXG4gICAgICAgICAgICcgJyArXG4gICAgICAgICAgIG91dHB1dC5qb2luKCcsXFxuICAnKSArXG4gICAgICAgICAgICcgJyArXG4gICAgICAgICAgIGJyYWNlc1sxXTtcbiAgfVxuXG4gIHJldHVybiBicmFjZXNbMF0gKyBiYXNlICsgJyAnICsgb3V0cHV0LmpvaW4oJywgJykgKyAnICcgKyBicmFjZXNbMV07XG59XG5cblxuLy8gTk9URTogVGhlc2UgdHlwZSBjaGVja2luZyBmdW5jdGlvbnMgaW50ZW50aW9uYWxseSBkb24ndCB1c2UgYGluc3RhbmNlb2ZgXG4vLyBiZWNhdXNlIGl0IGlzIGZyYWdpbGUgYW5kIGNhbiBiZSBlYXNpbHkgZmFrZWQgd2l0aCBgT2JqZWN0LmNyZWF0ZSgpYC5cbmZ1bmN0aW9uIGlzQXJyYXkoYXIpIHtcbiAgcmV0dXJuIEFycmF5LmlzQXJyYXkoYXIpO1xufVxuZXhwb3J0cy5pc0FycmF5ID0gaXNBcnJheTtcblxuZnVuY3Rpb24gaXNCb29sZWFuKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ2Jvb2xlYW4nO1xufVxuZXhwb3J0cy5pc0Jvb2xlYW4gPSBpc0Jvb2xlYW47XG5cbmZ1bmN0aW9uIGlzTnVsbChhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gbnVsbDtcbn1cbmV4cG9ydHMuaXNOdWxsID0gaXNOdWxsO1xuXG5mdW5jdGlvbiBpc051bGxPclVuZGVmaW5lZChhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PSBudWxsO1xufVxuZXhwb3J0cy5pc051bGxPclVuZGVmaW5lZCA9IGlzTnVsbE9yVW5kZWZpbmVkO1xuXG5mdW5jdGlvbiBpc051bWJlcihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdudW1iZXInO1xufVxuZXhwb3J0cy5pc051bWJlciA9IGlzTnVtYmVyO1xuXG5mdW5jdGlvbiBpc1N0cmluZyhhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdzdHJpbmcnO1xufVxuZXhwb3J0cy5pc1N0cmluZyA9IGlzU3RyaW5nO1xuXG5mdW5jdGlvbiBpc1N5bWJvbChhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdzeW1ib2wnO1xufVxuZXhwb3J0cy5pc1N5bWJvbCA9IGlzU3ltYm9sO1xuXG5mdW5jdGlvbiBpc1VuZGVmaW5lZChhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gdm9pZCAwO1xufVxuZXhwb3J0cy5pc1VuZGVmaW5lZCA9IGlzVW5kZWZpbmVkO1xuXG5mdW5jdGlvbiBpc1JlZ0V4cChyZSkge1xuICByZXR1cm4gaXNPYmplY3QocmUpICYmIG9iamVjdFRvU3RyaW5nKHJlKSA9PT0gJ1tvYmplY3QgUmVnRXhwXSc7XG59XG5leHBvcnRzLmlzUmVnRXhwID0gaXNSZWdFeHA7XG5cbmZ1bmN0aW9uIGlzT2JqZWN0KGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ29iamVjdCcgJiYgYXJnICE9PSBudWxsO1xufVxuZXhwb3J0cy5pc09iamVjdCA9IGlzT2JqZWN0O1xuXG5mdW5jdGlvbiBpc0RhdGUoZCkge1xuICByZXR1cm4gaXNPYmplY3QoZCkgJiYgb2JqZWN0VG9TdHJpbmcoZCkgPT09ICdbb2JqZWN0IERhdGVdJztcbn1cbmV4cG9ydHMuaXNEYXRlID0gaXNEYXRlO1xuXG5mdW5jdGlvbiBpc0Vycm9yKGUpIHtcbiAgcmV0dXJuIGlzT2JqZWN0KGUpICYmXG4gICAgICAob2JqZWN0VG9TdHJpbmcoZSkgPT09ICdbb2JqZWN0IEVycm9yXScgfHwgZSBpbnN0YW5jZW9mIEVycm9yKTtcbn1cbmV4cG9ydHMuaXNFcnJvciA9IGlzRXJyb3I7XG5cbmZ1bmN0aW9uIGlzRnVuY3Rpb24oYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnZnVuY3Rpb24nO1xufVxuZXhwb3J0cy5pc0Z1bmN0aW9uID0gaXNGdW5jdGlvbjtcblxuZnVuY3Rpb24gaXNQcmltaXRpdmUoYXJnKSB7XG4gIHJldHVybiBhcmcgPT09IG51bGwgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdib29sZWFuJyB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ251bWJlcicgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdzdHJpbmcnIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnc3ltYm9sJyB8fCAgLy8gRVM2IHN5bWJvbFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ3VuZGVmaW5lZCc7XG59XG5leHBvcnRzLmlzUHJpbWl0aXZlID0gaXNQcmltaXRpdmU7XG5cbmV4cG9ydHMuaXNCdWZmZXIgPSByZXF1aXJlKCcuL3N1cHBvcnQvaXNCdWZmZXInKTtcblxuZnVuY3Rpb24gb2JqZWN0VG9TdHJpbmcobykge1xuICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKG8pO1xufVxuXG5cbmZ1bmN0aW9uIHBhZChuKSB7XG4gIHJldHVybiBuIDwgMTAgPyAnMCcgKyBuLnRvU3RyaW5nKDEwKSA6IG4udG9TdHJpbmcoMTApO1xufVxuXG5cbnZhciBtb250aHMgPSBbJ0phbicsICdGZWInLCAnTWFyJywgJ0FwcicsICdNYXknLCAnSnVuJywgJ0p1bCcsICdBdWcnLCAnU2VwJyxcbiAgICAgICAgICAgICAgJ09jdCcsICdOb3YnLCAnRGVjJ107XG5cbi8vIDI2IEZlYiAxNjoxOTozNFxuZnVuY3Rpb24gdGltZXN0YW1wKCkge1xuICB2YXIgZCA9IG5ldyBEYXRlKCk7XG4gIHZhciB0aW1lID0gW3BhZChkLmdldEhvdXJzKCkpLFxuICAgICAgICAgICAgICBwYWQoZC5nZXRNaW51dGVzKCkpLFxuICAgICAgICAgICAgICBwYWQoZC5nZXRTZWNvbmRzKCkpXS5qb2luKCc6Jyk7XG4gIHJldHVybiBbZC5nZXREYXRlKCksIG1vbnRoc1tkLmdldE1vbnRoKCldLCB0aW1lXS5qb2luKCcgJyk7XG59XG5cblxuLy8gbG9nIGlzIGp1c3QgYSB0aGluIHdyYXBwZXIgdG8gY29uc29sZS5sb2cgdGhhdCBwcmVwZW5kcyBhIHRpbWVzdGFtcFxuZXhwb3J0cy5sb2cgPSBmdW5jdGlvbigpIHtcbiAgY29uc29sZS5sb2coJyVzIC0gJXMnLCB0aW1lc3RhbXAoKSwgZXhwb3J0cy5mb3JtYXQuYXBwbHkoZXhwb3J0cywgYXJndW1lbnRzKSk7XG59O1xuXG5cbi8qKlxuICogSW5oZXJpdCB0aGUgcHJvdG90eXBlIG1ldGhvZHMgZnJvbSBvbmUgY29uc3RydWN0b3IgaW50byBhbm90aGVyLlxuICpcbiAqIFRoZSBGdW5jdGlvbi5wcm90b3R5cGUuaW5oZXJpdHMgZnJvbSBsYW5nLmpzIHJld3JpdHRlbiBhcyBhIHN0YW5kYWxvbmVcbiAqIGZ1bmN0aW9uIChub3Qgb24gRnVuY3Rpb24ucHJvdG90eXBlKS4gTk9URTogSWYgdGhpcyBmaWxlIGlzIHRvIGJlIGxvYWRlZFxuICogZHVyaW5nIGJvb3RzdHJhcHBpbmcgdGhpcyBmdW5jdGlvbiBuZWVkcyB0byBiZSByZXdyaXR0ZW4gdXNpbmcgc29tZSBuYXRpdmVcbiAqIGZ1bmN0aW9ucyBhcyBwcm90b3R5cGUgc2V0dXAgdXNpbmcgbm9ybWFsIEphdmFTY3JpcHQgZG9lcyBub3Qgd29yayBhc1xuICogZXhwZWN0ZWQgZHVyaW5nIGJvb3RzdHJhcHBpbmcgKHNlZSBtaXJyb3IuanMgaW4gcjExNDkwMykuXG4gKlxuICogQHBhcmFtIHtmdW5jdGlvbn0gY3RvciBDb25zdHJ1Y3RvciBmdW5jdGlvbiB3aGljaCBuZWVkcyB0byBpbmhlcml0IHRoZVxuICogICAgIHByb3RvdHlwZS5cbiAqIEBwYXJhbSB7ZnVuY3Rpb259IHN1cGVyQ3RvciBDb25zdHJ1Y3RvciBmdW5jdGlvbiB0byBpbmhlcml0IHByb3RvdHlwZSBmcm9tLlxuICovXG5leHBvcnRzLmluaGVyaXRzID0gcmVxdWlyZSgnaW5oZXJpdHMnKTtcblxuZXhwb3J0cy5fZXh0ZW5kID0gZnVuY3Rpb24ob3JpZ2luLCBhZGQpIHtcbiAgLy8gRG9uJ3QgZG8gYW55dGhpbmcgaWYgYWRkIGlzbid0IGFuIG9iamVjdFxuICBpZiAoIWFkZCB8fCAhaXNPYmplY3QoYWRkKSkgcmV0dXJuIG9yaWdpbjtcblxuICB2YXIga2V5cyA9IE9iamVjdC5rZXlzKGFkZCk7XG4gIHZhciBpID0ga2V5cy5sZW5ndGg7XG4gIHdoaWxlIChpLS0pIHtcbiAgICBvcmlnaW5ba2V5c1tpXV0gPSBhZGRba2V5c1tpXV07XG4gIH1cbiAgcmV0dXJuIG9yaWdpbjtcbn07XG5cbmZ1bmN0aW9uIGhhc093blByb3BlcnR5KG9iaiwgcHJvcCkge1xuICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG9iaiwgcHJvcCk7XG59XG4iLCIvKiBnbG9iYWwgZGVzY3JpYmUgaXQgKi9cbmNvbnN0IGFzc2VydCA9IHJlcXVpcmUoJ2Fzc2VydCcpO1xuY29uc3QgZGVxID0gKHpfZXhwZWN0LCB6X2FjdHVhbCkgPT4ge1xuXHRhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHpfYWN0dWFsLCB6X2V4cGVjdCk7XG59O1xuY29uc3QgZXEgPSAoel9leHBlY3QsIHpfYWN0dWFsKSA9PiB7XG5cdGFzc2VydC5zdHJpY3RFcXVhbCh6X2FjdHVhbCwgel9leHBlY3QpO1xufTtcbmNvbnN0IGZzID0gcmVxdWlyZSgnZnMnKTtcblxuY29uc3Qgd29ya2VyID0gcmVxdWlyZSgnLi4vLi4vZGlzdC9tYWluL21vZHVsZS5qcycpLnNjb3BpZnkocmVxdWlyZSwgKCkgPT4ge1xuXHRyZXF1aXJlKCcuL3dvcmtlcnMvYmFzaWMuanMnKTtcbn0sICd1bmRlZmluZWQnICE9PSB0eXBlb2YgYXJndW1lbnRzICYmIGFyZ3VtZW50cyk7XG5cbmNvbnN0IHNwYXduID0gKHNfbmFtZT0nYmFzaWMnKSA9PiB3b3JrZXIuc3Bhd24oYC4vd29ya2Vycy8ke3NfbmFtZX0uanNgKTtcbmNvbnN0IGdyb3VwID0gKG5fd29ya2Vycywgc19uYW1lPSdiYXNpYycpID0+IHdvcmtlci5ncm91cChgLi93b3JrZXJzLyR7c19uYW1lfS5qc2AsIG5fd29ya2Vycyk7XG5cbmNvbnN0IHJ1biA9IGFzeW5jICguLi5hX2FyZ3MpID0+IHtcblx0bGV0IGtfd29ya2VyID0gc3Bhd24oKTtcblx0bGV0IHpfcmVzdWx0ID0gYXdhaXQga193b3JrZXIucnVuKC4uLmFfYXJncyk7XG5cdGF3YWl0IGtfd29ya2VyLmtpbGwoKTtcblx0cmV0dXJuIHpfcmVzdWx0O1xufTtcblxuXG5kZXNjcmliZSgnd29ya2VyJywgKCkgPT4ge1xuXG5cdGl0KCdydW5zJywgYXN5bmMgKCkgPT4ge1xuXHRcdGVxKCd5ZWgnLCBhd2FpdCBydW4oJ3JldmVyc2Vfc3RyaW5nJywgWydoZXknXSkpO1xuXHR9KTtcblxuXHRpdCgndHdpY2UnLCBhc3luYyAoKSA9PiB7XG5cdFx0bGV0IGtfd29ya2VyID0gc3Bhd24oKTtcblx0XHRsZXQgc195ZWggPSBhd2FpdCBrX3dvcmtlci5ydW4oJ3JldmVyc2Vfc3RyaW5nJywgWydoZXknXSk7XG5cdFx0ZXEoJ2hleScsIGF3YWl0IHJ1bigncmV2ZXJzZV9zdHJpbmcnLCBbc195ZWhdKSk7XG5cdFx0YXdhaXQga193b3JrZXIua2lsbCgpO1xuXHR9KTtcblxuXHRpdCgndGVybWluYXRlcycsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBrX3dvcmtlciA9IHNwYXduKCk7XG5cdFx0a193b3JrZXIucnVuKCd3YWl0JywgW1s1MDAwXV0pXG5cdFx0XHQudGhlbigoKSA9PiBma2VfdGVzdCgnd29ya2VyIGRpZCBub3QgdGVybWluYXRlIGJlZm9yZSBmaW5pc2hpbmcgdGFzaycpKVxuXHRcdFx0LmNhdGNoKChlX3J1bikgPT4ge1xuXHRcdFx0XHRma2VfdGVzdChlX3J1bik7XG5cdFx0XHR9KTtcblx0XHRzZXRUaW1lb3V0KGFzeW5jICgpID0+IHtcblx0XHRcdGF3YWl0IGtfd29ya2VyLmtpbGwoKTtcblx0XHRcdGZrZV90ZXN0KCk7XG5cdFx0fSwgMTAwKTtcblx0fSk7XG5cblx0aXQoJ2NhdGNoZXMnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQga193b3JrZXIgPSBzcGF3bigpO1xuXHRcdGtfd29ya2VyLnJ1bignZmFpbCcpXG5cdFx0XHQudGhlbigoKSA9PiBma2VfdGVzdCgnZXJyb3Igbm90IGNhdWdodCBieSBtYXN0ZXInKSlcblx0XHRcdC5jYXRjaChhc3luYyAoZV9ydW4pID0+IHtcblx0XHRcdFx0YXNzZXJ0KGVfcnVuLm1lc3NhZ2UuaW5jbHVkZXMoJ25vIHN1Y2ggdGFzaycpKTtcblx0XHRcdFx0YXdhaXQga193b3JrZXIua2lsbCgpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdldmVudHMnLCBhc3luYyAoKSA9PiB7XG5cdFx0bGV0IGhfY29udm8gPSB7XG5cdFx0XHRncmVldDogJ2hpJyxcblx0XHRcdGNoYXQ6ICdob3cgciB1Jyxcblx0XHRcdHllbGw6ICdhaGghJyxcblx0XHRcdGFwb2xvZ2l6ZTogJ3NvcnJ5Jyxcblx0XHRcdGZvcmdpdmU6ICdtbWsnLFxuXHRcdFx0ZXhpdDogJ2tieWUnLFxuXHRcdH07XG5cblx0XHRsZXQgYV9kYXRhID0gW107XG5cdFx0bGV0IGhfcmVzcG9uc2VzID0ge307XG5cdFx0bGV0IGNfcmVzcG9uc2VzID0gMDtcblx0XHRPYmplY3Qua2V5cyhoX2NvbnZvKS5mb3JFYWNoKChzX2tleSwgaV9rZXkpID0+IHtcblx0XHRcdGFfZGF0YS5wdXNoKHtcblx0XHRcdFx0bmFtZTogc19rZXksXG5cdFx0XHRcdGRhdGE6IGhfY29udm9bc19rZXldLFxuXHRcdFx0XHR3YWl0OiBpX2tleT8gMTAwOiAwLFxuXHRcdFx0fSk7XG5cblx0XHRcdGhfcmVzcG9uc2VzW3Nfa2V5XSA9IChzX21zZykgPT4ge1xuXHRcdFx0XHRlcShoX2NvbnZvW3Nfa2V5XSwgc19tc2cpO1xuXHRcdFx0XHRjX3Jlc3BvbnNlcyArPSAxO1xuXHRcdFx0fTtcblx0XHR9KTtcblxuXHRcdGxldCBrX3dvcmtlciA9IHNwYXduKCk7XG5cdFx0YXdhaXQga193b3JrZXIucnVuKCdldmVudHMnLCBbYV9kYXRhXSwgaF9yZXNwb25zZXMpO1xuXHRcdGF3YWl0IGtfd29ya2VyLmtpbGwoKTtcblx0XHRlcShhX2RhdGEubGVuZ3RoLCBjX3Jlc3BvbnNlcyk7XG5cdH0pO1xuXG5cdGl0KCdzdG9yZScsIGFzeW5jICgpID0+IHtcblx0XHRsZXQga193b3JrZXIgPSBzcGF3bigpO1xuXHRcdGF3YWl0IGtfd29ya2VyLnJ1bignc3RvcmUnLCBbW3t0ZXN0Oid2YWx1ZSd9XV0pO1xuXHRcdGxldCBhX3ZhbHVlcyA9IGF3YWl0IGtfd29ya2VyLnJ1bignZmV0Y2gnLCBbWyd0ZXN0J11dKTtcblx0XHRhd2FpdCBrX3dvcmtlci5raWxsKCk7XG5cdFx0ZXEoJ3ZhbHVlJywgYV92YWx1ZXNbMF0pO1xuXHR9KTtcbn0pO1xuXG5cbmRlc2NyaWJlKCdncm91cCcsICgpID0+IHtcblxuXHRpdCgnbWFwL3RocnUnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQgYV9zZXEgPSBbOCwgMSwgNywgNCwgMywgNSwgMiwgNl07XG5cdFx0bGV0IGtfZ3JvdXAgPSBncm91cChhX3NlcS5sZW5ndGgpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKGFfc2VxKVxuXHRcdFx0Lm1hcCgnbXVsdGlwbHknLCBbMl0pXG5cdFx0XHQudGhydSgnYWRkJywgWzNdKVxuXHRcdFx0LmVhY2goKHhfbiwgaV9uKSA9PiB7XG5cdFx0XHRcdGVxKChhX3NlcVtpX25dKjIpKzMsIHhfblswXSk7XG5cdFx0XHR9LCBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdGF3YWl0IGtfZ3JvdXAua2lsbCgpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdtYXAvZWFjaCcsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBhX3NlcSA9IFs4LCAxLCA3LCA0LCAzLCA1LCAyLCA2XS5tYXAoeCA9PiB4KjEwMCk7XG5cdFx0bGV0IGtfZ3JvdXAgPSBncm91cChhX3NlcS5sZW5ndGgpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKGFfc2VxKVxuXHRcdFx0Lm1hcCgnd2FpdCcpXG5cdFx0XHQuZWFjaCgoeF9uLCBpX24pID0+IHtcblx0XHRcdFx0ZXEoYV9zZXFbaV9uXSwgeF9uKTtcblx0XHRcdH0sIGFzeW5jICgpID0+IHtcblx0XHRcdFx0YXdhaXQga19ncm91cC5raWxsKCk7XG5cdFx0XHRcdGZrZV90ZXN0KCk7XG5cdFx0XHR9KTtcblx0fSk7XG5cblx0aXQoJ21hcC9zZXJpZXMnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQgYV9zZXEgPSBbOCwgMSwgNywgNCwgMywgNSwgMiwgNl0ubWFwKHggPT4geCoxMDApO1xuXHRcdGxldCBhX3JlcyA9IFtdO1xuXHRcdGxldCBrX2dyb3VwID0gZ3JvdXAoYV9zZXEubGVuZ3RoKTtcblx0XHRrX2dyb3VwXG5cdFx0XHQuZGF0YShhX3NlcSlcblx0XHRcdC5tYXAoJ3dhaXQnKVxuXHRcdFx0LnNlcmllcygoeF9uKSA9PiB7XG5cdFx0XHRcdGFfcmVzLnB1c2goeF9uKTtcblx0XHRcdH0sIGFzeW5jICgpID0+IHtcblx0XHRcdFx0YXdhaXQga19ncm91cC5raWxsKCk7XG5cdFx0XHRcdGRlcShhX3NlcSwgYV9yZXMpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdtYXAvcmVkdWNlICM0JywgKGZrZV90ZXN0KSA9PiB7XG5cdFx0bGV0IHNfc3JjID0gJ2FiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6Jztcblx0XHRsZXQga19ncm91cCA9IGdyb3VwKDQpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKHNfc3JjLnNwbGl0KCcnKSlcblx0XHRcdC5tYXAoJ2NvbmNhdCcpXG5cdFx0XHQucmVkdWNlKCdtZXJnZV9jb25jYXQnKS50aGVuKGFzeW5jIChzX2ZpbmFsKSA9PiB7XG5cdFx0XHRcdGF3YWl0IGtfZ3JvdXAua2lsbCgpO1xuXHRcdFx0XHRlcShzX3NyYywgc19maW5hbCk7XG5cdFx0XHRcdGZrZV90ZXN0KCk7XG5cdFx0XHR9KTtcblx0fSk7XG5cblx0aXQoJ21hcC9yZWR1Y2UgIzgnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQgc19zcmMgPSAnYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXonO1xuXHRcdGxldCBrX2dyb3VwID0gZ3JvdXAoOCk7XG5cdFx0a19ncm91cFxuXHRcdFx0LmRhdGEoc19zcmMuc3BsaXQoJycpKVxuXHRcdFx0Lm1hcCgnY29uY2F0Jylcblx0XHRcdC5yZWR1Y2UoJ21lcmdlX2NvbmNhdCcpLnRoZW4oYXN5bmMgKHNfZmluYWwpID0+IHtcblx0XHRcdFx0YXdhaXQga19ncm91cC5raWxsKCk7XG5cdFx0XHRcdGVxKHNfc3JjLCBzX2ZpbmFsKTtcblx0XHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxuXHRpdCgnZXZlbnRzJywgKGZrZV90ZXN0KSA9PiB7XG5cdFx0bGV0IGhfY29udm8gPSB7XG5cdFx0XHRncmVldDogJ2hpJyxcblx0XHRcdGNoYXQ6ICdob3cgciB1Jyxcblx0XHRcdHllbGw6ICdhaGghJyxcblx0XHRcdGFwb2xvZ2l6ZTogJ3NvcnJ5Jyxcblx0XHRcdGZvcmdpdmU6ICdtbWsnLFxuXHRcdFx0ZXhpdDogJ2tieWUnLFxuXHRcdH07XG5cblx0XHRsZXQgYV9kYXRhID0gW107XG5cdFx0bGV0IGhfcmVzcG9uc2VzID0ge307XG5cdFx0bGV0IGNfcmVzcG9uc2VzID0gMDtcblx0XHRPYmplY3Qua2V5cyhoX2NvbnZvKS5mb3JFYWNoKChzX2tleSwgaV9rZXkpID0+IHtcblx0XHRcdGFfZGF0YS5wdXNoKHtcblx0XHRcdFx0bmFtZTogc19rZXksXG5cdFx0XHRcdGRhdGE6IGhfY29udm9bc19rZXldLFxuXHRcdFx0XHR3YWl0OiBpX2tleT8gNTAwOiAwLFxuXHRcdFx0fSk7XG5cblx0XHRcdGhfcmVzcG9uc2VzW3Nfa2V5XSA9IChpX3N1YnNldCwgc19tc2cpID0+IHtcblx0XHRcdFx0ZXEoaF9jb252b1tzX2tleV0sIHNfbXNnKTtcblx0XHRcdFx0Y19yZXNwb25zZXMgKz0gMTtcblx0XHRcdH07XG5cdFx0fSk7XG5cblx0XHRsZXQga19ncm91cCA9IGdyb3VwKDMpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKGFfZGF0YSlcblx0XHRcdC5tYXAoJ2V2ZW50cycsIFtdLCBoX3Jlc3BvbnNlcylcblx0XHRcdC5lbmQoYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRhd2FpdCBrX2dyb3VwLmtpbGwoKTtcblx0XHRcdFx0ZXEoYV9kYXRhLmxlbmd0aCwgY19yZXNwb25zZXMpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdzdG9yZScsICgpID0+IHtcblx0XHRsZXQga19ncm91cCA9IGdyb3VwKDIpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKFtbMTAwLCAwLCAwLCAwXV0pXG5cdFx0XHQubWFwKCdwYXNzJylcblx0XHRcdC8vIC50aHJ1KCdwYXNzJylcblx0XHRcdC5yZWR1Y2UoJ3N1bScpLnRoZW4oYXN5bmMgKGFfdikgPT4ge1xuXHRcdFx0XHRhd2FpdCBrX2dyb3VwLmtpbGwoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxufSk7XG5cblxuZGVzY3JpYmUoJ2F1eCcsICgpID0+IHtcblxuXHRpZighd29ya2VyLmJyb3dzZXIpIHtcblx0XHRpdCgndHJhbnNmZXJzJywgYXN5bmMgKCkgPT4ge1xuXHRcdFx0bGV0IGttX2FyZ3MgPSB3b3JrZXIubWFuaWZlc3QoW2ZzLnJlYWRGaWxlU3luYygnLi9wYWNrYWdlLmpzb24nKV0pO1xuXHRcdFx0bGV0IG5fbGVuZ3RoID0gYXdhaXQgcnVuKCdjb3VudCcsIGttX2FyZ3MpO1xuXG5cdFx0XHRhc3NlcnQobl9sZW5ndGggPiAwKTtcblx0XHR9KTtcblx0fVxuXG5cdGl0KCd0eXBlZC1hcnJheScsIGFzeW5jICgpID0+IHtcblx0XHRsZXQgYXRfdGVzdCA9IG5ldyBVaW50OEFycmF5KDEwKTtcblx0XHRhdF90ZXN0WzBdID0gNztcblx0XHRhdF90ZXN0WzFdID0gNTtcblx0XHRsZXQga21fYXJncyA9IHdvcmtlci5tYW5pZmVzdChbYXRfdGVzdCwgMV0pO1xuXHRcdGxldCBuX2F0ID0gYXdhaXQgcnVuKCdhdCcsIGttX2FyZ3MpO1xuXHRcdGVxKDUsIG5fYXQpO1xuXHR9KTtcblxuXHQvLyBpdCgnc3RyZWFtcycsIGFzeW5jICgpID0+IHtcblx0Ly8gXHRsZXQgZHNfd29yZHMgPSBmcy5jcmVhdGVSZWFkU3RyZWFtKCcvdXNyL3NoYXJlL2RpY3Qvd29yZHMnLCAndXRmOCcpO1xuXHQvLyBcdGxldCBuX25ld2xpbmVzID0gYXdhaXQgcnVuKCdjb3VudF9zdHInLCBbZHNfd29yZHMsICdcXG4nXSk7XG5cdC8vIFx0Y29uc29sZS5sb2cobl9uZXdsaW5lcyk7XG5cdC8vIFx0Ly8gZXEoJ3dvcmtlcicsIHNfcGFja2FnZV9uYW1lKTtcblx0Ly8gfSk7XG59KTtcblxuXG4iLCJjb25zdCB3b3JrZXIgPSByZXF1aXJlKCcuLi8uLi8uLi9kaXN0L21haW4vbW9kdWxlLmpzJyk7XG5cbndvcmtlci5kZWRpY2F0ZWQoe1xuXHRyZXZlcnNlX3N0cmluZzogcyA9PiBzLnNwbGl0KCcnKS5yZXZlcnNlKCkuam9pbignJyksXG5cblx0YXQ6IChhLCBpKSA9PiBhW2ldLFxuXG5cdHdhaXQ6IChhX3dhaXQpID0+IG5ldyBQcm9taXNlKChmX3Jlc29sdmUpID0+IHtcblx0XHRsZXQgdF93YWl0ID0gYV93YWl0WzBdO1xuXG5cdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRmX3Jlc29sdmUodF93YWl0KTtcblx0XHR9LCB0X3dhaXQpO1xuXHR9KSxcblxuXHRjb25jYXQ6IGEgPT4gYS5qb2luKCcnKSxcblxuXHRtZXJnZV9jb25jYXQ6IChzX2EsIHNfYikgPT4gc19hICsgc19iLFxuXG5cdGV2ZW50cyhhX2V2dHMpIHtcblx0XHRyZXR1cm4gUHJvbWlzZS5hbGwoXG5cdFx0XHRhX2V2dHMubWFwKChoX2V2dCkgPT4gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSwgZl9yZWplY3QpID0+IHtcblx0XHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0dGhpcy5lbWl0KGhfZXZ0Lm5hbWUsIGhfZXZ0LmRhdGEpO1xuXHRcdFx0XHRcdGZfcmVzb2x2ZSgpO1xuXHRcdFx0XHR9LCBoX2V2dC53YWl0ICsgNjAwKTtcblx0XHRcdH0pKVxuXHRcdCk7XG5cdH0sXG5cblx0c3RvcmUoYV9zdG9yZSkge1xuXHRcdGFfc3RvcmUuZm9yRWFjaCgoaF9zdG9yZSkgPT4ge1xuXHRcdFx0Zm9yKGxldCBzX2tleSBpbiBoX3N0b3JlKSB7XG5cdFx0XHRcdHRoaXMucHV0KHNfa2V5LCBoX3N0b3JlW3Nfa2V5XSk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cdH0sXG5cblx0ZmV0Y2goYV9rZXlzKSB7XG5cdFx0cmV0dXJuIGFfa2V5cy5tYXAoc19rZXkgPT4gdGhpcy5nZXQoc19rZXkpKTtcblx0fSxcblxuXHRwYXNzKGFfd2FpdCkge1xuXHRcdHJldHVybiBQcm9taXNlLmFsbChhX3dhaXQubWFwKHhfd2FpdCA9PiBuZXcgUHJvbWlzZSgoZl9yZXNvbHZlLCBmX3JlamVjdCkgPT4ge1xuXHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdGxldCBjX3ZhbCA9ICh0aGlzLmdldCgnZGlnJykgfHwgMCkgKyAxO1xuXHRcdFx0XHR0aGlzLnB1dCgnZGlnJywgY192YWwpO1xuXHRcdFx0XHRmX3Jlc29sdmUoY192YWwpO1xuXHRcdFx0fSwgeF93YWl0KTtcblx0XHR9KSkpO1xuXHR9LFxuXG5cdG11bHRpcGx5OiAoYSwgeF9tdWx0aXBsaWVyKSA9PiBhLm1hcCh4ID0+IHggKiB4X211bHRpcGxpZXIpLFxuXG5cdGFkZDogKGEsIHhfYWRkKSA9PiBhLm1hcCh4ID0+IHggKyB4X2FkZCksXG5cblx0Ly8gc3VtOiAoeF9hLCB4X2IpID0+IHhfYSArIHhfYixcblxuXHRzdW06IChhX2EsIGFfYikgPT4gW2FfYS5yZWR1Y2UoKGMsIHgpID0+IGMgKyB4LCAwKSArIGFfYi5yZWR1Y2UoKGMsIHgpID0+IGMgKyB4LCAwKV0sXG5cblx0Y291bnQ6IChhKSA9PiBhLnJlZHVjZSgoYywgeCkgPT4gYyArIHgsIDApLFxuXG5cdGNvdW50X3N0cihkc19pbnB1dCwgc19zdHIpIHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSwgZl9yZWplY3QpID0+IHtcblx0XHRcdGxldCBjX29jY3VycmVuY2VzID0gMDtcblx0XHRcdGRzX2lucHV0Lm9uKCdkYXRhJywgKHNfY2h1bmspID0+IHtcblx0XHRcdFx0Y29uc29sZS5sb2coJ29jY3VycmVuY2VzOiAnK2Nfb2NjdXJyZW5jZXMpO1xuXHRcdFx0XHRjX29jY3VycmVuY2VzICs9IHNfY2h1bmsuc3BsaXQoc19zdHIpLmxlbmd0aCAtIDE7XG5cdFx0XHR9KTtcblxuXHRcdFx0ZHNfaW5wdXQub24oJ2VuZCcsICgpID0+IHtcblx0XHRcdFx0Y29uc29sZS5sb2coJ2VuZCcpO1xuXHRcdFx0XHRmX3Jlc29sdmUoY19vY2N1cnJlbmNlcyk7XG5cdFx0XHR9KTtcblxuXHRcdFx0ZHNfaW5wdXQub24oJ2Vycm9yJywgKGVfc3RyZWFtKSA9PiB7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoZV9zdHJlYW0pO1xuXHRcdFx0XHRmX3JlamVjdChlX3N0cmVhbSk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblx0fSxcblxuXHR3cml0ZShkc19vdXQsIGFfcmFuZ2UpIHtcblx0XHRmb3IobGV0IGk9YV9yYW5nZVswXTsgaTxhX3JhbmdlWzFdOyBpKyspIHtcblx0XHRcdGRzX291dC53cml0ZShpKydcXG4nKTtcblx0XHR9XG5cdH0sXG59KTtcbiJdfQ==
