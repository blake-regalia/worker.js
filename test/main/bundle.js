(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
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
			events: h_events || {},
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
	constructor(h_tasks, f_init=null) {
		super();

		if(!K_SELF) {
			throw new Error(`oops! looks like you tried loading a dedicated worker in the top thread`);
		}

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

		// init function
		if(f_init) f_init(K_SELF.args.slice(1));
	}

	debug(s_tag, s_type, ...a_info) {
		console.warn(`[${s_tag}] `.white+`S${this.id}`.yellow+` ${s_type} ${a_info.length? '('+a_info.join(', ')+')': '-'}`);
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
			debug: s_debug,
		} = h_msg;

		this.info = h_msg;

		if(s_debug) this.debug(s_debug, '<< task:'+s_task, i_task);

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

		// debugging, allow error to be thrown
		if(s_debug) {
			z_result = h_tasks[s_task].apply(new helper(this, i_task, h_events), a_args);
		}
		// catch and pass error to master
		else {
			try {
				z_result = h_tasks[s_task].apply(new helper(this, i_task, h_events), a_args);
			}
			catch(e_exec) {
				e_exec.message = `worker threw an error while executing task '${s_task}':\n${e_exec.message}`;
				return this.throw(e_exec);
			}
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
					debug: s_debug,
				});

				if(s_debug) this.debug(s_debug, '>> notify'.red, i_task);
			});
		}
		// send result back to master as soon as its ready
		else {
			this.resolve(z_result, (k_result) => {
				this.port.postMessage({
					type: 'respond',
					id: i_task,
					data: k_result.data[0],
					debug: s_debug,
				}, k_result.paths('data'));

				if(s_debug) this.debug(s_debug, '>> respond'.red, i_task);
			});
		}
	}

	// send result data to sibling
	handle_relay(h_msg) {
		let h_results = this.results;

		let {
			id: i_task,
			port: d_port,
			debug: s_debug,
		} = h_msg;

		// console.dir(d_port);
		if(s_debug) this.debug(s_debug, '<< relay', i_task, d_port.name);

		// grab result
		let k_result = h_results[i_task];

		// forward to given port
		d_port.postMessage({
			type: 'transfer',
			sender: i_task,
			data: k_result.data[0],
		}, k_result.transfer_paths.map(a => a.unshift('data')));

		// free to gc
		delete h_results[i_task];
	}

	// receive data from sibling and then execute ready task
	handle_receive(h_msg) {
		let {
			port: d_port,
			import: i_import,
			primary: b_primary,
			sender: i_sender,
			task_ready: h_task_ready,
			debug: s_debug,
		} = h_msg;

		// accept port
		ports(d_port);

		if(s_debug) this.debug(s_debug, '<< receive:'+i_import, h_task_ready.id, d_port.name);

		// import data
		let z_data_import = this.results[i_import].data[0];

		// free to gc
		delete this.results[i_import];

		// task ready args
		let a_args_task_ready = h_task_ready.args;

		// import is secondary
		if(!b_primary) a_args_task_ready.unshift(z_data_import);

		if(s_debug) this.debug(s_debug, 'setup', util.inspect(a_args_task_ready, {depth:null}));

		// set up message listener on port
		let fk_message = (d_msg_receive) => {
			let h_msg_receive = d_msg_receive.data;

			// matching sender
			if(i_sender === h_msg_receive.sender) {
				if(s_debug) this.debug(s_debug, '<< relay/receive', i_sender, d_port.name);

				// unbind listener
				d_port.removeListener('message', fk_message);

				// push message to front of args
				a_args_task_ready.unshift(h_msg_receive.data);

				// import is primary
				if(b_primary) a_args_task_ready.unshift(z_data_import);

				// fire ready task
				this.handle_task(h_task_ready);
			}
			else {
				if(s_debug) this.debug(s_debug, 'ignoring '+h_msg_receive.sender+' != '+i_sender);
			}
		};

		// bind listener
		d_port.on('message', fk_message);
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

		d_port.on('message', (d_msg) => {
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
		});
	}
};

},{"../browser/latent-subworker.js":10,"./locals.js":3,"./manifest.js":5,"./result.js":7,"util":40}],2:[function(require,module,exports){
const {
	HP_WORKER_NOTIFICATION,
	DC_CHANNEL,
} = require('./locals.js');

const manifest = require('./manifest.js');


const XM_STRATEGY_EQUAL = 1 << 0;

const XM_STRATEGY_ORDERED_GROUPS_BALANCED = 1 << 2;
const XM_STRATEGY_ORDERED_GROUPS_BIASED = 1 << 3;

const XM_STRATEGY_ORDERED_GROUPS = XM_STRATEGY_ORDERED_GROUPS_BALANCED | XM_STRATEGY_ORDERED_GROUPS_BIASED;

const XM_DISTRIBUTION_CONSTANT = 1 << 0;


class armed_group {
	constructor(k_group, a_subsets) {
		Object.assign(this, {
			group: k_group,
			subsets: a_subsets,
		});
	}

	map(s_task, z_args=[], h_events_map={}, s_debug=null) {
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

		// no subsets
		if(!nl_subsets) {
			setTimeout(() => {
				// result handler was not used; auto-end it
				if(!k_action.piped) k_action.end();

				// force end stream
				k_action.force_end();
			}, 0);
		}
		// yes subsets
		else {
			// summon workers as they become available
			k_group.summon_workers(nl_subsets, (k_worker, i_subset) => {
				// if(h_dispatch.debug) debugger;

				// result handler was not used; auto-end it
				if(!k_action.piped) k_action.end();

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
		}

		// let user bind a handler
		return k_action;
	}

	event_router(h_events, i_subset) {
		if(!h_events) return null;

		// make a new hash that pushes worker index in front of callback args
		let h_events_local = {};
		for(let s_event in h_events) {
			let f_event = h_events[s_event];
			h_events_local[s_event] = (...a_args) => {
				f_event(i_subset, ...a_args);
			};
		}

		return h_events_local;
	}
}


class active_group {
	constructor(k_group, n_tasks, f_push=null) {
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

	thru(s_task, z_args=[], h_events=null) {
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

	each(fk_result, fk_complete=null) {
		Object.assign(this, {
			piped: true,
			route: this.route_each,
			result_callback: fk_result,
			complete_callback: fk_complete,
		});

		return this.completable();
	}

	series(fk_result, fk_complete=null) {
		Object.assign(this, {
			piped: true,
			route: this.route_series,
			result_callback: fk_result,
			complete_callback: fk_complete,
			results: new Array(this.task_count),
		});

		return this.completable();
	}

	reduce(s_task, z_args=[], h_events=null, s_debug=null) {
		return new Promise((f_resolve) => {
			Object.assign(this, {
				debug: s_debug,
				piped: true,
				route: this.route_reduce,
				complete_callback: f_resolve,
				upstream_hold: this.task_count > 1,  // set `hold` flag for upstream sending its task
				reductions: new convergent_pairwise_tree(this.task_count),
				reduce_task: {
					task: s_task,
					manifest: new manifest(z_args),
					events: h_events,
					hold: true,  // assume another reduction will be performed by default
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
		if(++this.result_count === this.task_count && 'function' === typeof this.complete_callback) {
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
		if(i_subset === i_sequence) {
			// while there are results to process
			for(;;) {
				// process result
				this.handle_result_callback(z_result, i_sequence, k_worker, i_task);

				// reached end of sequence; that was last result
				if(++i_sequence === n_tasks) {
					// completion callback
					if('function' === typeof this.complete_callback) {
						this.complete_callback();
					}

					// exit loop and save sequence index
					break;
				}

				// next result not yet ready
				let h_next_result = a_results[i_sequence];
				if(!h_next_result) break;

				// else; onto next result
				z_result= h_next_result;

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
		if(HP_WORKER_NOTIFICATION !== z_result) {
			let z_completion = this.complete_callback(z_result);

			// add to outer stream
			if(z_completion instanceof active_group) {
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
			if(this.debug) {
				console.warn('\t == committed '+h_node.left+' </> '+h_node.right);
			}

			// able to perform a reduction
			let h_merge = k_pairwise_tree.commit(h_node);
			// k_pairwise_tree.print();
			if(h_merge) {
				if(this.debug) {
					console.warn('merged '+h_merge.node.left+' <-> '+h_merge.node.right);
				}
				let k_worker = h_node.item.worker;

				// this reduction will be the last one; do not hold result
				if(h_merge.makes_root) {
					h_task_ready = Object.assign({}, h_task_ready);
					h_task_ready.hold = false;
				}

				// after reduction;
				let fk_reduction = (z_result_reduction, i_task_reduction, k_worker_reduction) => {
					// if(this.debug) debugger;

					// recurse on reduction; update sender for callback scope
					this.reduce_result(z_result_reduction, Object.assign(h_merge.node, {
						item: {
							worker: k_worker_reduction,
							task_id: i_task_reduction,
						},
					}));
				};

				// give reduction task to worker that finished earlier; pass to the right
				if(k_worker === h_merge.left.worker) {
					k_group.relay({
						debug: this.debug,
						sender: h_node.item,
						receiver: h_merge.right,
						receiver_primary: false,
						task_ready: h_task_ready,
					}, fk_reduction);
				}
				// pass to the left
				else {
					k_group.relay({
						debug: this.debug,
						sender: h_node.item,
						receiver: h_merge.left,
						receiver_primary: true,
						task_ready: h_task_ready,
					}, fk_reduction);
				}
			}
		}
	}

	force_end() {
		if('function' === typeof this.complete_callback) {
			this.complete_callback();
		}

		if(this.downstream) {
			this.downstream.force_end();
		}
	}

	route_end() {
		// this was the last result
		if(++this.result_count === this.task_count && 'function' === typeof this.complete_callback) {
			this.complete_callback();
		}
	}

	completable() {
		let fk_complete = this.complete_callback;

		// nothing to reduce; complete after establishing downstream
		if(!this.task_count && 'function' === typeof fk_complete) {
			setTimeout(fk_complete, 0);
		}

		return this.downstream = new active_group(this.group, this.task_count, this.push);
	}

	handle_result_callback(z_result, i_subset, k_worker, i_task) {
		let k_downstream = this.downstream;

		// apply callback and capture return
		let z_return = this.result_callback(z_result, i_subset);

		// downstream is expecting data for next task
		if(k_downstream && k_downstream.piped) {
			// nothing was returned; reuse input data
			if(undefined === z_return) {
				// downstream action was expecting worker to hold data
				if(k_downstream.upstream_hold) {
					throw 'not yet implemented';
				}
				else {
					k_downstream.route(z_result, i_subset, k_worker, i_task);
				}
			}
			// returned promise
			else if(z_return instanceof Promise) {
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
			else if(z_return instanceof Error) {
				throw new Error('not yet implemented');
			}
			// returned immediately
			else {
				k_downstream.route(z_return, i_subset, k_worker, i_task);
			}
		}
		// something was returned though
		else if(undefined !== z_return) {
			console.warn('a task stream handler return some value but it cannot be carried because downstream is not expecting task data');
			debugger;
		}
	}

	end(fk_complete=null) {
		// new promise
		return new Promise((fk_end) => {
			Object.assign(this, {
				piped: true,
				route: this.route_end,
				complete_callback: async () => {
					// await complete callback
					if(fk_complete) await fk_complete();

					// now resolve
					fk_end();
				},
			});
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
		for(;;) {
			if(k_downstream.downstream) k_downstream = k_downstream.downstream;
			else break;
		}
		return k_downstream;
	}
}


function divide(a_things, n_workers, xm_strategy, h_divide={}) {
	let nl_things = a_things.length;

	let {
		item_count: c_items_remain=nl_things,
		open: f_open=null,
		seal: f_seal=null,
		quantify: f_quantify=() => {
			throw new Error(`must provide function for key 'quantify' when using '.balance_ordered_groups()'`);
		},
	} = h_divide;

	let a_tasks = [];

	if(Array.isArray(a_things)) {
		// do not assign workers to nothing
		if(nl_things < n_workers) n_workers = nl_things;

		// items per worker
		let x_items_per_worker = Math.floor(c_items_remain / n_workers);

		// distribute items equally
		if(XM_STRATEGY_EQUAL === xm_strategy) {
			// start index of slice
			let i_start = 0;

			// each worker
			for(let i_worker=0; i_worker<n_workers; i_worker++) {
				// find end index of worker; ensure all items find a worker
				let i_end = (i_worker===n_workers-1)? nl_things: i_start+x_items_per_worker;

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
		else if(XM_STRATEGY_ORDERED_GROUPS & xm_strategy) {
			let i_worker = 0;
			let c_worker_items = 0;

			// open new task item list
			let a_task_items = [];
			let z_task_data = f_open? f_open(a_task_items): a_task_items;

			// each group
			for(let i_group=0; i_group<nl_things; i_group++) {
				let h_group = a_things[i_group];
				let n_group_items = f_quantify(h_group);

				// adding this to current worker would exceed target load (make sure this isn't final worker)
				let n_worker_items_preview = n_group_items + c_worker_items;
				if((n_worker_items_preview > x_items_per_worker) && i_worker < n_workers-1) {
					let b_advance_group = false;

					// balance mode
					if(XM_STRATEGY_ORDERED_GROUPS_BALANCED === xm_strategy) {
						// preview is closer to target; add task item to worker before advancing
						if((n_worker_items_preview - x_items_per_worker) < (x_items_per_worker - c_worker_items)) {
							a_task_items.push(h_group);
							c_worker_items = n_worker_items_preview;

							// advance group after new task
							b_advance_group = true;
						}
					}

					// add task item to output (transforming it when appropriate)
					a_tasks.push(f_seal? f_seal(z_task_data): z_task_data);

					// next task item list
					a_task_items = [];
					c_items_remain -= c_worker_items;
					x_items_per_worker = c_items_remain / (n_workers - (++i_worker));
					c_worker_items = 0;

					// task item open
					z_task_data = f_open? f_open(a_task_items): a_task_items;

					// advance group
					if(b_advance_group) continue;
				}

				// add task to list
				a_task_items.push(h_group);
				c_worker_items += n_group_items;
			}

			// add final task item
			a_tasks.push(f_seal? f_seal(z_task_data): z_task_data);
		}
		// unknown strategy
		else {
			throw new RangeError('no such strategy');
		}
	}
	// typed array
	else if('byteLength' in a_things) {
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
		for(let i_item=0; i_item<n_items; i_item++) {
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
			steps: 0,
		});
	}

	ray(i_item, z_item) {
		let h_node = this.canopy[i_item];
		h_node.item = z_item;
		return h_node;
	}

	top(h_top) {
		for(;;) {
			let h_up = h_top.up;
			if(h_up) h_top = h_up;
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

	print() {
		let a_lines = new Array(this.canopy.length);

		debugger;
		this.canopy.forEach((h_node, i_node) => {
			a_lines[i_node] = `[${i_node}] ${h_node.ready? '-'.repeat(h_node.steps)+'O': '-'.repeat(this.steps)}`;
		});
	}

	commit(h_node) {
		let n_items = this.item_count;
		let a_canopy = this.canopy;
		this.steps += 1;

		// left edge of list
		if(-1 === h_node.left) {
			// tree root was handed to commit
			if(h_node.right === n_items) {
				throw new Error('cannot commit root!');
			}

			// neighbor on right side
			let h_right = this.top(a_canopy[h_node.right]);

			// neighbor is ready!
			if(h_right.ready) {
				return this.merge(h_node, h_right);
			}
			// neighbor is busy/not ready; mark this item as ready
			else {
				h_node.ready = true;
				h_node.steps = this.steps;
			}
		}
		// right edge of list
		else if(n_items === h_node.right) {
			// neighbor on left side
			let h_left = this.top(a_canopy[h_node.left]);

			// neighbor is ready
			if(h_left.ready) {
				return this.merge(h_left, h_node);
			}
			// neighbor is busy/not ready; mark this item as ready
			else {
				h_node.ready = true;
				h_node.steps = this.steps;
			}
		}
		// somewhere in the middle
		else {
			// start with left neighbor
			let h_left = this.top(a_canopy[h_node.left]);

			// neighbor is ready
			if(h_left.ready) {
				return this.merge(h_left, h_node);
			}
			// neighbor is busy/not ready
			else {
				// try right neighbor
				let h_right = this.top(a_canopy[h_node.right]);

				// neighbor is ready
				if(h_right.ready) {
					return this.merge(h_node, h_right);
				}
				// neighbor is busy/not ready; mark this item as ready
				else {
					h_node.ready = true;
					h_node.steps = this.steps;
				}
			}
		}

		return null;
	}
}


module.exports = function(dc_worker) {
	const pool = require('./pool.js')(dc_worker);
	return class group extends pool {
		constructor(...a_args) {
			super(...a_args);

			let {
				limit: n_workers,
			} = this;

			// make workers
			let hm_roster = new WeakMap();
			for(let i_worker=0; i_worker<n_workers; i_worker++) {
				// spawn new worker
				let k_worker = this.spawn_worker();

				// reserve a queue for it in roster
				hm_roster.set(k_worker, []);
			}

			// save group fields
			Object.assign(this, {
				roster: hm_roster,
				locks: {},
				next_worker_summon: 0,
			});
		}

		data(a_items) {
			return new armed_group(this, this.balance(a_items));
		}

		use(a_subsets) {
			if(a_subsets.length > this.limit) {
				throw new RangeError(`too many subsets given for number of workers: ${a_subsets.length} subsets > ${this.limit} workers`);
			}

			return new armed_group(this, a_subsets);
		}

		run(...a_args) {
			let {
				workers: a_workers,
				limit: n_workers,
			} = this;

			let a_promises = [];
			for(let i_worker=0; i_worker<n_workers; i_worker++) {
				a_promises.push(new Promise((fk_worker, fe_worker) => {
					this.schedule(a_workers[i_worker], (k_worker) => {
						k_worker.run(...a_args)
							.then(() => {
								// worker made itself available
								this.worker_available(k_worker);

								// resolve promise
								fk_worker();
							})
							.catch(fe_worker);
					});
				}));
			}

			return a_promises;
		}

		balance(a_items) {
			return divide(a_items, this.limit, XM_STRATEGY_EQUAL);
		}

		balance_ordered_groups(a_groups, h_divide) {
			return divide(a_groups, this.limit, XM_STRATEGY_ORDERED_GROUPS_BALANCED, h_divide);
		}

		bias_ordered_groups(a_groups, h_divide) {
			return divide(a_groups, this.limit, XM_STRATEGY_ORDERED_GROUPS_BIASED, h_divide);
		}

		divisions(n_items) {
			let n_workers = this.limit;

			// do not assign worker to do nothing
			if(n_items < n_workers) n_workers = n_items;

			// how many times to divide the items
			let n_divisions = n_workers - 1;

			// ideal number of items per worker
			let x_items_per_worker = n_items / n_workers;

			// item indices where to make divisions
			let a_divisions = [];
			for(let i_division=1; i_division<=n_divisions; i_division++) {
				a_divisions.push(Math.round(i_division * x_items_per_worker));
			}

			return a_divisions;
		}

		*divider(c_items_remain, xm_distribution=XM_DISTRIBUTION_CONSTANT) {
			let c_workers_remain = this.limit;

			// items per worker
			let n_items_per_division = Math.floor(c_items_remain / c_workers_remain);

			// constant distribution
			if(XM_DISTRIBUTION_CONSTANT === xm_distribution) {
				let c_items = 0;

				// iteratively find indexes to divide at
				for(;;) {
					// divide here
					if(++c_items >= n_items_per_division) {
						// dividing now would cause item overflow
						if(!--c_workers_remain) {
							// don't create any more divisions
							for(;;) yield false;
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
		// 		task_count: n_tasks=this.limit,
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
			if(k_worker.available) {
				f_run(k_worker);
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
				debug: s_debug,
			} = h_relay;

			// let s_sender = 'S'+String.fromCharCode(65+k_worker_sender.id);
			// let s_receiver = 'S'+String.fromCharCode(65+k_worker_receiver.id);

			// create message channel
			let k_channel = DC_CHANNEL.between(k_worker_sender, k_worker_receiver);

			if(k_worker_sender === k_worker_receiver) debugger;

			// console.warn(`M/relay/receive [${i_task_sender}] => ${i_task_receiver}`);

			// attach debug tag to ready task
			if(s_debug) h_task_ready.debug = s_debug;

			// schedule receiver worker to receive data and then run task
			this.schedule(k_worker_receiver, () => {
				k_worker_receiver.receive(k_channel.port_1(), {
					import: i_task_receiver,
					sender: i_task_sender,
					primary: b_receiver_primary,
					task_ready: h_task_ready,
				}, (...a_args) => {
					// worker just made itself available
					this.worker_available(k_worker_receiver);

					// callback
					fk_result(...a_args);
				}, s_debug);
			});

			// schedule sender worker to relay data to receiver worker
			this.schedule(k_worker_sender, () => {
				k_worker_sender.relay(i_task_sender, k_channel.port_2(), String.fromCharCode(65+k_worker_receiver.id), s_debug);

				// no result needed from relay; worker is available after message posts
				setTimeout(() => {
					this.worker_available(k_worker_sender);
				}, 0);
			});
		}

		summon_workers(n_summons, fk_worker) {
			let a_workers = this.workers;
			let n_workers = this.limit;

			let c_summoned = 0;

			// start by looking for available workers
			let i_next_worker_summon = this.next_worker_summon;

			for(let i_worker=0; i_worker<n_workers && c_summoned<n_summons; i_worker++) {
				let i_worker_call = (i_worker+i_next_worker_summon) % n_workers;
				let k_worker = a_workers[i_worker_call];

				// worker available immediately
				if(k_worker.available) {
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
			if(c_summoned < n_summons) {
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
			if(a_queue.length) {
				// fifo pop and call
				let fk_worker = a_queue.shift();
				fk_worker(k_worker);
			}
			// there is a wait list
			else if(this.wait_list.length) {
				// top of queue
				let h_patient = this.wait_list[0];

				// assign worker next task
				h_patient.each(k_worker);

				// this patient is satisfied; fifo pop
				if(0 === --h_patient.tasks_remaining) this.wait_list.shift();
			}
			// otherwise, free worker
			else {
				k_worker.available = true;
			}
		}
	};
};

},{"./locals.js":3,"./manifest.js":5,"./pool.js":6}],3:[function(require,module,exports){
(function (process){
/* eslint-disable no-new-func */

// deduce the runtime environment
const [B_BROWSER, B_BROWSERIFY] = (() => 'undefined' === typeof process
	? [true, false]
	: (process.browser
		? [true, true]
		: ('undefined' === process.versions || 'undefined' === process.versions.node
			? [true, false]
			: [false, false])))();

const locals = module.exports = Object.assign({
	B_BROWSER,
	B_BROWSERIFY,

	HP_WORKER_NOTIFICATION: Symbol('worker notification'),
}, B_BROWSER? require('../browser/locals.js'): require('../node/locals.js'), {

	webworkerify(z_import, h_config={}) {
		const [F_FUNCTION_BUNDLE, H_SOURCES, H_CACHE] = h_config.browserify;
		let s_worker_key = '';
		for(let s_cache_key in H_CACHE) {
			let z_exports = H_CACHE[s_cache_key].exports;
			if(z_import === z_exports || z_import === z_exports.default) {
				s_worker_key = s_cache_key;
				break;
			}
		}

		if(!s_worker_key) {
			s_worker_key = Math.floor(Math.pow(16, 8) * Math.random()).toString(16);
			let h_cache_worker = {};
			for(let s_key_cache in H_SOURCES) {
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
			{[s_worker_key]:s_worker_key},
		];

		let h_worker_sources = {};
		function resolve_sources(s_key) {
			h_worker_sources[s_key] = true;
			let h_source = H_SOURCES[s_key][1];
			for(let p_dependency in h_source) {
				let s_dependency_key = h_source[p_dependency];
				if(!h_worker_sources[s_dependency_key]) {
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

		let d_blob = new Blob([s_source], {type:'text/javascript'});
		if(h_config.bare) {
			return d_blob;
		}
		let p_worker_url = URL.createObjectURL(d_blob);
		let d_worker = new locals.DC_WORKER(p_worker_url, h_config.worker_options);
		// d_worker.objectURL = p_worker_url;
		// d_worker.source = d_blob;
		d_worker.source = s_source;
		return d_worker;
	},
});


}).call(this,require('_process'))

},{"../browser/locals.js":11,"../node/locals.js":20,"_process":37}],4:[function(require,module,exports){

class lock {
	constructor(b_unlocked=false) {
		Object.assign(this, {
			unlocked: b_unlocked,
			queue: [],
		});
	}

	wait(fk_unlock) {
		// already unlocked
		if(this.unlocked) {
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

class lockable {
	wait(z_key, z_unlock) {
		let fk_unlock = z_unlock;

		// unlock is another lock
		if('string' === typeof z_unlock) {
			fk_unlock = () => {
				this.unlock(z_unlock);
			};
		}
		// unlock is array of locks
		else if(Array.isArray(z_unlock)) {
			fk_unlock = () => {
				this.unlock(z_unlock);
			};
		}

		// series of keys to wait for
		if(Array.isArray(z_key)) {
			let i_key = 0;
			let n_keys = z_key.length;
			let f_next = () => {
				if(i_key === n_keys) fk_unlock();
				else this.wait(z_key[i_key++], f_next);
			};

			f_next();
		}
		// no such lock; but that's okay ;) create lock implicitly
		else if(!(z_key in this.locks)) {
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
		if(Array.isArray(z_key)) {
			z_key.forEach(z_key_ => this.unlock(z_key_));
		}
		// indivudal key
		else {
			// no such lock yet
			if(!(z_key in this.locks)) {
				this.locks[z_key] = new lock(true);
			}
			// unlock
			else {
				this.locks[z_key].unlock();
			}
		}
	}

}

module.exports = lockable;

},{}],5:[function(require,module,exports){
const {
	sharing,
} = require('./locals.js');

module.exports = class manifest {
	static from(z_other) {
		// manifest
		if(z_other instanceof manifest) {
			return z_other;
		}
		// any
		else {
			return new manifest(z_other, []);
		}
	}

	constructor(a_data=[], z_transfer_paths=true) {
		// not an array
		if(!Array.isArray(a_data)) {
			throw new Error('a manifest represents an array of arguments; pass the constructor an array');
		}

		// not a list; find transfers manually
		let a_transfer_paths = z_transfer_paths;
		if(!Array.isArray(a_transfer_paths)) {
			a_transfer_paths = this.extract(a_data);
		}
		// only check top level
		else {
			let a_transfers = [];
			for(let i_datum=0, nl_data=a_data.length; i_datum<nl_data; i_datum++) {
				let z_datum = a_data[i_datum];

				// shareable item
				if(sharing(z_datum)) a_transfers.push([i_datum]);
			}

			// solidify transfers
			if(a_transfers.length) {
				a_transfer_paths = a_transfers;
			}
		}

		Object.assign(this, {
			data: a_data,
			transfer_paths: a_transfer_paths,
		});
	}

	extract(z_data, a_path=[], zi_path_last=null) {
		// protect against [object] null
		if(!z_data) return [];

		// set of paths
		let a_paths = [];

		// object
		if('object' === typeof z_data) {
			// copy path
			a_path = a_path.slice();

			// commit to it
			if(null !== zi_path_last) a_path.push(zi_path_last);

			// plain object literal
			if(Object === z_data.constructor) {
				// scan over enumerable properties
				for(let s_property in z_data) {
					// extract data and transfers by recursing on property
					a_paths.push(...this.extract(z_data[s_property], a_path, s_property));
				}
			}
			// array
			else if(Array.isArray(z_data)) {
				// empty array
				if(!z_data.length) return [];

				// scan over each item
				z_data.forEach((z_item, i_item) => {
					// extract data and transfers by recursing on item
					a_paths.push(...this.extract(z_item, a_path, i_item));
				});
			}
			// shareable data
			else if(sharing(z_data)) {
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
		if(z_arg instanceof manifest) {
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

},{"./locals.js":3}],6:[function(require,module,exports){
const {
	N_CORES,
} = require('./locals.js');

const lockable = require('./lockable.js');

let worker;

class pool extends lockable {
	constructor(p_source, ...a_args) {
		super();

		// defaults
		let n_workers = N_CORES;
		let h_worker_options = {};

		// completeness
		if(2 === a_args.length) {
			n_workers = a_args[0] || n_workers;
			h_worker_options = a_args[1] || h_worker_options;
		}
		// omittance
		else if(1 === a_args.length) {
			// worker count
			if('number' === typeof a_args[0]) {
				n_workers = a_args[0];
			}
			// worker options
			else if('object' === typeof h_worker_options) {
				h_worker_options = a_args[0];
			}
			// invalid
			else {
				throw new TypeError('invalid 2nd argument: '+a_args[0]);
			}
		}
		// completeness
		else if(!n_workers) {
			n_workers = N_CORES;
		}

		// negative number given; subtract from core count
		if(n_workers < 0) n_workers = Math.max(1, N_CORES + n_workers);

		// fields
		Object.assign(this, {
			source: p_source,
			limit: n_workers,
			workers: [],
			history: [],
			wait_list: [],
			options: h_worker_options,
		});
	}

	spawn_worker() {
		let a_workers = this.workers;

		// fork options
		let h_options = Object.create(this.options);

		// node inspect
		let h_inspect = this.options.inspect;
		if(h_inspect) {
			// inspect range
			if(h_inspect.range && h_inspect.range[0] <= h_inspect.range[1]) {
				let i_inspect = h_inspect.range[0];
				let a_node_args = h_options.node_args = h_options.node_args? h_options.node_args.slice(0): [];
				a_node_args.push('--inspect'+(h_inspect.brk || h_inspect.break? '-brk': '')+'='+(h_inspect.range[0]++));
			}
		}

		// create new worker
		let k_worker = new worker({
			source: this.source,
			id: a_workers.length,
			master: this,
			options: Object.assign(h_options, {
				args: [String.fromCharCode(65+a_workers.length), ...(h_options.args || [])],
			}),
		});

		// add to pool
		a_workers.push(k_worker);

		// pretend its not available for synced mapping of run
		k_worker.busy = true;

		// it's actually available though ;)
		return k_worker;
	}

	summon() {
		let a_workers = this.workers;

		// each worker
		for(let k_worker of a_workers) {
			// worker not busy
			if(!k_worker.busy) {
				return k_worker;
			}
		}

		// room to grow
		if(a_workers.length < this.limit) {
			return this.spawn_worker();
		}

		// queue for notification when workers become available
		return new Promise((fk_worker) => {
			this.wait_list.push((k_worker) => {
				fk_worker(k_worker);
			});
		});
	}

	run(s_task, a_args, h_events) {
		let dp_run = new Promise(async(fk_run, fe_run) => {
			// summon a worker
			let k_worker = await this.summon();

			// run this task
			let z_result;
			try {
				z_result = await k_worker.run(s_task, a_args, h_events);
			}
			// error while running task
			catch(e_run) {
				return fe_run(e_run);
			}
			// worker is available now
			finally {
				let a_wait_list = this.wait_list;

				// at least one task is queued
				if(a_wait_list.length) {
					a_wait_list.shift()(k_worker);
				}
			}

			// resolve promise
			fk_run(z_result);
		});

		this.history.push(dp_run);
		return dp_run;
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

};

module.exports = function(dc_worker) {
	worker = dc_worker;
	return pool;
};


},{"./locals.js":3,"./lockable.js":4}],7:[function(require,module,exports){
const manifest = require('./manifest.js');

module.exports = class result extends manifest {
	static from(z_item) {
		if(z_item instanceof result) {
			return z_item;
		}
		else {
			return new result(z_item);
		}
	}

	constructor(z_result, z_transfer_paths=true) {
		// transfer paths needs to be prepended with zero index
		if(Array.isArray(z_transfer_paths)) {
			z_transfer_paths.forEach(a => a.unshift(0));
		}

		super([z_result], z_transfer_paths);
	}

	prepend() {
		throw new Error('cannot prepend a result');
	}
};

},{"./manifest.js":5}],8:[function(require,module,exports){
const events = require('./events.js');

module.exports = class channel extends MessageChannel {
	static between(kw_sender, kw_receiver) {
		let d_channel = kw_sender.channels.get(kw_receiver);
		if(d_channel) return d_channel;
		return new channel(kw_sender, kw_receiver);
	}

	port_1() {
		return events(this.port1);
	}

	port_2() {
		return events(this.port2);
	}
};

},{"./events.js":9}],9:[function(require,module,exports){
module.exports = (dz_thing) => {
	Object.assign(dz_thing, {
		on(...a_args) {
			// single event
			if(2 === a_args.length) {
				this['on'+a_args[0]] = a_args[1];
			}
			// multiple events
			else if(1 === a_args.length && 'object' === typeof a_args[0]) {
				let h_events = a_args[0];
				for(let s_event in h_events) {
					this['on'+s_event] = h_events[s_event];
				}
			}
			// nope
			else {
				throw new Error('misuse of on binding');
			}
		},

		removeListener(s_event) {
			this.removeEventListener(s_event, this['on'+s_event]);
		},
	});

	return dz_thing;
};

},{}],10:[function(require,module,exports){
const {
	K_SELF,
	webworkerify,
} = require('../all/locals.js');

const events = require('./events.js');

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
		while(this.messages.length) {
			d_port.postMessage(...this.messages.shift());
		}
	}

	postMessage(...a_args) {
		if(this.port) {
			this.port.postMessage(...a_args);
		}
		else {
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

	webworkerify(z_import, a_browserify, h_options={}) {
		let s_source = webworkerify(z_import, a_browserify, h_options);

		K_SELF.postMessage({
			type: 'spawn',
			source: s_source,
			options: h_options,
		});
	}
}

events(latent_subworker.prototype);

module.exports = latent_subworker;

},{"../all/locals.js":3,"./events.js":9}],11:[function(require,module,exports){
module.exports = {
	K_SELF: require('./self.js'),
	DC_WORKER: 'undefined' === typeof Worker? undefined: require('./worker.js'),
	DC_CHANNEL: require('./channel.js'),
	H_TYPED_ARRAYS: require('./typed-arrays.js'),
	N_CORES: navigator.hardwareConcurrency || 1,
	sharing: require('./sharing.js'),
	stream: require('./stream.js'),
	ports: require('./ports.js'),
};

},{"./channel.js":8,"./ports.js":12,"./self.js":13,"./sharing.js":14,"./stream.js":15,"./typed-arrays.js":16,"./worker.js":17}],12:[function(require,module,exports){
const events = require('./events.js');

module.exports = (d_port) => events(d_port);

},{"./events.js":9}],13:[function(require,module,exports){
const events = require('./events.js');

events(self);

self.args = [
	(Math.random()+'').slice(2, 8),
];

module.exports = self;

},{"./events.js":9}],14:[function(require,module,exports){
const stream = require('./stream.js');

const $_SHAREABLE = Symbol('shareable');

module.exports = Object.assign(function(z_object) {
	return 'object' === typeof z_object &&
		(ArrayBuffer.isView(z_object)
			|| z_object instanceof ArrayBuffer
			|| z_object instanceof MessagePort
			|| z_object instanceof ImageBitmap
			|| $_SHAREABLE in z_object);
}, {
	$_SHAREABLE,

	extract: function extract(z_data, as_transfers=null) {
		// protect against [object] null
		if(!z_data) return [z_data, []];

		// set of transfer objects
		if(!as_transfers) as_transfers = new Set();

		// object
		if('object' === typeof z_data) {
			// plain object literal
			if(Object === z_data.constructor) {
				// scan over enumerable properties
				for(let s_property in z_data) {
					// add each transferable from recursion to own set
					extract(z_data[s_property], as_transfers);
				}
			}
			// array
			else if(Array.isArray(z_data)) {
				// scan over each item
				z_data.forEach((z_item) => {
					// add each transferable from recursion to own set
					extract(z_item, as_transfers);
				});
			}
			// typed array, data view or array buffer
			else if(ArrayBuffer.isView(z_data)) {
				as_transfers.add(z_data.buffer);
			}
			// array buffer
			else if(z_data instanceof ArrayBuffer) {
				as_transfers.add(z_data);
			}
			// message port
			else if(z_data instanceof MessagePort) {
				as_transfers.add(z_data);
			}
			// image bitmap
			else if(z_data instanceof ImageBitmap) {
				as_transfers.add(z_data);
			}
			// stream
			else if(stream.is_stream(z_data)) {
				let a_transfers = [];
				[z_data, a_transfers] = stream.serialize(z_data);
				as_transfers.add(a_transfers);
			}
			// shareable
			else if($_SHAREABLE in z_data) {
				let a_transfers = [];
				[z_data, a_transfers] = z_data[$_SHAREABLE]();
				as_transfers.add(a_transfers);
			}
		}
		// function
		else if('function' === typeof z_data) {
			// scan over enumerable properties
			for(let s_property in z_data) {
				// add each transferable from recursion to own set
				extract(z_data[s_property], as_transfers);
			}
		}
		// nothing
		else {
			return [z_data, []];
		}

		// convert set to array
		return [z_data, Array.from(as_transfers)];
	},

	populate(h_msg) {
		let {
			data: h_data,
			transfers: a_transfers,
		} = h_msg;

		// each transfer
		a_transfers.forEach((h_transfer) => {
			// path to object
			let a_path = h_transfer.path;

			// walk path
			let z_walk = h_head;
			let nl_path = a_path.length;
			a_path.forEach((s_step, i_step) => {
				// final step
				if(i_step === nl_path-1) {
				}

				// no such step
				if(!(s_step in z_walk)) {
					throw new Error(`no such key '${s_step}' found while walking path along .${a_path.join('.')}`);
				}

				// take step
				z_walk = z_walk[s_step];
			});
		});

		// stream object
	},
});

},{"./stream.js":15}],15:[function(require,module,exports){
const node_events = require('events');

const sharing = require('./sharing.js');

class readable_stream extends node_events.EventEmitter {
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
		if(this.decoder) {
			let s_data;
			try {
				s_data = this.decoder.decode(at_chunk, {stream:!b_eof});
			}
			catch(e_decode) {
				this.emit('error', e_decode);
			}

			this.emit('data', s_data, at_chunk);
		}
		// no encoding
		else {
			this.emit('data', at_chunk, at_chunk);
		}

		// end of file
		if(b_eof) {
			setTimeout(() => {
				this.emit('end');
			}, 0);
		}
		// request more data
		else if(!this.paused) {
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
	constructor(p_object_url, h_config={}) {
		super();

		fetch(p_object_url)
			.then(d_res => d_res.blob())
			.then((dfb_input) => {
				if(this.onblob) this.onblob(dfb_input);
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
			if(this.buffer) {
				this.send(this.buffer, this.buffer_eof);
				this.buffer = null;
			}

			// reader is not busy
			if(!this.reader.busy) {
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

			// serialize this stream
			[sharing.$_SHAREABLE]() {
				return [{
					type: 'readable_stream',
					port: this.other_port,
				}, this.other_port];
			},
		});
	}

	send(at_chunk, b_eof=true) {
		this.receiver_busy = true;

// console.log('M ==> [chunk]');

		// send to receiver
		this.main_port.postMessage({
			content: at_chunk,
			eof: b_eof,
		}, [at_chunk.buffer]);
	}

	chunk(at_chunk, b_eof=true) {
// console.log('blob chunk ready to send; buffer: '+(!!this.buffer)+'; busy: '+this.receiver_busy);

		// receiver is busy, queue in buffer
		if(this.receiver_busy) {
			this.buffer = at_chunk;
			this.buffer_eof = b_eof;
		}
		// receiver available; send immediately
		else {
			// prefetch next chunk
			if(!this.buffer && !this.reader.eof) {
				this.reader.next_chunk();
			}

			this.send(at_chunk, b_eof);
		}
	}

	blob(dfb_input, h_config={}) {
		this.reader = new blob_reader(this, dfb_input, h_config);

		// start sending
		this.reader.next_chunk();
	}
}

class blob_reader {
	constructor(k_parent, dfb_input, h_config={}) {
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
			chunk_size: h_config.chunk_size || h_config.chunkSize || 1024 * 1024 * 1,  // 1 MiB
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
		if(i_end >= nl_content) {
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


module.exports = Object.assign(function(z_input=null) {
	if(z_input) {
		// make readable stream from object url's blob
		if('string' === typeof z_input) {
			return new readable_stream_via_object_url(z_input);
		}
		// make readable stream atop port
		else if(z_input instanceof MessagePort) {
			return new readable_stream_via_port(z_input);
		}
		// transmit blob across threads
		else if(z_input instanceof Blob) {
			// create new transfer stream
			let k_stream = new transfer_stream();

			// feed it this blob as input
			k_stream.blob(z_input);

			// return stream
			return k_stream;
		}
	}
	// transfer a stream
	else {
		return new transfer_stream();
	}
}, {
	handler: class handler {},

	is_stream(z_stream) {
		return z_stream instanceof transfer_stream
			|| z_stream instanceof ReadableStream
			|| z_stream instanceof WritableStream;
	},

	serialize(z_stream) {
		// transfer stream
		if(z_stream instanceof transfer_stream) {
			return [{
				type: 'readable_stream',
				port: z_stream.other_port,
			}, z_stream.other_port];
		}
		// readable stream
		else if(z_stream instanceof ReadableStream) {
			throw new Error('not yet implemented');
			return {
				type: 'readable_stream',
			};
		}
		// writable stream
		else if(z_stream instanceof WritableStream) {
			throw new Error('not yet implemented');
			return {
				type: 'writable_stream',
			};
		}
		// invalid type
		else {
			throw new TypeError('cannot create transfer stream from: '+z_stream);
		}
	},
});

},{"./sharing.js":14,"events":34}],16:[function(require,module,exports){
(function (global){

const sharing = require('./sharing.js');
const TypedArray = Object.getPrototypeOf(Object.getPrototypeOf(new Uint8Array(0))).constructor;



/* globals SharedArrayBuffer */


if('undefined' === typeof SharedArrayBuffer) {
	global.SharedArrayBuffer = function() {
		throw new Error('SharedArrayBuffer is not supported by this browser, or it is currently disabled due to Spectre');
	};
}

class Int8ArrayS extends Int8Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if('number' === typeof z_arg_0) {
			at_self = new Int8Array(new SharedArrayBuffer(z_arg_0));
		}
		// typed array constructor
		else if(z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if(sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				at_self = new Int8Array(new SharedArrayBuffer(z_arg_0.byteLength));


				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if(z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if('undefined' === typeof nl_array) {
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
Object.assign(Int8ArrayS.prototype, {[sharing.$_SHAREABLE]:1});
class Uint8ArrayS extends Uint8Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if('number' === typeof z_arg_0) {
			at_self = new Uint8Array(new SharedArrayBuffer(z_arg_0));
		}
		// typed array constructor
		else if(z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if(sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				at_self = new Uint8Array(new SharedArrayBuffer(z_arg_0.byteLength));


				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if(z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if('undefined' === typeof nl_array) {
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
Object.assign(Uint8ArrayS.prototype, {[sharing.$_SHAREABLE]:1});
class Uint8ClampedArrayS extends Uint8ClampedArray {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if('number' === typeof z_arg_0) {
			at_self = new Uint8ClampedArray(new SharedArrayBuffer(z_arg_0));
		}
		// typed array constructor
		else if(z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if(sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				at_self = new Uint8ClampedArray(new SharedArrayBuffer(z_arg_0.byteLength));


				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if(z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if('undefined' === typeof nl_array) {
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
Object.assign(Uint8ClampedArrayS.prototype, {[sharing.$_SHAREABLE]:1});
class Int16ArrayS extends Int16Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if('number' === typeof z_arg_0) {
			at_self = new Int16Array(new SharedArrayBuffer(z_arg_0 << 1));
		}
		// typed array constructor
		else if(z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if(sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				at_self = new Int16Array(new SharedArrayBuffer(z_arg_0.byteLength));


				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if(z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if('undefined' === typeof nl_array) {
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
Object.assign(Int16ArrayS.prototype, {[sharing.$_SHAREABLE]:1});
class Uint16ArrayS extends Uint16Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if('number' === typeof z_arg_0) {
			at_self = new Uint16Array(new SharedArrayBuffer(z_arg_0 << 1));
		}
		// typed array constructor
		else if(z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if(sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				at_self = new Uint16Array(new SharedArrayBuffer(z_arg_0.byteLength));


				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if(z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if('undefined' === typeof nl_array) {
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
Object.assign(Uint16ArrayS.prototype, {[sharing.$_SHAREABLE]:1});
class Int32ArrayS extends Int32Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if('number' === typeof z_arg_0) {
			at_self = new Int32Array(new SharedArrayBuffer(z_arg_0 << 2));
		}
		// typed array constructor
		else if(z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if(sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				at_self = new Int32Array(new SharedArrayBuffer(z_arg_0.byteLength));


				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if(z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if('undefined' === typeof nl_array) {
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
Object.assign(Int32ArrayS.prototype, {[sharing.$_SHAREABLE]:1});
class Uint32ArrayS extends Uint32Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if('number' === typeof z_arg_0) {
			at_self = new Uint32Array(new SharedArrayBuffer(z_arg_0 << 2));
		}
		// typed array constructor
		else if(z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if(sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				at_self = new Uint32Array(new SharedArrayBuffer(z_arg_0.byteLength));


				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if(z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if('undefined' === typeof nl_array) {
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
Object.assign(Uint32ArrayS.prototype, {[sharing.$_SHAREABLE]:1});
class Float32ArrayS extends Float32Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if('number' === typeof z_arg_0) {
			at_self = new Float32Array(new SharedArrayBuffer(z_arg_0 << 2));
		}
		// typed array constructor
		else if(z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if(sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				at_self = new Float32Array(new SharedArrayBuffer(z_arg_0.byteLength));


				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if(z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if('undefined' === typeof nl_array) {
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
Object.assign(Float32ArrayS.prototype, {[sharing.$_SHAREABLE]:1});
class Float64ArrayS extends Float64Array {
	constructor(z_arg_0, nb_offset, nl_array) {
		// this
		let h_this = {};

		// self
		let at_self;


		// length constructor
		if('number' === typeof z_arg_0) {
			at_self = new Float64Array(new SharedArrayBuffer(z_arg_0 << 4));
		}
		// typed array constructor
		else if(z_arg_0 instanceof TypedArray) {
			// transferable typed array
			if(sharing(z_arg_0)) {
				debugger;
			}
			// basic typed array
			else {
				at_self = new Float64Array(new SharedArrayBuffer(z_arg_0.byteLength));


				// copy data over
				at_self.set(z_arg_0);
			}
		}
		// array buffer constructor
		else if(z_arg_0 instanceof ArrayBuffer) {
			// force offset
			nb_offset = nb_offset || 0;

			// no length; deduce it from offset
			if('undefined' === typeof nl_array) {
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
Object.assign(Float64ArrayS.prototype, {[sharing.$_SHAREABLE]:1});


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

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"./sharing.js":14}],17:[function(require,module,exports){
const events = require('./events.js');
const sharing = require('./sharing.js');

class worker extends Worker {

	postPort(d_port, h_msg, a_transfer_paths=[]) {
		// append port to transfer paths
		a_transfer_paths.push(['port']);

		// send
		this.postMessage(Object.assign({
			port: d_port,
		}, h_msg), a_transfer_paths);
	}

	postMessage(h_msg, a_transfer_paths) {
		let a_transfers = [];
		for(let a_path of a_transfer_paths) {
			let z_head = h_msg;
			let nl_path = a_path.length;
			for(let i_step=0; i_step<nl_path-1; i_step++) {
				z_head = z_head[a_path[i_step]];
			}

			// final step
			let s_key = a_path[nl_path-1];

			// extract transfer item(s)
			let [h_serialization, a_transfer_items] = sharing.extract(z_head[s_key]);

			// add transfer items
			a_transfers.push(...a_transfer_items);

			// replace object
			z_head[s_key] = h_serialization;
		}

		try {
			super.postMessage(h_msg, a_transfers);
		}
		catch(e_post) {
			// data clone error
			if('DataCloneError' === e_post.name) {
				console.warn('Did you forget to declare an object that needs to be transferred? Make sure you know when to use worker.manifest()');
				debugger;
			}

			throw e_post;
		}
	}
}

events(worker.prototype);

module.exports = worker;

},{"./events.js":9,"./sharing.js":14}],18:[function(require,module,exports){
(function (process){
/* @flow */
const path = require('path');

const colors = require('colors');
colors.enabled = true;

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
const X_CONTEXT_TYPE = !B_BROWSER
	? (process.env.WORKER_DEPTH? XM_CONTEXT_PROCESS_CHILD: XM_CONTEXT_PROCESS_PARENT)
	: ('undefined' !== typeof document
		? XM_CONTEXT_WINDOW
		: ('DedicatedWorkerGlobalScope' in self
			? XM_CONTEXT_WORKER_DEDICATED
			: ('SharedWorkerGlobalScope' in self
				? XM_CONTEXT_WORKER_SHARED
				: ('ServiceWorkerGlobalScope' in self
					? XM_CONTEXT_WORKER_SERVICE
					: 0))));

// unrecognized context
if(!X_CONTEXT_TYPE) {
	throw new Error('failed to determine what is the current environment/context');
}

// spawns a Worker
let spawn_worker = B_WORKER_SUPPORTED
	? (!B_BROWSERIFY
		? (p_source, h_options) => new DC_WORKER(p_source, h_options)
		: (p_source, h_options) => {
			console.error(`Fatal error: since you are using browserify, you need to include explicit 'require()' statements for any scripts you intend to spawn as workers from this thread`);
			console.warn(`try using the following instead:\n\nconst worker = require('worker').scopify(require, () => {\n`
				+`\trequire('${p_source}');\n\t// ... and any other scripts you will spawn from this thread\n`
				+`}, 'undefined' !== typeof arguments && arguments);`);

			throw new Error(`Cannot spawn worker '${p_source}'`);
		})
	: (p_source, h_options) => {
		// we're inside a worker
		if(X_CONTEXT_TYPE & XM_CONTEXT_WORKER) {
			console.error(`Fatal error: browser does not support subworkers; failed to spawn '${p_source}'\n`
				+'Fortunately worker.js has a solution  ;)');
			console.warn(`try using the following in your worker script to support subworkers:\n\n`
				+`const worker = require('worker').scopify(require, () => {\n`
				+`\trequire('${p_source}');\n`
				+`\t// ... and any other scripts you will spawn from this thread\n`
				+`}, 'undefined' !== typeof arguments && arguments);`);
		}

		throw new Error(`Cannot spawn worker ${p_source}; 'Worker' is undefined`);
	};


let i_guid = 0;

class worker extends stream.handler {
	static from_source(p_source, h_options={}) {
		return new worker({
			source: p_source,
			options: h_options,
		});
	}

	constructor(h_config) {
		super();

		let {
			source: p_source,
			id: i_id=-1,
			master: k_master=null,
			options: h_options={},
		} = h_config;

		// resolve source relative to master
		let pa_source = B_BROWSER
			? p_source
			: path.resolve(path.dirname(module.parent.filename), p_source);

		// make worker
		let d_worker;
		try {
			d_worker = spawn_worker(pa_source, h_options);
		}
		catch(e_spawn) {
			let e_msg = new Error('An uncaught error was thrown by the worker, possibly due to a bug in the worker.js library. That error was:\n'+e_spawn.stack.split('\n')[0]);
			e_msg.stack = e_spawn.stack;
			throw e_msg;
		}

		d_worker.on({
			error: (e_worker) => {
				if(e_worker instanceof ErrorEvent) {
					if('lineno' in e_worker && 'source' in d_worker) {
						let a_lines = d_worker.source.split('\n');
						let i_line_err = e_worker.lineno;
						let a_debug = a_lines.slice(Math.max(0, i_line_err-2), Math.min(a_lines.length-1, i_line_err+2))
							.map((s_line, i_line) => (1 === i_line? '*': ' ')+((i_line_err+i_line-1)+'').padStart(5)+': '+s_line);

						// recreate error message
						e_worker = new Error(e_worker.message+`Error thrown in worker:\n${a_debug.join('\n')}`);
					}

					if(this.task_error) {
						this.task_error(e_worker);
					}
					else {
						throw e_worker;
					}
				}
				else if(this.task_error) {
					this.task_error(e_worker);
				}
				else {
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
				let s_handle = 'handle_'+h_msg.type;
				if(s_handle in this) {
					this[s_handle](h_msg);
				}
				else {
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
			channels: new Map(),
			server: null,
		});
	}

	debug(s_tag, s_type, ...a_info) {
		console.warn(`[${s_tag}] `.white+`M${String.fromCharCode(65+this.id)}`.blue+` ${s_type} ${a_info.length? '('+a_info.join(', ')+')': '-'}`);
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

		if(h_msg.debug) this.debug(h_msg.debug, '<< respond'.red, i_task);

		// execute callback
		h_callbacks[i_task](h_msg.data, i_task, this);

		// free callback
		delete h_callbacks[i_task];
	}

	handle_notify(h_msg) {
		h_msg.data = HP_WORKER_NOTIFICATION;

		// no longer busy
		this.busy = false;

		if(h_msg.debug) this.debug(h_msg.debug, '<< notify'.red);

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

		if(this.task_error) {
			this.task_error(e_msg);
		}
		else {
			throw e_msg;
		}
	}

	handle_spawn(h_msg) {
		let p_source = path.join(path.dirname(this.source), h_msg.source);
		if('/' !== p_source[0]) p_source = './'+p_source;

		p_source = h_msg.source;
		let d_subworker = spawn_worker(p_source);
		let i_subworker = this.subworkers.push(d_subworker)-1;

		d_subworker.on('error', (e_worker) => {
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

	prepare(h_task, fk_task, a_roots=[]) {
		let i_task = ++i_guid;

		let {
			task: s_task,
			manifest: k_manifest,
			receive: i_receive=0,
			inherit: i_inherit=0,
			hold: b_hold=false,
			events: h_events=null,
		} = h_task;

		// save callback
		this.callbacks[i_task] = fk_task;

		// save events
		if(h_events) {
			this.events[i_task] = h_events;

			// what to send
			let h_events_send ={};
			for(let s_key in h_events) {
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

		// this.debug('exec:'+h_task.msg.id);

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
		if(this.prev_run_task) {
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
		if('function' === typeof fk_run) {
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

	receive(d_port, h_receive, fk_task, s_debug=null) {
		let h_task = this.prepare(h_receive.task_ready, fk_task, ['task_ready']);

		if(s_debug) this.debug(s_debug, '>> receive:'.green+h_receive.import, h_task.msg.id, d_port.name || d_port);

		this.port.postPort(d_port, {
			type: 'receive',
			import: h_receive.import,
			sender: h_receive.sender,
			primary: h_receive.primary,
			task_ready: Object.assign(h_task.msg, {debug:s_debug}),
			debug: s_debug,
		}, [...(h_task.paths || [])]);
	}

	relay(i_task_sender, d_port, s_receiver, s_debug=null) {
		if(s_debug) this.debug(s_debug, '>> relay', i_task_sender, d_port.name || d_port);

		this.port.postPort(d_port, {
			type: 'relay',
			id: i_task_sender,
			debug: s_debug,
		});
	}

	kill(s_kill) {
		if(B_BROWSER) {
			return new Promise((f_resolve) => {
				this.port.terminate();
				f_resolve();
			});
		}
		else {
			return this.port.terminate(s_kill);
		}
	}
}


const mk_new = (dc) => function(...a_args) {
	return new dc(...a_args);
};

// now import anyhing that depends on worker
const group = require('./all/group.js')(worker);
const pool = require('./all/pool.js')(worker);

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
	globals: (h_scope={}) => Object.assign(h_scope, H_TYPED_ARRAYS.exports),

	// for compatibility with browserify
	scopify(f_require, a_sources, d_arguments) {
		// browserify arguments
		let a_browserify = d_arguments? [d_arguments[3], d_arguments[4], d_arguments[5]]: null;

		// running in browserify
		if(B_BROWSERIFY) {
			const latent_subworker = require('./browser/latent-subworker.js');

			// change how a worker is spawned
			spawn_worker = (p_source, h_options) => {
				// workaround for chromium bug that cannot spawn subworkers
				if(!B_WORKER_SUPPORTED) {
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
		for(;;) {
			// a wins
			if(f_cmp(z_a, z_b) < 0) {
				// add to output list
				a_out.push(z_a);

				// reached end of a
				if(i_a === ih_a) break;

				// next item from a
				z_a = a_a[++i_a];
			}
			// b wins
			else {
				// add to output list
				a_out.push(z_b);

				// reached end of b
				if(i_b === ih_b) break;

				// next item from b
				z_b = a_b[++i_b];
			}
		}

		// a finished first
		if(i_a === ih_a) {
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
	if(XM_CONTEXT_WORKER & X_CONTEXT_TYPE) {
		// dedicated worker
		if(XM_CONTEXT_WORKER_DEDICATED === X_CONTEXT_TYPE) {
			return new dedicated(...a_args);
		}
		// shared worker
		else if(XM_CONTEXT_WORKER_SHARED === X_CONTEXT_TYPE) {
			// return new shared(...a_args);
		}
		// service worker
		else if(XM_CONTEXT_WORKER_SERVICE === X_CONTEXT_TYPE) {
			// return new service(...a_args);
		}
	}
	// child process; dedicated worker
	else if(XM_CONTEXT_PROCESS_CHILD === X_CONTEXT_TYPE) {
		return new dedicated(...a_args);
	}
	// master
	else {
		return worker.from_source(...a_args);
	}
}, H_EXPORTS);


}).call(this,require('_process'))

},{"./all/dedicated.js":1,"./all/group.js":2,"./all/locals.js":3,"./all/manifest.js":5,"./all/pool.js":6,"./all/result.js":7,"./browser/latent-subworker.js":10,"_process":37,"colors":26,"path":36}],19:[function(require,module,exports){
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

},{"util/":40}],20:[function(require,module,exports){

},{}],21:[function(require,module,exports){
arguments[4][20][0].apply(exports,arguments)
},{"dup":20}],22:[function(require,module,exports){
/*

The MIT License (MIT)

Original Library 
  - Copyright (c) Marak Squires

Additional functionality
 - Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

*/

var colors = {};
module['exports'] = colors;

colors.themes = {};

var ansiStyles = colors.styles = require('./styles');
var defineProps = Object.defineProperties;

colors.supportsColor = require('./system/supports-colors').supportsColor;

if (typeof colors.enabled === "undefined") {
  colors.enabled = colors.supportsColor() !== false;
}

colors.stripColors = colors.strip = function(str){
  return ("" + str).replace(/\x1B\[\d+m/g, '');
};


var stylize = colors.stylize = function stylize (str, style) {
  if (!colors.enabled) {
    return str+'';
  }

  return ansiStyles[style].open + str + ansiStyles[style].close;
}

var matchOperatorsRe = /[|\\{}()[\]^$+*?.]/g;
var escapeStringRegexp = function (str) {
  if (typeof str !== 'string') {
    throw new TypeError('Expected a string');
  }
  return str.replace(matchOperatorsRe,  '\\$&');
}

function build(_styles) {
  var builder = function builder() {
    return applyStyle.apply(builder, arguments);
  };
  builder._styles = _styles;
  // __proto__ is used because we must return a function, but there is
  // no way to create a function with a different prototype.
  builder.__proto__ = proto;
  return builder;
}

var styles = (function () {
  var ret = {};
  ansiStyles.grey = ansiStyles.gray;
  Object.keys(ansiStyles).forEach(function (key) {
    ansiStyles[key].closeRe = new RegExp(escapeStringRegexp(ansiStyles[key].close), 'g');
    ret[key] = {
      get: function () {
        return build(this._styles.concat(key));
      }
    };
  });
  return ret;
})();

var proto = defineProps(function colors() {}, styles);

function applyStyle() {
  var args = arguments;
  var argsLen = args.length;
  var str = argsLen !== 0 && String(arguments[0]);
  if (argsLen > 1) {
    for (var a = 1; a < argsLen; a++) {
      str += ' ' + args[a];
    }
  }

  if (!colors.enabled || !str) {
    return str;
  }

  var nestedStyles = this._styles;

  var i = nestedStyles.length;
  while (i--) {
    var code = ansiStyles[nestedStyles[i]];
    str = code.open + str.replace(code.closeRe, code.open) + code.close;
  }

  return str;
}

colors.setTheme = function (theme) {
  if (typeof theme === 'string') {
    console.log('colors.setTheme now only accepts an object, not a string.  ' +
      'If you are trying to set a theme from a file, it is now your (the caller\'s) responsibility to require the file.  ' +
      'The old syntax looked like colors.setTheme(__dirname + \'/../themes/generic-logging.js\'); ' +
      'The new syntax looks like colors.setTheme(require(__dirname + \'/../themes/generic-logging.js\'));');
    return;
  }
  for (var style in theme) {
    (function(style){
      colors[style] = function(str){
        if (typeof theme[style] === 'object'){
          var out = str;
          for (var i in theme[style]){
            out = colors[theme[style][i]](out);
          }
          return out;
        }
        return colors[theme[style]](str);
      };
    })(style)
  }
}

function init() {
  var ret = {};
  Object.keys(styles).forEach(function (name) {
    ret[name] = {
      get: function () {
        return build([name]);
      }
    };
  });
  return ret;
}

var sequencer = function sequencer (map, str) {
  var exploded = str.split(""), i = 0;
  exploded = exploded.map(map);
  return exploded.join("");
};

// custom formatter methods
colors.trap = require('./custom/trap');
colors.zalgo = require('./custom/zalgo');

// maps
colors.maps = {};
colors.maps.america = require('./maps/america');
colors.maps.zebra = require('./maps/zebra');
colors.maps.rainbow = require('./maps/rainbow');
colors.maps.random = require('./maps/random')

for (var map in colors.maps) {
  (function(map){
    colors[map] = function (str) {
      return sequencer(colors.maps[map], str);
    }
  })(map)
}

defineProps(colors, init());

},{"./custom/trap":23,"./custom/zalgo":24,"./maps/america":27,"./maps/rainbow":28,"./maps/random":29,"./maps/zebra":30,"./styles":31,"./system/supports-colors":33}],23:[function(require,module,exports){
module['exports'] = function runTheTrap (text, options) {
  var result = "";
  text = text || "Run the trap, drop the bass";
  text = text.split('');
  var trap = {
    a: ["\u0040", "\u0104", "\u023a", "\u0245", "\u0394", "\u039b", "\u0414"],
    b: ["\u00df", "\u0181", "\u0243", "\u026e", "\u03b2", "\u0e3f"],
    c: ["\u00a9", "\u023b", "\u03fe"],
    d: ["\u00d0", "\u018a", "\u0500" , "\u0501" ,"\u0502", "\u0503"],
    e: ["\u00cb", "\u0115", "\u018e", "\u0258", "\u03a3", "\u03be", "\u04bc", "\u0a6c"],
    f: ["\u04fa"],
    g: ["\u0262"],
    h: ["\u0126", "\u0195", "\u04a2", "\u04ba", "\u04c7", "\u050a"],
    i: ["\u0f0f"],
    j: ["\u0134"],
    k: ["\u0138", "\u04a0", "\u04c3", "\u051e"],
    l: ["\u0139"],
    m: ["\u028d", "\u04cd", "\u04ce", "\u0520", "\u0521", "\u0d69"],
    n: ["\u00d1", "\u014b", "\u019d", "\u0376", "\u03a0", "\u048a"],
    o: ["\u00d8", "\u00f5", "\u00f8", "\u01fe", "\u0298", "\u047a", "\u05dd", "\u06dd", "\u0e4f"],
    p: ["\u01f7", "\u048e"],
    q: ["\u09cd"],
    r: ["\u00ae", "\u01a6", "\u0210", "\u024c", "\u0280", "\u042f"],
    s: ["\u00a7", "\u03de", "\u03df", "\u03e8"],
    t: ["\u0141", "\u0166", "\u0373"],
    u: ["\u01b1", "\u054d"],
    v: ["\u05d8"],
    w: ["\u0428", "\u0460", "\u047c", "\u0d70"],
    x: ["\u04b2", "\u04fe", "\u04fc", "\u04fd"],
    y: ["\u00a5", "\u04b0", "\u04cb"],
    z: ["\u01b5", "\u0240"]
  }
  text.forEach(function(c){
    c = c.toLowerCase();
    var chars = trap[c] || [" "];
    var rand = Math.floor(Math.random() * chars.length);
    if (typeof trap[c] !== "undefined") {
      result += trap[c][rand];
    } else {
      result += c;
    }
  });
  return result;

}

},{}],24:[function(require,module,exports){
// please no
module['exports'] = function zalgo(text, options) {
  text = text || "   he is here   ";
  var soul = {
    "up" : [
      '̍', '̎', '̄', '̅',
      '̿', '̑', '̆', '̐',
      '͒', '͗', '͑', '̇',
      '̈', '̊', '͂', '̓',
      '̈', '͊', '͋', '͌',
      '̃', '̂', '̌', '͐',
      '̀', '́', '̋', '̏',
      '̒', '̓', '̔', '̽',
      '̉', 'ͣ', 'ͤ', 'ͥ',
      'ͦ', 'ͧ', 'ͨ', 'ͩ',
      'ͪ', 'ͫ', 'ͬ', 'ͭ',
      'ͮ', 'ͯ', '̾', '͛',
      '͆', '̚'
    ],
    "down" : [
      '̖', '̗', '̘', '̙',
      '̜', '̝', '̞', '̟',
      '̠', '̤', '̥', '̦',
      '̩', '̪', '̫', '̬',
      '̭', '̮', '̯', '̰',
      '̱', '̲', '̳', '̹',
      '̺', '̻', '̼', 'ͅ',
      '͇', '͈', '͉', '͍',
      '͎', '͓', '͔', '͕',
      '͖', '͙', '͚', '̣'
    ],
    "mid" : [
      '̕', '̛', '̀', '́',
      '͘', '̡', '̢', '̧',
      '̨', '̴', '̵', '̶',
      '͜', '͝', '͞',
      '͟', '͠', '͢', '̸',
      '̷', '͡', ' ҉'
    ]
  },
  all = [].concat(soul.up, soul.down, soul.mid),
  zalgo = {};

  function randomNumber(range) {
    var r = Math.floor(Math.random() * range);
    return r;
  }

  function is_char(character) {
    var bool = false;
    all.filter(function (i) {
      bool = (i === character);
    });
    return bool;
  }
  

  function heComes(text, options) {
    var result = '', counts, l;
    options = options || {};
    options["up"] =   typeof options["up"]   !== 'undefined' ? options["up"]   : true;
    options["mid"] =  typeof options["mid"]  !== 'undefined' ? options["mid"]  : true;
    options["down"] = typeof options["down"] !== 'undefined' ? options["down"] : true;
    options["size"] = typeof options["size"] !== 'undefined' ? options["size"] : "maxi";
    text = text.split('');
    for (l in text) {
      if (is_char(l)) {
        continue;
      }
      result = result + text[l];
      counts = {"up" : 0, "down" : 0, "mid" : 0};
      switch (options.size) {
      case 'mini':
        counts.up = randomNumber(8);
        counts.mid = randomNumber(2);
        counts.down = randomNumber(8);
        break;
      case 'maxi':
        counts.up = randomNumber(16) + 3;
        counts.mid = randomNumber(4) + 1;
        counts.down = randomNumber(64) + 3;
        break;
      default:
        counts.up = randomNumber(8) + 1;
        counts.mid = randomNumber(6) / 2;
        counts.down = randomNumber(8) + 1;
        break;
      }

      var arr = ["up", "mid", "down"];
      for (var d in arr) {
        var index = arr[d];
        for (var i = 0 ; i <= counts[index]; i++) {
          if (options[index]) {
            result = result + soul[index][randomNumber(soul[index].length)];
          }
        }
      }
    }
    return result;
  }
  // don't summon him
  return heComes(text, options);
}

},{}],25:[function(require,module,exports){
var colors = require('./colors');

module['exports'] = function () {

  //
  // Extends prototype of native string object to allow for "foo".red syntax
  //
  var addProperty = function (color, func) {
    String.prototype.__defineGetter__(color, func);
  };

  var sequencer = function sequencer (map, str) {
      return function () {
        var exploded = this.split(""), i = 0;
        exploded = exploded.map(map);
        return exploded.join("");
      }
  };

  addProperty('strip', function () {
    return colors.strip(this);
  });

  addProperty('stripColors', function () {
    return colors.strip(this);
  });

  addProperty("trap", function(){
    return colors.trap(this);
  });

  addProperty("zalgo", function(){
    return colors.zalgo(this);
  });

  addProperty("zebra", function(){
    return colors.zebra(this);
  });

  addProperty("rainbow", function(){
    return colors.rainbow(this);
  });

  addProperty("random", function(){
    return colors.random(this);
  });

  addProperty("america", function(){
    return colors.america(this);
  });

  //
  // Iterate through all default styles and colors
  //
  var x = Object.keys(colors.styles);
  x.forEach(function (style) {
    addProperty(style, function () {
      return colors.stylize(this, style);
    });
  });

  function applyTheme(theme) {
    //
    // Remark: This is a list of methods that exist
    // on String that you should not overwrite.
    //
    var stringPrototypeBlacklist = [
      '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'charAt', 'constructor',
      'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf', 'charCodeAt',
      'indexOf', 'lastIndexof', 'length', 'localeCompare', 'match', 'repeat', 'replace', 'search', 'slice', 'split', 'substring',
      'toLocaleLowerCase', 'toLocaleUpperCase', 'toLowerCase', 'toUpperCase', 'trim', 'trimLeft', 'trimRight'
    ];

    Object.keys(theme).forEach(function (prop) {
      if (stringPrototypeBlacklist.indexOf(prop) !== -1) {
        console.log('warn: '.red + ('String.prototype' + prop).magenta + ' is probably something you don\'t want to override. Ignoring style name');
      }
      else {
        if (typeof(theme[prop]) === 'string') {
          colors[prop] = colors[theme[prop]];
          addProperty(prop, function () {
            return colors[theme[prop]](this);
          });
        }
        else {
          addProperty(prop, function () {
            var ret = this;
            for (var t = 0; t < theme[prop].length; t++) {
              ret = colors[theme[prop][t]](ret);
            }
            return ret;
          });
        }
      }
    });
  }

  colors.setTheme = function (theme) {
    if (typeof theme === 'string') {
      try {
        colors.themes[theme] = require(theme);
        applyTheme(colors.themes[theme]);
        return colors.themes[theme];
      } catch (err) {
        console.log(err);
        return err;
      }
    } else {
      applyTheme(theme);
    }
  };

};

},{"./colors":22}],26:[function(require,module,exports){
var colors = require('./colors');
module['exports'] = colors;

// Remark: By default, colors will add style properties to String.prototype
//
// If you don't wish to extend String.prototype you can do this instead and native String will not be touched
//
//   var colors = require('colors/safe);
//   colors.red("foo")
//
//
require('./extendStringPrototype')();
},{"./colors":22,"./extendStringPrototype":25}],27:[function(require,module,exports){
var colors = require('../colors');

module['exports'] = (function() {
  return function (letter, i, exploded) {
    if(letter === " ") return letter;
    switch(i%3) {
      case 0: return colors.red(letter);
      case 1: return colors.white(letter)
      case 2: return colors.blue(letter)
    }
  }
})();
},{"../colors":22}],28:[function(require,module,exports){
var colors = require('../colors');

module['exports'] = (function () {
  var rainbowColors = ['red', 'yellow', 'green', 'blue', 'magenta']; //RoY G BiV
  return function (letter, i, exploded) {
    if (letter === " ") {
      return letter;
    } else {
      return colors[rainbowColors[i++ % rainbowColors.length]](letter);
    }
  };
})();


},{"../colors":22}],29:[function(require,module,exports){
var colors = require('../colors');

module['exports'] = (function () {
  var available = ['underline', 'inverse', 'grey', 'yellow', 'red', 'green', 'blue', 'white', 'cyan', 'magenta'];
  return function(letter, i, exploded) {
    return letter === " " ? letter : colors[available[Math.round(Math.random() * (available.length - 1))]](letter);
  };
})();
},{"../colors":22}],30:[function(require,module,exports){
var colors = require('../colors');

module['exports'] = function (letter, i, exploded) {
  return i % 2 === 0 ? letter : colors.inverse(letter);
};
},{"../colors":22}],31:[function(require,module,exports){
/*
The MIT License (MIT)

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

*/

var styles = {};
module['exports'] = styles;

var codes = {
  reset: [0, 0],

  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
  hidden: [8, 28],
  strikethrough: [9, 29],

  black: [30, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  gray: [90, 39],
  grey: [90, 39],

  bgBlack: [40, 49],
  bgRed: [41, 49],
  bgGreen: [42, 49],
  bgYellow: [43, 49],
  bgBlue: [44, 49],
  bgMagenta: [45, 49],
  bgCyan: [46, 49],
  bgWhite: [47, 49],

  // legacy styles for colors pre v1.0.0
  blackBG: [40, 49],
  redBG: [41, 49],
  greenBG: [42, 49],
  yellowBG: [43, 49],
  blueBG: [44, 49],
  magentaBG: [45, 49],
  cyanBG: [46, 49],
  whiteBG: [47, 49]

};

Object.keys(codes).forEach(function (key) {
  var val = codes[key];
  var style = styles[key] = [];
  style.open = '\u001b[' + val[0] + 'm';
  style.close = '\u001b[' + val[1] + 'm';
});
},{}],32:[function(require,module,exports){
(function (process){
/*
MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

'use strict';

module.exports = function (flag, argv) {
	argv = argv || process.argv;

	var terminatorPos = argv.indexOf('--');
	var prefix = /^-{1,2}/.test(flag) ? '' : '--';
	var pos = argv.indexOf(prefix + flag);

	return pos !== -1 && (terminatorPos === -1 ? true : pos < terminatorPos);
};

}).call(this,require('_process'))

},{"_process":37}],33:[function(require,module,exports){
(function (process){
/*
The MIT License (MIT)

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

*/

'use strict';

var os = require('os');
var hasFlag = require('./has-flag.js');

var env = process.env;

var forceColor = void 0;
if (hasFlag('no-color') || hasFlag('no-colors') || hasFlag('color=false')) {
	forceColor = false;
} else if (hasFlag('color') || hasFlag('colors') || hasFlag('color=true') || hasFlag('color=always')) {
	forceColor = true;
}
if ('FORCE_COLOR' in env) {
	forceColor = env.FORCE_COLOR.length === 0 || parseInt(env.FORCE_COLOR, 10) !== 0;
}

function translateLevel(level) {
	if (level === 0) {
		return false;
	}

	return {
		level: level,
		hasBasic: true,
		has256: level >= 2,
		has16m: level >= 3
	};
}

function supportsColor(stream) {
	if (forceColor === false) {
		return 0;
	}

	if (hasFlag('color=16m') || hasFlag('color=full') || hasFlag('color=truecolor')) {
		return 3;
	}

	if (hasFlag('color=256')) {
		return 2;
	}

	if (stream && !stream.isTTY && forceColor !== true) {
		return 0;
	}

	var min = forceColor ? 1 : 0;

	if (process.platform === 'win32') {
		// Node.js 7.5.0 is the first version of Node.js to include a patch to
		// libuv that enables 256 color output on Windows. Anything earlier and it
		// won't work. However, here we target Node.js 8 at minimum as it is an LTS
		// release, and Node.js 7 is not. Windows 10 build 10586 is the first Windows
		// release that supports 256 colors. Windows 10 build 14931 is the first release
		// that supports 16m/TrueColor.
		var osRelease = os.release().split('.');
		if (Number(process.versions.node.split('.')[0]) >= 8 && Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) {
			return Number(osRelease[2]) >= 14931 ? 3 : 2;
		}

		return 1;
	}

	if ('CI' in env) {
		if (['TRAVIS', 'CIRCLECI', 'APPVEYOR', 'GITLAB_CI'].some(function (sign) {
			return sign in env;
		}) || env.CI_NAME === 'codeship') {
			return 1;
		}

		return min;
	}

	if ('TEAMCITY_VERSION' in env) {
		return (/^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0
		);
	}

	if ('TERM_PROGRAM' in env) {
		var version = parseInt((env.TERM_PROGRAM_VERSION || '').split('.')[0], 10);

		switch (env.TERM_PROGRAM) {
			case 'iTerm.app':
				return version >= 3 ? 3 : 2;
			case 'Hyper':
				return 3;
			case 'Apple_Terminal':
				return 2;
			// No default
		}
	}

	if (/-256(color)?$/i.test(env.TERM)) {
		return 2;
	}

	if (/^screen|^xterm|^vt100|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) {
		return 1;
	}

	if ('COLORTERM' in env) {
		return 1;
	}

	if (env.TERM === 'dumb') {
		return min;
	}

	return min;
}

function getSupportLevel(stream) {
	var level = supportsColor(stream);
	return translateLevel(level);
}

module.exports = {
	supportsColor: getSupportLevel,
	stdout: getSupportLevel(process.stdout),
	stderr: getSupportLevel(process.stderr)
};

}).call(this,require('_process'))

},{"./has-flag.js":32,"_process":37,"os":35}],34:[function(require,module,exports){
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

var objectCreate = Object.create || objectCreatePolyfill
var objectKeys = Object.keys || objectKeysPolyfill
var bind = Function.prototype.bind || functionBindPolyfill

function EventEmitter() {
  if (!this._events || !Object.prototype.hasOwnProperty.call(this, '_events')) {
    this._events = objectCreate(null);
    this._eventsCount = 0;
  }

  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
var defaultMaxListeners = 10;

var hasDefineProperty;
try {
  var o = {};
  if (Object.defineProperty) Object.defineProperty(o, 'x', { value: 0 });
  hasDefineProperty = o.x === 0;
} catch (err) { hasDefineProperty = false }
if (hasDefineProperty) {
  Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
    enumerable: true,
    get: function() {
      return defaultMaxListeners;
    },
    set: function(arg) {
      // check whether the input is a positive number (whose value is zero or
      // greater and not a NaN).
      if (typeof arg !== 'number' || arg < 0 || arg !== arg)
        throw new TypeError('"defaultMaxListeners" must be a positive number');
      defaultMaxListeners = arg;
    }
  });
} else {
  EventEmitter.defaultMaxListeners = defaultMaxListeners;
}

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
  if (typeof n !== 'number' || n < 0 || isNaN(n))
    throw new TypeError('"n" argument must be a positive number');
  this._maxListeners = n;
  return this;
};

function $getMaxListeners(that) {
  if (that._maxListeners === undefined)
    return EventEmitter.defaultMaxListeners;
  return that._maxListeners;
}

EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
  return $getMaxListeners(this);
};

// These standalone emit* functions are used to optimize calling of event
// handlers for fast cases because emit() itself often has a variable number of
// arguments and can be deoptimized because of that. These functions always have
// the same number of arguments and thus do not get deoptimized, so the code
// inside them can execute faster.
function emitNone(handler, isFn, self) {
  if (isFn)
    handler.call(self);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self);
  }
}
function emitOne(handler, isFn, self, arg1) {
  if (isFn)
    handler.call(self, arg1);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1);
  }
}
function emitTwo(handler, isFn, self, arg1, arg2) {
  if (isFn)
    handler.call(self, arg1, arg2);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1, arg2);
  }
}
function emitThree(handler, isFn, self, arg1, arg2, arg3) {
  if (isFn)
    handler.call(self, arg1, arg2, arg3);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1, arg2, arg3);
  }
}

function emitMany(handler, isFn, self, args) {
  if (isFn)
    handler.apply(self, args);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].apply(self, args);
  }
}

EventEmitter.prototype.emit = function emit(type) {
  var er, handler, len, args, i, events;
  var doError = (type === 'error');

  events = this._events;
  if (events)
    doError = (doError && events.error == null);
  else if (!doError)
    return false;

  // If there is no 'error' event listener then throw.
  if (doError) {
    if (arguments.length > 1)
      er = arguments[1];
    if (er instanceof Error) {
      throw er; // Unhandled 'error' event
    } else {
      // At least give some kind of context to the user
      var err = new Error('Unhandled "error" event. (' + er + ')');
      err.context = er;
      throw err;
    }
    return false;
  }

  handler = events[type];

  if (!handler)
    return false;

  var isFn = typeof handler === 'function';
  len = arguments.length;
  switch (len) {
      // fast cases
    case 1:
      emitNone(handler, isFn, this);
      break;
    case 2:
      emitOne(handler, isFn, this, arguments[1]);
      break;
    case 3:
      emitTwo(handler, isFn, this, arguments[1], arguments[2]);
      break;
    case 4:
      emitThree(handler, isFn, this, arguments[1], arguments[2], arguments[3]);
      break;
      // slower
    default:
      args = new Array(len - 1);
      for (i = 1; i < len; i++)
        args[i - 1] = arguments[i];
      emitMany(handler, isFn, this, args);
  }

  return true;
};

function _addListener(target, type, listener, prepend) {
  var m;
  var events;
  var existing;

  if (typeof listener !== 'function')
    throw new TypeError('"listener" argument must be a function');

  events = target._events;
  if (!events) {
    events = target._events = objectCreate(null);
    target._eventsCount = 0;
  } else {
    // To avoid recursion in the case that type === "newListener"! Before
    // adding it to the listeners, first emit "newListener".
    if (events.newListener) {
      target.emit('newListener', type,
          listener.listener ? listener.listener : listener);

      // Re-assign `events` because a newListener handler could have caused the
      // this._events to be assigned to a new object
      events = target._events;
    }
    existing = events[type];
  }

  if (!existing) {
    // Optimize the case of one listener. Don't need the extra array object.
    existing = events[type] = listener;
    ++target._eventsCount;
  } else {
    if (typeof existing === 'function') {
      // Adding the second element, need to change to array.
      existing = events[type] =
          prepend ? [listener, existing] : [existing, listener];
    } else {
      // If we've already got an array, just append.
      if (prepend) {
        existing.unshift(listener);
      } else {
        existing.push(listener);
      }
    }

    // Check for listener leak
    if (!existing.warned) {
      m = $getMaxListeners(target);
      if (m && m > 0 && existing.length > m) {
        existing.warned = true;
        var w = new Error('Possible EventEmitter memory leak detected. ' +
            existing.length + ' "' + String(type) + '" listeners ' +
            'added. Use emitter.setMaxListeners() to ' +
            'increase limit.');
        w.name = 'MaxListenersExceededWarning';
        w.emitter = target;
        w.type = type;
        w.count = existing.length;
        if (typeof console === 'object' && console.warn) {
          console.warn('%s: %s', w.name, w.message);
        }
      }
    }
  }

  return target;
}

EventEmitter.prototype.addListener = function addListener(type, listener) {
  return _addListener(this, type, listener, false);
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.prependListener =
    function prependListener(type, listener) {
      return _addListener(this, type, listener, true);
    };

function onceWrapper() {
  if (!this.fired) {
    this.target.removeListener(this.type, this.wrapFn);
    this.fired = true;
    switch (arguments.length) {
      case 0:
        return this.listener.call(this.target);
      case 1:
        return this.listener.call(this.target, arguments[0]);
      case 2:
        return this.listener.call(this.target, arguments[0], arguments[1]);
      case 3:
        return this.listener.call(this.target, arguments[0], arguments[1],
            arguments[2]);
      default:
        var args = new Array(arguments.length);
        for (var i = 0; i < args.length; ++i)
          args[i] = arguments[i];
        this.listener.apply(this.target, args);
    }
  }
}

function _onceWrap(target, type, listener) {
  var state = { fired: false, wrapFn: undefined, target: target, type: type, listener: listener };
  var wrapped = bind.call(onceWrapper, state);
  wrapped.listener = listener;
  state.wrapFn = wrapped;
  return wrapped;
}

EventEmitter.prototype.once = function once(type, listener) {
  if (typeof listener !== 'function')
    throw new TypeError('"listener" argument must be a function');
  this.on(type, _onceWrap(this, type, listener));
  return this;
};

EventEmitter.prototype.prependOnceListener =
    function prependOnceListener(type, listener) {
      if (typeof listener !== 'function')
        throw new TypeError('"listener" argument must be a function');
      this.prependListener(type, _onceWrap(this, type, listener));
      return this;
    };

// Emits a 'removeListener' event if and only if the listener was removed.
EventEmitter.prototype.removeListener =
    function removeListener(type, listener) {
      var list, events, position, i, originalListener;

      if (typeof listener !== 'function')
        throw new TypeError('"listener" argument must be a function');

      events = this._events;
      if (!events)
        return this;

      list = events[type];
      if (!list)
        return this;

      if (list === listener || list.listener === listener) {
        if (--this._eventsCount === 0)
          this._events = objectCreate(null);
        else {
          delete events[type];
          if (events.removeListener)
            this.emit('removeListener', type, list.listener || listener);
        }
      } else if (typeof list !== 'function') {
        position = -1;

        for (i = list.length - 1; i >= 0; i--) {
          if (list[i] === listener || list[i].listener === listener) {
            originalListener = list[i].listener;
            position = i;
            break;
          }
        }

        if (position < 0)
          return this;

        if (position === 0)
          list.shift();
        else
          spliceOne(list, position);

        if (list.length === 1)
          events[type] = list[0];

        if (events.removeListener)
          this.emit('removeListener', type, originalListener || listener);
      }

      return this;
    };

EventEmitter.prototype.removeAllListeners =
    function removeAllListeners(type) {
      var listeners, events, i;

      events = this._events;
      if (!events)
        return this;

      // not listening for removeListener, no need to emit
      if (!events.removeListener) {
        if (arguments.length === 0) {
          this._events = objectCreate(null);
          this._eventsCount = 0;
        } else if (events[type]) {
          if (--this._eventsCount === 0)
            this._events = objectCreate(null);
          else
            delete events[type];
        }
        return this;
      }

      // emit removeListener for all listeners on all events
      if (arguments.length === 0) {
        var keys = objectKeys(events);
        var key;
        for (i = 0; i < keys.length; ++i) {
          key = keys[i];
          if (key === 'removeListener') continue;
          this.removeAllListeners(key);
        }
        this.removeAllListeners('removeListener');
        this._events = objectCreate(null);
        this._eventsCount = 0;
        return this;
      }

      listeners = events[type];

      if (typeof listeners === 'function') {
        this.removeListener(type, listeners);
      } else if (listeners) {
        // LIFO order
        for (i = listeners.length - 1; i >= 0; i--) {
          this.removeListener(type, listeners[i]);
        }
      }

      return this;
    };

EventEmitter.prototype.listeners = function listeners(type) {
  var evlistener;
  var ret;
  var events = this._events;

  if (!events)
    ret = [];
  else {
    evlistener = events[type];
    if (!evlistener)
      ret = [];
    else if (typeof evlistener === 'function')
      ret = [evlistener.listener || evlistener];
    else
      ret = unwrapListeners(evlistener);
  }

  return ret;
};

EventEmitter.listenerCount = function(emitter, type) {
  if (typeof emitter.listenerCount === 'function') {
    return emitter.listenerCount(type);
  } else {
    return listenerCount.call(emitter, type);
  }
};

EventEmitter.prototype.listenerCount = listenerCount;
function listenerCount(type) {
  var events = this._events;

  if (events) {
    var evlistener = events[type];

    if (typeof evlistener === 'function') {
      return 1;
    } else if (evlistener) {
      return evlistener.length;
    }
  }

  return 0;
}

EventEmitter.prototype.eventNames = function eventNames() {
  return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
};

// About 1.5x faster than the two-arg version of Array#splice().
function spliceOne(list, index) {
  for (var i = index, k = i + 1, n = list.length; k < n; i += 1, k += 1)
    list[i] = list[k];
  list.pop();
}

function arrayClone(arr, n) {
  var copy = new Array(n);
  for (var i = 0; i < n; ++i)
    copy[i] = arr[i];
  return copy;
}

function unwrapListeners(arr) {
  var ret = new Array(arr.length);
  for (var i = 0; i < ret.length; ++i) {
    ret[i] = arr[i].listener || arr[i];
  }
  return ret;
}

function objectCreatePolyfill(proto) {
  var F = function() {};
  F.prototype = proto;
  return new F;
}
function objectKeysPolyfill(obj) {
  var keys = [];
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
    keys.push(k);
  }
  return k;
}
function functionBindPolyfill(context) {
  var fn = this;
  return function () {
    return fn.apply(context, arguments);
  };
}

},{}],35:[function(require,module,exports){
exports.endianness = function () { return 'LE' };

exports.hostname = function () {
    if (typeof location !== 'undefined') {
        return location.hostname
    }
    else return '';
};

exports.loadavg = function () { return [] };

exports.uptime = function () { return 0 };

exports.freemem = function () {
    return Number.MAX_VALUE;
};

exports.totalmem = function () {
    return Number.MAX_VALUE;
};

exports.cpus = function () { return [] };

exports.type = function () { return 'Browser' };

exports.release = function () {
    if (typeof navigator !== 'undefined') {
        return navigator.appVersion;
    }
    return '';
};

exports.networkInterfaces
= exports.getNetworkInterfaces
= function () { return {} };

exports.arch = function () { return 'javascript' };

exports.platform = function () { return 'browser' };

exports.tmpdir = exports.tmpDir = function () {
    return '/tmp';
};

exports.EOL = '\n';

exports.homedir = function () {
	return '/'
};

},{}],36:[function(require,module,exports){
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

},{"_process":37}],37:[function(require,module,exports){
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

},{}],38:[function(require,module,exports){
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

},{}],39:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],40:[function(require,module,exports){
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

},{"./support/isBuffer":39,"_process":37,"inherits":38}],41:[function(require,module,exports){
/* global describe it */
const assert = require('assert');
const deq = (z_expect, z_actual) => {
	assert.deepStrictEqual(z_actual, z_expect);
};
const eq = (z_expect, z_actual) => {
	assert.strictEqual(z_actual, z_expect);
};
const fs = require('fs');

const worker = require('../../build/main/module.js').scopify(require, () => {
	require('./workers/basic.js');
}, 'undefined' !== typeof arguments && arguments);

const spawn = (s_name='basic') => worker.spawn(`./workers/${s_name}.js`);
const pool = (s_name='basic') => worker.pool(`./workers/${s_name}.js`);
const group = (n_workers, s_name='basic') => worker.group(`./workers/${s_name}.js`, n_workers);

const run = async (...a_args) => {
	let k_worker = spawn();
	let z_result = await k_worker.run(...a_args);
	await k_worker.kill();
	return z_result;
};


describe('worker', () => {

	it('runs', async() => {
		eq('yeh', await run('reverse_string', ['hey']));
	});

	it('twice', async() => {
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
		setTimeout(async() => {
			await k_worker.kill();
			fke_test();
		}, 100);
	});

	it('catches', (fke_test) => {
		let k_worker = spawn();
		k_worker.run('fail')
			.then(() => fke_test('error not caught by master'))
			.catch(async(e_run) => {
				assert(e_run.message.includes('no such task'));
				await k_worker.kill();
				fke_test();
			});
	});

	it('events', async() => {
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


describe('pool', () => {
	it('events', async() => {
		let k_pool = pool();
		let n_says = 10;
		let c_byes = 0;
		let a_waits = [];

		const h_events = {
			notify(s_say) {
				if('bye' === s_say) c_byes += 1;
			},
		};

		for(let i=0; i<n_says; i++) {
			a_waits.push(k_pool
				.run('events', [
					[
						{
							name: 'notify',
							data: 'hi',
							wait: 5,
						},
						{
							name: 'notify',
							data: 'bye',
							wait: 15,
						},
					],
				], h_events));
		}

		await Promise.all(a_waits);

		await k_pool.kill();

		eq(n_says, c_byes);
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

	it('map/reduce empty', (fke_test) => {
		let k_group = group(8);
		k_group
			.data([])
			.map('concat')
			.reduce('merge_concat').then(async (s_final=null) => {
				await k_group.kill();
				eq(null, s_final);
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


/* TODO:

 - await group#end
 - await group#run
 - event emitters
 - channel messaging

[node.js]
 - channel socket file unlinking (including on abrubt exit)


*/



},{"../../build/main/module.js":18,"./workers/basic.js":42,"assert":19,"fs":21}],42:[function(require,module,exports){
const worker = require('../../../build/main/module.js');

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

},{"../../../build/main/module.js":18}]},{},[41])
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJidWlsZC9tYWluL2FsbC9kZWRpY2F0ZWQuanMiLCJidWlsZC9tYWluL2FsbC9ncm91cC5qcyIsImJ1aWxkL21haW4vYWxsL2xvY2Fscy5qcyIsImJ1aWxkL21haW4vYWxsL2xvY2thYmxlLmpzIiwiYnVpbGQvbWFpbi9hbGwvbWFuaWZlc3QuanMiLCJidWlsZC9tYWluL2FsbC9wb29sLmpzIiwiYnVpbGQvbWFpbi9hbGwvcmVzdWx0LmpzIiwiYnVpbGQvbWFpbi9icm93c2VyL2NoYW5uZWwuanMiLCJidWlsZC9tYWluL2Jyb3dzZXIvZXZlbnRzLmpzIiwiYnVpbGQvbWFpbi9icm93c2VyL2xhdGVudC1zdWJ3b3JrZXIuanMiLCJidWlsZC9tYWluL2Jyb3dzZXIvbG9jYWxzLmpzIiwiYnVpbGQvbWFpbi9icm93c2VyL3BvcnRzLmpzIiwiYnVpbGQvbWFpbi9icm93c2VyL3NlbGYuanMiLCJidWlsZC9tYWluL2Jyb3dzZXIvc2hhcmluZy5qcyIsImJ1aWxkL21haW4vYnJvd3Nlci9zdHJlYW0uanMiLCJidWlsZC9tYWluL2Jyb3dzZXIvdHlwZWQtYXJyYXlzLmpzIiwiYnVpbGQvbWFpbi9icm93c2VyL3dvcmtlci5qcyIsImJ1aWxkL21haW4vbW9kdWxlLmpzIiwibm9kZV9tb2R1bGVzL2Fzc2VydC9hc3NlcnQuanMiLCJub2RlX21vZHVsZXMvYnJvd3Nlci1yZXNvbHZlL2VtcHR5LmpzIiwibm9kZV9tb2R1bGVzL2NvbG9ycy9saWIvY29sb3JzLmpzIiwibm9kZV9tb2R1bGVzL2NvbG9ycy9saWIvY3VzdG9tL3RyYXAuanMiLCJub2RlX21vZHVsZXMvY29sb3JzL2xpYi9jdXN0b20vemFsZ28uanMiLCJub2RlX21vZHVsZXMvY29sb3JzL2xpYi9leHRlbmRTdHJpbmdQcm90b3R5cGUuanMiLCJub2RlX21vZHVsZXMvY29sb3JzL2xpYi9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9jb2xvcnMvbGliL21hcHMvYW1lcmljYS5qcyIsIm5vZGVfbW9kdWxlcy9jb2xvcnMvbGliL21hcHMvcmFpbmJvdy5qcyIsIm5vZGVfbW9kdWxlcy9jb2xvcnMvbGliL21hcHMvcmFuZG9tLmpzIiwibm9kZV9tb2R1bGVzL2NvbG9ycy9saWIvbWFwcy96ZWJyYS5qcyIsIm5vZGVfbW9kdWxlcy9jb2xvcnMvbGliL3N0eWxlcy5qcyIsIm5vZGVfbW9kdWxlcy9jb2xvcnMvbGliL3N5c3RlbS9oYXMtZmxhZy5qcyIsIm5vZGVfbW9kdWxlcy9jb2xvcnMvbGliL3N5c3RlbS9zdXBwb3J0cy1jb2xvcnMuanMiLCJub2RlX21vZHVsZXMvZXZlbnRzL2V2ZW50cy5qcyIsIm5vZGVfbW9kdWxlcy9vcy1icm93c2VyaWZ5L2Jyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvcGF0aC1icm93c2VyaWZ5L2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3Byb2Nlc3MvYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy91dGlsL25vZGVfbW9kdWxlcy9pbmhlcml0cy9pbmhlcml0c19icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL3V0aWwvc3VwcG9ydC9pc0J1ZmZlckJyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvdXRpbC91dGlsLmpzIiwidGVzdC9tYWluL21vZHVsZS5qcyIsInRlc3QvbWFpbi93b3JrZXJzL2Jhc2ljLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcldBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDcmlDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDckZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMvRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNySUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOUtBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzFGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1ZBO0FBQ0E7QUFDQTtBQUNBOztBQ0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQzVYQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQzlvQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDdkRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7OztBQ2hrQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQzFlQTs7OztBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4R0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDWEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDYkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQzVFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7O0FDdkJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDbkpBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZnQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDakRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ2hPQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQzFrQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcFVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbigpe2Z1bmN0aW9uIHIoZSxuLHQpe2Z1bmN0aW9uIG8oaSxmKXtpZighbltpXSl7aWYoIWVbaV0pe3ZhciBjPVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmU7aWYoIWYmJmMpcmV0dXJuIGMoaSwhMCk7aWYodSlyZXR1cm4gdShpLCEwKTt2YXIgYT1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK2krXCInXCIpO3Rocm93IGEuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixhfXZhciBwPW5baV09e2V4cG9ydHM6e319O2VbaV1bMF0uY2FsbChwLmV4cG9ydHMsZnVuY3Rpb24ocil7dmFyIG49ZVtpXVsxXVtyXTtyZXR1cm4gbyhufHxyKX0scCxwLmV4cG9ydHMscixlLG4sdCl9cmV0dXJuIG5baV0uZXhwb3J0c31mb3IodmFyIHU9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWlyZSYmcmVxdWlyZSxpPTA7aTx0Lmxlbmd0aDtpKyspbyh0W2ldKTtyZXR1cm4gb31yZXR1cm4gcn0pKCkiLCJjb25zdCB7XG5cdEtfU0VMRixcblx0c3RyZWFtLFxuXHRwb3J0cyxcbn0gPSByZXF1aXJlKCcuL2xvY2Fscy5qcycpO1xuXG5jb25zdCB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuY29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKCcuL21hbmlmZXN0LmpzJyk7XG5jb25zdCByZXN1bHQgPSByZXF1aXJlKCcuL3Jlc3VsdC5qcycpO1xuXG5jbGFzcyBoZWxwZXIge1xuXHRjb25zdHJ1Y3RvcihrX3dvcmtlciwgaV90YXNrLCBoX2V2ZW50cykge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0d29ya2VyOiBrX3dvcmtlcixcblx0XHRcdHRhc2tfaWQ6IGlfdGFzayxcblx0XHRcdGV2ZW50czogaF9ldmVudHMgfHwge30sXG5cdFx0XHR3b3JrZXJfc3RvcmU6IGtfd29ya2VyLnN0b3JlLFxuXHRcdFx0dGFza3M6IGtfd29ya2VyLnRhc2tzLFxuXHRcdH0pO1xuXHR9XG5cblx0cHV0KHNfa2V5LCB6X2RhdGEpIHtcblx0XHRsZXQgaF9zdG9yZSA9IHRoaXMud29ya2VyX3N0b3JlO1xuXHRcdGxldCBpX3Rhc2sgPSB0aGlzLnRhc2tfaWQ7XG5cblx0XHQvLyBmaXJzdCBpdGVtIGluIHRoaXMgdGFzaydzIHN0b3JlXG5cdFx0aWYoIShpX3Rhc2sgaW4gaF9zdG9yZSkpIHtcblx0XHRcdGhfc3RvcmVbaV90YXNrXSA9IHtcblx0XHRcdFx0W3Nfa2V5XTogel9kYXRhLFxuXHRcdFx0fTtcblx0XHR9XG5cdFx0Ly8gbm90IGZpcnN0IGl0ZW07IGFkZCBpdFxuXHRcdGVsc2Uge1xuXHRcdFx0aF9zdG9yZVtpX3Rhc2tdW3Nfa2V5XSA9IHpfZGF0YTtcblx0XHR9XG5cdH1cblxuXHRnZXQoc19rZXkpIHtcblx0XHRsZXQgaV90YXNrID0gdGhpcy50YXNrX2lkO1xuXG5cdFx0Ly8gdGhpcyB0YXNrIGNoYWluIHdhcyBuZXZlciB3cml0dGVuIHRvXG5cdFx0aWYoIShpX3Rhc2sgaW4gdGhpcy53b3JrZXJfc3RvcmUpKSByZXR1cm47XG5cblx0XHQvLyByZXR1cm4gd2hhdGV2ZXIgdmFsdWUgaXMgdGhlcmVcblx0XHRyZXR1cm4gdGhpcy53b3JrZXJfc3RvcmVbaV90YXNrXVtzX2tleV07XG5cdH1cblxuXHRlbWl0KHNfa2V5LCAuLi5hX2FyZ3MpIHtcblx0XHQvLyBvbmx5IGlmIHRoZSBldmVudCBpcyByZWdpc3RlcmVkXG5cdFx0aWYoc19rZXkgaW4gdGhpcy5ldmVudHMpIHtcblx0XHRcdGxldCBhX2FyZ3Nfc2VuZCA9IFtdO1xuXHRcdFx0bGV0IGFfdHJhbnNmZXJfcGF0aHMgPSBbXTtcblxuXHRcdFx0Ly8gbWVyZ2UgYXJnc1xuXHRcdFx0bGV0IG5fYXJncyA9IGFfYXJncy5sZW5ndGg7XG5cdFx0XHRmb3IobGV0IGlfYXJnPTA7IGlfYXJnPG5fYXJnczsgaV9hcmcrKykge1xuXHRcdFx0XHRsZXQgel9hcmcgPSBhX2FyZ3NbaV9hcmddO1xuXG5cdFx0XHRcdC8vIHJlc3VsdFxuXHRcdFx0XHRpZih6X2FyZyBpbnN0YW5jZW9mIG1hbmlmZXN0KSB7XG5cdFx0XHRcdFx0YV9hcmdzX3NlbmQucHVzaCh6X2FyZy5kYXRhKTtcblx0XHRcdFx0XHRpZih6X2FyZy50cmFuc2Zlcl9wYXRocykge1xuXHRcdFx0XHRcdFx0bGV0IG5sX3BhdGhzID0gYV90cmFuc2Zlcl9wYXRocy5sZW5ndGg7XG5cdFx0XHRcdFx0XHRsZXQgYV9pbXBvcnRfcGF0aHMgPSB6X2FyZy50cmFuc2Zlcl9wYXRocztcblx0XHRcdFx0XHRcdGFfaW1wb3J0X3BhdGhzLmZvckVhY2goKGFfcGF0aCkgPT4ge1xuXHRcdFx0XHRcdFx0XHRhX3BhdGhbMF0gKz0gbmxfcGF0aHM7XG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdGFfdHJhbnNmZXJfcGF0aHMucHVzaCguLi5hX2ltcG9ydF9wYXRocyk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIHBvc3RhYmxlXG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdGFfYXJnc19zZW5kLnB1c2goel9hcmcpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIHNlbmQgbWVzc2FnZVxuXHRcdFx0S19TRUxGLnBvc3RNZXNzYWdlKHtcblx0XHRcdFx0dHlwZTogJ2V2ZW50Jyxcblx0XHRcdFx0aWQ6IHRoaXMudGFza19pZCxcblx0XHRcdFx0ZXZlbnQ6IHNfa2V5LFxuXHRcdFx0XHRhcmdzOiBhX2FyZ3Nfc2VuZCxcblx0XHRcdH0sIGFfdHJhbnNmZXJfcGF0aHMpO1xuXHRcdH1cblx0fVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGNsYXNzIGRlZGljYXRlZCBleHRlbmRzIHN0cmVhbS5oYW5kbGVyIHtcblx0Y29uc3RydWN0b3IoaF90YXNrcywgZl9pbml0PW51bGwpIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0aWYoIUtfU0VMRikge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBvb3BzISBsb29rcyBsaWtlIHlvdSB0cmllZCBsb2FkaW5nIGEgZGVkaWNhdGVkIHdvcmtlciBpbiB0aGUgdG9wIHRocmVhZGApO1xuXHRcdH1cblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0dGFza3M6IGhfdGFza3MsXG5cdFx0XHRzdG9yZToge30sXG5cdFx0XHRyZXN1bHRzOiB7fSxcblx0XHRcdHBvcnQ6IEtfU0VMRixcblx0XHRcdGlkOiBLX1NFTEYuYXJnc1swXSxcblx0XHR9KTtcblxuXHRcdEtfU0VMRi5vbignZXJyb3InLCAoZV93b3JrZXIpID0+IHtcblx0XHRcdHRoaXMudGhyb3coZV93b3JrZXIpO1xuXHRcdH0pO1xuXG5cdFx0dGhpcy5zZXRfcG9ydChLX1NFTEYpO1xuXG5cdFx0Ly8gaW5pdCBmdW5jdGlvblxuXHRcdGlmKGZfaW5pdCkgZl9pbml0KEtfU0VMRi5hcmdzLnNsaWNlKDEpKTtcblx0fVxuXG5cdGRlYnVnKHNfdGFnLCBzX3R5cGUsIC4uLmFfaW5mbykge1xuXHRcdGNvbnNvbGUud2FybihgWyR7c190YWd9XSBgLndoaXRlK2BTJHt0aGlzLmlkfWAueWVsbG93K2AgJHtzX3R5cGV9ICR7YV9pbmZvLmxlbmd0aD8gJygnK2FfaW5mby5qb2luKCcsICcpKycpJzogJy0nfWApO1xuXHR9XG5cblx0Ly8gcmVzb2x2ZXMgcHJvbWlzZXMgYW5kIHdyYXBzIHJlc3VsdHNcblx0cmVzb2x2ZSh6X3Jlc3VsdCwgZmtfcmVzb2x2ZSkge1xuXHRcdC8vIGEgcHJvbWlzZSB3YXMgcmV0dXJuZWRcblx0XHRpZih6X3Jlc3VsdCBpbnN0YW5jZW9mIFByb21pc2UpIHtcblx0XHRcdHpfcmVzdWx0XG5cdFx0XHRcdC8vIG9uY2UgaXRzIHJlYWR5OyByZXNvbHZlIHVzaW5nIHJlc3VsdFxuXHRcdFx0XHQudGhlbigoel9kYXRhKSA9PiB7XG5cdFx0XHRcdFx0ZmtfcmVzb2x2ZShyZXN1bHQuZnJvbSh6X2RhdGEpKTtcblx0XHRcdFx0fSlcblx0XHRcdFx0Ly8gb3IgY2F0Y2ggaWYgdGhlcmUgd2FzIGEgc3ludGF4IGVycm9yIC8gZXRjLlxuXHRcdFx0XHQuY2F0Y2goKGVfcmVzb2x2ZSkgPT4ge1xuXHRcdFx0XHRcdHRoaXMudGhyb3coZV9yZXNvbHZlKTtcblx0XHRcdFx0fSk7XG5cdFx0fVxuXHRcdC8vIHN5bmNcblx0XHRlbHNlIHtcblx0XHRcdHJldHVybiBma19yZXNvbHZlKHJlc3VsdC5mcm9tKHpfcmVzdWx0KSk7XG5cdFx0fVxuXHR9XG5cblx0dGhyb3coZV90aHJvdykge1xuXHRcdHRoaXMucG9ydC5wb3N0TWVzc2FnZSh7XG5cdFx0XHR0eXBlOiAnZXJyb3InLFxuXHRcdFx0ZXJyb3I6IHtcblx0XHRcdFx0bWVzc2FnZTogZV90aHJvdy5tZXNzYWdlLFxuXHRcdFx0XHRzdGFjazogZV90aHJvdy5zdGFjayxcblx0XHRcdH0sXG5cdFx0fSk7XG5cdH1cblxuXHQvLyB0eXBpY2FsIGV4ZWN1dGUtYW5kLXJlc3BvbmQgdGFza1xuXHRoYW5kbGVfdGFzayhoX21zZykge1xuXHRcdGxldCBoX3Rhc2tzID0gdGhpcy50YXNrcztcblxuXHRcdGxldCB7XG5cdFx0XHRpZDogaV90YXNrLFxuXHRcdFx0dGFzazogc190YXNrLFxuXHRcdFx0YXJnczogYV9hcmdzLFxuXHRcdFx0aW5oZXJpdDogaV9pbmhlcml0PTAsXG5cdFx0XHRyZWNlaXZlOiBpX3JlY2VpdmU9MCxcblx0XHRcdGhvbGQ6IGJfaG9sZD1mYWxzZSxcblx0XHRcdGV2ZW50czogaF9ldmVudHM9e30sXG5cdFx0XHRkZWJ1Zzogc19kZWJ1Zyxcblx0XHR9ID0gaF9tc2c7XG5cblx0XHR0aGlzLmluZm8gPSBoX21zZztcblxuXHRcdGlmKHNfZGVidWcpIHRoaXMuZGVidWcoc19kZWJ1ZywgJzw8IHRhc2s6JytzX3Rhc2ssIGlfdGFzayk7XG5cblx0XHQvLyBubyBzdWNoIHRhc2tcblx0XHRpZighKHNfdGFzayBpbiBoX3Rhc2tzKSkge1xuXHRcdFx0cmV0dXJuIHRoaXMudGhyb3cobmV3IEVycm9yKGBkZWRpY2F0ZWQgd29ya2VyIGhhcyBubyBzdWNoIHRhc2sgcmVnaXN0ZXJlZCBhcyAnJHtzX3Rhc2t9J2ApKTtcblx0XHR9XG5cblx0XHQvLyBpbmhlcml0IHN0b3JlIGZyb20gcHJldmlvdXMgdGFza1xuXHRcdGlmKGlfaW5oZXJpdCkge1xuXHRcdFx0bGV0IGhfc3RvcmUgPSB0aGlzLnN0b3JlO1xuXHRcdFx0aF9zdG9yZVtpX3Rhc2tdID0gaF9zdG9yZVtpX2luaGVyaXRdO1xuXHRcdFx0ZGVsZXRlIGhfc3RvcmVbaV9pbmhlcml0XTtcblx0XHR9XG5cblx0XHQvLyByZWNlaXZlIGRhdGEgZnJvbSBwcmV2aW91cyB0YXNrXG5cdFx0aWYoaV9yZWNlaXZlKSB7XG5cdFx0XHRsZXQgaF9yZXN1bHRzID0gdGhpcy5yZXN1bHRzO1xuXG5cdFx0XHQvLyBwdXNoIHRvIGZyb250IG9mIGFyZ3Ncblx0XHRcdGFfYXJncy51bnNoaWZ0KGhfcmVzdWx0c1tpX3JlY2VpdmVdLmRhdGFbMF0pO1xuXG5cdFx0XHQvLyBmcmVlIHRvIGdjXG5cdFx0XHRkZWxldGUgaF9yZXN1bHRzW2lfcmVjZWl2ZV07XG5cdFx0fVxuXG5cdFx0Ly8gZXhlY3V0ZSBnaXZlbiB0YXNrXG5cdFx0bGV0IHpfcmVzdWx0O1xuXG5cdFx0Ly8gZGVidWdnaW5nLCBhbGxvdyBlcnJvciB0byBiZSB0aHJvd25cblx0XHRpZihzX2RlYnVnKSB7XG5cdFx0XHR6X3Jlc3VsdCA9IGhfdGFza3Nbc190YXNrXS5hcHBseShuZXcgaGVscGVyKHRoaXMsIGlfdGFzaywgaF9ldmVudHMpLCBhX2FyZ3MpO1xuXHRcdH1cblx0XHQvLyBjYXRjaCBhbmQgcGFzcyBlcnJvciB0byBtYXN0ZXJcblx0XHRlbHNlIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdHpfcmVzdWx0ID0gaF90YXNrc1tzX3Rhc2tdLmFwcGx5KG5ldyBoZWxwZXIodGhpcywgaV90YXNrLCBoX2V2ZW50cyksIGFfYXJncyk7XG5cdFx0XHR9XG5cdFx0XHRjYXRjaChlX2V4ZWMpIHtcblx0XHRcdFx0ZV9leGVjLm1lc3NhZ2UgPSBgd29ya2VyIHRocmV3IGFuIGVycm9yIHdoaWxlIGV4ZWN1dGluZyB0YXNrICcke3NfdGFza30nOlxcbiR7ZV9leGVjLm1lc3NhZ2V9YDtcblx0XHRcdFx0cmV0dXJuIHRoaXMudGhyb3coZV9leGVjKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBob2xkIHJlc3VsdCBkYXRhIGFuZCBhd2FpdCBmdXJ0aGVyIGluc3RydWN0aW9ucyBmcm9tIG1hc3RlclxuXHRcdGlmKGJfaG9sZCkge1xuXHRcdFx0dGhpcy5yZXNvbHZlKHpfcmVzdWx0LCAoa19yZXN1bHQpID0+IHtcblx0XHRcdFx0Ly8gc3RvcmUgcmVzdWx0XG5cdFx0XHRcdHRoaXMucmVzdWx0c1tpX3Rhc2tdID0ga19yZXN1bHQ7XG5cblx0XHRcdFx0Ly8gc3VibWl0IG5vdGlmaWNhdGlvbiB0byBtYXN0ZXJcblx0XHRcdFx0dGhpcy5wb3J0LnBvc3RNZXNzYWdlKHtcblx0XHRcdFx0XHR0eXBlOiAnbm90aWZ5Jyxcblx0XHRcdFx0XHRpZDogaV90YXNrLFxuXHRcdFx0XHRcdGRlYnVnOiBzX2RlYnVnLFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRpZihzX2RlYnVnKSB0aGlzLmRlYnVnKHNfZGVidWcsICc+PiBub3RpZnknLnJlZCwgaV90YXNrKTtcblx0XHRcdH0pO1xuXHRcdH1cblx0XHQvLyBzZW5kIHJlc3VsdCBiYWNrIHRvIG1hc3RlciBhcyBzb29uIGFzIGl0cyByZWFkeVxuXHRcdGVsc2Uge1xuXHRcdFx0dGhpcy5yZXNvbHZlKHpfcmVzdWx0LCAoa19yZXN1bHQpID0+IHtcblx0XHRcdFx0dGhpcy5wb3J0LnBvc3RNZXNzYWdlKHtcblx0XHRcdFx0XHR0eXBlOiAncmVzcG9uZCcsXG5cdFx0XHRcdFx0aWQ6IGlfdGFzayxcblx0XHRcdFx0XHRkYXRhOiBrX3Jlc3VsdC5kYXRhWzBdLFxuXHRcdFx0XHRcdGRlYnVnOiBzX2RlYnVnLFxuXHRcdFx0XHR9LCBrX3Jlc3VsdC5wYXRocygnZGF0YScpKTtcblxuXHRcdFx0XHRpZihzX2RlYnVnKSB0aGlzLmRlYnVnKHNfZGVidWcsICc+PiByZXNwb25kJy5yZWQsIGlfdGFzayk7XG5cdFx0XHR9KTtcblx0XHR9XG5cdH1cblxuXHQvLyBzZW5kIHJlc3VsdCBkYXRhIHRvIHNpYmxpbmdcblx0aGFuZGxlX3JlbGF5KGhfbXNnKSB7XG5cdFx0bGV0IGhfcmVzdWx0cyA9IHRoaXMucmVzdWx0cztcblxuXHRcdGxldCB7XG5cdFx0XHRpZDogaV90YXNrLFxuXHRcdFx0cG9ydDogZF9wb3J0LFxuXHRcdFx0ZGVidWc6IHNfZGVidWcsXG5cdFx0fSA9IGhfbXNnO1xuXG5cdFx0Ly8gY29uc29sZS5kaXIoZF9wb3J0KTtcblx0XHRpZihzX2RlYnVnKSB0aGlzLmRlYnVnKHNfZGVidWcsICc8PCByZWxheScsIGlfdGFzaywgZF9wb3J0Lm5hbWUpO1xuXG5cdFx0Ly8gZ3JhYiByZXN1bHRcblx0XHRsZXQga19yZXN1bHQgPSBoX3Jlc3VsdHNbaV90YXNrXTtcblxuXHRcdC8vIGZvcndhcmQgdG8gZ2l2ZW4gcG9ydFxuXHRcdGRfcG9ydC5wb3N0TWVzc2FnZSh7XG5cdFx0XHR0eXBlOiAndHJhbnNmZXInLFxuXHRcdFx0c2VuZGVyOiBpX3Rhc2ssXG5cdFx0XHRkYXRhOiBrX3Jlc3VsdC5kYXRhWzBdLFxuXHRcdH0sIGtfcmVzdWx0LnRyYW5zZmVyX3BhdGhzLm1hcChhID0+IGEudW5zaGlmdCgnZGF0YScpKSk7XG5cblx0XHQvLyBmcmVlIHRvIGdjXG5cdFx0ZGVsZXRlIGhfcmVzdWx0c1tpX3Rhc2tdO1xuXHR9XG5cblx0Ly8gcmVjZWl2ZSBkYXRhIGZyb20gc2libGluZyBhbmQgdGhlbiBleGVjdXRlIHJlYWR5IHRhc2tcblx0aGFuZGxlX3JlY2VpdmUoaF9tc2cpIHtcblx0XHRsZXQge1xuXHRcdFx0cG9ydDogZF9wb3J0LFxuXHRcdFx0aW1wb3J0OiBpX2ltcG9ydCxcblx0XHRcdHByaW1hcnk6IGJfcHJpbWFyeSxcblx0XHRcdHNlbmRlcjogaV9zZW5kZXIsXG5cdFx0XHR0YXNrX3JlYWR5OiBoX3Rhc2tfcmVhZHksXG5cdFx0XHRkZWJ1Zzogc19kZWJ1Zyxcblx0XHR9ID0gaF9tc2c7XG5cblx0XHQvLyBhY2NlcHQgcG9ydFxuXHRcdHBvcnRzKGRfcG9ydCk7XG5cblx0XHRpZihzX2RlYnVnKSB0aGlzLmRlYnVnKHNfZGVidWcsICc8PCByZWNlaXZlOicraV9pbXBvcnQsIGhfdGFza19yZWFkeS5pZCwgZF9wb3J0Lm5hbWUpO1xuXG5cdFx0Ly8gaW1wb3J0IGRhdGFcblx0XHRsZXQgel9kYXRhX2ltcG9ydCA9IHRoaXMucmVzdWx0c1tpX2ltcG9ydF0uZGF0YVswXTtcblxuXHRcdC8vIGZyZWUgdG8gZ2Ncblx0XHRkZWxldGUgdGhpcy5yZXN1bHRzW2lfaW1wb3J0XTtcblxuXHRcdC8vIHRhc2sgcmVhZHkgYXJnc1xuXHRcdGxldCBhX2FyZ3NfdGFza19yZWFkeSA9IGhfdGFza19yZWFkeS5hcmdzO1xuXG5cdFx0Ly8gaW1wb3J0IGlzIHNlY29uZGFyeVxuXHRcdGlmKCFiX3ByaW1hcnkpIGFfYXJnc190YXNrX3JlYWR5LnVuc2hpZnQoel9kYXRhX2ltcG9ydCk7XG5cblx0XHRpZihzX2RlYnVnKSB0aGlzLmRlYnVnKHNfZGVidWcsICdzZXR1cCcsIHV0aWwuaW5zcGVjdChhX2FyZ3NfdGFza19yZWFkeSwge2RlcHRoOm51bGx9KSk7XG5cblx0XHQvLyBzZXQgdXAgbWVzc2FnZSBsaXN0ZW5lciBvbiBwb3J0XG5cdFx0bGV0IGZrX21lc3NhZ2UgPSAoZF9tc2dfcmVjZWl2ZSkgPT4ge1xuXHRcdFx0bGV0IGhfbXNnX3JlY2VpdmUgPSBkX21zZ19yZWNlaXZlLmRhdGE7XG5cblx0XHRcdC8vIG1hdGNoaW5nIHNlbmRlclxuXHRcdFx0aWYoaV9zZW5kZXIgPT09IGhfbXNnX3JlY2VpdmUuc2VuZGVyKSB7XG5cdFx0XHRcdGlmKHNfZGVidWcpIHRoaXMuZGVidWcoc19kZWJ1ZywgJzw8IHJlbGF5L3JlY2VpdmUnLCBpX3NlbmRlciwgZF9wb3J0Lm5hbWUpO1xuXG5cdFx0XHRcdC8vIHVuYmluZCBsaXN0ZW5lclxuXHRcdFx0XHRkX3BvcnQucmVtb3ZlTGlzdGVuZXIoJ21lc3NhZ2UnLCBma19tZXNzYWdlKTtcblxuXHRcdFx0XHQvLyBwdXNoIG1lc3NhZ2UgdG8gZnJvbnQgb2YgYXJnc1xuXHRcdFx0XHRhX2FyZ3NfdGFza19yZWFkeS51bnNoaWZ0KGhfbXNnX3JlY2VpdmUuZGF0YSk7XG5cblx0XHRcdFx0Ly8gaW1wb3J0IGlzIHByaW1hcnlcblx0XHRcdFx0aWYoYl9wcmltYXJ5KSBhX2FyZ3NfdGFza19yZWFkeS51bnNoaWZ0KHpfZGF0YV9pbXBvcnQpO1xuXG5cdFx0XHRcdC8vIGZpcmUgcmVhZHkgdGFza1xuXHRcdFx0XHR0aGlzLmhhbmRsZV90YXNrKGhfdGFza19yZWFkeSk7XG5cdFx0XHR9XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0aWYoc19kZWJ1ZykgdGhpcy5kZWJ1ZyhzX2RlYnVnLCAnaWdub3JpbmcgJytoX21zZ19yZWNlaXZlLnNlbmRlcisnICE9ICcraV9zZW5kZXIpO1xuXHRcdFx0fVxuXHRcdH07XG5cblx0XHQvLyBiaW5kIGxpc3RlbmVyXG5cdFx0ZF9wb3J0Lm9uKCdtZXNzYWdlJywgZmtfbWVzc2FnZSk7XG5cdH1cblxuXHRoYW5kbGVfcGluZygpIHtcblx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0dHlwZTogJ3BvbmcnLFxuXHRcdH0pO1xuXHR9XG5cblx0aGFuZGxlX293bmVyKGhfbXNnKSB7XG5cdFx0dGhpcy5zZXRfcG9ydChwb3J0cyhoX21zZy5wb3J0KSk7XG5cdH1cblxuXHRoYW5kbGVfc3Vid29ya2VyKGhfbXNnKSB7XG5cdFx0cmVxdWlyZSgnLi4vYnJvd3Nlci9sYXRlbnQtc3Vid29ya2VyLmpzJykuY29ubmVjdChoX21zZyk7XG5cdH1cblxuXHRzZXRfcG9ydChkX3BvcnQpIHtcblx0XHR0aGlzLnBvcnQgPSBkX3BvcnQ7XG5cblx0XHRkX3BvcnQub24oJ21lc3NhZ2UnLCAoZF9tc2cpID0+IHtcblx0XHRcdC8vIGRlYnVnZ2VyO1xuXHRcdFx0bGV0IGhfbXNnID0gZF9tc2cuZGF0YTtcblxuXHRcdFx0Ly8gaGFuZGxlIG1lc3NhZ2Vcblx0XHRcdGxldCBzX2hhbmRsZSA9ICdoYW5kbGVfJytoX21zZy50eXBlO1xuXHRcdFx0aWYoc19oYW5kbGUgaW4gdGhpcykge1xuXHRcdFx0XHR0aGlzW3NfaGFuZGxlXShoX21zZyk7XG5cdFx0XHR9XG5cdFx0XHQvLyBtaXNzaW5nIGhhbmRsZSBuYW1lIGluIG1lc3NhZ2Vcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ2RlZGljYXRlZCB3b3JrZXIgcmVjZWl2ZWQgYSBtZXNzYWdlIGl0IGRvZXMgbm90IGtub3cgaG93IHRvIGhhbmRsZTogJytkX21zZyk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cdH1cbn07XG4iLCJjb25zdCB7XG5cdEhQX1dPUktFUl9OT1RJRklDQVRJT04sXG5cdERDX0NIQU5ORUwsXG59ID0gcmVxdWlyZSgnLi9sb2NhbHMuanMnKTtcblxuY29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKCcuL21hbmlmZXN0LmpzJyk7XG5cblxuY29uc3QgWE1fU1RSQVRFR1lfRVFVQUwgPSAxIDw8IDA7XG5cbmNvbnN0IFhNX1NUUkFURUdZX09SREVSRURfR1JPVVBTX0JBTEFOQ0VEID0gMSA8PCAyO1xuY29uc3QgWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQklBU0VEID0gMSA8PCAzO1xuXG5jb25zdCBYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQUyA9IFhNX1NUUkFURUdZX09SREVSRURfR1JPVVBTX0JBTEFOQ0VEIHwgWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQklBU0VEO1xuXG5jb25zdCBYTV9ESVNUUklCVVRJT05fQ09OU1RBTlQgPSAxIDw8IDA7XG5cblxuY2xhc3MgYXJtZWRfZ3JvdXAge1xuXHRjb25zdHJ1Y3RvcihrX2dyb3VwLCBhX3N1YnNldHMpIHtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdGdyb3VwOiBrX2dyb3VwLFxuXHRcdFx0c3Vic2V0czogYV9zdWJzZXRzLFxuXHRcdH0pO1xuXHR9XG5cblx0bWFwKHNfdGFzaywgel9hcmdzPVtdLCBoX2V2ZW50c19tYXA9e30sIHNfZGVidWc9bnVsbCkge1xuXHRcdGxldCB7XG5cdFx0XHRncm91cDoga19ncm91cCxcblx0XHRcdHN1YnNldHM6IGFfc3Vic2V0cyxcblx0XHR9ID0gdGhpcztcblxuXHRcdC8vIGhvdyBtYW55IHN1YnNldHMgdG8gcHJvY2Vzc1xuXHRcdGxldCBubF9zdWJzZXRzID0gYV9zdWJzZXRzLmxlbmd0aDtcblxuXHRcdC8vIHByZXBhcmUgdG8gZGVhbCB3aXRoIHJlc3VsdHNcblx0XHRsZXQga19hY3Rpb24gPSBuZXcgYWN0aXZlX2dyb3VwKGtfZ3JvdXAsIG5sX3N1YnNldHMpO1xuXG5cdFx0Ly8gY3JlYXRlIG1hbmlmZXN0IG9iamVjdFxuXHRcdGxldCBrX21hbmlmZXN0ID0gbWFuaWZlc3QuZnJvbSh6X2FyZ3MpO1xuXG5cdFx0Ly8gbm8gc3Vic2V0c1xuXHRcdGlmKCFubF9zdWJzZXRzKSB7XG5cdFx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0Ly8gcmVzdWx0IGhhbmRsZXIgd2FzIG5vdCB1c2VkOyBhdXRvLWVuZCBpdFxuXHRcdFx0XHRpZigha19hY3Rpb24ucGlwZWQpIGtfYWN0aW9uLmVuZCgpO1xuXG5cdFx0XHRcdC8vIGZvcmNlIGVuZCBzdHJlYW1cblx0XHRcdFx0a19hY3Rpb24uZm9yY2VfZW5kKCk7XG5cdFx0XHR9LCAwKTtcblx0XHR9XG5cdFx0Ly8geWVzIHN1YnNldHNcblx0XHRlbHNlIHtcblx0XHRcdC8vIHN1bW1vbiB3b3JrZXJzIGFzIHRoZXkgYmVjb21lIGF2YWlsYWJsZVxuXHRcdFx0a19ncm91cC5zdW1tb25fd29ya2VycyhubF9zdWJzZXRzLCAoa193b3JrZXIsIGlfc3Vic2V0KSA9PiB7XG5cdFx0XHRcdC8vIGlmKGhfZGlzcGF0Y2guZGVidWcpIGRlYnVnZ2VyO1xuXG5cdFx0XHRcdC8vIHJlc3VsdCBoYW5kbGVyIHdhcyBub3QgdXNlZDsgYXV0by1lbmQgaXRcblx0XHRcdFx0aWYoIWtfYWN0aW9uLnBpcGVkKSBrX2FjdGlvbi5lbmQoKTtcblxuXHRcdFx0XHQvLyBtYWtlIHJlc3VsdCBoYW5kbGVyXG5cdFx0XHRcdGxldCBma19yZXN1bHQgPSBrX2FjdGlvbi5ta19yZXN1bHQoa193b3JrZXIsIGlfc3Vic2V0KTtcblxuXHRcdFx0XHQvLyBtYWtlIHdvcmtlci1zcGVjaWZpYyBldmVudHNcblx0XHRcdFx0bGV0IGhfZXZlbnRzX3dvcmtlciA9IHRoaXMuZXZlbnRfcm91dGVyKGhfZXZlbnRzX21hcCwgaV9zdWJzZXQpO1xuXG5cdFx0XHRcdC8vIHB1c2ggc3Vic2V0IHRvIGZyb250IG9mIGFyZ3Ncblx0XHRcdFx0bGV0IGtfbWFuaWZlc3Rfd29ya2VyID0ga19tYW5pZmVzdC5wcmVwZW5kKGFfc3Vic2V0c1tpX3N1YnNldF0pO1xuXG5cdFx0XHRcdC8vIGV4ZWN1dGUgd29ya2VyIG9uIG5leHQgcGFydCBvZiBkYXRhXG5cdFx0XHRcdGtfd29ya2VyLmV4ZWMoe1xuXHRcdFx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHRcdFx0XHRtYW5pZmVzdDoga19tYW5pZmVzdF93b3JrZXIsXG5cdFx0XHRcdFx0aG9sZDoga19hY3Rpb24udXBzdHJlYW1faG9sZCxcblx0XHRcdFx0XHRldmVudHM6IGhfZXZlbnRzX3dvcmtlcixcblx0XHRcdFx0fSwgZmtfcmVzdWx0KTtcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdC8vIGxldCB1c2VyIGJpbmQgYSBoYW5kbGVyXG5cdFx0cmV0dXJuIGtfYWN0aW9uO1xuXHR9XG5cblx0ZXZlbnRfcm91dGVyKGhfZXZlbnRzLCBpX3N1YnNldCkge1xuXHRcdGlmKCFoX2V2ZW50cykgcmV0dXJuIG51bGw7XG5cblx0XHQvLyBtYWtlIGEgbmV3IGhhc2ggdGhhdCBwdXNoZXMgd29ya2VyIGluZGV4IGluIGZyb250IG9mIGNhbGxiYWNrIGFyZ3Ncblx0XHRsZXQgaF9ldmVudHNfbG9jYWwgPSB7fTtcblx0XHRmb3IobGV0IHNfZXZlbnQgaW4gaF9ldmVudHMpIHtcblx0XHRcdGxldCBmX2V2ZW50ID0gaF9ldmVudHNbc19ldmVudF07XG5cdFx0XHRoX2V2ZW50c19sb2NhbFtzX2V2ZW50XSA9ICguLi5hX2FyZ3MpID0+IHtcblx0XHRcdFx0Zl9ldmVudChpX3N1YnNldCwgLi4uYV9hcmdzKTtcblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGhfZXZlbnRzX2xvY2FsO1xuXHR9XG59XG5cblxuY2xhc3MgYWN0aXZlX2dyb3VwIHtcblx0Y29uc3RydWN0b3Ioa19ncm91cCwgbl90YXNrcywgZl9wdXNoPW51bGwpIHtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdGdyb3VwOiBrX2dyb3VwLFxuXHRcdFx0dGFza19jb3VudDogbl90YXNrcyxcblxuXHRcdFx0Ly8gd2hldGhlciBvciBub3QgdGhlIHVzZXIgaGFzIHJvdXRlZCB0aGlzIHN0cmVhbSB5ZXRcblx0XHRcdHBpcGVkOiBmYWxzZSxcblxuXHRcdFx0Ly8gbGluayB0byBuZXh0IGFjdGlvbiBkb3duc3RyZWFtXG5cdFx0XHRkb3duc3RyZWFtOiBudWxsLFxuXG5cdFx0XHQvLyB3aGV0aGVyIG9yIG5vdCB0aGUgYWN0aW9uIHVwc3RyZWFtIHNob3VsZCBob2xkIGRhdGEgaW4gd29ya2VyXG5cdFx0XHR1cHN0cmVhbV9ob2xkOiBmYWxzZSxcblxuXHRcdFx0cmVzdWx0X2NvdW50OiAwLFxuXG5cdFx0XHRyZXN1bHRfY2FsbGJhY2s6IG51bGwsXG5cdFx0XHRjb21wbGV0ZV9jYWxsYmFjazogbnVsbCxcblxuXHRcdFx0cHVzaDogZl9wdXNoIHx8ICgoKSA9PiB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihgY2Fubm90ICcucHVzaCgpJyBoZXJlYCk7XG5cdFx0XHR9KSxcblx0XHRcdGNhcnJ5OiBudWxsLFxuXG5cdFx0XHRyZWR1Y3Rpb25zOiBudWxsLFxuXHRcdFx0cmVkdWNlX3Rhc2s6IG51bGwsXG5cblx0XHRcdHJlc3VsdHM6IG51bGwsXG5cdFx0XHRzZXF1ZW5jZV9pbmRleDogMCxcblx0XHR9KTtcblx0fVxuXG5cdHRocnUoc190YXNrLCB6X2FyZ3M9W10sIGhfZXZlbnRzPW51bGwpIHtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdHBpcGVkOiB0cnVlLFxuXHRcdFx0cm91dGU6IHRoaXMucm91dGVfdGhydSxcblx0XHRcdHVwc3RyZWFtX2hvbGQ6IHRydWUsXG5cdFx0XHRuZXh0X3Rhc2s6IHtcblx0XHRcdFx0dGFzazogc190YXNrLFxuXHRcdFx0XHRtYW5pZmVzdDogbWFuaWZlc3QuZnJvbSh6X2FyZ3MpLFxuXHRcdFx0XHRldmVudHM6IGhfZXZlbnRzLFxuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdHJldHVybiB0aGlzLmNvbXBsZXRhYmxlKCk7XG5cdH1cblxuXHRlYWNoKGZrX3Jlc3VsdCwgZmtfY29tcGxldGU9bnVsbCkge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0cGlwZWQ6IHRydWUsXG5cdFx0XHRyb3V0ZTogdGhpcy5yb3V0ZV9lYWNoLFxuXHRcdFx0cmVzdWx0X2NhbGxiYWNrOiBma19yZXN1bHQsXG5cdFx0XHRjb21wbGV0ZV9jYWxsYmFjazogZmtfY29tcGxldGUsXG5cdFx0fSk7XG5cblx0XHRyZXR1cm4gdGhpcy5jb21wbGV0YWJsZSgpO1xuXHR9XG5cblx0c2VyaWVzKGZrX3Jlc3VsdCwgZmtfY29tcGxldGU9bnVsbCkge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0cGlwZWQ6IHRydWUsXG5cdFx0XHRyb3V0ZTogdGhpcy5yb3V0ZV9zZXJpZXMsXG5cdFx0XHRyZXN1bHRfY2FsbGJhY2s6IGZrX3Jlc3VsdCxcblx0XHRcdGNvbXBsZXRlX2NhbGxiYWNrOiBma19jb21wbGV0ZSxcblx0XHRcdHJlc3VsdHM6IG5ldyBBcnJheSh0aGlzLnRhc2tfY291bnQpLFxuXHRcdH0pO1xuXG5cdFx0cmV0dXJuIHRoaXMuY29tcGxldGFibGUoKTtcblx0fVxuXG5cdHJlZHVjZShzX3Rhc2ssIHpfYXJncz1bXSwgaF9ldmVudHM9bnVsbCwgc19kZWJ1Zz1udWxsKSB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChmX3Jlc29sdmUpID0+IHtcblx0XHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0XHRkZWJ1Zzogc19kZWJ1Zyxcblx0XHRcdFx0cGlwZWQ6IHRydWUsXG5cdFx0XHRcdHJvdXRlOiB0aGlzLnJvdXRlX3JlZHVjZSxcblx0XHRcdFx0Y29tcGxldGVfY2FsbGJhY2s6IGZfcmVzb2x2ZSxcblx0XHRcdFx0dXBzdHJlYW1faG9sZDogdGhpcy50YXNrX2NvdW50ID4gMSwgIC8vIHNldCBgaG9sZGAgZmxhZyBmb3IgdXBzdHJlYW0gc2VuZGluZyBpdHMgdGFza1xuXHRcdFx0XHRyZWR1Y3Rpb25zOiBuZXcgY29udmVyZ2VudF9wYWlyd2lzZV90cmVlKHRoaXMudGFza19jb3VudCksXG5cdFx0XHRcdHJlZHVjZV90YXNrOiB7XG5cdFx0XHRcdFx0dGFzazogc190YXNrLFxuXHRcdFx0XHRcdG1hbmlmZXN0OiBuZXcgbWFuaWZlc3Qoel9hcmdzKSxcblx0XHRcdFx0XHRldmVudHM6IGhfZXZlbnRzLFxuXHRcdFx0XHRcdGhvbGQ6IHRydWUsICAvLyBhc3N1bWUgYW5vdGhlciByZWR1Y3Rpb24gd2lsbCBiZSBwZXJmb3JtZWQgYnkgZGVmYXVsdFxuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH1cblxuXHQvLyByZXN1bHRzIG5vdCBoYW5kbGVkXG5cdHJvdXRlKCkge1xuXHRcdGNvbnNvbGUud2FybigncmVzdWx0IGZyb20gd29ya2VyIHdhcyBub3QgaGFuZGxlZCEgbWFrZSBzdXJlIHRvIGJpbmQgYSBoYW5kbGVyIGJlZm9yZSBnb2luZyBhc3luYy4gdXNlIGAuaWdub3JlKClgIGlmIHlvdSBkbyBub3QgY2FyZSBhYm91dCB0aGUgcmVzdWx0Jyk7XG5cdH1cblxuXHRyb3V0ZV90aHJ1KGhwX25vdGlmaWNhdGlvbiwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spIHtcblx0XHQvLyBjcmVhdGUgc3BlY2lmaWMgdGFzayBmb3Igd29ya2VyIHRvIHJlY2VpdmUgZGF0YSBmcm9tIGl0cyBwcmV2aW91cyB0YXNrXG5cdFx0bGV0IGhfdGFzayA9IE9iamVjdC5hc3NpZ24oe1xuXHRcdFx0cmVjZWl2ZTogaV90YXNrLFxuXHRcdFx0aG9sZDogdGhpcy5kb3duc3RyZWFtLnVwc3RyZWFtX2hvbGQsXG5cdFx0fSwgdGhpcy5uZXh0X3Rhc2spO1xuXG5cdFx0Ly8gYXNzaWduIHdvcmtlciBuZXcgdGFza1xuXHRcdHRoaXMuZ3JvdXAuYXNzaWduX3dvcmtlcihrX3dvcmtlciwgaF90YXNrLCAoLi4uYV9hcmdzKSA9PiB7XG5cdFx0XHQvLyBtayByZXN1bHRcblx0XHRcdGxldCBmX3Jlc3VsdCA9IHRoaXMuZG93bnN0cmVhbS5ta19yZXN1bHQoa193b3JrZXIsIGlfc3Vic2V0KTtcblxuXHRcdFx0Ly8gdHJpZ2dlciByZXN1bHRcblx0XHRcdGZfcmVzdWx0KC4uLmFfYXJncyk7XG5cdFx0fSk7XG5cdH1cblxuXHQvLyByZXR1cm4gcmVzdWx0cyBpbW1lZGlhdGVseVxuXHRyb3V0ZV9lYWNoKHpfcmVzdWx0LCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzaykge1xuXHRcdHRoaXMuaGFuZGxlX3Jlc3VsdF9jYWxsYmFjayh6X3Jlc3VsdCwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spO1xuXG5cdFx0Ly8gdGhpcyB3YXMgdGhlIGxhc3QgcmVzdWx0XG5cdFx0aWYoKyt0aGlzLnJlc3VsdF9jb3VudCA9PT0gdGhpcy50YXNrX2NvdW50ICYmICdmdW5jdGlvbicgPT09IHR5cGVvZiB0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKSB7XG5cdFx0XHR0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKCk7XG5cdFx0fVxuXHR9XG5cblx0cm91dGVfc2VyaWVzKHpfcmVzdWx0LCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzaykge1xuXHRcdGxldCB7XG5cdFx0XHR0YXNrX2NvdW50OiBuX3Rhc2tzLFxuXHRcdFx0cmVzdWx0X2NhbGxiYWNrOiBma19yZXN1bHQsXG5cdFx0XHRzZXF1ZW5jZV9pbmRleDogaV9zZXF1ZW5jZSxcblx0XHRcdHJlc3VsdHM6IGFfcmVzdWx0cyxcblx0XHR9ID0gdGhpcztcblxuXHRcdC8vIHJlc3VsdCBhcnJpdmVkIHdoaWxlIHdlIHdlcmUgd2FpdGluZyBmb3IgaXRcblx0XHRpZihpX3N1YnNldCA9PT0gaV9zZXF1ZW5jZSkge1xuXHRcdFx0Ly8gd2hpbGUgdGhlcmUgYXJlIHJlc3VsdHMgdG8gcHJvY2Vzc1xuXHRcdFx0Zm9yKDs7KSB7XG5cdFx0XHRcdC8vIHByb2Nlc3MgcmVzdWx0XG5cdFx0XHRcdHRoaXMuaGFuZGxlX3Jlc3VsdF9jYWxsYmFjayh6X3Jlc3VsdCwgaV9zZXF1ZW5jZSwga193b3JrZXIsIGlfdGFzayk7XG5cblx0XHRcdFx0Ly8gcmVhY2hlZCBlbmQgb2Ygc2VxdWVuY2U7IHRoYXQgd2FzIGxhc3QgcmVzdWx0XG5cdFx0XHRcdGlmKCsraV9zZXF1ZW5jZSA9PT0gbl90YXNrcykge1xuXHRcdFx0XHRcdC8vIGNvbXBsZXRpb24gY2FsbGJhY2tcblx0XHRcdFx0XHRpZignZnVuY3Rpb24nID09PSB0eXBlb2YgdGhpcy5jb21wbGV0ZV9jYWxsYmFjaykge1xuXHRcdFx0XHRcdFx0dGhpcy5jb21wbGV0ZV9jYWxsYmFjaygpO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdC8vIGV4aXQgbG9vcCBhbmQgc2F2ZSBzZXF1ZW5jZSBpbmRleFxuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gbmV4dCByZXN1bHQgbm90IHlldCByZWFkeVxuXHRcdFx0XHRsZXQgaF9uZXh0X3Jlc3VsdCA9IGFfcmVzdWx0c1tpX3NlcXVlbmNlXTtcblx0XHRcdFx0aWYoIWhfbmV4dF9yZXN1bHQpIGJyZWFrO1xuXG5cdFx0XHRcdC8vIGVsc2U7IG9udG8gbmV4dCByZXN1bHRcblx0XHRcdFx0el9yZXN1bHQ9IGhfbmV4dF9yZXN1bHQ7XG5cblx0XHRcdFx0Ly8gcmVsZWFzZSB0byBnY1xuXHRcdFx0XHRhX3Jlc3VsdHNbaV9zZXF1ZW5jZV0gPSBudWxsO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBub3QgeWV0IHJlYWR5IHRvIHByb2Nlc3MgdGhpcyByZXN1bHRcblx0XHRlbHNlIHtcblx0XHRcdC8vIHN0b3JlIGl0IGZvciBub3dcblx0XHRcdGFfcmVzdWx0c1tpX3N1YnNldF0gPSB6X3Jlc3VsdDtcblx0XHR9XG5cblx0XHQvLyB1cGRhdGUgc2VxdWVuY2UgaW5kZXhcblx0XHR0aGlzLnNlcXVlbmNlX2luZGV4ID0gaV9zZXF1ZW5jZTtcblx0fVxuXG5cdHJvdXRlX3JlZHVjZShocF9ub3RpZmljYXRpb24sIGlfc3Vic2V0LCBrX3dvcmtlciwgaV90YXNrKSB7XG5cdFx0Ly8gbm9kZSBpbml0aWF0aW9uXG5cdFx0bGV0IGhfY2Fub3B5X25vZGUgPSB0aGlzLnJlZHVjdGlvbnMucmF5KGlfc3Vic2V0LCB7XG5cdFx0XHR3b3JrZXI6IGtfd29ya2VyLFxuXHRcdFx0dGFza19pZDogaV90YXNrLFxuXHRcdH0pO1xuXG5cdFx0Ly8gc3RhcnQgYXQgY2Fub3B5IG5vZGVcblx0XHR0aGlzLnJlZHVjZV9yZXN1bHQoaHBfbm90aWZpY2F0aW9uLCBoX2Nhbm9weV9ub2RlKTtcblx0fVxuXG5cdC8vIGVhY2ggdGltZSBhIHdvcmtlciBjb21wbGV0ZXNcblx0cmVkdWNlX3Jlc3VsdCh6X3Jlc3VsdCwgaF9ub2RlKSB7XG5cdFx0bGV0IHtcblx0XHRcdGdyb3VwOiBrX2dyb3VwLFxuXHRcdFx0cmVkdWN0aW9uczoga19wYWlyd2lzZV90cmVlLFxuXHRcdFx0cmVkdWNlX3Rhc2s6IGhfdGFza19yZWFkeSxcblx0XHR9ID0gdGhpcztcblxuXHRcdC8vIGZpbmFsIHJlc3VsdFxuXHRcdGlmKEhQX1dPUktFUl9OT1RJRklDQVRJT04gIT09IHpfcmVzdWx0KSB7XG5cdFx0XHRsZXQgel9jb21wbGV0aW9uID0gdGhpcy5jb21wbGV0ZV9jYWxsYmFjayh6X3Jlc3VsdCk7XG5cblx0XHRcdC8vIGFkZCB0byBvdXRlciBzdHJlYW1cblx0XHRcdGlmKHpfY29tcGxldGlvbiBpbnN0YW5jZW9mIGFjdGl2ZV9ncm91cCkge1xuXHRcdFx0XHRsZXQga19sYWtlID0gdGhpcy5sYWtlKCk7XG5cdFx0XHRcdGxldCBma19sYWtlID0ga19sYWtlLmNvbXBsZXRlX2NhbGxiYWNrO1xuXHRcdFx0XHRsZXQgaHBfbG9jayA9IFN5bWJvbCgna2V5Jyk7XG5cblx0XHRcdFx0el9jb21wbGV0aW9uLmVuZCgoKSA9PiB7XG5cdFx0XHRcdFx0a19ncm91cC51bmxvY2soaHBfbG9jayk7XG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdC8vIHJld3JhcCBjb21wbGV0aW9uIGNhbGxiYWNrIGZ1bmN0aW9uXG5cdFx0XHRcdGtfbGFrZS5jb21wbGV0ZV9jYWxsYmFjayA9ICgpID0+IHtcblx0XHRcdFx0XHRrX2dyb3VwLndhaXQoaHBfbG9jaywgKCkgPT4ge1xuXHRcdFx0XHRcdFx0ZmtfbGFrZSgpO1xuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBub3RpZmljYXRpb25cblx0XHRlbHNlIHtcblx0XHRcdGlmKHRoaXMuZGVidWcpIHtcblx0XHRcdFx0Y29uc29sZS53YXJuKCdcXHQgPT0gY29tbWl0dGVkICcraF9ub2RlLmxlZnQrJyA8Lz4gJytoX25vZGUucmlnaHQpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhYmxlIHRvIHBlcmZvcm0gYSByZWR1Y3Rpb25cblx0XHRcdGxldCBoX21lcmdlID0ga19wYWlyd2lzZV90cmVlLmNvbW1pdChoX25vZGUpO1xuXHRcdFx0Ly8ga19wYWlyd2lzZV90cmVlLnByaW50KCk7XG5cdFx0XHRpZihoX21lcmdlKSB7XG5cdFx0XHRcdGlmKHRoaXMuZGVidWcpIHtcblx0XHRcdFx0XHRjb25zb2xlLndhcm4oJ21lcmdlZCAnK2hfbWVyZ2Uubm9kZS5sZWZ0KycgPC0+ICcraF9tZXJnZS5ub2RlLnJpZ2h0KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRsZXQga193b3JrZXIgPSBoX25vZGUuaXRlbS53b3JrZXI7XG5cblx0XHRcdFx0Ly8gdGhpcyByZWR1Y3Rpb24gd2lsbCBiZSB0aGUgbGFzdCBvbmU7IGRvIG5vdCBob2xkIHJlc3VsdFxuXHRcdFx0XHRpZihoX21lcmdlLm1ha2VzX3Jvb3QpIHtcblx0XHRcdFx0XHRoX3Rhc2tfcmVhZHkgPSBPYmplY3QuYXNzaWduKHt9LCBoX3Rhc2tfcmVhZHkpO1xuXHRcdFx0XHRcdGhfdGFza19yZWFkeS5ob2xkID0gZmFsc2U7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBhZnRlciByZWR1Y3Rpb247XG5cdFx0XHRcdGxldCBma19yZWR1Y3Rpb24gPSAoel9yZXN1bHRfcmVkdWN0aW9uLCBpX3Rhc2tfcmVkdWN0aW9uLCBrX3dvcmtlcl9yZWR1Y3Rpb24pID0+IHtcblx0XHRcdFx0XHQvLyBpZih0aGlzLmRlYnVnKSBkZWJ1Z2dlcjtcblxuXHRcdFx0XHRcdC8vIHJlY3Vyc2Ugb24gcmVkdWN0aW9uOyB1cGRhdGUgc2VuZGVyIGZvciBjYWxsYmFjayBzY29wZVxuXHRcdFx0XHRcdHRoaXMucmVkdWNlX3Jlc3VsdCh6X3Jlc3VsdF9yZWR1Y3Rpb24sIE9iamVjdC5hc3NpZ24oaF9tZXJnZS5ub2RlLCB7XG5cdFx0XHRcdFx0XHRpdGVtOiB7XG5cdFx0XHRcdFx0XHRcdHdvcmtlcjoga193b3JrZXJfcmVkdWN0aW9uLFxuXHRcdFx0XHRcdFx0XHR0YXNrX2lkOiBpX3Rhc2tfcmVkdWN0aW9uLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHR9KSk7XG5cdFx0XHRcdH07XG5cblx0XHRcdFx0Ly8gZ2l2ZSByZWR1Y3Rpb24gdGFzayB0byB3b3JrZXIgdGhhdCBmaW5pc2hlZCBlYXJsaWVyOyBwYXNzIHRvIHRoZSByaWdodFxuXHRcdFx0XHRpZihrX3dvcmtlciA9PT0gaF9tZXJnZS5sZWZ0Lndvcmtlcikge1xuXHRcdFx0XHRcdGtfZ3JvdXAucmVsYXkoe1xuXHRcdFx0XHRcdFx0ZGVidWc6IHRoaXMuZGVidWcsXG5cdFx0XHRcdFx0XHRzZW5kZXI6IGhfbm9kZS5pdGVtLFxuXHRcdFx0XHRcdFx0cmVjZWl2ZXI6IGhfbWVyZ2UucmlnaHQsXG5cdFx0XHRcdFx0XHRyZWNlaXZlcl9wcmltYXJ5OiBmYWxzZSxcblx0XHRcdFx0XHRcdHRhc2tfcmVhZHk6IGhfdGFza19yZWFkeSxcblx0XHRcdFx0XHR9LCBma19yZWR1Y3Rpb24pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIHBhc3MgdG8gdGhlIGxlZnRcblx0XHRcdFx0ZWxzZSB7XG5cdFx0XHRcdFx0a19ncm91cC5yZWxheSh7XG5cdFx0XHRcdFx0XHRkZWJ1ZzogdGhpcy5kZWJ1Zyxcblx0XHRcdFx0XHRcdHNlbmRlcjogaF9ub2RlLml0ZW0sXG5cdFx0XHRcdFx0XHRyZWNlaXZlcjogaF9tZXJnZS5sZWZ0LFxuXHRcdFx0XHRcdFx0cmVjZWl2ZXJfcHJpbWFyeTogdHJ1ZSxcblx0XHRcdFx0XHRcdHRhc2tfcmVhZHk6IGhfdGFza19yZWFkeSxcblx0XHRcdFx0XHR9LCBma19yZWR1Y3Rpb24pO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0Zm9yY2VfZW5kKCkge1xuXHRcdGlmKCdmdW5jdGlvbicgPT09IHR5cGVvZiB0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKSB7XG5cdFx0XHR0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKCk7XG5cdFx0fVxuXG5cdFx0aWYodGhpcy5kb3duc3RyZWFtKSB7XG5cdFx0XHR0aGlzLmRvd25zdHJlYW0uZm9yY2VfZW5kKCk7XG5cdFx0fVxuXHR9XG5cblx0cm91dGVfZW5kKCkge1xuXHRcdC8vIHRoaXMgd2FzIHRoZSBsYXN0IHJlc3VsdFxuXHRcdGlmKCsrdGhpcy5yZXN1bHRfY291bnQgPT09IHRoaXMudGFza19jb3VudCAmJiAnZnVuY3Rpb24nID09PSB0eXBlb2YgdGhpcy5jb21wbGV0ZV9jYWxsYmFjaykge1xuXHRcdFx0dGhpcy5jb21wbGV0ZV9jYWxsYmFjaygpO1xuXHRcdH1cblx0fVxuXG5cdGNvbXBsZXRhYmxlKCkge1xuXHRcdGxldCBma19jb21wbGV0ZSA9IHRoaXMuY29tcGxldGVfY2FsbGJhY2s7XG5cblx0XHQvLyBub3RoaW5nIHRvIHJlZHVjZTsgY29tcGxldGUgYWZ0ZXIgZXN0YWJsaXNoaW5nIGRvd25zdHJlYW1cblx0XHRpZighdGhpcy50YXNrX2NvdW50ICYmICdmdW5jdGlvbicgPT09IHR5cGVvZiBma19jb21wbGV0ZSkge1xuXHRcdFx0c2V0VGltZW91dChma19jb21wbGV0ZSwgMCk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHRoaXMuZG93bnN0cmVhbSA9IG5ldyBhY3RpdmVfZ3JvdXAodGhpcy5ncm91cCwgdGhpcy50YXNrX2NvdW50LCB0aGlzLnB1c2gpO1xuXHR9XG5cblx0aGFuZGxlX3Jlc3VsdF9jYWxsYmFjayh6X3Jlc3VsdCwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spIHtcblx0XHRsZXQga19kb3duc3RyZWFtID0gdGhpcy5kb3duc3RyZWFtO1xuXG5cdFx0Ly8gYXBwbHkgY2FsbGJhY2sgYW5kIGNhcHR1cmUgcmV0dXJuXG5cdFx0bGV0IHpfcmV0dXJuID0gdGhpcy5yZXN1bHRfY2FsbGJhY2soel9yZXN1bHQsIGlfc3Vic2V0KTtcblxuXHRcdC8vIGRvd25zdHJlYW0gaXMgZXhwZWN0aW5nIGRhdGEgZm9yIG5leHQgdGFza1xuXHRcdGlmKGtfZG93bnN0cmVhbSAmJiBrX2Rvd25zdHJlYW0ucGlwZWQpIHtcblx0XHRcdC8vIG5vdGhpbmcgd2FzIHJldHVybmVkOyByZXVzZSBpbnB1dCBkYXRhXG5cdFx0XHRpZih1bmRlZmluZWQgPT09IHpfcmV0dXJuKSB7XG5cdFx0XHRcdC8vIGRvd25zdHJlYW0gYWN0aW9uIHdhcyBleHBlY3Rpbmcgd29ya2VyIHRvIGhvbGQgZGF0YVxuXHRcdFx0XHRpZihrX2Rvd25zdHJlYW0udXBzdHJlYW1faG9sZCkge1xuXHRcdFx0XHRcdHRocm93ICdub3QgeWV0IGltcGxlbWVudGVkJztcblx0XHRcdFx0fVxuXHRcdFx0XHRlbHNlIHtcblx0XHRcdFx0XHRrX2Rvd25zdHJlYW0ucm91dGUoel9yZXN1bHQsIGlfc3Vic2V0LCBrX3dvcmtlciwgaV90YXNrKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0Ly8gcmV0dXJuZWQgcHJvbWlzZVxuXHRcdFx0ZWxzZSBpZih6X3JldHVybiBpbnN0YW5jZW9mIFByb21pc2UpIHtcblx0XHRcdFx0el9yZXR1cm5cblx0XHRcdFx0XHQvLyBhd2FpdCBwcm9taXNlIHJlc29sdmVcblx0XHRcdFx0XHQudGhlbigoel9jYXJyeSkgPT4ge1xuXHRcdFx0XHRcdFx0a19kb3duc3RyZWFtLnJvdXRlKHpfY2FycnksIGlfc3Vic2V0LCBrX3dvcmtlciwgaV90YXNrKTtcblx0XHRcdFx0XHR9KVxuXHRcdFx0XHRcdC8vIGNhdGNoIHByb21pc2UgcmVqZWN0XG5cdFx0XHRcdFx0LmNhdGNoKChlX3JlamVjdCkgPT4ge1xuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCd1bmNhdWdodCByZWplY3Rpb24nKTtcblx0XHRcdFx0XHR9KTtcblx0XHRcdH1cblx0XHRcdC8vIHJldHVybmVkIGVycm9yXG5cdFx0XHRlbHNlIGlmKHpfcmV0dXJuIGluc3RhbmNlb2YgRXJyb3IpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdub3QgeWV0IGltcGxlbWVudGVkJyk7XG5cdFx0XHR9XG5cdFx0XHQvLyByZXR1cm5lZCBpbW1lZGlhdGVseVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdGtfZG93bnN0cmVhbS5yb3V0ZSh6X3JldHVybiwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBzb21ldGhpbmcgd2FzIHJldHVybmVkIHRob3VnaFxuXHRcdGVsc2UgaWYodW5kZWZpbmVkICE9PSB6X3JldHVybikge1xuXHRcdFx0Y29uc29sZS53YXJuKCdhIHRhc2sgc3RyZWFtIGhhbmRsZXIgcmV0dXJuIHNvbWUgdmFsdWUgYnV0IGl0IGNhbm5vdCBiZSBjYXJyaWVkIGJlY2F1c2UgZG93bnN0cmVhbSBpcyBub3QgZXhwZWN0aW5nIHRhc2sgZGF0YScpO1xuXHRcdFx0ZGVidWdnZXI7XG5cdFx0fVxuXHR9XG5cblx0ZW5kKGZrX2NvbXBsZXRlPW51bGwpIHtcblx0XHQvLyBuZXcgcHJvbWlzZVxuXHRcdHJldHVybiBuZXcgUHJvbWlzZSgoZmtfZW5kKSA9PiB7XG5cdFx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdFx0cGlwZWQ6IHRydWUsXG5cdFx0XHRcdHJvdXRlOiB0aGlzLnJvdXRlX2VuZCxcblx0XHRcdFx0Y29tcGxldGVfY2FsbGJhY2s6IGFzeW5jICgpID0+IHtcblx0XHRcdFx0XHQvLyBhd2FpdCBjb21wbGV0ZSBjYWxsYmFja1xuXHRcdFx0XHRcdGlmKGZrX2NvbXBsZXRlKSBhd2FpdCBma19jb21wbGV0ZSgpO1xuXG5cdFx0XHRcdFx0Ly8gbm93IHJlc29sdmVcblx0XHRcdFx0XHRma19lbmQoKTtcblx0XHRcdFx0fSxcblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9XG5cblxuXHRta19yZXN1bHQoa193b3JrZXIsIGlfc3Vic2V0KSB7XG5cdFx0Ly8gZm9yIHdoZW4gYSByZXN1bHQgYXJyaXZlc1xuXHRcdHJldHVybiAoel9yZXN1bHQsIGlfdGFzaykgPT4ge1xuXHRcdFx0Ly8gdGhpcyB3b3JrZXIganVzdCBtYWRlIGl0c2VsZiBhdmFpbGFibGVcblx0XHRcdHRoaXMuZ3JvdXAud29ya2VyX2F2YWlsYWJsZShrX3dvcmtlcik7XG5cblx0XHRcdC8vIHJvdXRlIHRoZSByZXN1bHRcblx0XHRcdHRoaXMucm91dGUoel9yZXN1bHQsIGlfc3Vic2V0LCBrX3dvcmtlciwgaV90YXNrKTtcblx0XHR9O1xuXHR9XG5cblx0Ly8gdHJhdmVyc2UgYWxsIHRoZSB3YXkgZG93bnN0cmVhbVxuXHRsYWtlKCkge1xuXHRcdGxldCBrX2Rvd25zdHJlYW0gPSB0aGlzO1xuXHRcdGZvcig7Oykge1xuXHRcdFx0aWYoa19kb3duc3RyZWFtLmRvd25zdHJlYW0pIGtfZG93bnN0cmVhbSA9IGtfZG93bnN0cmVhbS5kb3duc3RyZWFtO1xuXHRcdFx0ZWxzZSBicmVhaztcblx0XHR9XG5cdFx0cmV0dXJuIGtfZG93bnN0cmVhbTtcblx0fVxufVxuXG5cbmZ1bmN0aW9uIGRpdmlkZShhX3RoaW5ncywgbl93b3JrZXJzLCB4bV9zdHJhdGVneSwgaF9kaXZpZGU9e30pIHtcblx0bGV0IG5sX3RoaW5ncyA9IGFfdGhpbmdzLmxlbmd0aDtcblxuXHRsZXQge1xuXHRcdGl0ZW1fY291bnQ6IGNfaXRlbXNfcmVtYWluPW5sX3RoaW5ncyxcblx0XHRvcGVuOiBmX29wZW49bnVsbCxcblx0XHRzZWFsOiBmX3NlYWw9bnVsbCxcblx0XHRxdWFudGlmeTogZl9xdWFudGlmeT0oKSA9PiB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYG11c3QgcHJvdmlkZSBmdW5jdGlvbiBmb3Iga2V5ICdxdWFudGlmeScgd2hlbiB1c2luZyAnLmJhbGFuY2Vfb3JkZXJlZF9ncm91cHMoKSdgKTtcblx0XHR9LFxuXHR9ID0gaF9kaXZpZGU7XG5cblx0bGV0IGFfdGFza3MgPSBbXTtcblxuXHRpZihBcnJheS5pc0FycmF5KGFfdGhpbmdzKSkge1xuXHRcdC8vIGRvIG5vdCBhc3NpZ24gd29ya2VycyB0byBub3RoaW5nXG5cdFx0aWYobmxfdGhpbmdzIDwgbl93b3JrZXJzKSBuX3dvcmtlcnMgPSBubF90aGluZ3M7XG5cblx0XHQvLyBpdGVtcyBwZXIgd29ya2VyXG5cdFx0bGV0IHhfaXRlbXNfcGVyX3dvcmtlciA9IE1hdGguZmxvb3IoY19pdGVtc19yZW1haW4gLyBuX3dvcmtlcnMpO1xuXG5cdFx0Ly8gZGlzdHJpYnV0ZSBpdGVtcyBlcXVhbGx5XG5cdFx0aWYoWE1fU1RSQVRFR1lfRVFVQUwgPT09IHhtX3N0cmF0ZWd5KSB7XG5cdFx0XHQvLyBzdGFydCBpbmRleCBvZiBzbGljZVxuXHRcdFx0bGV0IGlfc3RhcnQgPSAwO1xuXG5cdFx0XHQvLyBlYWNoIHdvcmtlclxuXHRcdFx0Zm9yKGxldCBpX3dvcmtlcj0wOyBpX3dvcmtlcjxuX3dvcmtlcnM7IGlfd29ya2VyKyspIHtcblx0XHRcdFx0Ly8gZmluZCBlbmQgaW5kZXggb2Ygd29ya2VyOyBlbnN1cmUgYWxsIGl0ZW1zIGZpbmQgYSB3b3JrZXJcblx0XHRcdFx0bGV0IGlfZW5kID0gKGlfd29ya2VyPT09bl93b3JrZXJzLTEpPyBubF90aGluZ3M6IGlfc3RhcnQreF9pdGVtc19wZXJfd29ya2VyO1xuXG5cdFx0XHRcdC8vIGV4dHJhY3Qgc2xpY2UgZnJvbSB0aGluZ3MgYW5kIHB1c2ggdG8gZGl2aXNpb25zXG5cdFx0XHRcdGFfdGFza3MucHVzaChhX3RoaW5ncy5zbGljZShpX3N0YXJ0LCBpX2VuZCkpO1xuXG5cdFx0XHRcdC8vIGFkdmFuY2UgaW5kZXggZm9yIG5leHQgZGl2aXNpb25cblx0XHRcdFx0aV9zdGFydCA9IGlfZW5kO1xuXG5cdFx0XHRcdC8vIHVwZGF0ZSBudW1iZXIgb2YgaXRlbXMgcmVtYWluaW5nXG5cdFx0XHRcdGNfaXRlbXNfcmVtYWluIC09IHhfaXRlbXNfcGVyX3dvcmtlcjtcblxuXHRcdFx0XHQvLyByZWNhbGN1bGF0ZSB0YXJnZXQgaXRlbXMgcGVyIHdvcmtlclxuXHRcdFx0XHR4X2l0ZW1zX3Blcl93b3JrZXIgPSBNYXRoLmZsb29yKGNfaXRlbXNfcmVtYWluIC8gKG5fd29ya2VycyAtIGlfd29ya2VyIC0gMSkpO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBvcmRlcmVkIGdyb3Vwc1xuXHRcdGVsc2UgaWYoWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFMgJiB4bV9zdHJhdGVneSkge1xuXHRcdFx0bGV0IGlfd29ya2VyID0gMDtcblx0XHRcdGxldCBjX3dvcmtlcl9pdGVtcyA9IDA7XG5cblx0XHRcdC8vIG9wZW4gbmV3IHRhc2sgaXRlbSBsaXN0XG5cdFx0XHRsZXQgYV90YXNrX2l0ZW1zID0gW107XG5cdFx0XHRsZXQgel90YXNrX2RhdGEgPSBmX29wZW4/IGZfb3BlbihhX3Rhc2tfaXRlbXMpOiBhX3Rhc2tfaXRlbXM7XG5cblx0XHRcdC8vIGVhY2ggZ3JvdXBcblx0XHRcdGZvcihsZXQgaV9ncm91cD0wOyBpX2dyb3VwPG5sX3RoaW5nczsgaV9ncm91cCsrKSB7XG5cdFx0XHRcdGxldCBoX2dyb3VwID0gYV90aGluZ3NbaV9ncm91cF07XG5cdFx0XHRcdGxldCBuX2dyb3VwX2l0ZW1zID0gZl9xdWFudGlmeShoX2dyb3VwKTtcblxuXHRcdFx0XHQvLyBhZGRpbmcgdGhpcyB0byBjdXJyZW50IHdvcmtlciB3b3VsZCBleGNlZWQgdGFyZ2V0IGxvYWQgKG1ha2Ugc3VyZSB0aGlzIGlzbid0IGZpbmFsIHdvcmtlcilcblx0XHRcdFx0bGV0IG5fd29ya2VyX2l0ZW1zX3ByZXZpZXcgPSBuX2dyb3VwX2l0ZW1zICsgY193b3JrZXJfaXRlbXM7XG5cdFx0XHRcdGlmKChuX3dvcmtlcl9pdGVtc19wcmV2aWV3ID4geF9pdGVtc19wZXJfd29ya2VyKSAmJiBpX3dvcmtlciA8IG5fd29ya2Vycy0xKSB7XG5cdFx0XHRcdFx0bGV0IGJfYWR2YW5jZV9ncm91cCA9IGZhbHNlO1xuXG5cdFx0XHRcdFx0Ly8gYmFsYW5jZSBtb2RlXG5cdFx0XHRcdFx0aWYoWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQkFMQU5DRUQgPT09IHhtX3N0cmF0ZWd5KSB7XG5cdFx0XHRcdFx0XHQvLyBwcmV2aWV3IGlzIGNsb3NlciB0byB0YXJnZXQ7IGFkZCB0YXNrIGl0ZW0gdG8gd29ya2VyIGJlZm9yZSBhZHZhbmNpbmdcblx0XHRcdFx0XHRcdGlmKChuX3dvcmtlcl9pdGVtc19wcmV2aWV3IC0geF9pdGVtc19wZXJfd29ya2VyKSA8ICh4X2l0ZW1zX3Blcl93b3JrZXIgLSBjX3dvcmtlcl9pdGVtcykpIHtcblx0XHRcdFx0XHRcdFx0YV90YXNrX2l0ZW1zLnB1c2goaF9ncm91cCk7XG5cdFx0XHRcdFx0XHRcdGNfd29ya2VyX2l0ZW1zID0gbl93b3JrZXJfaXRlbXNfcHJldmlldztcblxuXHRcdFx0XHRcdFx0XHQvLyBhZHZhbmNlIGdyb3VwIGFmdGVyIG5ldyB0YXNrXG5cdFx0XHRcdFx0XHRcdGJfYWR2YW5jZV9ncm91cCA9IHRydWU7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gYWRkIHRhc2sgaXRlbSB0byBvdXRwdXQgKHRyYW5zZm9ybWluZyBpdCB3aGVuIGFwcHJvcHJpYXRlKVxuXHRcdFx0XHRcdGFfdGFza3MucHVzaChmX3NlYWw/IGZfc2VhbCh6X3Rhc2tfZGF0YSk6IHpfdGFza19kYXRhKTtcblxuXHRcdFx0XHRcdC8vIG5leHQgdGFzayBpdGVtIGxpc3Rcblx0XHRcdFx0XHRhX3Rhc2tfaXRlbXMgPSBbXTtcblx0XHRcdFx0XHRjX2l0ZW1zX3JlbWFpbiAtPSBjX3dvcmtlcl9pdGVtcztcblx0XHRcdFx0XHR4X2l0ZW1zX3Blcl93b3JrZXIgPSBjX2l0ZW1zX3JlbWFpbiAvIChuX3dvcmtlcnMgLSAoKytpX3dvcmtlcikpO1xuXHRcdFx0XHRcdGNfd29ya2VyX2l0ZW1zID0gMDtcblxuXHRcdFx0XHRcdC8vIHRhc2sgaXRlbSBvcGVuXG5cdFx0XHRcdFx0el90YXNrX2RhdGEgPSBmX29wZW4/IGZfb3BlbihhX3Rhc2tfaXRlbXMpOiBhX3Rhc2tfaXRlbXM7XG5cblx0XHRcdFx0XHQvLyBhZHZhbmNlIGdyb3VwXG5cdFx0XHRcdFx0aWYoYl9hZHZhbmNlX2dyb3VwKSBjb250aW51ZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIGFkZCB0YXNrIHRvIGxpc3Rcblx0XHRcdFx0YV90YXNrX2l0ZW1zLnB1c2goaF9ncm91cCk7XG5cdFx0XHRcdGNfd29ya2VyX2l0ZW1zICs9IG5fZ3JvdXBfaXRlbXM7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFkZCBmaW5hbCB0YXNrIGl0ZW1cblx0XHRcdGFfdGFza3MucHVzaChmX3NlYWw/IGZfc2VhbCh6X3Rhc2tfZGF0YSk6IHpfdGFza19kYXRhKTtcblx0XHR9XG5cdFx0Ly8gdW5rbm93biBzdHJhdGVneVxuXHRcdGVsc2Uge1xuXHRcdFx0dGhyb3cgbmV3IFJhbmdlRXJyb3IoJ25vIHN1Y2ggc3RyYXRlZ3knKTtcblx0XHR9XG5cdH1cblx0Ly8gdHlwZWQgYXJyYXlcblx0ZWxzZSBpZignYnl0ZUxlbmd0aCcgaW4gYV90aGluZ3MpIHtcblx0XHQvLyBkaXZpZGUgXG5cdFx0dGhyb3cgJ25vdCB5ZXQgaW1wbGVtZW50ZWQnO1xuXHR9XG5cdC8vIHVuc3VwcG9ydGVkIHR5cGVcblx0ZWxzZSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKCd3b3JrZXIgY2FuIG9ubHkgZGl2aWRlIGRhdGEgaW4gYXJyYXlzIChlaXRoZXIgcGxhaW4gb3IgdHlwZWQpJyk7XG5cdH1cblxuXHRyZXR1cm4gYV90YXNrcztcbn1cblxuXG5jbGFzcyBjb252ZXJnZW50X3BhaXJ3aXNlX3RyZWUge1xuXHRjb25zdHJ1Y3RvcihuX2l0ZW1zKSB7XG5cdFx0bGV0IGFfY2Fub3B5ID0gW107XG5cdFx0Zm9yKGxldCBpX2l0ZW09MDsgaV9pdGVtPG5faXRlbXM7IGlfaXRlbSsrKSB7XG5cdFx0XHRhX2Nhbm9weS5wdXNoKHtcblx0XHRcdFx0cmVhZHk6IGZhbHNlLFxuXHRcdFx0XHR1cDogbnVsbCxcblx0XHRcdFx0aXRlbTogbnVsbCxcblx0XHRcdFx0bGVmdDogaV9pdGVtIC0gMSxcblx0XHRcdFx0cmlnaHQ6IGlfaXRlbSArIDEsXG5cdFx0XHR9KTtcblx0XHR9XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdGl0ZW1fY291bnQ6IG5faXRlbXMsXG5cdFx0XHRjYW5vcHk6IGFfY2Fub3B5LFxuXHRcdFx0c3RlcHM6IDAsXG5cdFx0fSk7XG5cdH1cblxuXHRyYXkoaV9pdGVtLCB6X2l0ZW0pIHtcblx0XHRsZXQgaF9ub2RlID0gdGhpcy5jYW5vcHlbaV9pdGVtXTtcblx0XHRoX25vZGUuaXRlbSA9IHpfaXRlbTtcblx0XHRyZXR1cm4gaF9ub2RlO1xuXHR9XG5cblx0dG9wKGhfdG9wKSB7XG5cdFx0Zm9yKDs7KSB7XG5cdFx0XHRsZXQgaF91cCA9IGhfdG9wLnVwO1xuXHRcdFx0aWYoaF91cCkgaF90b3AgPSBoX3VwO1xuXHRcdFx0ZWxzZSBicmVhaztcblx0XHR9XG5cdFx0cmV0dXJuIGhfdG9wO1xuXHR9XG5cblx0bWVyZ2UoaF9sZWZ0LCBoX3JpZ2h0KSB7XG5cdFx0bGV0IG5faXRlbXMgPSB0aGlzLml0ZW1fY291bnQ7XG5cblx0XHRsZXQgaF9ub2RlID0ge1xuXHRcdFx0cmVhZHk6IGZhbHNlLFxuXHRcdFx0dXA6IG51bGwsXG5cdFx0XHRpdGVtOiBudWxsLFxuXHRcdFx0bGVmdDogaF9sZWZ0LmxlZnQsXG5cdFx0XHRyaWdodDogaF9yaWdodC5yaWdodCxcblx0XHR9O1xuXG5cdFx0aF9sZWZ0LnVwID0gaF9yaWdodC51cCA9IGhfbm9kZTtcblxuXHRcdHJldHVybiB7XG5cdFx0XHRub2RlOiBoX25vZGUsXG5cdFx0XHRsZWZ0OiBoX2xlZnQuaXRlbSxcblx0XHRcdHJpZ2h0OiBoX3JpZ2h0Lml0ZW0sXG5cdFx0XHRtYWtlc19yb290OiAtMSA9PT0gaF9sZWZ0LmxlZnQgJiYgbl9pdGVtcyA9PT0gaF9yaWdodC5yaWdodCxcblx0XHR9O1xuXHR9XG5cblx0cHJpbnQoKSB7XG5cdFx0bGV0IGFfbGluZXMgPSBuZXcgQXJyYXkodGhpcy5jYW5vcHkubGVuZ3RoKTtcblxuXHRcdGRlYnVnZ2VyO1xuXHRcdHRoaXMuY2Fub3B5LmZvckVhY2goKGhfbm9kZSwgaV9ub2RlKSA9PiB7XG5cdFx0XHRhX2xpbmVzW2lfbm9kZV0gPSBgWyR7aV9ub2RlfV0gJHtoX25vZGUucmVhZHk/ICctJy5yZXBlYXQoaF9ub2RlLnN0ZXBzKSsnTyc6ICctJy5yZXBlYXQodGhpcy5zdGVwcyl9YDtcblx0XHR9KTtcblx0fVxuXG5cdGNvbW1pdChoX25vZGUpIHtcblx0XHRsZXQgbl9pdGVtcyA9IHRoaXMuaXRlbV9jb3VudDtcblx0XHRsZXQgYV9jYW5vcHkgPSB0aGlzLmNhbm9weTtcblx0XHR0aGlzLnN0ZXBzICs9IDE7XG5cblx0XHQvLyBsZWZ0IGVkZ2Ugb2YgbGlzdFxuXHRcdGlmKC0xID09PSBoX25vZGUubGVmdCkge1xuXHRcdFx0Ly8gdHJlZSByb290IHdhcyBoYW5kZWQgdG8gY29tbWl0XG5cdFx0XHRpZihoX25vZGUucmlnaHQgPT09IG5faXRlbXMpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdjYW5ub3QgY29tbWl0IHJvb3QhJyk7XG5cdFx0XHR9XG5cblx0XHRcdC8vIG5laWdoYm9yIG9uIHJpZ2h0IHNpZGVcblx0XHRcdGxldCBoX3JpZ2h0ID0gdGhpcy50b3AoYV9jYW5vcHlbaF9ub2RlLnJpZ2h0XSk7XG5cblx0XHRcdC8vIG5laWdoYm9yIGlzIHJlYWR5IVxuXHRcdFx0aWYoaF9yaWdodC5yZWFkeSkge1xuXHRcdFx0XHRyZXR1cm4gdGhpcy5tZXJnZShoX25vZGUsIGhfcmlnaHQpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgYnVzeS9ub3QgcmVhZHk7IG1hcmsgdGhpcyBpdGVtIGFzIHJlYWR5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0aF9ub2RlLnJlYWR5ID0gdHJ1ZTtcblx0XHRcdFx0aF9ub2RlLnN0ZXBzID0gdGhpcy5zdGVwcztcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gcmlnaHQgZWRnZSBvZiBsaXN0XG5cdFx0ZWxzZSBpZihuX2l0ZW1zID09PSBoX25vZGUucmlnaHQpIHtcblx0XHRcdC8vIG5laWdoYm9yIG9uIGxlZnQgc2lkZVxuXHRcdFx0bGV0IGhfbGVmdCA9IHRoaXMudG9wKGFfY2Fub3B5W2hfbm9kZS5sZWZ0XSk7XG5cblx0XHRcdC8vIG5laWdoYm9yIGlzIHJlYWR5XG5cdFx0XHRpZihoX2xlZnQucmVhZHkpIHtcblx0XHRcdFx0cmV0dXJuIHRoaXMubWVyZ2UoaF9sZWZ0LCBoX25vZGUpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgYnVzeS9ub3QgcmVhZHk7IG1hcmsgdGhpcyBpdGVtIGFzIHJlYWR5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0aF9ub2RlLnJlYWR5ID0gdHJ1ZTtcblx0XHRcdFx0aF9ub2RlLnN0ZXBzID0gdGhpcy5zdGVwcztcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gc29tZXdoZXJlIGluIHRoZSBtaWRkbGVcblx0XHRlbHNlIHtcblx0XHRcdC8vIHN0YXJ0IHdpdGggbGVmdCBuZWlnaGJvclxuXHRcdFx0bGV0IGhfbGVmdCA9IHRoaXMudG9wKGFfY2Fub3B5W2hfbm9kZS5sZWZ0XSk7XG5cblx0XHRcdC8vIG5laWdoYm9yIGlzIHJlYWR5XG5cdFx0XHRpZihoX2xlZnQucmVhZHkpIHtcblx0XHRcdFx0cmV0dXJuIHRoaXMubWVyZ2UoaF9sZWZ0LCBoX25vZGUpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgYnVzeS9ub3QgcmVhZHlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyB0cnkgcmlnaHQgbmVpZ2hib3Jcblx0XHRcdFx0bGV0IGhfcmlnaHQgPSB0aGlzLnRvcChhX2Nhbm9weVtoX25vZGUucmlnaHRdKTtcblxuXHRcdFx0XHQvLyBuZWlnaGJvciBpcyByZWFkeVxuXHRcdFx0XHRpZihoX3JpZ2h0LnJlYWR5KSB7XG5cdFx0XHRcdFx0cmV0dXJuIHRoaXMubWVyZ2UoaF9ub2RlLCBoX3JpZ2h0KTtcblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBuZWlnaGJvciBpcyBidXN5L25vdCByZWFkeTsgbWFyayB0aGlzIGl0ZW0gYXMgcmVhZHlcblx0XHRcdFx0ZWxzZSB7XG5cdFx0XHRcdFx0aF9ub2RlLnJlYWR5ID0gdHJ1ZTtcblx0XHRcdFx0XHRoX25vZGUuc3RlcHMgPSB0aGlzLnN0ZXBzO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cbn1cblxuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKGRjX3dvcmtlcikge1xuXHRjb25zdCBwb29sID0gcmVxdWlyZSgnLi9wb29sLmpzJykoZGNfd29ya2VyKTtcblx0cmV0dXJuIGNsYXNzIGdyb3VwIGV4dGVuZHMgcG9vbCB7XG5cdFx0Y29uc3RydWN0b3IoLi4uYV9hcmdzKSB7XG5cdFx0XHRzdXBlciguLi5hX2FyZ3MpO1xuXG5cdFx0XHRsZXQge1xuXHRcdFx0XHRsaW1pdDogbl93b3JrZXJzLFxuXHRcdFx0fSA9IHRoaXM7XG5cblx0XHRcdC8vIG1ha2Ugd29ya2Vyc1xuXHRcdFx0bGV0IGhtX3Jvc3RlciA9IG5ldyBXZWFrTWFwKCk7XG5cdFx0XHRmb3IobGV0IGlfd29ya2VyPTA7IGlfd29ya2VyPG5fd29ya2VyczsgaV93b3JrZXIrKykge1xuXHRcdFx0XHQvLyBzcGF3biBuZXcgd29ya2VyXG5cdFx0XHRcdGxldCBrX3dvcmtlciA9IHRoaXMuc3Bhd25fd29ya2VyKCk7XG5cblx0XHRcdFx0Ly8gcmVzZXJ2ZSBhIHF1ZXVlIGZvciBpdCBpbiByb3N0ZXJcblx0XHRcdFx0aG1fcm9zdGVyLnNldChrX3dvcmtlciwgW10pO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBzYXZlIGdyb3VwIGZpZWxkc1xuXHRcdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRcdHJvc3RlcjogaG1fcm9zdGVyLFxuXHRcdFx0XHRsb2Nrczoge30sXG5cdFx0XHRcdG5leHRfd29ya2VyX3N1bW1vbjogMCxcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdGRhdGEoYV9pdGVtcykge1xuXHRcdFx0cmV0dXJuIG5ldyBhcm1lZF9ncm91cCh0aGlzLCB0aGlzLmJhbGFuY2UoYV9pdGVtcykpO1xuXHRcdH1cblxuXHRcdHVzZShhX3N1YnNldHMpIHtcblx0XHRcdGlmKGFfc3Vic2V0cy5sZW5ndGggPiB0aGlzLmxpbWl0KSB7XG5cdFx0XHRcdHRocm93IG5ldyBSYW5nZUVycm9yKGB0b28gbWFueSBzdWJzZXRzIGdpdmVuIGZvciBudW1iZXIgb2Ygd29ya2VyczogJHthX3N1YnNldHMubGVuZ3RofSBzdWJzZXRzID4gJHt0aGlzLmxpbWl0fSB3b3JrZXJzYCk7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiBuZXcgYXJtZWRfZ3JvdXAodGhpcywgYV9zdWJzZXRzKTtcblx0XHR9XG5cblx0XHRydW4oLi4uYV9hcmdzKSB7XG5cdFx0XHRsZXQge1xuXHRcdFx0XHR3b3JrZXJzOiBhX3dvcmtlcnMsXG5cdFx0XHRcdGxpbWl0OiBuX3dvcmtlcnMsXG5cdFx0XHR9ID0gdGhpcztcblxuXHRcdFx0bGV0IGFfcHJvbWlzZXMgPSBbXTtcblx0XHRcdGZvcihsZXQgaV93b3JrZXI9MDsgaV93b3JrZXI8bl93b3JrZXJzOyBpX3dvcmtlcisrKSB7XG5cdFx0XHRcdGFfcHJvbWlzZXMucHVzaChuZXcgUHJvbWlzZSgoZmtfd29ya2VyLCBmZV93b3JrZXIpID0+IHtcblx0XHRcdFx0XHR0aGlzLnNjaGVkdWxlKGFfd29ya2Vyc1tpX3dvcmtlcl0sIChrX3dvcmtlcikgPT4ge1xuXHRcdFx0XHRcdFx0a193b3JrZXIucnVuKC4uLmFfYXJncylcblx0XHRcdFx0XHRcdFx0LnRoZW4oKCkgPT4ge1xuXHRcdFx0XHRcdFx0XHRcdC8vIHdvcmtlciBtYWRlIGl0c2VsZiBhdmFpbGFibGVcblx0XHRcdFx0XHRcdFx0XHR0aGlzLndvcmtlcl9hdmFpbGFibGUoa193b3JrZXIpO1xuXG5cdFx0XHRcdFx0XHRcdFx0Ly8gcmVzb2x2ZSBwcm9taXNlXG5cdFx0XHRcdFx0XHRcdFx0Zmtfd29ya2VyKCk7XG5cdFx0XHRcdFx0XHRcdH0pXG5cdFx0XHRcdFx0XHRcdC5jYXRjaChmZV93b3JrZXIpO1xuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9KSk7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiBhX3Byb21pc2VzO1xuXHRcdH1cblxuXHRcdGJhbGFuY2UoYV9pdGVtcykge1xuXHRcdFx0cmV0dXJuIGRpdmlkZShhX2l0ZW1zLCB0aGlzLmxpbWl0LCBYTV9TVFJBVEVHWV9FUVVBTCk7XG5cdFx0fVxuXG5cdFx0YmFsYW5jZV9vcmRlcmVkX2dyb3VwcyhhX2dyb3VwcywgaF9kaXZpZGUpIHtcblx0XHRcdHJldHVybiBkaXZpZGUoYV9ncm91cHMsIHRoaXMubGltaXQsIFhNX1NUUkFURUdZX09SREVSRURfR1JPVVBTX0JBTEFOQ0VELCBoX2RpdmlkZSk7XG5cdFx0fVxuXG5cdFx0Ymlhc19vcmRlcmVkX2dyb3VwcyhhX2dyb3VwcywgaF9kaXZpZGUpIHtcblx0XHRcdHJldHVybiBkaXZpZGUoYV9ncm91cHMsIHRoaXMubGltaXQsIFhNX1NUUkFURUdZX09SREVSRURfR1JPVVBTX0JJQVNFRCwgaF9kaXZpZGUpO1xuXHRcdH1cblxuXHRcdGRpdmlzaW9ucyhuX2l0ZW1zKSB7XG5cdFx0XHRsZXQgbl93b3JrZXJzID0gdGhpcy5saW1pdDtcblxuXHRcdFx0Ly8gZG8gbm90IGFzc2lnbiB3b3JrZXIgdG8gZG8gbm90aGluZ1xuXHRcdFx0aWYobl9pdGVtcyA8IG5fd29ya2Vycykgbl93b3JrZXJzID0gbl9pdGVtcztcblxuXHRcdFx0Ly8gaG93IG1hbnkgdGltZXMgdG8gZGl2aWRlIHRoZSBpdGVtc1xuXHRcdFx0bGV0IG5fZGl2aXNpb25zID0gbl93b3JrZXJzIC0gMTtcblxuXHRcdFx0Ly8gaWRlYWwgbnVtYmVyIG9mIGl0ZW1zIHBlciB3b3JrZXJcblx0XHRcdGxldCB4X2l0ZW1zX3Blcl93b3JrZXIgPSBuX2l0ZW1zIC8gbl93b3JrZXJzO1xuXG5cdFx0XHQvLyBpdGVtIGluZGljZXMgd2hlcmUgdG8gbWFrZSBkaXZpc2lvbnNcblx0XHRcdGxldCBhX2RpdmlzaW9ucyA9IFtdO1xuXHRcdFx0Zm9yKGxldCBpX2RpdmlzaW9uPTE7IGlfZGl2aXNpb248PW5fZGl2aXNpb25zOyBpX2RpdmlzaW9uKyspIHtcblx0XHRcdFx0YV9kaXZpc2lvbnMucHVzaChNYXRoLnJvdW5kKGlfZGl2aXNpb24gKiB4X2l0ZW1zX3Blcl93b3JrZXIpKTtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIGFfZGl2aXNpb25zO1xuXHRcdH1cblxuXHRcdCpkaXZpZGVyKGNfaXRlbXNfcmVtYWluLCB4bV9kaXN0cmlidXRpb249WE1fRElTVFJJQlVUSU9OX0NPTlNUQU5UKSB7XG5cdFx0XHRsZXQgY193b3JrZXJzX3JlbWFpbiA9IHRoaXMubGltaXQ7XG5cblx0XHRcdC8vIGl0ZW1zIHBlciB3b3JrZXJcblx0XHRcdGxldCBuX2l0ZW1zX3Blcl9kaXZpc2lvbiA9IE1hdGguZmxvb3IoY19pdGVtc19yZW1haW4gLyBjX3dvcmtlcnNfcmVtYWluKTtcblxuXHRcdFx0Ly8gY29uc3RhbnQgZGlzdHJpYnV0aW9uXG5cdFx0XHRpZihYTV9ESVNUUklCVVRJT05fQ09OU1RBTlQgPT09IHhtX2Rpc3RyaWJ1dGlvbikge1xuXHRcdFx0XHRsZXQgY19pdGVtcyA9IDA7XG5cblx0XHRcdFx0Ly8gaXRlcmF0aXZlbHkgZmluZCBpbmRleGVzIHRvIGRpdmlkZSBhdFxuXHRcdFx0XHRmb3IoOzspIHtcblx0XHRcdFx0XHQvLyBkaXZpZGUgaGVyZVxuXHRcdFx0XHRcdGlmKCsrY19pdGVtcyA+PSBuX2l0ZW1zX3Blcl9kaXZpc2lvbikge1xuXHRcdFx0XHRcdFx0Ly8gZGl2aWRpbmcgbm93IHdvdWxkIGNhdXNlIGl0ZW0gb3ZlcmZsb3dcblx0XHRcdFx0XHRcdGlmKCEtLWNfd29ya2Vyc19yZW1haW4pIHtcblx0XHRcdFx0XHRcdFx0Ly8gZG9uJ3QgY3JlYXRlIGFueSBtb3JlIGRpdmlzaW9uc1xuXHRcdFx0XHRcdFx0XHRmb3IoOzspIHlpZWxkIGZhbHNlO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHQvLyBkaXZpc2lvbiBva2F5XG5cdFx0XHRcdFx0XHR5aWVsZCB0cnVlO1xuXG5cdFx0XHRcdFx0XHQvLyBob3cgbWFueSBpdGVtcyByZW1haW5cblx0XHRcdFx0XHRcdGNfaXRlbXNfcmVtYWluIC09IGNfaXRlbXM7XG5cblx0XHRcdFx0XHRcdC8vIHJlc2V0IGl0ZW0gY291bnQgZm9yIG5ldyB3b3JrZXJcblx0XHRcdFx0XHRcdGNfaXRlbXMgPSAwO1xuXG5cdFx0XHRcdFx0XHQvLyByZWNhbGN1bGF0ZSB0YXJnZXQgaXRlbXMgcGVyIHdvcmtlclxuXHRcdFx0XHRcdFx0bl9pdGVtc19wZXJfZGl2aXNpb24gPSBNYXRoLmZsb29yKGNfaXRlbXNfcmVtYWluIC8gY193b3JrZXJzX3JlbWFpbik7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdC8vIHB1c2ggaXRlbVxuXHRcdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdFx0eWllbGQgZmFsc2U7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXG5cblx0XHQvLyBsYXRlbnQoaF9kaXNwYXRjaCkge1xuXHRcdC8vIFx0bGV0IHtcblx0XHQvLyBcdFx0dGFzazogc190YXNrLFxuXHRcdC8vIFx0XHRhcmdzOiBhX2FyZ3NfZGlzcGF0Y2g9W10sXG5cdFx0Ly8gXHRcdHRhc2tfY291bnQ6IG5fdGFza3M9dGhpcy5saW1pdCxcblx0XHQvLyBcdFx0ZXZlbnRzOiBoX2V2ZW50c19kaXNwYXRjaCxcblx0XHQvLyBcdH0gPSBoX2Rpc3BhdGNoO1xuXG5cdFx0Ly8gXHRsZXQgaV9zdWJzZXQgPSAwO1xuXG5cdFx0Ly8gXHQvLyBwcmVwYXJlIHRvIGRlYWwgd2l0aCByZXN1bHRzXG5cdFx0Ly8gXHRsZXQga19wbGFubmVyID0gbmV3IGFjdGl2ZV9ncm91cCh0aGlzLCBuX3Rhc2tzLCAoYV9hcmdzPVtdLCBhX3RyYW5zZmVyPW51bGwpID0+IHtcblx0XHQvLyBcdFx0Ly8gc3VtbW9uIHdvcmtlcnMgb25lIGF0IGEgdGltZVxuXHRcdC8vIFx0XHR0aGlzLnN1bW1vbl93b3JrZXJzKDEsIChrX3dvcmtlcikgPT4ge1xuXHRcdC8vIFx0XHRcdC8vIHJlc3VsdCBoYW5kbGVyIHdhcyBub3QgdXNlZDsgYXV0by1lbmQgaXRcblx0XHQvLyBcdFx0XHRpZigha19wbGFubmVyLnVzZWQpIGtfcGxhbm5lci5lbmQoKTtcblxuXHRcdC8vIFx0XHRcdC8vIG1ha2UgcmVzdWx0IGhhbmRsZXJcblx0XHQvLyBcdFx0XHRsZXQgZmtfcmVzdWx0ID0ga19wbGFubmVyLm1rX3Jlc3VsdChrX3dvcmtlciwgaV9zdWJzZXQrKyk7XG5cblx0XHQvLyBcdFx0XHQvLyBtYWtlIHdvcmtlci1zcGVjaWZpYyBldmVudHNcblx0XHQvLyBcdFx0XHRsZXQgaF9ldmVudHNfd29ya2VyID0gdGhpcy5ldmVudF9yb3V0ZXIoaF9ldmVudHNfZGlzcGF0Y2gsIGlfc3Vic2V0KTtcblxuXHRcdC8vIFx0XHRcdC8vIGV4ZWN1dGUgd29ya2VyIG9uIHRoaXMgcGFydCBvZiBkYXRhXG5cdFx0Ly8gXHRcdFx0a193b3JrZXIuZXhlYyh7XG5cdFx0Ly8gXHRcdFx0XHR0YXNrOiBzX3Rhc2ssXG5cdFx0Ly8gXHRcdFx0XHRhcmdzOiBbLi4uYV9hcmdzX2Rpc3BhdGNoLCAuLi5hX2FyZ3NdLFxuXHRcdC8vIFx0XHRcdFx0dHJhbnNmZXI6IGFfdHJhbnNmZXIsXG5cdFx0Ly8gXHRcdFx0XHRob2xkOiBrX3BsYW5uZXIudXBzdHJlYW1faG9sZCxcblx0XHQvLyBcdFx0XHRcdGV2ZW50czogaF9ldmVudHNfd29ya2VyLFxuXHRcdC8vIFx0XHRcdH0sIGZrX3Jlc3VsdCk7XG5cdFx0Ly8gXHRcdH0pO1xuXHRcdC8vIFx0fSk7XG5cblx0XHQvLyBcdC8vIGxldCB1c2VyIGJpbmQgaGFuZGxlclxuXHRcdC8vIFx0cmV0dXJuIGtfcGxhbm5lcjtcblx0XHQvLyB9XG5cblx0XHRzY2hlZHVsZShrX3dvcmtlciwgZl9ydW4pIHtcblx0XHRcdC8vIHdvcmtlciBhdmFpbGFibGUgaW1tZWRpYXRlbHlcblx0XHRcdGlmKGtfd29ya2VyLmF2YWlsYWJsZSkge1xuXHRcdFx0XHRmX3J1bihrX3dvcmtlcik7XG5cdFx0XHR9XG5cdFx0XHQvLyBwdXNoIHRvIHByaW9yaXR5IHF1ZXVlXG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0dGhpcy5yb3N0ZXIuZ2V0KGtfd29ya2VyKS5wdXNoKGZfcnVuKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRhc3NpZ25fd29ya2VyKGtfd29ya2VyLCBoX3Rhc2ssIGZrX3Rhc2spIHtcblx0XHRcdC8vIG9uY2UgaXQgaXMgdGltZSB0byBydW4gdGhlIHRhc2sgb24gdGhlIGdpdmVuIHdvcmtlclxuXHRcdFx0dGhpcy5zY2hlZHVsZShrX3dvcmtlciwgKCkgPT4ge1xuXHRcdFx0XHRrX3dvcmtlci5leGVjKGhfdGFzaywgKC4uLmFfYXJncykgPT4ge1xuXHRcdFx0XHRcdC8vIHdvcmtlciBqdXN0IG1hZGUgaXRzZWxmIGF2YWlsYWJsZVxuXHRcdFx0XHRcdHRoaXMud29ya2VyX2F2YWlsYWJsZShrX3dvcmtlcik7XG5cblx0XHRcdFx0XHQvLyBjYWxsYmFja1xuXHRcdFx0XHRcdGZrX3Rhc2soLi4uYV9hcmdzKTtcblx0XHRcdFx0fSk7XG5cdFx0XHR9KTtcblx0XHR9XG5cblx0XHRyZWxheShoX3JlbGF5LCBma19yZXN1bHQpIHtcblx0XHRcdGxldCB7XG5cdFx0XHRcdHNlbmRlcjoge1xuXHRcdFx0XHRcdHdvcmtlcjoga193b3JrZXJfc2VuZGVyLFxuXHRcdFx0XHRcdHRhc2tfaWQ6IGlfdGFza19zZW5kZXIsXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHJlY2VpdmVyOiB7XG5cdFx0XHRcdFx0d29ya2VyOiBrX3dvcmtlcl9yZWNlaXZlcixcblx0XHRcdFx0XHR0YXNrX2lkOiBpX3Rhc2tfcmVjZWl2ZXIsXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHJlY2VpdmVyX3ByaW1hcnk6IGJfcmVjZWl2ZXJfcHJpbWFyeSxcblx0XHRcdFx0dGFza19yZWFkeTogaF90YXNrX3JlYWR5LFxuXHRcdFx0XHRkZWJ1Zzogc19kZWJ1Zyxcblx0XHRcdH0gPSBoX3JlbGF5O1xuXG5cdFx0XHQvLyBsZXQgc19zZW5kZXIgPSAnUycrU3RyaW5nLmZyb21DaGFyQ29kZSg2NStrX3dvcmtlcl9zZW5kZXIuaWQpO1xuXHRcdFx0Ly8gbGV0IHNfcmVjZWl2ZXIgPSAnUycrU3RyaW5nLmZyb21DaGFyQ29kZSg2NStrX3dvcmtlcl9yZWNlaXZlci5pZCk7XG5cblx0XHRcdC8vIGNyZWF0ZSBtZXNzYWdlIGNoYW5uZWxcblx0XHRcdGxldCBrX2NoYW5uZWwgPSBEQ19DSEFOTkVMLmJldHdlZW4oa193b3JrZXJfc2VuZGVyLCBrX3dvcmtlcl9yZWNlaXZlcik7XG5cblx0XHRcdGlmKGtfd29ya2VyX3NlbmRlciA9PT0ga193b3JrZXJfcmVjZWl2ZXIpIGRlYnVnZ2VyO1xuXG5cdFx0XHQvLyBjb25zb2xlLndhcm4oYE0vcmVsYXkvcmVjZWl2ZSBbJHtpX3Rhc2tfc2VuZGVyfV0gPT4gJHtpX3Rhc2tfcmVjZWl2ZXJ9YCk7XG5cblx0XHRcdC8vIGF0dGFjaCBkZWJ1ZyB0YWcgdG8gcmVhZHkgdGFza1xuXHRcdFx0aWYoc19kZWJ1ZykgaF90YXNrX3JlYWR5LmRlYnVnID0gc19kZWJ1ZztcblxuXHRcdFx0Ly8gc2NoZWR1bGUgcmVjZWl2ZXIgd29ya2VyIHRvIHJlY2VpdmUgZGF0YSBhbmQgdGhlbiBydW4gdGFza1xuXHRcdFx0dGhpcy5zY2hlZHVsZShrX3dvcmtlcl9yZWNlaXZlciwgKCkgPT4ge1xuXHRcdFx0XHRrX3dvcmtlcl9yZWNlaXZlci5yZWNlaXZlKGtfY2hhbm5lbC5wb3J0XzEoKSwge1xuXHRcdFx0XHRcdGltcG9ydDogaV90YXNrX3JlY2VpdmVyLFxuXHRcdFx0XHRcdHNlbmRlcjogaV90YXNrX3NlbmRlcixcblx0XHRcdFx0XHRwcmltYXJ5OiBiX3JlY2VpdmVyX3ByaW1hcnksXG5cdFx0XHRcdFx0dGFza19yZWFkeTogaF90YXNrX3JlYWR5LFxuXHRcdFx0XHR9LCAoLi4uYV9hcmdzKSA9PiB7XG5cdFx0XHRcdFx0Ly8gd29ya2VyIGp1c3QgbWFkZSBpdHNlbGYgYXZhaWxhYmxlXG5cdFx0XHRcdFx0dGhpcy53b3JrZXJfYXZhaWxhYmxlKGtfd29ya2VyX3JlY2VpdmVyKTtcblxuXHRcdFx0XHRcdC8vIGNhbGxiYWNrXG5cdFx0XHRcdFx0ZmtfcmVzdWx0KC4uLmFfYXJncyk7XG5cdFx0XHRcdH0sIHNfZGVidWcpO1xuXHRcdFx0fSk7XG5cblx0XHRcdC8vIHNjaGVkdWxlIHNlbmRlciB3b3JrZXIgdG8gcmVsYXkgZGF0YSB0byByZWNlaXZlciB3b3JrZXJcblx0XHRcdHRoaXMuc2NoZWR1bGUoa193b3JrZXJfc2VuZGVyLCAoKSA9PiB7XG5cdFx0XHRcdGtfd29ya2VyX3NlbmRlci5yZWxheShpX3Rhc2tfc2VuZGVyLCBrX2NoYW5uZWwucG9ydF8yKCksIFN0cmluZy5mcm9tQ2hhckNvZGUoNjUra193b3JrZXJfcmVjZWl2ZXIuaWQpLCBzX2RlYnVnKTtcblxuXHRcdFx0XHQvLyBubyByZXN1bHQgbmVlZGVkIGZyb20gcmVsYXk7IHdvcmtlciBpcyBhdmFpbGFibGUgYWZ0ZXIgbWVzc2FnZSBwb3N0c1xuXHRcdFx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0XHR0aGlzLndvcmtlcl9hdmFpbGFibGUoa193b3JrZXJfc2VuZGVyKTtcblx0XHRcdFx0fSwgMCk7XG5cdFx0XHR9KTtcblx0XHR9XG5cblx0XHRzdW1tb25fd29ya2VycyhuX3N1bW1vbnMsIGZrX3dvcmtlcikge1xuXHRcdFx0bGV0IGFfd29ya2VycyA9IHRoaXMud29ya2Vycztcblx0XHRcdGxldCBuX3dvcmtlcnMgPSB0aGlzLmxpbWl0O1xuXG5cdFx0XHRsZXQgY19zdW1tb25lZCA9IDA7XG5cblx0XHRcdC8vIHN0YXJ0IGJ5IGxvb2tpbmcgZm9yIGF2YWlsYWJsZSB3b3JrZXJzXG5cdFx0XHRsZXQgaV9uZXh0X3dvcmtlcl9zdW1tb24gPSB0aGlzLm5leHRfd29ya2VyX3N1bW1vbjtcblxuXHRcdFx0Zm9yKGxldCBpX3dvcmtlcj0wOyBpX3dvcmtlcjxuX3dvcmtlcnMgJiYgY19zdW1tb25lZDxuX3N1bW1vbnM7IGlfd29ya2VyKyspIHtcblx0XHRcdFx0bGV0IGlfd29ya2VyX2NhbGwgPSAoaV93b3JrZXIraV9uZXh0X3dvcmtlcl9zdW1tb24pICUgbl93b3JrZXJzO1xuXHRcdFx0XHRsZXQga193b3JrZXIgPSBhX3dvcmtlcnNbaV93b3JrZXJfY2FsbF07XG5cblx0XHRcdFx0Ly8gd29ya2VyIGF2YWlsYWJsZSBpbW1lZGlhdGVseVxuXHRcdFx0XHRpZihrX3dvcmtlci5hdmFpbGFibGUpIHtcblx0XHRcdFx0XHQvLyBzZXQgbmV4dCB3b3JrZXIgdG8gc3VtbW9uXG5cdFx0XHRcdFx0dGhpcy5uZXh0X3dvcmtlcl9zdW1tb24gPSBpX3dvcmtlcl9jYWxsICsgMTtcblxuXHRcdFx0XHRcdC8vIHNhdmUgc3VtbW9uIGluZGV4XG5cdFx0XHRcdFx0bGV0IGlfc3Vic2V0ID0gY19zdW1tb25lZCsrO1xuXG5cdFx0XHRcdFx0Ly8gYWxsb3cgZG93bnN0cmVhbSBoYW5kbGVyIHRvIGJlIGVzdGFibGlzaGVkIGZpcnN0XG5cdFx0XHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0XHQvLyBjb25zb2xlLmluZm8oJyA9PiAnK2tfd29ya2VyLmlkKTtcblx0XHRcdFx0XHRcdGZrX3dvcmtlcihrX3dvcmtlciwgaV9zdWJzZXQpO1xuXHRcdFx0XHRcdH0sIDApO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIHRoZXJlIGFyZSByZW1haW5pbmcgc3VtbW9uc1xuXHRcdFx0aWYoY19zdW1tb25lZCA8IG5fc3VtbW9ucykge1xuXHRcdFx0XHQvLyBxdWV1ZSBmb3Igbm90aWZpY2F0aW9uIHdoZW4gd29ya2VycyBiZWNvbWUgYXZhaWxhYmxlXG5cdFx0XHRcdHRoaXMud2FpdF9saXN0LnB1c2goe1xuXHRcdFx0XHRcdHRhc2tzX3JlbWFpbmluZzogbl9zdW1tb25zIC0gY19zdW1tb25lZCxcblx0XHRcdFx0XHRlYWNoKGtfd29ya2VyKSB7XG5cdFx0XHRcdFx0XHRma193b3JrZXIoa193b3JrZXIsIGNfc3VtbW9uZWQrKyk7XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0d29ya2VyX2F2YWlsYWJsZShrX3dvcmtlcikge1xuXHRcdFx0Ly8gdGhpcyB3b3JrZXIgaGFzIHByaW9yaXR5IHRhc2tzIHdhaXRpbmcgZm9yIGl0XG5cdFx0XHRsZXQgYV9xdWV1ZSA9IHRoaXMucm9zdGVyLmdldChrX3dvcmtlcik7XG5cdFx0XHRpZihhX3F1ZXVlLmxlbmd0aCkge1xuXHRcdFx0XHQvLyBmaWZvIHBvcCBhbmQgY2FsbFxuXHRcdFx0XHRsZXQgZmtfd29ya2VyID0gYV9xdWV1ZS5zaGlmdCgpO1xuXHRcdFx0XHRma193b3JrZXIoa193b3JrZXIpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gdGhlcmUgaXMgYSB3YWl0IGxpc3Rcblx0XHRcdGVsc2UgaWYodGhpcy53YWl0X2xpc3QubGVuZ3RoKSB7XG5cdFx0XHRcdC8vIHRvcCBvZiBxdWV1ZVxuXHRcdFx0XHRsZXQgaF9wYXRpZW50ID0gdGhpcy53YWl0X2xpc3RbMF07XG5cblx0XHRcdFx0Ly8gYXNzaWduIHdvcmtlciBuZXh0IHRhc2tcblx0XHRcdFx0aF9wYXRpZW50LmVhY2goa193b3JrZXIpO1xuXG5cdFx0XHRcdC8vIHRoaXMgcGF0aWVudCBpcyBzYXRpc2ZpZWQ7IGZpZm8gcG9wXG5cdFx0XHRcdGlmKDAgPT09IC0taF9wYXRpZW50LnRhc2tzX3JlbWFpbmluZykgdGhpcy53YWl0X2xpc3Quc2hpZnQoKTtcblx0XHRcdH1cblx0XHRcdC8vIG90aGVyd2lzZSwgZnJlZSB3b3JrZXJcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHRrX3dvcmtlci5hdmFpbGFibGUgPSB0cnVlO1xuXHRcdFx0fVxuXHRcdH1cblx0fTtcbn07XG4iLCIvKiBlc2xpbnQtZGlzYWJsZSBuby1uZXctZnVuYyAqL1xuXG4vLyBkZWR1Y2UgdGhlIHJ1bnRpbWUgZW52aXJvbm1lbnRcbmNvbnN0IFtCX0JST1dTRVIsIEJfQlJPV1NFUklGWV0gPSAoKCkgPT4gJ3VuZGVmaW5lZCcgPT09IHR5cGVvZiBwcm9jZXNzXG5cdD8gW3RydWUsIGZhbHNlXVxuXHQ6IChwcm9jZXNzLmJyb3dzZXJcblx0XHQ/IFt0cnVlLCB0cnVlXVxuXHRcdDogKCd1bmRlZmluZWQnID09PSBwcm9jZXNzLnZlcnNpb25zIHx8ICd1bmRlZmluZWQnID09PSBwcm9jZXNzLnZlcnNpb25zLm5vZGVcblx0XHRcdD8gW3RydWUsIGZhbHNlXVxuXHRcdFx0OiBbZmFsc2UsIGZhbHNlXSkpKSgpO1xuXG5jb25zdCBsb2NhbHMgPSBtb2R1bGUuZXhwb3J0cyA9IE9iamVjdC5hc3NpZ24oe1xuXHRCX0JST1dTRVIsXG5cdEJfQlJPV1NFUklGWSxcblxuXHRIUF9XT1JLRVJfTk9USUZJQ0FUSU9OOiBTeW1ib2woJ3dvcmtlciBub3RpZmljYXRpb24nKSxcbn0sIEJfQlJPV1NFUj8gcmVxdWlyZSgnLi4vYnJvd3Nlci9sb2NhbHMuanMnKTogcmVxdWlyZSgnLi4vbm9kZS9sb2NhbHMuanMnKSwge1xuXG5cdHdlYndvcmtlcmlmeSh6X2ltcG9ydCwgaF9jb25maWc9e30pIHtcblx0XHRjb25zdCBbRl9GVU5DVElPTl9CVU5ETEUsIEhfU09VUkNFUywgSF9DQUNIRV0gPSBoX2NvbmZpZy5icm93c2VyaWZ5O1xuXHRcdGxldCBzX3dvcmtlcl9rZXkgPSAnJztcblx0XHRmb3IobGV0IHNfY2FjaGVfa2V5IGluIEhfQ0FDSEUpIHtcblx0XHRcdGxldCB6X2V4cG9ydHMgPSBIX0NBQ0hFW3NfY2FjaGVfa2V5XS5leHBvcnRzO1xuXHRcdFx0aWYoel9pbXBvcnQgPT09IHpfZXhwb3J0cyB8fCB6X2ltcG9ydCA9PT0gel9leHBvcnRzLmRlZmF1bHQpIHtcblx0XHRcdFx0c193b3JrZXJfa2V5ID0gc19jYWNoZV9rZXk7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGlmKCFzX3dvcmtlcl9rZXkpIHtcblx0XHRcdHNfd29ya2VyX2tleSA9IE1hdGguZmxvb3IoTWF0aC5wb3coMTYsIDgpICogTWF0aC5yYW5kb20oKSkudG9TdHJpbmcoMTYpO1xuXHRcdFx0bGV0IGhfY2FjaGVfd29ya2VyID0ge307XG5cdFx0XHRmb3IobGV0IHNfa2V5X2NhY2hlIGluIEhfU09VUkNFUykge1xuXHRcdFx0XHRoX2NhY2hlX3dvcmtlcltzX2tleV9jYWNoZV0gPSBzX2tleV9jYWNoZTtcblx0XHRcdH1cblx0XHRcdEhfU09VUkNFU1tzX3dvcmtlcl9rZXldID0gW1xuXHRcdFx0XHRuZXcgRnVuY3Rpb24oWydyZXF1aXJlJywgJ21vZHVsZScsICdleHBvcnRzJ10sIGAoJHt6X2ltcG9ydH0pKHNlbGYpO2ApLFxuXHRcdFx0XHRoX2NhY2hlX3dvcmtlcixcblx0XHRcdF07XG5cdFx0fVxuXG5cdFx0bGV0IHNfc291cmNlX2tleSA9IE1hdGguZmxvb3IoTWF0aC5wb3coMTYsIDgpICogTWF0aC5yYW5kb20oKSkudG9TdHJpbmcoMTYpO1xuXHRcdEhfU09VUkNFU1tzX3NvdXJjZV9rZXldID0gW1xuXHRcdFx0bmV3IEZ1bmN0aW9uKFsncmVxdWlyZSddLCBgXG5cdFx0XHRcdGxldCBmID0gcmVxdWlyZSgke0pTT04uc3RyaW5naWZ5KHNfd29ya2VyX2tleSl9KTtcblx0XHRcdFx0Ly8gZGVidWdnZXI7XG5cdFx0XHRcdC8vIChmLmRlZmF1bHQ/IGYuZGVmYXVsdDogZikoc2VsZik7XG5cdFx0XHRgKSxcblx0XHRcdHtbc193b3JrZXJfa2V5XTpzX3dvcmtlcl9rZXl9LFxuXHRcdF07XG5cblx0XHRsZXQgaF93b3JrZXJfc291cmNlcyA9IHt9O1xuXHRcdGZ1bmN0aW9uIHJlc29sdmVfc291cmNlcyhzX2tleSkge1xuXHRcdFx0aF93b3JrZXJfc291cmNlc1tzX2tleV0gPSB0cnVlO1xuXHRcdFx0bGV0IGhfc291cmNlID0gSF9TT1VSQ0VTW3Nfa2V5XVsxXTtcblx0XHRcdGZvcihsZXQgcF9kZXBlbmRlbmN5IGluIGhfc291cmNlKSB7XG5cdFx0XHRcdGxldCBzX2RlcGVuZGVuY3lfa2V5ID0gaF9zb3VyY2VbcF9kZXBlbmRlbmN5XTtcblx0XHRcdFx0aWYoIWhfd29ya2VyX3NvdXJjZXNbc19kZXBlbmRlbmN5X2tleV0pIHtcblx0XHRcdFx0XHRyZXNvbHZlX3NvdXJjZXMoc19kZXBlbmRlbmN5X2tleSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cdFx0cmVzb2x2ZV9zb3VyY2VzKHNfc291cmNlX2tleSk7XG5cblx0XHRsZXQgc19zb3VyY2UgPSBgKCR7Rl9GVU5DVElPTl9CVU5ETEV9KSh7XG5cdFx0XHQke09iamVjdC5rZXlzKGhfd29ya2VyX3NvdXJjZXMpLm1hcCgoc19rZXkpID0+IHtcblx0XHRcdFx0bGV0IGFfc291cmNlID0gSF9TT1VSQ0VTW3Nfa2V5XTtcblx0XHRcdFx0cmV0dXJuIEpTT04uc3RyaW5naWZ5KHNfa2V5KVxuXHRcdFx0XHRcdCtgOlske2Ffc291cmNlWzBdfSwke0pTT04uc3RyaW5naWZ5KGFfc291cmNlWzFdKX1dYDtcblx0XHRcdH0pfVxuXHRcdH0sIHt9LCBbJHtKU09OLnN0cmluZ2lmeShzX3NvdXJjZV9rZXkpfV0pYDtcblxuXHRcdGxldCBkX2Jsb2IgPSBuZXcgQmxvYihbc19zb3VyY2VdLCB7dHlwZTondGV4dC9qYXZhc2NyaXB0J30pO1xuXHRcdGlmKGhfY29uZmlnLmJhcmUpIHtcblx0XHRcdHJldHVybiBkX2Jsb2I7XG5cdFx0fVxuXHRcdGxldCBwX3dvcmtlcl91cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKGRfYmxvYik7XG5cdFx0bGV0IGRfd29ya2VyID0gbmV3IGxvY2Fscy5EQ19XT1JLRVIocF93b3JrZXJfdXJsLCBoX2NvbmZpZy53b3JrZXJfb3B0aW9ucyk7XG5cdFx0Ly8gZF93b3JrZXIub2JqZWN0VVJMID0gcF93b3JrZXJfdXJsO1xuXHRcdC8vIGRfd29ya2VyLnNvdXJjZSA9IGRfYmxvYjtcblx0XHRkX3dvcmtlci5zb3VyY2UgPSBzX3NvdXJjZTtcblx0XHRyZXR1cm4gZF93b3JrZXI7XG5cdH0sXG59KTtcblxuIiwiXG5jbGFzcyBsb2NrIHtcblx0Y29uc3RydWN0b3IoYl91bmxvY2tlZD1mYWxzZSkge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0dW5sb2NrZWQ6IGJfdW5sb2NrZWQsXG5cdFx0XHRxdWV1ZTogW10sXG5cdFx0fSk7XG5cdH1cblxuXHR3YWl0KGZrX3VubG9jaykge1xuXHRcdC8vIGFscmVhZHkgdW5sb2NrZWRcblx0XHRpZih0aGlzLnVubG9ja2VkKSB7XG5cdFx0XHRma191bmxvY2soKTtcblx0XHR9XG5cdFx0Ly8gY3VycmVudGx5IGxvY2tlZCwgYWRkIHRvIHF1ZXVlXG5cdFx0ZWxzZSB7XG5cdFx0XHR0aGlzLnF1ZXVlLnB1c2goZmtfdW5sb2NrKTtcblx0XHR9XG5cdH1cblxuXHR1bmxvY2soKSB7XG5cdFx0Ly8gdXBkYXRlIHN0YXRlXG5cdFx0dGhpcy51bmxvY2tlZCA9IHRydWU7XG5cblx0XHQvLyB1cGRhdGUgZmllbGQgYmVmb3JlIGV4ZWN1dGluZyBjYWxsYmFja3Ncblx0XHRsZXQgYV9xdWV1ZSA9IHRoaXMucXVldWU7XG5cdFx0dGhpcy5xdWV1ZSA9IFtdO1xuXG5cdFx0Ly8gcHJvY2VzcyBjYWxsYmFjayBxdWV1ZVxuXHRcdGFfcXVldWUuZm9yRWFjaCgoZmtfdW5sb2NrKSA9PiB7XG5cdFx0XHRma191bmxvY2soKTtcblx0XHR9KTtcblx0fVxufVxuXG5jbGFzcyBsb2NrYWJsZSB7XG5cdHdhaXQoel9rZXksIHpfdW5sb2NrKSB7XG5cdFx0bGV0IGZrX3VubG9jayA9IHpfdW5sb2NrO1xuXG5cdFx0Ly8gdW5sb2NrIGlzIGFub3RoZXIgbG9ja1xuXHRcdGlmKCdzdHJpbmcnID09PSB0eXBlb2Ygel91bmxvY2spIHtcblx0XHRcdGZrX3VubG9jayA9ICgpID0+IHtcblx0XHRcdFx0dGhpcy51bmxvY2soel91bmxvY2spO1xuXHRcdFx0fTtcblx0XHR9XG5cdFx0Ly8gdW5sb2NrIGlzIGFycmF5IG9mIGxvY2tzXG5cdFx0ZWxzZSBpZihBcnJheS5pc0FycmF5KHpfdW5sb2NrKSkge1xuXHRcdFx0ZmtfdW5sb2NrID0gKCkgPT4ge1xuXHRcdFx0XHR0aGlzLnVubG9jayh6X3VubG9jayk7XG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdC8vIHNlcmllcyBvZiBrZXlzIHRvIHdhaXQgZm9yXG5cdFx0aWYoQXJyYXkuaXNBcnJheSh6X2tleSkpIHtcblx0XHRcdGxldCBpX2tleSA9IDA7XG5cdFx0XHRsZXQgbl9rZXlzID0gel9rZXkubGVuZ3RoO1xuXHRcdFx0bGV0IGZfbmV4dCA9ICgpID0+IHtcblx0XHRcdFx0aWYoaV9rZXkgPT09IG5fa2V5cykgZmtfdW5sb2NrKCk7XG5cdFx0XHRcdGVsc2UgdGhpcy53YWl0KHpfa2V5W2lfa2V5KytdLCBmX25leHQpO1xuXHRcdFx0fTtcblxuXHRcdFx0Zl9uZXh0KCk7XG5cdFx0fVxuXHRcdC8vIG5vIHN1Y2ggbG9jazsgYnV0IHRoYXQncyBva2F5IDspIGNyZWF0ZSBsb2NrIGltcGxpY2l0bHlcblx0XHRlbHNlIGlmKCEoel9rZXkgaW4gdGhpcy5sb2NrcykpIHtcblx0XHRcdGxldCBrX2xvY2sgPSB0aGlzLmxvY2tzW3pfa2V5XSA9IG5ldyBsb2NrKCk7XG5cdFx0XHRrX2xvY2sud2FpdChma191bmxvY2spO1xuXHRcdH1cblx0XHQvLyBhZGQgdG8gd2FpdCBxdWV1ZVxuXHRcdGVsc2Uge1xuXHRcdFx0dGhpcy5sb2Nrc1t6X2tleV0ud2FpdChma191bmxvY2spO1xuXHRcdH1cblx0fVxuXG5cdHVubG9jayh6X2tleSkge1xuXHRcdC8vIGxpc3Qgb2Yga2V5cyB0byB1bmxvY2tcblx0XHRpZihBcnJheS5pc0FycmF5KHpfa2V5KSkge1xuXHRcdFx0el9rZXkuZm9yRWFjaCh6X2tleV8gPT4gdGhpcy51bmxvY2soel9rZXlfKSk7XG5cdFx0fVxuXHRcdC8vIGluZGl2dWRhbCBrZXlcblx0XHRlbHNlIHtcblx0XHRcdC8vIG5vIHN1Y2ggbG9jayB5ZXRcblx0XHRcdGlmKCEoel9rZXkgaW4gdGhpcy5sb2NrcykpIHtcblx0XHRcdFx0dGhpcy5sb2Nrc1t6X2tleV0gPSBuZXcgbG9jayh0cnVlKTtcblx0XHRcdH1cblx0XHRcdC8vIHVubG9ja1xuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdHRoaXMubG9ja3Nbel9rZXldLnVubG9jaygpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG59XG5cbm1vZHVsZS5leHBvcnRzID0gbG9ja2FibGU7XG4iLCJjb25zdCB7XG5cdHNoYXJpbmcsXG59ID0gcmVxdWlyZSgnLi9sb2NhbHMuanMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBjbGFzcyBtYW5pZmVzdCB7XG5cdHN0YXRpYyBmcm9tKHpfb3RoZXIpIHtcblx0XHQvLyBtYW5pZmVzdFxuXHRcdGlmKHpfb3RoZXIgaW5zdGFuY2VvZiBtYW5pZmVzdCkge1xuXHRcdFx0cmV0dXJuIHpfb3RoZXI7XG5cdFx0fVxuXHRcdC8vIGFueVxuXHRcdGVsc2Uge1xuXHRcdFx0cmV0dXJuIG5ldyBtYW5pZmVzdCh6X290aGVyLCBbXSk7XG5cdFx0fVxuXHR9XG5cblx0Y29uc3RydWN0b3IoYV9kYXRhPVtdLCB6X3RyYW5zZmVyX3BhdGhzPXRydWUpIHtcblx0XHQvLyBub3QgYW4gYXJyYXlcblx0XHRpZighQXJyYXkuaXNBcnJheShhX2RhdGEpKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ2EgbWFuaWZlc3QgcmVwcmVzZW50cyBhbiBhcnJheSBvZiBhcmd1bWVudHM7IHBhc3MgdGhlIGNvbnN0cnVjdG9yIGFuIGFycmF5Jyk7XG5cdFx0fVxuXG5cdFx0Ly8gbm90IGEgbGlzdDsgZmluZCB0cmFuc2ZlcnMgbWFudWFsbHlcblx0XHRsZXQgYV90cmFuc2Zlcl9wYXRocyA9IHpfdHJhbnNmZXJfcGF0aHM7XG5cdFx0aWYoIUFycmF5LmlzQXJyYXkoYV90cmFuc2Zlcl9wYXRocykpIHtcblx0XHRcdGFfdHJhbnNmZXJfcGF0aHMgPSB0aGlzLmV4dHJhY3QoYV9kYXRhKTtcblx0XHR9XG5cdFx0Ly8gb25seSBjaGVjayB0b3AgbGV2ZWxcblx0XHRlbHNlIHtcblx0XHRcdGxldCBhX3RyYW5zZmVycyA9IFtdO1xuXHRcdFx0Zm9yKGxldCBpX2RhdHVtPTAsIG5sX2RhdGE9YV9kYXRhLmxlbmd0aDsgaV9kYXR1bTxubF9kYXRhOyBpX2RhdHVtKyspIHtcblx0XHRcdFx0bGV0IHpfZGF0dW0gPSBhX2RhdGFbaV9kYXR1bV07XG5cblx0XHRcdFx0Ly8gc2hhcmVhYmxlIGl0ZW1cblx0XHRcdFx0aWYoc2hhcmluZyh6X2RhdHVtKSkgYV90cmFuc2ZlcnMucHVzaChbaV9kYXR1bV0pO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBzb2xpZGlmeSB0cmFuc2ZlcnNcblx0XHRcdGlmKGFfdHJhbnNmZXJzLmxlbmd0aCkge1xuXHRcdFx0XHRhX3RyYW5zZmVyX3BhdGhzID0gYV90cmFuc2ZlcnM7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRkYXRhOiBhX2RhdGEsXG5cdFx0XHR0cmFuc2Zlcl9wYXRoczogYV90cmFuc2Zlcl9wYXRocyxcblx0XHR9KTtcblx0fVxuXG5cdGV4dHJhY3Qoel9kYXRhLCBhX3BhdGg9W10sIHppX3BhdGhfbGFzdD1udWxsKSB7XG5cdFx0Ly8gcHJvdGVjdCBhZ2FpbnN0IFtvYmplY3RdIG51bGxcblx0XHRpZighel9kYXRhKSByZXR1cm4gW107XG5cblx0XHQvLyBzZXQgb2YgcGF0aHNcblx0XHRsZXQgYV9wYXRocyA9IFtdO1xuXG5cdFx0Ly8gb2JqZWN0XG5cdFx0aWYoJ29iamVjdCcgPT09IHR5cGVvZiB6X2RhdGEpIHtcblx0XHRcdC8vIGNvcHkgcGF0aFxuXHRcdFx0YV9wYXRoID0gYV9wYXRoLnNsaWNlKCk7XG5cblx0XHRcdC8vIGNvbW1pdCB0byBpdFxuXHRcdFx0aWYobnVsbCAhPT0gemlfcGF0aF9sYXN0KSBhX3BhdGgucHVzaCh6aV9wYXRoX2xhc3QpO1xuXG5cdFx0XHQvLyBwbGFpbiBvYmplY3QgbGl0ZXJhbFxuXHRcdFx0aWYoT2JqZWN0ID09PSB6X2RhdGEuY29uc3RydWN0b3IpIHtcblx0XHRcdFx0Ly8gc2NhbiBvdmVyIGVudW1lcmFibGUgcHJvcGVydGllc1xuXHRcdFx0XHRmb3IobGV0IHNfcHJvcGVydHkgaW4gel9kYXRhKSB7XG5cdFx0XHRcdFx0Ly8gZXh0cmFjdCBkYXRhIGFuZCB0cmFuc2ZlcnMgYnkgcmVjdXJzaW5nIG9uIHByb3BlcnR5XG5cdFx0XHRcdFx0YV9wYXRocy5wdXNoKC4uLnRoaXMuZXh0cmFjdCh6X2RhdGFbc19wcm9wZXJ0eV0sIGFfcGF0aCwgc19wcm9wZXJ0eSkpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHQvLyBhcnJheVxuXHRcdFx0ZWxzZSBpZihBcnJheS5pc0FycmF5KHpfZGF0YSkpIHtcblx0XHRcdFx0Ly8gZW1wdHkgYXJyYXlcblx0XHRcdFx0aWYoIXpfZGF0YS5sZW5ndGgpIHJldHVybiBbXTtcblxuXHRcdFx0XHQvLyBzY2FuIG92ZXIgZWFjaCBpdGVtXG5cdFx0XHRcdHpfZGF0YS5mb3JFYWNoKCh6X2l0ZW0sIGlfaXRlbSkgPT4ge1xuXHRcdFx0XHRcdC8vIGV4dHJhY3QgZGF0YSBhbmQgdHJhbnNmZXJzIGJ5IHJlY3Vyc2luZyBvbiBpdGVtXG5cdFx0XHRcdFx0YV9wYXRocy5wdXNoKC4uLnRoaXMuZXh0cmFjdCh6X2l0ZW0sIGFfcGF0aCwgaV9pdGVtKSk7XG5cdFx0XHRcdH0pO1xuXHRcdFx0fVxuXHRcdFx0Ly8gc2hhcmVhYmxlIGRhdGFcblx0XHRcdGVsc2UgaWYoc2hhcmluZyh6X2RhdGEpKSB7XG5cdFx0XHRcdHJldHVybiBbYV9wYXRoXTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyByZXR1cm4gcGF0aHNcblx0XHRyZXR1cm4gYV9wYXRocztcblx0fVxuXG5cdHByZXBlbmQoel9hcmcpIHtcblx0XHQvLyBjb3B5IGl0ZW1zXG5cdFx0bGV0IGFfaXRlbXMgPSB0aGlzLmRhdGEuc2xpY2UoKTtcblxuXHRcdC8vIGNvcHkgdHJhbnNmZXIgcGF0aHNcblx0XHRsZXQgYV90cmFuc2Zlcl9wYXRocyA9IHRoaXMudHJhbnNmZXJfcGF0aHMuc2xpY2UoKTtcblxuXHRcdC8vIHB1c2ggYSBtYW5pZmVzdCB0byBmcm9udFxuXHRcdGlmKHpfYXJnIGluc3RhbmNlb2YgbWFuaWZlc3QpIHtcblx0XHRcdC8vIGFkZCBpdHMgY29udGVudHMgYXMgYSBzaW5nbGUgaXRlbVxuXHRcdFx0YV9pdGVtcy51bnNoaWZ0KHpfYXJnLmRhdGEpO1xuXG5cdFx0XHQvLyBob3cgbWFueSBwYXRocyB0byBvZmZzZXQgaW1wb3J0IGJ5XG5cdFx0XHRsZXQgbmxfcGF0aHMgPSBhX3RyYW5zZmVyX3BhdGhzLmxlbmd0aDtcblxuXHRcdFx0Ly8gdXBkYXRlIGltcG9ydCBwYXRocyAocHJpbWFyeSBpbmRleCBuZWVkcyB1cGRhdGUpXG5cdFx0XHRsZXQgYV9pbXBvcnRfcGF0aHMgPSB6X2FyZy50cmFuc2Zlcl9wYXRocztcblx0XHRcdGFfaW1wb3J0X3BhdGhzLmZvckVhY2goKGFfcGF0aCkgPT4ge1xuXHRcdFx0XHRhX3BhdGhbMF0gKz0gbmxfcGF0aHM7XG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gYXBwZW5kIGl0cyB0cmFuc2ZlciBwYXRoc1xuXHRcdFx0YV90cmFuc2Zlcl9wYXRocy5wdXNoKGFfaW1wb3J0X3BhdGhzKTtcblx0XHR9XG5cdFx0Ly8gYW55dGhpbmcgZWxzZVxuXHRcdGVsc2Uge1xuXHRcdFx0Ly8ganVzdCBhZGQgdG8gZnJvbnRcblx0XHRcdGFfaXRlbXMudW5zaGlmdCh6X2FyZyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIG5ldyBtYW5pZmVzdFxuXHRcdHJldHVybiBuZXcgbWFuaWZlc3QoYV9pdGVtcywgYV90cmFuc2Zlcl9wYXRocyk7XG5cdH1cblxuXHRwYXRocyguLi5hX3Vuc2hpZnQpIHtcblx0XHRyZXR1cm4gdGhpcy50cmFuc2Zlcl9wYXRocy5tYXAoKGFfcGF0aCkgPT4ge1xuXHRcdFx0cmV0dXJuIFsuLi5hX3Vuc2hpZnQsIC4uLmFfcGF0aF07XG5cdFx0fSk7XG5cdH1cbn07XG4iLCJjb25zdCB7XG5cdE5fQ09SRVMsXG59ID0gcmVxdWlyZSgnLi9sb2NhbHMuanMnKTtcblxuY29uc3QgbG9ja2FibGUgPSByZXF1aXJlKCcuL2xvY2thYmxlLmpzJyk7XG5cbmxldCB3b3JrZXI7XG5cbmNsYXNzIHBvb2wgZXh0ZW5kcyBsb2NrYWJsZSB7XG5cdGNvbnN0cnVjdG9yKHBfc291cmNlLCAuLi5hX2FyZ3MpIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0Ly8gZGVmYXVsdHNcblx0XHRsZXQgbl93b3JrZXJzID0gTl9DT1JFUztcblx0XHRsZXQgaF93b3JrZXJfb3B0aW9ucyA9IHt9O1xuXG5cdFx0Ly8gY29tcGxldGVuZXNzXG5cdFx0aWYoMiA9PT0gYV9hcmdzLmxlbmd0aCkge1xuXHRcdFx0bl93b3JrZXJzID0gYV9hcmdzWzBdIHx8IG5fd29ya2Vycztcblx0XHRcdGhfd29ya2VyX29wdGlvbnMgPSBhX2FyZ3NbMV0gfHwgaF93b3JrZXJfb3B0aW9ucztcblx0XHR9XG5cdFx0Ly8gb21pdHRhbmNlXG5cdFx0ZWxzZSBpZigxID09PSBhX2FyZ3MubGVuZ3RoKSB7XG5cdFx0XHQvLyB3b3JrZXIgY291bnRcblx0XHRcdGlmKCdudW1iZXInID09PSB0eXBlb2YgYV9hcmdzWzBdKSB7XG5cdFx0XHRcdG5fd29ya2VycyA9IGFfYXJnc1swXTtcblx0XHRcdH1cblx0XHRcdC8vIHdvcmtlciBvcHRpb25zXG5cdFx0XHRlbHNlIGlmKCdvYmplY3QnID09PSB0eXBlb2YgaF93b3JrZXJfb3B0aW9ucykge1xuXHRcdFx0XHRoX3dvcmtlcl9vcHRpb25zID0gYV9hcmdzWzBdO1xuXHRcdFx0fVxuXHRcdFx0Ly8gaW52YWxpZFxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdHRocm93IG5ldyBUeXBlRXJyb3IoJ2ludmFsaWQgMm5kIGFyZ3VtZW50OiAnK2FfYXJnc1swXSk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGNvbXBsZXRlbmVzc1xuXHRcdGVsc2UgaWYoIW5fd29ya2Vycykge1xuXHRcdFx0bl93b3JrZXJzID0gTl9DT1JFUztcblx0XHR9XG5cblx0XHQvLyBuZWdhdGl2ZSBudW1iZXIgZ2l2ZW47IHN1YnRyYWN0IGZyb20gY29yZSBjb3VudFxuXHRcdGlmKG5fd29ya2VycyA8IDApIG5fd29ya2VycyA9IE1hdGgubWF4KDEsIE5fQ09SRVMgKyBuX3dvcmtlcnMpO1xuXG5cdFx0Ly8gZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdFx0bGltaXQ6IG5fd29ya2Vycyxcblx0XHRcdHdvcmtlcnM6IFtdLFxuXHRcdFx0aGlzdG9yeTogW10sXG5cdFx0XHR3YWl0X2xpc3Q6IFtdLFxuXHRcdFx0b3B0aW9uczogaF93b3JrZXJfb3B0aW9ucyxcblx0XHR9KTtcblx0fVxuXG5cdHNwYXduX3dvcmtlcigpIHtcblx0XHRsZXQgYV93b3JrZXJzID0gdGhpcy53b3JrZXJzO1xuXG5cdFx0Ly8gZm9yayBvcHRpb25zXG5cdFx0bGV0IGhfb3B0aW9ucyA9IE9iamVjdC5jcmVhdGUodGhpcy5vcHRpb25zKTtcblxuXHRcdC8vIG5vZGUgaW5zcGVjdFxuXHRcdGxldCBoX2luc3BlY3QgPSB0aGlzLm9wdGlvbnMuaW5zcGVjdDtcblx0XHRpZihoX2luc3BlY3QpIHtcblx0XHRcdC8vIGluc3BlY3QgcmFuZ2Vcblx0XHRcdGlmKGhfaW5zcGVjdC5yYW5nZSAmJiBoX2luc3BlY3QucmFuZ2VbMF0gPD0gaF9pbnNwZWN0LnJhbmdlWzFdKSB7XG5cdFx0XHRcdGxldCBpX2luc3BlY3QgPSBoX2luc3BlY3QucmFuZ2VbMF07XG5cdFx0XHRcdGxldCBhX25vZGVfYXJncyA9IGhfb3B0aW9ucy5ub2RlX2FyZ3MgPSBoX29wdGlvbnMubm9kZV9hcmdzPyBoX29wdGlvbnMubm9kZV9hcmdzLnNsaWNlKDApOiBbXTtcblx0XHRcdFx0YV9ub2RlX2FyZ3MucHVzaCgnLS1pbnNwZWN0JysoaF9pbnNwZWN0LmJyayB8fCBoX2luc3BlY3QuYnJlYWs/ICctYnJrJzogJycpKyc9JysoaF9pbnNwZWN0LnJhbmdlWzBdKyspKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgbmV3IHdvcmtlclxuXHRcdGxldCBrX3dvcmtlciA9IG5ldyB3b3JrZXIoe1xuXHRcdFx0c291cmNlOiB0aGlzLnNvdXJjZSxcblx0XHRcdGlkOiBhX3dvcmtlcnMubGVuZ3RoLFxuXHRcdFx0bWFzdGVyOiB0aGlzLFxuXHRcdFx0b3B0aW9uczogT2JqZWN0LmFzc2lnbihoX29wdGlvbnMsIHtcblx0XHRcdFx0YXJnczogW1N0cmluZy5mcm9tQ2hhckNvZGUoNjUrYV93b3JrZXJzLmxlbmd0aCksIC4uLihoX29wdGlvbnMuYXJncyB8fCBbXSldLFxuXHRcdFx0fSksXG5cdFx0fSk7XG5cblx0XHQvLyBhZGQgdG8gcG9vbFxuXHRcdGFfd29ya2Vycy5wdXNoKGtfd29ya2VyKTtcblxuXHRcdC8vIHByZXRlbmQgaXRzIG5vdCBhdmFpbGFibGUgZm9yIHN5bmNlZCBtYXBwaW5nIG9mIHJ1blxuXHRcdGtfd29ya2VyLmJ1c3kgPSB0cnVlO1xuXG5cdFx0Ly8gaXQncyBhY3R1YWxseSBhdmFpbGFibGUgdGhvdWdoIDspXG5cdFx0cmV0dXJuIGtfd29ya2VyO1xuXHR9XG5cblx0c3VtbW9uKCkge1xuXHRcdGxldCBhX3dvcmtlcnMgPSB0aGlzLndvcmtlcnM7XG5cblx0XHQvLyBlYWNoIHdvcmtlclxuXHRcdGZvcihsZXQga193b3JrZXIgb2YgYV93b3JrZXJzKSB7XG5cdFx0XHQvLyB3b3JrZXIgbm90IGJ1c3lcblx0XHRcdGlmKCFrX3dvcmtlci5idXN5KSB7XG5cdFx0XHRcdHJldHVybiBrX3dvcmtlcjtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyByb29tIHRvIGdyb3dcblx0XHRpZihhX3dvcmtlcnMubGVuZ3RoIDwgdGhpcy5saW1pdCkge1xuXHRcdFx0cmV0dXJuIHRoaXMuc3Bhd25fd29ya2VyKCk7XG5cdFx0fVxuXG5cdFx0Ly8gcXVldWUgZm9yIG5vdGlmaWNhdGlvbiB3aGVuIHdvcmtlcnMgYmVjb21lIGF2YWlsYWJsZVxuXHRcdHJldHVybiBuZXcgUHJvbWlzZSgoZmtfd29ya2VyKSA9PiB7XG5cdFx0XHR0aGlzLndhaXRfbGlzdC5wdXNoKChrX3dvcmtlcikgPT4ge1xuXHRcdFx0XHRma193b3JrZXIoa193b3JrZXIpO1xuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH1cblxuXHRydW4oc190YXNrLCBhX2FyZ3MsIGhfZXZlbnRzKSB7XG5cdFx0bGV0IGRwX3J1biA9IG5ldyBQcm9taXNlKGFzeW5jKGZrX3J1biwgZmVfcnVuKSA9PiB7XG5cdFx0XHQvLyBzdW1tb24gYSB3b3JrZXJcblx0XHRcdGxldCBrX3dvcmtlciA9IGF3YWl0IHRoaXMuc3VtbW9uKCk7XG5cblx0XHRcdC8vIHJ1biB0aGlzIHRhc2tcblx0XHRcdGxldCB6X3Jlc3VsdDtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdHpfcmVzdWx0ID0gYXdhaXQga193b3JrZXIucnVuKHNfdGFzaywgYV9hcmdzLCBoX2V2ZW50cyk7XG5cdFx0XHR9XG5cdFx0XHQvLyBlcnJvciB3aGlsZSBydW5uaW5nIHRhc2tcblx0XHRcdGNhdGNoKGVfcnVuKSB7XG5cdFx0XHRcdHJldHVybiBmZV9ydW4oZV9ydW4pO1xuXHRcdFx0fVxuXHRcdFx0Ly8gd29ya2VyIGlzIGF2YWlsYWJsZSBub3dcblx0XHRcdGZpbmFsbHkge1xuXHRcdFx0XHRsZXQgYV93YWl0X2xpc3QgPSB0aGlzLndhaXRfbGlzdDtcblxuXHRcdFx0XHQvLyBhdCBsZWFzdCBvbmUgdGFzayBpcyBxdWV1ZWRcblx0XHRcdFx0aWYoYV93YWl0X2xpc3QubGVuZ3RoKSB7XG5cdFx0XHRcdFx0YV93YWl0X2xpc3Quc2hpZnQoKShrX3dvcmtlcik7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gcmVzb2x2ZSBwcm9taXNlXG5cdFx0XHRma19ydW4oel9yZXN1bHQpO1xuXHRcdH0pO1xuXG5cdFx0dGhpcy5oaXN0b3J5LnB1c2goZHBfcnVuKTtcblx0XHRyZXR1cm4gZHBfcnVuO1xuXHR9XG5cblx0YXN5bmMga2lsbChzX3NpZ25hbCkge1xuXHRcdHJldHVybiBhd2FpdCBQcm9taXNlLmFsbCh0aGlzLndvcmtlcnMubWFwKChrX3dvcmtlcikgPT4ga193b3JrZXIua2lsbChzX3NpZ25hbCkpKTtcblx0fVxuXG5cdHN0YXJ0KCkge1xuXHRcdHRoaXMuaGlzdG9yeS5sZW5ndGggPSAwO1xuXHR9XG5cblx0YXN5bmMgc3RvcCgpIHtcblx0XHQvLyBjYWNoZSBoaXN0b3J5XG5cdFx0bGV0IGFfaGlzdG9yeSA9IHRoaXMuaGlzdG9yeTtcblxuXHRcdC8vIHJlc2V0IHN0YXJ0IHBvaW50XG5cdFx0dGhpcy5zdGFydCgpO1xuXG5cdFx0Ly8gYXdhaXQgYWxsIHByb21pc2VzIHRvIGZpbmlzaFxuXHRcdHJldHVybiBhd2FpdCBQcm9taXNlLmFsbChhX2hpc3RvcnkpO1xuXHR9XG5cbn07XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oZGNfd29ya2VyKSB7XG5cdHdvcmtlciA9IGRjX3dvcmtlcjtcblx0cmV0dXJuIHBvb2w7XG59O1xuXG4iLCJjb25zdCBtYW5pZmVzdCA9IHJlcXVpcmUoJy4vbWFuaWZlc3QuanMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBjbGFzcyByZXN1bHQgZXh0ZW5kcyBtYW5pZmVzdCB7XG5cdHN0YXRpYyBmcm9tKHpfaXRlbSkge1xuXHRcdGlmKHpfaXRlbSBpbnN0YW5jZW9mIHJlc3VsdCkge1xuXHRcdFx0cmV0dXJuIHpfaXRlbTtcblx0XHR9XG5cdFx0ZWxzZSB7XG5cdFx0XHRyZXR1cm4gbmV3IHJlc3VsdCh6X2l0ZW0pO1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0cnVjdG9yKHpfcmVzdWx0LCB6X3RyYW5zZmVyX3BhdGhzPXRydWUpIHtcblx0XHQvLyB0cmFuc2ZlciBwYXRocyBuZWVkcyB0byBiZSBwcmVwZW5kZWQgd2l0aCB6ZXJvIGluZGV4XG5cdFx0aWYoQXJyYXkuaXNBcnJheSh6X3RyYW5zZmVyX3BhdGhzKSkge1xuXHRcdFx0el90cmFuc2Zlcl9wYXRocy5mb3JFYWNoKGEgPT4gYS51bnNoaWZ0KDApKTtcblx0XHR9XG5cblx0XHRzdXBlcihbel9yZXN1bHRdLCB6X3RyYW5zZmVyX3BhdGhzKTtcblx0fVxuXG5cdHByZXBlbmQoKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKCdjYW5ub3QgcHJlcGVuZCBhIHJlc3VsdCcpO1xuXHR9XG59O1xuIiwiY29uc3QgZXZlbnRzID0gcmVxdWlyZSgnLi9ldmVudHMuanMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBjbGFzcyBjaGFubmVsIGV4dGVuZHMgTWVzc2FnZUNoYW5uZWwge1xuXHRzdGF0aWMgYmV0d2Vlbihrd19zZW5kZXIsIGt3X3JlY2VpdmVyKSB7XG5cdFx0bGV0IGRfY2hhbm5lbCA9IGt3X3NlbmRlci5jaGFubmVscy5nZXQoa3dfcmVjZWl2ZXIpO1xuXHRcdGlmKGRfY2hhbm5lbCkgcmV0dXJuIGRfY2hhbm5lbDtcblx0XHRyZXR1cm4gbmV3IGNoYW5uZWwoa3dfc2VuZGVyLCBrd19yZWNlaXZlcik7XG5cdH1cblxuXHRwb3J0XzEoKSB7XG5cdFx0cmV0dXJuIGV2ZW50cyh0aGlzLnBvcnQxKTtcblx0fVxuXG5cdHBvcnRfMigpIHtcblx0XHRyZXR1cm4gZXZlbnRzKHRoaXMucG9ydDIpO1xuXHR9XG59O1xuIiwibW9kdWxlLmV4cG9ydHMgPSAoZHpfdGhpbmcpID0+IHtcblx0T2JqZWN0LmFzc2lnbihkel90aGluZywge1xuXHRcdG9uKC4uLmFfYXJncykge1xuXHRcdFx0Ly8gc2luZ2xlIGV2ZW50XG5cdFx0XHRpZigyID09PSBhX2FyZ3MubGVuZ3RoKSB7XG5cdFx0XHRcdHRoaXNbJ29uJythX2FyZ3NbMF1dID0gYV9hcmdzWzFdO1xuXHRcdFx0fVxuXHRcdFx0Ly8gbXVsdGlwbGUgZXZlbnRzXG5cdFx0XHRlbHNlIGlmKDEgPT09IGFfYXJncy5sZW5ndGggJiYgJ29iamVjdCcgPT09IHR5cGVvZiBhX2FyZ3NbMF0pIHtcblx0XHRcdFx0bGV0IGhfZXZlbnRzID0gYV9hcmdzWzBdO1xuXHRcdFx0XHRmb3IobGV0IHNfZXZlbnQgaW4gaF9ldmVudHMpIHtcblx0XHRcdFx0XHR0aGlzWydvbicrc19ldmVudF0gPSBoX2V2ZW50c1tzX2V2ZW50XTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0Ly8gbm9wZVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcignbWlzdXNlIG9mIG9uIGJpbmRpbmcnKTtcblx0XHRcdH1cblx0XHR9LFxuXG5cdFx0cmVtb3ZlTGlzdGVuZXIoc19ldmVudCkge1xuXHRcdFx0dGhpcy5yZW1vdmVFdmVudExpc3RlbmVyKHNfZXZlbnQsIHRoaXNbJ29uJytzX2V2ZW50XSk7XG5cdFx0fSxcblx0fSk7XG5cblx0cmV0dXJuIGR6X3RoaW5nO1xufTtcbiIsImNvbnN0IHtcblx0S19TRUxGLFxuXHR3ZWJ3b3JrZXJpZnksXG59ID0gcmVxdWlyZSgnLi4vYWxsL2xvY2Fscy5qcycpO1xuXG5jb25zdCBldmVudHMgPSByZXF1aXJlKCcuL2V2ZW50cy5qcycpO1xuXG5sZXQgaV9zdWJ3b3JrZXJfc3Bhd24gPSAxO1xubGV0IGhfc3Vid29ya2VycyA9IHt9O1xuXG5jbGFzcyBsYXRlbnRfc3Vid29ya2VyIHtcblx0c3RhdGljIGNvbm5lY3QoaF9tc2cpIHtcblx0XHRoX3N1YndvcmtlcnNbaF9tc2cuaWRdLmNvbm5lY3QoaF9tc2cpO1xuXHR9XG5cblx0Y29uc3RydWN0b3IoKSB7XG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRpZDogaV9zdWJ3b3JrZXJfc3Bhd24sXG5cdFx0XHRtZXNzYWdlczogW10sXG5cdFx0XHRtYXN0ZXJfa2V5OiAwLFxuXHRcdFx0cG9ydDogbnVsbCxcblx0XHR9KTtcblxuXHRcdGhfc3Vid29ya2Vyc1tpX3N1Yndvcmtlcl9zcGF3bisrXSA9IHRoaXM7XG5cdH1cblxuXHRjb25uZWN0KGhfbXNnKSB7XG5cdFx0bGV0IHtcblx0XHRcdG1hc3Rlcl9rZXk6IGlfbWFzdGVyLFxuXHRcdFx0cG9ydDogZF9wb3J0LFxuXHRcdH0gPSBoX21zZztcblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0bWFzdGVyX2tleTogaV9tYXN0ZXIsXG5cdFx0XHRwb3J0OiBkX3BvcnQsXG5cdFx0fSk7XG5cblx0XHQvLyBiaW5kIGV2ZW50c1xuXHRcdGRfcG9ydC5vbm1lc3NhZ2UgPSAoLi4uYV9hcmdzKSA9PiB7XG5cdFx0XHR0aGlzLm9ubWVzc2FnZSguLi5hX2FyZ3MpO1xuXHRcdH07XG5cdFx0ZF9wb3J0Lm9ubWVzc2FnZWVycm9yID0gKC4uLmFfYXJncykgPT4ge1xuXHRcdFx0dGhpcy5vbm1lc3NhZ2VlcnJvciguLi5hX2FyZ3MpO1xuXHRcdH07XG5cblx0XHQvLyBwcm9jZXNzIG1lc3NhZ2UgcXVldWVcblx0XHR3aGlsZSh0aGlzLm1lc3NhZ2VzLmxlbmd0aCkge1xuXHRcdFx0ZF9wb3J0LnBvc3RNZXNzYWdlKC4uLnRoaXMubWVzc2FnZXMuc2hpZnQoKSk7XG5cdFx0fVxuXHR9XG5cblx0cG9zdE1lc3NhZ2UoLi4uYV9hcmdzKSB7XG5cdFx0aWYodGhpcy5wb3J0KSB7XG5cdFx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2UoLi4uYV9hcmdzKTtcblx0XHR9XG5cdFx0ZWxzZSB7XG5cdFx0XHR0aGlzLm1lc3NhZ2VzLnB1c2goYV9hcmdzKTtcblx0XHR9XG5cdH1cblxuXHRvbm1lc3NhZ2UoKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKCdyZWNlaXZlZCBtZXNzYWdlIGZyb20gc3Vid29ya2VyIGJlZm9yZSBpdHMgcG9ydCB3YXMgY29ubmVjdGVkJyk7XG5cdH1cblxuXHRvbm1lc3NhZ2VlcnJvcigpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ3JlY2VpdmVkIG1lc3NhZ2UgZXJyb3IgZnJvbSBzdWJ3b3JrZXIgYmVmb3JlIGl0cyBwb3J0IHdhcyBjb25uZWN0ZWQnKTtcblx0fVxuXG5cdHRlcm1pbmF0ZSgpIHtcblx0XHR0aGlzLnBvcnQuY2xvc2UoKTtcblx0XHRLX1NFTEYucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0dHlwZTogJ3Rlcm1pbmF0ZScsXG5cdFx0XHRtYXN0ZXJfa2V5OiB0aGlzLm1hc3Rlcl9rZXksXG5cdFx0fSk7XG5cdH1cblxuXHR3ZWJ3b3JrZXJpZnkoel9pbXBvcnQsIGFfYnJvd3NlcmlmeSwgaF9vcHRpb25zPXt9KSB7XG5cdFx0bGV0IHNfc291cmNlID0gd2Vid29ya2VyaWZ5KHpfaW1wb3J0LCBhX2Jyb3dzZXJpZnksIGhfb3B0aW9ucyk7XG5cblx0XHRLX1NFTEYucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0dHlwZTogJ3NwYXduJyxcblx0XHRcdHNvdXJjZTogc19zb3VyY2UsXG5cdFx0XHRvcHRpb25zOiBoX29wdGlvbnMsXG5cdFx0fSk7XG5cdH1cbn1cblxuZXZlbnRzKGxhdGVudF9zdWJ3b3JrZXIucHJvdG90eXBlKTtcblxubW9kdWxlLmV4cG9ydHMgPSBsYXRlbnRfc3Vid29ya2VyO1xuIiwibW9kdWxlLmV4cG9ydHMgPSB7XG5cdEtfU0VMRjogcmVxdWlyZSgnLi9zZWxmLmpzJyksXG5cdERDX1dPUktFUjogJ3VuZGVmaW5lZCcgPT09IHR5cGVvZiBXb3JrZXI/IHVuZGVmaW5lZDogcmVxdWlyZSgnLi93b3JrZXIuanMnKSxcblx0RENfQ0hBTk5FTDogcmVxdWlyZSgnLi9jaGFubmVsLmpzJyksXG5cdEhfVFlQRURfQVJSQVlTOiByZXF1aXJlKCcuL3R5cGVkLWFycmF5cy5qcycpLFxuXHROX0NPUkVTOiBuYXZpZ2F0b3IuaGFyZHdhcmVDb25jdXJyZW5jeSB8fCAxLFxuXHRzaGFyaW5nOiByZXF1aXJlKCcuL3NoYXJpbmcuanMnKSxcblx0c3RyZWFtOiByZXF1aXJlKCcuL3N0cmVhbS5qcycpLFxuXHRwb3J0czogcmVxdWlyZSgnLi9wb3J0cy5qcycpLFxufTtcbiIsImNvbnN0IGV2ZW50cyA9IHJlcXVpcmUoJy4vZXZlbnRzLmpzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gKGRfcG9ydCkgPT4gZXZlbnRzKGRfcG9ydCk7XG4iLCJjb25zdCBldmVudHMgPSByZXF1aXJlKCcuL2V2ZW50cy5qcycpO1xuXG5ldmVudHMoc2VsZik7XG5cbnNlbGYuYXJncyA9IFtcblx0KE1hdGgucmFuZG9tKCkrJycpLnNsaWNlKDIsIDgpLFxuXTtcblxubW9kdWxlLmV4cG9ydHMgPSBzZWxmO1xuIiwiY29uc3Qgc3RyZWFtID0gcmVxdWlyZSgnLi9zdHJlYW0uanMnKTtcblxuY29uc3QgJF9TSEFSRUFCTEUgPSBTeW1ib2woJ3NoYXJlYWJsZScpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IE9iamVjdC5hc3NpZ24oZnVuY3Rpb24oel9vYmplY3QpIHtcblx0cmV0dXJuICdvYmplY3QnID09PSB0eXBlb2Ygel9vYmplY3QgJiZcblx0XHQoQXJyYXlCdWZmZXIuaXNWaWV3KHpfb2JqZWN0KVxuXHRcdFx0fHwgel9vYmplY3QgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlclxuXHRcdFx0fHwgel9vYmplY3QgaW5zdGFuY2VvZiBNZXNzYWdlUG9ydFxuXHRcdFx0fHwgel9vYmplY3QgaW5zdGFuY2VvZiBJbWFnZUJpdG1hcFxuXHRcdFx0fHwgJF9TSEFSRUFCTEUgaW4gel9vYmplY3QpO1xufSwge1xuXHQkX1NIQVJFQUJMRSxcblxuXHRleHRyYWN0OiBmdW5jdGlvbiBleHRyYWN0KHpfZGF0YSwgYXNfdHJhbnNmZXJzPW51bGwpIHtcblx0XHQvLyBwcm90ZWN0IGFnYWluc3QgW29iamVjdF0gbnVsbFxuXHRcdGlmKCF6X2RhdGEpIHJldHVybiBbel9kYXRhLCBbXV07XG5cblx0XHQvLyBzZXQgb2YgdHJhbnNmZXIgb2JqZWN0c1xuXHRcdGlmKCFhc190cmFuc2ZlcnMpIGFzX3RyYW5zZmVycyA9IG5ldyBTZXQoKTtcblxuXHRcdC8vIG9iamVjdFxuXHRcdGlmKCdvYmplY3QnID09PSB0eXBlb2Ygel9kYXRhKSB7XG5cdFx0XHQvLyBwbGFpbiBvYmplY3QgbGl0ZXJhbFxuXHRcdFx0aWYoT2JqZWN0ID09PSB6X2RhdGEuY29uc3RydWN0b3IpIHtcblx0XHRcdFx0Ly8gc2NhbiBvdmVyIGVudW1lcmFibGUgcHJvcGVydGllc1xuXHRcdFx0XHRmb3IobGV0IHNfcHJvcGVydHkgaW4gel9kYXRhKSB7XG5cdFx0XHRcdFx0Ly8gYWRkIGVhY2ggdHJhbnNmZXJhYmxlIGZyb20gcmVjdXJzaW9uIHRvIG93biBzZXRcblx0XHRcdFx0XHRleHRyYWN0KHpfZGF0YVtzX3Byb3BlcnR5XSwgYXNfdHJhbnNmZXJzKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0Ly8gYXJyYXlcblx0XHRcdGVsc2UgaWYoQXJyYXkuaXNBcnJheSh6X2RhdGEpKSB7XG5cdFx0XHRcdC8vIHNjYW4gb3ZlciBlYWNoIGl0ZW1cblx0XHRcdFx0el9kYXRhLmZvckVhY2goKHpfaXRlbSkgPT4ge1xuXHRcdFx0XHRcdC8vIGFkZCBlYWNoIHRyYW5zZmVyYWJsZSBmcm9tIHJlY3Vyc2lvbiB0byBvd24gc2V0XG5cdFx0XHRcdFx0ZXh0cmFjdCh6X2l0ZW0sIGFzX3RyYW5zZmVycyk7XG5cdFx0XHRcdH0pO1xuXHRcdFx0fVxuXHRcdFx0Ly8gdHlwZWQgYXJyYXksIGRhdGEgdmlldyBvciBhcnJheSBidWZmZXJcblx0XHRcdGVsc2UgaWYoQXJyYXlCdWZmZXIuaXNWaWV3KHpfZGF0YSkpIHtcblx0XHRcdFx0YXNfdHJhbnNmZXJzLmFkZCh6X2RhdGEuYnVmZmVyKTtcblx0XHRcdH1cblx0XHRcdC8vIGFycmF5IGJ1ZmZlclxuXHRcdFx0ZWxzZSBpZih6X2RhdGEgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0XHRhc190cmFuc2ZlcnMuYWRkKHpfZGF0YSk7XG5cdFx0XHR9XG5cdFx0XHQvLyBtZXNzYWdlIHBvcnRcblx0XHRcdGVsc2UgaWYoel9kYXRhIGluc3RhbmNlb2YgTWVzc2FnZVBvcnQpIHtcblx0XHRcdFx0YXNfdHJhbnNmZXJzLmFkZCh6X2RhdGEpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gaW1hZ2UgYml0bWFwXG5cdFx0XHRlbHNlIGlmKHpfZGF0YSBpbnN0YW5jZW9mIEltYWdlQml0bWFwKSB7XG5cdFx0XHRcdGFzX3RyYW5zZmVycy5hZGQoel9kYXRhKTtcblx0XHRcdH1cblx0XHRcdC8vIHN0cmVhbVxuXHRcdFx0ZWxzZSBpZihzdHJlYW0uaXNfc3RyZWFtKHpfZGF0YSkpIHtcblx0XHRcdFx0bGV0IGFfdHJhbnNmZXJzID0gW107XG5cdFx0XHRcdFt6X2RhdGEsIGFfdHJhbnNmZXJzXSA9IHN0cmVhbS5zZXJpYWxpemUoel9kYXRhKTtcblx0XHRcdFx0YXNfdHJhbnNmZXJzLmFkZChhX3RyYW5zZmVycyk7XG5cdFx0XHR9XG5cdFx0XHQvLyBzaGFyZWFibGVcblx0XHRcdGVsc2UgaWYoJF9TSEFSRUFCTEUgaW4gel9kYXRhKSB7XG5cdFx0XHRcdGxldCBhX3RyYW5zZmVycyA9IFtdO1xuXHRcdFx0XHRbel9kYXRhLCBhX3RyYW5zZmVyc10gPSB6X2RhdGFbJF9TSEFSRUFCTEVdKCk7XG5cdFx0XHRcdGFzX3RyYW5zZmVycy5hZGQoYV90cmFuc2ZlcnMpO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBmdW5jdGlvblxuXHRcdGVsc2UgaWYoJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIHpfZGF0YSkge1xuXHRcdFx0Ly8gc2NhbiBvdmVyIGVudW1lcmFibGUgcHJvcGVydGllc1xuXHRcdFx0Zm9yKGxldCBzX3Byb3BlcnR5IGluIHpfZGF0YSkge1xuXHRcdFx0XHQvLyBhZGQgZWFjaCB0cmFuc2ZlcmFibGUgZnJvbSByZWN1cnNpb24gdG8gb3duIHNldFxuXHRcdFx0XHRleHRyYWN0KHpfZGF0YVtzX3Byb3BlcnR5XSwgYXNfdHJhbnNmZXJzKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gbm90aGluZ1xuXHRcdGVsc2Uge1xuXHRcdFx0cmV0dXJuIFt6X2RhdGEsIFtdXTtcblx0XHR9XG5cblx0XHQvLyBjb252ZXJ0IHNldCB0byBhcnJheVxuXHRcdHJldHVybiBbel9kYXRhLCBBcnJheS5mcm9tKGFzX3RyYW5zZmVycyldO1xuXHR9LFxuXG5cdHBvcHVsYXRlKGhfbXNnKSB7XG5cdFx0bGV0IHtcblx0XHRcdGRhdGE6IGhfZGF0YSxcblx0XHRcdHRyYW5zZmVyczogYV90cmFuc2ZlcnMsXG5cdFx0fSA9IGhfbXNnO1xuXG5cdFx0Ly8gZWFjaCB0cmFuc2ZlclxuXHRcdGFfdHJhbnNmZXJzLmZvckVhY2goKGhfdHJhbnNmZXIpID0+IHtcblx0XHRcdC8vIHBhdGggdG8gb2JqZWN0XG5cdFx0XHRsZXQgYV9wYXRoID0gaF90cmFuc2Zlci5wYXRoO1xuXG5cdFx0XHQvLyB3YWxrIHBhdGhcblx0XHRcdGxldCB6X3dhbGsgPSBoX2hlYWQ7XG5cdFx0XHRsZXQgbmxfcGF0aCA9IGFfcGF0aC5sZW5ndGg7XG5cdFx0XHRhX3BhdGguZm9yRWFjaCgoc19zdGVwLCBpX3N0ZXApID0+IHtcblx0XHRcdFx0Ly8gZmluYWwgc3RlcFxuXHRcdFx0XHRpZihpX3N0ZXAgPT09IG5sX3BhdGgtMSkge1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gbm8gc3VjaCBzdGVwXG5cdFx0XHRcdGlmKCEoc19zdGVwIGluIHpfd2FsaykpIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYG5vIHN1Y2gga2V5ICcke3Nfc3RlcH0nIGZvdW5kIHdoaWxlIHdhbGtpbmcgcGF0aCBhbG9uZyAuJHthX3BhdGguam9pbignLicpfWApO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gdGFrZSBzdGVwXG5cdFx0XHRcdHpfd2FsayA9IHpfd2Fsa1tzX3N0ZXBdO1xuXHRcdFx0fSk7XG5cdFx0fSk7XG5cblx0XHQvLyBzdHJlYW0gb2JqZWN0XG5cdH0sXG59KTtcbiIsImNvbnN0IG5vZGVfZXZlbnRzID0gcmVxdWlyZSgnZXZlbnRzJyk7XG5cbmNvbnN0IHNoYXJpbmcgPSByZXF1aXJlKCcuL3NoYXJpbmcuanMnKTtcblxuY2xhc3MgcmVhZGFibGVfc3RyZWFtIGV4dGVuZHMgbm9kZV9ldmVudHMuRXZlbnRFbWl0dGVyIHtcblx0Y29uc3RydWN0b3IoKSB7XG5cdFx0c3VwZXIoKTtcblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0ZGVjb2RlcjogbnVsbCxcblx0XHRcdHBhdXNlZDogZmFsc2UsXG5cdFx0XHRjb25zdW1lZDogMCxcblx0XHR9KTtcblx0fVxuXG5cdHNldEVuY29kaW5nKHNfZW5jb2RpbmcpIHtcblx0XHR0aGlzLmRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoc19lbmNvZGluZyk7XG5cdH1cblxuXHRwYXVzZSgpIHtcblx0XHR0aGlzLnBhdXNlZCA9IHRydWU7XG5cdH1cblxuXHRyZXN1bWUoKSB7XG5cdFx0dGhpcy5wYXVzZWQgPSBmYWxzZTtcblx0XHR0aGlzLm5leHRfY2h1bmsoKTtcblx0fVxuXG5cdGNodW5rKGF0X2NodW5rLCBiX2VvZikge1xuXHRcdGxldCBubF9jaHVuayA9IGF0X2NodW5rLmxlbmd0aDtcblx0XHR0aGlzLmNvbnN1bWVkICs9IG5sX2NodW5rO1xuXG5cdFx0Ly8gZGVjb2RlIGRhdGFcblx0XHRpZih0aGlzLmRlY29kZXIpIHtcblx0XHRcdGxldCBzX2RhdGE7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRzX2RhdGEgPSB0aGlzLmRlY29kZXIuZGVjb2RlKGF0X2NodW5rLCB7c3RyZWFtOiFiX2VvZn0pO1xuXHRcdFx0fVxuXHRcdFx0Y2F0Y2goZV9kZWNvZGUpIHtcblx0XHRcdFx0dGhpcy5lbWl0KCdlcnJvcicsIGVfZGVjb2RlKTtcblx0XHRcdH1cblxuXHRcdFx0dGhpcy5lbWl0KCdkYXRhJywgc19kYXRhLCBhdF9jaHVuayk7XG5cdFx0fVxuXHRcdC8vIG5vIGVuY29kaW5nXG5cdFx0ZWxzZSB7XG5cdFx0XHR0aGlzLmVtaXQoJ2RhdGEnLCBhdF9jaHVuaywgYXRfY2h1bmspO1xuXHRcdH1cblxuXHRcdC8vIGVuZCBvZiBmaWxlXG5cdFx0aWYoYl9lb2YpIHtcblx0XHRcdHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHR0aGlzLmVtaXQoJ2VuZCcpO1xuXHRcdFx0fSwgMCk7XG5cdFx0fVxuXHRcdC8vIHJlcXVlc3QgbW9yZSBkYXRhXG5cdFx0ZWxzZSBpZighdGhpcy5wYXVzZWQpIHtcblx0XHRcdHRoaXMubmV4dF9jaHVuaygpO1xuXHRcdH1cblx0fVxufVxuXG5PYmplY3QuYXNzaWduKHJlYWRhYmxlX3N0cmVhbS5wcm90b3R5cGUsIHtcblx0ZW1pdHNCeXRlQ291bnRzOiB0cnVlLFxufSk7XG5cbmNsYXNzIHJlYWRhYmxlX3N0cmVhbV92aWFfcG9ydCBleHRlbmRzIHJlYWRhYmxlX3N0cmVhbSB7XG5cdGNvbnN0cnVjdG9yKGRfcG9ydCkge1xuXHRcdHN1cGVyKCk7XG5cblx0XHQvLyBtZXNzYWdlIGhhbmRsaW5nXG5cdFx0ZF9wb3J0Lm9ubWVzc2FnZSA9IChkX21zZykgPT4ge1xuXHRcdFx0bGV0IHtcblx0XHRcdFx0Y29udGVudDogYXRfY29udGVudCxcblx0XHRcdFx0ZW9mOiBiX2VvZixcblx0XHRcdH0gPSBkX21zZy5kYXRhO1xuXG5cdFx0XHQvLyBzdGFydCB0aW1pbmdcblx0XHRcdHRoaXMuc3RhcnRlZCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuXG5cdFx0XHQvLyBwcm9jZXNzIGNodW5rXG5cdFx0XHR0aGlzLmNodW5rKGF0X2NvbnRlbnQsIGJfZW9mKTtcblx0XHR9O1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRwb3J0OiBkX3BvcnQsXG5cdFx0XHRzdGFydGVkOiAwLFxuXHRcdH0pO1xuXHR9XG5cblx0c2V0RW5jb2Rpbmcoc19lbmNvZGluZykge1xuXHRcdHRoaXMuZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcihzX2VuY29kaW5nKTtcblx0fVxuXG5cdG5leHRfY2h1bmsoKSB7XG5cdFx0bGV0IHRfZWxhcHNlZCA9IHBlcmZvcm1hbmNlLm5vdygpIC0gdGhpcy5zdGFydGVkO1xuXG4vLyBjb25zb2xlLmxvZygnUyA9PT4gW0FDSyAvIG5leHQgY2h1bmtdJyk7XG5cblx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0cG9zdGVkOiBwZXJmb3JtYW5jZS5ub3coKSxcblx0XHRcdGVsYXBzZWQ6IHRfZWxhcHNlZCxcblx0XHR9KTtcblx0fVxuXG5cdC8vIHBhdXNlKCkge1xuXG5cdC8vIH1cblxuXHQvLyByZXN1bWUoYl9kb250X3VucGF1c2U9ZmFsc2UpIHtcblx0Ly8gXHRsZXQgdF9lbGFwc2VkID0gcGVyZm9ybWFuY2Uubm93KCkgLSB0aGlzLnN0YXJ0ZWQ7XG5cblx0Ly8gXHRzZWxmLnBvc3RNZXNzYWdlKHtcblx0Ly8gXHRcdGVsYXBzZWQ6IHRfZWxhcHNlZCxcblx0Ly8gXHR9KTtcblx0Ly8gfVxuXG5cdC8vIHBpcGUoeV93cml0YWJsZSkge1xuXHQvLyBcdHRoaXMub24oJ2RhdGEnLCAoel9jaHVuaykgPT4ge1xuXHQvLyBcdFx0bGV0IGJfY2FwYWNpdHkgPSB5X3dyaXRhYmxlLndyaXRlKHpfY2h1bmspO1xuXG5cdC8vIFx0XHQvLyBmZXRjaCBuZXh0IGNodW5rOyBvdGhlcndpc2UgYXdhaXQgZHJhaW5cblx0Ly8gXHRcdGlmKGZhbHNlICE9PSBiX2NhcGFjaXR5KSB7XG5cdC8vIFx0XHRcdHRoaXMucmVzdW1lKHRydWUpO1xuXHQvLyBcdFx0fVxuXHQvLyBcdH0pO1xuXG5cdC8vIFx0eV93cml0YWJsZS5vbignZHJhaW4nLCAoKSA9PiB7XG5cdC8vIFx0XHR0aGlzLnJlc3VtZSh0cnVlKTtcblx0Ly8gXHR9KTtcblxuXHQvLyBcdHlfd3JpdGFibGUuZW1pdCgncGlwZScsIHRoaXMpO1xuXHQvLyB9XG59XG5cblxuXG5jbGFzcyByZWFkYWJsZV9zdHJlYW1fdmlhX29iamVjdF91cmwgZXh0ZW5kcyByZWFkYWJsZV9zdHJlYW0ge1xuXHRjb25zdHJ1Y3RvcihwX29iamVjdF91cmwsIGhfY29uZmlnPXt9KSB7XG5cdFx0c3VwZXIoKTtcblxuXHRcdGZldGNoKHBfb2JqZWN0X3VybClcblx0XHRcdC50aGVuKGRfcmVzID0+IGRfcmVzLmJsb2IoKSlcblx0XHRcdC50aGVuKChkZmJfaW5wdXQpID0+IHtcblx0XHRcdFx0aWYodGhpcy5vbmJsb2IpIHRoaXMub25ibG9iKGRmYl9pbnB1dCk7XG5cdFx0XHRcdGxldCBrX2Jsb2JfcmVhZGVyID0gdGhpcy5ibG9iX3JlYWRlciA9IG5ldyBibG9iX3JlYWRlcih0aGlzLCBkZmJfaW5wdXQsIGhfY29uZmlnKTtcblx0XHRcdFx0dGhpcy5vbignZW5kJywgKCkgPT4ge1xuXHRcdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0XHRcdFVSTC5yZXZva2VPYmplY3RVUkwocF9vYmplY3RfdXJsKTtcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGtfYmxvYl9yZWFkZXIubmV4dF9jaHVuaygpO1xuXHRcdFx0fSk7XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdGJsb2JfcmVhZGVyOiBudWxsLFxuXHRcdFx0b2JqZWN0X3VybDogcF9vYmplY3RfdXJsLFxuXHRcdH0pO1xuXHR9XG5cblx0bmV4dF9jaHVuaygpIHtcblx0XHR0aGlzLmJsb2JfcmVhZGVyLm5leHRfY2h1bmsoKTtcblx0fVxuXG5cdC8vIG9uKHNfZXZlbnQsIGZrX2V2ZW50KSB7XG5cdC8vIFx0c3VwZXIub24oc19ldmVudCwgZmtfZXZlbnQpO1xuXG5cdC8vIFx0aWYoJ2RhdGEnID09PSBzX2V2ZW50KSB7XG5cdC8vIFx0XHRpZighdGhpcy5ibG9iKSB7XG5cdC8vIFx0XHRcdHRoaXMub25fYmxvYiA9IHRoaXMucmVzdW1lO1xuXHQvLyBcdFx0fVxuXHQvLyBcdFx0ZWxzZSB7XG5cdC8vIFx0XHRcdHRoaXMucmVzdW1lKCk7XG5cdC8vIFx0XHR9XG5cdC8vIFx0fVxuXHQvLyB9XG59XG5cbmNsYXNzIHRyYW5zZmVyX3N0cmVhbSB7XG5cdGNvbnN0cnVjdG9yKCkge1xuXHRcdGxldCBkX2NoYW5uZWwgPSBuZXcgTWVzc2FnZUNoYW5uZWwoKTtcblx0XHRsZXQgZF9wb3J0ID0gZF9jaGFubmVsLnBvcnQxO1xuXG5cdFx0ZF9wb3J0Lm9ubWVzc2FnZSA9IChkX21zZykgPT4ge1xuXHRcdFx0bGV0IHRfZWxhcHNlZF9tYWluID0gdGhpcy5lbGFwc2VkO1xuXG5cdFx0XHRsZXQge1xuXHRcdFx0XHRwb3N0ZWQ6IHRfcG9zdGVkLFxuXHRcdFx0XHRlbGFwc2VkOiB0X2VsYXBzZWRfb3RoZXIsXG5cdFx0XHR9ID0gZF9tc2cuZGF0YTtcblxuXHRcdFx0Ly8gY29uc29sZS5sb2coJyArKyBwYXJzZTogJyt0X2VsYXBzZWRfb3RoZXIpO1xuXHRcdFx0dGhpcy5yZWNlaXZlcl9lbGFwc2VkICs9IHRfZWxhcHNlZF9vdGhlcjtcblxuLy8gY29uc29sZS5sb2coJ00gPD09IFtBQ0sgLyBuZXh0IGNodW5rXTsgYnVmZmVyOiAnKyghIXRoaXMuYnVmZmVyKSsnOyBidXN5OiAnK3RoaXMucmVjZWl2ZXJfYnVzeSsnOyBlb2Y6Jyt0aGlzLnJlYWRlci5lb2YpOyAgLy9wb3N0ZWQgQCcrdF9wb3N0ZWQpO1xuXG5cdFx0XHQvLyByZWNlaXZlciBpcyBmcmVlXG5cdFx0XHR0aGlzLnJlY2VpdmVyX2J1c3kgPSBmYWxzZTtcblxuXHRcdFx0Ly8gY2h1bmsgcmVhZHkgdG8gZ29cblx0XHRcdGlmKHRoaXMuYnVmZmVyKSB7XG5cdFx0XHRcdHRoaXMuc2VuZCh0aGlzLmJ1ZmZlciwgdGhpcy5idWZmZXJfZW9mKTtcblx0XHRcdFx0dGhpcy5idWZmZXIgPSBudWxsO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyByZWFkZXIgaXMgbm90IGJ1c3lcblx0XHRcdGlmKCF0aGlzLnJlYWRlci5idXN5KSB7XG5cdFx0XHRcdHRoaXMucmVhZGVyLm5leHRfY2h1bmsoKTtcblx0XHRcdH1cblx0XHR9O1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRtYWluX3BvcnQ6IGRfcG9ydCxcblx0XHRcdG90aGVyX3BvcnQ6IGRfY2hhbm5lbC5wb3J0Mixcblx0XHRcdGVsYXBzZWQ6IDAsXG5cdFx0XHRyZWFkZXI6IG51bGwsXG5cdFx0XHRidWZmZXI6IG51bGwsXG5cdFx0XHRidWZmZXJfZW9mOiB0cnVlLFxuXHRcdFx0cmVjZWl2ZXJfYnVzeTogZmFsc2UsXG5cdFx0XHRyZWNlaXZlcl9lbGFwc2VkOiAwLFxuXG5cdFx0XHQvLyBzZXJpYWxpemUgdGhpcyBzdHJlYW1cblx0XHRcdFtzaGFyaW5nLiRfU0hBUkVBQkxFXSgpIHtcblx0XHRcdFx0cmV0dXJuIFt7XG5cdFx0XHRcdFx0dHlwZTogJ3JlYWRhYmxlX3N0cmVhbScsXG5cdFx0XHRcdFx0cG9ydDogdGhpcy5vdGhlcl9wb3J0LFxuXHRcdFx0XHR9LCB0aGlzLm90aGVyX3BvcnRdO1xuXHRcdFx0fSxcblx0XHR9KTtcblx0fVxuXG5cdHNlbmQoYXRfY2h1bmssIGJfZW9mPXRydWUpIHtcblx0XHR0aGlzLnJlY2VpdmVyX2J1c3kgPSB0cnVlO1xuXG4vLyBjb25zb2xlLmxvZygnTSA9PT4gW2NodW5rXScpO1xuXG5cdFx0Ly8gc2VuZCB0byByZWNlaXZlclxuXHRcdHRoaXMubWFpbl9wb3J0LnBvc3RNZXNzYWdlKHtcblx0XHRcdGNvbnRlbnQ6IGF0X2NodW5rLFxuXHRcdFx0ZW9mOiBiX2VvZixcblx0XHR9LCBbYXRfY2h1bmsuYnVmZmVyXSk7XG5cdH1cblxuXHRjaHVuayhhdF9jaHVuaywgYl9lb2Y9dHJ1ZSkge1xuLy8gY29uc29sZS5sb2coJ2Jsb2IgY2h1bmsgcmVhZHkgdG8gc2VuZDsgYnVmZmVyOiAnKyghIXRoaXMuYnVmZmVyKSsnOyBidXN5OiAnK3RoaXMucmVjZWl2ZXJfYnVzeSk7XG5cblx0XHQvLyByZWNlaXZlciBpcyBidXN5LCBxdWV1ZSBpbiBidWZmZXJcblx0XHRpZih0aGlzLnJlY2VpdmVyX2J1c3kpIHtcblx0XHRcdHRoaXMuYnVmZmVyID0gYXRfY2h1bms7XG5cdFx0XHR0aGlzLmJ1ZmZlcl9lb2YgPSBiX2VvZjtcblx0XHR9XG5cdFx0Ly8gcmVjZWl2ZXIgYXZhaWxhYmxlOyBzZW5kIGltbWVkaWF0ZWx5XG5cdFx0ZWxzZSB7XG5cdFx0XHQvLyBwcmVmZXRjaCBuZXh0IGNodW5rXG5cdFx0XHRpZighdGhpcy5idWZmZXIgJiYgIXRoaXMucmVhZGVyLmVvZikge1xuXHRcdFx0XHR0aGlzLnJlYWRlci5uZXh0X2NodW5rKCk7XG5cdFx0XHR9XG5cblx0XHRcdHRoaXMuc2VuZChhdF9jaHVuaywgYl9lb2YpO1xuXHRcdH1cblx0fVxuXG5cdGJsb2IoZGZiX2lucHV0LCBoX2NvbmZpZz17fSkge1xuXHRcdHRoaXMucmVhZGVyID0gbmV3IGJsb2JfcmVhZGVyKHRoaXMsIGRmYl9pbnB1dCwgaF9jb25maWcpO1xuXG5cdFx0Ly8gc3RhcnQgc2VuZGluZ1xuXHRcdHRoaXMucmVhZGVyLm5leHRfY2h1bmsoKTtcblx0fVxufVxuXG5jbGFzcyBibG9iX3JlYWRlciB7XG5cdGNvbnN0cnVjdG9yKGtfcGFyZW50LCBkZmJfaW5wdXQsIGhfY29uZmlnPXt9KSB7XG5cdFx0bGV0IGRmcl9yZWFkZXIgPSBuZXcgRmlsZVJlYWRlcigpO1xuXHRcdGRmcl9yZWFkZXIub25sb2FkID0gKGRfZXZlbnQpID0+IHtcblx0XHRcdHRoaXMuYnVzeSA9IGZhbHNlO1xuXHRcdFx0Ly8gbGV0IGJfZW9mID0gZmFsc2U7XG5cdFx0XHQvLyBpZigrK3RoaXMuY2h1bmtzX3JlYWQgPT09IHRoaXMuY2h1bmtzX2xvYWRlZCkgYl9lb2YgPSB0aGlzLmVvZjtcblx0XHRcdGtfcGFyZW50LmNodW5rKG5ldyBVaW50OEFycmF5KGRfZXZlbnQudGFyZ2V0LnJlc3VsdCksIHRoaXMuZW9mKTtcblx0XHR9O1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRlb2Y6IGZhbHNlLFxuXHRcdFx0YnVzeTogZmFsc2UsXG5cdFx0XHRyZWFkX2luZGV4OiAwLFxuXHRcdFx0Y2h1bmtfc2l6ZTogaF9jb25maWcuY2h1bmtfc2l6ZSB8fCBoX2NvbmZpZy5jaHVua1NpemUgfHwgMTAyNCAqIDEwMjQgKiAxLCAgLy8gMSBNaUJcblx0XHRcdGNvbnRlbnQ6IGRmYl9pbnB1dCxcblx0XHRcdGNvbnRlbnRfbGVuZ3RoOiBkZmJfaW5wdXQuc2l6ZSxcblx0XHRcdGZpbGVfcmVhZGVyOiBkZnJfcmVhZGVyLFxuXHRcdFx0Y2h1bmtzX2xvYWRlZDogMCxcblx0XHRcdGNodW5rc19yZWFkOiAwLFxuXHRcdH0pO1xuXHR9XG5cblx0bmV4dF9jaHVuaygpIHtcblx0XHRsZXQge1xuXHRcdFx0cmVhZF9pbmRleDogaV9yZWFkLFxuXHRcdFx0Y2h1bmtfc2l6ZTogbl9jaHVua19zaXplLFxuXHRcdFx0Y29udGVudDogZGZiX2NvbnRlbnQsXG5cdFx0XHRjb250ZW50X2xlbmd0aDogbmxfY29udGVudCxcblx0XHR9ID0gdGhpcztcblxuXHRcdGxldCBpX2VuZCA9IGlfcmVhZCArIG5fY2h1bmtfc2l6ZTtcblx0XHRpZihpX2VuZCA+PSBubF9jb250ZW50KSB7XG5cdFx0XHRpX2VuZCA9IG5sX2NvbnRlbnQ7XG5cdFx0XHR0aGlzLmVvZiA9IHRydWU7XG5cdFx0fVxuXG5cdFx0dGhpcy5idXN5ID0gdHJ1ZTtcblx0XHR0aGlzLmNodW5rc19sb2FkZWQgKz0gMTtcblxuXHRcdGxldCBkZmJfc2xpY2UgPSBkZmJfY29udGVudC5zbGljZShpX3JlYWQsIGlfZW5kKTtcblx0XHR0aGlzLnJlYWRfaW5kZXggPSBpX2VuZDtcblxuXHRcdHRoaXMuZmlsZV9yZWFkZXIucmVhZEFzQXJyYXlCdWZmZXIoZGZiX3NsaWNlKTtcblx0fVxufVxuXG5cbm1vZHVsZS5leHBvcnRzID0gT2JqZWN0LmFzc2lnbihmdW5jdGlvbih6X2lucHV0PW51bGwpIHtcblx0aWYoel9pbnB1dCkge1xuXHRcdC8vIG1ha2UgcmVhZGFibGUgc3RyZWFtIGZyb20gb2JqZWN0IHVybCdzIGJsb2Jcblx0XHRpZignc3RyaW5nJyA9PT0gdHlwZW9mIHpfaW5wdXQpIHtcblx0XHRcdHJldHVybiBuZXcgcmVhZGFibGVfc3RyZWFtX3ZpYV9vYmplY3RfdXJsKHpfaW5wdXQpO1xuXHRcdH1cblx0XHQvLyBtYWtlIHJlYWRhYmxlIHN0cmVhbSBhdG9wIHBvcnRcblx0XHRlbHNlIGlmKHpfaW5wdXQgaW5zdGFuY2VvZiBNZXNzYWdlUG9ydCkge1xuXHRcdFx0cmV0dXJuIG5ldyByZWFkYWJsZV9zdHJlYW1fdmlhX3BvcnQoel9pbnB1dCk7XG5cdFx0fVxuXHRcdC8vIHRyYW5zbWl0IGJsb2IgYWNyb3NzIHRocmVhZHNcblx0XHRlbHNlIGlmKHpfaW5wdXQgaW5zdGFuY2VvZiBCbG9iKSB7XG5cdFx0XHQvLyBjcmVhdGUgbmV3IHRyYW5zZmVyIHN0cmVhbVxuXHRcdFx0bGV0IGtfc3RyZWFtID0gbmV3IHRyYW5zZmVyX3N0cmVhbSgpO1xuXG5cdFx0XHQvLyBmZWVkIGl0IHRoaXMgYmxvYiBhcyBpbnB1dFxuXHRcdFx0a19zdHJlYW0uYmxvYih6X2lucHV0KTtcblxuXHRcdFx0Ly8gcmV0dXJuIHN0cmVhbVxuXHRcdFx0cmV0dXJuIGtfc3RyZWFtO1xuXHRcdH1cblx0fVxuXHQvLyB0cmFuc2ZlciBhIHN0cmVhbVxuXHRlbHNlIHtcblx0XHRyZXR1cm4gbmV3IHRyYW5zZmVyX3N0cmVhbSgpO1xuXHR9XG59LCB7XG5cdGhhbmRsZXI6IGNsYXNzIGhhbmRsZXIge30sXG5cblx0aXNfc3RyZWFtKHpfc3RyZWFtKSB7XG5cdFx0cmV0dXJuIHpfc3RyZWFtIGluc3RhbmNlb2YgdHJhbnNmZXJfc3RyZWFtXG5cdFx0XHR8fCB6X3N0cmVhbSBpbnN0YW5jZW9mIFJlYWRhYmxlU3RyZWFtXG5cdFx0XHR8fCB6X3N0cmVhbSBpbnN0YW5jZW9mIFdyaXRhYmxlU3RyZWFtO1xuXHR9LFxuXG5cdHNlcmlhbGl6ZSh6X3N0cmVhbSkge1xuXHRcdC8vIHRyYW5zZmVyIHN0cmVhbVxuXHRcdGlmKHpfc3RyZWFtIGluc3RhbmNlb2YgdHJhbnNmZXJfc3RyZWFtKSB7XG5cdFx0XHRyZXR1cm4gW3tcblx0XHRcdFx0dHlwZTogJ3JlYWRhYmxlX3N0cmVhbScsXG5cdFx0XHRcdHBvcnQ6IHpfc3RyZWFtLm90aGVyX3BvcnQsXG5cdFx0XHR9LCB6X3N0cmVhbS5vdGhlcl9wb3J0XTtcblx0XHR9XG5cdFx0Ly8gcmVhZGFibGUgc3RyZWFtXG5cdFx0ZWxzZSBpZih6X3N0cmVhbSBpbnN0YW5jZW9mIFJlYWRhYmxlU3RyZWFtKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ25vdCB5ZXQgaW1wbGVtZW50ZWQnKTtcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdHR5cGU6ICdyZWFkYWJsZV9zdHJlYW0nLFxuXHRcdFx0fTtcblx0XHR9XG5cdFx0Ly8gd3JpdGFibGUgc3RyZWFtXG5cdFx0ZWxzZSBpZih6X3N0cmVhbSBpbnN0YW5jZW9mIFdyaXRhYmxlU3RyZWFtKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ25vdCB5ZXQgaW1wbGVtZW50ZWQnKTtcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdHR5cGU6ICd3cml0YWJsZV9zdHJlYW0nLFxuXHRcdFx0fTtcblx0XHR9XG5cdFx0Ly8gaW52YWxpZCB0eXBlXG5cdFx0ZWxzZSB7XG5cdFx0XHR0aHJvdyBuZXcgVHlwZUVycm9yKCdjYW5ub3QgY3JlYXRlIHRyYW5zZmVyIHN0cmVhbSBmcm9tOiAnK3pfc3RyZWFtKTtcblx0XHR9XG5cdH0sXG59KTtcbiIsIlxuY29uc3Qgc2hhcmluZyA9IHJlcXVpcmUoJy4vc2hhcmluZy5qcycpO1xuY29uc3QgVHlwZWRBcnJheSA9IE9iamVjdC5nZXRQcm90b3R5cGVPZihPYmplY3QuZ2V0UHJvdG90eXBlT2YobmV3IFVpbnQ4QXJyYXkoMCkpKS5jb25zdHJ1Y3RvcjtcblxuXG5cbi8qIGdsb2JhbHMgU2hhcmVkQXJyYXlCdWZmZXIgKi9cblxuXG5pZigndW5kZWZpbmVkJyA9PT0gdHlwZW9mIFNoYXJlZEFycmF5QnVmZmVyKSB7XG5cdGdsb2JhbC5TaGFyZWRBcnJheUJ1ZmZlciA9IGZ1bmN0aW9uKCkge1xuXHRcdHRocm93IG5ldyBFcnJvcignU2hhcmVkQXJyYXlCdWZmZXIgaXMgbm90IHN1cHBvcnRlZCBieSB0aGlzIGJyb3dzZXIsIG9yIGl0IGlzIGN1cnJlbnRseSBkaXNhYmxlZCBkdWUgdG8gU3BlY3RyZScpO1xuXHR9O1xufVxuXG5jbGFzcyBJbnQ4QXJyYXlTIGV4dGVuZHMgSW50OEFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQ4QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzApKTtcblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgSW50OEFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcih6X2FyZ18wLmJ5dGVMZW5ndGgpKTtcblxuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmKCd1bmRlZmluZWQnID09PSB0eXBlb2YgbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXk7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgSW50OEFycmF5KGRzYiwgMCwgbmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgY29weSBzcmNcblx0XHRcdGxldCBhdF9zcmMgPSBuZXcgSW50OEFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgSW50OEFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKEludDhBcnJheVMucHJvdG90eXBlLCB7W3NoYXJpbmcuJF9TSEFSRUFCTEVdOjF9KTtcbmNsYXNzIFVpbnQ4QXJyYXlTIGV4dGVuZHMgVWludDhBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZignbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoel9hcmdfMCkpO1xuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50OEFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcih6X2FyZ18wLmJ5dGVMZW5ndGgpKTtcblxuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmKCd1bmRlZmluZWQnID09PSB0eXBlb2YgbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXk7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IFVpbnQ4QXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBVaW50OEFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKFVpbnQ4QXJyYXlTLnByb3RvdHlwZSwge1tzaGFyaW5nLiRfU0hBUkVBQkxFXToxfSk7XG5jbGFzcyBVaW50OENsYW1wZWRBcnJheVMgZXh0ZW5kcyBVaW50OENsYW1wZWRBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZignbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhDbGFtcGVkQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzApKTtcblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhDbGFtcGVkQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzAuYnl0ZUxlbmd0aCkpO1xuXG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYoJ3VuZGVmaW5lZCcgPT09IHR5cGVvZiBubF9hcnJheSkge1xuXHRcdFx0XHRubF9hcnJheSA9IHpfYXJnXzAubGVuZ3RoIC0gbmJfb2Zmc2V0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhcnJheSBzaXplIGluIGJ5dGVzXG5cdFx0XHRsZXQgbmJfYXJyYXkgPSBubF9hcnJheTtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50OENsYW1wZWRBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IFVpbnQ4Q2xhbXBlZEFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgVWludDhDbGFtcGVkQXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oVWludDhDbGFtcGVkQXJyYXlTLnByb3RvdHlwZSwge1tzaGFyaW5nLiRfU0hBUkVBQkxFXToxfSk7XG5jbGFzcyBJbnQxNkFycmF5UyBleHRlbmRzIEludDE2QXJyYXkge1xuXHRjb25zdHJ1Y3Rvcih6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KSB7XG5cdFx0Ly8gdGhpc1xuXHRcdGxldCBoX3RoaXMgPSB7fTtcblxuXHRcdC8vIHNlbGZcblx0XHRsZXQgYXRfc2VsZjtcblxuXG5cdFx0Ly8gbGVuZ3RoIGNvbnN0cnVjdG9yXG5cdFx0aWYoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHRhdF9zZWxmID0gbmV3IEludDE2QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzAgPDwgMSkpO1xuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQxNkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcih6X2FyZ18wLmJ5dGVMZW5ndGgpKTtcblxuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmKCd1bmRlZmluZWQnID09PSB0eXBlb2YgbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXkgPDwgMTtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQxNkFycmF5KGRzYiwgMCwgbmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgY29weSBzcmNcblx0XHRcdGxldCBhdF9zcmMgPSBuZXcgSW50MTZBcnJheSh6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KTtcblxuXHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdGF0X3NlbGYuc2V0KGF0X3NyYyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIHNlbGZcblx0XHRzdXBlcihhdF9zZWxmKTtcblxuXHRcdC8vIHNhdmUgZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCBoX3RoaXMpO1xuXHR9XG5cblx0YmFzZSguLi5hX2FyZ3MpIHtcblx0XHRyZXR1cm4gbmV3IEludDE2QXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oSW50MTZBcnJheVMucHJvdG90eXBlLCB7W3NoYXJpbmcuJF9TSEFSRUFCTEVdOjF9KTtcbmNsYXNzIFVpbnQxNkFycmF5UyBleHRlbmRzIFVpbnQxNkFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50MTZBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoel9hcmdfMCA8PCAxKSk7XG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZih6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZihzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQxNkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcih6X2FyZ18wLmJ5dGVMZW5ndGgpKTtcblxuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmKCd1bmRlZmluZWQnID09PSB0eXBlb2YgbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXkgPDwgMTtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50MTZBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IFVpbnQxNkFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgVWludDE2QXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oVWludDE2QXJyYXlTLnByb3RvdHlwZSwge1tzaGFyaW5nLiRfU0hBUkVBQkxFXToxfSk7XG5jbGFzcyBJbnQzMkFycmF5UyBleHRlbmRzIEludDMyQXJyYXkge1xuXHRjb25zdHJ1Y3Rvcih6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KSB7XG5cdFx0Ly8gdGhpc1xuXHRcdGxldCBoX3RoaXMgPSB7fTtcblxuXHRcdC8vIHNlbGZcblx0XHRsZXQgYXRfc2VsZjtcblxuXG5cdFx0Ly8gbGVuZ3RoIGNvbnN0cnVjdG9yXG5cdFx0aWYoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHRhdF9zZWxmID0gbmV3IEludDMyQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzAgPDwgMikpO1xuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQzMkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcih6X2FyZ18wLmJ5dGVMZW5ndGgpKTtcblxuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmKCd1bmRlZmluZWQnID09PSB0eXBlb2YgbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXkgPDwgMjtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQzMkFycmF5KGRzYiwgMCwgbmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgY29weSBzcmNcblx0XHRcdGxldCBhdF9zcmMgPSBuZXcgSW50MzJBcnJheSh6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KTtcblxuXHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdGF0X3NlbGYuc2V0KGF0X3NyYyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIHNlbGZcblx0XHRzdXBlcihhdF9zZWxmKTtcblxuXHRcdC8vIHNhdmUgZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCBoX3RoaXMpO1xuXHR9XG5cblx0YmFzZSguLi5hX2FyZ3MpIHtcblx0XHRyZXR1cm4gbmV3IEludDMyQXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oSW50MzJBcnJheVMucHJvdG90eXBlLCB7W3NoYXJpbmcuJF9TSEFSRUFCTEVdOjF9KTtcbmNsYXNzIFVpbnQzMkFycmF5UyBleHRlbmRzIFVpbnQzMkFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50MzJBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoel9hcmdfMCA8PCAyKSk7XG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZih6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZihzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQzMkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcih6X2FyZ18wLmJ5dGVMZW5ndGgpKTtcblxuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmKCd1bmRlZmluZWQnID09PSB0eXBlb2YgbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXkgPDwgMjtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50MzJBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IFVpbnQzMkFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgVWludDMyQXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oVWludDMyQXJyYXlTLnByb3RvdHlwZSwge1tzaGFyaW5nLiRfU0hBUkVBQkxFXToxfSk7XG5jbGFzcyBGbG9hdDMyQXJyYXlTIGV4dGVuZHMgRmxvYXQzMkFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0YXRfc2VsZiA9IG5ldyBGbG9hdDMyQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzAgPDwgMikpO1xuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBGbG9hdDMyQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzAuYnl0ZUxlbmd0aCkpO1xuXG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYoJ3VuZGVmaW5lZCcgPT09IHR5cGVvZiBubF9hcnJheSkge1xuXHRcdFx0XHRubF9hcnJheSA9IHpfYXJnXzAubGVuZ3RoIC0gbmJfb2Zmc2V0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhcnJheSBzaXplIGluIGJ5dGVzXG5cdFx0XHRsZXQgbmJfYXJyYXkgPSBubF9hcnJheSA8PCAyO1xuXG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRsZXQgZHNiID0gbmV3IFNoYXJlZEFycmF5QnVmZmVyKG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIHR5cGVkIGFycmF5XG5cdFx0XHRhdF9zZWxmID0gbmV3IEZsb2F0MzJBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IEZsb2F0MzJBcnJheSh6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KTtcblxuXHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdGF0X3NlbGYuc2V0KGF0X3NyYyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIHNlbGZcblx0XHRzdXBlcihhdF9zZWxmKTtcblxuXHRcdC8vIHNhdmUgZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCBoX3RoaXMpO1xuXHR9XG5cblx0YmFzZSguLi5hX2FyZ3MpIHtcblx0XHRyZXR1cm4gbmV3IEZsb2F0MzJBcnJheSguLi5hX2FyZ3MpO1xuXHR9XG59XG5cbi8vIHN0YXRpYyBmaWVsZFxuT2JqZWN0LmFzc2lnbihGbG9hdDMyQXJyYXlTLnByb3RvdHlwZSwge1tzaGFyaW5nLiRfU0hBUkVBQkxFXToxfSk7XG5jbGFzcyBGbG9hdDY0QXJyYXlTIGV4dGVuZHMgRmxvYXQ2NEFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0YXRfc2VsZiA9IG5ldyBGbG9hdDY0QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzAgPDwgNCkpO1xuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBGbG9hdDY0QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzAuYnl0ZUxlbmd0aCkpO1xuXG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYoJ3VuZGVmaW5lZCcgPT09IHR5cGVvZiBubF9hcnJheSkge1xuXHRcdFx0XHRubF9hcnJheSA9IHpfYXJnXzAubGVuZ3RoIC0gbmJfb2Zmc2V0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhcnJheSBzaXplIGluIGJ5dGVzXG5cdFx0XHRsZXQgbmJfYXJyYXkgPSBubF9hcnJheSA8PCA0O1xuXG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRsZXQgZHNiID0gbmV3IFNoYXJlZEFycmF5QnVmZmVyKG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIHR5cGVkIGFycmF5XG5cdFx0XHRhdF9zZWxmID0gbmV3IEZsb2F0NjRBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IEZsb2F0NjRBcnJheSh6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KTtcblxuXHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdGF0X3NlbGYuc2V0KGF0X3NyYyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIHNlbGZcblx0XHRzdXBlcihhdF9zZWxmKTtcblxuXHRcdC8vIHNhdmUgZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCBoX3RoaXMpO1xuXHR9XG5cblx0YmFzZSguLi5hX2FyZ3MpIHtcblx0XHRyZXR1cm4gbmV3IEZsb2F0NjRBcnJheSguLi5hX2FyZ3MpO1xuXHR9XG59XG5cbi8vIHN0YXRpYyBmaWVsZFxuT2JqZWN0LmFzc2lnbihGbG9hdDY0QXJyYXlTLnByb3RvdHlwZSwge1tzaGFyaW5nLiRfU0hBUkVBQkxFXToxfSk7XG5cblxuLy8gZ2xvYmFsc1xubW9kdWxlLmV4cG9ydHMgPSB7XG5cdGV4cG9ydHM6IHtcblx0XHRBcnJheUJ1ZmZlclM6IFNoYXJlZEFycmF5QnVmZmVyLFxuXHRcdEFycmF5QnVmZmVyVDogQXJyYXlCdWZmZXIsXG5cdFx0SW50OEFycmF5UzogSW50OEFycmF5Uyxcblx0XHRJbnQ4QXJyYXlUOiBJbnQ4QXJyYXksXG5cdFx0VWludDhBcnJheVM6IFVpbnQ4QXJyYXlTLFxuXHRcdFVpbnQ4QXJyYXlUOiBVaW50OEFycmF5LFxuXHRcdFVpbnQ4Q2xhbXBlZEFycmF5UzogVWludDhDbGFtcGVkQXJyYXlTLFxuXHRcdFVpbnQ4Q2xhbXBlZEFycmF5VDogVWludDhDbGFtcGVkQXJyYXksXG5cdFx0SW50MTZBcnJheVM6IEludDE2QXJyYXlTLFxuXHRcdEludDE2QXJyYXlUOiBJbnQxNkFycmF5LFxuXHRcdFVpbnQxNkFycmF5UzogVWludDE2QXJyYXlTLFxuXHRcdFVpbnQxNkFycmF5VDogVWludDE2QXJyYXksXG5cdFx0SW50MzJBcnJheVM6IEludDMyQXJyYXlTLFxuXHRcdEludDMyQXJyYXlUOiBJbnQzMkFycmF5LFxuXHRcdFVpbnQzMkFycmF5UzogVWludDMyQXJyYXlTLFxuXHRcdFVpbnQzMkFycmF5VDogVWludDMyQXJyYXksXG5cdFx0RmxvYXQzMkFycmF5UzogRmxvYXQzMkFycmF5Uyxcblx0XHRGbG9hdDMyQXJyYXlUOiBGbG9hdDMyQXJyYXksXG5cdFx0RmxvYXQ2NEFycmF5UzogRmxvYXQ2NEFycmF5Uyxcblx0XHRGbG9hdDY0QXJyYXlUOiBGbG9hdDY0QXJyYXksXG5cdH0sXG59O1xuIiwiY29uc3QgZXZlbnRzID0gcmVxdWlyZSgnLi9ldmVudHMuanMnKTtcbmNvbnN0IHNoYXJpbmcgPSByZXF1aXJlKCcuL3NoYXJpbmcuanMnKTtcblxuY2xhc3Mgd29ya2VyIGV4dGVuZHMgV29ya2VyIHtcblxuXHRwb3N0UG9ydChkX3BvcnQsIGhfbXNnLCBhX3RyYW5zZmVyX3BhdGhzPVtdKSB7XG5cdFx0Ly8gYXBwZW5kIHBvcnQgdG8gdHJhbnNmZXIgcGF0aHNcblx0XHRhX3RyYW5zZmVyX3BhdGhzLnB1c2goWydwb3J0J10pO1xuXG5cdFx0Ly8gc2VuZFxuXHRcdHRoaXMucG9zdE1lc3NhZ2UoT2JqZWN0LmFzc2lnbih7XG5cdFx0XHRwb3J0OiBkX3BvcnQsXG5cdFx0fSwgaF9tc2cpLCBhX3RyYW5zZmVyX3BhdGhzKTtcblx0fVxuXG5cdHBvc3RNZXNzYWdlKGhfbXNnLCBhX3RyYW5zZmVyX3BhdGhzKSB7XG5cdFx0bGV0IGFfdHJhbnNmZXJzID0gW107XG5cdFx0Zm9yKGxldCBhX3BhdGggb2YgYV90cmFuc2Zlcl9wYXRocykge1xuXHRcdFx0bGV0IHpfaGVhZCA9IGhfbXNnO1xuXHRcdFx0bGV0IG5sX3BhdGggPSBhX3BhdGgubGVuZ3RoO1xuXHRcdFx0Zm9yKGxldCBpX3N0ZXA9MDsgaV9zdGVwPG5sX3BhdGgtMTsgaV9zdGVwKyspIHtcblx0XHRcdFx0el9oZWFkID0gel9oZWFkW2FfcGF0aFtpX3N0ZXBdXTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gZmluYWwgc3RlcFxuXHRcdFx0bGV0IHNfa2V5ID0gYV9wYXRoW25sX3BhdGgtMV07XG5cblx0XHRcdC8vIGV4dHJhY3QgdHJhbnNmZXIgaXRlbShzKVxuXHRcdFx0bGV0IFtoX3NlcmlhbGl6YXRpb24sIGFfdHJhbnNmZXJfaXRlbXNdID0gc2hhcmluZy5leHRyYWN0KHpfaGVhZFtzX2tleV0pO1xuXG5cdFx0XHQvLyBhZGQgdHJhbnNmZXIgaXRlbXNcblx0XHRcdGFfdHJhbnNmZXJzLnB1c2goLi4uYV90cmFuc2Zlcl9pdGVtcyk7XG5cblx0XHRcdC8vIHJlcGxhY2Ugb2JqZWN0XG5cdFx0XHR6X2hlYWRbc19rZXldID0gaF9zZXJpYWxpemF0aW9uO1xuXHRcdH1cblxuXHRcdHRyeSB7XG5cdFx0XHRzdXBlci5wb3N0TWVzc2FnZShoX21zZywgYV90cmFuc2ZlcnMpO1xuXHRcdH1cblx0XHRjYXRjaChlX3Bvc3QpIHtcblx0XHRcdC8vIGRhdGEgY2xvbmUgZXJyb3Jcblx0XHRcdGlmKCdEYXRhQ2xvbmVFcnJvcicgPT09IGVfcG9zdC5uYW1lKSB7XG5cdFx0XHRcdGNvbnNvbGUud2FybignRGlkIHlvdSBmb3JnZXQgdG8gZGVjbGFyZSBhbiBvYmplY3QgdGhhdCBuZWVkcyB0byBiZSB0cmFuc2ZlcnJlZD8gTWFrZSBzdXJlIHlvdSBrbm93IHdoZW4gdG8gdXNlIHdvcmtlci5tYW5pZmVzdCgpJyk7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXG5cdFx0XHR0aHJvdyBlX3Bvc3Q7XG5cdFx0fVxuXHR9XG59XG5cbmV2ZW50cyh3b3JrZXIucHJvdG90eXBlKTtcblxubW9kdWxlLmV4cG9ydHMgPSB3b3JrZXI7XG4iLCIvKiBAZmxvdyAqL1xuY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcblxuY29uc3QgY29sb3JzID0gcmVxdWlyZSgnY29sb3JzJyk7XG5jb2xvcnMuZW5hYmxlZCA9IHRydWU7XG5cbi8vIGxvY2FsIGNsYXNzZXMgLyBnbG9iYWxzXG5jb25zdCB7XG5cdEtfU0VMRixcblx0RENfV09SS0VSLFxuXHREQ19DSEFOTkVMLFxuXHRIX1RZUEVEX0FSUkFZUyxcblx0Ql9CUk9XU0VSLFxuXHRCX0JST1dTRVJJRlksXG5cdEhQX1dPUktFUl9OT1RJRklDQVRJT04sXG5cdHN0cmVhbSxcblx0d2Vid29ya2VyaWZ5LFxufSA9IHJlcXVpcmUoJy4vYWxsL2xvY2Fscy5qcycpO1xuXG5jb25zdCBkZWRpY2F0ZWQgPSByZXF1aXJlKCcuL2FsbC9kZWRpY2F0ZWQuanMnKTtcbmNvbnN0IG1hbmlmZXN0ID0gcmVxdWlyZSgnLi9hbGwvbWFuaWZlc3QuanMnKTtcbmNvbnN0IHJlc3VsdCA9IHJlcXVpcmUoJy4vYWxsL3Jlc3VsdC5qcycpO1xuXG4vLyBXb3JrZXIgaXMgc3VwcG9ydGVkXG5jb25zdCBCX1dPUktFUl9TVVBQT1JURUQgPSAoJ3VuZGVmaW5lZCcgIT09IHR5cGVvZiBEQ19XT1JLRVIpO1xuXG4vLyBjb250ZXh0IGJpdG1hc2tzXG5jb25zdCBYTV9DT05URVhUX1BST0NFU1NfUEFSRU5UID0gMSA8PCAwO1xuY29uc3QgWE1fQ09OVEVYVF9QUk9DRVNTX0NISUxEID0gMSA8PCAxO1xuY29uc3QgWE1fQ09OVEVYVF9XSU5ET1cgPSAxIDw8IDI7XG5jb25zdCBYTV9DT05URVhUX1dPUktFUl9ERURJQ0FURUQgPSAxIDw8IDM7XG5jb25zdCBYTV9DT05URVhUX1dPUktFUl9TRVJWSUNFID0gMSA8PCA0O1xuY29uc3QgWE1fQ09OVEVYVF9XT1JLRVJfU0hBUkVEID0gMSA8PCA1O1xuXG5jb25zdCBYTV9DT05URVhUX1dPUktFUiA9IFhNX0NPTlRFWFRfV09SS0VSX0RFRElDQVRFRCB8IFhNX0NPTlRFWFRfV09SS0VSX1NFUlZJQ0UgfCBYTV9DT05URVhUX1dPUktFUl9TSEFSRUQ7XG5cbi8vIHNldCB0aGUgY3VycmVudCBjb250ZXh0XG5jb25zdCBYX0NPTlRFWFRfVFlQRSA9ICFCX0JST1dTRVJcblx0PyAocHJvY2Vzcy5lbnYuV09SS0VSX0RFUFRIPyBYTV9DT05URVhUX1BST0NFU1NfQ0hJTEQ6IFhNX0NPTlRFWFRfUFJPQ0VTU19QQVJFTlQpXG5cdDogKCd1bmRlZmluZWQnICE9PSB0eXBlb2YgZG9jdW1lbnRcblx0XHQ/IFhNX0NPTlRFWFRfV0lORE9XXG5cdFx0OiAoJ0RlZGljYXRlZFdvcmtlckdsb2JhbFNjb3BlJyBpbiBzZWxmXG5cdFx0XHQ/IFhNX0NPTlRFWFRfV09SS0VSX0RFRElDQVRFRFxuXHRcdFx0OiAoJ1NoYXJlZFdvcmtlckdsb2JhbFNjb3BlJyBpbiBzZWxmXG5cdFx0XHRcdD8gWE1fQ09OVEVYVF9XT1JLRVJfU0hBUkVEXG5cdFx0XHRcdDogKCdTZXJ2aWNlV29ya2VyR2xvYmFsU2NvcGUnIGluIHNlbGZcblx0XHRcdFx0XHQ/IFhNX0NPTlRFWFRfV09SS0VSX1NFUlZJQ0Vcblx0XHRcdFx0XHQ6IDApKSkpO1xuXG4vLyB1bnJlY29nbml6ZWQgY29udGV4dFxuaWYoIVhfQ09OVEVYVF9UWVBFKSB7XG5cdHRocm93IG5ldyBFcnJvcignZmFpbGVkIHRvIGRldGVybWluZSB3aGF0IGlzIHRoZSBjdXJyZW50IGVudmlyb25tZW50L2NvbnRleHQnKTtcbn1cblxuLy8gc3Bhd25zIGEgV29ya2VyXG5sZXQgc3Bhd25fd29ya2VyID0gQl9XT1JLRVJfU1VQUE9SVEVEXG5cdD8gKCFCX0JST1dTRVJJRllcblx0XHQ/IChwX3NvdXJjZSwgaF9vcHRpb25zKSA9PiBuZXcgRENfV09SS0VSKHBfc291cmNlLCBoX29wdGlvbnMpXG5cdFx0OiAocF9zb3VyY2UsIGhfb3B0aW9ucykgPT4ge1xuXHRcdFx0Y29uc29sZS5lcnJvcihgRmF0YWwgZXJyb3I6IHNpbmNlIHlvdSBhcmUgdXNpbmcgYnJvd3NlcmlmeSwgeW91IG5lZWQgdG8gaW5jbHVkZSBleHBsaWNpdCAncmVxdWlyZSgpJyBzdGF0ZW1lbnRzIGZvciBhbnkgc2NyaXB0cyB5b3UgaW50ZW5kIHRvIHNwYXduIGFzIHdvcmtlcnMgZnJvbSB0aGlzIHRocmVhZGApO1xuXHRcdFx0Y29uc29sZS53YXJuKGB0cnkgdXNpbmcgdGhlIGZvbGxvd2luZyBpbnN0ZWFkOlxcblxcbmNvbnN0IHdvcmtlciA9IHJlcXVpcmUoJ3dvcmtlcicpLnNjb3BpZnkocmVxdWlyZSwgKCkgPT4ge1xcbmBcblx0XHRcdFx0K2BcXHRyZXF1aXJlKCcke3Bfc291cmNlfScpO1xcblxcdC8vIC4uLiBhbmQgYW55IG90aGVyIHNjcmlwdHMgeW91IHdpbGwgc3Bhd24gZnJvbSB0aGlzIHRocmVhZFxcbmBcblx0XHRcdFx0K2B9LCAndW5kZWZpbmVkJyAhPT0gdHlwZW9mIGFyZ3VtZW50cyAmJiBhcmd1bWVudHMpO2ApO1xuXG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBzcGF3biB3b3JrZXIgJyR7cF9zb3VyY2V9J2ApO1xuXHRcdH0pXG5cdDogKHBfc291cmNlLCBoX29wdGlvbnMpID0+IHtcblx0XHQvLyB3ZSdyZSBpbnNpZGUgYSB3b3JrZXJcblx0XHRpZihYX0NPTlRFWFRfVFlQRSAmIFhNX0NPTlRFWFRfV09SS0VSKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBGYXRhbCBlcnJvcjogYnJvd3NlciBkb2VzIG5vdCBzdXBwb3J0IHN1YndvcmtlcnM7IGZhaWxlZCB0byBzcGF3biAnJHtwX3NvdXJjZX0nXFxuYFxuXHRcdFx0XHQrJ0ZvcnR1bmF0ZWx5IHdvcmtlci5qcyBoYXMgYSBzb2x1dGlvbiAgOyknKTtcblx0XHRcdGNvbnNvbGUud2FybihgdHJ5IHVzaW5nIHRoZSBmb2xsb3dpbmcgaW4geW91ciB3b3JrZXIgc2NyaXB0IHRvIHN1cHBvcnQgc3Vid29ya2VyczpcXG5cXG5gXG5cdFx0XHRcdCtgY29uc3Qgd29ya2VyID0gcmVxdWlyZSgnd29ya2VyJykuc2NvcGlmeShyZXF1aXJlLCAoKSA9PiB7XFxuYFxuXHRcdFx0XHQrYFxcdHJlcXVpcmUoJyR7cF9zb3VyY2V9Jyk7XFxuYFxuXHRcdFx0XHQrYFxcdC8vIC4uLiBhbmQgYW55IG90aGVyIHNjcmlwdHMgeW91IHdpbGwgc3Bhd24gZnJvbSB0aGlzIHRocmVhZFxcbmBcblx0XHRcdFx0K2B9LCAndW5kZWZpbmVkJyAhPT0gdHlwZW9mIGFyZ3VtZW50cyAmJiBhcmd1bWVudHMpO2ApO1xuXHRcdH1cblxuXHRcdHRocm93IG5ldyBFcnJvcihgQ2Fubm90IHNwYXduIHdvcmtlciAke3Bfc291cmNlfTsgJ1dvcmtlcicgaXMgdW5kZWZpbmVkYCk7XG5cdH07XG5cblxubGV0IGlfZ3VpZCA9IDA7XG5cbmNsYXNzIHdvcmtlciBleHRlbmRzIHN0cmVhbS5oYW5kbGVyIHtcblx0c3RhdGljIGZyb21fc291cmNlKHBfc291cmNlLCBoX29wdGlvbnM9e30pIHtcblx0XHRyZXR1cm4gbmV3IHdvcmtlcih7XG5cdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdFx0b3B0aW9uczogaF9vcHRpb25zLFxuXHRcdH0pO1xuXHR9XG5cblx0Y29uc3RydWN0b3IoaF9jb25maWcpIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0bGV0IHtcblx0XHRcdHNvdXJjZTogcF9zb3VyY2UsXG5cdFx0XHRpZDogaV9pZD0tMSxcblx0XHRcdG1hc3Rlcjoga19tYXN0ZXI9bnVsbCxcblx0XHRcdG9wdGlvbnM6IGhfb3B0aW9ucz17fSxcblx0XHR9ID0gaF9jb25maWc7XG5cblx0XHQvLyByZXNvbHZlIHNvdXJjZSByZWxhdGl2ZSB0byBtYXN0ZXJcblx0XHRsZXQgcGFfc291cmNlID0gQl9CUk9XU0VSXG5cdFx0XHQ/IHBfc291cmNlXG5cdFx0XHQ6IHBhdGgucmVzb2x2ZShwYXRoLmRpcm5hbWUobW9kdWxlLnBhcmVudC5maWxlbmFtZSksIHBfc291cmNlKTtcblxuXHRcdC8vIG1ha2Ugd29ya2VyXG5cdFx0bGV0IGRfd29ya2VyO1xuXHRcdHRyeSB7XG5cdFx0XHRkX3dvcmtlciA9IHNwYXduX3dvcmtlcihwYV9zb3VyY2UsIGhfb3B0aW9ucyk7XG5cdFx0fVxuXHRcdGNhdGNoKGVfc3Bhd24pIHtcblx0XHRcdGxldCBlX21zZyA9IG5ldyBFcnJvcignQW4gdW5jYXVnaHQgZXJyb3Igd2FzIHRocm93biBieSB0aGUgd29ya2VyLCBwb3NzaWJseSBkdWUgdG8gYSBidWcgaW4gdGhlIHdvcmtlci5qcyBsaWJyYXJ5LiBUaGF0IGVycm9yIHdhczpcXG4nK2Vfc3Bhd24uc3RhY2suc3BsaXQoJ1xcbicpWzBdKTtcblx0XHRcdGVfbXNnLnN0YWNrID0gZV9zcGF3bi5zdGFjaztcblx0XHRcdHRocm93IGVfbXNnO1xuXHRcdH1cblxuXHRcdGRfd29ya2VyLm9uKHtcblx0XHRcdGVycm9yOiAoZV93b3JrZXIpID0+IHtcblx0XHRcdFx0aWYoZV93b3JrZXIgaW5zdGFuY2VvZiBFcnJvckV2ZW50KSB7XG5cdFx0XHRcdFx0aWYoJ2xpbmVubycgaW4gZV93b3JrZXIgJiYgJ3NvdXJjZScgaW4gZF93b3JrZXIpIHtcblx0XHRcdFx0XHRcdGxldCBhX2xpbmVzID0gZF93b3JrZXIuc291cmNlLnNwbGl0KCdcXG4nKTtcblx0XHRcdFx0XHRcdGxldCBpX2xpbmVfZXJyID0gZV93b3JrZXIubGluZW5vO1xuXHRcdFx0XHRcdFx0bGV0IGFfZGVidWcgPSBhX2xpbmVzLnNsaWNlKE1hdGgubWF4KDAsIGlfbGluZV9lcnItMiksIE1hdGgubWluKGFfbGluZXMubGVuZ3RoLTEsIGlfbGluZV9lcnIrMikpXG5cdFx0XHRcdFx0XHRcdC5tYXAoKHNfbGluZSwgaV9saW5lKSA9PiAoMSA9PT0gaV9saW5lPyAnKic6ICcgJykrKChpX2xpbmVfZXJyK2lfbGluZS0xKSsnJykucGFkU3RhcnQoNSkrJzogJytzX2xpbmUpO1xuXG5cdFx0XHRcdFx0XHQvLyByZWNyZWF0ZSBlcnJvciBtZXNzYWdlXG5cdFx0XHRcdFx0XHRlX3dvcmtlciA9IG5ldyBFcnJvcihlX3dvcmtlci5tZXNzYWdlK2BFcnJvciB0aHJvd24gaW4gd29ya2VyOlxcbiR7YV9kZWJ1Zy5qb2luKCdcXG4nKX1gKTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRpZih0aGlzLnRhc2tfZXJyb3IpIHtcblx0XHRcdFx0XHRcdHRoaXMudGFza19lcnJvcihlX3dvcmtlcik7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdFx0dGhyb3cgZV93b3JrZXI7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdGVsc2UgaWYodGhpcy50YXNrX2Vycm9yKSB7XG5cdFx0XHRcdFx0dGhpcy50YXNrX2Vycm9yKGVfd29ya2VyKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRlbHNlIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYGFuIGVycm9yIG9jY3VyZWQgb24gd29ya2VyLi4uIGJ1dCB0aGUgJ2Vycm9yJyBldmVudCBjYWxsYmFjayBkaWQgbm90IHJlY2VpdmUgYW4gRXJyb3JFdmVudCBvYmplY3QhIHRyeSBpbnNwZWN0aW5nIGNvbnNvbGVgKTtcblx0XHRcdFx0fVxuXHRcdFx0fSxcblxuXHRcdFx0Ly8gd2hlbiB0aGVyZSBpcyBhbiBlcnJvciBjcmVhdGluZy9jb21tdW5pY2F0aW5nIHdpdGggd29ya2VyXG5cdFx0XHRtZXNzYWdlZXJyb3I6IChlX2FjdGlvbikgPT4ge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoZV9hY3Rpb24pO1xuXHRcdFx0fSxcblxuXHRcdFx0Ly8gd2hlbiBhIHdvcmtlciByZXNwb25kc1xuXHRcdFx0bWVzc2FnZTogKGRfbXNnKSA9PiB7XG5cdFx0XHRcdGxldCBoX21zZyA9IGRfbXNnLmRhdGE7XG5cblx0XHRcdFx0Ly8gaGFuZGxlIG1lc3NhZ2Vcblx0XHRcdFx0bGV0IHNfaGFuZGxlID0gJ2hhbmRsZV8nK2hfbXNnLnR5cGU7XG5cdFx0XHRcdGlmKHNfaGFuZGxlIGluIHRoaXMpIHtcblx0XHRcdFx0XHR0aGlzW3NfaGFuZGxlXShoX21zZyk7XG5cdFx0XHRcdH1cblx0XHRcdFx0ZWxzZSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGB3b3JrZXIgc2VudCBhIG1lc3NhZ2UgdGhhdCBoYXMgbm8gZGVmaW5lZCBoYW5kbGVyOiAnJHtoX21zZy50eXBlfSdgKTtcblx0XHRcdFx0fVxuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0c291cmNlOiBwX3NvdXJjZSxcblx0XHRcdGlkOiBpX2lkLFxuXHRcdFx0bWFzdGVyOiBrX21hc3Rlcixcblx0XHRcdHBvcnQ6IGRfd29ya2VyLFxuXHRcdFx0YnVzeTogZmFsc2UsXG5cdFx0XHRhdmFpbGFibGU6IHRydWUsXG5cdFx0XHR0YXNrc19hc3NpZ25lZDogMCxcblx0XHRcdGNhbGxiYWNrczoge30sXG5cdFx0XHRldmVudHM6IHt9LFxuXHRcdFx0c3Vid29ya2VyczogW10sXG5cdFx0XHR0YXNrX2Vycm9yOiBudWxsLFxuXHRcdFx0Y2hhbm5lbHM6IG5ldyBNYXAoKSxcblx0XHRcdHNlcnZlcjogbnVsbCxcblx0XHR9KTtcblx0fVxuXG5cdGRlYnVnKHNfdGFnLCBzX3R5cGUsIC4uLmFfaW5mbykge1xuXHRcdGNvbnNvbGUud2FybihgWyR7c190YWd9XSBgLndoaXRlK2BNJHtTdHJpbmcuZnJvbUNoYXJDb2RlKDY1K3RoaXMuaWQpfWAuYmx1ZStgICR7c190eXBlfSAke2FfaW5mby5sZW5ndGg/ICcoJythX2luZm8uam9pbignLCAnKSsnKSc6ICctJ31gKTtcblx0fVxuXG5cdGhhbmRsZV9jbG9zZV9zZXJ2ZXIoaF9tc2cpIHtcblx0XHREQ19DSEFOTkVMLmtpbGwoaF9tc2cuc2VydmVyKTtcblx0fVxuXG5cdGhhbmRsZV9yZXNwb25kKGhfbXNnKSB7XG5cdFx0bGV0IGhfY2FsbGJhY2tzID0gdGhpcy5jYWxsYmFja3M7XG5cblx0XHQvLyBubyBsb25nZXIgYnVzeVxuXHRcdHRoaXMuYnVzeSA9IGZhbHNlO1xuXG5cdFx0Ly8gZ3JhYiB0YXNrIGlkXG5cdFx0bGV0IGlfdGFzayA9IGhfbXNnLmlkO1xuXG5cdFx0aWYoaF9tc2cuZGVidWcpIHRoaXMuZGVidWcoaF9tc2cuZGVidWcsICc8PCByZXNwb25kJy5yZWQsIGlfdGFzayk7XG5cblx0XHQvLyBleGVjdXRlIGNhbGxiYWNrXG5cdFx0aF9jYWxsYmFja3NbaV90YXNrXShoX21zZy5kYXRhLCBpX3Rhc2ssIHRoaXMpO1xuXG5cdFx0Ly8gZnJlZSBjYWxsYmFja1xuXHRcdGRlbGV0ZSBoX2NhbGxiYWNrc1tpX3Rhc2tdO1xuXHR9XG5cblx0aGFuZGxlX25vdGlmeShoX21zZykge1xuXHRcdGhfbXNnLmRhdGEgPSBIUF9XT1JLRVJfTk9USUZJQ0FUSU9OO1xuXG5cdFx0Ly8gbm8gbG9uZ2VyIGJ1c3lcblx0XHR0aGlzLmJ1c3kgPSBmYWxzZTtcblxuXHRcdGlmKGhfbXNnLmRlYnVnKSB0aGlzLmRlYnVnKGhfbXNnLmRlYnVnLCAnPDwgbm90aWZ5Jy5yZWQpO1xuXG5cdFx0dGhpcy5oYW5kbGVfcmVzcG9uZChoX21zZyk7XG5cdH1cblxuXHRoYW5kbGVfZXZlbnQoaF9tc2cpIHtcblx0XHQvLyBldmVudCBpcyBndWFyYW50ZWVkIHRvIGJlIGhlcmU7IGp1c3QgY2FsbGJhY2sgd2l0aCBkYXRhXG5cdFx0dGhpcy5ldmVudHNbaF9tc2cuaWRdW2hfbXNnLmV2ZW50XSguLi5oX21zZy5hcmdzKTtcblx0fVxuXG5cdGhhbmRsZV9lcnJvcihoX21zZykge1xuXHRcdGxldCBoX2Vycm9yID0gaF9tc2cuZXJyb3I7XG5cdFx0bGV0IGVfbXNnID0gbmV3IEVycm9yKGhfZXJyb3IubWVzc2FnZSk7XG5cdFx0ZV9tc2cuc3RhY2sgPSBoX2Vycm9yLnN0YWNrO1xuXG5cdFx0aWYodGhpcy50YXNrX2Vycm9yKSB7XG5cdFx0XHR0aGlzLnRhc2tfZXJyb3IoZV9tc2cpO1xuXHRcdH1cblx0XHRlbHNlIHtcblx0XHRcdHRocm93IGVfbXNnO1xuXHRcdH1cblx0fVxuXG5cdGhhbmRsZV9zcGF3bihoX21zZykge1xuXHRcdGxldCBwX3NvdXJjZSA9IHBhdGguam9pbihwYXRoLmRpcm5hbWUodGhpcy5zb3VyY2UpLCBoX21zZy5zb3VyY2UpO1xuXHRcdGlmKCcvJyAhPT0gcF9zb3VyY2VbMF0pIHBfc291cmNlID0gJy4vJytwX3NvdXJjZTtcblxuXHRcdHBfc291cmNlID0gaF9tc2cuc291cmNlO1xuXHRcdGxldCBkX3N1YndvcmtlciA9IHNwYXduX3dvcmtlcihwX3NvdXJjZSk7XG5cdFx0bGV0IGlfc3Vid29ya2VyID0gdGhpcy5zdWJ3b3JrZXJzLnB1c2goZF9zdWJ3b3JrZXIpLTE7XG5cblx0XHRkX3N1Yndvcmtlci5vbignZXJyb3InLCAoZV93b3JrZXIpID0+IHtcblx0XHRcdHRoaXMucG9ydC5wb3N0TWVzc2FnZSh7XG5cdFx0XHRcdHR5cGU6ICdzdWJ3b3JrZXJfZXJyb3InLFxuXHRcdFx0XHRlcnJvcjoge1xuXHRcdFx0XHRcdG1lc3NhZ2U6IGVfd29ya2VyLm1lc3NhZ2UsXG5cdFx0XHRcdFx0ZmlsZW5hbWU6IGVfd29ya2VyLmZpbGVuYW1lLFxuXHRcdFx0XHRcdGxpbmVubzogZV93b3JrZXIubGluZW5vLFxuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cblx0XHRsZXQga19jaGFubmVsID0gbmV3IERDX0NIQU5ORUwoKTtcblxuXHRcdGtfY2hhbm5lbC5wb3J0XzEoKGRfcG9ydCkgPT4ge1xuXHRcdFx0dGhpcy5wb3J0LnBvc3RQb3J0KGRfcG9ydCwge1xuXHRcdFx0XHR0eXBlOiAnc3Vid29ya2VyJyxcblx0XHRcdFx0aWQ6IGhfbXNnLmlkLFxuXHRcdFx0XHRtYXN0ZXJfa2V5OiBpX3N1Yndvcmtlcixcblx0XHRcdH0pO1xuXHRcdH0pO1xuXG5cdFx0a19jaGFubmVsLnBvcnRfMigoZF9wb3J0KSA9PiB7XG5cdFx0XHRkX3N1Yndvcmtlci5wb3N0UG9ydChkX3BvcnQsIHtcblx0XHRcdFx0dHlwZTogJ293bmVyJyxcblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9XG5cblx0aGFuZGxlX3BpbmcoKSB7XG5cdFx0S19TRUxGLnBvc3RNZXNzYWdlKHtcblx0XHRcdHR5cGU6ICdwb25nJyxcblx0XHR9KTtcblx0fVxuXG5cdGhhbmRsZV90ZXJtaW5hdGUoaF9tc2cpIHtcblx0XHR0aGlzLnN1YndvcmtlcnNbaF9tc2cubWFzdGVyX2tleV0udGVybWluYXRlKCk7XG5cdH1cblxuXHRwcmVwYXJlKGhfdGFzaywgZmtfdGFzaywgYV9yb290cz1bXSkge1xuXHRcdGxldCBpX3Rhc2sgPSArK2lfZ3VpZDtcblxuXHRcdGxldCB7XG5cdFx0XHR0YXNrOiBzX3Rhc2ssXG5cdFx0XHRtYW5pZmVzdDoga19tYW5pZmVzdCxcblx0XHRcdHJlY2VpdmU6IGlfcmVjZWl2ZT0wLFxuXHRcdFx0aW5oZXJpdDogaV9pbmhlcml0PTAsXG5cdFx0XHRob2xkOiBiX2hvbGQ9ZmFsc2UsXG5cdFx0XHRldmVudHM6IGhfZXZlbnRzPW51bGwsXG5cdFx0fSA9IGhfdGFzaztcblxuXHRcdC8vIHNhdmUgY2FsbGJhY2tcblx0XHR0aGlzLmNhbGxiYWNrc1tpX3Rhc2tdID0gZmtfdGFzaztcblxuXHRcdC8vIHNhdmUgZXZlbnRzXG5cdFx0aWYoaF9ldmVudHMpIHtcblx0XHRcdHRoaXMuZXZlbnRzW2lfdGFza10gPSBoX2V2ZW50cztcblxuXHRcdFx0Ly8gd2hhdCB0byBzZW5kXG5cdFx0XHRsZXQgaF9ldmVudHNfc2VuZCA9e307XG5cdFx0XHRmb3IobGV0IHNfa2V5IGluIGhfZXZlbnRzKSB7XG5cdFx0XHRcdGhfZXZlbnRzX3NlbmRbc19rZXldID0gMTtcblx0XHRcdH1cblx0XHRcdGhfZXZlbnRzID0gaF9ldmVudHNfc2VuZDtcblx0XHR9XG5cblx0XHQvLyBzZW5kIHRhc2tcblx0XHRyZXR1cm4ge1xuXHRcdFx0bXNnOiB7XG5cdFx0XHRcdHR5cGU6ICd0YXNrJyxcblx0XHRcdFx0aWQ6IGlfdGFzayxcblx0XHRcdFx0dGFzazogc190YXNrLFxuXHRcdFx0XHRhcmdzOiBrX21hbmlmZXN0LmRhdGEsXG5cdFx0XHRcdHJlY2VpdmU6IGlfcmVjZWl2ZSxcblx0XHRcdFx0aW5oZXJpdDogaV9pbmhlcml0LFxuXHRcdFx0XHRob2xkOiBiX2hvbGQsXG5cdFx0XHRcdGV2ZW50czogaF9ldmVudHMsXG5cdFx0XHR9LFxuXHRcdFx0cGF0aHM6IGtfbWFuaWZlc3QucGF0aHMoLi4uYV9yb290cywgJ2FyZ3MnKSxcblx0XHR9O1xuXHR9XG5cblx0ZXhlYyhoX3Rhc2tfZXhlYywgZmtfdGFzaykge1xuXHRcdC8vIG1hcmsgd29ya2VyIGFzIGJ1c3lcblx0XHR0aGlzLmJ1c3kgPSB0cnVlO1xuXG5cdFx0Ly8gcHJlcGFyZSBmaW5hbCB0YXNrIGRlc2NyaXB0b3Jcblx0XHRsZXQgaF90YXNrID0gdGhpcy5wcmVwYXJlKGhfdGFza19leGVjLCBma190YXNrKTtcblxuXHRcdC8vIHRoaXMuZGVidWcoJ2V4ZWM6JytoX3Rhc2subXNnLmlkKTtcblxuXHRcdC8vIHBvc3QgdG8gd29ya2VyXG5cdFx0dGhpcy5wb3J0LnBvc3RNZXNzYWdlKGhfdGFzay5tc2csIGhfdGFzay5wYXRocyk7XG5cdH1cblxuXHQvLyBhc3NpZ24gYSB0YXNrIHRvIHRoZSB3b3JrZXJcblx0cnVuKHNfdGFzaywgel9hcmdzLCBoX2V2ZW50cywgZmtfcnVuKSB7XG5cdFx0Ly8gcHJlcGFyZSBmaW5hbCB0YXNrIGRlc2NyaXB0b3Jcblx0XHRsZXQgaF9leGVjID0ge1xuXHRcdFx0dGFzazogc190YXNrLFxuXHRcdFx0bWFuaWZlc3Q6IG1hbmlmZXN0LmZyb20oel9hcmdzKSxcblx0XHRcdGV2ZW50czogaF9ldmVudHMsXG5cdFx0fTtcblxuXHRcdC8vIHByZXZpb3VzIHJ1biB0YXNrXG5cdFx0aWYodGhpcy5wcmV2X3J1bl90YXNrKSB7XG5cdFx0XHRoX2V4ZWMuaW5oZXJpdCA9IHRoaXMucHJldl9ydW5fdGFzaztcblx0XHR9XG5cblx0XHQvLyBleGVjdXRlIHRhc2tcblx0XHRsZXQgZHBfZXhlYyA9IG5ldyBQcm9taXNlKChmX3Jlc29sdmUsIGZfcmVqZWN0KSA9PiB7XG5cdFx0XHR0aGlzLnRhc2tfZXJyb3IgPSBmX3JlamVjdDtcblx0XHRcdHRoaXMuZXhlYyhoX2V4ZWMsICh6X3Jlc3VsdCwgaV90YXNrKSA9PiB7XG5cdFx0XHRcdHRoaXMucHJldl9ydW5fdGFzayA9IGlfdGFzaztcblx0XHRcdFx0dGhpcy50YXNrX2Vycm9yID0gbnVsbDtcblx0XHRcdFx0Zl9yZXNvbHZlKHpfcmVzdWx0KTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXG5cdFx0Ly8gZW1iZWRkZWQgcmVzb2x2ZS9yZWplY3Rcblx0XHRpZignZnVuY3Rpb24nID09PSB0eXBlb2YgZmtfcnVuKSB7XG5cdFx0XHRkcF9leGVjLnRoZW4oKHpfcmVzdWx0KSA9PiB7XG5cdFx0XHRcdGZrX3J1bihudWxsLCB6X3Jlc3VsdCk7XG5cdFx0XHR9KS5jYXRjaCgoZV9leGVjKSA9PiB7XG5cdFx0XHRcdGZrX3J1bihlX2V4ZWMpO1xuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdC8vIHByb21pc2Vcblx0XHRlbHNlIHtcblx0XHRcdHJldHVybiBkcF9leGVjO1xuXHRcdH1cblx0fVxuXG5cdHJlY2VpdmUoZF9wb3J0LCBoX3JlY2VpdmUsIGZrX3Rhc2ssIHNfZGVidWc9bnVsbCkge1xuXHRcdGxldCBoX3Rhc2sgPSB0aGlzLnByZXBhcmUoaF9yZWNlaXZlLnRhc2tfcmVhZHksIGZrX3Rhc2ssIFsndGFza19yZWFkeSddKTtcblxuXHRcdGlmKHNfZGVidWcpIHRoaXMuZGVidWcoc19kZWJ1ZywgJz4+IHJlY2VpdmU6Jy5ncmVlbitoX3JlY2VpdmUuaW1wb3J0LCBoX3Rhc2subXNnLmlkLCBkX3BvcnQubmFtZSB8fCBkX3BvcnQpO1xuXG5cdFx0dGhpcy5wb3J0LnBvc3RQb3J0KGRfcG9ydCwge1xuXHRcdFx0dHlwZTogJ3JlY2VpdmUnLFxuXHRcdFx0aW1wb3J0OiBoX3JlY2VpdmUuaW1wb3J0LFxuXHRcdFx0c2VuZGVyOiBoX3JlY2VpdmUuc2VuZGVyLFxuXHRcdFx0cHJpbWFyeTogaF9yZWNlaXZlLnByaW1hcnksXG5cdFx0XHR0YXNrX3JlYWR5OiBPYmplY3QuYXNzaWduKGhfdGFzay5tc2csIHtkZWJ1ZzpzX2RlYnVnfSksXG5cdFx0XHRkZWJ1Zzogc19kZWJ1Zyxcblx0XHR9LCBbLi4uKGhfdGFzay5wYXRocyB8fCBbXSldKTtcblx0fVxuXG5cdHJlbGF5KGlfdGFza19zZW5kZXIsIGRfcG9ydCwgc19yZWNlaXZlciwgc19kZWJ1Zz1udWxsKSB7XG5cdFx0aWYoc19kZWJ1ZykgdGhpcy5kZWJ1ZyhzX2RlYnVnLCAnPj4gcmVsYXknLCBpX3Rhc2tfc2VuZGVyLCBkX3BvcnQubmFtZSB8fCBkX3BvcnQpO1xuXG5cdFx0dGhpcy5wb3J0LnBvc3RQb3J0KGRfcG9ydCwge1xuXHRcdFx0dHlwZTogJ3JlbGF5Jyxcblx0XHRcdGlkOiBpX3Rhc2tfc2VuZGVyLFxuXHRcdFx0ZGVidWc6IHNfZGVidWcsXG5cdFx0fSk7XG5cdH1cblxuXHRraWxsKHNfa2lsbCkge1xuXHRcdGlmKEJfQlJPV1NFUikge1xuXHRcdFx0cmV0dXJuIG5ldyBQcm9taXNlKChmX3Jlc29sdmUpID0+IHtcblx0XHRcdFx0dGhpcy5wb3J0LnRlcm1pbmF0ZSgpO1xuXHRcdFx0XHRmX3Jlc29sdmUoKTtcblx0XHRcdH0pO1xuXHRcdH1cblx0XHRlbHNlIHtcblx0XHRcdHJldHVybiB0aGlzLnBvcnQudGVybWluYXRlKHNfa2lsbCk7XG5cdFx0fVxuXHR9XG59XG5cblxuY29uc3QgbWtfbmV3ID0gKGRjKSA9PiBmdW5jdGlvbiguLi5hX2FyZ3MpIHtcblx0cmV0dXJuIG5ldyBkYyguLi5hX2FyZ3MpO1xufTtcblxuLy8gbm93IGltcG9ydCBhbnloaW5nIHRoYXQgZGVwZW5kcyBvbiB3b3JrZXJcbmNvbnN0IGdyb3VwID0gcmVxdWlyZSgnLi9hbGwvZ3JvdXAuanMnKSh3b3JrZXIpO1xuY29uc3QgcG9vbCA9IHJlcXVpcmUoJy4vYWxsL3Bvb2wuanMnKSh3b3JrZXIpO1xuXG5jb25zdCBIX0VYUE9SVFMgPSB7XG5cdHNwYXduKC4uLmFfYXJncykge1xuXHRcdHJldHVybiB3b3JrZXIuZnJvbV9zb3VyY2UoLi4uYV9hcmdzKTtcblx0fSxcblxuXHRuZXc6ICguLi5hX2FyZ3MpID0+IG5ldyB3b3JrZXIoLi4uYV9hcmdzKSxcblx0Z3JvdXA6IG1rX25ldyhncm91cCksXG5cdHBvb2w6IG1rX25ldyhwb29sKSxcblx0ZGVkaWNhdGVkOiBta19uZXcoZGVkaWNhdGVkKSxcblx0bWFuaWZlc3Q6IG1rX25ldyhtYW5pZmVzdCksXG5cdHJlc3VsdDogbWtfbmV3KHJlc3VsdCksXG5cblx0c3RyZWFtLFxuXHQvLyBzdHJlYW06IG1rX25ldyh3cml0YWJsZV9zdHJlYW0pLFxuXHQvLyBnZXQgc3RyZWFtKCkge1xuXHQvLyBcdGRlbGV0ZSB0aGlzLnN0cmVhbTtcblx0Ly8gXHRyZXR1cm4gdGhpcy5zdHJlYW0gPSByZXF1aXJlKCcuL3N0cmVhbS5qcycpO1xuXHQvLyB9LFxuXG5cdC8vIHN0YXRlc1xuXHRicm93c2VyOiBCX0JST1dTRVIsXG5cdGJyb3dzZXJpZnk6IEJfQlJPV1NFUklGWSxcblx0Ly8gZGVwdGg6IFdPUktFUl9ERVBUSFxuXG5cdC8vIGltcG9ydCB0eXBlZCBhcnJheXMgaW50byB0aGUgZ2l2ZW4gc2NvcGVcblx0Z2xvYmFsczogKGhfc2NvcGU9e30pID0+IE9iamVjdC5hc3NpZ24oaF9zY29wZSwgSF9UWVBFRF9BUlJBWVMuZXhwb3J0cyksXG5cblx0Ly8gZm9yIGNvbXBhdGliaWxpdHkgd2l0aCBicm93c2VyaWZ5XG5cdHNjb3BpZnkoZl9yZXF1aXJlLCBhX3NvdXJjZXMsIGRfYXJndW1lbnRzKSB7XG5cdFx0Ly8gYnJvd3NlcmlmeSBhcmd1bWVudHNcblx0XHRsZXQgYV9icm93c2VyaWZ5ID0gZF9hcmd1bWVudHM/IFtkX2FyZ3VtZW50c1szXSwgZF9hcmd1bWVudHNbNF0sIGRfYXJndW1lbnRzWzVdXTogbnVsbDtcblxuXHRcdC8vIHJ1bm5pbmcgaW4gYnJvd3NlcmlmeVxuXHRcdGlmKEJfQlJPV1NFUklGWSkge1xuXHRcdFx0Y29uc3QgbGF0ZW50X3N1YndvcmtlciA9IHJlcXVpcmUoJy4vYnJvd3Nlci9sYXRlbnQtc3Vid29ya2VyLmpzJyk7XG5cblx0XHRcdC8vIGNoYW5nZSBob3cgYSB3b3JrZXIgaXMgc3Bhd25lZFxuXHRcdFx0c3Bhd25fd29ya2VyID0gKHBfc291cmNlLCBoX29wdGlvbnMpID0+IHtcblx0XHRcdFx0Ly8gd29ya2Fyb3VuZCBmb3IgY2hyb21pdW0gYnVnIHRoYXQgY2Fubm90IHNwYXduIHN1YndvcmtlcnNcblx0XHRcdFx0aWYoIUJfV09SS0VSX1NVUFBPUlRFRCkge1xuXHRcdFx0XHRcdGxldCBrX3N1YndvcmtlciA9IG5ldyBsYXRlbnRfc3Vid29ya2VyKCk7XG5cblx0XHRcdFx0XHQvLyBzZW5kIG1lc3NhZ2UgdG8gbWFzdGVyIHJlcXVlc3Rpbmcgc3Bhd24gb2YgbmV3IHdvcmtlclxuXHRcdFx0XHRcdEtfU0VMRi5wb3N0TWVzc2FnZSh7XG5cdFx0XHRcdFx0XHR0eXBlOiAnc3Bhd24nLFxuXHRcdFx0XHRcdFx0aWQ6IGtfc3Vid29ya2VyLmlkLFxuXHRcdFx0XHRcdFx0c291cmNlOiBwX3NvdXJjZSxcblx0XHRcdFx0XHRcdG9wdGlvbnM6IGhfb3B0aW9ucyxcblx0XHRcdFx0XHR9KTtcblxuXHRcdFx0XHRcdHJldHVybiBrX3N1Yndvcmtlcjtcblx0XHRcdFx0fVxuXHRcdFx0XHQvLyB3b3JrZXIgaXMgZGVmaW5lZFxuXHRcdFx0XHRlbHNlIHtcblx0XHRcdFx0XHRsZXQgel9pbXBvcnQgPSBmX3JlcXVpcmUocF9zb3VyY2UpO1xuXHRcdFx0XHRcdHJldHVybiB3ZWJ3b3JrZXJpZnkoel9pbXBvcnQsIHtcblx0XHRcdFx0XHRcdGJyb3dzZXJpZnk6IGFfYnJvd3NlcmlmeSxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXHRcdFx0fTtcblx0XHR9XG5cblx0XHQvLyBub3JtYWwgZXhwb3J0c1xuXHRcdHJldHVybiBIX0VYUE9SVFM7XG5cdH0sXG5cblx0bWVyZ2Vfc29ydGVkKGFfYSwgYV9iLCBmX2NtcCkge1xuXHRcdC8vIG91dHB1dCBsaXN0XG5cdFx0bGV0IGFfb3V0ID0gW107XG5cblx0XHQvLyBpbmRleCBvZiBuZXh0IGl0ZW0gZnJvbSBlYWNoIGxpc3Rcblx0XHRsZXQgaV9hID0gMDtcblx0XHRsZXQgaV9iID0gMDtcblxuXHRcdC8vIGN1cnJlbnQgaXRlbSBmcm9tIGVhY2ggbGlzdFxuXHRcdGxldCB6X2EgPSBhX2FbMF07XG5cdFx0bGV0IHpfYiA9IGFfYlswXTtcblxuXHRcdC8vIGZpbmFsIGluZGV4IG9mIGVhY2ggbGlzdFxuXHRcdGxldCBpaF9hID0gYV9hLmxlbmd0aCAtIDE7XG5cdFx0bGV0IGloX2IgPSBhX2IubGVuZ3RoIC0gMTtcblxuXHRcdC8vIG1lcmdlXG5cdFx0Zm9yKDs7KSB7XG5cdFx0XHQvLyBhIHdpbnNcblx0XHRcdGlmKGZfY21wKHpfYSwgel9iKSA8IDApIHtcblx0XHRcdFx0Ly8gYWRkIHRvIG91dHB1dCBsaXN0XG5cdFx0XHRcdGFfb3V0LnB1c2goel9hKTtcblxuXHRcdFx0XHQvLyByZWFjaGVkIGVuZCBvZiBhXG5cdFx0XHRcdGlmKGlfYSA9PT0gaWhfYSkgYnJlYWs7XG5cblx0XHRcdFx0Ly8gbmV4dCBpdGVtIGZyb20gYVxuXHRcdFx0XHR6X2EgPSBhX2FbKytpX2FdO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYiB3aW5zXG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0Ly8gYWRkIHRvIG91dHB1dCBsaXN0XG5cdFx0XHRcdGFfb3V0LnB1c2goel9iKTtcblxuXHRcdFx0XHQvLyByZWFjaGVkIGVuZCBvZiBiXG5cdFx0XHRcdGlmKGlfYiA9PT0gaWhfYikgYnJlYWs7XG5cblx0XHRcdFx0Ly8gbmV4dCBpdGVtIGZyb20gYlxuXHRcdFx0XHR6X2IgPSBhX2JbKytpX2JdO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIGEgZmluaXNoZWQgZmlyc3Rcblx0XHRpZihpX2EgPT09IGloX2EpIHtcblx0XHRcdC8vIGFwcGVuZCByZW1haW5kZXIgb2YgYlxuXHRcdFx0YV9vdXQucHVzaChhX2Iuc2xpY2UoaV9iKSk7XG5cdFx0fVxuXHRcdC8vIGIgZmluaXNoZWQgZmlyc3Rcblx0XHRlbHNlIHtcblx0XHRcdC8vIGFwcGVuZCByZW1haW5kZXIgb2YgYVxuXHRcdFx0YV9vdXQucHVzaChhX2Euc2xpY2UoaV9hKSk7XG5cdFx0fVxuXG5cdFx0Ly8gcmVzdWx0XG5cdFx0cmV0dXJuIGFfb3V0O1xuXHR9LFxufTtcblxuXG5tb2R1bGUuZXhwb3J0cyA9IE9iamVjdC5hc3NpZ24oZnVuY3Rpb24oLi4uYV9hcmdzKSB7XG5cdC8vIGNhbGxlZCBmcm9tIHdvcmtlclxuXHRpZihYTV9DT05URVhUX1dPUktFUiAmIFhfQ09OVEVYVF9UWVBFKSB7XG5cdFx0Ly8gZGVkaWNhdGVkIHdvcmtlclxuXHRcdGlmKFhNX0NPTlRFWFRfV09SS0VSX0RFRElDQVRFRCA9PT0gWF9DT05URVhUX1RZUEUpIHtcblx0XHRcdHJldHVybiBuZXcgZGVkaWNhdGVkKC4uLmFfYXJncyk7XG5cdFx0fVxuXHRcdC8vIHNoYXJlZCB3b3JrZXJcblx0XHRlbHNlIGlmKFhNX0NPTlRFWFRfV09SS0VSX1NIQVJFRCA9PT0gWF9DT05URVhUX1RZUEUpIHtcblx0XHRcdC8vIHJldHVybiBuZXcgc2hhcmVkKC4uLmFfYXJncyk7XG5cdFx0fVxuXHRcdC8vIHNlcnZpY2Ugd29ya2VyXG5cdFx0ZWxzZSBpZihYTV9DT05URVhUX1dPUktFUl9TRVJWSUNFID09PSBYX0NPTlRFWFRfVFlQRSkge1xuXHRcdFx0Ly8gcmV0dXJuIG5ldyBzZXJ2aWNlKC4uLmFfYXJncyk7XG5cdFx0fVxuXHR9XG5cdC8vIGNoaWxkIHByb2Nlc3M7IGRlZGljYXRlZCB3b3JrZXJcblx0ZWxzZSBpZihYTV9DT05URVhUX1BST0NFU1NfQ0hJTEQgPT09IFhfQ09OVEVYVF9UWVBFKSB7XG5cdFx0cmV0dXJuIG5ldyBkZWRpY2F0ZWQoLi4uYV9hcmdzKTtcblx0fVxuXHQvLyBtYXN0ZXJcblx0ZWxzZSB7XG5cdFx0cmV0dXJuIHdvcmtlci5mcm9tX3NvdXJjZSguLi5hX2FyZ3MpO1xuXHR9XG59LCBIX0VYUE9SVFMpO1xuXG4iLCIndXNlIHN0cmljdCc7XG5cbi8vIGNvbXBhcmUgYW5kIGlzQnVmZmVyIHRha2VuIGZyb20gaHR0cHM6Ly9naXRodWIuY29tL2Zlcm9zcy9idWZmZXIvYmxvYi82ODBlOWU1ZTQ4OGYyMmFhYzI3NTk5YTU3ZGM4NDRhNjMxNTkyOGRkL2luZGV4LmpzXG4vLyBvcmlnaW5hbCBub3RpY2U6XG5cbi8qIVxuICogVGhlIGJ1ZmZlciBtb2R1bGUgZnJvbSBub2RlLmpzLCBmb3IgdGhlIGJyb3dzZXIuXG4gKlxuICogQGF1dGhvciAgIEZlcm9zcyBBYm91a2hhZGlqZWggPGZlcm9zc0BmZXJvc3Mub3JnPiA8aHR0cDovL2Zlcm9zcy5vcmc+XG4gKiBAbGljZW5zZSAgTUlUXG4gKi9cbmZ1bmN0aW9uIGNvbXBhcmUoYSwgYikge1xuICBpZiAoYSA9PT0gYikge1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgdmFyIHggPSBhLmxlbmd0aDtcbiAgdmFyIHkgPSBiLmxlbmd0aDtcblxuICBmb3IgKHZhciBpID0gMCwgbGVuID0gTWF0aC5taW4oeCwgeSk7IGkgPCBsZW47ICsraSkge1xuICAgIGlmIChhW2ldICE9PSBiW2ldKSB7XG4gICAgICB4ID0gYVtpXTtcbiAgICAgIHkgPSBiW2ldO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgaWYgKHggPCB5KSB7XG4gICAgcmV0dXJuIC0xO1xuICB9XG4gIGlmICh5IDwgeCkge1xuICAgIHJldHVybiAxO1xuICB9XG4gIHJldHVybiAwO1xufVxuZnVuY3Rpb24gaXNCdWZmZXIoYikge1xuICBpZiAoZ2xvYmFsLkJ1ZmZlciAmJiB0eXBlb2YgZ2xvYmFsLkJ1ZmZlci5pc0J1ZmZlciA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiBnbG9iYWwuQnVmZmVyLmlzQnVmZmVyKGIpO1xuICB9XG4gIHJldHVybiAhIShiICE9IG51bGwgJiYgYi5faXNCdWZmZXIpO1xufVxuXG4vLyBiYXNlZCBvbiBub2RlIGFzc2VydCwgb3JpZ2luYWwgbm90aWNlOlxuXG4vLyBodHRwOi8vd2lraS5jb21tb25qcy5vcmcvd2lraS9Vbml0X1Rlc3RpbmcvMS4wXG4vL1xuLy8gVEhJUyBJUyBOT1QgVEVTVEVEIE5PUiBMSUtFTFkgVE8gV09SSyBPVVRTSURFIFY4IVxuLy9cbi8vIE9yaWdpbmFsbHkgZnJvbSBuYXJ3aGFsLmpzIChodHRwOi8vbmFyd2hhbGpzLm9yZylcbi8vIENvcHlyaWdodCAoYykgMjAwOSBUaG9tYXMgUm9iaW5zb24gPDI4MG5vcnRoLmNvbT5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XG4vLyBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSAnU29mdHdhcmUnKSwgdG9cbi8vIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlXG4vLyByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Jcbi8vIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzXG4vLyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4vLyBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgJ0FTIElTJywgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuLy8gSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4vLyBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcbi8vIEFVVEhPUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOXG4vLyBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OXG4vLyBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxudmFyIHV0aWwgPSByZXF1aXJlKCd1dGlsLycpO1xudmFyIGhhc093biA9IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHk7XG52YXIgcFNsaWNlID0gQXJyYXkucHJvdG90eXBlLnNsaWNlO1xudmFyIGZ1bmN0aW9uc0hhdmVOYW1lcyA9IChmdW5jdGlvbiAoKSB7XG4gIHJldHVybiBmdW5jdGlvbiBmb28oKSB7fS5uYW1lID09PSAnZm9vJztcbn0oKSk7XG5mdW5jdGlvbiBwVG9TdHJpbmcgKG9iaikge1xuICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKG9iaik7XG59XG5mdW5jdGlvbiBpc1ZpZXcoYXJyYnVmKSB7XG4gIGlmIChpc0J1ZmZlcihhcnJidWYpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmICh0eXBlb2YgZ2xvYmFsLkFycmF5QnVmZmVyICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmICh0eXBlb2YgQXJyYXlCdWZmZXIuaXNWaWV3ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgcmV0dXJuIEFycmF5QnVmZmVyLmlzVmlldyhhcnJidWYpO1xuICB9XG4gIGlmICghYXJyYnVmKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmIChhcnJidWYgaW5zdGFuY2VvZiBEYXRhVmlldykge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmIChhcnJidWYuYnVmZmVyICYmIGFycmJ1Zi5idWZmZXIgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cbi8vIDEuIFRoZSBhc3NlcnQgbW9kdWxlIHByb3ZpZGVzIGZ1bmN0aW9ucyB0aGF0IHRocm93XG4vLyBBc3NlcnRpb25FcnJvcidzIHdoZW4gcGFydGljdWxhciBjb25kaXRpb25zIGFyZSBub3QgbWV0LiBUaGVcbi8vIGFzc2VydCBtb2R1bGUgbXVzdCBjb25mb3JtIHRvIHRoZSBmb2xsb3dpbmcgaW50ZXJmYWNlLlxuXG52YXIgYXNzZXJ0ID0gbW9kdWxlLmV4cG9ydHMgPSBvaztcblxuLy8gMi4gVGhlIEFzc2VydGlvbkVycm9yIGlzIGRlZmluZWQgaW4gYXNzZXJ0LlxuLy8gbmV3IGFzc2VydC5Bc3NlcnRpb25FcnJvcih7IG1lc3NhZ2U6IG1lc3NhZ2UsXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYWN0dWFsOiBhY3R1YWwsXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhwZWN0ZWQ6IGV4cGVjdGVkIH0pXG5cbnZhciByZWdleCA9IC9cXHMqZnVuY3Rpb25cXHMrKFteXFwoXFxzXSopXFxzKi87XG4vLyBiYXNlZCBvbiBodHRwczovL2dpdGh1Yi5jb20vbGpoYXJiL2Z1bmN0aW9uLnByb3RvdHlwZS5uYW1lL2Jsb2IvYWRlZWVlYzhiZmNjNjA2OGIxODdkN2Q5ZmIzZDViYjFkM2EzMDg5OS9pbXBsZW1lbnRhdGlvbi5qc1xuZnVuY3Rpb24gZ2V0TmFtZShmdW5jKSB7XG4gIGlmICghdXRpbC5pc0Z1bmN0aW9uKGZ1bmMpKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChmdW5jdGlvbnNIYXZlTmFtZXMpIHtcbiAgICByZXR1cm4gZnVuYy5uYW1lO1xuICB9XG4gIHZhciBzdHIgPSBmdW5jLnRvU3RyaW5nKCk7XG4gIHZhciBtYXRjaCA9IHN0ci5tYXRjaChyZWdleCk7XG4gIHJldHVybiBtYXRjaCAmJiBtYXRjaFsxXTtcbn1cbmFzc2VydC5Bc3NlcnRpb25FcnJvciA9IGZ1bmN0aW9uIEFzc2VydGlvbkVycm9yKG9wdGlvbnMpIHtcbiAgdGhpcy5uYW1lID0gJ0Fzc2VydGlvbkVycm9yJztcbiAgdGhpcy5hY3R1YWwgPSBvcHRpb25zLmFjdHVhbDtcbiAgdGhpcy5leHBlY3RlZCA9IG9wdGlvbnMuZXhwZWN0ZWQ7XG4gIHRoaXMub3BlcmF0b3IgPSBvcHRpb25zLm9wZXJhdG9yO1xuICBpZiAob3B0aW9ucy5tZXNzYWdlKSB7XG4gICAgdGhpcy5tZXNzYWdlID0gb3B0aW9ucy5tZXNzYWdlO1xuICAgIHRoaXMuZ2VuZXJhdGVkTWVzc2FnZSA9IGZhbHNlO1xuICB9IGVsc2Uge1xuICAgIHRoaXMubWVzc2FnZSA9IGdldE1lc3NhZ2UodGhpcyk7XG4gICAgdGhpcy5nZW5lcmF0ZWRNZXNzYWdlID0gdHJ1ZTtcbiAgfVxuICB2YXIgc3RhY2tTdGFydEZ1bmN0aW9uID0gb3B0aW9ucy5zdGFja1N0YXJ0RnVuY3Rpb24gfHwgZmFpbDtcbiAgaWYgKEVycm9yLmNhcHR1cmVTdGFja1RyYWNlKSB7XG4gICAgRXJyb3IuY2FwdHVyZVN0YWNrVHJhY2UodGhpcywgc3RhY2tTdGFydEZ1bmN0aW9uKTtcbiAgfSBlbHNlIHtcbiAgICAvLyBub24gdjggYnJvd3NlcnMgc28gd2UgY2FuIGhhdmUgYSBzdGFja3RyYWNlXG4gICAgdmFyIGVyciA9IG5ldyBFcnJvcigpO1xuICAgIGlmIChlcnIuc3RhY2spIHtcbiAgICAgIHZhciBvdXQgPSBlcnIuc3RhY2s7XG5cbiAgICAgIC8vIHRyeSB0byBzdHJpcCB1c2VsZXNzIGZyYW1lc1xuICAgICAgdmFyIGZuX25hbWUgPSBnZXROYW1lKHN0YWNrU3RhcnRGdW5jdGlvbik7XG4gICAgICB2YXIgaWR4ID0gb3V0LmluZGV4T2YoJ1xcbicgKyBmbl9uYW1lKTtcbiAgICAgIGlmIChpZHggPj0gMCkge1xuICAgICAgICAvLyBvbmNlIHdlIGhhdmUgbG9jYXRlZCB0aGUgZnVuY3Rpb24gZnJhbWVcbiAgICAgICAgLy8gd2UgbmVlZCB0byBzdHJpcCBvdXQgZXZlcnl0aGluZyBiZWZvcmUgaXQgKGFuZCBpdHMgbGluZSlcbiAgICAgICAgdmFyIG5leHRfbGluZSA9IG91dC5pbmRleE9mKCdcXG4nLCBpZHggKyAxKTtcbiAgICAgICAgb3V0ID0gb3V0LnN1YnN0cmluZyhuZXh0X2xpbmUgKyAxKTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5zdGFjayA9IG91dDtcbiAgICB9XG4gIH1cbn07XG5cbi8vIGFzc2VydC5Bc3NlcnRpb25FcnJvciBpbnN0YW5jZW9mIEVycm9yXG51dGlsLmluaGVyaXRzKGFzc2VydC5Bc3NlcnRpb25FcnJvciwgRXJyb3IpO1xuXG5mdW5jdGlvbiB0cnVuY2F0ZShzLCBuKSB7XG4gIGlmICh0eXBlb2YgcyA9PT0gJ3N0cmluZycpIHtcbiAgICByZXR1cm4gcy5sZW5ndGggPCBuID8gcyA6IHMuc2xpY2UoMCwgbik7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIHM7XG4gIH1cbn1cbmZ1bmN0aW9uIGluc3BlY3Qoc29tZXRoaW5nKSB7XG4gIGlmIChmdW5jdGlvbnNIYXZlTmFtZXMgfHwgIXV0aWwuaXNGdW5jdGlvbihzb21ldGhpbmcpKSB7XG4gICAgcmV0dXJuIHV0aWwuaW5zcGVjdChzb21ldGhpbmcpO1xuICB9XG4gIHZhciByYXduYW1lID0gZ2V0TmFtZShzb21ldGhpbmcpO1xuICB2YXIgbmFtZSA9IHJhd25hbWUgPyAnOiAnICsgcmF3bmFtZSA6ICcnO1xuICByZXR1cm4gJ1tGdW5jdGlvbicgKyAgbmFtZSArICddJztcbn1cbmZ1bmN0aW9uIGdldE1lc3NhZ2Uoc2VsZikge1xuICByZXR1cm4gdHJ1bmNhdGUoaW5zcGVjdChzZWxmLmFjdHVhbCksIDEyOCkgKyAnICcgK1xuICAgICAgICAgc2VsZi5vcGVyYXRvciArICcgJyArXG4gICAgICAgICB0cnVuY2F0ZShpbnNwZWN0KHNlbGYuZXhwZWN0ZWQpLCAxMjgpO1xufVxuXG4vLyBBdCBwcmVzZW50IG9ubHkgdGhlIHRocmVlIGtleXMgbWVudGlvbmVkIGFib3ZlIGFyZSB1c2VkIGFuZFxuLy8gdW5kZXJzdG9vZCBieSB0aGUgc3BlYy4gSW1wbGVtZW50YXRpb25zIG9yIHN1YiBtb2R1bGVzIGNhbiBwYXNzXG4vLyBvdGhlciBrZXlzIHRvIHRoZSBBc3NlcnRpb25FcnJvcidzIGNvbnN0cnVjdG9yIC0gdGhleSB3aWxsIGJlXG4vLyBpZ25vcmVkLlxuXG4vLyAzLiBBbGwgb2YgdGhlIGZvbGxvd2luZyBmdW5jdGlvbnMgbXVzdCB0aHJvdyBhbiBBc3NlcnRpb25FcnJvclxuLy8gd2hlbiBhIGNvcnJlc3BvbmRpbmcgY29uZGl0aW9uIGlzIG5vdCBtZXQsIHdpdGggYSBtZXNzYWdlIHRoYXRcbi8vIG1heSBiZSB1bmRlZmluZWQgaWYgbm90IHByb3ZpZGVkLiAgQWxsIGFzc2VydGlvbiBtZXRob2RzIHByb3ZpZGVcbi8vIGJvdGggdGhlIGFjdHVhbCBhbmQgZXhwZWN0ZWQgdmFsdWVzIHRvIHRoZSBhc3NlcnRpb24gZXJyb3IgZm9yXG4vLyBkaXNwbGF5IHB1cnBvc2VzLlxuXG5mdW5jdGlvbiBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsIG9wZXJhdG9yLCBzdGFja1N0YXJ0RnVuY3Rpb24pIHtcbiAgdGhyb3cgbmV3IGFzc2VydC5Bc3NlcnRpb25FcnJvcih7XG4gICAgbWVzc2FnZTogbWVzc2FnZSxcbiAgICBhY3R1YWw6IGFjdHVhbCxcbiAgICBleHBlY3RlZDogZXhwZWN0ZWQsXG4gICAgb3BlcmF0b3I6IG9wZXJhdG9yLFxuICAgIHN0YWNrU3RhcnRGdW5jdGlvbjogc3RhY2tTdGFydEZ1bmN0aW9uXG4gIH0pO1xufVxuXG4vLyBFWFRFTlNJT04hIGFsbG93cyBmb3Igd2VsbCBiZWhhdmVkIGVycm9ycyBkZWZpbmVkIGVsc2V3aGVyZS5cbmFzc2VydC5mYWlsID0gZmFpbDtcblxuLy8gNC4gUHVyZSBhc3NlcnRpb24gdGVzdHMgd2hldGhlciBhIHZhbHVlIGlzIHRydXRoeSwgYXMgZGV0ZXJtaW5lZFxuLy8gYnkgISFndWFyZC5cbi8vIGFzc2VydC5vayhndWFyZCwgbWVzc2FnZV9vcHQpO1xuLy8gVGhpcyBzdGF0ZW1lbnQgaXMgZXF1aXZhbGVudCB0byBhc3NlcnQuZXF1YWwodHJ1ZSwgISFndWFyZCxcbi8vIG1lc3NhZ2Vfb3B0KTsuIFRvIHRlc3Qgc3RyaWN0bHkgZm9yIHRoZSB2YWx1ZSB0cnVlLCB1c2Vcbi8vIGFzc2VydC5zdHJpY3RFcXVhbCh0cnVlLCBndWFyZCwgbWVzc2FnZV9vcHQpOy5cblxuZnVuY3Rpb24gb2sodmFsdWUsIG1lc3NhZ2UpIHtcbiAgaWYgKCF2YWx1ZSkgZmFpbCh2YWx1ZSwgdHJ1ZSwgbWVzc2FnZSwgJz09JywgYXNzZXJ0Lm9rKTtcbn1cbmFzc2VydC5vayA9IG9rO1xuXG4vLyA1LiBUaGUgZXF1YWxpdHkgYXNzZXJ0aW9uIHRlc3RzIHNoYWxsb3csIGNvZXJjaXZlIGVxdWFsaXR5IHdpdGhcbi8vID09LlxuLy8gYXNzZXJ0LmVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2Vfb3B0KTtcblxuYXNzZXJ0LmVxdWFsID0gZnVuY3Rpb24gZXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICBpZiAoYWN0dWFsICE9IGV4cGVjdGVkKSBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsICc9PScsIGFzc2VydC5lcXVhbCk7XG59O1xuXG4vLyA2LiBUaGUgbm9uLWVxdWFsaXR5IGFzc2VydGlvbiB0ZXN0cyBmb3Igd2hldGhlciB0d28gb2JqZWN0cyBhcmUgbm90IGVxdWFsXG4vLyB3aXRoICE9IGFzc2VydC5ub3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlX29wdCk7XG5cbmFzc2VydC5ub3RFcXVhbCA9IGZ1bmN0aW9uIG5vdEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgaWYgKGFjdHVhbCA9PSBleHBlY3RlZCkge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJyE9JywgYXNzZXJ0Lm5vdEVxdWFsKTtcbiAgfVxufTtcblxuLy8gNy4gVGhlIGVxdWl2YWxlbmNlIGFzc2VydGlvbiB0ZXN0cyBhIGRlZXAgZXF1YWxpdHkgcmVsYXRpb24uXG4vLyBhc3NlcnQuZGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2Vfb3B0KTtcblxuYXNzZXJ0LmRlZXBFcXVhbCA9IGZ1bmN0aW9uIGRlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmICghX2RlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBmYWxzZSkpIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsICdkZWVwRXF1YWwnLCBhc3NlcnQuZGVlcEVxdWFsKTtcbiAgfVxufTtcblxuYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCA9IGZ1bmN0aW9uIGRlZXBTdHJpY3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmICghX2RlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCB0cnVlKSkge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJ2RlZXBTdHJpY3RFcXVhbCcsIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwpO1xuICB9XG59O1xuXG5mdW5jdGlvbiBfZGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIHN0cmljdCwgbWVtb3MpIHtcbiAgLy8gNy4xLiBBbGwgaWRlbnRpY2FsIHZhbHVlcyBhcmUgZXF1aXZhbGVudCwgYXMgZGV0ZXJtaW5lZCBieSA9PT0uXG4gIGlmIChhY3R1YWwgPT09IGV4cGVjdGVkKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gZWxzZSBpZiAoaXNCdWZmZXIoYWN0dWFsKSAmJiBpc0J1ZmZlcihleHBlY3RlZCkpIHtcbiAgICByZXR1cm4gY29tcGFyZShhY3R1YWwsIGV4cGVjdGVkKSA9PT0gMDtcblxuICAvLyA3LjIuIElmIHRoZSBleHBlY3RlZCB2YWx1ZSBpcyBhIERhdGUgb2JqZWN0LCB0aGUgYWN0dWFsIHZhbHVlIGlzXG4gIC8vIGVxdWl2YWxlbnQgaWYgaXQgaXMgYWxzbyBhIERhdGUgb2JqZWN0IHRoYXQgcmVmZXJzIHRvIHRoZSBzYW1lIHRpbWUuXG4gIH0gZWxzZSBpZiAodXRpbC5pc0RhdGUoYWN0dWFsKSAmJiB1dGlsLmlzRGF0ZShleHBlY3RlZCkpIHtcbiAgICByZXR1cm4gYWN0dWFsLmdldFRpbWUoKSA9PT0gZXhwZWN0ZWQuZ2V0VGltZSgpO1xuXG4gIC8vIDcuMyBJZiB0aGUgZXhwZWN0ZWQgdmFsdWUgaXMgYSBSZWdFeHAgb2JqZWN0LCB0aGUgYWN0dWFsIHZhbHVlIGlzXG4gIC8vIGVxdWl2YWxlbnQgaWYgaXQgaXMgYWxzbyBhIFJlZ0V4cCBvYmplY3Qgd2l0aCB0aGUgc2FtZSBzb3VyY2UgYW5kXG4gIC8vIHByb3BlcnRpZXMgKGBnbG9iYWxgLCBgbXVsdGlsaW5lYCwgYGxhc3RJbmRleGAsIGBpZ25vcmVDYXNlYCkuXG4gIH0gZWxzZSBpZiAodXRpbC5pc1JlZ0V4cChhY3R1YWwpICYmIHV0aWwuaXNSZWdFeHAoZXhwZWN0ZWQpKSB7XG4gICAgcmV0dXJuIGFjdHVhbC5zb3VyY2UgPT09IGV4cGVjdGVkLnNvdXJjZSAmJlxuICAgICAgICAgICBhY3R1YWwuZ2xvYmFsID09PSBleHBlY3RlZC5nbG9iYWwgJiZcbiAgICAgICAgICAgYWN0dWFsLm11bHRpbGluZSA9PT0gZXhwZWN0ZWQubXVsdGlsaW5lICYmXG4gICAgICAgICAgIGFjdHVhbC5sYXN0SW5kZXggPT09IGV4cGVjdGVkLmxhc3RJbmRleCAmJlxuICAgICAgICAgICBhY3R1YWwuaWdub3JlQ2FzZSA9PT0gZXhwZWN0ZWQuaWdub3JlQ2FzZTtcblxuICAvLyA3LjQuIE90aGVyIHBhaXJzIHRoYXQgZG8gbm90IGJvdGggcGFzcyB0eXBlb2YgdmFsdWUgPT0gJ29iamVjdCcsXG4gIC8vIGVxdWl2YWxlbmNlIGlzIGRldGVybWluZWQgYnkgPT0uXG4gIH0gZWxzZSBpZiAoKGFjdHVhbCA9PT0gbnVsbCB8fCB0eXBlb2YgYWN0dWFsICE9PSAnb2JqZWN0JykgJiZcbiAgICAgICAgICAgICAoZXhwZWN0ZWQgPT09IG51bGwgfHwgdHlwZW9mIGV4cGVjdGVkICE9PSAnb2JqZWN0JykpIHtcbiAgICByZXR1cm4gc3RyaWN0ID8gYWN0dWFsID09PSBleHBlY3RlZCA6IGFjdHVhbCA9PSBleHBlY3RlZDtcblxuICAvLyBJZiBib3RoIHZhbHVlcyBhcmUgaW5zdGFuY2VzIG9mIHR5cGVkIGFycmF5cywgd3JhcCB0aGVpciB1bmRlcmx5aW5nXG4gIC8vIEFycmF5QnVmZmVycyBpbiBhIEJ1ZmZlciBlYWNoIHRvIGluY3JlYXNlIHBlcmZvcm1hbmNlXG4gIC8vIFRoaXMgb3B0aW1pemF0aW9uIHJlcXVpcmVzIHRoZSBhcnJheXMgdG8gaGF2ZSB0aGUgc2FtZSB0eXBlIGFzIGNoZWNrZWQgYnlcbiAgLy8gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZyAoYWthIHBUb1N0cmluZykuIE5ldmVyIHBlcmZvcm0gYmluYXJ5XG4gIC8vIGNvbXBhcmlzb25zIGZvciBGbG9hdCpBcnJheXMsIHRob3VnaCwgc2luY2UgZS5nLiArMCA9PT0gLTAgYnV0IHRoZWlyXG4gIC8vIGJpdCBwYXR0ZXJucyBhcmUgbm90IGlkZW50aWNhbC5cbiAgfSBlbHNlIGlmIChpc1ZpZXcoYWN0dWFsKSAmJiBpc1ZpZXcoZXhwZWN0ZWQpICYmXG4gICAgICAgICAgICAgcFRvU3RyaW5nKGFjdHVhbCkgPT09IHBUb1N0cmluZyhleHBlY3RlZCkgJiZcbiAgICAgICAgICAgICAhKGFjdHVhbCBpbnN0YW5jZW9mIEZsb2F0MzJBcnJheSB8fFxuICAgICAgICAgICAgICAgYWN0dWFsIGluc3RhbmNlb2YgRmxvYXQ2NEFycmF5KSkge1xuICAgIHJldHVybiBjb21wYXJlKG5ldyBVaW50OEFycmF5KGFjdHVhbC5idWZmZXIpLFxuICAgICAgICAgICAgICAgICAgIG5ldyBVaW50OEFycmF5KGV4cGVjdGVkLmJ1ZmZlcikpID09PSAwO1xuXG4gIC8vIDcuNSBGb3IgYWxsIG90aGVyIE9iamVjdCBwYWlycywgaW5jbHVkaW5nIEFycmF5IG9iamVjdHMsIGVxdWl2YWxlbmNlIGlzXG4gIC8vIGRldGVybWluZWQgYnkgaGF2aW5nIHRoZSBzYW1lIG51bWJlciBvZiBvd25lZCBwcm9wZXJ0aWVzIChhcyB2ZXJpZmllZFxuICAvLyB3aXRoIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCksIHRoZSBzYW1lIHNldCBvZiBrZXlzXG4gIC8vIChhbHRob3VnaCBub3QgbmVjZXNzYXJpbHkgdGhlIHNhbWUgb3JkZXIpLCBlcXVpdmFsZW50IHZhbHVlcyBmb3IgZXZlcnlcbiAgLy8gY29ycmVzcG9uZGluZyBrZXksIGFuZCBhbiBpZGVudGljYWwgJ3Byb3RvdHlwZScgcHJvcGVydHkuIE5vdGU6IHRoaXNcbiAgLy8gYWNjb3VudHMgZm9yIGJvdGggbmFtZWQgYW5kIGluZGV4ZWQgcHJvcGVydGllcyBvbiBBcnJheXMuXG4gIH0gZWxzZSBpZiAoaXNCdWZmZXIoYWN0dWFsKSAhPT0gaXNCdWZmZXIoZXhwZWN0ZWQpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9IGVsc2Uge1xuICAgIG1lbW9zID0gbWVtb3MgfHwge2FjdHVhbDogW10sIGV4cGVjdGVkOiBbXX07XG5cbiAgICB2YXIgYWN0dWFsSW5kZXggPSBtZW1vcy5hY3R1YWwuaW5kZXhPZihhY3R1YWwpO1xuICAgIGlmIChhY3R1YWxJbmRleCAhPT0gLTEpIHtcbiAgICAgIGlmIChhY3R1YWxJbmRleCA9PT0gbWVtb3MuZXhwZWN0ZWQuaW5kZXhPZihleHBlY3RlZCkpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgbWVtb3MuYWN0dWFsLnB1c2goYWN0dWFsKTtcbiAgICBtZW1vcy5leHBlY3RlZC5wdXNoKGV4cGVjdGVkKTtcblxuICAgIHJldHVybiBvYmpFcXVpdihhY3R1YWwsIGV4cGVjdGVkLCBzdHJpY3QsIG1lbW9zKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpc0FyZ3VtZW50cyhvYmplY3QpIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChvYmplY3QpID09ICdbb2JqZWN0IEFyZ3VtZW50c10nO1xufVxuXG5mdW5jdGlvbiBvYmpFcXVpdihhLCBiLCBzdHJpY3QsIGFjdHVhbFZpc2l0ZWRPYmplY3RzKSB7XG4gIGlmIChhID09PSBudWxsIHx8IGEgPT09IHVuZGVmaW5lZCB8fCBiID09PSBudWxsIHx8IGIgPT09IHVuZGVmaW5lZClcbiAgICByZXR1cm4gZmFsc2U7XG4gIC8vIGlmIG9uZSBpcyBhIHByaW1pdGl2ZSwgdGhlIG90aGVyIG11c3QgYmUgc2FtZVxuICBpZiAodXRpbC5pc1ByaW1pdGl2ZShhKSB8fCB1dGlsLmlzUHJpbWl0aXZlKGIpKVxuICAgIHJldHVybiBhID09PSBiO1xuICBpZiAoc3RyaWN0ICYmIE9iamVjdC5nZXRQcm90b3R5cGVPZihhKSAhPT0gT2JqZWN0LmdldFByb3RvdHlwZU9mKGIpKVxuICAgIHJldHVybiBmYWxzZTtcbiAgdmFyIGFJc0FyZ3MgPSBpc0FyZ3VtZW50cyhhKTtcbiAgdmFyIGJJc0FyZ3MgPSBpc0FyZ3VtZW50cyhiKTtcbiAgaWYgKChhSXNBcmdzICYmICFiSXNBcmdzKSB8fCAoIWFJc0FyZ3MgJiYgYklzQXJncykpXG4gICAgcmV0dXJuIGZhbHNlO1xuICBpZiAoYUlzQXJncykge1xuICAgIGEgPSBwU2xpY2UuY2FsbChhKTtcbiAgICBiID0gcFNsaWNlLmNhbGwoYik7XG4gICAgcmV0dXJuIF9kZWVwRXF1YWwoYSwgYiwgc3RyaWN0KTtcbiAgfVxuICB2YXIga2EgPSBvYmplY3RLZXlzKGEpO1xuICB2YXIga2IgPSBvYmplY3RLZXlzKGIpO1xuICB2YXIga2V5LCBpO1xuICAvLyBoYXZpbmcgdGhlIHNhbWUgbnVtYmVyIG9mIG93bmVkIHByb3BlcnRpZXMgKGtleXMgaW5jb3Jwb3JhdGVzXG4gIC8vIGhhc093blByb3BlcnR5KVxuICBpZiAoa2EubGVuZ3RoICE9PSBrYi5sZW5ndGgpXG4gICAgcmV0dXJuIGZhbHNlO1xuICAvL3RoZSBzYW1lIHNldCBvZiBrZXlzIChhbHRob3VnaCBub3QgbmVjZXNzYXJpbHkgdGhlIHNhbWUgb3JkZXIpLFxuICBrYS5zb3J0KCk7XG4gIGtiLnNvcnQoKTtcbiAgLy9+fn5jaGVhcCBrZXkgdGVzdFxuICBmb3IgKGkgPSBrYS5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGlmIChrYVtpXSAhPT0ga2JbaV0pXG4gICAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgLy9lcXVpdmFsZW50IHZhbHVlcyBmb3IgZXZlcnkgY29ycmVzcG9uZGluZyBrZXksIGFuZFxuICAvL35+fnBvc3NpYmx5IGV4cGVuc2l2ZSBkZWVwIHRlc3RcbiAgZm9yIChpID0ga2EubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICBrZXkgPSBrYVtpXTtcbiAgICBpZiAoIV9kZWVwRXF1YWwoYVtrZXldLCBiW2tleV0sIHN0cmljdCwgYWN0dWFsVmlzaXRlZE9iamVjdHMpKVxuICAgICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyA4LiBUaGUgbm9uLWVxdWl2YWxlbmNlIGFzc2VydGlvbiB0ZXN0cyBmb3IgYW55IGRlZXAgaW5lcXVhbGl0eS5cbi8vIGFzc2VydC5ub3REZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZV9vcHQpO1xuXG5hc3NlcnQubm90RGVlcEVxdWFsID0gZnVuY3Rpb24gbm90RGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgaWYgKF9kZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgZmFsc2UpKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnbm90RGVlcEVxdWFsJywgYXNzZXJ0Lm5vdERlZXBFcXVhbCk7XG4gIH1cbn07XG5cbmFzc2VydC5ub3REZWVwU3RyaWN0RXF1YWwgPSBub3REZWVwU3RyaWN0RXF1YWw7XG5mdW5jdGlvbiBub3REZWVwU3RyaWN0RXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICBpZiAoX2RlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCB0cnVlKSkge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJ25vdERlZXBTdHJpY3RFcXVhbCcsIG5vdERlZXBTdHJpY3RFcXVhbCk7XG4gIH1cbn1cblxuXG4vLyA5LiBUaGUgc3RyaWN0IGVxdWFsaXR5IGFzc2VydGlvbiB0ZXN0cyBzdHJpY3QgZXF1YWxpdHksIGFzIGRldGVybWluZWQgYnkgPT09LlxuLy8gYXNzZXJ0LnN0cmljdEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2Vfb3B0KTtcblxuYXNzZXJ0LnN0cmljdEVxdWFsID0gZnVuY3Rpb24gc3RyaWN0RXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICBpZiAoYWN0dWFsICE9PSBleHBlY3RlZCkge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJz09PScsIGFzc2VydC5zdHJpY3RFcXVhbCk7XG4gIH1cbn07XG5cbi8vIDEwLiBUaGUgc3RyaWN0IG5vbi1lcXVhbGl0eSBhc3NlcnRpb24gdGVzdHMgZm9yIHN0cmljdCBpbmVxdWFsaXR5LCBhc1xuLy8gZGV0ZXJtaW5lZCBieSAhPT0uICBhc3NlcnQubm90U3RyaWN0RXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZV9vcHQpO1xuXG5hc3NlcnQubm90U3RyaWN0RXF1YWwgPSBmdW5jdGlvbiBub3RTdHJpY3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmIChhY3R1YWwgPT09IGV4cGVjdGVkKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnIT09JywgYXNzZXJ0Lm5vdFN0cmljdEVxdWFsKTtcbiAgfVxufTtcblxuZnVuY3Rpb24gZXhwZWN0ZWRFeGNlcHRpb24oYWN0dWFsLCBleHBlY3RlZCkge1xuICBpZiAoIWFjdHVhbCB8fCAhZXhwZWN0ZWQpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBpZiAoT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKGV4cGVjdGVkKSA9PSAnW29iamVjdCBSZWdFeHBdJykge1xuICAgIHJldHVybiBleHBlY3RlZC50ZXN0KGFjdHVhbCk7XG4gIH1cblxuICB0cnkge1xuICAgIGlmIChhY3R1YWwgaW5zdGFuY2VvZiBleHBlY3RlZCkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgLy8gSWdub3JlLiAgVGhlIGluc3RhbmNlb2YgY2hlY2sgZG9lc24ndCB3b3JrIGZvciBhcnJvdyBmdW5jdGlvbnMuXG4gIH1cblxuICBpZiAoRXJyb3IuaXNQcm90b3R5cGVPZihleHBlY3RlZCkpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICByZXR1cm4gZXhwZWN0ZWQuY2FsbCh7fSwgYWN0dWFsKSA9PT0gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gX3RyeUJsb2NrKGJsb2NrKSB7XG4gIHZhciBlcnJvcjtcbiAgdHJ5IHtcbiAgICBibG9jaygpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgZXJyb3IgPSBlO1xuICB9XG4gIHJldHVybiBlcnJvcjtcbn1cblxuZnVuY3Rpb24gX3Rocm93cyhzaG91bGRUaHJvdywgYmxvY2ssIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIHZhciBhY3R1YWw7XG5cbiAgaWYgKHR5cGVvZiBibG9jayAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1wiYmxvY2tcIiBhcmd1bWVudCBtdXN0IGJlIGEgZnVuY3Rpb24nKTtcbiAgfVxuXG4gIGlmICh0eXBlb2YgZXhwZWN0ZWQgPT09ICdzdHJpbmcnKSB7XG4gICAgbWVzc2FnZSA9IGV4cGVjdGVkO1xuICAgIGV4cGVjdGVkID0gbnVsbDtcbiAgfVxuXG4gIGFjdHVhbCA9IF90cnlCbG9jayhibG9jayk7XG5cbiAgbWVzc2FnZSA9IChleHBlY3RlZCAmJiBleHBlY3RlZC5uYW1lID8gJyAoJyArIGV4cGVjdGVkLm5hbWUgKyAnKS4nIDogJy4nKSArXG4gICAgICAgICAgICAobWVzc2FnZSA/ICcgJyArIG1lc3NhZ2UgOiAnLicpO1xuXG4gIGlmIChzaG91bGRUaHJvdyAmJiAhYWN0dWFsKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCAnTWlzc2luZyBleHBlY3RlZCBleGNlcHRpb24nICsgbWVzc2FnZSk7XG4gIH1cblxuICB2YXIgdXNlclByb3ZpZGVkTWVzc2FnZSA9IHR5cGVvZiBtZXNzYWdlID09PSAnc3RyaW5nJztcbiAgdmFyIGlzVW53YW50ZWRFeGNlcHRpb24gPSAhc2hvdWxkVGhyb3cgJiYgdXRpbC5pc0Vycm9yKGFjdHVhbCk7XG4gIHZhciBpc1VuZXhwZWN0ZWRFeGNlcHRpb24gPSAhc2hvdWxkVGhyb3cgJiYgYWN0dWFsICYmICFleHBlY3RlZDtcblxuICBpZiAoKGlzVW53YW50ZWRFeGNlcHRpb24gJiZcbiAgICAgIHVzZXJQcm92aWRlZE1lc3NhZ2UgJiZcbiAgICAgIGV4cGVjdGVkRXhjZXB0aW9uKGFjdHVhbCwgZXhwZWN0ZWQpKSB8fFxuICAgICAgaXNVbmV4cGVjdGVkRXhjZXB0aW9uKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCAnR290IHVud2FudGVkIGV4Y2VwdGlvbicgKyBtZXNzYWdlKTtcbiAgfVxuXG4gIGlmICgoc2hvdWxkVGhyb3cgJiYgYWN0dWFsICYmIGV4cGVjdGVkICYmXG4gICAgICAhZXhwZWN0ZWRFeGNlcHRpb24oYWN0dWFsLCBleHBlY3RlZCkpIHx8ICghc2hvdWxkVGhyb3cgJiYgYWN0dWFsKSkge1xuICAgIHRocm93IGFjdHVhbDtcbiAgfVxufVxuXG4vLyAxMS4gRXhwZWN0ZWQgdG8gdGhyb3cgYW4gZXJyb3I6XG4vLyBhc3NlcnQudGhyb3dzKGJsb2NrLCBFcnJvcl9vcHQsIG1lc3NhZ2Vfb3B0KTtcblxuYXNzZXJ0LnRocm93cyA9IGZ1bmN0aW9uKGJsb2NrLCAvKm9wdGlvbmFsKi9lcnJvciwgLypvcHRpb25hbCovbWVzc2FnZSkge1xuICBfdGhyb3dzKHRydWUsIGJsb2NrLCBlcnJvciwgbWVzc2FnZSk7XG59O1xuXG4vLyBFWFRFTlNJT04hIFRoaXMgaXMgYW5ub3lpbmcgdG8gd3JpdGUgb3V0c2lkZSB0aGlzIG1vZHVsZS5cbmFzc2VydC5kb2VzTm90VGhyb3cgPSBmdW5jdGlvbihibG9jaywgLypvcHRpb25hbCovZXJyb3IsIC8qb3B0aW9uYWwqL21lc3NhZ2UpIHtcbiAgX3Rocm93cyhmYWxzZSwgYmxvY2ssIGVycm9yLCBtZXNzYWdlKTtcbn07XG5cbmFzc2VydC5pZkVycm9yID0gZnVuY3Rpb24oZXJyKSB7IGlmIChlcnIpIHRocm93IGVycjsgfTtcblxudmFyIG9iamVjdEtleXMgPSBPYmplY3Qua2V5cyB8fCBmdW5jdGlvbiAob2JqKSB7XG4gIHZhciBrZXlzID0gW107XG4gIGZvciAodmFyIGtleSBpbiBvYmopIHtcbiAgICBpZiAoaGFzT3duLmNhbGwob2JqLCBrZXkpKSBrZXlzLnB1c2goa2V5KTtcbiAgfVxuICByZXR1cm4ga2V5cztcbn07XG4iLCIiLCIvKlxyXG5cclxuVGhlIE1JVCBMaWNlbnNlIChNSVQpXHJcblxyXG5PcmlnaW5hbCBMaWJyYXJ5IFxyXG4gIC0gQ29weXJpZ2h0IChjKSBNYXJhayBTcXVpcmVzXHJcblxyXG5BZGRpdGlvbmFsIGZ1bmN0aW9uYWxpdHlcclxuIC0gQ29weXJpZ2h0IChjKSBTaW5kcmUgU29yaHVzIDxzaW5kcmVzb3JodXNAZ21haWwuY29tPiAoc2luZHJlc29yaHVzLmNvbSlcclxuXHJcblBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcclxub2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGUgXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbFxyXG5pbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzXHJcbnRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcclxuY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzXHJcbmZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6XHJcblxyXG5UaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpblxyXG5hbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cclxuXHJcblRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1JcclxuSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXHJcbkZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxyXG5BVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXHJcbkxJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sXHJcbk9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU5cclxuVEhFIFNPRlRXQVJFLlxyXG5cclxuKi9cclxuXHJcbnZhciBjb2xvcnMgPSB7fTtcclxubW9kdWxlWydleHBvcnRzJ10gPSBjb2xvcnM7XHJcblxyXG5jb2xvcnMudGhlbWVzID0ge307XHJcblxyXG52YXIgYW5zaVN0eWxlcyA9IGNvbG9ycy5zdHlsZXMgPSByZXF1aXJlKCcuL3N0eWxlcycpO1xyXG52YXIgZGVmaW5lUHJvcHMgPSBPYmplY3QuZGVmaW5lUHJvcGVydGllcztcclxuXHJcbmNvbG9ycy5zdXBwb3J0c0NvbG9yID0gcmVxdWlyZSgnLi9zeXN0ZW0vc3VwcG9ydHMtY29sb3JzJykuc3VwcG9ydHNDb2xvcjtcclxuXHJcbmlmICh0eXBlb2YgY29sb3JzLmVuYWJsZWQgPT09IFwidW5kZWZpbmVkXCIpIHtcclxuICBjb2xvcnMuZW5hYmxlZCA9IGNvbG9ycy5zdXBwb3J0c0NvbG9yKCkgIT09IGZhbHNlO1xyXG59XHJcblxyXG5jb2xvcnMuc3RyaXBDb2xvcnMgPSBjb2xvcnMuc3RyaXAgPSBmdW5jdGlvbihzdHIpe1xyXG4gIHJldHVybiAoXCJcIiArIHN0cikucmVwbGFjZSgvXFx4MUJcXFtcXGQrbS9nLCAnJyk7XHJcbn07XHJcblxyXG5cclxudmFyIHN0eWxpemUgPSBjb2xvcnMuc3R5bGl6ZSA9IGZ1bmN0aW9uIHN0eWxpemUgKHN0ciwgc3R5bGUpIHtcclxuICBpZiAoIWNvbG9ycy5lbmFibGVkKSB7XHJcbiAgICByZXR1cm4gc3RyKycnO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIGFuc2lTdHlsZXNbc3R5bGVdLm9wZW4gKyBzdHIgKyBhbnNpU3R5bGVzW3N0eWxlXS5jbG9zZTtcclxufVxyXG5cclxudmFyIG1hdGNoT3BlcmF0b3JzUmUgPSAvW3xcXFxce30oKVtcXF1eJCsqPy5dL2c7XHJcbnZhciBlc2NhcGVTdHJpbmdSZWdleHAgPSBmdW5jdGlvbiAoc3RyKSB7XHJcbiAgaWYgKHR5cGVvZiBzdHIgIT09ICdzdHJpbmcnKSB7XHJcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdFeHBlY3RlZCBhIHN0cmluZycpO1xyXG4gIH1cclxuICByZXR1cm4gc3RyLnJlcGxhY2UobWF0Y2hPcGVyYXRvcnNSZSwgICdcXFxcJCYnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gYnVpbGQoX3N0eWxlcykge1xyXG4gIHZhciBidWlsZGVyID0gZnVuY3Rpb24gYnVpbGRlcigpIHtcclxuICAgIHJldHVybiBhcHBseVN0eWxlLmFwcGx5KGJ1aWxkZXIsIGFyZ3VtZW50cyk7XHJcbiAgfTtcclxuICBidWlsZGVyLl9zdHlsZXMgPSBfc3R5bGVzO1xyXG4gIC8vIF9fcHJvdG9fXyBpcyB1c2VkIGJlY2F1c2Ugd2UgbXVzdCByZXR1cm4gYSBmdW5jdGlvbiwgYnV0IHRoZXJlIGlzXHJcbiAgLy8gbm8gd2F5IHRvIGNyZWF0ZSBhIGZ1bmN0aW9uIHdpdGggYSBkaWZmZXJlbnQgcHJvdG90eXBlLlxyXG4gIGJ1aWxkZXIuX19wcm90b19fID0gcHJvdG87XHJcbiAgcmV0dXJuIGJ1aWxkZXI7XHJcbn1cclxuXHJcbnZhciBzdHlsZXMgPSAoZnVuY3Rpb24gKCkge1xyXG4gIHZhciByZXQgPSB7fTtcclxuICBhbnNpU3R5bGVzLmdyZXkgPSBhbnNpU3R5bGVzLmdyYXk7XHJcbiAgT2JqZWN0LmtleXMoYW5zaVN0eWxlcykuZm9yRWFjaChmdW5jdGlvbiAoa2V5KSB7XHJcbiAgICBhbnNpU3R5bGVzW2tleV0uY2xvc2VSZSA9IG5ldyBSZWdFeHAoZXNjYXBlU3RyaW5nUmVnZXhwKGFuc2lTdHlsZXNba2V5XS5jbG9zZSksICdnJyk7XHJcbiAgICByZXRba2V5XSA9IHtcclxuICAgICAgZ2V0OiBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgcmV0dXJuIGJ1aWxkKHRoaXMuX3N0eWxlcy5jb25jYXQoa2V5KSk7XHJcbiAgICAgIH1cclxuICAgIH07XHJcbiAgfSk7XHJcbiAgcmV0dXJuIHJldDtcclxufSkoKTtcclxuXHJcbnZhciBwcm90byA9IGRlZmluZVByb3BzKGZ1bmN0aW9uIGNvbG9ycygpIHt9LCBzdHlsZXMpO1xyXG5cclxuZnVuY3Rpb24gYXBwbHlTdHlsZSgpIHtcclxuICB2YXIgYXJncyA9IGFyZ3VtZW50cztcclxuICB2YXIgYXJnc0xlbiA9IGFyZ3MubGVuZ3RoO1xyXG4gIHZhciBzdHIgPSBhcmdzTGVuICE9PSAwICYmIFN0cmluZyhhcmd1bWVudHNbMF0pO1xyXG4gIGlmIChhcmdzTGVuID4gMSkge1xyXG4gICAgZm9yICh2YXIgYSA9IDE7IGEgPCBhcmdzTGVuOyBhKyspIHtcclxuICAgICAgc3RyICs9ICcgJyArIGFyZ3NbYV07XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBpZiAoIWNvbG9ycy5lbmFibGVkIHx8ICFzdHIpIHtcclxuICAgIHJldHVybiBzdHI7XHJcbiAgfVxyXG5cclxuICB2YXIgbmVzdGVkU3R5bGVzID0gdGhpcy5fc3R5bGVzO1xyXG5cclxuICB2YXIgaSA9IG5lc3RlZFN0eWxlcy5sZW5ndGg7XHJcbiAgd2hpbGUgKGktLSkge1xyXG4gICAgdmFyIGNvZGUgPSBhbnNpU3R5bGVzW25lc3RlZFN0eWxlc1tpXV07XHJcbiAgICBzdHIgPSBjb2RlLm9wZW4gKyBzdHIucmVwbGFjZShjb2RlLmNsb3NlUmUsIGNvZGUub3BlbikgKyBjb2RlLmNsb3NlO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIHN0cjtcclxufVxyXG5cclxuY29sb3JzLnNldFRoZW1lID0gZnVuY3Rpb24gKHRoZW1lKSB7XHJcbiAgaWYgKHR5cGVvZiB0aGVtZSA9PT0gJ3N0cmluZycpIHtcclxuICAgIGNvbnNvbGUubG9nKCdjb2xvcnMuc2V0VGhlbWUgbm93IG9ubHkgYWNjZXB0cyBhbiBvYmplY3QsIG5vdCBhIHN0cmluZy4gICcgK1xyXG4gICAgICAnSWYgeW91IGFyZSB0cnlpbmcgdG8gc2V0IGEgdGhlbWUgZnJvbSBhIGZpbGUsIGl0IGlzIG5vdyB5b3VyICh0aGUgY2FsbGVyXFwncykgcmVzcG9uc2liaWxpdHkgdG8gcmVxdWlyZSB0aGUgZmlsZS4gICcgK1xyXG4gICAgICAnVGhlIG9sZCBzeW50YXggbG9va2VkIGxpa2UgY29sb3JzLnNldFRoZW1lKF9fZGlybmFtZSArIFxcJy8uLi90aGVtZXMvZ2VuZXJpYy1sb2dnaW5nLmpzXFwnKTsgJyArXHJcbiAgICAgICdUaGUgbmV3IHN5bnRheCBsb29rcyBsaWtlIGNvbG9ycy5zZXRUaGVtZShyZXF1aXJlKF9fZGlybmFtZSArIFxcJy8uLi90aGVtZXMvZ2VuZXJpYy1sb2dnaW5nLmpzXFwnKSk7Jyk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIGZvciAodmFyIHN0eWxlIGluIHRoZW1lKSB7XHJcbiAgICAoZnVuY3Rpb24oc3R5bGUpe1xyXG4gICAgICBjb2xvcnNbc3R5bGVdID0gZnVuY3Rpb24oc3RyKXtcclxuICAgICAgICBpZiAodHlwZW9mIHRoZW1lW3N0eWxlXSA9PT0gJ29iamVjdCcpe1xyXG4gICAgICAgICAgdmFyIG91dCA9IHN0cjtcclxuICAgICAgICAgIGZvciAodmFyIGkgaW4gdGhlbWVbc3R5bGVdKXtcclxuICAgICAgICAgICAgb3V0ID0gY29sb3JzW3RoZW1lW3N0eWxlXVtpXV0ob3V0KTtcclxuICAgICAgICAgIH1cclxuICAgICAgICAgIHJldHVybiBvdXQ7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBjb2xvcnNbdGhlbWVbc3R5bGVdXShzdHIpO1xyXG4gICAgICB9O1xyXG4gICAgfSkoc3R5bGUpXHJcbiAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBpbml0KCkge1xyXG4gIHZhciByZXQgPSB7fTtcclxuICBPYmplY3Qua2V5cyhzdHlsZXMpLmZvckVhY2goZnVuY3Rpb24gKG5hbWUpIHtcclxuICAgIHJldFtuYW1lXSA9IHtcclxuICAgICAgZ2V0OiBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgcmV0dXJuIGJ1aWxkKFtuYW1lXSk7XHJcbiAgICAgIH1cclxuICAgIH07XHJcbiAgfSk7XHJcbiAgcmV0dXJuIHJldDtcclxufVxyXG5cclxudmFyIHNlcXVlbmNlciA9IGZ1bmN0aW9uIHNlcXVlbmNlciAobWFwLCBzdHIpIHtcclxuICB2YXIgZXhwbG9kZWQgPSBzdHIuc3BsaXQoXCJcIiksIGkgPSAwO1xyXG4gIGV4cGxvZGVkID0gZXhwbG9kZWQubWFwKG1hcCk7XHJcbiAgcmV0dXJuIGV4cGxvZGVkLmpvaW4oXCJcIik7XHJcbn07XHJcblxyXG4vLyBjdXN0b20gZm9ybWF0dGVyIG1ldGhvZHNcclxuY29sb3JzLnRyYXAgPSByZXF1aXJlKCcuL2N1c3RvbS90cmFwJyk7XHJcbmNvbG9ycy56YWxnbyA9IHJlcXVpcmUoJy4vY3VzdG9tL3phbGdvJyk7XHJcblxyXG4vLyBtYXBzXHJcbmNvbG9ycy5tYXBzID0ge307XHJcbmNvbG9ycy5tYXBzLmFtZXJpY2EgPSByZXF1aXJlKCcuL21hcHMvYW1lcmljYScpO1xyXG5jb2xvcnMubWFwcy56ZWJyYSA9IHJlcXVpcmUoJy4vbWFwcy96ZWJyYScpO1xyXG5jb2xvcnMubWFwcy5yYWluYm93ID0gcmVxdWlyZSgnLi9tYXBzL3JhaW5ib3cnKTtcclxuY29sb3JzLm1hcHMucmFuZG9tID0gcmVxdWlyZSgnLi9tYXBzL3JhbmRvbScpXHJcblxyXG5mb3IgKHZhciBtYXAgaW4gY29sb3JzLm1hcHMpIHtcclxuICAoZnVuY3Rpb24obWFwKXtcclxuICAgIGNvbG9yc1ttYXBdID0gZnVuY3Rpb24gKHN0cikge1xyXG4gICAgICByZXR1cm4gc2VxdWVuY2VyKGNvbG9ycy5tYXBzW21hcF0sIHN0cik7XHJcbiAgICB9XHJcbiAgfSkobWFwKVxyXG59XHJcblxyXG5kZWZpbmVQcm9wcyhjb2xvcnMsIGluaXQoKSk7XHJcbiIsIm1vZHVsZVsnZXhwb3J0cyddID0gZnVuY3Rpb24gcnVuVGhlVHJhcCAodGV4dCwgb3B0aW9ucykge1xyXG4gIHZhciByZXN1bHQgPSBcIlwiO1xyXG4gIHRleHQgPSB0ZXh0IHx8IFwiUnVuIHRoZSB0cmFwLCBkcm9wIHRoZSBiYXNzXCI7XHJcbiAgdGV4dCA9IHRleHQuc3BsaXQoJycpO1xyXG4gIHZhciB0cmFwID0ge1xyXG4gICAgYTogW1wiXFx1MDA0MFwiLCBcIlxcdTAxMDRcIiwgXCJcXHUwMjNhXCIsIFwiXFx1MDI0NVwiLCBcIlxcdTAzOTRcIiwgXCJcXHUwMzliXCIsIFwiXFx1MDQxNFwiXSxcclxuICAgIGI6IFtcIlxcdTAwZGZcIiwgXCJcXHUwMTgxXCIsIFwiXFx1MDI0M1wiLCBcIlxcdTAyNmVcIiwgXCJcXHUwM2IyXCIsIFwiXFx1MGUzZlwiXSxcclxuICAgIGM6IFtcIlxcdTAwYTlcIiwgXCJcXHUwMjNiXCIsIFwiXFx1MDNmZVwiXSxcclxuICAgIGQ6IFtcIlxcdTAwZDBcIiwgXCJcXHUwMThhXCIsIFwiXFx1MDUwMFwiICwgXCJcXHUwNTAxXCIgLFwiXFx1MDUwMlwiLCBcIlxcdTA1MDNcIl0sXHJcbiAgICBlOiBbXCJcXHUwMGNiXCIsIFwiXFx1MDExNVwiLCBcIlxcdTAxOGVcIiwgXCJcXHUwMjU4XCIsIFwiXFx1MDNhM1wiLCBcIlxcdTAzYmVcIiwgXCJcXHUwNGJjXCIsIFwiXFx1MGE2Y1wiXSxcclxuICAgIGY6IFtcIlxcdTA0ZmFcIl0sXHJcbiAgICBnOiBbXCJcXHUwMjYyXCJdLFxyXG4gICAgaDogW1wiXFx1MDEyNlwiLCBcIlxcdTAxOTVcIiwgXCJcXHUwNGEyXCIsIFwiXFx1MDRiYVwiLCBcIlxcdTA0YzdcIiwgXCJcXHUwNTBhXCJdLFxyXG4gICAgaTogW1wiXFx1MGYwZlwiXSxcclxuICAgIGo6IFtcIlxcdTAxMzRcIl0sXHJcbiAgICBrOiBbXCJcXHUwMTM4XCIsIFwiXFx1MDRhMFwiLCBcIlxcdTA0YzNcIiwgXCJcXHUwNTFlXCJdLFxyXG4gICAgbDogW1wiXFx1MDEzOVwiXSxcclxuICAgIG06IFtcIlxcdTAyOGRcIiwgXCJcXHUwNGNkXCIsIFwiXFx1MDRjZVwiLCBcIlxcdTA1MjBcIiwgXCJcXHUwNTIxXCIsIFwiXFx1MGQ2OVwiXSxcclxuICAgIG46IFtcIlxcdTAwZDFcIiwgXCJcXHUwMTRiXCIsIFwiXFx1MDE5ZFwiLCBcIlxcdTAzNzZcIiwgXCJcXHUwM2EwXCIsIFwiXFx1MDQ4YVwiXSxcclxuICAgIG86IFtcIlxcdTAwZDhcIiwgXCJcXHUwMGY1XCIsIFwiXFx1MDBmOFwiLCBcIlxcdTAxZmVcIiwgXCJcXHUwMjk4XCIsIFwiXFx1MDQ3YVwiLCBcIlxcdTA1ZGRcIiwgXCJcXHUwNmRkXCIsIFwiXFx1MGU0ZlwiXSxcclxuICAgIHA6IFtcIlxcdTAxZjdcIiwgXCJcXHUwNDhlXCJdLFxyXG4gICAgcTogW1wiXFx1MDljZFwiXSxcclxuICAgIHI6IFtcIlxcdTAwYWVcIiwgXCJcXHUwMWE2XCIsIFwiXFx1MDIxMFwiLCBcIlxcdTAyNGNcIiwgXCJcXHUwMjgwXCIsIFwiXFx1MDQyZlwiXSxcclxuICAgIHM6IFtcIlxcdTAwYTdcIiwgXCJcXHUwM2RlXCIsIFwiXFx1MDNkZlwiLCBcIlxcdTAzZThcIl0sXHJcbiAgICB0OiBbXCJcXHUwMTQxXCIsIFwiXFx1MDE2NlwiLCBcIlxcdTAzNzNcIl0sXHJcbiAgICB1OiBbXCJcXHUwMWIxXCIsIFwiXFx1MDU0ZFwiXSxcclxuICAgIHY6IFtcIlxcdTA1ZDhcIl0sXHJcbiAgICB3OiBbXCJcXHUwNDI4XCIsIFwiXFx1MDQ2MFwiLCBcIlxcdTA0N2NcIiwgXCJcXHUwZDcwXCJdLFxyXG4gICAgeDogW1wiXFx1MDRiMlwiLCBcIlxcdTA0ZmVcIiwgXCJcXHUwNGZjXCIsIFwiXFx1MDRmZFwiXSxcclxuICAgIHk6IFtcIlxcdTAwYTVcIiwgXCJcXHUwNGIwXCIsIFwiXFx1MDRjYlwiXSxcclxuICAgIHo6IFtcIlxcdTAxYjVcIiwgXCJcXHUwMjQwXCJdXHJcbiAgfVxyXG4gIHRleHQuZm9yRWFjaChmdW5jdGlvbihjKXtcclxuICAgIGMgPSBjLnRvTG93ZXJDYXNlKCk7XHJcbiAgICB2YXIgY2hhcnMgPSB0cmFwW2NdIHx8IFtcIiBcIl07XHJcbiAgICB2YXIgcmFuZCA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGNoYXJzLmxlbmd0aCk7XHJcbiAgICBpZiAodHlwZW9mIHRyYXBbY10gIT09IFwidW5kZWZpbmVkXCIpIHtcclxuICAgICAgcmVzdWx0ICs9IHRyYXBbY11bcmFuZF07XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICByZXN1bHQgKz0gYztcclxuICAgIH1cclxuICB9KTtcclxuICByZXR1cm4gcmVzdWx0O1xyXG5cclxufVxyXG4iLCIvLyBwbGVhc2Ugbm9cclxubW9kdWxlWydleHBvcnRzJ10gPSBmdW5jdGlvbiB6YWxnbyh0ZXh0LCBvcHRpb25zKSB7XHJcbiAgdGV4dCA9IHRleHQgfHwgXCIgICBoZSBpcyBoZXJlICAgXCI7XHJcbiAgdmFyIHNvdWwgPSB7XHJcbiAgICBcInVwXCIgOiBbXHJcbiAgICAgICfMjScsICfMjicsICfMhCcsICfMhScsXHJcbiAgICAgICfMvycsICfMkScsICfMhicsICfMkCcsXHJcbiAgICAgICfNkicsICfNlycsICfNkScsICfMhycsXHJcbiAgICAgICfMiCcsICfMiicsICfNgicsICfMkycsXHJcbiAgICAgICfMiCcsICfNiicsICfNiycsICfNjCcsXHJcbiAgICAgICfMgycsICfMgicsICfMjCcsICfNkCcsXHJcbiAgICAgICfMgCcsICfMgScsICfMiycsICfMjycsXHJcbiAgICAgICfMkicsICfMkycsICfMlCcsICfMvScsXHJcbiAgICAgICfMiScsICfNoycsICfNpCcsICfNpScsXHJcbiAgICAgICfNpicsICfNpycsICfNqCcsICfNqScsXHJcbiAgICAgICfNqicsICfNqycsICfNrCcsICfNrScsXHJcbiAgICAgICfNricsICfNrycsICfMvicsICfNmycsXHJcbiAgICAgICfNhicsICfMmidcclxuICAgIF0sXHJcbiAgICBcImRvd25cIiA6IFtcclxuICAgICAgJ8yWJywgJ8yXJywgJ8yYJywgJ8yZJyxcclxuICAgICAgJ8ycJywgJ8ydJywgJ8yeJywgJ8yfJyxcclxuICAgICAgJ8ygJywgJ8ykJywgJ8ylJywgJ8ymJyxcclxuICAgICAgJ8ypJywgJ8yqJywgJ8yrJywgJ8ysJyxcclxuICAgICAgJ8ytJywgJ8yuJywgJ8yvJywgJ8ywJyxcclxuICAgICAgJ8yxJywgJ8yyJywgJ8yzJywgJ8y5JyxcclxuICAgICAgJ8y6JywgJ8y7JywgJ8y8JywgJ82FJyxcclxuICAgICAgJ82HJywgJ82IJywgJ82JJywgJ82NJyxcclxuICAgICAgJ82OJywgJ82TJywgJ82UJywgJ82VJyxcclxuICAgICAgJ82WJywgJ82ZJywgJ82aJywgJ8yjJ1xyXG4gICAgXSxcclxuICAgIFwibWlkXCIgOiBbXHJcbiAgICAgICfMlScsICfMmycsICfMgCcsICfMgScsXHJcbiAgICAgICfNmCcsICfMoScsICfMoicsICfMpycsXHJcbiAgICAgICfMqCcsICfMtCcsICfMtScsICfMticsXHJcbiAgICAgICfNnCcsICfNnScsICfNnicsXHJcbiAgICAgICfNnycsICfNoCcsICfNoicsICfMuCcsXHJcbiAgICAgICfMtycsICfNoScsICcg0oknXHJcbiAgICBdXHJcbiAgfSxcclxuICBhbGwgPSBbXS5jb25jYXQoc291bC51cCwgc291bC5kb3duLCBzb3VsLm1pZCksXHJcbiAgemFsZ28gPSB7fTtcclxuXHJcbiAgZnVuY3Rpb24gcmFuZG9tTnVtYmVyKHJhbmdlKSB7XHJcbiAgICB2YXIgciA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIHJhbmdlKTtcclxuICAgIHJldHVybiByO1xyXG4gIH1cclxuXHJcbiAgZnVuY3Rpb24gaXNfY2hhcihjaGFyYWN0ZXIpIHtcclxuICAgIHZhciBib29sID0gZmFsc2U7XHJcbiAgICBhbGwuZmlsdGVyKGZ1bmN0aW9uIChpKSB7XHJcbiAgICAgIGJvb2wgPSAoaSA9PT0gY2hhcmFjdGVyKTtcclxuICAgIH0pO1xyXG4gICAgcmV0dXJuIGJvb2w7XHJcbiAgfVxyXG4gIFxyXG5cclxuICBmdW5jdGlvbiBoZUNvbWVzKHRleHQsIG9wdGlvbnMpIHtcclxuICAgIHZhciByZXN1bHQgPSAnJywgY291bnRzLCBsO1xyXG4gICAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XHJcbiAgICBvcHRpb25zW1widXBcIl0gPSAgIHR5cGVvZiBvcHRpb25zW1widXBcIl0gICAhPT0gJ3VuZGVmaW5lZCcgPyBvcHRpb25zW1widXBcIl0gICA6IHRydWU7XHJcbiAgICBvcHRpb25zW1wibWlkXCJdID0gIHR5cGVvZiBvcHRpb25zW1wibWlkXCJdICAhPT0gJ3VuZGVmaW5lZCcgPyBvcHRpb25zW1wibWlkXCJdICA6IHRydWU7XHJcbiAgICBvcHRpb25zW1wiZG93blwiXSA9IHR5cGVvZiBvcHRpb25zW1wiZG93blwiXSAhPT0gJ3VuZGVmaW5lZCcgPyBvcHRpb25zW1wiZG93blwiXSA6IHRydWU7XHJcbiAgICBvcHRpb25zW1wic2l6ZVwiXSA9IHR5cGVvZiBvcHRpb25zW1wic2l6ZVwiXSAhPT0gJ3VuZGVmaW5lZCcgPyBvcHRpb25zW1wic2l6ZVwiXSA6IFwibWF4aVwiO1xyXG4gICAgdGV4dCA9IHRleHQuc3BsaXQoJycpO1xyXG4gICAgZm9yIChsIGluIHRleHQpIHtcclxuICAgICAgaWYgKGlzX2NoYXIobCkpIHtcclxuICAgICAgICBjb250aW51ZTtcclxuICAgICAgfVxyXG4gICAgICByZXN1bHQgPSByZXN1bHQgKyB0ZXh0W2xdO1xyXG4gICAgICBjb3VudHMgPSB7XCJ1cFwiIDogMCwgXCJkb3duXCIgOiAwLCBcIm1pZFwiIDogMH07XHJcbiAgICAgIHN3aXRjaCAob3B0aW9ucy5zaXplKSB7XHJcbiAgICAgIGNhc2UgJ21pbmknOlxyXG4gICAgICAgIGNvdW50cy51cCA9IHJhbmRvbU51bWJlcig4KTtcclxuICAgICAgICBjb3VudHMubWlkID0gcmFuZG9tTnVtYmVyKDIpO1xyXG4gICAgICAgIGNvdW50cy5kb3duID0gcmFuZG9tTnVtYmVyKDgpO1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgICBjYXNlICdtYXhpJzpcclxuICAgICAgICBjb3VudHMudXAgPSByYW5kb21OdW1iZXIoMTYpICsgMztcclxuICAgICAgICBjb3VudHMubWlkID0gcmFuZG9tTnVtYmVyKDQpICsgMTtcclxuICAgICAgICBjb3VudHMuZG93biA9IHJhbmRvbU51bWJlcig2NCkgKyAzO1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgICBkZWZhdWx0OlxyXG4gICAgICAgIGNvdW50cy51cCA9IHJhbmRvbU51bWJlcig4KSArIDE7XHJcbiAgICAgICAgY291bnRzLm1pZCA9IHJhbmRvbU51bWJlcig2KSAvIDI7XHJcbiAgICAgICAgY291bnRzLmRvd24gPSByYW5kb21OdW1iZXIoOCkgKyAxO1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgICB9XHJcblxyXG4gICAgICB2YXIgYXJyID0gW1widXBcIiwgXCJtaWRcIiwgXCJkb3duXCJdO1xyXG4gICAgICBmb3IgKHZhciBkIGluIGFycikge1xyXG4gICAgICAgIHZhciBpbmRleCA9IGFycltkXTtcclxuICAgICAgICBmb3IgKHZhciBpID0gMCA7IGkgPD0gY291bnRzW2luZGV4XTsgaSsrKSB7XHJcbiAgICAgICAgICBpZiAob3B0aW9uc1tpbmRleF0pIHtcclxuICAgICAgICAgICAgcmVzdWx0ID0gcmVzdWx0ICsgc291bFtpbmRleF1bcmFuZG9tTnVtYmVyKHNvdWxbaW5kZXhdLmxlbmd0aCldO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxuICB9XHJcbiAgLy8gZG9uJ3Qgc3VtbW9uIGhpbVxyXG4gIHJldHVybiBoZUNvbWVzKHRleHQsIG9wdGlvbnMpO1xyXG59XHJcbiIsInZhciBjb2xvcnMgPSByZXF1aXJlKCcuL2NvbG9ycycpO1xyXG5cclxubW9kdWxlWydleHBvcnRzJ10gPSBmdW5jdGlvbiAoKSB7XHJcblxyXG4gIC8vXHJcbiAgLy8gRXh0ZW5kcyBwcm90b3R5cGUgb2YgbmF0aXZlIHN0cmluZyBvYmplY3QgdG8gYWxsb3cgZm9yIFwiZm9vXCIucmVkIHN5bnRheFxyXG4gIC8vXHJcbiAgdmFyIGFkZFByb3BlcnR5ID0gZnVuY3Rpb24gKGNvbG9yLCBmdW5jKSB7XHJcbiAgICBTdHJpbmcucHJvdG90eXBlLl9fZGVmaW5lR2V0dGVyX18oY29sb3IsIGZ1bmMpO1xyXG4gIH07XHJcblxyXG4gIHZhciBzZXF1ZW5jZXIgPSBmdW5jdGlvbiBzZXF1ZW5jZXIgKG1hcCwgc3RyKSB7XHJcbiAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgdmFyIGV4cGxvZGVkID0gdGhpcy5zcGxpdChcIlwiKSwgaSA9IDA7XHJcbiAgICAgICAgZXhwbG9kZWQgPSBleHBsb2RlZC5tYXAobWFwKTtcclxuICAgICAgICByZXR1cm4gZXhwbG9kZWQuam9pbihcIlwiKTtcclxuICAgICAgfVxyXG4gIH07XHJcblxyXG4gIGFkZFByb3BlcnR5KCdzdHJpcCcsIGZ1bmN0aW9uICgpIHtcclxuICAgIHJldHVybiBjb2xvcnMuc3RyaXAodGhpcyk7XHJcbiAgfSk7XHJcblxyXG4gIGFkZFByb3BlcnR5KCdzdHJpcENvbG9ycycsIGZ1bmN0aW9uICgpIHtcclxuICAgIHJldHVybiBjb2xvcnMuc3RyaXAodGhpcyk7XHJcbiAgfSk7XHJcblxyXG4gIGFkZFByb3BlcnR5KFwidHJhcFwiLCBmdW5jdGlvbigpe1xyXG4gICAgcmV0dXJuIGNvbG9ycy50cmFwKHRoaXMpO1xyXG4gIH0pO1xyXG5cclxuICBhZGRQcm9wZXJ0eShcInphbGdvXCIsIGZ1bmN0aW9uKCl7XHJcbiAgICByZXR1cm4gY29sb3JzLnphbGdvKHRoaXMpO1xyXG4gIH0pO1xyXG5cclxuICBhZGRQcm9wZXJ0eShcInplYnJhXCIsIGZ1bmN0aW9uKCl7XHJcbiAgICByZXR1cm4gY29sb3JzLnplYnJhKHRoaXMpO1xyXG4gIH0pO1xyXG5cclxuICBhZGRQcm9wZXJ0eShcInJhaW5ib3dcIiwgZnVuY3Rpb24oKXtcclxuICAgIHJldHVybiBjb2xvcnMucmFpbmJvdyh0aGlzKTtcclxuICB9KTtcclxuXHJcbiAgYWRkUHJvcGVydHkoXCJyYW5kb21cIiwgZnVuY3Rpb24oKXtcclxuICAgIHJldHVybiBjb2xvcnMucmFuZG9tKHRoaXMpO1xyXG4gIH0pO1xyXG5cclxuICBhZGRQcm9wZXJ0eShcImFtZXJpY2FcIiwgZnVuY3Rpb24oKXtcclxuICAgIHJldHVybiBjb2xvcnMuYW1lcmljYSh0aGlzKTtcclxuICB9KTtcclxuXHJcbiAgLy9cclxuICAvLyBJdGVyYXRlIHRocm91Z2ggYWxsIGRlZmF1bHQgc3R5bGVzIGFuZCBjb2xvcnNcclxuICAvL1xyXG4gIHZhciB4ID0gT2JqZWN0LmtleXMoY29sb3JzLnN0eWxlcyk7XHJcbiAgeC5mb3JFYWNoKGZ1bmN0aW9uIChzdHlsZSkge1xyXG4gICAgYWRkUHJvcGVydHkoc3R5bGUsIGZ1bmN0aW9uICgpIHtcclxuICAgICAgcmV0dXJuIGNvbG9ycy5zdHlsaXplKHRoaXMsIHN0eWxlKTtcclxuICAgIH0pO1xyXG4gIH0pO1xyXG5cclxuICBmdW5jdGlvbiBhcHBseVRoZW1lKHRoZW1lKSB7XHJcbiAgICAvL1xyXG4gICAgLy8gUmVtYXJrOiBUaGlzIGlzIGEgbGlzdCBvZiBtZXRob2RzIHRoYXQgZXhpc3RcclxuICAgIC8vIG9uIFN0cmluZyB0aGF0IHlvdSBzaG91bGQgbm90IG92ZXJ3cml0ZS5cclxuICAgIC8vXHJcbiAgICB2YXIgc3RyaW5nUHJvdG90eXBlQmxhY2tsaXN0ID0gW1xyXG4gICAgICAnX19kZWZpbmVHZXR0ZXJfXycsICdfX2RlZmluZVNldHRlcl9fJywgJ19fbG9va3VwR2V0dGVyX18nLCAnX19sb29rdXBTZXR0ZXJfXycsICdjaGFyQXQnLCAnY29uc3RydWN0b3InLFxyXG4gICAgICAnaGFzT3duUHJvcGVydHknLCAnaXNQcm90b3R5cGVPZicsICdwcm9wZXJ0eUlzRW51bWVyYWJsZScsICd0b0xvY2FsZVN0cmluZycsICd0b1N0cmluZycsICd2YWx1ZU9mJywgJ2NoYXJDb2RlQXQnLFxyXG4gICAgICAnaW5kZXhPZicsICdsYXN0SW5kZXhvZicsICdsZW5ndGgnLCAnbG9jYWxlQ29tcGFyZScsICdtYXRjaCcsICdyZXBlYXQnLCAncmVwbGFjZScsICdzZWFyY2gnLCAnc2xpY2UnLCAnc3BsaXQnLCAnc3Vic3RyaW5nJyxcclxuICAgICAgJ3RvTG9jYWxlTG93ZXJDYXNlJywgJ3RvTG9jYWxlVXBwZXJDYXNlJywgJ3RvTG93ZXJDYXNlJywgJ3RvVXBwZXJDYXNlJywgJ3RyaW0nLCAndHJpbUxlZnQnLCAndHJpbVJpZ2h0J1xyXG4gICAgXTtcclxuXHJcbiAgICBPYmplY3Qua2V5cyh0aGVtZSkuZm9yRWFjaChmdW5jdGlvbiAocHJvcCkge1xyXG4gICAgICBpZiAoc3RyaW5nUHJvdG90eXBlQmxhY2tsaXN0LmluZGV4T2YocHJvcCkgIT09IC0xKSB7XHJcbiAgICAgICAgY29uc29sZS5sb2coJ3dhcm46ICcucmVkICsgKCdTdHJpbmcucHJvdG90eXBlJyArIHByb3ApLm1hZ2VudGEgKyAnIGlzIHByb2JhYmx5IHNvbWV0aGluZyB5b3UgZG9uXFwndCB3YW50IHRvIG92ZXJyaWRlLiBJZ25vcmluZyBzdHlsZSBuYW1lJyk7XHJcbiAgICAgIH1cclxuICAgICAgZWxzZSB7XHJcbiAgICAgICAgaWYgKHR5cGVvZih0aGVtZVtwcm9wXSkgPT09ICdzdHJpbmcnKSB7XHJcbiAgICAgICAgICBjb2xvcnNbcHJvcF0gPSBjb2xvcnNbdGhlbWVbcHJvcF1dO1xyXG4gICAgICAgICAgYWRkUHJvcGVydHkocHJvcCwgZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICByZXR1cm4gY29sb3JzW3RoZW1lW3Byb3BdXSh0aGlzKTtcclxuICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBlbHNlIHtcclxuICAgICAgICAgIGFkZFByb3BlcnR5KHByb3AsIGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgdmFyIHJldCA9IHRoaXM7XHJcbiAgICAgICAgICAgIGZvciAodmFyIHQgPSAwOyB0IDwgdGhlbWVbcHJvcF0ubGVuZ3RoOyB0KyspIHtcclxuICAgICAgICAgICAgICByZXQgPSBjb2xvcnNbdGhlbWVbcHJvcF1bdF1dKHJldCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIHJldDtcclxuICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICBjb2xvcnMuc2V0VGhlbWUgPSBmdW5jdGlvbiAodGhlbWUpIHtcclxuICAgIGlmICh0eXBlb2YgdGhlbWUgPT09ICdzdHJpbmcnKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29sb3JzLnRoZW1lc1t0aGVtZV0gPSByZXF1aXJlKHRoZW1lKTtcclxuICAgICAgICBhcHBseVRoZW1lKGNvbG9ycy50aGVtZXNbdGhlbWVdKTtcclxuICAgICAgICByZXR1cm4gY29sb3JzLnRoZW1lc1t0aGVtZV07XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGNvbnNvbGUubG9nKGVycik7XHJcbiAgICAgICAgcmV0dXJuIGVycjtcclxuICAgICAgfVxyXG4gICAgfSBlbHNlIHtcclxuICAgICAgYXBwbHlUaGVtZSh0aGVtZSk7XHJcbiAgICB9XHJcbiAgfTtcclxuXHJcbn07XHJcbiIsInZhciBjb2xvcnMgPSByZXF1aXJlKCcuL2NvbG9ycycpO1xyXG5tb2R1bGVbJ2V4cG9ydHMnXSA9IGNvbG9ycztcclxuXHJcbi8vIFJlbWFyazogQnkgZGVmYXVsdCwgY29sb3JzIHdpbGwgYWRkIHN0eWxlIHByb3BlcnRpZXMgdG8gU3RyaW5nLnByb3RvdHlwZVxyXG4vL1xyXG4vLyBJZiB5b3UgZG9uJ3Qgd2lzaCB0byBleHRlbmQgU3RyaW5nLnByb3RvdHlwZSB5b3UgY2FuIGRvIHRoaXMgaW5zdGVhZCBhbmQgbmF0aXZlIFN0cmluZyB3aWxsIG5vdCBiZSB0b3VjaGVkXHJcbi8vXHJcbi8vICAgdmFyIGNvbG9ycyA9IHJlcXVpcmUoJ2NvbG9ycy9zYWZlKTtcclxuLy8gICBjb2xvcnMucmVkKFwiZm9vXCIpXHJcbi8vXHJcbi8vXHJcbnJlcXVpcmUoJy4vZXh0ZW5kU3RyaW5nUHJvdG90eXBlJykoKTsiLCJ2YXIgY29sb3JzID0gcmVxdWlyZSgnLi4vY29sb3JzJyk7XHJcblxyXG5tb2R1bGVbJ2V4cG9ydHMnXSA9IChmdW5jdGlvbigpIHtcclxuICByZXR1cm4gZnVuY3Rpb24gKGxldHRlciwgaSwgZXhwbG9kZWQpIHtcclxuICAgIGlmKGxldHRlciA9PT0gXCIgXCIpIHJldHVybiBsZXR0ZXI7XHJcbiAgICBzd2l0Y2goaSUzKSB7XHJcbiAgICAgIGNhc2UgMDogcmV0dXJuIGNvbG9ycy5yZWQobGV0dGVyKTtcclxuICAgICAgY2FzZSAxOiByZXR1cm4gY29sb3JzLndoaXRlKGxldHRlcilcclxuICAgICAgY2FzZSAyOiByZXR1cm4gY29sb3JzLmJsdWUobGV0dGVyKVxyXG4gICAgfVxyXG4gIH1cclxufSkoKTsiLCJ2YXIgY29sb3JzID0gcmVxdWlyZSgnLi4vY29sb3JzJyk7XHJcblxyXG5tb2R1bGVbJ2V4cG9ydHMnXSA9IChmdW5jdGlvbiAoKSB7XHJcbiAgdmFyIHJhaW5ib3dDb2xvcnMgPSBbJ3JlZCcsICd5ZWxsb3cnLCAnZ3JlZW4nLCAnYmx1ZScsICdtYWdlbnRhJ107IC8vUm9ZIEcgQmlWXHJcbiAgcmV0dXJuIGZ1bmN0aW9uIChsZXR0ZXIsIGksIGV4cGxvZGVkKSB7XHJcbiAgICBpZiAobGV0dGVyID09PSBcIiBcIikge1xyXG4gICAgICByZXR1cm4gbGV0dGVyO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgcmV0dXJuIGNvbG9yc1tyYWluYm93Q29sb3JzW2krKyAlIHJhaW5ib3dDb2xvcnMubGVuZ3RoXV0obGV0dGVyKTtcclxuICAgIH1cclxuICB9O1xyXG59KSgpO1xyXG5cclxuIiwidmFyIGNvbG9ycyA9IHJlcXVpcmUoJy4uL2NvbG9ycycpO1xyXG5cclxubW9kdWxlWydleHBvcnRzJ10gPSAoZnVuY3Rpb24gKCkge1xyXG4gIHZhciBhdmFpbGFibGUgPSBbJ3VuZGVybGluZScsICdpbnZlcnNlJywgJ2dyZXknLCAneWVsbG93JywgJ3JlZCcsICdncmVlbicsICdibHVlJywgJ3doaXRlJywgJ2N5YW4nLCAnbWFnZW50YSddO1xyXG4gIHJldHVybiBmdW5jdGlvbihsZXR0ZXIsIGksIGV4cGxvZGVkKSB7XHJcbiAgICByZXR1cm4gbGV0dGVyID09PSBcIiBcIiA/IGxldHRlciA6IGNvbG9yc1thdmFpbGFibGVbTWF0aC5yb3VuZChNYXRoLnJhbmRvbSgpICogKGF2YWlsYWJsZS5sZW5ndGggLSAxKSldXShsZXR0ZXIpO1xyXG4gIH07XHJcbn0pKCk7IiwidmFyIGNvbG9ycyA9IHJlcXVpcmUoJy4uL2NvbG9ycycpO1xyXG5cclxubW9kdWxlWydleHBvcnRzJ10gPSBmdW5jdGlvbiAobGV0dGVyLCBpLCBleHBsb2RlZCkge1xyXG4gIHJldHVybiBpICUgMiA9PT0gMCA/IGxldHRlciA6IGNvbG9ycy5pbnZlcnNlKGxldHRlcik7XHJcbn07IiwiLypcclxuVGhlIE1JVCBMaWNlbnNlIChNSVQpXHJcblxyXG5Db3B5cmlnaHQgKGMpIFNpbmRyZSBTb3JodXMgPHNpbmRyZXNvcmh1c0BnbWFpbC5jb20+IChzaW5kcmVzb3JodXMuY29tKVxyXG5cclxuUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weVxyXG5vZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXHJcbmluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcclxudG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbFxyXG5jb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcclxuZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczpcclxuXHJcblRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXHJcbmFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxyXG5cclxuVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxyXG5JTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcclxuRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU4gTk8gRVZFTlQgU0hBTEwgVEhFXHJcbkFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVJcclxuTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcclxuT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxyXG5USEUgU09GVFdBUkUuXHJcblxyXG4qL1xyXG5cclxudmFyIHN0eWxlcyA9IHt9O1xyXG5tb2R1bGVbJ2V4cG9ydHMnXSA9IHN0eWxlcztcclxuXHJcbnZhciBjb2RlcyA9IHtcclxuICByZXNldDogWzAsIDBdLFxyXG5cclxuICBib2xkOiBbMSwgMjJdLFxyXG4gIGRpbTogWzIsIDIyXSxcclxuICBpdGFsaWM6IFszLCAyM10sXHJcbiAgdW5kZXJsaW5lOiBbNCwgMjRdLFxyXG4gIGludmVyc2U6IFs3LCAyN10sXHJcbiAgaGlkZGVuOiBbOCwgMjhdLFxyXG4gIHN0cmlrZXRocm91Z2g6IFs5LCAyOV0sXHJcblxyXG4gIGJsYWNrOiBbMzAsIDM5XSxcclxuICByZWQ6IFszMSwgMzldLFxyXG4gIGdyZWVuOiBbMzIsIDM5XSxcclxuICB5ZWxsb3c6IFszMywgMzldLFxyXG4gIGJsdWU6IFszNCwgMzldLFxyXG4gIG1hZ2VudGE6IFszNSwgMzldLFxyXG4gIGN5YW46IFszNiwgMzldLFxyXG4gIHdoaXRlOiBbMzcsIDM5XSxcclxuICBncmF5OiBbOTAsIDM5XSxcclxuICBncmV5OiBbOTAsIDM5XSxcclxuXHJcbiAgYmdCbGFjazogWzQwLCA0OV0sXHJcbiAgYmdSZWQ6IFs0MSwgNDldLFxyXG4gIGJnR3JlZW46IFs0MiwgNDldLFxyXG4gIGJnWWVsbG93OiBbNDMsIDQ5XSxcclxuICBiZ0JsdWU6IFs0NCwgNDldLFxyXG4gIGJnTWFnZW50YTogWzQ1LCA0OV0sXHJcbiAgYmdDeWFuOiBbNDYsIDQ5XSxcclxuICBiZ1doaXRlOiBbNDcsIDQ5XSxcclxuXHJcbiAgLy8gbGVnYWN5IHN0eWxlcyBmb3IgY29sb3JzIHByZSB2MS4wLjBcclxuICBibGFja0JHOiBbNDAsIDQ5XSxcclxuICByZWRCRzogWzQxLCA0OV0sXHJcbiAgZ3JlZW5CRzogWzQyLCA0OV0sXHJcbiAgeWVsbG93Qkc6IFs0MywgNDldLFxyXG4gIGJsdWVCRzogWzQ0LCA0OV0sXHJcbiAgbWFnZW50YUJHOiBbNDUsIDQ5XSxcclxuICBjeWFuQkc6IFs0NiwgNDldLFxyXG4gIHdoaXRlQkc6IFs0NywgNDldXHJcblxyXG59O1xyXG5cclxuT2JqZWN0LmtleXMoY29kZXMpLmZvckVhY2goZnVuY3Rpb24gKGtleSkge1xyXG4gIHZhciB2YWwgPSBjb2Rlc1trZXldO1xyXG4gIHZhciBzdHlsZSA9IHN0eWxlc1trZXldID0gW107XHJcbiAgc3R5bGUub3BlbiA9ICdcXHUwMDFiWycgKyB2YWxbMF0gKyAnbSc7XHJcbiAgc3R5bGUuY2xvc2UgPSAnXFx1MDAxYlsnICsgdmFsWzFdICsgJ20nO1xyXG59KTsiLCIvKlxyXG5NSVQgTGljZW5zZVxyXG5cclxuQ29weXJpZ2h0IChjKSBTaW5kcmUgU29yaHVzIDxzaW5kcmVzb3JodXNAZ21haWwuY29tPiAoc2luZHJlc29yaHVzLmNvbSlcclxuXHJcblBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGUgXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6XHJcblxyXG5UaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cclxuXHJcblRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxyXG4qL1xyXG5cclxuJ3VzZSBzdHJpY3QnO1xyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoZmxhZywgYXJndikge1xyXG5cdGFyZ3YgPSBhcmd2IHx8IHByb2Nlc3MuYXJndjtcclxuXHJcblx0dmFyIHRlcm1pbmF0b3JQb3MgPSBhcmd2LmluZGV4T2YoJy0tJyk7XHJcblx0dmFyIHByZWZpeCA9IC9eLXsxLDJ9Ly50ZXN0KGZsYWcpID8gJycgOiAnLS0nO1xyXG5cdHZhciBwb3MgPSBhcmd2LmluZGV4T2YocHJlZml4ICsgZmxhZyk7XHJcblxyXG5cdHJldHVybiBwb3MgIT09IC0xICYmICh0ZXJtaW5hdG9yUG9zID09PSAtMSA/IHRydWUgOiBwb3MgPCB0ZXJtaW5hdG9yUG9zKTtcclxufTtcclxuIiwiLypcclxuVGhlIE1JVCBMaWNlbnNlIChNSVQpXHJcblxyXG5Db3B5cmlnaHQgKGMpIFNpbmRyZSBTb3JodXMgPHNpbmRyZXNvcmh1c0BnbWFpbC5jb20+IChzaW5kcmVzb3JodXMuY29tKVxyXG5cclxuUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weVxyXG5vZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXHJcbmluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcclxudG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbFxyXG5jb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcclxuZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczpcclxuXHJcblRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXHJcbmFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxyXG5cclxuVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxyXG5JTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcclxuRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU4gTk8gRVZFTlQgU0hBTEwgVEhFXHJcbkFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVJcclxuTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcclxuT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxyXG5USEUgU09GVFdBUkUuXHJcblxyXG4qL1xyXG5cclxuJ3VzZSBzdHJpY3QnO1xyXG5cclxudmFyIG9zID0gcmVxdWlyZSgnb3MnKTtcclxudmFyIGhhc0ZsYWcgPSByZXF1aXJlKCcuL2hhcy1mbGFnLmpzJyk7XHJcblxyXG52YXIgZW52ID0gcHJvY2Vzcy5lbnY7XHJcblxyXG52YXIgZm9yY2VDb2xvciA9IHZvaWQgMDtcclxuaWYgKGhhc0ZsYWcoJ25vLWNvbG9yJykgfHwgaGFzRmxhZygnbm8tY29sb3JzJykgfHwgaGFzRmxhZygnY29sb3I9ZmFsc2UnKSkge1xyXG5cdGZvcmNlQ29sb3IgPSBmYWxzZTtcclxufSBlbHNlIGlmIChoYXNGbGFnKCdjb2xvcicpIHx8IGhhc0ZsYWcoJ2NvbG9ycycpIHx8IGhhc0ZsYWcoJ2NvbG9yPXRydWUnKSB8fCBoYXNGbGFnKCdjb2xvcj1hbHdheXMnKSkge1xyXG5cdGZvcmNlQ29sb3IgPSB0cnVlO1xyXG59XHJcbmlmICgnRk9SQ0VfQ09MT1InIGluIGVudikge1xyXG5cdGZvcmNlQ29sb3IgPSBlbnYuRk9SQ0VfQ09MT1IubGVuZ3RoID09PSAwIHx8IHBhcnNlSW50KGVudi5GT1JDRV9DT0xPUiwgMTApICE9PSAwO1xyXG59XHJcblxyXG5mdW5jdGlvbiB0cmFuc2xhdGVMZXZlbChsZXZlbCkge1xyXG5cdGlmIChsZXZlbCA9PT0gMCkge1xyXG5cdFx0cmV0dXJuIGZhbHNlO1xyXG5cdH1cclxuXHJcblx0cmV0dXJuIHtcclxuXHRcdGxldmVsOiBsZXZlbCxcclxuXHRcdGhhc0Jhc2ljOiB0cnVlLFxyXG5cdFx0aGFzMjU2OiBsZXZlbCA+PSAyLFxyXG5cdFx0aGFzMTZtOiBsZXZlbCA+PSAzXHJcblx0fTtcclxufVxyXG5cclxuZnVuY3Rpb24gc3VwcG9ydHNDb2xvcihzdHJlYW0pIHtcclxuXHRpZiAoZm9yY2VDb2xvciA9PT0gZmFsc2UpIHtcclxuXHRcdHJldHVybiAwO1xyXG5cdH1cclxuXHJcblx0aWYgKGhhc0ZsYWcoJ2NvbG9yPTE2bScpIHx8IGhhc0ZsYWcoJ2NvbG9yPWZ1bGwnKSB8fCBoYXNGbGFnKCdjb2xvcj10cnVlY29sb3InKSkge1xyXG5cdFx0cmV0dXJuIDM7XHJcblx0fVxyXG5cclxuXHRpZiAoaGFzRmxhZygnY29sb3I9MjU2JykpIHtcclxuXHRcdHJldHVybiAyO1xyXG5cdH1cclxuXHJcblx0aWYgKHN0cmVhbSAmJiAhc3RyZWFtLmlzVFRZICYmIGZvcmNlQ29sb3IgIT09IHRydWUpIHtcclxuXHRcdHJldHVybiAwO1xyXG5cdH1cclxuXHJcblx0dmFyIG1pbiA9IGZvcmNlQ29sb3IgPyAxIDogMDtcclxuXHJcblx0aWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMicpIHtcclxuXHRcdC8vIE5vZGUuanMgNy41LjAgaXMgdGhlIGZpcnN0IHZlcnNpb24gb2YgTm9kZS5qcyB0byBpbmNsdWRlIGEgcGF0Y2ggdG9cclxuXHRcdC8vIGxpYnV2IHRoYXQgZW5hYmxlcyAyNTYgY29sb3Igb3V0cHV0IG9uIFdpbmRvd3MuIEFueXRoaW5nIGVhcmxpZXIgYW5kIGl0XHJcblx0XHQvLyB3b24ndCB3b3JrLiBIb3dldmVyLCBoZXJlIHdlIHRhcmdldCBOb2RlLmpzIDggYXQgbWluaW11bSBhcyBpdCBpcyBhbiBMVFNcclxuXHRcdC8vIHJlbGVhc2UsIGFuZCBOb2RlLmpzIDcgaXMgbm90LiBXaW5kb3dzIDEwIGJ1aWxkIDEwNTg2IGlzIHRoZSBmaXJzdCBXaW5kb3dzXHJcblx0XHQvLyByZWxlYXNlIHRoYXQgc3VwcG9ydHMgMjU2IGNvbG9ycy4gV2luZG93cyAxMCBidWlsZCAxNDkzMSBpcyB0aGUgZmlyc3QgcmVsZWFzZVxyXG5cdFx0Ly8gdGhhdCBzdXBwb3J0cyAxNm0vVHJ1ZUNvbG9yLlxyXG5cdFx0dmFyIG9zUmVsZWFzZSA9IG9zLnJlbGVhc2UoKS5zcGxpdCgnLicpO1xyXG5cdFx0aWYgKE51bWJlcihwcm9jZXNzLnZlcnNpb25zLm5vZGUuc3BsaXQoJy4nKVswXSkgPj0gOCAmJiBOdW1iZXIob3NSZWxlYXNlWzBdKSA+PSAxMCAmJiBOdW1iZXIob3NSZWxlYXNlWzJdKSA+PSAxMDU4Nikge1xyXG5cdFx0XHRyZXR1cm4gTnVtYmVyKG9zUmVsZWFzZVsyXSkgPj0gMTQ5MzEgPyAzIDogMjtcclxuXHRcdH1cclxuXHJcblx0XHRyZXR1cm4gMTtcclxuXHR9XHJcblxyXG5cdGlmICgnQ0knIGluIGVudikge1xyXG5cdFx0aWYgKFsnVFJBVklTJywgJ0NJUkNMRUNJJywgJ0FQUFZFWU9SJywgJ0dJVExBQl9DSSddLnNvbWUoZnVuY3Rpb24gKHNpZ24pIHtcclxuXHRcdFx0cmV0dXJuIHNpZ24gaW4gZW52O1xyXG5cdFx0fSkgfHwgZW52LkNJX05BTUUgPT09ICdjb2Rlc2hpcCcpIHtcclxuXHRcdFx0cmV0dXJuIDE7XHJcblx0XHR9XHJcblxyXG5cdFx0cmV0dXJuIG1pbjtcclxuXHR9XHJcblxyXG5cdGlmICgnVEVBTUNJVFlfVkVSU0lPTicgaW4gZW52KSB7XHJcblx0XHRyZXR1cm4gKC9eKDlcXC4oMCpbMS05XVxcZCopXFwufFxcZHsyLH1cXC4pLy50ZXN0KGVudi5URUFNQ0lUWV9WRVJTSU9OKSA/IDEgOiAwXHJcblx0XHQpO1xyXG5cdH1cclxuXHJcblx0aWYgKCdURVJNX1BST0dSQU0nIGluIGVudikge1xyXG5cdFx0dmFyIHZlcnNpb24gPSBwYXJzZUludCgoZW52LlRFUk1fUFJPR1JBTV9WRVJTSU9OIHx8ICcnKS5zcGxpdCgnLicpWzBdLCAxMCk7XHJcblxyXG5cdFx0c3dpdGNoIChlbnYuVEVSTV9QUk9HUkFNKSB7XHJcblx0XHRcdGNhc2UgJ2lUZXJtLmFwcCc6XHJcblx0XHRcdFx0cmV0dXJuIHZlcnNpb24gPj0gMyA/IDMgOiAyO1xyXG5cdFx0XHRjYXNlICdIeXBlcic6XHJcblx0XHRcdFx0cmV0dXJuIDM7XHJcblx0XHRcdGNhc2UgJ0FwcGxlX1Rlcm1pbmFsJzpcclxuXHRcdFx0XHRyZXR1cm4gMjtcclxuXHRcdFx0Ly8gTm8gZGVmYXVsdFxyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0aWYgKC8tMjU2KGNvbG9yKT8kL2kudGVzdChlbnYuVEVSTSkpIHtcclxuXHRcdHJldHVybiAyO1xyXG5cdH1cclxuXHJcblx0aWYgKC9ec2NyZWVufF54dGVybXxednQxMDB8XnJ4dnR8Y29sb3J8YW5zaXxjeWd3aW58bGludXgvaS50ZXN0KGVudi5URVJNKSkge1xyXG5cdFx0cmV0dXJuIDE7XHJcblx0fVxyXG5cclxuXHRpZiAoJ0NPTE9SVEVSTScgaW4gZW52KSB7XHJcblx0XHRyZXR1cm4gMTtcclxuXHR9XHJcblxyXG5cdGlmIChlbnYuVEVSTSA9PT0gJ2R1bWInKSB7XHJcblx0XHRyZXR1cm4gbWluO1xyXG5cdH1cclxuXHJcblx0cmV0dXJuIG1pbjtcclxufVxyXG5cclxuZnVuY3Rpb24gZ2V0U3VwcG9ydExldmVsKHN0cmVhbSkge1xyXG5cdHZhciBsZXZlbCA9IHN1cHBvcnRzQ29sb3Ioc3RyZWFtKTtcclxuXHRyZXR1cm4gdHJhbnNsYXRlTGV2ZWwobGV2ZWwpO1xyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHtcclxuXHRzdXBwb3J0c0NvbG9yOiBnZXRTdXBwb3J0TGV2ZWwsXHJcblx0c3Rkb3V0OiBnZXRTdXBwb3J0TGV2ZWwocHJvY2Vzcy5zdGRvdXQpLFxyXG5cdHN0ZGVycjogZ2V0U3VwcG9ydExldmVsKHByb2Nlc3Muc3RkZXJyKVxyXG59O1xyXG4iLCIvLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxudmFyIG9iamVjdENyZWF0ZSA9IE9iamVjdC5jcmVhdGUgfHwgb2JqZWN0Q3JlYXRlUG9seWZpbGxcbnZhciBvYmplY3RLZXlzID0gT2JqZWN0LmtleXMgfHwgb2JqZWN0S2V5c1BvbHlmaWxsXG52YXIgYmluZCA9IEZ1bmN0aW9uLnByb3RvdHlwZS5iaW5kIHx8IGZ1bmN0aW9uQmluZFBvbHlmaWxsXG5cbmZ1bmN0aW9uIEV2ZW50RW1pdHRlcigpIHtcbiAgaWYgKCF0aGlzLl9ldmVudHMgfHwgIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCh0aGlzLCAnX2V2ZW50cycpKSB7XG4gICAgdGhpcy5fZXZlbnRzID0gb2JqZWN0Q3JlYXRlKG51bGwpO1xuICAgIHRoaXMuX2V2ZW50c0NvdW50ID0gMDtcbiAgfVxuXG4gIHRoaXMuX21heExpc3RlbmVycyA9IHRoaXMuX21heExpc3RlbmVycyB8fCB1bmRlZmluZWQ7XG59XG5tb2R1bGUuZXhwb3J0cyA9IEV2ZW50RW1pdHRlcjtcblxuLy8gQmFja3dhcmRzLWNvbXBhdCB3aXRoIG5vZGUgMC4xMC54XG5FdmVudEVtaXR0ZXIuRXZlbnRFbWl0dGVyID0gRXZlbnRFbWl0dGVyO1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLl9ldmVudHMgPSB1bmRlZmluZWQ7XG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLl9tYXhMaXN0ZW5lcnMgPSB1bmRlZmluZWQ7XG5cbi8vIEJ5IGRlZmF1bHQgRXZlbnRFbWl0dGVycyB3aWxsIHByaW50IGEgd2FybmluZyBpZiBtb3JlIHRoYW4gMTAgbGlzdGVuZXJzIGFyZVxuLy8gYWRkZWQgdG8gaXQuIFRoaXMgaXMgYSB1c2VmdWwgZGVmYXVsdCB3aGljaCBoZWxwcyBmaW5kaW5nIG1lbW9yeSBsZWFrcy5cbnZhciBkZWZhdWx0TWF4TGlzdGVuZXJzID0gMTA7XG5cbnZhciBoYXNEZWZpbmVQcm9wZXJ0eTtcbnRyeSB7XG4gIHZhciBvID0ge307XG4gIGlmIChPYmplY3QuZGVmaW5lUHJvcGVydHkpIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShvLCAneCcsIHsgdmFsdWU6IDAgfSk7XG4gIGhhc0RlZmluZVByb3BlcnR5ID0gby54ID09PSAwO1xufSBjYXRjaCAoZXJyKSB7IGhhc0RlZmluZVByb3BlcnR5ID0gZmFsc2UgfVxuaWYgKGhhc0RlZmluZVByb3BlcnR5KSB7XG4gIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShFdmVudEVtaXR0ZXIsICdkZWZhdWx0TWF4TGlzdGVuZXJzJywge1xuICAgIGVudW1lcmFibGU6IHRydWUsXG4gICAgZ2V0OiBmdW5jdGlvbigpIHtcbiAgICAgIHJldHVybiBkZWZhdWx0TWF4TGlzdGVuZXJzO1xuICAgIH0sXG4gICAgc2V0OiBmdW5jdGlvbihhcmcpIHtcbiAgICAgIC8vIGNoZWNrIHdoZXRoZXIgdGhlIGlucHV0IGlzIGEgcG9zaXRpdmUgbnVtYmVyICh3aG9zZSB2YWx1ZSBpcyB6ZXJvIG9yXG4gICAgICAvLyBncmVhdGVyIGFuZCBub3QgYSBOYU4pLlxuICAgICAgaWYgKHR5cGVvZiBhcmcgIT09ICdudW1iZXInIHx8IGFyZyA8IDAgfHwgYXJnICE9PSBhcmcpXG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1wiZGVmYXVsdE1heExpc3RlbmVyc1wiIG11c3QgYmUgYSBwb3NpdGl2ZSBudW1iZXInKTtcbiAgICAgIGRlZmF1bHRNYXhMaXN0ZW5lcnMgPSBhcmc7XG4gICAgfVxuICB9KTtcbn0gZWxzZSB7XG4gIEV2ZW50RW1pdHRlci5kZWZhdWx0TWF4TGlzdGVuZXJzID0gZGVmYXVsdE1heExpc3RlbmVycztcbn1cblxuLy8gT2J2aW91c2x5IG5vdCBhbGwgRW1pdHRlcnMgc2hvdWxkIGJlIGxpbWl0ZWQgdG8gMTAuIFRoaXMgZnVuY3Rpb24gYWxsb3dzXG4vLyB0aGF0IHRvIGJlIGluY3JlYXNlZC4gU2V0IHRvIHplcm8gZm9yIHVubGltaXRlZC5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuc2V0TWF4TGlzdGVuZXJzID0gZnVuY3Rpb24gc2V0TWF4TGlzdGVuZXJzKG4pIHtcbiAgaWYgKHR5cGVvZiBuICE9PSAnbnVtYmVyJyB8fCBuIDwgMCB8fCBpc05hTihuKSlcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdcIm5cIiBhcmd1bWVudCBtdXN0IGJlIGEgcG9zaXRpdmUgbnVtYmVyJyk7XG4gIHRoaXMuX21heExpc3RlbmVycyA9IG47XG4gIHJldHVybiB0aGlzO1xufTtcblxuZnVuY3Rpb24gJGdldE1heExpc3RlbmVycyh0aGF0KSB7XG4gIGlmICh0aGF0Ll9tYXhMaXN0ZW5lcnMgPT09IHVuZGVmaW5lZClcbiAgICByZXR1cm4gRXZlbnRFbWl0dGVyLmRlZmF1bHRNYXhMaXN0ZW5lcnM7XG4gIHJldHVybiB0aGF0Ll9tYXhMaXN0ZW5lcnM7XG59XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuZ2V0TWF4TGlzdGVuZXJzID0gZnVuY3Rpb24gZ2V0TWF4TGlzdGVuZXJzKCkge1xuICByZXR1cm4gJGdldE1heExpc3RlbmVycyh0aGlzKTtcbn07XG5cbi8vIFRoZXNlIHN0YW5kYWxvbmUgZW1pdCogZnVuY3Rpb25zIGFyZSB1c2VkIHRvIG9wdGltaXplIGNhbGxpbmcgb2YgZXZlbnRcbi8vIGhhbmRsZXJzIGZvciBmYXN0IGNhc2VzIGJlY2F1c2UgZW1pdCgpIGl0c2VsZiBvZnRlbiBoYXMgYSB2YXJpYWJsZSBudW1iZXIgb2Zcbi8vIGFyZ3VtZW50cyBhbmQgY2FuIGJlIGRlb3B0aW1pemVkIGJlY2F1c2Ugb2YgdGhhdC4gVGhlc2UgZnVuY3Rpb25zIGFsd2F5cyBoYXZlXG4vLyB0aGUgc2FtZSBudW1iZXIgb2YgYXJndW1lbnRzIGFuZCB0aHVzIGRvIG5vdCBnZXQgZGVvcHRpbWl6ZWQsIHNvIHRoZSBjb2RlXG4vLyBpbnNpZGUgdGhlbSBjYW4gZXhlY3V0ZSBmYXN0ZXIuXG5mdW5jdGlvbiBlbWl0Tm9uZShoYW5kbGVyLCBpc0ZuLCBzZWxmKSB7XG4gIGlmIChpc0ZuKVxuICAgIGhhbmRsZXIuY2FsbChzZWxmKTtcbiAgZWxzZSB7XG4gICAgdmFyIGxlbiA9IGhhbmRsZXIubGVuZ3RoO1xuICAgIHZhciBsaXN0ZW5lcnMgPSBhcnJheUNsb25lKGhhbmRsZXIsIGxlbik7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW47ICsraSlcbiAgICAgIGxpc3RlbmVyc1tpXS5jYWxsKHNlbGYpO1xuICB9XG59XG5mdW5jdGlvbiBlbWl0T25lKGhhbmRsZXIsIGlzRm4sIHNlbGYsIGFyZzEpIHtcbiAgaWYgKGlzRm4pXG4gICAgaGFuZGxlci5jYWxsKHNlbGYsIGFyZzEpO1xuICBlbHNlIHtcbiAgICB2YXIgbGVuID0gaGFuZGxlci5sZW5ndGg7XG4gICAgdmFyIGxpc3RlbmVycyA9IGFycmF5Q2xvbmUoaGFuZGxlciwgbGVuKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgKytpKVxuICAgICAgbGlzdGVuZXJzW2ldLmNhbGwoc2VsZiwgYXJnMSk7XG4gIH1cbn1cbmZ1bmN0aW9uIGVtaXRUd28oaGFuZGxlciwgaXNGbiwgc2VsZiwgYXJnMSwgYXJnMikge1xuICBpZiAoaXNGbilcbiAgICBoYW5kbGVyLmNhbGwoc2VsZiwgYXJnMSwgYXJnMik7XG4gIGVsc2Uge1xuICAgIHZhciBsZW4gPSBoYW5kbGVyLmxlbmd0aDtcbiAgICB2YXIgbGlzdGVuZXJzID0gYXJyYXlDbG9uZShoYW5kbGVyLCBsZW4pO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyArK2kpXG4gICAgICBsaXN0ZW5lcnNbaV0uY2FsbChzZWxmLCBhcmcxLCBhcmcyKTtcbiAgfVxufVxuZnVuY3Rpb24gZW1pdFRocmVlKGhhbmRsZXIsIGlzRm4sIHNlbGYsIGFyZzEsIGFyZzIsIGFyZzMpIHtcbiAgaWYgKGlzRm4pXG4gICAgaGFuZGxlci5jYWxsKHNlbGYsIGFyZzEsIGFyZzIsIGFyZzMpO1xuICBlbHNlIHtcbiAgICB2YXIgbGVuID0gaGFuZGxlci5sZW5ndGg7XG4gICAgdmFyIGxpc3RlbmVycyA9IGFycmF5Q2xvbmUoaGFuZGxlciwgbGVuKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgKytpKVxuICAgICAgbGlzdGVuZXJzW2ldLmNhbGwoc2VsZiwgYXJnMSwgYXJnMiwgYXJnMyk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZW1pdE1hbnkoaGFuZGxlciwgaXNGbiwgc2VsZiwgYXJncykge1xuICBpZiAoaXNGbilcbiAgICBoYW5kbGVyLmFwcGx5KHNlbGYsIGFyZ3MpO1xuICBlbHNlIHtcbiAgICB2YXIgbGVuID0gaGFuZGxlci5sZW5ndGg7XG4gICAgdmFyIGxpc3RlbmVycyA9IGFycmF5Q2xvbmUoaGFuZGxlciwgbGVuKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgKytpKVxuICAgICAgbGlzdGVuZXJzW2ldLmFwcGx5KHNlbGYsIGFyZ3MpO1xuICB9XG59XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuZW1pdCA9IGZ1bmN0aW9uIGVtaXQodHlwZSkge1xuICB2YXIgZXIsIGhhbmRsZXIsIGxlbiwgYXJncywgaSwgZXZlbnRzO1xuICB2YXIgZG9FcnJvciA9ICh0eXBlID09PSAnZXJyb3InKTtcblxuICBldmVudHMgPSB0aGlzLl9ldmVudHM7XG4gIGlmIChldmVudHMpXG4gICAgZG9FcnJvciA9IChkb0Vycm9yICYmIGV2ZW50cy5lcnJvciA9PSBudWxsKTtcbiAgZWxzZSBpZiAoIWRvRXJyb3IpXG4gICAgcmV0dXJuIGZhbHNlO1xuXG4gIC8vIElmIHRoZXJlIGlzIG5vICdlcnJvcicgZXZlbnQgbGlzdGVuZXIgdGhlbiB0aHJvdy5cbiAgaWYgKGRvRXJyb3IpIHtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDEpXG4gICAgICBlciA9IGFyZ3VtZW50c1sxXTtcbiAgICBpZiAoZXIgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgICAgdGhyb3cgZXI7IC8vIFVuaGFuZGxlZCAnZXJyb3InIGV2ZW50XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEF0IGxlYXN0IGdpdmUgc29tZSBraW5kIG9mIGNvbnRleHQgdG8gdGhlIHVzZXJcbiAgICAgIHZhciBlcnIgPSBuZXcgRXJyb3IoJ1VuaGFuZGxlZCBcImVycm9yXCIgZXZlbnQuICgnICsgZXIgKyAnKScpO1xuICAgICAgZXJyLmNvbnRleHQgPSBlcjtcbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgaGFuZGxlciA9IGV2ZW50c1t0eXBlXTtcblxuICBpZiAoIWhhbmRsZXIpXG4gICAgcmV0dXJuIGZhbHNlO1xuXG4gIHZhciBpc0ZuID0gdHlwZW9mIGhhbmRsZXIgPT09ICdmdW5jdGlvbic7XG4gIGxlbiA9IGFyZ3VtZW50cy5sZW5ndGg7XG4gIHN3aXRjaCAobGVuKSB7XG4gICAgICAvLyBmYXN0IGNhc2VzXG4gICAgY2FzZSAxOlxuICAgICAgZW1pdE5vbmUoaGFuZGxlciwgaXNGbiwgdGhpcyk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIDI6XG4gICAgICBlbWl0T25lKGhhbmRsZXIsIGlzRm4sIHRoaXMsIGFyZ3VtZW50c1sxXSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIDM6XG4gICAgICBlbWl0VHdvKGhhbmRsZXIsIGlzRm4sIHRoaXMsIGFyZ3VtZW50c1sxXSwgYXJndW1lbnRzWzJdKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgNDpcbiAgICAgIGVtaXRUaHJlZShoYW5kbGVyLCBpc0ZuLCB0aGlzLCBhcmd1bWVudHNbMV0sIGFyZ3VtZW50c1syXSwgYXJndW1lbnRzWzNdKTtcbiAgICAgIGJyZWFrO1xuICAgICAgLy8gc2xvd2VyXG4gICAgZGVmYXVsdDpcbiAgICAgIGFyZ3MgPSBuZXcgQXJyYXkobGVuIC0gMSk7XG4gICAgICBmb3IgKGkgPSAxOyBpIDwgbGVuOyBpKyspXG4gICAgICAgIGFyZ3NbaSAtIDFdID0gYXJndW1lbnRzW2ldO1xuICAgICAgZW1pdE1hbnkoaGFuZGxlciwgaXNGbiwgdGhpcywgYXJncyk7XG4gIH1cblxuICByZXR1cm4gdHJ1ZTtcbn07XG5cbmZ1bmN0aW9uIF9hZGRMaXN0ZW5lcih0YXJnZXQsIHR5cGUsIGxpc3RlbmVyLCBwcmVwZW5kKSB7XG4gIHZhciBtO1xuICB2YXIgZXZlbnRzO1xuICB2YXIgZXhpc3Rpbmc7XG5cbiAgaWYgKHR5cGVvZiBsaXN0ZW5lciAhPT0gJ2Z1bmN0aW9uJylcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdcImxpc3RlbmVyXCIgYXJndW1lbnQgbXVzdCBiZSBhIGZ1bmN0aW9uJyk7XG5cbiAgZXZlbnRzID0gdGFyZ2V0Ll9ldmVudHM7XG4gIGlmICghZXZlbnRzKSB7XG4gICAgZXZlbnRzID0gdGFyZ2V0Ll9ldmVudHMgPSBvYmplY3RDcmVhdGUobnVsbCk7XG4gICAgdGFyZ2V0Ll9ldmVudHNDb3VudCA9IDA7XG4gIH0gZWxzZSB7XG4gICAgLy8gVG8gYXZvaWQgcmVjdXJzaW9uIGluIHRoZSBjYXNlIHRoYXQgdHlwZSA9PT0gXCJuZXdMaXN0ZW5lclwiISBCZWZvcmVcbiAgICAvLyBhZGRpbmcgaXQgdG8gdGhlIGxpc3RlbmVycywgZmlyc3QgZW1pdCBcIm5ld0xpc3RlbmVyXCIuXG4gICAgaWYgKGV2ZW50cy5uZXdMaXN0ZW5lcikge1xuICAgICAgdGFyZ2V0LmVtaXQoJ25ld0xpc3RlbmVyJywgdHlwZSxcbiAgICAgICAgICBsaXN0ZW5lci5saXN0ZW5lciA/IGxpc3RlbmVyLmxpc3RlbmVyIDogbGlzdGVuZXIpO1xuXG4gICAgICAvLyBSZS1hc3NpZ24gYGV2ZW50c2AgYmVjYXVzZSBhIG5ld0xpc3RlbmVyIGhhbmRsZXIgY291bGQgaGF2ZSBjYXVzZWQgdGhlXG4gICAgICAvLyB0aGlzLl9ldmVudHMgdG8gYmUgYXNzaWduZWQgdG8gYSBuZXcgb2JqZWN0XG4gICAgICBldmVudHMgPSB0YXJnZXQuX2V2ZW50cztcbiAgICB9XG4gICAgZXhpc3RpbmcgPSBldmVudHNbdHlwZV07XG4gIH1cblxuICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgLy8gT3B0aW1pemUgdGhlIGNhc2Ugb2Ygb25lIGxpc3RlbmVyLiBEb24ndCBuZWVkIHRoZSBleHRyYSBhcnJheSBvYmplY3QuXG4gICAgZXhpc3RpbmcgPSBldmVudHNbdHlwZV0gPSBsaXN0ZW5lcjtcbiAgICArK3RhcmdldC5fZXZlbnRzQ291bnQ7XG4gIH0gZWxzZSB7XG4gICAgaWYgKHR5cGVvZiBleGlzdGluZyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgLy8gQWRkaW5nIHRoZSBzZWNvbmQgZWxlbWVudCwgbmVlZCB0byBjaGFuZ2UgdG8gYXJyYXkuXG4gICAgICBleGlzdGluZyA9IGV2ZW50c1t0eXBlXSA9XG4gICAgICAgICAgcHJlcGVuZCA/IFtsaXN0ZW5lciwgZXhpc3RpbmddIDogW2V4aXN0aW5nLCBsaXN0ZW5lcl07XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIElmIHdlJ3ZlIGFscmVhZHkgZ290IGFuIGFycmF5LCBqdXN0IGFwcGVuZC5cbiAgICAgIGlmIChwcmVwZW5kKSB7XG4gICAgICAgIGV4aXN0aW5nLnVuc2hpZnQobGlzdGVuZXIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZXhpc3RpbmcucHVzaChsaXN0ZW5lcik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgZm9yIGxpc3RlbmVyIGxlYWtcbiAgICBpZiAoIWV4aXN0aW5nLndhcm5lZCkge1xuICAgICAgbSA9ICRnZXRNYXhMaXN0ZW5lcnModGFyZ2V0KTtcbiAgICAgIGlmIChtICYmIG0gPiAwICYmIGV4aXN0aW5nLmxlbmd0aCA+IG0pIHtcbiAgICAgICAgZXhpc3Rpbmcud2FybmVkID0gdHJ1ZTtcbiAgICAgICAgdmFyIHcgPSBuZXcgRXJyb3IoJ1Bvc3NpYmxlIEV2ZW50RW1pdHRlciBtZW1vcnkgbGVhayBkZXRlY3RlZC4gJyArXG4gICAgICAgICAgICBleGlzdGluZy5sZW5ndGggKyAnIFwiJyArIFN0cmluZyh0eXBlKSArICdcIiBsaXN0ZW5lcnMgJyArXG4gICAgICAgICAgICAnYWRkZWQuIFVzZSBlbWl0dGVyLnNldE1heExpc3RlbmVycygpIHRvICcgK1xuICAgICAgICAgICAgJ2luY3JlYXNlIGxpbWl0LicpO1xuICAgICAgICB3Lm5hbWUgPSAnTWF4TGlzdGVuZXJzRXhjZWVkZWRXYXJuaW5nJztcbiAgICAgICAgdy5lbWl0dGVyID0gdGFyZ2V0O1xuICAgICAgICB3LnR5cGUgPSB0eXBlO1xuICAgICAgICB3LmNvdW50ID0gZXhpc3RpbmcubGVuZ3RoO1xuICAgICAgICBpZiAodHlwZW9mIGNvbnNvbGUgPT09ICdvYmplY3QnICYmIGNvbnNvbGUud2Fybikge1xuICAgICAgICAgIGNvbnNvbGUud2FybignJXM6ICVzJywgdy5uYW1lLCB3Lm1lc3NhZ2UpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHRhcmdldDtcbn1cblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5hZGRMaXN0ZW5lciA9IGZ1bmN0aW9uIGFkZExpc3RlbmVyKHR5cGUsIGxpc3RlbmVyKSB7XG4gIHJldHVybiBfYWRkTGlzdGVuZXIodGhpcywgdHlwZSwgbGlzdGVuZXIsIGZhbHNlKTtcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUub24gPSBFdmVudEVtaXR0ZXIucHJvdG90eXBlLmFkZExpc3RlbmVyO1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLnByZXBlbmRMaXN0ZW5lciA9XG4gICAgZnVuY3Rpb24gcHJlcGVuZExpc3RlbmVyKHR5cGUsIGxpc3RlbmVyKSB7XG4gICAgICByZXR1cm4gX2FkZExpc3RlbmVyKHRoaXMsIHR5cGUsIGxpc3RlbmVyLCB0cnVlKTtcbiAgICB9O1xuXG5mdW5jdGlvbiBvbmNlV3JhcHBlcigpIHtcbiAgaWYgKCF0aGlzLmZpcmVkKSB7XG4gICAgdGhpcy50YXJnZXQucmVtb3ZlTGlzdGVuZXIodGhpcy50eXBlLCB0aGlzLndyYXBGbik7XG4gICAgdGhpcy5maXJlZCA9IHRydWU7XG4gICAgc3dpdGNoIChhcmd1bWVudHMubGVuZ3RoKSB7XG4gICAgICBjYXNlIDA6XG4gICAgICAgIHJldHVybiB0aGlzLmxpc3RlbmVyLmNhbGwodGhpcy50YXJnZXQpO1xuICAgICAgY2FzZSAxOlxuICAgICAgICByZXR1cm4gdGhpcy5saXN0ZW5lci5jYWxsKHRoaXMudGFyZ2V0LCBhcmd1bWVudHNbMF0pO1xuICAgICAgY2FzZSAyOlxuICAgICAgICByZXR1cm4gdGhpcy5saXN0ZW5lci5jYWxsKHRoaXMudGFyZ2V0LCBhcmd1bWVudHNbMF0sIGFyZ3VtZW50c1sxXSk7XG4gICAgICBjYXNlIDM6XG4gICAgICAgIHJldHVybiB0aGlzLmxpc3RlbmVyLmNhbGwodGhpcy50YXJnZXQsIGFyZ3VtZW50c1swXSwgYXJndW1lbnRzWzFdLFxuICAgICAgICAgICAgYXJndW1lbnRzWzJdKTtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHZhciBhcmdzID0gbmV3IEFycmF5KGFyZ3VtZW50cy5sZW5ndGgpO1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGFyZ3MubGVuZ3RoOyArK2kpXG4gICAgICAgICAgYXJnc1tpXSA9IGFyZ3VtZW50c1tpXTtcbiAgICAgICAgdGhpcy5saXN0ZW5lci5hcHBseSh0aGlzLnRhcmdldCwgYXJncyk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIF9vbmNlV3JhcCh0YXJnZXQsIHR5cGUsIGxpc3RlbmVyKSB7XG4gIHZhciBzdGF0ZSA9IHsgZmlyZWQ6IGZhbHNlLCB3cmFwRm46IHVuZGVmaW5lZCwgdGFyZ2V0OiB0YXJnZXQsIHR5cGU6IHR5cGUsIGxpc3RlbmVyOiBsaXN0ZW5lciB9O1xuICB2YXIgd3JhcHBlZCA9IGJpbmQuY2FsbChvbmNlV3JhcHBlciwgc3RhdGUpO1xuICB3cmFwcGVkLmxpc3RlbmVyID0gbGlzdGVuZXI7XG4gIHN0YXRlLndyYXBGbiA9IHdyYXBwZWQ7XG4gIHJldHVybiB3cmFwcGVkO1xufVxuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLm9uY2UgPSBmdW5jdGlvbiBvbmNlKHR5cGUsIGxpc3RlbmVyKSB7XG4gIGlmICh0eXBlb2YgbGlzdGVuZXIgIT09ICdmdW5jdGlvbicpXG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignXCJsaXN0ZW5lclwiIGFyZ3VtZW50IG11c3QgYmUgYSBmdW5jdGlvbicpO1xuICB0aGlzLm9uKHR5cGUsIF9vbmNlV3JhcCh0aGlzLCB0eXBlLCBsaXN0ZW5lcikpO1xuICByZXR1cm4gdGhpcztcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUucHJlcGVuZE9uY2VMaXN0ZW5lciA9XG4gICAgZnVuY3Rpb24gcHJlcGVuZE9uY2VMaXN0ZW5lcih0eXBlLCBsaXN0ZW5lcikge1xuICAgICAgaWYgKHR5cGVvZiBsaXN0ZW5lciAhPT0gJ2Z1bmN0aW9uJylcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignXCJsaXN0ZW5lclwiIGFyZ3VtZW50IG11c3QgYmUgYSBmdW5jdGlvbicpO1xuICAgICAgdGhpcy5wcmVwZW5kTGlzdGVuZXIodHlwZSwgX29uY2VXcmFwKHRoaXMsIHR5cGUsIGxpc3RlbmVyKSk7XG4gICAgICByZXR1cm4gdGhpcztcbiAgICB9O1xuXG4vLyBFbWl0cyBhICdyZW1vdmVMaXN0ZW5lcicgZXZlbnQgaWYgYW5kIG9ubHkgaWYgdGhlIGxpc3RlbmVyIHdhcyByZW1vdmVkLlxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5yZW1vdmVMaXN0ZW5lciA9XG4gICAgZnVuY3Rpb24gcmVtb3ZlTGlzdGVuZXIodHlwZSwgbGlzdGVuZXIpIHtcbiAgICAgIHZhciBsaXN0LCBldmVudHMsIHBvc2l0aW9uLCBpLCBvcmlnaW5hbExpc3RlbmVyO1xuXG4gICAgICBpZiAodHlwZW9mIGxpc3RlbmVyICE9PSAnZnVuY3Rpb24nKVxuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdcImxpc3RlbmVyXCIgYXJndW1lbnQgbXVzdCBiZSBhIGZ1bmN0aW9uJyk7XG5cbiAgICAgIGV2ZW50cyA9IHRoaXMuX2V2ZW50cztcbiAgICAgIGlmICghZXZlbnRzKVxuICAgICAgICByZXR1cm4gdGhpcztcblxuICAgICAgbGlzdCA9IGV2ZW50c1t0eXBlXTtcbiAgICAgIGlmICghbGlzdClcbiAgICAgICAgcmV0dXJuIHRoaXM7XG5cbiAgICAgIGlmIChsaXN0ID09PSBsaXN0ZW5lciB8fCBsaXN0Lmxpc3RlbmVyID09PSBsaXN0ZW5lcikge1xuICAgICAgICBpZiAoLS10aGlzLl9ldmVudHNDb3VudCA9PT0gMClcbiAgICAgICAgICB0aGlzLl9ldmVudHMgPSBvYmplY3RDcmVhdGUobnVsbCk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGRlbGV0ZSBldmVudHNbdHlwZV07XG4gICAgICAgICAgaWYgKGV2ZW50cy5yZW1vdmVMaXN0ZW5lcilcbiAgICAgICAgICAgIHRoaXMuZW1pdCgncmVtb3ZlTGlzdGVuZXInLCB0eXBlLCBsaXN0Lmxpc3RlbmVyIHx8IGxpc3RlbmVyKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmICh0eXBlb2YgbGlzdCAhPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBwb3NpdGlvbiA9IC0xO1xuXG4gICAgICAgIGZvciAoaSA9IGxpc3QubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICAgICAgICBpZiAobGlzdFtpXSA9PT0gbGlzdGVuZXIgfHwgbGlzdFtpXS5saXN0ZW5lciA9PT0gbGlzdGVuZXIpIHtcbiAgICAgICAgICAgIG9yaWdpbmFsTGlzdGVuZXIgPSBsaXN0W2ldLmxpc3RlbmVyO1xuICAgICAgICAgICAgcG9zaXRpb24gPSBpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHBvc2l0aW9uIDwgMClcbiAgICAgICAgICByZXR1cm4gdGhpcztcblxuICAgICAgICBpZiAocG9zaXRpb24gPT09IDApXG4gICAgICAgICAgbGlzdC5zaGlmdCgpO1xuICAgICAgICBlbHNlXG4gICAgICAgICAgc3BsaWNlT25lKGxpc3QsIHBvc2l0aW9uKTtcblxuICAgICAgICBpZiAobGlzdC5sZW5ndGggPT09IDEpXG4gICAgICAgICAgZXZlbnRzW3R5cGVdID0gbGlzdFswXTtcblxuICAgICAgICBpZiAoZXZlbnRzLnJlbW92ZUxpc3RlbmVyKVxuICAgICAgICAgIHRoaXMuZW1pdCgncmVtb3ZlTGlzdGVuZXInLCB0eXBlLCBvcmlnaW5hbExpc3RlbmVyIHx8IGxpc3RlbmVyKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5yZW1vdmVBbGxMaXN0ZW5lcnMgPVxuICAgIGZ1bmN0aW9uIHJlbW92ZUFsbExpc3RlbmVycyh0eXBlKSB7XG4gICAgICB2YXIgbGlzdGVuZXJzLCBldmVudHMsIGk7XG5cbiAgICAgIGV2ZW50cyA9IHRoaXMuX2V2ZW50cztcbiAgICAgIGlmICghZXZlbnRzKVxuICAgICAgICByZXR1cm4gdGhpcztcblxuICAgICAgLy8gbm90IGxpc3RlbmluZyBmb3IgcmVtb3ZlTGlzdGVuZXIsIG5vIG5lZWQgdG8gZW1pdFxuICAgICAgaWYgKCFldmVudHMucmVtb3ZlTGlzdGVuZXIpIHtcbiAgICAgICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICB0aGlzLl9ldmVudHMgPSBvYmplY3RDcmVhdGUobnVsbCk7XG4gICAgICAgICAgdGhpcy5fZXZlbnRzQ291bnQgPSAwO1xuICAgICAgICB9IGVsc2UgaWYgKGV2ZW50c1t0eXBlXSkge1xuICAgICAgICAgIGlmICgtLXRoaXMuX2V2ZW50c0NvdW50ID09PSAwKVxuICAgICAgICAgICAgdGhpcy5fZXZlbnRzID0gb2JqZWN0Q3JlYXRlKG51bGwpO1xuICAgICAgICAgIGVsc2VcbiAgICAgICAgICAgIGRlbGV0ZSBldmVudHNbdHlwZV07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICB9XG5cbiAgICAgIC8vIGVtaXQgcmVtb3ZlTGlzdGVuZXIgZm9yIGFsbCBsaXN0ZW5lcnMgb24gYWxsIGV2ZW50c1xuICAgICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdmFyIGtleXMgPSBvYmplY3RLZXlzKGV2ZW50cyk7XG4gICAgICAgIHZhciBrZXk7XG4gICAgICAgIGZvciAoaSA9IDA7IGkgPCBrZXlzLmxlbmd0aDsgKytpKSB7XG4gICAgICAgICAga2V5ID0ga2V5c1tpXTtcbiAgICAgICAgICBpZiAoa2V5ID09PSAncmVtb3ZlTGlzdGVuZXInKSBjb250aW51ZTtcbiAgICAgICAgICB0aGlzLnJlbW92ZUFsbExpc3RlbmVycyhrZXkpO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMucmVtb3ZlQWxsTGlzdGVuZXJzKCdyZW1vdmVMaXN0ZW5lcicpO1xuICAgICAgICB0aGlzLl9ldmVudHMgPSBvYmplY3RDcmVhdGUobnVsbCk7XG4gICAgICAgIHRoaXMuX2V2ZW50c0NvdW50ID0gMDtcbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICB9XG5cbiAgICAgIGxpc3RlbmVycyA9IGV2ZW50c1t0eXBlXTtcblxuICAgICAgaWYgKHR5cGVvZiBsaXN0ZW5lcnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgdGhpcy5yZW1vdmVMaXN0ZW5lcih0eXBlLCBsaXN0ZW5lcnMpO1xuICAgICAgfSBlbHNlIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgLy8gTElGTyBvcmRlclxuICAgICAgICBmb3IgKGkgPSBsaXN0ZW5lcnMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICAgICAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKHR5cGUsIGxpc3RlbmVyc1tpXSk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5saXN0ZW5lcnMgPSBmdW5jdGlvbiBsaXN0ZW5lcnModHlwZSkge1xuICB2YXIgZXZsaXN0ZW5lcjtcbiAgdmFyIHJldDtcbiAgdmFyIGV2ZW50cyA9IHRoaXMuX2V2ZW50cztcblxuICBpZiAoIWV2ZW50cylcbiAgICByZXQgPSBbXTtcbiAgZWxzZSB7XG4gICAgZXZsaXN0ZW5lciA9IGV2ZW50c1t0eXBlXTtcbiAgICBpZiAoIWV2bGlzdGVuZXIpXG4gICAgICByZXQgPSBbXTtcbiAgICBlbHNlIGlmICh0eXBlb2YgZXZsaXN0ZW5lciA9PT0gJ2Z1bmN0aW9uJylcbiAgICAgIHJldCA9IFtldmxpc3RlbmVyLmxpc3RlbmVyIHx8IGV2bGlzdGVuZXJdO1xuICAgIGVsc2VcbiAgICAgIHJldCA9IHVud3JhcExpc3RlbmVycyhldmxpc3RlbmVyKTtcbiAgfVxuXG4gIHJldHVybiByZXQ7XG59O1xuXG5FdmVudEVtaXR0ZXIubGlzdGVuZXJDb3VudCA9IGZ1bmN0aW9uKGVtaXR0ZXIsIHR5cGUpIHtcbiAgaWYgKHR5cGVvZiBlbWl0dGVyLmxpc3RlbmVyQ291bnQgPT09ICdmdW5jdGlvbicpIHtcbiAgICByZXR1cm4gZW1pdHRlci5saXN0ZW5lckNvdW50KHR5cGUpO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBsaXN0ZW5lckNvdW50LmNhbGwoZW1pdHRlciwgdHlwZSk7XG4gIH1cbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUubGlzdGVuZXJDb3VudCA9IGxpc3RlbmVyQ291bnQ7XG5mdW5jdGlvbiBsaXN0ZW5lckNvdW50KHR5cGUpIHtcbiAgdmFyIGV2ZW50cyA9IHRoaXMuX2V2ZW50cztcblxuICBpZiAoZXZlbnRzKSB7XG4gICAgdmFyIGV2bGlzdGVuZXIgPSBldmVudHNbdHlwZV07XG5cbiAgICBpZiAodHlwZW9mIGV2bGlzdGVuZXIgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiAxO1xuICAgIH0gZWxzZSBpZiAoZXZsaXN0ZW5lcikge1xuICAgICAgcmV0dXJuIGV2bGlzdGVuZXIubGVuZ3RoO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiAwO1xufVxuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmV2ZW50TmFtZXMgPSBmdW5jdGlvbiBldmVudE5hbWVzKCkge1xuICByZXR1cm4gdGhpcy5fZXZlbnRzQ291bnQgPiAwID8gUmVmbGVjdC5vd25LZXlzKHRoaXMuX2V2ZW50cykgOiBbXTtcbn07XG5cbi8vIEFib3V0IDEuNXggZmFzdGVyIHRoYW4gdGhlIHR3by1hcmcgdmVyc2lvbiBvZiBBcnJheSNzcGxpY2UoKS5cbmZ1bmN0aW9uIHNwbGljZU9uZShsaXN0LCBpbmRleCkge1xuICBmb3IgKHZhciBpID0gaW5kZXgsIGsgPSBpICsgMSwgbiA9IGxpc3QubGVuZ3RoOyBrIDwgbjsgaSArPSAxLCBrICs9IDEpXG4gICAgbGlzdFtpXSA9IGxpc3Rba107XG4gIGxpc3QucG9wKCk7XG59XG5cbmZ1bmN0aW9uIGFycmF5Q2xvbmUoYXJyLCBuKSB7XG4gIHZhciBjb3B5ID0gbmV3IEFycmF5KG4pO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IG47ICsraSlcbiAgICBjb3B5W2ldID0gYXJyW2ldO1xuICByZXR1cm4gY29weTtcbn1cblxuZnVuY3Rpb24gdW53cmFwTGlzdGVuZXJzKGFycikge1xuICB2YXIgcmV0ID0gbmV3IEFycmF5KGFyci5sZW5ndGgpO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IHJldC5sZW5ndGg7ICsraSkge1xuICAgIHJldFtpXSA9IGFycltpXS5saXN0ZW5lciB8fCBhcnJbaV07XG4gIH1cbiAgcmV0dXJuIHJldDtcbn1cblxuZnVuY3Rpb24gb2JqZWN0Q3JlYXRlUG9seWZpbGwocHJvdG8pIHtcbiAgdmFyIEYgPSBmdW5jdGlvbigpIHt9O1xuICBGLnByb3RvdHlwZSA9IHByb3RvO1xuICByZXR1cm4gbmV3IEY7XG59XG5mdW5jdGlvbiBvYmplY3RLZXlzUG9seWZpbGwob2JqKSB7XG4gIHZhciBrZXlzID0gW107XG4gIGZvciAodmFyIGsgaW4gb2JqKSBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG9iaiwgaykpIHtcbiAgICBrZXlzLnB1c2goayk7XG4gIH1cbiAgcmV0dXJuIGs7XG59XG5mdW5jdGlvbiBmdW5jdGlvbkJpbmRQb2x5ZmlsbChjb250ZXh0KSB7XG4gIHZhciBmbiA9IHRoaXM7XG4gIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIGZuLmFwcGx5KGNvbnRleHQsIGFyZ3VtZW50cyk7XG4gIH07XG59XG4iLCJleHBvcnRzLmVuZGlhbm5lc3MgPSBmdW5jdGlvbiAoKSB7IHJldHVybiAnTEUnIH07XG5cbmV4cG9ydHMuaG9zdG5hbWUgPSBmdW5jdGlvbiAoKSB7XG4gICAgaWYgKHR5cGVvZiBsb2NhdGlvbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgcmV0dXJuIGxvY2F0aW9uLmhvc3RuYW1lXG4gICAgfVxuICAgIGVsc2UgcmV0dXJuICcnO1xufTtcblxuZXhwb3J0cy5sb2FkYXZnID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gW10gfTtcblxuZXhwb3J0cy51cHRpbWUgPSBmdW5jdGlvbiAoKSB7IHJldHVybiAwIH07XG5cbmV4cG9ydHMuZnJlZW1lbSA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gTnVtYmVyLk1BWF9WQUxVRTtcbn07XG5cbmV4cG9ydHMudG90YWxtZW0gPSBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIE51bWJlci5NQVhfVkFMVUU7XG59O1xuXG5leHBvcnRzLmNwdXMgPSBmdW5jdGlvbiAoKSB7IHJldHVybiBbXSB9O1xuXG5leHBvcnRzLnR5cGUgPSBmdW5jdGlvbiAoKSB7IHJldHVybiAnQnJvd3NlcicgfTtcblxuZXhwb3J0cy5yZWxlYXNlID0gZnVuY3Rpb24gKCkge1xuICAgIGlmICh0eXBlb2YgbmF2aWdhdG9yICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICByZXR1cm4gbmF2aWdhdG9yLmFwcFZlcnNpb247XG4gICAgfVxuICAgIHJldHVybiAnJztcbn07XG5cbmV4cG9ydHMubmV0d29ya0ludGVyZmFjZXNcbj0gZXhwb3J0cy5nZXROZXR3b3JrSW50ZXJmYWNlc1xuPSBmdW5jdGlvbiAoKSB7IHJldHVybiB7fSB9O1xuXG5leHBvcnRzLmFyY2ggPSBmdW5jdGlvbiAoKSB7IHJldHVybiAnamF2YXNjcmlwdCcgfTtcblxuZXhwb3J0cy5wbGF0Zm9ybSA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICdicm93c2VyJyB9O1xuXG5leHBvcnRzLnRtcGRpciA9IGV4cG9ydHMudG1wRGlyID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiAnL3RtcCc7XG59O1xuXG5leHBvcnRzLkVPTCA9ICdcXG4nO1xuXG5leHBvcnRzLmhvbWVkaXIgPSBmdW5jdGlvbiAoKSB7XG5cdHJldHVybiAnLydcbn07XG4iLCIvLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxuLy8gcmVzb2x2ZXMgLiBhbmQgLi4gZWxlbWVudHMgaW4gYSBwYXRoIGFycmF5IHdpdGggZGlyZWN0b3J5IG5hbWVzIHRoZXJlXG4vLyBtdXN0IGJlIG5vIHNsYXNoZXMsIGVtcHR5IGVsZW1lbnRzLCBvciBkZXZpY2UgbmFtZXMgKGM6XFwpIGluIHRoZSBhcnJheVxuLy8gKHNvIGFsc28gbm8gbGVhZGluZyBhbmQgdHJhaWxpbmcgc2xhc2hlcyAtIGl0IGRvZXMgbm90IGRpc3Rpbmd1aXNoXG4vLyByZWxhdGl2ZSBhbmQgYWJzb2x1dGUgcGF0aHMpXG5mdW5jdGlvbiBub3JtYWxpemVBcnJheShwYXJ0cywgYWxsb3dBYm92ZVJvb3QpIHtcbiAgLy8gaWYgdGhlIHBhdGggdHJpZXMgdG8gZ28gYWJvdmUgdGhlIHJvb3QsIGB1cGAgZW5kcyB1cCA+IDBcbiAgdmFyIHVwID0gMDtcbiAgZm9yICh2YXIgaSA9IHBhcnRzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgdmFyIGxhc3QgPSBwYXJ0c1tpXTtcbiAgICBpZiAobGFzdCA9PT0gJy4nKSB7XG4gICAgICBwYXJ0cy5zcGxpY2UoaSwgMSk7XG4gICAgfSBlbHNlIGlmIChsYXN0ID09PSAnLi4nKSB7XG4gICAgICBwYXJ0cy5zcGxpY2UoaSwgMSk7XG4gICAgICB1cCsrO1xuICAgIH0gZWxzZSBpZiAodXApIHtcbiAgICAgIHBhcnRzLnNwbGljZShpLCAxKTtcbiAgICAgIHVwLS07XG4gICAgfVxuICB9XG5cbiAgLy8gaWYgdGhlIHBhdGggaXMgYWxsb3dlZCB0byBnbyBhYm92ZSB0aGUgcm9vdCwgcmVzdG9yZSBsZWFkaW5nIC4uc1xuICBpZiAoYWxsb3dBYm92ZVJvb3QpIHtcbiAgICBmb3IgKDsgdXAtLTsgdXApIHtcbiAgICAgIHBhcnRzLnVuc2hpZnQoJy4uJyk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHBhcnRzO1xufVxuXG4vLyBTcGxpdCBhIGZpbGVuYW1lIGludG8gW3Jvb3QsIGRpciwgYmFzZW5hbWUsIGV4dF0sIHVuaXggdmVyc2lvblxuLy8gJ3Jvb3QnIGlzIGp1c3QgYSBzbGFzaCwgb3Igbm90aGluZy5cbnZhciBzcGxpdFBhdGhSZSA9XG4gICAgL14oXFwvP3wpKFtcXHNcXFNdKj8pKCg/OlxcLnsxLDJ9fFteXFwvXSs/fCkoXFwuW14uXFwvXSp8KSkoPzpbXFwvXSopJC87XG52YXIgc3BsaXRQYXRoID0gZnVuY3Rpb24oZmlsZW5hbWUpIHtcbiAgcmV0dXJuIHNwbGl0UGF0aFJlLmV4ZWMoZmlsZW5hbWUpLnNsaWNlKDEpO1xufTtcblxuLy8gcGF0aC5yZXNvbHZlKFtmcm9tIC4uLl0sIHRvKVxuLy8gcG9zaXggdmVyc2lvblxuZXhwb3J0cy5yZXNvbHZlID0gZnVuY3Rpb24oKSB7XG4gIHZhciByZXNvbHZlZFBhdGggPSAnJyxcbiAgICAgIHJlc29sdmVkQWJzb2x1dGUgPSBmYWxzZTtcblxuICBmb3IgKHZhciBpID0gYXJndW1lbnRzLmxlbmd0aCAtIDE7IGkgPj0gLTEgJiYgIXJlc29sdmVkQWJzb2x1dGU7IGktLSkge1xuICAgIHZhciBwYXRoID0gKGkgPj0gMCkgPyBhcmd1bWVudHNbaV0gOiBwcm9jZXNzLmN3ZCgpO1xuXG4gICAgLy8gU2tpcCBlbXB0eSBhbmQgaW52YWxpZCBlbnRyaWVzXG4gICAgaWYgKHR5cGVvZiBwYXRoICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignQXJndW1lbnRzIHRvIHBhdGgucmVzb2x2ZSBtdXN0IGJlIHN0cmluZ3MnKTtcbiAgICB9IGVsc2UgaWYgKCFwYXRoKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICByZXNvbHZlZFBhdGggPSBwYXRoICsgJy8nICsgcmVzb2x2ZWRQYXRoO1xuICAgIHJlc29sdmVkQWJzb2x1dGUgPSBwYXRoLmNoYXJBdCgwKSA9PT0gJy8nO1xuICB9XG5cbiAgLy8gQXQgdGhpcyBwb2ludCB0aGUgcGF0aCBzaG91bGQgYmUgcmVzb2x2ZWQgdG8gYSBmdWxsIGFic29sdXRlIHBhdGgsIGJ1dFxuICAvLyBoYW5kbGUgcmVsYXRpdmUgcGF0aHMgdG8gYmUgc2FmZSAobWlnaHQgaGFwcGVuIHdoZW4gcHJvY2Vzcy5jd2QoKSBmYWlscylcblxuICAvLyBOb3JtYWxpemUgdGhlIHBhdGhcbiAgcmVzb2x2ZWRQYXRoID0gbm9ybWFsaXplQXJyYXkoZmlsdGVyKHJlc29sdmVkUGF0aC5zcGxpdCgnLycpLCBmdW5jdGlvbihwKSB7XG4gICAgcmV0dXJuICEhcDtcbiAgfSksICFyZXNvbHZlZEFic29sdXRlKS5qb2luKCcvJyk7XG5cbiAgcmV0dXJuICgocmVzb2x2ZWRBYnNvbHV0ZSA/ICcvJyA6ICcnKSArIHJlc29sdmVkUGF0aCkgfHwgJy4nO1xufTtcblxuLy8gcGF0aC5ub3JtYWxpemUocGF0aClcbi8vIHBvc2l4IHZlcnNpb25cbmV4cG9ydHMubm9ybWFsaXplID0gZnVuY3Rpb24ocGF0aCkge1xuICB2YXIgaXNBYnNvbHV0ZSA9IGV4cG9ydHMuaXNBYnNvbHV0ZShwYXRoKSxcbiAgICAgIHRyYWlsaW5nU2xhc2ggPSBzdWJzdHIocGF0aCwgLTEpID09PSAnLyc7XG5cbiAgLy8gTm9ybWFsaXplIHRoZSBwYXRoXG4gIHBhdGggPSBub3JtYWxpemVBcnJheShmaWx0ZXIocGF0aC5zcGxpdCgnLycpLCBmdW5jdGlvbihwKSB7XG4gICAgcmV0dXJuICEhcDtcbiAgfSksICFpc0Fic29sdXRlKS5qb2luKCcvJyk7XG5cbiAgaWYgKCFwYXRoICYmICFpc0Fic29sdXRlKSB7XG4gICAgcGF0aCA9ICcuJztcbiAgfVxuICBpZiAocGF0aCAmJiB0cmFpbGluZ1NsYXNoKSB7XG4gICAgcGF0aCArPSAnLyc7XG4gIH1cblxuICByZXR1cm4gKGlzQWJzb2x1dGUgPyAnLycgOiAnJykgKyBwYXRoO1xufTtcblxuLy8gcG9zaXggdmVyc2lvblxuZXhwb3J0cy5pc0Fic29sdXRlID0gZnVuY3Rpb24ocGF0aCkge1xuICByZXR1cm4gcGF0aC5jaGFyQXQoMCkgPT09ICcvJztcbn07XG5cbi8vIHBvc2l4IHZlcnNpb25cbmV4cG9ydHMuam9pbiA9IGZ1bmN0aW9uKCkge1xuICB2YXIgcGF0aHMgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDApO1xuICByZXR1cm4gZXhwb3J0cy5ub3JtYWxpemUoZmlsdGVyKHBhdGhzLCBmdW5jdGlvbihwLCBpbmRleCkge1xuICAgIGlmICh0eXBlb2YgcCAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0FyZ3VtZW50cyB0byBwYXRoLmpvaW4gbXVzdCBiZSBzdHJpbmdzJyk7XG4gICAgfVxuICAgIHJldHVybiBwO1xuICB9KS5qb2luKCcvJykpO1xufTtcblxuXG4vLyBwYXRoLnJlbGF0aXZlKGZyb20sIHRvKVxuLy8gcG9zaXggdmVyc2lvblxuZXhwb3J0cy5yZWxhdGl2ZSA9IGZ1bmN0aW9uKGZyb20sIHRvKSB7XG4gIGZyb20gPSBleHBvcnRzLnJlc29sdmUoZnJvbSkuc3Vic3RyKDEpO1xuICB0byA9IGV4cG9ydHMucmVzb2x2ZSh0bykuc3Vic3RyKDEpO1xuXG4gIGZ1bmN0aW9uIHRyaW0oYXJyKSB7XG4gICAgdmFyIHN0YXJ0ID0gMDtcbiAgICBmb3IgKDsgc3RhcnQgPCBhcnIubGVuZ3RoOyBzdGFydCsrKSB7XG4gICAgICBpZiAoYXJyW3N0YXJ0XSAhPT0gJycpIGJyZWFrO1xuICAgIH1cblxuICAgIHZhciBlbmQgPSBhcnIubGVuZ3RoIC0gMTtcbiAgICBmb3IgKDsgZW5kID49IDA7IGVuZC0tKSB7XG4gICAgICBpZiAoYXJyW2VuZF0gIT09ICcnKSBicmVhaztcbiAgICB9XG5cbiAgICBpZiAoc3RhcnQgPiBlbmQpIHJldHVybiBbXTtcbiAgICByZXR1cm4gYXJyLnNsaWNlKHN0YXJ0LCBlbmQgLSBzdGFydCArIDEpO1xuICB9XG5cbiAgdmFyIGZyb21QYXJ0cyA9IHRyaW0oZnJvbS5zcGxpdCgnLycpKTtcbiAgdmFyIHRvUGFydHMgPSB0cmltKHRvLnNwbGl0KCcvJykpO1xuXG4gIHZhciBsZW5ndGggPSBNYXRoLm1pbihmcm9tUGFydHMubGVuZ3RoLCB0b1BhcnRzLmxlbmd0aCk7XG4gIHZhciBzYW1lUGFydHNMZW5ndGggPSBsZW5ndGg7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuZ3RoOyBpKyspIHtcbiAgICBpZiAoZnJvbVBhcnRzW2ldICE9PSB0b1BhcnRzW2ldKSB7XG4gICAgICBzYW1lUGFydHNMZW5ndGggPSBpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgdmFyIG91dHB1dFBhcnRzID0gW107XG4gIGZvciAodmFyIGkgPSBzYW1lUGFydHNMZW5ndGg7IGkgPCBmcm9tUGFydHMubGVuZ3RoOyBpKyspIHtcbiAgICBvdXRwdXRQYXJ0cy5wdXNoKCcuLicpO1xuICB9XG5cbiAgb3V0cHV0UGFydHMgPSBvdXRwdXRQYXJ0cy5jb25jYXQodG9QYXJ0cy5zbGljZShzYW1lUGFydHNMZW5ndGgpKTtcblxuICByZXR1cm4gb3V0cHV0UGFydHMuam9pbignLycpO1xufTtcblxuZXhwb3J0cy5zZXAgPSAnLyc7XG5leHBvcnRzLmRlbGltaXRlciA9ICc6JztcblxuZXhwb3J0cy5kaXJuYW1lID0gZnVuY3Rpb24ocGF0aCkge1xuICB2YXIgcmVzdWx0ID0gc3BsaXRQYXRoKHBhdGgpLFxuICAgICAgcm9vdCA9IHJlc3VsdFswXSxcbiAgICAgIGRpciA9IHJlc3VsdFsxXTtcblxuICBpZiAoIXJvb3QgJiYgIWRpcikge1xuICAgIC8vIE5vIGRpcm5hbWUgd2hhdHNvZXZlclxuICAgIHJldHVybiAnLic7XG4gIH1cblxuICBpZiAoZGlyKSB7XG4gICAgLy8gSXQgaGFzIGEgZGlybmFtZSwgc3RyaXAgdHJhaWxpbmcgc2xhc2hcbiAgICBkaXIgPSBkaXIuc3Vic3RyKDAsIGRpci5sZW5ndGggLSAxKTtcbiAgfVxuXG4gIHJldHVybiByb290ICsgZGlyO1xufTtcblxuXG5leHBvcnRzLmJhc2VuYW1lID0gZnVuY3Rpb24ocGF0aCwgZXh0KSB7XG4gIHZhciBmID0gc3BsaXRQYXRoKHBhdGgpWzJdO1xuICAvLyBUT0RPOiBtYWtlIHRoaXMgY29tcGFyaXNvbiBjYXNlLWluc2Vuc2l0aXZlIG9uIHdpbmRvd3M/XG4gIGlmIChleHQgJiYgZi5zdWJzdHIoLTEgKiBleHQubGVuZ3RoKSA9PT0gZXh0KSB7XG4gICAgZiA9IGYuc3Vic3RyKDAsIGYubGVuZ3RoIC0gZXh0Lmxlbmd0aCk7XG4gIH1cbiAgcmV0dXJuIGY7XG59O1xuXG5cbmV4cG9ydHMuZXh0bmFtZSA9IGZ1bmN0aW9uKHBhdGgpIHtcbiAgcmV0dXJuIHNwbGl0UGF0aChwYXRoKVszXTtcbn07XG5cbmZ1bmN0aW9uIGZpbHRlciAoeHMsIGYpIHtcbiAgICBpZiAoeHMuZmlsdGVyKSByZXR1cm4geHMuZmlsdGVyKGYpO1xuICAgIHZhciByZXMgPSBbXTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHhzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGlmIChmKHhzW2ldLCBpLCB4cykpIHJlcy5wdXNoKHhzW2ldKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlcztcbn1cblxuLy8gU3RyaW5nLnByb3RvdHlwZS5zdWJzdHIgLSBuZWdhdGl2ZSBpbmRleCBkb24ndCB3b3JrIGluIElFOFxudmFyIHN1YnN0ciA9ICdhYicuc3Vic3RyKC0xKSA9PT0gJ2InXG4gICAgPyBmdW5jdGlvbiAoc3RyLCBzdGFydCwgbGVuKSB7IHJldHVybiBzdHIuc3Vic3RyKHN0YXJ0LCBsZW4pIH1cbiAgICA6IGZ1bmN0aW9uIChzdHIsIHN0YXJ0LCBsZW4pIHtcbiAgICAgICAgaWYgKHN0YXJ0IDwgMCkgc3RhcnQgPSBzdHIubGVuZ3RoICsgc3RhcnQ7XG4gICAgICAgIHJldHVybiBzdHIuc3Vic3RyKHN0YXJ0LCBsZW4pO1xuICAgIH1cbjtcbiIsIi8vIHNoaW0gZm9yIHVzaW5nIHByb2Nlc3MgaW4gYnJvd3NlclxudmFyIHByb2Nlc3MgPSBtb2R1bGUuZXhwb3J0cyA9IHt9O1xuXG4vLyBjYWNoZWQgZnJvbSB3aGF0ZXZlciBnbG9iYWwgaXMgcHJlc2VudCBzbyB0aGF0IHRlc3QgcnVubmVycyB0aGF0IHN0dWIgaXRcbi8vIGRvbid0IGJyZWFrIHRoaW5ncy4gIEJ1dCB3ZSBuZWVkIHRvIHdyYXAgaXQgaW4gYSB0cnkgY2F0Y2ggaW4gY2FzZSBpdCBpc1xuLy8gd3JhcHBlZCBpbiBzdHJpY3QgbW9kZSBjb2RlIHdoaWNoIGRvZXNuJ3QgZGVmaW5lIGFueSBnbG9iYWxzLiAgSXQncyBpbnNpZGUgYVxuLy8gZnVuY3Rpb24gYmVjYXVzZSB0cnkvY2F0Y2hlcyBkZW9wdGltaXplIGluIGNlcnRhaW4gZW5naW5lcy5cblxudmFyIGNhY2hlZFNldFRpbWVvdXQ7XG52YXIgY2FjaGVkQ2xlYXJUaW1lb3V0O1xuXG5mdW5jdGlvbiBkZWZhdWx0U2V0VGltb3V0KCkge1xuICAgIHRocm93IG5ldyBFcnJvcignc2V0VGltZW91dCBoYXMgbm90IGJlZW4gZGVmaW5lZCcpO1xufVxuZnVuY3Rpb24gZGVmYXVsdENsZWFyVGltZW91dCAoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdjbGVhclRpbWVvdXQgaGFzIG5vdCBiZWVuIGRlZmluZWQnKTtcbn1cbihmdW5jdGlvbiAoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKHR5cGVvZiBzZXRUaW1lb3V0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gc2V0VGltZW91dDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNhY2hlZFNldFRpbWVvdXQgPSBkZWZhdWx0U2V0VGltb3V0O1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gZGVmYXVsdFNldFRpbW91dDtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKHR5cGVvZiBjbGVhclRpbWVvdXQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGNsZWFyVGltZW91dDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGRlZmF1bHRDbGVhclRpbWVvdXQ7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGRlZmF1bHRDbGVhclRpbWVvdXQ7XG4gICAgfVxufSAoKSlcbmZ1bmN0aW9uIHJ1blRpbWVvdXQoZnVuKSB7XG4gICAgaWYgKGNhY2hlZFNldFRpbWVvdXQgPT09IHNldFRpbWVvdXQpIHtcbiAgICAgICAgLy9ub3JtYWwgZW52aXJvbWVudHMgaW4gc2FuZSBzaXR1YXRpb25zXG4gICAgICAgIHJldHVybiBzZXRUaW1lb3V0KGZ1biwgMCk7XG4gICAgfVxuICAgIC8vIGlmIHNldFRpbWVvdXQgd2Fzbid0IGF2YWlsYWJsZSBidXQgd2FzIGxhdHRlciBkZWZpbmVkXG4gICAgaWYgKChjYWNoZWRTZXRUaW1lb3V0ID09PSBkZWZhdWx0U2V0VGltb3V0IHx8ICFjYWNoZWRTZXRUaW1lb3V0KSAmJiBzZXRUaW1lb3V0KSB7XG4gICAgICAgIGNhY2hlZFNldFRpbWVvdXQgPSBzZXRUaW1lb3V0O1xuICAgICAgICByZXR1cm4gc2V0VGltZW91dChmdW4sIDApO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICAvLyB3aGVuIHdoZW4gc29tZWJvZHkgaGFzIHNjcmV3ZWQgd2l0aCBzZXRUaW1lb3V0IGJ1dCBubyBJLkUuIG1hZGRuZXNzXG4gICAgICAgIHJldHVybiBjYWNoZWRTZXRUaW1lb3V0KGZ1biwgMCk7XG4gICAgfSBjYXRjaChlKXtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIFdoZW4gd2UgYXJlIGluIEkuRS4gYnV0IHRoZSBzY3JpcHQgaGFzIGJlZW4gZXZhbGVkIHNvIEkuRS4gZG9lc24ndCB0cnVzdCB0aGUgZ2xvYmFsIG9iamVjdCB3aGVuIGNhbGxlZCBub3JtYWxseVxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZFNldFRpbWVvdXQuY2FsbChudWxsLCBmdW4sIDApO1xuICAgICAgICB9IGNhdGNoKGUpe1xuICAgICAgICAgICAgLy8gc2FtZSBhcyBhYm92ZSBidXQgd2hlbiBpdCdzIGEgdmVyc2lvbiBvZiBJLkUuIHRoYXQgbXVzdCBoYXZlIHRoZSBnbG9iYWwgb2JqZWN0IGZvciAndGhpcycsIGhvcGZ1bGx5IG91ciBjb250ZXh0IGNvcnJlY3Qgb3RoZXJ3aXNlIGl0IHdpbGwgdGhyb3cgYSBnbG9iYWwgZXJyb3JcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWRTZXRUaW1lb3V0LmNhbGwodGhpcywgZnVuLCAwKTtcbiAgICAgICAgfVxuICAgIH1cblxuXG59XG5mdW5jdGlvbiBydW5DbGVhclRpbWVvdXQobWFya2VyKSB7XG4gICAgaWYgKGNhY2hlZENsZWFyVGltZW91dCA9PT0gY2xlYXJUaW1lb3V0KSB7XG4gICAgICAgIC8vbm9ybWFsIGVudmlyb21lbnRzIGluIHNhbmUgc2l0dWF0aW9uc1xuICAgICAgICByZXR1cm4gY2xlYXJUaW1lb3V0KG1hcmtlcik7XG4gICAgfVxuICAgIC8vIGlmIGNsZWFyVGltZW91dCB3YXNuJ3QgYXZhaWxhYmxlIGJ1dCB3YXMgbGF0dGVyIGRlZmluZWRcbiAgICBpZiAoKGNhY2hlZENsZWFyVGltZW91dCA9PT0gZGVmYXVsdENsZWFyVGltZW91dCB8fCAhY2FjaGVkQ2xlYXJUaW1lb3V0KSAmJiBjbGVhclRpbWVvdXQpIHtcbiAgICAgICAgY2FjaGVkQ2xlYXJUaW1lb3V0ID0gY2xlYXJUaW1lb3V0O1xuICAgICAgICByZXR1cm4gY2xlYXJUaW1lb3V0KG1hcmtlcik7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIC8vIHdoZW4gd2hlbiBzb21lYm9keSBoYXMgc2NyZXdlZCB3aXRoIHNldFRpbWVvdXQgYnV0IG5vIEkuRS4gbWFkZG5lc3NcbiAgICAgICAgcmV0dXJuIGNhY2hlZENsZWFyVGltZW91dChtYXJrZXIpO1xuICAgIH0gY2F0Y2ggKGUpe1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8gV2hlbiB3ZSBhcmUgaW4gSS5FLiBidXQgdGhlIHNjcmlwdCBoYXMgYmVlbiBldmFsZWQgc28gSS5FLiBkb2Vzbid0ICB0cnVzdCB0aGUgZ2xvYmFsIG9iamVjdCB3aGVuIGNhbGxlZCBub3JtYWxseVxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZENsZWFyVGltZW91dC5jYWxsKG51bGwsIG1hcmtlcik7XG4gICAgICAgIH0gY2F0Y2ggKGUpe1xuICAgICAgICAgICAgLy8gc2FtZSBhcyBhYm92ZSBidXQgd2hlbiBpdCdzIGEgdmVyc2lvbiBvZiBJLkUuIHRoYXQgbXVzdCBoYXZlIHRoZSBnbG9iYWwgb2JqZWN0IGZvciAndGhpcycsIGhvcGZ1bGx5IG91ciBjb250ZXh0IGNvcnJlY3Qgb3RoZXJ3aXNlIGl0IHdpbGwgdGhyb3cgYSBnbG9iYWwgZXJyb3IuXG4gICAgICAgICAgICAvLyBTb21lIHZlcnNpb25zIG9mIEkuRS4gaGF2ZSBkaWZmZXJlbnQgcnVsZXMgZm9yIGNsZWFyVGltZW91dCB2cyBzZXRUaW1lb3V0XG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkQ2xlYXJUaW1lb3V0LmNhbGwodGhpcywgbWFya2VyKTtcbiAgICAgICAgfVxuICAgIH1cblxuXG5cbn1cbnZhciBxdWV1ZSA9IFtdO1xudmFyIGRyYWluaW5nID0gZmFsc2U7XG52YXIgY3VycmVudFF1ZXVlO1xudmFyIHF1ZXVlSW5kZXggPSAtMTtcblxuZnVuY3Rpb24gY2xlYW5VcE5leHRUaWNrKCkge1xuICAgIGlmICghZHJhaW5pbmcgfHwgIWN1cnJlbnRRdWV1ZSkge1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGRyYWluaW5nID0gZmFsc2U7XG4gICAgaWYgKGN1cnJlbnRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgcXVldWUgPSBjdXJyZW50UXVldWUuY29uY2F0KHF1ZXVlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgfVxuICAgIGlmIChxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgZHJhaW5RdWV1ZSgpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gZHJhaW5RdWV1ZSgpIHtcbiAgICBpZiAoZHJhaW5pbmcpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgdGltZW91dCA9IHJ1blRpbWVvdXQoY2xlYW5VcE5leHRUaWNrKTtcbiAgICBkcmFpbmluZyA9IHRydWU7XG5cbiAgICB2YXIgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIHdoaWxlKGxlbikge1xuICAgICAgICBjdXJyZW50UXVldWUgPSBxdWV1ZTtcbiAgICAgICAgcXVldWUgPSBbXTtcbiAgICAgICAgd2hpbGUgKCsrcXVldWVJbmRleCA8IGxlbikge1xuICAgICAgICAgICAgaWYgKGN1cnJlbnRRdWV1ZSkge1xuICAgICAgICAgICAgICAgIGN1cnJlbnRRdWV1ZVtxdWV1ZUluZGV4XS5ydW4oKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgICAgIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB9XG4gICAgY3VycmVudFF1ZXVlID0gbnVsbDtcbiAgICBkcmFpbmluZyA9IGZhbHNlO1xuICAgIHJ1bkNsZWFyVGltZW91dCh0aW1lb3V0KTtcbn1cblxucHJvY2Vzcy5uZXh0VGljayA9IGZ1bmN0aW9uIChmdW4pIHtcbiAgICB2YXIgYXJncyA9IG5ldyBBcnJheShhcmd1bWVudHMubGVuZ3RoIC0gMSk7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAxKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAxOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBhcmdzW2kgLSAxXSA9IGFyZ3VtZW50c1tpXTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBxdWV1ZS5wdXNoKG5ldyBJdGVtKGZ1biwgYXJncykpO1xuICAgIGlmIChxdWV1ZS5sZW5ndGggPT09IDEgJiYgIWRyYWluaW5nKSB7XG4gICAgICAgIHJ1blRpbWVvdXQoZHJhaW5RdWV1ZSk7XG4gICAgfVxufTtcblxuLy8gdjggbGlrZXMgcHJlZGljdGlibGUgb2JqZWN0c1xuZnVuY3Rpb24gSXRlbShmdW4sIGFycmF5KSB7XG4gICAgdGhpcy5mdW4gPSBmdW47XG4gICAgdGhpcy5hcnJheSA9IGFycmF5O1xufVxuSXRlbS5wcm90b3R5cGUucnVuID0gZnVuY3Rpb24gKCkge1xuICAgIHRoaXMuZnVuLmFwcGx5KG51bGwsIHRoaXMuYXJyYXkpO1xufTtcbnByb2Nlc3MudGl0bGUgPSAnYnJvd3Nlcic7XG5wcm9jZXNzLmJyb3dzZXIgPSB0cnVlO1xucHJvY2Vzcy5lbnYgPSB7fTtcbnByb2Nlc3MuYXJndiA9IFtdO1xucHJvY2Vzcy52ZXJzaW9uID0gJyc7IC8vIGVtcHR5IHN0cmluZyB0byBhdm9pZCByZWdleHAgaXNzdWVzXG5wcm9jZXNzLnZlcnNpb25zID0ge307XG5cbmZ1bmN0aW9uIG5vb3AoKSB7fVxuXG5wcm9jZXNzLm9uID0gbm9vcDtcbnByb2Nlc3MuYWRkTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5vbmNlID0gbm9vcDtcbnByb2Nlc3Mub2ZmID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVBbGxMaXN0ZW5lcnMgPSBub29wO1xucHJvY2Vzcy5lbWl0ID0gbm9vcDtcbnByb2Nlc3MucHJlcGVuZExpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3MucHJlcGVuZE9uY2VMaXN0ZW5lciA9IG5vb3A7XG5cbnByb2Nlc3MubGlzdGVuZXJzID0gZnVuY3Rpb24gKG5hbWUpIHsgcmV0dXJuIFtdIH1cblxucHJvY2Vzcy5iaW5kaW5nID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuYmluZGluZyBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xuXG5wcm9jZXNzLmN3ZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICcvJyB9O1xucHJvY2Vzcy5jaGRpciA9IGZ1bmN0aW9uIChkaXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuY2hkaXIgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcbnByb2Nlc3MudW1hc2sgPSBmdW5jdGlvbigpIHsgcmV0dXJuIDA7IH07XG4iLCJpZiAodHlwZW9mIE9iamVjdC5jcmVhdGUgPT09ICdmdW5jdGlvbicpIHtcbiAgLy8gaW1wbGVtZW50YXRpb24gZnJvbSBzdGFuZGFyZCBub2RlLmpzICd1dGlsJyBtb2R1bGVcbiAgbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBpbmhlcml0cyhjdG9yLCBzdXBlckN0b3IpIHtcbiAgICBjdG9yLnN1cGVyXyA9IHN1cGVyQ3RvclxuICAgIGN0b3IucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShzdXBlckN0b3IucHJvdG90eXBlLCB7XG4gICAgICBjb25zdHJ1Y3Rvcjoge1xuICAgICAgICB2YWx1ZTogY3RvcixcbiAgICAgICAgZW51bWVyYWJsZTogZmFsc2UsXG4gICAgICAgIHdyaXRhYmxlOiB0cnVlLFxuICAgICAgICBjb25maWd1cmFibGU6IHRydWVcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcbn0gZWxzZSB7XG4gIC8vIG9sZCBzY2hvb2wgc2hpbSBmb3Igb2xkIGJyb3dzZXJzXG4gIG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gaW5oZXJpdHMoY3Rvciwgc3VwZXJDdG9yKSB7XG4gICAgY3Rvci5zdXBlcl8gPSBzdXBlckN0b3JcbiAgICB2YXIgVGVtcEN0b3IgPSBmdW5jdGlvbiAoKSB7fVxuICAgIFRlbXBDdG9yLnByb3RvdHlwZSA9IHN1cGVyQ3Rvci5wcm90b3R5cGVcbiAgICBjdG9yLnByb3RvdHlwZSA9IG5ldyBUZW1wQ3RvcigpXG4gICAgY3Rvci5wcm90b3R5cGUuY29uc3RydWN0b3IgPSBjdG9yXG4gIH1cbn1cbiIsIm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gaXNCdWZmZXIoYXJnKSB7XG4gIHJldHVybiBhcmcgJiYgdHlwZW9mIGFyZyA9PT0gJ29iamVjdCdcbiAgICAmJiB0eXBlb2YgYXJnLmNvcHkgPT09ICdmdW5jdGlvbidcbiAgICAmJiB0eXBlb2YgYXJnLmZpbGwgPT09ICdmdW5jdGlvbidcbiAgICAmJiB0eXBlb2YgYXJnLnJlYWRVSW50OCA9PT0gJ2Z1bmN0aW9uJztcbn0iLCIvLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxudmFyIGZvcm1hdFJlZ0V4cCA9IC8lW3NkaiVdL2c7XG5leHBvcnRzLmZvcm1hdCA9IGZ1bmN0aW9uKGYpIHtcbiAgaWYgKCFpc1N0cmluZyhmKSkge1xuICAgIHZhciBvYmplY3RzID0gW107XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBhcmd1bWVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIG9iamVjdHMucHVzaChpbnNwZWN0KGFyZ3VtZW50c1tpXSkpO1xuICAgIH1cbiAgICByZXR1cm4gb2JqZWN0cy5qb2luKCcgJyk7XG4gIH1cblxuICB2YXIgaSA9IDE7XG4gIHZhciBhcmdzID0gYXJndW1lbnRzO1xuICB2YXIgbGVuID0gYXJncy5sZW5ndGg7XG4gIHZhciBzdHIgPSBTdHJpbmcoZikucmVwbGFjZShmb3JtYXRSZWdFeHAsIGZ1bmN0aW9uKHgpIHtcbiAgICBpZiAoeCA9PT0gJyUlJykgcmV0dXJuICclJztcbiAgICBpZiAoaSA+PSBsZW4pIHJldHVybiB4O1xuICAgIHN3aXRjaCAoeCkge1xuICAgICAgY2FzZSAnJXMnOiByZXR1cm4gU3RyaW5nKGFyZ3NbaSsrXSk7XG4gICAgICBjYXNlICclZCc6IHJldHVybiBOdW1iZXIoYXJnc1tpKytdKTtcbiAgICAgIGNhc2UgJyVqJzpcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoYXJnc1tpKytdKTtcbiAgICAgICAgfSBjYXRjaCAoXykge1xuICAgICAgICAgIHJldHVybiAnW0NpcmN1bGFyXSc7XG4gICAgICAgIH1cbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHJldHVybiB4O1xuICAgIH1cbiAgfSk7XG4gIGZvciAodmFyIHggPSBhcmdzW2ldOyBpIDwgbGVuOyB4ID0gYXJnc1srK2ldKSB7XG4gICAgaWYgKGlzTnVsbCh4KSB8fCAhaXNPYmplY3QoeCkpIHtcbiAgICAgIHN0ciArPSAnICcgKyB4O1xuICAgIH0gZWxzZSB7XG4gICAgICBzdHIgKz0gJyAnICsgaW5zcGVjdCh4KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHN0cjtcbn07XG5cblxuLy8gTWFyayB0aGF0IGEgbWV0aG9kIHNob3VsZCBub3QgYmUgdXNlZC5cbi8vIFJldHVybnMgYSBtb2RpZmllZCBmdW5jdGlvbiB3aGljaCB3YXJucyBvbmNlIGJ5IGRlZmF1bHQuXG4vLyBJZiAtLW5vLWRlcHJlY2F0aW9uIGlzIHNldCwgdGhlbiBpdCBpcyBhIG5vLW9wLlxuZXhwb3J0cy5kZXByZWNhdGUgPSBmdW5jdGlvbihmbiwgbXNnKSB7XG4gIC8vIEFsbG93IGZvciBkZXByZWNhdGluZyB0aGluZ3MgaW4gdGhlIHByb2Nlc3Mgb2Ygc3RhcnRpbmcgdXAuXG4gIGlmIChpc1VuZGVmaW5lZChnbG9iYWwucHJvY2VzcykpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICByZXR1cm4gZXhwb3J0cy5kZXByZWNhdGUoZm4sIG1zZykuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICB9O1xuICB9XG5cbiAgaWYgKHByb2Nlc3Mubm9EZXByZWNhdGlvbiA9PT0gdHJ1ZSkge1xuICAgIHJldHVybiBmbjtcbiAgfVxuXG4gIHZhciB3YXJuZWQgPSBmYWxzZTtcbiAgZnVuY3Rpb24gZGVwcmVjYXRlZCgpIHtcbiAgICBpZiAoIXdhcm5lZCkge1xuICAgICAgaWYgKHByb2Nlc3MudGhyb3dEZXByZWNhdGlvbikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IobXNnKTtcbiAgICAgIH0gZWxzZSBpZiAocHJvY2Vzcy50cmFjZURlcHJlY2F0aW9uKSB7XG4gICAgICAgIGNvbnNvbGUudHJhY2UobXNnKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IobXNnKTtcbiAgICAgIH1cbiAgICAgIHdhcm5lZCA9IHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICB9XG5cbiAgcmV0dXJuIGRlcHJlY2F0ZWQ7XG59O1xuXG5cbnZhciBkZWJ1Z3MgPSB7fTtcbnZhciBkZWJ1Z0Vudmlyb247XG5leHBvcnRzLmRlYnVnbG9nID0gZnVuY3Rpb24oc2V0KSB7XG4gIGlmIChpc1VuZGVmaW5lZChkZWJ1Z0Vudmlyb24pKVxuICAgIGRlYnVnRW52aXJvbiA9IHByb2Nlc3MuZW52Lk5PREVfREVCVUcgfHwgJyc7XG4gIHNldCA9IHNldC50b1VwcGVyQ2FzZSgpO1xuICBpZiAoIWRlYnVnc1tzZXRdKSB7XG4gICAgaWYgKG5ldyBSZWdFeHAoJ1xcXFxiJyArIHNldCArICdcXFxcYicsICdpJykudGVzdChkZWJ1Z0Vudmlyb24pKSB7XG4gICAgICB2YXIgcGlkID0gcHJvY2Vzcy5waWQ7XG4gICAgICBkZWJ1Z3Nbc2V0XSA9IGZ1bmN0aW9uKCkge1xuICAgICAgICB2YXIgbXNnID0gZXhwb3J0cy5mb3JtYXQuYXBwbHkoZXhwb3J0cywgYXJndW1lbnRzKTtcbiAgICAgICAgY29uc29sZS5lcnJvcignJXMgJWQ6ICVzJywgc2V0LCBwaWQsIG1zZyk7XG4gICAgICB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBkZWJ1Z3Nbc2V0XSA9IGZ1bmN0aW9uKCkge307XG4gICAgfVxuICB9XG4gIHJldHVybiBkZWJ1Z3Nbc2V0XTtcbn07XG5cblxuLyoqXG4gKiBFY2hvcyB0aGUgdmFsdWUgb2YgYSB2YWx1ZS4gVHJ5cyB0byBwcmludCB0aGUgdmFsdWUgb3V0XG4gKiBpbiB0aGUgYmVzdCB3YXkgcG9zc2libGUgZ2l2ZW4gdGhlIGRpZmZlcmVudCB0eXBlcy5cbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gb2JqIFRoZSBvYmplY3QgdG8gcHJpbnQgb3V0LlxuICogQHBhcmFtIHtPYmplY3R9IG9wdHMgT3B0aW9uYWwgb3B0aW9ucyBvYmplY3QgdGhhdCBhbHRlcnMgdGhlIG91dHB1dC5cbiAqL1xuLyogbGVnYWN5OiBvYmosIHNob3dIaWRkZW4sIGRlcHRoLCBjb2xvcnMqL1xuZnVuY3Rpb24gaW5zcGVjdChvYmosIG9wdHMpIHtcbiAgLy8gZGVmYXVsdCBvcHRpb25zXG4gIHZhciBjdHggPSB7XG4gICAgc2VlbjogW10sXG4gICAgc3R5bGl6ZTogc3R5bGl6ZU5vQ29sb3JcbiAgfTtcbiAgLy8gbGVnYWN5Li4uXG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID49IDMpIGN0eC5kZXB0aCA9IGFyZ3VtZW50c1syXTtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPj0gNCkgY3R4LmNvbG9ycyA9IGFyZ3VtZW50c1szXTtcbiAgaWYgKGlzQm9vbGVhbihvcHRzKSkge1xuICAgIC8vIGxlZ2FjeS4uLlxuICAgIGN0eC5zaG93SGlkZGVuID0gb3B0cztcbiAgfSBlbHNlIGlmIChvcHRzKSB7XG4gICAgLy8gZ290IGFuIFwib3B0aW9uc1wiIG9iamVjdFxuICAgIGV4cG9ydHMuX2V4dGVuZChjdHgsIG9wdHMpO1xuICB9XG4gIC8vIHNldCBkZWZhdWx0IG9wdGlvbnNcbiAgaWYgKGlzVW5kZWZpbmVkKGN0eC5zaG93SGlkZGVuKSkgY3R4LnNob3dIaWRkZW4gPSBmYWxzZTtcbiAgaWYgKGlzVW5kZWZpbmVkKGN0eC5kZXB0aCkpIGN0eC5kZXB0aCA9IDI7XG4gIGlmIChpc1VuZGVmaW5lZChjdHguY29sb3JzKSkgY3R4LmNvbG9ycyA9IGZhbHNlO1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LmN1c3RvbUluc3BlY3QpKSBjdHguY3VzdG9tSW5zcGVjdCA9IHRydWU7XG4gIGlmIChjdHguY29sb3JzKSBjdHguc3R5bGl6ZSA9IHN0eWxpemVXaXRoQ29sb3I7XG4gIHJldHVybiBmb3JtYXRWYWx1ZShjdHgsIG9iaiwgY3R4LmRlcHRoKTtcbn1cbmV4cG9ydHMuaW5zcGVjdCA9IGluc3BlY3Q7XG5cblxuLy8gaHR0cDovL2VuLndpa2lwZWRpYS5vcmcvd2lraS9BTlNJX2VzY2FwZV9jb2RlI2dyYXBoaWNzXG5pbnNwZWN0LmNvbG9ycyA9IHtcbiAgJ2JvbGQnIDogWzEsIDIyXSxcbiAgJ2l0YWxpYycgOiBbMywgMjNdLFxuICAndW5kZXJsaW5lJyA6IFs0LCAyNF0sXG4gICdpbnZlcnNlJyA6IFs3LCAyN10sXG4gICd3aGl0ZScgOiBbMzcsIDM5XSxcbiAgJ2dyZXknIDogWzkwLCAzOV0sXG4gICdibGFjaycgOiBbMzAsIDM5XSxcbiAgJ2JsdWUnIDogWzM0LCAzOV0sXG4gICdjeWFuJyA6IFszNiwgMzldLFxuICAnZ3JlZW4nIDogWzMyLCAzOV0sXG4gICdtYWdlbnRhJyA6IFszNSwgMzldLFxuICAncmVkJyA6IFszMSwgMzldLFxuICAneWVsbG93JyA6IFszMywgMzldXG59O1xuXG4vLyBEb24ndCB1c2UgJ2JsdWUnIG5vdCB2aXNpYmxlIG9uIGNtZC5leGVcbmluc3BlY3Quc3R5bGVzID0ge1xuICAnc3BlY2lhbCc6ICdjeWFuJyxcbiAgJ251bWJlcic6ICd5ZWxsb3cnLFxuICAnYm9vbGVhbic6ICd5ZWxsb3cnLFxuICAndW5kZWZpbmVkJzogJ2dyZXknLFxuICAnbnVsbCc6ICdib2xkJyxcbiAgJ3N0cmluZyc6ICdncmVlbicsXG4gICdkYXRlJzogJ21hZ2VudGEnLFxuICAvLyBcIm5hbWVcIjogaW50ZW50aW9uYWxseSBub3Qgc3R5bGluZ1xuICAncmVnZXhwJzogJ3JlZCdcbn07XG5cblxuZnVuY3Rpb24gc3R5bGl6ZVdpdGhDb2xvcihzdHIsIHN0eWxlVHlwZSkge1xuICB2YXIgc3R5bGUgPSBpbnNwZWN0LnN0eWxlc1tzdHlsZVR5cGVdO1xuXG4gIGlmIChzdHlsZSkge1xuICAgIHJldHVybiAnXFx1MDAxYlsnICsgaW5zcGVjdC5jb2xvcnNbc3R5bGVdWzBdICsgJ20nICsgc3RyICtcbiAgICAgICAgICAgJ1xcdTAwMWJbJyArIGluc3BlY3QuY29sb3JzW3N0eWxlXVsxXSArICdtJztcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gc3RyO1xuICB9XG59XG5cblxuZnVuY3Rpb24gc3R5bGl6ZU5vQ29sb3Ioc3RyLCBzdHlsZVR5cGUpIHtcbiAgcmV0dXJuIHN0cjtcbn1cblxuXG5mdW5jdGlvbiBhcnJheVRvSGFzaChhcnJheSkge1xuICB2YXIgaGFzaCA9IHt9O1xuXG4gIGFycmF5LmZvckVhY2goZnVuY3Rpb24odmFsLCBpZHgpIHtcbiAgICBoYXNoW3ZhbF0gPSB0cnVlO1xuICB9KTtcblxuICByZXR1cm4gaGFzaDtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRWYWx1ZShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMpIHtcbiAgLy8gUHJvdmlkZSBhIGhvb2sgZm9yIHVzZXItc3BlY2lmaWVkIGluc3BlY3QgZnVuY3Rpb25zLlxuICAvLyBDaGVjayB0aGF0IHZhbHVlIGlzIGFuIG9iamVjdCB3aXRoIGFuIGluc3BlY3QgZnVuY3Rpb24gb24gaXRcbiAgaWYgKGN0eC5jdXN0b21JbnNwZWN0ICYmXG4gICAgICB2YWx1ZSAmJlxuICAgICAgaXNGdW5jdGlvbih2YWx1ZS5pbnNwZWN0KSAmJlxuICAgICAgLy8gRmlsdGVyIG91dCB0aGUgdXRpbCBtb2R1bGUsIGl0J3MgaW5zcGVjdCBmdW5jdGlvbiBpcyBzcGVjaWFsXG4gICAgICB2YWx1ZS5pbnNwZWN0ICE9PSBleHBvcnRzLmluc3BlY3QgJiZcbiAgICAgIC8vIEFsc28gZmlsdGVyIG91dCBhbnkgcHJvdG90eXBlIG9iamVjdHMgdXNpbmcgdGhlIGNpcmN1bGFyIGNoZWNrLlxuICAgICAgISh2YWx1ZS5jb25zdHJ1Y3RvciAmJiB2YWx1ZS5jb25zdHJ1Y3Rvci5wcm90b3R5cGUgPT09IHZhbHVlKSkge1xuICAgIHZhciByZXQgPSB2YWx1ZS5pbnNwZWN0KHJlY3Vyc2VUaW1lcywgY3R4KTtcbiAgICBpZiAoIWlzU3RyaW5nKHJldCkpIHtcbiAgICAgIHJldCA9IGZvcm1hdFZhbHVlKGN0eCwgcmV0LCByZWN1cnNlVGltZXMpO1xuICAgIH1cbiAgICByZXR1cm4gcmV0O1xuICB9XG5cbiAgLy8gUHJpbWl0aXZlIHR5cGVzIGNhbm5vdCBoYXZlIHByb3BlcnRpZXNcbiAgdmFyIHByaW1pdGl2ZSA9IGZvcm1hdFByaW1pdGl2ZShjdHgsIHZhbHVlKTtcbiAgaWYgKHByaW1pdGl2ZSkge1xuICAgIHJldHVybiBwcmltaXRpdmU7XG4gIH1cblxuICAvLyBMb29rIHVwIHRoZSBrZXlzIG9mIHRoZSBvYmplY3QuXG4gIHZhciBrZXlzID0gT2JqZWN0LmtleXModmFsdWUpO1xuICB2YXIgdmlzaWJsZUtleXMgPSBhcnJheVRvSGFzaChrZXlzKTtcblxuICBpZiAoY3R4LnNob3dIaWRkZW4pIHtcbiAgICBrZXlzID0gT2JqZWN0LmdldE93blByb3BlcnR5TmFtZXModmFsdWUpO1xuICB9XG5cbiAgLy8gSUUgZG9lc24ndCBtYWtlIGVycm9yIGZpZWxkcyBub24tZW51bWVyYWJsZVxuICAvLyBodHRwOi8vbXNkbi5taWNyb3NvZnQuY29tL2VuLXVzL2xpYnJhcnkvaWUvZHd3NTJzYnQodj12cy45NCkuYXNweFxuICBpZiAoaXNFcnJvcih2YWx1ZSlcbiAgICAgICYmIChrZXlzLmluZGV4T2YoJ21lc3NhZ2UnKSA+PSAwIHx8IGtleXMuaW5kZXhPZignZGVzY3JpcHRpb24nKSA+PSAwKSkge1xuICAgIHJldHVybiBmb3JtYXRFcnJvcih2YWx1ZSk7XG4gIH1cblxuICAvLyBTb21lIHR5cGUgb2Ygb2JqZWN0IHdpdGhvdXQgcHJvcGVydGllcyBjYW4gYmUgc2hvcnRjdXR0ZWQuXG4gIGlmIChrZXlzLmxlbmd0aCA9PT0gMCkge1xuICAgIGlmIChpc0Z1bmN0aW9uKHZhbHVlKSkge1xuICAgICAgdmFyIG5hbWUgPSB2YWx1ZS5uYW1lID8gJzogJyArIHZhbHVlLm5hbWUgOiAnJztcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZSgnW0Z1bmN0aW9uJyArIG5hbWUgKyAnXScsICdzcGVjaWFsJyk7XG4gICAgfVxuICAgIGlmIChpc1JlZ0V4cCh2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZShSZWdFeHAucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpLCAncmVnZXhwJyk7XG4gICAgfVxuICAgIGlmIChpc0RhdGUodmFsdWUpKSB7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoRGF0ZS5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSksICdkYXRlJyk7XG4gICAgfVxuICAgIGlmIChpc0Vycm9yKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGZvcm1hdEVycm9yKHZhbHVlKTtcbiAgICB9XG4gIH1cblxuICB2YXIgYmFzZSA9ICcnLCBhcnJheSA9IGZhbHNlLCBicmFjZXMgPSBbJ3snLCAnfSddO1xuXG4gIC8vIE1ha2UgQXJyYXkgc2F5IHRoYXQgdGhleSBhcmUgQXJyYXlcbiAgaWYgKGlzQXJyYXkodmFsdWUpKSB7XG4gICAgYXJyYXkgPSB0cnVlO1xuICAgIGJyYWNlcyA9IFsnWycsICddJ107XG4gIH1cblxuICAvLyBNYWtlIGZ1bmN0aW9ucyBzYXkgdGhhdCB0aGV5IGFyZSBmdW5jdGlvbnNcbiAgaWYgKGlzRnVuY3Rpb24odmFsdWUpKSB7XG4gICAgdmFyIG4gPSB2YWx1ZS5uYW1lID8gJzogJyArIHZhbHVlLm5hbWUgOiAnJztcbiAgICBiYXNlID0gJyBbRnVuY3Rpb24nICsgbiArICddJztcbiAgfVxuXG4gIC8vIE1ha2UgUmVnRXhwcyBzYXkgdGhhdCB0aGV5IGFyZSBSZWdFeHBzXG4gIGlmIChpc1JlZ0V4cCh2YWx1ZSkpIHtcbiAgICBiYXNlID0gJyAnICsgUmVnRXhwLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKTtcbiAgfVxuXG4gIC8vIE1ha2UgZGF0ZXMgd2l0aCBwcm9wZXJ0aWVzIGZpcnN0IHNheSB0aGUgZGF0ZVxuICBpZiAoaXNEYXRlKHZhbHVlKSkge1xuICAgIGJhc2UgPSAnICcgKyBEYXRlLnByb3RvdHlwZS50b1VUQ1N0cmluZy5jYWxsKHZhbHVlKTtcbiAgfVxuXG4gIC8vIE1ha2UgZXJyb3Igd2l0aCBtZXNzYWdlIGZpcnN0IHNheSB0aGUgZXJyb3JcbiAgaWYgKGlzRXJyb3IodmFsdWUpKSB7XG4gICAgYmFzZSA9ICcgJyArIGZvcm1hdEVycm9yKHZhbHVlKTtcbiAgfVxuXG4gIGlmIChrZXlzLmxlbmd0aCA9PT0gMCAmJiAoIWFycmF5IHx8IHZhbHVlLmxlbmd0aCA9PSAwKSkge1xuICAgIHJldHVybiBicmFjZXNbMF0gKyBiYXNlICsgYnJhY2VzWzFdO1xuICB9XG5cbiAgaWYgKHJlY3Vyc2VUaW1lcyA8IDApIHtcbiAgICBpZiAoaXNSZWdFeHAodmFsdWUpKSB7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoUmVnRXhwLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKSwgJ3JlZ2V4cCcpO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoJ1tPYmplY3RdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH1cblxuICBjdHguc2Vlbi5wdXNoKHZhbHVlKTtcblxuICB2YXIgb3V0cHV0O1xuICBpZiAoYXJyYXkpIHtcbiAgICBvdXRwdXQgPSBmb3JtYXRBcnJheShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLCBrZXlzKTtcbiAgfSBlbHNlIHtcbiAgICBvdXRwdXQgPSBrZXlzLm1hcChmdW5jdGlvbihrZXkpIHtcbiAgICAgIHJldHVybiBmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLCBrZXksIGFycmF5KTtcbiAgICB9KTtcbiAgfVxuXG4gIGN0eC5zZWVuLnBvcCgpO1xuXG4gIHJldHVybiByZWR1Y2VUb1NpbmdsZVN0cmluZyhvdXRwdXQsIGJhc2UsIGJyYWNlcyk7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0UHJpbWl0aXZlKGN0eCwgdmFsdWUpIHtcbiAgaWYgKGlzVW5kZWZpbmVkKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJ3VuZGVmaW5lZCcsICd1bmRlZmluZWQnKTtcbiAgaWYgKGlzU3RyaW5nKHZhbHVlKSkge1xuICAgIHZhciBzaW1wbGUgPSAnXFwnJyArIEpTT04uc3RyaW5naWZ5KHZhbHVlKS5yZXBsYWNlKC9eXCJ8XCIkL2csICcnKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLnJlcGxhY2UoL1xcXFxcIi9nLCAnXCInKSArICdcXCcnO1xuICAgIHJldHVybiBjdHguc3R5bGl6ZShzaW1wbGUsICdzdHJpbmcnKTtcbiAgfVxuICBpZiAoaXNOdW1iZXIodmFsdWUpKVxuICAgIHJldHVybiBjdHguc3R5bGl6ZSgnJyArIHZhbHVlLCAnbnVtYmVyJyk7XG4gIGlmIChpc0Jvb2xlYW4odmFsdWUpKVxuICAgIHJldHVybiBjdHguc3R5bGl6ZSgnJyArIHZhbHVlLCAnYm9vbGVhbicpO1xuICAvLyBGb3Igc29tZSByZWFzb24gdHlwZW9mIG51bGwgaXMgXCJvYmplY3RcIiwgc28gc3BlY2lhbCBjYXNlIGhlcmUuXG4gIGlmIChpc051bGwodmFsdWUpKVxuICAgIHJldHVybiBjdHguc3R5bGl6ZSgnbnVsbCcsICdudWxsJyk7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0RXJyb3IodmFsdWUpIHtcbiAgcmV0dXJuICdbJyArIEVycm9yLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKSArICddJztcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRBcnJheShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLCBrZXlzKSB7XG4gIHZhciBvdXRwdXQgPSBbXTtcbiAgZm9yICh2YXIgaSA9IDAsIGwgPSB2YWx1ZS5sZW5ndGg7IGkgPCBsOyArK2kpIHtcbiAgICBpZiAoaGFzT3duUHJvcGVydHkodmFsdWUsIFN0cmluZyhpKSkpIHtcbiAgICAgIG91dHB1dC5wdXNoKGZvcm1hdFByb3BlcnR5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsXG4gICAgICAgICAgU3RyaW5nKGkpLCB0cnVlKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG91dHB1dC5wdXNoKCcnKTtcbiAgICB9XG4gIH1cbiAga2V5cy5mb3JFYWNoKGZ1bmN0aW9uKGtleSkge1xuICAgIGlmICgha2V5Lm1hdGNoKC9eXFxkKyQvKSkge1xuICAgICAgb3V0cHV0LnB1c2goZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cyxcbiAgICAgICAgICBrZXksIHRydWUpKTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gb3V0cHV0O1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdFByb3BlcnR5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleSwgYXJyYXkpIHtcbiAgdmFyIG5hbWUsIHN0ciwgZGVzYztcbiAgZGVzYyA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IodmFsdWUsIGtleSkgfHwgeyB2YWx1ZTogdmFsdWVba2V5XSB9O1xuICBpZiAoZGVzYy5nZXQpIHtcbiAgICBpZiAoZGVzYy5zZXQpIHtcbiAgICAgIHN0ciA9IGN0eC5zdHlsaXplKCdbR2V0dGVyL1NldHRlcl0nLCAnc3BlY2lhbCcpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW0dldHRlcl0nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBpZiAoZGVzYy5zZXQpIHtcbiAgICAgIHN0ciA9IGN0eC5zdHlsaXplKCdbU2V0dGVyXScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9XG4gIGlmICghaGFzT3duUHJvcGVydHkodmlzaWJsZUtleXMsIGtleSkpIHtcbiAgICBuYW1lID0gJ1snICsga2V5ICsgJ10nO1xuICB9XG4gIGlmICghc3RyKSB7XG4gICAgaWYgKGN0eC5zZWVuLmluZGV4T2YoZGVzYy52YWx1ZSkgPCAwKSB7XG4gICAgICBpZiAoaXNOdWxsKHJlY3Vyc2VUaW1lcykpIHtcbiAgICAgICAgc3RyID0gZm9ybWF0VmFsdWUoY3R4LCBkZXNjLnZhbHVlLCBudWxsKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHN0ciA9IGZvcm1hdFZhbHVlKGN0eCwgZGVzYy52YWx1ZSwgcmVjdXJzZVRpbWVzIC0gMSk7XG4gICAgICB9XG4gICAgICBpZiAoc3RyLmluZGV4T2YoJ1xcbicpID4gLTEpIHtcbiAgICAgICAgaWYgKGFycmF5KSB7XG4gICAgICAgICAgc3RyID0gc3RyLnNwbGl0KCdcXG4nKS5tYXAoZnVuY3Rpb24obGluZSkge1xuICAgICAgICAgICAgcmV0dXJuICcgICcgKyBsaW5lO1xuICAgICAgICAgIH0pLmpvaW4oJ1xcbicpLnN1YnN0cigyKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBzdHIgPSAnXFxuJyArIHN0ci5zcGxpdCgnXFxuJykubWFwKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgICAgICAgIHJldHVybiAnICAgJyArIGxpbmU7XG4gICAgICAgICAgfSkuam9pbignXFxuJyk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tDaXJjdWxhcl0nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgfVxuICBpZiAoaXNVbmRlZmluZWQobmFtZSkpIHtcbiAgICBpZiAoYXJyYXkgJiYga2V5Lm1hdGNoKC9eXFxkKyQvKSkge1xuICAgICAgcmV0dXJuIHN0cjtcbiAgICB9XG4gICAgbmFtZSA9IEpTT04uc3RyaW5naWZ5KCcnICsga2V5KTtcbiAgICBpZiAobmFtZS5tYXRjaCgvXlwiKFthLXpBLVpfXVthLXpBLVpfMC05XSopXCIkLykpIHtcbiAgICAgIG5hbWUgPSBuYW1lLnN1YnN0cigxLCBuYW1lLmxlbmd0aCAtIDIpO1xuICAgICAgbmFtZSA9IGN0eC5zdHlsaXplKG5hbWUsICduYW1lJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG5hbWUgPSBuYW1lLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKVxuICAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFxcXFwiL2csICdcIicpXG4gICAgICAgICAgICAgICAgIC5yZXBsYWNlKC8oXlwifFwiJCkvZywgXCInXCIpO1xuICAgICAgbmFtZSA9IGN0eC5zdHlsaXplKG5hbWUsICdzdHJpbmcnKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gbmFtZSArICc6ICcgKyBzdHI7XG59XG5cblxuZnVuY3Rpb24gcmVkdWNlVG9TaW5nbGVTdHJpbmcob3V0cHV0LCBiYXNlLCBicmFjZXMpIHtcbiAgdmFyIG51bUxpbmVzRXN0ID0gMDtcbiAgdmFyIGxlbmd0aCA9IG91dHB1dC5yZWR1Y2UoZnVuY3Rpb24ocHJldiwgY3VyKSB7XG4gICAgbnVtTGluZXNFc3QrKztcbiAgICBpZiAoY3VyLmluZGV4T2YoJ1xcbicpID49IDApIG51bUxpbmVzRXN0Kys7XG4gICAgcmV0dXJuIHByZXYgKyBjdXIucmVwbGFjZSgvXFx1MDAxYlxcW1xcZFxcZD9tL2csICcnKS5sZW5ndGggKyAxO1xuICB9LCAwKTtcblxuICBpZiAobGVuZ3RoID4gNjApIHtcbiAgICByZXR1cm4gYnJhY2VzWzBdICtcbiAgICAgICAgICAgKGJhc2UgPT09ICcnID8gJycgOiBiYXNlICsgJ1xcbiAnKSArXG4gICAgICAgICAgICcgJyArXG4gICAgICAgICAgIG91dHB1dC5qb2luKCcsXFxuICAnKSArXG4gICAgICAgICAgICcgJyArXG4gICAgICAgICAgIGJyYWNlc1sxXTtcbiAgfVxuXG4gIHJldHVybiBicmFjZXNbMF0gKyBiYXNlICsgJyAnICsgb3V0cHV0LmpvaW4oJywgJykgKyAnICcgKyBicmFjZXNbMV07XG59XG5cblxuLy8gTk9URTogVGhlc2UgdHlwZSBjaGVja2luZyBmdW5jdGlvbnMgaW50ZW50aW9uYWxseSBkb24ndCB1c2UgYGluc3RhbmNlb2ZgXG4vLyBiZWNhdXNlIGl0IGlzIGZyYWdpbGUgYW5kIGNhbiBiZSBlYXNpbHkgZmFrZWQgd2l0aCBgT2JqZWN0LmNyZWF0ZSgpYC5cbmZ1bmN0aW9uIGlzQXJyYXkoYXIpIHtcbiAgcmV0dXJuIEFycmF5LmlzQXJyYXkoYXIpO1xufVxuZXhwb3J0cy5pc0FycmF5ID0gaXNBcnJheTtcblxuZnVuY3Rpb24gaXNCb29sZWFuKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ2Jvb2xlYW4nO1xufVxuZXhwb3J0cy5pc0Jvb2xlYW4gPSBpc0Jvb2xlYW47XG5cbmZ1bmN0aW9uIGlzTnVsbChhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gbnVsbDtcbn1cbmV4cG9ydHMuaXNOdWxsID0gaXNOdWxsO1xuXG5mdW5jdGlvbiBpc051bGxPclVuZGVmaW5lZChhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PSBudWxsO1xufVxuZXhwb3J0cy5pc051bGxPclVuZGVmaW5lZCA9IGlzTnVsbE9yVW5kZWZpbmVkO1xuXG5mdW5jdGlvbiBpc051bWJlcihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdudW1iZXInO1xufVxuZXhwb3J0cy5pc051bWJlciA9IGlzTnVtYmVyO1xuXG5mdW5jdGlvbiBpc1N0cmluZyhhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdzdHJpbmcnO1xufVxuZXhwb3J0cy5pc1N0cmluZyA9IGlzU3RyaW5nO1xuXG5mdW5jdGlvbiBpc1N5bWJvbChhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdzeW1ib2wnO1xufVxuZXhwb3J0cy5pc1N5bWJvbCA9IGlzU3ltYm9sO1xuXG5mdW5jdGlvbiBpc1VuZGVmaW5lZChhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gdm9pZCAwO1xufVxuZXhwb3J0cy5pc1VuZGVmaW5lZCA9IGlzVW5kZWZpbmVkO1xuXG5mdW5jdGlvbiBpc1JlZ0V4cChyZSkge1xuICByZXR1cm4gaXNPYmplY3QocmUpICYmIG9iamVjdFRvU3RyaW5nKHJlKSA9PT0gJ1tvYmplY3QgUmVnRXhwXSc7XG59XG5leHBvcnRzLmlzUmVnRXhwID0gaXNSZWdFeHA7XG5cbmZ1bmN0aW9uIGlzT2JqZWN0KGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ29iamVjdCcgJiYgYXJnICE9PSBudWxsO1xufVxuZXhwb3J0cy5pc09iamVjdCA9IGlzT2JqZWN0O1xuXG5mdW5jdGlvbiBpc0RhdGUoZCkge1xuICByZXR1cm4gaXNPYmplY3QoZCkgJiYgb2JqZWN0VG9TdHJpbmcoZCkgPT09ICdbb2JqZWN0IERhdGVdJztcbn1cbmV4cG9ydHMuaXNEYXRlID0gaXNEYXRlO1xuXG5mdW5jdGlvbiBpc0Vycm9yKGUpIHtcbiAgcmV0dXJuIGlzT2JqZWN0KGUpICYmXG4gICAgICAob2JqZWN0VG9TdHJpbmcoZSkgPT09ICdbb2JqZWN0IEVycm9yXScgfHwgZSBpbnN0YW5jZW9mIEVycm9yKTtcbn1cbmV4cG9ydHMuaXNFcnJvciA9IGlzRXJyb3I7XG5cbmZ1bmN0aW9uIGlzRnVuY3Rpb24oYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnZnVuY3Rpb24nO1xufVxuZXhwb3J0cy5pc0Z1bmN0aW9uID0gaXNGdW5jdGlvbjtcblxuZnVuY3Rpb24gaXNQcmltaXRpdmUoYXJnKSB7XG4gIHJldHVybiBhcmcgPT09IG51bGwgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdib29sZWFuJyB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ251bWJlcicgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdzdHJpbmcnIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnc3ltYm9sJyB8fCAgLy8gRVM2IHN5bWJvbFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ3VuZGVmaW5lZCc7XG59XG5leHBvcnRzLmlzUHJpbWl0aXZlID0gaXNQcmltaXRpdmU7XG5cbmV4cG9ydHMuaXNCdWZmZXIgPSByZXF1aXJlKCcuL3N1cHBvcnQvaXNCdWZmZXInKTtcblxuZnVuY3Rpb24gb2JqZWN0VG9TdHJpbmcobykge1xuICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKG8pO1xufVxuXG5cbmZ1bmN0aW9uIHBhZChuKSB7XG4gIHJldHVybiBuIDwgMTAgPyAnMCcgKyBuLnRvU3RyaW5nKDEwKSA6IG4udG9TdHJpbmcoMTApO1xufVxuXG5cbnZhciBtb250aHMgPSBbJ0phbicsICdGZWInLCAnTWFyJywgJ0FwcicsICdNYXknLCAnSnVuJywgJ0p1bCcsICdBdWcnLCAnU2VwJyxcbiAgICAgICAgICAgICAgJ09jdCcsICdOb3YnLCAnRGVjJ107XG5cbi8vIDI2IEZlYiAxNjoxOTozNFxuZnVuY3Rpb24gdGltZXN0YW1wKCkge1xuICB2YXIgZCA9IG5ldyBEYXRlKCk7XG4gIHZhciB0aW1lID0gW3BhZChkLmdldEhvdXJzKCkpLFxuICAgICAgICAgICAgICBwYWQoZC5nZXRNaW51dGVzKCkpLFxuICAgICAgICAgICAgICBwYWQoZC5nZXRTZWNvbmRzKCkpXS5qb2luKCc6Jyk7XG4gIHJldHVybiBbZC5nZXREYXRlKCksIG1vbnRoc1tkLmdldE1vbnRoKCldLCB0aW1lXS5qb2luKCcgJyk7XG59XG5cblxuLy8gbG9nIGlzIGp1c3QgYSB0aGluIHdyYXBwZXIgdG8gY29uc29sZS5sb2cgdGhhdCBwcmVwZW5kcyBhIHRpbWVzdGFtcFxuZXhwb3J0cy5sb2cgPSBmdW5jdGlvbigpIHtcbiAgY29uc29sZS5sb2coJyVzIC0gJXMnLCB0aW1lc3RhbXAoKSwgZXhwb3J0cy5mb3JtYXQuYXBwbHkoZXhwb3J0cywgYXJndW1lbnRzKSk7XG59O1xuXG5cbi8qKlxuICogSW5oZXJpdCB0aGUgcHJvdG90eXBlIG1ldGhvZHMgZnJvbSBvbmUgY29uc3RydWN0b3IgaW50byBhbm90aGVyLlxuICpcbiAqIFRoZSBGdW5jdGlvbi5wcm90b3R5cGUuaW5oZXJpdHMgZnJvbSBsYW5nLmpzIHJld3JpdHRlbiBhcyBhIHN0YW5kYWxvbmVcbiAqIGZ1bmN0aW9uIChub3Qgb24gRnVuY3Rpb24ucHJvdG90eXBlKS4gTk9URTogSWYgdGhpcyBmaWxlIGlzIHRvIGJlIGxvYWRlZFxuICogZHVyaW5nIGJvb3RzdHJhcHBpbmcgdGhpcyBmdW5jdGlvbiBuZWVkcyB0byBiZSByZXdyaXR0ZW4gdXNpbmcgc29tZSBuYXRpdmVcbiAqIGZ1bmN0aW9ucyBhcyBwcm90b3R5cGUgc2V0dXAgdXNpbmcgbm9ybWFsIEphdmFTY3JpcHQgZG9lcyBub3Qgd29yayBhc1xuICogZXhwZWN0ZWQgZHVyaW5nIGJvb3RzdHJhcHBpbmcgKHNlZSBtaXJyb3IuanMgaW4gcjExNDkwMykuXG4gKlxuICogQHBhcmFtIHtmdW5jdGlvbn0gY3RvciBDb25zdHJ1Y3RvciBmdW5jdGlvbiB3aGljaCBuZWVkcyB0byBpbmhlcml0IHRoZVxuICogICAgIHByb3RvdHlwZS5cbiAqIEBwYXJhbSB7ZnVuY3Rpb259IHN1cGVyQ3RvciBDb25zdHJ1Y3RvciBmdW5jdGlvbiB0byBpbmhlcml0IHByb3RvdHlwZSBmcm9tLlxuICovXG5leHBvcnRzLmluaGVyaXRzID0gcmVxdWlyZSgnaW5oZXJpdHMnKTtcblxuZXhwb3J0cy5fZXh0ZW5kID0gZnVuY3Rpb24ob3JpZ2luLCBhZGQpIHtcbiAgLy8gRG9uJ3QgZG8gYW55dGhpbmcgaWYgYWRkIGlzbid0IGFuIG9iamVjdFxuICBpZiAoIWFkZCB8fCAhaXNPYmplY3QoYWRkKSkgcmV0dXJuIG9yaWdpbjtcblxuICB2YXIga2V5cyA9IE9iamVjdC5rZXlzKGFkZCk7XG4gIHZhciBpID0ga2V5cy5sZW5ndGg7XG4gIHdoaWxlIChpLS0pIHtcbiAgICBvcmlnaW5ba2V5c1tpXV0gPSBhZGRba2V5c1tpXV07XG4gIH1cbiAgcmV0dXJuIG9yaWdpbjtcbn07XG5cbmZ1bmN0aW9uIGhhc093blByb3BlcnR5KG9iaiwgcHJvcCkge1xuICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG9iaiwgcHJvcCk7XG59XG4iLCIvKiBnbG9iYWwgZGVzY3JpYmUgaXQgKi9cbmNvbnN0IGFzc2VydCA9IHJlcXVpcmUoJ2Fzc2VydCcpO1xuY29uc3QgZGVxID0gKHpfZXhwZWN0LCB6X2FjdHVhbCkgPT4ge1xuXHRhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHpfYWN0dWFsLCB6X2V4cGVjdCk7XG59O1xuY29uc3QgZXEgPSAoel9leHBlY3QsIHpfYWN0dWFsKSA9PiB7XG5cdGFzc2VydC5zdHJpY3RFcXVhbCh6X2FjdHVhbCwgel9leHBlY3QpO1xufTtcbmNvbnN0IGZzID0gcmVxdWlyZSgnZnMnKTtcblxuY29uc3Qgd29ya2VyID0gcmVxdWlyZSgnLi4vLi4vYnVpbGQvbWFpbi9tb2R1bGUuanMnKS5zY29waWZ5KHJlcXVpcmUsICgpID0+IHtcblx0cmVxdWlyZSgnLi93b3JrZXJzL2Jhc2ljLmpzJyk7XG59LCAndW5kZWZpbmVkJyAhPT0gdHlwZW9mIGFyZ3VtZW50cyAmJiBhcmd1bWVudHMpO1xuXG5jb25zdCBzcGF3biA9IChzX25hbWU9J2Jhc2ljJykgPT4gd29ya2VyLnNwYXduKGAuL3dvcmtlcnMvJHtzX25hbWV9LmpzYCk7XG5jb25zdCBwb29sID0gKHNfbmFtZT0nYmFzaWMnKSA9PiB3b3JrZXIucG9vbChgLi93b3JrZXJzLyR7c19uYW1lfS5qc2ApO1xuY29uc3QgZ3JvdXAgPSAobl93b3JrZXJzLCBzX25hbWU9J2Jhc2ljJykgPT4gd29ya2VyLmdyb3VwKGAuL3dvcmtlcnMvJHtzX25hbWV9LmpzYCwgbl93b3JrZXJzKTtcblxuY29uc3QgcnVuID0gYXN5bmMgKC4uLmFfYXJncykgPT4ge1xuXHRsZXQga193b3JrZXIgPSBzcGF3bigpO1xuXHRsZXQgel9yZXN1bHQgPSBhd2FpdCBrX3dvcmtlci5ydW4oLi4uYV9hcmdzKTtcblx0YXdhaXQga193b3JrZXIua2lsbCgpO1xuXHRyZXR1cm4gel9yZXN1bHQ7XG59O1xuXG5cbmRlc2NyaWJlKCd3b3JrZXInLCAoKSA9PiB7XG5cblx0aXQoJ3J1bnMnLCBhc3luYygpID0+IHtcblx0XHRlcSgneWVoJywgYXdhaXQgcnVuKCdyZXZlcnNlX3N0cmluZycsIFsnaGV5J10pKTtcblx0fSk7XG5cblx0aXQoJ3R3aWNlJywgYXN5bmMoKSA9PiB7XG5cdFx0bGV0IGtfd29ya2VyID0gc3Bhd24oKTtcblx0XHRsZXQgc195ZWggPSBhd2FpdCBrX3dvcmtlci5ydW4oJ3JldmVyc2Vfc3RyaW5nJywgWydoZXknXSk7XG5cdFx0ZXEoJ2hleScsIGF3YWl0IHJ1bigncmV2ZXJzZV9zdHJpbmcnLCBbc195ZWhdKSk7XG5cdFx0YXdhaXQga193b3JrZXIua2lsbCgpO1xuXHR9KTtcblxuXHRpdCgndGVybWluYXRlcycsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBrX3dvcmtlciA9IHNwYXduKCk7XG5cdFx0a193b3JrZXIucnVuKCd3YWl0JywgW1s1MDAwXV0pXG5cdFx0XHQudGhlbigoKSA9PiBma2VfdGVzdCgnd29ya2VyIGRpZCBub3QgdGVybWluYXRlIGJlZm9yZSBmaW5pc2hpbmcgdGFzaycpKVxuXHRcdFx0LmNhdGNoKChlX3J1bikgPT4ge1xuXHRcdFx0XHRma2VfdGVzdChlX3J1bik7XG5cdFx0XHR9KTtcblx0XHRzZXRUaW1lb3V0KGFzeW5jKCkgPT4ge1xuXHRcdFx0YXdhaXQga193b3JrZXIua2lsbCgpO1xuXHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHR9LCAxMDApO1xuXHR9KTtcblxuXHRpdCgnY2F0Y2hlcycsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBrX3dvcmtlciA9IHNwYXduKCk7XG5cdFx0a193b3JrZXIucnVuKCdmYWlsJylcblx0XHRcdC50aGVuKCgpID0+IGZrZV90ZXN0KCdlcnJvciBub3QgY2F1Z2h0IGJ5IG1hc3RlcicpKVxuXHRcdFx0LmNhdGNoKGFzeW5jKGVfcnVuKSA9PiB7XG5cdFx0XHRcdGFzc2VydChlX3J1bi5tZXNzYWdlLmluY2x1ZGVzKCdubyBzdWNoIHRhc2snKSk7XG5cdFx0XHRcdGF3YWl0IGtfd29ya2VyLmtpbGwoKTtcblx0XHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxuXHRpdCgnZXZlbnRzJywgYXN5bmMoKSA9PiB7XG5cdFx0bGV0IGhfY29udm8gPSB7XG5cdFx0XHRncmVldDogJ2hpJyxcblx0XHRcdGNoYXQ6ICdob3cgciB1Jyxcblx0XHRcdHllbGw6ICdhaGghJyxcblx0XHRcdGFwb2xvZ2l6ZTogJ3NvcnJ5Jyxcblx0XHRcdGZvcmdpdmU6ICdtbWsnLFxuXHRcdFx0ZXhpdDogJ2tieWUnLFxuXHRcdH07XG5cblx0XHRsZXQgYV9kYXRhID0gW107XG5cdFx0bGV0IGhfcmVzcG9uc2VzID0ge307XG5cdFx0bGV0IGNfcmVzcG9uc2VzID0gMDtcblx0XHRPYmplY3Qua2V5cyhoX2NvbnZvKS5mb3JFYWNoKChzX2tleSwgaV9rZXkpID0+IHtcblx0XHRcdGFfZGF0YS5wdXNoKHtcblx0XHRcdFx0bmFtZTogc19rZXksXG5cdFx0XHRcdGRhdGE6IGhfY29udm9bc19rZXldLFxuXHRcdFx0XHR3YWl0OiBpX2tleT8gMTAwOiAwLFxuXHRcdFx0fSk7XG5cblx0XHRcdGhfcmVzcG9uc2VzW3Nfa2V5XSA9IChzX21zZykgPT4ge1xuXHRcdFx0XHRlcShoX2NvbnZvW3Nfa2V5XSwgc19tc2cpO1xuXHRcdFx0XHRjX3Jlc3BvbnNlcyArPSAxO1xuXHRcdFx0fTtcblx0XHR9KTtcblxuXHRcdGxldCBrX3dvcmtlciA9IHNwYXduKCk7XG5cdFx0YXdhaXQga193b3JrZXIucnVuKCdldmVudHMnLCBbYV9kYXRhXSwgaF9yZXNwb25zZXMpO1xuXHRcdGF3YWl0IGtfd29ya2VyLmtpbGwoKTtcblx0XHRlcShhX2RhdGEubGVuZ3RoLCBjX3Jlc3BvbnNlcyk7XG5cdH0pO1xuXG5cdGl0KCdzdG9yZScsIGFzeW5jICgpID0+IHtcblx0XHRsZXQga193b3JrZXIgPSBzcGF3bigpO1xuXHRcdGF3YWl0IGtfd29ya2VyLnJ1bignc3RvcmUnLCBbW3t0ZXN0Oid2YWx1ZSd9XV0pO1xuXHRcdGxldCBhX3ZhbHVlcyA9IGF3YWl0IGtfd29ya2VyLnJ1bignZmV0Y2gnLCBbWyd0ZXN0J11dKTtcblx0XHRhd2FpdCBrX3dvcmtlci5raWxsKCk7XG5cdFx0ZXEoJ3ZhbHVlJywgYV92YWx1ZXNbMF0pO1xuXHR9KTtcbn0pO1xuXG5cbmRlc2NyaWJlKCdwb29sJywgKCkgPT4ge1xuXHRpdCgnZXZlbnRzJywgYXN5bmMoKSA9PiB7XG5cdFx0bGV0IGtfcG9vbCA9IHBvb2woKTtcblx0XHRsZXQgbl9zYXlzID0gMTA7XG5cdFx0bGV0IGNfYnllcyA9IDA7XG5cdFx0bGV0IGFfd2FpdHMgPSBbXTtcblxuXHRcdGNvbnN0IGhfZXZlbnRzID0ge1xuXHRcdFx0bm90aWZ5KHNfc2F5KSB7XG5cdFx0XHRcdGlmKCdieWUnID09PSBzX3NheSkgY19ieWVzICs9IDE7XG5cdFx0XHR9LFxuXHRcdH07XG5cblx0XHRmb3IobGV0IGk9MDsgaTxuX3NheXM7IGkrKykge1xuXHRcdFx0YV93YWl0cy5wdXNoKGtfcG9vbFxuXHRcdFx0XHQucnVuKCdldmVudHMnLCBbXG5cdFx0XHRcdFx0W1xuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRuYW1lOiAnbm90aWZ5Jyxcblx0XHRcdFx0XHRcdFx0ZGF0YTogJ2hpJyxcblx0XHRcdFx0XHRcdFx0d2FpdDogNSxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdG5hbWU6ICdub3RpZnknLFxuXHRcdFx0XHRcdFx0XHRkYXRhOiAnYnllJyxcblx0XHRcdFx0XHRcdFx0d2FpdDogMTUsXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdF0sXG5cdFx0XHRcdF0sIGhfZXZlbnRzKSk7XG5cdFx0fVxuXG5cdFx0YXdhaXQgUHJvbWlzZS5hbGwoYV93YWl0cyk7XG5cblx0XHRhd2FpdCBrX3Bvb2wua2lsbCgpO1xuXG5cdFx0ZXEobl9zYXlzLCBjX2J5ZXMpO1xuXHR9KTtcbn0pO1xuXG5cbmRlc2NyaWJlKCdncm91cCcsICgpID0+IHtcblxuXHRpdCgnbWFwL3RocnUnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQgYV9zZXEgPSBbOCwgMSwgNywgNCwgMywgNSwgMiwgNl07XG5cdFx0bGV0IGtfZ3JvdXAgPSBncm91cChhX3NlcS5sZW5ndGgpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKGFfc2VxKVxuXHRcdFx0Lm1hcCgnbXVsdGlwbHknLCBbMl0pXG5cdFx0XHQudGhydSgnYWRkJywgWzNdKVxuXHRcdFx0LmVhY2goKHhfbiwgaV9uKSA9PiB7XG5cdFx0XHRcdGVxKChhX3NlcVtpX25dKjIpKzMsIHhfblswXSk7XG5cdFx0XHR9LCBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdGF3YWl0IGtfZ3JvdXAua2lsbCgpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdtYXAvZWFjaCcsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBhX3NlcSA9IFs4LCAxLCA3LCA0LCAzLCA1LCAyLCA2XS5tYXAoeCA9PiB4KjEwMCk7XG5cdFx0bGV0IGtfZ3JvdXAgPSBncm91cChhX3NlcS5sZW5ndGgpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKGFfc2VxKVxuXHRcdFx0Lm1hcCgnd2FpdCcpXG5cdFx0XHQuZWFjaCgoeF9uLCBpX24pID0+IHtcblx0XHRcdFx0ZXEoYV9zZXFbaV9uXSwgeF9uKTtcblx0XHRcdH0sIGFzeW5jICgpID0+IHtcblx0XHRcdFx0YXdhaXQga19ncm91cC5raWxsKCk7XG5cdFx0XHRcdGZrZV90ZXN0KCk7XG5cdFx0XHR9KTtcblx0fSk7XG5cblx0aXQoJ21hcC9zZXJpZXMnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQgYV9zZXEgPSBbOCwgMSwgNywgNCwgMywgNSwgMiwgNl0ubWFwKHggPT4geCoxMDApO1xuXHRcdGxldCBhX3JlcyA9IFtdO1xuXHRcdGxldCBrX2dyb3VwID0gZ3JvdXAoYV9zZXEubGVuZ3RoKTtcblx0XHRrX2dyb3VwXG5cdFx0XHQuZGF0YShhX3NlcSlcblx0XHRcdC5tYXAoJ3dhaXQnKVxuXHRcdFx0LnNlcmllcygoeF9uKSA9PiB7XG5cdFx0XHRcdGFfcmVzLnB1c2goeF9uKTtcblx0XHRcdH0sIGFzeW5jICgpID0+IHtcblx0XHRcdFx0YXdhaXQga19ncm91cC5raWxsKCk7XG5cdFx0XHRcdGRlcShhX3NlcSwgYV9yZXMpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdtYXAvcmVkdWNlICM0JywgKGZrZV90ZXN0KSA9PiB7XG5cdFx0bGV0IHNfc3JjID0gJ2FiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6Jztcblx0XHRsZXQga19ncm91cCA9IGdyb3VwKDQpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKHNfc3JjLnNwbGl0KCcnKSlcblx0XHRcdC5tYXAoJ2NvbmNhdCcpXG5cdFx0XHQucmVkdWNlKCdtZXJnZV9jb25jYXQnKS50aGVuKGFzeW5jIChzX2ZpbmFsKSA9PiB7XG5cdFx0XHRcdGF3YWl0IGtfZ3JvdXAua2lsbCgpO1xuXHRcdFx0XHRlcShzX3NyYywgc19maW5hbCk7XG5cdFx0XHRcdGZrZV90ZXN0KCk7XG5cdFx0XHR9KTtcblx0fSk7XG5cblx0aXQoJ21hcC9yZWR1Y2UgIzgnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQgc19zcmMgPSAnYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXonO1xuXHRcdGxldCBrX2dyb3VwID0gZ3JvdXAoOCk7XG5cdFx0a19ncm91cFxuXHRcdFx0LmRhdGEoc19zcmMuc3BsaXQoJycpKVxuXHRcdFx0Lm1hcCgnY29uY2F0Jylcblx0XHRcdC5yZWR1Y2UoJ21lcmdlX2NvbmNhdCcpLnRoZW4oYXN5bmMgKHNfZmluYWwpID0+IHtcblx0XHRcdFx0YXdhaXQga19ncm91cC5raWxsKCk7XG5cdFx0XHRcdGVxKHNfc3JjLCBzX2ZpbmFsKTtcblx0XHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxuXHRpdCgnbWFwL3JlZHVjZSBlbXB0eScsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBrX2dyb3VwID0gZ3JvdXAoOCk7XG5cdFx0a19ncm91cFxuXHRcdFx0LmRhdGEoW10pXG5cdFx0XHQubWFwKCdjb25jYXQnKVxuXHRcdFx0LnJlZHVjZSgnbWVyZ2VfY29uY2F0JykudGhlbihhc3luYyAoc19maW5hbD1udWxsKSA9PiB7XG5cdFx0XHRcdGF3YWl0IGtfZ3JvdXAua2lsbCgpO1xuXHRcdFx0XHRlcShudWxsLCBzX2ZpbmFsKTtcblx0XHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxuXHRpdCgnZXZlbnRzJywgKGZrZV90ZXN0KSA9PiB7XG5cdFx0bGV0IGhfY29udm8gPSB7XG5cdFx0XHRncmVldDogJ2hpJyxcblx0XHRcdGNoYXQ6ICdob3cgciB1Jyxcblx0XHRcdHllbGw6ICdhaGghJyxcblx0XHRcdGFwb2xvZ2l6ZTogJ3NvcnJ5Jyxcblx0XHRcdGZvcmdpdmU6ICdtbWsnLFxuXHRcdFx0ZXhpdDogJ2tieWUnLFxuXHRcdH07XG5cblx0XHRsZXQgYV9kYXRhID0gW107XG5cdFx0bGV0IGhfcmVzcG9uc2VzID0ge307XG5cdFx0bGV0IGNfcmVzcG9uc2VzID0gMDtcblx0XHRPYmplY3Qua2V5cyhoX2NvbnZvKS5mb3JFYWNoKChzX2tleSwgaV9rZXkpID0+IHtcblx0XHRcdGFfZGF0YS5wdXNoKHtcblx0XHRcdFx0bmFtZTogc19rZXksXG5cdFx0XHRcdGRhdGE6IGhfY29udm9bc19rZXldLFxuXHRcdFx0XHR3YWl0OiBpX2tleT8gNTAwOiAwLFxuXHRcdFx0fSk7XG5cblx0XHRcdGhfcmVzcG9uc2VzW3Nfa2V5XSA9IChpX3N1YnNldCwgc19tc2cpID0+IHtcblx0XHRcdFx0ZXEoaF9jb252b1tzX2tleV0sIHNfbXNnKTtcblx0XHRcdFx0Y19yZXNwb25zZXMgKz0gMTtcblx0XHRcdH07XG5cdFx0fSk7XG5cblx0XHRsZXQga19ncm91cCA9IGdyb3VwKDMpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKGFfZGF0YSlcblx0XHRcdC5tYXAoJ2V2ZW50cycsIFtdLCBoX3Jlc3BvbnNlcylcblx0XHRcdC5lbmQoYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRhd2FpdCBrX2dyb3VwLmtpbGwoKTtcblx0XHRcdFx0ZXEoYV9kYXRhLmxlbmd0aCwgY19yZXNwb25zZXMpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdzdG9yZScsICgpID0+IHtcblx0XHRsZXQga19ncm91cCA9IGdyb3VwKDIpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKFtbMTAwLCAwLCAwLCAwXV0pXG5cdFx0XHQubWFwKCdwYXNzJylcblx0XHRcdC8vIC50aHJ1KCdwYXNzJylcblx0XHRcdC5yZWR1Y2UoJ3N1bScpLnRoZW4oYXN5bmMgKGFfdikgPT4ge1xuXHRcdFx0XHRhd2FpdCBrX2dyb3VwLmtpbGwoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxufSk7XG5cblxuZGVzY3JpYmUoJ2F1eCcsICgpID0+IHtcblxuXHRpZighd29ya2VyLmJyb3dzZXIpIHtcblx0XHRpdCgndHJhbnNmZXJzJywgYXN5bmMgKCkgPT4ge1xuXHRcdFx0bGV0IGttX2FyZ3MgPSB3b3JrZXIubWFuaWZlc3QoW2ZzLnJlYWRGaWxlU3luYygnLi9wYWNrYWdlLmpzb24nKV0pO1xuXHRcdFx0bGV0IG5fbGVuZ3RoID0gYXdhaXQgcnVuKCdjb3VudCcsIGttX2FyZ3MpO1xuXG5cdFx0XHRhc3NlcnQobl9sZW5ndGggPiAwKTtcblx0XHR9KTtcblx0fVxuXG5cdGl0KCd0eXBlZC1hcnJheScsIGFzeW5jICgpID0+IHtcblx0XHRsZXQgYXRfdGVzdCA9IG5ldyBVaW50OEFycmF5KDEwKTtcblx0XHRhdF90ZXN0WzBdID0gNztcblx0XHRhdF90ZXN0WzFdID0gNTtcblx0XHRsZXQga21fYXJncyA9IHdvcmtlci5tYW5pZmVzdChbYXRfdGVzdCwgMV0pO1xuXHRcdGxldCBuX2F0ID0gYXdhaXQgcnVuKCdhdCcsIGttX2FyZ3MpO1xuXHRcdGVxKDUsIG5fYXQpO1xuXHR9KTtcblxuXHQvLyBpdCgnc3RyZWFtcycsIGFzeW5jICgpID0+IHtcblx0Ly8gXHRsZXQgZHNfd29yZHMgPSBmcy5jcmVhdGVSZWFkU3RyZWFtKCcvdXNyL3NoYXJlL2RpY3Qvd29yZHMnLCAndXRmOCcpO1xuXHQvLyBcdGxldCBuX25ld2xpbmVzID0gYXdhaXQgcnVuKCdjb3VudF9zdHInLCBbZHNfd29yZHMsICdcXG4nXSk7XG5cdC8vIFx0Y29uc29sZS5sb2cobl9uZXdsaW5lcyk7XG5cdC8vIFx0Ly8gZXEoJ3dvcmtlcicsIHNfcGFja2FnZV9uYW1lKTtcblx0Ly8gfSk7XG59KTtcblxuXG4vKiBUT0RPOlxuXG4gLSBhd2FpdCBncm91cCNlbmRcbiAtIGF3YWl0IGdyb3VwI3J1blxuIC0gZXZlbnQgZW1pdHRlcnNcbiAtIGNoYW5uZWwgbWVzc2FnaW5nXG5cbltub2RlLmpzXVxuIC0gY2hhbm5lbCBzb2NrZXQgZmlsZSB1bmxpbmtpbmcgKGluY2x1ZGluZyBvbiBhYnJ1YnQgZXhpdClcblxuXG4qL1xuXG5cbiIsImNvbnN0IHdvcmtlciA9IHJlcXVpcmUoJy4uLy4uLy4uL2J1aWxkL21haW4vbW9kdWxlLmpzJyk7XG5cbndvcmtlci5kZWRpY2F0ZWQoe1xuXHRyZXZlcnNlX3N0cmluZzogcyA9PiBzLnNwbGl0KCcnKS5yZXZlcnNlKCkuam9pbignJyksXG5cblx0YXQ6IChhLCBpKSA9PiBhW2ldLFxuXG5cdHdhaXQ6IChhX3dhaXQpID0+IG5ldyBQcm9taXNlKChmX3Jlc29sdmUpID0+IHtcblx0XHRsZXQgdF93YWl0ID0gYV93YWl0WzBdO1xuXG5cdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRmX3Jlc29sdmUodF93YWl0KTtcblx0XHR9LCB0X3dhaXQpO1xuXHR9KSxcblxuXHRjb25jYXQ6IGEgPT4gYS5qb2luKCcnKSxcblxuXHRtZXJnZV9jb25jYXQ6IChzX2EsIHNfYikgPT4gc19hICsgc19iLFxuXG5cdGV2ZW50cyhhX2V2dHMpIHtcblx0XHRyZXR1cm4gUHJvbWlzZS5hbGwoXG5cdFx0XHRhX2V2dHMubWFwKChoX2V2dCkgPT4gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSwgZl9yZWplY3QpID0+IHtcblx0XHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0dGhpcy5lbWl0KGhfZXZ0Lm5hbWUsIGhfZXZ0LmRhdGEpO1xuXHRcdFx0XHRcdGZfcmVzb2x2ZSgpO1xuXHRcdFx0XHR9LCBoX2V2dC53YWl0ICsgNjAwKTtcblx0XHRcdH0pKVxuXHRcdCk7XG5cdH0sXG5cblx0c3RvcmUoYV9zdG9yZSkge1xuXHRcdGFfc3RvcmUuZm9yRWFjaCgoaF9zdG9yZSkgPT4ge1xuXHRcdFx0Zm9yKGxldCBzX2tleSBpbiBoX3N0b3JlKSB7XG5cdFx0XHRcdHRoaXMucHV0KHNfa2V5LCBoX3N0b3JlW3Nfa2V5XSk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cdH0sXG5cblx0ZmV0Y2goYV9rZXlzKSB7XG5cdFx0cmV0dXJuIGFfa2V5cy5tYXAoc19rZXkgPT4gdGhpcy5nZXQoc19rZXkpKTtcblx0fSxcblxuXHRwYXNzKGFfd2FpdCkge1xuXHRcdHJldHVybiBQcm9taXNlLmFsbChhX3dhaXQubWFwKHhfd2FpdCA9PiBuZXcgUHJvbWlzZSgoZl9yZXNvbHZlLCBmX3JlamVjdCkgPT4ge1xuXHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdGxldCBjX3ZhbCA9ICh0aGlzLmdldCgnZGlnJykgfHwgMCkgKyAxO1xuXHRcdFx0XHR0aGlzLnB1dCgnZGlnJywgY192YWwpO1xuXHRcdFx0XHRmX3Jlc29sdmUoY192YWwpO1xuXHRcdFx0fSwgeF93YWl0KTtcblx0XHR9KSkpO1xuXHR9LFxuXG5cdG11bHRpcGx5OiAoYSwgeF9tdWx0aXBsaWVyKSA9PiBhLm1hcCh4ID0+IHggKiB4X211bHRpcGxpZXIpLFxuXG5cdGFkZDogKGEsIHhfYWRkKSA9PiBhLm1hcCh4ID0+IHggKyB4X2FkZCksXG5cblx0Ly8gc3VtOiAoeF9hLCB4X2IpID0+IHhfYSArIHhfYixcblxuXHRzdW06IChhX2EsIGFfYikgPT4gW2FfYS5yZWR1Y2UoKGMsIHgpID0+IGMgKyB4LCAwKSArIGFfYi5yZWR1Y2UoKGMsIHgpID0+IGMgKyB4LCAwKV0sXG5cblx0Y291bnQ6IChhKSA9PiBhLnJlZHVjZSgoYywgeCkgPT4gYyArIHgsIDApLFxuXG5cdGNvdW50X3N0cihkc19pbnB1dCwgc19zdHIpIHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSwgZl9yZWplY3QpID0+IHtcblx0XHRcdGxldCBjX29jY3VycmVuY2VzID0gMDtcblx0XHRcdGRzX2lucHV0Lm9uKCdkYXRhJywgKHNfY2h1bmspID0+IHtcblx0XHRcdFx0Y29uc29sZS5sb2coJ29jY3VycmVuY2VzOiAnK2Nfb2NjdXJyZW5jZXMpO1xuXHRcdFx0XHRjX29jY3VycmVuY2VzICs9IHNfY2h1bmsuc3BsaXQoc19zdHIpLmxlbmd0aCAtIDE7XG5cdFx0XHR9KTtcblxuXHRcdFx0ZHNfaW5wdXQub24oJ2VuZCcsICgpID0+IHtcblx0XHRcdFx0Y29uc29sZS5sb2coJ2VuZCcpO1xuXHRcdFx0XHRmX3Jlc29sdmUoY19vY2N1cnJlbmNlcyk7XG5cdFx0XHR9KTtcblxuXHRcdFx0ZHNfaW5wdXQub24oJ2Vycm9yJywgKGVfc3RyZWFtKSA9PiB7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoZV9zdHJlYW0pO1xuXHRcdFx0XHRmX3JlamVjdChlX3N0cmVhbSk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblx0fSxcblxuXHR3cml0ZShkc19vdXQsIGFfcmFuZ2UpIHtcblx0XHRmb3IobGV0IGk9YV9yYW5nZVswXTsgaTxhX3JhbmdlWzFdOyBpKyspIHtcblx0XHRcdGRzX291dC53cml0ZShpKydcXG4nKTtcblx0XHR9XG5cdH0sXG59KTtcbiJdfQ==
