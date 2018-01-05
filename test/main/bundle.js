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

},{}],12:[function(require,module,exports){
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
arguments[4][11][0].apply(exports,arguments)
},{"dup":11}],19:[function(require,module,exports){
arguments[4][11][0].apply(exports,arguments)
},{"dup":11}],20:[function(require,module,exports){
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJkaXN0L21haW4vYWxsL2RlZGljYXRlZC5qcyIsImRpc3QvbWFpbi9hbGwvZ3JvdXAuanMiLCJkaXN0L21haW4vYWxsL2xvY2Fscy5qcyIsImRpc3QvbWFpbi9hbGwvbWFuaWZlc3QuanMiLCJkaXN0L21haW4vYWxsL3Bvb2wuanMiLCJkaXN0L21haW4vYWxsL3Jlc3VsdC5qcyIsImRpc3QvbWFpbi9icm93c2VyL2NoYW5uZWwuanMiLCJkaXN0L21haW4vYnJvd3Nlci9ldmVudHMuanMiLCJkaXN0L21haW4vYnJvd3Nlci9sb2NhbHMuanMiLCJkaXN0L21haW4vYnJvd3Nlci9wb3J0cy5qcyIsImRpc3QvbWFpbi9icm93c2VyL3NlbGYuanMiLCJkaXN0L21haW4vYnJvd3Nlci9zaGFyaW5nLmpzIiwiZGlzdC9tYWluL2Jyb3dzZXIvc3RyZWFtLmpzIiwiZGlzdC9tYWluL2Jyb3dzZXIvdHlwZWQtYXJyYXlzLmpzIiwiZGlzdC9tYWluL2Jyb3dzZXIvd29ya2VyLmpzIiwiZGlzdC9tYWluL21vZHVsZS5qcyIsIm5vZGVfbW9kdWxlcy9hc3NlcnQvYXNzZXJ0LmpzIiwibm9kZV9tb2R1bGVzL2V2ZW50cy9ldmVudHMuanMiLCJub2RlX21vZHVsZXMvcGF0aC1icm93c2VyaWZ5L2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3Byb2Nlc3MvYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy91dGlsL25vZGVfbW9kdWxlcy9pbmhlcml0cy9pbmhlcml0c19icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL3V0aWwvc3VwcG9ydC9pc0J1ZmZlckJyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvdXRpbC91dGlsLmpzIiwidGVzdC9tYWluL21vZHVsZS5qcyIsInRlc3QvbWFpbi93b3JrZXJzL2Jhc2ljLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM1pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ2xrQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMxRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcElBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNWQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDZEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVEE7QUFDQTtBQUNBOztBQ0ZBOztBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdEVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDclVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxckJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ2xDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7OztBQ3ppQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7Ozs7QUMxZUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUM5U0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDaE9BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeExBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDMWtCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDalFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dmFyIGY9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKTt0aHJvdyBmLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsZn12YXIgbD1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwobC5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxsLGwuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiY29uc3Qge1xuXHRLX1NFTEYsXG5cdHdlYndvcmtlcmlmeSxcblx0c3RyZWFtLFxuXHRwb3J0cyxcbn0gPSByZXF1aXJlKCcuL2xvY2Fscy5qcycpO1xuXG5jb25zdCB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuY29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKCcuL21hbmlmZXN0LmpzJyk7XG5jb25zdCByZXN1bHQgPSByZXF1aXJlKCcuL3Jlc3VsdC5qcycpO1xuXG5sZXQgaV9zdWJ3b3JrZXJfc3Bhd24gPSAxO1xubGV0IGhfc3Vid29ya2VycyA9IHt9O1xuY2xhc3MgbGF0ZW50X3N1YndvcmtlciB7XG5cdHN0YXRpYyBjb25uZWN0KGhfbXNnKSB7XG5cdFx0aF9zdWJ3b3JrZXJzW2hfbXNnLmlkXS5jb25uZWN0KGhfbXNnKTtcblx0fVxuXG5cdGNvbnN0cnVjdG9yKCkge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0aWQ6IGlfc3Vid29ya2VyX3NwYXduLFxuXHRcdFx0bWVzc2FnZXM6IFtdLFxuXHRcdFx0bWFzdGVyX2tleTogMCxcblx0XHRcdHBvcnQ6IG51bGwsXG5cdFx0fSk7XG5cblx0XHRoX3N1YndvcmtlcnNbaV9zdWJ3b3JrZXJfc3Bhd24rK10gPSB0aGlzO1xuXHR9XG5cblx0Y29ubmVjdChoX21zZykge1xuXHRcdGxldCB7XG5cdFx0XHRtYXN0ZXJfa2V5OiBpX21hc3Rlcixcblx0XHRcdHBvcnQ6IGRfcG9ydCxcblx0XHR9ID0gaF9tc2c7XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdG1hc3Rlcl9rZXk6IGlfbWFzdGVyLFxuXHRcdFx0cG9ydDogZF9wb3J0LFxuXHRcdH0pO1xuXG5cdFx0Ly8gYmluZCBldmVudHNcblx0XHRkX3BvcnQub25tZXNzYWdlID0gKC4uLmFfYXJncykgPT4ge1xuXHRcdFx0dGhpcy5vbm1lc3NhZ2UoLi4uYV9hcmdzKTtcblx0XHR9O1xuXHRcdGRfcG9ydC5vbm1lc3NhZ2VlcnJvciA9ICguLi5hX2FyZ3MpID0+IHtcblx0XHRcdHRoaXMub25tZXNzYWdlZXJyb3IoLi4uYV9hcmdzKTtcblx0XHR9O1xuXG5cdFx0Ly8gcHJvY2VzcyBtZXNzYWdlIHF1ZXVlXG5cdFx0d2hpbGUgKHRoaXMubWVzc2FnZXMubGVuZ3RoKSB7XG5cdFx0XHRkX3BvcnQucG9zdE1lc3NhZ2UoLi4udGhpcy5tZXNzYWdlcy5zaGlmdCgpKTtcblx0XHR9XG5cdH1cblxuXHRwb3N0TWVzc2FnZSguLi5hX2FyZ3MpIHtcblx0XHRpZiAodGhpcy5wb3J0KSB7XG5cdFx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2UoLi4uYV9hcmdzKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5tZXNzYWdlcy5wdXNoKGFfYXJncyk7XG5cdFx0fVxuXHR9XG5cblx0b25tZXNzYWdlKCkge1xuXHRcdHRocm93IG5ldyBFcnJvcigncmVjZWl2ZWQgbWVzc2FnZSBmcm9tIHN1YndvcmtlciBiZWZvcmUgaXRzIHBvcnQgd2FzIGNvbm5lY3RlZCcpO1xuXHR9XG5cblx0b25tZXNzYWdlZXJyb3IoKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKCdyZWNlaXZlZCBtZXNzYWdlIGVycm9yIGZyb20gc3Vid29ya2VyIGJlZm9yZSBpdHMgcG9ydCB3YXMgY29ubmVjdGVkJyk7XG5cdH1cblxuXHR0ZXJtaW5hdGUoKSB7XG5cdFx0dGhpcy5wb3J0LmNsb3NlKCk7XG5cdFx0S19TRUxGLnBvc3RNZXNzYWdlKHtcblx0XHRcdHR5cGU6ICd0ZXJtaW5hdGUnLFxuXHRcdFx0bWFzdGVyX2tleTogdGhpcy5tYXN0ZXJfa2V5LFxuXHRcdH0pO1xuXHR9XG5cblx0d2Vid29ya2VyaWZ5KHpfaW1wb3J0LCBhX2Jyb3dzZXJpZnksIGhfb3B0aW9ucyA9IHt9KSB7XG5cdFx0bGV0IHNfc291cmNlID0gd2Vid29ya2VyaWZ5KHpfaW1wb3J0LCBhX2Jyb3dzZXJpZnksIGhfb3B0aW9ucyk7XG5cblx0XHRLX1NFTEYucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0dHlwZTogJ3NwYXduJyxcblx0XHRcdHNvdXJjZTogc19zb3VyY2UsXG5cdFx0XHRvcHRpb25zOiBoX29wdGlvbnMsXG5cdFx0fSk7XG5cdH1cbn1cblxuXG5jbGFzcyBoZWxwZXIge1xuXHRjb25zdHJ1Y3RvcihrX3dvcmtlciwgaV90YXNrLCBoX2V2ZW50cykge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0d29ya2VyOiBrX3dvcmtlcixcblx0XHRcdHRhc2tfaWQ6IGlfdGFzayxcblx0XHRcdGV2ZW50czogaF9ldmVudHMsXG5cdFx0XHR3b3JrZXJfc3RvcmU6IGtfd29ya2VyLnN0b3JlLFxuXHRcdFx0dGFza3M6IGtfd29ya2VyLnRhc2tzLFxuXHRcdH0pO1xuXHR9XG5cblx0cHV0KHNfa2V5LCB6X2RhdGEpIHtcblx0XHRsZXQgaF9zdG9yZSA9IHRoaXMud29ya2VyX3N0b3JlO1xuXHRcdGxldCBpX3Rhc2sgPSB0aGlzLnRhc2tfaWQ7XG5cblx0XHQvLyBmaXJzdCBpdGVtIGluIHRoaXMgdGFzaydzIHN0b3JlXG5cdFx0aWYgKCEoaV90YXNrIGluIGhfc3RvcmUpKSB7XG5cdFx0XHRoX3N0b3JlW2lfdGFza10gPSB7XG5cdFx0XHRcdFtzX2tleV06IHpfZGF0YSxcblx0XHRcdH07XG5cdFx0fVxuXHRcdC8vIG5vdCBmaXJzdCBpdGVtOyBhZGQgaXRcblx0XHRlbHNlIHtcblx0XHRcdGhfc3RvcmVbaV90YXNrXVtzX2tleV0gPSB6X2RhdGE7XG5cdFx0fVxuXHR9XG5cblx0Z2V0KHNfa2V5KSB7XG5cdFx0bGV0IGlfdGFzayA9IHRoaXMudGFza19pZDtcblxuXHRcdC8vIHRoaXMgdGFzayBjaGFpbiB3YXMgbmV2ZXIgd3JpdHRlbiB0b1xuXHRcdGlmICghKGlfdGFzayBpbiB0aGlzLndvcmtlcl9zdG9yZSkpIHJldHVybjtcblxuXHRcdC8vIHJldHVybiB3aGF0ZXZlciB2YWx1ZSBpcyB0aGVyZVxuXHRcdHJldHVybiB0aGlzLndvcmtlcl9zdG9yZVtpX3Rhc2tdW3Nfa2V5XTtcblx0fVxuXG5cdGVtaXQoc19rZXksIC4uLmFfYXJncykge1xuXHRcdC8vIG9ubHkgaWYgdGhlIGV2ZW50IGlzIHJlZ2lzdGVyZWRcblx0XHRpZiAoc19rZXkgaW4gdGhpcy5ldmVudHMpIHtcblx0XHRcdGxldCBhX2FyZ3Nfc2VuZCA9IFtdO1xuXHRcdFx0bGV0IGFfdHJhbnNmZXJfcGF0aHMgPSBbXTtcblxuXHRcdFx0Ly8gbWVyZ2UgYXJnc1xuXHRcdFx0bGV0IG5fYXJncyA9IGFfYXJncy5sZW5ndGg7XG5cdFx0XHRmb3IgKGxldCBpX2FyZyA9IDA7IGlfYXJnIDwgbl9hcmdzOyBpX2FyZysrKSB7XG5cdFx0XHRcdGxldCB6X2FyZyA9IGFfYXJnc1tpX2FyZ107XG5cblx0XHRcdFx0Ly8gcmVzdWx0XG5cdFx0XHRcdGlmICh6X2FyZyBpbnN0YW5jZW9mIG1hbmlmZXN0KSB7XG5cdFx0XHRcdFx0YV9hcmdzX3NlbmQucHVzaCh6X2FyZy5kYXRhKTtcblx0XHRcdFx0XHRpZiAoel9hcmcudHJhbnNmZXJfcGF0aHMpIHtcblx0XHRcdFx0XHRcdGxldCBubF9wYXRocyA9IGFfdHJhbnNmZXJfcGF0aHMubGVuZ3RoO1xuXHRcdFx0XHRcdFx0bGV0IGFfaW1wb3J0X3BhdGhzID0gel9hcmcudHJhbnNmZXJfcGF0aHM7XG5cdFx0XHRcdFx0XHRhX2ltcG9ydF9wYXRocy5mb3JFYWNoKChhX3BhdGgpID0+IHtcblx0XHRcdFx0XHRcdFx0YV9wYXRoWzBdICs9IG5sX3BhdGhzO1xuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRhX3RyYW5zZmVyX3BhdGhzLnB1c2goLi4uYV9pbXBvcnRfcGF0aHMpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBwb3N0YWJsZVxuXHRcdFx0XHRlbHNlIHtcblx0XHRcdFx0XHRhX2FyZ3Nfc2VuZC5wdXNoKHpfYXJnKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBzZW5kIG1lc3NhZ2Vcblx0XHRcdEtfU0VMRi5wb3N0TWVzc2FnZSh7XG5cdFx0XHRcdHR5cGU6ICdldmVudCcsXG5cdFx0XHRcdGlkOiB0aGlzLnRhc2tfaWQsXG5cdFx0XHRcdGV2ZW50OiBzX2tleSxcblx0XHRcdFx0YXJnczogYV9hcmdzX3NlbmQsXG5cdFx0XHR9LCBhX3RyYW5zZmVyX3BhdGhzKTtcblx0XHR9XG5cdH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBjbGFzcyBkZWRpY2F0ZWQgZXh0ZW5kcyBzdHJlYW0uaGFuZGxlciB7XG5cdGNvbnN0cnVjdG9yKGhfdGFza3MpIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHR0YXNrczogaF90YXNrcyxcblx0XHRcdHN0b3JlOiB7fSxcblx0XHRcdHJlc3VsdHM6IHt9LFxuXHRcdFx0cG9ydDogS19TRUxGLFxuXHRcdFx0aWQ6IEtfU0VMRi5hcmdzWzBdLFxuXHRcdH0pO1xuXG5cdFx0S19TRUxGLmV2ZW50KCdlcnJvcicsIChlX3dvcmtlcikgPT4ge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGVfd29ya2VyKTtcblx0XHR9KTtcblxuXHRcdHRoaXMuc2V0X3BvcnQoS19TRUxGKTtcblx0fVxuXG5cdGRlYnVnKHNfdHlwZSwgLi4uYV9pbmZvKSB7XG5cdFx0Ly8gY29uc29sZS53YXJuKGBTJHt0aGlzLmlkfSAke3NfdHlwZX0gJHthX2luZm8ubGVuZ3RoPyAnKCcrYV9pbmZvLmpvaW4oJywgJykrJyknOiAnLSd9YCk7XG5cdH1cblxuXHQvLyByZXNvbHZlcyBwcm9taXNlcyBhbmQgd3JhcHMgcmVzdWx0c1xuXHRyZXNvbHZlKHpfcmVzdWx0LCBma19yZXNvbHZlKSB7XG5cdFx0Ly8gYSBwcm9taXNlIHdhcyByZXR1cm5lZFxuXHRcdGlmICh6X3Jlc3VsdCBpbnN0YW5jZW9mIFByb21pc2UpIHtcblx0XHRcdHpfcmVzdWx0XG5cdFx0XHRcdC8vIG9uY2UgaXRzIHJlYWR5OyByZXNvbHZlIHVzaW5nIHJlc3VsdFxuXHRcdFx0XHQudGhlbigoel9kYXRhKSA9PiB7XG5cdFx0XHRcdFx0ZmtfcmVzb2x2ZShyZXN1bHQuZnJvbSh6X2RhdGEpKTtcblx0XHRcdFx0fSlcblx0XHRcdFx0Ly8gb3IgY2F0Y2ggaWYgdGhlcmUgd2FzIGEgc3ludGF4IGVycm9yIC8gZXRjLlxuXHRcdFx0XHQuY2F0Y2goKGVfcmVzb2x2ZSkgPT4ge1xuXHRcdFx0XHRcdHRoaXMudGhyb3coZV9yZXNvbHZlKTtcblx0XHRcdFx0fSk7XG5cdFx0fVxuXHRcdC8vIHN5bmNcblx0XHRlbHNlIHtcblx0XHRcdHJldHVybiBma19yZXNvbHZlKHJlc3VsdC5mcm9tKHpfcmVzdWx0KSk7XG5cdFx0fVxuXHR9XG5cblx0dGhyb3cgKGVfdGhyb3cpIHtcblx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0dHlwZTogJ2Vycm9yJyxcblx0XHRcdGVycm9yOiB7XG5cdFx0XHRcdG1lc3NhZ2U6IGVfdGhyb3cubWVzc2FnZSxcblx0XHRcdFx0c3RhY2s6IGVfdGhyb3cuc3RhY2ssXG5cdFx0XHR9LFxuXHRcdH0pO1xuXHR9XG5cblx0Ly8gdHlwaWNhbCBleGVjdXRlLWFuZC1yZXNwb25kIHRhc2tcblx0aGFuZGxlX3Rhc2soaF9tc2cpIHtcblx0XHRsZXQgaF90YXNrcyA9IHRoaXMudGFza3M7XG5cblx0XHRsZXQge1xuXHRcdFx0aWQ6IGlfdGFzayxcblx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHRcdGFyZ3M6IGFfYXJncyxcblx0XHRcdGluaGVyaXQ6IGlfaW5oZXJpdCA9IDAsXG5cdFx0XHRyZWNlaXZlOiBpX3JlY2VpdmUgPSAwLFxuXHRcdFx0aG9sZDogYl9ob2xkID0gZmFsc2UsXG5cdFx0XHRldmVudHM6IGhfZXZlbnRzID0ge30sXG5cdFx0fSA9IGhfbXNnO1xuXG5cdFx0dGhpcy5kZWJ1ZygnPDwgdGFzazonICsgc190YXNrLCBpX3Rhc2spO1xuXG5cdFx0Ly8gbm8gc3VjaCB0YXNrXG5cdFx0aWYgKCEoc190YXNrIGluIGhfdGFza3MpKSB7XG5cdFx0XHRyZXR1cm4gdGhpcy50aHJvdyhuZXcgRXJyb3IoYGRlZGljYXRlZCB3b3JrZXIgaGFzIG5vIHN1Y2ggdGFzayByZWdpc3RlcmVkIGFzICcke3NfdGFza30nYCkpO1xuXHRcdH1cblxuXHRcdC8vIGluaGVyaXQgc3RvcmUgZnJvbSBwcmV2aW91cyB0YXNrXG5cdFx0aWYgKGlfaW5oZXJpdCkge1xuXHRcdFx0bGV0IGhfc3RvcmUgPSB0aGlzLnN0b3JlO1xuXHRcdFx0aF9zdG9yZVtpX3Rhc2tdID0gaF9zdG9yZVtpX2luaGVyaXRdO1xuXHRcdFx0ZGVsZXRlIGhfc3RvcmVbaV9pbmhlcml0XTtcblx0XHR9XG5cblx0XHQvLyByZWNlaXZlIGRhdGEgZnJvbSBwcmV2aW91cyB0YXNrXG5cdFx0aWYgKGlfcmVjZWl2ZSkge1xuXHRcdFx0bGV0IGhfcmVzdWx0cyA9IHRoaXMucmVzdWx0cztcblxuXHRcdFx0Ly8gcHVzaCB0byBmcm9udCBvZiBhcmdzXG5cdFx0XHRhX2FyZ3MudW5zaGlmdChoX3Jlc3VsdHNbaV9yZWNlaXZlXS5kYXRhWzBdKTtcblxuXHRcdFx0Ly8gZnJlZSB0byBnY1xuXHRcdFx0ZGVsZXRlIGhfcmVzdWx0c1tpX3JlY2VpdmVdO1xuXHRcdH1cblxuXHRcdC8vIGV4ZWN1dGUgZ2l2ZW4gdGFza1xuXHRcdGxldCB6X3Jlc3VsdDtcblx0XHR0cnkge1xuXHRcdFx0el9yZXN1bHQgPSBoX3Rhc2tzW3NfdGFza10uYXBwbHkobmV3IGhlbHBlcih0aGlzLCBpX3Rhc2ssIGhfZXZlbnRzKSwgYV9hcmdzKTtcblx0XHR9IGNhdGNoIChlX2V4ZWMpIHtcblx0XHRcdGVfZXhlYy5tZXNzYWdlID0gYHdvcmtlciB0aHJldyBhbiBlcnJvciB3aGlsZSBleGVjdXRpbmcgdGFzayAnJHtzX3Rhc2t9JzpcXG4ke2VfZXhlYy5tZXNzYWdlfWA7XG5cdFx0XHRyZXR1cm4gdGhpcy50aHJvdyhlX2V4ZWMpO1xuXHRcdH1cblxuXHRcdC8vIGhvbGQgcmVzdWx0IGRhdGEgYW5kIGF3YWl0IGZ1cnRoZXIgaW5zdHJ1Y3Rpb25zIGZyb20gbWFzdGVyXG5cdFx0aWYgKGJfaG9sZCkge1xuXHRcdFx0dGhpcy5yZXNvbHZlKHpfcmVzdWx0LCAoa19yZXN1bHQpID0+IHtcblx0XHRcdFx0Ly8gc3RvcmUgcmVzdWx0XG5cdFx0XHRcdHRoaXMucmVzdWx0c1tpX3Rhc2tdID0ga19yZXN1bHQ7XG5cblx0XHRcdFx0Ly8gc3VibWl0IG5vdGlmaWNhdGlvbiB0byBtYXN0ZXJcblx0XHRcdFx0dGhpcy5wb3J0LnBvc3RNZXNzYWdlKHtcblx0XHRcdFx0XHR0eXBlOiAnbm90aWZ5Jyxcblx0XHRcdFx0XHRpZDogaV90YXNrLFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHR0aGlzLmRlYnVnKCc+PiBub3RpZnknLCBpX3Rhc2spO1xuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdC8vIHNlbmQgcmVzdWx0IGJhY2sgdG8gbWFzdGVyIGFzIHNvb24gYXMgaXRzIHJlYWR5XG5cdFx0ZWxzZSB7XG5cdFx0XHR0aGlzLnJlc29sdmUoel9yZXN1bHQsIChrX3Jlc3VsdCkgPT4ge1xuXHRcdFx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0XHRcdHR5cGU6ICdyZXNwb25kJyxcblx0XHRcdFx0XHRpZDogaV90YXNrLFxuXHRcdFx0XHRcdGRhdGE6IGtfcmVzdWx0LmRhdGFbMF0sXG5cdFx0XHRcdH0sIGtfcmVzdWx0LnBhdGhzKCdkYXRhJykpO1xuXG5cdFx0XHRcdHRoaXMuZGVidWcoJz4+IHJlc3BvbmQnLCBpX3Rhc2spO1xuXHRcdFx0fSk7XG5cdFx0fVxuXHR9XG5cblx0Ly8gc2VuZCByZXN1bHQgZGF0YSB0byBzaWJsaW5nXG5cdGhhbmRsZV9yZWxheShoX21zZykge1xuXHRcdGxldCBoX3Jlc3VsdHMgPSB0aGlzLnJlc3VsdHM7XG5cblx0XHRsZXQge1xuXHRcdFx0aWQ6IGlfdGFzayxcblx0XHRcdHBvcnQ6IGRfcG9ydCxcblx0XHR9ID0gaF9tc2c7XG5cblx0XHQvLyBjb25zb2xlLmRpcihkX3BvcnQpO1xuXHRcdHRoaXMuZGVidWcoJzw8IHJlbGF5JywgaV90YXNrLCBkX3BvcnQubmFtZSk7XG5cblx0XHQvLyBncmFiIHJlc3VsdFxuXHRcdGxldCBrX3Jlc3VsdCA9IGhfcmVzdWx0c1tpX3Rhc2tdO1xuXG5cdFx0Ly8gZm9yd2FyZCB0byBnaXZlbiBwb3J0XG5cdFx0ZF9wb3J0LnBvc3RNZXNzYWdlKGtfcmVzdWx0LmRhdGFbMF0sIGtfcmVzdWx0LnRyYW5zZmVyX3BhdGhzKTtcblxuXHRcdC8vIGZyZWUgdG8gZ2Ncblx0XHRkZWxldGUgaF9yZXN1bHRzW2lfdGFza107XG5cdH1cblxuXHQvLyByZWNlaXZlIGRhdGEgZnJvbSBzaWJsaW5nIGFuZCB0aGVuIGV4ZWN1dGUgcmVhZHkgdGFza1xuXHRoYW5kbGVfcmVjZWl2ZShoX21zZykge1xuXHRcdGxldCB7XG5cdFx0XHRwb3J0OiBkX3BvcnQsXG5cdFx0XHRpbXBvcnQ6IGlfaW1wb3J0LFxuXHRcdFx0cHJpbWFyeTogYl9wcmltYXJ5LFxuXHRcdFx0dGFza19yZWFkeTogaF90YXNrX3JlYWR5LFxuXHRcdH0gPSBoX21zZztcblxuXHRcdC8vIGFjY2VwdCBwb3J0XG5cdFx0cG9ydHMoZF9wb3J0KTtcblxuXHRcdHRoaXMuZGVidWcoJzw8IHJlY2VpdmU6JyArIGlfaW1wb3J0LCBoX3Rhc2tfcmVhZHkuaWQsIGRfcG9ydC5uYW1lKTtcblxuXHRcdC8vIGltcG9ydCBkYXRhXG5cdFx0bGV0IHpfZGF0YV9pbXBvcnQgPSB0aGlzLnJlc3VsdHNbaV9pbXBvcnRdLmRhdGFbMF07XG5cblx0XHQvLyBmcmVlIHRvIGdjXG5cdFx0ZGVsZXRlIHRoaXMucmVzdWx0c1tpX2ltcG9ydF07XG5cblx0XHQvLyB0YXNrIHJlYWR5IGFyZ3Ncblx0XHRsZXQgYV9hcmdzX3Rhc2tfcmVhZHkgPSBoX3Rhc2tfcmVhZHkuYXJncztcblxuXHRcdC8vIGltcG9ydCBpcyBzZWNvbmRhcnlcblx0XHRpZiAoIWJfcHJpbWFyeSkgYV9hcmdzX3Rhc2tfcmVhZHkudW5zaGlmdCh6X2RhdGFfaW1wb3J0KTtcblxuXHRcdHRoaXMuZGVidWcoJ3NldHVwJywgdXRpbC5pbnNwZWN0KGFfYXJnc190YXNrX3JlYWR5LCB7XG5cdFx0XHRkZXB0aDogbnVsbFxuXHRcdH0pKTtcblxuXHRcdC8vIHNldCB1cCBtZXNzYWdlIGhhbmRsZXIgb24gcG9ydFxuXHRcdGRfcG9ydC5ldmVudHMoe1xuXHRcdFx0bWVzc2FnZTogKGRfbXNnX3JlY2VpdmUpID0+IHtcblx0XHRcdFx0dGhpcy5kZWJ1ZygnPDwgcmVsYXkvcmVjZWl2ZScsIGRfcG9ydC5uYW1lKTtcblxuXHRcdFx0XHQvLyBjbG9zZSBwb3J0IG9uIGJvdGggc2lkZXNcblx0XHRcdFx0ZF9wb3J0LmNsb3NlKCk7XG5cblx0XHRcdFx0Ly8gcHVzaCBtZXNzYWdlIHRvIGZyb250IG9mIGFyZ3Ncblx0XHRcdFx0YV9hcmdzX3Rhc2tfcmVhZHkudW5zaGlmdChkX21zZ19yZWNlaXZlLmRhdGEpO1xuXG5cdFx0XHRcdC8vIGltcG9ydCBpcyBwcmltYXJ5XG5cdFx0XHRcdGlmIChiX3ByaW1hcnkpIGFfYXJnc190YXNrX3JlYWR5LnVuc2hpZnQoel9kYXRhX2ltcG9ydCk7XG5cblx0XHRcdFx0Ly8gZmlyZSByZWFkeSB0YXNrXG5cdFx0XHRcdHRoaXMuaGFuZGxlX3Rhc2soaF90YXNrX3JlYWR5KTtcblx0XHRcdH0sXG5cblx0XHRcdG1lc3NhZ2VlcnJvcjogKGVfbXNnKSA9PiB7XG5cdFx0XHRcdHRocm93IGVfbXNnO1xuXHRcdFx0fSxcblx0XHR9KTtcblx0fVxuXG5cdGhhbmRsZV9waW5nKCkge1xuXHRcdHRoaXMucG9ydC5wb3N0TWVzc2FnZSh7XG5cdFx0XHR0eXBlOiAncG9uZycsXG5cdFx0fSk7XG5cdH1cblxuXHRoYW5kbGVfb3duZXIoaF9tc2cpIHtcblx0XHR0aGlzLnNldF9wb3J0KHBvcnRzKGhfbXNnLnBvcnQpKTtcblx0fVxuXG5cdGhhbmRsZV9zdWJ3b3JrZXIoaF9tc2cpIHtcblx0XHRsYXRlbnRfc3Vid29ya2VyLmNvbm5lY3QoaF9tc2cpO1xuXHR9XG5cblx0c2V0X3BvcnQoZF9wb3J0KSB7XG5cdFx0dGhpcy5wb3J0ID0gZF9wb3J0O1xuXG5cdFx0ZF9wb3J0LmV2ZW50cyh7XG5cdFx0XHRtZXNzYWdlOiAoZF9tc2cpID0+IHtcblx0XHRcdFx0Ly8gZGVidWdnZXI7XG5cdFx0XHRcdGxldCBoX21zZyA9IGRfbXNnLmRhdGE7XG5cblx0XHRcdFx0Ly8gaGFuZGxlIG1lc3NhZ2Vcblx0XHRcdFx0bGV0IHNfaGFuZGxlID0gJ2hhbmRsZV8nICsgaF9tc2cudHlwZTtcblx0XHRcdFx0aWYgKHNfaGFuZGxlIGluIHRoaXMpIHtcblx0XHRcdFx0XHR0aGlzW3NfaGFuZGxlXShoX21zZyk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gbWlzc2luZyBoYW5kbGUgbmFtZSBpbiBtZXNzYWdlXG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcignZGVkaWNhdGVkIHdvcmtlciByZWNlaXZlZCBhIG1lc3NhZ2UgaXQgZG9lcyBub3Qga25vdyBob3cgdG8gaGFuZGxlOiAnICsgZF9tc2cpO1xuXHRcdFx0XHR9XG5cdFx0XHR9LFxuXG5cdFx0XHRtZXNzYWdlZXJyb3I6IChlX21zZykgPT4ge1xuXHRcdFx0XHR0aHJvdyBlX21zZztcblx0XHRcdH0sXG5cdFx0fSk7XG5cdH1cbn07IiwiY29uc3Qge1xuXHROX0NPUkVTLFxuXHRIUF9XT1JLRVJfTk9USUZJQ0FUSU9OLFxuXHREQ19DSEFOTkVMLFxufSA9IHJlcXVpcmUoJy4vbG9jYWxzLmpzJyk7XG5cbmNvbnN0IG1hbmlmZXN0ID0gcmVxdWlyZSgnLi9tYW5pZmVzdC5qcycpO1xubGV0IHdvcmtlcjtcblxuXG5jb25zdCBYTV9TVFJBVEVHWV9FUVVBTCA9IDEgPDwgMDtcblxuY29uc3QgWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQkFMQU5DRUQgPSAxIDw8IDI7XG5jb25zdCBYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQU19CSUFTRUQgPSAxIDw8IDM7XG5cbmNvbnN0IFhNX1NUUkFURUdZX09SREVSRURfR1JPVVBTID0gWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQkFMQU5DRUQgfCBYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQU19CSUFTRUQ7XG5cbmNvbnN0IFhNX0RJU1RSSUJVVElPTl9DT05TVEFOVCA9IDEgPDwgMDtcblxuXG5jbGFzcyBsb2NrIHtcblx0Y29uc3RydWN0b3IoYl91bmxvY2tlZCA9IGZhbHNlKSB7XG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHR1bmxvY2tlZDogYl91bmxvY2tlZCxcblx0XHRcdHF1ZXVlOiBbXSxcblx0XHR9KTtcblx0fVxuXG5cdHdhaXQoZmtfdW5sb2NrKSB7XG5cdFx0Ly8gYWxyZWFkeSB1bmxvY2tlZFxuXHRcdGlmICh0aGlzLnVubG9ja2VkKSB7XG5cdFx0XHRma191bmxvY2soKTtcblx0XHR9XG5cdFx0Ly8gY3VycmVudGx5IGxvY2tlZCwgYWRkIHRvIHF1ZXVlXG5cdFx0ZWxzZSB7XG5cdFx0XHR0aGlzLnF1ZXVlLnB1c2goZmtfdW5sb2NrKTtcblx0XHR9XG5cdH1cblxuXHR1bmxvY2soKSB7XG5cdFx0Ly8gdXBkYXRlIHN0YXRlXG5cdFx0dGhpcy51bmxvY2tlZCA9IHRydWU7XG5cblx0XHQvLyB1cGRhdGUgZmllbGQgYmVmb3JlIGV4ZWN1dGluZyBjYWxsYmFja3Ncblx0XHRsZXQgYV9xdWV1ZSA9IHRoaXMucXVldWU7XG5cdFx0dGhpcy5xdWV1ZSA9IFtdO1xuXG5cdFx0Ly8gcHJvY2VzcyBjYWxsYmFjayBxdWV1ZVxuXHRcdGFfcXVldWUuZm9yRWFjaCgoZmtfdW5sb2NrKSA9PiB7XG5cdFx0XHRma191bmxvY2soKTtcblx0XHR9KTtcblx0fVxufVxuXG5cbmNsYXNzIGdyb3VwIHtcblx0Y29uc3RydWN0b3IocF9zb3VyY2UsIG5fd29ya2VycyA9IE5fQ09SRVMsIGhfd29ya2VyX29wdGlvbnMgPSB7fSkge1xuXHRcdC8vIG5vIHdvcmtlciBjb3VudCBnaXZlbjsgZGVmYXVsdCB0byBudW1iZXIgb2YgY29yZXNcblx0XHRpZiAoIW5fd29ya2Vycykgbl93b3JrZXJzID0gTl9DT1JFUztcblxuXHRcdC8vIG5lZ2F0aXZlIG51bWJlciBnaXZlbjsgc3VidHJhY3QgZnJvbSBjb3JlIGNvdW50XG5cdFx0aWYgKG5fd29ya2VycyA8IDApIG5fd29ya2VycyA9IE1hdGgubWF4KDEsIE5fQ09SRVMgKyBuX3dvcmtlcnMpO1xuXG5cdFx0Ly8gbWFrZSB3b3JrZXJzXG5cdFx0bGV0IGFfd29ya2VycyA9IFtdO1xuXHRcdGxldCBobV9yb3N0ZXIgPSBuZXcgV2Vha01hcCgpO1xuXHRcdGZvciAobGV0IGlfd29ya2VyID0gMDsgaV93b3JrZXIgPCBuX3dvcmtlcnM7IGlfd29ya2VyKyspIHtcblx0XHRcdC8vIG1ha2UgbmV3IHdvcmtlclxuXHRcdFx0bGV0IGtfd29ya2VyID0gbmV3IHdvcmtlcih7XG5cdFx0XHRcdHNvdXJjZTogcF9zb3VyY2UsXG5cdFx0XHRcdGlkOiBpX3dvcmtlcixcblx0XHRcdFx0bWFzdGVyOiB0aGlzLFxuXHRcdFx0XHRvcHRpb25zOiBPYmplY3QuYXNzaWduKHtcblx0XHRcdFx0XHRhcmdzOiBbU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIGlfd29ya2VyKV0sXG5cdFx0XHRcdH0sIGhfd29ya2VyX29wdGlvbnMpLFxuXHRcdFx0fSk7XG5cblx0XHRcdC8vIGFkZCB0byB3b3JrZXIgbGlzdFxuXHRcdFx0YV93b3JrZXJzLnB1c2goa193b3JrZXIpO1xuXG5cdFx0XHQvLyByZXNlcnZlIGEgcXVldWUgZm9yIGl0IGluIHJvc3RlclxuXHRcdFx0aG1fcm9zdGVyLnNldChrX3dvcmtlciwgW10pO1xuXHRcdH1cblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0c291cmNlOiBwX3NvdXJjZSxcblx0XHRcdHdvcmtlcl9jb3VudDogbl93b3JrZXJzLFxuXHRcdFx0d29ya2VyczogYV93b3JrZXJzLFxuXHRcdFx0cm9zdGVyOiBobV9yb3N0ZXIsXG5cdFx0XHR3YWl0X2xpc3Q6IFtdLFxuXHRcdFx0bG9ja3M6IHt9LFxuXHRcdFx0bmV4dF93b3JrZXJfc3VtbW9uOiAwLFxuXHRcdH0pO1xuXHR9XG5cblx0ZGF0YShhX2l0ZW1zKSB7XG5cdFx0cmV0dXJuIG5ldyBhcm1lZF9ncm91cCh0aGlzLCB0aGlzLmJhbGFuY2UoYV9pdGVtcykpO1xuXHR9XG5cblx0dXNlKGFfc3Vic2V0cykge1xuXHRcdGlmIChhX3N1YnNldHMubGVuZ3RoID4gdGhpcy53b3JrZXJfY291bnQpIHtcblx0XHRcdHRocm93IG5ldyBSYW5nZUVycm9yKGB0b28gbWFueSBzdWJzZXRzIGdpdmVuIGZvciBudW1iZXIgb2Ygd29ya2VyczogJHthX3N1YnNldHMubGVuZ3RofSBzdWJzZXRzID4gJHt0aGlzLndvcmtlcl9jb3VudH0gd29ya2Vyc2ApO1xuXHRcdH1cblxuXHRcdHJldHVybiBuZXcgYXJtZWRfZ3JvdXAodGhpcywgYV9zdWJzZXRzKTtcblx0fVxuXG5cdHdhaXQoel9rZXksIHpfdW5sb2NrKSB7XG5cdFx0bGV0IGZrX3VubG9jayA9IHpfdW5sb2NrO1xuXG5cdFx0Ly8gdW5sb2NrIGlzIGFub3RoZXIgbG9ja1xuXHRcdGlmICgnc3RyaW5nJyA9PT0gdHlwZW9mIHpfdW5sb2NrKSB7XG5cdFx0XHRma191bmxvY2sgPSAoKSA9PiB7XG5cdFx0XHRcdHRoaXMudW5sb2NrKHpfdW5sb2NrKTtcblx0XHRcdH07XG5cdFx0fVxuXHRcdC8vIHVubG9jayBpcyBhcnJheSBvZiBsb2Nrc1xuXHRcdGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoel91bmxvY2spKSB7XG5cdFx0XHRma191bmxvY2sgPSAoKSA9PiB7XG5cdFx0XHRcdHRoaXMudW5sb2NrKHpfdW5sb2NrKTtcblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0Ly8gc2VyaWVzIG9mIGtleXMgdG8gd2FpdCBmb3Jcblx0XHRpZiAoQXJyYXkuaXNBcnJheSh6X2tleSkpIHtcblx0XHRcdGxldCBpX2tleSA9IDA7XG5cdFx0XHRsZXQgbl9rZXlzID0gel9rZXkubGVuZ3RoO1xuXHRcdFx0bGV0IGZfbmV4dCA9ICgpID0+IHtcblx0XHRcdFx0aWYgKGlfa2V5ID09PSBuX2tleXMpIGZrX3VubG9jaygpO1xuXHRcdFx0XHRlbHNlIHRoaXMud2FpdCh6X2tleVtpX2tleSsrXSwgZl9uZXh0KTtcblx0XHRcdH07XG5cblx0XHRcdGZfbmV4dCgpO1xuXHRcdH1cblx0XHQvLyBubyBzdWNoIGxvY2s7IGJ1dCB0aGF0J3Mgb2theSA7KSBjcmVhdGUgbG9jayBpbXBsaWNpdGx5XG5cdFx0ZWxzZSBpZiAoISh6X2tleSBpbiB0aGlzLmxvY2tzKSkge1xuXHRcdFx0bGV0IGtfbG9jayA9IHRoaXMubG9ja3Nbel9rZXldID0gbmV3IGxvY2soKTtcblx0XHRcdGtfbG9jay53YWl0KGZrX3VubG9jayk7XG5cdFx0fVxuXHRcdC8vIGFkZCB0byB3YWl0IHF1ZXVlXG5cdFx0ZWxzZSB7XG5cdFx0XHR0aGlzLmxvY2tzW3pfa2V5XS53YWl0KGZrX3VubG9jayk7XG5cdFx0fVxuXHR9XG5cblx0dW5sb2NrKHpfa2V5KSB7XG5cdFx0Ly8gbGlzdCBvZiBrZXlzIHRvIHVubG9ja1xuXHRcdGlmIChBcnJheS5pc0FycmF5KHpfa2V5KSkge1xuXHRcdFx0el9rZXkuZm9yRWFjaCh6X2tleV8gPT4gdGhpcy51bmxvY2soel9rZXlfKSk7XG5cdFx0fVxuXHRcdC8vIGluZGl2dWRhbCBrZXlcblx0XHRlbHNlIHtcblx0XHRcdC8vIG5vIHN1Y2ggbG9jayB5ZXRcblx0XHRcdGlmICghKHpfa2V5IGluIHRoaXMubG9ja3MpKSB7XG5cdFx0XHRcdHRoaXMubG9ja3Nbel9rZXldID0gbmV3IGxvY2sodHJ1ZSk7XG5cdFx0XHR9XG5cdFx0XHQvLyB1bmxvY2tcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHR0aGlzLmxvY2tzW3pfa2V5XS51bmxvY2soKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRiYWxhbmNlKGFfaXRlbXMpIHtcblx0XHRyZXR1cm4gZGl2aWRlKGFfaXRlbXMsIHRoaXMud29ya2VyX2NvdW50LCBYTV9TVFJBVEVHWV9FUVVBTCk7XG5cdH1cblxuXHRiYWxhbmNlX29yZGVyZWRfZ3JvdXBzKGFfZ3JvdXBzLCBoX2RpdmlkZSkge1xuXHRcdHJldHVybiBkaXZpZGUoYV9ncm91cHMsIHRoaXMud29ya2VyX2NvdW50LCBYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQU19CQUxBTkNFRCwgaF9kaXZpZGUpO1xuXHR9XG5cblx0Ymlhc19vcmRlcmVkX2dyb3VwcyhhX2dyb3VwcywgaF9kaXZpZGUpIHtcblx0XHRyZXR1cm4gZGl2aWRlKGFfZ3JvdXBzLCB0aGlzLndvcmtlcl9jb3VudCwgWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQklBU0VELCBoX2RpdmlkZSk7XG5cdH1cblxuXHRkaXZpc2lvbnMobl9pdGVtcykge1xuXHRcdGxldCBuX3dvcmtlcnMgPSB0aGlzLndvcmtlcl9jb3VudDtcblxuXHRcdC8vIGRvIG5vdCBhc3NpZ24gd29ya2VyIHRvIGRvIG5vdGhpbmdcblx0XHRpZiAobl9pdGVtcyA8IG5fd29ya2Vycykgbl93b3JrZXJzID0gbl9pdGVtcztcblxuXHRcdC8vIGhvdyBtYW55IHRpbWVzIHRvIGRpdmlkZSB0aGUgaXRlbXNcblx0XHRsZXQgbl9kaXZpc2lvbnMgPSBuX3dvcmtlcnMgLSAxO1xuXG5cdFx0Ly8gaWRlYWwgbnVtYmVyIG9mIGl0ZW1zIHBlciB3b3JrZXJcblx0XHRsZXQgeF9pdGVtc19wZXJfd29ya2VyID0gbl9pdGVtcyAvIG5fd29ya2VycztcblxuXHRcdC8vIGl0ZW0gaW5kaWNlcyB3aGVyZSB0byBtYWtlIGRpdmlzaW9uc1xuXHRcdGxldCBhX2RpdmlzaW9ucyA9IFtdO1xuXHRcdGZvciAobGV0IGlfZGl2aXNpb24gPSAxOyBpX2RpdmlzaW9uIDw9IG5fZGl2aXNpb25zOyBpX2RpdmlzaW9uKyspIHtcblx0XHRcdGFfZGl2aXNpb25zLnB1c2goTWF0aC5yb3VuZChpX2RpdmlzaW9uICogeF9pdGVtc19wZXJfd29ya2VyKSk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGFfZGl2aXNpb25zO1xuXHR9XG5cblx0KiBkaXZpZGVyKGNfaXRlbXNfcmVtYWluLCB4bV9kaXN0cmlidXRpb24gPSBYTV9ESVNUUklCVVRJT05fQ09OU1RBTlQpIHtcblx0XHRsZXQgY193b3JrZXJzX3JlbWFpbiA9IHRoaXMud29ya2VyX2NvdW50O1xuXG5cdFx0Ly8gaXRlbXMgcGVyIHdvcmtlclxuXHRcdGxldCBuX2l0ZW1zX3Blcl9kaXZpc2lvbiA9IE1hdGguZmxvb3IoY19pdGVtc19yZW1haW4gLyBjX3dvcmtlcnNfcmVtYWluKTtcblxuXHRcdC8vIGNvbnN0YW50IGRpc3RyaWJ1dGlvblxuXHRcdGlmIChYTV9ESVNUUklCVVRJT05fQ09OU1RBTlQgPT09IHhtX2Rpc3RyaWJ1dGlvbikge1xuXHRcdFx0bGV0IGNfaXRlbXMgPSAwO1xuXG5cdFx0XHQvLyBpdGVyYXRpdmVseSBmaW5kIGluZGV4ZXMgdG8gZGl2aWRlIGF0XG5cdFx0XHRmb3IgKDs7KSB7XG5cdFx0XHRcdC8vIGRpdmlkZSBoZXJlXG5cdFx0XHRcdGlmICgrK2NfaXRlbXMgPj0gbl9pdGVtc19wZXJfZGl2aXNpb24pIHtcblx0XHRcdFx0XHQvLyBkaXZpZGluZyBub3cgd291bGQgY2F1c2UgaXRlbSBvdmVyZmxvd1xuXHRcdFx0XHRcdGlmICghLS1jX3dvcmtlcnNfcmVtYWluKSB7XG5cdFx0XHRcdFx0XHQvLyBkb24ndCBjcmVhdGUgYW55IG1vcmUgZGl2aXNpb25zXG5cdFx0XHRcdFx0XHRmb3IgKDs7KSB5aWVsZCBmYWxzZTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHQvLyBkaXZpc2lvbiBva2F5XG5cdFx0XHRcdFx0eWllbGQgdHJ1ZTtcblxuXHRcdFx0XHRcdC8vIGhvdyBtYW55IGl0ZW1zIHJlbWFpblxuXHRcdFx0XHRcdGNfaXRlbXNfcmVtYWluIC09IGNfaXRlbXM7XG5cblx0XHRcdFx0XHQvLyByZXNldCBpdGVtIGNvdW50IGZvciBuZXcgd29ya2VyXG5cdFx0XHRcdFx0Y19pdGVtcyA9IDA7XG5cblx0XHRcdFx0XHQvLyByZWNhbGN1bGF0ZSB0YXJnZXQgaXRlbXMgcGVyIHdvcmtlclxuXHRcdFx0XHRcdG5faXRlbXNfcGVyX2RpdmlzaW9uID0gTWF0aC5mbG9vcihjX2l0ZW1zX3JlbWFpbiAvIGNfd29ya2Vyc19yZW1haW4pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIHB1c2ggaXRlbVxuXHRcdFx0XHRlbHNlIHtcblx0XHRcdFx0XHR5aWVsZCBmYWxzZTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cblx0Ly8gbGF0ZW50KGhfZGlzcGF0Y2gpIHtcblx0Ly8gXHRsZXQge1xuXHQvLyBcdFx0dGFzazogc190YXNrLFxuXHQvLyBcdFx0YXJnczogYV9hcmdzX2Rpc3BhdGNoPVtdLFxuXHQvLyBcdFx0dGFza19jb3VudDogbl90YXNrcz10aGlzLndvcmtlcl9jb3VudCxcblx0Ly8gXHRcdGV2ZW50czogaF9ldmVudHNfZGlzcGF0Y2gsXG5cdC8vIFx0fSA9IGhfZGlzcGF0Y2g7XG5cblx0Ly8gXHRsZXQgaV9zdWJzZXQgPSAwO1xuXG5cdC8vIFx0Ly8gcHJlcGFyZSB0byBkZWFsIHdpdGggcmVzdWx0c1xuXHQvLyBcdGxldCBrX3BsYW5uZXIgPSBuZXcgYWN0aXZlX2dyb3VwKHRoaXMsIG5fdGFza3MsIChhX2FyZ3M9W10sIGFfdHJhbnNmZXI9bnVsbCkgPT4ge1xuXHQvLyBcdFx0Ly8gc3VtbW9uIHdvcmtlcnMgb25lIGF0IGEgdGltZVxuXHQvLyBcdFx0dGhpcy5zdW1tb25fd29ya2VycygxLCAoa193b3JrZXIpID0+IHtcblx0Ly8gXHRcdFx0Ly8gcmVzdWx0IGhhbmRsZXIgd2FzIG5vdCB1c2VkOyBhdXRvLWVuZCBpdFxuXHQvLyBcdFx0XHRpZigha19wbGFubmVyLnVzZWQpIGtfcGxhbm5lci5lbmQoKTtcblxuXHQvLyBcdFx0XHQvLyBtYWtlIHJlc3VsdCBoYW5kbGVyXG5cdC8vIFx0XHRcdGxldCBma19yZXN1bHQgPSBrX3BsYW5uZXIubWtfcmVzdWx0KGtfd29ya2VyLCBpX3N1YnNldCsrKTtcblxuXHQvLyBcdFx0XHQvLyBtYWtlIHdvcmtlci1zcGVjaWZpYyBldmVudHNcblx0Ly8gXHRcdFx0bGV0IGhfZXZlbnRzX3dvcmtlciA9IHRoaXMuZXZlbnRfcm91dGVyKGhfZXZlbnRzX2Rpc3BhdGNoLCBpX3N1YnNldCk7XG5cblx0Ly8gXHRcdFx0Ly8gZXhlY3V0ZSB3b3JrZXIgb24gdGhpcyBwYXJ0IG9mIGRhdGFcblx0Ly8gXHRcdFx0a193b3JrZXIuZXhlYyh7XG5cdC8vIFx0XHRcdFx0dGFzazogc190YXNrLFxuXHQvLyBcdFx0XHRcdGFyZ3M6IFsuLi5hX2FyZ3NfZGlzcGF0Y2gsIC4uLmFfYXJnc10sXG5cdC8vIFx0XHRcdFx0dHJhbnNmZXI6IGFfdHJhbnNmZXIsXG5cdC8vIFx0XHRcdFx0aG9sZDoga19wbGFubmVyLnVwc3RyZWFtX2hvbGQsXG5cdC8vIFx0XHRcdFx0ZXZlbnRzOiBoX2V2ZW50c193b3JrZXIsXG5cdC8vIFx0XHRcdH0sIGZrX3Jlc3VsdCk7XG5cdC8vIFx0XHR9KTtcblx0Ly8gXHR9KTtcblxuXHQvLyBcdC8vIGxldCB1c2VyIGJpbmQgaGFuZGxlclxuXHQvLyBcdHJldHVybiBrX3BsYW5uZXI7XG5cdC8vIH1cblxuXHRzY2hlZHVsZShrX3dvcmtlciwgZl9ydW4pIHtcblx0XHQvLyB3b3JrZXIgYXZhaWxhYmxlIGltbWVkaWF0ZWx5XG5cdFx0aWYgKGtfd29ya2VyLmF2YWlsYWJsZSkge1xuXHRcdFx0Zl9ydW4oKTtcblx0XHR9XG5cdFx0Ly8gcHVzaCB0byBwcmlvcml0eSBxdWV1ZVxuXHRcdGVsc2Uge1xuXHRcdFx0dGhpcy5yb3N0ZXIuZ2V0KGtfd29ya2VyKS5wdXNoKGZfcnVuKTtcblx0XHR9XG5cdH1cblxuXHRhc3NpZ25fd29ya2VyKGtfd29ya2VyLCBoX3Rhc2ssIGZrX3Rhc2spIHtcblx0XHQvLyBvbmNlIGl0IGlzIHRpbWUgdG8gcnVuIHRoZSB0YXNrIG9uIHRoZSBnaXZlbiB3b3JrZXJcblx0XHR0aGlzLnNjaGVkdWxlKGtfd29ya2VyLCAoKSA9PiB7XG5cdFx0XHRrX3dvcmtlci5leGVjKGhfdGFzaywgKC4uLmFfYXJncykgPT4ge1xuXHRcdFx0XHQvLyB3b3JrZXIganVzdCBtYWRlIGl0c2VsZiBhdmFpbGFibGVcblx0XHRcdFx0dGhpcy53b3JrZXJfYXZhaWxhYmxlKGtfd29ya2VyKTtcblxuXHRcdFx0XHQvLyBjYWxsYmFja1xuXHRcdFx0XHRma190YXNrKC4uLmFfYXJncyk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblx0fVxuXG5cdHJlbGF5KGhfcmVsYXksIGZrX3Jlc3VsdCkge1xuXHRcdGxldCB7XG5cdFx0XHRzZW5kZXI6IHtcblx0XHRcdFx0d29ya2VyOiBrX3dvcmtlcl9zZW5kZXIsXG5cdFx0XHRcdHRhc2tfaWQ6IGlfdGFza19zZW5kZXIsXG5cdFx0XHR9LFxuXHRcdFx0cmVjZWl2ZXI6IHtcblx0XHRcdFx0d29ya2VyOiBrX3dvcmtlcl9yZWNlaXZlcixcblx0XHRcdFx0dGFza19pZDogaV90YXNrX3JlY2VpdmVyLFxuXHRcdFx0fSxcblx0XHRcdHJlY2VpdmVyX3ByaW1hcnk6IGJfcmVjZWl2ZXJfcHJpbWFyeSxcblx0XHRcdHRhc2tfcmVhZHk6IGhfdGFza19yZWFkeSxcblx0XHR9ID0gaF9yZWxheTtcblxuXHRcdGxldCBzX3NlbmRlciA9ICdTJyArIFN0cmluZy5mcm9tQ2hhckNvZGUoNjUgKyBrX3dvcmtlcl9zZW5kZXIuaWQpO1xuXHRcdGxldCBzX3JlY2VpdmVyID0gJ1MnICsgU3RyaW5nLmZyb21DaGFyQ29kZSg2NSArIGtfd29ya2VyX3JlY2VpdmVyLmlkKTtcblxuXHRcdC8vIGNyZWF0ZSBtZXNzYWdlIGNoYW5uZWxcblx0XHRsZXQga19jaGFubmVsID0gbmV3IERDX0NIQU5ORUwoc19zZW5kZXIsIHNfcmVjZWl2ZXIpO1xuXG5cdFx0aWYgKGtfd29ya2VyX3NlbmRlciA9PT0ga193b3JrZXJfcmVjZWl2ZXIpIGRlYnVnZ2VyO1xuXG5cdFx0Ly8gY29uc29sZS53YXJuKGBNL3JlbGF5L3JlY2VpdmUgWyR7aV90YXNrX3NlbmRlcn1dID0+ICR7aV90YXNrX3JlY2VpdmVyfWApO1xuXG5cdFx0Ly8gc2NoZWR1bGUgcmVjZWl2ZXIgd29ya2VyIHRvIHJlY2VpdmUgZGF0YSBhbmQgdGhlbiBydW4gdGFza1xuXHRcdHRoaXMuc2NoZWR1bGUoa193b3JrZXJfcmVjZWl2ZXIsICgpID0+IHtcblx0XHRcdGtfY2hhbm5lbC5wb3J0XzIoKGRfcG9ydCkgPT4ge1xuXHRcdFx0XHRrX3dvcmtlcl9yZWNlaXZlci5yZWNlaXZlKGRfcG9ydCwge1xuXHRcdFx0XHRcdGltcG9ydDogaV90YXNrX3JlY2VpdmVyLFxuXHRcdFx0XHRcdHByaW1hcnk6IGJfcmVjZWl2ZXJfcHJpbWFyeSxcblx0XHRcdFx0XHR0YXNrX3JlYWR5OiBoX3Rhc2tfcmVhZHksXG5cdFx0XHRcdH0sICguLi5hX2FyZ3MpID0+IHtcblx0XHRcdFx0XHQvLyB3b3JrZXIganVzdCBtYWRlIGl0c2VsZiBhdmFpbGFibGVcblx0XHRcdFx0XHR0aGlzLndvcmtlcl9hdmFpbGFibGUoa193b3JrZXJfcmVjZWl2ZXIpO1xuXG5cdFx0XHRcdFx0Ly8gY2FsbGJhY2tcblx0XHRcdFx0XHRma19yZXN1bHQoLi4uYV9hcmdzKTtcblx0XHRcdFx0fSk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdC8vIHNjaGVkdWxlIHNlbmRlciB3b3JrZXIgdG8gcmVsYXkgZGF0YSB0byByZWNlaXZlciB3b3JrZXJcblx0XHR0aGlzLnNjaGVkdWxlKGtfd29ya2VyX3NlbmRlciwgKCkgPT4ge1xuXHRcdFx0a19jaGFubmVsLnBvcnRfMSgoZF9wb3J0KSA9PiB7XG5cdFx0XHRcdGtfd29ya2VyX3NlbmRlci5yZWxheShpX3Rhc2tfc2VuZGVyLCBkX3BvcnQsIFN0cmluZy5mcm9tQ2hhckNvZGUoNjUgKyBrX3dvcmtlcl9yZWNlaXZlci5pZCkpO1xuXG5cdFx0XHRcdC8vIG5vIHJlc3VsdCBuZWVkZWQgZnJvbSByZWxheTsgd29ya2VyIGlzIGF2YWlsYWJsZSBhZnRlciBtZXNzYWdlIHBvc3RzXG5cdFx0XHRcdHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHRcdHRoaXMud29ya2VyX2F2YWlsYWJsZShrX3dvcmtlcl9zZW5kZXIpO1xuXHRcdFx0XHR9LCAwKTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXG5cdH1cblxuXHRzdW1tb25fd29ya2VycyhuX3N1bW1vbnMsIGZrX3dvcmtlcikge1xuXHRcdGxldCBhX3dvcmtlcnMgPSB0aGlzLndvcmtlcnM7XG5cdFx0bGV0IG5fd29ya2VycyA9IHRoaXMud29ya2VyX2NvdW50O1xuXG5cdFx0bGV0IGNfc3VtbW9uZWQgPSAwO1xuXG5cdFx0Ly8gc3RhcnQgYnkgbG9va2luZyBmb3IgYXZhaWxhYmxlIHdvcmtlcnNcblx0XHRsZXQgaV9uZXh0X3dvcmtlcl9zdW1tb24gPSB0aGlzLm5leHRfd29ya2VyX3N1bW1vbjtcblxuXHRcdGZvciAobGV0IGlfd29ya2VyID0gMDsgaV93b3JrZXIgPCBuX3dvcmtlcnMgJiYgY19zdW1tb25lZCA8IG5fc3VtbW9uczsgaV93b3JrZXIrKykge1xuXHRcdFx0bGV0IGlfd29ya2VyX2NhbGwgPSAoaV93b3JrZXIgKyBpX25leHRfd29ya2VyX3N1bW1vbikgJSBuX3dvcmtlcnM7XG5cdFx0XHRsZXQga193b3JrZXIgPSBhX3dvcmtlcnNbaV93b3JrZXJfY2FsbF07XG5cblx0XHRcdC8vIHdvcmtlciBhdmFpbGFibGUgaW1tZWRpYXRlbHlcblx0XHRcdGlmIChrX3dvcmtlci5hdmFpbGFibGUpIHtcblx0XHRcdFx0Ly8gc2V0IG5leHQgd29ya2VyIHRvIHN1bW1vblxuXHRcdFx0XHR0aGlzLm5leHRfd29ya2VyX3N1bW1vbiA9IGlfd29ya2VyX2NhbGwgKyAxO1xuXG5cdFx0XHRcdC8vIHNhdmUgc3VtbW9uIGluZGV4XG5cdFx0XHRcdGxldCBpX3N1YnNldCA9IGNfc3VtbW9uZWQrKztcblxuXHRcdFx0XHQvLyBhbGxvdyBkb3duc3RyZWFtIGhhbmRsZXIgdG8gYmUgZXN0YWJsaXNoZWQgZmlyc3Rcblx0XHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0Ly8gY29uc29sZS5pbmZvKCcgPT4gJytrX3dvcmtlci5pZCk7XG5cdFx0XHRcdFx0Zmtfd29ya2VyKGtfd29ya2VyLCBpX3N1YnNldCk7XG5cdFx0XHRcdH0sIDApO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIHRoZXJlIGFyZSByZW1haW5pbmcgc3VtbW9uc1xuXHRcdGlmIChjX3N1bW1vbmVkIDwgbl9zdW1tb25zKSB7XG5cdFx0XHQvLyBxdWV1ZSBmb3Igbm90aWZpY2F0aW9uIHdoZW4gd29ya2VycyBiZWNvbWUgYXZhaWxhYmxlXG5cdFx0XHR0aGlzLndhaXRfbGlzdC5wdXNoKHtcblx0XHRcdFx0dGFza3NfcmVtYWluaW5nOiBuX3N1bW1vbnMgLSBjX3N1bW1vbmVkLFxuXHRcdFx0XHRlYWNoKGtfd29ya2VyKSB7XG5cdFx0XHRcdFx0Zmtfd29ya2VyKGtfd29ya2VyLCBjX3N1bW1vbmVkKyspO1xuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cdFx0fVxuXHR9XG5cblx0d29ya2VyX2F2YWlsYWJsZShrX3dvcmtlcikge1xuXHRcdC8vIHRoaXMgd29ya2VyIGhhcyBwcmlvcml0eSB0YXNrcyB3YWl0aW5nIGZvciBpdFxuXHRcdGxldCBhX3F1ZXVlID0gdGhpcy5yb3N0ZXIuZ2V0KGtfd29ya2VyKTtcblx0XHRpZiAoYV9xdWV1ZS5sZW5ndGgpIHtcblx0XHRcdC8vIGZpZm8gcG9wIGFuZCBjYWxsXG5cdFx0XHRsZXQgZmtfd29ya2VyID0gYV9xdWV1ZS5zaGlmdCgpO1xuXHRcdFx0Zmtfd29ya2VyKCk7XG5cdFx0fVxuXHRcdC8vIHRoZXJlIGlzIGEgd2FpdCBsaXN0XG5cdFx0ZWxzZSBpZiAodGhpcy53YWl0X2xpc3QubGVuZ3RoKSB7XG5cdFx0XHQvLyB0b3Agb2YgcXVldWVcblx0XHRcdGxldCBoX3BhdGllbnQgPSB0aGlzLndhaXRfbGlzdFswXTtcblxuXHRcdFx0Ly8gYXNzaWduIHdvcmtlciBuZXh0IHRhc2tcblx0XHRcdGhfcGF0aWVudC5lYWNoKGtfd29ya2VyKTtcblxuXHRcdFx0Ly8gdGhpcyBwYXRpZW50IGlzIHNhdGlzZmllZDsgZmlmbyBwb3Bcblx0XHRcdGlmICgwID09PSAtLWhfcGF0aWVudC50YXNrc19yZW1haW5pbmcpIHRoaXMud2FpdF9saXN0LnNoaWZ0KCk7XG5cdFx0fVxuXHRcdC8vIG90aGVyd2lzZSwgZnJlZSB3b3JrZXJcblx0XHRlbHNlIHtcblx0XHRcdGtfd29ya2VyLmF2YWlsYWJsZSA9IHRydWU7XG5cdFx0fVxuXHR9XG5cblx0a2lsbChzX2tpbGwpIHtcblx0XHRyZXR1cm4gUHJvbWlzZS5hbGwodGhpcy53b3JrZXJzLm1hcCgoa193b3JrZXIpID0+IGtfd29ya2VyLmtpbGwoc19raWxsKSkpO1xuXHR9XG59XG5cblxuY2xhc3MgYXJtZWRfZ3JvdXAge1xuXHRjb25zdHJ1Y3RvcihrX2dyb3VwLCBhX3N1YnNldHMpIHtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdGdyb3VwOiBrX2dyb3VwLFxuXHRcdFx0c3Vic2V0czogYV9zdWJzZXRzLFxuXHRcdH0pO1xuXHR9XG5cblx0bWFwKHNfdGFzaywgel9hcmdzID0gW10sIGhfZXZlbnRzX21hcCA9IHt9KSB7XG5cdFx0bGV0IHtcblx0XHRcdGdyb3VwOiBrX2dyb3VwLFxuXHRcdFx0c3Vic2V0czogYV9zdWJzZXRzLFxuXHRcdH0gPSB0aGlzO1xuXG5cdFx0Ly8gaG93IG1hbnkgc3Vic2V0cyB0byBwcm9jZXNzXG5cdFx0bGV0IG5sX3N1YnNldHMgPSBhX3N1YnNldHMubGVuZ3RoO1xuXG5cdFx0Ly8gcHJlcGFyZSB0byBkZWFsIHdpdGggcmVzdWx0c1xuXHRcdGxldCBrX2FjdGlvbiA9IG5ldyBhY3RpdmVfZ3JvdXAoa19ncm91cCwgbmxfc3Vic2V0cyk7XG5cblx0XHQvLyBjcmVhdGUgbWFuaWZlc3Qgb2JqZWN0XG5cdFx0bGV0IGtfbWFuaWZlc3QgPSBtYW5pZmVzdC5mcm9tKHpfYXJncyk7XG5cblx0XHQvLyBzdW1tb24gd29ya2VycyBhcyB0aGV5IGJlY29tZSBhdmFpbGFibGVcblx0XHRrX2dyb3VwLnN1bW1vbl93b3JrZXJzKG5sX3N1YnNldHMsIChrX3dvcmtlciwgaV9zdWJzZXQpID0+IHtcblx0XHRcdC8vIGlmKGhfZGlzcGF0Y2guZGVidWcpIGRlYnVnZ2VyO1xuXG5cdFx0XHQvLyByZXN1bHQgaGFuZGxlciB3YXMgbm90IHVzZWQ7IGF1dG8tZW5kIGl0XG5cdFx0XHRpZiAoIWtfYWN0aW9uLnBpcGVkKSBrX2FjdGlvbi5lbmQoKTtcblxuXHRcdFx0Ly8gbWFrZSByZXN1bHQgaGFuZGxlclxuXHRcdFx0bGV0IGZrX3Jlc3VsdCA9IGtfYWN0aW9uLm1rX3Jlc3VsdChrX3dvcmtlciwgaV9zdWJzZXQpO1xuXG5cdFx0XHQvLyBtYWtlIHdvcmtlci1zcGVjaWZpYyBldmVudHNcblx0XHRcdGxldCBoX2V2ZW50c193b3JrZXIgPSB0aGlzLmV2ZW50X3JvdXRlcihoX2V2ZW50c19tYXAsIGlfc3Vic2V0KTtcblxuXHRcdFx0Ly8gcHVzaCBzdWJzZXQgdG8gZnJvbnQgb2YgYXJnc1xuXHRcdFx0bGV0IGtfbWFuaWZlc3Rfd29ya2VyID0ga19tYW5pZmVzdC5wcmVwZW5kKGFfc3Vic2V0c1tpX3N1YnNldF0pO1xuXG5cdFx0XHQvLyBleGVjdXRlIHdvcmtlciBvbiBuZXh0IHBhcnQgb2YgZGF0YVxuXHRcdFx0a193b3JrZXIuZXhlYyh7XG5cdFx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHRcdFx0bWFuaWZlc3Q6IGtfbWFuaWZlc3Rfd29ya2VyLFxuXHRcdFx0XHRob2xkOiBrX2FjdGlvbi51cHN0cmVhbV9ob2xkLFxuXHRcdFx0XHRldmVudHM6IGhfZXZlbnRzX3dvcmtlcixcblx0XHRcdH0sIGZrX3Jlc3VsdCk7XG5cdFx0fSk7XG5cblx0XHQvLyBsZXQgdXNlciBiaW5kIGEgaGFuZGxlclxuXHRcdHJldHVybiBrX2FjdGlvbjtcblx0fVxuXG5cdGV2ZW50X3JvdXRlcihoX2V2ZW50cywgaV9zdWJzZXQpIHtcblx0XHRpZiAoIWhfZXZlbnRzKSByZXR1cm4gbnVsbDtcblxuXHRcdC8vIG1ha2UgYSBuZXcgaGFzaCB0aGF0IHB1c2hlcyB3b3JrZXIgaW5kZXggaW4gZnJvbnQgb2YgY2FsbGJhY2sgYXJnc1xuXHRcdGxldCBoX2V2ZW50c19sb2NhbCA9IHt9O1xuXHRcdGZvciAobGV0IHNfZXZlbnQgaW4gaF9ldmVudHMpIHtcblx0XHRcdGxldCBmX2V2ZW50ID0gaF9ldmVudHNbc19ldmVudF07XG5cdFx0XHRoX2V2ZW50c19sb2NhbFtzX2V2ZW50XSA9ICguLi5hX2FyZ3MpID0+IHtcblx0XHRcdFx0Zl9ldmVudChpX3N1YnNldCwgLi4uYV9hcmdzKTtcblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGhfZXZlbnRzX2xvY2FsO1xuXHR9XG59XG5cblxuY2xhc3MgYWN0aXZlX2dyb3VwIHtcblx0Y29uc3RydWN0b3Ioa19ncm91cCwgbl90YXNrcywgZl9wdXNoID0gbnVsbCkge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0Z3JvdXA6IGtfZ3JvdXAsXG5cdFx0XHR0YXNrX2NvdW50OiBuX3Rhc2tzLFxuXG5cdFx0XHQvLyB3aGV0aGVyIG9yIG5vdCB0aGUgdXNlciBoYXMgcm91dGVkIHRoaXMgc3RyZWFtIHlldFxuXHRcdFx0cGlwZWQ6IGZhbHNlLFxuXG5cdFx0XHQvLyBsaW5rIHRvIG5leHQgYWN0aW9uIGRvd25zdHJlYW1cblx0XHRcdGRvd25zdHJlYW06IG51bGwsXG5cblx0XHRcdC8vIHdoZXRoZXIgb3Igbm90IHRoZSBhY3Rpb24gdXBzdHJlYW0gc2hvdWxkIGhvbGQgZGF0YSBpbiB3b3JrZXJcblx0XHRcdHVwc3RyZWFtX2hvbGQ6IGZhbHNlLFxuXG5cdFx0XHRyZXN1bHRfY291bnQ6IDAsXG5cblx0XHRcdHJlc3VsdF9jYWxsYmFjazogbnVsbCxcblx0XHRcdGNvbXBsZXRlX2NhbGxiYWNrOiBudWxsLFxuXG5cdFx0XHRwdXNoOiBmX3B1c2ggfHwgKCgpID0+IHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBjYW5ub3QgJy5wdXNoKCknIGhlcmVgKTtcblx0XHRcdH0pLFxuXHRcdFx0Y2Fycnk6IG51bGwsXG5cblx0XHRcdHJlZHVjdGlvbnM6IG51bGwsXG5cdFx0XHRyZWR1Y2VfdGFzazogbnVsbCxcblxuXHRcdFx0cmVzdWx0czogbnVsbCxcblx0XHRcdHNlcXVlbmNlX2luZGV4OiAwLFxuXHRcdH0pO1xuXHR9XG5cblx0dGhydShzX3Rhc2ssIHpfYXJncyA9IFtdLCBoX2V2ZW50cyA9IG51bGwpIHtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdHBpcGVkOiB0cnVlLFxuXHRcdFx0cm91dGU6IHRoaXMucm91dGVfdGhydSxcblx0XHRcdHVwc3RyZWFtX2hvbGQ6IHRydWUsXG5cdFx0XHRuZXh0X3Rhc2s6IHtcblx0XHRcdFx0dGFzazogc190YXNrLFxuXHRcdFx0XHRtYW5pZmVzdDogbWFuaWZlc3QuZnJvbSh6X2FyZ3MpLFxuXHRcdFx0XHRldmVudHM6IGhfZXZlbnRzLFxuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdHJldHVybiB0aGlzLmNvbXBsZXRhYmxlKCk7XG5cdH1cblxuXHRlYWNoKGZrX3Jlc3VsdCwgZmtfY29tcGxldGUgPSBudWxsKSB7XG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRwaXBlZDogdHJ1ZSxcblx0XHRcdHJvdXRlOiB0aGlzLnJvdXRlX2VhY2gsXG5cdFx0XHRyZXN1bHRfY2FsbGJhY2s6IGZrX3Jlc3VsdCxcblx0XHRcdGNvbXBsZXRlX2NhbGxiYWNrOiBma19jb21wbGV0ZSxcblx0XHR9KTtcblxuXHRcdHJldHVybiB0aGlzLmNvbXBsZXRhYmxlKCk7XG5cdH1cblxuXHRzZXJpZXMoZmtfcmVzdWx0LCBma19jb21wbGV0ZSA9IG51bGwpIHtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdHBpcGVkOiB0cnVlLFxuXHRcdFx0cm91dGU6IHRoaXMucm91dGVfc2VyaWVzLFxuXHRcdFx0cmVzdWx0X2NhbGxiYWNrOiBma19yZXN1bHQsXG5cdFx0XHRjb21wbGV0ZV9jYWxsYmFjazogZmtfY29tcGxldGUsXG5cdFx0XHRyZXN1bHRzOiBuZXcgQXJyYXkodGhpcy50YXNrX2NvdW50KSxcblx0XHR9KTtcblxuXHRcdHJldHVybiB0aGlzLmNvbXBsZXRhYmxlKCk7XG5cdH1cblxuXHRyZWR1Y2Uoc190YXNrLCB6X2FyZ3MgPSBbXSwgaF9ldmVudHMgPSBudWxsKSB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChmX3Jlc29sdmUpID0+IHtcblx0XHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0XHRwaXBlZDogdHJ1ZSxcblx0XHRcdFx0cm91dGU6IHRoaXMucm91dGVfcmVkdWNlLFxuXHRcdFx0XHRjb21wbGV0ZV9jYWxsYmFjazogZl9yZXNvbHZlLFxuXHRcdFx0XHR1cHN0cmVhbV9ob2xkOiB0aGlzLnRhc2tfY291bnQgPiAxLCAvLyBzZXQgYGhvbGRgIGZsYWcgZm9yIHVwc3RyZWFtIHNlbmRpbmcgaXRzIHRhc2tcblx0XHRcdFx0cmVkdWN0aW9uczogbmV3IGNvbnZlcmdlbnRfcGFpcndpc2VfdHJlZSh0aGlzLnRhc2tfY291bnQpLFxuXHRcdFx0XHRyZWR1Y2VfdGFzazoge1xuXHRcdFx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHRcdFx0XHRtYW5pZmVzdDogbmV3IG1hbmlmZXN0KHpfYXJncyksXG5cdFx0XHRcdFx0ZXZlbnRzOiBoX2V2ZW50cyxcblx0XHRcdFx0XHRob2xkOiB0cnVlLCAvLyBhc3N1bWUgYW5vdGhlciByZWR1Y3Rpb24gd2lsbCBiZSBwZXJmb3JtZWQgYnkgZGVmYXVsdFxuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH1cblxuXHQvLyByZXN1bHRzIG5vdCBoYW5kbGVkXG5cdHJvdXRlKCkge1xuXHRcdGNvbnNvbGUud2FybigncmVzdWx0IGZyb20gd29ya2VyIHdhcyBub3QgaGFuZGxlZCEgbWFrZSBzdXJlIHRvIGJpbmQgYSBoYW5kbGVyIGJlZm9yZSBnb2luZyBhc3luYy4gdXNlIGAuaWdub3JlKClgIGlmIHlvdSBkbyBub3QgY2FyZSBhYm91dCB0aGUgcmVzdWx0Jyk7XG5cdH1cblxuXHRyb3V0ZV90aHJ1KGhwX25vdGlmaWNhdGlvbiwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spIHtcblx0XHQvLyBjcmVhdGUgc3BlY2lmaWMgdGFzayBmb3Igd29ya2VyIHRvIHJlY2VpdmUgZGF0YSBmcm9tIGl0cyBwcmV2aW91cyB0YXNrXG5cdFx0bGV0IGhfdGFzayA9IE9iamVjdC5hc3NpZ24oe1xuXHRcdFx0cmVjZWl2ZTogaV90YXNrLFxuXHRcdFx0aG9sZDogdGhpcy5kb3duc3RyZWFtLnVwc3RyZWFtX2hvbGQsXG5cdFx0fSwgdGhpcy5uZXh0X3Rhc2spO1xuXG5cdFx0Ly8gYXNzaWduIHdvcmtlciBuZXcgdGFza1xuXHRcdHRoaXMuZ3JvdXAuYXNzaWduX3dvcmtlcihrX3dvcmtlciwgaF90YXNrLCAoLi4uYV9hcmdzKSA9PiB7XG5cdFx0XHQvLyBtayByZXN1bHRcblx0XHRcdGxldCBmX3Jlc3VsdCA9IHRoaXMuZG93bnN0cmVhbS5ta19yZXN1bHQoa193b3JrZXIsIGlfc3Vic2V0KTtcblxuXHRcdFx0Ly8gdHJpZ2dlciByZXN1bHRcblx0XHRcdGZfcmVzdWx0KC4uLmFfYXJncyk7XG5cdFx0fSk7XG5cdH1cblxuXHQvLyByZXR1cm4gcmVzdWx0cyBpbW1lZGlhdGVseVxuXHRyb3V0ZV9lYWNoKHpfcmVzdWx0LCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzaykge1xuXHRcdHRoaXMuaGFuZGxlX3Jlc3VsdF9jYWxsYmFjayh6X3Jlc3VsdCwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spO1xuXG5cdFx0Ly8gdGhpcyB3YXMgdGhlIGxhc3QgcmVzdWx0XG5cdFx0aWYgKCsrdGhpcy5yZXN1bHRfY291bnQgPT09IHRoaXMudGFza19jb3VudCAmJiAnZnVuY3Rpb24nID09PSB0eXBlb2YgdGhpcy5jb21wbGV0ZV9jYWxsYmFjaykge1xuXHRcdFx0dGhpcy5jb21wbGV0ZV9jYWxsYmFjaygpO1xuXHRcdH1cblx0fVxuXG5cdHJvdXRlX3Nlcmllcyh6X3Jlc3VsdCwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spIHtcblx0XHRsZXQge1xuXHRcdFx0dGFza19jb3VudDogbl90YXNrcyxcblx0XHRcdHJlc3VsdF9jYWxsYmFjazogZmtfcmVzdWx0LFxuXHRcdFx0c2VxdWVuY2VfaW5kZXg6IGlfc2VxdWVuY2UsXG5cdFx0XHRyZXN1bHRzOiBhX3Jlc3VsdHMsXG5cdFx0fSA9IHRoaXM7XG5cblx0XHQvLyByZXN1bHQgYXJyaXZlZCB3aGlsZSB3ZSB3ZXJlIHdhaXRpbmcgZm9yIGl0XG5cdFx0aWYgKGlfc3Vic2V0ID09PSBpX3NlcXVlbmNlKSB7XG5cdFx0XHQvLyB3aGlsZSB0aGVyZSBhcmUgcmVzdWx0cyB0byBwcm9jZXNzXG5cdFx0XHRmb3IgKDs7KSB7XG5cdFx0XHRcdC8vIHByb2Nlc3MgcmVzdWx0XG5cdFx0XHRcdHRoaXMuaGFuZGxlX3Jlc3VsdF9jYWxsYmFjayh6X3Jlc3VsdCwgaV9zZXF1ZW5jZSwga193b3JrZXIsIGlfdGFzayk7XG5cblx0XHRcdFx0Ly8gcmVhY2hlZCBlbmQgb2Ygc2VxdWVuY2U7IHRoYXQgd2FzIGxhc3QgcmVzdWx0XG5cdFx0XHRcdGlmICgrK2lfc2VxdWVuY2UgPT09IG5fdGFza3MpIHtcblx0XHRcdFx0XHQvLyBjb21wbGV0aW9uIGNhbGxiYWNrXG5cdFx0XHRcdFx0aWYgKCdmdW5jdGlvbicgPT09IHR5cGVvZiB0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKSB7XG5cdFx0XHRcdFx0XHR0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKCk7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gZXhpdCBsb29wIGFuZCBzYXZlIHNlcXVlbmNlIGluZGV4XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBuZXh0IHJlc3VsdCBub3QgeWV0IHJlYWR5XG5cdFx0XHRcdGxldCBoX25leHRfcmVzdWx0ID0gYV9yZXN1bHRzW2lfc2VxdWVuY2VdO1xuXHRcdFx0XHRpZiAoIWhfbmV4dF9yZXN1bHQpIGJyZWFrO1xuXG5cdFx0XHRcdC8vIGVsc2U7IG9udG8gbmV4dCByZXN1bHRcblx0XHRcdFx0el9yZXN1bHQgPSBoX25leHRfcmVzdWx0O1xuXG5cdFx0XHRcdC8vIHJlbGVhc2UgdG8gZ2Ncblx0XHRcdFx0YV9yZXN1bHRzW2lfc2VxdWVuY2VdID0gbnVsbDtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gbm90IHlldCByZWFkeSB0byBwcm9jZXNzIHRoaXMgcmVzdWx0XG5cdFx0ZWxzZSB7XG5cdFx0XHQvLyBzdG9yZSBpdCBmb3Igbm93XG5cdFx0XHRhX3Jlc3VsdHNbaV9zdWJzZXRdID0gel9yZXN1bHQ7XG5cdFx0fVxuXG5cdFx0Ly8gdXBkYXRlIHNlcXVlbmNlIGluZGV4XG5cdFx0dGhpcy5zZXF1ZW5jZV9pbmRleCA9IGlfc2VxdWVuY2U7XG5cdH1cblxuXHRyb3V0ZV9yZWR1Y2UoaHBfbm90aWZpY2F0aW9uLCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzaykge1xuXHRcdC8vIGRlYnVnZ2VyO1xuXG5cdFx0Ly8gbm9kZSBpbml0aWF0aW9uXG5cdFx0bGV0IGhfY2Fub3B5X25vZGUgPSB0aGlzLnJlZHVjdGlvbnMucmF5KGlfc3Vic2V0LCB7XG5cdFx0XHR3b3JrZXI6IGtfd29ya2VyLFxuXHRcdFx0dGFza19pZDogaV90YXNrLFxuXHRcdH0pO1xuXG5cdFx0Ly8gc3RhcnQgYXQgY2Fub3B5IG5vZGVcblx0XHR0aGlzLnJlZHVjZV9yZXN1bHQoaHBfbm90aWZpY2F0aW9uLCBoX2Nhbm9weV9ub2RlKTtcblx0fVxuXG5cdC8vIGVhY2ggdGltZSBhIHdvcmtlciBjb21wbGV0ZXNcblx0cmVkdWNlX3Jlc3VsdCh6X3Jlc3VsdCwgaF9ub2RlKSB7XG5cdFx0bGV0IHtcblx0XHRcdGdyb3VwOiBrX2dyb3VwLFxuXHRcdFx0cmVkdWN0aW9uczoga19wYWlyd2lzZV90cmVlLFxuXHRcdFx0cmVkdWNlX3Rhc2s6IGhfdGFza19yZWFkeSxcblx0XHR9ID0gdGhpcztcblxuXHRcdC8vIGZpbmFsIHJlc3VsdFxuXHRcdGlmIChIUF9XT1JLRVJfTk9USUZJQ0FUSU9OICE9PSB6X3Jlc3VsdCkge1xuXHRcdFx0bGV0IHpfY29tcGxldGlvbiA9IHRoaXMuY29tcGxldGVfY2FsbGJhY2soel9yZXN1bHQpO1xuXG5cdFx0XHQvLyBhZGQgdG8gb3V0ZXIgc3RyZWFtXG5cdFx0XHRpZiAoel9jb21wbGV0aW9uIGluc3RhbmNlb2YgYWN0aXZlX2dyb3VwKSB7XG5cdFx0XHRcdGxldCBrX2xha2UgPSB0aGlzLmxha2UoKTtcblx0XHRcdFx0bGV0IGZrX2xha2UgPSBrX2xha2UuY29tcGxldGVfY2FsbGJhY2s7XG5cdFx0XHRcdGxldCBocF9sb2NrID0gU3ltYm9sKCdrZXknKTtcblxuXHRcdFx0XHR6X2NvbXBsZXRpb24uZW5kKCgpID0+IHtcblx0XHRcdFx0XHRrX2dyb3VwLnVubG9jayhocF9sb2NrKTtcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0Ly8gcmV3cmFwIGNvbXBsZXRpb24gY2FsbGJhY2sgZnVuY3Rpb25cblx0XHRcdFx0a19sYWtlLmNvbXBsZXRlX2NhbGxiYWNrID0gKCkgPT4ge1xuXHRcdFx0XHRcdGtfZ3JvdXAud2FpdChocF9sb2NrLCAoKSA9PiB7XG5cdFx0XHRcdFx0XHRma19sYWtlKCk7XG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIG5vdGlmaWNhdGlvblxuXHRcdGVsc2Uge1xuXHRcdFx0Ly8gYWJsZSB0byBwZXJmb3JtIGEgcmVkdWN0aW9uXG5cdFx0XHRsZXQgaF9tZXJnZSA9IGtfcGFpcndpc2VfdHJlZS5jb21taXQoaF9ub2RlKTtcblx0XHRcdGlmIChoX21lcmdlKSB7XG5cdFx0XHRcdGxldCBrX3dvcmtlciA9IGhfbm9kZS5pdGVtLndvcmtlcjtcblxuXHRcdFx0XHQvLyB0aGlzIHJlZHVjdGlvbiB3aWxsIGJlIHRoZSBsYXN0IG9uZTsgZG8gbm90IGhvbGQgcmVzdWx0XG5cdFx0XHRcdGlmIChoX21lcmdlLm1ha2VzX3Jvb3QpIHtcblx0XHRcdFx0XHRoX3Rhc2tfcmVhZHkgPSBPYmplY3QuYXNzaWduKHt9LCBoX3Rhc2tfcmVhZHkpO1xuXHRcdFx0XHRcdGhfdGFza19yZWFkeS5ob2xkID0gZmFsc2U7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBhZnRlciByZWR1Y3Rpb247XG5cdFx0XHRcdGxldCBma19yZWR1Y3Rpb24gPSAoel9yZXN1bHRfcmVkdWN0aW9uLCBpX3Rhc2tfcmVkdWN0aW9uLCBrX3dvcmtlcl9yZWR1Y3Rpb24pID0+IHtcblx0XHRcdFx0XHQvLyByZWN1cnNlIG9uIHJlZHVjdGlvbjsgdXBkYXRlIHNlbmRlciBmb3IgY2FsbGJhY2sgc2NvcGVcblx0XHRcdFx0XHR0aGlzLnJlZHVjZV9yZXN1bHQoel9yZXN1bHRfcmVkdWN0aW9uLCBPYmplY3QuYXNzaWduKGhfbWVyZ2Uubm9kZSwge1xuXHRcdFx0XHRcdFx0aXRlbToge1xuXHRcdFx0XHRcdFx0XHR3b3JrZXI6IGtfd29ya2VyX3JlZHVjdGlvbixcblx0XHRcdFx0XHRcdFx0dGFza19pZDogaV90YXNrX3JlZHVjdGlvbixcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0fSkpO1xuXHRcdFx0XHR9O1xuXG5cdFx0XHRcdC8vIGdpdmUgcmVkdWN0aW9uIHRhc2sgdG8gd29ya2VyIHRoYXQgZmluaXNoZWQgZWFybGllcjsgcGFzcyB0byB0aGUgcmlnaHRcblx0XHRcdFx0aWYgKGtfd29ya2VyID09PSBoX21lcmdlLmxlZnQud29ya2VyKSB7XG5cdFx0XHRcdFx0a19ncm91cC5yZWxheSh7XG5cdFx0XHRcdFx0XHRzZW5kZXI6IGhfbm9kZS5pdGVtLFxuXHRcdFx0XHRcdFx0cmVjZWl2ZXI6IGhfbWVyZ2UucmlnaHQsXG5cdFx0XHRcdFx0XHRyZWNlaXZlcl9wcmltYXJ5OiBmYWxzZSxcblx0XHRcdFx0XHRcdHRhc2tfcmVhZHk6IGhfdGFza19yZWFkeSxcblx0XHRcdFx0XHR9LCBma19yZWR1Y3Rpb24pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIHBhc3MgdG8gdGhlIGxlZnRcblx0XHRcdFx0ZWxzZSB7XG5cdFx0XHRcdFx0a19ncm91cC5yZWxheSh7XG5cdFx0XHRcdFx0XHRzZW5kZXI6IGhfbm9kZS5pdGVtLFxuXHRcdFx0XHRcdFx0cmVjZWl2ZXI6IGhfbWVyZ2UubGVmdCxcblx0XHRcdFx0XHRcdHJlY2VpdmVyX3ByaW1hcnk6IHRydWUsXG5cdFx0XHRcdFx0XHR0YXNrX3JlYWR5OiBoX3Rhc2tfcmVhZHksXG5cdFx0XHRcdFx0fSwgZmtfcmVkdWN0aW9uKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHJvdXRlX2VuZCgpIHtcblx0XHQvLyB0aGlzIHdhcyB0aGUgbGFzdCByZXN1bHRcblx0XHRpZiAoKyt0aGlzLnJlc3VsdF9jb3VudCA9PT0gdGhpcy50YXNrX2NvdW50ICYmICdmdW5jdGlvbicgPT09IHR5cGVvZiB0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKSB7XG5cdFx0XHR0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKCk7XG5cdFx0fVxuXHR9XG5cblx0Y29tcGxldGFibGUoKSB7XG5cdFx0bGV0IGZrX2NvbXBsZXRlID0gdGhpcy5jb21wbGV0ZV9jYWxsYmFjaztcblxuXHRcdC8vIG5vdGhpbmcgdG8gcmVkdWNlOyBjb21wbGV0ZSBhZnRlciBlc3RhYmxpc2hpbmcgZG93bnN0cmVhbVxuXHRcdGlmICghdGhpcy50YXNrX2NvdW50ICYmICdmdW5jdGlvbicgPT09IHR5cGVvZiBma19jb21wbGV0ZSkge1xuXHRcdFx0c2V0VGltZW91dChma19jb21wbGV0ZSwgMCk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHRoaXMuZG93bnN0cmVhbSA9IG5ldyBhY3RpdmVfZ3JvdXAodGhpcy5ncm91cCwgdGhpcy50YXNrX2NvdW50LCB0aGlzLnB1c2gpO1xuXHR9XG5cblx0aGFuZGxlX3Jlc3VsdF9jYWxsYmFjayh6X3Jlc3VsdCwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spIHtcblx0XHRsZXQga19kb3duc3RyZWFtID0gdGhpcy5kb3duc3RyZWFtO1xuXG5cdFx0Ly8gYXBwbHkgY2FsbGJhY2sgYW5kIGNhcHR1cmUgcmV0dXJuXG5cdFx0bGV0IHpfcmV0dXJuID0gdGhpcy5yZXN1bHRfY2FsbGJhY2soel9yZXN1bHQsIGlfc3Vic2V0KTtcblxuXHRcdC8vIGRvd25zdHJlYW0gaXMgZXhwZWN0aW5nIGRhdGEgZm9yIG5leHQgdGFza1xuXHRcdGlmIChrX2Rvd25zdHJlYW0gJiYga19kb3duc3RyZWFtLnBpcGVkKSB7XG5cdFx0XHQvLyBub3RoaW5nIHdhcyByZXR1cm5lZDsgcmV1c2UgaW5wdXQgZGF0YVxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gel9yZXR1cm4pIHtcblx0XHRcdFx0Ly8gZG93bnN0cmVhbSBhY3Rpb24gd2FzIGV4cGVjdGluZyB3b3JrZXIgdG8gaG9sZCBkYXRhXG5cdFx0XHRcdGlmIChrX2Rvd25zdHJlYW0udXBzdHJlYW1faG9sZCkge1xuXHRcdFx0XHRcdHRocm93ICdub3QgeWV0IGltcGxlbWVudGVkJztcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRrX2Rvd25zdHJlYW0ucm91dGUoel9yZXN1bHQsIGlfc3Vic2V0LCBrX3dvcmtlciwgaV90YXNrKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0Ly8gcmV0dXJuZWQgcHJvbWlzZVxuXHRcdFx0ZWxzZSBpZiAoel9yZXR1cm4gaW5zdGFuY2VvZiBQcm9taXNlKSB7XG5cdFx0XHRcdHpfcmV0dXJuXG5cdFx0XHRcdFx0Ly8gYXdhaXQgcHJvbWlzZSByZXNvbHZlXG5cdFx0XHRcdFx0LnRoZW4oKHpfY2FycnkpID0+IHtcblx0XHRcdFx0XHRcdGtfZG93bnN0cmVhbS5yb3V0ZSh6X2NhcnJ5LCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzayk7XG5cdFx0XHRcdFx0fSlcblx0XHRcdFx0XHQvLyBjYXRjaCBwcm9taXNlIHJlamVjdFxuXHRcdFx0XHRcdC5jYXRjaCgoZV9yZWplY3QpID0+IHtcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcigndW5jYXVnaHQgcmVqZWN0aW9uJyk7XG5cdFx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0XHQvLyByZXR1cm5lZCBlcnJvclxuXHRcdFx0ZWxzZSBpZiAoel9yZXR1cm4gaW5zdGFuY2VvZiBFcnJvcikge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ25vdCB5ZXQgaW1wbGVtZW50ZWQnKTtcblx0XHRcdH1cblx0XHRcdC8vIHJldHVybmVkIGltbWVkaWF0ZWx5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0a19kb3duc3RyZWFtLnJvdXRlKHpfcmV0dXJuLCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzayk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIHNvbWV0aGluZyB3YXMgcmV0dXJuZWQgdGhvdWdoXG5cdFx0ZWxzZSBpZiAodW5kZWZpbmVkICE9PSB6X3JldHVybikge1xuXHRcdFx0Y29uc29sZS53YXJuKCdhIHRhc2sgc3RyZWFtIGhhbmRsZXIgcmV0dXJuIHNvbWUgdmFsdWUgYnV0IGl0IGNhbm5vdCBiZSBjYXJyaWVkIGJlY2F1c2UgZG93bnN0cmVhbSBpcyBub3QgZXhwZWN0aW5nIHRhc2sgZGF0YScpO1xuXHRcdFx0ZGVidWdnZXI7XG5cdFx0fVxuXHR9XG5cblx0ZW5kKGZrX2NvbXBsZXRlID0gbnVsbCkge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0cGlwZWQ6IHRydWUsXG5cdFx0XHRyb3V0ZTogdGhpcy5yb3V0ZV9lbmQsXG5cdFx0XHRjb21wbGV0ZV9jYWxsYmFjazogZmtfY29tcGxldGUsXG5cdFx0fSk7XG5cdH1cblxuXG5cdG1rX3Jlc3VsdChrX3dvcmtlciwgaV9zdWJzZXQpIHtcblx0XHQvLyBmb3Igd2hlbiBhIHJlc3VsdCBhcnJpdmVzXG5cdFx0cmV0dXJuICh6X3Jlc3VsdCwgaV90YXNrKSA9PiB7XG5cdFx0XHQvLyB0aGlzIHdvcmtlciBqdXN0IG1hZGUgaXRzZWxmIGF2YWlsYWJsZVxuXHRcdFx0dGhpcy5ncm91cC53b3JrZXJfYXZhaWxhYmxlKGtfd29ya2VyKTtcblxuXHRcdFx0Ly8gcm91dGUgdGhlIHJlc3VsdFxuXHRcdFx0dGhpcy5yb3V0ZSh6X3Jlc3VsdCwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spO1xuXHRcdH07XG5cdH1cblxuXHQvLyB0cmF2ZXJzZSBhbGwgdGhlIHdheSBkb3duc3RyZWFtXG5cdGxha2UoKSB7XG5cdFx0bGV0IGtfZG93bnN0cmVhbSA9IHRoaXM7XG5cdFx0Zm9yICg7Oykge1xuXHRcdFx0aWYgKGtfZG93bnN0cmVhbS5kb3duc3RyZWFtKSBrX2Rvd25zdHJlYW0gPSBrX2Rvd25zdHJlYW0uZG93bnN0cmVhbTtcblx0XHRcdGVsc2UgYnJlYWs7XG5cdFx0fVxuXHRcdHJldHVybiBrX2Rvd25zdHJlYW07XG5cdH1cbn1cblxuXG5mdW5jdGlvbiBkaXZpZGUoYV90aGluZ3MsIG5fd29ya2VycywgeG1fc3RyYXRlZ3ksIGhfZGl2aWRlID0ge30pIHtcblx0bGV0IG5sX3RoaW5ncyA9IGFfdGhpbmdzLmxlbmd0aDtcblxuXHRsZXQge1xuXHRcdGl0ZW1fY291bnQ6IGNfaXRlbXNfcmVtYWluID0gbmxfdGhpbmdzLFxuXHRcdG9wZW46IGZfb3BlbiA9IG51bGwsXG5cdFx0c2VhbDogZl9zZWFsID0gbnVsbCxcblx0XHRxdWFudGlmeTogZl9xdWFudGlmeSA9ICgpID0+IHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihgbXVzdCBwcm92aWRlIGZ1bmN0aW9uIGZvciBrZXkgJ3F1YW50aWZ5JyB3aGVuIHVzaW5nICcuYmFsYW5jZV9vcmRlcmVkX2dyb3VwcygpJ2ApO1xuXHRcdH0sXG5cdH0gPSBoX2RpdmlkZTtcblxuXHRsZXQgYV90YXNrcyA9IFtdO1xuXG5cdGlmIChBcnJheS5pc0FycmF5KGFfdGhpbmdzKSkge1xuXHRcdC8vIGRvIG5vdCBhc3NpZ24gd29ya2VycyB0byBub3RoaW5nXG5cdFx0aWYgKG5sX3RoaW5ncyA8IG5fd29ya2Vycykgbl93b3JrZXJzID0gbmxfdGhpbmdzO1xuXG5cdFx0Ly8gaXRlbXMgcGVyIHdvcmtlclxuXHRcdGxldCB4X2l0ZW1zX3Blcl93b3JrZXIgPSBNYXRoLmZsb29yKGNfaXRlbXNfcmVtYWluIC8gbl93b3JrZXJzKTtcblxuXHRcdC8vIGRpc3RyaWJ1dGUgaXRlbXMgZXF1YWxseVxuXHRcdGlmIChYTV9TVFJBVEVHWV9FUVVBTCA9PT0geG1fc3RyYXRlZ3kpIHtcblx0XHRcdC8vIHN0YXJ0IGluZGV4IG9mIHNsaWNlXG5cdFx0XHRsZXQgaV9zdGFydCA9IDA7XG5cblx0XHRcdC8vIGVhY2ggd29ya2VyXG5cdFx0XHRmb3IgKGxldCBpX3dvcmtlciA9IDA7IGlfd29ya2VyIDwgbl93b3JrZXJzOyBpX3dvcmtlcisrKSB7XG5cdFx0XHRcdC8vIGZpbmQgZW5kIGluZGV4IG9mIHdvcmtlcjsgZW5zdXJlIGFsbCBpdGVtcyBmaW5kIGEgd29ya2VyXG5cdFx0XHRcdGxldCBpX2VuZCA9IChpX3dvcmtlciA9PT0gbl93b3JrZXJzIC0gMSkgPyBubF90aGluZ3MgOiBpX3N0YXJ0ICsgeF9pdGVtc19wZXJfd29ya2VyO1xuXG5cdFx0XHRcdC8vIGV4dHJhY3Qgc2xpY2UgZnJvbSB0aGluZ3MgYW5kIHB1c2ggdG8gZGl2aXNpb25zXG5cdFx0XHRcdGFfdGFza3MucHVzaChhX3RoaW5ncy5zbGljZShpX3N0YXJ0LCBpX2VuZCkpO1xuXG5cdFx0XHRcdC8vIGFkdmFuY2UgaW5kZXggZm9yIG5leHQgZGl2aXNpb25cblx0XHRcdFx0aV9zdGFydCA9IGlfZW5kO1xuXG5cdFx0XHRcdC8vIHVwZGF0ZSBudW1iZXIgb2YgaXRlbXMgcmVtYWluaW5nXG5cdFx0XHRcdGNfaXRlbXNfcmVtYWluIC09IHhfaXRlbXNfcGVyX3dvcmtlcjtcblxuXHRcdFx0XHQvLyByZWNhbGN1bGF0ZSB0YXJnZXQgaXRlbXMgcGVyIHdvcmtlclxuXHRcdFx0XHR4X2l0ZW1zX3Blcl93b3JrZXIgPSBNYXRoLmZsb29yKGNfaXRlbXNfcmVtYWluIC8gKG5fd29ya2VycyAtIGlfd29ya2VyIC0gMSkpO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBvcmRlcmVkIGdyb3Vwc1xuXHRcdGVsc2UgaWYgKFhNX1NUUkFURUdZX09SREVSRURfR1JPVVBTICYgeG1fc3RyYXRlZ3kpIHtcblx0XHRcdGxldCBpX3dvcmtlciA9IDA7XG5cdFx0XHRsZXQgY193b3JrZXJfaXRlbXMgPSAwO1xuXG5cdFx0XHQvLyBvcGVuIG5ldyB0YXNrIGl0ZW0gbGlzdFxuXHRcdFx0bGV0IGFfdGFza19pdGVtcyA9IFtdO1xuXHRcdFx0bGV0IHpfdGFza19kYXRhID0gZl9vcGVuID8gZl9vcGVuKGFfdGFza19pdGVtcykgOiBhX3Rhc2tfaXRlbXM7XG5cblx0XHRcdC8vIGVhY2ggZ3JvdXBcblx0XHRcdGZvciAobGV0IGlfZ3JvdXAgPSAwOyBpX2dyb3VwIDwgbmxfdGhpbmdzOyBpX2dyb3VwKyspIHtcblx0XHRcdFx0bGV0IGhfZ3JvdXAgPSBhX3RoaW5nc1tpX2dyb3VwXTtcblx0XHRcdFx0bGV0IG5fZ3JvdXBfaXRlbXMgPSBmX3F1YW50aWZ5KGhfZ3JvdXApO1xuXG5cdFx0XHRcdC8vIGFkZGluZyB0aGlzIHRvIGN1cnJlbnQgd29ya2VyIHdvdWxkIGV4Y2VlZCB0YXJnZXQgbG9hZCAobWFrZSBzdXJlIHRoaXMgaXNuJ3QgZmluYWwgd29ya2VyKVxuXHRcdFx0XHRsZXQgbl93b3JrZXJfaXRlbXNfcHJldmlldyA9IG5fZ3JvdXBfaXRlbXMgKyBjX3dvcmtlcl9pdGVtcztcblx0XHRcdFx0aWYgKChuX3dvcmtlcl9pdGVtc19wcmV2aWV3ID4geF9pdGVtc19wZXJfd29ya2VyKSAmJiBpX3dvcmtlciA8IG5fd29ya2VycyAtIDEpIHtcblx0XHRcdFx0XHRsZXQgYl9hZHZhbmNlX2dyb3VwID0gZmFsc2U7XG5cblx0XHRcdFx0XHQvLyBiYWxhbmNlIG1vZGVcblx0XHRcdFx0XHRpZiAoWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQkFMQU5DRUQgPT09IHhtX3N0cmF0ZWd5KSB7XG5cdFx0XHRcdFx0XHQvLyBwcmV2aWV3IGlzIGNsb3NlciB0byB0YXJnZXQ7IGFkZCB0YXNrIGl0ZW0gdG8gd29ya2VyIGJlZm9yZSBhZHZhbmNpbmdcblx0XHRcdFx0XHRcdGlmICgobl93b3JrZXJfaXRlbXNfcHJldmlldyAtIHhfaXRlbXNfcGVyX3dvcmtlcikgPCAoeF9pdGVtc19wZXJfd29ya2VyIC0gY193b3JrZXJfaXRlbXMpKSB7XG5cdFx0XHRcdFx0XHRcdGFfdGFza19pdGVtcy5wdXNoKGhfZ3JvdXApO1xuXHRcdFx0XHRcdFx0XHRjX3dvcmtlcl9pdGVtcyA9IG5fd29ya2VyX2l0ZW1zX3ByZXZpZXc7XG5cblx0XHRcdFx0XHRcdFx0Ly8gYWR2YW5jZSBncm91cCBhZnRlciBuZXcgdGFza1xuXHRcdFx0XHRcdFx0XHRiX2FkdmFuY2VfZ3JvdXAgPSB0cnVlO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdC8vIGFkZCB0YXNrIGl0ZW0gdG8gb3V0cHV0ICh0cmFuc2Zvcm1pbmcgaXQgd2hlbiBhcHByb3ByaWF0ZSlcblx0XHRcdFx0XHRhX3Rhc2tzLnB1c2goZl9zZWFsID8gZl9zZWFsKHpfdGFza19kYXRhKSA6IHpfdGFza19kYXRhKTtcblxuXHRcdFx0XHRcdC8vIG5leHQgdGFzayBpdGVtIGxpc3Rcblx0XHRcdFx0XHRhX3Rhc2tfaXRlbXMgPSBbXTtcblx0XHRcdFx0XHRjX2l0ZW1zX3JlbWFpbiAtPSBjX3dvcmtlcl9pdGVtcztcblx0XHRcdFx0XHR4X2l0ZW1zX3Blcl93b3JrZXIgPSBjX2l0ZW1zX3JlbWFpbiAvIChuX3dvcmtlcnMgLSAoKytpX3dvcmtlcikpO1xuXHRcdFx0XHRcdGNfd29ya2VyX2l0ZW1zID0gMDtcblxuXHRcdFx0XHRcdC8vIHRhc2sgaXRlbSBvcGVuXG5cdFx0XHRcdFx0el90YXNrX2RhdGEgPSBmX29wZW4gPyBmX29wZW4oYV90YXNrX2l0ZW1zKSA6IGFfdGFza19pdGVtcztcblxuXHRcdFx0XHRcdC8vIGFkdmFuY2UgZ3JvdXBcblx0XHRcdFx0XHRpZiAoYl9hZHZhbmNlX2dyb3VwKSBjb250aW51ZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIGFkZCB0YXNrIHRvIGxpc3Rcblx0XHRcdFx0YV90YXNrX2l0ZW1zLnB1c2goaF9ncm91cCk7XG5cdFx0XHRcdGNfd29ya2VyX2l0ZW1zICs9IG5fZ3JvdXBfaXRlbXM7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFkZCBmaW5hbCB0YXNrIGl0ZW1cblx0XHRcdGFfdGFza3MucHVzaChmX3NlYWwgPyBmX3NlYWwoel90YXNrX2RhdGEpIDogel90YXNrX2RhdGEpO1xuXHRcdH1cblx0XHQvLyB1bmtub3duIHN0cmF0ZWd5XG5cdFx0ZWxzZSB7XG5cdFx0XHR0aHJvdyBuZXcgUmFuZ2VFcnJvcignbm8gc3VjaCBzdHJhdGVneScpO1xuXHRcdH1cblx0fVxuXHQvLyB0eXBlZCBhcnJheVxuXHRlbHNlIGlmICgnYnl0ZUxlbmd0aCcgaW4gYV90aGluZ3MpIHtcblx0XHQvLyBkaXZpZGUgXG5cdFx0dGhyb3cgJ25vdCB5ZXQgaW1wbGVtZW50ZWQnO1xuXHR9XG5cdC8vIHVuc3VwcG9ydGVkIHR5cGVcblx0ZWxzZSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKCd3b3JrZXIgY2FuIG9ubHkgZGl2aWRlIGRhdGEgaW4gYXJyYXlzIChlaXRoZXIgcGxhaW4gb3IgdHlwZWQpJyk7XG5cdH1cblxuXHRyZXR1cm4gYV90YXNrcztcbn1cblxuXG5jbGFzcyBjb252ZXJnZW50X3BhaXJ3aXNlX3RyZWUge1xuXHRjb25zdHJ1Y3RvcihuX2l0ZW1zKSB7XG5cdFx0bGV0IGFfY2Fub3B5ID0gW107XG5cdFx0Zm9yIChsZXQgaV9pdGVtID0gMDsgaV9pdGVtIDwgbl9pdGVtczsgaV9pdGVtKyspIHtcblx0XHRcdGFfY2Fub3B5LnB1c2goe1xuXHRcdFx0XHRyZWFkeTogZmFsc2UsXG5cdFx0XHRcdHVwOiBudWxsLFxuXHRcdFx0XHRpdGVtOiBudWxsLFxuXHRcdFx0XHRsZWZ0OiBpX2l0ZW0gLSAxLFxuXHRcdFx0XHRyaWdodDogaV9pdGVtICsgMSxcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0aXRlbV9jb3VudDogbl9pdGVtcyxcblx0XHRcdGNhbm9weTogYV9jYW5vcHksXG5cdFx0fSk7XG5cdH1cblxuXHRyYXkoaV9pdGVtLCB6X2l0ZW0pIHtcblx0XHRsZXQgaF9ub2RlID0gdGhpcy5jYW5vcHlbaV9pdGVtXTtcblx0XHRoX25vZGUuaXRlbSA9IHpfaXRlbTtcblx0XHRyZXR1cm4gaF9ub2RlO1xuXHR9XG5cblx0dG9wKGhfdG9wKSB7XG5cdFx0Zm9yICg7Oykge1xuXHRcdFx0bGV0IGhfdXAgPSBoX3RvcC51cDtcblx0XHRcdGlmIChoX3VwKSBoX3RvcCA9IGhfdXA7XG5cdFx0XHRlbHNlIGJyZWFrO1xuXHRcdH1cblx0XHRyZXR1cm4gaF90b3A7XG5cdH1cblxuXHRtZXJnZShoX2xlZnQsIGhfcmlnaHQpIHtcblx0XHRsZXQgbl9pdGVtcyA9IHRoaXMuaXRlbV9jb3VudDtcblxuXHRcdGxldCBoX25vZGUgPSB7XG5cdFx0XHRyZWFkeTogZmFsc2UsXG5cdFx0XHR1cDogbnVsbCxcblx0XHRcdGl0ZW06IG51bGwsXG5cdFx0XHRsZWZ0OiBoX2xlZnQubGVmdCxcblx0XHRcdHJpZ2h0OiBoX3JpZ2h0LnJpZ2h0LFxuXHRcdH07XG5cblx0XHRoX2xlZnQudXAgPSBoX3JpZ2h0LnVwID0gaF9ub2RlO1xuXG5cdFx0cmV0dXJuIHtcblx0XHRcdG5vZGU6IGhfbm9kZSxcblx0XHRcdGxlZnQ6IGhfbGVmdC5pdGVtLFxuXHRcdFx0cmlnaHQ6IGhfcmlnaHQuaXRlbSxcblx0XHRcdG1ha2VzX3Jvb3Q6IC0xID09PSBoX2xlZnQubGVmdCAmJiBuX2l0ZW1zID09PSBoX3JpZ2h0LnJpZ2h0LFxuXHRcdH07XG5cdH1cblxuXHRjb21taXQoaF9ub2RlKSB7XG5cdFx0bGV0IG5faXRlbXMgPSB0aGlzLml0ZW1fY291bnQ7XG5cdFx0bGV0IGFfY2Fub3B5ID0gdGhpcy5jYW5vcHk7XG5cblx0XHQvLyBsZWZ0IGVkZ2Ugb2YgbGlzdFxuXHRcdGlmICgtMSA9PT0gaF9ub2RlLmxlZnQpIHtcblx0XHRcdC8vIHRyZWUgcm9vdCB3YXMgaGFuZGVkIHRvIGNvbW1pdFxuXHRcdFx0aWYgKGhfbm9kZS5yaWdodCA9PT0gbl9pdGVtcykge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ2Nhbm5vdCBjb21taXQgcm9vdCEnKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gbmVpZ2hib3Igb24gcmlnaHQgc2lkZVxuXHRcdFx0bGV0IGhfcmlnaHQgPSB0aGlzLnRvcChhX2Nhbm9weVtoX25vZGUucmlnaHRdKTtcblxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgcmVhZHkhXG5cdFx0XHRpZiAoaF9yaWdodC5yZWFkeSkge1xuXHRcdFx0XHRyZXR1cm4gdGhpcy5tZXJnZShoX25vZGUsIGhfcmlnaHQpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgYnVzeS9ub3QgcmVhZHk7IG1hcmsgdGhpcyBpdGVtIGFzIHJlYWR5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0aF9ub2RlLnJlYWR5ID0gdHJ1ZTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gcmlnaHQgZWRnZSBvZiBsaXN0XG5cdFx0ZWxzZSBpZiAobl9pdGVtcyA9PT0gaF9ub2RlLnJpZ2h0KSB7XG5cdFx0XHQvLyBuZWlnaGJvciBvbiBsZWZ0IHNpZGVcblx0XHRcdGxldCBoX2xlZnQgPSB0aGlzLnRvcChhX2Nhbm9weVtoX25vZGUubGVmdF0pO1xuXG5cdFx0XHQvLyBuZWlnaGJvciBpcyByZWFkeVxuXHRcdFx0aWYgKGhfbGVmdC5yZWFkeSkge1xuXHRcdFx0XHRyZXR1cm4gdGhpcy5tZXJnZShoX2xlZnQsIGhfbm9kZSk7XG5cdFx0XHR9XG5cdFx0XHQvLyBuZWlnaGJvciBpcyBidXN5L25vdCByZWFkeTsgbWFyayB0aGlzIGl0ZW0gYXMgcmVhZHlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHRoX25vZGUucmVhZHkgPSB0cnVlO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBzb21ld2hlcmUgaW4gdGhlIG1pZGRsZVxuXHRcdGVsc2Uge1xuXHRcdFx0Ly8gc3RhcnQgd2l0aCBsZWZ0IG5laWdoYm9yXG5cdFx0XHRsZXQgaF9sZWZ0ID0gdGhpcy50b3AoYV9jYW5vcHlbaF9ub2RlLmxlZnRdKTtcblxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgcmVhZHlcblx0XHRcdGlmIChoX2xlZnQucmVhZHkpIHtcblx0XHRcdFx0cmV0dXJuIHRoaXMubWVyZ2UoaF9sZWZ0LCBoX25vZGUpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgYnVzeS9ub3QgcmVhZHlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyB0cnkgcmlnaHQgbmVpZ2hib3Jcblx0XHRcdFx0bGV0IGhfcmlnaHQgPSB0aGlzLnRvcChhX2Nhbm9weVtoX25vZGUucmlnaHRdKTtcblxuXHRcdFx0XHQvLyBuZWlnaGJvciBpcyByZWFkeVxuXHRcdFx0XHRpZiAoaF9yaWdodC5yZWFkeSkge1xuXHRcdFx0XHRcdHJldHVybiB0aGlzLm1lcmdlKGhfbm9kZSwgaF9yaWdodCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gbmVpZ2hib3IgaXMgYnVzeS9ub3QgcmVhZHk7IG1hcmsgdGhpcyBpdGVtIGFzIHJlYWR5XG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdGhfbm9kZS5yZWFkeSA9IHRydWU7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHRyZXR1cm4gbnVsbDtcblx0fVxufVxuXG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oZGNfd29ya2VyKSB7XG5cdHdvcmtlciA9IGRjX3dvcmtlcjtcblx0cmV0dXJuIGdyb3VwO1xufTsiLCIvLyBkZWR1Y2UgdGhlIHJ1bnRpbWUgZW52aXJvbm1lbnRcbmNvbnN0IFtCX0JST1dTRVIsIEJfQlJPV1NFUklGWV0gPSAoKCkgPT4gJ3VuZGVmaW5lZCcgPT09IHR5cGVvZiBwcm9jZXNzID9cblx0W3RydWUsIGZhbHNlXSA6XG5cdChwcm9jZXNzLmJyb3dzZXIgP1xuXHRcdFt0cnVlLCB0cnVlXSA6XG5cdFx0KCd1bmRlZmluZWQnID09PSBwcm9jZXNzLnZlcnNpb25zIHx8ICd1bmRlZmluZWQnID09PSBwcm9jZXNzLnZlcnNpb25zLm5vZGUgP1xuXHRcdFx0W3RydWUsIGZhbHNlXSA6XG5cdFx0XHRbZmFsc2UsIGZhbHNlXSkpKSgpO1xuXG5cbmNvbnN0IGxvY2FscyA9IE9iamVjdC5hc3NpZ24oe1xuXHRCX0JST1dTRVIsXG5cdEJfQlJPV1NFUklGWSxcblxuXHRIUF9XT1JLRVJfTk9USUZJQ0FUSU9OOiBTeW1ib2woJ3dvcmtlciBub3RpZmljYXRpb24nKSxcbn0sIEJfQlJPV1NFUiA/IHJlcXVpcmUoJy4uL2Jyb3dzZXIvbG9jYWxzLmpzJykgOiByZXF1aXJlKCcuLi9ub2RlL2xvY2Fscy5qcycpKTtcblxuXG5sb2NhbHMud2Vid29ya2VyaWZ5ID0gZnVuY3Rpb24oel9pbXBvcnQsIGhfY29uZmlnID0ge30pIHtcblx0Y29uc3QgW0ZfRlVOQ1RJT05fQlVORExFLCBIX1NPVVJDRVMsIEhfQ0FDSEVdID0gaF9jb25maWcuYnJvd3NlcmlmeTtcblx0bGV0IHNfd29ya2VyX2tleSA9ICcnO1xuXHRmb3IgKGxldCBzX2NhY2hlX2tleSBpbiBIX0NBQ0hFKSB7XG5cdFx0bGV0IHpfZXhwb3J0cyA9IEhfQ0FDSEVbc19jYWNoZV9rZXldLmV4cG9ydHM7XG5cdFx0aWYgKHpfaW1wb3J0ID09PSB6X2V4cG9ydHMgfHwgel9pbXBvcnQgPT09IHpfZXhwb3J0cy5kZWZhdWx0KSB7XG5cdFx0XHRzX3dvcmtlcl9rZXkgPSBzX2NhY2hlX2tleTtcblx0XHRcdGJyZWFrO1xuXHRcdH1cblx0fVxuXG5cdGlmICghc193b3JrZXJfa2V5KSB7XG5cdFx0c193b3JrZXJfa2V5ID0gTWF0aC5mbG9vcihNYXRoLnBvdygxNiwgOCkgKiBNYXRoLnJhbmRvbSgpKS50b1N0cmluZygxNik7XG5cdFx0bGV0IGhfY2FjaGVfd29ya2VyID0ge307XG5cdFx0Zm9yIChsZXQgc19rZXlfY2FjaGUgaW4gSF9TT1VSQ0VTKSB7XG5cdFx0XHRoX2NhY2hlX3dvcmtlcltzX2tleV9jYWNoZV0gPSBzX2tleV9jYWNoZTtcblx0XHR9XG5cdFx0SF9TT1VSQ0VTW3Nfd29ya2VyX2tleV0gPSBbXG5cdFx0XHRuZXcgRnVuY3Rpb24oWydyZXF1aXJlJywgJ21vZHVsZScsICdleHBvcnRzJ10sIGAoJHt6X2ltcG9ydH0pKHNlbGYpO2ApLFxuXHRcdFx0aF9jYWNoZV93b3JrZXIsXG5cdFx0XTtcblx0fVxuXG5cdGxldCBzX3NvdXJjZV9rZXkgPSBNYXRoLmZsb29yKE1hdGgucG93KDE2LCA4KSAqIE1hdGgucmFuZG9tKCkpLnRvU3RyaW5nKDE2KTtcblx0SF9TT1VSQ0VTW3Nfc291cmNlX2tleV0gPSBbXG5cdFx0bmV3IEZ1bmN0aW9uKFsncmVxdWlyZSddLCBgXG5cdFx0XHRsZXQgZiA9IHJlcXVpcmUoJHtKU09OLnN0cmluZ2lmeShzX3dvcmtlcl9rZXkpfSk7XG5cdFx0XHQvLyBkZWJ1Z2dlcjtcblx0XHRcdC8vIChmLmRlZmF1bHQ/IGYuZGVmYXVsdDogZikoc2VsZik7XG5cdFx0YCksXG5cdFx0e1xuXHRcdFx0W3Nfd29ya2VyX2tleV06IHNfd29ya2VyX2tleVxuXHRcdH0sXG5cdF07XG5cblx0bGV0IGhfd29ya2VyX3NvdXJjZXMgPSB7fTtcblxuXHRmdW5jdGlvbiByZXNvbHZlX3NvdXJjZXMoc19rZXkpIHtcblx0XHRoX3dvcmtlcl9zb3VyY2VzW3Nfa2V5XSA9IHRydWU7XG5cdFx0bGV0IGhfc291cmNlID0gSF9TT1VSQ0VTW3Nfa2V5XVsxXTtcblx0XHRmb3IgKGxldCBwX2RlcGVuZGVuY3kgaW4gaF9zb3VyY2UpIHtcblx0XHRcdGxldCBzX2RlcGVuZGVuY3lfa2V5ID0gaF9zb3VyY2VbcF9kZXBlbmRlbmN5XTtcblx0XHRcdGlmICghaF93b3JrZXJfc291cmNlc1tzX2RlcGVuZGVuY3lfa2V5XSkge1xuXHRcdFx0XHRyZXNvbHZlX3NvdXJjZXMoc19kZXBlbmRlbmN5X2tleSk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cdHJlc29sdmVfc291cmNlcyhzX3NvdXJjZV9rZXkpO1xuXG5cdGxldCBzX3NvdXJjZSA9IGAoJHtGX0ZVTkNUSU9OX0JVTkRMRX0pKHtcblx0XHQke09iamVjdC5rZXlzKGhfd29ya2VyX3NvdXJjZXMpLm1hcCgoc19rZXkpID0+IHtcblx0XHRcdGxldCBhX3NvdXJjZSA9IEhfU09VUkNFU1tzX2tleV07XG5cdFx0XHRyZXR1cm4gSlNPTi5zdHJpbmdpZnkoc19rZXkpXG5cdFx0XHRcdCtgOlske2Ffc291cmNlWzBdfSwke0pTT04uc3RyaW5naWZ5KGFfc291cmNlWzFdKX1dYDtcblx0XHR9KX1cblx0fSwge30sIFske0pTT04uc3RyaW5naWZ5KHNfc291cmNlX2tleSl9XSlgO1xuXG5cdGxldCBkX2Jsb2IgPSBuZXcgQmxvYihbc19zb3VyY2VdLCB7XG5cdFx0dHlwZTogJ3RleHQvamF2YXNjcmlwdCdcblx0fSk7XG5cdGlmIChoX2NvbmZpZy5iYXJlKSB7XG5cdFx0cmV0dXJuIGRfYmxvYjtcblx0fVxuXHRsZXQgcF93b3JrZXJfdXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChkX2Jsb2IpO1xuXHRsZXQgZF93b3JrZXIgPSBuZXcgbG9jYWxzLkRDX1dPUktFUihwX3dvcmtlcl91cmwsIGhfY29uZmlnLndvcmtlcl9vcHRpb25zKTtcblx0Ly8gZF93b3JrZXIub2JqZWN0VVJMID0gcF93b3JrZXJfdXJsO1xuXHQvLyBkX3dvcmtlci5zb3VyY2UgPSBkX2Jsb2I7XG5cdGRfd29ya2VyLnNvdXJjZSA9IHNfc291cmNlO1xuXHRyZXR1cm4gZF93b3JrZXI7XG59O1xuXG5cbm1vZHVsZS5leHBvcnRzID0gbG9jYWxzOyIsImNvbnN0IHtcblx0c2hhcmluZyxcbn0gPSByZXF1aXJlKCcuL2xvY2Fscy5qcycpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGNsYXNzIG1hbmlmZXN0IHtcblx0c3RhdGljIGZyb20oel9vdGhlcikge1xuXHRcdC8vIG1hbmlmZXN0XG5cdFx0aWYgKHpfb3RoZXIgaW5zdGFuY2VvZiBtYW5pZmVzdCkge1xuXHRcdFx0cmV0dXJuIHpfb3RoZXI7XG5cdFx0fVxuXHRcdC8vIGFueVxuXHRcdGVsc2Uge1xuXHRcdFx0cmV0dXJuIG5ldyBtYW5pZmVzdCh6X290aGVyLCBbXSk7XG5cdFx0fVxuXHR9XG5cblx0Y29uc3RydWN0b3IoYV9kYXRhID0gW10sIHpfdHJhbnNmZXJfcGF0aHMgPSB0cnVlKSB7XG5cdFx0Ly8gbm90IGFuIGFycmF5XG5cdFx0aWYgKCFBcnJheS5pc0FycmF5KGFfZGF0YSkpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcignYSBtYW5pZmVzdCByZXByZXNlbnRzIGFuIGFycmF5IG9mIGFyZ3VtZW50czsgcGFzcyB0aGUgY29uc3RydWN0b3IgYW4gYXJyYXknKTtcblx0XHR9XG5cblx0XHQvLyBub3QgYSBsaXN0OyBmaW5kIHRyYW5zZmVycyBtYW51YWxseVxuXHRcdGxldCBhX3RyYW5zZmVyX3BhdGhzID0gel90cmFuc2Zlcl9wYXRocztcblx0XHRpZiAoIUFycmF5LmlzQXJyYXkoYV90cmFuc2Zlcl9wYXRocykpIHtcblx0XHRcdGFfdHJhbnNmZXJfcGF0aHMgPSB0aGlzLmV4dHJhY3QoYV9kYXRhKTtcblx0XHR9XG5cdFx0Ly8gb25seSBjaGVjayB0b3AgbGV2ZWxcblx0XHRlbHNlIHtcblx0XHRcdGxldCBhX3RyYW5zZmVycyA9IFtdO1xuXHRcdFx0Zm9yIChsZXQgaV9kYXR1bSA9IDAsIG5sX2RhdGEgPSBhX2RhdGEubGVuZ3RoOyBpX2RhdHVtIDwgbmxfZGF0YTsgaV9kYXR1bSsrKSB7XG5cdFx0XHRcdGxldCB6X2RhdHVtID0gYV9kYXRhW2lfZGF0dW1dO1xuXG5cdFx0XHRcdC8vIHNoYXJlYWJsZSBpdGVtXG5cdFx0XHRcdGlmIChzaGFyaW5nKHpfZGF0dW0pKSBhX3RyYW5zZmVycy5wdXNoKFtpX2RhdHVtXSk7XG5cdFx0XHR9XG5cblx0XHRcdC8vIHNvbGlkaWZ5IHRyYW5zZmVyc1xuXHRcdFx0aWYgKGFfdHJhbnNmZXJzLmxlbmd0aCkge1xuXHRcdFx0XHRhX3RyYW5zZmVyX3BhdGhzID0gYV90cmFuc2ZlcnM7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRkYXRhOiBhX2RhdGEsXG5cdFx0XHR0cmFuc2Zlcl9wYXRoczogYV90cmFuc2Zlcl9wYXRocyxcblx0XHR9KTtcblx0fVxuXG5cdGV4dHJhY3Qoel9kYXRhLCBhX3BhdGggPSBbXSwgemlfcGF0aF9sYXN0ID0gbnVsbCkge1xuXHRcdC8vIHByb3RlY3QgYWdhaW5zdCBbb2JqZWN0XSBudWxsXG5cdFx0aWYgKCF6X2RhdGEpIHJldHVybiBbXTtcblxuXHRcdC8vIHNldCBvZiBwYXRoc1xuXHRcdGxldCBhX3BhdGhzID0gW107XG5cblx0XHQvLyBvYmplY3Rcblx0XHRpZiAoJ29iamVjdCcgPT09IHR5cGVvZiB6X2RhdGEpIHtcblx0XHRcdC8vIGNvcHkgcGF0aFxuXHRcdFx0YV9wYXRoID0gYV9wYXRoLnNsaWNlKCk7XG5cblx0XHRcdC8vIGNvbW1pdCB0byBpdFxuXHRcdFx0aWYgKG51bGwgIT09IHppX3BhdGhfbGFzdCkgYV9wYXRoLnB1c2goemlfcGF0aF9sYXN0KTtcblxuXHRcdFx0Ly8gcGxhaW4gb2JqZWN0IGxpdGVyYWxcblx0XHRcdGlmIChPYmplY3QgPT09IHpfZGF0YS5jb25zdHJ1Y3Rvcikge1xuXHRcdFx0XHQvLyBzY2FuIG92ZXIgZW51bWVyYWJsZSBwcm9wZXJ0aWVzXG5cdFx0XHRcdGZvciAobGV0IHNfcHJvcGVydHkgaW4gel9kYXRhKSB7XG5cdFx0XHRcdFx0Ly8gZXh0cmFjdCBkYXRhIGFuZCB0cmFuc2ZlcnMgYnkgcmVjdXJzaW5nIG9uIHByb3BlcnR5XG5cdFx0XHRcdFx0YV9wYXRocy5wdXNoKC4uLnRoaXMuZXh0cmFjdCh6X2RhdGFbc19wcm9wZXJ0eV0sIGFfcGF0aCwgc19wcm9wZXJ0eSkpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHQvLyBhcnJheVxuXHRcdFx0ZWxzZSBpZiAoQXJyYXkuaXNBcnJheSh6X2RhdGEpKSB7XG5cdFx0XHRcdC8vIGVtcHR5IGFycmF5XG5cdFx0XHRcdGlmICghel9kYXRhLmxlbmd0aCkgcmV0dXJuIFtdO1xuXG5cdFx0XHRcdC8vIHNjYW4gb3ZlciBlYWNoIGl0ZW1cblx0XHRcdFx0el9kYXRhLmZvckVhY2goKHpfaXRlbSwgaV9pdGVtKSA9PiB7XG5cdFx0XHRcdFx0Ly8gZXh0cmFjdCBkYXRhIGFuZCB0cmFuc2ZlcnMgYnkgcmVjdXJzaW5nIG9uIGl0ZW1cblx0XHRcdFx0XHRhX3BhdGhzLnB1c2goLi4udGhpcy5leHRyYWN0KHpfaXRlbSwgYV9wYXRoLCBpX2l0ZW0pKTtcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0XHQvLyBzaGFyZWFibGUgZGF0YVxuXHRcdFx0ZWxzZSBpZiAoc2hhcmluZyh6X2RhdGEpKSB7XG5cdFx0XHRcdHJldHVybiBbYV9wYXRoXTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyByZXR1cm4gcGF0aHNcblx0XHRyZXR1cm4gYV9wYXRocztcblx0fVxuXG5cdHByZXBlbmQoel9hcmcpIHtcblx0XHQvLyBjb3B5IGl0ZW1zXG5cdFx0bGV0IGFfaXRlbXMgPSB0aGlzLmRhdGEuc2xpY2UoKTtcblxuXHRcdC8vIGNvcHkgdHJhbnNmZXIgcGF0aHNcblx0XHRsZXQgYV90cmFuc2Zlcl9wYXRocyA9IHRoaXMudHJhbnNmZXJfcGF0aHMuc2xpY2UoKTtcblxuXHRcdC8vIHB1c2ggYSBtYW5pZmVzdCB0byBmcm9udFxuXHRcdGlmICh6X2FyZyBpbnN0YW5jZW9mIG1hbmlmZXN0KSB7XG5cdFx0XHQvLyBhZGQgaXRzIGNvbnRlbnRzIGFzIGEgc2luZ2xlIGl0ZW1cblx0XHRcdGFfaXRlbXMudW5zaGlmdCh6X2FyZy5kYXRhKTtcblxuXHRcdFx0Ly8gaG93IG1hbnkgcGF0aHMgdG8gb2Zmc2V0IGltcG9ydCBieVxuXHRcdFx0bGV0IG5sX3BhdGhzID0gYV90cmFuc2Zlcl9wYXRocy5sZW5ndGg7XG5cblx0XHRcdC8vIHVwZGF0ZSBpbXBvcnQgcGF0aHMgKHByaW1hcnkgaW5kZXggbmVlZHMgdXBkYXRlKVxuXHRcdFx0bGV0IGFfaW1wb3J0X3BhdGhzID0gel9hcmcudHJhbnNmZXJfcGF0aHM7XG5cdFx0XHRhX2ltcG9ydF9wYXRocy5mb3JFYWNoKChhX3BhdGgpID0+IHtcblx0XHRcdFx0YV9wYXRoWzBdICs9IG5sX3BhdGhzO1xuXHRcdFx0fSk7XG5cblx0XHRcdC8vIGFwcGVuZCBpdHMgdHJhbnNmZXIgcGF0aHNcblx0XHRcdGFfdHJhbnNmZXJfcGF0aHMucHVzaChhX2ltcG9ydF9wYXRocyk7XG5cdFx0fVxuXHRcdC8vIGFueXRoaW5nIGVsc2Vcblx0XHRlbHNlIHtcblx0XHRcdC8vIGp1c3QgYWRkIHRvIGZyb250XG5cdFx0XHRhX2l0ZW1zLnVuc2hpZnQoel9hcmcpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBuZXcgbWFuaWZlc3Rcblx0XHRyZXR1cm4gbmV3IG1hbmlmZXN0KGFfaXRlbXMsIGFfdHJhbnNmZXJfcGF0aHMpO1xuXHR9XG5cblx0cGF0aHMoLi4uYV91bnNoaWZ0KSB7XG5cdFx0cmV0dXJuIHRoaXMudHJhbnNmZXJfcGF0aHMubWFwKChhX3BhdGgpID0+IHtcblx0XHRcdHJldHVybiBbLi4uYV91bnNoaWZ0LCAuLi5hX3BhdGhdO1xuXHRcdH0pO1xuXHR9XG59OyIsImNvbnN0IHtcblx0Tl9DT1JFUyxcbn0gPSByZXF1aXJlKCcuL2xvY2Fscy5qcycpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGNsYXNzIHBvb2wge1xuXHRjb25zdHJ1Y3RvcihwX3NvdXJjZSwgbl93b3JrZXJzID0gTl9DT1JFUywgaF93b3JrZXJfb3B0aW9ucyA9IHt9KSB7XG5cdFx0Ly8gbm8gd29ya2VyIGNvdW50IGdpdmVuOyBkZWZhdWx0IHRvIG51bWJlciBvZiBjb3Jlc1xuXHRcdGlmICghbl93b3JrZXJzKSBuX3dvcmtlcnMgPSBOX0NPUkVTO1xuXG5cdFx0Ly8gZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdFx0bGltaXQ6IG5fd29ya2Vycyxcblx0XHRcdHdvcmtlcnM6IFtdLFxuXHRcdFx0aGlzdG9yeTogW10sXG5cdFx0XHR3YWl0X2xpc3Q6IFtdLFxuXHRcdH0pO1xuXHR9XG5cblx0cnVuKHNfdGFzaywgYV9hcmdzLCBoX2V2ZW50cykge1xuXHRcdHRoaXMuaGlzdG9yeS5wdXNoKG5ldyBQcm9taXNlKGFzeW5jIChmX3Jlc29sdmUsIGZfcmVqZWN0KSA9PiB7XG5cdFx0XHQvLyBzdW1tb24gYSB3b3JrZXJcblx0XHRcdGxldCBrX3dvcmtlciA9IGF3YWl0IHRoaXMuc3VtbW9uKCk7XG5cblx0XHRcdC8vIHJ1biB0aGlzIHRhc2tcblx0XHRcdGxldCB6X3Jlc3VsdDtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdHpfcmVzdWx0ID0gYXdhaXQga193b3JrZXIucnVuKHNfdGFzaywgYV9hcmdzLCBoX2V2ZW50cyk7XG5cdFx0XHR9XG5cdFx0XHQvLyBlcnJvciB3aGlsZSBydW5uaW5nIHRhc2tcblx0XHRcdGNhdGNoIChlX3J1bikge1xuXHRcdFx0XHRyZXR1cm4gZl9yZWplY3QoZV9ydW4pO1xuXHRcdFx0fVxuXHRcdFx0Ly8gd29ya2VyIGlzIGF2YWlsYWJsZSBub3dcblx0XHRcdGZpbmFsbHkge1xuXHRcdFx0XHRsZXQgYV93YWl0X2xpc3QgPSB0aGlzLndhaXRfbGlzdDtcblxuXHRcdFx0XHQvLyBhdCBsZWFzdCBvbmUgdGFzayBpcyBxdWV1ZWRcblx0XHRcdFx0aWYgKGFfd2FpdF9saXN0Lmxlbmd0aCkge1xuXHRcdFx0XHRcdGFfd2FpdF9saXN0LnNoaWZ0KCkoa193b3JrZXIpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIHJlc29sdmUgcHJvbWlzZVxuXHRcdFx0Zl9yZXNvbHZlKHpfcmVzdWx0KTtcblx0XHR9KSk7XG5cdH1cblxuXHRhc3luYyBraWxsKHNfc2lnbmFsKSB7XG5cdFx0cmV0dXJuIGF3YWl0IFByb21pc2UuYWxsKHRoaXMud29ya2Vycy5tYXAoKGtfd29ya2VyKSA9PiBrX3dvcmtlci5raWxsKHNfc2lnbmFsKSkpO1xuXHR9XG5cblx0c3RhcnQoKSB7XG5cdFx0dGhpcy5oaXN0b3J5Lmxlbmd0aCA9IDA7XG5cdH1cblxuXHRhc3luYyBzdG9wKCkge1xuXHRcdC8vIGNhY2hlIGhpc3Rvcnlcblx0XHRsZXQgYV9oaXN0b3J5ID0gdGhpcy5oaXN0b3J5O1xuXG5cdFx0Ly8gcmVzZXQgc3RhcnQgcG9pbnRcblx0XHR0aGlzLnN0YXJ0KCk7XG5cblx0XHQvLyBhd2FpdCBhbGwgcHJvbWlzZXMgdG8gZmluaXNoXG5cdFx0cmV0dXJuIGF3YWl0IFByb21pc2UuYWxsKGFfaGlzdG9yeSk7XG5cdH1cblxuXHRhc3luYyBzdW1tb24oKSB7XG5cdFx0bGV0IGFfd29ya2VycyA9IHRoaXMud29ya2VycztcblxuXHRcdC8vIGVhY2ggd29ya2VyXG5cdFx0Zm9yIChsZXQgaV93b3JrZXIgPSAwLCBubF93b3JrZXJzID0gYV93b3JrZXJzLmxlbmd0aDsgaV93b3JrZXIgPCBubF93b3JrZXJzOyBpX3dvcmtlcisrKSB7XG5cdFx0XHRsZXQga193b3JrZXIgPSBhX3dvcmtlcnNbaV93b3JrZXJdO1xuXG5cdFx0XHQvLyB3b3JrZXIgbm90IGJ1c3lcblx0XHRcdGlmICgha193b3JrZXIuYnVzeSkge1xuXHRcdFx0XHRyZXR1cm4ga193b3JrZXI7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gcm9vbSB0byBncm93XG5cdFx0aWYgKGFfd29ya2Vycy5sZW5ndGggPCB0aGlzLmxpbWl0KSB7XG5cdFx0XHQvLyBjcmVhdGUgbmV3IHdvcmtlclxuXHRcdFx0bGV0IGtfd29ya2VyID0gbmV3IHdvcmtlcih7XG5cdFx0XHRcdHNvdXJjZTogcF9zb3VyY2UsXG5cdFx0XHRcdGlkOiBhX3dvcmtlcnMubGVuZ3RoLFxuXHRcdFx0XHRtYXN0ZXI6IHRoaXMsXG5cdFx0XHRcdG9wdGlvbnM6IGhfd29ya2VyX29wdGlvbnMsXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gYWRkIHRvIHBvb2xcblx0XHRcdGFfd29ya2Vycy5wdXNoKGtfd29ya2VyKTtcblxuXHRcdFx0Ly8gaXQncyBhdmFpbGFibGUgbm93XG5cdFx0XHRyZXR1cm4ga193b3JrZXI7XG5cdFx0fVxuXG5cdFx0Ly8gcXVldWUgZm9yIG5vdGlmaWNhdGlvbiB3aGVuIHdvcmtlcnMgYmVjb21lIGF2YWlsYWJsZVxuXHRcdHRoaXMud2FpdF9saXN0LnB1c2goKGtfd29ya2VyKSA9PiB7XG5cdFx0XHRma193b3JrZXIoa193b3JrZXIsIGNfc3VtbW9uZWQrKyk7XG5cdFx0fSk7XG5cdH1cbn07IiwiY29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKCcuL21hbmlmZXN0LmpzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gY2xhc3MgcmVzdWx0IGV4dGVuZHMgbWFuaWZlc3Qge1xuXHRzdGF0aWMgZnJvbSh6X2l0ZW0pIHtcblx0XHRpZiAoel9pdGVtIGluc3RhbmNlb2YgcmVzdWx0KSB7XG5cdFx0XHRyZXR1cm4gel9pdGVtO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRyZXR1cm4gbmV3IHJlc3VsdCh6X2l0ZW0pO1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0cnVjdG9yKHpfcmVzdWx0LCB6X3RyYW5zZmVyX3BhdGhzID0gdHJ1ZSkge1xuXHRcdHN1cGVyKFt6X3Jlc3VsdF0sIHpfdHJhbnNmZXJfcGF0aHMpO1xuXHR9XG5cblx0cHJlcGVuZCgpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ2Nhbm5vdCBwcmVwZW5kIGEgcmVzdWx0Jyk7XG5cdH1cbn07IiwiY29uc3QgZXZlbnRzID0gcmVxdWlyZSgnLi9ldmVudHMuanMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBjbGFzcyBjaGFubmVsIGV4dGVuZHMgTWVzc2FnZUNoYW5uZWwge1xuXHRwb3J0XzEoZmtfcG9ydCkge1xuXHRcdGZrX3BvcnQoZXZlbnRzKHRoaXMucG9ydDEpKTtcblx0fVxuXG5cdHBvcnRfMihma19wb3J0KSB7XG5cdFx0ZmtfcG9ydChldmVudHModGhpcy5wb3J0MikpO1xuXHR9XG59OyIsIm1vZHVsZS5leHBvcnRzID0gKGR6X3RoaW5nKSA9PiB7XG5cdE9iamVjdC5hc3NpZ24oZHpfdGhpbmcsIHtcblx0XHRldmVudHMoaF9ldmVudHMpIHtcblx0XHRcdGZvciAobGV0IHNfZXZlbnQgaW4gaF9ldmVudHMpIHtcblx0XHRcdFx0dGhpc1snb24nICsgc19ldmVudF0gPSBoX2V2ZW50c1tzX2V2ZW50XTtcblx0XHRcdH1cblx0XHR9LFxuXG5cdFx0ZXZlbnQoc19ldmVudCwgZl9ldmVudCkge1xuXHRcdFx0dGhpc1snb24nICsgc19ldmVudF0gPSBmX2V2ZW50O1xuXHRcdH0sXG5cdH0pO1xuXG5cdHJldHVybiBkel90aGluZztcbn07IiwibW9kdWxlLmV4cG9ydHMgPSB7XG5cdEtfU0VMRjogcmVxdWlyZSgnLi9zZWxmLmpzJyksXG5cdERDX1dPUktFUjogJ3VuZGVmaW5lZCcgPT09IHR5cGVvZiBXb3JrZXIgPyB1bmRlZmluZWQgOiByZXF1aXJlKCcuL3dvcmtlci5qcycpLFxuXHREQ19DSEFOTkVMOiByZXF1aXJlKCcuL2NoYW5uZWwuanMnKSxcblx0SF9UWVBFRF9BUlJBWVM6IHJlcXVpcmUoJy4vdHlwZWQtYXJyYXlzLmpzJyksXG5cdE5fQ09SRVM6IG5hdmlnYXRvci5oYXJkd2FyZUNvbmN1cnJlbmN5IHx8IDEsXG5cdHNoYXJpbmc6IHJlcXVpcmUoJy4vc2hhcmluZy5qcycpLFxuXHRzdHJlYW06IHJlcXVpcmUoJy4vc3RyZWFtLmpzJyksXG5cdHBvcnRzOiByZXF1aXJlKCcuL3BvcnRzLmpzJyksXG59OyIsImNvbnN0IGV2ZW50cyA9IHJlcXVpcmUoJy4vZXZlbnRzLmpzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gKGRfcG9ydCkgPT4gZXZlbnRzKGRfcG9ydCk7IiwiIiwiY29uc3QgJF9TSEFSRUFCTEUgPSBTeW1ib2woJ3NoYXJlYWJsZScpO1xuXG5mdW5jdGlvbiBleHRyYWN0KHpfZGF0YSwgYXNfdHJhbnNmZXJzID0gbnVsbCkge1xuXHQvLyBwcm90ZWN0IGFnYWluc3QgW29iamVjdF0gbnVsbFxuXHRpZiAoIXpfZGF0YSkgcmV0dXJuIFtdO1xuXG5cdC8vIHNldCBvZiB0cmFuc2ZlciBvYmplY3RzXG5cdGlmICghYXNfdHJhbnNmZXJzKSBhc190cmFuc2ZlcnMgPSBuZXcgU2V0KCk7XG5cblx0Ly8gb2JqZWN0XG5cdGlmICgnb2JqZWN0JyA9PT0gdHlwZW9mIHpfZGF0YSkge1xuXHRcdC8vIHBsYWluIG9iamVjdCBsaXRlcmFsXG5cdFx0aWYgKE9iamVjdCA9PT0gel9kYXRhLmNvbnN0cnVjdG9yKSB7XG5cdFx0XHQvLyBzY2FuIG92ZXIgZW51bWVyYWJsZSBwcm9wZXJ0aWVzXG5cdFx0XHRmb3IgKGxldCBzX3Byb3BlcnR5IGluIHpfZGF0YSkge1xuXHRcdFx0XHQvLyBhZGQgZWFjaCB0cmFuc2ZlcmFibGUgZnJvbSByZWN1cnNpb24gdG8gb3duIHNldFxuXHRcdFx0XHRleHRyYWN0KHpfZGF0YVtzX3Byb3BlcnR5XSwgYXNfdHJhbnNmZXJzKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXlcblx0XHRlbHNlIGlmIChBcnJheS5pc0FycmF5KHpfZGF0YSkpIHtcblx0XHRcdC8vIHNjYW4gb3ZlciBlYWNoIGl0ZW1cblx0XHRcdHpfZGF0YS5mb3JFYWNoKCh6X2l0ZW0pID0+IHtcblx0XHRcdFx0Ly8gYWRkIGVhY2ggdHJhbnNmZXJhYmxlIGZyb20gcmVjdXJzaW9uIHRvIG93biBzZXRcblx0XHRcdFx0ZXh0cmFjdCh6X2l0ZW0sIGFzX3RyYW5zZmVycyk7XG5cdFx0XHR9KTtcblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXksIGRhdGEgdmlldyBvciBhcnJheSBidWZmZXJcblx0XHRlbHNlIGlmIChBcnJheUJ1ZmZlci5pc1ZpZXcoel9kYXRhKSkge1xuXHRcdFx0YXNfdHJhbnNmZXJzLmFkZCh6X2RhdGEuYnVmZmVyKTtcblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyXG5cdFx0ZWxzZSBpZiAoel9kYXRhIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHtcblx0XHRcdGFzX3RyYW5zZmVycy5hZGQoel9kYXRhKTtcblx0XHR9XG5cdFx0Ly8gbWVzc2FnZSBwb3J0XG5cdFx0ZWxzZSBpZiAoel9kYXRhIGluc3RhbmNlb2YgTWVzc2FnZVBvcnQpIHtcblx0XHRcdGFzX3RyYW5zZmVycy5hZGQoel9kYXRhKTtcblx0XHR9XG5cdFx0Ly8gaW1hZ2UgYml0bWFwXG5cdFx0ZWxzZSBpZiAoel9kYXRhIGluc3RhbmNlb2YgSW1hZ2VCaXRtYXApIHtcblx0XHRcdGFzX3RyYW5zZmVycy5hZGQoel9kYXRhKTtcblx0XHR9XG5cdH1cblx0Ly8gZnVuY3Rpb25cblx0ZWxzZSBpZiAoJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIHpfZGF0YSkge1xuXHRcdC8vIHNjYW4gb3ZlciBlbnVtZXJhYmxlIHByb3BlcnRpZXNcblx0XHRmb3IgKGxldCBzX3Byb3BlcnR5IGluIHpfZGF0YSkge1xuXHRcdFx0Ly8gYWRkIGVhY2ggdHJhbnNmZXJhYmxlIGZyb20gcmVjdXJzaW9uIHRvIG93biBzZXRcblx0XHRcdGV4dHJhY3Qoel9kYXRhW3NfcHJvcGVydHldLCBhc190cmFuc2ZlcnMpO1xuXHRcdH1cblx0fVxuXHQvLyBub3RoaW5nXG5cdGVsc2Uge1xuXHRcdHJldHVybiBbXTtcblx0fVxuXG5cdC8vIGNvbnZlcnQgc2V0IHRvIGFycmF5XG5cdHJldHVybiBBcnJheS5mcm9tKGFzX3RyYW5zZmVycyk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gT2JqZWN0LmFzc2lnbihmdW5jdGlvbih6X29iamVjdCkge1xuXHRyZXR1cm4gQXJyYXlCdWZmZXIuaXNWaWV3KHpfb2JqZWN0KSB8fFxuXHRcdHpfb2JqZWN0IGluc3RhbmNlb2YgQXJyYXlCdWZmZXIgfHxcblx0XHR6X29iamVjdCBpbnN0YW5jZW9mIE1lc3NhZ2VQb3J0IHx8XG5cdFx0el9vYmplY3QgaW5zdGFuY2VvZiBJbWFnZUJpdG1hcDtcbn0sIHtcblx0JF9TSEFSRUFCTEUsXG5cblx0ZXh0cmFjdCxcbn0pOyIsImNvbnN0IGV2ZW50cyA9IHJlcXVpcmUoJ2V2ZW50cycpO1xuXG5jbGFzcyByZWFkYWJsZV9zdHJlYW0gZXh0ZW5kcyBldmVudHMuRXZlbnRFbWl0dGVyIHtcblx0Y29uc3RydWN0b3IoKSB7XG5cdFx0c3VwZXIoKTtcblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0ZGVjb2RlcjogbnVsbCxcblx0XHRcdHBhdXNlZDogZmFsc2UsXG5cdFx0XHRjb25zdW1lZDogMCxcblx0XHR9KTtcblx0fVxuXG5cdHNldEVuY29kaW5nKHNfZW5jb2RpbmcpIHtcblx0XHR0aGlzLmRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoc19lbmNvZGluZyk7XG5cdH1cblxuXHRwYXVzZSgpIHtcblx0XHR0aGlzLnBhdXNlZCA9IHRydWU7XG5cdH1cblxuXHRyZXN1bWUoKSB7XG5cdFx0dGhpcy5wYXVzZWQgPSBmYWxzZTtcblx0XHR0aGlzLm5leHRfY2h1bmsoKTtcblx0fVxuXG5cdGNodW5rKGF0X2NodW5rLCBiX2VvZikge1xuXHRcdGxldCBubF9jaHVuayA9IGF0X2NodW5rLmxlbmd0aDtcblx0XHR0aGlzLmNvbnN1bWVkICs9IG5sX2NodW5rO1xuXG5cdFx0Ly8gZGVjb2RlIGRhdGFcblx0XHRpZiAodGhpcy5kZWNvZGVyKSB7XG5cdFx0XHRsZXQgc19kYXRhO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0c19kYXRhID0gdGhpcy5kZWNvZGVyLmRlY29kZShhdF9jaHVuaywge1xuXHRcdFx0XHRcdHN0cmVhbTogIWJfZW9mXG5cdFx0XHRcdH0pO1xuXHRcdFx0fSBjYXRjaCAoZV9kZWNvZGUpIHtcblx0XHRcdFx0dGhpcy5lbWl0KCdlcnJvcicsIGVfZGVjb2RlKTtcblx0XHRcdH1cblxuXHRcdFx0dGhpcy5lbWl0KCdkYXRhJywgc19kYXRhLCBhdF9jaHVuayk7XG5cdFx0fVxuXHRcdC8vIG5vIGVuY29kaW5nXG5cdFx0ZWxzZSB7XG5cdFx0XHR0aGlzLmVtaXQoJ2RhdGEnLCBhdF9jaHVuaywgYXRfY2h1bmspO1xuXHRcdH1cblxuXHRcdC8vIGVuZCBvZiBmaWxlXG5cdFx0aWYgKGJfZW9mKSB7XG5cdFx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0dGhpcy5lbWl0KCdlbmQnKTtcblx0XHRcdH0sIDApO1xuXHRcdH1cblx0XHQvLyByZXF1ZXN0IG1vcmUgZGF0YVxuXHRcdGVsc2UgaWYgKCF0aGlzLnBhdXNlZCkge1xuXHRcdFx0dGhpcy5uZXh0X2NodW5rKCk7XG5cdFx0fVxuXHR9XG59XG5cbk9iamVjdC5hc3NpZ24ocmVhZGFibGVfc3RyZWFtLnByb3RvdHlwZSwge1xuXHRlbWl0c0J5dGVDb3VudHM6IHRydWUsXG59KTtcblxuY2xhc3MgcmVhZGFibGVfc3RyZWFtX3ZpYV9wb3J0IGV4dGVuZHMgcmVhZGFibGVfc3RyZWFtIHtcblx0Y29uc3RydWN0b3IoZF9wb3J0KSB7XG5cdFx0c3VwZXIoKTtcblxuXHRcdC8vIG1lc3NhZ2UgaGFuZGxpbmdcblx0XHRkX3BvcnQub25tZXNzYWdlID0gKGRfbXNnKSA9PiB7XG5cdFx0XHRsZXQge1xuXHRcdFx0XHRjb250ZW50OiBhdF9jb250ZW50LFxuXHRcdFx0XHRlb2Y6IGJfZW9mLFxuXHRcdFx0fSA9IGRfbXNnLmRhdGE7XG5cblx0XHRcdC8vIHN0YXJ0IHRpbWluZ1xuXHRcdFx0dGhpcy5zdGFydGVkID0gcGVyZm9ybWFuY2Uubm93KCk7XG5cblx0XHRcdC8vIHByb2Nlc3MgY2h1bmtcblx0XHRcdHRoaXMuY2h1bmsoYXRfY29udGVudCwgYl9lb2YpO1xuXHRcdH07XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdHBvcnQ6IGRfcG9ydCxcblx0XHRcdHN0YXJ0ZWQ6IDAsXG5cdFx0fSk7XG5cdH1cblxuXHRzZXRFbmNvZGluZyhzX2VuY29kaW5nKSB7XG5cdFx0dGhpcy5kZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKHNfZW5jb2RpbmcpO1xuXHR9XG5cblx0bmV4dF9jaHVuaygpIHtcblx0XHRsZXQgdF9lbGFwc2VkID0gcGVyZm9ybWFuY2Uubm93KCkgLSB0aGlzLnN0YXJ0ZWQ7XG5cblx0XHQvLyBjb25zb2xlLmxvZygnUyA9PT4gW0FDSyAvIG5leHQgY2h1bmtdJyk7XG5cblx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0cG9zdGVkOiBwZXJmb3JtYW5jZS5ub3coKSxcblx0XHRcdGVsYXBzZWQ6IHRfZWxhcHNlZCxcblx0XHR9KTtcblx0fVxuXG5cdC8vIHBhdXNlKCkge1xuXG5cdC8vIH1cblxuXHQvLyByZXN1bWUoYl9kb250X3VucGF1c2U9ZmFsc2UpIHtcblx0Ly8gXHRsZXQgdF9lbGFwc2VkID0gcGVyZm9ybWFuY2Uubm93KCkgLSB0aGlzLnN0YXJ0ZWQ7XG5cblx0Ly8gXHRzZWxmLnBvc3RNZXNzYWdlKHtcblx0Ly8gXHRcdGVsYXBzZWQ6IHRfZWxhcHNlZCxcblx0Ly8gXHR9KTtcblx0Ly8gfVxuXG5cdC8vIHBpcGUoeV93cml0YWJsZSkge1xuXHQvLyBcdHRoaXMub24oJ2RhdGEnLCAoel9jaHVuaykgPT4ge1xuXHQvLyBcdFx0bGV0IGJfY2FwYWNpdHkgPSB5X3dyaXRhYmxlLndyaXRlKHpfY2h1bmspO1xuXG5cdC8vIFx0XHQvLyBmZXRjaCBuZXh0IGNodW5rOyBvdGhlcndpc2UgYXdhaXQgZHJhaW5cblx0Ly8gXHRcdGlmKGZhbHNlICE9PSBiX2NhcGFjaXR5KSB7XG5cdC8vIFx0XHRcdHRoaXMucmVzdW1lKHRydWUpO1xuXHQvLyBcdFx0fVxuXHQvLyBcdH0pO1xuXG5cdC8vIFx0eV93cml0YWJsZS5vbignZHJhaW4nLCAoKSA9PiB7XG5cdC8vIFx0XHR0aGlzLnJlc3VtZSh0cnVlKTtcblx0Ly8gXHR9KTtcblxuXHQvLyBcdHlfd3JpdGFibGUuZW1pdCgncGlwZScsIHRoaXMpO1xuXHQvLyB9XG59XG5cblxuXG5jbGFzcyByZWFkYWJsZV9zdHJlYW1fdmlhX29iamVjdF91cmwgZXh0ZW5kcyByZWFkYWJsZV9zdHJlYW0ge1xuXHRjb25zdHJ1Y3RvcihwX29iamVjdF91cmwsIGhfY29uZmlnID0ge30pIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0ZmV0Y2gocF9vYmplY3RfdXJsKVxuXHRcdFx0LnRoZW4oZF9yZXMgPT4gZF9yZXMuYmxvYigpKVxuXHRcdFx0LnRoZW4oKGRmYl9pbnB1dCkgPT4ge1xuXHRcdFx0XHRpZiAodGhpcy5vbmJsb2IpIHRoaXMub25ibG9iKGRmYl9pbnB1dCk7XG5cdFx0XHRcdGxldCBrX2Jsb2JfcmVhZGVyID0gdGhpcy5ibG9iX3JlYWRlciA9IG5ldyBibG9iX3JlYWRlcih0aGlzLCBkZmJfaW5wdXQsIGhfY29uZmlnKTtcblx0XHRcdFx0dGhpcy5vbignZW5kJywgKCkgPT4ge1xuXHRcdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0XHRcdFVSTC5yZXZva2VPYmplY3RVUkwocF9vYmplY3RfdXJsKTtcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGtfYmxvYl9yZWFkZXIubmV4dF9jaHVuaygpO1xuXHRcdFx0fSk7XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdGJsb2JfcmVhZGVyOiBudWxsLFxuXHRcdFx0b2JqZWN0X3VybDogcF9vYmplY3RfdXJsLFxuXHRcdH0pO1xuXHR9XG5cblx0bmV4dF9jaHVuaygpIHtcblx0XHR0aGlzLmJsb2JfcmVhZGVyLm5leHRfY2h1bmsoKTtcblx0fVxuXG5cdC8vIG9uKHNfZXZlbnQsIGZrX2V2ZW50KSB7XG5cdC8vIFx0c3VwZXIub24oc19ldmVudCwgZmtfZXZlbnQpO1xuXG5cdC8vIFx0aWYoJ2RhdGEnID09PSBzX2V2ZW50KSB7XG5cdC8vIFx0XHRpZighdGhpcy5ibG9iKSB7XG5cdC8vIFx0XHRcdHRoaXMub25fYmxvYiA9IHRoaXMucmVzdW1lO1xuXHQvLyBcdFx0fVxuXHQvLyBcdFx0ZWxzZSB7XG5cdC8vIFx0XHRcdHRoaXMucmVzdW1lKCk7XG5cdC8vIFx0XHR9XG5cdC8vIFx0fVxuXHQvLyB9XG59XG5cbmNsYXNzIHRyYW5zZmVyX3N0cmVhbSB7XG5cdGNvbnN0cnVjdG9yKCkge1xuXHRcdGxldCBkX2NoYW5uZWwgPSBuZXcgTWVzc2FnZUNoYW5uZWwoKTtcblx0XHRsZXQgZF9wb3J0ID0gZF9jaGFubmVsLnBvcnQxO1xuXG5cdFx0ZF9wb3J0Lm9ubWVzc2FnZSA9IChkX21zZykgPT4ge1xuXHRcdFx0bGV0IHRfZWxhcHNlZF9tYWluID0gdGhpcy5lbGFwc2VkO1xuXG5cdFx0XHRsZXQge1xuXHRcdFx0XHRwb3N0ZWQ6IHRfcG9zdGVkLFxuXHRcdFx0XHRlbGFwc2VkOiB0X2VsYXBzZWRfb3RoZXIsXG5cdFx0XHR9ID0gZF9tc2cuZGF0YTtcblxuXHRcdFx0Ly8gY29uc29sZS5sb2coJyArKyBwYXJzZTogJyt0X2VsYXBzZWRfb3RoZXIpO1xuXHRcdFx0dGhpcy5yZWNlaXZlcl9lbGFwc2VkICs9IHRfZWxhcHNlZF9vdGhlcjtcblxuXHRcdFx0Ly8gY29uc29sZS5sb2coJ00gPD09IFtBQ0sgLyBuZXh0IGNodW5rXTsgYnVmZmVyOiAnKyghIXRoaXMuYnVmZmVyKSsnOyBidXN5OiAnK3RoaXMucmVjZWl2ZXJfYnVzeSsnOyBlb2Y6Jyt0aGlzLnJlYWRlci5lb2YpOyAgLy9wb3N0ZWQgQCcrdF9wb3N0ZWQpO1xuXG5cdFx0XHQvLyByZWNlaXZlciBpcyBmcmVlXG5cdFx0XHR0aGlzLnJlY2VpdmVyX2J1c3kgPSBmYWxzZTtcblxuXHRcdFx0Ly8gY2h1bmsgcmVhZHkgdG8gZ29cblx0XHRcdGlmICh0aGlzLmJ1ZmZlcikge1xuXHRcdFx0XHR0aGlzLnNlbmQodGhpcy5idWZmZXIsIHRoaXMuYnVmZmVyX2VvZik7XG5cdFx0XHRcdHRoaXMuYnVmZmVyID0gbnVsbDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gcmVhZGVyIGlzIG5vdCBidXN5XG5cdFx0XHRpZiAoIXRoaXMucmVhZGVyLmJ1c3kpIHtcblx0XHRcdFx0dGhpcy5yZWFkZXIubmV4dF9jaHVuaygpO1xuXHRcdFx0fVxuXHRcdH07XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdG1haW5fcG9ydDogZF9wb3J0LFxuXHRcdFx0b3RoZXJfcG9ydDogZF9jaGFubmVsLnBvcnQyLFxuXHRcdFx0ZWxhcHNlZDogMCxcblx0XHRcdHJlYWRlcjogbnVsbCxcblx0XHRcdGJ1ZmZlcjogbnVsbCxcblx0XHRcdGJ1ZmZlcl9lb2Y6IHRydWUsXG5cdFx0XHRyZWNlaXZlcl9idXN5OiBmYWxzZSxcblx0XHRcdHJlY2VpdmVyX2VsYXBzZWQ6IDAsXG5cdFx0fSk7XG5cdH1cblxuXHRzZW5kKGF0X2NodW5rLCBiX2VvZiA9IHRydWUpIHtcblx0XHR0aGlzLnJlY2VpdmVyX2J1c3kgPSB0cnVlO1xuXG5cdFx0Ly8gY29uc29sZS5sb2coJ00gPT0+IFtjaHVua10nKTtcblxuXHRcdC8vIHNlbmQgdG8gcmVjZWl2ZXJcblx0XHR0aGlzLm1haW5fcG9ydC5wb3N0TWVzc2FnZSh7XG5cdFx0XHRjb250ZW50OiBhdF9jaHVuayxcblx0XHRcdGVvZjogYl9lb2YsXG5cdFx0fSwgW2F0X2NodW5rLmJ1ZmZlcl0pO1xuXHR9XG5cblx0Y2h1bmsoYXRfY2h1bmssIGJfZW9mID0gdHJ1ZSkge1xuXHRcdC8vIGNvbnNvbGUubG9nKCdibG9iIGNodW5rIHJlYWR5IHRvIHNlbmQ7IGJ1ZmZlcjogJysoISF0aGlzLmJ1ZmZlcikrJzsgYnVzeTogJyt0aGlzLnJlY2VpdmVyX2J1c3kpO1xuXG5cdFx0Ly8gcmVjZWl2ZXIgaXMgYnVzeSwgcXVldWUgaW4gYnVmZmVyXG5cdFx0aWYgKHRoaXMucmVjZWl2ZXJfYnVzeSkge1xuXHRcdFx0dGhpcy5idWZmZXIgPSBhdF9jaHVuaztcblx0XHRcdHRoaXMuYnVmZmVyX2VvZiA9IGJfZW9mO1xuXHRcdH1cblx0XHQvLyByZWNlaXZlciBhdmFpbGFibGU7IHNlbmQgaW1tZWRpYXRlbHlcblx0XHRlbHNlIHtcblx0XHRcdC8vIHByZWZldGNoIG5leHQgY2h1bmtcblx0XHRcdGlmICghdGhpcy5idWZmZXIgJiYgIXRoaXMucmVhZGVyLmVvZikge1xuXHRcdFx0XHR0aGlzLnJlYWRlci5uZXh0X2NodW5rKCk7XG5cdFx0XHR9XG5cblx0XHRcdHRoaXMuc2VuZChhdF9jaHVuaywgYl9lb2YpO1xuXHRcdH1cblx0fVxuXG5cdGJsb2IoZGZiX2lucHV0LCBoX2NvbmZpZyA9IHt9KSB7XG5cdFx0dGhpcy5yZWFkZXIgPSBuZXcgYmxvYl9yZWFkZXIodGhpcywgZGZiX2lucHV0LCBoX2NvbmZpZyk7XG5cblx0XHQvLyBzdGFydCBzZW5kaW5nXG5cdFx0dGhpcy5yZWFkZXIubmV4dF9jaHVuaygpO1xuXHR9XG59XG5cbmNsYXNzIGJsb2JfcmVhZGVyIHtcblx0Y29uc3RydWN0b3Ioa19wYXJlbnQsIGRmYl9pbnB1dCwgaF9jb25maWcgPSB7fSkge1xuXHRcdGxldCBkZnJfcmVhZGVyID0gbmV3IEZpbGVSZWFkZXIoKTtcblx0XHRkZnJfcmVhZGVyLm9ubG9hZCA9IChkX2V2ZW50KSA9PiB7XG5cdFx0XHR0aGlzLmJ1c3kgPSBmYWxzZTtcblx0XHRcdC8vIGxldCBiX2VvZiA9IGZhbHNlO1xuXHRcdFx0Ly8gaWYoKyt0aGlzLmNodW5rc19yZWFkID09PSB0aGlzLmNodW5rc19sb2FkZWQpIGJfZW9mID0gdGhpcy5lb2Y7XG5cdFx0XHRrX3BhcmVudC5jaHVuayhuZXcgVWludDhBcnJheShkX2V2ZW50LnRhcmdldC5yZXN1bHQpLCB0aGlzLmVvZik7XG5cdFx0fTtcblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0ZW9mOiBmYWxzZSxcblx0XHRcdGJ1c3k6IGZhbHNlLFxuXHRcdFx0cmVhZF9pbmRleDogMCxcblx0XHRcdGNodW5rX3NpemU6IGhfY29uZmlnLmNodW5rX3NpemUgfHwgaF9jb25maWcuY2h1bmtTaXplIHx8IDEwMjQgKiAxMDI0ICogMSwgLy8gMSBNaUJcblx0XHRcdGNvbnRlbnQ6IGRmYl9pbnB1dCxcblx0XHRcdGNvbnRlbnRfbGVuZ3RoOiBkZmJfaW5wdXQuc2l6ZSxcblx0XHRcdGZpbGVfcmVhZGVyOiBkZnJfcmVhZGVyLFxuXHRcdFx0Y2h1bmtzX2xvYWRlZDogMCxcblx0XHRcdGNodW5rc19yZWFkOiAwLFxuXHRcdH0pO1xuXHR9XG5cblx0bmV4dF9jaHVuaygpIHtcblx0XHRsZXQge1xuXHRcdFx0cmVhZF9pbmRleDogaV9yZWFkLFxuXHRcdFx0Y2h1bmtfc2l6ZTogbl9jaHVua19zaXplLFxuXHRcdFx0Y29udGVudDogZGZiX2NvbnRlbnQsXG5cdFx0XHRjb250ZW50X2xlbmd0aDogbmxfY29udGVudCxcblx0XHR9ID0gdGhpcztcblxuXHRcdGxldCBpX2VuZCA9IGlfcmVhZCArIG5fY2h1bmtfc2l6ZTtcblx0XHRpZiAoaV9lbmQgPj0gbmxfY29udGVudCkge1xuXHRcdFx0aV9lbmQgPSBubF9jb250ZW50O1xuXHRcdFx0dGhpcy5lb2YgPSB0cnVlO1xuXHRcdH1cblxuXHRcdHRoaXMuYnVzeSA9IHRydWU7XG5cdFx0dGhpcy5jaHVua3NfbG9hZGVkICs9IDE7XG5cblx0XHRsZXQgZGZiX3NsaWNlID0gZGZiX2NvbnRlbnQuc2xpY2UoaV9yZWFkLCBpX2VuZCk7XG5cdFx0dGhpcy5yZWFkX2luZGV4ID0gaV9lbmQ7XG5cblx0XHR0aGlzLmZpbGVfcmVhZGVyLnJlYWRBc0FycmF5QnVmZmVyKGRmYl9zbGljZSk7XG5cdH1cbn1cblxuXG5tb2R1bGUuZXhwb3J0cyA9IE9iamVjdC5hc3NpZ24oZnVuY3Rpb24oel9pbnB1dCA9IG51bGwpIHtcblx0aWYgKHpfaW5wdXQpIHtcblx0XHQvLyBtYWtlIHJlYWRhYmxlIHN0cmVhbSBmcm9tIG9iamVjdCB1cmwncyBibG9iXG5cdFx0aWYgKCdzdHJpbmcnID09PSB0eXBlb2Ygel9pbnB1dCkge1xuXHRcdFx0cmV0dXJuIG5ldyByZWFkYWJsZV9zdHJlYW1fdmlhX29iamVjdF91cmwoel9pbnB1dCk7XG5cdFx0fVxuXHRcdC8vIG1ha2UgcmVhZGFibGUgc3RyZWFtIGF0b3AgcG9ydFxuXHRcdGVsc2UgaWYgKHpfaW5wdXQgaW5zdGFuY2VvZiBNZXNzYWdlUG9ydCkge1xuXHRcdFx0cmV0dXJuIG5ldyByZWFkYWJsZV9zdHJlYW1fdmlhX3BvcnQoel9pbnB1dCk7XG5cdFx0fVxuXHR9XG5cdC8vIHRyYW5zZmVyIGEgc3RyZWFtXG5cdGVsc2Uge1xuXHRcdHJldHVybiBuZXcgdHJhbnNmZXJfc3RyZWFtKCk7XG5cdH1cbn0sIHtcblx0aGFuZGxlcjogY2xhc3MgaGFuZGxlciB7fSxcbn0pOyIsImNvbnN0IHNoYXJpbmcgPSByZXF1aXJlKCcuL3NoYXJpbmcuanMnKTtcbmNvbnN0IFR5cGVkQXJyYXkgPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoT2JqZWN0LmdldFByb3RvdHlwZU9mKG5ldyBVaW50OEFycmF5KDApKSkuY29uc3RydWN0b3I7XG5cblxuXG5cblxuY2xhc3MgSW50OEFycmF5UyBleHRlbmRzIEludDhBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZiAoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRhdF9zZWxmID0gbmV3IEludDhBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmIChzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgSW50OEFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHtcblx0XHRcdC8vIGZvcmNlIG9mZnNldFxuXHRcdFx0bmJfb2Zmc2V0ID0gbmJfb2Zmc2V0IHx8IDA7XG5cblx0XHRcdC8vIG5vIGxlbmd0aDsgZGVkdWNlIGl0IGZyb20gb2Zmc2V0XG5cdFx0XHRpZiAodW5kZWZpbmVkID09PSBubF9hcnJheSkge1xuXHRcdFx0XHRubF9hcnJheSA9IHpfYXJnXzAubGVuZ3RoIC0gbmJfb2Zmc2V0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhcnJheSBzaXplIGluIGJ5dGVzXG5cdFx0XHRsZXQgbmJfYXJyYXkgPSBubF9hcnJheTtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQ4QXJyYXkoZHNiLCAwLCBuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSBjb3B5IHNyY1xuXHRcdFx0bGV0IGF0X3NyYyA9IG5ldyBJbnQ4QXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBJbnQ4QXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oSW50OEFycmF5Uy5wcm90b3R5cGUsIHtcblx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdOiAxLFxufSk7XG5cblxuY2xhc3MgVWludDhBcnJheVMgZXh0ZW5kcyBVaW50OEFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmICgnbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmIChzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0XHRhdF9zZWxmLnNldCh6X2FyZ18wKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyIGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXk7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IFVpbnQ4QXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBVaW50OEFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKFVpbnQ4QXJyYXlTLnByb3RvdHlwZSwge1xuXHRbc2hhcmluZy4kX1NIQVJFQUJMRV06IDEsXG59KTtcblxuXG5jbGFzcyBVaW50OENsYW1wZWRBcnJheVMgZXh0ZW5kcyBVaW50OENsYW1wZWRBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZiAoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQ4Q2xhbXBlZEFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYgKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50OENsYW1wZWRBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0XHRhdF9zZWxmLnNldCh6X2FyZ18wKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyIGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXk7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhDbGFtcGVkQXJyYXkoZHNiLCAwLCBuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSBjb3B5IHNyY1xuXHRcdFx0bGV0IGF0X3NyYyA9IG5ldyBVaW50OENsYW1wZWRBcnJheSh6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KTtcblxuXHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdGF0X3NlbGYuc2V0KGF0X3NyYyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIHNlbGZcblx0XHRzdXBlcihhdF9zZWxmKTtcblxuXHRcdC8vIHNhdmUgZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCBoX3RoaXMpO1xuXHR9XG5cblx0YmFzZSguLi5hX2FyZ3MpIHtcblx0XHRyZXR1cm4gbmV3IFVpbnQ4Q2xhbXBlZEFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKFVpbnQ4Q2xhbXBlZEFycmF5Uy5wcm90b3R5cGUsIHtcblx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdOiAxLFxufSk7XG5cblxuY2xhc3MgSW50MTZBcnJheVMgZXh0ZW5kcyBJbnQxNkFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmICgnbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGF0X3NlbGYgPSBuZXcgSW50MTZBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmIChzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgSW50MTZBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0XHRhdF9zZWxmLnNldCh6X2FyZ18wKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyIGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXkgPDwgMTtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQxNkFycmF5KGRzYiwgMCwgbmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgY29weSBzcmNcblx0XHRcdGxldCBhdF9zcmMgPSBuZXcgSW50MTZBcnJheSh6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KTtcblxuXHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdGF0X3NlbGYuc2V0KGF0X3NyYyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIHNlbGZcblx0XHRzdXBlcihhdF9zZWxmKTtcblxuXHRcdC8vIHNhdmUgZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCBoX3RoaXMpO1xuXHR9XG5cblx0YmFzZSguLi5hX2FyZ3MpIHtcblx0XHRyZXR1cm4gbmV3IEludDE2QXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oSW50MTZBcnJheVMucHJvdG90eXBlLCB7XG5cdFtzaGFyaW5nLiRfU0hBUkVBQkxFXTogMSxcbn0pO1xuXG5cbmNsYXNzIFVpbnQxNkFycmF5UyBleHRlbmRzIFVpbnQxNkFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmICgnbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDE2QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZiAoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQxNkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHtcblx0XHRcdC8vIGZvcmNlIG9mZnNldFxuXHRcdFx0bmJfb2Zmc2V0ID0gbmJfb2Zmc2V0IHx8IDA7XG5cblx0XHRcdC8vIG5vIGxlbmd0aDsgZGVkdWNlIGl0IGZyb20gb2Zmc2V0XG5cdFx0XHRpZiAodW5kZWZpbmVkID09PSBubF9hcnJheSkge1xuXHRcdFx0XHRubF9hcnJheSA9IHpfYXJnXzAubGVuZ3RoIC0gbmJfb2Zmc2V0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhcnJheSBzaXplIGluIGJ5dGVzXG5cdFx0XHRsZXQgbmJfYXJyYXkgPSBubF9hcnJheSA8PCAxO1xuXG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRsZXQgZHNiID0gbmV3IFNoYXJlZEFycmF5QnVmZmVyKG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIHR5cGVkIGFycmF5XG5cdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQxNkFycmF5KGRzYiwgMCwgbmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgY29weSBzcmNcblx0XHRcdGxldCBhdF9zcmMgPSBuZXcgVWludDE2QXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBVaW50MTZBcnJheSguLi5hX2FyZ3MpO1xuXHR9XG59XG5cbi8vIHN0YXRpYyBmaWVsZFxuT2JqZWN0LmFzc2lnbihVaW50MTZBcnJheVMucHJvdG90eXBlLCB7XG5cdFtzaGFyaW5nLiRfU0hBUkVBQkxFXTogMSxcbn0pO1xuXG5cbmNsYXNzIEludDMyQXJyYXlTIGV4dGVuZHMgSW50MzJBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZiAoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRhdF9zZWxmID0gbmV3IEludDMyQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZiAoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0XHRhdF9zZWxmID0gbmV3IEludDMyQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmICh1bmRlZmluZWQgPT09IG5sX2FycmF5KSB7XG5cdFx0XHRcdG5sX2FycmF5ID0gel9hcmdfMC5sZW5ndGggLSBuYl9vZmZzZXQ7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFycmF5IHNpemUgaW4gYnl0ZXNcblx0XHRcdGxldCBuYl9hcnJheSA9IG5sX2FycmF5IDw8IDI7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgSW50MzJBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IEludDMyQXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBJbnQzMkFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKEludDMyQXJyYXlTLnByb3RvdHlwZSwge1xuXHRbc2hhcmluZy4kX1NIQVJFQUJMRV06IDEsXG59KTtcblxuXG5jbGFzcyBVaW50MzJBcnJheVMgZXh0ZW5kcyBVaW50MzJBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZiAoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQzMkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYgKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50MzJBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0XHRhdF9zZWxmLnNldCh6X2FyZ18wKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyIGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXkgPDwgMjtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50MzJBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IFVpbnQzMkFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgVWludDMyQXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oVWludDMyQXJyYXlTLnByb3RvdHlwZSwge1xuXHRbc2hhcmluZy4kX1NIQVJFQUJMRV06IDEsXG59KTtcblxuXG5jbGFzcyBGbG9hdDMyQXJyYXlTIGV4dGVuZHMgRmxvYXQzMkFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmICgnbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGF0X3NlbGYgPSBuZXcgRmxvYXQzMkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihzX2hvdykpO1xuXG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYgKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBGbG9hdDMyQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYgKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmICh1bmRlZmluZWQgPT09IG5sX2FycmF5KSB7XG5cdFx0XHRcdG5sX2FycmF5ID0gel9hcmdfMC5sZW5ndGggLSBuYl9vZmZzZXQ7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFycmF5IHNpemUgaW4gYnl0ZXNcblx0XHRcdGxldCBuYl9hcnJheSA9IG5sX2FycmF5IDw8IDI7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgRmxvYXQzMkFycmF5KGRzYiwgMCwgbmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgY29weSBzcmNcblx0XHRcdGxldCBhdF9zcmMgPSBuZXcgRmxvYXQzMkFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgRmxvYXQzMkFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKEZsb2F0MzJBcnJheVMucHJvdG90eXBlLCB7XG5cdFtzaGFyaW5nLiRfU0hBUkVBQkxFXTogMSxcbn0pO1xuXG5cbmNsYXNzIEZsb2F0NjRBcnJheVMgZXh0ZW5kcyBGbG9hdDY0QXJyYXkge1xuXHRjb25zdHJ1Y3Rvcih6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KSB7XG5cdFx0Ly8gdGhpc1xuXHRcdGxldCBoX3RoaXMgPSB7fTtcblxuXHRcdC8vIHNlbGZcblx0XHRsZXQgYXRfc2VsZjtcblxuXG5cdFx0Ly8gbGVuZ3RoIGNvbnN0cnVjdG9yXG5cdFx0aWYgKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0YXRfc2VsZiA9IG5ldyBGbG9hdDY0QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHNfaG93KSk7XG5cblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmICh6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZiAoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0XHRhdF9zZWxmID0gbmV3IEZsb2F0NjRBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoc19ob3cpKTtcblxuXHRcdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0XHRhdF9zZWxmLnNldCh6X2FyZ18wKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyIGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZiAoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYgKHVuZGVmaW5lZCA9PT0gbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXkgPDwgNDtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBGbG9hdDY0QXJyYXkoZHNiLCAwLCBuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSBjb3B5IHNyY1xuXHRcdFx0bGV0IGF0X3NyYyA9IG5ldyBGbG9hdDY0QXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBGbG9hdDY0QXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oRmxvYXQ2NEFycmF5Uy5wcm90b3R5cGUsIHtcblx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdOiAxLFxufSk7XG5cblxuXG4vLyBnbG9iYWxzXG5tb2R1bGUuZXhwb3J0cyA9IHtcblx0ZXhwb3J0czoge1xuXHRcdEFycmF5QnVmZmVyUzogU2hhcmVkQXJyYXlCdWZmZXIsXG5cdFx0QXJyYXlCdWZmZXJUOiBBcnJheUJ1ZmZlcixcblx0XHRJbnQ4QXJyYXlTOiBJbnQ4QXJyYXlTLFxuXHRcdEludDhBcnJheVQ6IEludDhBcnJheSxcblx0XHRVaW50OEFycmF5UzogVWludDhBcnJheVMsXG5cdFx0VWludDhBcnJheVQ6IFVpbnQ4QXJyYXksXG5cdFx0VWludDhDbGFtcGVkQXJyYXlTOiBVaW50OENsYW1wZWRBcnJheVMsXG5cdFx0VWludDhDbGFtcGVkQXJyYXlUOiBVaW50OENsYW1wZWRBcnJheSxcblx0XHRJbnQxNkFycmF5UzogSW50MTZBcnJheVMsXG5cdFx0SW50MTZBcnJheVQ6IEludDE2QXJyYXksXG5cdFx0VWludDE2QXJyYXlTOiBVaW50MTZBcnJheVMsXG5cdFx0VWludDE2QXJyYXlUOiBVaW50MTZBcnJheSxcblx0XHRJbnQzMkFycmF5UzogSW50MzJBcnJheVMsXG5cdFx0SW50MzJBcnJheVQ6IEludDMyQXJyYXksXG5cdFx0VWludDMyQXJyYXlTOiBVaW50MzJBcnJheVMsXG5cdFx0VWludDMyQXJyYXlUOiBVaW50MzJBcnJheSxcblx0XHRGbG9hdDMyQXJyYXlTOiBGbG9hdDMyQXJyYXlTLFxuXHRcdEZsb2F0MzJBcnJheVQ6IEZsb2F0MzJBcnJheSxcblx0XHRGbG9hdDY0QXJyYXlTOiBGbG9hdDY0QXJyYXlTLFxuXHRcdEZsb2F0NjRBcnJheVQ6IEZsb2F0NjRBcnJheSxcblx0fSxcbn07IiwiY29uc3QgZXZlbnRzID0gcmVxdWlyZSgnLi9ldmVudHMuanMnKTtcbmNvbnN0IHNoYXJpbmcgPSByZXF1aXJlKCcuL3NoYXJpbmcuanMnKTtcblxuY2xhc3Mgd29ya2VyIGV4dGVuZHMgV29ya2VyIHtcblxuXHRwb3N0UG9ydChkX3BvcnQsIGhfbXNnLCBhX3RyYW5zZmVyX3BhdGhzID0gW10pIHtcblx0XHQvLyBhcHBlbmQgcG9ydCB0byB0cmFuc2ZlciBwYXRoc1xuXHRcdGFfdHJhbnNmZXJfcGF0aHMucHVzaChbJ3BvcnQnXSk7XG5cblx0XHQvLyBzZW5kXG5cdFx0dGhpcy5wb3N0TWVzc2FnZShPYmplY3QuYXNzaWduKHtcblx0XHRcdHBvcnQ6IGRfcG9ydCxcblx0XHR9LCBoX21zZyksIGFfdHJhbnNmZXJfcGF0aHMpO1xuXHR9XG5cblx0cG9zdE1lc3NhZ2UoaF9tc2csIGFfdHJhbnNmZXJfcGF0aHMpIHtcblx0XHRsZXQgYV90cmFuc2ZlcnMgPSBbXTtcblx0XHRmb3IgKGxldCBpX3RyYW5zZmVyX3BhdGggPSAwLCBubF90cmFuc2Zlcl9wYXRocyA9IGFfdHJhbnNmZXJfcGF0aHMubGVuZ3RoOyBpX3RyYW5zZmVyX3BhdGggPCBubF90cmFuc2Zlcl9wYXRoczsgaV90cmFuc2Zlcl9wYXRoKyspIHtcblx0XHRcdGxldCBhX3BhdGggPSBhX3RyYW5zZmVyX3BhdGhzW2lfdHJhbnNmZXJfcGF0aF07XG5cblx0XHRcdGxldCB6X3dhbGsgPSBoX21zZztcblx0XHRcdGZvciAobGV0IGlfc3RlcCA9IDAsIG5sX3BhdGggPSBhX3BhdGgubGVuZ3RoOyBpX3N0ZXAgPCBubF9wYXRoOyBpX3N0ZXArKykge1xuXHRcdFx0XHR6X3dhbGsgPSB6X3dhbGtbYV9wYXRoW2lfc3RlcF1dO1xuXHRcdFx0fVxuXG5cdFx0XHRhX3RyYW5zZmVycy5wdXNoKC4uLnNoYXJpbmcuZXh0cmFjdCh6X3dhbGspKTtcblx0XHR9XG5cblx0XHRzdXBlci5wb3N0TWVzc2FnZShoX21zZywgYV90cmFuc2ZlcnMpO1xuXHR9XG59XG5cbmV2ZW50cyh3b3JrZXIucHJvdG90eXBlKTtcblxubW9kdWxlLmV4cG9ydHMgPSB3b3JrZXI7IiwiY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcblxuLy8gbG9jYWwgY2xhc3NlcyAvIGdsb2JhbHNcbmNvbnN0IHtcblx0S19TRUxGLFxuXHREQ19XT1JLRVIsXG5cdERDX0NIQU5ORUwsXG5cdEhfVFlQRURfQVJSQVlTLFxuXHRCX0JST1dTRVIsXG5cdEJfQlJPV1NFUklGWSxcblx0SFBfV09SS0VSX05PVElGSUNBVElPTixcblx0c3RyZWFtLFxuXHR3ZWJ3b3JrZXJpZnksXG59ID0gcmVxdWlyZSgnLi9hbGwvbG9jYWxzLmpzJyk7XG5cbmNvbnN0IGRlZGljYXRlZCA9IHJlcXVpcmUoJy4vYWxsL2RlZGljYXRlZC5qcycpO1xuY29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKCcuL2FsbC9tYW5pZmVzdC5qcycpO1xuY29uc3QgcG9vbCA9IHJlcXVpcmUoJy4vYWxsL3Bvb2wuanMnKTtcbmNvbnN0IHJlc3VsdCA9IHJlcXVpcmUoJy4vYWxsL3Jlc3VsdC5qcycpO1xuXG4vLyBXb3JrZXIgaXMgc3VwcG9ydGVkXG5jb25zdCBCX1dPUktFUl9TVVBQT1JURUQgPSAoJ3VuZGVmaW5lZCcgIT09IHR5cGVvZiBEQ19XT1JLRVIpO1xuXG4vLyBjb250ZXh0IGJpdG1hc2tzXG5jb25zdCBYTV9DT05URVhUX1BST0NFU1NfUEFSRU5UID0gMSA8PCAwO1xuY29uc3QgWE1fQ09OVEVYVF9QUk9DRVNTX0NISUxEID0gMSA8PCAxO1xuY29uc3QgWE1fQ09OVEVYVF9XSU5ET1cgPSAxIDw8IDI7XG5jb25zdCBYTV9DT05URVhUX1dPUktFUl9ERURJQ0FURUQgPSAxIDw8IDM7XG5jb25zdCBYTV9DT05URVhUX1dPUktFUl9TRVJWSUNFID0gMSA8PCA0O1xuY29uc3QgWE1fQ09OVEVYVF9XT1JLRVJfU0hBUkVEID0gMSA8PCA1O1xuXG5jb25zdCBYTV9DT05URVhUX1dPUktFUiA9IFhNX0NPTlRFWFRfV09SS0VSX0RFRElDQVRFRCB8IFhNX0NPTlRFWFRfV09SS0VSX1NFUlZJQ0UgfCBYTV9DT05URVhUX1dPUktFUl9TSEFSRUQ7XG5cbi8vIHNldCB0aGUgY3VycmVudCBjb250ZXh0XG5jb25zdCBYX0NPTlRFWFRfVFlQRSA9ICFCX0JST1dTRVIgP1xuXHQocHJvY2Vzcy5lbnYuV09SS0VSX0RFUFRIID8gWE1fQ09OVEVYVF9QUk9DRVNTX0NISUxEIDogWE1fQ09OVEVYVF9QUk9DRVNTX1BBUkVOVCkgOlxuXHQoJ3VuZGVmaW5lZCcgIT09IHR5cGVvZiBkb2N1bWVudCA/XG5cdFx0WE1fQ09OVEVYVF9XSU5ET1cgOlxuXHRcdCgnRGVkaWNhdGVkV29ya2VyR2xvYmFsU2NvcGUnIGluIHNlbGYgP1xuXHRcdFx0WE1fQ09OVEVYVF9XT1JLRVJfREVESUNBVEVEIDpcblx0XHRcdCgnU2hhcmVkV29ya2VyR2xvYmFsU2NvcGUnIGluIHNlbGYgP1xuXHRcdFx0XHRYTV9DT05URVhUX1dPUktFUl9TSEFSRUQgOlxuXHRcdFx0XHQoJ1NlcnZpY2VXb3JrZXJHbG9iYWxTY29wZScgaW4gc2VsZiA/XG5cdFx0XHRcdFx0WE1fQ09OVEVYVF9XT1JLRVJfU0VSVklDRSA6XG5cdFx0XHRcdFx0MCkpKSk7XG5cbi8vIHVucmVjb2duaXplZCBjb250ZXh0XG5pZiAoIVhfQ09OVEVYVF9UWVBFKSB7XG5cdHRocm93IG5ldyBFcnJvcignZmFpbGVkIHRvIGRldGVybWluZSB3aGF0IGlzIHRoZSBjdXJyZW50IGVudmlyb25tZW50L2NvbnRleHQnKTtcbn1cblxuLy8gc3Bhd25zIGEgV29ya2VyXG5sZXQgc3Bhd25fd29ya2VyID0gQl9XT1JLRVJfU1VQUE9SVEVEID9cblx0KCFCX0JST1dTRVJJRlkgP1xuXHRcdChwX3NvdXJjZSwgaF9vcHRpb25zKSA9PiBuZXcgRENfV09SS0VSKHBfc291cmNlLCBoX29wdGlvbnMpIDpcblx0XHQocF9zb3VyY2UsIGhfb3B0aW9ucykgPT4ge1xuXHRcdFx0Y29uc29sZS5lcnJvcihgRmF0YWwgZXJyb3I6IHNpbmNlIHlvdSBhcmUgdXNpbmcgYnJvd3NlcmlmeSwgeW91IG5lZWQgdG8gaW5jbHVkZSBleHBsaWNpdCAncmVxdWlyZSgpJyBzdGF0ZW1lbnRzIGZvciBhbnkgc2NyaXB0cyB5b3UgaW50ZW5kIHRvIHNwYXduIGFzIHdvcmtlcnMgZnJvbSB0aGlzIHRocmVhZGApO1xuXHRcdFx0Y29uc29sZS53YXJuKGB0cnkgdXNpbmcgdGhlIGZvbGxvd2luZyBpbnN0ZWFkOlxcblxcbmNvbnN0IHdvcmtlciA9IHJlcXVpcmUoJ3dvcmtlcicpLnNjb3BpZnkocmVxdWlyZSwgKCkgPT4ge1xcbmAgK1xuXHRcdFx0XHRgXFx0cmVxdWlyZSgnJHtwX3NvdXJjZX0nKTtcXG5cXHQvLyAuLi4gYW5kIGFueSBvdGhlciBzY3JpcHRzIHlvdSB3aWxsIHNwYXduIGZyb20gdGhpcyB0aHJlYWRcXG5gICtcblx0XHRcdFx0YH0sICd1bmRlZmluZWQnICE9PSB0eXBlb2YgYXJndW1lbnRzICYmIGFyZ3VtZW50cyk7YCk7XG5cblx0XHRcdHRocm93IG5ldyBFcnJvcihgQ2Fubm90IHNwYXduIHdvcmtlciAnJHtwX3NvdXJjZX0nYCk7XG5cdFx0fSkgOlxuXHQocF9zb3VyY2UsIGhfb3B0aW9ucykgPT4ge1xuXHRcdC8vIHdlJ3JlIGluc2lkZSBhIHdvcmtlclxuXHRcdGlmIChYX0NPTlRFWFRfVFlQRSAmIFhNX0NPTlRFWFRfV09SS0VSKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBGYXRhbCBlcnJvcjogYnJvd3NlciBkb2VzIG5vdCBzdXBwb3J0IHN1YndvcmtlcnM7IGZhaWxlZCB0byBzcGF3biAnJHtwX3NvdXJjZX0nXFxuYCArXG5cdFx0XHRcdCdGb3J0dW5hdGVseSB3b3JrZXIuanMgaGFzIGEgc29sdXRpb24gIDspJyk7XG5cdFx0XHRjb25zb2xlLndhcm4oYHRyeSB1c2luZyB0aGUgZm9sbG93aW5nIGluIHlvdXIgd29ya2VyIHNjcmlwdCB0byBzdXBwb3J0IHN1YndvcmtlcnM6XFxuXFxuYCArXG5cdFx0XHRcdGBjb25zdCB3b3JrZXIgPSByZXF1aXJlKCd3b3JrZXInKS5zY29waWZ5KHJlcXVpcmUsICgpID0+IHtcXG5gICtcblx0XHRcdFx0YFxcdHJlcXVpcmUoJyR7cF9zb3VyY2V9Jyk7XFxuYCArXG5cdFx0XHRcdGBcXHQvLyAuLi4gYW5kIGFueSBvdGhlciBzY3JpcHRzIHlvdSB3aWxsIHNwYXduIGZyb20gdGhpcyB0aHJlYWRcXG5gICtcblx0XHRcdFx0YH0sICd1bmRlZmluZWQnICE9PSB0eXBlb2YgYXJndW1lbnRzICYmIGFyZ3VtZW50cyk7YCk7XG5cdFx0fVxuXG5cdFx0dGhyb3cgbmV3IEVycm9yKGBDYW5ub3Qgc3Bhd24gd29ya2VyICR7cF9zb3VyY2V9OyAnV29ya2VyJyBpcyB1bmRlZmluZWRgKTtcblx0fTtcblxuXG5sZXQgaV9ndWlkID0gMDtcblxuY2xhc3Mgd29ya2VyIGV4dGVuZHMgc3RyZWFtLmhhbmRsZXIge1xuXHRzdGF0aWMgZnJvbV9zb3VyY2UocF9zb3VyY2UpIHtcblx0XHRyZXR1cm4gbmV3IHdvcmtlcih7XG5cdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdH0pO1xuXHR9XG5cblx0Y29uc3RydWN0b3IoaF9jb25maWcpIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0bGV0IHtcblx0XHRcdHNvdXJjZTogcF9zb3VyY2UsXG5cdFx0XHRpZDogaV9pZCA9IC0xLFxuXHRcdFx0bWFzdGVyOiBrX21hc3RlciA9IG51bGwsXG5cdFx0XHRvcHRpb25zOiBoX29wdGlvbnMgPSB7fSxcblx0XHR9ID0gaF9jb25maWc7XG5cblx0XHQvLyByZXNvbHZlIHNvdXJjZSByZWxhdGl2ZSB0byBtYXN0ZXJcblx0XHRsZXQgcGFfc291cmNlID0gQl9CUk9XU0VSID9cblx0XHRcdHBfc291cmNlIDpcblx0XHRcdHBhdGgucmVzb2x2ZShwYXRoLmRpcm5hbWUobW9kdWxlLnBhcmVudC5maWxlbmFtZSksIHBfc291cmNlKTtcblxuXHRcdC8vIG1ha2Ugd29ya2VyXG5cdFx0bGV0IGRfd29ya2VyO1xuXHRcdHRyeSB7XG5cdFx0XHRkX3dvcmtlciA9IHNwYXduX3dvcmtlcihwYV9zb3VyY2UsIGhfb3B0aW9ucyk7XG5cdFx0fSBjYXRjaCAoZV9zcGF3bikge1xuXHRcdFx0bGV0IGVfbXNnID0gbmV3IEVycm9yKCdmYWlsZWQgdG8gc3Bhd24gd29ya2VyOiAnKTtcblx0XHRcdGVfbXNnLnN0YWNrID0gZV9zcGF3bi5zdGFjaztcblx0XHRcdHRocm93IGVfbXNnO1xuXHRcdH1cblxuXHRcdGRfd29ya2VyLmV2ZW50cyh7XG5cdFx0XHRlcnJvcihlX3dvcmtlcikge1xuXHRcdFx0XHRpZiAoZV93b3JrZXIgaW5zdGFuY2VvZiBFcnJvckV2ZW50KSB7XG5cdFx0XHRcdFx0aWYgKCdsaW5lbm8nIGluIGVfd29ya2VyICYmICdzb3VyY2UnIGluIGRfd29ya2VyKSB7XG5cdFx0XHRcdFx0XHRsZXQgYV9saW5lcyA9IGRfd29ya2VyLnNvdXJjZS5zcGxpdCgnXFxuJyk7XG5cdFx0XHRcdFx0XHRsZXQgaV9saW5lX2VyciA9IGVfd29ya2VyLmxpbmVubztcblx0XHRcdFx0XHRcdGxldCBhX2RlYnVnID0gYV9saW5lcy5zbGljZShNYXRoLm1heCgwLCBpX2xpbmVfZXJyIC0gMiksIE1hdGgubWluKGFfbGluZXMubGVuZ3RoIC0gMSwgaV9saW5lX2VyciArIDIpKVxuXHRcdFx0XHRcdFx0XHQubWFwKChzX2xpbmUsIGlfbGluZSkgPT4gKDEgPT09IGlfbGluZSA/ICcqJyA6ICcgJykgKyAoKGlfbGluZV9lcnIgKyBpX2xpbmUgLSAxKSArICcnKS5wYWRTdGFydCg1KSArICc6ICcgKyBzX2xpbmUpO1xuXG5cdFx0XHRcdFx0XHQvLyByZWNyZWF0ZSBlcnJvciBtZXNzYWdlXG5cdFx0XHRcdFx0XHRlX3dvcmtlciA9IG5ldyBFcnJvcihlX3dvcmtlci5tZXNzYWdlICsgYEVycm9yIHRocm93biBpbiB3b3JrZXI6XFxuJHthX2RlYnVnLmpvaW4oJ1xcbicpfWApO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGlmICh0aGlzLnRhc2tfZXJyb3IpIHtcblx0XHRcdFx0XHRcdHRoaXMudGFza19lcnJvcihlX3dvcmtlcik7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHRocm93IGVfd29ya2VyO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBlbHNlIGlmICh0aGlzLnRhc2tfZXJyb3IpIHtcblx0XHRcdFx0XHR0aGlzLnRhc2tfZXJyb3IoZV93b3JrZXIpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgYW4gZXJyb3Igb2NjdXJlZCBvbiB3b3JrZXIuLi4gYnV0IHRoZSAnZXJyb3InIGV2ZW50IGNhbGxiYWNrIGRpZCBub3QgcmVjZWl2ZSBhbiBFcnJvckV2ZW50IG9iamVjdCEgdHJ5IGluc3BlY3RpbmcgY29uc29sZWApO1xuXHRcdFx0XHR9XG5cdFx0XHR9LFxuXG5cdFx0XHQvLyB3aGVuIHRoZXJlIGlzIGFuIGVycm9yIGNyZWF0aW5nL2NvbW11bmljYXRpbmcgd2l0aCB3b3JrZXJcblx0XHRcdG1lc3NhZ2VlcnJvcjogKGVfYWN0aW9uKSA9PiB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihlX2FjdGlvbik7XG5cdFx0XHR9LFxuXG5cdFx0XHQvLyB3aGVuIGEgd29ya2VyIHJlc3BvbmRzXG5cdFx0XHRtZXNzYWdlOiAoZF9tc2cpID0+IHtcblx0XHRcdFx0bGV0IGhfbXNnID0gZF9tc2cuZGF0YTtcblxuXHRcdFx0XHQvLyBoYW5kbGUgbWVzc2FnZVxuXHRcdFx0XHRsZXQgc19oYW5kbGUgPSAnaGFuZGxlXycgKyBoX21zZy50eXBlO1xuXHRcdFx0XHRpZiAoc19oYW5kbGUgaW4gdGhpcykge1xuXHRcdFx0XHRcdHRoaXNbc19oYW5kbGVdKGhfbXNnKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYHdvcmtlciBzZW50IGEgbWVzc2FnZSB0aGF0IGhhcyBubyBkZWZpbmVkIGhhbmRsZXI6ICcke2hfbXNnLnR5cGV9J2ApO1xuXHRcdFx0XHR9XG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdFx0aWQ6IGlfaWQsXG5cdFx0XHRtYXN0ZXI6IGtfbWFzdGVyLFxuXHRcdFx0cG9ydDogZF93b3JrZXIsXG5cdFx0XHRidXN5OiBmYWxzZSxcblx0XHRcdGF2YWlsYWJsZTogdHJ1ZSxcblx0XHRcdHRhc2tzX2Fzc2lnbmVkOiAwLFxuXHRcdFx0Y2FsbGJhY2tzOiB7fSxcblx0XHRcdGV2ZW50czoge30sXG5cdFx0XHRzdWJ3b3JrZXJzOiBbXSxcblx0XHRcdHRhc2tfZXJyb3I6IG51bGwsXG5cdFx0fSk7XG5cdH1cblxuXHRkZWJ1ZyhzX3R5cGUsIC4uLmFfaW5mbykge1xuXHRcdC8vIGNvbnNvbGUud2FybihgTSR7U3RyaW5nLmZyb21DaGFyQ29kZSg2NSt0aGlzLmlkKX0gJHtzX3R5cGV9ICR7YV9pbmZvLmxlbmd0aD8gJygnK2FfaW5mby5qb2luKCcsICcpKycpJzogJy0nfWApO1xuXHR9XG5cblx0aGFuZGxlX2Nsb3NlX3NlcnZlcihoX21zZykge1xuXHRcdERDX0NIQU5ORUwua2lsbChoX21zZy5zZXJ2ZXIpO1xuXHR9XG5cblx0aGFuZGxlX3Jlc3BvbmQoaF9tc2cpIHtcblx0XHRsZXQgaF9jYWxsYmFja3MgPSB0aGlzLmNhbGxiYWNrcztcblxuXHRcdC8vIG5vIGxvbmdlciBidXN5XG5cdFx0dGhpcy5idXN5ID0gZmFsc2U7XG5cblx0XHQvLyBncmFiIHRhc2sgaWRcblx0XHRsZXQgaV90YXNrID0gaF9tc2cuaWQ7XG5cblx0XHR0aGlzLmRlYnVnKCc8PCByZXNwb25kJywgaV90YXNrKTtcblxuXHRcdC8vIGV4ZWN1dGUgY2FsbGJhY2tcblx0XHRoX2NhbGxiYWNrc1tpX3Rhc2tdKGhfbXNnLmRhdGEsIGlfdGFzaywgdGhpcyk7XG5cblx0XHQvLyBmcmVlIGNhbGxiYWNrXG5cdFx0ZGVsZXRlIGhfY2FsbGJhY2tzW2lfdGFza107XG5cdH1cblxuXHRoYW5kbGVfbm90aWZ5KGhfbXNnKSB7XG5cdFx0aF9tc2cuZGF0YSA9IEhQX1dPUktFUl9OT1RJRklDQVRJT047XG5cblx0XHQvLyBubyBsb25nZXIgYnVzeVxuXHRcdHRoaXMuYnVzeSA9IGZhbHNlO1xuXG5cdFx0dGhpcy5kZWJ1ZygnPDwgbm90aWZ5Jyk7XG5cblx0XHR0aGlzLmhhbmRsZV9yZXNwb25kKGhfbXNnKTtcblx0fVxuXG5cdGhhbmRsZV9ldmVudChoX21zZykge1xuXHRcdC8vIGV2ZW50IGlzIGd1YXJhbnRlZWQgdG8gYmUgaGVyZTsganVzdCBjYWxsYmFjayB3aXRoIGRhdGFcblx0XHR0aGlzLmV2ZW50c1toX21zZy5pZF1baF9tc2cuZXZlbnRdKC4uLmhfbXNnLmFyZ3MpO1xuXHR9XG5cblx0aGFuZGxlX2Vycm9yKGhfbXNnKSB7XG5cdFx0bGV0IGhfZXJyb3IgPSBoX21zZy5lcnJvcjtcblx0XHRsZXQgZV9tc2cgPSBuZXcgRXJyb3IoaF9lcnJvci5tZXNzYWdlKTtcblx0XHRlX21zZy5zdGFjayA9IGhfZXJyb3Iuc3RhY2s7XG5cblx0XHRpZiAodGhpcy50YXNrX2Vycm9yKSB7XG5cdFx0XHR0aGlzLnRhc2tfZXJyb3IoZV9tc2cpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aHJvdyBlX21zZztcblx0XHR9XG5cdH1cblxuXHRoYW5kbGVfc3Bhd24oaF9tc2cpIHtcblx0XHRsZXQgcF9zb3VyY2UgPSBwYXRoLmpvaW4ocGF0aC5kaXJuYW1lKHRoaXMuc291cmNlKSwgaF9tc2cuc291cmNlKTtcblx0XHRpZiAoJy8nICE9PSBwX3NvdXJjZVswXSkgcF9zb3VyY2UgPSAnLi8nICsgcF9zb3VyY2U7XG5cblx0XHRwX3NvdXJjZSA9IGhfbXNnLnNvdXJjZTtcblx0XHRsZXQgZF9zdWJ3b3JrZXIgPSBzcGF3bl93b3JrZXIocF9zb3VyY2UpO1xuXHRcdGxldCBpX3N1YndvcmtlciA9IHRoaXMuc3Vid29ya2Vycy5wdXNoKGRfc3Vid29ya2VyKSAtIDE7XG5cblx0XHRkX3N1Yndvcmtlci5ldmVudCgnZXJyb3InLCAoZV93b3JrZXIpID0+IHtcblx0XHRcdHRoaXMucG9ydC5wb3N0TWVzc2FnZSh7XG5cdFx0XHRcdHR5cGU6ICdzdWJ3b3JrZXJfZXJyb3InLFxuXHRcdFx0XHRlcnJvcjoge1xuXHRcdFx0XHRcdG1lc3NhZ2U6IGVfd29ya2VyLm1lc3NhZ2UsXG5cdFx0XHRcdFx0ZmlsZW5hbWU6IGVfd29ya2VyLmZpbGVuYW1lLFxuXHRcdFx0XHRcdGxpbmVubzogZV93b3JrZXIubGluZW5vLFxuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cblx0XHRsZXQga19jaGFubmVsID0gbmV3IERDX0NIQU5ORUwoKTtcblxuXHRcdGtfY2hhbm5lbC5wb3J0XzEoKGRfcG9ydCkgPT4ge1xuXHRcdFx0dGhpcy5wb3J0LnBvc3RQb3J0KGRfcG9ydCwge1xuXHRcdFx0XHR0eXBlOiAnc3Vid29ya2VyJyxcblx0XHRcdFx0aWQ6IGhfbXNnLmlkLFxuXHRcdFx0XHRtYXN0ZXJfa2V5OiBpX3N1Yndvcmtlcixcblx0XHRcdH0pO1xuXHRcdH0pO1xuXG5cdFx0a19jaGFubmVsLnBvcnRfMigoZF9wb3J0KSA9PiB7XG5cdFx0XHRkX3N1Yndvcmtlci5wb3N0UG9ydChkX3BvcnQsIHtcblx0XHRcdFx0dHlwZTogJ293bmVyJyxcblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9XG5cblx0aGFuZGxlX3BpbmcoKSB7XG5cdFx0S19TRUxGLnBvc3RNZXNzYWdlKHtcblx0XHRcdHR5cGU6ICdwb25nJyxcblx0XHR9KTtcblx0fVxuXG5cdGhhbmRsZV90ZXJtaW5hdGUoaF9tc2cpIHtcblx0XHR0aGlzLnN1YndvcmtlcnNbaF9tc2cubWFzdGVyX2tleV0udGVybWluYXRlKCk7XG5cdH1cblxuXHRwcmVwYXJlKGhfdGFzaywgZmtfdGFzaywgYV9yb290cyA9IFtdKSB7XG5cdFx0bGV0IGlfdGFzayA9ICsraV9ndWlkO1xuXG5cdFx0bGV0IHtcblx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHRcdG1hbmlmZXN0OiBrX21hbmlmZXN0LFxuXHRcdFx0cmVjZWl2ZTogaV9yZWNlaXZlID0gMCxcblx0XHRcdGluaGVyaXQ6IGlfaW5oZXJpdCA9IDAsXG5cdFx0XHRob2xkOiBiX2hvbGQgPSBmYWxzZSxcblx0XHRcdGV2ZW50czogaF9ldmVudHMgPSBudWxsLFxuXHRcdH0gPSBoX3Rhc2s7XG5cblx0XHQvLyBzYXZlIGNhbGxiYWNrXG5cdFx0dGhpcy5jYWxsYmFja3NbaV90YXNrXSA9IGZrX3Rhc2s7XG5cblx0XHQvLyBzYXZlIGV2ZW50c1xuXHRcdGlmIChoX2V2ZW50cykge1xuXHRcdFx0dGhpcy5ldmVudHNbaV90YXNrXSA9IGhfZXZlbnRzO1xuXG5cdFx0XHQvLyB3aGF0IHRvIHNlbmRcblx0XHRcdGxldCBoX2V2ZW50c19zZW5kID0ge307XG5cdFx0XHRmb3IgKGxldCBzX2tleSBpbiBoX2V2ZW50cykge1xuXHRcdFx0XHRoX2V2ZW50c19zZW5kW3Nfa2V5XSA9IDE7XG5cdFx0XHR9XG5cdFx0XHRoX2V2ZW50cyA9IGhfZXZlbnRzX3NlbmQ7XG5cdFx0fVxuXG5cdFx0Ly8gc2VuZCB0YXNrXG5cdFx0cmV0dXJuIHtcblx0XHRcdG1zZzoge1xuXHRcdFx0XHR0eXBlOiAndGFzaycsXG5cdFx0XHRcdGlkOiBpX3Rhc2ssXG5cdFx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHRcdFx0YXJnczoga19tYW5pZmVzdC5kYXRhLFxuXHRcdFx0XHRyZWNlaXZlOiBpX3JlY2VpdmUsXG5cdFx0XHRcdGluaGVyaXQ6IGlfaW5oZXJpdCxcblx0XHRcdFx0aG9sZDogYl9ob2xkLFxuXHRcdFx0XHRldmVudHM6IGhfZXZlbnRzLFxuXHRcdFx0fSxcblx0XHRcdHBhdGhzOiBrX21hbmlmZXN0LnBhdGhzKC4uLmFfcm9vdHMsICdhcmdzJyksXG5cdFx0fTtcblx0fVxuXG5cdGV4ZWMoaF90YXNrX2V4ZWMsIGZrX3Rhc2spIHtcblx0XHQvLyBtYXJrIHdvcmtlciBhcyBidXN5XG5cdFx0dGhpcy5idXN5ID0gdHJ1ZTtcblxuXHRcdC8vIHByZXBhcmUgZmluYWwgdGFzayBkZXNjcmlwdG9yXG5cdFx0bGV0IGhfdGFzayA9IHRoaXMucHJlcGFyZShoX3Rhc2tfZXhlYywgZmtfdGFzayk7XG5cblx0XHR0aGlzLmRlYnVnKCdleGVjOicgKyBoX3Rhc2subXNnLmlkKTtcblxuXHRcdC8vIHBvc3QgdG8gd29ya2VyXG5cdFx0dGhpcy5wb3J0LnBvc3RNZXNzYWdlKGhfdGFzay5tc2csIGhfdGFzay5wYXRocyk7XG5cdH1cblxuXHQvLyBhc3NpZ24gYSB0YXNrIHRvIHRoZSB3b3JrZXJcblx0cnVuKHNfdGFzaywgel9hcmdzLCBoX2V2ZW50cywgZmtfcnVuKSB7XG5cdFx0Ly8gcHJlcGFyZSBmaW5hbCB0YXNrIGRlc2NyaXB0b3Jcblx0XHRsZXQgaF9leGVjID0ge1xuXHRcdFx0dGFzazogc190YXNrLFxuXHRcdFx0bWFuaWZlc3Q6IG1hbmlmZXN0LmZyb20oel9hcmdzKSxcblx0XHRcdGV2ZW50czogaF9ldmVudHMsXG5cdFx0fTtcblxuXHRcdC8vIHByZXZpb3VzIHJ1biB0YXNrXG5cdFx0aWYgKHRoaXMucHJldl9ydW5fdGFzaykge1xuXHRcdFx0aF9leGVjLmluaGVyaXQgPSB0aGlzLnByZXZfcnVuX3Rhc2s7XG5cdFx0fVxuXG5cdFx0Ly8gZXhlY3V0ZSB0YXNrXG5cdFx0bGV0IGRwX2V4ZWMgPSBuZXcgUHJvbWlzZSgoZl9yZXNvbHZlLCBmX3JlamVjdCkgPT4ge1xuXHRcdFx0dGhpcy50YXNrX2Vycm9yID0gZl9yZWplY3Q7XG5cdFx0XHR0aGlzLmV4ZWMoaF9leGVjLCAoel9yZXN1bHQsIGlfdGFzaykgPT4ge1xuXHRcdFx0XHR0aGlzLnByZXZfcnVuX3Rhc2sgPSBpX3Rhc2s7XG5cdFx0XHRcdHRoaXMudGFza19lcnJvciA9IG51bGw7XG5cdFx0XHRcdGZfcmVzb2x2ZSh6X3Jlc3VsdCk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdC8vIGVtYmVkZGVkIHJlc29sdmUvcmVqZWN0XG5cdFx0aWYgKCdmdW5jdGlvbicgPT09IHR5cGVvZiBma19ydW4pIHtcblx0XHRcdGRwX2V4ZWMudGhlbigoel9yZXN1bHQpID0+IHtcblx0XHRcdFx0ZmtfcnVuKG51bGwsIHpfcmVzdWx0KTtcblx0XHRcdH0pLmNhdGNoKChlX2V4ZWMpID0+IHtcblx0XHRcdFx0ZmtfcnVuKGVfZXhlYyk7XG5cdFx0XHR9KTtcblx0XHR9XG5cdFx0Ly8gcHJvbWlzZVxuXHRcdGVsc2Uge1xuXHRcdFx0cmV0dXJuIGRwX2V4ZWM7XG5cdFx0fVxuXHR9XG5cblx0cmVjZWl2ZShkX3BvcnQsIGhfcmVjZWl2ZSwgZmtfdGFzaykge1xuXHRcdGxldCBoX3Rhc2sgPSB0aGlzLnByZXBhcmUoaF9yZWNlaXZlLnRhc2tfcmVhZHksIGZrX3Rhc2ssIFsndGFza19yZWFkeSddKTtcblxuXHRcdHRoaXMuZGVidWcoJz4+IHJlY2VpdmU6JyArIGhfcmVjZWl2ZS5pbXBvcnQsIGhfdGFzay5tc2cuaWQsIGRfcG9ydC5uYW1lKTtcblxuXHRcdHRoaXMucG9ydC5wb3N0UG9ydChkX3BvcnQsIHtcblx0XHRcdHR5cGU6ICdyZWNlaXZlJyxcblx0XHRcdGltcG9ydDogaF9yZWNlaXZlLmltcG9ydCxcblx0XHRcdHByaW1hcnk6IGhfcmVjZWl2ZS5wcmltYXJ5LFxuXHRcdFx0dGFza19yZWFkeTogaF90YXNrLm1zZyxcblx0XHR9LCBbLi4uKGhfdGFzay5wYXRocyB8fCBbXSldKTtcblx0fVxuXG5cdHJlbGF5KGlfdGFza19zZW5kZXIsIGRfcG9ydCwgc19yZWNlaXZlcikge1xuXHRcdHRoaXMuZGVidWcoJz4+IHJlbGF5JywgaV90YXNrX3NlbmRlciwgZF9wb3J0Lm5hbWUpO1xuXG5cdFx0dGhpcy5wb3J0LnBvc3RQb3J0KGRfcG9ydCwge1xuXHRcdFx0dHlwZTogJ3JlbGF5Jyxcblx0XHRcdGlkOiBpX3Rhc2tfc2VuZGVyLFxuXHRcdH0pO1xuXHR9XG5cblx0a2lsbChzX2tpbGwpIHtcblx0XHRpZiAoQl9CUk9XU0VSKSB7XG5cdFx0XHRyZXR1cm4gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSkgPT4ge1xuXHRcdFx0XHR0aGlzLnBvcnQudGVybWluYXRlKCk7XG5cdFx0XHRcdGZfcmVzb2x2ZSgpO1xuXHRcdFx0fSk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHJldHVybiB0aGlzLnBvcnQudGVybWluYXRlKHNfa2lsbCk7XG5cdFx0fVxuXHR9XG59XG5cblxuY29uc3QgbWtfbmV3ID0gKGRjKSA9PiBmdW5jdGlvbiguLi5hX2FyZ3MpIHtcblx0cmV0dXJuIG5ldyBkYyguLi5hX2FyZ3MpO1xufTtcblxuLy8gbm93IGltcG9ydCBhbnloaW5nIHRoYXQgZGVwZW5kcyBvbiB3b3JrZXJcbmNvbnN0IGdyb3VwID0gcmVxdWlyZSgnLi9hbGwvZ3JvdXAuanMnKSh3b3JrZXIpO1xuXG5jb25zdCBIX0VYUE9SVFMgPSB7XG5cdHNwYXduKC4uLmFfYXJncykge1xuXHRcdHJldHVybiB3b3JrZXIuZnJvbV9zb3VyY2UoLi4uYV9hcmdzKTtcblx0fSxcblxuXHRuZXc6ICguLi5hX2FyZ3MpID0+IG5ldyB3b3JrZXIoLi4uYV9hcmdzKSxcblx0Z3JvdXA6IG1rX25ldyhncm91cCksXG5cdHBvb2w6IG1rX25ldyhwb29sKSxcblx0ZGVkaWNhdGVkOiBta19uZXcoZGVkaWNhdGVkKSxcblx0bWFuaWZlc3Q6IG1rX25ldyhtYW5pZmVzdCksXG5cdHJlc3VsdDogbWtfbmV3KHJlc3VsdCksXG5cdC8vIHN0cmVhbTogbWtfbmV3KHdyaXRhYmxlX3N0cmVhbSksXG5cblx0Ly8gc3RhdGVzXG5cdGJyb3dzZXI6IEJfQlJPV1NFUixcblx0YnJvd3NlcmlmeTogQl9CUk9XU0VSSUZZLFxuXHQvLyBkZXB0aDogV09SS0VSX0RFUFRIXG5cblx0Ly8gaW1wb3J0IHR5cGVkIGFycmF5cyBpbnRvIHRoZSBnaXZlbiBzY29wZVxuXHRnbG9iYWxzOiAoaF9zY29wZSA9IHt9KSA9PiBPYmplY3QuYXNzaWduKGhfc2NvcGUsIEhfVFlQRURfQVJSQVlTLmV4cG9ydHMpLFxuXG5cdC8vIGZvciBjb21wYXRpYmlsaXR5IHdpdGggYnJvd3NlcmlmeVxuXHRzY29waWZ5KGZfcmVxdWlyZSwgYV9zb3VyY2VzLCBkX2FyZ3VtZW50cykge1xuXHRcdC8vIGJyb3dzZXJpZnkgYXJndW1lbnRzXG5cdFx0bGV0IGFfYnJvd3NlcmlmeSA9IGRfYXJndW1lbnRzID8gW2RfYXJndW1lbnRzWzNdLCBkX2FyZ3VtZW50c1s0XSwgZF9hcmd1bWVudHNbNV1dIDogbnVsbDtcblxuXHRcdC8vIHJ1bm5pbmcgaW4gYnJvd3NlcmlmeVxuXHRcdGlmIChCX0JST1dTRVJJRlkpIHtcblx0XHRcdC8vIGNoYW5nZSBob3cgYSB3b3JrZXIgaXMgc3Bhd25lZFxuXHRcdFx0c3Bhd25fd29ya2VyID0gKHBfc291cmNlLCBoX29wdGlvbnMpID0+IHtcblx0XHRcdFx0Ly8gd29ya2Fyb3VuZCBmb3IgY2hyb21pdW0gYnVnIHRoYXQgY2Fubm90IHNwYXduIHN1YndvcmtlcnNcblx0XHRcdFx0aWYgKCFCX1dPUktFUl9TVVBQT1JURUQpIHtcblx0XHRcdFx0XHRsZXQga19zdWJ3b3JrZXIgPSBuZXcgbGF0ZW50X3N1YndvcmtlcigpO1xuXG5cdFx0XHRcdFx0Ly8gc2VuZCBtZXNzYWdlIHRvIG1hc3RlciByZXF1ZXN0aW5nIHNwYXduIG9mIG5ldyB3b3JrZXJcblx0XHRcdFx0XHRLX1NFTEYucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0XHRcdFx0dHlwZTogJ3NwYXduJyxcblx0XHRcdFx0XHRcdGlkOiBrX3N1Yndvcmtlci5pZCxcblx0XHRcdFx0XHRcdHNvdXJjZTogcF9zb3VyY2UsXG5cdFx0XHRcdFx0XHRvcHRpb25zOiBoX29wdGlvbnMsXG5cdFx0XHRcdFx0fSk7XG5cblx0XHRcdFx0XHRyZXR1cm4ga19zdWJ3b3JrZXI7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gd29ya2VyIGlzIGRlZmluZWRcblx0XHRcdFx0ZWxzZSB7XG5cdFx0XHRcdFx0bGV0IHpfaW1wb3J0ID0gZl9yZXF1aXJlKHBfc291cmNlKTtcblx0XHRcdFx0XHRyZXR1cm4gd2Vid29ya2VyaWZ5KHpfaW1wb3J0LCB7XG5cdFx0XHRcdFx0XHRicm93c2VyaWZ5OiBhX2Jyb3dzZXJpZnksXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH1cblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0Ly8gbm9ybWFsIGV4cG9ydHNcblx0XHRyZXR1cm4gSF9FWFBPUlRTO1xuXHR9LFxuXG5cdC8vIGdldCBzdHJlYW0oKSB7XG5cdC8vIFx0ZGVsZXRlIHRoaXMuc3RyZWFtO1xuXHQvLyBcdHJldHVybiB0aGlzLnN0cmVhbSA9IHJlcXVpcmUoJy4vc3RyZWFtLmpzJyk7XG5cdC8vIH0sXG5cblx0bWVyZ2Vfc29ydGVkKGFfYSwgYV9iLCBmX2NtcCkge1xuXHRcdC8vIG91dHB1dCBsaXN0XG5cdFx0bGV0IGFfb3V0ID0gW107XG5cblx0XHQvLyBpbmRleCBvZiBuZXh0IGl0ZW0gZnJvbSBlYWNoIGxpc3Rcblx0XHRsZXQgaV9hID0gMDtcblx0XHRsZXQgaV9iID0gMDtcblxuXHRcdC8vIGN1cnJlbnQgaXRlbSBmcm9tIGVhY2ggbGlzdFxuXHRcdGxldCB6X2EgPSBhX2FbMF07XG5cdFx0bGV0IHpfYiA9IGFfYlswXTtcblxuXHRcdC8vIGZpbmFsIGluZGV4IG9mIGVhY2ggbGlzdFxuXHRcdGxldCBpaF9hID0gYV9hLmxlbmd0aCAtIDE7XG5cdFx0bGV0IGloX2IgPSBhX2IubGVuZ3RoIC0gMTtcblxuXHRcdC8vIG1lcmdlXG5cdFx0Zm9yICg7Oykge1xuXHRcdFx0Ly8gYSB3aW5zXG5cdFx0XHRpZiAoZl9jbXAoel9hLCB6X2IpIDwgMCkge1xuXHRcdFx0XHQvLyBhZGQgdG8gb3V0cHV0IGxpc3Rcblx0XHRcdFx0YV9vdXQucHVzaCh6X2EpO1xuXG5cdFx0XHRcdC8vIHJlYWNoZWQgZW5kIG9mIGFcblx0XHRcdFx0aWYgKGlfYSA9PT0gaWhfYSkgYnJlYWs7XG5cblx0XHRcdFx0Ly8gbmV4dCBpdGVtIGZyb20gYVxuXHRcdFx0XHR6X2EgPSBhX2FbKytpX2FdO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYiB3aW5zXG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0Ly8gYWRkIHRvIG91dHB1dCBsaXN0XG5cdFx0XHRcdGFfb3V0LnB1c2goel9iKTtcblxuXHRcdFx0XHQvLyByZWFjaGVkIGVuZCBvZiBiXG5cdFx0XHRcdGlmIChpX2IgPT09IGloX2IpIGJyZWFrO1xuXG5cdFx0XHRcdC8vIG5leHQgaXRlbSBmcm9tIGJcblx0XHRcdFx0el9iID0gYV9iWysraV9iXTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBhIGZpbmlzaGVkIGZpcnN0XG5cdFx0aWYgKGlfYSA9PT0gaWhfYSkge1xuXHRcdFx0Ly8gYXBwZW5kIHJlbWFpbmRlciBvZiBiXG5cdFx0XHRhX291dC5wdXNoKGFfYi5zbGljZShpX2IpKTtcblx0XHR9XG5cdFx0Ly8gYiBmaW5pc2hlZCBmaXJzdFxuXHRcdGVsc2Uge1xuXHRcdFx0Ly8gYXBwZW5kIHJlbWFpbmRlciBvZiBhXG5cdFx0XHRhX291dC5wdXNoKGFfYS5zbGljZShpX2EpKTtcblx0XHR9XG5cblx0XHQvLyByZXN1bHRcblx0XHRyZXR1cm4gYV9vdXQ7XG5cdH0sXG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IE9iamVjdC5hc3NpZ24oZnVuY3Rpb24oLi4uYV9hcmdzKSB7XG5cdC8vIGNhbGxlZCBmcm9tIHdvcmtlclxuXHRpZiAoWE1fQ09OVEVYVF9XT1JLRVIgJiBYX0NPTlRFWFRfVFlQRSkge1xuXHRcdC8vIGRlZGljYXRlZCB3b3JrZXJcblx0XHRpZiAoWE1fQ09OVEVYVF9XT1JLRVJfREVESUNBVEVEID09PSBYX0NPTlRFWFRfVFlQRSkge1xuXHRcdFx0cmV0dXJuIG5ldyBkZWRpY2F0ZWQoLi4uYV9hcmdzKTtcblx0XHR9XG5cdFx0Ly8gc2hhcmVkIHdvcmtlclxuXHRcdGVsc2UgaWYgKFhNX0NPTlRFWFRfV09SS0VSX1NIQVJFRCA9PT0gWF9DT05URVhUX1RZUEUpIHtcblx0XHRcdC8vIHJldHVybiBuZXcgc2hhcmVkKC4uLmFfYXJncyk7XG5cdFx0fVxuXHRcdC8vIHNlcnZpY2Ugd29ya2VyXG5cdFx0ZWxzZSBpZiAoWE1fQ09OVEVYVF9XT1JLRVJfU0VSVklDRSA9PT0gWF9DT05URVhUX1RZUEUpIHtcblx0XHRcdC8vIHJldHVybiBuZXcgc2VydmljZSguLi5hX2FyZ3MpO1xuXHRcdH1cblx0fVxuXHQvLyBjaGlsZCBwcm9jZXNzOyBkZWRpY2F0ZWQgd29ya2VyXG5cdGVsc2UgaWYgKFhNX0NPTlRFWFRfUFJPQ0VTU19DSElMRCA9PT0gWF9DT05URVhUX1RZUEUpIHtcblx0XHRyZXR1cm4gbmV3IGRlZGljYXRlZCguLi5hX2FyZ3MpO1xuXHR9XG5cdC8vIG1hc3RlclxuXHRlbHNlIHtcblx0XHRyZXR1cm4gd29ya2VyLmZyb21fc291cmNlKC4uLmFfYXJncyk7XG5cdH1cbn0sIEhfRVhQT1JUUyk7IiwiJ3VzZSBzdHJpY3QnO1xuXG4vLyBjb21wYXJlIGFuZCBpc0J1ZmZlciB0YWtlbiBmcm9tIGh0dHBzOi8vZ2l0aHViLmNvbS9mZXJvc3MvYnVmZmVyL2Jsb2IvNjgwZTllNWU0ODhmMjJhYWMyNzU5OWE1N2RjODQ0YTYzMTU5MjhkZC9pbmRleC5qc1xuLy8gb3JpZ2luYWwgbm90aWNlOlxuXG4vKiFcbiAqIFRoZSBidWZmZXIgbW9kdWxlIGZyb20gbm9kZS5qcywgZm9yIHRoZSBicm93c2VyLlxuICpcbiAqIEBhdXRob3IgICBGZXJvc3MgQWJvdWtoYWRpamVoIDxmZXJvc3NAZmVyb3NzLm9yZz4gPGh0dHA6Ly9mZXJvc3Mub3JnPlxuICogQGxpY2Vuc2UgIE1JVFxuICovXG5mdW5jdGlvbiBjb21wYXJlKGEsIGIpIHtcbiAgaWYgKGEgPT09IGIpIHtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIHZhciB4ID0gYS5sZW5ndGg7XG4gIHZhciB5ID0gYi5sZW5ndGg7XG5cbiAgZm9yICh2YXIgaSA9IDAsIGxlbiA9IE1hdGgubWluKHgsIHkpOyBpIDwgbGVuOyArK2kpIHtcbiAgICBpZiAoYVtpXSAhPT0gYltpXSkge1xuICAgICAgeCA9IGFbaV07XG4gICAgICB5ID0gYltpXTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIGlmICh4IDwgeSkge1xuICAgIHJldHVybiAtMTtcbiAgfVxuICBpZiAoeSA8IHgpIHtcbiAgICByZXR1cm4gMTtcbiAgfVxuICByZXR1cm4gMDtcbn1cbmZ1bmN0aW9uIGlzQnVmZmVyKGIpIHtcbiAgaWYgKGdsb2JhbC5CdWZmZXIgJiYgdHlwZW9mIGdsb2JhbC5CdWZmZXIuaXNCdWZmZXIgPT09ICdmdW5jdGlvbicpIHtcbiAgICByZXR1cm4gZ2xvYmFsLkJ1ZmZlci5pc0J1ZmZlcihiKTtcbiAgfVxuICByZXR1cm4gISEoYiAhPSBudWxsICYmIGIuX2lzQnVmZmVyKTtcbn1cblxuLy8gYmFzZWQgb24gbm9kZSBhc3NlcnQsIG9yaWdpbmFsIG5vdGljZTpcblxuLy8gaHR0cDovL3dpa2kuY29tbW9uanMub3JnL3dpa2kvVW5pdF9UZXN0aW5nLzEuMFxuLy9cbi8vIFRISVMgSVMgTk9UIFRFU1RFRCBOT1IgTElLRUxZIFRPIFdPUksgT1VUU0lERSBWOCFcbi8vXG4vLyBPcmlnaW5hbGx5IGZyb20gbmFyd2hhbC5qcyAoaHR0cDovL25hcndoYWxqcy5vcmcpXG4vLyBDb3B5cmlnaHQgKGMpIDIwMDkgVGhvbWFzIFJvYmluc29uIDwyODBub3J0aC5jb20+XG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weVxuLy8gb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGUgJ1NvZnR3YXJlJyksIHRvXG4vLyBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZVxuLy8gcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yXG4vLyBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuLy8gZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpblxuLy8gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEICdBUyBJUycsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1Jcbi8vIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLFxuLy8gRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4vLyBBVVRIT1JTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTlxuLy8gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTlxuLy8gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbnZhciB1dGlsID0gcmVxdWlyZSgndXRpbC8nKTtcbnZhciBoYXNPd24gPSBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5O1xudmFyIHBTbGljZSA9IEFycmF5LnByb3RvdHlwZS5zbGljZTtcbnZhciBmdW5jdGlvbnNIYXZlTmFtZXMgPSAoZnVuY3Rpb24gKCkge1xuICByZXR1cm4gZnVuY3Rpb24gZm9vKCkge30ubmFtZSA9PT0gJ2Zvbyc7XG59KCkpO1xuZnVuY3Rpb24gcFRvU3RyaW5nIChvYmopIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChvYmopO1xufVxuZnVuY3Rpb24gaXNWaWV3KGFycmJ1Zikge1xuICBpZiAoaXNCdWZmZXIoYXJyYnVmKSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAodHlwZW9mIGdsb2JhbC5BcnJheUJ1ZmZlciAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAodHlwZW9mIEFycmF5QnVmZmVyLmlzVmlldyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiBBcnJheUJ1ZmZlci5pc1ZpZXcoYXJyYnVmKTtcbiAgfVxuICBpZiAoIWFycmJ1Zikge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAoYXJyYnVmIGluc3RhbmNlb2YgRGF0YVZpZXcpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAoYXJyYnVmLmJ1ZmZlciAmJiBhcnJidWYuYnVmZmVyIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG4vLyAxLiBUaGUgYXNzZXJ0IG1vZHVsZSBwcm92aWRlcyBmdW5jdGlvbnMgdGhhdCB0aHJvd1xuLy8gQXNzZXJ0aW9uRXJyb3IncyB3aGVuIHBhcnRpY3VsYXIgY29uZGl0aW9ucyBhcmUgbm90IG1ldC4gVGhlXG4vLyBhc3NlcnQgbW9kdWxlIG11c3QgY29uZm9ybSB0byB0aGUgZm9sbG93aW5nIGludGVyZmFjZS5cblxudmFyIGFzc2VydCA9IG1vZHVsZS5leHBvcnRzID0gb2s7XG5cbi8vIDIuIFRoZSBBc3NlcnRpb25FcnJvciBpcyBkZWZpbmVkIGluIGFzc2VydC5cbi8vIG5ldyBhc3NlcnQuQXNzZXJ0aW9uRXJyb3IoeyBtZXNzYWdlOiBtZXNzYWdlLFxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFjdHVhbDogYWN0dWFsLFxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4cGVjdGVkOiBleHBlY3RlZCB9KVxuXG52YXIgcmVnZXggPSAvXFxzKmZ1bmN0aW9uXFxzKyhbXlxcKFxcc10qKVxccyovO1xuLy8gYmFzZWQgb24gaHR0cHM6Ly9naXRodWIuY29tL2xqaGFyYi9mdW5jdGlvbi5wcm90b3R5cGUubmFtZS9ibG9iL2FkZWVlZWM4YmZjYzYwNjhiMTg3ZDdkOWZiM2Q1YmIxZDNhMzA4OTkvaW1wbGVtZW50YXRpb24uanNcbmZ1bmN0aW9uIGdldE5hbWUoZnVuYykge1xuICBpZiAoIXV0aWwuaXNGdW5jdGlvbihmdW5jKSkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoZnVuY3Rpb25zSGF2ZU5hbWVzKSB7XG4gICAgcmV0dXJuIGZ1bmMubmFtZTtcbiAgfVxuICB2YXIgc3RyID0gZnVuYy50b1N0cmluZygpO1xuICB2YXIgbWF0Y2ggPSBzdHIubWF0Y2gocmVnZXgpO1xuICByZXR1cm4gbWF0Y2ggJiYgbWF0Y2hbMV07XG59XG5hc3NlcnQuQXNzZXJ0aW9uRXJyb3IgPSBmdW5jdGlvbiBBc3NlcnRpb25FcnJvcihvcHRpb25zKSB7XG4gIHRoaXMubmFtZSA9ICdBc3NlcnRpb25FcnJvcic7XG4gIHRoaXMuYWN0dWFsID0gb3B0aW9ucy5hY3R1YWw7XG4gIHRoaXMuZXhwZWN0ZWQgPSBvcHRpb25zLmV4cGVjdGVkO1xuICB0aGlzLm9wZXJhdG9yID0gb3B0aW9ucy5vcGVyYXRvcjtcbiAgaWYgKG9wdGlvbnMubWVzc2FnZSkge1xuICAgIHRoaXMubWVzc2FnZSA9IG9wdGlvbnMubWVzc2FnZTtcbiAgICB0aGlzLmdlbmVyYXRlZE1lc3NhZ2UgPSBmYWxzZTtcbiAgfSBlbHNlIHtcbiAgICB0aGlzLm1lc3NhZ2UgPSBnZXRNZXNzYWdlKHRoaXMpO1xuICAgIHRoaXMuZ2VuZXJhdGVkTWVzc2FnZSA9IHRydWU7XG4gIH1cbiAgdmFyIHN0YWNrU3RhcnRGdW5jdGlvbiA9IG9wdGlvbnMuc3RhY2tTdGFydEZ1bmN0aW9uIHx8IGZhaWw7XG4gIGlmIChFcnJvci5jYXB0dXJlU3RhY2tUcmFjZSkge1xuICAgIEVycm9yLmNhcHR1cmVTdGFja1RyYWNlKHRoaXMsIHN0YWNrU3RhcnRGdW5jdGlvbik7XG4gIH0gZWxzZSB7XG4gICAgLy8gbm9uIHY4IGJyb3dzZXJzIHNvIHdlIGNhbiBoYXZlIGEgc3RhY2t0cmFjZVxuICAgIHZhciBlcnIgPSBuZXcgRXJyb3IoKTtcbiAgICBpZiAoZXJyLnN0YWNrKSB7XG4gICAgICB2YXIgb3V0ID0gZXJyLnN0YWNrO1xuXG4gICAgICAvLyB0cnkgdG8gc3RyaXAgdXNlbGVzcyBmcmFtZXNcbiAgICAgIHZhciBmbl9uYW1lID0gZ2V0TmFtZShzdGFja1N0YXJ0RnVuY3Rpb24pO1xuICAgICAgdmFyIGlkeCA9IG91dC5pbmRleE9mKCdcXG4nICsgZm5fbmFtZSk7XG4gICAgICBpZiAoaWR4ID49IDApIHtcbiAgICAgICAgLy8gb25jZSB3ZSBoYXZlIGxvY2F0ZWQgdGhlIGZ1bmN0aW9uIGZyYW1lXG4gICAgICAgIC8vIHdlIG5lZWQgdG8gc3RyaXAgb3V0IGV2ZXJ5dGhpbmcgYmVmb3JlIGl0IChhbmQgaXRzIGxpbmUpXG4gICAgICAgIHZhciBuZXh0X2xpbmUgPSBvdXQuaW5kZXhPZignXFxuJywgaWR4ICsgMSk7XG4gICAgICAgIG91dCA9IG91dC5zdWJzdHJpbmcobmV4dF9saW5lICsgMSk7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuc3RhY2sgPSBvdXQ7XG4gICAgfVxuICB9XG59O1xuXG4vLyBhc3NlcnQuQXNzZXJ0aW9uRXJyb3IgaW5zdGFuY2VvZiBFcnJvclxudXRpbC5pbmhlcml0cyhhc3NlcnQuQXNzZXJ0aW9uRXJyb3IsIEVycm9yKTtcblxuZnVuY3Rpb24gdHJ1bmNhdGUocywgbikge1xuICBpZiAodHlwZW9mIHMgPT09ICdzdHJpbmcnKSB7XG4gICAgcmV0dXJuIHMubGVuZ3RoIDwgbiA/IHMgOiBzLnNsaWNlKDAsIG4pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBzO1xuICB9XG59XG5mdW5jdGlvbiBpbnNwZWN0KHNvbWV0aGluZykge1xuICBpZiAoZnVuY3Rpb25zSGF2ZU5hbWVzIHx8ICF1dGlsLmlzRnVuY3Rpb24oc29tZXRoaW5nKSkge1xuICAgIHJldHVybiB1dGlsLmluc3BlY3Qoc29tZXRoaW5nKTtcbiAgfVxuICB2YXIgcmF3bmFtZSA9IGdldE5hbWUoc29tZXRoaW5nKTtcbiAgdmFyIG5hbWUgPSByYXduYW1lID8gJzogJyArIHJhd25hbWUgOiAnJztcbiAgcmV0dXJuICdbRnVuY3Rpb24nICsgIG5hbWUgKyAnXSc7XG59XG5mdW5jdGlvbiBnZXRNZXNzYWdlKHNlbGYpIHtcbiAgcmV0dXJuIHRydW5jYXRlKGluc3BlY3Qoc2VsZi5hY3R1YWwpLCAxMjgpICsgJyAnICtcbiAgICAgICAgIHNlbGYub3BlcmF0b3IgKyAnICcgK1xuICAgICAgICAgdHJ1bmNhdGUoaW5zcGVjdChzZWxmLmV4cGVjdGVkKSwgMTI4KTtcbn1cblxuLy8gQXQgcHJlc2VudCBvbmx5IHRoZSB0aHJlZSBrZXlzIG1lbnRpb25lZCBhYm92ZSBhcmUgdXNlZCBhbmRcbi8vIHVuZGVyc3Rvb2QgYnkgdGhlIHNwZWMuIEltcGxlbWVudGF0aW9ucyBvciBzdWIgbW9kdWxlcyBjYW4gcGFzc1xuLy8gb3RoZXIga2V5cyB0byB0aGUgQXNzZXJ0aW9uRXJyb3IncyBjb25zdHJ1Y3RvciAtIHRoZXkgd2lsbCBiZVxuLy8gaWdub3JlZC5cblxuLy8gMy4gQWxsIG9mIHRoZSBmb2xsb3dpbmcgZnVuY3Rpb25zIG11c3QgdGhyb3cgYW4gQXNzZXJ0aW9uRXJyb3Jcbi8vIHdoZW4gYSBjb3JyZXNwb25kaW5nIGNvbmRpdGlvbiBpcyBub3QgbWV0LCB3aXRoIGEgbWVzc2FnZSB0aGF0XG4vLyBtYXkgYmUgdW5kZWZpbmVkIGlmIG5vdCBwcm92aWRlZC4gIEFsbCBhc3NlcnRpb24gbWV0aG9kcyBwcm92aWRlXG4vLyBib3RoIHRoZSBhY3R1YWwgYW5kIGV4cGVjdGVkIHZhbHVlcyB0byB0aGUgYXNzZXJ0aW9uIGVycm9yIGZvclxuLy8gZGlzcGxheSBwdXJwb3Nlcy5cblxuZnVuY3Rpb24gZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCBvcGVyYXRvciwgc3RhY2tTdGFydEZ1bmN0aW9uKSB7XG4gIHRocm93IG5ldyBhc3NlcnQuQXNzZXJ0aW9uRXJyb3Ioe1xuICAgIG1lc3NhZ2U6IG1lc3NhZ2UsXG4gICAgYWN0dWFsOiBhY3R1YWwsXG4gICAgZXhwZWN0ZWQ6IGV4cGVjdGVkLFxuICAgIG9wZXJhdG9yOiBvcGVyYXRvcixcbiAgICBzdGFja1N0YXJ0RnVuY3Rpb246IHN0YWNrU3RhcnRGdW5jdGlvblxuICB9KTtcbn1cblxuLy8gRVhURU5TSU9OISBhbGxvd3MgZm9yIHdlbGwgYmVoYXZlZCBlcnJvcnMgZGVmaW5lZCBlbHNld2hlcmUuXG5hc3NlcnQuZmFpbCA9IGZhaWw7XG5cbi8vIDQuIFB1cmUgYXNzZXJ0aW9uIHRlc3RzIHdoZXRoZXIgYSB2YWx1ZSBpcyB0cnV0aHksIGFzIGRldGVybWluZWRcbi8vIGJ5ICEhZ3VhcmQuXG4vLyBhc3NlcnQub2soZ3VhcmQsIG1lc3NhZ2Vfb3B0KTtcbi8vIFRoaXMgc3RhdGVtZW50IGlzIGVxdWl2YWxlbnQgdG8gYXNzZXJ0LmVxdWFsKHRydWUsICEhZ3VhcmQsXG4vLyBtZXNzYWdlX29wdCk7LiBUbyB0ZXN0IHN0cmljdGx5IGZvciB0aGUgdmFsdWUgdHJ1ZSwgdXNlXG4vLyBhc3NlcnQuc3RyaWN0RXF1YWwodHJ1ZSwgZ3VhcmQsIG1lc3NhZ2Vfb3B0KTsuXG5cbmZ1bmN0aW9uIG9rKHZhbHVlLCBtZXNzYWdlKSB7XG4gIGlmICghdmFsdWUpIGZhaWwodmFsdWUsIHRydWUsIG1lc3NhZ2UsICc9PScsIGFzc2VydC5vayk7XG59XG5hc3NlcnQub2sgPSBvaztcblxuLy8gNS4gVGhlIGVxdWFsaXR5IGFzc2VydGlvbiB0ZXN0cyBzaGFsbG93LCBjb2VyY2l2ZSBlcXVhbGl0eSB3aXRoXG4vLyA9PS5cbi8vIGFzc2VydC5lcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlX29wdCk7XG5cbmFzc2VydC5lcXVhbCA9IGZ1bmN0aW9uIGVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgaWYgKGFjdHVhbCAhPSBleHBlY3RlZCkgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnPT0nLCBhc3NlcnQuZXF1YWwpO1xufTtcblxuLy8gNi4gVGhlIG5vbi1lcXVhbGl0eSBhc3NlcnRpb24gdGVzdHMgZm9yIHdoZXRoZXIgdHdvIG9iamVjdHMgYXJlIG5vdCBlcXVhbFxuLy8gd2l0aCAhPSBhc3NlcnQubm90RXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZV9vcHQpO1xuXG5hc3NlcnQubm90RXF1YWwgPSBmdW5jdGlvbiBub3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmIChhY3R1YWwgPT0gZXhwZWN0ZWQpIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsICchPScsIGFzc2VydC5ub3RFcXVhbCk7XG4gIH1cbn07XG5cbi8vIDcuIFRoZSBlcXVpdmFsZW5jZSBhc3NlcnRpb24gdGVzdHMgYSBkZWVwIGVxdWFsaXR5IHJlbGF0aW9uLlxuLy8gYXNzZXJ0LmRlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlX29wdCk7XG5cbmFzc2VydC5kZWVwRXF1YWwgPSBmdW5jdGlvbiBkZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICBpZiAoIV9kZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgZmFsc2UpKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnZGVlcEVxdWFsJywgYXNzZXJ0LmRlZXBFcXVhbCk7XG4gIH1cbn07XG5cbmFzc2VydC5kZWVwU3RyaWN0RXF1YWwgPSBmdW5jdGlvbiBkZWVwU3RyaWN0RXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICBpZiAoIV9kZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgdHJ1ZSkpIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsICdkZWVwU3RyaWN0RXF1YWwnLCBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKTtcbiAgfVxufTtcblxuZnVuY3Rpb24gX2RlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBzdHJpY3QsIG1lbW9zKSB7XG4gIC8vIDcuMS4gQWxsIGlkZW50aWNhbCB2YWx1ZXMgYXJlIGVxdWl2YWxlbnQsIGFzIGRldGVybWluZWQgYnkgPT09LlxuICBpZiAoYWN0dWFsID09PSBleHBlY3RlZCkge1xuICAgIHJldHVybiB0cnVlO1xuICB9IGVsc2UgaWYgKGlzQnVmZmVyKGFjdHVhbCkgJiYgaXNCdWZmZXIoZXhwZWN0ZWQpKSB7XG4gICAgcmV0dXJuIGNvbXBhcmUoYWN0dWFsLCBleHBlY3RlZCkgPT09IDA7XG5cbiAgLy8gNy4yLiBJZiB0aGUgZXhwZWN0ZWQgdmFsdWUgaXMgYSBEYXRlIG9iamVjdCwgdGhlIGFjdHVhbCB2YWx1ZSBpc1xuICAvLyBlcXVpdmFsZW50IGlmIGl0IGlzIGFsc28gYSBEYXRlIG9iamVjdCB0aGF0IHJlZmVycyB0byB0aGUgc2FtZSB0aW1lLlxuICB9IGVsc2UgaWYgKHV0aWwuaXNEYXRlKGFjdHVhbCkgJiYgdXRpbC5pc0RhdGUoZXhwZWN0ZWQpKSB7XG4gICAgcmV0dXJuIGFjdHVhbC5nZXRUaW1lKCkgPT09IGV4cGVjdGVkLmdldFRpbWUoKTtcblxuICAvLyA3LjMgSWYgdGhlIGV4cGVjdGVkIHZhbHVlIGlzIGEgUmVnRXhwIG9iamVjdCwgdGhlIGFjdHVhbCB2YWx1ZSBpc1xuICAvLyBlcXVpdmFsZW50IGlmIGl0IGlzIGFsc28gYSBSZWdFeHAgb2JqZWN0IHdpdGggdGhlIHNhbWUgc291cmNlIGFuZFxuICAvLyBwcm9wZXJ0aWVzIChgZ2xvYmFsYCwgYG11bHRpbGluZWAsIGBsYXN0SW5kZXhgLCBgaWdub3JlQ2FzZWApLlxuICB9IGVsc2UgaWYgKHV0aWwuaXNSZWdFeHAoYWN0dWFsKSAmJiB1dGlsLmlzUmVnRXhwKGV4cGVjdGVkKSkge1xuICAgIHJldHVybiBhY3R1YWwuc291cmNlID09PSBleHBlY3RlZC5zb3VyY2UgJiZcbiAgICAgICAgICAgYWN0dWFsLmdsb2JhbCA9PT0gZXhwZWN0ZWQuZ2xvYmFsICYmXG4gICAgICAgICAgIGFjdHVhbC5tdWx0aWxpbmUgPT09IGV4cGVjdGVkLm11bHRpbGluZSAmJlxuICAgICAgICAgICBhY3R1YWwubGFzdEluZGV4ID09PSBleHBlY3RlZC5sYXN0SW5kZXggJiZcbiAgICAgICAgICAgYWN0dWFsLmlnbm9yZUNhc2UgPT09IGV4cGVjdGVkLmlnbm9yZUNhc2U7XG5cbiAgLy8gNy40LiBPdGhlciBwYWlycyB0aGF0IGRvIG5vdCBib3RoIHBhc3MgdHlwZW9mIHZhbHVlID09ICdvYmplY3QnLFxuICAvLyBlcXVpdmFsZW5jZSBpcyBkZXRlcm1pbmVkIGJ5ID09LlxuICB9IGVsc2UgaWYgKChhY3R1YWwgPT09IG51bGwgfHwgdHlwZW9mIGFjdHVhbCAhPT0gJ29iamVjdCcpICYmXG4gICAgICAgICAgICAgKGV4cGVjdGVkID09PSBudWxsIHx8IHR5cGVvZiBleHBlY3RlZCAhPT0gJ29iamVjdCcpKSB7XG4gICAgcmV0dXJuIHN0cmljdCA/IGFjdHVhbCA9PT0gZXhwZWN0ZWQgOiBhY3R1YWwgPT0gZXhwZWN0ZWQ7XG5cbiAgLy8gSWYgYm90aCB2YWx1ZXMgYXJlIGluc3RhbmNlcyBvZiB0eXBlZCBhcnJheXMsIHdyYXAgdGhlaXIgdW5kZXJseWluZ1xuICAvLyBBcnJheUJ1ZmZlcnMgaW4gYSBCdWZmZXIgZWFjaCB0byBpbmNyZWFzZSBwZXJmb3JtYW5jZVxuICAvLyBUaGlzIG9wdGltaXphdGlvbiByZXF1aXJlcyB0aGUgYXJyYXlzIHRvIGhhdmUgdGhlIHNhbWUgdHlwZSBhcyBjaGVja2VkIGJ5XG4gIC8vIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcgKGFrYSBwVG9TdHJpbmcpLiBOZXZlciBwZXJmb3JtIGJpbmFyeVxuICAvLyBjb21wYXJpc29ucyBmb3IgRmxvYXQqQXJyYXlzLCB0aG91Z2gsIHNpbmNlIGUuZy4gKzAgPT09IC0wIGJ1dCB0aGVpclxuICAvLyBiaXQgcGF0dGVybnMgYXJlIG5vdCBpZGVudGljYWwuXG4gIH0gZWxzZSBpZiAoaXNWaWV3KGFjdHVhbCkgJiYgaXNWaWV3KGV4cGVjdGVkKSAmJlxuICAgICAgICAgICAgIHBUb1N0cmluZyhhY3R1YWwpID09PSBwVG9TdHJpbmcoZXhwZWN0ZWQpICYmXG4gICAgICAgICAgICAgIShhY3R1YWwgaW5zdGFuY2VvZiBGbG9hdDMyQXJyYXkgfHxcbiAgICAgICAgICAgICAgIGFjdHVhbCBpbnN0YW5jZW9mIEZsb2F0NjRBcnJheSkpIHtcbiAgICByZXR1cm4gY29tcGFyZShuZXcgVWludDhBcnJheShhY3R1YWwuYnVmZmVyKSxcbiAgICAgICAgICAgICAgICAgICBuZXcgVWludDhBcnJheShleHBlY3RlZC5idWZmZXIpKSA9PT0gMDtcblxuICAvLyA3LjUgRm9yIGFsbCBvdGhlciBPYmplY3QgcGFpcnMsIGluY2x1ZGluZyBBcnJheSBvYmplY3RzLCBlcXVpdmFsZW5jZSBpc1xuICAvLyBkZXRlcm1pbmVkIGJ5IGhhdmluZyB0aGUgc2FtZSBudW1iZXIgb2Ygb3duZWQgcHJvcGVydGllcyAoYXMgdmVyaWZpZWRcbiAgLy8gd2l0aCBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwpLCB0aGUgc2FtZSBzZXQgb2Yga2V5c1xuICAvLyAoYWx0aG91Z2ggbm90IG5lY2Vzc2FyaWx5IHRoZSBzYW1lIG9yZGVyKSwgZXF1aXZhbGVudCB2YWx1ZXMgZm9yIGV2ZXJ5XG4gIC8vIGNvcnJlc3BvbmRpbmcga2V5LCBhbmQgYW4gaWRlbnRpY2FsICdwcm90b3R5cGUnIHByb3BlcnR5LiBOb3RlOiB0aGlzXG4gIC8vIGFjY291bnRzIGZvciBib3RoIG5hbWVkIGFuZCBpbmRleGVkIHByb3BlcnRpZXMgb24gQXJyYXlzLlxuICB9IGVsc2UgaWYgKGlzQnVmZmVyKGFjdHVhbCkgIT09IGlzQnVmZmVyKGV4cGVjdGVkKSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfSBlbHNlIHtcbiAgICBtZW1vcyA9IG1lbW9zIHx8IHthY3R1YWw6IFtdLCBleHBlY3RlZDogW119O1xuXG4gICAgdmFyIGFjdHVhbEluZGV4ID0gbWVtb3MuYWN0dWFsLmluZGV4T2YoYWN0dWFsKTtcbiAgICBpZiAoYWN0dWFsSW5kZXggIT09IC0xKSB7XG4gICAgICBpZiAoYWN0dWFsSW5kZXggPT09IG1lbW9zLmV4cGVjdGVkLmluZGV4T2YoZXhwZWN0ZWQpKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIG1lbW9zLmFjdHVhbC5wdXNoKGFjdHVhbCk7XG4gICAgbWVtb3MuZXhwZWN0ZWQucHVzaChleHBlY3RlZCk7XG5cbiAgICByZXR1cm4gb2JqRXF1aXYoYWN0dWFsLCBleHBlY3RlZCwgc3RyaWN0LCBtZW1vcyk7XG4gIH1cbn1cblxuZnVuY3Rpb24gaXNBcmd1bWVudHMob2JqZWN0KSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwob2JqZWN0KSA9PSAnW29iamVjdCBBcmd1bWVudHNdJztcbn1cblxuZnVuY3Rpb24gb2JqRXF1aXYoYSwgYiwgc3RyaWN0LCBhY3R1YWxWaXNpdGVkT2JqZWN0cykge1xuICBpZiAoYSA9PT0gbnVsbCB8fCBhID09PSB1bmRlZmluZWQgfHwgYiA9PT0gbnVsbCB8fCBiID09PSB1bmRlZmluZWQpXG4gICAgcmV0dXJuIGZhbHNlO1xuICAvLyBpZiBvbmUgaXMgYSBwcmltaXRpdmUsIHRoZSBvdGhlciBtdXN0IGJlIHNhbWVcbiAgaWYgKHV0aWwuaXNQcmltaXRpdmUoYSkgfHwgdXRpbC5pc1ByaW1pdGl2ZShiKSlcbiAgICByZXR1cm4gYSA9PT0gYjtcbiAgaWYgKHN0cmljdCAmJiBPYmplY3QuZ2V0UHJvdG90eXBlT2YoYSkgIT09IE9iamVjdC5nZXRQcm90b3R5cGVPZihiKSlcbiAgICByZXR1cm4gZmFsc2U7XG4gIHZhciBhSXNBcmdzID0gaXNBcmd1bWVudHMoYSk7XG4gIHZhciBiSXNBcmdzID0gaXNBcmd1bWVudHMoYik7XG4gIGlmICgoYUlzQXJncyAmJiAhYklzQXJncykgfHwgKCFhSXNBcmdzICYmIGJJc0FyZ3MpKVxuICAgIHJldHVybiBmYWxzZTtcbiAgaWYgKGFJc0FyZ3MpIHtcbiAgICBhID0gcFNsaWNlLmNhbGwoYSk7XG4gICAgYiA9IHBTbGljZS5jYWxsKGIpO1xuICAgIHJldHVybiBfZGVlcEVxdWFsKGEsIGIsIHN0cmljdCk7XG4gIH1cbiAgdmFyIGthID0gb2JqZWN0S2V5cyhhKTtcbiAgdmFyIGtiID0gb2JqZWN0S2V5cyhiKTtcbiAgdmFyIGtleSwgaTtcbiAgLy8gaGF2aW5nIHRoZSBzYW1lIG51bWJlciBvZiBvd25lZCBwcm9wZXJ0aWVzIChrZXlzIGluY29ycG9yYXRlc1xuICAvLyBoYXNPd25Qcm9wZXJ0eSlcbiAgaWYgKGthLmxlbmd0aCAhPT0ga2IubGVuZ3RoKVxuICAgIHJldHVybiBmYWxzZTtcbiAgLy90aGUgc2FtZSBzZXQgb2Yga2V5cyAoYWx0aG91Z2ggbm90IG5lY2Vzc2FyaWx5IHRoZSBzYW1lIG9yZGVyKSxcbiAga2Euc29ydCgpO1xuICBrYi5zb3J0KCk7XG4gIC8vfn5+Y2hlYXAga2V5IHRlc3RcbiAgZm9yIChpID0ga2EubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICBpZiAoa2FbaV0gIT09IGtiW2ldKVxuICAgICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIC8vZXF1aXZhbGVudCB2YWx1ZXMgZm9yIGV2ZXJ5IGNvcnJlc3BvbmRpbmcga2V5LCBhbmRcbiAgLy9+fn5wb3NzaWJseSBleHBlbnNpdmUgZGVlcCB0ZXN0XG4gIGZvciAoaSA9IGthLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAga2V5ID0ga2FbaV07XG4gICAgaWYgKCFfZGVlcEVxdWFsKGFba2V5XSwgYltrZXldLCBzdHJpY3QsIGFjdHVhbFZpc2l0ZWRPYmplY3RzKSlcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gOC4gVGhlIG5vbi1lcXVpdmFsZW5jZSBhc3NlcnRpb24gdGVzdHMgZm9yIGFueSBkZWVwIGluZXF1YWxpdHkuXG4vLyBhc3NlcnQubm90RGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2Vfb3B0KTtcblxuYXNzZXJ0Lm5vdERlZXBFcXVhbCA9IGZ1bmN0aW9uIG5vdERlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmIChfZGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIGZhbHNlKSkge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJ25vdERlZXBFcXVhbCcsIGFzc2VydC5ub3REZWVwRXF1YWwpO1xuICB9XG59O1xuXG5hc3NlcnQubm90RGVlcFN0cmljdEVxdWFsID0gbm90RGVlcFN0cmljdEVxdWFsO1xuZnVuY3Rpb24gbm90RGVlcFN0cmljdEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgaWYgKF9kZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgdHJ1ZSkpIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsICdub3REZWVwU3RyaWN0RXF1YWwnLCBub3REZWVwU3RyaWN0RXF1YWwpO1xuICB9XG59XG5cblxuLy8gOS4gVGhlIHN0cmljdCBlcXVhbGl0eSBhc3NlcnRpb24gdGVzdHMgc3RyaWN0IGVxdWFsaXR5LCBhcyBkZXRlcm1pbmVkIGJ5ID09PS5cbi8vIGFzc2VydC5zdHJpY3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlX29wdCk7XG5cbmFzc2VydC5zdHJpY3RFcXVhbCA9IGZ1bmN0aW9uIHN0cmljdEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgaWYgKGFjdHVhbCAhPT0gZXhwZWN0ZWQpIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsICc9PT0nLCBhc3NlcnQuc3RyaWN0RXF1YWwpO1xuICB9XG59O1xuXG4vLyAxMC4gVGhlIHN0cmljdCBub24tZXF1YWxpdHkgYXNzZXJ0aW9uIHRlc3RzIGZvciBzdHJpY3QgaW5lcXVhbGl0eSwgYXNcbi8vIGRldGVybWluZWQgYnkgIT09LiAgYXNzZXJ0Lm5vdFN0cmljdEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2Vfb3B0KTtcblxuYXNzZXJ0Lm5vdFN0cmljdEVxdWFsID0gZnVuY3Rpb24gbm90U3RyaWN0RXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICBpZiAoYWN0dWFsID09PSBleHBlY3RlZCkge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJyE9PScsIGFzc2VydC5ub3RTdHJpY3RFcXVhbCk7XG4gIH1cbn07XG5cbmZ1bmN0aW9uIGV4cGVjdGVkRXhjZXB0aW9uKGFjdHVhbCwgZXhwZWN0ZWQpIHtcbiAgaWYgKCFhY3R1YWwgfHwgIWV4cGVjdGVkKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgaWYgKE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChleHBlY3RlZCkgPT0gJ1tvYmplY3QgUmVnRXhwXScpIHtcbiAgICByZXR1cm4gZXhwZWN0ZWQudGVzdChhY3R1YWwpO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBpZiAoYWN0dWFsIGluc3RhbmNlb2YgZXhwZWN0ZWQpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIC8vIElnbm9yZS4gIFRoZSBpbnN0YW5jZW9mIGNoZWNrIGRvZXNuJ3Qgd29yayBmb3IgYXJyb3cgZnVuY3Rpb25zLlxuICB9XG5cbiAgaWYgKEVycm9yLmlzUHJvdG90eXBlT2YoZXhwZWN0ZWQpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgcmV0dXJuIGV4cGVjdGVkLmNhbGwoe30sIGFjdHVhbCkgPT09IHRydWU7XG59XG5cbmZ1bmN0aW9uIF90cnlCbG9jayhibG9jaykge1xuICB2YXIgZXJyb3I7XG4gIHRyeSB7XG4gICAgYmxvY2soKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGVycm9yID0gZTtcbiAgfVxuICByZXR1cm4gZXJyb3I7XG59XG5cbmZ1bmN0aW9uIF90aHJvd3Moc2hvdWxkVGhyb3csIGJsb2NrLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICB2YXIgYWN0dWFsO1xuXG4gIGlmICh0eXBlb2YgYmxvY2sgIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdcImJsb2NrXCIgYXJndW1lbnQgbXVzdCBiZSBhIGZ1bmN0aW9uJyk7XG4gIH1cblxuICBpZiAodHlwZW9mIGV4cGVjdGVkID09PSAnc3RyaW5nJykge1xuICAgIG1lc3NhZ2UgPSBleHBlY3RlZDtcbiAgICBleHBlY3RlZCA9IG51bGw7XG4gIH1cblxuICBhY3R1YWwgPSBfdHJ5QmxvY2soYmxvY2spO1xuXG4gIG1lc3NhZ2UgPSAoZXhwZWN0ZWQgJiYgZXhwZWN0ZWQubmFtZSA/ICcgKCcgKyBleHBlY3RlZC5uYW1lICsgJykuJyA6ICcuJykgK1xuICAgICAgICAgICAgKG1lc3NhZ2UgPyAnICcgKyBtZXNzYWdlIDogJy4nKTtcblxuICBpZiAoc2hvdWxkVGhyb3cgJiYgIWFjdHVhbCkge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgJ01pc3NpbmcgZXhwZWN0ZWQgZXhjZXB0aW9uJyArIG1lc3NhZ2UpO1xuICB9XG5cbiAgdmFyIHVzZXJQcm92aWRlZE1lc3NhZ2UgPSB0eXBlb2YgbWVzc2FnZSA9PT0gJ3N0cmluZyc7XG4gIHZhciBpc1Vud2FudGVkRXhjZXB0aW9uID0gIXNob3VsZFRocm93ICYmIHV0aWwuaXNFcnJvcihhY3R1YWwpO1xuICB2YXIgaXNVbmV4cGVjdGVkRXhjZXB0aW9uID0gIXNob3VsZFRocm93ICYmIGFjdHVhbCAmJiAhZXhwZWN0ZWQ7XG5cbiAgaWYgKChpc1Vud2FudGVkRXhjZXB0aW9uICYmXG4gICAgICB1c2VyUHJvdmlkZWRNZXNzYWdlICYmXG4gICAgICBleHBlY3RlZEV4Y2VwdGlvbihhY3R1YWwsIGV4cGVjdGVkKSkgfHxcbiAgICAgIGlzVW5leHBlY3RlZEV4Y2VwdGlvbikge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgJ0dvdCB1bndhbnRlZCBleGNlcHRpb24nICsgbWVzc2FnZSk7XG4gIH1cblxuICBpZiAoKHNob3VsZFRocm93ICYmIGFjdHVhbCAmJiBleHBlY3RlZCAmJlxuICAgICAgIWV4cGVjdGVkRXhjZXB0aW9uKGFjdHVhbCwgZXhwZWN0ZWQpKSB8fCAoIXNob3VsZFRocm93ICYmIGFjdHVhbCkpIHtcbiAgICB0aHJvdyBhY3R1YWw7XG4gIH1cbn1cblxuLy8gMTEuIEV4cGVjdGVkIHRvIHRocm93IGFuIGVycm9yOlxuLy8gYXNzZXJ0LnRocm93cyhibG9jaywgRXJyb3Jfb3B0LCBtZXNzYWdlX29wdCk7XG5cbmFzc2VydC50aHJvd3MgPSBmdW5jdGlvbihibG9jaywgLypvcHRpb25hbCovZXJyb3IsIC8qb3B0aW9uYWwqL21lc3NhZ2UpIHtcbiAgX3Rocm93cyh0cnVlLCBibG9jaywgZXJyb3IsIG1lc3NhZ2UpO1xufTtcblxuLy8gRVhURU5TSU9OISBUaGlzIGlzIGFubm95aW5nIHRvIHdyaXRlIG91dHNpZGUgdGhpcyBtb2R1bGUuXG5hc3NlcnQuZG9lc05vdFRocm93ID0gZnVuY3Rpb24oYmxvY2ssIC8qb3B0aW9uYWwqL2Vycm9yLCAvKm9wdGlvbmFsKi9tZXNzYWdlKSB7XG4gIF90aHJvd3MoZmFsc2UsIGJsb2NrLCBlcnJvciwgbWVzc2FnZSk7XG59O1xuXG5hc3NlcnQuaWZFcnJvciA9IGZ1bmN0aW9uKGVycikgeyBpZiAoZXJyKSB0aHJvdyBlcnI7IH07XG5cbnZhciBvYmplY3RLZXlzID0gT2JqZWN0LmtleXMgfHwgZnVuY3Rpb24gKG9iaikge1xuICB2YXIga2V5cyA9IFtdO1xuICBmb3IgKHZhciBrZXkgaW4gb2JqKSB7XG4gICAgaWYgKGhhc093bi5jYWxsKG9iaiwga2V5KSkga2V5cy5wdXNoKGtleSk7XG4gIH1cbiAgcmV0dXJuIGtleXM7XG59O1xuIiwiLy8gQ29weXJpZ2h0IEpveWVudCwgSW5jLiBhbmQgb3RoZXIgTm9kZSBjb250cmlidXRvcnMuXG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGFcbi8vIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGVcbi8vIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZ1xuLy8gd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLFxuLy8gZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdFxuLy8gcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlXG4vLyBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZFxuLy8gaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTU1xuLy8gT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRlxuLy8gTUVSQ0hBTlRBQklMSVRZLCBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTlxuLy8gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sXG4vLyBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1Jcbi8vIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEVcbi8vIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbmZ1bmN0aW9uIEV2ZW50RW1pdHRlcigpIHtcbiAgdGhpcy5fZXZlbnRzID0gdGhpcy5fZXZlbnRzIHx8IHt9O1xuICB0aGlzLl9tYXhMaXN0ZW5lcnMgPSB0aGlzLl9tYXhMaXN0ZW5lcnMgfHwgdW5kZWZpbmVkO1xufVxubW9kdWxlLmV4cG9ydHMgPSBFdmVudEVtaXR0ZXI7XG5cbi8vIEJhY2t3YXJkcy1jb21wYXQgd2l0aCBub2RlIDAuMTAueFxuRXZlbnRFbWl0dGVyLkV2ZW50RW1pdHRlciA9IEV2ZW50RW1pdHRlcjtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5fZXZlbnRzID0gdW5kZWZpbmVkO1xuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5fbWF4TGlzdGVuZXJzID0gdW5kZWZpbmVkO1xuXG4vLyBCeSBkZWZhdWx0IEV2ZW50RW1pdHRlcnMgd2lsbCBwcmludCBhIHdhcm5pbmcgaWYgbW9yZSB0aGFuIDEwIGxpc3RlbmVycyBhcmVcbi8vIGFkZGVkIHRvIGl0LiBUaGlzIGlzIGEgdXNlZnVsIGRlZmF1bHQgd2hpY2ggaGVscHMgZmluZGluZyBtZW1vcnkgbGVha3MuXG5FdmVudEVtaXR0ZXIuZGVmYXVsdE1heExpc3RlbmVycyA9IDEwO1xuXG4vLyBPYnZpb3VzbHkgbm90IGFsbCBFbWl0dGVycyBzaG91bGQgYmUgbGltaXRlZCB0byAxMC4gVGhpcyBmdW5jdGlvbiBhbGxvd3Ncbi8vIHRoYXQgdG8gYmUgaW5jcmVhc2VkLiBTZXQgdG8gemVybyBmb3IgdW5saW1pdGVkLlxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5zZXRNYXhMaXN0ZW5lcnMgPSBmdW5jdGlvbihuKSB7XG4gIGlmICghaXNOdW1iZXIobikgfHwgbiA8IDAgfHwgaXNOYU4obikpXG4gICAgdGhyb3cgVHlwZUVycm9yKCduIG11c3QgYmUgYSBwb3NpdGl2ZSBudW1iZXInKTtcbiAgdGhpcy5fbWF4TGlzdGVuZXJzID0gbjtcbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmVtaXQgPSBmdW5jdGlvbih0eXBlKSB7XG4gIHZhciBlciwgaGFuZGxlciwgbGVuLCBhcmdzLCBpLCBsaXN0ZW5lcnM7XG5cbiAgaWYgKCF0aGlzLl9ldmVudHMpXG4gICAgdGhpcy5fZXZlbnRzID0ge307XG5cbiAgLy8gSWYgdGhlcmUgaXMgbm8gJ2Vycm9yJyBldmVudCBsaXN0ZW5lciB0aGVuIHRocm93LlxuICBpZiAodHlwZSA9PT0gJ2Vycm9yJykge1xuICAgIGlmICghdGhpcy5fZXZlbnRzLmVycm9yIHx8XG4gICAgICAgIChpc09iamVjdCh0aGlzLl9ldmVudHMuZXJyb3IpICYmICF0aGlzLl9ldmVudHMuZXJyb3IubGVuZ3RoKSkge1xuICAgICAgZXIgPSBhcmd1bWVudHNbMV07XG4gICAgICBpZiAoZXIgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgICAgICB0aHJvdyBlcjsgLy8gVW5oYW5kbGVkICdlcnJvcicgZXZlbnRcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIEF0IGxlYXN0IGdpdmUgc29tZSBraW5kIG9mIGNvbnRleHQgdG8gdGhlIHVzZXJcbiAgICAgICAgdmFyIGVyciA9IG5ldyBFcnJvcignVW5jYXVnaHQsIHVuc3BlY2lmaWVkIFwiZXJyb3JcIiBldmVudC4gKCcgKyBlciArICcpJyk7XG4gICAgICAgIGVyci5jb250ZXh0ID0gZXI7XG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBoYW5kbGVyID0gdGhpcy5fZXZlbnRzW3R5cGVdO1xuXG4gIGlmIChpc1VuZGVmaW5lZChoYW5kbGVyKSlcbiAgICByZXR1cm4gZmFsc2U7XG5cbiAgaWYgKGlzRnVuY3Rpb24oaGFuZGxlcikpIHtcbiAgICBzd2l0Y2ggKGFyZ3VtZW50cy5sZW5ndGgpIHtcbiAgICAgIC8vIGZhc3QgY2FzZXNcbiAgICAgIGNhc2UgMTpcbiAgICAgICAgaGFuZGxlci5jYWxsKHRoaXMpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgMjpcbiAgICAgICAgaGFuZGxlci5jYWxsKHRoaXMsIGFyZ3VtZW50c1sxXSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAzOlxuICAgICAgICBoYW5kbGVyLmNhbGwodGhpcywgYXJndW1lbnRzWzFdLCBhcmd1bWVudHNbMl0pO1xuICAgICAgICBicmVhaztcbiAgICAgIC8vIHNsb3dlclxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgICAgIGhhbmRsZXIuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICB9IGVsc2UgaWYgKGlzT2JqZWN0KGhhbmRsZXIpKSB7XG4gICAgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgbGlzdGVuZXJzID0gaGFuZGxlci5zbGljZSgpO1xuICAgIGxlbiA9IGxpc3RlbmVycy5sZW5ndGg7XG4gICAgZm9yIChpID0gMDsgaSA8IGxlbjsgaSsrKVxuICAgICAgbGlzdGVuZXJzW2ldLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICB9XG5cbiAgcmV0dXJuIHRydWU7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmFkZExpc3RlbmVyID0gZnVuY3Rpb24odHlwZSwgbGlzdGVuZXIpIHtcbiAgdmFyIG07XG5cbiAgaWYgKCFpc0Z1bmN0aW9uKGxpc3RlbmVyKSlcbiAgICB0aHJvdyBUeXBlRXJyb3IoJ2xpc3RlbmVyIG11c3QgYmUgYSBmdW5jdGlvbicpO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzKVxuICAgIHRoaXMuX2V2ZW50cyA9IHt9O1xuXG4gIC8vIFRvIGF2b2lkIHJlY3Vyc2lvbiBpbiB0aGUgY2FzZSB0aGF0IHR5cGUgPT09IFwibmV3TGlzdGVuZXJcIiEgQmVmb3JlXG4gIC8vIGFkZGluZyBpdCB0byB0aGUgbGlzdGVuZXJzLCBmaXJzdCBlbWl0IFwibmV3TGlzdGVuZXJcIi5cbiAgaWYgKHRoaXMuX2V2ZW50cy5uZXdMaXN0ZW5lcilcbiAgICB0aGlzLmVtaXQoJ25ld0xpc3RlbmVyJywgdHlwZSxcbiAgICAgICAgICAgICAgaXNGdW5jdGlvbihsaXN0ZW5lci5saXN0ZW5lcikgP1xuICAgICAgICAgICAgICBsaXN0ZW5lci5saXN0ZW5lciA6IGxpc3RlbmVyKTtcblxuICBpZiAoIXRoaXMuX2V2ZW50c1t0eXBlXSlcbiAgICAvLyBPcHRpbWl6ZSB0aGUgY2FzZSBvZiBvbmUgbGlzdGVuZXIuIERvbid0IG5lZWQgdGhlIGV4dHJhIGFycmF5IG9iamVjdC5cbiAgICB0aGlzLl9ldmVudHNbdHlwZV0gPSBsaXN0ZW5lcjtcbiAgZWxzZSBpZiAoaXNPYmplY3QodGhpcy5fZXZlbnRzW3R5cGVdKSlcbiAgICAvLyBJZiB3ZSd2ZSBhbHJlYWR5IGdvdCBhbiBhcnJheSwganVzdCBhcHBlbmQuXG4gICAgdGhpcy5fZXZlbnRzW3R5cGVdLnB1c2gobGlzdGVuZXIpO1xuICBlbHNlXG4gICAgLy8gQWRkaW5nIHRoZSBzZWNvbmQgZWxlbWVudCwgbmVlZCB0byBjaGFuZ2UgdG8gYXJyYXkuXG4gICAgdGhpcy5fZXZlbnRzW3R5cGVdID0gW3RoaXMuX2V2ZW50c1t0eXBlXSwgbGlzdGVuZXJdO1xuXG4gIC8vIENoZWNrIGZvciBsaXN0ZW5lciBsZWFrXG4gIGlmIChpc09iamVjdCh0aGlzLl9ldmVudHNbdHlwZV0pICYmICF0aGlzLl9ldmVudHNbdHlwZV0ud2FybmVkKSB7XG4gICAgaWYgKCFpc1VuZGVmaW5lZCh0aGlzLl9tYXhMaXN0ZW5lcnMpKSB7XG4gICAgICBtID0gdGhpcy5fbWF4TGlzdGVuZXJzO1xuICAgIH0gZWxzZSB7XG4gICAgICBtID0gRXZlbnRFbWl0dGVyLmRlZmF1bHRNYXhMaXN0ZW5lcnM7XG4gICAgfVxuXG4gICAgaWYgKG0gJiYgbSA+IDAgJiYgdGhpcy5fZXZlbnRzW3R5cGVdLmxlbmd0aCA+IG0pIHtcbiAgICAgIHRoaXMuX2V2ZW50c1t0eXBlXS53YXJuZWQgPSB0cnVlO1xuICAgICAgY29uc29sZS5lcnJvcignKG5vZGUpIHdhcm5pbmc6IHBvc3NpYmxlIEV2ZW50RW1pdHRlciBtZW1vcnkgJyArXG4gICAgICAgICAgICAgICAgICAgICdsZWFrIGRldGVjdGVkLiAlZCBsaXN0ZW5lcnMgYWRkZWQuICcgK1xuICAgICAgICAgICAgICAgICAgICAnVXNlIGVtaXR0ZXIuc2V0TWF4TGlzdGVuZXJzKCkgdG8gaW5jcmVhc2UgbGltaXQuJyxcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRzW3R5cGVdLmxlbmd0aCk7XG4gICAgICBpZiAodHlwZW9mIGNvbnNvbGUudHJhY2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgLy8gbm90IHN1cHBvcnRlZCBpbiBJRSAxMFxuICAgICAgICBjb25zb2xlLnRyYWNlKCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLm9uID0gRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5hZGRMaXN0ZW5lcjtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5vbmNlID0gZnVuY3Rpb24odHlwZSwgbGlzdGVuZXIpIHtcbiAgaWYgKCFpc0Z1bmN0aW9uKGxpc3RlbmVyKSlcbiAgICB0aHJvdyBUeXBlRXJyb3IoJ2xpc3RlbmVyIG11c3QgYmUgYSBmdW5jdGlvbicpO1xuXG4gIHZhciBmaXJlZCA9IGZhbHNlO1xuXG4gIGZ1bmN0aW9uIGcoKSB7XG4gICAgdGhpcy5yZW1vdmVMaXN0ZW5lcih0eXBlLCBnKTtcblxuICAgIGlmICghZmlyZWQpIHtcbiAgICAgIGZpcmVkID0gdHJ1ZTtcbiAgICAgIGxpc3RlbmVyLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfVxuICB9XG5cbiAgZy5saXN0ZW5lciA9IGxpc3RlbmVyO1xuICB0aGlzLm9uKHR5cGUsIGcpO1xuXG4gIHJldHVybiB0aGlzO1xufTtcblxuLy8gZW1pdHMgYSAncmVtb3ZlTGlzdGVuZXInIGV2ZW50IGlmZiB0aGUgbGlzdGVuZXIgd2FzIHJlbW92ZWRcbkV2ZW50RW1pdHRlci5wcm90b3R5cGUucmVtb3ZlTGlzdGVuZXIgPSBmdW5jdGlvbih0eXBlLCBsaXN0ZW5lcikge1xuICB2YXIgbGlzdCwgcG9zaXRpb24sIGxlbmd0aCwgaTtcblxuICBpZiAoIWlzRnVuY3Rpb24obGlzdGVuZXIpKVxuICAgIHRocm93IFR5cGVFcnJvcignbGlzdGVuZXIgbXVzdCBiZSBhIGZ1bmN0aW9uJyk7XG5cbiAgaWYgKCF0aGlzLl9ldmVudHMgfHwgIXRoaXMuX2V2ZW50c1t0eXBlXSlcbiAgICByZXR1cm4gdGhpcztcblxuICBsaXN0ID0gdGhpcy5fZXZlbnRzW3R5cGVdO1xuICBsZW5ndGggPSBsaXN0Lmxlbmd0aDtcbiAgcG9zaXRpb24gPSAtMTtcblxuICBpZiAobGlzdCA9PT0gbGlzdGVuZXIgfHxcbiAgICAgIChpc0Z1bmN0aW9uKGxpc3QubGlzdGVuZXIpICYmIGxpc3QubGlzdGVuZXIgPT09IGxpc3RlbmVyKSkge1xuICAgIGRlbGV0ZSB0aGlzLl9ldmVudHNbdHlwZV07XG4gICAgaWYgKHRoaXMuX2V2ZW50cy5yZW1vdmVMaXN0ZW5lcilcbiAgICAgIHRoaXMuZW1pdCgncmVtb3ZlTGlzdGVuZXInLCB0eXBlLCBsaXN0ZW5lcik7XG5cbiAgfSBlbHNlIGlmIChpc09iamVjdChsaXN0KSkge1xuICAgIGZvciAoaSA9IGxlbmd0aDsgaS0tID4gMDspIHtcbiAgICAgIGlmIChsaXN0W2ldID09PSBsaXN0ZW5lciB8fFxuICAgICAgICAgIChsaXN0W2ldLmxpc3RlbmVyICYmIGxpc3RbaV0ubGlzdGVuZXIgPT09IGxpc3RlbmVyKSkge1xuICAgICAgICBwb3NpdGlvbiA9IGk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChwb3NpdGlvbiA8IDApXG4gICAgICByZXR1cm4gdGhpcztcblxuICAgIGlmIChsaXN0Lmxlbmd0aCA9PT0gMSkge1xuICAgICAgbGlzdC5sZW5ndGggPSAwO1xuICAgICAgZGVsZXRlIHRoaXMuX2V2ZW50c1t0eXBlXTtcbiAgICB9IGVsc2Uge1xuICAgICAgbGlzdC5zcGxpY2UocG9zaXRpb24sIDEpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLl9ldmVudHMucmVtb3ZlTGlzdGVuZXIpXG4gICAgICB0aGlzLmVtaXQoJ3JlbW92ZUxpc3RlbmVyJywgdHlwZSwgbGlzdGVuZXIpO1xuICB9XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLnJlbW92ZUFsbExpc3RlbmVycyA9IGZ1bmN0aW9uKHR5cGUpIHtcbiAgdmFyIGtleSwgbGlzdGVuZXJzO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzKVxuICAgIHJldHVybiB0aGlzO1xuXG4gIC8vIG5vdCBsaXN0ZW5pbmcgZm9yIHJlbW92ZUxpc3RlbmVyLCBubyBuZWVkIHRvIGVtaXRcbiAgaWYgKCF0aGlzLl9ldmVudHMucmVtb3ZlTGlzdGVuZXIpIHtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMClcbiAgICAgIHRoaXMuX2V2ZW50cyA9IHt9O1xuICAgIGVsc2UgaWYgKHRoaXMuX2V2ZW50c1t0eXBlXSlcbiAgICAgIGRlbGV0ZSB0aGlzLl9ldmVudHNbdHlwZV07XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvLyBlbWl0IHJlbW92ZUxpc3RlbmVyIGZvciBhbGwgbGlzdGVuZXJzIG9uIGFsbCBldmVudHNcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDApIHtcbiAgICBmb3IgKGtleSBpbiB0aGlzLl9ldmVudHMpIHtcbiAgICAgIGlmIChrZXkgPT09ICdyZW1vdmVMaXN0ZW5lcicpIGNvbnRpbnVlO1xuICAgICAgdGhpcy5yZW1vdmVBbGxMaXN0ZW5lcnMoa2V5KTtcbiAgICB9XG4gICAgdGhpcy5yZW1vdmVBbGxMaXN0ZW5lcnMoJ3JlbW92ZUxpc3RlbmVyJyk7XG4gICAgdGhpcy5fZXZlbnRzID0ge307XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBsaXN0ZW5lcnMgPSB0aGlzLl9ldmVudHNbdHlwZV07XG5cbiAgaWYgKGlzRnVuY3Rpb24obGlzdGVuZXJzKSkge1xuICAgIHRoaXMucmVtb3ZlTGlzdGVuZXIodHlwZSwgbGlzdGVuZXJzKTtcbiAgfSBlbHNlIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAvLyBMSUZPIG9yZGVyXG4gICAgd2hpbGUgKGxpc3RlbmVycy5sZW5ndGgpXG4gICAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKHR5cGUsIGxpc3RlbmVyc1tsaXN0ZW5lcnMubGVuZ3RoIC0gMV0pO1xuICB9XG4gIGRlbGV0ZSB0aGlzLl9ldmVudHNbdHlwZV07XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmxpc3RlbmVycyA9IGZ1bmN0aW9uKHR5cGUpIHtcbiAgdmFyIHJldDtcbiAgaWYgKCF0aGlzLl9ldmVudHMgfHwgIXRoaXMuX2V2ZW50c1t0eXBlXSlcbiAgICByZXQgPSBbXTtcbiAgZWxzZSBpZiAoaXNGdW5jdGlvbih0aGlzLl9ldmVudHNbdHlwZV0pKVxuICAgIHJldCA9IFt0aGlzLl9ldmVudHNbdHlwZV1dO1xuICBlbHNlXG4gICAgcmV0ID0gdGhpcy5fZXZlbnRzW3R5cGVdLnNsaWNlKCk7XG4gIHJldHVybiByZXQ7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmxpc3RlbmVyQ291bnQgPSBmdW5jdGlvbih0eXBlKSB7XG4gIGlmICh0aGlzLl9ldmVudHMpIHtcbiAgICB2YXIgZXZsaXN0ZW5lciA9IHRoaXMuX2V2ZW50c1t0eXBlXTtcblxuICAgIGlmIChpc0Z1bmN0aW9uKGV2bGlzdGVuZXIpKVxuICAgICAgcmV0dXJuIDE7XG4gICAgZWxzZSBpZiAoZXZsaXN0ZW5lcilcbiAgICAgIHJldHVybiBldmxpc3RlbmVyLmxlbmd0aDtcbiAgfVxuICByZXR1cm4gMDtcbn07XG5cbkV2ZW50RW1pdHRlci5saXN0ZW5lckNvdW50ID0gZnVuY3Rpb24oZW1pdHRlciwgdHlwZSkge1xuICByZXR1cm4gZW1pdHRlci5saXN0ZW5lckNvdW50KHR5cGUpO1xufTtcblxuZnVuY3Rpb24gaXNGdW5jdGlvbihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdmdW5jdGlvbic7XG59XG5cbmZ1bmN0aW9uIGlzTnVtYmVyKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ251bWJlcic7XG59XG5cbmZ1bmN0aW9uIGlzT2JqZWN0KGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ29iamVjdCcgJiYgYXJnICE9PSBudWxsO1xufVxuXG5mdW5jdGlvbiBpc1VuZGVmaW5lZChhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gdm9pZCAwO1xufVxuIiwiLy8gQ29weXJpZ2h0IEpveWVudCwgSW5jLiBhbmQgb3RoZXIgTm9kZSBjb250cmlidXRvcnMuXG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGFcbi8vIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGVcbi8vIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZ1xuLy8gd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLFxuLy8gZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdFxuLy8gcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlXG4vLyBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZFxuLy8gaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTU1xuLy8gT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRlxuLy8gTUVSQ0hBTlRBQklMSVRZLCBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTlxuLy8gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sXG4vLyBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1Jcbi8vIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEVcbi8vIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbi8vIHJlc29sdmVzIC4gYW5kIC4uIGVsZW1lbnRzIGluIGEgcGF0aCBhcnJheSB3aXRoIGRpcmVjdG9yeSBuYW1lcyB0aGVyZVxuLy8gbXVzdCBiZSBubyBzbGFzaGVzLCBlbXB0eSBlbGVtZW50cywgb3IgZGV2aWNlIG5hbWVzIChjOlxcKSBpbiB0aGUgYXJyYXlcbi8vIChzbyBhbHNvIG5vIGxlYWRpbmcgYW5kIHRyYWlsaW5nIHNsYXNoZXMgLSBpdCBkb2VzIG5vdCBkaXN0aW5ndWlzaFxuLy8gcmVsYXRpdmUgYW5kIGFic29sdXRlIHBhdGhzKVxuZnVuY3Rpb24gbm9ybWFsaXplQXJyYXkocGFydHMsIGFsbG93QWJvdmVSb290KSB7XG4gIC8vIGlmIHRoZSBwYXRoIHRyaWVzIHRvIGdvIGFib3ZlIHRoZSByb290LCBgdXBgIGVuZHMgdXAgPiAwXG4gIHZhciB1cCA9IDA7XG4gIGZvciAodmFyIGkgPSBwYXJ0cy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIHZhciBsYXN0ID0gcGFydHNbaV07XG4gICAgaWYgKGxhc3QgPT09ICcuJykge1xuICAgICAgcGFydHMuc3BsaWNlKGksIDEpO1xuICAgIH0gZWxzZSBpZiAobGFzdCA9PT0gJy4uJykge1xuICAgICAgcGFydHMuc3BsaWNlKGksIDEpO1xuICAgICAgdXArKztcbiAgICB9IGVsc2UgaWYgKHVwKSB7XG4gICAgICBwYXJ0cy5zcGxpY2UoaSwgMSk7XG4gICAgICB1cC0tO1xuICAgIH1cbiAgfVxuXG4gIC8vIGlmIHRoZSBwYXRoIGlzIGFsbG93ZWQgdG8gZ28gYWJvdmUgdGhlIHJvb3QsIHJlc3RvcmUgbGVhZGluZyAuLnNcbiAgaWYgKGFsbG93QWJvdmVSb290KSB7XG4gICAgZm9yICg7IHVwLS07IHVwKSB7XG4gICAgICBwYXJ0cy51bnNoaWZ0KCcuLicpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBwYXJ0cztcbn1cblxuLy8gU3BsaXQgYSBmaWxlbmFtZSBpbnRvIFtyb290LCBkaXIsIGJhc2VuYW1lLCBleHRdLCB1bml4IHZlcnNpb25cbi8vICdyb290JyBpcyBqdXN0IGEgc2xhc2gsIG9yIG5vdGhpbmcuXG52YXIgc3BsaXRQYXRoUmUgPVxuICAgIC9eKFxcLz98KShbXFxzXFxTXSo/KSgoPzpcXC57MSwyfXxbXlxcL10rP3wpKFxcLlteLlxcL10qfCkpKD86W1xcL10qKSQvO1xudmFyIHNwbGl0UGF0aCA9IGZ1bmN0aW9uKGZpbGVuYW1lKSB7XG4gIHJldHVybiBzcGxpdFBhdGhSZS5leGVjKGZpbGVuYW1lKS5zbGljZSgxKTtcbn07XG5cbi8vIHBhdGgucmVzb2x2ZShbZnJvbSAuLi5dLCB0bylcbi8vIHBvc2l4IHZlcnNpb25cbmV4cG9ydHMucmVzb2x2ZSA9IGZ1bmN0aW9uKCkge1xuICB2YXIgcmVzb2x2ZWRQYXRoID0gJycsXG4gICAgICByZXNvbHZlZEFic29sdXRlID0gZmFsc2U7XG5cbiAgZm9yICh2YXIgaSA9IGFyZ3VtZW50cy5sZW5ndGggLSAxOyBpID49IC0xICYmICFyZXNvbHZlZEFic29sdXRlOyBpLS0pIHtcbiAgICB2YXIgcGF0aCA9IChpID49IDApID8gYXJndW1lbnRzW2ldIDogcHJvY2Vzcy5jd2QoKTtcblxuICAgIC8vIFNraXAgZW1wdHkgYW5kIGludmFsaWQgZW50cmllc1xuICAgIGlmICh0eXBlb2YgcGF0aCAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0FyZ3VtZW50cyB0byBwYXRoLnJlc29sdmUgbXVzdCBiZSBzdHJpbmdzJyk7XG4gICAgfSBlbHNlIGlmICghcGF0aCkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgcmVzb2x2ZWRQYXRoID0gcGF0aCArICcvJyArIHJlc29sdmVkUGF0aDtcbiAgICByZXNvbHZlZEFic29sdXRlID0gcGF0aC5jaGFyQXQoMCkgPT09ICcvJztcbiAgfVxuXG4gIC8vIEF0IHRoaXMgcG9pbnQgdGhlIHBhdGggc2hvdWxkIGJlIHJlc29sdmVkIHRvIGEgZnVsbCBhYnNvbHV0ZSBwYXRoLCBidXRcbiAgLy8gaGFuZGxlIHJlbGF0aXZlIHBhdGhzIHRvIGJlIHNhZmUgKG1pZ2h0IGhhcHBlbiB3aGVuIHByb2Nlc3MuY3dkKCkgZmFpbHMpXG5cbiAgLy8gTm9ybWFsaXplIHRoZSBwYXRoXG4gIHJlc29sdmVkUGF0aCA9IG5vcm1hbGl6ZUFycmF5KGZpbHRlcihyZXNvbHZlZFBhdGguc3BsaXQoJy8nKSwgZnVuY3Rpb24ocCkge1xuICAgIHJldHVybiAhIXA7XG4gIH0pLCAhcmVzb2x2ZWRBYnNvbHV0ZSkuam9pbignLycpO1xuXG4gIHJldHVybiAoKHJlc29sdmVkQWJzb2x1dGUgPyAnLycgOiAnJykgKyByZXNvbHZlZFBhdGgpIHx8ICcuJztcbn07XG5cbi8vIHBhdGgubm9ybWFsaXplKHBhdGgpXG4vLyBwb3NpeCB2ZXJzaW9uXG5leHBvcnRzLm5vcm1hbGl6ZSA9IGZ1bmN0aW9uKHBhdGgpIHtcbiAgdmFyIGlzQWJzb2x1dGUgPSBleHBvcnRzLmlzQWJzb2x1dGUocGF0aCksXG4gICAgICB0cmFpbGluZ1NsYXNoID0gc3Vic3RyKHBhdGgsIC0xKSA9PT0gJy8nO1xuXG4gIC8vIE5vcm1hbGl6ZSB0aGUgcGF0aFxuICBwYXRoID0gbm9ybWFsaXplQXJyYXkoZmlsdGVyKHBhdGguc3BsaXQoJy8nKSwgZnVuY3Rpb24ocCkge1xuICAgIHJldHVybiAhIXA7XG4gIH0pLCAhaXNBYnNvbHV0ZSkuam9pbignLycpO1xuXG4gIGlmICghcGF0aCAmJiAhaXNBYnNvbHV0ZSkge1xuICAgIHBhdGggPSAnLic7XG4gIH1cbiAgaWYgKHBhdGggJiYgdHJhaWxpbmdTbGFzaCkge1xuICAgIHBhdGggKz0gJy8nO1xuICB9XG5cbiAgcmV0dXJuIChpc0Fic29sdXRlID8gJy8nIDogJycpICsgcGF0aDtcbn07XG5cbi8vIHBvc2l4IHZlcnNpb25cbmV4cG9ydHMuaXNBYnNvbHV0ZSA9IGZ1bmN0aW9uKHBhdGgpIHtcbiAgcmV0dXJuIHBhdGguY2hhckF0KDApID09PSAnLyc7XG59O1xuXG4vLyBwb3NpeCB2ZXJzaW9uXG5leHBvcnRzLmpvaW4gPSBmdW5jdGlvbigpIHtcbiAgdmFyIHBhdGhzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAwKTtcbiAgcmV0dXJuIGV4cG9ydHMubm9ybWFsaXplKGZpbHRlcihwYXRocywgZnVuY3Rpb24ocCwgaW5kZXgpIHtcbiAgICBpZiAodHlwZW9mIHAgIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdBcmd1bWVudHMgdG8gcGF0aC5qb2luIG11c3QgYmUgc3RyaW5ncycpO1xuICAgIH1cbiAgICByZXR1cm4gcDtcbiAgfSkuam9pbignLycpKTtcbn07XG5cblxuLy8gcGF0aC5yZWxhdGl2ZShmcm9tLCB0bylcbi8vIHBvc2l4IHZlcnNpb25cbmV4cG9ydHMucmVsYXRpdmUgPSBmdW5jdGlvbihmcm9tLCB0bykge1xuICBmcm9tID0gZXhwb3J0cy5yZXNvbHZlKGZyb20pLnN1YnN0cigxKTtcbiAgdG8gPSBleHBvcnRzLnJlc29sdmUodG8pLnN1YnN0cigxKTtcblxuICBmdW5jdGlvbiB0cmltKGFycikge1xuICAgIHZhciBzdGFydCA9IDA7XG4gICAgZm9yICg7IHN0YXJ0IDwgYXJyLmxlbmd0aDsgc3RhcnQrKykge1xuICAgICAgaWYgKGFycltzdGFydF0gIT09ICcnKSBicmVhaztcbiAgICB9XG5cbiAgICB2YXIgZW5kID0gYXJyLmxlbmd0aCAtIDE7XG4gICAgZm9yICg7IGVuZCA+PSAwOyBlbmQtLSkge1xuICAgICAgaWYgKGFycltlbmRdICE9PSAnJykgYnJlYWs7XG4gICAgfVxuXG4gICAgaWYgKHN0YXJ0ID4gZW5kKSByZXR1cm4gW107XG4gICAgcmV0dXJuIGFyci5zbGljZShzdGFydCwgZW5kIC0gc3RhcnQgKyAxKTtcbiAgfVxuXG4gIHZhciBmcm9tUGFydHMgPSB0cmltKGZyb20uc3BsaXQoJy8nKSk7XG4gIHZhciB0b1BhcnRzID0gdHJpbSh0by5zcGxpdCgnLycpKTtcblxuICB2YXIgbGVuZ3RoID0gTWF0aC5taW4oZnJvbVBhcnRzLmxlbmd0aCwgdG9QYXJ0cy5sZW5ndGgpO1xuICB2YXIgc2FtZVBhcnRzTGVuZ3RoID0gbGVuZ3RoO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKGZyb21QYXJ0c1tpXSAhPT0gdG9QYXJ0c1tpXSkge1xuICAgICAgc2FtZVBhcnRzTGVuZ3RoID0gaTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIHZhciBvdXRwdXRQYXJ0cyA9IFtdO1xuICBmb3IgKHZhciBpID0gc2FtZVBhcnRzTGVuZ3RoOyBpIDwgZnJvbVBhcnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgb3V0cHV0UGFydHMucHVzaCgnLi4nKTtcbiAgfVxuXG4gIG91dHB1dFBhcnRzID0gb3V0cHV0UGFydHMuY29uY2F0KHRvUGFydHMuc2xpY2Uoc2FtZVBhcnRzTGVuZ3RoKSk7XG5cbiAgcmV0dXJuIG91dHB1dFBhcnRzLmpvaW4oJy8nKTtcbn07XG5cbmV4cG9ydHMuc2VwID0gJy8nO1xuZXhwb3J0cy5kZWxpbWl0ZXIgPSAnOic7XG5cbmV4cG9ydHMuZGlybmFtZSA9IGZ1bmN0aW9uKHBhdGgpIHtcbiAgdmFyIHJlc3VsdCA9IHNwbGl0UGF0aChwYXRoKSxcbiAgICAgIHJvb3QgPSByZXN1bHRbMF0sXG4gICAgICBkaXIgPSByZXN1bHRbMV07XG5cbiAgaWYgKCFyb290ICYmICFkaXIpIHtcbiAgICAvLyBObyBkaXJuYW1lIHdoYXRzb2V2ZXJcbiAgICByZXR1cm4gJy4nO1xuICB9XG5cbiAgaWYgKGRpcikge1xuICAgIC8vIEl0IGhhcyBhIGRpcm5hbWUsIHN0cmlwIHRyYWlsaW5nIHNsYXNoXG4gICAgZGlyID0gZGlyLnN1YnN0cigwLCBkaXIubGVuZ3RoIC0gMSk7XG4gIH1cblxuICByZXR1cm4gcm9vdCArIGRpcjtcbn07XG5cblxuZXhwb3J0cy5iYXNlbmFtZSA9IGZ1bmN0aW9uKHBhdGgsIGV4dCkge1xuICB2YXIgZiA9IHNwbGl0UGF0aChwYXRoKVsyXTtcbiAgLy8gVE9ETzogbWFrZSB0aGlzIGNvbXBhcmlzb24gY2FzZS1pbnNlbnNpdGl2ZSBvbiB3aW5kb3dzP1xuICBpZiAoZXh0ICYmIGYuc3Vic3RyKC0xICogZXh0Lmxlbmd0aCkgPT09IGV4dCkge1xuICAgIGYgPSBmLnN1YnN0cigwLCBmLmxlbmd0aCAtIGV4dC5sZW5ndGgpO1xuICB9XG4gIHJldHVybiBmO1xufTtcblxuXG5leHBvcnRzLmV4dG5hbWUgPSBmdW5jdGlvbihwYXRoKSB7XG4gIHJldHVybiBzcGxpdFBhdGgocGF0aClbM107XG59O1xuXG5mdW5jdGlvbiBmaWx0ZXIgKHhzLCBmKSB7XG4gICAgaWYgKHhzLmZpbHRlcikgcmV0dXJuIHhzLmZpbHRlcihmKTtcbiAgICB2YXIgcmVzID0gW107XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB4cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAoZih4c1tpXSwgaSwgeHMpKSByZXMucHVzaCh4c1tpXSk7XG4gICAgfVxuICAgIHJldHVybiByZXM7XG59XG5cbi8vIFN0cmluZy5wcm90b3R5cGUuc3Vic3RyIC0gbmVnYXRpdmUgaW5kZXggZG9uJ3Qgd29yayBpbiBJRThcbnZhciBzdWJzdHIgPSAnYWInLnN1YnN0cigtMSkgPT09ICdiJ1xuICAgID8gZnVuY3Rpb24gKHN0ciwgc3RhcnQsIGxlbikgeyByZXR1cm4gc3RyLnN1YnN0cihzdGFydCwgbGVuKSB9XG4gICAgOiBmdW5jdGlvbiAoc3RyLCBzdGFydCwgbGVuKSB7XG4gICAgICAgIGlmIChzdGFydCA8IDApIHN0YXJ0ID0gc3RyLmxlbmd0aCArIHN0YXJ0O1xuICAgICAgICByZXR1cm4gc3RyLnN1YnN0cihzdGFydCwgbGVuKTtcbiAgICB9XG47XG4iLCIvLyBzaGltIGZvciB1c2luZyBwcm9jZXNzIGluIGJyb3dzZXJcbnZhciBwcm9jZXNzID0gbW9kdWxlLmV4cG9ydHMgPSB7fTtcblxuLy8gY2FjaGVkIGZyb20gd2hhdGV2ZXIgZ2xvYmFsIGlzIHByZXNlbnQgc28gdGhhdCB0ZXN0IHJ1bm5lcnMgdGhhdCBzdHViIGl0XG4vLyBkb24ndCBicmVhayB0aGluZ3MuICBCdXQgd2UgbmVlZCB0byB3cmFwIGl0IGluIGEgdHJ5IGNhdGNoIGluIGNhc2UgaXQgaXNcbi8vIHdyYXBwZWQgaW4gc3RyaWN0IG1vZGUgY29kZSB3aGljaCBkb2Vzbid0IGRlZmluZSBhbnkgZ2xvYmFscy4gIEl0J3MgaW5zaWRlIGFcbi8vIGZ1bmN0aW9uIGJlY2F1c2UgdHJ5L2NhdGNoZXMgZGVvcHRpbWl6ZSBpbiBjZXJ0YWluIGVuZ2luZXMuXG5cbnZhciBjYWNoZWRTZXRUaW1lb3V0O1xudmFyIGNhY2hlZENsZWFyVGltZW91dDtcblxuZnVuY3Rpb24gZGVmYXVsdFNldFRpbW91dCgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3NldFRpbWVvdXQgaGFzIG5vdCBiZWVuIGRlZmluZWQnKTtcbn1cbmZ1bmN0aW9uIGRlZmF1bHRDbGVhclRpbWVvdXQgKCkge1xuICAgIHRocm93IG5ldyBFcnJvcignY2xlYXJUaW1lb3V0IGhhcyBub3QgYmVlbiBkZWZpbmVkJyk7XG59XG4oZnVuY3Rpb24gKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGlmICh0eXBlb2Ygc2V0VGltZW91dCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FjaGVkU2V0VGltZW91dCA9IHNldFRpbWVvdXQ7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gZGVmYXVsdFNldFRpbW91dDtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY2FjaGVkU2V0VGltZW91dCA9IGRlZmF1bHRTZXRUaW1vdXQ7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIGlmICh0eXBlb2YgY2xlYXJUaW1lb3V0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYWNoZWRDbGVhclRpbWVvdXQgPSBjbGVhclRpbWVvdXQ7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjYWNoZWRDbGVhclRpbWVvdXQgPSBkZWZhdWx0Q2xlYXJUaW1lb3V0O1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjYWNoZWRDbGVhclRpbWVvdXQgPSBkZWZhdWx0Q2xlYXJUaW1lb3V0O1xuICAgIH1cbn0gKCkpXG5mdW5jdGlvbiBydW5UaW1lb3V0KGZ1bikge1xuICAgIGlmIChjYWNoZWRTZXRUaW1lb3V0ID09PSBzZXRUaW1lb3V0KSB7XG4gICAgICAgIC8vbm9ybWFsIGVudmlyb21lbnRzIGluIHNhbmUgc2l0dWF0aW9uc1xuICAgICAgICByZXR1cm4gc2V0VGltZW91dChmdW4sIDApO1xuICAgIH1cbiAgICAvLyBpZiBzZXRUaW1lb3V0IHdhc24ndCBhdmFpbGFibGUgYnV0IHdhcyBsYXR0ZXIgZGVmaW5lZFxuICAgIGlmICgoY2FjaGVkU2V0VGltZW91dCA9PT0gZGVmYXVsdFNldFRpbW91dCB8fCAhY2FjaGVkU2V0VGltZW91dCkgJiYgc2V0VGltZW91dCkge1xuICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gc2V0VGltZW91dDtcbiAgICAgICAgcmV0dXJuIHNldFRpbWVvdXQoZnVuLCAwKTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgLy8gd2hlbiB3aGVuIHNvbWVib2R5IGhhcyBzY3Jld2VkIHdpdGggc2V0VGltZW91dCBidXQgbm8gSS5FLiBtYWRkbmVzc1xuICAgICAgICByZXR1cm4gY2FjaGVkU2V0VGltZW91dChmdW4sIDApO1xuICAgIH0gY2F0Y2goZSl7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBXaGVuIHdlIGFyZSBpbiBJLkUuIGJ1dCB0aGUgc2NyaXB0IGhhcyBiZWVuIGV2YWxlZCBzbyBJLkUuIGRvZXNuJ3QgdHJ1c3QgdGhlIGdsb2JhbCBvYmplY3Qgd2hlbiBjYWxsZWQgbm9ybWFsbHlcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWRTZXRUaW1lb3V0LmNhbGwobnVsbCwgZnVuLCAwKTtcbiAgICAgICAgfSBjYXRjaChlKXtcbiAgICAgICAgICAgIC8vIHNhbWUgYXMgYWJvdmUgYnV0IHdoZW4gaXQncyBhIHZlcnNpb24gb2YgSS5FLiB0aGF0IG11c3QgaGF2ZSB0aGUgZ2xvYmFsIG9iamVjdCBmb3IgJ3RoaXMnLCBob3BmdWxseSBvdXIgY29udGV4dCBjb3JyZWN0IG90aGVyd2lzZSBpdCB3aWxsIHRocm93IGEgZ2xvYmFsIGVycm9yXG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkU2V0VGltZW91dC5jYWxsKHRoaXMsIGZ1biwgMCk7XG4gICAgICAgIH1cbiAgICB9XG5cblxufVxuZnVuY3Rpb24gcnVuQ2xlYXJUaW1lb3V0KG1hcmtlcikge1xuICAgIGlmIChjYWNoZWRDbGVhclRpbWVvdXQgPT09IGNsZWFyVGltZW91dCkge1xuICAgICAgICAvL25vcm1hbCBlbnZpcm9tZW50cyBpbiBzYW5lIHNpdHVhdGlvbnNcbiAgICAgICAgcmV0dXJuIGNsZWFyVGltZW91dChtYXJrZXIpO1xuICAgIH1cbiAgICAvLyBpZiBjbGVhclRpbWVvdXQgd2Fzbid0IGF2YWlsYWJsZSBidXQgd2FzIGxhdHRlciBkZWZpbmVkXG4gICAgaWYgKChjYWNoZWRDbGVhclRpbWVvdXQgPT09IGRlZmF1bHRDbGVhclRpbWVvdXQgfHwgIWNhY2hlZENsZWFyVGltZW91dCkgJiYgY2xlYXJUaW1lb3V0KSB7XG4gICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGNsZWFyVGltZW91dDtcbiAgICAgICAgcmV0dXJuIGNsZWFyVGltZW91dChtYXJrZXIpO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICAvLyB3aGVuIHdoZW4gc29tZWJvZHkgaGFzIHNjcmV3ZWQgd2l0aCBzZXRUaW1lb3V0IGJ1dCBubyBJLkUuIG1hZGRuZXNzXG4gICAgICAgIHJldHVybiBjYWNoZWRDbGVhclRpbWVvdXQobWFya2VyKTtcbiAgICB9IGNhdGNoIChlKXtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIFdoZW4gd2UgYXJlIGluIEkuRS4gYnV0IHRoZSBzY3JpcHQgaGFzIGJlZW4gZXZhbGVkIHNvIEkuRS4gZG9lc24ndCAgdHJ1c3QgdGhlIGdsb2JhbCBvYmplY3Qgd2hlbiBjYWxsZWQgbm9ybWFsbHlcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWRDbGVhclRpbWVvdXQuY2FsbChudWxsLCBtYXJrZXIpO1xuICAgICAgICB9IGNhdGNoIChlKXtcbiAgICAgICAgICAgIC8vIHNhbWUgYXMgYWJvdmUgYnV0IHdoZW4gaXQncyBhIHZlcnNpb24gb2YgSS5FLiB0aGF0IG11c3QgaGF2ZSB0aGUgZ2xvYmFsIG9iamVjdCBmb3IgJ3RoaXMnLCBob3BmdWxseSBvdXIgY29udGV4dCBjb3JyZWN0IG90aGVyd2lzZSBpdCB3aWxsIHRocm93IGEgZ2xvYmFsIGVycm9yLlxuICAgICAgICAgICAgLy8gU29tZSB2ZXJzaW9ucyBvZiBJLkUuIGhhdmUgZGlmZmVyZW50IHJ1bGVzIGZvciBjbGVhclRpbWVvdXQgdnMgc2V0VGltZW91dFxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZENsZWFyVGltZW91dC5jYWxsKHRoaXMsIG1hcmtlcik7XG4gICAgICAgIH1cbiAgICB9XG5cblxuXG59XG52YXIgcXVldWUgPSBbXTtcbnZhciBkcmFpbmluZyA9IGZhbHNlO1xudmFyIGN1cnJlbnRRdWV1ZTtcbnZhciBxdWV1ZUluZGV4ID0gLTE7XG5cbmZ1bmN0aW9uIGNsZWFuVXBOZXh0VGljaygpIHtcbiAgICBpZiAoIWRyYWluaW5nIHx8ICFjdXJyZW50UXVldWUpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBkcmFpbmluZyA9IGZhbHNlO1xuICAgIGlmIChjdXJyZW50UXVldWUubGVuZ3RoKSB7XG4gICAgICAgIHF1ZXVlID0gY3VycmVudFF1ZXVlLmNvbmNhdChxdWV1ZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcXVldWVJbmRleCA9IC0xO1xuICAgIH1cbiAgICBpZiAocXVldWUubGVuZ3RoKSB7XG4gICAgICAgIGRyYWluUXVldWUoKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGRyYWluUXVldWUoKSB7XG4gICAgaWYgKGRyYWluaW5nKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdmFyIHRpbWVvdXQgPSBydW5UaW1lb3V0KGNsZWFuVXBOZXh0VGljayk7XG4gICAgZHJhaW5pbmcgPSB0cnVlO1xuXG4gICAgdmFyIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB3aGlsZShsZW4pIHtcbiAgICAgICAgY3VycmVudFF1ZXVlID0gcXVldWU7XG4gICAgICAgIHF1ZXVlID0gW107XG4gICAgICAgIHdoaWxlICgrK3F1ZXVlSW5kZXggPCBsZW4pIHtcbiAgICAgICAgICAgIGlmIChjdXJyZW50UXVldWUpIHtcbiAgICAgICAgICAgICAgICBjdXJyZW50UXVldWVbcXVldWVJbmRleF0ucnVuKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcXVldWVJbmRleCA9IC0xO1xuICAgICAgICBsZW4gPSBxdWV1ZS5sZW5ndGg7XG4gICAgfVxuICAgIGN1cnJlbnRRdWV1ZSA9IG51bGw7XG4gICAgZHJhaW5pbmcgPSBmYWxzZTtcbiAgICBydW5DbGVhclRpbWVvdXQodGltZW91dCk7XG59XG5cbnByb2Nlc3MubmV4dFRpY2sgPSBmdW5jdGlvbiAoZnVuKSB7XG4gICAgdmFyIGFyZ3MgPSBuZXcgQXJyYXkoYXJndW1lbnRzLmxlbmd0aCAtIDEpO1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMSkge1xuICAgICAgICBmb3IgKHZhciBpID0gMTsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgYXJnc1tpIC0gMV0gPSBhcmd1bWVudHNbaV07XG4gICAgICAgIH1cbiAgICB9XG4gICAgcXVldWUucHVzaChuZXcgSXRlbShmdW4sIGFyZ3MpKTtcbiAgICBpZiAocXVldWUubGVuZ3RoID09PSAxICYmICFkcmFpbmluZykge1xuICAgICAgICBydW5UaW1lb3V0KGRyYWluUXVldWUpO1xuICAgIH1cbn07XG5cbi8vIHY4IGxpa2VzIHByZWRpY3RpYmxlIG9iamVjdHNcbmZ1bmN0aW9uIEl0ZW0oZnVuLCBhcnJheSkge1xuICAgIHRoaXMuZnVuID0gZnVuO1xuICAgIHRoaXMuYXJyYXkgPSBhcnJheTtcbn1cbkl0ZW0ucHJvdG90eXBlLnJ1biA9IGZ1bmN0aW9uICgpIHtcbiAgICB0aGlzLmZ1bi5hcHBseShudWxsLCB0aGlzLmFycmF5KTtcbn07XG5wcm9jZXNzLnRpdGxlID0gJ2Jyb3dzZXInO1xucHJvY2Vzcy5icm93c2VyID0gdHJ1ZTtcbnByb2Nlc3MuZW52ID0ge307XG5wcm9jZXNzLmFyZ3YgPSBbXTtcbnByb2Nlc3MudmVyc2lvbiA9ICcnOyAvLyBlbXB0eSBzdHJpbmcgdG8gYXZvaWQgcmVnZXhwIGlzc3Vlc1xucHJvY2Vzcy52ZXJzaW9ucyA9IHt9O1xuXG5mdW5jdGlvbiBub29wKCkge31cblxucHJvY2Vzcy5vbiA9IG5vb3A7XG5wcm9jZXNzLmFkZExpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3Mub25jZSA9IG5vb3A7XG5wcm9jZXNzLm9mZiA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUxpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlQWxsTGlzdGVuZXJzID0gbm9vcDtcbnByb2Nlc3MuZW1pdCA9IG5vb3A7XG5wcm9jZXNzLnByZXBlbmRMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLnByZXBlbmRPbmNlTGlzdGVuZXIgPSBub29wO1xuXG5wcm9jZXNzLmxpc3RlbmVycyA9IGZ1bmN0aW9uIChuYW1lKSB7IHJldHVybiBbXSB9XG5cbnByb2Nlc3MuYmluZGluZyA9IGZ1bmN0aW9uIChuYW1lKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmJpbmRpbmcgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcblxucHJvY2Vzcy5jd2QgPSBmdW5jdGlvbiAoKSB7IHJldHVybiAnLycgfTtcbnByb2Nlc3MuY2hkaXIgPSBmdW5jdGlvbiAoZGlyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmNoZGlyIGlzIG5vdCBzdXBwb3J0ZWQnKTtcbn07XG5wcm9jZXNzLnVtYXNrID0gZnVuY3Rpb24oKSB7IHJldHVybiAwOyB9O1xuIiwiaWYgKHR5cGVvZiBPYmplY3QuY3JlYXRlID09PSAnZnVuY3Rpb24nKSB7XG4gIC8vIGltcGxlbWVudGF0aW9uIGZyb20gc3RhbmRhcmQgbm9kZS5qcyAndXRpbCcgbW9kdWxlXG4gIG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gaW5oZXJpdHMoY3Rvciwgc3VwZXJDdG9yKSB7XG4gICAgY3Rvci5zdXBlcl8gPSBzdXBlckN0b3JcbiAgICBjdG9yLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoc3VwZXJDdG9yLnByb3RvdHlwZSwge1xuICAgICAgY29uc3RydWN0b3I6IHtcbiAgICAgICAgdmFsdWU6IGN0b3IsXG4gICAgICAgIGVudW1lcmFibGU6IGZhbHNlLFxuICAgICAgICB3cml0YWJsZTogdHJ1ZSxcbiAgICAgICAgY29uZmlndXJhYmxlOiB0cnVlXG4gICAgICB9XG4gICAgfSk7XG4gIH07XG59IGVsc2Uge1xuICAvLyBvbGQgc2Nob29sIHNoaW0gZm9yIG9sZCBicm93c2Vyc1xuICBtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGluaGVyaXRzKGN0b3IsIHN1cGVyQ3Rvcikge1xuICAgIGN0b3Iuc3VwZXJfID0gc3VwZXJDdG9yXG4gICAgdmFyIFRlbXBDdG9yID0gZnVuY3Rpb24gKCkge31cbiAgICBUZW1wQ3Rvci5wcm90b3R5cGUgPSBzdXBlckN0b3IucHJvdG90eXBlXG4gICAgY3Rvci5wcm90b3R5cGUgPSBuZXcgVGVtcEN0b3IoKVxuICAgIGN0b3IucHJvdG90eXBlLmNvbnN0cnVjdG9yID0gY3RvclxuICB9XG59XG4iLCJtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGlzQnVmZmVyKGFyZykge1xuICByZXR1cm4gYXJnICYmIHR5cGVvZiBhcmcgPT09ICdvYmplY3QnXG4gICAgJiYgdHlwZW9mIGFyZy5jb3B5ID09PSAnZnVuY3Rpb24nXG4gICAgJiYgdHlwZW9mIGFyZy5maWxsID09PSAnZnVuY3Rpb24nXG4gICAgJiYgdHlwZW9mIGFyZy5yZWFkVUludDggPT09ICdmdW5jdGlvbic7XG59IiwiLy8gQ29weXJpZ2h0IEpveWVudCwgSW5jLiBhbmQgb3RoZXIgTm9kZSBjb250cmlidXRvcnMuXG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGFcbi8vIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGVcbi8vIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZ1xuLy8gd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLFxuLy8gZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdFxuLy8gcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlXG4vLyBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZFxuLy8gaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTU1xuLy8gT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRlxuLy8gTUVSQ0hBTlRBQklMSVRZLCBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTlxuLy8gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sXG4vLyBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1Jcbi8vIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEVcbi8vIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbnZhciBmb3JtYXRSZWdFeHAgPSAvJVtzZGolXS9nO1xuZXhwb3J0cy5mb3JtYXQgPSBmdW5jdGlvbihmKSB7XG4gIGlmICghaXNTdHJpbmcoZikpIHtcbiAgICB2YXIgb2JqZWN0cyA9IFtdO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBvYmplY3RzLnB1c2goaW5zcGVjdChhcmd1bWVudHNbaV0pKTtcbiAgICB9XG4gICAgcmV0dXJuIG9iamVjdHMuam9pbignICcpO1xuICB9XG5cbiAgdmFyIGkgPSAxO1xuICB2YXIgYXJncyA9IGFyZ3VtZW50cztcbiAgdmFyIGxlbiA9IGFyZ3MubGVuZ3RoO1xuICB2YXIgc3RyID0gU3RyaW5nKGYpLnJlcGxhY2UoZm9ybWF0UmVnRXhwLCBmdW5jdGlvbih4KSB7XG4gICAgaWYgKHggPT09ICclJScpIHJldHVybiAnJSc7XG4gICAgaWYgKGkgPj0gbGVuKSByZXR1cm4geDtcbiAgICBzd2l0Y2ggKHgpIHtcbiAgICAgIGNhc2UgJyVzJzogcmV0dXJuIFN0cmluZyhhcmdzW2krK10pO1xuICAgICAgY2FzZSAnJWQnOiByZXR1cm4gTnVtYmVyKGFyZ3NbaSsrXSk7XG4gICAgICBjYXNlICclaic6XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGFyZ3NbaSsrXSk7XG4gICAgICAgIH0gY2F0Y2ggKF8pIHtcbiAgICAgICAgICByZXR1cm4gJ1tDaXJjdWxhcl0nO1xuICAgICAgICB9XG4gICAgICBkZWZhdWx0OlxuICAgICAgICByZXR1cm4geDtcbiAgICB9XG4gIH0pO1xuICBmb3IgKHZhciB4ID0gYXJnc1tpXTsgaSA8IGxlbjsgeCA9IGFyZ3NbKytpXSkge1xuICAgIGlmIChpc051bGwoeCkgfHwgIWlzT2JqZWN0KHgpKSB7XG4gICAgICBzdHIgKz0gJyAnICsgeDtcbiAgICB9IGVsc2Uge1xuICAgICAgc3RyICs9ICcgJyArIGluc3BlY3QoeCk7XG4gICAgfVxuICB9XG4gIHJldHVybiBzdHI7XG59O1xuXG5cbi8vIE1hcmsgdGhhdCBhIG1ldGhvZCBzaG91bGQgbm90IGJlIHVzZWQuXG4vLyBSZXR1cm5zIGEgbW9kaWZpZWQgZnVuY3Rpb24gd2hpY2ggd2FybnMgb25jZSBieSBkZWZhdWx0LlxuLy8gSWYgLS1uby1kZXByZWNhdGlvbiBpcyBzZXQsIHRoZW4gaXQgaXMgYSBuby1vcC5cbmV4cG9ydHMuZGVwcmVjYXRlID0gZnVuY3Rpb24oZm4sIG1zZykge1xuICAvLyBBbGxvdyBmb3IgZGVwcmVjYXRpbmcgdGhpbmdzIGluIHRoZSBwcm9jZXNzIG9mIHN0YXJ0aW5nIHVwLlxuICBpZiAoaXNVbmRlZmluZWQoZ2xvYmFsLnByb2Nlc3MpKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgcmV0dXJuIGV4cG9ydHMuZGVwcmVjYXRlKGZuLCBtc2cpLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfTtcbiAgfVxuXG4gIGlmIChwcm9jZXNzLm5vRGVwcmVjYXRpb24gPT09IHRydWUpIHtcbiAgICByZXR1cm4gZm47XG4gIH1cblxuICB2YXIgd2FybmVkID0gZmFsc2U7XG4gIGZ1bmN0aW9uIGRlcHJlY2F0ZWQoKSB7XG4gICAgaWYgKCF3YXJuZWQpIHtcbiAgICAgIGlmIChwcm9jZXNzLnRocm93RGVwcmVjYXRpb24pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XG4gICAgICB9IGVsc2UgaWYgKHByb2Nlc3MudHJhY2VEZXByZWNhdGlvbikge1xuICAgICAgICBjb25zb2xlLnRyYWNlKG1zZyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmVycm9yKG1zZyk7XG4gICAgICB9XG4gICAgICB3YXJuZWQgPSB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfVxuXG4gIHJldHVybiBkZXByZWNhdGVkO1xufTtcblxuXG52YXIgZGVidWdzID0ge307XG52YXIgZGVidWdFbnZpcm9uO1xuZXhwb3J0cy5kZWJ1Z2xvZyA9IGZ1bmN0aW9uKHNldCkge1xuICBpZiAoaXNVbmRlZmluZWQoZGVidWdFbnZpcm9uKSlcbiAgICBkZWJ1Z0Vudmlyb24gPSBwcm9jZXNzLmVudi5OT0RFX0RFQlVHIHx8ICcnO1xuICBzZXQgPSBzZXQudG9VcHBlckNhc2UoKTtcbiAgaWYgKCFkZWJ1Z3Nbc2V0XSkge1xuICAgIGlmIChuZXcgUmVnRXhwKCdcXFxcYicgKyBzZXQgKyAnXFxcXGInLCAnaScpLnRlc3QoZGVidWdFbnZpcm9uKSkge1xuICAgICAgdmFyIHBpZCA9IHByb2Nlc3MucGlkO1xuICAgICAgZGVidWdzW3NldF0gPSBmdW5jdGlvbigpIHtcbiAgICAgICAgdmFyIG1zZyA9IGV4cG9ydHMuZm9ybWF0LmFwcGx5KGV4cG9ydHMsIGFyZ3VtZW50cyk7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoJyVzICVkOiAlcycsIHNldCwgcGlkLCBtc2cpO1xuICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgZGVidWdzW3NldF0gPSBmdW5jdGlvbigpIHt9O1xuICAgIH1cbiAgfVxuICByZXR1cm4gZGVidWdzW3NldF07XG59O1xuXG5cbi8qKlxuICogRWNob3MgdGhlIHZhbHVlIG9mIGEgdmFsdWUuIFRyeXMgdG8gcHJpbnQgdGhlIHZhbHVlIG91dFxuICogaW4gdGhlIGJlc3Qgd2F5IHBvc3NpYmxlIGdpdmVuIHRoZSBkaWZmZXJlbnQgdHlwZXMuXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IG9iaiBUaGUgb2JqZWN0IHRvIHByaW50IG91dC5cbiAqIEBwYXJhbSB7T2JqZWN0fSBvcHRzIE9wdGlvbmFsIG9wdGlvbnMgb2JqZWN0IHRoYXQgYWx0ZXJzIHRoZSBvdXRwdXQuXG4gKi9cbi8qIGxlZ2FjeTogb2JqLCBzaG93SGlkZGVuLCBkZXB0aCwgY29sb3JzKi9cbmZ1bmN0aW9uIGluc3BlY3Qob2JqLCBvcHRzKSB7XG4gIC8vIGRlZmF1bHQgb3B0aW9uc1xuICB2YXIgY3R4ID0ge1xuICAgIHNlZW46IFtdLFxuICAgIHN0eWxpemU6IHN0eWxpemVOb0NvbG9yXG4gIH07XG4gIC8vIGxlZ2FjeS4uLlxuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+PSAzKSBjdHguZGVwdGggPSBhcmd1bWVudHNbMl07XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID49IDQpIGN0eC5jb2xvcnMgPSBhcmd1bWVudHNbM107XG4gIGlmIChpc0Jvb2xlYW4ob3B0cykpIHtcbiAgICAvLyBsZWdhY3kuLi5cbiAgICBjdHguc2hvd0hpZGRlbiA9IG9wdHM7XG4gIH0gZWxzZSBpZiAob3B0cykge1xuICAgIC8vIGdvdCBhbiBcIm9wdGlvbnNcIiBvYmplY3RcbiAgICBleHBvcnRzLl9leHRlbmQoY3R4LCBvcHRzKTtcbiAgfVxuICAvLyBzZXQgZGVmYXVsdCBvcHRpb25zXG4gIGlmIChpc1VuZGVmaW5lZChjdHguc2hvd0hpZGRlbikpIGN0eC5zaG93SGlkZGVuID0gZmFsc2U7XG4gIGlmIChpc1VuZGVmaW5lZChjdHguZGVwdGgpKSBjdHguZGVwdGggPSAyO1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LmNvbG9ycykpIGN0eC5jb2xvcnMgPSBmYWxzZTtcbiAgaWYgKGlzVW5kZWZpbmVkKGN0eC5jdXN0b21JbnNwZWN0KSkgY3R4LmN1c3RvbUluc3BlY3QgPSB0cnVlO1xuICBpZiAoY3R4LmNvbG9ycykgY3R4LnN0eWxpemUgPSBzdHlsaXplV2l0aENvbG9yO1xuICByZXR1cm4gZm9ybWF0VmFsdWUoY3R4LCBvYmosIGN0eC5kZXB0aCk7XG59XG5leHBvcnRzLmluc3BlY3QgPSBpbnNwZWN0O1xuXG5cbi8vIGh0dHA6Ly9lbi53aWtpcGVkaWEub3JnL3dpa2kvQU5TSV9lc2NhcGVfY29kZSNncmFwaGljc1xuaW5zcGVjdC5jb2xvcnMgPSB7XG4gICdib2xkJyA6IFsxLCAyMl0sXG4gICdpdGFsaWMnIDogWzMsIDIzXSxcbiAgJ3VuZGVybGluZScgOiBbNCwgMjRdLFxuICAnaW52ZXJzZScgOiBbNywgMjddLFxuICAnd2hpdGUnIDogWzM3LCAzOV0sXG4gICdncmV5JyA6IFs5MCwgMzldLFxuICAnYmxhY2snIDogWzMwLCAzOV0sXG4gICdibHVlJyA6IFszNCwgMzldLFxuICAnY3lhbicgOiBbMzYsIDM5XSxcbiAgJ2dyZWVuJyA6IFszMiwgMzldLFxuICAnbWFnZW50YScgOiBbMzUsIDM5XSxcbiAgJ3JlZCcgOiBbMzEsIDM5XSxcbiAgJ3llbGxvdycgOiBbMzMsIDM5XVxufTtcblxuLy8gRG9uJ3QgdXNlICdibHVlJyBub3QgdmlzaWJsZSBvbiBjbWQuZXhlXG5pbnNwZWN0LnN0eWxlcyA9IHtcbiAgJ3NwZWNpYWwnOiAnY3lhbicsXG4gICdudW1iZXInOiAneWVsbG93JyxcbiAgJ2Jvb2xlYW4nOiAneWVsbG93JyxcbiAgJ3VuZGVmaW5lZCc6ICdncmV5JyxcbiAgJ251bGwnOiAnYm9sZCcsXG4gICdzdHJpbmcnOiAnZ3JlZW4nLFxuICAnZGF0ZSc6ICdtYWdlbnRhJyxcbiAgLy8gXCJuYW1lXCI6IGludGVudGlvbmFsbHkgbm90IHN0eWxpbmdcbiAgJ3JlZ2V4cCc6ICdyZWQnXG59O1xuXG5cbmZ1bmN0aW9uIHN0eWxpemVXaXRoQ29sb3Ioc3RyLCBzdHlsZVR5cGUpIHtcbiAgdmFyIHN0eWxlID0gaW5zcGVjdC5zdHlsZXNbc3R5bGVUeXBlXTtcblxuICBpZiAoc3R5bGUpIHtcbiAgICByZXR1cm4gJ1xcdTAwMWJbJyArIGluc3BlY3QuY29sb3JzW3N0eWxlXVswXSArICdtJyArIHN0ciArXG4gICAgICAgICAgICdcXHUwMDFiWycgKyBpbnNwZWN0LmNvbG9yc1tzdHlsZV1bMV0gKyAnbSc7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIHN0cjtcbiAgfVxufVxuXG5cbmZ1bmN0aW9uIHN0eWxpemVOb0NvbG9yKHN0ciwgc3R5bGVUeXBlKSB7XG4gIHJldHVybiBzdHI7XG59XG5cblxuZnVuY3Rpb24gYXJyYXlUb0hhc2goYXJyYXkpIHtcbiAgdmFyIGhhc2ggPSB7fTtcblxuICBhcnJheS5mb3JFYWNoKGZ1bmN0aW9uKHZhbCwgaWR4KSB7XG4gICAgaGFzaFt2YWxdID0gdHJ1ZTtcbiAgfSk7XG5cbiAgcmV0dXJuIGhhc2g7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0VmFsdWUoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzKSB7XG4gIC8vIFByb3ZpZGUgYSBob29rIGZvciB1c2VyLXNwZWNpZmllZCBpbnNwZWN0IGZ1bmN0aW9ucy5cbiAgLy8gQ2hlY2sgdGhhdCB2YWx1ZSBpcyBhbiBvYmplY3Qgd2l0aCBhbiBpbnNwZWN0IGZ1bmN0aW9uIG9uIGl0XG4gIGlmIChjdHguY3VzdG9tSW5zcGVjdCAmJlxuICAgICAgdmFsdWUgJiZcbiAgICAgIGlzRnVuY3Rpb24odmFsdWUuaW5zcGVjdCkgJiZcbiAgICAgIC8vIEZpbHRlciBvdXQgdGhlIHV0aWwgbW9kdWxlLCBpdCdzIGluc3BlY3QgZnVuY3Rpb24gaXMgc3BlY2lhbFxuICAgICAgdmFsdWUuaW5zcGVjdCAhPT0gZXhwb3J0cy5pbnNwZWN0ICYmXG4gICAgICAvLyBBbHNvIGZpbHRlciBvdXQgYW55IHByb3RvdHlwZSBvYmplY3RzIHVzaW5nIHRoZSBjaXJjdWxhciBjaGVjay5cbiAgICAgICEodmFsdWUuY29uc3RydWN0b3IgJiYgdmFsdWUuY29uc3RydWN0b3IucHJvdG90eXBlID09PSB2YWx1ZSkpIHtcbiAgICB2YXIgcmV0ID0gdmFsdWUuaW5zcGVjdChyZWN1cnNlVGltZXMsIGN0eCk7XG4gICAgaWYgKCFpc1N0cmluZyhyZXQpKSB7XG4gICAgICByZXQgPSBmb3JtYXRWYWx1ZShjdHgsIHJldCwgcmVjdXJzZVRpbWVzKTtcbiAgICB9XG4gICAgcmV0dXJuIHJldDtcbiAgfVxuXG4gIC8vIFByaW1pdGl2ZSB0eXBlcyBjYW5ub3QgaGF2ZSBwcm9wZXJ0aWVzXG4gIHZhciBwcmltaXRpdmUgPSBmb3JtYXRQcmltaXRpdmUoY3R4LCB2YWx1ZSk7XG4gIGlmIChwcmltaXRpdmUpIHtcbiAgICByZXR1cm4gcHJpbWl0aXZlO1xuICB9XG5cbiAgLy8gTG9vayB1cCB0aGUga2V5cyBvZiB0aGUgb2JqZWN0LlxuICB2YXIga2V5cyA9IE9iamVjdC5rZXlzKHZhbHVlKTtcbiAgdmFyIHZpc2libGVLZXlzID0gYXJyYXlUb0hhc2goa2V5cyk7XG5cbiAgaWYgKGN0eC5zaG93SGlkZGVuKSB7XG4gICAga2V5cyA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eU5hbWVzKHZhbHVlKTtcbiAgfVxuXG4gIC8vIElFIGRvZXNuJ3QgbWFrZSBlcnJvciBmaWVsZHMgbm9uLWVudW1lcmFibGVcbiAgLy8gaHR0cDovL21zZG4ubWljcm9zb2Z0LmNvbS9lbi11cy9saWJyYXJ5L2llL2R3dzUyc2J0KHY9dnMuOTQpLmFzcHhcbiAgaWYgKGlzRXJyb3IodmFsdWUpXG4gICAgICAmJiAoa2V5cy5pbmRleE9mKCdtZXNzYWdlJykgPj0gMCB8fCBrZXlzLmluZGV4T2YoJ2Rlc2NyaXB0aW9uJykgPj0gMCkpIHtcbiAgICByZXR1cm4gZm9ybWF0RXJyb3IodmFsdWUpO1xuICB9XG5cbiAgLy8gU29tZSB0eXBlIG9mIG9iamVjdCB3aXRob3V0IHByb3BlcnRpZXMgY2FuIGJlIHNob3J0Y3V0dGVkLlxuICBpZiAoa2V5cy5sZW5ndGggPT09IDApIHtcbiAgICBpZiAoaXNGdW5jdGlvbih2YWx1ZSkpIHtcbiAgICAgIHZhciBuYW1lID0gdmFsdWUubmFtZSA/ICc6ICcgKyB2YWx1ZS5uYW1lIDogJyc7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoJ1tGdW5jdGlvbicgKyBuYW1lICsgJ10nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgICBpZiAoaXNSZWdFeHAodmFsdWUpKSB7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoUmVnRXhwLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKSwgJ3JlZ2V4cCcpO1xuICAgIH1cbiAgICBpZiAoaXNEYXRlKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKERhdGUucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpLCAnZGF0ZScpO1xuICAgIH1cbiAgICBpZiAoaXNFcnJvcih2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBmb3JtYXRFcnJvcih2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgdmFyIGJhc2UgPSAnJywgYXJyYXkgPSBmYWxzZSwgYnJhY2VzID0gWyd7JywgJ30nXTtcblxuICAvLyBNYWtlIEFycmF5IHNheSB0aGF0IHRoZXkgYXJlIEFycmF5XG4gIGlmIChpc0FycmF5KHZhbHVlKSkge1xuICAgIGFycmF5ID0gdHJ1ZTtcbiAgICBicmFjZXMgPSBbJ1snLCAnXSddO1xuICB9XG5cbiAgLy8gTWFrZSBmdW5jdGlvbnMgc2F5IHRoYXQgdGhleSBhcmUgZnVuY3Rpb25zXG4gIGlmIChpc0Z1bmN0aW9uKHZhbHVlKSkge1xuICAgIHZhciBuID0gdmFsdWUubmFtZSA/ICc6ICcgKyB2YWx1ZS5uYW1lIDogJyc7XG4gICAgYmFzZSA9ICcgW0Z1bmN0aW9uJyArIG4gKyAnXSc7XG4gIH1cblxuICAvLyBNYWtlIFJlZ0V4cHMgc2F5IHRoYXQgdGhleSBhcmUgUmVnRXhwc1xuICBpZiAoaXNSZWdFeHAodmFsdWUpKSB7XG4gICAgYmFzZSA9ICcgJyArIFJlZ0V4cC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSk7XG4gIH1cblxuICAvLyBNYWtlIGRhdGVzIHdpdGggcHJvcGVydGllcyBmaXJzdCBzYXkgdGhlIGRhdGVcbiAgaWYgKGlzRGF0ZSh2YWx1ZSkpIHtcbiAgICBiYXNlID0gJyAnICsgRGF0ZS5wcm90b3R5cGUudG9VVENTdHJpbmcuY2FsbCh2YWx1ZSk7XG4gIH1cblxuICAvLyBNYWtlIGVycm9yIHdpdGggbWVzc2FnZSBmaXJzdCBzYXkgdGhlIGVycm9yXG4gIGlmIChpc0Vycm9yKHZhbHVlKSkge1xuICAgIGJhc2UgPSAnICcgKyBmb3JtYXRFcnJvcih2YWx1ZSk7XG4gIH1cblxuICBpZiAoa2V5cy5sZW5ndGggPT09IDAgJiYgKCFhcnJheSB8fCB2YWx1ZS5sZW5ndGggPT0gMCkpIHtcbiAgICByZXR1cm4gYnJhY2VzWzBdICsgYmFzZSArIGJyYWNlc1sxXTtcbiAgfVxuXG4gIGlmIChyZWN1cnNlVGltZXMgPCAwKSB7XG4gICAgaWYgKGlzUmVnRXhwKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKFJlZ0V4cC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSksICdyZWdleHAnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKCdbT2JqZWN0XScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9XG5cbiAgY3R4LnNlZW4ucHVzaCh2YWx1ZSk7XG5cbiAgdmFyIG91dHB1dDtcbiAgaWYgKGFycmF5KSB7XG4gICAgb3V0cHV0ID0gZm9ybWF0QXJyYXkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5cyk7XG4gIH0gZWxzZSB7XG4gICAgb3V0cHV0ID0ga2V5cy5tYXAoZnVuY3Rpb24oa2V5KSB7XG4gICAgICByZXR1cm4gZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5LCBhcnJheSk7XG4gICAgfSk7XG4gIH1cblxuICBjdHguc2Vlbi5wb3AoKTtcblxuICByZXR1cm4gcmVkdWNlVG9TaW5nbGVTdHJpbmcob3V0cHV0LCBiYXNlLCBicmFjZXMpO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdFByaW1pdGl2ZShjdHgsIHZhbHVlKSB7XG4gIGlmIChpc1VuZGVmaW5lZCh2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCd1bmRlZmluZWQnLCAndW5kZWZpbmVkJyk7XG4gIGlmIChpc1N0cmluZyh2YWx1ZSkpIHtcbiAgICB2YXIgc2ltcGxlID0gJ1xcJycgKyBKU09OLnN0cmluZ2lmeSh2YWx1ZSkucmVwbGFjZSgvXlwifFwiJC9nLCAnJylcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIilcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXFxcXCIvZywgJ1wiJykgKyAnXFwnJztcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoc2ltcGxlLCAnc3RyaW5nJyk7XG4gIH1cbiAgaWYgKGlzTnVtYmVyKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJycgKyB2YWx1ZSwgJ251bWJlcicpO1xuICBpZiAoaXNCb29sZWFuKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJycgKyB2YWx1ZSwgJ2Jvb2xlYW4nKTtcbiAgLy8gRm9yIHNvbWUgcmVhc29uIHR5cGVvZiBudWxsIGlzIFwib2JqZWN0XCIsIHNvIHNwZWNpYWwgY2FzZSBoZXJlLlxuICBpZiAoaXNOdWxsKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJ251bGwnLCAnbnVsbCcpO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdEVycm9yKHZhbHVlKSB7XG4gIHJldHVybiAnWycgKyBFcnJvci5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSkgKyAnXSc7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0QXJyYXkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5cykge1xuICB2YXIgb3V0cHV0ID0gW107XG4gIGZvciAodmFyIGkgPSAwLCBsID0gdmFsdWUubGVuZ3RoOyBpIDwgbDsgKytpKSB7XG4gICAgaWYgKGhhc093blByb3BlcnR5KHZhbHVlLCBTdHJpbmcoaSkpKSB7XG4gICAgICBvdXRwdXQucHVzaChmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLFxuICAgICAgICAgIFN0cmluZyhpKSwgdHJ1ZSkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBvdXRwdXQucHVzaCgnJyk7XG4gICAgfVxuICB9XG4gIGtleXMuZm9yRWFjaChmdW5jdGlvbihrZXkpIHtcbiAgICBpZiAoIWtleS5tYXRjaCgvXlxcZCskLykpIHtcbiAgICAgIG91dHB1dC5wdXNoKGZvcm1hdFByb3BlcnR5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsXG4gICAgICAgICAga2V5LCB0cnVlKSk7XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIG91dHB1dDtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLCBrZXksIGFycmF5KSB7XG4gIHZhciBuYW1lLCBzdHIsIGRlc2M7XG4gIGRlc2MgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHZhbHVlLCBrZXkpIHx8IHsgdmFsdWU6IHZhbHVlW2tleV0gfTtcbiAgaWYgKGRlc2MuZ2V0KSB7XG4gICAgaWYgKGRlc2Muc2V0KSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW0dldHRlci9TZXR0ZXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tHZXR0ZXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgaWYgKGRlc2Muc2V0KSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW1NldHRlcl0nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgfVxuICBpZiAoIWhhc093blByb3BlcnR5KHZpc2libGVLZXlzLCBrZXkpKSB7XG4gICAgbmFtZSA9ICdbJyArIGtleSArICddJztcbiAgfVxuICBpZiAoIXN0cikge1xuICAgIGlmIChjdHguc2Vlbi5pbmRleE9mKGRlc2MudmFsdWUpIDwgMCkge1xuICAgICAgaWYgKGlzTnVsbChyZWN1cnNlVGltZXMpKSB7XG4gICAgICAgIHN0ciA9IGZvcm1hdFZhbHVlKGN0eCwgZGVzYy52YWx1ZSwgbnVsbCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzdHIgPSBmb3JtYXRWYWx1ZShjdHgsIGRlc2MudmFsdWUsIHJlY3Vyc2VUaW1lcyAtIDEpO1xuICAgICAgfVxuICAgICAgaWYgKHN0ci5pbmRleE9mKCdcXG4nKSA+IC0xKSB7XG4gICAgICAgIGlmIChhcnJheSkge1xuICAgICAgICAgIHN0ciA9IHN0ci5zcGxpdCgnXFxuJykubWFwKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgICAgICAgIHJldHVybiAnICAnICsgbGluZTtcbiAgICAgICAgICB9KS5qb2luKCdcXG4nKS5zdWJzdHIoMik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc3RyID0gJ1xcbicgKyBzdHIuc3BsaXQoJ1xcbicpLm1hcChmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgICAgICByZXR1cm4gJyAgICcgKyBsaW5lO1xuICAgICAgICAgIH0pLmpvaW4oJ1xcbicpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0ciA9IGN0eC5zdHlsaXplKCdbQ2lyY3VsYXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH1cbiAgaWYgKGlzVW5kZWZpbmVkKG5hbWUpKSB7XG4gICAgaWYgKGFycmF5ICYmIGtleS5tYXRjaCgvXlxcZCskLykpIHtcbiAgICAgIHJldHVybiBzdHI7XG4gICAgfVxuICAgIG5hbWUgPSBKU09OLnN0cmluZ2lmeSgnJyArIGtleSk7XG4gICAgaWYgKG5hbWUubWF0Y2goL15cIihbYS16QS1aX11bYS16QS1aXzAtOV0qKVwiJC8pKSB7XG4gICAgICBuYW1lID0gbmFtZS5zdWJzdHIoMSwgbmFtZS5sZW5ndGggLSAyKTtcbiAgICAgIG5hbWUgPSBjdHguc3R5bGl6ZShuYW1lLCAnbmFtZScpO1xuICAgIH0gZWxzZSB7XG4gICAgICBuYW1lID0gbmFtZS5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIilcbiAgICAgICAgICAgICAgICAgLnJlcGxhY2UoL1xcXFxcIi9nLCAnXCInKVxuICAgICAgICAgICAgICAgICAucmVwbGFjZSgvKF5cInxcIiQpL2csIFwiJ1wiKTtcbiAgICAgIG5hbWUgPSBjdHguc3R5bGl6ZShuYW1lLCAnc3RyaW5nJyk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG5hbWUgKyAnOiAnICsgc3RyO1xufVxuXG5cbmZ1bmN0aW9uIHJlZHVjZVRvU2luZ2xlU3RyaW5nKG91dHB1dCwgYmFzZSwgYnJhY2VzKSB7XG4gIHZhciBudW1MaW5lc0VzdCA9IDA7XG4gIHZhciBsZW5ndGggPSBvdXRwdXQucmVkdWNlKGZ1bmN0aW9uKHByZXYsIGN1cikge1xuICAgIG51bUxpbmVzRXN0Kys7XG4gICAgaWYgKGN1ci5pbmRleE9mKCdcXG4nKSA+PSAwKSBudW1MaW5lc0VzdCsrO1xuICAgIHJldHVybiBwcmV2ICsgY3VyLnJlcGxhY2UoL1xcdTAwMWJcXFtcXGRcXGQ/bS9nLCAnJykubGVuZ3RoICsgMTtcbiAgfSwgMCk7XG5cbiAgaWYgKGxlbmd0aCA+IDYwKSB7XG4gICAgcmV0dXJuIGJyYWNlc1swXSArXG4gICAgICAgICAgIChiYXNlID09PSAnJyA/ICcnIDogYmFzZSArICdcXG4gJykgK1xuICAgICAgICAgICAnICcgK1xuICAgICAgICAgICBvdXRwdXQuam9pbignLFxcbiAgJykgK1xuICAgICAgICAgICAnICcgK1xuICAgICAgICAgICBicmFjZXNbMV07XG4gIH1cblxuICByZXR1cm4gYnJhY2VzWzBdICsgYmFzZSArICcgJyArIG91dHB1dC5qb2luKCcsICcpICsgJyAnICsgYnJhY2VzWzFdO1xufVxuXG5cbi8vIE5PVEU6IFRoZXNlIHR5cGUgY2hlY2tpbmcgZnVuY3Rpb25zIGludGVudGlvbmFsbHkgZG9uJ3QgdXNlIGBpbnN0YW5jZW9mYFxuLy8gYmVjYXVzZSBpdCBpcyBmcmFnaWxlIGFuZCBjYW4gYmUgZWFzaWx5IGZha2VkIHdpdGggYE9iamVjdC5jcmVhdGUoKWAuXG5mdW5jdGlvbiBpc0FycmF5KGFyKSB7XG4gIHJldHVybiBBcnJheS5pc0FycmF5KGFyKTtcbn1cbmV4cG9ydHMuaXNBcnJheSA9IGlzQXJyYXk7XG5cbmZ1bmN0aW9uIGlzQm9vbGVhbihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdib29sZWFuJztcbn1cbmV4cG9ydHMuaXNCb29sZWFuID0gaXNCb29sZWFuO1xuXG5mdW5jdGlvbiBpc051bGwoYXJnKSB7XG4gIHJldHVybiBhcmcgPT09IG51bGw7XG59XG5leHBvcnRzLmlzTnVsbCA9IGlzTnVsbDtcblxuZnVuY3Rpb24gaXNOdWxsT3JVbmRlZmluZWQoYXJnKSB7XG4gIHJldHVybiBhcmcgPT0gbnVsbDtcbn1cbmV4cG9ydHMuaXNOdWxsT3JVbmRlZmluZWQgPSBpc051bGxPclVuZGVmaW5lZDtcblxuZnVuY3Rpb24gaXNOdW1iZXIoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnbnVtYmVyJztcbn1cbmV4cG9ydHMuaXNOdW1iZXIgPSBpc051bWJlcjtcblxuZnVuY3Rpb24gaXNTdHJpbmcoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnc3RyaW5nJztcbn1cbmV4cG9ydHMuaXNTdHJpbmcgPSBpc1N0cmluZztcblxuZnVuY3Rpb24gaXNTeW1ib2woYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnc3ltYm9sJztcbn1cbmV4cG9ydHMuaXNTeW1ib2wgPSBpc1N5bWJvbDtcblxuZnVuY3Rpb24gaXNVbmRlZmluZWQoYXJnKSB7XG4gIHJldHVybiBhcmcgPT09IHZvaWQgMDtcbn1cbmV4cG9ydHMuaXNVbmRlZmluZWQgPSBpc1VuZGVmaW5lZDtcblxuZnVuY3Rpb24gaXNSZWdFeHAocmUpIHtcbiAgcmV0dXJuIGlzT2JqZWN0KHJlKSAmJiBvYmplY3RUb1N0cmluZyhyZSkgPT09ICdbb2JqZWN0IFJlZ0V4cF0nO1xufVxuZXhwb3J0cy5pc1JlZ0V4cCA9IGlzUmVnRXhwO1xuXG5mdW5jdGlvbiBpc09iamVjdChhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdvYmplY3QnICYmIGFyZyAhPT0gbnVsbDtcbn1cbmV4cG9ydHMuaXNPYmplY3QgPSBpc09iamVjdDtcblxuZnVuY3Rpb24gaXNEYXRlKGQpIHtcbiAgcmV0dXJuIGlzT2JqZWN0KGQpICYmIG9iamVjdFRvU3RyaW5nKGQpID09PSAnW29iamVjdCBEYXRlXSc7XG59XG5leHBvcnRzLmlzRGF0ZSA9IGlzRGF0ZTtcblxuZnVuY3Rpb24gaXNFcnJvcihlKSB7XG4gIHJldHVybiBpc09iamVjdChlKSAmJlxuICAgICAgKG9iamVjdFRvU3RyaW5nKGUpID09PSAnW29iamVjdCBFcnJvcl0nIHx8IGUgaW5zdGFuY2VvZiBFcnJvcik7XG59XG5leHBvcnRzLmlzRXJyb3IgPSBpc0Vycm9yO1xuXG5mdW5jdGlvbiBpc0Z1bmN0aW9uKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ2Z1bmN0aW9uJztcbn1cbmV4cG9ydHMuaXNGdW5jdGlvbiA9IGlzRnVuY3Rpb247XG5cbmZ1bmN0aW9uIGlzUHJpbWl0aXZlKGFyZykge1xuICByZXR1cm4gYXJnID09PSBudWxsIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnYm9vbGVhbicgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdudW1iZXInIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnc3RyaW5nJyB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ3N5bWJvbCcgfHwgIC8vIEVTNiBzeW1ib2xcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICd1bmRlZmluZWQnO1xufVxuZXhwb3J0cy5pc1ByaW1pdGl2ZSA9IGlzUHJpbWl0aXZlO1xuXG5leHBvcnRzLmlzQnVmZmVyID0gcmVxdWlyZSgnLi9zdXBwb3J0L2lzQnVmZmVyJyk7XG5cbmZ1bmN0aW9uIG9iamVjdFRvU3RyaW5nKG8pIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChvKTtcbn1cblxuXG5mdW5jdGlvbiBwYWQobikge1xuICByZXR1cm4gbiA8IDEwID8gJzAnICsgbi50b1N0cmluZygxMCkgOiBuLnRvU3RyaW5nKDEwKTtcbn1cblxuXG52YXIgbW9udGhzID0gWydKYW4nLCAnRmViJywgJ01hcicsICdBcHInLCAnTWF5JywgJ0p1bicsICdKdWwnLCAnQXVnJywgJ1NlcCcsXG4gICAgICAgICAgICAgICdPY3QnLCAnTm92JywgJ0RlYyddO1xuXG4vLyAyNiBGZWIgMTY6MTk6MzRcbmZ1bmN0aW9uIHRpbWVzdGFtcCgpIHtcbiAgdmFyIGQgPSBuZXcgRGF0ZSgpO1xuICB2YXIgdGltZSA9IFtwYWQoZC5nZXRIb3VycygpKSxcbiAgICAgICAgICAgICAgcGFkKGQuZ2V0TWludXRlcygpKSxcbiAgICAgICAgICAgICAgcGFkKGQuZ2V0U2Vjb25kcygpKV0uam9pbignOicpO1xuICByZXR1cm4gW2QuZ2V0RGF0ZSgpLCBtb250aHNbZC5nZXRNb250aCgpXSwgdGltZV0uam9pbignICcpO1xufVxuXG5cbi8vIGxvZyBpcyBqdXN0IGEgdGhpbiB3cmFwcGVyIHRvIGNvbnNvbGUubG9nIHRoYXQgcHJlcGVuZHMgYSB0aW1lc3RhbXBcbmV4cG9ydHMubG9nID0gZnVuY3Rpb24oKSB7XG4gIGNvbnNvbGUubG9nKCclcyAtICVzJywgdGltZXN0YW1wKCksIGV4cG9ydHMuZm9ybWF0LmFwcGx5KGV4cG9ydHMsIGFyZ3VtZW50cykpO1xufTtcblxuXG4vKipcbiAqIEluaGVyaXQgdGhlIHByb3RvdHlwZSBtZXRob2RzIGZyb20gb25lIGNvbnN0cnVjdG9yIGludG8gYW5vdGhlci5cbiAqXG4gKiBUaGUgRnVuY3Rpb24ucHJvdG90eXBlLmluaGVyaXRzIGZyb20gbGFuZy5qcyByZXdyaXR0ZW4gYXMgYSBzdGFuZGFsb25lXG4gKiBmdW5jdGlvbiAobm90IG9uIEZ1bmN0aW9uLnByb3RvdHlwZSkuIE5PVEU6IElmIHRoaXMgZmlsZSBpcyB0byBiZSBsb2FkZWRcbiAqIGR1cmluZyBib290c3RyYXBwaW5nIHRoaXMgZnVuY3Rpb24gbmVlZHMgdG8gYmUgcmV3cml0dGVuIHVzaW5nIHNvbWUgbmF0aXZlXG4gKiBmdW5jdGlvbnMgYXMgcHJvdG90eXBlIHNldHVwIHVzaW5nIG5vcm1hbCBKYXZhU2NyaXB0IGRvZXMgbm90IHdvcmsgYXNcbiAqIGV4cGVjdGVkIGR1cmluZyBib290c3RyYXBwaW5nIChzZWUgbWlycm9yLmpzIGluIHIxMTQ5MDMpLlxuICpcbiAqIEBwYXJhbSB7ZnVuY3Rpb259IGN0b3IgQ29uc3RydWN0b3IgZnVuY3Rpb24gd2hpY2ggbmVlZHMgdG8gaW5oZXJpdCB0aGVcbiAqICAgICBwcm90b3R5cGUuXG4gKiBAcGFyYW0ge2Z1bmN0aW9ufSBzdXBlckN0b3IgQ29uc3RydWN0b3IgZnVuY3Rpb24gdG8gaW5oZXJpdCBwcm90b3R5cGUgZnJvbS5cbiAqL1xuZXhwb3J0cy5pbmhlcml0cyA9IHJlcXVpcmUoJ2luaGVyaXRzJyk7XG5cbmV4cG9ydHMuX2V4dGVuZCA9IGZ1bmN0aW9uKG9yaWdpbiwgYWRkKSB7XG4gIC8vIERvbid0IGRvIGFueXRoaW5nIGlmIGFkZCBpc24ndCBhbiBvYmplY3RcbiAgaWYgKCFhZGQgfHwgIWlzT2JqZWN0KGFkZCkpIHJldHVybiBvcmlnaW47XG5cbiAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyhhZGQpO1xuICB2YXIgaSA9IGtleXMubGVuZ3RoO1xuICB3aGlsZSAoaS0tKSB7XG4gICAgb3JpZ2luW2tleXNbaV1dID0gYWRkW2tleXNbaV1dO1xuICB9XG4gIHJldHVybiBvcmlnaW47XG59O1xuXG5mdW5jdGlvbiBoYXNPd25Qcm9wZXJ0eShvYmosIHByb3ApIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIHByb3ApO1xufVxuIiwiLyogZ2xvYmFsIGRlc2NyaWJlIGl0ICovXG5jb25zdCBhc3NlcnQgPSByZXF1aXJlKCdhc3NlcnQnKTtcbmNvbnN0IGRlcSA9ICh6X2V4cGVjdCwgel9hY3R1YWwpID0+IHtcblx0YXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh6X2FjdHVhbCwgel9leHBlY3QpO1xufTtcbmNvbnN0IGVxID0gKHpfZXhwZWN0LCB6X2FjdHVhbCkgPT4ge1xuXHRhc3NlcnQuc3RyaWN0RXF1YWwoel9hY3R1YWwsIHpfZXhwZWN0KTtcbn07XG5jb25zdCBmcyA9IHJlcXVpcmUoJ2ZzJyk7XG5cbmNvbnN0IHdvcmtlciA9IHJlcXVpcmUoJy4uLy4uL2Rpc3QvbWFpbi9tb2R1bGUuanMnKS5zY29waWZ5KHJlcXVpcmUsICgpID0+IHtcblx0cmVxdWlyZSgnLi93b3JrZXJzL2Jhc2ljLmpzJyk7XG59LCAndW5kZWZpbmVkJyAhPT0gdHlwZW9mIGFyZ3VtZW50cyAmJiBhcmd1bWVudHMpO1xuXG5jb25zdCBzcGF3biA9IChzX25hbWU9J2Jhc2ljJykgPT4gd29ya2VyLnNwYXduKGAuL3dvcmtlcnMvJHtzX25hbWV9LmpzYCk7XG5jb25zdCBncm91cCA9IChuX3dvcmtlcnMsIHNfbmFtZT0nYmFzaWMnKSA9PiB3b3JrZXIuZ3JvdXAoYC4vd29ya2Vycy8ke3NfbmFtZX0uanNgLCBuX3dvcmtlcnMpO1xuXG5jb25zdCBydW4gPSBhc3luYyAoLi4uYV9hcmdzKSA9PiB7XG5cdGxldCBrX3dvcmtlciA9IHNwYXduKCk7XG5cdGxldCB6X3Jlc3VsdCA9IGF3YWl0IGtfd29ya2VyLnJ1biguLi5hX2FyZ3MpO1xuXHRhd2FpdCBrX3dvcmtlci5raWxsKCk7XG5cdHJldHVybiB6X3Jlc3VsdDtcbn07XG5cblxuZGVzY3JpYmUoJ3dvcmtlcicsICgpID0+IHtcblxuXHRpdCgncnVucycsIGFzeW5jICgpID0+IHtcblx0XHRlcSgneWVoJywgYXdhaXQgcnVuKCdyZXZlcnNlX3N0cmluZycsIFsnaGV5J10pKTtcblx0fSk7XG5cblx0aXQoJ3R3aWNlJywgYXN5bmMgKCkgPT4ge1xuXHRcdGxldCBrX3dvcmtlciA9IHNwYXduKCk7XG5cdFx0bGV0IHNfeWVoID0gYXdhaXQga193b3JrZXIucnVuKCdyZXZlcnNlX3N0cmluZycsIFsnaGV5J10pO1xuXHRcdGVxKCdoZXknLCBhd2FpdCBydW4oJ3JldmVyc2Vfc3RyaW5nJywgW3NfeWVoXSkpO1xuXHRcdGF3YWl0IGtfd29ya2VyLmtpbGwoKTtcblx0fSk7XG5cblx0aXQoJ3Rlcm1pbmF0ZXMnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQga193b3JrZXIgPSBzcGF3bigpO1xuXHRcdGtfd29ya2VyLnJ1bignd2FpdCcsIFtbNTAwMF1dKVxuXHRcdFx0LnRoZW4oKCkgPT4gZmtlX3Rlc3QoJ3dvcmtlciBkaWQgbm90IHRlcm1pbmF0ZSBiZWZvcmUgZmluaXNoaW5nIHRhc2snKSlcblx0XHRcdC5jYXRjaCgoZV9ydW4pID0+IHtcblx0XHRcdFx0ZmtlX3Rlc3QoZV9ydW4pO1xuXHRcdFx0fSk7XG5cdFx0c2V0VGltZW91dChhc3luYyAoKSA9PiB7XG5cdFx0XHRhd2FpdCBrX3dvcmtlci5raWxsKCk7XG5cdFx0XHRma2VfdGVzdCgpO1xuXHRcdH0sIDEwMCk7XG5cdH0pO1xuXG5cdGl0KCdjYXRjaGVzJywgKGZrZV90ZXN0KSA9PiB7XG5cdFx0bGV0IGtfd29ya2VyID0gc3Bhd24oKTtcblx0XHRrX3dvcmtlci5ydW4oJ2ZhaWwnKVxuXHRcdFx0LnRoZW4oKCkgPT4gZmtlX3Rlc3QoJ2Vycm9yIG5vdCBjYXVnaHQgYnkgbWFzdGVyJykpXG5cdFx0XHQuY2F0Y2goYXN5bmMgKGVfcnVuKSA9PiB7XG5cdFx0XHRcdGFzc2VydChlX3J1bi5tZXNzYWdlLmluY2x1ZGVzKCdubyBzdWNoIHRhc2snKSk7XG5cdFx0XHRcdGF3YWl0IGtfd29ya2VyLmtpbGwoKTtcblx0XHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxuXHRpdCgnZXZlbnRzJywgYXN5bmMgKCkgPT4ge1xuXHRcdGxldCBoX2NvbnZvID0ge1xuXHRcdFx0Z3JlZXQ6ICdoaScsXG5cdFx0XHRjaGF0OiAnaG93IHIgdScsXG5cdFx0XHR5ZWxsOiAnYWhoIScsXG5cdFx0XHRhcG9sb2dpemU6ICdzb3JyeScsXG5cdFx0XHRmb3JnaXZlOiAnbW1rJyxcblx0XHRcdGV4aXQ6ICdrYnllJyxcblx0XHR9O1xuXG5cdFx0bGV0IGFfZGF0YSA9IFtdO1xuXHRcdGxldCBoX3Jlc3BvbnNlcyA9IHt9O1xuXHRcdGxldCBjX3Jlc3BvbnNlcyA9IDA7XG5cdFx0T2JqZWN0LmtleXMoaF9jb252bykuZm9yRWFjaCgoc19rZXksIGlfa2V5KSA9PiB7XG5cdFx0XHRhX2RhdGEucHVzaCh7XG5cdFx0XHRcdG5hbWU6IHNfa2V5LFxuXHRcdFx0XHRkYXRhOiBoX2NvbnZvW3Nfa2V5XSxcblx0XHRcdFx0d2FpdDogaV9rZXk/IDEwMDogMCxcblx0XHRcdH0pO1xuXG5cdFx0XHRoX3Jlc3BvbnNlc1tzX2tleV0gPSAoc19tc2cpID0+IHtcblx0XHRcdFx0ZXEoaF9jb252b1tzX2tleV0sIHNfbXNnKTtcblx0XHRcdFx0Y19yZXNwb25zZXMgKz0gMTtcblx0XHRcdH07XG5cdFx0fSk7XG5cblx0XHRsZXQga193b3JrZXIgPSBzcGF3bigpO1xuXHRcdGF3YWl0IGtfd29ya2VyLnJ1bignZXZlbnRzJywgW2FfZGF0YV0sIGhfcmVzcG9uc2VzKTtcblx0XHRhd2FpdCBrX3dvcmtlci5raWxsKCk7XG5cdFx0ZXEoYV9kYXRhLmxlbmd0aCwgY19yZXNwb25zZXMpO1xuXHR9KTtcblxuXHRpdCgnc3RvcmUnLCBhc3luYyAoKSA9PiB7XG5cdFx0bGV0IGtfd29ya2VyID0gc3Bhd24oKTtcblx0XHRhd2FpdCBrX3dvcmtlci5ydW4oJ3N0b3JlJywgW1t7dGVzdDondmFsdWUnfV1dKTtcblx0XHRsZXQgYV92YWx1ZXMgPSBhd2FpdCBrX3dvcmtlci5ydW4oJ2ZldGNoJywgW1sndGVzdCddXSk7XG5cdFx0YXdhaXQga193b3JrZXIua2lsbCgpO1xuXHRcdGVxKCd2YWx1ZScsIGFfdmFsdWVzWzBdKTtcblx0fSk7XG59KTtcblxuXG5kZXNjcmliZSgnZ3JvdXAnLCAoKSA9PiB7XG5cblx0aXQoJ21hcC90aHJ1JywgKGZrZV90ZXN0KSA9PiB7XG5cdFx0bGV0IGFfc2VxID0gWzgsIDEsIDcsIDQsIDMsIDUsIDIsIDZdO1xuXHRcdGxldCBrX2dyb3VwID0gZ3JvdXAoYV9zZXEubGVuZ3RoKTtcblx0XHRrX2dyb3VwXG5cdFx0XHQuZGF0YShhX3NlcSlcblx0XHRcdC5tYXAoJ211bHRpcGx5JywgWzJdKVxuXHRcdFx0LnRocnUoJ2FkZCcsIFszXSlcblx0XHRcdC5lYWNoKCh4X24sIGlfbikgPT4ge1xuXHRcdFx0XHRlcSgoYV9zZXFbaV9uXSoyKSszLCB4X25bMF0pO1xuXHRcdFx0fSwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRhd2FpdCBrX2dyb3VwLmtpbGwoKTtcblx0XHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxuXHRpdCgnbWFwL2VhY2gnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQgYV9zZXEgPSBbOCwgMSwgNywgNCwgMywgNSwgMiwgNl0ubWFwKHggPT4geCoxMDApO1xuXHRcdGxldCBrX2dyb3VwID0gZ3JvdXAoYV9zZXEubGVuZ3RoKTtcblx0XHRrX2dyb3VwXG5cdFx0XHQuZGF0YShhX3NlcSlcblx0XHRcdC5tYXAoJ3dhaXQnKVxuXHRcdFx0LmVhY2goKHhfbiwgaV9uKSA9PiB7XG5cdFx0XHRcdGVxKGFfc2VxW2lfbl0sIHhfbik7XG5cdFx0XHR9LCBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdGF3YWl0IGtfZ3JvdXAua2lsbCgpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdtYXAvc2VyaWVzJywgKGZrZV90ZXN0KSA9PiB7XG5cdFx0bGV0IGFfc2VxID0gWzgsIDEsIDcsIDQsIDMsIDUsIDIsIDZdLm1hcCh4ID0+IHgqMTAwKTtcblx0XHRsZXQgYV9yZXMgPSBbXTtcblx0XHRsZXQga19ncm91cCA9IGdyb3VwKGFfc2VxLmxlbmd0aCk7XG5cdFx0a19ncm91cFxuXHRcdFx0LmRhdGEoYV9zZXEpXG5cdFx0XHQubWFwKCd3YWl0Jylcblx0XHRcdC5zZXJpZXMoKHhfbikgPT4ge1xuXHRcdFx0XHRhX3Jlcy5wdXNoKHhfbik7XG5cdFx0XHR9LCBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdGF3YWl0IGtfZ3JvdXAua2lsbCgpO1xuXHRcdFx0XHRkZXEoYV9zZXEsIGFfcmVzKTtcblx0XHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxuXHRpdCgnbWFwL3JlZHVjZSAjNCcsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBzX3NyYyA9ICdhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eic7XG5cdFx0bGV0IGtfZ3JvdXAgPSBncm91cCg0KTtcblx0XHRrX2dyb3VwXG5cdFx0XHQuZGF0YShzX3NyYy5zcGxpdCgnJykpXG5cdFx0XHQubWFwKCdjb25jYXQnKVxuXHRcdFx0LnJlZHVjZSgnbWVyZ2VfY29uY2F0JykudGhlbihhc3luYyAoc19maW5hbCkgPT4ge1xuXHRcdFx0XHRhd2FpdCBrX2dyb3VwLmtpbGwoKTtcblx0XHRcdFx0ZXEoc19zcmMsIHNfZmluYWwpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdtYXAvcmVkdWNlICM4JywgKGZrZV90ZXN0KSA9PiB7XG5cdFx0bGV0IHNfc3JjID0gJ2FiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6Jztcblx0XHRsZXQga19ncm91cCA9IGdyb3VwKDgpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKHNfc3JjLnNwbGl0KCcnKSlcblx0XHRcdC5tYXAoJ2NvbmNhdCcpXG5cdFx0XHQucmVkdWNlKCdtZXJnZV9jb25jYXQnKS50aGVuKGFzeW5jIChzX2ZpbmFsKSA9PiB7XG5cdFx0XHRcdGF3YWl0IGtfZ3JvdXAua2lsbCgpO1xuXHRcdFx0XHRlcShzX3NyYywgc19maW5hbCk7XG5cdFx0XHRcdGZrZV90ZXN0KCk7XG5cdFx0XHR9KTtcblx0fSk7XG5cblx0aXQoJ2V2ZW50cycsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBoX2NvbnZvID0ge1xuXHRcdFx0Z3JlZXQ6ICdoaScsXG5cdFx0XHRjaGF0OiAnaG93IHIgdScsXG5cdFx0XHR5ZWxsOiAnYWhoIScsXG5cdFx0XHRhcG9sb2dpemU6ICdzb3JyeScsXG5cdFx0XHRmb3JnaXZlOiAnbW1rJyxcblx0XHRcdGV4aXQ6ICdrYnllJyxcblx0XHR9O1xuXG5cdFx0bGV0IGFfZGF0YSA9IFtdO1xuXHRcdGxldCBoX3Jlc3BvbnNlcyA9IHt9O1xuXHRcdGxldCBjX3Jlc3BvbnNlcyA9IDA7XG5cdFx0T2JqZWN0LmtleXMoaF9jb252bykuZm9yRWFjaCgoc19rZXksIGlfa2V5KSA9PiB7XG5cdFx0XHRhX2RhdGEucHVzaCh7XG5cdFx0XHRcdG5hbWU6IHNfa2V5LFxuXHRcdFx0XHRkYXRhOiBoX2NvbnZvW3Nfa2V5XSxcblx0XHRcdFx0d2FpdDogaV9rZXk/IDUwMDogMCxcblx0XHRcdH0pO1xuXG5cdFx0XHRoX3Jlc3BvbnNlc1tzX2tleV0gPSAoaV9zdWJzZXQsIHNfbXNnKSA9PiB7XG5cdFx0XHRcdGVxKGhfY29udm9bc19rZXldLCBzX21zZyk7XG5cdFx0XHRcdGNfcmVzcG9uc2VzICs9IDE7XG5cdFx0XHR9O1xuXHRcdH0pO1xuXG5cdFx0bGV0IGtfZ3JvdXAgPSBncm91cCgzKTtcblx0XHRrX2dyb3VwXG5cdFx0XHQuZGF0YShhX2RhdGEpXG5cdFx0XHQubWFwKCdldmVudHMnLCBbXSwgaF9yZXNwb25zZXMpXG5cdFx0XHQuZW5kKGFzeW5jICgpID0+IHtcblx0XHRcdFx0YXdhaXQga19ncm91cC5raWxsKCk7XG5cdFx0XHRcdGVxKGFfZGF0YS5sZW5ndGgsIGNfcmVzcG9uc2VzKTtcblx0XHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxuXHRpdCgnc3RvcmUnLCAoKSA9PiB7XG5cdFx0bGV0IGtfZ3JvdXAgPSBncm91cCgyKTtcblx0XHRrX2dyb3VwXG5cdFx0XHQuZGF0YShbWzEwMCwgMCwgMCwgMF1dKVxuXHRcdFx0Lm1hcCgncGFzcycpXG5cdFx0XHQvLyAudGhydSgncGFzcycpXG5cdFx0XHQucmVkdWNlKCdzdW0nKS50aGVuKGFzeW5jIChhX3YpID0+IHtcblx0XHRcdFx0YXdhaXQga19ncm91cC5raWxsKCk7XG5cdFx0XHR9KTtcblx0fSk7XG5cbn0pO1xuXG5cbmRlc2NyaWJlKCdhdXgnLCAoKSA9PiB7XG5cblx0aWYoIXdvcmtlci5icm93c2VyKSB7XG5cdFx0aXQoJ3RyYW5zZmVycycsIGFzeW5jICgpID0+IHtcblx0XHRcdGxldCBrbV9hcmdzID0gd29ya2VyLm1hbmlmZXN0KFtmcy5yZWFkRmlsZVN5bmMoJy4vcGFja2FnZS5qc29uJyldKTtcblx0XHRcdGxldCBuX2xlbmd0aCA9IGF3YWl0IHJ1bignY291bnQnLCBrbV9hcmdzKTtcblxuXHRcdFx0YXNzZXJ0KG5fbGVuZ3RoID4gMCk7XG5cdFx0fSk7XG5cdH1cblxuXHRpdCgndHlwZWQtYXJyYXknLCBhc3luYyAoKSA9PiB7XG5cdFx0bGV0IGF0X3Rlc3QgPSBuZXcgVWludDhBcnJheSgxMCk7XG5cdFx0YXRfdGVzdFswXSA9IDc7XG5cdFx0YXRfdGVzdFsxXSA9IDU7XG5cdFx0bGV0IGttX2FyZ3MgPSB3b3JrZXIubWFuaWZlc3QoW2F0X3Rlc3QsIDFdKTtcblx0XHRsZXQgbl9hdCA9IGF3YWl0IHJ1bignYXQnLCBrbV9hcmdzKTtcblx0XHRlcSg1LCBuX2F0KTtcblx0fSk7XG5cblx0Ly8gaXQoJ3N0cmVhbXMnLCBhc3luYyAoKSA9PiB7XG5cdC8vIFx0bGV0IGRzX3dvcmRzID0gZnMuY3JlYXRlUmVhZFN0cmVhbSgnL3Vzci9zaGFyZS9kaWN0L3dvcmRzJywgJ3V0ZjgnKTtcblx0Ly8gXHRsZXQgbl9uZXdsaW5lcyA9IGF3YWl0IHJ1bignY291bnRfc3RyJywgW2RzX3dvcmRzLCAnXFxuJ10pO1xuXHQvLyBcdGNvbnNvbGUubG9nKG5fbmV3bGluZXMpO1xuXHQvLyBcdC8vIGVxKCd3b3JrZXInLCBzX3BhY2thZ2VfbmFtZSk7XG5cdC8vIH0pO1xufSk7XG5cblxuIiwiY29uc3Qgd29ya2VyID0gcmVxdWlyZSgnLi4vLi4vLi4vZGlzdC9tYWluL21vZHVsZS5qcycpO1xuXG53b3JrZXIuZGVkaWNhdGVkKHtcblx0cmV2ZXJzZV9zdHJpbmc6IHMgPT4gcy5zcGxpdCgnJykucmV2ZXJzZSgpLmpvaW4oJycpLFxuXG5cdGF0OiAoYSwgaSkgPT4gYVtpXSxcblxuXHR3YWl0OiAoYV93YWl0KSA9PiBuZXcgUHJvbWlzZSgoZl9yZXNvbHZlKSA9PiB7XG5cdFx0bGV0IHRfd2FpdCA9IGFfd2FpdFswXTtcblxuXHRcdHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0Zl9yZXNvbHZlKHRfd2FpdCk7XG5cdFx0fSwgdF93YWl0KTtcblx0fSksXG5cblx0Y29uY2F0OiBhID0+IGEuam9pbignJyksXG5cblx0bWVyZ2VfY29uY2F0OiAoc19hLCBzX2IpID0+IHNfYSArIHNfYixcblxuXHRldmVudHMoYV9ldnRzKSB7XG5cdFx0cmV0dXJuIFByb21pc2UuYWxsKFxuXHRcdFx0YV9ldnRzLm1hcCgoaF9ldnQpID0+IG5ldyBQcm9taXNlKChmX3Jlc29sdmUsIGZfcmVqZWN0KSA9PiB7XG5cdFx0XHRcdHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHRcdHRoaXMuZW1pdChoX2V2dC5uYW1lLCBoX2V2dC5kYXRhKTtcblx0XHRcdFx0XHRmX3Jlc29sdmUoKTtcblx0XHRcdFx0fSwgaF9ldnQud2FpdCArIDYwMCk7XG5cdFx0XHR9KSlcblx0XHQpO1xuXHR9LFxuXG5cdHN0b3JlKGFfc3RvcmUpIHtcblx0XHRhX3N0b3JlLmZvckVhY2goKGhfc3RvcmUpID0+IHtcblx0XHRcdGZvcihsZXQgc19rZXkgaW4gaF9zdG9yZSkge1xuXHRcdFx0XHR0aGlzLnB1dChzX2tleSwgaF9zdG9yZVtzX2tleV0pO1xuXHRcdFx0fVxuXHRcdH0pO1xuXHR9LFxuXG5cdGZldGNoKGFfa2V5cykge1xuXHRcdHJldHVybiBhX2tleXMubWFwKHNfa2V5ID0+IHRoaXMuZ2V0KHNfa2V5KSk7XG5cdH0sXG5cblx0cGFzcyhhX3dhaXQpIHtcblx0XHRyZXR1cm4gUHJvbWlzZS5hbGwoYV93YWl0Lm1hcCh4X3dhaXQgPT4gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSwgZl9yZWplY3QpID0+IHtcblx0XHRcdHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHRsZXQgY192YWwgPSAodGhpcy5nZXQoJ2RpZycpIHx8IDApICsgMTtcblx0XHRcdFx0dGhpcy5wdXQoJ2RpZycsIGNfdmFsKTtcblx0XHRcdFx0Zl9yZXNvbHZlKGNfdmFsKTtcblx0XHRcdH0sIHhfd2FpdCk7XG5cdFx0fSkpKTtcblx0fSxcblxuXHRtdWx0aXBseTogKGEsIHhfbXVsdGlwbGllcikgPT4gYS5tYXAoeCA9PiB4ICogeF9tdWx0aXBsaWVyKSxcblxuXHRhZGQ6IChhLCB4X2FkZCkgPT4gYS5tYXAoeCA9PiB4ICsgeF9hZGQpLFxuXG5cdC8vIHN1bTogKHhfYSwgeF9iKSA9PiB4X2EgKyB4X2IsXG5cblx0c3VtOiAoYV9hLCBhX2IpID0+IFthX2EucmVkdWNlKChjLCB4KSA9PiBjICsgeCwgMCkgKyBhX2IucmVkdWNlKChjLCB4KSA9PiBjICsgeCwgMCldLFxuXG5cdGNvdW50OiAoYSkgPT4gYS5yZWR1Y2UoKGMsIHgpID0+IGMgKyB4LCAwKSxcblxuXHRjb3VudF9zdHIoZHNfaW5wdXQsIHNfc3RyKSB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChmX3Jlc29sdmUsIGZfcmVqZWN0KSA9PiB7XG5cdFx0XHRsZXQgY19vY2N1cnJlbmNlcyA9IDA7XG5cdFx0XHRkc19pbnB1dC5vbignZGF0YScsIChzX2NodW5rKSA9PiB7XG5cdFx0XHRcdGNvbnNvbGUubG9nKCdvY2N1cnJlbmNlczogJytjX29jY3VycmVuY2VzKTtcblx0XHRcdFx0Y19vY2N1cnJlbmNlcyArPSBzX2NodW5rLnNwbGl0KHNfc3RyKS5sZW5ndGggLSAxO1xuXHRcdFx0fSk7XG5cblx0XHRcdGRzX2lucHV0Lm9uKCdlbmQnLCAoKSA9PiB7XG5cdFx0XHRcdGNvbnNvbGUubG9nKCdlbmQnKTtcblx0XHRcdFx0Zl9yZXNvbHZlKGNfb2NjdXJyZW5jZXMpO1xuXHRcdFx0fSk7XG5cblx0XHRcdGRzX2lucHV0Lm9uKCdlcnJvcicsIChlX3N0cmVhbSkgPT4ge1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGVfc3RyZWFtKTtcblx0XHRcdFx0Zl9yZWplY3QoZV9zdHJlYW0pO1xuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH0sXG5cblx0d3JpdGUoZHNfb3V0LCBhX3JhbmdlKSB7XG5cdFx0Zm9yKGxldCBpPWFfcmFuZ2VbMF07IGk8YV9yYW5nZVsxXTsgaSsrKSB7XG5cdFx0XHRkc19vdXQud3JpdGUoaSsnXFxuJyk7XG5cdFx0fVxuXHR9LFxufSk7XG4iXX0=
