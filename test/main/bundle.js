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

// deduce the runtime environment
const [B_BROWSER, B_BROWSERIFY] = (() => 'undefined' === typeof process
	? [true, false]
	: (process.browser
		? [true, true]
		: ('undefined' === process.versions || 'undefined' === process.versions.node
			? [true, false]
			: [false, false])))();


const locals = Object.assign({
	B_BROWSER,
	B_BROWSERIFY,

	HP_WORKER_NOTIFICATION: Symbol('worker notification'),
}, B_BROWSER? require('../browser/locals.js'): require('../node/locals.js'));


locals.webworkerify = function(z_import, h_config={}) {
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
};


module.exports = locals;

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
		let dp_run = new Promise(async (fk_run, fe_run) => {
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
Object.assign(Float64ArrayS.prototype, {
	[sharing.$_SHAREABLE]: 1,
});


// globals
module.exports = {
	exports: {
		ArrayBufferS: SharedArrayBuffer,
		ArrayBufferT: ArrayBuffer,
		Int8ArrayS: Int8ArrayS, Int8ArrayT: Int8Array, Uint8ArrayS: Uint8ArrayS, Uint8ArrayT: Uint8Array, Uint8ClampedArrayS: Uint8ClampedArrayS, Uint8ClampedArrayT: Uint8ClampedArray, Int16ArrayS: Int16ArrayS, Int16ArrayT: Int16Array, Uint16ArrayS: Uint16ArrayS, Uint16ArrayT: Uint16Array, Int32ArrayS: Int32ArrayS, Int32ArrayT: Int32Array, Uint32ArrayS: Uint32ArrayS, Uint32ArrayT: Uint32Array, Float32ArrayS: Float32ArrayS, Float32ArrayT: Float32Array, Float64ArrayS: Float64ArrayS, Float64ArrayT: Float64Array,
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJidWlsZC9tYWluL2FsbC9kZWRpY2F0ZWQuanMiLCJidWlsZC9tYWluL2FsbC9ncm91cC5qcyIsImJ1aWxkL21haW4vYWxsL2xvY2Fscy5qcyIsImJ1aWxkL21haW4vYWxsL2xvY2thYmxlLmpzIiwiYnVpbGQvbWFpbi9hbGwvbWFuaWZlc3QuanMiLCJidWlsZC9tYWluL2FsbC9wb29sLmpzIiwiYnVpbGQvbWFpbi9hbGwvcmVzdWx0LmpzIiwiYnVpbGQvbWFpbi9icm93c2VyL2NoYW5uZWwuanMiLCJidWlsZC9tYWluL2Jyb3dzZXIvZXZlbnRzLmpzIiwiYnVpbGQvbWFpbi9icm93c2VyL2xhdGVudC1zdWJ3b3JrZXIuanMiLCJidWlsZC9tYWluL2Jyb3dzZXIvbG9jYWxzLmpzIiwiYnVpbGQvbWFpbi9icm93c2VyL3BvcnRzLmpzIiwiYnVpbGQvbWFpbi9icm93c2VyL3NlbGYuanMiLCJidWlsZC9tYWluL2Jyb3dzZXIvc2hhcmluZy5qcyIsImJ1aWxkL21haW4vYnJvd3Nlci9zdHJlYW0uanMiLCJidWlsZC9tYWluL2Jyb3dzZXIvdHlwZWQtYXJyYXlzLmpzIiwiYnVpbGQvbWFpbi9icm93c2VyL3dvcmtlci5qcyIsImJ1aWxkL21haW4vbW9kdWxlLmpzIiwibm9kZV9tb2R1bGVzL2Fzc2VydC9hc3NlcnQuanMiLCJub2RlX21vZHVsZXMvYnJvd3Nlci1yZXNvbHZlL2VtcHR5LmpzIiwibm9kZV9tb2R1bGVzL2NvbG9ycy9saWIvY29sb3JzLmpzIiwibm9kZV9tb2R1bGVzL2NvbG9ycy9saWIvY3VzdG9tL3RyYXAuanMiLCJub2RlX21vZHVsZXMvY29sb3JzL2xpYi9jdXN0b20vemFsZ28uanMiLCJub2RlX21vZHVsZXMvY29sb3JzL2xpYi9leHRlbmRTdHJpbmdQcm90b3R5cGUuanMiLCJub2RlX21vZHVsZXMvY29sb3JzL2xpYi9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9jb2xvcnMvbGliL21hcHMvYW1lcmljYS5qcyIsIm5vZGVfbW9kdWxlcy9jb2xvcnMvbGliL21hcHMvcmFpbmJvdy5qcyIsIm5vZGVfbW9kdWxlcy9jb2xvcnMvbGliL21hcHMvcmFuZG9tLmpzIiwibm9kZV9tb2R1bGVzL2NvbG9ycy9saWIvbWFwcy96ZWJyYS5qcyIsIm5vZGVfbW9kdWxlcy9jb2xvcnMvbGliL3N0eWxlcy5qcyIsIm5vZGVfbW9kdWxlcy9jb2xvcnMvbGliL3N5c3RlbS9oYXMtZmxhZy5qcyIsIm5vZGVfbW9kdWxlcy9jb2xvcnMvbGliL3N5c3RlbS9zdXBwb3J0cy1jb2xvcnMuanMiLCJub2RlX21vZHVsZXMvZXZlbnRzL2V2ZW50cy5qcyIsIm5vZGVfbW9kdWxlcy9vcy1icm93c2VyaWZ5L2Jyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvcGF0aC1icm93c2VyaWZ5L2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3Byb2Nlc3MvYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy91dGlsL25vZGVfbW9kdWxlcy9pbmhlcml0cy9pbmhlcml0c19icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL3V0aWwvc3VwcG9ydC9pc0J1ZmZlckJyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvdXRpbC91dGlsLmpzIiwidGVzdC9tYWluL21vZHVsZS5qcyIsInRlc3QvbWFpbi93b3JrZXJzL2Jhc2ljLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pXQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3JpQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUN2RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9GQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JJQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMUZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVkE7QUFDQTtBQUNBO0FBQ0E7O0FDSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDNVhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUN4cEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3ZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7QUNoa0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMxZUE7Ozs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbkxBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeEdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNYQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUM1RUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7OztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ25KQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2Z0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ2pEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUNoT0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4TEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMxa0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM1JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbigpe2Z1bmN0aW9uIHIoZSxuLHQpe2Z1bmN0aW9uIG8oaSxmKXtpZighbltpXSl7aWYoIWVbaV0pe3ZhciBjPVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmU7aWYoIWYmJmMpcmV0dXJuIGMoaSwhMCk7aWYodSlyZXR1cm4gdShpLCEwKTt2YXIgYT1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK2krXCInXCIpO3Rocm93IGEuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixhfXZhciBwPW5baV09e2V4cG9ydHM6e319O2VbaV1bMF0uY2FsbChwLmV4cG9ydHMsZnVuY3Rpb24ocil7dmFyIG49ZVtpXVsxXVtyXTtyZXR1cm4gbyhufHxyKX0scCxwLmV4cG9ydHMscixlLG4sdCl9cmV0dXJuIG5baV0uZXhwb3J0c31mb3IodmFyIHU9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWlyZSYmcmVxdWlyZSxpPTA7aTx0Lmxlbmd0aDtpKyspbyh0W2ldKTtyZXR1cm4gb31yZXR1cm4gcn0pKCkiLCJjb25zdCB7XG5cdEtfU0VMRixcblx0c3RyZWFtLFxuXHRwb3J0cyxcbn0gPSByZXF1aXJlKCcuL2xvY2Fscy5qcycpO1xuXG5jb25zdCB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuY29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKCcuL21hbmlmZXN0LmpzJyk7XG5jb25zdCByZXN1bHQgPSByZXF1aXJlKCcuL3Jlc3VsdC5qcycpO1xuXG5jbGFzcyBoZWxwZXIge1xuXHRjb25zdHJ1Y3RvcihrX3dvcmtlciwgaV90YXNrLCBoX2V2ZW50cykge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0d29ya2VyOiBrX3dvcmtlcixcblx0XHRcdHRhc2tfaWQ6IGlfdGFzayxcblx0XHRcdGV2ZW50czogaF9ldmVudHMgfHwge30sXG5cdFx0XHR3b3JrZXJfc3RvcmU6IGtfd29ya2VyLnN0b3JlLFxuXHRcdFx0dGFza3M6IGtfd29ya2VyLnRhc2tzLFxuXHRcdH0pO1xuXHR9XG5cblx0cHV0KHNfa2V5LCB6X2RhdGEpIHtcblx0XHRsZXQgaF9zdG9yZSA9IHRoaXMud29ya2VyX3N0b3JlO1xuXHRcdGxldCBpX3Rhc2sgPSB0aGlzLnRhc2tfaWQ7XG5cblx0XHQvLyBmaXJzdCBpdGVtIGluIHRoaXMgdGFzaydzIHN0b3JlXG5cdFx0aWYoIShpX3Rhc2sgaW4gaF9zdG9yZSkpIHtcblx0XHRcdGhfc3RvcmVbaV90YXNrXSA9IHtcblx0XHRcdFx0W3Nfa2V5XTogel9kYXRhLFxuXHRcdFx0fTtcblx0XHR9XG5cdFx0Ly8gbm90IGZpcnN0IGl0ZW07IGFkZCBpdFxuXHRcdGVsc2Uge1xuXHRcdFx0aF9zdG9yZVtpX3Rhc2tdW3Nfa2V5XSA9IHpfZGF0YTtcblx0XHR9XG5cdH1cblxuXHRnZXQoc19rZXkpIHtcblx0XHRsZXQgaV90YXNrID0gdGhpcy50YXNrX2lkO1xuXG5cdFx0Ly8gdGhpcyB0YXNrIGNoYWluIHdhcyBuZXZlciB3cml0dGVuIHRvXG5cdFx0aWYoIShpX3Rhc2sgaW4gdGhpcy53b3JrZXJfc3RvcmUpKSByZXR1cm47XG5cblx0XHQvLyByZXR1cm4gd2hhdGV2ZXIgdmFsdWUgaXMgdGhlcmVcblx0XHRyZXR1cm4gdGhpcy53b3JrZXJfc3RvcmVbaV90YXNrXVtzX2tleV07XG5cdH1cblxuXHRlbWl0KHNfa2V5LCAuLi5hX2FyZ3MpIHtcblx0XHQvLyBvbmx5IGlmIHRoZSBldmVudCBpcyByZWdpc3RlcmVkXG5cdFx0aWYoc19rZXkgaW4gdGhpcy5ldmVudHMpIHtcblx0XHRcdGxldCBhX2FyZ3Nfc2VuZCA9IFtdO1xuXHRcdFx0bGV0IGFfdHJhbnNmZXJfcGF0aHMgPSBbXTtcblxuXHRcdFx0Ly8gbWVyZ2UgYXJnc1xuXHRcdFx0bGV0IG5fYXJncyA9IGFfYXJncy5sZW5ndGg7XG5cdFx0XHRmb3IobGV0IGlfYXJnPTA7IGlfYXJnPG5fYXJnczsgaV9hcmcrKykge1xuXHRcdFx0XHRsZXQgel9hcmcgPSBhX2FyZ3NbaV9hcmddO1xuXG5cdFx0XHRcdC8vIHJlc3VsdFxuXHRcdFx0XHRpZih6X2FyZyBpbnN0YW5jZW9mIG1hbmlmZXN0KSB7XG5cdFx0XHRcdFx0YV9hcmdzX3NlbmQucHVzaCh6X2FyZy5kYXRhKTtcblx0XHRcdFx0XHRpZih6X2FyZy50cmFuc2Zlcl9wYXRocykge1xuXHRcdFx0XHRcdFx0bGV0IG5sX3BhdGhzID0gYV90cmFuc2Zlcl9wYXRocy5sZW5ndGg7XG5cdFx0XHRcdFx0XHRsZXQgYV9pbXBvcnRfcGF0aHMgPSB6X2FyZy50cmFuc2Zlcl9wYXRocztcblx0XHRcdFx0XHRcdGFfaW1wb3J0X3BhdGhzLmZvckVhY2goKGFfcGF0aCkgPT4ge1xuXHRcdFx0XHRcdFx0XHRhX3BhdGhbMF0gKz0gbmxfcGF0aHM7XG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdGFfdHJhbnNmZXJfcGF0aHMucHVzaCguLi5hX2ltcG9ydF9wYXRocyk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIHBvc3RhYmxlXG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdGFfYXJnc19zZW5kLnB1c2goel9hcmcpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIHNlbmQgbWVzc2FnZVxuXHRcdFx0S19TRUxGLnBvc3RNZXNzYWdlKHtcblx0XHRcdFx0dHlwZTogJ2V2ZW50Jyxcblx0XHRcdFx0aWQ6IHRoaXMudGFza19pZCxcblx0XHRcdFx0ZXZlbnQ6IHNfa2V5LFxuXHRcdFx0XHRhcmdzOiBhX2FyZ3Nfc2VuZCxcblx0XHRcdH0sIGFfdHJhbnNmZXJfcGF0aHMpO1xuXHRcdH1cblx0fVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGNsYXNzIGRlZGljYXRlZCBleHRlbmRzIHN0cmVhbS5oYW5kbGVyIHtcblx0Y29uc3RydWN0b3IoaF90YXNrcywgZl9pbml0PW51bGwpIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHR0YXNrczogaF90YXNrcyxcblx0XHRcdHN0b3JlOiB7fSxcblx0XHRcdHJlc3VsdHM6IHt9LFxuXHRcdFx0cG9ydDogS19TRUxGLFxuXHRcdFx0aWQ6IEtfU0VMRi5hcmdzWzBdLFxuXHRcdH0pO1xuXG5cdFx0S19TRUxGLm9uKCdlcnJvcicsIChlX3dvcmtlcikgPT4ge1xuXHRcdFx0dGhpcy50aHJvdyhlX3dvcmtlcik7XG5cdFx0fSk7XG5cblx0XHR0aGlzLnNldF9wb3J0KEtfU0VMRik7XG5cblx0XHQvLyBpbml0IGZ1bmN0aW9uXG5cdFx0aWYoZl9pbml0KSBmX2luaXQoS19TRUxGLmFyZ3Muc2xpY2UoMSkpO1xuXHR9XG5cblx0ZGVidWcoc190YWcsIHNfdHlwZSwgLi4uYV9pbmZvKSB7XG5cdFx0Y29uc29sZS53YXJuKGBbJHtzX3RhZ31dIGAud2hpdGUrYFMke3RoaXMuaWR9YC55ZWxsb3crYCAke3NfdHlwZX0gJHthX2luZm8ubGVuZ3RoPyAnKCcrYV9pbmZvLmpvaW4oJywgJykrJyknOiAnLSd9YCk7XG5cdH1cblxuXHQvLyByZXNvbHZlcyBwcm9taXNlcyBhbmQgd3JhcHMgcmVzdWx0c1xuXHRyZXNvbHZlKHpfcmVzdWx0LCBma19yZXNvbHZlKSB7XG5cdFx0Ly8gYSBwcm9taXNlIHdhcyByZXR1cm5lZFxuXHRcdGlmKHpfcmVzdWx0IGluc3RhbmNlb2YgUHJvbWlzZSkge1xuXHRcdFx0el9yZXN1bHRcblx0XHRcdFx0Ly8gb25jZSBpdHMgcmVhZHk7IHJlc29sdmUgdXNpbmcgcmVzdWx0XG5cdFx0XHRcdC50aGVuKCh6X2RhdGEpID0+IHtcblx0XHRcdFx0XHRma19yZXNvbHZlKHJlc3VsdC5mcm9tKHpfZGF0YSkpO1xuXHRcdFx0XHR9KVxuXHRcdFx0XHQvLyBvciBjYXRjaCBpZiB0aGVyZSB3YXMgYSBzeW50YXggZXJyb3IgLyBldGMuXG5cdFx0XHRcdC5jYXRjaCgoZV9yZXNvbHZlKSA9PiB7XG5cdFx0XHRcdFx0dGhpcy50aHJvdyhlX3Jlc29sdmUpO1xuXHRcdFx0XHR9KTtcblx0XHR9XG5cdFx0Ly8gc3luY1xuXHRcdGVsc2Uge1xuXHRcdFx0cmV0dXJuIGZrX3Jlc29sdmUocmVzdWx0LmZyb20oel9yZXN1bHQpKTtcblx0XHR9XG5cdH1cblxuXHR0aHJvdyhlX3Rocm93KSB7XG5cdFx0dGhpcy5wb3J0LnBvc3RNZXNzYWdlKHtcblx0XHRcdHR5cGU6ICdlcnJvcicsXG5cdFx0XHRlcnJvcjoge1xuXHRcdFx0XHRtZXNzYWdlOiBlX3Rocm93Lm1lc3NhZ2UsXG5cdFx0XHRcdHN0YWNrOiBlX3Rocm93LnN0YWNrLFxuXHRcdFx0fSxcblx0XHR9KTtcblx0fVxuXG5cdC8vIHR5cGljYWwgZXhlY3V0ZS1hbmQtcmVzcG9uZCB0YXNrXG5cdGhhbmRsZV90YXNrKGhfbXNnKSB7XG5cdFx0bGV0IGhfdGFza3MgPSB0aGlzLnRhc2tzO1xuXG5cdFx0bGV0IHtcblx0XHRcdGlkOiBpX3Rhc2ssXG5cdFx0XHR0YXNrOiBzX3Rhc2ssXG5cdFx0XHRhcmdzOiBhX2FyZ3MsXG5cdFx0XHRpbmhlcml0OiBpX2luaGVyaXQ9MCxcblx0XHRcdHJlY2VpdmU6IGlfcmVjZWl2ZT0wLFxuXHRcdFx0aG9sZDogYl9ob2xkPWZhbHNlLFxuXHRcdFx0ZXZlbnRzOiBoX2V2ZW50cz17fSxcblx0XHRcdGRlYnVnOiBzX2RlYnVnLFxuXHRcdH0gPSBoX21zZztcblxuXHRcdHRoaXMuaW5mbyA9IGhfbXNnO1xuXG5cdFx0aWYoc19kZWJ1ZykgdGhpcy5kZWJ1ZyhzX2RlYnVnLCAnPDwgdGFzazonK3NfdGFzaywgaV90YXNrKTtcblxuXHRcdC8vIG5vIHN1Y2ggdGFza1xuXHRcdGlmKCEoc190YXNrIGluIGhfdGFza3MpKSB7XG5cdFx0XHRyZXR1cm4gdGhpcy50aHJvdyhuZXcgRXJyb3IoYGRlZGljYXRlZCB3b3JrZXIgaGFzIG5vIHN1Y2ggdGFzayByZWdpc3RlcmVkIGFzICcke3NfdGFza30nYCkpO1xuXHRcdH1cblxuXHRcdC8vIGluaGVyaXQgc3RvcmUgZnJvbSBwcmV2aW91cyB0YXNrXG5cdFx0aWYoaV9pbmhlcml0KSB7XG5cdFx0XHRsZXQgaF9zdG9yZSA9IHRoaXMuc3RvcmU7XG5cdFx0XHRoX3N0b3JlW2lfdGFza10gPSBoX3N0b3JlW2lfaW5oZXJpdF07XG5cdFx0XHRkZWxldGUgaF9zdG9yZVtpX2luaGVyaXRdO1xuXHRcdH1cblxuXHRcdC8vIHJlY2VpdmUgZGF0YSBmcm9tIHByZXZpb3VzIHRhc2tcblx0XHRpZihpX3JlY2VpdmUpIHtcblx0XHRcdGxldCBoX3Jlc3VsdHMgPSB0aGlzLnJlc3VsdHM7XG5cblx0XHRcdC8vIHB1c2ggdG8gZnJvbnQgb2YgYXJnc1xuXHRcdFx0YV9hcmdzLnVuc2hpZnQoaF9yZXN1bHRzW2lfcmVjZWl2ZV0uZGF0YVswXSk7XG5cblx0XHRcdC8vIGZyZWUgdG8gZ2Ncblx0XHRcdGRlbGV0ZSBoX3Jlc3VsdHNbaV9yZWNlaXZlXTtcblx0XHR9XG5cblx0XHQvLyBleGVjdXRlIGdpdmVuIHRhc2tcblx0XHRsZXQgel9yZXN1bHQ7XG5cblx0XHQvLyBkZWJ1Z2dpbmcsIGFsbG93IGVycm9yIHRvIGJlIHRocm93blxuXHRcdGlmKHNfZGVidWcpIHtcblx0XHRcdHpfcmVzdWx0ID0gaF90YXNrc1tzX3Rhc2tdLmFwcGx5KG5ldyBoZWxwZXIodGhpcywgaV90YXNrLCBoX2V2ZW50cyksIGFfYXJncyk7XG5cdFx0fVxuXHRcdC8vIGNhdGNoIGFuZCBwYXNzIGVycm9yIHRvIG1hc3RlclxuXHRcdGVsc2Uge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0el9yZXN1bHQgPSBoX3Rhc2tzW3NfdGFza10uYXBwbHkobmV3IGhlbHBlcih0aGlzLCBpX3Rhc2ssIGhfZXZlbnRzKSwgYV9hcmdzKTtcblx0XHRcdH1cblx0XHRcdGNhdGNoKGVfZXhlYykge1xuXHRcdFx0XHRlX2V4ZWMubWVzc2FnZSA9IGB3b3JrZXIgdGhyZXcgYW4gZXJyb3Igd2hpbGUgZXhlY3V0aW5nIHRhc2sgJyR7c190YXNrfSc6XFxuJHtlX2V4ZWMubWVzc2FnZX1gO1xuXHRcdFx0XHRyZXR1cm4gdGhpcy50aHJvdyhlX2V4ZWMpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIGhvbGQgcmVzdWx0IGRhdGEgYW5kIGF3YWl0IGZ1cnRoZXIgaW5zdHJ1Y3Rpb25zIGZyb20gbWFzdGVyXG5cdFx0aWYoYl9ob2xkKSB7XG5cdFx0XHR0aGlzLnJlc29sdmUoel9yZXN1bHQsIChrX3Jlc3VsdCkgPT4ge1xuXHRcdFx0XHQvLyBzdG9yZSByZXN1bHRcblx0XHRcdFx0dGhpcy5yZXN1bHRzW2lfdGFza10gPSBrX3Jlc3VsdDtcblxuXHRcdFx0XHQvLyBzdWJtaXQgbm90aWZpY2F0aW9uIHRvIG1hc3RlclxuXHRcdFx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0XHRcdHR5cGU6ICdub3RpZnknLFxuXHRcdFx0XHRcdGlkOiBpX3Rhc2ssXG5cdFx0XHRcdFx0ZGVidWc6IHNfZGVidWcsXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdGlmKHNfZGVidWcpIHRoaXMuZGVidWcoc19kZWJ1ZywgJz4+IG5vdGlmeScucmVkLCBpX3Rhc2spO1xuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdC8vIHNlbmQgcmVzdWx0IGJhY2sgdG8gbWFzdGVyIGFzIHNvb24gYXMgaXRzIHJlYWR5XG5cdFx0ZWxzZSB7XG5cdFx0XHR0aGlzLnJlc29sdmUoel9yZXN1bHQsIChrX3Jlc3VsdCkgPT4ge1xuXHRcdFx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0XHRcdHR5cGU6ICdyZXNwb25kJyxcblx0XHRcdFx0XHRpZDogaV90YXNrLFxuXHRcdFx0XHRcdGRhdGE6IGtfcmVzdWx0LmRhdGFbMF0sXG5cdFx0XHRcdFx0ZGVidWc6IHNfZGVidWcsXG5cdFx0XHRcdH0sIGtfcmVzdWx0LnBhdGhzKCdkYXRhJykpO1xuXG5cdFx0XHRcdGlmKHNfZGVidWcpIHRoaXMuZGVidWcoc19kZWJ1ZywgJz4+IHJlc3BvbmQnLnJlZCwgaV90YXNrKTtcblx0XHRcdH0pO1xuXHRcdH1cblx0fVxuXG5cdC8vIHNlbmQgcmVzdWx0IGRhdGEgdG8gc2libGluZ1xuXHRoYW5kbGVfcmVsYXkoaF9tc2cpIHtcblx0XHRsZXQgaF9yZXN1bHRzID0gdGhpcy5yZXN1bHRzO1xuXG5cdFx0bGV0IHtcblx0XHRcdGlkOiBpX3Rhc2ssXG5cdFx0XHRwb3J0OiBkX3BvcnQsXG5cdFx0XHRkZWJ1Zzogc19kZWJ1Zyxcblx0XHR9ID0gaF9tc2c7XG5cblx0XHQvLyBjb25zb2xlLmRpcihkX3BvcnQpO1xuXHRcdGlmKHNfZGVidWcpIHRoaXMuZGVidWcoc19kZWJ1ZywgJzw8IHJlbGF5JywgaV90YXNrLCBkX3BvcnQubmFtZSk7XG5cblx0XHQvLyBncmFiIHJlc3VsdFxuXHRcdGxldCBrX3Jlc3VsdCA9IGhfcmVzdWx0c1tpX3Rhc2tdO1xuXG5cdFx0Ly8gZm9yd2FyZCB0byBnaXZlbiBwb3J0XG5cdFx0ZF9wb3J0LnBvc3RNZXNzYWdlKHtcblx0XHRcdHR5cGU6ICd0cmFuc2ZlcicsXG5cdFx0XHRzZW5kZXI6IGlfdGFzayxcblx0XHRcdGRhdGE6IGtfcmVzdWx0LmRhdGFbMF0sXG5cdFx0fSwga19yZXN1bHQudHJhbnNmZXJfcGF0aHMubWFwKGEgPT4gYS51bnNoaWZ0KCdkYXRhJykpKTtcblxuXHRcdC8vIGZyZWUgdG8gZ2Ncblx0XHRkZWxldGUgaF9yZXN1bHRzW2lfdGFza107XG5cdH1cblxuXHQvLyByZWNlaXZlIGRhdGEgZnJvbSBzaWJsaW5nIGFuZCB0aGVuIGV4ZWN1dGUgcmVhZHkgdGFza1xuXHRoYW5kbGVfcmVjZWl2ZShoX21zZykge1xuXHRcdGxldCB7XG5cdFx0XHRwb3J0OiBkX3BvcnQsXG5cdFx0XHRpbXBvcnQ6IGlfaW1wb3J0LFxuXHRcdFx0cHJpbWFyeTogYl9wcmltYXJ5LFxuXHRcdFx0c2VuZGVyOiBpX3NlbmRlcixcblx0XHRcdHRhc2tfcmVhZHk6IGhfdGFza19yZWFkeSxcblx0XHRcdGRlYnVnOiBzX2RlYnVnLFxuXHRcdH0gPSBoX21zZztcblxuXHRcdC8vIGFjY2VwdCBwb3J0XG5cdFx0cG9ydHMoZF9wb3J0KTtcblxuXHRcdGlmKHNfZGVidWcpIHRoaXMuZGVidWcoc19kZWJ1ZywgJzw8IHJlY2VpdmU6JytpX2ltcG9ydCwgaF90YXNrX3JlYWR5LmlkLCBkX3BvcnQubmFtZSk7XG5cblx0XHQvLyBpbXBvcnQgZGF0YVxuXHRcdGxldCB6X2RhdGFfaW1wb3J0ID0gdGhpcy5yZXN1bHRzW2lfaW1wb3J0XS5kYXRhWzBdO1xuXG5cdFx0Ly8gZnJlZSB0byBnY1xuXHRcdGRlbGV0ZSB0aGlzLnJlc3VsdHNbaV9pbXBvcnRdO1xuXG5cdFx0Ly8gdGFzayByZWFkeSBhcmdzXG5cdFx0bGV0IGFfYXJnc190YXNrX3JlYWR5ID0gaF90YXNrX3JlYWR5LmFyZ3M7XG5cblx0XHQvLyBpbXBvcnQgaXMgc2Vjb25kYXJ5XG5cdFx0aWYoIWJfcHJpbWFyeSkgYV9hcmdzX3Rhc2tfcmVhZHkudW5zaGlmdCh6X2RhdGFfaW1wb3J0KTtcblxuXHRcdGlmKHNfZGVidWcpIHRoaXMuZGVidWcoc19kZWJ1ZywgJ3NldHVwJywgdXRpbC5pbnNwZWN0KGFfYXJnc190YXNrX3JlYWR5LCB7ZGVwdGg6bnVsbH0pKTtcblxuXHRcdC8vIHNldCB1cCBtZXNzYWdlIGxpc3RlbmVyIG9uIHBvcnRcblx0XHRsZXQgZmtfbWVzc2FnZSA9IChkX21zZ19yZWNlaXZlKSA9PiB7XG5cdFx0XHRsZXQgaF9tc2dfcmVjZWl2ZSA9IGRfbXNnX3JlY2VpdmUuZGF0YTtcblxuXHRcdFx0Ly8gbWF0Y2hpbmcgc2VuZGVyXG5cdFx0XHRpZihpX3NlbmRlciA9PT0gaF9tc2dfcmVjZWl2ZS5zZW5kZXIpIHtcblx0XHRcdFx0aWYoc19kZWJ1ZykgdGhpcy5kZWJ1ZyhzX2RlYnVnLCAnPDwgcmVsYXkvcmVjZWl2ZScsIGlfc2VuZGVyLCBkX3BvcnQubmFtZSk7XG5cblx0XHRcdFx0Ly8gdW5iaW5kIGxpc3RlbmVyXG5cdFx0XHRcdGRfcG9ydC5yZW1vdmVMaXN0ZW5lcignbWVzc2FnZScsIGZrX21lc3NhZ2UpO1xuXG5cdFx0XHRcdC8vIHB1c2ggbWVzc2FnZSB0byBmcm9udCBvZiBhcmdzXG5cdFx0XHRcdGFfYXJnc190YXNrX3JlYWR5LnVuc2hpZnQoaF9tc2dfcmVjZWl2ZS5kYXRhKTtcblxuXHRcdFx0XHQvLyBpbXBvcnQgaXMgcHJpbWFyeVxuXHRcdFx0XHRpZihiX3ByaW1hcnkpIGFfYXJnc190YXNrX3JlYWR5LnVuc2hpZnQoel9kYXRhX2ltcG9ydCk7XG5cblx0XHRcdFx0Ly8gZmlyZSByZWFkeSB0YXNrXG5cdFx0XHRcdHRoaXMuaGFuZGxlX3Rhc2soaF90YXNrX3JlYWR5KTtcblx0XHRcdH1cblx0XHRcdGVsc2Uge1xuXHRcdFx0XHRpZihzX2RlYnVnKSB0aGlzLmRlYnVnKHNfZGVidWcsICdpZ25vcmluZyAnK2hfbXNnX3JlY2VpdmUuc2VuZGVyKycgIT0gJytpX3NlbmRlcik7XG5cdFx0XHR9XG5cdFx0fTtcblxuXHRcdC8vIGJpbmQgbGlzdGVuZXJcblx0XHRkX3BvcnQub24oJ21lc3NhZ2UnLCBma19tZXNzYWdlKTtcblx0fVxuXG5cdGhhbmRsZV9waW5nKCkge1xuXHRcdHRoaXMucG9ydC5wb3N0TWVzc2FnZSh7XG5cdFx0XHR0eXBlOiAncG9uZycsXG5cdFx0fSk7XG5cdH1cblxuXHRoYW5kbGVfb3duZXIoaF9tc2cpIHtcblx0XHR0aGlzLnNldF9wb3J0KHBvcnRzKGhfbXNnLnBvcnQpKTtcblx0fVxuXG5cdGhhbmRsZV9zdWJ3b3JrZXIoaF9tc2cpIHtcblx0XHRyZXF1aXJlKCcuLi9icm93c2VyL2xhdGVudC1zdWJ3b3JrZXIuanMnKS5jb25uZWN0KGhfbXNnKTtcblx0fVxuXG5cdHNldF9wb3J0KGRfcG9ydCkge1xuXHRcdHRoaXMucG9ydCA9IGRfcG9ydDtcblxuXHRcdGRfcG9ydC5vbignbWVzc2FnZScsIChkX21zZykgPT4ge1xuXHRcdFx0Ly8gZGVidWdnZXI7XG5cdFx0XHRsZXQgaF9tc2cgPSBkX21zZy5kYXRhO1xuXG5cdFx0XHQvLyBoYW5kbGUgbWVzc2FnZVxuXHRcdFx0bGV0IHNfaGFuZGxlID0gJ2hhbmRsZV8nK2hfbXNnLnR5cGU7XG5cdFx0XHRpZihzX2hhbmRsZSBpbiB0aGlzKSB7XG5cdFx0XHRcdHRoaXNbc19oYW5kbGVdKGhfbXNnKTtcblx0XHRcdH1cblx0XHRcdC8vIG1pc3NpbmcgaGFuZGxlIG5hbWUgaW4gbWVzc2FnZVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcignZGVkaWNhdGVkIHdvcmtlciByZWNlaXZlZCBhIG1lc3NhZ2UgaXQgZG9lcyBub3Qga25vdyBob3cgdG8gaGFuZGxlOiAnK2RfbXNnKTtcblx0XHRcdH1cblx0XHR9KTtcblx0fVxufTtcbiIsImNvbnN0IHtcblx0SFBfV09SS0VSX05PVElGSUNBVElPTixcblx0RENfQ0hBTk5FTCxcbn0gPSByZXF1aXJlKCcuL2xvY2Fscy5qcycpO1xuXG5jb25zdCBtYW5pZmVzdCA9IHJlcXVpcmUoJy4vbWFuaWZlc3QuanMnKTtcblxuXG5jb25zdCBYTV9TVFJBVEVHWV9FUVVBTCA9IDEgPDwgMDtcblxuY29uc3QgWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQkFMQU5DRUQgPSAxIDw8IDI7XG5jb25zdCBYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQU19CSUFTRUQgPSAxIDw8IDM7XG5cbmNvbnN0IFhNX1NUUkFURUdZX09SREVSRURfR1JPVVBTID0gWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQkFMQU5DRUQgfCBYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQU19CSUFTRUQ7XG5cbmNvbnN0IFhNX0RJU1RSSUJVVElPTl9DT05TVEFOVCA9IDEgPDwgMDtcblxuXG5jbGFzcyBhcm1lZF9ncm91cCB7XG5cdGNvbnN0cnVjdG9yKGtfZ3JvdXAsIGFfc3Vic2V0cykge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0Z3JvdXA6IGtfZ3JvdXAsXG5cdFx0XHRzdWJzZXRzOiBhX3N1YnNldHMsXG5cdFx0fSk7XG5cdH1cblxuXHRtYXAoc190YXNrLCB6X2FyZ3M9W10sIGhfZXZlbnRzX21hcD17fSwgc19kZWJ1Zz1udWxsKSB7XG5cdFx0bGV0IHtcblx0XHRcdGdyb3VwOiBrX2dyb3VwLFxuXHRcdFx0c3Vic2V0czogYV9zdWJzZXRzLFxuXHRcdH0gPSB0aGlzO1xuXG5cdFx0Ly8gaG93IG1hbnkgc3Vic2V0cyB0byBwcm9jZXNzXG5cdFx0bGV0IG5sX3N1YnNldHMgPSBhX3N1YnNldHMubGVuZ3RoO1xuXG5cdFx0Ly8gcHJlcGFyZSB0byBkZWFsIHdpdGggcmVzdWx0c1xuXHRcdGxldCBrX2FjdGlvbiA9IG5ldyBhY3RpdmVfZ3JvdXAoa19ncm91cCwgbmxfc3Vic2V0cyk7XG5cblx0XHQvLyBjcmVhdGUgbWFuaWZlc3Qgb2JqZWN0XG5cdFx0bGV0IGtfbWFuaWZlc3QgPSBtYW5pZmVzdC5mcm9tKHpfYXJncyk7XG5cblx0XHQvLyBubyBzdWJzZXRzXG5cdFx0aWYoIW5sX3N1YnNldHMpIHtcblx0XHRcdHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHQvLyByZXN1bHQgaGFuZGxlciB3YXMgbm90IHVzZWQ7IGF1dG8tZW5kIGl0XG5cdFx0XHRcdGlmKCFrX2FjdGlvbi5waXBlZCkga19hY3Rpb24uZW5kKCk7XG5cblx0XHRcdFx0Ly8gZm9yY2UgZW5kIHN0cmVhbVxuXHRcdFx0XHRrX2FjdGlvbi5mb3JjZV9lbmQoKTtcblx0XHRcdH0sIDApO1xuXHRcdH1cblx0XHQvLyB5ZXMgc3Vic2V0c1xuXHRcdGVsc2Uge1xuXHRcdFx0Ly8gc3VtbW9uIHdvcmtlcnMgYXMgdGhleSBiZWNvbWUgYXZhaWxhYmxlXG5cdFx0XHRrX2dyb3VwLnN1bW1vbl93b3JrZXJzKG5sX3N1YnNldHMsIChrX3dvcmtlciwgaV9zdWJzZXQpID0+IHtcblx0XHRcdFx0Ly8gaWYoaF9kaXNwYXRjaC5kZWJ1ZykgZGVidWdnZXI7XG5cblx0XHRcdFx0Ly8gcmVzdWx0IGhhbmRsZXIgd2FzIG5vdCB1c2VkOyBhdXRvLWVuZCBpdFxuXHRcdFx0XHRpZigha19hY3Rpb24ucGlwZWQpIGtfYWN0aW9uLmVuZCgpO1xuXG5cdFx0XHRcdC8vIG1ha2UgcmVzdWx0IGhhbmRsZXJcblx0XHRcdFx0bGV0IGZrX3Jlc3VsdCA9IGtfYWN0aW9uLm1rX3Jlc3VsdChrX3dvcmtlciwgaV9zdWJzZXQpO1xuXG5cdFx0XHRcdC8vIG1ha2Ugd29ya2VyLXNwZWNpZmljIGV2ZW50c1xuXHRcdFx0XHRsZXQgaF9ldmVudHNfd29ya2VyID0gdGhpcy5ldmVudF9yb3V0ZXIoaF9ldmVudHNfbWFwLCBpX3N1YnNldCk7XG5cblx0XHRcdFx0Ly8gcHVzaCBzdWJzZXQgdG8gZnJvbnQgb2YgYXJnc1xuXHRcdFx0XHRsZXQga19tYW5pZmVzdF93b3JrZXIgPSBrX21hbmlmZXN0LnByZXBlbmQoYV9zdWJzZXRzW2lfc3Vic2V0XSk7XG5cblx0XHRcdFx0Ly8gZXhlY3V0ZSB3b3JrZXIgb24gbmV4dCBwYXJ0IG9mIGRhdGFcblx0XHRcdFx0a193b3JrZXIuZXhlYyh7XG5cdFx0XHRcdFx0dGFzazogc190YXNrLFxuXHRcdFx0XHRcdG1hbmlmZXN0OiBrX21hbmlmZXN0X3dvcmtlcixcblx0XHRcdFx0XHRob2xkOiBrX2FjdGlvbi51cHN0cmVhbV9ob2xkLFxuXHRcdFx0XHRcdGV2ZW50czogaF9ldmVudHNfd29ya2VyLFxuXHRcdFx0XHR9LCBma19yZXN1bHQpO1xuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0Ly8gbGV0IHVzZXIgYmluZCBhIGhhbmRsZXJcblx0XHRyZXR1cm4ga19hY3Rpb247XG5cdH1cblxuXHRldmVudF9yb3V0ZXIoaF9ldmVudHMsIGlfc3Vic2V0KSB7XG5cdFx0aWYoIWhfZXZlbnRzKSByZXR1cm4gbnVsbDtcblxuXHRcdC8vIG1ha2UgYSBuZXcgaGFzaCB0aGF0IHB1c2hlcyB3b3JrZXIgaW5kZXggaW4gZnJvbnQgb2YgY2FsbGJhY2sgYXJnc1xuXHRcdGxldCBoX2V2ZW50c19sb2NhbCA9IHt9O1xuXHRcdGZvcihsZXQgc19ldmVudCBpbiBoX2V2ZW50cykge1xuXHRcdFx0bGV0IGZfZXZlbnQgPSBoX2V2ZW50c1tzX2V2ZW50XTtcblx0XHRcdGhfZXZlbnRzX2xvY2FsW3NfZXZlbnRdID0gKC4uLmFfYXJncykgPT4ge1xuXHRcdFx0XHRmX2V2ZW50KGlfc3Vic2V0LCAuLi5hX2FyZ3MpO1xuXHRcdFx0fTtcblx0XHR9XG5cblx0XHRyZXR1cm4gaF9ldmVudHNfbG9jYWw7XG5cdH1cbn1cblxuXG5jbGFzcyBhY3RpdmVfZ3JvdXAge1xuXHRjb25zdHJ1Y3RvcihrX2dyb3VwLCBuX3Rhc2tzLCBmX3B1c2g9bnVsbCkge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0Z3JvdXA6IGtfZ3JvdXAsXG5cdFx0XHR0YXNrX2NvdW50OiBuX3Rhc2tzLFxuXG5cdFx0XHQvLyB3aGV0aGVyIG9yIG5vdCB0aGUgdXNlciBoYXMgcm91dGVkIHRoaXMgc3RyZWFtIHlldFxuXHRcdFx0cGlwZWQ6IGZhbHNlLFxuXG5cdFx0XHQvLyBsaW5rIHRvIG5leHQgYWN0aW9uIGRvd25zdHJlYW1cblx0XHRcdGRvd25zdHJlYW06IG51bGwsXG5cblx0XHRcdC8vIHdoZXRoZXIgb3Igbm90IHRoZSBhY3Rpb24gdXBzdHJlYW0gc2hvdWxkIGhvbGQgZGF0YSBpbiB3b3JrZXJcblx0XHRcdHVwc3RyZWFtX2hvbGQ6IGZhbHNlLFxuXG5cdFx0XHRyZXN1bHRfY291bnQ6IDAsXG5cblx0XHRcdHJlc3VsdF9jYWxsYmFjazogbnVsbCxcblx0XHRcdGNvbXBsZXRlX2NhbGxiYWNrOiBudWxsLFxuXG5cdFx0XHRwdXNoOiBmX3B1c2ggfHwgKCgpID0+IHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBjYW5ub3QgJy5wdXNoKCknIGhlcmVgKTtcblx0XHRcdH0pLFxuXHRcdFx0Y2Fycnk6IG51bGwsXG5cblx0XHRcdHJlZHVjdGlvbnM6IG51bGwsXG5cdFx0XHRyZWR1Y2VfdGFzazogbnVsbCxcblxuXHRcdFx0cmVzdWx0czogbnVsbCxcblx0XHRcdHNlcXVlbmNlX2luZGV4OiAwLFxuXHRcdH0pO1xuXHR9XG5cblx0dGhydShzX3Rhc2ssIHpfYXJncz1bXSwgaF9ldmVudHM9bnVsbCkge1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0cGlwZWQ6IHRydWUsXG5cdFx0XHRyb3V0ZTogdGhpcy5yb3V0ZV90aHJ1LFxuXHRcdFx0dXBzdHJlYW1faG9sZDogdHJ1ZSxcblx0XHRcdG5leHRfdGFzazoge1xuXHRcdFx0XHR0YXNrOiBzX3Rhc2ssXG5cdFx0XHRcdG1hbmlmZXN0OiBtYW5pZmVzdC5mcm9tKHpfYXJncyksXG5cdFx0XHRcdGV2ZW50czogaF9ldmVudHMsXG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0cmV0dXJuIHRoaXMuY29tcGxldGFibGUoKTtcblx0fVxuXG5cdGVhY2goZmtfcmVzdWx0LCBma19jb21wbGV0ZT1udWxsKSB7XG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRwaXBlZDogdHJ1ZSxcblx0XHRcdHJvdXRlOiB0aGlzLnJvdXRlX2VhY2gsXG5cdFx0XHRyZXN1bHRfY2FsbGJhY2s6IGZrX3Jlc3VsdCxcblx0XHRcdGNvbXBsZXRlX2NhbGxiYWNrOiBma19jb21wbGV0ZSxcblx0XHR9KTtcblxuXHRcdHJldHVybiB0aGlzLmNvbXBsZXRhYmxlKCk7XG5cdH1cblxuXHRzZXJpZXMoZmtfcmVzdWx0LCBma19jb21wbGV0ZT1udWxsKSB7XG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRwaXBlZDogdHJ1ZSxcblx0XHRcdHJvdXRlOiB0aGlzLnJvdXRlX3Nlcmllcyxcblx0XHRcdHJlc3VsdF9jYWxsYmFjazogZmtfcmVzdWx0LFxuXHRcdFx0Y29tcGxldGVfY2FsbGJhY2s6IGZrX2NvbXBsZXRlLFxuXHRcdFx0cmVzdWx0czogbmV3IEFycmF5KHRoaXMudGFza19jb3VudCksXG5cdFx0fSk7XG5cblx0XHRyZXR1cm4gdGhpcy5jb21wbGV0YWJsZSgpO1xuXHR9XG5cblx0cmVkdWNlKHNfdGFzaywgel9hcmdzPVtdLCBoX2V2ZW50cz1udWxsLCBzX2RlYnVnPW51bGwpIHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSkgPT4ge1xuXHRcdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRcdGRlYnVnOiBzX2RlYnVnLFxuXHRcdFx0XHRwaXBlZDogdHJ1ZSxcblx0XHRcdFx0cm91dGU6IHRoaXMucm91dGVfcmVkdWNlLFxuXHRcdFx0XHRjb21wbGV0ZV9jYWxsYmFjazogZl9yZXNvbHZlLFxuXHRcdFx0XHR1cHN0cmVhbV9ob2xkOiB0aGlzLnRhc2tfY291bnQgPiAxLCAgLy8gc2V0IGBob2xkYCBmbGFnIGZvciB1cHN0cmVhbSBzZW5kaW5nIGl0cyB0YXNrXG5cdFx0XHRcdHJlZHVjdGlvbnM6IG5ldyBjb252ZXJnZW50X3BhaXJ3aXNlX3RyZWUodGhpcy50YXNrX2NvdW50KSxcblx0XHRcdFx0cmVkdWNlX3Rhc2s6IHtcblx0XHRcdFx0XHR0YXNrOiBzX3Rhc2ssXG5cdFx0XHRcdFx0bWFuaWZlc3Q6IG5ldyBtYW5pZmVzdCh6X2FyZ3MpLFxuXHRcdFx0XHRcdGV2ZW50czogaF9ldmVudHMsXG5cdFx0XHRcdFx0aG9sZDogdHJ1ZSwgIC8vIGFzc3VtZSBhbm90aGVyIHJlZHVjdGlvbiB3aWxsIGJlIHBlcmZvcm1lZCBieSBkZWZhdWx0XG5cdFx0XHRcdH0sXG5cdFx0XHR9KTtcblx0XHR9KTtcblx0fVxuXG5cdC8vIHJlc3VsdHMgbm90IGhhbmRsZWRcblx0cm91dGUoKSB7XG5cdFx0Y29uc29sZS53YXJuKCdyZXN1bHQgZnJvbSB3b3JrZXIgd2FzIG5vdCBoYW5kbGVkISBtYWtlIHN1cmUgdG8gYmluZCBhIGhhbmRsZXIgYmVmb3JlIGdvaW5nIGFzeW5jLiB1c2UgYC5pZ25vcmUoKWAgaWYgeW91IGRvIG5vdCBjYXJlIGFib3V0IHRoZSByZXN1bHQnKTtcblx0fVxuXG5cdHJvdXRlX3RocnUoaHBfbm90aWZpY2F0aW9uLCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzaykge1xuXHRcdC8vIGNyZWF0ZSBzcGVjaWZpYyB0YXNrIGZvciB3b3JrZXIgdG8gcmVjZWl2ZSBkYXRhIGZyb20gaXRzIHByZXZpb3VzIHRhc2tcblx0XHRsZXQgaF90YXNrID0gT2JqZWN0LmFzc2lnbih7XG5cdFx0XHRyZWNlaXZlOiBpX3Rhc2ssXG5cdFx0XHRob2xkOiB0aGlzLmRvd25zdHJlYW0udXBzdHJlYW1faG9sZCxcblx0XHR9LCB0aGlzLm5leHRfdGFzayk7XG5cblx0XHQvLyBhc3NpZ24gd29ya2VyIG5ldyB0YXNrXG5cdFx0dGhpcy5ncm91cC5hc3NpZ25fd29ya2VyKGtfd29ya2VyLCBoX3Rhc2ssICguLi5hX2FyZ3MpID0+IHtcblx0XHRcdC8vIG1rIHJlc3VsdFxuXHRcdFx0bGV0IGZfcmVzdWx0ID0gdGhpcy5kb3duc3RyZWFtLm1rX3Jlc3VsdChrX3dvcmtlciwgaV9zdWJzZXQpO1xuXG5cdFx0XHQvLyB0cmlnZ2VyIHJlc3VsdFxuXHRcdFx0Zl9yZXN1bHQoLi4uYV9hcmdzKTtcblx0XHR9KTtcblx0fVxuXG5cdC8vIHJldHVybiByZXN1bHRzIGltbWVkaWF0ZWx5XG5cdHJvdXRlX2VhY2goel9yZXN1bHQsIGlfc3Vic2V0LCBrX3dvcmtlciwgaV90YXNrKSB7XG5cdFx0dGhpcy5oYW5kbGVfcmVzdWx0X2NhbGxiYWNrKHpfcmVzdWx0LCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzayk7XG5cblx0XHQvLyB0aGlzIHdhcyB0aGUgbGFzdCByZXN1bHRcblx0XHRpZigrK3RoaXMucmVzdWx0X2NvdW50ID09PSB0aGlzLnRhc2tfY291bnQgJiYgJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIHRoaXMuY29tcGxldGVfY2FsbGJhY2spIHtcblx0XHRcdHRoaXMuY29tcGxldGVfY2FsbGJhY2soKTtcblx0XHR9XG5cdH1cblxuXHRyb3V0ZV9zZXJpZXMoel9yZXN1bHQsIGlfc3Vic2V0LCBrX3dvcmtlciwgaV90YXNrKSB7XG5cdFx0bGV0IHtcblx0XHRcdHRhc2tfY291bnQ6IG5fdGFza3MsXG5cdFx0XHRyZXN1bHRfY2FsbGJhY2s6IGZrX3Jlc3VsdCxcblx0XHRcdHNlcXVlbmNlX2luZGV4OiBpX3NlcXVlbmNlLFxuXHRcdFx0cmVzdWx0czogYV9yZXN1bHRzLFxuXHRcdH0gPSB0aGlzO1xuXG5cdFx0Ly8gcmVzdWx0IGFycml2ZWQgd2hpbGUgd2Ugd2VyZSB3YWl0aW5nIGZvciBpdFxuXHRcdGlmKGlfc3Vic2V0ID09PSBpX3NlcXVlbmNlKSB7XG5cdFx0XHQvLyB3aGlsZSB0aGVyZSBhcmUgcmVzdWx0cyB0byBwcm9jZXNzXG5cdFx0XHRmb3IoOzspIHtcblx0XHRcdFx0Ly8gcHJvY2VzcyByZXN1bHRcblx0XHRcdFx0dGhpcy5oYW5kbGVfcmVzdWx0X2NhbGxiYWNrKHpfcmVzdWx0LCBpX3NlcXVlbmNlLCBrX3dvcmtlciwgaV90YXNrKTtcblxuXHRcdFx0XHQvLyByZWFjaGVkIGVuZCBvZiBzZXF1ZW5jZTsgdGhhdCB3YXMgbGFzdCByZXN1bHRcblx0XHRcdFx0aWYoKytpX3NlcXVlbmNlID09PSBuX3Rhc2tzKSB7XG5cdFx0XHRcdFx0Ly8gY29tcGxldGlvbiBjYWxsYmFja1xuXHRcdFx0XHRcdGlmKCdmdW5jdGlvbicgPT09IHR5cGVvZiB0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKSB7XG5cdFx0XHRcdFx0XHR0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKCk7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gZXhpdCBsb29wIGFuZCBzYXZlIHNlcXVlbmNlIGluZGV4XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBuZXh0IHJlc3VsdCBub3QgeWV0IHJlYWR5XG5cdFx0XHRcdGxldCBoX25leHRfcmVzdWx0ID0gYV9yZXN1bHRzW2lfc2VxdWVuY2VdO1xuXHRcdFx0XHRpZighaF9uZXh0X3Jlc3VsdCkgYnJlYWs7XG5cblx0XHRcdFx0Ly8gZWxzZTsgb250byBuZXh0IHJlc3VsdFxuXHRcdFx0XHR6X3Jlc3VsdD0gaF9uZXh0X3Jlc3VsdDtcblxuXHRcdFx0XHQvLyByZWxlYXNlIHRvIGdjXG5cdFx0XHRcdGFfcmVzdWx0c1tpX3NlcXVlbmNlXSA9IG51bGw7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIG5vdCB5ZXQgcmVhZHkgdG8gcHJvY2VzcyB0aGlzIHJlc3VsdFxuXHRcdGVsc2Uge1xuXHRcdFx0Ly8gc3RvcmUgaXQgZm9yIG5vd1xuXHRcdFx0YV9yZXN1bHRzW2lfc3Vic2V0XSA9IHpfcmVzdWx0O1xuXHRcdH1cblxuXHRcdC8vIHVwZGF0ZSBzZXF1ZW5jZSBpbmRleFxuXHRcdHRoaXMuc2VxdWVuY2VfaW5kZXggPSBpX3NlcXVlbmNlO1xuXHR9XG5cblx0cm91dGVfcmVkdWNlKGhwX25vdGlmaWNhdGlvbiwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spIHtcblx0XHQvLyBub2RlIGluaXRpYXRpb25cblx0XHRsZXQgaF9jYW5vcHlfbm9kZSA9IHRoaXMucmVkdWN0aW9ucy5yYXkoaV9zdWJzZXQsIHtcblx0XHRcdHdvcmtlcjoga193b3JrZXIsXG5cdFx0XHR0YXNrX2lkOiBpX3Rhc2ssXG5cdFx0fSk7XG5cblx0XHQvLyBzdGFydCBhdCBjYW5vcHkgbm9kZVxuXHRcdHRoaXMucmVkdWNlX3Jlc3VsdChocF9ub3RpZmljYXRpb24sIGhfY2Fub3B5X25vZGUpO1xuXHR9XG5cblx0Ly8gZWFjaCB0aW1lIGEgd29ya2VyIGNvbXBsZXRlc1xuXHRyZWR1Y2VfcmVzdWx0KHpfcmVzdWx0LCBoX25vZGUpIHtcblx0XHRsZXQge1xuXHRcdFx0Z3JvdXA6IGtfZ3JvdXAsXG5cdFx0XHRyZWR1Y3Rpb25zOiBrX3BhaXJ3aXNlX3RyZWUsXG5cdFx0XHRyZWR1Y2VfdGFzazogaF90YXNrX3JlYWR5LFxuXHRcdH0gPSB0aGlzO1xuXG5cdFx0Ly8gZmluYWwgcmVzdWx0XG5cdFx0aWYoSFBfV09SS0VSX05PVElGSUNBVElPTiAhPT0gel9yZXN1bHQpIHtcblx0XHRcdGxldCB6X2NvbXBsZXRpb24gPSB0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKHpfcmVzdWx0KTtcblxuXHRcdFx0Ly8gYWRkIHRvIG91dGVyIHN0cmVhbVxuXHRcdFx0aWYoel9jb21wbGV0aW9uIGluc3RhbmNlb2YgYWN0aXZlX2dyb3VwKSB7XG5cdFx0XHRcdGxldCBrX2xha2UgPSB0aGlzLmxha2UoKTtcblx0XHRcdFx0bGV0IGZrX2xha2UgPSBrX2xha2UuY29tcGxldGVfY2FsbGJhY2s7XG5cdFx0XHRcdGxldCBocF9sb2NrID0gU3ltYm9sKCdrZXknKTtcblxuXHRcdFx0XHR6X2NvbXBsZXRpb24uZW5kKCgpID0+IHtcblx0XHRcdFx0XHRrX2dyb3VwLnVubG9jayhocF9sb2NrKTtcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0Ly8gcmV3cmFwIGNvbXBsZXRpb24gY2FsbGJhY2sgZnVuY3Rpb25cblx0XHRcdFx0a19sYWtlLmNvbXBsZXRlX2NhbGxiYWNrID0gKCkgPT4ge1xuXHRcdFx0XHRcdGtfZ3JvdXAud2FpdChocF9sb2NrLCAoKSA9PiB7XG5cdFx0XHRcdFx0XHRma19sYWtlKCk7XG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIG5vdGlmaWNhdGlvblxuXHRcdGVsc2Uge1xuXHRcdFx0aWYodGhpcy5kZWJ1Zykge1xuXHRcdFx0XHRjb25zb2xlLndhcm4oJ1xcdCA9PSBjb21taXR0ZWQgJytoX25vZGUubGVmdCsnIDwvPiAnK2hfbm9kZS5yaWdodCk7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFibGUgdG8gcGVyZm9ybSBhIHJlZHVjdGlvblxuXHRcdFx0bGV0IGhfbWVyZ2UgPSBrX3BhaXJ3aXNlX3RyZWUuY29tbWl0KGhfbm9kZSk7XG5cdFx0XHQvLyBrX3BhaXJ3aXNlX3RyZWUucHJpbnQoKTtcblx0XHRcdGlmKGhfbWVyZ2UpIHtcblx0XHRcdFx0aWYodGhpcy5kZWJ1Zykge1xuXHRcdFx0XHRcdGNvbnNvbGUud2FybignbWVyZ2VkICcraF9tZXJnZS5ub2RlLmxlZnQrJyA8LT4gJytoX21lcmdlLm5vZGUucmlnaHQpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGxldCBrX3dvcmtlciA9IGhfbm9kZS5pdGVtLndvcmtlcjtcblxuXHRcdFx0XHQvLyB0aGlzIHJlZHVjdGlvbiB3aWxsIGJlIHRoZSBsYXN0IG9uZTsgZG8gbm90IGhvbGQgcmVzdWx0XG5cdFx0XHRcdGlmKGhfbWVyZ2UubWFrZXNfcm9vdCkge1xuXHRcdFx0XHRcdGhfdGFza19yZWFkeSA9IE9iamVjdC5hc3NpZ24oe30sIGhfdGFza19yZWFkeSk7XG5cdFx0XHRcdFx0aF90YXNrX3JlYWR5LmhvbGQgPSBmYWxzZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIGFmdGVyIHJlZHVjdGlvbjtcblx0XHRcdFx0bGV0IGZrX3JlZHVjdGlvbiA9ICh6X3Jlc3VsdF9yZWR1Y3Rpb24sIGlfdGFza19yZWR1Y3Rpb24sIGtfd29ya2VyX3JlZHVjdGlvbikgPT4ge1xuXHRcdFx0XHRcdC8vIGlmKHRoaXMuZGVidWcpIGRlYnVnZ2VyO1xuXG5cdFx0XHRcdFx0Ly8gcmVjdXJzZSBvbiByZWR1Y3Rpb247IHVwZGF0ZSBzZW5kZXIgZm9yIGNhbGxiYWNrIHNjb3BlXG5cdFx0XHRcdFx0dGhpcy5yZWR1Y2VfcmVzdWx0KHpfcmVzdWx0X3JlZHVjdGlvbiwgT2JqZWN0LmFzc2lnbihoX21lcmdlLm5vZGUsIHtcblx0XHRcdFx0XHRcdGl0ZW06IHtcblx0XHRcdFx0XHRcdFx0d29ya2VyOiBrX3dvcmtlcl9yZWR1Y3Rpb24sXG5cdFx0XHRcdFx0XHRcdHRhc2tfaWQ6IGlfdGFza19yZWR1Y3Rpb24sXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdH0pKTtcblx0XHRcdFx0fTtcblxuXHRcdFx0XHQvLyBnaXZlIHJlZHVjdGlvbiB0YXNrIHRvIHdvcmtlciB0aGF0IGZpbmlzaGVkIGVhcmxpZXI7IHBhc3MgdG8gdGhlIHJpZ2h0XG5cdFx0XHRcdGlmKGtfd29ya2VyID09PSBoX21lcmdlLmxlZnQud29ya2VyKSB7XG5cdFx0XHRcdFx0a19ncm91cC5yZWxheSh7XG5cdFx0XHRcdFx0XHRkZWJ1ZzogdGhpcy5kZWJ1Zyxcblx0XHRcdFx0XHRcdHNlbmRlcjogaF9ub2RlLml0ZW0sXG5cdFx0XHRcdFx0XHRyZWNlaXZlcjogaF9tZXJnZS5yaWdodCxcblx0XHRcdFx0XHRcdHJlY2VpdmVyX3ByaW1hcnk6IGZhbHNlLFxuXHRcdFx0XHRcdFx0dGFza19yZWFkeTogaF90YXNrX3JlYWR5LFxuXHRcdFx0XHRcdH0sIGZrX3JlZHVjdGlvbik7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gcGFzcyB0byB0aGUgbGVmdFxuXHRcdFx0XHRlbHNlIHtcblx0XHRcdFx0XHRrX2dyb3VwLnJlbGF5KHtcblx0XHRcdFx0XHRcdGRlYnVnOiB0aGlzLmRlYnVnLFxuXHRcdFx0XHRcdFx0c2VuZGVyOiBoX25vZGUuaXRlbSxcblx0XHRcdFx0XHRcdHJlY2VpdmVyOiBoX21lcmdlLmxlZnQsXG5cdFx0XHRcdFx0XHRyZWNlaXZlcl9wcmltYXJ5OiB0cnVlLFxuXHRcdFx0XHRcdFx0dGFza19yZWFkeTogaF90YXNrX3JlYWR5LFxuXHRcdFx0XHRcdH0sIGZrX3JlZHVjdGlvbik7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRmb3JjZV9lbmQoKSB7XG5cdFx0aWYoJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIHRoaXMuY29tcGxldGVfY2FsbGJhY2spIHtcblx0XHRcdHRoaXMuY29tcGxldGVfY2FsbGJhY2soKTtcblx0XHR9XG5cblx0XHRpZih0aGlzLmRvd25zdHJlYW0pIHtcblx0XHRcdHRoaXMuZG93bnN0cmVhbS5mb3JjZV9lbmQoKTtcblx0XHR9XG5cdH1cblxuXHRyb3V0ZV9lbmQoKSB7XG5cdFx0Ly8gdGhpcyB3YXMgdGhlIGxhc3QgcmVzdWx0XG5cdFx0aWYoKyt0aGlzLnJlc3VsdF9jb3VudCA9PT0gdGhpcy50YXNrX2NvdW50ICYmICdmdW5jdGlvbicgPT09IHR5cGVvZiB0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKSB7XG5cdFx0XHR0aGlzLmNvbXBsZXRlX2NhbGxiYWNrKCk7XG5cdFx0fVxuXHR9XG5cblx0Y29tcGxldGFibGUoKSB7XG5cdFx0bGV0IGZrX2NvbXBsZXRlID0gdGhpcy5jb21wbGV0ZV9jYWxsYmFjaztcblxuXHRcdC8vIG5vdGhpbmcgdG8gcmVkdWNlOyBjb21wbGV0ZSBhZnRlciBlc3RhYmxpc2hpbmcgZG93bnN0cmVhbVxuXHRcdGlmKCF0aGlzLnRhc2tfY291bnQgJiYgJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIGZrX2NvbXBsZXRlKSB7XG5cdFx0XHRzZXRUaW1lb3V0KGZrX2NvbXBsZXRlLCAwKTtcblx0XHR9XG5cblx0XHRyZXR1cm4gdGhpcy5kb3duc3RyZWFtID0gbmV3IGFjdGl2ZV9ncm91cCh0aGlzLmdyb3VwLCB0aGlzLnRhc2tfY291bnQsIHRoaXMucHVzaCk7XG5cdH1cblxuXHRoYW5kbGVfcmVzdWx0X2NhbGxiYWNrKHpfcmVzdWx0LCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzaykge1xuXHRcdGxldCBrX2Rvd25zdHJlYW0gPSB0aGlzLmRvd25zdHJlYW07XG5cblx0XHQvLyBhcHBseSBjYWxsYmFjayBhbmQgY2FwdHVyZSByZXR1cm5cblx0XHRsZXQgel9yZXR1cm4gPSB0aGlzLnJlc3VsdF9jYWxsYmFjayh6X3Jlc3VsdCwgaV9zdWJzZXQpO1xuXG5cdFx0Ly8gZG93bnN0cmVhbSBpcyBleHBlY3RpbmcgZGF0YSBmb3IgbmV4dCB0YXNrXG5cdFx0aWYoa19kb3duc3RyZWFtICYmIGtfZG93bnN0cmVhbS5waXBlZCkge1xuXHRcdFx0Ly8gbm90aGluZyB3YXMgcmV0dXJuZWQ7IHJldXNlIGlucHV0IGRhdGFcblx0XHRcdGlmKHVuZGVmaW5lZCA9PT0gel9yZXR1cm4pIHtcblx0XHRcdFx0Ly8gZG93bnN0cmVhbSBhY3Rpb24gd2FzIGV4cGVjdGluZyB3b3JrZXIgdG8gaG9sZCBkYXRhXG5cdFx0XHRcdGlmKGtfZG93bnN0cmVhbS51cHN0cmVhbV9ob2xkKSB7XG5cdFx0XHRcdFx0dGhyb3cgJ25vdCB5ZXQgaW1wbGVtZW50ZWQnO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdGtfZG93bnN0cmVhbS5yb3V0ZSh6X3Jlc3VsdCwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHQvLyByZXR1cm5lZCBwcm9taXNlXG5cdFx0XHRlbHNlIGlmKHpfcmV0dXJuIGluc3RhbmNlb2YgUHJvbWlzZSkge1xuXHRcdFx0XHR6X3JldHVyblxuXHRcdFx0XHRcdC8vIGF3YWl0IHByb21pc2UgcmVzb2x2ZVxuXHRcdFx0XHRcdC50aGVuKCh6X2NhcnJ5KSA9PiB7XG5cdFx0XHRcdFx0XHRrX2Rvd25zdHJlYW0ucm91dGUoel9jYXJyeSwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spO1xuXHRcdFx0XHRcdH0pXG5cdFx0XHRcdFx0Ly8gY2F0Y2ggcHJvbWlzZSByZWplY3Rcblx0XHRcdFx0XHQuY2F0Y2goKGVfcmVqZWN0KSA9PiB7XG5cdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ3VuY2F1Z2h0IHJlamVjdGlvbicpO1xuXHRcdFx0XHRcdH0pO1xuXHRcdFx0fVxuXHRcdFx0Ly8gcmV0dXJuZWQgZXJyb3Jcblx0XHRcdGVsc2UgaWYoel9yZXR1cm4gaW5zdGFuY2VvZiBFcnJvcikge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ25vdCB5ZXQgaW1wbGVtZW50ZWQnKTtcblx0XHRcdH1cblx0XHRcdC8vIHJldHVybmVkIGltbWVkaWF0ZWx5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0a19kb3duc3RyZWFtLnJvdXRlKHpfcmV0dXJuLCBpX3N1YnNldCwga193b3JrZXIsIGlfdGFzayk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIHNvbWV0aGluZyB3YXMgcmV0dXJuZWQgdGhvdWdoXG5cdFx0ZWxzZSBpZih1bmRlZmluZWQgIT09IHpfcmV0dXJuKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oJ2EgdGFzayBzdHJlYW0gaGFuZGxlciByZXR1cm4gc29tZSB2YWx1ZSBidXQgaXQgY2Fubm90IGJlIGNhcnJpZWQgYmVjYXVzZSBkb3duc3RyZWFtIGlzIG5vdCBleHBlY3RpbmcgdGFzayBkYXRhJyk7XG5cdFx0XHRkZWJ1Z2dlcjtcblx0XHR9XG5cdH1cblxuXHRlbmQoZmtfY29tcGxldGU9bnVsbCkge1xuXHRcdC8vIG5ldyBwcm9taXNlXG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChma19lbmQpID0+IHtcblx0XHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0XHRwaXBlZDogdHJ1ZSxcblx0XHRcdFx0cm91dGU6IHRoaXMucm91dGVfZW5kLFxuXHRcdFx0XHRjb21wbGV0ZV9jYWxsYmFjazogYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRcdC8vIGF3YWl0IGNvbXBsZXRlIGNhbGxiYWNrXG5cdFx0XHRcdFx0aWYoZmtfY29tcGxldGUpIGF3YWl0IGZrX2NvbXBsZXRlKCk7XG5cblx0XHRcdFx0XHQvLyBub3cgcmVzb2x2ZVxuXHRcdFx0XHRcdGZrX2VuZCgpO1xuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH1cblxuXG5cdG1rX3Jlc3VsdChrX3dvcmtlciwgaV9zdWJzZXQpIHtcblx0XHQvLyBmb3Igd2hlbiBhIHJlc3VsdCBhcnJpdmVzXG5cdFx0cmV0dXJuICh6X3Jlc3VsdCwgaV90YXNrKSA9PiB7XG5cdFx0XHQvLyB0aGlzIHdvcmtlciBqdXN0IG1hZGUgaXRzZWxmIGF2YWlsYWJsZVxuXHRcdFx0dGhpcy5ncm91cC53b3JrZXJfYXZhaWxhYmxlKGtfd29ya2VyKTtcblxuXHRcdFx0Ly8gcm91dGUgdGhlIHJlc3VsdFxuXHRcdFx0dGhpcy5yb3V0ZSh6X3Jlc3VsdCwgaV9zdWJzZXQsIGtfd29ya2VyLCBpX3Rhc2spO1xuXHRcdH07XG5cdH1cblxuXHQvLyB0cmF2ZXJzZSBhbGwgdGhlIHdheSBkb3duc3RyZWFtXG5cdGxha2UoKSB7XG5cdFx0bGV0IGtfZG93bnN0cmVhbSA9IHRoaXM7XG5cdFx0Zm9yKDs7KSB7XG5cdFx0XHRpZihrX2Rvd25zdHJlYW0uZG93bnN0cmVhbSkga19kb3duc3RyZWFtID0ga19kb3duc3RyZWFtLmRvd25zdHJlYW07XG5cdFx0XHRlbHNlIGJyZWFrO1xuXHRcdH1cblx0XHRyZXR1cm4ga19kb3duc3RyZWFtO1xuXHR9XG59XG5cblxuZnVuY3Rpb24gZGl2aWRlKGFfdGhpbmdzLCBuX3dvcmtlcnMsIHhtX3N0cmF0ZWd5LCBoX2RpdmlkZT17fSkge1xuXHRsZXQgbmxfdGhpbmdzID0gYV90aGluZ3MubGVuZ3RoO1xuXG5cdGxldCB7XG5cdFx0aXRlbV9jb3VudDogY19pdGVtc19yZW1haW49bmxfdGhpbmdzLFxuXHRcdG9wZW46IGZfb3Blbj1udWxsLFxuXHRcdHNlYWw6IGZfc2VhbD1udWxsLFxuXHRcdHF1YW50aWZ5OiBmX3F1YW50aWZ5PSgpID0+IHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihgbXVzdCBwcm92aWRlIGZ1bmN0aW9uIGZvciBrZXkgJ3F1YW50aWZ5JyB3aGVuIHVzaW5nICcuYmFsYW5jZV9vcmRlcmVkX2dyb3VwcygpJ2ApO1xuXHRcdH0sXG5cdH0gPSBoX2RpdmlkZTtcblxuXHRsZXQgYV90YXNrcyA9IFtdO1xuXG5cdGlmKEFycmF5LmlzQXJyYXkoYV90aGluZ3MpKSB7XG5cdFx0Ly8gZG8gbm90IGFzc2lnbiB3b3JrZXJzIHRvIG5vdGhpbmdcblx0XHRpZihubF90aGluZ3MgPCBuX3dvcmtlcnMpIG5fd29ya2VycyA9IG5sX3RoaW5ncztcblxuXHRcdC8vIGl0ZW1zIHBlciB3b3JrZXJcblx0XHRsZXQgeF9pdGVtc19wZXJfd29ya2VyID0gTWF0aC5mbG9vcihjX2l0ZW1zX3JlbWFpbiAvIG5fd29ya2Vycyk7XG5cblx0XHQvLyBkaXN0cmlidXRlIGl0ZW1zIGVxdWFsbHlcblx0XHRpZihYTV9TVFJBVEVHWV9FUVVBTCA9PT0geG1fc3RyYXRlZ3kpIHtcblx0XHRcdC8vIHN0YXJ0IGluZGV4IG9mIHNsaWNlXG5cdFx0XHRsZXQgaV9zdGFydCA9IDA7XG5cblx0XHRcdC8vIGVhY2ggd29ya2VyXG5cdFx0XHRmb3IobGV0IGlfd29ya2VyPTA7IGlfd29ya2VyPG5fd29ya2VyczsgaV93b3JrZXIrKykge1xuXHRcdFx0XHQvLyBmaW5kIGVuZCBpbmRleCBvZiB3b3JrZXI7IGVuc3VyZSBhbGwgaXRlbXMgZmluZCBhIHdvcmtlclxuXHRcdFx0XHRsZXQgaV9lbmQgPSAoaV93b3JrZXI9PT1uX3dvcmtlcnMtMSk/IG5sX3RoaW5nczogaV9zdGFydCt4X2l0ZW1zX3Blcl93b3JrZXI7XG5cblx0XHRcdFx0Ly8gZXh0cmFjdCBzbGljZSBmcm9tIHRoaW5ncyBhbmQgcHVzaCB0byBkaXZpc2lvbnNcblx0XHRcdFx0YV90YXNrcy5wdXNoKGFfdGhpbmdzLnNsaWNlKGlfc3RhcnQsIGlfZW5kKSk7XG5cblx0XHRcdFx0Ly8gYWR2YW5jZSBpbmRleCBmb3IgbmV4dCBkaXZpc2lvblxuXHRcdFx0XHRpX3N0YXJ0ID0gaV9lbmQ7XG5cblx0XHRcdFx0Ly8gdXBkYXRlIG51bWJlciBvZiBpdGVtcyByZW1haW5pbmdcblx0XHRcdFx0Y19pdGVtc19yZW1haW4gLT0geF9pdGVtc19wZXJfd29ya2VyO1xuXG5cdFx0XHRcdC8vIHJlY2FsY3VsYXRlIHRhcmdldCBpdGVtcyBwZXIgd29ya2VyXG5cdFx0XHRcdHhfaXRlbXNfcGVyX3dvcmtlciA9IE1hdGguZmxvb3IoY19pdGVtc19yZW1haW4gLyAobl93b3JrZXJzIC0gaV93b3JrZXIgLSAxKSk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIG9yZGVyZWQgZ3JvdXBzXG5cdFx0ZWxzZSBpZihYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQUyAmIHhtX3N0cmF0ZWd5KSB7XG5cdFx0XHRsZXQgaV93b3JrZXIgPSAwO1xuXHRcdFx0bGV0IGNfd29ya2VyX2l0ZW1zID0gMDtcblxuXHRcdFx0Ly8gb3BlbiBuZXcgdGFzayBpdGVtIGxpc3Rcblx0XHRcdGxldCBhX3Rhc2tfaXRlbXMgPSBbXTtcblx0XHRcdGxldCB6X3Rhc2tfZGF0YSA9IGZfb3Blbj8gZl9vcGVuKGFfdGFza19pdGVtcyk6IGFfdGFza19pdGVtcztcblxuXHRcdFx0Ly8gZWFjaCBncm91cFxuXHRcdFx0Zm9yKGxldCBpX2dyb3VwPTA7IGlfZ3JvdXA8bmxfdGhpbmdzOyBpX2dyb3VwKyspIHtcblx0XHRcdFx0bGV0IGhfZ3JvdXAgPSBhX3RoaW5nc1tpX2dyb3VwXTtcblx0XHRcdFx0bGV0IG5fZ3JvdXBfaXRlbXMgPSBmX3F1YW50aWZ5KGhfZ3JvdXApO1xuXG5cdFx0XHRcdC8vIGFkZGluZyB0aGlzIHRvIGN1cnJlbnQgd29ya2VyIHdvdWxkIGV4Y2VlZCB0YXJnZXQgbG9hZCAobWFrZSBzdXJlIHRoaXMgaXNuJ3QgZmluYWwgd29ya2VyKVxuXHRcdFx0XHRsZXQgbl93b3JrZXJfaXRlbXNfcHJldmlldyA9IG5fZ3JvdXBfaXRlbXMgKyBjX3dvcmtlcl9pdGVtcztcblx0XHRcdFx0aWYoKG5fd29ya2VyX2l0ZW1zX3ByZXZpZXcgPiB4X2l0ZW1zX3Blcl93b3JrZXIpICYmIGlfd29ya2VyIDwgbl93b3JrZXJzLTEpIHtcblx0XHRcdFx0XHRsZXQgYl9hZHZhbmNlX2dyb3VwID0gZmFsc2U7XG5cblx0XHRcdFx0XHQvLyBiYWxhbmNlIG1vZGVcblx0XHRcdFx0XHRpZihYTV9TVFJBVEVHWV9PUkRFUkVEX0dST1VQU19CQUxBTkNFRCA9PT0geG1fc3RyYXRlZ3kpIHtcblx0XHRcdFx0XHRcdC8vIHByZXZpZXcgaXMgY2xvc2VyIHRvIHRhcmdldDsgYWRkIHRhc2sgaXRlbSB0byB3b3JrZXIgYmVmb3JlIGFkdmFuY2luZ1xuXHRcdFx0XHRcdFx0aWYoKG5fd29ya2VyX2l0ZW1zX3ByZXZpZXcgLSB4X2l0ZW1zX3Blcl93b3JrZXIpIDwgKHhfaXRlbXNfcGVyX3dvcmtlciAtIGNfd29ya2VyX2l0ZW1zKSkge1xuXHRcdFx0XHRcdFx0XHRhX3Rhc2tfaXRlbXMucHVzaChoX2dyb3VwKTtcblx0XHRcdFx0XHRcdFx0Y193b3JrZXJfaXRlbXMgPSBuX3dvcmtlcl9pdGVtc19wcmV2aWV3O1xuXG5cdFx0XHRcdFx0XHRcdC8vIGFkdmFuY2UgZ3JvdXAgYWZ0ZXIgbmV3IHRhc2tcblx0XHRcdFx0XHRcdFx0Yl9hZHZhbmNlX2dyb3VwID0gdHJ1ZTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHQvLyBhZGQgdGFzayBpdGVtIHRvIG91dHB1dCAodHJhbnNmb3JtaW5nIGl0IHdoZW4gYXBwcm9wcmlhdGUpXG5cdFx0XHRcdFx0YV90YXNrcy5wdXNoKGZfc2VhbD8gZl9zZWFsKHpfdGFza19kYXRhKTogel90YXNrX2RhdGEpO1xuXG5cdFx0XHRcdFx0Ly8gbmV4dCB0YXNrIGl0ZW0gbGlzdFxuXHRcdFx0XHRcdGFfdGFza19pdGVtcyA9IFtdO1xuXHRcdFx0XHRcdGNfaXRlbXNfcmVtYWluIC09IGNfd29ya2VyX2l0ZW1zO1xuXHRcdFx0XHRcdHhfaXRlbXNfcGVyX3dvcmtlciA9IGNfaXRlbXNfcmVtYWluIC8gKG5fd29ya2VycyAtICgrK2lfd29ya2VyKSk7XG5cdFx0XHRcdFx0Y193b3JrZXJfaXRlbXMgPSAwO1xuXG5cdFx0XHRcdFx0Ly8gdGFzayBpdGVtIG9wZW5cblx0XHRcdFx0XHR6X3Rhc2tfZGF0YSA9IGZfb3Blbj8gZl9vcGVuKGFfdGFza19pdGVtcyk6IGFfdGFza19pdGVtcztcblxuXHRcdFx0XHRcdC8vIGFkdmFuY2UgZ3JvdXBcblx0XHRcdFx0XHRpZihiX2FkdmFuY2VfZ3JvdXApIGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gYWRkIHRhc2sgdG8gbGlzdFxuXHRcdFx0XHRhX3Rhc2tfaXRlbXMucHVzaChoX2dyb3VwKTtcblx0XHRcdFx0Y193b3JrZXJfaXRlbXMgKz0gbl9ncm91cF9pdGVtcztcblx0XHRcdH1cblxuXHRcdFx0Ly8gYWRkIGZpbmFsIHRhc2sgaXRlbVxuXHRcdFx0YV90YXNrcy5wdXNoKGZfc2VhbD8gZl9zZWFsKHpfdGFza19kYXRhKTogel90YXNrX2RhdGEpO1xuXHRcdH1cblx0XHQvLyB1bmtub3duIHN0cmF0ZWd5XG5cdFx0ZWxzZSB7XG5cdFx0XHR0aHJvdyBuZXcgUmFuZ2VFcnJvcignbm8gc3VjaCBzdHJhdGVneScpO1xuXHRcdH1cblx0fVxuXHQvLyB0eXBlZCBhcnJheVxuXHRlbHNlIGlmKCdieXRlTGVuZ3RoJyBpbiBhX3RoaW5ncykge1xuXHRcdC8vIGRpdmlkZSBcblx0XHR0aHJvdyAnbm90IHlldCBpbXBsZW1lbnRlZCc7XG5cdH1cblx0Ly8gdW5zdXBwb3J0ZWQgdHlwZVxuXHRlbHNlIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ3dvcmtlciBjYW4gb25seSBkaXZpZGUgZGF0YSBpbiBhcnJheXMgKGVpdGhlciBwbGFpbiBvciB0eXBlZCknKTtcblx0fVxuXG5cdHJldHVybiBhX3Rhc2tzO1xufVxuXG5cbmNsYXNzIGNvbnZlcmdlbnRfcGFpcndpc2VfdHJlZSB7XG5cdGNvbnN0cnVjdG9yKG5faXRlbXMpIHtcblx0XHRsZXQgYV9jYW5vcHkgPSBbXTtcblx0XHRmb3IobGV0IGlfaXRlbT0wOyBpX2l0ZW08bl9pdGVtczsgaV9pdGVtKyspIHtcblx0XHRcdGFfY2Fub3B5LnB1c2goe1xuXHRcdFx0XHRyZWFkeTogZmFsc2UsXG5cdFx0XHRcdHVwOiBudWxsLFxuXHRcdFx0XHRpdGVtOiBudWxsLFxuXHRcdFx0XHRsZWZ0OiBpX2l0ZW0gLSAxLFxuXHRcdFx0XHRyaWdodDogaV9pdGVtICsgMSxcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0aXRlbV9jb3VudDogbl9pdGVtcyxcblx0XHRcdGNhbm9weTogYV9jYW5vcHksXG5cdFx0XHRzdGVwczogMCxcblx0XHR9KTtcblx0fVxuXG5cdHJheShpX2l0ZW0sIHpfaXRlbSkge1xuXHRcdGxldCBoX25vZGUgPSB0aGlzLmNhbm9weVtpX2l0ZW1dO1xuXHRcdGhfbm9kZS5pdGVtID0gel9pdGVtO1xuXHRcdHJldHVybiBoX25vZGU7XG5cdH1cblxuXHR0b3AoaF90b3ApIHtcblx0XHRmb3IoOzspIHtcblx0XHRcdGxldCBoX3VwID0gaF90b3AudXA7XG5cdFx0XHRpZihoX3VwKSBoX3RvcCA9IGhfdXA7XG5cdFx0XHRlbHNlIGJyZWFrO1xuXHRcdH1cblx0XHRyZXR1cm4gaF90b3A7XG5cdH1cblxuXHRtZXJnZShoX2xlZnQsIGhfcmlnaHQpIHtcblx0XHRsZXQgbl9pdGVtcyA9IHRoaXMuaXRlbV9jb3VudDtcblxuXHRcdGxldCBoX25vZGUgPSB7XG5cdFx0XHRyZWFkeTogZmFsc2UsXG5cdFx0XHR1cDogbnVsbCxcblx0XHRcdGl0ZW06IG51bGwsXG5cdFx0XHRsZWZ0OiBoX2xlZnQubGVmdCxcblx0XHRcdHJpZ2h0OiBoX3JpZ2h0LnJpZ2h0LFxuXHRcdH07XG5cblx0XHRoX2xlZnQudXAgPSBoX3JpZ2h0LnVwID0gaF9ub2RlO1xuXG5cdFx0cmV0dXJuIHtcblx0XHRcdG5vZGU6IGhfbm9kZSxcblx0XHRcdGxlZnQ6IGhfbGVmdC5pdGVtLFxuXHRcdFx0cmlnaHQ6IGhfcmlnaHQuaXRlbSxcblx0XHRcdG1ha2VzX3Jvb3Q6IC0xID09PSBoX2xlZnQubGVmdCAmJiBuX2l0ZW1zID09PSBoX3JpZ2h0LnJpZ2h0LFxuXHRcdH07XG5cdH1cblxuXHRwcmludCgpIHtcblx0XHRsZXQgYV9saW5lcyA9IG5ldyBBcnJheSh0aGlzLmNhbm9weS5sZW5ndGgpO1xuXG5cdFx0ZGVidWdnZXI7XG5cdFx0dGhpcy5jYW5vcHkuZm9yRWFjaCgoaF9ub2RlLCBpX25vZGUpID0+IHtcblx0XHRcdGFfbGluZXNbaV9ub2RlXSA9IGBbJHtpX25vZGV9XSAke2hfbm9kZS5yZWFkeT8gJy0nLnJlcGVhdChoX25vZGUuc3RlcHMpKydPJzogJy0nLnJlcGVhdCh0aGlzLnN0ZXBzKX1gO1xuXHRcdH0pO1xuXHR9XG5cblx0Y29tbWl0KGhfbm9kZSkge1xuXHRcdGxldCBuX2l0ZW1zID0gdGhpcy5pdGVtX2NvdW50O1xuXHRcdGxldCBhX2Nhbm9weSA9IHRoaXMuY2Fub3B5O1xuXHRcdHRoaXMuc3RlcHMgKz0gMTtcblxuXHRcdC8vIGxlZnQgZWRnZSBvZiBsaXN0XG5cdFx0aWYoLTEgPT09IGhfbm9kZS5sZWZ0KSB7XG5cdFx0XHQvLyB0cmVlIHJvb3Qgd2FzIGhhbmRlZCB0byBjb21taXRcblx0XHRcdGlmKGhfbm9kZS5yaWdodCA9PT0gbl9pdGVtcykge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ2Nhbm5vdCBjb21taXQgcm9vdCEnKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gbmVpZ2hib3Igb24gcmlnaHQgc2lkZVxuXHRcdFx0bGV0IGhfcmlnaHQgPSB0aGlzLnRvcChhX2Nhbm9weVtoX25vZGUucmlnaHRdKTtcblxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgcmVhZHkhXG5cdFx0XHRpZihoX3JpZ2h0LnJlYWR5KSB7XG5cdFx0XHRcdHJldHVybiB0aGlzLm1lcmdlKGhfbm9kZSwgaF9yaWdodCk7XG5cdFx0XHR9XG5cdFx0XHQvLyBuZWlnaGJvciBpcyBidXN5L25vdCByZWFkeTsgbWFyayB0aGlzIGl0ZW0gYXMgcmVhZHlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHRoX25vZGUucmVhZHkgPSB0cnVlO1xuXHRcdFx0XHRoX25vZGUuc3RlcHMgPSB0aGlzLnN0ZXBzO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyByaWdodCBlZGdlIG9mIGxpc3Rcblx0XHRlbHNlIGlmKG5faXRlbXMgPT09IGhfbm9kZS5yaWdodCkge1xuXHRcdFx0Ly8gbmVpZ2hib3Igb24gbGVmdCBzaWRlXG5cdFx0XHRsZXQgaF9sZWZ0ID0gdGhpcy50b3AoYV9jYW5vcHlbaF9ub2RlLmxlZnRdKTtcblxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgcmVhZHlcblx0XHRcdGlmKGhfbGVmdC5yZWFkeSkge1xuXHRcdFx0XHRyZXR1cm4gdGhpcy5tZXJnZShoX2xlZnQsIGhfbm9kZSk7XG5cdFx0XHR9XG5cdFx0XHQvLyBuZWlnaGJvciBpcyBidXN5L25vdCByZWFkeTsgbWFyayB0aGlzIGl0ZW0gYXMgcmVhZHlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHRoX25vZGUucmVhZHkgPSB0cnVlO1xuXHRcdFx0XHRoX25vZGUuc3RlcHMgPSB0aGlzLnN0ZXBzO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBzb21ld2hlcmUgaW4gdGhlIG1pZGRsZVxuXHRcdGVsc2Uge1xuXHRcdFx0Ly8gc3RhcnQgd2l0aCBsZWZ0IG5laWdoYm9yXG5cdFx0XHRsZXQgaF9sZWZ0ID0gdGhpcy50b3AoYV9jYW5vcHlbaF9ub2RlLmxlZnRdKTtcblxuXHRcdFx0Ly8gbmVpZ2hib3IgaXMgcmVhZHlcblx0XHRcdGlmKGhfbGVmdC5yZWFkeSkge1xuXHRcdFx0XHRyZXR1cm4gdGhpcy5tZXJnZShoX2xlZnQsIGhfbm9kZSk7XG5cdFx0XHR9XG5cdFx0XHQvLyBuZWlnaGJvciBpcyBidXN5L25vdCByZWFkeVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdC8vIHRyeSByaWdodCBuZWlnaGJvclxuXHRcdFx0XHRsZXQgaF9yaWdodCA9IHRoaXMudG9wKGFfY2Fub3B5W2hfbm9kZS5yaWdodF0pO1xuXG5cdFx0XHRcdC8vIG5laWdoYm9yIGlzIHJlYWR5XG5cdFx0XHRcdGlmKGhfcmlnaHQucmVhZHkpIHtcblx0XHRcdFx0XHRyZXR1cm4gdGhpcy5tZXJnZShoX25vZGUsIGhfcmlnaHQpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIG5laWdoYm9yIGlzIGJ1c3kvbm90IHJlYWR5OyBtYXJrIHRoaXMgaXRlbSBhcyByZWFkeVxuXHRcdFx0XHRlbHNlIHtcblx0XHRcdFx0XHRoX25vZGUucmVhZHkgPSB0cnVlO1xuXHRcdFx0XHRcdGhfbm9kZS5zdGVwcyA9IHRoaXMuc3RlcHM7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHRyZXR1cm4gbnVsbDtcblx0fVxufVxuXG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oZGNfd29ya2VyKSB7XG5cdGNvbnN0IHBvb2wgPSByZXF1aXJlKCcuL3Bvb2wuanMnKShkY193b3JrZXIpO1xuXHRyZXR1cm4gY2xhc3MgZ3JvdXAgZXh0ZW5kcyBwb29sIHtcblx0XHRjb25zdHJ1Y3RvciguLi5hX2FyZ3MpIHtcblx0XHRcdHN1cGVyKC4uLmFfYXJncyk7XG5cblx0XHRcdGxldCB7XG5cdFx0XHRcdGxpbWl0OiBuX3dvcmtlcnMsXG5cdFx0XHR9ID0gdGhpcztcblxuXHRcdFx0Ly8gbWFrZSB3b3JrZXJzXG5cdFx0XHRsZXQgaG1fcm9zdGVyID0gbmV3IFdlYWtNYXAoKTtcblx0XHRcdGZvcihsZXQgaV93b3JrZXI9MDsgaV93b3JrZXI8bl93b3JrZXJzOyBpX3dvcmtlcisrKSB7XG5cdFx0XHRcdC8vIHNwYXduIG5ldyB3b3JrZXJcblx0XHRcdFx0bGV0IGtfd29ya2VyID0gdGhpcy5zcGF3bl93b3JrZXIoKTtcblxuXHRcdFx0XHQvLyByZXNlcnZlIGEgcXVldWUgZm9yIGl0IGluIHJvc3RlclxuXHRcdFx0XHRobV9yb3N0ZXIuc2V0KGtfd29ya2VyLCBbXSk7XG5cdFx0XHR9XG5cblx0XHRcdC8vIHNhdmUgZ3JvdXAgZmllbGRzXG5cdFx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdFx0cm9zdGVyOiBobV9yb3N0ZXIsXG5cdFx0XHRcdGxvY2tzOiB7fSxcblx0XHRcdFx0bmV4dF93b3JrZXJfc3VtbW9uOiAwLFxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0ZGF0YShhX2l0ZW1zKSB7XG5cdFx0XHRyZXR1cm4gbmV3IGFybWVkX2dyb3VwKHRoaXMsIHRoaXMuYmFsYW5jZShhX2l0ZW1zKSk7XG5cdFx0fVxuXG5cdFx0dXNlKGFfc3Vic2V0cykge1xuXHRcdFx0aWYoYV9zdWJzZXRzLmxlbmd0aCA+IHRoaXMubGltaXQpIHtcblx0XHRcdFx0dGhyb3cgbmV3IFJhbmdlRXJyb3IoYHRvbyBtYW55IHN1YnNldHMgZ2l2ZW4gZm9yIG51bWJlciBvZiB3b3JrZXJzOiAke2Ffc3Vic2V0cy5sZW5ndGh9IHN1YnNldHMgPiAke3RoaXMubGltaXR9IHdvcmtlcnNgKTtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIG5ldyBhcm1lZF9ncm91cCh0aGlzLCBhX3N1YnNldHMpO1xuXHRcdH1cblxuXHRcdHJ1biguLi5hX2FyZ3MpIHtcblx0XHRcdGxldCB7XG5cdFx0XHRcdHdvcmtlcnM6IGFfd29ya2Vycyxcblx0XHRcdFx0bGltaXQ6IG5fd29ya2Vycyxcblx0XHRcdH0gPSB0aGlzO1xuXG5cdFx0XHRsZXQgYV9wcm9taXNlcyA9IFtdO1xuXHRcdFx0Zm9yKGxldCBpX3dvcmtlcj0wOyBpX3dvcmtlcjxuX3dvcmtlcnM7IGlfd29ya2VyKyspIHtcblx0XHRcdFx0YV9wcm9taXNlcy5wdXNoKG5ldyBQcm9taXNlKChma193b3JrZXIsIGZlX3dvcmtlcikgPT4ge1xuXHRcdFx0XHRcdHRoaXMuc2NoZWR1bGUoYV93b3JrZXJzW2lfd29ya2VyXSwgKGtfd29ya2VyKSA9PiB7XG5cdFx0XHRcdFx0XHRrX3dvcmtlci5ydW4oLi4uYV9hcmdzKVxuXHRcdFx0XHRcdFx0XHQudGhlbigoKSA9PiB7XG5cdFx0XHRcdFx0XHRcdFx0Ly8gd29ya2VyIG1hZGUgaXRzZWxmIGF2YWlsYWJsZVxuXHRcdFx0XHRcdFx0XHRcdHRoaXMud29ya2VyX2F2YWlsYWJsZShrX3dvcmtlcik7XG5cblx0XHRcdFx0XHRcdFx0XHQvLyByZXNvbHZlIHByb21pc2Vcblx0XHRcdFx0XHRcdFx0XHRma193b3JrZXIoKTtcblx0XHRcdFx0XHRcdFx0fSlcblx0XHRcdFx0XHRcdFx0LmNhdGNoKGZlX3dvcmtlcik7XG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH0pKTtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIGFfcHJvbWlzZXM7XG5cdFx0fVxuXG5cdFx0YmFsYW5jZShhX2l0ZW1zKSB7XG5cdFx0XHRyZXR1cm4gZGl2aWRlKGFfaXRlbXMsIHRoaXMubGltaXQsIFhNX1NUUkFURUdZX0VRVUFMKTtcblx0XHR9XG5cblx0XHRiYWxhbmNlX29yZGVyZWRfZ3JvdXBzKGFfZ3JvdXBzLCBoX2RpdmlkZSkge1xuXHRcdFx0cmV0dXJuIGRpdmlkZShhX2dyb3VwcywgdGhpcy5saW1pdCwgWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQkFMQU5DRUQsIGhfZGl2aWRlKTtcblx0XHR9XG5cblx0XHRiaWFzX29yZGVyZWRfZ3JvdXBzKGFfZ3JvdXBzLCBoX2RpdmlkZSkge1xuXHRcdFx0cmV0dXJuIGRpdmlkZShhX2dyb3VwcywgdGhpcy5saW1pdCwgWE1fU1RSQVRFR1lfT1JERVJFRF9HUk9VUFNfQklBU0VELCBoX2RpdmlkZSk7XG5cdFx0fVxuXG5cdFx0ZGl2aXNpb25zKG5faXRlbXMpIHtcblx0XHRcdGxldCBuX3dvcmtlcnMgPSB0aGlzLmxpbWl0O1xuXG5cdFx0XHQvLyBkbyBub3QgYXNzaWduIHdvcmtlciB0byBkbyBub3RoaW5nXG5cdFx0XHRpZihuX2l0ZW1zIDwgbl93b3JrZXJzKSBuX3dvcmtlcnMgPSBuX2l0ZW1zO1xuXG5cdFx0XHQvLyBob3cgbWFueSB0aW1lcyB0byBkaXZpZGUgdGhlIGl0ZW1zXG5cdFx0XHRsZXQgbl9kaXZpc2lvbnMgPSBuX3dvcmtlcnMgLSAxO1xuXG5cdFx0XHQvLyBpZGVhbCBudW1iZXIgb2YgaXRlbXMgcGVyIHdvcmtlclxuXHRcdFx0bGV0IHhfaXRlbXNfcGVyX3dvcmtlciA9IG5faXRlbXMgLyBuX3dvcmtlcnM7XG5cblx0XHRcdC8vIGl0ZW0gaW5kaWNlcyB3aGVyZSB0byBtYWtlIGRpdmlzaW9uc1xuXHRcdFx0bGV0IGFfZGl2aXNpb25zID0gW107XG5cdFx0XHRmb3IobGV0IGlfZGl2aXNpb249MTsgaV9kaXZpc2lvbjw9bl9kaXZpc2lvbnM7IGlfZGl2aXNpb24rKykge1xuXHRcdFx0XHRhX2RpdmlzaW9ucy5wdXNoKE1hdGgucm91bmQoaV9kaXZpc2lvbiAqIHhfaXRlbXNfcGVyX3dvcmtlcikpO1xuXHRcdFx0fVxuXG5cdFx0XHRyZXR1cm4gYV9kaXZpc2lvbnM7XG5cdFx0fVxuXG5cdFx0KmRpdmlkZXIoY19pdGVtc19yZW1haW4sIHhtX2Rpc3RyaWJ1dGlvbj1YTV9ESVNUUklCVVRJT05fQ09OU1RBTlQpIHtcblx0XHRcdGxldCBjX3dvcmtlcnNfcmVtYWluID0gdGhpcy5saW1pdDtcblxuXHRcdFx0Ly8gaXRlbXMgcGVyIHdvcmtlclxuXHRcdFx0bGV0IG5faXRlbXNfcGVyX2RpdmlzaW9uID0gTWF0aC5mbG9vcihjX2l0ZW1zX3JlbWFpbiAvIGNfd29ya2Vyc19yZW1haW4pO1xuXG5cdFx0XHQvLyBjb25zdGFudCBkaXN0cmlidXRpb25cblx0XHRcdGlmKFhNX0RJU1RSSUJVVElPTl9DT05TVEFOVCA9PT0geG1fZGlzdHJpYnV0aW9uKSB7XG5cdFx0XHRcdGxldCBjX2l0ZW1zID0gMDtcblxuXHRcdFx0XHQvLyBpdGVyYXRpdmVseSBmaW5kIGluZGV4ZXMgdG8gZGl2aWRlIGF0XG5cdFx0XHRcdGZvcig7Oykge1xuXHRcdFx0XHRcdC8vIGRpdmlkZSBoZXJlXG5cdFx0XHRcdFx0aWYoKytjX2l0ZW1zID49IG5faXRlbXNfcGVyX2RpdmlzaW9uKSB7XG5cdFx0XHRcdFx0XHQvLyBkaXZpZGluZyBub3cgd291bGQgY2F1c2UgaXRlbSBvdmVyZmxvd1xuXHRcdFx0XHRcdFx0aWYoIS0tY193b3JrZXJzX3JlbWFpbikge1xuXHRcdFx0XHRcdFx0XHQvLyBkb24ndCBjcmVhdGUgYW55IG1vcmUgZGl2aXNpb25zXG5cdFx0XHRcdFx0XHRcdGZvcig7OykgeWllbGQgZmFsc2U7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdC8vIGRpdmlzaW9uIG9rYXlcblx0XHRcdFx0XHRcdHlpZWxkIHRydWU7XG5cblx0XHRcdFx0XHRcdC8vIGhvdyBtYW55IGl0ZW1zIHJlbWFpblxuXHRcdFx0XHRcdFx0Y19pdGVtc19yZW1haW4gLT0gY19pdGVtcztcblxuXHRcdFx0XHRcdFx0Ly8gcmVzZXQgaXRlbSBjb3VudCBmb3IgbmV3IHdvcmtlclxuXHRcdFx0XHRcdFx0Y19pdGVtcyA9IDA7XG5cblx0XHRcdFx0XHRcdC8vIHJlY2FsY3VsYXRlIHRhcmdldCBpdGVtcyBwZXIgd29ya2VyXG5cdFx0XHRcdFx0XHRuX2l0ZW1zX3Blcl9kaXZpc2lvbiA9IE1hdGguZmxvb3IoY19pdGVtc19yZW1haW4gLyBjX3dvcmtlcnNfcmVtYWluKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0Ly8gcHVzaCBpdGVtXG5cdFx0XHRcdFx0ZWxzZSB7XG5cdFx0XHRcdFx0XHR5aWVsZCBmYWxzZTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblxuXHRcdC8vIGxhdGVudChoX2Rpc3BhdGNoKSB7XG5cdFx0Ly8gXHRsZXQge1xuXHRcdC8vIFx0XHR0YXNrOiBzX3Rhc2ssXG5cdFx0Ly8gXHRcdGFyZ3M6IGFfYXJnc19kaXNwYXRjaD1bXSxcblx0XHQvLyBcdFx0dGFza19jb3VudDogbl90YXNrcz10aGlzLmxpbWl0LFxuXHRcdC8vIFx0XHRldmVudHM6IGhfZXZlbnRzX2Rpc3BhdGNoLFxuXHRcdC8vIFx0fSA9IGhfZGlzcGF0Y2g7XG5cblx0XHQvLyBcdGxldCBpX3N1YnNldCA9IDA7XG5cblx0XHQvLyBcdC8vIHByZXBhcmUgdG8gZGVhbCB3aXRoIHJlc3VsdHNcblx0XHQvLyBcdGxldCBrX3BsYW5uZXIgPSBuZXcgYWN0aXZlX2dyb3VwKHRoaXMsIG5fdGFza3MsIChhX2FyZ3M9W10sIGFfdHJhbnNmZXI9bnVsbCkgPT4ge1xuXHRcdC8vIFx0XHQvLyBzdW1tb24gd29ya2VycyBvbmUgYXQgYSB0aW1lXG5cdFx0Ly8gXHRcdHRoaXMuc3VtbW9uX3dvcmtlcnMoMSwgKGtfd29ya2VyKSA9PiB7XG5cdFx0Ly8gXHRcdFx0Ly8gcmVzdWx0IGhhbmRsZXIgd2FzIG5vdCB1c2VkOyBhdXRvLWVuZCBpdFxuXHRcdC8vIFx0XHRcdGlmKCFrX3BsYW5uZXIudXNlZCkga19wbGFubmVyLmVuZCgpO1xuXG5cdFx0Ly8gXHRcdFx0Ly8gbWFrZSByZXN1bHQgaGFuZGxlclxuXHRcdC8vIFx0XHRcdGxldCBma19yZXN1bHQgPSBrX3BsYW5uZXIubWtfcmVzdWx0KGtfd29ya2VyLCBpX3N1YnNldCsrKTtcblxuXHRcdC8vIFx0XHRcdC8vIG1ha2Ugd29ya2VyLXNwZWNpZmljIGV2ZW50c1xuXHRcdC8vIFx0XHRcdGxldCBoX2V2ZW50c193b3JrZXIgPSB0aGlzLmV2ZW50X3JvdXRlcihoX2V2ZW50c19kaXNwYXRjaCwgaV9zdWJzZXQpO1xuXG5cdFx0Ly8gXHRcdFx0Ly8gZXhlY3V0ZSB3b3JrZXIgb24gdGhpcyBwYXJ0IG9mIGRhdGFcblx0XHQvLyBcdFx0XHRrX3dvcmtlci5leGVjKHtcblx0XHQvLyBcdFx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHQvLyBcdFx0XHRcdGFyZ3M6IFsuLi5hX2FyZ3NfZGlzcGF0Y2gsIC4uLmFfYXJnc10sXG5cdFx0Ly8gXHRcdFx0XHR0cmFuc2ZlcjogYV90cmFuc2Zlcixcblx0XHQvLyBcdFx0XHRcdGhvbGQ6IGtfcGxhbm5lci51cHN0cmVhbV9ob2xkLFxuXHRcdC8vIFx0XHRcdFx0ZXZlbnRzOiBoX2V2ZW50c193b3JrZXIsXG5cdFx0Ly8gXHRcdFx0fSwgZmtfcmVzdWx0KTtcblx0XHQvLyBcdFx0fSk7XG5cdFx0Ly8gXHR9KTtcblxuXHRcdC8vIFx0Ly8gbGV0IHVzZXIgYmluZCBoYW5kbGVyXG5cdFx0Ly8gXHRyZXR1cm4ga19wbGFubmVyO1xuXHRcdC8vIH1cblxuXHRcdHNjaGVkdWxlKGtfd29ya2VyLCBmX3J1bikge1xuXHRcdFx0Ly8gd29ya2VyIGF2YWlsYWJsZSBpbW1lZGlhdGVseVxuXHRcdFx0aWYoa193b3JrZXIuYXZhaWxhYmxlKSB7XG5cdFx0XHRcdGZfcnVuKGtfd29ya2VyKTtcblx0XHRcdH1cblx0XHRcdC8vIHB1c2ggdG8gcHJpb3JpdHkgcXVldWVcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHR0aGlzLnJvc3Rlci5nZXQoa193b3JrZXIpLnB1c2goZl9ydW4pO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGFzc2lnbl93b3JrZXIoa193b3JrZXIsIGhfdGFzaywgZmtfdGFzaykge1xuXHRcdFx0Ly8gb25jZSBpdCBpcyB0aW1lIHRvIHJ1biB0aGUgdGFzayBvbiB0aGUgZ2l2ZW4gd29ya2VyXG5cdFx0XHR0aGlzLnNjaGVkdWxlKGtfd29ya2VyLCAoKSA9PiB7XG5cdFx0XHRcdGtfd29ya2VyLmV4ZWMoaF90YXNrLCAoLi4uYV9hcmdzKSA9PiB7XG5cdFx0XHRcdFx0Ly8gd29ya2VyIGp1c3QgbWFkZSBpdHNlbGYgYXZhaWxhYmxlXG5cdFx0XHRcdFx0dGhpcy53b3JrZXJfYXZhaWxhYmxlKGtfd29ya2VyKTtcblxuXHRcdFx0XHRcdC8vIGNhbGxiYWNrXG5cdFx0XHRcdFx0ZmtfdGFzayguLi5hX2FyZ3MpO1xuXHRcdFx0XHR9KTtcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdHJlbGF5KGhfcmVsYXksIGZrX3Jlc3VsdCkge1xuXHRcdFx0bGV0IHtcblx0XHRcdFx0c2VuZGVyOiB7XG5cdFx0XHRcdFx0d29ya2VyOiBrX3dvcmtlcl9zZW5kZXIsXG5cdFx0XHRcdFx0dGFza19pZDogaV90YXNrX3NlbmRlcixcblx0XHRcdFx0fSxcblx0XHRcdFx0cmVjZWl2ZXI6IHtcblx0XHRcdFx0XHR3b3JrZXI6IGtfd29ya2VyX3JlY2VpdmVyLFxuXHRcdFx0XHRcdHRhc2tfaWQ6IGlfdGFza19yZWNlaXZlcixcblx0XHRcdFx0fSxcblx0XHRcdFx0cmVjZWl2ZXJfcHJpbWFyeTogYl9yZWNlaXZlcl9wcmltYXJ5LFxuXHRcdFx0XHR0YXNrX3JlYWR5OiBoX3Rhc2tfcmVhZHksXG5cdFx0XHRcdGRlYnVnOiBzX2RlYnVnLFxuXHRcdFx0fSA9IGhfcmVsYXk7XG5cblx0XHRcdC8vIGxldCBzX3NlbmRlciA9ICdTJytTdHJpbmcuZnJvbUNoYXJDb2RlKDY1K2tfd29ya2VyX3NlbmRlci5pZCk7XG5cdFx0XHQvLyBsZXQgc19yZWNlaXZlciA9ICdTJytTdHJpbmcuZnJvbUNoYXJDb2RlKDY1K2tfd29ya2VyX3JlY2VpdmVyLmlkKTtcblxuXHRcdFx0Ly8gY3JlYXRlIG1lc3NhZ2UgY2hhbm5lbFxuXHRcdFx0bGV0IGtfY2hhbm5lbCA9IERDX0NIQU5ORUwuYmV0d2VlbihrX3dvcmtlcl9zZW5kZXIsIGtfd29ya2VyX3JlY2VpdmVyKTtcblxuXHRcdFx0aWYoa193b3JrZXJfc2VuZGVyID09PSBrX3dvcmtlcl9yZWNlaXZlcikgZGVidWdnZXI7XG5cblx0XHRcdC8vIGNvbnNvbGUud2FybihgTS9yZWxheS9yZWNlaXZlIFske2lfdGFza19zZW5kZXJ9XSA9PiAke2lfdGFza19yZWNlaXZlcn1gKTtcblxuXHRcdFx0Ly8gYXR0YWNoIGRlYnVnIHRhZyB0byByZWFkeSB0YXNrXG5cdFx0XHRpZihzX2RlYnVnKSBoX3Rhc2tfcmVhZHkuZGVidWcgPSBzX2RlYnVnO1xuXG5cdFx0XHQvLyBzY2hlZHVsZSByZWNlaXZlciB3b3JrZXIgdG8gcmVjZWl2ZSBkYXRhIGFuZCB0aGVuIHJ1biB0YXNrXG5cdFx0XHR0aGlzLnNjaGVkdWxlKGtfd29ya2VyX3JlY2VpdmVyLCAoKSA9PiB7XG5cdFx0XHRcdGtfd29ya2VyX3JlY2VpdmVyLnJlY2VpdmUoa19jaGFubmVsLnBvcnRfMSgpLCB7XG5cdFx0XHRcdFx0aW1wb3J0OiBpX3Rhc2tfcmVjZWl2ZXIsXG5cdFx0XHRcdFx0c2VuZGVyOiBpX3Rhc2tfc2VuZGVyLFxuXHRcdFx0XHRcdHByaW1hcnk6IGJfcmVjZWl2ZXJfcHJpbWFyeSxcblx0XHRcdFx0XHR0YXNrX3JlYWR5OiBoX3Rhc2tfcmVhZHksXG5cdFx0XHRcdH0sICguLi5hX2FyZ3MpID0+IHtcblx0XHRcdFx0XHQvLyB3b3JrZXIganVzdCBtYWRlIGl0c2VsZiBhdmFpbGFibGVcblx0XHRcdFx0XHR0aGlzLndvcmtlcl9hdmFpbGFibGUoa193b3JrZXJfcmVjZWl2ZXIpO1xuXG5cdFx0XHRcdFx0Ly8gY2FsbGJhY2tcblx0XHRcdFx0XHRma19yZXN1bHQoLi4uYV9hcmdzKTtcblx0XHRcdFx0fSwgc19kZWJ1Zyk7XG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gc2NoZWR1bGUgc2VuZGVyIHdvcmtlciB0byByZWxheSBkYXRhIHRvIHJlY2VpdmVyIHdvcmtlclxuXHRcdFx0dGhpcy5zY2hlZHVsZShrX3dvcmtlcl9zZW5kZXIsICgpID0+IHtcblx0XHRcdFx0a193b3JrZXJfc2VuZGVyLnJlbGF5KGlfdGFza19zZW5kZXIsIGtfY2hhbm5lbC5wb3J0XzIoKSwgU3RyaW5nLmZyb21DaGFyQ29kZSg2NStrX3dvcmtlcl9yZWNlaXZlci5pZCksIHNfZGVidWcpO1xuXG5cdFx0XHRcdC8vIG5vIHJlc3VsdCBuZWVkZWQgZnJvbSByZWxheTsgd29ya2VyIGlzIGF2YWlsYWJsZSBhZnRlciBtZXNzYWdlIHBvc3RzXG5cdFx0XHRcdHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHRcdHRoaXMud29ya2VyX2F2YWlsYWJsZShrX3dvcmtlcl9zZW5kZXIpO1xuXHRcdFx0XHR9LCAwKTtcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdHN1bW1vbl93b3JrZXJzKG5fc3VtbW9ucywgZmtfd29ya2VyKSB7XG5cdFx0XHRsZXQgYV93b3JrZXJzID0gdGhpcy53b3JrZXJzO1xuXHRcdFx0bGV0IG5fd29ya2VycyA9IHRoaXMubGltaXQ7XG5cblx0XHRcdGxldCBjX3N1bW1vbmVkID0gMDtcblxuXHRcdFx0Ly8gc3RhcnQgYnkgbG9va2luZyBmb3IgYXZhaWxhYmxlIHdvcmtlcnNcblx0XHRcdGxldCBpX25leHRfd29ya2VyX3N1bW1vbiA9IHRoaXMubmV4dF93b3JrZXJfc3VtbW9uO1xuXG5cdFx0XHRmb3IobGV0IGlfd29ya2VyPTA7IGlfd29ya2VyPG5fd29ya2VycyAmJiBjX3N1bW1vbmVkPG5fc3VtbW9uczsgaV93b3JrZXIrKykge1xuXHRcdFx0XHRsZXQgaV93b3JrZXJfY2FsbCA9IChpX3dvcmtlcitpX25leHRfd29ya2VyX3N1bW1vbikgJSBuX3dvcmtlcnM7XG5cdFx0XHRcdGxldCBrX3dvcmtlciA9IGFfd29ya2Vyc1tpX3dvcmtlcl9jYWxsXTtcblxuXHRcdFx0XHQvLyB3b3JrZXIgYXZhaWxhYmxlIGltbWVkaWF0ZWx5XG5cdFx0XHRcdGlmKGtfd29ya2VyLmF2YWlsYWJsZSkge1xuXHRcdFx0XHRcdC8vIHNldCBuZXh0IHdvcmtlciB0byBzdW1tb25cblx0XHRcdFx0XHR0aGlzLm5leHRfd29ya2VyX3N1bW1vbiA9IGlfd29ya2VyX2NhbGwgKyAxO1xuXG5cdFx0XHRcdFx0Ly8gc2F2ZSBzdW1tb24gaW5kZXhcblx0XHRcdFx0XHRsZXQgaV9zdWJzZXQgPSBjX3N1bW1vbmVkKys7XG5cblx0XHRcdFx0XHQvLyBhbGxvdyBkb3duc3RyZWFtIGhhbmRsZXIgdG8gYmUgZXN0YWJsaXNoZWQgZmlyc3Rcblx0XHRcdFx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0XHRcdC8vIGNvbnNvbGUuaW5mbygnID0+ICcra193b3JrZXIuaWQpO1xuXHRcdFx0XHRcdFx0Zmtfd29ya2VyKGtfd29ya2VyLCBpX3N1YnNldCk7XG5cdFx0XHRcdFx0fSwgMCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gdGhlcmUgYXJlIHJlbWFpbmluZyBzdW1tb25zXG5cdFx0XHRpZihjX3N1bW1vbmVkIDwgbl9zdW1tb25zKSB7XG5cdFx0XHRcdC8vIHF1ZXVlIGZvciBub3RpZmljYXRpb24gd2hlbiB3b3JrZXJzIGJlY29tZSBhdmFpbGFibGVcblx0XHRcdFx0dGhpcy53YWl0X2xpc3QucHVzaCh7XG5cdFx0XHRcdFx0dGFza3NfcmVtYWluaW5nOiBuX3N1bW1vbnMgLSBjX3N1bW1vbmVkLFxuXHRcdFx0XHRcdGVhY2goa193b3JrZXIpIHtcblx0XHRcdFx0XHRcdGZrX3dvcmtlcihrX3dvcmtlciwgY19zdW1tb25lZCsrKTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9KTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHR3b3JrZXJfYXZhaWxhYmxlKGtfd29ya2VyKSB7XG5cdFx0XHQvLyB0aGlzIHdvcmtlciBoYXMgcHJpb3JpdHkgdGFza3Mgd2FpdGluZyBmb3IgaXRcblx0XHRcdGxldCBhX3F1ZXVlID0gdGhpcy5yb3N0ZXIuZ2V0KGtfd29ya2VyKTtcblx0XHRcdGlmKGFfcXVldWUubGVuZ3RoKSB7XG5cdFx0XHRcdC8vIGZpZm8gcG9wIGFuZCBjYWxsXG5cdFx0XHRcdGxldCBma193b3JrZXIgPSBhX3F1ZXVlLnNoaWZ0KCk7XG5cdFx0XHRcdGZrX3dvcmtlcihrX3dvcmtlcik7XG5cdFx0XHR9XG5cdFx0XHQvLyB0aGVyZSBpcyBhIHdhaXQgbGlzdFxuXHRcdFx0ZWxzZSBpZih0aGlzLndhaXRfbGlzdC5sZW5ndGgpIHtcblx0XHRcdFx0Ly8gdG9wIG9mIHF1ZXVlXG5cdFx0XHRcdGxldCBoX3BhdGllbnQgPSB0aGlzLndhaXRfbGlzdFswXTtcblxuXHRcdFx0XHQvLyBhc3NpZ24gd29ya2VyIG5leHQgdGFza1xuXHRcdFx0XHRoX3BhdGllbnQuZWFjaChrX3dvcmtlcik7XG5cblx0XHRcdFx0Ly8gdGhpcyBwYXRpZW50IGlzIHNhdGlzZmllZDsgZmlmbyBwb3Bcblx0XHRcdFx0aWYoMCA9PT0gLS1oX3BhdGllbnQudGFza3NfcmVtYWluaW5nKSB0aGlzLndhaXRfbGlzdC5zaGlmdCgpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gb3RoZXJ3aXNlLCBmcmVlIHdvcmtlclxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdGtfd29ya2VyLmF2YWlsYWJsZSA9IHRydWU7XG5cdFx0XHR9XG5cdFx0fVxuXHR9O1xufTtcbiIsIlxuLy8gZGVkdWNlIHRoZSBydW50aW1lIGVudmlyb25tZW50XG5jb25zdCBbQl9CUk9XU0VSLCBCX0JST1dTRVJJRlldID0gKCgpID0+ICd1bmRlZmluZWQnID09PSB0eXBlb2YgcHJvY2Vzc1xuXHQ/IFt0cnVlLCBmYWxzZV1cblx0OiAocHJvY2Vzcy5icm93c2VyXG5cdFx0PyBbdHJ1ZSwgdHJ1ZV1cblx0XHQ6ICgndW5kZWZpbmVkJyA9PT0gcHJvY2Vzcy52ZXJzaW9ucyB8fCAndW5kZWZpbmVkJyA9PT0gcHJvY2Vzcy52ZXJzaW9ucy5ub2RlXG5cdFx0XHQ/IFt0cnVlLCBmYWxzZV1cblx0XHRcdDogW2ZhbHNlLCBmYWxzZV0pKSkoKTtcblxuXG5jb25zdCBsb2NhbHMgPSBPYmplY3QuYXNzaWduKHtcblx0Ql9CUk9XU0VSLFxuXHRCX0JST1dTRVJJRlksXG5cblx0SFBfV09SS0VSX05PVElGSUNBVElPTjogU3ltYm9sKCd3b3JrZXIgbm90aWZpY2F0aW9uJyksXG59LCBCX0JST1dTRVI/IHJlcXVpcmUoJy4uL2Jyb3dzZXIvbG9jYWxzLmpzJyk6IHJlcXVpcmUoJy4uL25vZGUvbG9jYWxzLmpzJykpO1xuXG5cbmxvY2Fscy53ZWJ3b3JrZXJpZnkgPSBmdW5jdGlvbih6X2ltcG9ydCwgaF9jb25maWc9e30pIHtcblx0Y29uc3QgW0ZfRlVOQ1RJT05fQlVORExFLCBIX1NPVVJDRVMsIEhfQ0FDSEVdID0gaF9jb25maWcuYnJvd3NlcmlmeTtcblx0bGV0IHNfd29ya2VyX2tleSA9ICcnO1xuXHRmb3IobGV0IHNfY2FjaGVfa2V5IGluIEhfQ0FDSEUpIHtcblx0XHRsZXQgel9leHBvcnRzID0gSF9DQUNIRVtzX2NhY2hlX2tleV0uZXhwb3J0cztcblx0XHRpZih6X2ltcG9ydCA9PT0gel9leHBvcnRzIHx8IHpfaW1wb3J0ID09PSB6X2V4cG9ydHMuZGVmYXVsdCkge1xuXHRcdFx0c193b3JrZXJfa2V5ID0gc19jYWNoZV9rZXk7XG5cdFx0XHRicmVhaztcblx0XHR9XG5cdH1cblxuXHRpZighc193b3JrZXJfa2V5KSB7XG5cdFx0c193b3JrZXJfa2V5ID0gTWF0aC5mbG9vcihNYXRoLnBvdygxNiwgOCkgKiBNYXRoLnJhbmRvbSgpKS50b1N0cmluZygxNik7XG5cdFx0bGV0IGhfY2FjaGVfd29ya2VyID0ge307XG5cdFx0Zm9yKGxldCBzX2tleV9jYWNoZSBpbiBIX1NPVVJDRVMpIHtcblx0XHRcdGhfY2FjaGVfd29ya2VyW3Nfa2V5X2NhY2hlXSA9IHNfa2V5X2NhY2hlO1xuXHRcdH1cblx0XHRIX1NPVVJDRVNbc193b3JrZXJfa2V5XSA9IFtcblx0XHRcdG5ldyBGdW5jdGlvbihbJ3JlcXVpcmUnLCAnbW9kdWxlJywgJ2V4cG9ydHMnXSwgYCgke3pfaW1wb3J0fSkoc2VsZik7YCksXG5cdFx0XHRoX2NhY2hlX3dvcmtlcixcblx0XHRdO1xuXHR9XG5cblx0bGV0IHNfc291cmNlX2tleSA9IE1hdGguZmxvb3IoTWF0aC5wb3coMTYsIDgpICogTWF0aC5yYW5kb20oKSkudG9TdHJpbmcoMTYpO1xuXHRIX1NPVVJDRVNbc19zb3VyY2Vfa2V5XSA9IFtcblx0XHRuZXcgRnVuY3Rpb24oWydyZXF1aXJlJ10sIGBcblx0XHRcdGxldCBmID0gcmVxdWlyZSgke0pTT04uc3RyaW5naWZ5KHNfd29ya2VyX2tleSl9KTtcblx0XHRcdC8vIGRlYnVnZ2VyO1xuXHRcdFx0Ly8gKGYuZGVmYXVsdD8gZi5kZWZhdWx0OiBmKShzZWxmKTtcblx0XHRgKSxcblx0XHR7W3Nfd29ya2VyX2tleV06c193b3JrZXJfa2V5fSxcblx0XTtcblxuXHRsZXQgaF93b3JrZXJfc291cmNlcyA9IHt9O1xuXHRmdW5jdGlvbiByZXNvbHZlX3NvdXJjZXMoc19rZXkpIHtcblx0XHRoX3dvcmtlcl9zb3VyY2VzW3Nfa2V5XSA9IHRydWU7XG5cdFx0bGV0IGhfc291cmNlID0gSF9TT1VSQ0VTW3Nfa2V5XVsxXTtcblx0XHRmb3IobGV0IHBfZGVwZW5kZW5jeSBpbiBoX3NvdXJjZSkge1xuXHRcdFx0bGV0IHNfZGVwZW5kZW5jeV9rZXkgPSBoX3NvdXJjZVtwX2RlcGVuZGVuY3ldO1xuXHRcdFx0aWYoIWhfd29ya2VyX3NvdXJjZXNbc19kZXBlbmRlbmN5X2tleV0pIHtcblx0XHRcdFx0cmVzb2x2ZV9zb3VyY2VzKHNfZGVwZW5kZW5jeV9rZXkpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXHRyZXNvbHZlX3NvdXJjZXMoc19zb3VyY2Vfa2V5KTtcblxuXHRsZXQgc19zb3VyY2UgPSBgKCR7Rl9GVU5DVElPTl9CVU5ETEV9KSh7XG5cdFx0JHtPYmplY3Qua2V5cyhoX3dvcmtlcl9zb3VyY2VzKS5tYXAoKHNfa2V5KSA9PiB7XG5cdFx0XHRsZXQgYV9zb3VyY2UgPSBIX1NPVVJDRVNbc19rZXldO1xuXHRcdFx0cmV0dXJuIEpTT04uc3RyaW5naWZ5KHNfa2V5KVxuXHRcdFx0XHQrYDpbJHthX3NvdXJjZVswXX0sJHtKU09OLnN0cmluZ2lmeShhX3NvdXJjZVsxXSl9XWA7XG5cdFx0fSl9XG5cdH0sIHt9LCBbJHtKU09OLnN0cmluZ2lmeShzX3NvdXJjZV9rZXkpfV0pYDtcblxuXHRsZXQgZF9ibG9iID0gbmV3IEJsb2IoW3Nfc291cmNlXSwge3R5cGU6J3RleHQvamF2YXNjcmlwdCd9KTtcblx0aWYoaF9jb25maWcuYmFyZSkge1xuXHRcdHJldHVybiBkX2Jsb2I7XG5cdH1cblx0bGV0IHBfd29ya2VyX3VybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwoZF9ibG9iKTtcblx0bGV0IGRfd29ya2VyID0gbmV3IGxvY2Fscy5EQ19XT1JLRVIocF93b3JrZXJfdXJsLCBoX2NvbmZpZy53b3JrZXJfb3B0aW9ucyk7XG5cdC8vIGRfd29ya2VyLm9iamVjdFVSTCA9IHBfd29ya2VyX3VybDtcblx0Ly8gZF93b3JrZXIuc291cmNlID0gZF9ibG9iO1xuXHRkX3dvcmtlci5zb3VyY2UgPSBzX3NvdXJjZTtcblx0cmV0dXJuIGRfd29ya2VyO1xufTtcblxuXG5tb2R1bGUuZXhwb3J0cyA9IGxvY2FscztcbiIsIlxuY2xhc3MgbG9jayB7XG5cdGNvbnN0cnVjdG9yKGJfdW5sb2NrZWQ9ZmFsc2UpIHtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdHVubG9ja2VkOiBiX3VubG9ja2VkLFxuXHRcdFx0cXVldWU6IFtdLFxuXHRcdH0pO1xuXHR9XG5cblx0d2FpdChma191bmxvY2spIHtcblx0XHQvLyBhbHJlYWR5IHVubG9ja2VkXG5cdFx0aWYodGhpcy51bmxvY2tlZCkge1xuXHRcdFx0ZmtfdW5sb2NrKCk7XG5cdFx0fVxuXHRcdC8vIGN1cnJlbnRseSBsb2NrZWQsIGFkZCB0byBxdWV1ZVxuXHRcdGVsc2Uge1xuXHRcdFx0dGhpcy5xdWV1ZS5wdXNoKGZrX3VubG9jayk7XG5cdFx0fVxuXHR9XG5cblx0dW5sb2NrKCkge1xuXHRcdC8vIHVwZGF0ZSBzdGF0ZVxuXHRcdHRoaXMudW5sb2NrZWQgPSB0cnVlO1xuXG5cdFx0Ly8gdXBkYXRlIGZpZWxkIGJlZm9yZSBleGVjdXRpbmcgY2FsbGJhY2tzXG5cdFx0bGV0IGFfcXVldWUgPSB0aGlzLnF1ZXVlO1xuXHRcdHRoaXMucXVldWUgPSBbXTtcblxuXHRcdC8vIHByb2Nlc3MgY2FsbGJhY2sgcXVldWVcblx0XHRhX3F1ZXVlLmZvckVhY2goKGZrX3VubG9jaykgPT4ge1xuXHRcdFx0ZmtfdW5sb2NrKCk7XG5cdFx0fSk7XG5cdH1cbn1cblxuY2xhc3MgbG9ja2FibGUge1xuXHR3YWl0KHpfa2V5LCB6X3VubG9jaykge1xuXHRcdGxldCBma191bmxvY2sgPSB6X3VubG9jaztcblxuXHRcdC8vIHVubG9jayBpcyBhbm90aGVyIGxvY2tcblx0XHRpZignc3RyaW5nJyA9PT0gdHlwZW9mIHpfdW5sb2NrKSB7XG5cdFx0XHRma191bmxvY2sgPSAoKSA9PiB7XG5cdFx0XHRcdHRoaXMudW5sb2NrKHpfdW5sb2NrKTtcblx0XHRcdH07XG5cdFx0fVxuXHRcdC8vIHVubG9jayBpcyBhcnJheSBvZiBsb2Nrc1xuXHRcdGVsc2UgaWYoQXJyYXkuaXNBcnJheSh6X3VubG9jaykpIHtcblx0XHRcdGZrX3VubG9jayA9ICgpID0+IHtcblx0XHRcdFx0dGhpcy51bmxvY2soel91bmxvY2spO1xuXHRcdFx0fTtcblx0XHR9XG5cblx0XHQvLyBzZXJpZXMgb2Yga2V5cyB0byB3YWl0IGZvclxuXHRcdGlmKEFycmF5LmlzQXJyYXkoel9rZXkpKSB7XG5cdFx0XHRsZXQgaV9rZXkgPSAwO1xuXHRcdFx0bGV0IG5fa2V5cyA9IHpfa2V5Lmxlbmd0aDtcblx0XHRcdGxldCBmX25leHQgPSAoKSA9PiB7XG5cdFx0XHRcdGlmKGlfa2V5ID09PSBuX2tleXMpIGZrX3VubG9jaygpO1xuXHRcdFx0XHRlbHNlIHRoaXMud2FpdCh6X2tleVtpX2tleSsrXSwgZl9uZXh0KTtcblx0XHRcdH07XG5cblx0XHRcdGZfbmV4dCgpO1xuXHRcdH1cblx0XHQvLyBubyBzdWNoIGxvY2s7IGJ1dCB0aGF0J3Mgb2theSA7KSBjcmVhdGUgbG9jayBpbXBsaWNpdGx5XG5cdFx0ZWxzZSBpZighKHpfa2V5IGluIHRoaXMubG9ja3MpKSB7XG5cdFx0XHRsZXQga19sb2NrID0gdGhpcy5sb2Nrc1t6X2tleV0gPSBuZXcgbG9jaygpO1xuXHRcdFx0a19sb2NrLndhaXQoZmtfdW5sb2NrKTtcblx0XHR9XG5cdFx0Ly8gYWRkIHRvIHdhaXQgcXVldWVcblx0XHRlbHNlIHtcblx0XHRcdHRoaXMubG9ja3Nbel9rZXldLndhaXQoZmtfdW5sb2NrKTtcblx0XHR9XG5cdH1cblxuXHR1bmxvY2soel9rZXkpIHtcblx0XHQvLyBsaXN0IG9mIGtleXMgdG8gdW5sb2NrXG5cdFx0aWYoQXJyYXkuaXNBcnJheSh6X2tleSkpIHtcblx0XHRcdHpfa2V5LmZvckVhY2goel9rZXlfID0+IHRoaXMudW5sb2NrKHpfa2V5XykpO1xuXHRcdH1cblx0XHQvLyBpbmRpdnVkYWwga2V5XG5cdFx0ZWxzZSB7XG5cdFx0XHQvLyBubyBzdWNoIGxvY2sgeWV0XG5cdFx0XHRpZighKHpfa2V5IGluIHRoaXMubG9ja3MpKSB7XG5cdFx0XHRcdHRoaXMubG9ja3Nbel9rZXldID0gbmV3IGxvY2sodHJ1ZSk7XG5cdFx0XHR9XG5cdFx0XHQvLyB1bmxvY2tcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHR0aGlzLmxvY2tzW3pfa2V5XS51bmxvY2soKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGxvY2thYmxlO1xuIiwiY29uc3Qge1xuXHRzaGFyaW5nLFxufSA9IHJlcXVpcmUoJy4vbG9jYWxzLmpzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gY2xhc3MgbWFuaWZlc3Qge1xuXHRzdGF0aWMgZnJvbSh6X290aGVyKSB7XG5cdFx0Ly8gbWFuaWZlc3Rcblx0XHRpZih6X290aGVyIGluc3RhbmNlb2YgbWFuaWZlc3QpIHtcblx0XHRcdHJldHVybiB6X290aGVyO1xuXHRcdH1cblx0XHQvLyBhbnlcblx0XHRlbHNlIHtcblx0XHRcdHJldHVybiBuZXcgbWFuaWZlc3Qoel9vdGhlciwgW10pO1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0cnVjdG9yKGFfZGF0YT1bXSwgel90cmFuc2Zlcl9wYXRocz10cnVlKSB7XG5cdFx0Ly8gbm90IGFuIGFycmF5XG5cdFx0aWYoIUFycmF5LmlzQXJyYXkoYV9kYXRhKSkge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKCdhIG1hbmlmZXN0IHJlcHJlc2VudHMgYW4gYXJyYXkgb2YgYXJndW1lbnRzOyBwYXNzIHRoZSBjb25zdHJ1Y3RvciBhbiBhcnJheScpO1xuXHRcdH1cblxuXHRcdC8vIG5vdCBhIGxpc3Q7IGZpbmQgdHJhbnNmZXJzIG1hbnVhbGx5XG5cdFx0bGV0IGFfdHJhbnNmZXJfcGF0aHMgPSB6X3RyYW5zZmVyX3BhdGhzO1xuXHRcdGlmKCFBcnJheS5pc0FycmF5KGFfdHJhbnNmZXJfcGF0aHMpKSB7XG5cdFx0XHRhX3RyYW5zZmVyX3BhdGhzID0gdGhpcy5leHRyYWN0KGFfZGF0YSk7XG5cdFx0fVxuXHRcdC8vIG9ubHkgY2hlY2sgdG9wIGxldmVsXG5cdFx0ZWxzZSB7XG5cdFx0XHRsZXQgYV90cmFuc2ZlcnMgPSBbXTtcblx0XHRcdGZvcihsZXQgaV9kYXR1bT0wLCBubF9kYXRhPWFfZGF0YS5sZW5ndGg7IGlfZGF0dW08bmxfZGF0YTsgaV9kYXR1bSsrKSB7XG5cdFx0XHRcdGxldCB6X2RhdHVtID0gYV9kYXRhW2lfZGF0dW1dO1xuXG5cdFx0XHRcdC8vIHNoYXJlYWJsZSBpdGVtXG5cdFx0XHRcdGlmKHNoYXJpbmcoel9kYXR1bSkpIGFfdHJhbnNmZXJzLnB1c2goW2lfZGF0dW1dKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gc29saWRpZnkgdHJhbnNmZXJzXG5cdFx0XHRpZihhX3RyYW5zZmVycy5sZW5ndGgpIHtcblx0XHRcdFx0YV90cmFuc2Zlcl9wYXRocyA9IGFfdHJhbnNmZXJzO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0ZGF0YTogYV9kYXRhLFxuXHRcdFx0dHJhbnNmZXJfcGF0aHM6IGFfdHJhbnNmZXJfcGF0aHMsXG5cdFx0fSk7XG5cdH1cblxuXHRleHRyYWN0KHpfZGF0YSwgYV9wYXRoPVtdLCB6aV9wYXRoX2xhc3Q9bnVsbCkge1xuXHRcdC8vIHByb3RlY3QgYWdhaW5zdCBbb2JqZWN0XSBudWxsXG5cdFx0aWYoIXpfZGF0YSkgcmV0dXJuIFtdO1xuXG5cdFx0Ly8gc2V0IG9mIHBhdGhzXG5cdFx0bGV0IGFfcGF0aHMgPSBbXTtcblxuXHRcdC8vIG9iamVjdFxuXHRcdGlmKCdvYmplY3QnID09PSB0eXBlb2Ygel9kYXRhKSB7XG5cdFx0XHQvLyBjb3B5IHBhdGhcblx0XHRcdGFfcGF0aCA9IGFfcGF0aC5zbGljZSgpO1xuXG5cdFx0XHQvLyBjb21taXQgdG8gaXRcblx0XHRcdGlmKG51bGwgIT09IHppX3BhdGhfbGFzdCkgYV9wYXRoLnB1c2goemlfcGF0aF9sYXN0KTtcblxuXHRcdFx0Ly8gcGxhaW4gb2JqZWN0IGxpdGVyYWxcblx0XHRcdGlmKE9iamVjdCA9PT0gel9kYXRhLmNvbnN0cnVjdG9yKSB7XG5cdFx0XHRcdC8vIHNjYW4gb3ZlciBlbnVtZXJhYmxlIHByb3BlcnRpZXNcblx0XHRcdFx0Zm9yKGxldCBzX3Byb3BlcnR5IGluIHpfZGF0YSkge1xuXHRcdFx0XHRcdC8vIGV4dHJhY3QgZGF0YSBhbmQgdHJhbnNmZXJzIGJ5IHJlY3Vyc2luZyBvbiBwcm9wZXJ0eVxuXHRcdFx0XHRcdGFfcGF0aHMucHVzaCguLi50aGlzLmV4dHJhY3Qoel9kYXRhW3NfcHJvcGVydHldLCBhX3BhdGgsIHNfcHJvcGVydHkpKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0Ly8gYXJyYXlcblx0XHRcdGVsc2UgaWYoQXJyYXkuaXNBcnJheSh6X2RhdGEpKSB7XG5cdFx0XHRcdC8vIGVtcHR5IGFycmF5XG5cdFx0XHRcdGlmKCF6X2RhdGEubGVuZ3RoKSByZXR1cm4gW107XG5cblx0XHRcdFx0Ly8gc2NhbiBvdmVyIGVhY2ggaXRlbVxuXHRcdFx0XHR6X2RhdGEuZm9yRWFjaCgoel9pdGVtLCBpX2l0ZW0pID0+IHtcblx0XHRcdFx0XHQvLyBleHRyYWN0IGRhdGEgYW5kIHRyYW5zZmVycyBieSByZWN1cnNpbmcgb24gaXRlbVxuXHRcdFx0XHRcdGFfcGF0aHMucHVzaCguLi50aGlzLmV4dHJhY3Qoel9pdGVtLCBhX3BhdGgsIGlfaXRlbSkpO1xuXHRcdFx0XHR9KTtcblx0XHRcdH1cblx0XHRcdC8vIHNoYXJlYWJsZSBkYXRhXG5cdFx0XHRlbHNlIGlmKHNoYXJpbmcoel9kYXRhKSkge1xuXHRcdFx0XHRyZXR1cm4gW2FfcGF0aF07XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gcmV0dXJuIHBhdGhzXG5cdFx0cmV0dXJuIGFfcGF0aHM7XG5cdH1cblxuXHRwcmVwZW5kKHpfYXJnKSB7XG5cdFx0Ly8gY29weSBpdGVtc1xuXHRcdGxldCBhX2l0ZW1zID0gdGhpcy5kYXRhLnNsaWNlKCk7XG5cblx0XHQvLyBjb3B5IHRyYW5zZmVyIHBhdGhzXG5cdFx0bGV0IGFfdHJhbnNmZXJfcGF0aHMgPSB0aGlzLnRyYW5zZmVyX3BhdGhzLnNsaWNlKCk7XG5cblx0XHQvLyBwdXNoIGEgbWFuaWZlc3QgdG8gZnJvbnRcblx0XHRpZih6X2FyZyBpbnN0YW5jZW9mIG1hbmlmZXN0KSB7XG5cdFx0XHQvLyBhZGQgaXRzIGNvbnRlbnRzIGFzIGEgc2luZ2xlIGl0ZW1cblx0XHRcdGFfaXRlbXMudW5zaGlmdCh6X2FyZy5kYXRhKTtcblxuXHRcdFx0Ly8gaG93IG1hbnkgcGF0aHMgdG8gb2Zmc2V0IGltcG9ydCBieVxuXHRcdFx0bGV0IG5sX3BhdGhzID0gYV90cmFuc2Zlcl9wYXRocy5sZW5ndGg7XG5cblx0XHRcdC8vIHVwZGF0ZSBpbXBvcnQgcGF0aHMgKHByaW1hcnkgaW5kZXggbmVlZHMgdXBkYXRlKVxuXHRcdFx0bGV0IGFfaW1wb3J0X3BhdGhzID0gel9hcmcudHJhbnNmZXJfcGF0aHM7XG5cdFx0XHRhX2ltcG9ydF9wYXRocy5mb3JFYWNoKChhX3BhdGgpID0+IHtcblx0XHRcdFx0YV9wYXRoWzBdICs9IG5sX3BhdGhzO1xuXHRcdFx0fSk7XG5cblx0XHRcdC8vIGFwcGVuZCBpdHMgdHJhbnNmZXIgcGF0aHNcblx0XHRcdGFfdHJhbnNmZXJfcGF0aHMucHVzaChhX2ltcG9ydF9wYXRocyk7XG5cdFx0fVxuXHRcdC8vIGFueXRoaW5nIGVsc2Vcblx0XHRlbHNlIHtcblx0XHRcdC8vIGp1c3QgYWRkIHRvIGZyb250XG5cdFx0XHRhX2l0ZW1zLnVuc2hpZnQoel9hcmcpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBuZXcgbWFuaWZlc3Rcblx0XHRyZXR1cm4gbmV3IG1hbmlmZXN0KGFfaXRlbXMsIGFfdHJhbnNmZXJfcGF0aHMpO1xuXHR9XG5cblx0cGF0aHMoLi4uYV91bnNoaWZ0KSB7XG5cdFx0cmV0dXJuIHRoaXMudHJhbnNmZXJfcGF0aHMubWFwKChhX3BhdGgpID0+IHtcblx0XHRcdHJldHVybiBbLi4uYV91bnNoaWZ0LCAuLi5hX3BhdGhdO1xuXHRcdH0pO1xuXHR9XG59O1xuIiwiY29uc3Qge1xuXHROX0NPUkVTLFxufSA9IHJlcXVpcmUoJy4vbG9jYWxzLmpzJyk7XG5cbmNvbnN0IGxvY2thYmxlID0gcmVxdWlyZSgnLi9sb2NrYWJsZS5qcycpO1xuXG5sZXQgd29ya2VyO1xuXG5jbGFzcyBwb29sIGV4dGVuZHMgbG9ja2FibGUge1xuXHRjb25zdHJ1Y3RvcihwX3NvdXJjZSwgLi4uYV9hcmdzKSB7XG5cdFx0c3VwZXIoKTtcblxuXHRcdC8vIGRlZmF1bHRzXG5cdFx0bGV0IG5fd29ya2VycyA9IE5fQ09SRVM7XG5cdFx0bGV0IGhfd29ya2VyX29wdGlvbnMgPSB7fTtcblxuXHRcdC8vIGNvbXBsZXRlbmVzc1xuXHRcdGlmKDIgPT09IGFfYXJncy5sZW5ndGgpIHtcblx0XHRcdG5fd29ya2VycyA9IGFfYXJnc1swXSB8fCBuX3dvcmtlcnM7XG5cdFx0XHRoX3dvcmtlcl9vcHRpb25zID0gYV9hcmdzWzFdIHx8IGhfd29ya2VyX29wdGlvbnM7XG5cdFx0fVxuXHRcdC8vIG9taXR0YW5jZVxuXHRcdGVsc2UgaWYoMSA9PT0gYV9hcmdzLmxlbmd0aCkge1xuXHRcdFx0Ly8gd29ya2VyIGNvdW50XG5cdFx0XHRpZignbnVtYmVyJyA9PT0gdHlwZW9mIGFfYXJnc1swXSkge1xuXHRcdFx0XHRuX3dvcmtlcnMgPSBhX2FyZ3NbMF07XG5cdFx0XHR9XG5cdFx0XHQvLyB3b3JrZXIgb3B0aW9uc1xuXHRcdFx0ZWxzZSBpZignb2JqZWN0JyA9PT0gdHlwZW9mIGhfd29ya2VyX29wdGlvbnMpIHtcblx0XHRcdFx0aF93b3JrZXJfb3B0aW9ucyA9IGFfYXJnc1swXTtcblx0XHRcdH1cblx0XHRcdC8vIGludmFsaWRcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHR0aHJvdyBuZXcgVHlwZUVycm9yKCdpbnZhbGlkIDJuZCBhcmd1bWVudDogJythX2FyZ3NbMF0pO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBjb21wbGV0ZW5lc3Ncblx0XHRlbHNlIGlmKCFuX3dvcmtlcnMpIHtcblx0XHRcdG5fd29ya2VycyA9IE5fQ09SRVM7XG5cdFx0fVxuXG5cdFx0Ly8gbmVnYXRpdmUgbnVtYmVyIGdpdmVuOyBzdWJ0cmFjdCBmcm9tIGNvcmUgY291bnRcblx0XHRpZihuX3dvcmtlcnMgPCAwKSBuX3dvcmtlcnMgPSBNYXRoLm1heCgxLCBOX0NPUkVTICsgbl93b3JrZXJzKTtcblxuXHRcdC8vIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0c291cmNlOiBwX3NvdXJjZSxcblx0XHRcdGxpbWl0OiBuX3dvcmtlcnMsXG5cdFx0XHR3b3JrZXJzOiBbXSxcblx0XHRcdGhpc3Rvcnk6IFtdLFxuXHRcdFx0d2FpdF9saXN0OiBbXSxcblx0XHRcdG9wdGlvbnM6IGhfd29ya2VyX29wdGlvbnMsXG5cdFx0fSk7XG5cdH1cblxuXHRzcGF3bl93b3JrZXIoKSB7XG5cdFx0bGV0IGFfd29ya2VycyA9IHRoaXMud29ya2VycztcblxuXHRcdC8vIGZvcmsgb3B0aW9uc1xuXHRcdGxldCBoX29wdGlvbnMgPSBPYmplY3QuY3JlYXRlKHRoaXMub3B0aW9ucyk7XG5cblx0XHQvLyBub2RlIGluc3BlY3Rcblx0XHRsZXQgaF9pbnNwZWN0ID0gdGhpcy5vcHRpb25zLmluc3BlY3Q7XG5cdFx0aWYoaF9pbnNwZWN0KSB7XG5cdFx0XHQvLyBpbnNwZWN0IHJhbmdlXG5cdFx0XHRpZihoX2luc3BlY3QucmFuZ2UgJiYgaF9pbnNwZWN0LnJhbmdlWzBdIDw9IGhfaW5zcGVjdC5yYW5nZVsxXSkge1xuXHRcdFx0XHRsZXQgaV9pbnNwZWN0ID0gaF9pbnNwZWN0LnJhbmdlWzBdO1xuXHRcdFx0XHRsZXQgYV9ub2RlX2FyZ3MgPSBoX29wdGlvbnMubm9kZV9hcmdzID0gaF9vcHRpb25zLm5vZGVfYXJncz8gaF9vcHRpb25zLm5vZGVfYXJncy5zbGljZSgwKTogW107XG5cdFx0XHRcdGFfbm9kZV9hcmdzLnB1c2goJy0taW5zcGVjdCcrKGhfaW5zcGVjdC5icmsgfHwgaF9pbnNwZWN0LmJyZWFrPyAnLWJyayc6ICcnKSsnPScrKGhfaW5zcGVjdC5yYW5nZVswXSsrKSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIG5ldyB3b3JrZXJcblx0XHRsZXQga193b3JrZXIgPSBuZXcgd29ya2VyKHtcblx0XHRcdHNvdXJjZTogdGhpcy5zb3VyY2UsXG5cdFx0XHRpZDogYV93b3JrZXJzLmxlbmd0aCxcblx0XHRcdG1hc3RlcjogdGhpcyxcblx0XHRcdG9wdGlvbnM6IE9iamVjdC5hc3NpZ24oaF9vcHRpb25zLCB7XG5cdFx0XHRcdGFyZ3M6IFtTdHJpbmcuZnJvbUNoYXJDb2RlKDY1K2Ffd29ya2Vycy5sZW5ndGgpLCAuLi4oaF9vcHRpb25zLmFyZ3MgfHwgW10pXSxcblx0XHRcdH0pLFxuXHRcdH0pO1xuXG5cdFx0Ly8gYWRkIHRvIHBvb2xcblx0XHRhX3dvcmtlcnMucHVzaChrX3dvcmtlcik7XG5cblx0XHQvLyBwcmV0ZW5kIGl0cyBub3QgYXZhaWxhYmxlIGZvciBzeW5jZWQgbWFwcGluZyBvZiBydW5cblx0XHRrX3dvcmtlci5idXN5ID0gdHJ1ZTtcblxuXHRcdC8vIGl0J3MgYWN0dWFsbHkgYXZhaWxhYmxlIHRob3VnaCA7KVxuXHRcdHJldHVybiBrX3dvcmtlcjtcblx0fVxuXG5cdHN1bW1vbigpIHtcblx0XHRsZXQgYV93b3JrZXJzID0gdGhpcy53b3JrZXJzO1xuXG5cdFx0Ly8gZWFjaCB3b3JrZXJcblx0XHRmb3IobGV0IGtfd29ya2VyIG9mIGFfd29ya2Vycykge1xuXHRcdFx0Ly8gd29ya2VyIG5vdCBidXN5XG5cdFx0XHRpZigha193b3JrZXIuYnVzeSkge1xuXHRcdFx0XHRyZXR1cm4ga193b3JrZXI7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gcm9vbSB0byBncm93XG5cdFx0aWYoYV93b3JrZXJzLmxlbmd0aCA8IHRoaXMubGltaXQpIHtcblx0XHRcdHJldHVybiB0aGlzLnNwYXduX3dvcmtlcigpO1xuXHRcdH1cblxuXHRcdC8vIHF1ZXVlIGZvciBub3RpZmljYXRpb24gd2hlbiB3b3JrZXJzIGJlY29tZSBhdmFpbGFibGVcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKGZrX3dvcmtlcikgPT4ge1xuXHRcdFx0dGhpcy53YWl0X2xpc3QucHVzaCgoa193b3JrZXIpID0+IHtcblx0XHRcdFx0Zmtfd29ya2VyKGtfd29ya2VyKTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9XG5cblx0cnVuKHNfdGFzaywgYV9hcmdzLCBoX2V2ZW50cykge1xuXHRcdGxldCBkcF9ydW4gPSBuZXcgUHJvbWlzZShhc3luYyAoZmtfcnVuLCBmZV9ydW4pID0+IHtcblx0XHRcdC8vIHN1bW1vbiBhIHdvcmtlclxuXHRcdFx0bGV0IGtfd29ya2VyID0gYXdhaXQgdGhpcy5zdW1tb24oKTtcblxuXHRcdFx0Ly8gcnVuIHRoaXMgdGFza1xuXHRcdFx0bGV0IHpfcmVzdWx0O1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0el9yZXN1bHQgPSBhd2FpdCBrX3dvcmtlci5ydW4oc190YXNrLCBhX2FyZ3MsIGhfZXZlbnRzKTtcblx0XHRcdH1cblx0XHRcdC8vIGVycm9yIHdoaWxlIHJ1bm5pbmcgdGFza1xuXHRcdFx0Y2F0Y2goZV9ydW4pIHtcblx0XHRcdFx0cmV0dXJuIGZlX3J1bihlX3J1bik7XG5cdFx0XHR9XG5cdFx0XHQvLyB3b3JrZXIgaXMgYXZhaWxhYmxlIG5vd1xuXHRcdFx0ZmluYWxseSB7XG5cdFx0XHRcdGxldCBhX3dhaXRfbGlzdCA9IHRoaXMud2FpdF9saXN0O1xuXG5cdFx0XHRcdC8vIGF0IGxlYXN0IG9uZSB0YXNrIGlzIHF1ZXVlZFxuXHRcdFx0XHRpZihhX3dhaXRfbGlzdC5sZW5ndGgpIHtcblx0XHRcdFx0XHRhX3dhaXRfbGlzdC5zaGlmdCgpKGtfd29ya2VyKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyByZXNvbHZlIHByb21pc2Vcblx0XHRcdGZrX3J1bih6X3Jlc3VsdCk7XG5cdFx0fSk7XG5cblx0XHR0aGlzLmhpc3RvcnkucHVzaChkcF9ydW4pO1xuXHRcdHJldHVybiBkcF9ydW47XG5cdH1cblxuXHRhc3luYyBraWxsKHNfc2lnbmFsKSB7XG5cdFx0cmV0dXJuIGF3YWl0IFByb21pc2UuYWxsKHRoaXMud29ya2Vycy5tYXAoKGtfd29ya2VyKSA9PiBrX3dvcmtlci5raWxsKHNfc2lnbmFsKSkpO1xuXHR9XG5cblx0c3RhcnQoKSB7XG5cdFx0dGhpcy5oaXN0b3J5Lmxlbmd0aCA9IDA7XG5cdH1cblxuXHRhc3luYyBzdG9wKCkge1xuXHRcdC8vIGNhY2hlIGhpc3Rvcnlcblx0XHRsZXQgYV9oaXN0b3J5ID0gdGhpcy5oaXN0b3J5O1xuXG5cdFx0Ly8gcmVzZXQgc3RhcnQgcG9pbnRcblx0XHR0aGlzLnN0YXJ0KCk7XG5cblx0XHQvLyBhd2FpdCBhbGwgcHJvbWlzZXMgdG8gZmluaXNoXG5cdFx0cmV0dXJuIGF3YWl0IFByb21pc2UuYWxsKGFfaGlzdG9yeSk7XG5cdH1cblxufTtcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihkY193b3JrZXIpIHtcblx0d29ya2VyID0gZGNfd29ya2VyO1xuXHRyZXR1cm4gcG9vbDtcbn07XG5cbiIsImNvbnN0IG1hbmlmZXN0ID0gcmVxdWlyZSgnLi9tYW5pZmVzdC5qcycpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGNsYXNzIHJlc3VsdCBleHRlbmRzIG1hbmlmZXN0IHtcblx0c3RhdGljIGZyb20oel9pdGVtKSB7XG5cdFx0aWYoel9pdGVtIGluc3RhbmNlb2YgcmVzdWx0KSB7XG5cdFx0XHRyZXR1cm4gel9pdGVtO1xuXHRcdH1cblx0XHRlbHNlIHtcblx0XHRcdHJldHVybiBuZXcgcmVzdWx0KHpfaXRlbSk7XG5cdFx0fVxuXHR9XG5cblx0Y29uc3RydWN0b3Ioel9yZXN1bHQsIHpfdHJhbnNmZXJfcGF0aHM9dHJ1ZSkge1xuXHRcdC8vIHRyYW5zZmVyIHBhdGhzIG5lZWRzIHRvIGJlIHByZXBlbmRlZCB3aXRoIHplcm8gaW5kZXhcblx0XHRpZihBcnJheS5pc0FycmF5KHpfdHJhbnNmZXJfcGF0aHMpKSB7XG5cdFx0XHR6X3RyYW5zZmVyX3BhdGhzLmZvckVhY2goYSA9PiBhLnVuc2hpZnQoMCkpO1xuXHRcdH1cblxuXHRcdHN1cGVyKFt6X3Jlc3VsdF0sIHpfdHJhbnNmZXJfcGF0aHMpO1xuXHR9XG5cblx0cHJlcGVuZCgpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ2Nhbm5vdCBwcmVwZW5kIGEgcmVzdWx0Jyk7XG5cdH1cbn07XG4iLCJjb25zdCBldmVudHMgPSByZXF1aXJlKCcuL2V2ZW50cy5qcycpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGNsYXNzIGNoYW5uZWwgZXh0ZW5kcyBNZXNzYWdlQ2hhbm5lbCB7XG5cdHN0YXRpYyBiZXR3ZWVuKGt3X3NlbmRlciwga3dfcmVjZWl2ZXIpIHtcblx0XHRsZXQgZF9jaGFubmVsID0ga3dfc2VuZGVyLmNoYW5uZWxzLmdldChrd19yZWNlaXZlcik7XG5cdFx0aWYoZF9jaGFubmVsKSByZXR1cm4gZF9jaGFubmVsO1xuXHRcdHJldHVybiBuZXcgY2hhbm5lbChrd19zZW5kZXIsIGt3X3JlY2VpdmVyKTtcblx0fVxuXG5cdHBvcnRfMSgpIHtcblx0XHRyZXR1cm4gZXZlbnRzKHRoaXMucG9ydDEpO1xuXHR9XG5cblx0cG9ydF8yKCkge1xuXHRcdHJldHVybiBldmVudHModGhpcy5wb3J0Mik7XG5cdH1cbn07XG4iLCJtb2R1bGUuZXhwb3J0cyA9IChkel90aGluZykgPT4ge1xuXHRPYmplY3QuYXNzaWduKGR6X3RoaW5nLCB7XG5cdFx0b24oLi4uYV9hcmdzKSB7XG5cdFx0XHQvLyBzaW5nbGUgZXZlbnRcblx0XHRcdGlmKDIgPT09IGFfYXJncy5sZW5ndGgpIHtcblx0XHRcdFx0dGhpc1snb24nK2FfYXJnc1swXV0gPSBhX2FyZ3NbMV07XG5cdFx0XHR9XG5cdFx0XHQvLyBtdWx0aXBsZSBldmVudHNcblx0XHRcdGVsc2UgaWYoMSA9PT0gYV9hcmdzLmxlbmd0aCAmJiAnb2JqZWN0JyA9PT0gdHlwZW9mIGFfYXJnc1swXSkge1xuXHRcdFx0XHRsZXQgaF9ldmVudHMgPSBhX2FyZ3NbMF07XG5cdFx0XHRcdGZvcihsZXQgc19ldmVudCBpbiBoX2V2ZW50cykge1xuXHRcdFx0XHRcdHRoaXNbJ29uJytzX2V2ZW50XSA9IGhfZXZlbnRzW3NfZXZlbnRdO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHQvLyBub3BlXG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdtaXN1c2Ugb2Ygb24gYmluZGluZycpO1xuXHRcdFx0fVxuXHRcdH0sXG5cblx0XHRyZW1vdmVMaXN0ZW5lcihzX2V2ZW50KSB7XG5cdFx0XHR0aGlzLnJlbW92ZUV2ZW50TGlzdGVuZXIoc19ldmVudCwgdGhpc1snb24nK3NfZXZlbnRdKTtcblx0XHR9LFxuXHR9KTtcblxuXHRyZXR1cm4gZHpfdGhpbmc7XG59O1xuIiwiY29uc3Qge1xuXHRLX1NFTEYsXG5cdHdlYndvcmtlcmlmeSxcbn0gPSByZXF1aXJlKCcuLi9hbGwvbG9jYWxzLmpzJyk7XG5cbmNvbnN0IGV2ZW50cyA9IHJlcXVpcmUoJy4vZXZlbnRzLmpzJyk7XG5cbmxldCBpX3N1Yndvcmtlcl9zcGF3biA9IDE7XG5sZXQgaF9zdWJ3b3JrZXJzID0ge307XG5cbmNsYXNzIGxhdGVudF9zdWJ3b3JrZXIge1xuXHRzdGF0aWMgY29ubmVjdChoX21zZykge1xuXHRcdGhfc3Vid29ya2Vyc1toX21zZy5pZF0uY29ubmVjdChoX21zZyk7XG5cdH1cblxuXHRjb25zdHJ1Y3RvcigpIHtcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdGlkOiBpX3N1Yndvcmtlcl9zcGF3bixcblx0XHRcdG1lc3NhZ2VzOiBbXSxcblx0XHRcdG1hc3Rlcl9rZXk6IDAsXG5cdFx0XHRwb3J0OiBudWxsLFxuXHRcdH0pO1xuXG5cdFx0aF9zdWJ3b3JrZXJzW2lfc3Vid29ya2VyX3NwYXduKytdID0gdGhpcztcblx0fVxuXG5cdGNvbm5lY3QoaF9tc2cpIHtcblx0XHRsZXQge1xuXHRcdFx0bWFzdGVyX2tleTogaV9tYXN0ZXIsXG5cdFx0XHRwb3J0OiBkX3BvcnQsXG5cdFx0fSA9IGhfbXNnO1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRtYXN0ZXJfa2V5OiBpX21hc3Rlcixcblx0XHRcdHBvcnQ6IGRfcG9ydCxcblx0XHR9KTtcblxuXHRcdC8vIGJpbmQgZXZlbnRzXG5cdFx0ZF9wb3J0Lm9ubWVzc2FnZSA9ICguLi5hX2FyZ3MpID0+IHtcblx0XHRcdHRoaXMub25tZXNzYWdlKC4uLmFfYXJncyk7XG5cdFx0fTtcblx0XHRkX3BvcnQub25tZXNzYWdlZXJyb3IgPSAoLi4uYV9hcmdzKSA9PiB7XG5cdFx0XHR0aGlzLm9ubWVzc2FnZWVycm9yKC4uLmFfYXJncyk7XG5cdFx0fTtcblxuXHRcdC8vIHByb2Nlc3MgbWVzc2FnZSBxdWV1ZVxuXHRcdHdoaWxlKHRoaXMubWVzc2FnZXMubGVuZ3RoKSB7XG5cdFx0XHRkX3BvcnQucG9zdE1lc3NhZ2UoLi4udGhpcy5tZXNzYWdlcy5zaGlmdCgpKTtcblx0XHR9XG5cdH1cblxuXHRwb3N0TWVzc2FnZSguLi5hX2FyZ3MpIHtcblx0XHRpZih0aGlzLnBvcnQpIHtcblx0XHRcdHRoaXMucG9ydC5wb3N0TWVzc2FnZSguLi5hX2FyZ3MpO1xuXHRcdH1cblx0XHRlbHNlIHtcblx0XHRcdHRoaXMubWVzc2FnZXMucHVzaChhX2FyZ3MpO1xuXHRcdH1cblx0fVxuXG5cdG9ubWVzc2FnZSgpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ3JlY2VpdmVkIG1lc3NhZ2UgZnJvbSBzdWJ3b3JrZXIgYmVmb3JlIGl0cyBwb3J0IHdhcyBjb25uZWN0ZWQnKTtcblx0fVxuXG5cdG9ubWVzc2FnZWVycm9yKCkge1xuXHRcdHRocm93IG5ldyBFcnJvcigncmVjZWl2ZWQgbWVzc2FnZSBlcnJvciBmcm9tIHN1YndvcmtlciBiZWZvcmUgaXRzIHBvcnQgd2FzIGNvbm5lY3RlZCcpO1xuXHR9XG5cblx0dGVybWluYXRlKCkge1xuXHRcdHRoaXMucG9ydC5jbG9zZSgpO1xuXHRcdEtfU0VMRi5wb3N0TWVzc2FnZSh7XG5cdFx0XHR0eXBlOiAndGVybWluYXRlJyxcblx0XHRcdG1hc3Rlcl9rZXk6IHRoaXMubWFzdGVyX2tleSxcblx0XHR9KTtcblx0fVxuXG5cdHdlYndvcmtlcmlmeSh6X2ltcG9ydCwgYV9icm93c2VyaWZ5LCBoX29wdGlvbnM9e30pIHtcblx0XHRsZXQgc19zb3VyY2UgPSB3ZWJ3b3JrZXJpZnkoel9pbXBvcnQsIGFfYnJvd3NlcmlmeSwgaF9vcHRpb25zKTtcblxuXHRcdEtfU0VMRi5wb3N0TWVzc2FnZSh7XG5cdFx0XHR0eXBlOiAnc3Bhd24nLFxuXHRcdFx0c291cmNlOiBzX3NvdXJjZSxcblx0XHRcdG9wdGlvbnM6IGhfb3B0aW9ucyxcblx0XHR9KTtcblx0fVxufVxuXG5ldmVudHMobGF0ZW50X3N1Yndvcmtlci5wcm90b3R5cGUpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGxhdGVudF9zdWJ3b3JrZXI7XG4iLCJtb2R1bGUuZXhwb3J0cyA9IHtcblx0S19TRUxGOiByZXF1aXJlKCcuL3NlbGYuanMnKSxcblx0RENfV09SS0VSOiAndW5kZWZpbmVkJyA9PT0gdHlwZW9mIFdvcmtlcj8gdW5kZWZpbmVkOiByZXF1aXJlKCcuL3dvcmtlci5qcycpLFxuXHREQ19DSEFOTkVMOiByZXF1aXJlKCcuL2NoYW5uZWwuanMnKSxcblx0SF9UWVBFRF9BUlJBWVM6IHJlcXVpcmUoJy4vdHlwZWQtYXJyYXlzLmpzJyksXG5cdE5fQ09SRVM6IG5hdmlnYXRvci5oYXJkd2FyZUNvbmN1cnJlbmN5IHx8IDEsXG5cdHNoYXJpbmc6IHJlcXVpcmUoJy4vc2hhcmluZy5qcycpLFxuXHRzdHJlYW06IHJlcXVpcmUoJy4vc3RyZWFtLmpzJyksXG5cdHBvcnRzOiByZXF1aXJlKCcuL3BvcnRzLmpzJyksXG59O1xuIiwiY29uc3QgZXZlbnRzID0gcmVxdWlyZSgnLi9ldmVudHMuanMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSAoZF9wb3J0KSA9PiBldmVudHMoZF9wb3J0KTtcbiIsImNvbnN0IGV2ZW50cyA9IHJlcXVpcmUoJy4vZXZlbnRzLmpzJyk7XG5cbmV2ZW50cyhzZWxmKTtcblxuc2VsZi5hcmdzID0gW1xuXHQoTWF0aC5yYW5kb20oKSsnJykuc2xpY2UoMiwgOCksXG5dO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHNlbGY7XG4iLCJjb25zdCBzdHJlYW0gPSByZXF1aXJlKCcuL3N0cmVhbS5qcycpO1xuXG5jb25zdCAkX1NIQVJFQUJMRSA9IFN5bWJvbCgnc2hhcmVhYmxlJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gT2JqZWN0LmFzc2lnbihmdW5jdGlvbih6X29iamVjdCkge1xuXHRyZXR1cm4gJ29iamVjdCcgPT09IHR5cGVvZiB6X29iamVjdCAmJlxuXHRcdChBcnJheUJ1ZmZlci5pc1ZpZXcoel9vYmplY3QpXG5cdFx0XHR8fCB6X29iamVjdCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyXG5cdFx0XHR8fCB6X29iamVjdCBpbnN0YW5jZW9mIE1lc3NhZ2VQb3J0XG5cdFx0XHR8fCB6X29iamVjdCBpbnN0YW5jZW9mIEltYWdlQml0bWFwXG5cdFx0XHR8fCAkX1NIQVJFQUJMRSBpbiB6X29iamVjdCk7XG59LCB7XG5cdCRfU0hBUkVBQkxFLFxuXG5cdGV4dHJhY3Q6IGZ1bmN0aW9uIGV4dHJhY3Qoel9kYXRhLCBhc190cmFuc2ZlcnM9bnVsbCkge1xuXHRcdC8vIHByb3RlY3QgYWdhaW5zdCBbb2JqZWN0XSBudWxsXG5cdFx0aWYoIXpfZGF0YSkgcmV0dXJuIFt6X2RhdGEsIFtdXTtcblxuXHRcdC8vIHNldCBvZiB0cmFuc2ZlciBvYmplY3RzXG5cdFx0aWYoIWFzX3RyYW5zZmVycykgYXNfdHJhbnNmZXJzID0gbmV3IFNldCgpO1xuXG5cdFx0Ly8gb2JqZWN0XG5cdFx0aWYoJ29iamVjdCcgPT09IHR5cGVvZiB6X2RhdGEpIHtcblx0XHRcdC8vIHBsYWluIG9iamVjdCBsaXRlcmFsXG5cdFx0XHRpZihPYmplY3QgPT09IHpfZGF0YS5jb25zdHJ1Y3Rvcikge1xuXHRcdFx0XHQvLyBzY2FuIG92ZXIgZW51bWVyYWJsZSBwcm9wZXJ0aWVzXG5cdFx0XHRcdGZvcihsZXQgc19wcm9wZXJ0eSBpbiB6X2RhdGEpIHtcblx0XHRcdFx0XHQvLyBhZGQgZWFjaCB0cmFuc2ZlcmFibGUgZnJvbSByZWN1cnNpb24gdG8gb3duIHNldFxuXHRcdFx0XHRcdGV4dHJhY3Qoel9kYXRhW3NfcHJvcGVydHldLCBhc190cmFuc2ZlcnMpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHQvLyBhcnJheVxuXHRcdFx0ZWxzZSBpZihBcnJheS5pc0FycmF5KHpfZGF0YSkpIHtcblx0XHRcdFx0Ly8gc2NhbiBvdmVyIGVhY2ggaXRlbVxuXHRcdFx0XHR6X2RhdGEuZm9yRWFjaCgoel9pdGVtKSA9PiB7XG5cdFx0XHRcdFx0Ly8gYWRkIGVhY2ggdHJhbnNmZXJhYmxlIGZyb20gcmVjdXJzaW9uIHRvIG93biBzZXRcblx0XHRcdFx0XHRleHRyYWN0KHpfaXRlbSwgYXNfdHJhbnNmZXJzKTtcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0XHQvLyB0eXBlZCBhcnJheSwgZGF0YSB2aWV3IG9yIGFycmF5IGJ1ZmZlclxuXHRcdFx0ZWxzZSBpZihBcnJheUJ1ZmZlci5pc1ZpZXcoel9kYXRhKSkge1xuXHRcdFx0XHRhc190cmFuc2ZlcnMuYWRkKHpfZGF0YS5idWZmZXIpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYXJyYXkgYnVmZmVyXG5cdFx0XHRlbHNlIGlmKHpfZGF0YSBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHRcdGFzX3RyYW5zZmVycy5hZGQoel9kYXRhKTtcblx0XHRcdH1cblx0XHRcdC8vIG1lc3NhZ2UgcG9ydFxuXHRcdFx0ZWxzZSBpZih6X2RhdGEgaW5zdGFuY2VvZiBNZXNzYWdlUG9ydCkge1xuXHRcdFx0XHRhc190cmFuc2ZlcnMuYWRkKHpfZGF0YSk7XG5cdFx0XHR9XG5cdFx0XHQvLyBpbWFnZSBiaXRtYXBcblx0XHRcdGVsc2UgaWYoel9kYXRhIGluc3RhbmNlb2YgSW1hZ2VCaXRtYXApIHtcblx0XHRcdFx0YXNfdHJhbnNmZXJzLmFkZCh6X2RhdGEpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gc3RyZWFtXG5cdFx0XHRlbHNlIGlmKHN0cmVhbS5pc19zdHJlYW0oel9kYXRhKSkge1xuXHRcdFx0XHRsZXQgYV90cmFuc2ZlcnMgPSBbXTtcblx0XHRcdFx0W3pfZGF0YSwgYV90cmFuc2ZlcnNdID0gc3RyZWFtLnNlcmlhbGl6ZSh6X2RhdGEpO1xuXHRcdFx0XHRhc190cmFuc2ZlcnMuYWRkKGFfdHJhbnNmZXJzKTtcblx0XHRcdH1cblx0XHRcdC8vIHNoYXJlYWJsZVxuXHRcdFx0ZWxzZSBpZigkX1NIQVJFQUJMRSBpbiB6X2RhdGEpIHtcblx0XHRcdFx0bGV0IGFfdHJhbnNmZXJzID0gW107XG5cdFx0XHRcdFt6X2RhdGEsIGFfdHJhbnNmZXJzXSA9IHpfZGF0YVskX1NIQVJFQUJMRV0oKTtcblx0XHRcdFx0YXNfdHJhbnNmZXJzLmFkZChhX3RyYW5zZmVycyk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGZ1bmN0aW9uXG5cdFx0ZWxzZSBpZignZnVuY3Rpb24nID09PSB0eXBlb2Ygel9kYXRhKSB7XG5cdFx0XHQvLyBzY2FuIG92ZXIgZW51bWVyYWJsZSBwcm9wZXJ0aWVzXG5cdFx0XHRmb3IobGV0IHNfcHJvcGVydHkgaW4gel9kYXRhKSB7XG5cdFx0XHRcdC8vIGFkZCBlYWNoIHRyYW5zZmVyYWJsZSBmcm9tIHJlY3Vyc2lvbiB0byBvd24gc2V0XG5cdFx0XHRcdGV4dHJhY3Qoel9kYXRhW3NfcHJvcGVydHldLCBhc190cmFuc2ZlcnMpO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBub3RoaW5nXG5cdFx0ZWxzZSB7XG5cdFx0XHRyZXR1cm4gW3pfZGF0YSwgW11dO1xuXHRcdH1cblxuXHRcdC8vIGNvbnZlcnQgc2V0IHRvIGFycmF5XG5cdFx0cmV0dXJuIFt6X2RhdGEsIEFycmF5LmZyb20oYXNfdHJhbnNmZXJzKV07XG5cdH0sXG5cblx0cG9wdWxhdGUoaF9tc2cpIHtcblx0XHRsZXQge1xuXHRcdFx0ZGF0YTogaF9kYXRhLFxuXHRcdFx0dHJhbnNmZXJzOiBhX3RyYW5zZmVycyxcblx0XHR9ID0gaF9tc2c7XG5cblx0XHQvLyBlYWNoIHRyYW5zZmVyXG5cdFx0YV90cmFuc2ZlcnMuZm9yRWFjaCgoaF90cmFuc2ZlcikgPT4ge1xuXHRcdFx0Ly8gcGF0aCB0byBvYmplY3Rcblx0XHRcdGxldCBhX3BhdGggPSBoX3RyYW5zZmVyLnBhdGg7XG5cblx0XHRcdC8vIHdhbGsgcGF0aFxuXHRcdFx0bGV0IHpfd2FsayA9IGhfaGVhZDtcblx0XHRcdGxldCBubF9wYXRoID0gYV9wYXRoLmxlbmd0aDtcblx0XHRcdGFfcGF0aC5mb3JFYWNoKChzX3N0ZXAsIGlfc3RlcCkgPT4ge1xuXHRcdFx0XHQvLyBmaW5hbCBzdGVwXG5cdFx0XHRcdGlmKGlfc3RlcCA9PT0gbmxfcGF0aC0xKSB7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBubyBzdWNoIHN0ZXBcblx0XHRcdFx0aWYoIShzX3N0ZXAgaW4gel93YWxrKSkge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgbm8gc3VjaCBrZXkgJyR7c19zdGVwfScgZm91bmQgd2hpbGUgd2Fsa2luZyBwYXRoIGFsb25nIC4ke2FfcGF0aC5qb2luKCcuJyl9YCk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyB0YWtlIHN0ZXBcblx0XHRcdFx0el93YWxrID0gel93YWxrW3Nfc3RlcF07XG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdC8vIHN0cmVhbSBvYmplY3Rcblx0fSxcbn0pO1xuIiwiY29uc3Qgbm9kZV9ldmVudHMgPSByZXF1aXJlKCdldmVudHMnKTtcblxuY29uc3Qgc2hhcmluZyA9IHJlcXVpcmUoJy4vc2hhcmluZy5qcycpO1xuXG5jbGFzcyByZWFkYWJsZV9zdHJlYW0gZXh0ZW5kcyBub2RlX2V2ZW50cy5FdmVudEVtaXR0ZXIge1xuXHRjb25zdHJ1Y3RvcigpIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRkZWNvZGVyOiBudWxsLFxuXHRcdFx0cGF1c2VkOiBmYWxzZSxcblx0XHRcdGNvbnN1bWVkOiAwLFxuXHRcdH0pO1xuXHR9XG5cblx0c2V0RW5jb2Rpbmcoc19lbmNvZGluZykge1xuXHRcdHRoaXMuZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcihzX2VuY29kaW5nKTtcblx0fVxuXG5cdHBhdXNlKCkge1xuXHRcdHRoaXMucGF1c2VkID0gdHJ1ZTtcblx0fVxuXG5cdHJlc3VtZSgpIHtcblx0XHR0aGlzLnBhdXNlZCA9IGZhbHNlO1xuXHRcdHRoaXMubmV4dF9jaHVuaygpO1xuXHR9XG5cblx0Y2h1bmsoYXRfY2h1bmssIGJfZW9mKSB7XG5cdFx0bGV0IG5sX2NodW5rID0gYXRfY2h1bmsubGVuZ3RoO1xuXHRcdHRoaXMuY29uc3VtZWQgKz0gbmxfY2h1bms7XG5cblx0XHQvLyBkZWNvZGUgZGF0YVxuXHRcdGlmKHRoaXMuZGVjb2Rlcikge1xuXHRcdFx0bGV0IHNfZGF0YTtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdHNfZGF0YSA9IHRoaXMuZGVjb2Rlci5kZWNvZGUoYXRfY2h1bmssIHtzdHJlYW06IWJfZW9mfSk7XG5cdFx0XHR9XG5cdFx0XHRjYXRjaChlX2RlY29kZSkge1xuXHRcdFx0XHR0aGlzLmVtaXQoJ2Vycm9yJywgZV9kZWNvZGUpO1xuXHRcdFx0fVxuXG5cdFx0XHR0aGlzLmVtaXQoJ2RhdGEnLCBzX2RhdGEsIGF0X2NodW5rKTtcblx0XHR9XG5cdFx0Ly8gbm8gZW5jb2Rpbmdcblx0XHRlbHNlIHtcblx0XHRcdHRoaXMuZW1pdCgnZGF0YScsIGF0X2NodW5rLCBhdF9jaHVuayk7XG5cdFx0fVxuXG5cdFx0Ly8gZW5kIG9mIGZpbGVcblx0XHRpZihiX2VvZikge1xuXHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdHRoaXMuZW1pdCgnZW5kJyk7XG5cdFx0XHR9LCAwKTtcblx0XHR9XG5cdFx0Ly8gcmVxdWVzdCBtb3JlIGRhdGFcblx0XHRlbHNlIGlmKCF0aGlzLnBhdXNlZCkge1xuXHRcdFx0dGhpcy5uZXh0X2NodW5rKCk7XG5cdFx0fVxuXHR9XG59XG5cbk9iamVjdC5hc3NpZ24ocmVhZGFibGVfc3RyZWFtLnByb3RvdHlwZSwge1xuXHRlbWl0c0J5dGVDb3VudHM6IHRydWUsXG59KTtcblxuY2xhc3MgcmVhZGFibGVfc3RyZWFtX3ZpYV9wb3J0IGV4dGVuZHMgcmVhZGFibGVfc3RyZWFtIHtcblx0Y29uc3RydWN0b3IoZF9wb3J0KSB7XG5cdFx0c3VwZXIoKTtcblxuXHRcdC8vIG1lc3NhZ2UgaGFuZGxpbmdcblx0XHRkX3BvcnQub25tZXNzYWdlID0gKGRfbXNnKSA9PiB7XG5cdFx0XHRsZXQge1xuXHRcdFx0XHRjb250ZW50OiBhdF9jb250ZW50LFxuXHRcdFx0XHRlb2Y6IGJfZW9mLFxuXHRcdFx0fSA9IGRfbXNnLmRhdGE7XG5cblx0XHRcdC8vIHN0YXJ0IHRpbWluZ1xuXHRcdFx0dGhpcy5zdGFydGVkID0gcGVyZm9ybWFuY2Uubm93KCk7XG5cblx0XHRcdC8vIHByb2Nlc3MgY2h1bmtcblx0XHRcdHRoaXMuY2h1bmsoYXRfY29udGVudCwgYl9lb2YpO1xuXHRcdH07XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdHBvcnQ6IGRfcG9ydCxcblx0XHRcdHN0YXJ0ZWQ6IDAsXG5cdFx0fSk7XG5cdH1cblxuXHRzZXRFbmNvZGluZyhzX2VuY29kaW5nKSB7XG5cdFx0dGhpcy5kZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKHNfZW5jb2RpbmcpO1xuXHR9XG5cblx0bmV4dF9jaHVuaygpIHtcblx0XHRsZXQgdF9lbGFwc2VkID0gcGVyZm9ybWFuY2Uubm93KCkgLSB0aGlzLnN0YXJ0ZWQ7XG5cbi8vIGNvbnNvbGUubG9nKCdTID09PiBbQUNLIC8gbmV4dCBjaHVua10nKTtcblxuXHRcdHRoaXMucG9ydC5wb3N0TWVzc2FnZSh7XG5cdFx0XHRwb3N0ZWQ6IHBlcmZvcm1hbmNlLm5vdygpLFxuXHRcdFx0ZWxhcHNlZDogdF9lbGFwc2VkLFxuXHRcdH0pO1xuXHR9XG5cblx0Ly8gcGF1c2UoKSB7XG5cblx0Ly8gfVxuXG5cdC8vIHJlc3VtZShiX2RvbnRfdW5wYXVzZT1mYWxzZSkge1xuXHQvLyBcdGxldCB0X2VsYXBzZWQgPSBwZXJmb3JtYW5jZS5ub3coKSAtIHRoaXMuc3RhcnRlZDtcblxuXHQvLyBcdHNlbGYucG9zdE1lc3NhZ2Uoe1xuXHQvLyBcdFx0ZWxhcHNlZDogdF9lbGFwc2VkLFxuXHQvLyBcdH0pO1xuXHQvLyB9XG5cblx0Ly8gcGlwZSh5X3dyaXRhYmxlKSB7XG5cdC8vIFx0dGhpcy5vbignZGF0YScsICh6X2NodW5rKSA9PiB7XG5cdC8vIFx0XHRsZXQgYl9jYXBhY2l0eSA9IHlfd3JpdGFibGUud3JpdGUoel9jaHVuayk7XG5cblx0Ly8gXHRcdC8vIGZldGNoIG5leHQgY2h1bms7IG90aGVyd2lzZSBhd2FpdCBkcmFpblxuXHQvLyBcdFx0aWYoZmFsc2UgIT09IGJfY2FwYWNpdHkpIHtcblx0Ly8gXHRcdFx0dGhpcy5yZXN1bWUodHJ1ZSk7XG5cdC8vIFx0XHR9XG5cdC8vIFx0fSk7XG5cblx0Ly8gXHR5X3dyaXRhYmxlLm9uKCdkcmFpbicsICgpID0+IHtcblx0Ly8gXHRcdHRoaXMucmVzdW1lKHRydWUpO1xuXHQvLyBcdH0pO1xuXG5cdC8vIFx0eV93cml0YWJsZS5lbWl0KCdwaXBlJywgdGhpcyk7XG5cdC8vIH1cbn1cblxuXG5cbmNsYXNzIHJlYWRhYmxlX3N0cmVhbV92aWFfb2JqZWN0X3VybCBleHRlbmRzIHJlYWRhYmxlX3N0cmVhbSB7XG5cdGNvbnN0cnVjdG9yKHBfb2JqZWN0X3VybCwgaF9jb25maWc9e30pIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0ZmV0Y2gocF9vYmplY3RfdXJsKVxuXHRcdFx0LnRoZW4oZF9yZXMgPT4gZF9yZXMuYmxvYigpKVxuXHRcdFx0LnRoZW4oKGRmYl9pbnB1dCkgPT4ge1xuXHRcdFx0XHRpZih0aGlzLm9uYmxvYikgdGhpcy5vbmJsb2IoZGZiX2lucHV0KTtcblx0XHRcdFx0bGV0IGtfYmxvYl9yZWFkZXIgPSB0aGlzLmJsb2JfcmVhZGVyID0gbmV3IGJsb2JfcmVhZGVyKHRoaXMsIGRmYl9pbnB1dCwgaF9jb25maWcpO1xuXHRcdFx0XHR0aGlzLm9uKCdlbmQnLCAoKSA9PiB7XG5cdFx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHRcdFx0VVJMLnJldm9rZU9iamVjdFVSTChwX29iamVjdF91cmwpO1xuXHRcdFx0XHR9KTtcblx0XHRcdFx0a19ibG9iX3JlYWRlci5uZXh0X2NodW5rKCk7XG5cdFx0XHR9KTtcblxuXHRcdE9iamVjdC5hc3NpZ24odGhpcywge1xuXHRcdFx0YmxvYl9yZWFkZXI6IG51bGwsXG5cdFx0XHRvYmplY3RfdXJsOiBwX29iamVjdF91cmwsXG5cdFx0fSk7XG5cdH1cblxuXHRuZXh0X2NodW5rKCkge1xuXHRcdHRoaXMuYmxvYl9yZWFkZXIubmV4dF9jaHVuaygpO1xuXHR9XG5cblx0Ly8gb24oc19ldmVudCwgZmtfZXZlbnQpIHtcblx0Ly8gXHRzdXBlci5vbihzX2V2ZW50LCBma19ldmVudCk7XG5cblx0Ly8gXHRpZignZGF0YScgPT09IHNfZXZlbnQpIHtcblx0Ly8gXHRcdGlmKCF0aGlzLmJsb2IpIHtcblx0Ly8gXHRcdFx0dGhpcy5vbl9ibG9iID0gdGhpcy5yZXN1bWU7XG5cdC8vIFx0XHR9XG5cdC8vIFx0XHRlbHNlIHtcblx0Ly8gXHRcdFx0dGhpcy5yZXN1bWUoKTtcblx0Ly8gXHRcdH1cblx0Ly8gXHR9XG5cdC8vIH1cbn1cblxuY2xhc3MgdHJhbnNmZXJfc3RyZWFtIHtcblx0Y29uc3RydWN0b3IoKSB7XG5cdFx0bGV0IGRfY2hhbm5lbCA9IG5ldyBNZXNzYWdlQ2hhbm5lbCgpO1xuXHRcdGxldCBkX3BvcnQgPSBkX2NoYW5uZWwucG9ydDE7XG5cblx0XHRkX3BvcnQub25tZXNzYWdlID0gKGRfbXNnKSA9PiB7XG5cdFx0XHRsZXQgdF9lbGFwc2VkX21haW4gPSB0aGlzLmVsYXBzZWQ7XG5cblx0XHRcdGxldCB7XG5cdFx0XHRcdHBvc3RlZDogdF9wb3N0ZWQsXG5cdFx0XHRcdGVsYXBzZWQ6IHRfZWxhcHNlZF9vdGhlcixcblx0XHRcdH0gPSBkX21zZy5kYXRhO1xuXG5cdFx0XHQvLyBjb25zb2xlLmxvZygnICsrIHBhcnNlOiAnK3RfZWxhcHNlZF9vdGhlcik7XG5cdFx0XHR0aGlzLnJlY2VpdmVyX2VsYXBzZWQgKz0gdF9lbGFwc2VkX290aGVyO1xuXG4vLyBjb25zb2xlLmxvZygnTSA8PT0gW0FDSyAvIG5leHQgY2h1bmtdOyBidWZmZXI6ICcrKCEhdGhpcy5idWZmZXIpKyc7IGJ1c3k6ICcrdGhpcy5yZWNlaXZlcl9idXN5Kyc7IGVvZjonK3RoaXMucmVhZGVyLmVvZik7ICAvL3Bvc3RlZCBAJyt0X3Bvc3RlZCk7XG5cblx0XHRcdC8vIHJlY2VpdmVyIGlzIGZyZWVcblx0XHRcdHRoaXMucmVjZWl2ZXJfYnVzeSA9IGZhbHNlO1xuXG5cdFx0XHQvLyBjaHVuayByZWFkeSB0byBnb1xuXHRcdFx0aWYodGhpcy5idWZmZXIpIHtcblx0XHRcdFx0dGhpcy5zZW5kKHRoaXMuYnVmZmVyLCB0aGlzLmJ1ZmZlcl9lb2YpO1xuXHRcdFx0XHR0aGlzLmJ1ZmZlciA9IG51bGw7XG5cdFx0XHR9XG5cblx0XHRcdC8vIHJlYWRlciBpcyBub3QgYnVzeVxuXHRcdFx0aWYoIXRoaXMucmVhZGVyLmJ1c3kpIHtcblx0XHRcdFx0dGhpcy5yZWFkZXIubmV4dF9jaHVuaygpO1xuXHRcdFx0fVxuXHRcdH07XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdG1haW5fcG9ydDogZF9wb3J0LFxuXHRcdFx0b3RoZXJfcG9ydDogZF9jaGFubmVsLnBvcnQyLFxuXHRcdFx0ZWxhcHNlZDogMCxcblx0XHRcdHJlYWRlcjogbnVsbCxcblx0XHRcdGJ1ZmZlcjogbnVsbCxcblx0XHRcdGJ1ZmZlcl9lb2Y6IHRydWUsXG5cdFx0XHRyZWNlaXZlcl9idXN5OiBmYWxzZSxcblx0XHRcdHJlY2VpdmVyX2VsYXBzZWQ6IDAsXG5cblx0XHRcdC8vIHNlcmlhbGl6ZSB0aGlzIHN0cmVhbVxuXHRcdFx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdKCkge1xuXHRcdFx0XHRyZXR1cm4gW3tcblx0XHRcdFx0XHR0eXBlOiAncmVhZGFibGVfc3RyZWFtJyxcblx0XHRcdFx0XHRwb3J0OiB0aGlzLm90aGVyX3BvcnQsXG5cdFx0XHRcdH0sIHRoaXMub3RoZXJfcG9ydF07XG5cdFx0XHR9LFxuXHRcdH0pO1xuXHR9XG5cblx0c2VuZChhdF9jaHVuaywgYl9lb2Y9dHJ1ZSkge1xuXHRcdHRoaXMucmVjZWl2ZXJfYnVzeSA9IHRydWU7XG5cbi8vIGNvbnNvbGUubG9nKCdNID09PiBbY2h1bmtdJyk7XG5cblx0XHQvLyBzZW5kIHRvIHJlY2VpdmVyXG5cdFx0dGhpcy5tYWluX3BvcnQucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0Y29udGVudDogYXRfY2h1bmssXG5cdFx0XHRlb2Y6IGJfZW9mLFxuXHRcdH0sIFthdF9jaHVuay5idWZmZXJdKTtcblx0fVxuXG5cdGNodW5rKGF0X2NodW5rLCBiX2VvZj10cnVlKSB7XG4vLyBjb25zb2xlLmxvZygnYmxvYiBjaHVuayByZWFkeSB0byBzZW5kOyBidWZmZXI6ICcrKCEhdGhpcy5idWZmZXIpKyc7IGJ1c3k6ICcrdGhpcy5yZWNlaXZlcl9idXN5KTtcblxuXHRcdC8vIHJlY2VpdmVyIGlzIGJ1c3ksIHF1ZXVlIGluIGJ1ZmZlclxuXHRcdGlmKHRoaXMucmVjZWl2ZXJfYnVzeSkge1xuXHRcdFx0dGhpcy5idWZmZXIgPSBhdF9jaHVuaztcblx0XHRcdHRoaXMuYnVmZmVyX2VvZiA9IGJfZW9mO1xuXHRcdH1cblx0XHQvLyByZWNlaXZlciBhdmFpbGFibGU7IHNlbmQgaW1tZWRpYXRlbHlcblx0XHRlbHNlIHtcblx0XHRcdC8vIHByZWZldGNoIG5leHQgY2h1bmtcblx0XHRcdGlmKCF0aGlzLmJ1ZmZlciAmJiAhdGhpcy5yZWFkZXIuZW9mKSB7XG5cdFx0XHRcdHRoaXMucmVhZGVyLm5leHRfY2h1bmsoKTtcblx0XHRcdH1cblxuXHRcdFx0dGhpcy5zZW5kKGF0X2NodW5rLCBiX2VvZik7XG5cdFx0fVxuXHR9XG5cblx0YmxvYihkZmJfaW5wdXQsIGhfY29uZmlnPXt9KSB7XG5cdFx0dGhpcy5yZWFkZXIgPSBuZXcgYmxvYl9yZWFkZXIodGhpcywgZGZiX2lucHV0LCBoX2NvbmZpZyk7XG5cblx0XHQvLyBzdGFydCBzZW5kaW5nXG5cdFx0dGhpcy5yZWFkZXIubmV4dF9jaHVuaygpO1xuXHR9XG59XG5cbmNsYXNzIGJsb2JfcmVhZGVyIHtcblx0Y29uc3RydWN0b3Ioa19wYXJlbnQsIGRmYl9pbnB1dCwgaF9jb25maWc9e30pIHtcblx0XHRsZXQgZGZyX3JlYWRlciA9IG5ldyBGaWxlUmVhZGVyKCk7XG5cdFx0ZGZyX3JlYWRlci5vbmxvYWQgPSAoZF9ldmVudCkgPT4ge1xuXHRcdFx0dGhpcy5idXN5ID0gZmFsc2U7XG5cdFx0XHQvLyBsZXQgYl9lb2YgPSBmYWxzZTtcblx0XHRcdC8vIGlmKCsrdGhpcy5jaHVua3NfcmVhZCA9PT0gdGhpcy5jaHVua3NfbG9hZGVkKSBiX2VvZiA9IHRoaXMuZW9mO1xuXHRcdFx0a19wYXJlbnQuY2h1bmsobmV3IFVpbnQ4QXJyYXkoZF9ldmVudC50YXJnZXQucmVzdWx0KSwgdGhpcy5lb2YpO1xuXHRcdH07XG5cblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIHtcblx0XHRcdGVvZjogZmFsc2UsXG5cdFx0XHRidXN5OiBmYWxzZSxcblx0XHRcdHJlYWRfaW5kZXg6IDAsXG5cdFx0XHRjaHVua19zaXplOiBoX2NvbmZpZy5jaHVua19zaXplIHx8IGhfY29uZmlnLmNodW5rU2l6ZSB8fCAxMDI0ICogMTAyNCAqIDEsICAvLyAxIE1pQlxuXHRcdFx0Y29udGVudDogZGZiX2lucHV0LFxuXHRcdFx0Y29udGVudF9sZW5ndGg6IGRmYl9pbnB1dC5zaXplLFxuXHRcdFx0ZmlsZV9yZWFkZXI6IGRmcl9yZWFkZXIsXG5cdFx0XHRjaHVua3NfbG9hZGVkOiAwLFxuXHRcdFx0Y2h1bmtzX3JlYWQ6IDAsXG5cdFx0fSk7XG5cdH1cblxuXHRuZXh0X2NodW5rKCkge1xuXHRcdGxldCB7XG5cdFx0XHRyZWFkX2luZGV4OiBpX3JlYWQsXG5cdFx0XHRjaHVua19zaXplOiBuX2NodW5rX3NpemUsXG5cdFx0XHRjb250ZW50OiBkZmJfY29udGVudCxcblx0XHRcdGNvbnRlbnRfbGVuZ3RoOiBubF9jb250ZW50LFxuXHRcdH0gPSB0aGlzO1xuXG5cdFx0bGV0IGlfZW5kID0gaV9yZWFkICsgbl9jaHVua19zaXplO1xuXHRcdGlmKGlfZW5kID49IG5sX2NvbnRlbnQpIHtcblx0XHRcdGlfZW5kID0gbmxfY29udGVudDtcblx0XHRcdHRoaXMuZW9mID0gdHJ1ZTtcblx0XHR9XG5cblx0XHR0aGlzLmJ1c3kgPSB0cnVlO1xuXHRcdHRoaXMuY2h1bmtzX2xvYWRlZCArPSAxO1xuXG5cdFx0bGV0IGRmYl9zbGljZSA9IGRmYl9jb250ZW50LnNsaWNlKGlfcmVhZCwgaV9lbmQpO1xuXHRcdHRoaXMucmVhZF9pbmRleCA9IGlfZW5kO1xuXG5cdFx0dGhpcy5maWxlX3JlYWRlci5yZWFkQXNBcnJheUJ1ZmZlcihkZmJfc2xpY2UpO1xuXHR9XG59XG5cblxubW9kdWxlLmV4cG9ydHMgPSBPYmplY3QuYXNzaWduKGZ1bmN0aW9uKHpfaW5wdXQ9bnVsbCkge1xuXHRpZih6X2lucHV0KSB7XG5cdFx0Ly8gbWFrZSByZWFkYWJsZSBzdHJlYW0gZnJvbSBvYmplY3QgdXJsJ3MgYmxvYlxuXHRcdGlmKCdzdHJpbmcnID09PSB0eXBlb2Ygel9pbnB1dCkge1xuXHRcdFx0cmV0dXJuIG5ldyByZWFkYWJsZV9zdHJlYW1fdmlhX29iamVjdF91cmwoel9pbnB1dCk7XG5cdFx0fVxuXHRcdC8vIG1ha2UgcmVhZGFibGUgc3RyZWFtIGF0b3AgcG9ydFxuXHRcdGVsc2UgaWYoel9pbnB1dCBpbnN0YW5jZW9mIE1lc3NhZ2VQb3J0KSB7XG5cdFx0XHRyZXR1cm4gbmV3IHJlYWRhYmxlX3N0cmVhbV92aWFfcG9ydCh6X2lucHV0KTtcblx0XHR9XG5cdFx0Ly8gdHJhbnNtaXQgYmxvYiBhY3Jvc3MgdGhyZWFkc1xuXHRcdGVsc2UgaWYoel9pbnB1dCBpbnN0YW5jZW9mIEJsb2IpIHtcblx0XHRcdC8vIGNyZWF0ZSBuZXcgdHJhbnNmZXIgc3RyZWFtXG5cdFx0XHRsZXQga19zdHJlYW0gPSBuZXcgdHJhbnNmZXJfc3RyZWFtKCk7XG5cblx0XHRcdC8vIGZlZWQgaXQgdGhpcyBibG9iIGFzIGlucHV0XG5cdFx0XHRrX3N0cmVhbS5ibG9iKHpfaW5wdXQpO1xuXG5cdFx0XHQvLyByZXR1cm4gc3RyZWFtXG5cdFx0XHRyZXR1cm4ga19zdHJlYW07XG5cdFx0fVxuXHR9XG5cdC8vIHRyYW5zZmVyIGEgc3RyZWFtXG5cdGVsc2Uge1xuXHRcdHJldHVybiBuZXcgdHJhbnNmZXJfc3RyZWFtKCk7XG5cdH1cbn0sIHtcblx0aGFuZGxlcjogY2xhc3MgaGFuZGxlciB7fSxcblxuXHRpc19zdHJlYW0oel9zdHJlYW0pIHtcblx0XHRyZXR1cm4gel9zdHJlYW0gaW5zdGFuY2VvZiB0cmFuc2Zlcl9zdHJlYW1cblx0XHRcdHx8IHpfc3RyZWFtIGluc3RhbmNlb2YgUmVhZGFibGVTdHJlYW1cblx0XHRcdHx8IHpfc3RyZWFtIGluc3RhbmNlb2YgV3JpdGFibGVTdHJlYW07XG5cdH0sXG5cblx0c2VyaWFsaXplKHpfc3RyZWFtKSB7XG5cdFx0Ly8gdHJhbnNmZXIgc3RyZWFtXG5cdFx0aWYoel9zdHJlYW0gaW5zdGFuY2VvZiB0cmFuc2Zlcl9zdHJlYW0pIHtcblx0XHRcdHJldHVybiBbe1xuXHRcdFx0XHR0eXBlOiAncmVhZGFibGVfc3RyZWFtJyxcblx0XHRcdFx0cG9ydDogel9zdHJlYW0ub3RoZXJfcG9ydCxcblx0XHRcdH0sIHpfc3RyZWFtLm90aGVyX3BvcnRdO1xuXHRcdH1cblx0XHQvLyByZWFkYWJsZSBzdHJlYW1cblx0XHRlbHNlIGlmKHpfc3RyZWFtIGluc3RhbmNlb2YgUmVhZGFibGVTdHJlYW0pIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcignbm90IHlldCBpbXBsZW1lbnRlZCcpO1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0dHlwZTogJ3JlYWRhYmxlX3N0cmVhbScsXG5cdFx0XHR9O1xuXHRcdH1cblx0XHQvLyB3cml0YWJsZSBzdHJlYW1cblx0XHRlbHNlIGlmKHpfc3RyZWFtIGluc3RhbmNlb2YgV3JpdGFibGVTdHJlYW0pIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcignbm90IHlldCBpbXBsZW1lbnRlZCcpO1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0dHlwZTogJ3dyaXRhYmxlX3N0cmVhbScsXG5cdFx0XHR9O1xuXHRcdH1cblx0XHQvLyBpbnZhbGlkIHR5cGVcblx0XHRlbHNlIHtcblx0XHRcdHRocm93IG5ldyBUeXBlRXJyb3IoJ2Nhbm5vdCBjcmVhdGUgdHJhbnNmZXIgc3RyZWFtIGZyb206ICcrel9zdHJlYW0pO1xuXHRcdH1cblx0fSxcbn0pO1xuIiwiXG5jb25zdCBzaGFyaW5nID0gcmVxdWlyZSgnLi9zaGFyaW5nLmpzJyk7XG5jb25zdCBUeXBlZEFycmF5ID0gT2JqZWN0LmdldFByb3RvdHlwZU9mKE9iamVjdC5nZXRQcm90b3R5cGVPZihuZXcgVWludDhBcnJheSgwKSkpLmNvbnN0cnVjdG9yO1xuXG5cblxuLyogZ2xvYmFscyBTaGFyZWRBcnJheUJ1ZmZlciAqL1xuXG5cbmlmKCd1bmRlZmluZWQnID09PSB0eXBlb2YgU2hhcmVkQXJyYXlCdWZmZXIpIHtcblx0Z2xvYmFsLlNoYXJlZEFycmF5QnVmZmVyID0gZnVuY3Rpb24oKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKCdTaGFyZWRBcnJheUJ1ZmZlciBpcyBub3Qgc3VwcG9ydGVkIGJ5IHRoaXMgYnJvd3Nlciwgb3IgaXQgaXMgY3VycmVudGx5IGRpc2FibGVkIGR1ZSB0byBTcGVjdHJlJyk7XG5cdH07XG59XG5cbmNsYXNzIEludDhBcnJheVMgZXh0ZW5kcyBJbnQ4QXJyYXkge1xuXHRjb25zdHJ1Y3Rvcih6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KSB7XG5cdFx0Ly8gdGhpc1xuXHRcdGxldCBoX3RoaXMgPSB7fTtcblxuXHRcdC8vIHNlbGZcblx0XHRsZXQgYXRfc2VsZjtcblxuXHRcdFxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQ4QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzApKTtcblxuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQ4QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzAuYnl0ZUxlbmd0aCkpO1xuXG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYoJ3VuZGVmaW5lZCcgPT09IHR5cGVvZiBubF9hcnJheSkge1xuXHRcdFx0XHRubF9hcnJheSA9IHpfYXJnXzAubGVuZ3RoIC0gbmJfb2Zmc2V0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhcnJheSBzaXplIGluIGJ5dGVzXG5cdFx0XHRsZXQgbmJfYXJyYXkgPSBubF9hcnJheTtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBJbnQ4QXJyYXkoZHNiLCAwLCBuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSBjb3B5IHNyY1xuXHRcdFx0bGV0IGF0X3NyYyA9IG5ldyBJbnQ4QXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBJbnQ4QXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oSW50OEFycmF5Uy5wcm90b3R5cGUsIHtcblx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdOiAxLFxufSk7XG5cdGNsYXNzIFVpbnQ4QXJyYXlTIGV4dGVuZHMgVWludDhBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cdFx0XG5cdFx0Ly8gbGVuZ3RoIGNvbnN0cnVjdG9yXG5cdFx0aWYoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQ4QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzApKTtcblxuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50OEFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcih6X2FyZ18wLmJ5dGVMZW5ndGgpKTtcblxuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmKCd1bmRlZmluZWQnID09PSB0eXBlb2YgbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXk7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IFVpbnQ4QXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBVaW50OEFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKFVpbnQ4QXJyYXlTLnByb3RvdHlwZSwge1xuXHRbc2hhcmluZy4kX1NIQVJFQUJMRV06IDEsXG59KTtcblx0Y2xhc3MgVWludDhDbGFtcGVkQXJyYXlTIGV4dGVuZHMgVWludDhDbGFtcGVkQXJyYXkge1xuXHRjb25zdHJ1Y3Rvcih6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KSB7XG5cdFx0Ly8gdGhpc1xuXHRcdGxldCBoX3RoaXMgPSB7fTtcblxuXHRcdC8vIHNlbGZcblx0XHRsZXQgYXRfc2VsZjtcblxuXHRcdFxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50OENsYW1wZWRBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoel9hcmdfMCkpO1xuXG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZih6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZihzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQ4Q2xhbXBlZEFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcih6X2FyZ18wLmJ5dGVMZW5ndGgpKTtcblxuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmKCd1bmRlZmluZWQnID09PSB0eXBlb2YgbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXk7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDhDbGFtcGVkQXJyYXkoZHNiLCAwLCBuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSBjb3B5IHNyY1xuXHRcdFx0bGV0IGF0X3NyYyA9IG5ldyBVaW50OENsYW1wZWRBcnJheSh6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KTtcblxuXHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdGF0X3NlbGYuc2V0KGF0X3NyYyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIHNlbGZcblx0XHRzdXBlcihhdF9zZWxmKTtcblxuXHRcdC8vIHNhdmUgZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCBoX3RoaXMpO1xuXHR9XG5cblx0YmFzZSguLi5hX2FyZ3MpIHtcblx0XHRyZXR1cm4gbmV3IFVpbnQ4Q2xhbXBlZEFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKFVpbnQ4Q2xhbXBlZEFycmF5Uy5wcm90b3R5cGUsIHtcblx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdOiAxLFxufSk7XG5cdGNsYXNzIEludDE2QXJyYXlTIGV4dGVuZHMgSW50MTZBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cdFx0XG5cdFx0Ly8gbGVuZ3RoIGNvbnN0cnVjdG9yXG5cdFx0aWYoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHRhdF9zZWxmID0gbmV3IEludDE2QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzAgPDwgMSkpO1xuXG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZih6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZihzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHRhdF9zZWxmID0gbmV3IEludDE2QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzAuYnl0ZUxlbmd0aCkpO1xuXG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYoJ3VuZGVmaW5lZCcgPT09IHR5cGVvZiBubF9hcnJheSkge1xuXHRcdFx0XHRubF9hcnJheSA9IHpfYXJnXzAubGVuZ3RoIC0gbmJfb2Zmc2V0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhcnJheSBzaXplIGluIGJ5dGVzXG5cdFx0XHRsZXQgbmJfYXJyYXkgPSBubF9hcnJheSA8PCAxO1xuXG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRsZXQgZHNiID0gbmV3IFNoYXJlZEFycmF5QnVmZmVyKG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIHR5cGVkIGFycmF5XG5cdFx0XHRhdF9zZWxmID0gbmV3IEludDE2QXJyYXkoZHNiLCAwLCBuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSBjb3B5IHNyY1xuXHRcdFx0bGV0IGF0X3NyYyA9IG5ldyBJbnQxNkFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgSW50MTZBcnJheSguLi5hX2FyZ3MpO1xuXHR9XG59XG5cbi8vIHN0YXRpYyBmaWVsZFxuT2JqZWN0LmFzc2lnbihJbnQxNkFycmF5Uy5wcm90b3R5cGUsIHtcblx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdOiAxLFxufSk7XG5cdGNsYXNzIFVpbnQxNkFycmF5UyBleHRlbmRzIFVpbnQxNkFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblx0XHRcblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZignbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDE2QXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzAgPDwgMSkpO1xuXG5cdFx0fVxuXHRcdC8vIHR5cGVkIGFycmF5IGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZih6X2FyZ18wIGluc3RhbmNlb2YgVHlwZWRBcnJheSkge1xuXHRcdFx0Ly8gdHJhbnNmZXJhYmxlIHR5cGVkIGFycmF5XG5cdFx0XHRpZihzaGFyaW5nKHpfYXJnXzApKSB7XG5cdFx0XHRcdGRlYnVnZ2VyO1xuXHRcdFx0fVxuXHRcdFx0Ly8gYmFzaWMgdHlwZWQgYXJyYXlcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQxNkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcih6X2FyZ18wLmJ5dGVMZW5ndGgpKTtcblxuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmKCd1bmRlZmluZWQnID09PSB0eXBlb2YgbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXkgPDwgMTtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50MTZBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IFVpbnQxNkFycmF5KHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpO1xuXG5cdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0YXRfc2VsZi5zZXQoYXRfc3JjKTtcblx0XHR9XG5cblx0XHQvLyBjcmVhdGUgc2VsZlxuXHRcdHN1cGVyKGF0X3NlbGYpO1xuXG5cdFx0Ly8gc2F2ZSBmaWVsZHNcblx0XHRPYmplY3QuYXNzaWduKHRoaXMsIGhfdGhpcyk7XG5cdH1cblxuXHRiYXNlKC4uLmFfYXJncykge1xuXHRcdHJldHVybiBuZXcgVWludDE2QXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oVWludDE2QXJyYXlTLnByb3RvdHlwZSwge1xuXHRbc2hhcmluZy4kX1NIQVJFQUJMRV06IDEsXG59KTtcblx0Y2xhc3MgSW50MzJBcnJheVMgZXh0ZW5kcyBJbnQzMkFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblx0XHRcblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZignbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdGF0X3NlbGYgPSBuZXcgSW50MzJBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoel9hcmdfMCA8PCAyKSk7XG5cblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgSW50MzJBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoel9hcmdfMC5ieXRlTGVuZ3RoKSk7XG5cblxuXHRcdFx0XHQvLyBjb3B5IGRhdGEgb3ZlclxuXHRcdFx0XHRhdF9zZWxmLnNldCh6X2FyZ18wKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gYXJyYXkgYnVmZmVyIGNvbnN0cnVjdG9yXG5cdFx0ZWxzZSBpZih6X2FyZ18wIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHtcblx0XHRcdC8vIGZvcmNlIG9mZnNldFxuXHRcdFx0bmJfb2Zmc2V0ID0gbmJfb2Zmc2V0IHx8IDA7XG5cblx0XHRcdC8vIG5vIGxlbmd0aDsgZGVkdWNlIGl0IGZyb20gb2Zmc2V0XG5cdFx0XHRpZigndW5kZWZpbmVkJyA9PT0gdHlwZW9mIG5sX2FycmF5KSB7XG5cdFx0XHRcdG5sX2FycmF5ID0gel9hcmdfMC5sZW5ndGggLSBuYl9vZmZzZXQ7XG5cdFx0XHR9XG5cblx0XHRcdC8vIGFycmF5IHNpemUgaW4gYnl0ZXNcblx0XHRcdGxldCBuYl9hcnJheSA9IG5sX2FycmF5IDw8IDI7XG5cblx0XHRcdC8vIGNyZWF0ZSBzaGFyZWQgbWVtb3J5IHNlZ21lbnRcblx0XHRcdGxldCBkc2IgPSBuZXcgU2hhcmVkQXJyYXlCdWZmZXIobmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgdHlwZWQgYXJyYXlcblx0XHRcdGF0X3NlbGYgPSBuZXcgSW50MzJBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IEludDMyQXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBJbnQzMkFycmF5KC4uLmFfYXJncyk7XG5cdH1cbn1cblxuLy8gc3RhdGljIGZpZWxkXG5PYmplY3QuYXNzaWduKEludDMyQXJyYXlTLnByb3RvdHlwZSwge1xuXHRbc2hhcmluZy4kX1NIQVJFQUJMRV06IDEsXG59KTtcblx0Y2xhc3MgVWludDMyQXJyYXlTIGV4dGVuZHMgVWludDMyQXJyYXkge1xuXHRjb25zdHJ1Y3Rvcih6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KSB7XG5cdFx0Ly8gdGhpc1xuXHRcdGxldCBoX3RoaXMgPSB7fTtcblxuXHRcdC8vIHNlbGZcblx0XHRsZXQgYXRfc2VsZjtcblxuXHRcdFxuXHRcdC8vIGxlbmd0aCBjb25zdHJ1Y3RvclxuXHRcdGlmKCdudW1iZXInID09PSB0eXBlb2Ygel9hcmdfMCkge1xuXHRcdFx0YXRfc2VsZiA9IG5ldyBVaW50MzJBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoel9hcmdfMCA8PCAyKSk7XG5cblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgVWludDMyQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzAuYnl0ZUxlbmd0aCkpO1xuXG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYoJ3VuZGVmaW5lZCcgPT09IHR5cGVvZiBubF9hcnJheSkge1xuXHRcdFx0XHRubF9hcnJheSA9IHpfYXJnXzAubGVuZ3RoIC0gbmJfb2Zmc2V0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhcnJheSBzaXplIGluIGJ5dGVzXG5cdFx0XHRsZXQgbmJfYXJyYXkgPSBubF9hcnJheSA8PCAyO1xuXG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRsZXQgZHNiID0gbmV3IFNoYXJlZEFycmF5QnVmZmVyKG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIHR5cGVkIGFycmF5XG5cdFx0XHRhdF9zZWxmID0gbmV3IFVpbnQzMkFycmF5KGRzYiwgMCwgbmJfYXJyYXkpO1xuXG5cdFx0XHQvLyBjcmVhdGUgY29weSBzcmNcblx0XHRcdGxldCBhdF9zcmMgPSBuZXcgVWludDMyQXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBVaW50MzJBcnJheSguLi5hX2FyZ3MpO1xuXHR9XG59XG5cbi8vIHN0YXRpYyBmaWVsZFxuT2JqZWN0LmFzc2lnbihVaW50MzJBcnJheVMucHJvdG90eXBlLCB7XG5cdFtzaGFyaW5nLiRfU0hBUkVBQkxFXTogMSxcbn0pO1xuXHRjbGFzcyBGbG9hdDMyQXJyYXlTIGV4dGVuZHMgRmxvYXQzMkFycmF5IHtcblx0Y29uc3RydWN0b3Ioel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSkge1xuXHRcdC8vIHRoaXNcblx0XHRsZXQgaF90aGlzID0ge307XG5cblx0XHQvLyBzZWxmXG5cdFx0bGV0IGF0X3NlbGY7XG5cblx0XHRcblx0XHQvLyBsZW5ndGggY29uc3RydWN0b3Jcblx0XHRpZignbnVtYmVyJyA9PT0gdHlwZW9mIHpfYXJnXzApIHtcblx0XHRcdGF0X3NlbGYgPSBuZXcgRmxvYXQzMkFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcih6X2FyZ18wIDw8IDIpKTtcblxuXHRcdH1cblx0XHQvLyB0eXBlZCBhcnJheSBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIFR5cGVkQXJyYXkpIHtcblx0XHRcdC8vIHRyYW5zZmVyYWJsZSB0eXBlZCBhcnJheVxuXHRcdFx0aWYoc2hhcmluZyh6X2FyZ18wKSkge1xuXHRcdFx0XHRkZWJ1Z2dlcjtcblx0XHRcdH1cblx0XHRcdC8vIGJhc2ljIHR5cGVkIGFycmF5XG5cdFx0XHRlbHNlIHtcblx0XHRcdFx0YXRfc2VsZiA9IG5ldyBGbG9hdDMyQXJyYXkobmV3IFNoYXJlZEFycmF5QnVmZmVyKHpfYXJnXzAuYnl0ZUxlbmd0aCkpO1xuXG5cblx0XHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdFx0YXRfc2VsZi5zZXQoel9hcmdfMCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdC8vIGFycmF5IGJ1ZmZlciBjb25zdHJ1Y3RvclxuXHRcdGVsc2UgaWYoel9hcmdfMCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG5cdFx0XHQvLyBmb3JjZSBvZmZzZXRcblx0XHRcdG5iX29mZnNldCA9IG5iX29mZnNldCB8fCAwO1xuXG5cdFx0XHQvLyBubyBsZW5ndGg7IGRlZHVjZSBpdCBmcm9tIG9mZnNldFxuXHRcdFx0aWYoJ3VuZGVmaW5lZCcgPT09IHR5cGVvZiBubF9hcnJheSkge1xuXHRcdFx0XHRubF9hcnJheSA9IHpfYXJnXzAubGVuZ3RoIC0gbmJfb2Zmc2V0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBhcnJheSBzaXplIGluIGJ5dGVzXG5cdFx0XHRsZXQgbmJfYXJyYXkgPSBubF9hcnJheSA8PCAyO1xuXG5cdFx0XHQvLyBjcmVhdGUgc2hhcmVkIG1lbW9yeSBzZWdtZW50XG5cdFx0XHRsZXQgZHNiID0gbmV3IFNoYXJlZEFycmF5QnVmZmVyKG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIHR5cGVkIGFycmF5XG5cdFx0XHRhdF9zZWxmID0gbmV3IEZsb2F0MzJBcnJheShkc2IsIDAsIG5iX2FycmF5KTtcblxuXHRcdFx0Ly8gY3JlYXRlIGNvcHkgc3JjXG5cdFx0XHRsZXQgYXRfc3JjID0gbmV3IEZsb2F0MzJBcnJheSh6X2FyZ18wLCBuYl9vZmZzZXQsIG5sX2FycmF5KTtcblxuXHRcdFx0Ly8gY29weSBkYXRhIG92ZXJcblx0XHRcdGF0X3NlbGYuc2V0KGF0X3NyYyk7XG5cdFx0fVxuXG5cdFx0Ly8gY3JlYXRlIHNlbGZcblx0XHRzdXBlcihhdF9zZWxmKTtcblxuXHRcdC8vIHNhdmUgZmllbGRzXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCBoX3RoaXMpO1xuXHR9XG5cblx0YmFzZSguLi5hX2FyZ3MpIHtcblx0XHRyZXR1cm4gbmV3IEZsb2F0MzJBcnJheSguLi5hX2FyZ3MpO1xuXHR9XG59XG5cbi8vIHN0YXRpYyBmaWVsZFxuT2JqZWN0LmFzc2lnbihGbG9hdDMyQXJyYXlTLnByb3RvdHlwZSwge1xuXHRbc2hhcmluZy4kX1NIQVJFQUJMRV06IDEsXG59KTtcblx0Y2xhc3MgRmxvYXQ2NEFycmF5UyBleHRlbmRzIEZsb2F0NjRBcnJheSB7XG5cdGNvbnN0cnVjdG9yKHpfYXJnXzAsIG5iX29mZnNldCwgbmxfYXJyYXkpIHtcblx0XHQvLyB0aGlzXG5cdFx0bGV0IGhfdGhpcyA9IHt9O1xuXG5cdFx0Ly8gc2VsZlxuXHRcdGxldCBhdF9zZWxmO1xuXG5cdFx0XG5cdFx0Ly8gbGVuZ3RoIGNvbnN0cnVjdG9yXG5cdFx0aWYoJ251bWJlcicgPT09IHR5cGVvZiB6X2FyZ18wKSB7XG5cdFx0XHRhdF9zZWxmID0gbmV3IEZsb2F0NjRBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoel9hcmdfMCA8PCA0KSk7XG5cblx0XHR9XG5cdFx0Ly8gdHlwZWQgYXJyYXkgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG5cdFx0XHQvLyB0cmFuc2ZlcmFibGUgdHlwZWQgYXJyYXlcblx0XHRcdGlmKHNoYXJpbmcoel9hcmdfMCkpIHtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cdFx0XHQvLyBiYXNpYyB0eXBlZCBhcnJheVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdGF0X3NlbGYgPSBuZXcgRmxvYXQ2NEFycmF5KG5ldyBTaGFyZWRBcnJheUJ1ZmZlcih6X2FyZ18wLmJ5dGVMZW5ndGgpKTtcblxuXG5cdFx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRcdGF0X3NlbGYuc2V0KHpfYXJnXzApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBhcnJheSBidWZmZXIgY29uc3RydWN0b3Jcblx0XHRlbHNlIGlmKHpfYXJnXzAgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuXHRcdFx0Ly8gZm9yY2Ugb2Zmc2V0XG5cdFx0XHRuYl9vZmZzZXQgPSBuYl9vZmZzZXQgfHwgMDtcblxuXHRcdFx0Ly8gbm8gbGVuZ3RoOyBkZWR1Y2UgaXQgZnJvbSBvZmZzZXRcblx0XHRcdGlmKCd1bmRlZmluZWQnID09PSB0eXBlb2YgbmxfYXJyYXkpIHtcblx0XHRcdFx0bmxfYXJyYXkgPSB6X2FyZ18wLmxlbmd0aCAtIG5iX29mZnNldDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gYXJyYXkgc2l6ZSBpbiBieXRlc1xuXHRcdFx0bGV0IG5iX2FycmF5ID0gbmxfYXJyYXkgPDwgNDtcblxuXHRcdFx0Ly8gY3JlYXRlIHNoYXJlZCBtZW1vcnkgc2VnbWVudFxuXHRcdFx0bGV0IGRzYiA9IG5ldyBTaGFyZWRBcnJheUJ1ZmZlcihuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSB0eXBlZCBhcnJheVxuXHRcdFx0YXRfc2VsZiA9IG5ldyBGbG9hdDY0QXJyYXkoZHNiLCAwLCBuYl9hcnJheSk7XG5cblx0XHRcdC8vIGNyZWF0ZSBjb3B5IHNyY1xuXHRcdFx0bGV0IGF0X3NyYyA9IG5ldyBGbG9hdDY0QXJyYXkoel9hcmdfMCwgbmJfb2Zmc2V0LCBubF9hcnJheSk7XG5cblx0XHRcdC8vIGNvcHkgZGF0YSBvdmVyXG5cdFx0XHRhdF9zZWxmLnNldChhdF9zcmMpO1xuXHRcdH1cblxuXHRcdC8vIGNyZWF0ZSBzZWxmXG5cdFx0c3VwZXIoYXRfc2VsZik7XG5cblx0XHQvLyBzYXZlIGZpZWxkc1xuXHRcdE9iamVjdC5hc3NpZ24odGhpcywgaF90aGlzKTtcblx0fVxuXG5cdGJhc2UoLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIG5ldyBGbG9hdDY0QXJyYXkoLi4uYV9hcmdzKTtcblx0fVxufVxuXG4vLyBzdGF0aWMgZmllbGRcbk9iamVjdC5hc3NpZ24oRmxvYXQ2NEFycmF5Uy5wcm90b3R5cGUsIHtcblx0W3NoYXJpbmcuJF9TSEFSRUFCTEVdOiAxLFxufSk7XG5cblxuLy8gZ2xvYmFsc1xubW9kdWxlLmV4cG9ydHMgPSB7XG5cdGV4cG9ydHM6IHtcblx0XHRBcnJheUJ1ZmZlclM6IFNoYXJlZEFycmF5QnVmZmVyLFxuXHRcdEFycmF5QnVmZmVyVDogQXJyYXlCdWZmZXIsXG5cdFx0SW50OEFycmF5UzogSW50OEFycmF5UywgSW50OEFycmF5VDogSW50OEFycmF5LCBVaW50OEFycmF5UzogVWludDhBcnJheVMsIFVpbnQ4QXJyYXlUOiBVaW50OEFycmF5LCBVaW50OENsYW1wZWRBcnJheVM6IFVpbnQ4Q2xhbXBlZEFycmF5UywgVWludDhDbGFtcGVkQXJyYXlUOiBVaW50OENsYW1wZWRBcnJheSwgSW50MTZBcnJheVM6IEludDE2QXJyYXlTLCBJbnQxNkFycmF5VDogSW50MTZBcnJheSwgVWludDE2QXJyYXlTOiBVaW50MTZBcnJheVMsIFVpbnQxNkFycmF5VDogVWludDE2QXJyYXksIEludDMyQXJyYXlTOiBJbnQzMkFycmF5UywgSW50MzJBcnJheVQ6IEludDMyQXJyYXksIFVpbnQzMkFycmF5UzogVWludDMyQXJyYXlTLCBVaW50MzJBcnJheVQ6IFVpbnQzMkFycmF5LCBGbG9hdDMyQXJyYXlTOiBGbG9hdDMyQXJyYXlTLCBGbG9hdDMyQXJyYXlUOiBGbG9hdDMyQXJyYXksIEZsb2F0NjRBcnJheVM6IEZsb2F0NjRBcnJheVMsIEZsb2F0NjRBcnJheVQ6IEZsb2F0NjRBcnJheSxcblx0fSxcbn07XG4iLCJjb25zdCBldmVudHMgPSByZXF1aXJlKCcuL2V2ZW50cy5qcycpO1xuY29uc3Qgc2hhcmluZyA9IHJlcXVpcmUoJy4vc2hhcmluZy5qcycpO1xuXG5jbGFzcyB3b3JrZXIgZXh0ZW5kcyBXb3JrZXIge1xuXG5cdHBvc3RQb3J0KGRfcG9ydCwgaF9tc2csIGFfdHJhbnNmZXJfcGF0aHM9W10pIHtcblx0XHQvLyBhcHBlbmQgcG9ydCB0byB0cmFuc2ZlciBwYXRoc1xuXHRcdGFfdHJhbnNmZXJfcGF0aHMucHVzaChbJ3BvcnQnXSk7XG5cblx0XHQvLyBzZW5kXG5cdFx0dGhpcy5wb3N0TWVzc2FnZShPYmplY3QuYXNzaWduKHtcblx0XHRcdHBvcnQ6IGRfcG9ydCxcblx0XHR9LCBoX21zZyksIGFfdHJhbnNmZXJfcGF0aHMpO1xuXHR9XG5cblx0cG9zdE1lc3NhZ2UoaF9tc2csIGFfdHJhbnNmZXJfcGF0aHMpIHtcblx0XHRsZXQgYV90cmFuc2ZlcnMgPSBbXTtcblx0XHRmb3IobGV0IGFfcGF0aCBvZiBhX3RyYW5zZmVyX3BhdGhzKSB7XG5cdFx0XHRsZXQgel9oZWFkID0gaF9tc2c7XG5cdFx0XHRsZXQgbmxfcGF0aCA9IGFfcGF0aC5sZW5ndGg7XG5cdFx0XHRmb3IobGV0IGlfc3RlcD0wOyBpX3N0ZXA8bmxfcGF0aC0xOyBpX3N0ZXArKykge1xuXHRcdFx0XHR6X2hlYWQgPSB6X2hlYWRbYV9wYXRoW2lfc3RlcF1dO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBmaW5hbCBzdGVwXG5cdFx0XHRsZXQgc19rZXkgPSBhX3BhdGhbbmxfcGF0aC0xXTtcblxuXHRcdFx0Ly8gZXh0cmFjdCB0cmFuc2ZlciBpdGVtKHMpXG5cdFx0XHRsZXQgW2hfc2VyaWFsaXphdGlvbiwgYV90cmFuc2Zlcl9pdGVtc10gPSBzaGFyaW5nLmV4dHJhY3Qoel9oZWFkW3Nfa2V5XSk7XG5cblx0XHRcdC8vIGFkZCB0cmFuc2ZlciBpdGVtc1xuXHRcdFx0YV90cmFuc2ZlcnMucHVzaCguLi5hX3RyYW5zZmVyX2l0ZW1zKTtcblxuXHRcdFx0Ly8gcmVwbGFjZSBvYmplY3Rcblx0XHRcdHpfaGVhZFtzX2tleV0gPSBoX3NlcmlhbGl6YXRpb247XG5cdFx0fVxuXG5cdFx0dHJ5IHtcblx0XHRcdHN1cGVyLnBvc3RNZXNzYWdlKGhfbXNnLCBhX3RyYW5zZmVycyk7XG5cdFx0fVxuXHRcdGNhdGNoKGVfcG9zdCkge1xuXHRcdFx0Ly8gZGF0YSBjbG9uZSBlcnJvclxuXHRcdFx0aWYoJ0RhdGFDbG9uZUVycm9yJyA9PT0gZV9wb3N0Lm5hbWUpIHtcblx0XHRcdFx0Y29uc29sZS53YXJuKCdEaWQgeW91IGZvcmdldCB0byBkZWNsYXJlIGFuIG9iamVjdCB0aGF0IG5lZWRzIHRvIGJlIHRyYW5zZmVycmVkPyBNYWtlIHN1cmUgeW91IGtub3cgd2hlbiB0byB1c2Ugd29ya2VyLm1hbmlmZXN0KCknKTtcblx0XHRcdFx0ZGVidWdnZXI7XG5cdFx0XHR9XG5cblx0XHRcdHRocm93IGVfcG9zdDtcblx0XHR9XG5cdH1cbn1cblxuZXZlbnRzKHdvcmtlci5wcm90b3R5cGUpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHdvcmtlcjtcbiIsIi8qIEBmbG93ICovXG5jb25zdCBwYXRoID0gcmVxdWlyZSgncGF0aCcpO1xuXG5jb25zdCBjb2xvcnMgPSByZXF1aXJlKCdjb2xvcnMnKTtcbmNvbG9ycy5lbmFibGVkID0gdHJ1ZTtcblxuLy8gbG9jYWwgY2xhc3NlcyAvIGdsb2JhbHNcbmNvbnN0IHtcblx0S19TRUxGLFxuXHREQ19XT1JLRVIsXG5cdERDX0NIQU5ORUwsXG5cdEhfVFlQRURfQVJSQVlTLFxuXHRCX0JST1dTRVIsXG5cdEJfQlJPV1NFUklGWSxcblx0SFBfV09SS0VSX05PVElGSUNBVElPTixcblx0c3RyZWFtLFxuXHR3ZWJ3b3JrZXJpZnksXG59ID0gcmVxdWlyZSgnLi9hbGwvbG9jYWxzLmpzJyk7XG5cbmNvbnN0IGRlZGljYXRlZCA9IHJlcXVpcmUoJy4vYWxsL2RlZGljYXRlZC5qcycpO1xuY29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKCcuL2FsbC9tYW5pZmVzdC5qcycpO1xuY29uc3QgcmVzdWx0ID0gcmVxdWlyZSgnLi9hbGwvcmVzdWx0LmpzJyk7XG5cbi8vIFdvcmtlciBpcyBzdXBwb3J0ZWRcbmNvbnN0IEJfV09SS0VSX1NVUFBPUlRFRCA9ICgndW5kZWZpbmVkJyAhPT0gdHlwZW9mIERDX1dPUktFUik7XG5cbi8vIGNvbnRleHQgYml0bWFza3NcbmNvbnN0IFhNX0NPTlRFWFRfUFJPQ0VTU19QQVJFTlQgPSAxIDw8IDA7XG5jb25zdCBYTV9DT05URVhUX1BST0NFU1NfQ0hJTEQgPSAxIDw8IDE7XG5jb25zdCBYTV9DT05URVhUX1dJTkRPVyA9IDEgPDwgMjtcbmNvbnN0IFhNX0NPTlRFWFRfV09SS0VSX0RFRElDQVRFRCA9IDEgPDwgMztcbmNvbnN0IFhNX0NPTlRFWFRfV09SS0VSX1NFUlZJQ0UgPSAxIDw8IDQ7XG5jb25zdCBYTV9DT05URVhUX1dPUktFUl9TSEFSRUQgPSAxIDw8IDU7XG5cbmNvbnN0IFhNX0NPTlRFWFRfV09SS0VSID0gWE1fQ09OVEVYVF9XT1JLRVJfREVESUNBVEVEIHwgWE1fQ09OVEVYVF9XT1JLRVJfU0VSVklDRSB8IFhNX0NPTlRFWFRfV09SS0VSX1NIQVJFRDtcblxuLy8gc2V0IHRoZSBjdXJyZW50IGNvbnRleHRcbmNvbnN0IFhfQ09OVEVYVF9UWVBFID0gIUJfQlJPV1NFUlxuXHQ/IChwcm9jZXNzLmVudi5XT1JLRVJfREVQVEg/IFhNX0NPTlRFWFRfUFJPQ0VTU19DSElMRDogWE1fQ09OVEVYVF9QUk9DRVNTX1BBUkVOVClcblx0OiAoJ3VuZGVmaW5lZCcgIT09IHR5cGVvZiBkb2N1bWVudFxuXHRcdD8gWE1fQ09OVEVYVF9XSU5ET1dcblx0XHQ6ICgnRGVkaWNhdGVkV29ya2VyR2xvYmFsU2NvcGUnIGluIHNlbGZcblx0XHRcdD8gWE1fQ09OVEVYVF9XT1JLRVJfREVESUNBVEVEXG5cdFx0XHQ6ICgnU2hhcmVkV29ya2VyR2xvYmFsU2NvcGUnIGluIHNlbGZcblx0XHRcdFx0PyBYTV9DT05URVhUX1dPUktFUl9TSEFSRURcblx0XHRcdFx0OiAoJ1NlcnZpY2VXb3JrZXJHbG9iYWxTY29wZScgaW4gc2VsZlxuXHRcdFx0XHRcdD8gWE1fQ09OVEVYVF9XT1JLRVJfU0VSVklDRVxuXHRcdFx0XHRcdDogMCkpKSk7XG5cbi8vIHVucmVjb2duaXplZCBjb250ZXh0XG5pZighWF9DT05URVhUX1RZUEUpIHtcblx0dGhyb3cgbmV3IEVycm9yKCdmYWlsZWQgdG8gZGV0ZXJtaW5lIHdoYXQgaXMgdGhlIGN1cnJlbnQgZW52aXJvbm1lbnQvY29udGV4dCcpO1xufVxuXG4vLyBzcGF3bnMgYSBXb3JrZXJcbmxldCBzcGF3bl93b3JrZXIgPSBCX1dPUktFUl9TVVBQT1JURURcblx0PyAoIUJfQlJPV1NFUklGWVxuXHRcdD8gKHBfc291cmNlLCBoX29wdGlvbnMpID0+IG5ldyBEQ19XT1JLRVIocF9zb3VyY2UsIGhfb3B0aW9ucylcblx0XHQ6IChwX3NvdXJjZSwgaF9vcHRpb25zKSA9PiB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBGYXRhbCBlcnJvcjogc2luY2UgeW91IGFyZSB1c2luZyBicm93c2VyaWZ5LCB5b3UgbmVlZCB0byBpbmNsdWRlIGV4cGxpY2l0ICdyZXF1aXJlKCknIHN0YXRlbWVudHMgZm9yIGFueSBzY3JpcHRzIHlvdSBpbnRlbmQgdG8gc3Bhd24gYXMgd29ya2VycyBmcm9tIHRoaXMgdGhyZWFkYCk7XG5cdFx0XHRjb25zb2xlLndhcm4oYHRyeSB1c2luZyB0aGUgZm9sbG93aW5nIGluc3RlYWQ6XFxuXFxuY29uc3Qgd29ya2VyID0gcmVxdWlyZSgnd29ya2VyJykuc2NvcGlmeShyZXF1aXJlLCAoKSA9PiB7XFxuYFxuXHRcdFx0XHQrYFxcdHJlcXVpcmUoJyR7cF9zb3VyY2V9Jyk7XFxuXFx0Ly8gLi4uIGFuZCBhbnkgb3RoZXIgc2NyaXB0cyB5b3Ugd2lsbCBzcGF3biBmcm9tIHRoaXMgdGhyZWFkXFxuYFxuXHRcdFx0XHQrYH0sICd1bmRlZmluZWQnICE9PSB0eXBlb2YgYXJndW1lbnRzICYmIGFyZ3VtZW50cyk7YCk7XG5cblx0XHRcdHRocm93IG5ldyBFcnJvcihgQ2Fubm90IHNwYXduIHdvcmtlciAnJHtwX3NvdXJjZX0nYCk7XG5cdFx0fSlcblx0OiAocF9zb3VyY2UsIGhfb3B0aW9ucykgPT4ge1xuXHRcdC8vIHdlJ3JlIGluc2lkZSBhIHdvcmtlclxuXHRcdGlmKFhfQ09OVEVYVF9UWVBFICYgWE1fQ09OVEVYVF9XT1JLRVIpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoYEZhdGFsIGVycm9yOiBicm93c2VyIGRvZXMgbm90IHN1cHBvcnQgc3Vid29ya2VyczsgZmFpbGVkIHRvIHNwYXduICcke3Bfc291cmNlfSdcXG5gXG5cdFx0XHRcdCsnRm9ydHVuYXRlbHkgd29ya2VyLmpzIGhhcyBhIHNvbHV0aW9uICA7KScpO1xuXHRcdFx0Y29uc29sZS53YXJuKGB0cnkgdXNpbmcgdGhlIGZvbGxvd2luZyBpbiB5b3VyIHdvcmtlciBzY3JpcHQgdG8gc3VwcG9ydCBzdWJ3b3JrZXJzOlxcblxcbmBcblx0XHRcdFx0K2Bjb25zdCB3b3JrZXIgPSByZXF1aXJlKCd3b3JrZXInKS5zY29waWZ5KHJlcXVpcmUsICgpID0+IHtcXG5gXG5cdFx0XHRcdCtgXFx0cmVxdWlyZSgnJHtwX3NvdXJjZX0nKTtcXG5gXG5cdFx0XHRcdCtgXFx0Ly8gLi4uIGFuZCBhbnkgb3RoZXIgc2NyaXB0cyB5b3Ugd2lsbCBzcGF3biBmcm9tIHRoaXMgdGhyZWFkXFxuYFxuXHRcdFx0XHQrYH0sICd1bmRlZmluZWQnICE9PSB0eXBlb2YgYXJndW1lbnRzICYmIGFyZ3VtZW50cyk7YCk7XG5cdFx0fVxuXG5cdFx0dGhyb3cgbmV3IEVycm9yKGBDYW5ub3Qgc3Bhd24gd29ya2VyICR7cF9zb3VyY2V9OyAnV29ya2VyJyBpcyB1bmRlZmluZWRgKTtcblx0fTtcblxuXG5sZXQgaV9ndWlkID0gMDtcblxuY2xhc3Mgd29ya2VyIGV4dGVuZHMgc3RyZWFtLmhhbmRsZXIge1xuXHRzdGF0aWMgZnJvbV9zb3VyY2UocF9zb3VyY2UsIGhfb3B0aW9ucz17fSkge1xuXHRcdHJldHVybiBuZXcgd29ya2VyKHtcblx0XHRcdHNvdXJjZTogcF9zb3VyY2UsXG5cdFx0XHRvcHRpb25zOiBoX29wdGlvbnMsXG5cdFx0fSk7XG5cdH1cblxuXHRjb25zdHJ1Y3RvcihoX2NvbmZpZykge1xuXHRcdHN1cGVyKCk7XG5cblx0XHRsZXQge1xuXHRcdFx0c291cmNlOiBwX3NvdXJjZSxcblx0XHRcdGlkOiBpX2lkPS0xLFxuXHRcdFx0bWFzdGVyOiBrX21hc3Rlcj1udWxsLFxuXHRcdFx0b3B0aW9uczogaF9vcHRpb25zPXt9LFxuXHRcdH0gPSBoX2NvbmZpZztcblxuXHRcdC8vIHJlc29sdmUgc291cmNlIHJlbGF0aXZlIHRvIG1hc3RlclxuXHRcdGxldCBwYV9zb3VyY2UgPSBCX0JST1dTRVJcblx0XHRcdD8gcF9zb3VyY2Vcblx0XHRcdDogcGF0aC5yZXNvbHZlKHBhdGguZGlybmFtZShtb2R1bGUucGFyZW50LmZpbGVuYW1lKSwgcF9zb3VyY2UpO1xuXG5cdFx0Ly8gbWFrZSB3b3JrZXJcblx0XHRsZXQgZF93b3JrZXI7XG5cdFx0dHJ5IHtcblx0XHRcdGRfd29ya2VyID0gc3Bhd25fd29ya2VyKHBhX3NvdXJjZSwgaF9vcHRpb25zKTtcblx0XHR9XG5cdFx0Y2F0Y2goZV9zcGF3bikge1xuXHRcdFx0bGV0IGVfbXNnID0gbmV3IEVycm9yKCdBbiB1bmNhdWdodCBlcnJvciB3YXMgdGhyb3duIGJ5IHRoZSB3b3JrZXIsIHBvc3NpYmx5IGR1ZSB0byBhIGJ1ZyBpbiB0aGUgd29ya2VyLmpzIGxpYnJhcnkuIFRoYXQgZXJyb3Igd2FzOlxcbicrZV9zcGF3bi5zdGFjay5zcGxpdCgnXFxuJylbMF0pO1xuXHRcdFx0ZV9tc2cuc3RhY2sgPSBlX3NwYXduLnN0YWNrO1xuXHRcdFx0dGhyb3cgZV9tc2c7XG5cdFx0fVxuXG5cdFx0ZF93b3JrZXIub24oe1xuXHRcdFx0ZXJyb3I6IChlX3dvcmtlcikgPT4ge1xuXHRcdFx0XHRpZihlX3dvcmtlciBpbnN0YW5jZW9mIEVycm9yRXZlbnQpIHtcblx0XHRcdFx0XHRpZignbGluZW5vJyBpbiBlX3dvcmtlciAmJiAnc291cmNlJyBpbiBkX3dvcmtlcikge1xuXHRcdFx0XHRcdFx0bGV0IGFfbGluZXMgPSBkX3dvcmtlci5zb3VyY2Uuc3BsaXQoJ1xcbicpO1xuXHRcdFx0XHRcdFx0bGV0IGlfbGluZV9lcnIgPSBlX3dvcmtlci5saW5lbm87XG5cdFx0XHRcdFx0XHRsZXQgYV9kZWJ1ZyA9IGFfbGluZXMuc2xpY2UoTWF0aC5tYXgoMCwgaV9saW5lX2Vyci0yKSwgTWF0aC5taW4oYV9saW5lcy5sZW5ndGgtMSwgaV9saW5lX2VycisyKSlcblx0XHRcdFx0XHRcdFx0Lm1hcCgoc19saW5lLCBpX2xpbmUpID0+ICgxID09PSBpX2xpbmU/ICcqJzogJyAnKSsoKGlfbGluZV9lcnIraV9saW5lLTEpKycnKS5wYWRTdGFydCg1KSsnOiAnK3NfbGluZSk7XG5cblx0XHRcdFx0XHRcdC8vIHJlY3JlYXRlIGVycm9yIG1lc3NhZ2Vcblx0XHRcdFx0XHRcdGVfd29ya2VyID0gbmV3IEVycm9yKGVfd29ya2VyLm1lc3NhZ2UrYEVycm9yIHRocm93biBpbiB3b3JrZXI6XFxuJHthX2RlYnVnLmpvaW4oJ1xcbicpfWApO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGlmKHRoaXMudGFza19lcnJvcikge1xuXHRcdFx0XHRcdFx0dGhpcy50YXNrX2Vycm9yKGVfd29ya2VyKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0ZWxzZSB7XG5cdFx0XHRcdFx0XHR0aHJvdyBlX3dvcmtlcjtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdFx0ZWxzZSBpZih0aGlzLnRhc2tfZXJyb3IpIHtcblx0XHRcdFx0XHR0aGlzLnRhc2tfZXJyb3IoZV93b3JrZXIpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgYW4gZXJyb3Igb2NjdXJlZCBvbiB3b3JrZXIuLi4gYnV0IHRoZSAnZXJyb3InIGV2ZW50IGNhbGxiYWNrIGRpZCBub3QgcmVjZWl2ZSBhbiBFcnJvckV2ZW50IG9iamVjdCEgdHJ5IGluc3BlY3RpbmcgY29uc29sZWApO1xuXHRcdFx0XHR9XG5cdFx0XHR9LFxuXG5cdFx0XHQvLyB3aGVuIHRoZXJlIGlzIGFuIGVycm9yIGNyZWF0aW5nL2NvbW11bmljYXRpbmcgd2l0aCB3b3JrZXJcblx0XHRcdG1lc3NhZ2VlcnJvcjogKGVfYWN0aW9uKSA9PiB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihlX2FjdGlvbik7XG5cdFx0XHR9LFxuXG5cdFx0XHQvLyB3aGVuIGEgd29ya2VyIHJlc3BvbmRzXG5cdFx0XHRtZXNzYWdlOiAoZF9tc2cpID0+IHtcblx0XHRcdFx0bGV0IGhfbXNnID0gZF9tc2cuZGF0YTtcblxuXHRcdFx0XHQvLyBoYW5kbGUgbWVzc2FnZVxuXHRcdFx0XHRsZXQgc19oYW5kbGUgPSAnaGFuZGxlXycraF9tc2cudHlwZTtcblx0XHRcdFx0aWYoc19oYW5kbGUgaW4gdGhpcykge1xuXHRcdFx0XHRcdHRoaXNbc19oYW5kbGVdKGhfbXNnKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRlbHNlIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYHdvcmtlciBzZW50IGEgbWVzc2FnZSB0aGF0IGhhcyBubyBkZWZpbmVkIGhhbmRsZXI6ICcke2hfbXNnLnR5cGV9J2ApO1xuXHRcdFx0XHR9XG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdFx0aWQ6IGlfaWQsXG5cdFx0XHRtYXN0ZXI6IGtfbWFzdGVyLFxuXHRcdFx0cG9ydDogZF93b3JrZXIsXG5cdFx0XHRidXN5OiBmYWxzZSxcblx0XHRcdGF2YWlsYWJsZTogdHJ1ZSxcblx0XHRcdHRhc2tzX2Fzc2lnbmVkOiAwLFxuXHRcdFx0Y2FsbGJhY2tzOiB7fSxcblx0XHRcdGV2ZW50czoge30sXG5cdFx0XHRzdWJ3b3JrZXJzOiBbXSxcblx0XHRcdHRhc2tfZXJyb3I6IG51bGwsXG5cdFx0XHRjaGFubmVsczogbmV3IE1hcCgpLFxuXHRcdFx0c2VydmVyOiBudWxsLFxuXHRcdH0pO1xuXHR9XG5cblx0ZGVidWcoc190YWcsIHNfdHlwZSwgLi4uYV9pbmZvKSB7XG5cdFx0Y29uc29sZS53YXJuKGBbJHtzX3RhZ31dIGAud2hpdGUrYE0ke1N0cmluZy5mcm9tQ2hhckNvZGUoNjUrdGhpcy5pZCl9YC5ibHVlK2AgJHtzX3R5cGV9ICR7YV9pbmZvLmxlbmd0aD8gJygnK2FfaW5mby5qb2luKCcsICcpKycpJzogJy0nfWApO1xuXHR9XG5cblx0aGFuZGxlX2Nsb3NlX3NlcnZlcihoX21zZykge1xuXHRcdERDX0NIQU5ORUwua2lsbChoX21zZy5zZXJ2ZXIpO1xuXHR9XG5cblx0aGFuZGxlX3Jlc3BvbmQoaF9tc2cpIHtcblx0XHRsZXQgaF9jYWxsYmFja3MgPSB0aGlzLmNhbGxiYWNrcztcblxuXHRcdC8vIG5vIGxvbmdlciBidXN5XG5cdFx0dGhpcy5idXN5ID0gZmFsc2U7XG5cblx0XHQvLyBncmFiIHRhc2sgaWRcblx0XHRsZXQgaV90YXNrID0gaF9tc2cuaWQ7XG5cblx0XHRpZihoX21zZy5kZWJ1ZykgdGhpcy5kZWJ1ZyhoX21zZy5kZWJ1ZywgJzw8IHJlc3BvbmQnLnJlZCwgaV90YXNrKTtcblxuXHRcdC8vIGV4ZWN1dGUgY2FsbGJhY2tcblx0XHRoX2NhbGxiYWNrc1tpX3Rhc2tdKGhfbXNnLmRhdGEsIGlfdGFzaywgdGhpcyk7XG5cblx0XHQvLyBmcmVlIGNhbGxiYWNrXG5cdFx0ZGVsZXRlIGhfY2FsbGJhY2tzW2lfdGFza107XG5cdH1cblxuXHRoYW5kbGVfbm90aWZ5KGhfbXNnKSB7XG5cdFx0aF9tc2cuZGF0YSA9IEhQX1dPUktFUl9OT1RJRklDQVRJT047XG5cblx0XHQvLyBubyBsb25nZXIgYnVzeVxuXHRcdHRoaXMuYnVzeSA9IGZhbHNlO1xuXG5cdFx0aWYoaF9tc2cuZGVidWcpIHRoaXMuZGVidWcoaF9tc2cuZGVidWcsICc8PCBub3RpZnknLnJlZCk7XG5cblx0XHR0aGlzLmhhbmRsZV9yZXNwb25kKGhfbXNnKTtcblx0fVxuXG5cdGhhbmRsZV9ldmVudChoX21zZykge1xuXHRcdC8vIGV2ZW50IGlzIGd1YXJhbnRlZWQgdG8gYmUgaGVyZTsganVzdCBjYWxsYmFjayB3aXRoIGRhdGFcblx0XHR0aGlzLmV2ZW50c1toX21zZy5pZF1baF9tc2cuZXZlbnRdKC4uLmhfbXNnLmFyZ3MpO1xuXHR9XG5cblx0aGFuZGxlX2Vycm9yKGhfbXNnKSB7XG5cdFx0bGV0IGhfZXJyb3IgPSBoX21zZy5lcnJvcjtcblx0XHRsZXQgZV9tc2cgPSBuZXcgRXJyb3IoaF9lcnJvci5tZXNzYWdlKTtcblx0XHRlX21zZy5zdGFjayA9IGhfZXJyb3Iuc3RhY2s7XG5cblx0XHRpZih0aGlzLnRhc2tfZXJyb3IpIHtcblx0XHRcdHRoaXMudGFza19lcnJvcihlX21zZyk7XG5cdFx0fVxuXHRcdGVsc2Uge1xuXHRcdFx0dGhyb3cgZV9tc2c7XG5cdFx0fVxuXHR9XG5cblx0aGFuZGxlX3NwYXduKGhfbXNnKSB7XG5cdFx0bGV0IHBfc291cmNlID0gcGF0aC5qb2luKHBhdGguZGlybmFtZSh0aGlzLnNvdXJjZSksIGhfbXNnLnNvdXJjZSk7XG5cdFx0aWYoJy8nICE9PSBwX3NvdXJjZVswXSkgcF9zb3VyY2UgPSAnLi8nK3Bfc291cmNlO1xuXG5cdFx0cF9zb3VyY2UgPSBoX21zZy5zb3VyY2U7XG5cdFx0bGV0IGRfc3Vid29ya2VyID0gc3Bhd25fd29ya2VyKHBfc291cmNlKTtcblx0XHRsZXQgaV9zdWJ3b3JrZXIgPSB0aGlzLnN1YndvcmtlcnMucHVzaChkX3N1YndvcmtlciktMTtcblxuXHRcdGRfc3Vid29ya2VyLm9uKCdlcnJvcicsIChlX3dvcmtlcikgPT4ge1xuXHRcdFx0dGhpcy5wb3J0LnBvc3RNZXNzYWdlKHtcblx0XHRcdFx0dHlwZTogJ3N1Yndvcmtlcl9lcnJvcicsXG5cdFx0XHRcdGVycm9yOiB7XG5cdFx0XHRcdFx0bWVzc2FnZTogZV93b3JrZXIubWVzc2FnZSxcblx0XHRcdFx0XHRmaWxlbmFtZTogZV93b3JrZXIuZmlsZW5hbWUsXG5cdFx0XHRcdFx0bGluZW5vOiBlX3dvcmtlci5saW5lbm8sXG5cdFx0XHRcdH0sXG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdGxldCBrX2NoYW5uZWwgPSBuZXcgRENfQ0hBTk5FTCgpO1xuXG5cdFx0a19jaGFubmVsLnBvcnRfMSgoZF9wb3J0KSA9PiB7XG5cdFx0XHR0aGlzLnBvcnQucG9zdFBvcnQoZF9wb3J0LCB7XG5cdFx0XHRcdHR5cGU6ICdzdWJ3b3JrZXInLFxuXHRcdFx0XHRpZDogaF9tc2cuaWQsXG5cdFx0XHRcdG1hc3Rlcl9rZXk6IGlfc3Vid29ya2VyLFxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cblx0XHRrX2NoYW5uZWwucG9ydF8yKChkX3BvcnQpID0+IHtcblx0XHRcdGRfc3Vid29ya2VyLnBvc3RQb3J0KGRfcG9ydCwge1xuXHRcdFx0XHR0eXBlOiAnb3duZXInLFxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH1cblxuXHRoYW5kbGVfcGluZygpIHtcblx0XHRLX1NFTEYucG9zdE1lc3NhZ2Uoe1xuXHRcdFx0dHlwZTogJ3BvbmcnLFxuXHRcdH0pO1xuXHR9XG5cblx0aGFuZGxlX3Rlcm1pbmF0ZShoX21zZykge1xuXHRcdHRoaXMuc3Vid29ya2Vyc1toX21zZy5tYXN0ZXJfa2V5XS50ZXJtaW5hdGUoKTtcblx0fVxuXG5cdHByZXBhcmUoaF90YXNrLCBma190YXNrLCBhX3Jvb3RzPVtdKSB7XG5cdFx0bGV0IGlfdGFzayA9ICsraV9ndWlkO1xuXG5cdFx0bGV0IHtcblx0XHRcdHRhc2s6IHNfdGFzayxcblx0XHRcdG1hbmlmZXN0OiBrX21hbmlmZXN0LFxuXHRcdFx0cmVjZWl2ZTogaV9yZWNlaXZlPTAsXG5cdFx0XHRpbmhlcml0OiBpX2luaGVyaXQ9MCxcblx0XHRcdGhvbGQ6IGJfaG9sZD1mYWxzZSxcblx0XHRcdGV2ZW50czogaF9ldmVudHM9bnVsbCxcblx0XHR9ID0gaF90YXNrO1xuXG5cdFx0Ly8gc2F2ZSBjYWxsYmFja1xuXHRcdHRoaXMuY2FsbGJhY2tzW2lfdGFza10gPSBma190YXNrO1xuXG5cdFx0Ly8gc2F2ZSBldmVudHNcblx0XHRpZihoX2V2ZW50cykge1xuXHRcdFx0dGhpcy5ldmVudHNbaV90YXNrXSA9IGhfZXZlbnRzO1xuXG5cdFx0XHQvLyB3aGF0IHRvIHNlbmRcblx0XHRcdGxldCBoX2V2ZW50c19zZW5kID17fTtcblx0XHRcdGZvcihsZXQgc19rZXkgaW4gaF9ldmVudHMpIHtcblx0XHRcdFx0aF9ldmVudHNfc2VuZFtzX2tleV0gPSAxO1xuXHRcdFx0fVxuXHRcdFx0aF9ldmVudHMgPSBoX2V2ZW50c19zZW5kO1xuXHRcdH1cblxuXHRcdC8vIHNlbmQgdGFza1xuXHRcdHJldHVybiB7XG5cdFx0XHRtc2c6IHtcblx0XHRcdFx0dHlwZTogJ3Rhc2snLFxuXHRcdFx0XHRpZDogaV90YXNrLFxuXHRcdFx0XHR0YXNrOiBzX3Rhc2ssXG5cdFx0XHRcdGFyZ3M6IGtfbWFuaWZlc3QuZGF0YSxcblx0XHRcdFx0cmVjZWl2ZTogaV9yZWNlaXZlLFxuXHRcdFx0XHRpbmhlcml0OiBpX2luaGVyaXQsXG5cdFx0XHRcdGhvbGQ6IGJfaG9sZCxcblx0XHRcdFx0ZXZlbnRzOiBoX2V2ZW50cyxcblx0XHRcdH0sXG5cdFx0XHRwYXRoczoga19tYW5pZmVzdC5wYXRocyguLi5hX3Jvb3RzLCAnYXJncycpLFxuXHRcdH07XG5cdH1cblxuXHRleGVjKGhfdGFza19leGVjLCBma190YXNrKSB7XG5cdFx0Ly8gbWFyayB3b3JrZXIgYXMgYnVzeVxuXHRcdHRoaXMuYnVzeSA9IHRydWU7XG5cblx0XHQvLyBwcmVwYXJlIGZpbmFsIHRhc2sgZGVzY3JpcHRvclxuXHRcdGxldCBoX3Rhc2sgPSB0aGlzLnByZXBhcmUoaF90YXNrX2V4ZWMsIGZrX3Rhc2spO1xuXG5cdFx0Ly8gdGhpcy5kZWJ1ZygnZXhlYzonK2hfdGFzay5tc2cuaWQpO1xuXG5cdFx0Ly8gcG9zdCB0byB3b3JrZXJcblx0XHR0aGlzLnBvcnQucG9zdE1lc3NhZ2UoaF90YXNrLm1zZywgaF90YXNrLnBhdGhzKTtcblx0fVxuXG5cdC8vIGFzc2lnbiBhIHRhc2sgdG8gdGhlIHdvcmtlclxuXHRydW4oc190YXNrLCB6X2FyZ3MsIGhfZXZlbnRzLCBma19ydW4pIHtcblx0XHQvLyBwcmVwYXJlIGZpbmFsIHRhc2sgZGVzY3JpcHRvclxuXHRcdGxldCBoX2V4ZWMgPSB7XG5cdFx0XHR0YXNrOiBzX3Rhc2ssXG5cdFx0XHRtYW5pZmVzdDogbWFuaWZlc3QuZnJvbSh6X2FyZ3MpLFxuXHRcdFx0ZXZlbnRzOiBoX2V2ZW50cyxcblx0XHR9O1xuXG5cdFx0Ly8gcHJldmlvdXMgcnVuIHRhc2tcblx0XHRpZih0aGlzLnByZXZfcnVuX3Rhc2spIHtcblx0XHRcdGhfZXhlYy5pbmhlcml0ID0gdGhpcy5wcmV2X3J1bl90YXNrO1xuXHRcdH1cblxuXHRcdC8vIGV4ZWN1dGUgdGFza1xuXHRcdGxldCBkcF9leGVjID0gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSwgZl9yZWplY3QpID0+IHtcblx0XHRcdHRoaXMudGFza19lcnJvciA9IGZfcmVqZWN0O1xuXHRcdFx0dGhpcy5leGVjKGhfZXhlYywgKHpfcmVzdWx0LCBpX3Rhc2spID0+IHtcblx0XHRcdFx0dGhpcy5wcmV2X3J1bl90YXNrID0gaV90YXNrO1xuXHRcdFx0XHR0aGlzLnRhc2tfZXJyb3IgPSBudWxsO1xuXHRcdFx0XHRmX3Jlc29sdmUoel9yZXN1bHQpO1xuXHRcdFx0fSk7XG5cdFx0fSk7XG5cblx0XHQvLyBlbWJlZGRlZCByZXNvbHZlL3JlamVjdFxuXHRcdGlmKCdmdW5jdGlvbicgPT09IHR5cGVvZiBma19ydW4pIHtcblx0XHRcdGRwX2V4ZWMudGhlbigoel9yZXN1bHQpID0+IHtcblx0XHRcdFx0ZmtfcnVuKG51bGwsIHpfcmVzdWx0KTtcblx0XHRcdH0pLmNhdGNoKChlX2V4ZWMpID0+IHtcblx0XHRcdFx0ZmtfcnVuKGVfZXhlYyk7XG5cdFx0XHR9KTtcblx0XHR9XG5cdFx0Ly8gcHJvbWlzZVxuXHRcdGVsc2Uge1xuXHRcdFx0cmV0dXJuIGRwX2V4ZWM7XG5cdFx0fVxuXHR9XG5cblx0cmVjZWl2ZShkX3BvcnQsIGhfcmVjZWl2ZSwgZmtfdGFzaywgc19kZWJ1Zz1udWxsKSB7XG5cdFx0bGV0IGhfdGFzayA9IHRoaXMucHJlcGFyZShoX3JlY2VpdmUudGFza19yZWFkeSwgZmtfdGFzaywgWyd0YXNrX3JlYWR5J10pO1xuXG5cdFx0aWYoc19kZWJ1ZykgdGhpcy5kZWJ1ZyhzX2RlYnVnLCAnPj4gcmVjZWl2ZTonLmdyZWVuK2hfcmVjZWl2ZS5pbXBvcnQsIGhfdGFzay5tc2cuaWQsIGRfcG9ydC5uYW1lIHx8IGRfcG9ydCk7XG5cblx0XHR0aGlzLnBvcnQucG9zdFBvcnQoZF9wb3J0LCB7XG5cdFx0XHR0eXBlOiAncmVjZWl2ZScsXG5cdFx0XHRpbXBvcnQ6IGhfcmVjZWl2ZS5pbXBvcnQsXG5cdFx0XHRzZW5kZXI6IGhfcmVjZWl2ZS5zZW5kZXIsXG5cdFx0XHRwcmltYXJ5OiBoX3JlY2VpdmUucHJpbWFyeSxcblx0XHRcdHRhc2tfcmVhZHk6IE9iamVjdC5hc3NpZ24oaF90YXNrLm1zZywge2RlYnVnOnNfZGVidWd9KSxcblx0XHRcdGRlYnVnOiBzX2RlYnVnLFxuXHRcdH0sIFsuLi4oaF90YXNrLnBhdGhzIHx8IFtdKV0pO1xuXHR9XG5cblx0cmVsYXkoaV90YXNrX3NlbmRlciwgZF9wb3J0LCBzX3JlY2VpdmVyLCBzX2RlYnVnPW51bGwpIHtcblx0XHRpZihzX2RlYnVnKSB0aGlzLmRlYnVnKHNfZGVidWcsICc+PiByZWxheScsIGlfdGFza19zZW5kZXIsIGRfcG9ydC5uYW1lIHx8IGRfcG9ydCk7XG5cblx0XHR0aGlzLnBvcnQucG9zdFBvcnQoZF9wb3J0LCB7XG5cdFx0XHR0eXBlOiAncmVsYXknLFxuXHRcdFx0aWQ6IGlfdGFza19zZW5kZXIsXG5cdFx0XHRkZWJ1Zzogc19kZWJ1Zyxcblx0XHR9KTtcblx0fVxuXG5cdGtpbGwoc19raWxsKSB7XG5cdFx0aWYoQl9CUk9XU0VSKSB7XG5cdFx0XHRyZXR1cm4gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSkgPT4ge1xuXHRcdFx0XHR0aGlzLnBvcnQudGVybWluYXRlKCk7XG5cdFx0XHRcdGZfcmVzb2x2ZSgpO1xuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdGVsc2Uge1xuXHRcdFx0cmV0dXJuIHRoaXMucG9ydC50ZXJtaW5hdGUoc19raWxsKTtcblx0XHR9XG5cdH1cbn1cblxuXG5jb25zdCBta19uZXcgPSAoZGMpID0+IGZ1bmN0aW9uKC4uLmFfYXJncykge1xuXHRyZXR1cm4gbmV3IGRjKC4uLmFfYXJncyk7XG59O1xuXG4vLyBub3cgaW1wb3J0IGFueWhpbmcgdGhhdCBkZXBlbmRzIG9uIHdvcmtlclxuY29uc3QgZ3JvdXAgPSByZXF1aXJlKCcuL2FsbC9ncm91cC5qcycpKHdvcmtlcik7XG5jb25zdCBwb29sID0gcmVxdWlyZSgnLi9hbGwvcG9vbC5qcycpKHdvcmtlcik7XG5cbmNvbnN0IEhfRVhQT1JUUyA9IHtcblx0c3Bhd24oLi4uYV9hcmdzKSB7XG5cdFx0cmV0dXJuIHdvcmtlci5mcm9tX3NvdXJjZSguLi5hX2FyZ3MpO1xuXHR9LFxuXG5cdG5ldzogKC4uLmFfYXJncykgPT4gbmV3IHdvcmtlciguLi5hX2FyZ3MpLFxuXHRncm91cDogbWtfbmV3KGdyb3VwKSxcblx0cG9vbDogbWtfbmV3KHBvb2wpLFxuXHRkZWRpY2F0ZWQ6IG1rX25ldyhkZWRpY2F0ZWQpLFxuXHRtYW5pZmVzdDogbWtfbmV3KG1hbmlmZXN0KSxcblx0cmVzdWx0OiBta19uZXcocmVzdWx0KSxcblxuXHRzdHJlYW0sXG5cdC8vIHN0cmVhbTogbWtfbmV3KHdyaXRhYmxlX3N0cmVhbSksXG5cdC8vIGdldCBzdHJlYW0oKSB7XG5cdC8vIFx0ZGVsZXRlIHRoaXMuc3RyZWFtO1xuXHQvLyBcdHJldHVybiB0aGlzLnN0cmVhbSA9IHJlcXVpcmUoJy4vc3RyZWFtLmpzJyk7XG5cdC8vIH0sXG5cblx0Ly8gc3RhdGVzXG5cdGJyb3dzZXI6IEJfQlJPV1NFUixcblx0YnJvd3NlcmlmeTogQl9CUk9XU0VSSUZZLFxuXHQvLyBkZXB0aDogV09SS0VSX0RFUFRIXG5cblx0Ly8gaW1wb3J0IHR5cGVkIGFycmF5cyBpbnRvIHRoZSBnaXZlbiBzY29wZVxuXHRnbG9iYWxzOiAoaF9zY29wZT17fSkgPT4gT2JqZWN0LmFzc2lnbihoX3Njb3BlLCBIX1RZUEVEX0FSUkFZUy5leHBvcnRzKSxcblxuXHQvLyBmb3IgY29tcGF0aWJpbGl0eSB3aXRoIGJyb3dzZXJpZnlcblx0c2NvcGlmeShmX3JlcXVpcmUsIGFfc291cmNlcywgZF9hcmd1bWVudHMpIHtcblx0XHQvLyBicm93c2VyaWZ5IGFyZ3VtZW50c1xuXHRcdGxldCBhX2Jyb3dzZXJpZnkgPSBkX2FyZ3VtZW50cz8gW2RfYXJndW1lbnRzWzNdLCBkX2FyZ3VtZW50c1s0XSwgZF9hcmd1bWVudHNbNV1dOiBudWxsO1xuXG5cdFx0Ly8gcnVubmluZyBpbiBicm93c2VyaWZ5XG5cdFx0aWYoQl9CUk9XU0VSSUZZKSB7XG5cdFx0XHRjb25zdCBsYXRlbnRfc3Vid29ya2VyID0gcmVxdWlyZSgnLi9icm93c2VyL2xhdGVudC1zdWJ3b3JrZXIuanMnKTtcblxuXHRcdFx0Ly8gY2hhbmdlIGhvdyBhIHdvcmtlciBpcyBzcGF3bmVkXG5cdFx0XHRzcGF3bl93b3JrZXIgPSAocF9zb3VyY2UsIGhfb3B0aW9ucykgPT4ge1xuXHRcdFx0XHQvLyB3b3JrYXJvdW5kIGZvciBjaHJvbWl1bSBidWcgdGhhdCBjYW5ub3Qgc3Bhd24gc3Vid29ya2Vyc1xuXHRcdFx0XHRpZighQl9XT1JLRVJfU1VQUE9SVEVEKSB7XG5cdFx0XHRcdFx0bGV0IGtfc3Vid29ya2VyID0gbmV3IGxhdGVudF9zdWJ3b3JrZXIoKTtcblxuXHRcdFx0XHRcdC8vIHNlbmQgbWVzc2FnZSB0byBtYXN0ZXIgcmVxdWVzdGluZyBzcGF3biBvZiBuZXcgd29ya2VyXG5cdFx0XHRcdFx0S19TRUxGLnBvc3RNZXNzYWdlKHtcblx0XHRcdFx0XHRcdHR5cGU6ICdzcGF3bicsXG5cdFx0XHRcdFx0XHRpZDoga19zdWJ3b3JrZXIuaWQsXG5cdFx0XHRcdFx0XHRzb3VyY2U6IHBfc291cmNlLFxuXHRcdFx0XHRcdFx0b3B0aW9uczogaF9vcHRpb25zLFxuXHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0cmV0dXJuIGtfc3Vid29ya2VyO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIHdvcmtlciBpcyBkZWZpbmVkXG5cdFx0XHRcdGVsc2Uge1xuXHRcdFx0XHRcdGxldCB6X2ltcG9ydCA9IGZfcmVxdWlyZShwX3NvdXJjZSk7XG5cdFx0XHRcdFx0cmV0dXJuIHdlYndvcmtlcmlmeSh6X2ltcG9ydCwge1xuXHRcdFx0XHRcdFx0YnJvd3NlcmlmeTogYV9icm93c2VyaWZ5LFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdC8vIG5vcm1hbCBleHBvcnRzXG5cdFx0cmV0dXJuIEhfRVhQT1JUUztcblx0fSxcblxuXHRtZXJnZV9zb3J0ZWQoYV9hLCBhX2IsIGZfY21wKSB7XG5cdFx0Ly8gb3V0cHV0IGxpc3Rcblx0XHRsZXQgYV9vdXQgPSBbXTtcblxuXHRcdC8vIGluZGV4IG9mIG5leHQgaXRlbSBmcm9tIGVhY2ggbGlzdFxuXHRcdGxldCBpX2EgPSAwO1xuXHRcdGxldCBpX2IgPSAwO1xuXG5cdFx0Ly8gY3VycmVudCBpdGVtIGZyb20gZWFjaCBsaXN0XG5cdFx0bGV0IHpfYSA9IGFfYVswXTtcblx0XHRsZXQgel9iID0gYV9iWzBdO1xuXG5cdFx0Ly8gZmluYWwgaW5kZXggb2YgZWFjaCBsaXN0XG5cdFx0bGV0IGloX2EgPSBhX2EubGVuZ3RoIC0gMTtcblx0XHRsZXQgaWhfYiA9IGFfYi5sZW5ndGggLSAxO1xuXG5cdFx0Ly8gbWVyZ2Vcblx0XHRmb3IoOzspIHtcblx0XHRcdC8vIGEgd2luc1xuXHRcdFx0aWYoZl9jbXAoel9hLCB6X2IpIDwgMCkge1xuXHRcdFx0XHQvLyBhZGQgdG8gb3V0cHV0IGxpc3Rcblx0XHRcdFx0YV9vdXQucHVzaCh6X2EpO1xuXG5cdFx0XHRcdC8vIHJlYWNoZWQgZW5kIG9mIGFcblx0XHRcdFx0aWYoaV9hID09PSBpaF9hKSBicmVhaztcblxuXHRcdFx0XHQvLyBuZXh0IGl0ZW0gZnJvbSBhXG5cdFx0XHRcdHpfYSA9IGFfYVsrK2lfYV07XG5cdFx0XHR9XG5cdFx0XHQvLyBiIHdpbnNcblx0XHRcdGVsc2Uge1xuXHRcdFx0XHQvLyBhZGQgdG8gb3V0cHV0IGxpc3Rcblx0XHRcdFx0YV9vdXQucHVzaCh6X2IpO1xuXG5cdFx0XHRcdC8vIHJlYWNoZWQgZW5kIG9mIGJcblx0XHRcdFx0aWYoaV9iID09PSBpaF9iKSBicmVhaztcblxuXHRcdFx0XHQvLyBuZXh0IGl0ZW0gZnJvbSBiXG5cdFx0XHRcdHpfYiA9IGFfYlsrK2lfYl07XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gYSBmaW5pc2hlZCBmaXJzdFxuXHRcdGlmKGlfYSA9PT0gaWhfYSkge1xuXHRcdFx0Ly8gYXBwZW5kIHJlbWFpbmRlciBvZiBiXG5cdFx0XHRhX291dC5wdXNoKGFfYi5zbGljZShpX2IpKTtcblx0XHR9XG5cdFx0Ly8gYiBmaW5pc2hlZCBmaXJzdFxuXHRcdGVsc2Uge1xuXHRcdFx0Ly8gYXBwZW5kIHJlbWFpbmRlciBvZiBhXG5cdFx0XHRhX291dC5wdXNoKGFfYS5zbGljZShpX2EpKTtcblx0XHR9XG5cblx0XHQvLyByZXN1bHRcblx0XHRyZXR1cm4gYV9vdXQ7XG5cdH0sXG59O1xuXG5cbm1vZHVsZS5leHBvcnRzID0gT2JqZWN0LmFzc2lnbihmdW5jdGlvbiguLi5hX2FyZ3MpIHtcblx0Ly8gY2FsbGVkIGZyb20gd29ya2VyXG5cdGlmKFhNX0NPTlRFWFRfV09SS0VSICYgWF9DT05URVhUX1RZUEUpIHtcblx0XHQvLyBkZWRpY2F0ZWQgd29ya2VyXG5cdFx0aWYoWE1fQ09OVEVYVF9XT1JLRVJfREVESUNBVEVEID09PSBYX0NPTlRFWFRfVFlQRSkge1xuXHRcdFx0cmV0dXJuIG5ldyBkZWRpY2F0ZWQoLi4uYV9hcmdzKTtcblx0XHR9XG5cdFx0Ly8gc2hhcmVkIHdvcmtlclxuXHRcdGVsc2UgaWYoWE1fQ09OVEVYVF9XT1JLRVJfU0hBUkVEID09PSBYX0NPTlRFWFRfVFlQRSkge1xuXHRcdFx0Ly8gcmV0dXJuIG5ldyBzaGFyZWQoLi4uYV9hcmdzKTtcblx0XHR9XG5cdFx0Ly8gc2VydmljZSB3b3JrZXJcblx0XHRlbHNlIGlmKFhNX0NPTlRFWFRfV09SS0VSX1NFUlZJQ0UgPT09IFhfQ09OVEVYVF9UWVBFKSB7XG5cdFx0XHQvLyByZXR1cm4gbmV3IHNlcnZpY2UoLi4uYV9hcmdzKTtcblx0XHR9XG5cdH1cblx0Ly8gY2hpbGQgcHJvY2VzczsgZGVkaWNhdGVkIHdvcmtlclxuXHRlbHNlIGlmKFhNX0NPTlRFWFRfUFJPQ0VTU19DSElMRCA9PT0gWF9DT05URVhUX1RZUEUpIHtcblx0XHRyZXR1cm4gbmV3IGRlZGljYXRlZCguLi5hX2FyZ3MpO1xuXHR9XG5cdC8vIG1hc3RlclxuXHRlbHNlIHtcblx0XHRyZXR1cm4gd29ya2VyLmZyb21fc291cmNlKC4uLmFfYXJncyk7XG5cdH1cbn0sIEhfRVhQT1JUUyk7XG5cbiIsIid1c2Ugc3RyaWN0JztcblxuLy8gY29tcGFyZSBhbmQgaXNCdWZmZXIgdGFrZW4gZnJvbSBodHRwczovL2dpdGh1Yi5jb20vZmVyb3NzL2J1ZmZlci9ibG9iLzY4MGU5ZTVlNDg4ZjIyYWFjMjc1OTlhNTdkYzg0NGE2MzE1OTI4ZGQvaW5kZXguanNcbi8vIG9yaWdpbmFsIG5vdGljZTpcblxuLyohXG4gKiBUaGUgYnVmZmVyIG1vZHVsZSBmcm9tIG5vZGUuanMsIGZvciB0aGUgYnJvd3Nlci5cbiAqXG4gKiBAYXV0aG9yICAgRmVyb3NzIEFib3VraGFkaWplaCA8ZmVyb3NzQGZlcm9zcy5vcmc+IDxodHRwOi8vZmVyb3NzLm9yZz5cbiAqIEBsaWNlbnNlICBNSVRcbiAqL1xuZnVuY3Rpb24gY29tcGFyZShhLCBiKSB7XG4gIGlmIChhID09PSBiKSB7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICB2YXIgeCA9IGEubGVuZ3RoO1xuICB2YXIgeSA9IGIubGVuZ3RoO1xuXG4gIGZvciAodmFyIGkgPSAwLCBsZW4gPSBNYXRoLm1pbih4LCB5KTsgaSA8IGxlbjsgKytpKSB7XG4gICAgaWYgKGFbaV0gIT09IGJbaV0pIHtcbiAgICAgIHggPSBhW2ldO1xuICAgICAgeSA9IGJbaV07XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICBpZiAoeCA8IHkpIHtcbiAgICByZXR1cm4gLTE7XG4gIH1cbiAgaWYgKHkgPCB4KSB7XG4gICAgcmV0dXJuIDE7XG4gIH1cbiAgcmV0dXJuIDA7XG59XG5mdW5jdGlvbiBpc0J1ZmZlcihiKSB7XG4gIGlmIChnbG9iYWwuQnVmZmVyICYmIHR5cGVvZiBnbG9iYWwuQnVmZmVyLmlzQnVmZmVyID09PSAnZnVuY3Rpb24nKSB7XG4gICAgcmV0dXJuIGdsb2JhbC5CdWZmZXIuaXNCdWZmZXIoYik7XG4gIH1cbiAgcmV0dXJuICEhKGIgIT0gbnVsbCAmJiBiLl9pc0J1ZmZlcik7XG59XG5cbi8vIGJhc2VkIG9uIG5vZGUgYXNzZXJ0LCBvcmlnaW5hbCBub3RpY2U6XG5cbi8vIGh0dHA6Ly93aWtpLmNvbW1vbmpzLm9yZy93aWtpL1VuaXRfVGVzdGluZy8xLjBcbi8vXG4vLyBUSElTIElTIE5PVCBURVNURUQgTk9SIExJS0VMWSBUTyBXT1JLIE9VVFNJREUgVjghXG4vL1xuLy8gT3JpZ2luYWxseSBmcm9tIG5hcndoYWwuanMgKGh0dHA6Ly9uYXJ3aGFsanMub3JnKVxuLy8gQ29weXJpZ2h0IChjKSAyMDA5IFRob21hcyBSb2JpbnNvbiA8Mjgwbm9ydGguY29tPlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbi8vIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlICdTb2Z0d2FyZScpLCB0b1xuLy8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGVcbi8vIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vclxuLy8gc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcbi8vIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW5cbi8vIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCAnQVMgSVMnLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SXG4vLyBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcbi8vIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxuLy8gQVVUSE9SUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU5cbi8vIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT05cbi8vIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG52YXIgdXRpbCA9IHJlcXVpcmUoJ3V0aWwvJyk7XG52YXIgaGFzT3duID0gT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eTtcbnZhciBwU2xpY2UgPSBBcnJheS5wcm90b3R5cGUuc2xpY2U7XG52YXIgZnVuY3Rpb25zSGF2ZU5hbWVzID0gKGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIGZvbygpIHt9Lm5hbWUgPT09ICdmb28nO1xufSgpKTtcbmZ1bmN0aW9uIHBUb1N0cmluZyAob2JqKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwob2JqKTtcbn1cbmZ1bmN0aW9uIGlzVmlldyhhcnJidWYpIHtcbiAgaWYgKGlzQnVmZmVyKGFycmJ1ZikpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgaWYgKHR5cGVvZiBnbG9iYWwuQXJyYXlCdWZmZXIgIT09ICdmdW5jdGlvbicpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgaWYgKHR5cGVvZiBBcnJheUJ1ZmZlci5pc1ZpZXcgPT09ICdmdW5jdGlvbicpIHtcbiAgICByZXR1cm4gQXJyYXlCdWZmZXIuaXNWaWV3KGFycmJ1Zik7XG4gIH1cbiAgaWYgKCFhcnJidWYpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgaWYgKGFycmJ1ZiBpbnN0YW5jZW9mIERhdGFWaWV3KSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKGFycmJ1Zi5idWZmZXIgJiYgYXJyYnVmLmJ1ZmZlciBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuLy8gMS4gVGhlIGFzc2VydCBtb2R1bGUgcHJvdmlkZXMgZnVuY3Rpb25zIHRoYXQgdGhyb3dcbi8vIEFzc2VydGlvbkVycm9yJ3Mgd2hlbiBwYXJ0aWN1bGFyIGNvbmRpdGlvbnMgYXJlIG5vdCBtZXQuIFRoZVxuLy8gYXNzZXJ0IG1vZHVsZSBtdXN0IGNvbmZvcm0gdG8gdGhlIGZvbGxvd2luZyBpbnRlcmZhY2UuXG5cbnZhciBhc3NlcnQgPSBtb2R1bGUuZXhwb3J0cyA9IG9rO1xuXG4vLyAyLiBUaGUgQXNzZXJ0aW9uRXJyb3IgaXMgZGVmaW5lZCBpbiBhc3NlcnQuXG4vLyBuZXcgYXNzZXJ0LkFzc2VydGlvbkVycm9yKHsgbWVzc2FnZTogbWVzc2FnZSxcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhY3R1YWw6IGFjdHVhbCxcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHBlY3RlZDogZXhwZWN0ZWQgfSlcblxudmFyIHJlZ2V4ID0gL1xccypmdW5jdGlvblxccysoW15cXChcXHNdKilcXHMqLztcbi8vIGJhc2VkIG9uIGh0dHBzOi8vZ2l0aHViLmNvbS9samhhcmIvZnVuY3Rpb24ucHJvdG90eXBlLm5hbWUvYmxvYi9hZGVlZWVjOGJmY2M2MDY4YjE4N2Q3ZDlmYjNkNWJiMWQzYTMwODk5L2ltcGxlbWVudGF0aW9uLmpzXG5mdW5jdGlvbiBnZXROYW1lKGZ1bmMpIHtcbiAgaWYgKCF1dGlsLmlzRnVuY3Rpb24oZnVuYykpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGZ1bmN0aW9uc0hhdmVOYW1lcykge1xuICAgIHJldHVybiBmdW5jLm5hbWU7XG4gIH1cbiAgdmFyIHN0ciA9IGZ1bmMudG9TdHJpbmcoKTtcbiAgdmFyIG1hdGNoID0gc3RyLm1hdGNoKHJlZ2V4KTtcbiAgcmV0dXJuIG1hdGNoICYmIG1hdGNoWzFdO1xufVxuYXNzZXJ0LkFzc2VydGlvbkVycm9yID0gZnVuY3Rpb24gQXNzZXJ0aW9uRXJyb3Iob3B0aW9ucykge1xuICB0aGlzLm5hbWUgPSAnQXNzZXJ0aW9uRXJyb3InO1xuICB0aGlzLmFjdHVhbCA9IG9wdGlvbnMuYWN0dWFsO1xuICB0aGlzLmV4cGVjdGVkID0gb3B0aW9ucy5leHBlY3RlZDtcbiAgdGhpcy5vcGVyYXRvciA9IG9wdGlvbnMub3BlcmF0b3I7XG4gIGlmIChvcHRpb25zLm1lc3NhZ2UpIHtcbiAgICB0aGlzLm1lc3NhZ2UgPSBvcHRpb25zLm1lc3NhZ2U7XG4gICAgdGhpcy5nZW5lcmF0ZWRNZXNzYWdlID0gZmFsc2U7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5tZXNzYWdlID0gZ2V0TWVzc2FnZSh0aGlzKTtcbiAgICB0aGlzLmdlbmVyYXRlZE1lc3NhZ2UgPSB0cnVlO1xuICB9XG4gIHZhciBzdGFja1N0YXJ0RnVuY3Rpb24gPSBvcHRpb25zLnN0YWNrU3RhcnRGdW5jdGlvbiB8fCBmYWlsO1xuICBpZiAoRXJyb3IuY2FwdHVyZVN0YWNrVHJhY2UpIHtcbiAgICBFcnJvci5jYXB0dXJlU3RhY2tUcmFjZSh0aGlzLCBzdGFja1N0YXJ0RnVuY3Rpb24pO1xuICB9IGVsc2Uge1xuICAgIC8vIG5vbiB2OCBicm93c2VycyBzbyB3ZSBjYW4gaGF2ZSBhIHN0YWNrdHJhY2VcbiAgICB2YXIgZXJyID0gbmV3IEVycm9yKCk7XG4gICAgaWYgKGVyci5zdGFjaykge1xuICAgICAgdmFyIG91dCA9IGVyci5zdGFjaztcblxuICAgICAgLy8gdHJ5IHRvIHN0cmlwIHVzZWxlc3MgZnJhbWVzXG4gICAgICB2YXIgZm5fbmFtZSA9IGdldE5hbWUoc3RhY2tTdGFydEZ1bmN0aW9uKTtcbiAgICAgIHZhciBpZHggPSBvdXQuaW5kZXhPZignXFxuJyArIGZuX25hbWUpO1xuICAgICAgaWYgKGlkeCA+PSAwKSB7XG4gICAgICAgIC8vIG9uY2Ugd2UgaGF2ZSBsb2NhdGVkIHRoZSBmdW5jdGlvbiBmcmFtZVxuICAgICAgICAvLyB3ZSBuZWVkIHRvIHN0cmlwIG91dCBldmVyeXRoaW5nIGJlZm9yZSBpdCAoYW5kIGl0cyBsaW5lKVxuICAgICAgICB2YXIgbmV4dF9saW5lID0gb3V0LmluZGV4T2YoJ1xcbicsIGlkeCArIDEpO1xuICAgICAgICBvdXQgPSBvdXQuc3Vic3RyaW5nKG5leHRfbGluZSArIDEpO1xuICAgICAgfVxuXG4gICAgICB0aGlzLnN0YWNrID0gb3V0O1xuICAgIH1cbiAgfVxufTtcblxuLy8gYXNzZXJ0LkFzc2VydGlvbkVycm9yIGluc3RhbmNlb2YgRXJyb3JcbnV0aWwuaW5oZXJpdHMoYXNzZXJ0LkFzc2VydGlvbkVycm9yLCBFcnJvcik7XG5cbmZ1bmN0aW9uIHRydW5jYXRlKHMsIG4pIHtcbiAgaWYgKHR5cGVvZiBzID09PSAnc3RyaW5nJykge1xuICAgIHJldHVybiBzLmxlbmd0aCA8IG4gPyBzIDogcy5zbGljZSgwLCBuKTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gcztcbiAgfVxufVxuZnVuY3Rpb24gaW5zcGVjdChzb21ldGhpbmcpIHtcbiAgaWYgKGZ1bmN0aW9uc0hhdmVOYW1lcyB8fCAhdXRpbC5pc0Z1bmN0aW9uKHNvbWV0aGluZykpIHtcbiAgICByZXR1cm4gdXRpbC5pbnNwZWN0KHNvbWV0aGluZyk7XG4gIH1cbiAgdmFyIHJhd25hbWUgPSBnZXROYW1lKHNvbWV0aGluZyk7XG4gIHZhciBuYW1lID0gcmF3bmFtZSA/ICc6ICcgKyByYXduYW1lIDogJyc7XG4gIHJldHVybiAnW0Z1bmN0aW9uJyArICBuYW1lICsgJ10nO1xufVxuZnVuY3Rpb24gZ2V0TWVzc2FnZShzZWxmKSB7XG4gIHJldHVybiB0cnVuY2F0ZShpbnNwZWN0KHNlbGYuYWN0dWFsKSwgMTI4KSArICcgJyArXG4gICAgICAgICBzZWxmLm9wZXJhdG9yICsgJyAnICtcbiAgICAgICAgIHRydW5jYXRlKGluc3BlY3Qoc2VsZi5leHBlY3RlZCksIDEyOCk7XG59XG5cbi8vIEF0IHByZXNlbnQgb25seSB0aGUgdGhyZWUga2V5cyBtZW50aW9uZWQgYWJvdmUgYXJlIHVzZWQgYW5kXG4vLyB1bmRlcnN0b29kIGJ5IHRoZSBzcGVjLiBJbXBsZW1lbnRhdGlvbnMgb3Igc3ViIG1vZHVsZXMgY2FuIHBhc3Ncbi8vIG90aGVyIGtleXMgdG8gdGhlIEFzc2VydGlvbkVycm9yJ3MgY29uc3RydWN0b3IgLSB0aGV5IHdpbGwgYmVcbi8vIGlnbm9yZWQuXG5cbi8vIDMuIEFsbCBvZiB0aGUgZm9sbG93aW5nIGZ1bmN0aW9ucyBtdXN0IHRocm93IGFuIEFzc2VydGlvbkVycm9yXG4vLyB3aGVuIGEgY29ycmVzcG9uZGluZyBjb25kaXRpb24gaXMgbm90IG1ldCwgd2l0aCBhIG1lc3NhZ2UgdGhhdFxuLy8gbWF5IGJlIHVuZGVmaW5lZCBpZiBub3QgcHJvdmlkZWQuICBBbGwgYXNzZXJ0aW9uIG1ldGhvZHMgcHJvdmlkZVxuLy8gYm90aCB0aGUgYWN0dWFsIGFuZCBleHBlY3RlZCB2YWx1ZXMgdG8gdGhlIGFzc2VydGlvbiBlcnJvciBmb3Jcbi8vIGRpc3BsYXkgcHVycG9zZXMuXG5cbmZ1bmN0aW9uIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgb3BlcmF0b3IsIHN0YWNrU3RhcnRGdW5jdGlvbikge1xuICB0aHJvdyBuZXcgYXNzZXJ0LkFzc2VydGlvbkVycm9yKHtcbiAgICBtZXNzYWdlOiBtZXNzYWdlLFxuICAgIGFjdHVhbDogYWN0dWFsLFxuICAgIGV4cGVjdGVkOiBleHBlY3RlZCxcbiAgICBvcGVyYXRvcjogb3BlcmF0b3IsXG4gICAgc3RhY2tTdGFydEZ1bmN0aW9uOiBzdGFja1N0YXJ0RnVuY3Rpb25cbiAgfSk7XG59XG5cbi8vIEVYVEVOU0lPTiEgYWxsb3dzIGZvciB3ZWxsIGJlaGF2ZWQgZXJyb3JzIGRlZmluZWQgZWxzZXdoZXJlLlxuYXNzZXJ0LmZhaWwgPSBmYWlsO1xuXG4vLyA0LiBQdXJlIGFzc2VydGlvbiB0ZXN0cyB3aGV0aGVyIGEgdmFsdWUgaXMgdHJ1dGh5LCBhcyBkZXRlcm1pbmVkXG4vLyBieSAhIWd1YXJkLlxuLy8gYXNzZXJ0Lm9rKGd1YXJkLCBtZXNzYWdlX29wdCk7XG4vLyBUaGlzIHN0YXRlbWVudCBpcyBlcXVpdmFsZW50IHRvIGFzc2VydC5lcXVhbCh0cnVlLCAhIWd1YXJkLFxuLy8gbWVzc2FnZV9vcHQpOy4gVG8gdGVzdCBzdHJpY3RseSBmb3IgdGhlIHZhbHVlIHRydWUsIHVzZVxuLy8gYXNzZXJ0LnN0cmljdEVxdWFsKHRydWUsIGd1YXJkLCBtZXNzYWdlX29wdCk7LlxuXG5mdW5jdGlvbiBvayh2YWx1ZSwgbWVzc2FnZSkge1xuICBpZiAoIXZhbHVlKSBmYWlsKHZhbHVlLCB0cnVlLCBtZXNzYWdlLCAnPT0nLCBhc3NlcnQub2spO1xufVxuYXNzZXJ0Lm9rID0gb2s7XG5cbi8vIDUuIFRoZSBlcXVhbGl0eSBhc3NlcnRpb24gdGVzdHMgc2hhbGxvdywgY29lcmNpdmUgZXF1YWxpdHkgd2l0aFxuLy8gPT0uXG4vLyBhc3NlcnQuZXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZV9vcHQpO1xuXG5hc3NlcnQuZXF1YWwgPSBmdW5jdGlvbiBlcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmIChhY3R1YWwgIT0gZXhwZWN0ZWQpIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJz09JywgYXNzZXJ0LmVxdWFsKTtcbn07XG5cbi8vIDYuIFRoZSBub24tZXF1YWxpdHkgYXNzZXJ0aW9uIHRlc3RzIGZvciB3aGV0aGVyIHR3byBvYmplY3RzIGFyZSBub3QgZXF1YWxcbi8vIHdpdGggIT0gYXNzZXJ0Lm5vdEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2Vfb3B0KTtcblxuYXNzZXJ0Lm5vdEVxdWFsID0gZnVuY3Rpb24gbm90RXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICBpZiAoYWN0dWFsID09IGV4cGVjdGVkKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnIT0nLCBhc3NlcnQubm90RXF1YWwpO1xuICB9XG59O1xuXG4vLyA3LiBUaGUgZXF1aXZhbGVuY2UgYXNzZXJ0aW9uIHRlc3RzIGEgZGVlcCBlcXVhbGl0eSByZWxhdGlvbi5cbi8vIGFzc2VydC5kZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZV9vcHQpO1xuXG5hc3NlcnQuZGVlcEVxdWFsID0gZnVuY3Rpb24gZGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgaWYgKCFfZGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIGZhbHNlKSkge1xuICAgIGZhaWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSwgJ2RlZXBFcXVhbCcsIGFzc2VydC5kZWVwRXF1YWwpO1xuICB9XG59O1xuXG5hc3NlcnQuZGVlcFN0cmljdEVxdWFsID0gZnVuY3Rpb24gZGVlcFN0cmljdEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgaWYgKCFfZGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIHRydWUpKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnZGVlcFN0cmljdEVxdWFsJywgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCk7XG4gIH1cbn07XG5cbmZ1bmN0aW9uIF9kZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgc3RyaWN0LCBtZW1vcykge1xuICAvLyA3LjEuIEFsbCBpZGVudGljYWwgdmFsdWVzIGFyZSBlcXVpdmFsZW50LCBhcyBkZXRlcm1pbmVkIGJ5ID09PS5cbiAgaWYgKGFjdHVhbCA9PT0gZXhwZWN0ZWQpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBlbHNlIGlmIChpc0J1ZmZlcihhY3R1YWwpICYmIGlzQnVmZmVyKGV4cGVjdGVkKSkge1xuICAgIHJldHVybiBjb21wYXJlKGFjdHVhbCwgZXhwZWN0ZWQpID09PSAwO1xuXG4gIC8vIDcuMi4gSWYgdGhlIGV4cGVjdGVkIHZhbHVlIGlzIGEgRGF0ZSBvYmplY3QsIHRoZSBhY3R1YWwgdmFsdWUgaXNcbiAgLy8gZXF1aXZhbGVudCBpZiBpdCBpcyBhbHNvIGEgRGF0ZSBvYmplY3QgdGhhdCByZWZlcnMgdG8gdGhlIHNhbWUgdGltZS5cbiAgfSBlbHNlIGlmICh1dGlsLmlzRGF0ZShhY3R1YWwpICYmIHV0aWwuaXNEYXRlKGV4cGVjdGVkKSkge1xuICAgIHJldHVybiBhY3R1YWwuZ2V0VGltZSgpID09PSBleHBlY3RlZC5nZXRUaW1lKCk7XG5cbiAgLy8gNy4zIElmIHRoZSBleHBlY3RlZCB2YWx1ZSBpcyBhIFJlZ0V4cCBvYmplY3QsIHRoZSBhY3R1YWwgdmFsdWUgaXNcbiAgLy8gZXF1aXZhbGVudCBpZiBpdCBpcyBhbHNvIGEgUmVnRXhwIG9iamVjdCB3aXRoIHRoZSBzYW1lIHNvdXJjZSBhbmRcbiAgLy8gcHJvcGVydGllcyAoYGdsb2JhbGAsIGBtdWx0aWxpbmVgLCBgbGFzdEluZGV4YCwgYGlnbm9yZUNhc2VgKS5cbiAgfSBlbHNlIGlmICh1dGlsLmlzUmVnRXhwKGFjdHVhbCkgJiYgdXRpbC5pc1JlZ0V4cChleHBlY3RlZCkpIHtcbiAgICByZXR1cm4gYWN0dWFsLnNvdXJjZSA9PT0gZXhwZWN0ZWQuc291cmNlICYmXG4gICAgICAgICAgIGFjdHVhbC5nbG9iYWwgPT09IGV4cGVjdGVkLmdsb2JhbCAmJlxuICAgICAgICAgICBhY3R1YWwubXVsdGlsaW5lID09PSBleHBlY3RlZC5tdWx0aWxpbmUgJiZcbiAgICAgICAgICAgYWN0dWFsLmxhc3RJbmRleCA9PT0gZXhwZWN0ZWQubGFzdEluZGV4ICYmXG4gICAgICAgICAgIGFjdHVhbC5pZ25vcmVDYXNlID09PSBleHBlY3RlZC5pZ25vcmVDYXNlO1xuXG4gIC8vIDcuNC4gT3RoZXIgcGFpcnMgdGhhdCBkbyBub3QgYm90aCBwYXNzIHR5cGVvZiB2YWx1ZSA9PSAnb2JqZWN0JyxcbiAgLy8gZXF1aXZhbGVuY2UgaXMgZGV0ZXJtaW5lZCBieSA9PS5cbiAgfSBlbHNlIGlmICgoYWN0dWFsID09PSBudWxsIHx8IHR5cGVvZiBhY3R1YWwgIT09ICdvYmplY3QnKSAmJlxuICAgICAgICAgICAgIChleHBlY3RlZCA9PT0gbnVsbCB8fCB0eXBlb2YgZXhwZWN0ZWQgIT09ICdvYmplY3QnKSkge1xuICAgIHJldHVybiBzdHJpY3QgPyBhY3R1YWwgPT09IGV4cGVjdGVkIDogYWN0dWFsID09IGV4cGVjdGVkO1xuXG4gIC8vIElmIGJvdGggdmFsdWVzIGFyZSBpbnN0YW5jZXMgb2YgdHlwZWQgYXJyYXlzLCB3cmFwIHRoZWlyIHVuZGVybHlpbmdcbiAgLy8gQXJyYXlCdWZmZXJzIGluIGEgQnVmZmVyIGVhY2ggdG8gaW5jcmVhc2UgcGVyZm9ybWFuY2VcbiAgLy8gVGhpcyBvcHRpbWl6YXRpb24gcmVxdWlyZXMgdGhlIGFycmF5cyB0byBoYXZlIHRoZSBzYW1lIHR5cGUgYXMgY2hlY2tlZCBieVxuICAvLyBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nIChha2EgcFRvU3RyaW5nKS4gTmV2ZXIgcGVyZm9ybSBiaW5hcnlcbiAgLy8gY29tcGFyaXNvbnMgZm9yIEZsb2F0KkFycmF5cywgdGhvdWdoLCBzaW5jZSBlLmcuICswID09PSAtMCBidXQgdGhlaXJcbiAgLy8gYml0IHBhdHRlcm5zIGFyZSBub3QgaWRlbnRpY2FsLlxuICB9IGVsc2UgaWYgKGlzVmlldyhhY3R1YWwpICYmIGlzVmlldyhleHBlY3RlZCkgJiZcbiAgICAgICAgICAgICBwVG9TdHJpbmcoYWN0dWFsKSA9PT0gcFRvU3RyaW5nKGV4cGVjdGVkKSAmJlxuICAgICAgICAgICAgICEoYWN0dWFsIGluc3RhbmNlb2YgRmxvYXQzMkFycmF5IHx8XG4gICAgICAgICAgICAgICBhY3R1YWwgaW5zdGFuY2VvZiBGbG9hdDY0QXJyYXkpKSB7XG4gICAgcmV0dXJuIGNvbXBhcmUobmV3IFVpbnQ4QXJyYXkoYWN0dWFsLmJ1ZmZlciksXG4gICAgICAgICAgICAgICAgICAgbmV3IFVpbnQ4QXJyYXkoZXhwZWN0ZWQuYnVmZmVyKSkgPT09IDA7XG5cbiAgLy8gNy41IEZvciBhbGwgb3RoZXIgT2JqZWN0IHBhaXJzLCBpbmNsdWRpbmcgQXJyYXkgb2JqZWN0cywgZXF1aXZhbGVuY2UgaXNcbiAgLy8gZGV0ZXJtaW5lZCBieSBoYXZpbmcgdGhlIHNhbWUgbnVtYmVyIG9mIG93bmVkIHByb3BlcnRpZXMgKGFzIHZlcmlmaWVkXG4gIC8vIHdpdGggT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKSwgdGhlIHNhbWUgc2V0IG9mIGtleXNcbiAgLy8gKGFsdGhvdWdoIG5vdCBuZWNlc3NhcmlseSB0aGUgc2FtZSBvcmRlciksIGVxdWl2YWxlbnQgdmFsdWVzIGZvciBldmVyeVxuICAvLyBjb3JyZXNwb25kaW5nIGtleSwgYW5kIGFuIGlkZW50aWNhbCAncHJvdG90eXBlJyBwcm9wZXJ0eS4gTm90ZTogdGhpc1xuICAvLyBhY2NvdW50cyBmb3IgYm90aCBuYW1lZCBhbmQgaW5kZXhlZCBwcm9wZXJ0aWVzIG9uIEFycmF5cy5cbiAgfSBlbHNlIGlmIChpc0J1ZmZlcihhY3R1YWwpICE9PSBpc0J1ZmZlcihleHBlY3RlZCkpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH0gZWxzZSB7XG4gICAgbWVtb3MgPSBtZW1vcyB8fCB7YWN0dWFsOiBbXSwgZXhwZWN0ZWQ6IFtdfTtcblxuICAgIHZhciBhY3R1YWxJbmRleCA9IG1lbW9zLmFjdHVhbC5pbmRleE9mKGFjdHVhbCk7XG4gICAgaWYgKGFjdHVhbEluZGV4ICE9PSAtMSkge1xuICAgICAgaWYgKGFjdHVhbEluZGV4ID09PSBtZW1vcy5leHBlY3RlZC5pbmRleE9mKGV4cGVjdGVkKSkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBtZW1vcy5hY3R1YWwucHVzaChhY3R1YWwpO1xuICAgIG1lbW9zLmV4cGVjdGVkLnB1c2goZXhwZWN0ZWQpO1xuXG4gICAgcmV0dXJuIG9iakVxdWl2KGFjdHVhbCwgZXhwZWN0ZWQsIHN0cmljdCwgbWVtb3MpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGlzQXJndW1lbnRzKG9iamVjdCkge1xuICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKG9iamVjdCkgPT0gJ1tvYmplY3QgQXJndW1lbnRzXSc7XG59XG5cbmZ1bmN0aW9uIG9iakVxdWl2KGEsIGIsIHN0cmljdCwgYWN0dWFsVmlzaXRlZE9iamVjdHMpIHtcbiAgaWYgKGEgPT09IG51bGwgfHwgYSA9PT0gdW5kZWZpbmVkIHx8IGIgPT09IG51bGwgfHwgYiA9PT0gdW5kZWZpbmVkKVxuICAgIHJldHVybiBmYWxzZTtcbiAgLy8gaWYgb25lIGlzIGEgcHJpbWl0aXZlLCB0aGUgb3RoZXIgbXVzdCBiZSBzYW1lXG4gIGlmICh1dGlsLmlzUHJpbWl0aXZlKGEpIHx8IHV0aWwuaXNQcmltaXRpdmUoYikpXG4gICAgcmV0dXJuIGEgPT09IGI7XG4gIGlmIChzdHJpY3QgJiYgT2JqZWN0LmdldFByb3RvdHlwZU9mKGEpICE9PSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoYikpXG4gICAgcmV0dXJuIGZhbHNlO1xuICB2YXIgYUlzQXJncyA9IGlzQXJndW1lbnRzKGEpO1xuICB2YXIgYklzQXJncyA9IGlzQXJndW1lbnRzKGIpO1xuICBpZiAoKGFJc0FyZ3MgJiYgIWJJc0FyZ3MpIHx8ICghYUlzQXJncyAmJiBiSXNBcmdzKSlcbiAgICByZXR1cm4gZmFsc2U7XG4gIGlmIChhSXNBcmdzKSB7XG4gICAgYSA9IHBTbGljZS5jYWxsKGEpO1xuICAgIGIgPSBwU2xpY2UuY2FsbChiKTtcbiAgICByZXR1cm4gX2RlZXBFcXVhbChhLCBiLCBzdHJpY3QpO1xuICB9XG4gIHZhciBrYSA9IG9iamVjdEtleXMoYSk7XG4gIHZhciBrYiA9IG9iamVjdEtleXMoYik7XG4gIHZhciBrZXksIGk7XG4gIC8vIGhhdmluZyB0aGUgc2FtZSBudW1iZXIgb2Ygb3duZWQgcHJvcGVydGllcyAoa2V5cyBpbmNvcnBvcmF0ZXNcbiAgLy8gaGFzT3duUHJvcGVydHkpXG4gIGlmIChrYS5sZW5ndGggIT09IGtiLmxlbmd0aClcbiAgICByZXR1cm4gZmFsc2U7XG4gIC8vdGhlIHNhbWUgc2V0IG9mIGtleXMgKGFsdGhvdWdoIG5vdCBuZWNlc3NhcmlseSB0aGUgc2FtZSBvcmRlciksXG4gIGthLnNvcnQoKTtcbiAga2Iuc29ydCgpO1xuICAvL35+fmNoZWFwIGtleSB0ZXN0XG4gIGZvciAoaSA9IGthLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgaWYgKGthW2ldICE9PSBrYltpXSlcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICAvL2VxdWl2YWxlbnQgdmFsdWVzIGZvciBldmVyeSBjb3JyZXNwb25kaW5nIGtleSwgYW5kXG4gIC8vfn5+cG9zc2libHkgZXhwZW5zaXZlIGRlZXAgdGVzdFxuICBmb3IgKGkgPSBrYS5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGtleSA9IGthW2ldO1xuICAgIGlmICghX2RlZXBFcXVhbChhW2tleV0sIGJba2V5XSwgc3RyaWN0LCBhY3R1YWxWaXNpdGVkT2JqZWN0cykpXG4gICAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIDguIFRoZSBub24tZXF1aXZhbGVuY2UgYXNzZXJ0aW9uIHRlc3RzIGZvciBhbnkgZGVlcCBpbmVxdWFsaXR5LlxuLy8gYXNzZXJ0Lm5vdERlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlX29wdCk7XG5cbmFzc2VydC5ub3REZWVwRXF1YWwgPSBmdW5jdGlvbiBub3REZWVwRXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZSkge1xuICBpZiAoX2RlZXBFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBmYWxzZSkpIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsICdub3REZWVwRXF1YWwnLCBhc3NlcnQubm90RGVlcEVxdWFsKTtcbiAgfVxufTtcblxuYXNzZXJ0Lm5vdERlZXBTdHJpY3RFcXVhbCA9IG5vdERlZXBTdHJpY3RFcXVhbDtcbmZ1bmN0aW9uIG5vdERlZXBTdHJpY3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmIChfZGVlcEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIHRydWUpKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnbm90RGVlcFN0cmljdEVxdWFsJywgbm90RGVlcFN0cmljdEVxdWFsKTtcbiAgfVxufVxuXG5cbi8vIDkuIFRoZSBzdHJpY3QgZXF1YWxpdHkgYXNzZXJ0aW9uIHRlc3RzIHN0cmljdCBlcXVhbGl0eSwgYXMgZGV0ZXJtaW5lZCBieSA9PT0uXG4vLyBhc3NlcnQuc3RyaWN0RXF1YWwoYWN0dWFsLCBleHBlY3RlZCwgbWVzc2FnZV9vcHQpO1xuXG5hc3NlcnQuc3RyaWN0RXF1YWwgPSBmdW5jdGlvbiBzdHJpY3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlKSB7XG4gIGlmIChhY3R1YWwgIT09IGV4cGVjdGVkKSB7XG4gICAgZmFpbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlLCAnPT09JywgYXNzZXJ0LnN0cmljdEVxdWFsKTtcbiAgfVxufTtcblxuLy8gMTAuIFRoZSBzdHJpY3Qgbm9uLWVxdWFsaXR5IGFzc2VydGlvbiB0ZXN0cyBmb3Igc3RyaWN0IGluZXF1YWxpdHksIGFzXG4vLyBkZXRlcm1pbmVkIGJ5ICE9PS4gIGFzc2VydC5ub3RTdHJpY3RFcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBtZXNzYWdlX29wdCk7XG5cbmFzc2VydC5ub3RTdHJpY3RFcXVhbCA9IGZ1bmN0aW9uIG5vdFN0cmljdEVxdWFsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgaWYgKGFjdHVhbCA9PT0gZXhwZWN0ZWQpIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsIG1lc3NhZ2UsICchPT0nLCBhc3NlcnQubm90U3RyaWN0RXF1YWwpO1xuICB9XG59O1xuXG5mdW5jdGlvbiBleHBlY3RlZEV4Y2VwdGlvbihhY3R1YWwsIGV4cGVjdGVkKSB7XG4gIGlmICghYWN0dWFsIHx8ICFleHBlY3RlZCkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGlmIChPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoZXhwZWN0ZWQpID09ICdbb2JqZWN0IFJlZ0V4cF0nKSB7XG4gICAgcmV0dXJuIGV4cGVjdGVkLnRlc3QoYWN0dWFsKTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgaWYgKGFjdHVhbCBpbnN0YW5jZW9mIGV4cGVjdGVkKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICAvLyBJZ25vcmUuICBUaGUgaW5zdGFuY2VvZiBjaGVjayBkb2Vzbid0IHdvcmsgZm9yIGFycm93IGZ1bmN0aW9ucy5cbiAgfVxuXG4gIGlmIChFcnJvci5pc1Byb3RvdHlwZU9mKGV4cGVjdGVkKSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIHJldHVybiBleHBlY3RlZC5jYWxsKHt9LCBhY3R1YWwpID09PSB0cnVlO1xufVxuXG5mdW5jdGlvbiBfdHJ5QmxvY2soYmxvY2spIHtcbiAgdmFyIGVycm9yO1xuICB0cnkge1xuICAgIGJsb2NrKCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBlcnJvciA9IGU7XG4gIH1cbiAgcmV0dXJuIGVycm9yO1xufVxuXG5mdW5jdGlvbiBfdGhyb3dzKHNob3VsZFRocm93LCBibG9jaywgZXhwZWN0ZWQsIG1lc3NhZ2UpIHtcbiAgdmFyIGFjdHVhbDtcblxuICBpZiAodHlwZW9mIGJsb2NrICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignXCJibG9ja1wiIGFyZ3VtZW50IG11c3QgYmUgYSBmdW5jdGlvbicpO1xuICB9XG5cbiAgaWYgKHR5cGVvZiBleHBlY3RlZCA9PT0gJ3N0cmluZycpIHtcbiAgICBtZXNzYWdlID0gZXhwZWN0ZWQ7XG4gICAgZXhwZWN0ZWQgPSBudWxsO1xuICB9XG5cbiAgYWN0dWFsID0gX3RyeUJsb2NrKGJsb2NrKTtcblxuICBtZXNzYWdlID0gKGV4cGVjdGVkICYmIGV4cGVjdGVkLm5hbWUgPyAnICgnICsgZXhwZWN0ZWQubmFtZSArICcpLicgOiAnLicpICtcbiAgICAgICAgICAgIChtZXNzYWdlID8gJyAnICsgbWVzc2FnZSA6ICcuJyk7XG5cbiAgaWYgKHNob3VsZFRocm93ICYmICFhY3R1YWwpIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsICdNaXNzaW5nIGV4cGVjdGVkIGV4Y2VwdGlvbicgKyBtZXNzYWdlKTtcbiAgfVxuXG4gIHZhciB1c2VyUHJvdmlkZWRNZXNzYWdlID0gdHlwZW9mIG1lc3NhZ2UgPT09ICdzdHJpbmcnO1xuICB2YXIgaXNVbndhbnRlZEV4Y2VwdGlvbiA9ICFzaG91bGRUaHJvdyAmJiB1dGlsLmlzRXJyb3IoYWN0dWFsKTtcbiAgdmFyIGlzVW5leHBlY3RlZEV4Y2VwdGlvbiA9ICFzaG91bGRUaHJvdyAmJiBhY3R1YWwgJiYgIWV4cGVjdGVkO1xuXG4gIGlmICgoaXNVbndhbnRlZEV4Y2VwdGlvbiAmJlxuICAgICAgdXNlclByb3ZpZGVkTWVzc2FnZSAmJlxuICAgICAgZXhwZWN0ZWRFeGNlcHRpb24oYWN0dWFsLCBleHBlY3RlZCkpIHx8XG4gICAgICBpc1VuZXhwZWN0ZWRFeGNlcHRpb24pIHtcbiAgICBmYWlsKGFjdHVhbCwgZXhwZWN0ZWQsICdHb3QgdW53YW50ZWQgZXhjZXB0aW9uJyArIG1lc3NhZ2UpO1xuICB9XG5cbiAgaWYgKChzaG91bGRUaHJvdyAmJiBhY3R1YWwgJiYgZXhwZWN0ZWQgJiZcbiAgICAgICFleHBlY3RlZEV4Y2VwdGlvbihhY3R1YWwsIGV4cGVjdGVkKSkgfHwgKCFzaG91bGRUaHJvdyAmJiBhY3R1YWwpKSB7XG4gICAgdGhyb3cgYWN0dWFsO1xuICB9XG59XG5cbi8vIDExLiBFeHBlY3RlZCB0byB0aHJvdyBhbiBlcnJvcjpcbi8vIGFzc2VydC50aHJvd3MoYmxvY2ssIEVycm9yX29wdCwgbWVzc2FnZV9vcHQpO1xuXG5hc3NlcnQudGhyb3dzID0gZnVuY3Rpb24oYmxvY2ssIC8qb3B0aW9uYWwqL2Vycm9yLCAvKm9wdGlvbmFsKi9tZXNzYWdlKSB7XG4gIF90aHJvd3ModHJ1ZSwgYmxvY2ssIGVycm9yLCBtZXNzYWdlKTtcbn07XG5cbi8vIEVYVEVOU0lPTiEgVGhpcyBpcyBhbm5veWluZyB0byB3cml0ZSBvdXRzaWRlIHRoaXMgbW9kdWxlLlxuYXNzZXJ0LmRvZXNOb3RUaHJvdyA9IGZ1bmN0aW9uKGJsb2NrLCAvKm9wdGlvbmFsKi9lcnJvciwgLypvcHRpb25hbCovbWVzc2FnZSkge1xuICBfdGhyb3dzKGZhbHNlLCBibG9jaywgZXJyb3IsIG1lc3NhZ2UpO1xufTtcblxuYXNzZXJ0LmlmRXJyb3IgPSBmdW5jdGlvbihlcnIpIHsgaWYgKGVycikgdGhyb3cgZXJyOyB9O1xuXG52YXIgb2JqZWN0S2V5cyA9IE9iamVjdC5rZXlzIHx8IGZ1bmN0aW9uIChvYmopIHtcbiAgdmFyIGtleXMgPSBbXTtcbiAgZm9yICh2YXIga2V5IGluIG9iaikge1xuICAgIGlmIChoYXNPd24uY2FsbChvYmosIGtleSkpIGtleXMucHVzaChrZXkpO1xuICB9XG4gIHJldHVybiBrZXlzO1xufTtcbiIsIiIsIi8qXHJcblxyXG5UaGUgTUlUIExpY2Vuc2UgKE1JVClcclxuXHJcbk9yaWdpbmFsIExpYnJhcnkgXHJcbiAgLSBDb3B5cmlnaHQgKGMpIE1hcmFrIFNxdWlyZXNcclxuXHJcbkFkZGl0aW9uYWwgZnVuY3Rpb25hbGl0eVxyXG4gLSBDb3B5cmlnaHQgKGMpIFNpbmRyZSBTb3JodXMgPHNpbmRyZXNvcmh1c0BnbWFpbC5jb20+IChzaW5kcmVzb3JodXMuY29tKVxyXG5cclxuUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weVxyXG5vZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXHJcbmluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcclxudG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbFxyXG5jb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcclxuZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczpcclxuXHJcblRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXHJcbmFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxyXG5cclxuVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxyXG5JTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcclxuRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU4gTk8gRVZFTlQgU0hBTEwgVEhFXHJcbkFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVJcclxuTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcclxuT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxyXG5USEUgU09GVFdBUkUuXHJcblxyXG4qL1xyXG5cclxudmFyIGNvbG9ycyA9IHt9O1xyXG5tb2R1bGVbJ2V4cG9ydHMnXSA9IGNvbG9ycztcclxuXHJcbmNvbG9ycy50aGVtZXMgPSB7fTtcclxuXHJcbnZhciBhbnNpU3R5bGVzID0gY29sb3JzLnN0eWxlcyA9IHJlcXVpcmUoJy4vc3R5bGVzJyk7XHJcbnZhciBkZWZpbmVQcm9wcyA9IE9iamVjdC5kZWZpbmVQcm9wZXJ0aWVzO1xyXG5cclxuY29sb3JzLnN1cHBvcnRzQ29sb3IgPSByZXF1aXJlKCcuL3N5c3RlbS9zdXBwb3J0cy1jb2xvcnMnKS5zdXBwb3J0c0NvbG9yO1xyXG5cclxuaWYgKHR5cGVvZiBjb2xvcnMuZW5hYmxlZCA9PT0gXCJ1bmRlZmluZWRcIikge1xyXG4gIGNvbG9ycy5lbmFibGVkID0gY29sb3JzLnN1cHBvcnRzQ29sb3IoKSAhPT0gZmFsc2U7XHJcbn1cclxuXHJcbmNvbG9ycy5zdHJpcENvbG9ycyA9IGNvbG9ycy5zdHJpcCA9IGZ1bmN0aW9uKHN0cil7XHJcbiAgcmV0dXJuIChcIlwiICsgc3RyKS5yZXBsYWNlKC9cXHgxQlxcW1xcZCttL2csICcnKTtcclxufTtcclxuXHJcblxyXG52YXIgc3R5bGl6ZSA9IGNvbG9ycy5zdHlsaXplID0gZnVuY3Rpb24gc3R5bGl6ZSAoc3RyLCBzdHlsZSkge1xyXG4gIGlmICghY29sb3JzLmVuYWJsZWQpIHtcclxuICAgIHJldHVybiBzdHIrJyc7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gYW5zaVN0eWxlc1tzdHlsZV0ub3BlbiArIHN0ciArIGFuc2lTdHlsZXNbc3R5bGVdLmNsb3NlO1xyXG59XHJcblxyXG52YXIgbWF0Y2hPcGVyYXRvcnNSZSA9IC9bfFxcXFx7fSgpW1xcXV4kKyo/Ll0vZztcclxudmFyIGVzY2FwZVN0cmluZ1JlZ2V4cCA9IGZ1bmN0aW9uIChzdHIpIHtcclxuICBpZiAodHlwZW9mIHN0ciAhPT0gJ3N0cmluZycpIHtcclxuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0V4cGVjdGVkIGEgc3RyaW5nJyk7XHJcbiAgfVxyXG4gIHJldHVybiBzdHIucmVwbGFjZShtYXRjaE9wZXJhdG9yc1JlLCAgJ1xcXFwkJicpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBidWlsZChfc3R5bGVzKSB7XHJcbiAgdmFyIGJ1aWxkZXIgPSBmdW5jdGlvbiBidWlsZGVyKCkge1xyXG4gICAgcmV0dXJuIGFwcGx5U3R5bGUuYXBwbHkoYnVpbGRlciwgYXJndW1lbnRzKTtcclxuICB9O1xyXG4gIGJ1aWxkZXIuX3N0eWxlcyA9IF9zdHlsZXM7XHJcbiAgLy8gX19wcm90b19fIGlzIHVzZWQgYmVjYXVzZSB3ZSBtdXN0IHJldHVybiBhIGZ1bmN0aW9uLCBidXQgdGhlcmUgaXNcclxuICAvLyBubyB3YXkgdG8gY3JlYXRlIGEgZnVuY3Rpb24gd2l0aCBhIGRpZmZlcmVudCBwcm90b3R5cGUuXHJcbiAgYnVpbGRlci5fX3Byb3RvX18gPSBwcm90bztcclxuICByZXR1cm4gYnVpbGRlcjtcclxufVxyXG5cclxudmFyIHN0eWxlcyA9IChmdW5jdGlvbiAoKSB7XHJcbiAgdmFyIHJldCA9IHt9O1xyXG4gIGFuc2lTdHlsZXMuZ3JleSA9IGFuc2lTdHlsZXMuZ3JheTtcclxuICBPYmplY3Qua2V5cyhhbnNpU3R5bGVzKS5mb3JFYWNoKGZ1bmN0aW9uIChrZXkpIHtcclxuICAgIGFuc2lTdHlsZXNba2V5XS5jbG9zZVJlID0gbmV3IFJlZ0V4cChlc2NhcGVTdHJpbmdSZWdleHAoYW5zaVN0eWxlc1trZXldLmNsb3NlKSwgJ2cnKTtcclxuICAgIHJldFtrZXldID0ge1xyXG4gICAgICBnZXQ6IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICByZXR1cm4gYnVpbGQodGhpcy5fc3R5bGVzLmNvbmNhdChrZXkpKTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICB9KTtcclxuICByZXR1cm4gcmV0O1xyXG59KSgpO1xyXG5cclxudmFyIHByb3RvID0gZGVmaW5lUHJvcHMoZnVuY3Rpb24gY29sb3JzKCkge30sIHN0eWxlcyk7XHJcblxyXG5mdW5jdGlvbiBhcHBseVN0eWxlKCkge1xyXG4gIHZhciBhcmdzID0gYXJndW1lbnRzO1xyXG4gIHZhciBhcmdzTGVuID0gYXJncy5sZW5ndGg7XHJcbiAgdmFyIHN0ciA9IGFyZ3NMZW4gIT09IDAgJiYgU3RyaW5nKGFyZ3VtZW50c1swXSk7XHJcbiAgaWYgKGFyZ3NMZW4gPiAxKSB7XHJcbiAgICBmb3IgKHZhciBhID0gMTsgYSA8IGFyZ3NMZW47IGErKykge1xyXG4gICAgICBzdHIgKz0gJyAnICsgYXJnc1thXTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIGlmICghY29sb3JzLmVuYWJsZWQgfHwgIXN0cikge1xyXG4gICAgcmV0dXJuIHN0cjtcclxuICB9XHJcblxyXG4gIHZhciBuZXN0ZWRTdHlsZXMgPSB0aGlzLl9zdHlsZXM7XHJcblxyXG4gIHZhciBpID0gbmVzdGVkU3R5bGVzLmxlbmd0aDtcclxuICB3aGlsZSAoaS0tKSB7XHJcbiAgICB2YXIgY29kZSA9IGFuc2lTdHlsZXNbbmVzdGVkU3R5bGVzW2ldXTtcclxuICAgIHN0ciA9IGNvZGUub3BlbiArIHN0ci5yZXBsYWNlKGNvZGUuY2xvc2VSZSwgY29kZS5vcGVuKSArIGNvZGUuY2xvc2U7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gc3RyO1xyXG59XHJcblxyXG5jb2xvcnMuc2V0VGhlbWUgPSBmdW5jdGlvbiAodGhlbWUpIHtcclxuICBpZiAodHlwZW9mIHRoZW1lID09PSAnc3RyaW5nJykge1xyXG4gICAgY29uc29sZS5sb2coJ2NvbG9ycy5zZXRUaGVtZSBub3cgb25seSBhY2NlcHRzIGFuIG9iamVjdCwgbm90IGEgc3RyaW5nLiAgJyArXHJcbiAgICAgICdJZiB5b3UgYXJlIHRyeWluZyB0byBzZXQgYSB0aGVtZSBmcm9tIGEgZmlsZSwgaXQgaXMgbm93IHlvdXIgKHRoZSBjYWxsZXJcXCdzKSByZXNwb25zaWJpbGl0eSB0byByZXF1aXJlIHRoZSBmaWxlLiAgJyArXHJcbiAgICAgICdUaGUgb2xkIHN5bnRheCBsb29rZWQgbGlrZSBjb2xvcnMuc2V0VGhlbWUoX19kaXJuYW1lICsgXFwnLy4uL3RoZW1lcy9nZW5lcmljLWxvZ2dpbmcuanNcXCcpOyAnICtcclxuICAgICAgJ1RoZSBuZXcgc3ludGF4IGxvb2tzIGxpa2UgY29sb3JzLnNldFRoZW1lKHJlcXVpcmUoX19kaXJuYW1lICsgXFwnLy4uL3RoZW1lcy9nZW5lcmljLWxvZ2dpbmcuanNcXCcpKTsnKTtcclxuICAgIHJldHVybjtcclxuICB9XHJcbiAgZm9yICh2YXIgc3R5bGUgaW4gdGhlbWUpIHtcclxuICAgIChmdW5jdGlvbihzdHlsZSl7XHJcbiAgICAgIGNvbG9yc1tzdHlsZV0gPSBmdW5jdGlvbihzdHIpe1xyXG4gICAgICAgIGlmICh0eXBlb2YgdGhlbWVbc3R5bGVdID09PSAnb2JqZWN0Jyl7XHJcbiAgICAgICAgICB2YXIgb3V0ID0gc3RyO1xyXG4gICAgICAgICAgZm9yICh2YXIgaSBpbiB0aGVtZVtzdHlsZV0pe1xyXG4gICAgICAgICAgICBvdXQgPSBjb2xvcnNbdGhlbWVbc3R5bGVdW2ldXShvdXQpO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgICAgcmV0dXJuIG91dDtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIGNvbG9yc1t0aGVtZVtzdHlsZV1dKHN0cik7XHJcbiAgICAgIH07XHJcbiAgICB9KShzdHlsZSlcclxuICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluaXQoKSB7XHJcbiAgdmFyIHJldCA9IHt9O1xyXG4gIE9iamVjdC5rZXlzKHN0eWxlcykuZm9yRWFjaChmdW5jdGlvbiAobmFtZSkge1xyXG4gICAgcmV0W25hbWVdID0ge1xyXG4gICAgICBnZXQ6IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICByZXR1cm4gYnVpbGQoW25hbWVdKTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICB9KTtcclxuICByZXR1cm4gcmV0O1xyXG59XHJcblxyXG52YXIgc2VxdWVuY2VyID0gZnVuY3Rpb24gc2VxdWVuY2VyIChtYXAsIHN0cikge1xyXG4gIHZhciBleHBsb2RlZCA9IHN0ci5zcGxpdChcIlwiKSwgaSA9IDA7XHJcbiAgZXhwbG9kZWQgPSBleHBsb2RlZC5tYXAobWFwKTtcclxuICByZXR1cm4gZXhwbG9kZWQuam9pbihcIlwiKTtcclxufTtcclxuXHJcbi8vIGN1c3RvbSBmb3JtYXR0ZXIgbWV0aG9kc1xyXG5jb2xvcnMudHJhcCA9IHJlcXVpcmUoJy4vY3VzdG9tL3RyYXAnKTtcclxuY29sb3JzLnphbGdvID0gcmVxdWlyZSgnLi9jdXN0b20vemFsZ28nKTtcclxuXHJcbi8vIG1hcHNcclxuY29sb3JzLm1hcHMgPSB7fTtcclxuY29sb3JzLm1hcHMuYW1lcmljYSA9IHJlcXVpcmUoJy4vbWFwcy9hbWVyaWNhJyk7XHJcbmNvbG9ycy5tYXBzLnplYnJhID0gcmVxdWlyZSgnLi9tYXBzL3plYnJhJyk7XHJcbmNvbG9ycy5tYXBzLnJhaW5ib3cgPSByZXF1aXJlKCcuL21hcHMvcmFpbmJvdycpO1xyXG5jb2xvcnMubWFwcy5yYW5kb20gPSByZXF1aXJlKCcuL21hcHMvcmFuZG9tJylcclxuXHJcbmZvciAodmFyIG1hcCBpbiBjb2xvcnMubWFwcykge1xyXG4gIChmdW5jdGlvbihtYXApe1xyXG4gICAgY29sb3JzW21hcF0gPSBmdW5jdGlvbiAoc3RyKSB7XHJcbiAgICAgIHJldHVybiBzZXF1ZW5jZXIoY29sb3JzLm1hcHNbbWFwXSwgc3RyKTtcclxuICAgIH1cclxuICB9KShtYXApXHJcbn1cclxuXHJcbmRlZmluZVByb3BzKGNvbG9ycywgaW5pdCgpKTtcclxuIiwibW9kdWxlWydleHBvcnRzJ10gPSBmdW5jdGlvbiBydW5UaGVUcmFwICh0ZXh0LCBvcHRpb25zKSB7XHJcbiAgdmFyIHJlc3VsdCA9IFwiXCI7XHJcbiAgdGV4dCA9IHRleHQgfHwgXCJSdW4gdGhlIHRyYXAsIGRyb3AgdGhlIGJhc3NcIjtcclxuICB0ZXh0ID0gdGV4dC5zcGxpdCgnJyk7XHJcbiAgdmFyIHRyYXAgPSB7XHJcbiAgICBhOiBbXCJcXHUwMDQwXCIsIFwiXFx1MDEwNFwiLCBcIlxcdTAyM2FcIiwgXCJcXHUwMjQ1XCIsIFwiXFx1MDM5NFwiLCBcIlxcdTAzOWJcIiwgXCJcXHUwNDE0XCJdLFxyXG4gICAgYjogW1wiXFx1MDBkZlwiLCBcIlxcdTAxODFcIiwgXCJcXHUwMjQzXCIsIFwiXFx1MDI2ZVwiLCBcIlxcdTAzYjJcIiwgXCJcXHUwZTNmXCJdLFxyXG4gICAgYzogW1wiXFx1MDBhOVwiLCBcIlxcdTAyM2JcIiwgXCJcXHUwM2ZlXCJdLFxyXG4gICAgZDogW1wiXFx1MDBkMFwiLCBcIlxcdTAxOGFcIiwgXCJcXHUwNTAwXCIgLCBcIlxcdTA1MDFcIiAsXCJcXHUwNTAyXCIsIFwiXFx1MDUwM1wiXSxcclxuICAgIGU6IFtcIlxcdTAwY2JcIiwgXCJcXHUwMTE1XCIsIFwiXFx1MDE4ZVwiLCBcIlxcdTAyNThcIiwgXCJcXHUwM2EzXCIsIFwiXFx1MDNiZVwiLCBcIlxcdTA0YmNcIiwgXCJcXHUwYTZjXCJdLFxyXG4gICAgZjogW1wiXFx1MDRmYVwiXSxcclxuICAgIGc6IFtcIlxcdTAyNjJcIl0sXHJcbiAgICBoOiBbXCJcXHUwMTI2XCIsIFwiXFx1MDE5NVwiLCBcIlxcdTA0YTJcIiwgXCJcXHUwNGJhXCIsIFwiXFx1MDRjN1wiLCBcIlxcdTA1MGFcIl0sXHJcbiAgICBpOiBbXCJcXHUwZjBmXCJdLFxyXG4gICAgajogW1wiXFx1MDEzNFwiXSxcclxuICAgIGs6IFtcIlxcdTAxMzhcIiwgXCJcXHUwNGEwXCIsIFwiXFx1MDRjM1wiLCBcIlxcdTA1MWVcIl0sXHJcbiAgICBsOiBbXCJcXHUwMTM5XCJdLFxyXG4gICAgbTogW1wiXFx1MDI4ZFwiLCBcIlxcdTA0Y2RcIiwgXCJcXHUwNGNlXCIsIFwiXFx1MDUyMFwiLCBcIlxcdTA1MjFcIiwgXCJcXHUwZDY5XCJdLFxyXG4gICAgbjogW1wiXFx1MDBkMVwiLCBcIlxcdTAxNGJcIiwgXCJcXHUwMTlkXCIsIFwiXFx1MDM3NlwiLCBcIlxcdTAzYTBcIiwgXCJcXHUwNDhhXCJdLFxyXG4gICAgbzogW1wiXFx1MDBkOFwiLCBcIlxcdTAwZjVcIiwgXCJcXHUwMGY4XCIsIFwiXFx1MDFmZVwiLCBcIlxcdTAyOThcIiwgXCJcXHUwNDdhXCIsIFwiXFx1MDVkZFwiLCBcIlxcdTA2ZGRcIiwgXCJcXHUwZTRmXCJdLFxyXG4gICAgcDogW1wiXFx1MDFmN1wiLCBcIlxcdTA0OGVcIl0sXHJcbiAgICBxOiBbXCJcXHUwOWNkXCJdLFxyXG4gICAgcjogW1wiXFx1MDBhZVwiLCBcIlxcdTAxYTZcIiwgXCJcXHUwMjEwXCIsIFwiXFx1MDI0Y1wiLCBcIlxcdTAyODBcIiwgXCJcXHUwNDJmXCJdLFxyXG4gICAgczogW1wiXFx1MDBhN1wiLCBcIlxcdTAzZGVcIiwgXCJcXHUwM2RmXCIsIFwiXFx1MDNlOFwiXSxcclxuICAgIHQ6IFtcIlxcdTAxNDFcIiwgXCJcXHUwMTY2XCIsIFwiXFx1MDM3M1wiXSxcclxuICAgIHU6IFtcIlxcdTAxYjFcIiwgXCJcXHUwNTRkXCJdLFxyXG4gICAgdjogW1wiXFx1MDVkOFwiXSxcclxuICAgIHc6IFtcIlxcdTA0MjhcIiwgXCJcXHUwNDYwXCIsIFwiXFx1MDQ3Y1wiLCBcIlxcdTBkNzBcIl0sXHJcbiAgICB4OiBbXCJcXHUwNGIyXCIsIFwiXFx1MDRmZVwiLCBcIlxcdTA0ZmNcIiwgXCJcXHUwNGZkXCJdLFxyXG4gICAgeTogW1wiXFx1MDBhNVwiLCBcIlxcdTA0YjBcIiwgXCJcXHUwNGNiXCJdLFxyXG4gICAgejogW1wiXFx1MDFiNVwiLCBcIlxcdTAyNDBcIl1cclxuICB9XHJcbiAgdGV4dC5mb3JFYWNoKGZ1bmN0aW9uKGMpe1xyXG4gICAgYyA9IGMudG9Mb3dlckNhc2UoKTtcclxuICAgIHZhciBjaGFycyA9IHRyYXBbY10gfHwgW1wiIFwiXTtcclxuICAgIHZhciByYW5kID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogY2hhcnMubGVuZ3RoKTtcclxuICAgIGlmICh0eXBlb2YgdHJhcFtjXSAhPT0gXCJ1bmRlZmluZWRcIikge1xyXG4gICAgICByZXN1bHQgKz0gdHJhcFtjXVtyYW5kXTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHJlc3VsdCArPSBjO1xyXG4gICAgfVxyXG4gIH0pO1xyXG4gIHJldHVybiByZXN1bHQ7XHJcblxyXG59XHJcbiIsIi8vIHBsZWFzZSBub1xyXG5tb2R1bGVbJ2V4cG9ydHMnXSA9IGZ1bmN0aW9uIHphbGdvKHRleHQsIG9wdGlvbnMpIHtcclxuICB0ZXh0ID0gdGV4dCB8fCBcIiAgIGhlIGlzIGhlcmUgICBcIjtcclxuICB2YXIgc291bCA9IHtcclxuICAgIFwidXBcIiA6IFtcclxuICAgICAgJ8yNJywgJ8yOJywgJ8yEJywgJ8yFJyxcclxuICAgICAgJ8y/JywgJ8yRJywgJ8yGJywgJ8yQJyxcclxuICAgICAgJ82SJywgJ82XJywgJ82RJywgJ8yHJyxcclxuICAgICAgJ8yIJywgJ8yKJywgJ82CJywgJ8yTJyxcclxuICAgICAgJ8yIJywgJ82KJywgJ82LJywgJ82MJyxcclxuICAgICAgJ8yDJywgJ8yCJywgJ8yMJywgJ82QJyxcclxuICAgICAgJ8yAJywgJ8yBJywgJ8yLJywgJ8yPJyxcclxuICAgICAgJ8ySJywgJ8yTJywgJ8yUJywgJ8y9JyxcclxuICAgICAgJ8yJJywgJ82jJywgJ82kJywgJ82lJyxcclxuICAgICAgJ82mJywgJ82nJywgJ82oJywgJ82pJyxcclxuICAgICAgJ82qJywgJ82rJywgJ82sJywgJ82tJyxcclxuICAgICAgJ82uJywgJ82vJywgJ8y+JywgJ82bJyxcclxuICAgICAgJ82GJywgJ8yaJ1xyXG4gICAgXSxcclxuICAgIFwiZG93blwiIDogW1xyXG4gICAgICAnzJYnLCAnzJcnLCAnzJgnLCAnzJknLFxyXG4gICAgICAnzJwnLCAnzJ0nLCAnzJ4nLCAnzJ8nLFxyXG4gICAgICAnzKAnLCAnzKQnLCAnzKUnLCAnzKYnLFxyXG4gICAgICAnzKknLCAnzKonLCAnzKsnLCAnzKwnLFxyXG4gICAgICAnzK0nLCAnzK4nLCAnzK8nLCAnzLAnLFxyXG4gICAgICAnzLEnLCAnzLInLCAnzLMnLCAnzLknLFxyXG4gICAgICAnzLonLCAnzLsnLCAnzLwnLCAnzYUnLFxyXG4gICAgICAnzYcnLCAnzYgnLCAnzYknLCAnzY0nLFxyXG4gICAgICAnzY4nLCAnzZMnLCAnzZQnLCAnzZUnLFxyXG4gICAgICAnzZYnLCAnzZknLCAnzZonLCAnzKMnXHJcbiAgICBdLFxyXG4gICAgXCJtaWRcIiA6IFtcclxuICAgICAgJ8yVJywgJ8ybJywgJ8yAJywgJ8yBJyxcclxuICAgICAgJ82YJywgJ8yhJywgJ8yiJywgJ8ynJyxcclxuICAgICAgJ8yoJywgJ8y0JywgJ8y1JywgJ8y2JyxcclxuICAgICAgJ82cJywgJ82dJywgJ82eJyxcclxuICAgICAgJ82fJywgJ82gJywgJ82iJywgJ8y4JyxcclxuICAgICAgJ8y3JywgJ82hJywgJyDSiSdcclxuICAgIF1cclxuICB9LFxyXG4gIGFsbCA9IFtdLmNvbmNhdChzb3VsLnVwLCBzb3VsLmRvd24sIHNvdWwubWlkKSxcclxuICB6YWxnbyA9IHt9O1xyXG5cclxuICBmdW5jdGlvbiByYW5kb21OdW1iZXIocmFuZ2UpIHtcclxuICAgIHZhciByID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogcmFuZ2UpO1xyXG4gICAgcmV0dXJuIHI7XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBpc19jaGFyKGNoYXJhY3Rlcikge1xyXG4gICAgdmFyIGJvb2wgPSBmYWxzZTtcclxuICAgIGFsbC5maWx0ZXIoZnVuY3Rpb24gKGkpIHtcclxuICAgICAgYm9vbCA9IChpID09PSBjaGFyYWN0ZXIpO1xyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gYm9vbDtcclxuICB9XHJcbiAgXHJcblxyXG4gIGZ1bmN0aW9uIGhlQ29tZXModGV4dCwgb3B0aW9ucykge1xyXG4gICAgdmFyIHJlc3VsdCA9ICcnLCBjb3VudHMsIGw7XHJcbiAgICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcclxuICAgIG9wdGlvbnNbXCJ1cFwiXSA9ICAgdHlwZW9mIG9wdGlvbnNbXCJ1cFwiXSAgICE9PSAndW5kZWZpbmVkJyA/IG9wdGlvbnNbXCJ1cFwiXSAgIDogdHJ1ZTtcclxuICAgIG9wdGlvbnNbXCJtaWRcIl0gPSAgdHlwZW9mIG9wdGlvbnNbXCJtaWRcIl0gICE9PSAndW5kZWZpbmVkJyA/IG9wdGlvbnNbXCJtaWRcIl0gIDogdHJ1ZTtcclxuICAgIG9wdGlvbnNbXCJkb3duXCJdID0gdHlwZW9mIG9wdGlvbnNbXCJkb3duXCJdICE9PSAndW5kZWZpbmVkJyA/IG9wdGlvbnNbXCJkb3duXCJdIDogdHJ1ZTtcclxuICAgIG9wdGlvbnNbXCJzaXplXCJdID0gdHlwZW9mIG9wdGlvbnNbXCJzaXplXCJdICE9PSAndW5kZWZpbmVkJyA/IG9wdGlvbnNbXCJzaXplXCJdIDogXCJtYXhpXCI7XHJcbiAgICB0ZXh0ID0gdGV4dC5zcGxpdCgnJyk7XHJcbiAgICBmb3IgKGwgaW4gdGV4dCkge1xyXG4gICAgICBpZiAoaXNfY2hhcihsKSkge1xyXG4gICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICB9XHJcbiAgICAgIHJlc3VsdCA9IHJlc3VsdCArIHRleHRbbF07XHJcbiAgICAgIGNvdW50cyA9IHtcInVwXCIgOiAwLCBcImRvd25cIiA6IDAsIFwibWlkXCIgOiAwfTtcclxuICAgICAgc3dpdGNoIChvcHRpb25zLnNpemUpIHtcclxuICAgICAgY2FzZSAnbWluaSc6XHJcbiAgICAgICAgY291bnRzLnVwID0gcmFuZG9tTnVtYmVyKDgpO1xyXG4gICAgICAgIGNvdW50cy5taWQgPSByYW5kb21OdW1iZXIoMik7XHJcbiAgICAgICAgY291bnRzLmRvd24gPSByYW5kb21OdW1iZXIoOCk7XHJcbiAgICAgICAgYnJlYWs7XHJcbiAgICAgIGNhc2UgJ21heGknOlxyXG4gICAgICAgIGNvdW50cy51cCA9IHJhbmRvbU51bWJlcigxNikgKyAzO1xyXG4gICAgICAgIGNvdW50cy5taWQgPSByYW5kb21OdW1iZXIoNCkgKyAxO1xyXG4gICAgICAgIGNvdW50cy5kb3duID0gcmFuZG9tTnVtYmVyKDY0KSArIDM7XHJcbiAgICAgICAgYnJlYWs7XHJcbiAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgY291bnRzLnVwID0gcmFuZG9tTnVtYmVyKDgpICsgMTtcclxuICAgICAgICBjb3VudHMubWlkID0gcmFuZG9tTnVtYmVyKDYpIC8gMjtcclxuICAgICAgICBjb3VudHMuZG93biA9IHJhbmRvbU51bWJlcig4KSArIDE7XHJcbiAgICAgICAgYnJlYWs7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIHZhciBhcnIgPSBbXCJ1cFwiLCBcIm1pZFwiLCBcImRvd25cIl07XHJcbiAgICAgIGZvciAodmFyIGQgaW4gYXJyKSB7XHJcbiAgICAgICAgdmFyIGluZGV4ID0gYXJyW2RdO1xyXG4gICAgICAgIGZvciAodmFyIGkgPSAwIDsgaSA8PSBjb3VudHNbaW5kZXhdOyBpKyspIHtcclxuICAgICAgICAgIGlmIChvcHRpb25zW2luZGV4XSkge1xyXG4gICAgICAgICAgICByZXN1bHQgPSByZXN1bHQgKyBzb3VsW2luZGV4XVtyYW5kb21OdW1iZXIoc291bFtpbmRleF0ubGVuZ3RoKV07XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG4gIH1cclxuICAvLyBkb24ndCBzdW1tb24gaGltXHJcbiAgcmV0dXJuIGhlQ29tZXModGV4dCwgb3B0aW9ucyk7XHJcbn1cclxuIiwidmFyIGNvbG9ycyA9IHJlcXVpcmUoJy4vY29sb3JzJyk7XHJcblxyXG5tb2R1bGVbJ2V4cG9ydHMnXSA9IGZ1bmN0aW9uICgpIHtcclxuXHJcbiAgLy9cclxuICAvLyBFeHRlbmRzIHByb3RvdHlwZSBvZiBuYXRpdmUgc3RyaW5nIG9iamVjdCB0byBhbGxvdyBmb3IgXCJmb29cIi5yZWQgc3ludGF4XHJcbiAgLy9cclxuICB2YXIgYWRkUHJvcGVydHkgPSBmdW5jdGlvbiAoY29sb3IsIGZ1bmMpIHtcclxuICAgIFN0cmluZy5wcm90b3R5cGUuX19kZWZpbmVHZXR0ZXJfXyhjb2xvciwgZnVuYyk7XHJcbiAgfTtcclxuXHJcbiAgdmFyIHNlcXVlbmNlciA9IGZ1bmN0aW9uIHNlcXVlbmNlciAobWFwLCBzdHIpIHtcclxuICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcclxuICAgICAgICB2YXIgZXhwbG9kZWQgPSB0aGlzLnNwbGl0KFwiXCIpLCBpID0gMDtcclxuICAgICAgICBleHBsb2RlZCA9IGV4cGxvZGVkLm1hcChtYXApO1xyXG4gICAgICAgIHJldHVybiBleHBsb2RlZC5qb2luKFwiXCIpO1xyXG4gICAgICB9XHJcbiAgfTtcclxuXHJcbiAgYWRkUHJvcGVydHkoJ3N0cmlwJywgZnVuY3Rpb24gKCkge1xyXG4gICAgcmV0dXJuIGNvbG9ycy5zdHJpcCh0aGlzKTtcclxuICB9KTtcclxuXHJcbiAgYWRkUHJvcGVydHkoJ3N0cmlwQ29sb3JzJywgZnVuY3Rpb24gKCkge1xyXG4gICAgcmV0dXJuIGNvbG9ycy5zdHJpcCh0aGlzKTtcclxuICB9KTtcclxuXHJcbiAgYWRkUHJvcGVydHkoXCJ0cmFwXCIsIGZ1bmN0aW9uKCl7XHJcbiAgICByZXR1cm4gY29sb3JzLnRyYXAodGhpcyk7XHJcbiAgfSk7XHJcblxyXG4gIGFkZFByb3BlcnR5KFwiemFsZ29cIiwgZnVuY3Rpb24oKXtcclxuICAgIHJldHVybiBjb2xvcnMuemFsZ28odGhpcyk7XHJcbiAgfSk7XHJcblxyXG4gIGFkZFByb3BlcnR5KFwiemVicmFcIiwgZnVuY3Rpb24oKXtcclxuICAgIHJldHVybiBjb2xvcnMuemVicmEodGhpcyk7XHJcbiAgfSk7XHJcblxyXG4gIGFkZFByb3BlcnR5KFwicmFpbmJvd1wiLCBmdW5jdGlvbigpe1xyXG4gICAgcmV0dXJuIGNvbG9ycy5yYWluYm93KHRoaXMpO1xyXG4gIH0pO1xyXG5cclxuICBhZGRQcm9wZXJ0eShcInJhbmRvbVwiLCBmdW5jdGlvbigpe1xyXG4gICAgcmV0dXJuIGNvbG9ycy5yYW5kb20odGhpcyk7XHJcbiAgfSk7XHJcblxyXG4gIGFkZFByb3BlcnR5KFwiYW1lcmljYVwiLCBmdW5jdGlvbigpe1xyXG4gICAgcmV0dXJuIGNvbG9ycy5hbWVyaWNhKHRoaXMpO1xyXG4gIH0pO1xyXG5cclxuICAvL1xyXG4gIC8vIEl0ZXJhdGUgdGhyb3VnaCBhbGwgZGVmYXVsdCBzdHlsZXMgYW5kIGNvbG9yc1xyXG4gIC8vXHJcbiAgdmFyIHggPSBPYmplY3Qua2V5cyhjb2xvcnMuc3R5bGVzKTtcclxuICB4LmZvckVhY2goZnVuY3Rpb24gKHN0eWxlKSB7XHJcbiAgICBhZGRQcm9wZXJ0eShzdHlsZSwgZnVuY3Rpb24gKCkge1xyXG4gICAgICByZXR1cm4gY29sb3JzLnN0eWxpemUodGhpcywgc3R5bGUpO1xyXG4gICAgfSk7XHJcbiAgfSk7XHJcblxyXG4gIGZ1bmN0aW9uIGFwcGx5VGhlbWUodGhlbWUpIHtcclxuICAgIC8vXHJcbiAgICAvLyBSZW1hcms6IFRoaXMgaXMgYSBsaXN0IG9mIG1ldGhvZHMgdGhhdCBleGlzdFxyXG4gICAgLy8gb24gU3RyaW5nIHRoYXQgeW91IHNob3VsZCBub3Qgb3ZlcndyaXRlLlxyXG4gICAgLy9cclxuICAgIHZhciBzdHJpbmdQcm90b3R5cGVCbGFja2xpc3QgPSBbXHJcbiAgICAgICdfX2RlZmluZUdldHRlcl9fJywgJ19fZGVmaW5lU2V0dGVyX18nLCAnX19sb29rdXBHZXR0ZXJfXycsICdfX2xvb2t1cFNldHRlcl9fJywgJ2NoYXJBdCcsICdjb25zdHJ1Y3RvcicsXHJcbiAgICAgICdoYXNPd25Qcm9wZXJ0eScsICdpc1Byb3RvdHlwZU9mJywgJ3Byb3BlcnR5SXNFbnVtZXJhYmxlJywgJ3RvTG9jYWxlU3RyaW5nJywgJ3RvU3RyaW5nJywgJ3ZhbHVlT2YnLCAnY2hhckNvZGVBdCcsXHJcbiAgICAgICdpbmRleE9mJywgJ2xhc3RJbmRleG9mJywgJ2xlbmd0aCcsICdsb2NhbGVDb21wYXJlJywgJ21hdGNoJywgJ3JlcGVhdCcsICdyZXBsYWNlJywgJ3NlYXJjaCcsICdzbGljZScsICdzcGxpdCcsICdzdWJzdHJpbmcnLFxyXG4gICAgICAndG9Mb2NhbGVMb3dlckNhc2UnLCAndG9Mb2NhbGVVcHBlckNhc2UnLCAndG9Mb3dlckNhc2UnLCAndG9VcHBlckNhc2UnLCAndHJpbScsICd0cmltTGVmdCcsICd0cmltUmlnaHQnXHJcbiAgICBdO1xyXG5cclxuICAgIE9iamVjdC5rZXlzKHRoZW1lKS5mb3JFYWNoKGZ1bmN0aW9uIChwcm9wKSB7XHJcbiAgICAgIGlmIChzdHJpbmdQcm90b3R5cGVCbGFja2xpc3QuaW5kZXhPZihwcm9wKSAhPT0gLTEpIHtcclxuICAgICAgICBjb25zb2xlLmxvZygnd2FybjogJy5yZWQgKyAoJ1N0cmluZy5wcm90b3R5cGUnICsgcHJvcCkubWFnZW50YSArICcgaXMgcHJvYmFibHkgc29tZXRoaW5nIHlvdSBkb25cXCd0IHdhbnQgdG8gb3ZlcnJpZGUuIElnbm9yaW5nIHN0eWxlIG5hbWUnKTtcclxuICAgICAgfVxyXG4gICAgICBlbHNlIHtcclxuICAgICAgICBpZiAodHlwZW9mKHRoZW1lW3Byb3BdKSA9PT0gJ3N0cmluZycpIHtcclxuICAgICAgICAgIGNvbG9yc1twcm9wXSA9IGNvbG9yc1t0aGVtZVtwcm9wXV07XHJcbiAgICAgICAgICBhZGRQcm9wZXJ0eShwcm9wLCBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjb2xvcnNbdGhlbWVbcHJvcF1dKHRoaXMpO1xyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgYWRkUHJvcGVydHkocHJvcCwgZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICB2YXIgcmV0ID0gdGhpcztcclxuICAgICAgICAgICAgZm9yICh2YXIgdCA9IDA7IHQgPCB0aGVtZVtwcm9wXS5sZW5ndGg7IHQrKykge1xyXG4gICAgICAgICAgICAgIHJldCA9IGNvbG9yc1t0aGVtZVtwcm9wXVt0XV0ocmV0KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gcmV0O1xyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIGNvbG9ycy5zZXRUaGVtZSA9IGZ1bmN0aW9uICh0aGVtZSkge1xyXG4gICAgaWYgKHR5cGVvZiB0aGVtZSA9PT0gJ3N0cmluZycpIHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb2xvcnMudGhlbWVzW3RoZW1lXSA9IHJlcXVpcmUodGhlbWUpO1xyXG4gICAgICAgIGFwcGx5VGhlbWUoY29sb3JzLnRoZW1lc1t0aGVtZV0pO1xyXG4gICAgICAgIHJldHVybiBjb2xvcnMudGhlbWVzW3RoZW1lXTtcclxuICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgY29uc29sZS5sb2coZXJyKTtcclxuICAgICAgICByZXR1cm4gZXJyO1xyXG4gICAgICB9XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBhcHBseVRoZW1lKHRoZW1lKTtcclxuICAgIH1cclxuICB9O1xyXG5cclxufTtcclxuIiwidmFyIGNvbG9ycyA9IHJlcXVpcmUoJy4vY29sb3JzJyk7XHJcbm1vZHVsZVsnZXhwb3J0cyddID0gY29sb3JzO1xyXG5cclxuLy8gUmVtYXJrOiBCeSBkZWZhdWx0LCBjb2xvcnMgd2lsbCBhZGQgc3R5bGUgcHJvcGVydGllcyB0byBTdHJpbmcucHJvdG90eXBlXHJcbi8vXHJcbi8vIElmIHlvdSBkb24ndCB3aXNoIHRvIGV4dGVuZCBTdHJpbmcucHJvdG90eXBlIHlvdSBjYW4gZG8gdGhpcyBpbnN0ZWFkIGFuZCBuYXRpdmUgU3RyaW5nIHdpbGwgbm90IGJlIHRvdWNoZWRcclxuLy9cclxuLy8gICB2YXIgY29sb3JzID0gcmVxdWlyZSgnY29sb3JzL3NhZmUpO1xyXG4vLyAgIGNvbG9ycy5yZWQoXCJmb29cIilcclxuLy9cclxuLy9cclxucmVxdWlyZSgnLi9leHRlbmRTdHJpbmdQcm90b3R5cGUnKSgpOyIsInZhciBjb2xvcnMgPSByZXF1aXJlKCcuLi9jb2xvcnMnKTtcclxuXHJcbm1vZHVsZVsnZXhwb3J0cyddID0gKGZ1bmN0aW9uKCkge1xyXG4gIHJldHVybiBmdW5jdGlvbiAobGV0dGVyLCBpLCBleHBsb2RlZCkge1xyXG4gICAgaWYobGV0dGVyID09PSBcIiBcIikgcmV0dXJuIGxldHRlcjtcclxuICAgIHN3aXRjaChpJTMpIHtcclxuICAgICAgY2FzZSAwOiByZXR1cm4gY29sb3JzLnJlZChsZXR0ZXIpO1xyXG4gICAgICBjYXNlIDE6IHJldHVybiBjb2xvcnMud2hpdGUobGV0dGVyKVxyXG4gICAgICBjYXNlIDI6IHJldHVybiBjb2xvcnMuYmx1ZShsZXR0ZXIpXHJcbiAgICB9XHJcbiAgfVxyXG59KSgpOyIsInZhciBjb2xvcnMgPSByZXF1aXJlKCcuLi9jb2xvcnMnKTtcclxuXHJcbm1vZHVsZVsnZXhwb3J0cyddID0gKGZ1bmN0aW9uICgpIHtcclxuICB2YXIgcmFpbmJvd0NvbG9ycyA9IFsncmVkJywgJ3llbGxvdycsICdncmVlbicsICdibHVlJywgJ21hZ2VudGEnXTsgLy9Sb1kgRyBCaVZcclxuICByZXR1cm4gZnVuY3Rpb24gKGxldHRlciwgaSwgZXhwbG9kZWQpIHtcclxuICAgIGlmIChsZXR0ZXIgPT09IFwiIFwiKSB7XHJcbiAgICAgIHJldHVybiBsZXR0ZXI7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICByZXR1cm4gY29sb3JzW3JhaW5ib3dDb2xvcnNbaSsrICUgcmFpbmJvd0NvbG9ycy5sZW5ndGhdXShsZXR0ZXIpO1xyXG4gICAgfVxyXG4gIH07XHJcbn0pKCk7XHJcblxyXG4iLCJ2YXIgY29sb3JzID0gcmVxdWlyZSgnLi4vY29sb3JzJyk7XHJcblxyXG5tb2R1bGVbJ2V4cG9ydHMnXSA9IChmdW5jdGlvbiAoKSB7XHJcbiAgdmFyIGF2YWlsYWJsZSA9IFsndW5kZXJsaW5lJywgJ2ludmVyc2UnLCAnZ3JleScsICd5ZWxsb3cnLCAncmVkJywgJ2dyZWVuJywgJ2JsdWUnLCAnd2hpdGUnLCAnY3lhbicsICdtYWdlbnRhJ107XHJcbiAgcmV0dXJuIGZ1bmN0aW9uKGxldHRlciwgaSwgZXhwbG9kZWQpIHtcclxuICAgIHJldHVybiBsZXR0ZXIgPT09IFwiIFwiID8gbGV0dGVyIDogY29sb3JzW2F2YWlsYWJsZVtNYXRoLnJvdW5kKE1hdGgucmFuZG9tKCkgKiAoYXZhaWxhYmxlLmxlbmd0aCAtIDEpKV1dKGxldHRlcik7XHJcbiAgfTtcclxufSkoKTsiLCJ2YXIgY29sb3JzID0gcmVxdWlyZSgnLi4vY29sb3JzJyk7XHJcblxyXG5tb2R1bGVbJ2V4cG9ydHMnXSA9IGZ1bmN0aW9uIChsZXR0ZXIsIGksIGV4cGxvZGVkKSB7XHJcbiAgcmV0dXJuIGkgJSAyID09PSAwID8gbGV0dGVyIDogY29sb3JzLmludmVyc2UobGV0dGVyKTtcclxufTsiLCIvKlxyXG5UaGUgTUlUIExpY2Vuc2UgKE1JVClcclxuXHJcbkNvcHlyaWdodCAoYykgU2luZHJlIFNvcmh1cyA8c2luZHJlc29yaHVzQGdtYWlsLmNvbT4gKHNpbmRyZXNvcmh1cy5jb20pXHJcblxyXG5QZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XHJcbm9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcclxuaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0c1xyXG50byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsXHJcbmNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xyXG5mdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOlxyXG5cclxuVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW5cclxuYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXHJcblxyXG5USEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SXHJcbklNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLFxyXG5GSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcclxuQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUlxyXG5MSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxyXG5PVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOXHJcblRIRSBTT0ZUV0FSRS5cclxuXHJcbiovXHJcblxyXG52YXIgc3R5bGVzID0ge307XHJcbm1vZHVsZVsnZXhwb3J0cyddID0gc3R5bGVzO1xyXG5cclxudmFyIGNvZGVzID0ge1xyXG4gIHJlc2V0OiBbMCwgMF0sXHJcblxyXG4gIGJvbGQ6IFsxLCAyMl0sXHJcbiAgZGltOiBbMiwgMjJdLFxyXG4gIGl0YWxpYzogWzMsIDIzXSxcclxuICB1bmRlcmxpbmU6IFs0LCAyNF0sXHJcbiAgaW52ZXJzZTogWzcsIDI3XSxcclxuICBoaWRkZW46IFs4LCAyOF0sXHJcbiAgc3RyaWtldGhyb3VnaDogWzksIDI5XSxcclxuXHJcbiAgYmxhY2s6IFszMCwgMzldLFxyXG4gIHJlZDogWzMxLCAzOV0sXHJcbiAgZ3JlZW46IFszMiwgMzldLFxyXG4gIHllbGxvdzogWzMzLCAzOV0sXHJcbiAgYmx1ZTogWzM0LCAzOV0sXHJcbiAgbWFnZW50YTogWzM1LCAzOV0sXHJcbiAgY3lhbjogWzM2LCAzOV0sXHJcbiAgd2hpdGU6IFszNywgMzldLFxyXG4gIGdyYXk6IFs5MCwgMzldLFxyXG4gIGdyZXk6IFs5MCwgMzldLFxyXG5cclxuICBiZ0JsYWNrOiBbNDAsIDQ5XSxcclxuICBiZ1JlZDogWzQxLCA0OV0sXHJcbiAgYmdHcmVlbjogWzQyLCA0OV0sXHJcbiAgYmdZZWxsb3c6IFs0MywgNDldLFxyXG4gIGJnQmx1ZTogWzQ0LCA0OV0sXHJcbiAgYmdNYWdlbnRhOiBbNDUsIDQ5XSxcclxuICBiZ0N5YW46IFs0NiwgNDldLFxyXG4gIGJnV2hpdGU6IFs0NywgNDldLFxyXG5cclxuICAvLyBsZWdhY3kgc3R5bGVzIGZvciBjb2xvcnMgcHJlIHYxLjAuMFxyXG4gIGJsYWNrQkc6IFs0MCwgNDldLFxyXG4gIHJlZEJHOiBbNDEsIDQ5XSxcclxuICBncmVlbkJHOiBbNDIsIDQ5XSxcclxuICB5ZWxsb3dCRzogWzQzLCA0OV0sXHJcbiAgYmx1ZUJHOiBbNDQsIDQ5XSxcclxuICBtYWdlbnRhQkc6IFs0NSwgNDldLFxyXG4gIGN5YW5CRzogWzQ2LCA0OV0sXHJcbiAgd2hpdGVCRzogWzQ3LCA0OV1cclxuXHJcbn07XHJcblxyXG5PYmplY3Qua2V5cyhjb2RlcykuZm9yRWFjaChmdW5jdGlvbiAoa2V5KSB7XHJcbiAgdmFyIHZhbCA9IGNvZGVzW2tleV07XHJcbiAgdmFyIHN0eWxlID0gc3R5bGVzW2tleV0gPSBbXTtcclxuICBzdHlsZS5vcGVuID0gJ1xcdTAwMWJbJyArIHZhbFswXSArICdtJztcclxuICBzdHlsZS5jbG9zZSA9ICdcXHUwMDFiWycgKyB2YWxbMV0gKyAnbSc7XHJcbn0pOyIsIi8qXHJcbk1JVCBMaWNlbnNlXHJcblxyXG5Db3B5cmlnaHQgKGMpIFNpbmRyZSBTb3JodXMgPHNpbmRyZXNvcmh1c0BnbWFpbC5jb20+IChzaW5kcmVzb3JodXMuY29tKVxyXG5cclxuUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczpcclxuXHJcblRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxyXG5cclxuVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU4gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXHJcbiovXHJcblxyXG4ndXNlIHN0cmljdCc7XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChmbGFnLCBhcmd2KSB7XHJcblx0YXJndiA9IGFyZ3YgfHwgcHJvY2Vzcy5hcmd2O1xyXG5cclxuXHR2YXIgdGVybWluYXRvclBvcyA9IGFyZ3YuaW5kZXhPZignLS0nKTtcclxuXHR2YXIgcHJlZml4ID0gL14tezEsMn0vLnRlc3QoZmxhZykgPyAnJyA6ICctLSc7XHJcblx0dmFyIHBvcyA9IGFyZ3YuaW5kZXhPZihwcmVmaXggKyBmbGFnKTtcclxuXHJcblx0cmV0dXJuIHBvcyAhPT0gLTEgJiYgKHRlcm1pbmF0b3JQb3MgPT09IC0xID8gdHJ1ZSA6IHBvcyA8IHRlcm1pbmF0b3JQb3MpO1xyXG59O1xyXG4iLCIvKlxyXG5UaGUgTUlUIExpY2Vuc2UgKE1JVClcclxuXHJcbkNvcHlyaWdodCAoYykgU2luZHJlIFNvcmh1cyA8c2luZHJlc29yaHVzQGdtYWlsLmNvbT4gKHNpbmRyZXNvcmh1cy5jb20pXHJcblxyXG5QZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XHJcbm9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcclxuaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0c1xyXG50byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsXHJcbmNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xyXG5mdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOlxyXG5cclxuVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW5cclxuYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXHJcblxyXG5USEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SXHJcbklNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLFxyXG5GSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcclxuQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUlxyXG5MSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxyXG5PVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOXHJcblRIRSBTT0ZUV0FSRS5cclxuXHJcbiovXHJcblxyXG4ndXNlIHN0cmljdCc7XHJcblxyXG52YXIgb3MgPSByZXF1aXJlKCdvcycpO1xyXG52YXIgaGFzRmxhZyA9IHJlcXVpcmUoJy4vaGFzLWZsYWcuanMnKTtcclxuXHJcbnZhciBlbnYgPSBwcm9jZXNzLmVudjtcclxuXHJcbnZhciBmb3JjZUNvbG9yID0gdm9pZCAwO1xyXG5pZiAoaGFzRmxhZygnbm8tY29sb3InKSB8fCBoYXNGbGFnKCduby1jb2xvcnMnKSB8fCBoYXNGbGFnKCdjb2xvcj1mYWxzZScpKSB7XHJcblx0Zm9yY2VDb2xvciA9IGZhbHNlO1xyXG59IGVsc2UgaWYgKGhhc0ZsYWcoJ2NvbG9yJykgfHwgaGFzRmxhZygnY29sb3JzJykgfHwgaGFzRmxhZygnY29sb3I9dHJ1ZScpIHx8IGhhc0ZsYWcoJ2NvbG9yPWFsd2F5cycpKSB7XHJcblx0Zm9yY2VDb2xvciA9IHRydWU7XHJcbn1cclxuaWYgKCdGT1JDRV9DT0xPUicgaW4gZW52KSB7XHJcblx0Zm9yY2VDb2xvciA9IGVudi5GT1JDRV9DT0xPUi5sZW5ndGggPT09IDAgfHwgcGFyc2VJbnQoZW52LkZPUkNFX0NPTE9SLCAxMCkgIT09IDA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHRyYW5zbGF0ZUxldmVsKGxldmVsKSB7XHJcblx0aWYgKGxldmVsID09PSAwKSB7XHJcblx0XHRyZXR1cm4gZmFsc2U7XHJcblx0fVxyXG5cclxuXHRyZXR1cm4ge1xyXG5cdFx0bGV2ZWw6IGxldmVsLFxyXG5cdFx0aGFzQmFzaWM6IHRydWUsXHJcblx0XHRoYXMyNTY6IGxldmVsID49IDIsXHJcblx0XHRoYXMxNm06IGxldmVsID49IDNcclxuXHR9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBzdXBwb3J0c0NvbG9yKHN0cmVhbSkge1xyXG5cdGlmIChmb3JjZUNvbG9yID09PSBmYWxzZSkge1xyXG5cdFx0cmV0dXJuIDA7XHJcblx0fVxyXG5cclxuXHRpZiAoaGFzRmxhZygnY29sb3I9MTZtJykgfHwgaGFzRmxhZygnY29sb3I9ZnVsbCcpIHx8IGhhc0ZsYWcoJ2NvbG9yPXRydWVjb2xvcicpKSB7XHJcblx0XHRyZXR1cm4gMztcclxuXHR9XHJcblxyXG5cdGlmIChoYXNGbGFnKCdjb2xvcj0yNTYnKSkge1xyXG5cdFx0cmV0dXJuIDI7XHJcblx0fVxyXG5cclxuXHRpZiAoc3RyZWFtICYmICFzdHJlYW0uaXNUVFkgJiYgZm9yY2VDb2xvciAhPT0gdHJ1ZSkge1xyXG5cdFx0cmV0dXJuIDA7XHJcblx0fVxyXG5cclxuXHR2YXIgbWluID0gZm9yY2VDb2xvciA/IDEgOiAwO1xyXG5cclxuXHRpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ3dpbjMyJykge1xyXG5cdFx0Ly8gTm9kZS5qcyA3LjUuMCBpcyB0aGUgZmlyc3QgdmVyc2lvbiBvZiBOb2RlLmpzIHRvIGluY2x1ZGUgYSBwYXRjaCB0b1xyXG5cdFx0Ly8gbGlidXYgdGhhdCBlbmFibGVzIDI1NiBjb2xvciBvdXRwdXQgb24gV2luZG93cy4gQW55dGhpbmcgZWFybGllciBhbmQgaXRcclxuXHRcdC8vIHdvbid0IHdvcmsuIEhvd2V2ZXIsIGhlcmUgd2UgdGFyZ2V0IE5vZGUuanMgOCBhdCBtaW5pbXVtIGFzIGl0IGlzIGFuIExUU1xyXG5cdFx0Ly8gcmVsZWFzZSwgYW5kIE5vZGUuanMgNyBpcyBub3QuIFdpbmRvd3MgMTAgYnVpbGQgMTA1ODYgaXMgdGhlIGZpcnN0IFdpbmRvd3NcclxuXHRcdC8vIHJlbGVhc2UgdGhhdCBzdXBwb3J0cyAyNTYgY29sb3JzLiBXaW5kb3dzIDEwIGJ1aWxkIDE0OTMxIGlzIHRoZSBmaXJzdCByZWxlYXNlXHJcblx0XHQvLyB0aGF0IHN1cHBvcnRzIDE2bS9UcnVlQ29sb3IuXHJcblx0XHR2YXIgb3NSZWxlYXNlID0gb3MucmVsZWFzZSgpLnNwbGl0KCcuJyk7XHJcblx0XHRpZiAoTnVtYmVyKHByb2Nlc3MudmVyc2lvbnMubm9kZS5zcGxpdCgnLicpWzBdKSA+PSA4ICYmIE51bWJlcihvc1JlbGVhc2VbMF0pID49IDEwICYmIE51bWJlcihvc1JlbGVhc2VbMl0pID49IDEwNTg2KSB7XHJcblx0XHRcdHJldHVybiBOdW1iZXIob3NSZWxlYXNlWzJdKSA+PSAxNDkzMSA/IDMgOiAyO1xyXG5cdFx0fVxyXG5cclxuXHRcdHJldHVybiAxO1xyXG5cdH1cclxuXHJcblx0aWYgKCdDSScgaW4gZW52KSB7XHJcblx0XHRpZiAoWydUUkFWSVMnLCAnQ0lSQ0xFQ0knLCAnQVBQVkVZT1InLCAnR0lUTEFCX0NJJ10uc29tZShmdW5jdGlvbiAoc2lnbikge1xyXG5cdFx0XHRyZXR1cm4gc2lnbiBpbiBlbnY7XHJcblx0XHR9KSB8fCBlbnYuQ0lfTkFNRSA9PT0gJ2NvZGVzaGlwJykge1xyXG5cdFx0XHRyZXR1cm4gMTtcclxuXHRcdH1cclxuXHJcblx0XHRyZXR1cm4gbWluO1xyXG5cdH1cclxuXHJcblx0aWYgKCdURUFNQ0lUWV9WRVJTSU9OJyBpbiBlbnYpIHtcclxuXHRcdHJldHVybiAoL14oOVxcLigwKlsxLTldXFxkKilcXC58XFxkezIsfVxcLikvLnRlc3QoZW52LlRFQU1DSVRZX1ZFUlNJT04pID8gMSA6IDBcclxuXHRcdCk7XHJcblx0fVxyXG5cclxuXHRpZiAoJ1RFUk1fUFJPR1JBTScgaW4gZW52KSB7XHJcblx0XHR2YXIgdmVyc2lvbiA9IHBhcnNlSW50KChlbnYuVEVSTV9QUk9HUkFNX1ZFUlNJT04gfHwgJycpLnNwbGl0KCcuJylbMF0sIDEwKTtcclxuXHJcblx0XHRzd2l0Y2ggKGVudi5URVJNX1BST0dSQU0pIHtcclxuXHRcdFx0Y2FzZSAnaVRlcm0uYXBwJzpcclxuXHRcdFx0XHRyZXR1cm4gdmVyc2lvbiA+PSAzID8gMyA6IDI7XHJcblx0XHRcdGNhc2UgJ0h5cGVyJzpcclxuXHRcdFx0XHRyZXR1cm4gMztcclxuXHRcdFx0Y2FzZSAnQXBwbGVfVGVybWluYWwnOlxyXG5cdFx0XHRcdHJldHVybiAyO1xyXG5cdFx0XHQvLyBObyBkZWZhdWx0XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHRpZiAoLy0yNTYoY29sb3IpPyQvaS50ZXN0KGVudi5URVJNKSkge1xyXG5cdFx0cmV0dXJuIDI7XHJcblx0fVxyXG5cclxuXHRpZiAoL15zY3JlZW58Xnh0ZXJtfF52dDEwMHxecnh2dHxjb2xvcnxhbnNpfGN5Z3dpbnxsaW51eC9pLnRlc3QoZW52LlRFUk0pKSB7XHJcblx0XHRyZXR1cm4gMTtcclxuXHR9XHJcblxyXG5cdGlmICgnQ09MT1JURVJNJyBpbiBlbnYpIHtcclxuXHRcdHJldHVybiAxO1xyXG5cdH1cclxuXHJcblx0aWYgKGVudi5URVJNID09PSAnZHVtYicpIHtcclxuXHRcdHJldHVybiBtaW47XHJcblx0fVxyXG5cclxuXHRyZXR1cm4gbWluO1xyXG59XHJcblxyXG5mdW5jdGlvbiBnZXRTdXBwb3J0TGV2ZWwoc3RyZWFtKSB7XHJcblx0dmFyIGxldmVsID0gc3VwcG9ydHNDb2xvcihzdHJlYW0pO1xyXG5cdHJldHVybiB0cmFuc2xhdGVMZXZlbChsZXZlbCk7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0ge1xyXG5cdHN1cHBvcnRzQ29sb3I6IGdldFN1cHBvcnRMZXZlbCxcclxuXHRzdGRvdXQ6IGdldFN1cHBvcnRMZXZlbChwcm9jZXNzLnN0ZG91dCksXHJcblx0c3RkZXJyOiBnZXRTdXBwb3J0TGV2ZWwocHJvY2Vzcy5zdGRlcnIpXHJcbn07XHJcbiIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG52YXIgb2JqZWN0Q3JlYXRlID0gT2JqZWN0LmNyZWF0ZSB8fCBvYmplY3RDcmVhdGVQb2x5ZmlsbFxudmFyIG9iamVjdEtleXMgPSBPYmplY3Qua2V5cyB8fCBvYmplY3RLZXlzUG9seWZpbGxcbnZhciBiaW5kID0gRnVuY3Rpb24ucHJvdG90eXBlLmJpbmQgfHwgZnVuY3Rpb25CaW5kUG9seWZpbGxcblxuZnVuY3Rpb24gRXZlbnRFbWl0dGVyKCkge1xuICBpZiAoIXRoaXMuX2V2ZW50cyB8fCAhT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHRoaXMsICdfZXZlbnRzJykpIHtcbiAgICB0aGlzLl9ldmVudHMgPSBvYmplY3RDcmVhdGUobnVsbCk7XG4gICAgdGhpcy5fZXZlbnRzQ291bnQgPSAwO1xuICB9XG5cbiAgdGhpcy5fbWF4TGlzdGVuZXJzID0gdGhpcy5fbWF4TGlzdGVuZXJzIHx8IHVuZGVmaW5lZDtcbn1cbm1vZHVsZS5leHBvcnRzID0gRXZlbnRFbWl0dGVyO1xuXG4vLyBCYWNrd2FyZHMtY29tcGF0IHdpdGggbm9kZSAwLjEwLnhcbkV2ZW50RW1pdHRlci5FdmVudEVtaXR0ZXIgPSBFdmVudEVtaXR0ZXI7XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuX2V2ZW50cyA9IHVuZGVmaW5lZDtcbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuX21heExpc3RlbmVycyA9IHVuZGVmaW5lZDtcblxuLy8gQnkgZGVmYXVsdCBFdmVudEVtaXR0ZXJzIHdpbGwgcHJpbnQgYSB3YXJuaW5nIGlmIG1vcmUgdGhhbiAxMCBsaXN0ZW5lcnMgYXJlXG4vLyBhZGRlZCB0byBpdC4gVGhpcyBpcyBhIHVzZWZ1bCBkZWZhdWx0IHdoaWNoIGhlbHBzIGZpbmRpbmcgbWVtb3J5IGxlYWtzLlxudmFyIGRlZmF1bHRNYXhMaXN0ZW5lcnMgPSAxMDtcblxudmFyIGhhc0RlZmluZVByb3BlcnR5O1xudHJ5IHtcbiAgdmFyIG8gPSB7fTtcbiAgaWYgKE9iamVjdC5kZWZpbmVQcm9wZXJ0eSkgT2JqZWN0LmRlZmluZVByb3BlcnR5KG8sICd4JywgeyB2YWx1ZTogMCB9KTtcbiAgaGFzRGVmaW5lUHJvcGVydHkgPSBvLnggPT09IDA7XG59IGNhdGNoIChlcnIpIHsgaGFzRGVmaW5lUHJvcGVydHkgPSBmYWxzZSB9XG5pZiAoaGFzRGVmaW5lUHJvcGVydHkpIHtcbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5KEV2ZW50RW1pdHRlciwgJ2RlZmF1bHRNYXhMaXN0ZW5lcnMnLCB7XG4gICAgZW51bWVyYWJsZTogdHJ1ZSxcbiAgICBnZXQ6IGZ1bmN0aW9uKCkge1xuICAgICAgcmV0dXJuIGRlZmF1bHRNYXhMaXN0ZW5lcnM7XG4gICAgfSxcbiAgICBzZXQ6IGZ1bmN0aW9uKGFyZykge1xuICAgICAgLy8gY2hlY2sgd2hldGhlciB0aGUgaW5wdXQgaXMgYSBwb3NpdGl2ZSBudW1iZXIgKHdob3NlIHZhbHVlIGlzIHplcm8gb3JcbiAgICAgIC8vIGdyZWF0ZXIgYW5kIG5vdCBhIE5hTikuXG4gICAgICBpZiAodHlwZW9mIGFyZyAhPT0gJ251bWJlcicgfHwgYXJnIDwgMCB8fCBhcmcgIT09IGFyZylcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignXCJkZWZhdWx0TWF4TGlzdGVuZXJzXCIgbXVzdCBiZSBhIHBvc2l0aXZlIG51bWJlcicpO1xuICAgICAgZGVmYXVsdE1heExpc3RlbmVycyA9IGFyZztcbiAgICB9XG4gIH0pO1xufSBlbHNlIHtcbiAgRXZlbnRFbWl0dGVyLmRlZmF1bHRNYXhMaXN0ZW5lcnMgPSBkZWZhdWx0TWF4TGlzdGVuZXJzO1xufVxuXG4vLyBPYnZpb3VzbHkgbm90IGFsbCBFbWl0dGVycyBzaG91bGQgYmUgbGltaXRlZCB0byAxMC4gVGhpcyBmdW5jdGlvbiBhbGxvd3Ncbi8vIHRoYXQgdG8gYmUgaW5jcmVhc2VkLiBTZXQgdG8gemVybyBmb3IgdW5saW1pdGVkLlxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5zZXRNYXhMaXN0ZW5lcnMgPSBmdW5jdGlvbiBzZXRNYXhMaXN0ZW5lcnMobikge1xuICBpZiAodHlwZW9mIG4gIT09ICdudW1iZXInIHx8IG4gPCAwIHx8IGlzTmFOKG4pKVxuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1wiblwiIGFyZ3VtZW50IG11c3QgYmUgYSBwb3NpdGl2ZSBudW1iZXInKTtcbiAgdGhpcy5fbWF4TGlzdGVuZXJzID0gbjtcbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5mdW5jdGlvbiAkZ2V0TWF4TGlzdGVuZXJzKHRoYXQpIHtcbiAgaWYgKHRoYXQuX21heExpc3RlbmVycyA9PT0gdW5kZWZpbmVkKVxuICAgIHJldHVybiBFdmVudEVtaXR0ZXIuZGVmYXVsdE1heExpc3RlbmVycztcbiAgcmV0dXJuIHRoYXQuX21heExpc3RlbmVycztcbn1cblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5nZXRNYXhMaXN0ZW5lcnMgPSBmdW5jdGlvbiBnZXRNYXhMaXN0ZW5lcnMoKSB7XG4gIHJldHVybiAkZ2V0TWF4TGlzdGVuZXJzKHRoaXMpO1xufTtcblxuLy8gVGhlc2Ugc3RhbmRhbG9uZSBlbWl0KiBmdW5jdGlvbnMgYXJlIHVzZWQgdG8gb3B0aW1pemUgY2FsbGluZyBvZiBldmVudFxuLy8gaGFuZGxlcnMgZm9yIGZhc3QgY2FzZXMgYmVjYXVzZSBlbWl0KCkgaXRzZWxmIG9mdGVuIGhhcyBhIHZhcmlhYmxlIG51bWJlciBvZlxuLy8gYXJndW1lbnRzIGFuZCBjYW4gYmUgZGVvcHRpbWl6ZWQgYmVjYXVzZSBvZiB0aGF0LiBUaGVzZSBmdW5jdGlvbnMgYWx3YXlzIGhhdmVcbi8vIHRoZSBzYW1lIG51bWJlciBvZiBhcmd1bWVudHMgYW5kIHRodXMgZG8gbm90IGdldCBkZW9wdGltaXplZCwgc28gdGhlIGNvZGVcbi8vIGluc2lkZSB0aGVtIGNhbiBleGVjdXRlIGZhc3Rlci5cbmZ1bmN0aW9uIGVtaXROb25lKGhhbmRsZXIsIGlzRm4sIHNlbGYpIHtcbiAgaWYgKGlzRm4pXG4gICAgaGFuZGxlci5jYWxsKHNlbGYpO1xuICBlbHNlIHtcbiAgICB2YXIgbGVuID0gaGFuZGxlci5sZW5ndGg7XG4gICAgdmFyIGxpc3RlbmVycyA9IGFycmF5Q2xvbmUoaGFuZGxlciwgbGVuKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgKytpKVxuICAgICAgbGlzdGVuZXJzW2ldLmNhbGwoc2VsZik7XG4gIH1cbn1cbmZ1bmN0aW9uIGVtaXRPbmUoaGFuZGxlciwgaXNGbiwgc2VsZiwgYXJnMSkge1xuICBpZiAoaXNGbilcbiAgICBoYW5kbGVyLmNhbGwoc2VsZiwgYXJnMSk7XG4gIGVsc2Uge1xuICAgIHZhciBsZW4gPSBoYW5kbGVyLmxlbmd0aDtcbiAgICB2YXIgbGlzdGVuZXJzID0gYXJyYXlDbG9uZShoYW5kbGVyLCBsZW4pO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyArK2kpXG4gICAgICBsaXN0ZW5lcnNbaV0uY2FsbChzZWxmLCBhcmcxKTtcbiAgfVxufVxuZnVuY3Rpb24gZW1pdFR3byhoYW5kbGVyLCBpc0ZuLCBzZWxmLCBhcmcxLCBhcmcyKSB7XG4gIGlmIChpc0ZuKVxuICAgIGhhbmRsZXIuY2FsbChzZWxmLCBhcmcxLCBhcmcyKTtcbiAgZWxzZSB7XG4gICAgdmFyIGxlbiA9IGhhbmRsZXIubGVuZ3RoO1xuICAgIHZhciBsaXN0ZW5lcnMgPSBhcnJheUNsb25lKGhhbmRsZXIsIGxlbik7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW47ICsraSlcbiAgICAgIGxpc3RlbmVyc1tpXS5jYWxsKHNlbGYsIGFyZzEsIGFyZzIpO1xuICB9XG59XG5mdW5jdGlvbiBlbWl0VGhyZWUoaGFuZGxlciwgaXNGbiwgc2VsZiwgYXJnMSwgYXJnMiwgYXJnMykge1xuICBpZiAoaXNGbilcbiAgICBoYW5kbGVyLmNhbGwoc2VsZiwgYXJnMSwgYXJnMiwgYXJnMyk7XG4gIGVsc2Uge1xuICAgIHZhciBsZW4gPSBoYW5kbGVyLmxlbmd0aDtcbiAgICB2YXIgbGlzdGVuZXJzID0gYXJyYXlDbG9uZShoYW5kbGVyLCBsZW4pO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyArK2kpXG4gICAgICBsaXN0ZW5lcnNbaV0uY2FsbChzZWxmLCBhcmcxLCBhcmcyLCBhcmczKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBlbWl0TWFueShoYW5kbGVyLCBpc0ZuLCBzZWxmLCBhcmdzKSB7XG4gIGlmIChpc0ZuKVxuICAgIGhhbmRsZXIuYXBwbHkoc2VsZiwgYXJncyk7XG4gIGVsc2Uge1xuICAgIHZhciBsZW4gPSBoYW5kbGVyLmxlbmd0aDtcbiAgICB2YXIgbGlzdGVuZXJzID0gYXJyYXlDbG9uZShoYW5kbGVyLCBsZW4pO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyArK2kpXG4gICAgICBsaXN0ZW5lcnNbaV0uYXBwbHkoc2VsZiwgYXJncyk7XG4gIH1cbn1cblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5lbWl0ID0gZnVuY3Rpb24gZW1pdCh0eXBlKSB7XG4gIHZhciBlciwgaGFuZGxlciwgbGVuLCBhcmdzLCBpLCBldmVudHM7XG4gIHZhciBkb0Vycm9yID0gKHR5cGUgPT09ICdlcnJvcicpO1xuXG4gIGV2ZW50cyA9IHRoaXMuX2V2ZW50cztcbiAgaWYgKGV2ZW50cylcbiAgICBkb0Vycm9yID0gKGRvRXJyb3IgJiYgZXZlbnRzLmVycm9yID09IG51bGwpO1xuICBlbHNlIGlmICghZG9FcnJvcilcbiAgICByZXR1cm4gZmFsc2U7XG5cbiAgLy8gSWYgdGhlcmUgaXMgbm8gJ2Vycm9yJyBldmVudCBsaXN0ZW5lciB0aGVuIHRocm93LlxuICBpZiAoZG9FcnJvcikge1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMSlcbiAgICAgIGVyID0gYXJndW1lbnRzWzFdO1xuICAgIGlmIChlciBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICB0aHJvdyBlcjsgLy8gVW5oYW5kbGVkICdlcnJvcicgZXZlbnRcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gQXQgbGVhc3QgZ2l2ZSBzb21lIGtpbmQgb2YgY29udGV4dCB0byB0aGUgdXNlclxuICAgICAgdmFyIGVyciA9IG5ldyBFcnJvcignVW5oYW5kbGVkIFwiZXJyb3JcIiBldmVudC4gKCcgKyBlciArICcpJyk7XG4gICAgICBlcnIuY29udGV4dCA9IGVyO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBoYW5kbGVyID0gZXZlbnRzW3R5cGVdO1xuXG4gIGlmICghaGFuZGxlcilcbiAgICByZXR1cm4gZmFsc2U7XG5cbiAgdmFyIGlzRm4gPSB0eXBlb2YgaGFuZGxlciA9PT0gJ2Z1bmN0aW9uJztcbiAgbGVuID0gYXJndW1lbnRzLmxlbmd0aDtcbiAgc3dpdGNoIChsZW4pIHtcbiAgICAgIC8vIGZhc3QgY2FzZXNcbiAgICBjYXNlIDE6XG4gICAgICBlbWl0Tm9uZShoYW5kbGVyLCBpc0ZuLCB0aGlzKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgMjpcbiAgICAgIGVtaXRPbmUoaGFuZGxlciwgaXNGbiwgdGhpcywgYXJndW1lbnRzWzFdKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgMzpcbiAgICAgIGVtaXRUd28oaGFuZGxlciwgaXNGbiwgdGhpcywgYXJndW1lbnRzWzFdLCBhcmd1bWVudHNbMl0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSA0OlxuICAgICAgZW1pdFRocmVlKGhhbmRsZXIsIGlzRm4sIHRoaXMsIGFyZ3VtZW50c1sxXSwgYXJndW1lbnRzWzJdLCBhcmd1bWVudHNbM10pO1xuICAgICAgYnJlYWs7XG4gICAgICAvLyBzbG93ZXJcbiAgICBkZWZhdWx0OlxuICAgICAgYXJncyA9IG5ldyBBcnJheShsZW4gLSAxKTtcbiAgICAgIGZvciAoaSA9IDE7IGkgPCBsZW47IGkrKylcbiAgICAgICAgYXJnc1tpIC0gMV0gPSBhcmd1bWVudHNbaV07XG4gICAgICBlbWl0TWFueShoYW5kbGVyLCBpc0ZuLCB0aGlzLCBhcmdzKTtcbiAgfVxuXG4gIHJldHVybiB0cnVlO1xufTtcblxuZnVuY3Rpb24gX2FkZExpc3RlbmVyKHRhcmdldCwgdHlwZSwgbGlzdGVuZXIsIHByZXBlbmQpIHtcbiAgdmFyIG07XG4gIHZhciBldmVudHM7XG4gIHZhciBleGlzdGluZztcblxuICBpZiAodHlwZW9mIGxpc3RlbmVyICE9PSAnZnVuY3Rpb24nKVxuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1wibGlzdGVuZXJcIiBhcmd1bWVudCBtdXN0IGJlIGEgZnVuY3Rpb24nKTtcblxuICBldmVudHMgPSB0YXJnZXQuX2V2ZW50cztcbiAgaWYgKCFldmVudHMpIHtcbiAgICBldmVudHMgPSB0YXJnZXQuX2V2ZW50cyA9IG9iamVjdENyZWF0ZShudWxsKTtcbiAgICB0YXJnZXQuX2V2ZW50c0NvdW50ID0gMDtcbiAgfSBlbHNlIHtcbiAgICAvLyBUbyBhdm9pZCByZWN1cnNpb24gaW4gdGhlIGNhc2UgdGhhdCB0eXBlID09PSBcIm5ld0xpc3RlbmVyXCIhIEJlZm9yZVxuICAgIC8vIGFkZGluZyBpdCB0byB0aGUgbGlzdGVuZXJzLCBmaXJzdCBlbWl0IFwibmV3TGlzdGVuZXJcIi5cbiAgICBpZiAoZXZlbnRzLm5ld0xpc3RlbmVyKSB7XG4gICAgICB0YXJnZXQuZW1pdCgnbmV3TGlzdGVuZXInLCB0eXBlLFxuICAgICAgICAgIGxpc3RlbmVyLmxpc3RlbmVyID8gbGlzdGVuZXIubGlzdGVuZXIgOiBsaXN0ZW5lcik7XG5cbiAgICAgIC8vIFJlLWFzc2lnbiBgZXZlbnRzYCBiZWNhdXNlIGEgbmV3TGlzdGVuZXIgaGFuZGxlciBjb3VsZCBoYXZlIGNhdXNlZCB0aGVcbiAgICAgIC8vIHRoaXMuX2V2ZW50cyB0byBiZSBhc3NpZ25lZCB0byBhIG5ldyBvYmplY3RcbiAgICAgIGV2ZW50cyA9IHRhcmdldC5fZXZlbnRzO1xuICAgIH1cbiAgICBleGlzdGluZyA9IGV2ZW50c1t0eXBlXTtcbiAgfVxuXG4gIGlmICghZXhpc3RpbmcpIHtcbiAgICAvLyBPcHRpbWl6ZSB0aGUgY2FzZSBvZiBvbmUgbGlzdGVuZXIuIERvbid0IG5lZWQgdGhlIGV4dHJhIGFycmF5IG9iamVjdC5cbiAgICBleGlzdGluZyA9IGV2ZW50c1t0eXBlXSA9IGxpc3RlbmVyO1xuICAgICsrdGFyZ2V0Ll9ldmVudHNDb3VudDtcbiAgfSBlbHNlIHtcbiAgICBpZiAodHlwZW9mIGV4aXN0aW5nID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAvLyBBZGRpbmcgdGhlIHNlY29uZCBlbGVtZW50LCBuZWVkIHRvIGNoYW5nZSB0byBhcnJheS5cbiAgICAgIGV4aXN0aW5nID0gZXZlbnRzW3R5cGVdID1cbiAgICAgICAgICBwcmVwZW5kID8gW2xpc3RlbmVyLCBleGlzdGluZ10gOiBbZXhpc3RpbmcsIGxpc3RlbmVyXTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gSWYgd2UndmUgYWxyZWFkeSBnb3QgYW4gYXJyYXksIGp1c3QgYXBwZW5kLlxuICAgICAgaWYgKHByZXBlbmQpIHtcbiAgICAgICAgZXhpc3RpbmcudW5zaGlmdChsaXN0ZW5lcik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBleGlzdGluZy5wdXNoKGxpc3RlbmVyKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBDaGVjayBmb3IgbGlzdGVuZXIgbGVha1xuICAgIGlmICghZXhpc3Rpbmcud2FybmVkKSB7XG4gICAgICBtID0gJGdldE1heExpc3RlbmVycyh0YXJnZXQpO1xuICAgICAgaWYgKG0gJiYgbSA+IDAgJiYgZXhpc3RpbmcubGVuZ3RoID4gbSkge1xuICAgICAgICBleGlzdGluZy53YXJuZWQgPSB0cnVlO1xuICAgICAgICB2YXIgdyA9IG5ldyBFcnJvcignUG9zc2libGUgRXZlbnRFbWl0dGVyIG1lbW9yeSBsZWFrIGRldGVjdGVkLiAnICtcbiAgICAgICAgICAgIGV4aXN0aW5nLmxlbmd0aCArICcgXCInICsgU3RyaW5nKHR5cGUpICsgJ1wiIGxpc3RlbmVycyAnICtcbiAgICAgICAgICAgICdhZGRlZC4gVXNlIGVtaXR0ZXIuc2V0TWF4TGlzdGVuZXJzKCkgdG8gJyArXG4gICAgICAgICAgICAnaW5jcmVhc2UgbGltaXQuJyk7XG4gICAgICAgIHcubmFtZSA9ICdNYXhMaXN0ZW5lcnNFeGNlZWRlZFdhcm5pbmcnO1xuICAgICAgICB3LmVtaXR0ZXIgPSB0YXJnZXQ7XG4gICAgICAgIHcudHlwZSA9IHR5cGU7XG4gICAgICAgIHcuY291bnQgPSBleGlzdGluZy5sZW5ndGg7XG4gICAgICAgIGlmICh0eXBlb2YgY29uc29sZSA9PT0gJ29iamVjdCcgJiYgY29uc29sZS53YXJuKSB7XG4gICAgICAgICAgY29uc29sZS53YXJuKCclczogJXMnLCB3Lm5hbWUsIHcubWVzc2FnZSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gdGFyZ2V0O1xufVxuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmFkZExpc3RlbmVyID0gZnVuY3Rpb24gYWRkTGlzdGVuZXIodHlwZSwgbGlzdGVuZXIpIHtcbiAgcmV0dXJuIF9hZGRMaXN0ZW5lcih0aGlzLCB0eXBlLCBsaXN0ZW5lciwgZmFsc2UpO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5vbiA9IEV2ZW50RW1pdHRlci5wcm90b3R5cGUuYWRkTGlzdGVuZXI7XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUucHJlcGVuZExpc3RlbmVyID1cbiAgICBmdW5jdGlvbiBwcmVwZW5kTGlzdGVuZXIodHlwZSwgbGlzdGVuZXIpIHtcbiAgICAgIHJldHVybiBfYWRkTGlzdGVuZXIodGhpcywgdHlwZSwgbGlzdGVuZXIsIHRydWUpO1xuICAgIH07XG5cbmZ1bmN0aW9uIG9uY2VXcmFwcGVyKCkge1xuICBpZiAoIXRoaXMuZmlyZWQpIHtcbiAgICB0aGlzLnRhcmdldC5yZW1vdmVMaXN0ZW5lcih0aGlzLnR5cGUsIHRoaXMud3JhcEZuKTtcbiAgICB0aGlzLmZpcmVkID0gdHJ1ZTtcbiAgICBzd2l0Y2ggKGFyZ3VtZW50cy5sZW5ndGgpIHtcbiAgICAgIGNhc2UgMDpcbiAgICAgICAgcmV0dXJuIHRoaXMubGlzdGVuZXIuY2FsbCh0aGlzLnRhcmdldCk7XG4gICAgICBjYXNlIDE6XG4gICAgICAgIHJldHVybiB0aGlzLmxpc3RlbmVyLmNhbGwodGhpcy50YXJnZXQsIGFyZ3VtZW50c1swXSk7XG4gICAgICBjYXNlIDI6XG4gICAgICAgIHJldHVybiB0aGlzLmxpc3RlbmVyLmNhbGwodGhpcy50YXJnZXQsIGFyZ3VtZW50c1swXSwgYXJndW1lbnRzWzFdKTtcbiAgICAgIGNhc2UgMzpcbiAgICAgICAgcmV0dXJuIHRoaXMubGlzdGVuZXIuY2FsbCh0aGlzLnRhcmdldCwgYXJndW1lbnRzWzBdLCBhcmd1bWVudHNbMV0sXG4gICAgICAgICAgICBhcmd1bWVudHNbMl0pO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdmFyIGFyZ3MgPSBuZXcgQXJyYXkoYXJndW1lbnRzLmxlbmd0aCk7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJncy5sZW5ndGg7ICsraSlcbiAgICAgICAgICBhcmdzW2ldID0gYXJndW1lbnRzW2ldO1xuICAgICAgICB0aGlzLmxpc3RlbmVyLmFwcGx5KHRoaXMudGFyZ2V0LCBhcmdzKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gX29uY2VXcmFwKHRhcmdldCwgdHlwZSwgbGlzdGVuZXIpIHtcbiAgdmFyIHN0YXRlID0geyBmaXJlZDogZmFsc2UsIHdyYXBGbjogdW5kZWZpbmVkLCB0YXJnZXQ6IHRhcmdldCwgdHlwZTogdHlwZSwgbGlzdGVuZXI6IGxpc3RlbmVyIH07XG4gIHZhciB3cmFwcGVkID0gYmluZC5jYWxsKG9uY2VXcmFwcGVyLCBzdGF0ZSk7XG4gIHdyYXBwZWQubGlzdGVuZXIgPSBsaXN0ZW5lcjtcbiAgc3RhdGUud3JhcEZuID0gd3JhcHBlZDtcbiAgcmV0dXJuIHdyYXBwZWQ7XG59XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUub25jZSA9IGZ1bmN0aW9uIG9uY2UodHlwZSwgbGlzdGVuZXIpIHtcbiAgaWYgKHR5cGVvZiBsaXN0ZW5lciAhPT0gJ2Z1bmN0aW9uJylcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdcImxpc3RlbmVyXCIgYXJndW1lbnQgbXVzdCBiZSBhIGZ1bmN0aW9uJyk7XG4gIHRoaXMub24odHlwZSwgX29uY2VXcmFwKHRoaXMsIHR5cGUsIGxpc3RlbmVyKSk7XG4gIHJldHVybiB0aGlzO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5wcmVwZW5kT25jZUxpc3RlbmVyID1cbiAgICBmdW5jdGlvbiBwcmVwZW5kT25jZUxpc3RlbmVyKHR5cGUsIGxpc3RlbmVyKSB7XG4gICAgICBpZiAodHlwZW9mIGxpc3RlbmVyICE9PSAnZnVuY3Rpb24nKVxuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdcImxpc3RlbmVyXCIgYXJndW1lbnQgbXVzdCBiZSBhIGZ1bmN0aW9uJyk7XG4gICAgICB0aGlzLnByZXBlbmRMaXN0ZW5lcih0eXBlLCBfb25jZVdyYXAodGhpcywgdHlwZSwgbGlzdGVuZXIpKTtcbiAgICAgIHJldHVybiB0aGlzO1xuICAgIH07XG5cbi8vIEVtaXRzIGEgJ3JlbW92ZUxpc3RlbmVyJyBldmVudCBpZiBhbmQgb25seSBpZiB0aGUgbGlzdGVuZXIgd2FzIHJlbW92ZWQuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLnJlbW92ZUxpc3RlbmVyID1cbiAgICBmdW5jdGlvbiByZW1vdmVMaXN0ZW5lcih0eXBlLCBsaXN0ZW5lcikge1xuICAgICAgdmFyIGxpc3QsIGV2ZW50cywgcG9zaXRpb24sIGksIG9yaWdpbmFsTGlzdGVuZXI7XG5cbiAgICAgIGlmICh0eXBlb2YgbGlzdGVuZXIgIT09ICdmdW5jdGlvbicpXG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1wibGlzdGVuZXJcIiBhcmd1bWVudCBtdXN0IGJlIGEgZnVuY3Rpb24nKTtcblxuICAgICAgZXZlbnRzID0gdGhpcy5fZXZlbnRzO1xuICAgICAgaWYgKCFldmVudHMpXG4gICAgICAgIHJldHVybiB0aGlzO1xuXG4gICAgICBsaXN0ID0gZXZlbnRzW3R5cGVdO1xuICAgICAgaWYgKCFsaXN0KVxuICAgICAgICByZXR1cm4gdGhpcztcblxuICAgICAgaWYgKGxpc3QgPT09IGxpc3RlbmVyIHx8IGxpc3QubGlzdGVuZXIgPT09IGxpc3RlbmVyKSB7XG4gICAgICAgIGlmICgtLXRoaXMuX2V2ZW50c0NvdW50ID09PSAwKVxuICAgICAgICAgIHRoaXMuX2V2ZW50cyA9IG9iamVjdENyZWF0ZShudWxsKTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgZGVsZXRlIGV2ZW50c1t0eXBlXTtcbiAgICAgICAgICBpZiAoZXZlbnRzLnJlbW92ZUxpc3RlbmVyKVxuICAgICAgICAgICAgdGhpcy5lbWl0KCdyZW1vdmVMaXN0ZW5lcicsIHR5cGUsIGxpc3QubGlzdGVuZXIgfHwgbGlzdGVuZXIpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiBsaXN0ICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHBvc2l0aW9uID0gLTE7XG5cbiAgICAgICAgZm9yIChpID0gbGlzdC5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgICAgIGlmIChsaXN0W2ldID09PSBsaXN0ZW5lciB8fCBsaXN0W2ldLmxpc3RlbmVyID09PSBsaXN0ZW5lcikge1xuICAgICAgICAgICAgb3JpZ2luYWxMaXN0ZW5lciA9IGxpc3RbaV0ubGlzdGVuZXI7XG4gICAgICAgICAgICBwb3NpdGlvbiA9IGk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocG9zaXRpb24gPCAwKVxuICAgICAgICAgIHJldHVybiB0aGlzO1xuXG4gICAgICAgIGlmIChwb3NpdGlvbiA9PT0gMClcbiAgICAgICAgICBsaXN0LnNoaWZ0KCk7XG4gICAgICAgIGVsc2VcbiAgICAgICAgICBzcGxpY2VPbmUobGlzdCwgcG9zaXRpb24pO1xuXG4gICAgICAgIGlmIChsaXN0Lmxlbmd0aCA9PT0gMSlcbiAgICAgICAgICBldmVudHNbdHlwZV0gPSBsaXN0WzBdO1xuXG4gICAgICAgIGlmIChldmVudHMucmVtb3ZlTGlzdGVuZXIpXG4gICAgICAgICAgdGhpcy5lbWl0KCdyZW1vdmVMaXN0ZW5lcicsIHR5cGUsIG9yaWdpbmFsTGlzdGVuZXIgfHwgbGlzdGVuZXIpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcztcbiAgICB9O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLnJlbW92ZUFsbExpc3RlbmVycyA9XG4gICAgZnVuY3Rpb24gcmVtb3ZlQWxsTGlzdGVuZXJzKHR5cGUpIHtcbiAgICAgIHZhciBsaXN0ZW5lcnMsIGV2ZW50cywgaTtcblxuICAgICAgZXZlbnRzID0gdGhpcy5fZXZlbnRzO1xuICAgICAgaWYgKCFldmVudHMpXG4gICAgICAgIHJldHVybiB0aGlzO1xuXG4gICAgICAvLyBub3QgbGlzdGVuaW5nIGZvciByZW1vdmVMaXN0ZW5lciwgbm8gbmVlZCB0byBlbWl0XG4gICAgICBpZiAoIWV2ZW50cy5yZW1vdmVMaXN0ZW5lcikge1xuICAgICAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgIHRoaXMuX2V2ZW50cyA9IG9iamVjdENyZWF0ZShudWxsKTtcbiAgICAgICAgICB0aGlzLl9ldmVudHNDb3VudCA9IDA7XG4gICAgICAgIH0gZWxzZSBpZiAoZXZlbnRzW3R5cGVdKSB7XG4gICAgICAgICAgaWYgKC0tdGhpcy5fZXZlbnRzQ291bnQgPT09IDApXG4gICAgICAgICAgICB0aGlzLl9ldmVudHMgPSBvYmplY3RDcmVhdGUobnVsbCk7XG4gICAgICAgICAgZWxzZVxuICAgICAgICAgICAgZGVsZXRlIGV2ZW50c1t0eXBlXTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgIH1cblxuICAgICAgLy8gZW1pdCByZW1vdmVMaXN0ZW5lciBmb3IgYWxsIGxpc3RlbmVycyBvbiBhbGwgZXZlbnRzXG4gICAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICB2YXIga2V5cyA9IG9iamVjdEtleXMoZXZlbnRzKTtcbiAgICAgICAgdmFyIGtleTtcbiAgICAgICAgZm9yIChpID0gMDsgaSA8IGtleXMubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgICBrZXkgPSBrZXlzW2ldO1xuICAgICAgICAgIGlmIChrZXkgPT09ICdyZW1vdmVMaXN0ZW5lcicpIGNvbnRpbnVlO1xuICAgICAgICAgIHRoaXMucmVtb3ZlQWxsTGlzdGVuZXJzKGtleSk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5yZW1vdmVBbGxMaXN0ZW5lcnMoJ3JlbW92ZUxpc3RlbmVyJyk7XG4gICAgICAgIHRoaXMuX2V2ZW50cyA9IG9iamVjdENyZWF0ZShudWxsKTtcbiAgICAgICAgdGhpcy5fZXZlbnRzQ291bnQgPSAwO1xuICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgIH1cblxuICAgICAgbGlzdGVuZXJzID0gZXZlbnRzW3R5cGVdO1xuXG4gICAgICBpZiAodHlwZW9mIGxpc3RlbmVycyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKHR5cGUsIGxpc3RlbmVycyk7XG4gICAgICB9IGVsc2UgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAvLyBMSUZPIG9yZGVyXG4gICAgICAgIGZvciAoaSA9IGxpc3RlbmVycy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgICAgIHRoaXMucmVtb3ZlTGlzdGVuZXIodHlwZSwgbGlzdGVuZXJzW2ldKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcztcbiAgICB9O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmxpc3RlbmVycyA9IGZ1bmN0aW9uIGxpc3RlbmVycyh0eXBlKSB7XG4gIHZhciBldmxpc3RlbmVyO1xuICB2YXIgcmV0O1xuICB2YXIgZXZlbnRzID0gdGhpcy5fZXZlbnRzO1xuXG4gIGlmICghZXZlbnRzKVxuICAgIHJldCA9IFtdO1xuICBlbHNlIHtcbiAgICBldmxpc3RlbmVyID0gZXZlbnRzW3R5cGVdO1xuICAgIGlmICghZXZsaXN0ZW5lcilcbiAgICAgIHJldCA9IFtdO1xuICAgIGVsc2UgaWYgKHR5cGVvZiBldmxpc3RlbmVyID09PSAnZnVuY3Rpb24nKVxuICAgICAgcmV0ID0gW2V2bGlzdGVuZXIubGlzdGVuZXIgfHwgZXZsaXN0ZW5lcl07XG4gICAgZWxzZVxuICAgICAgcmV0ID0gdW53cmFwTGlzdGVuZXJzKGV2bGlzdGVuZXIpO1xuICB9XG5cbiAgcmV0dXJuIHJldDtcbn07XG5cbkV2ZW50RW1pdHRlci5saXN0ZW5lckNvdW50ID0gZnVuY3Rpb24oZW1pdHRlciwgdHlwZSkge1xuICBpZiAodHlwZW9mIGVtaXR0ZXIubGlzdGVuZXJDb3VudCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiBlbWl0dGVyLmxpc3RlbmVyQ291bnQodHlwZSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIGxpc3RlbmVyQ291bnQuY2FsbChlbWl0dGVyLCB0eXBlKTtcbiAgfVxufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5saXN0ZW5lckNvdW50ID0gbGlzdGVuZXJDb3VudDtcbmZ1bmN0aW9uIGxpc3RlbmVyQ291bnQodHlwZSkge1xuICB2YXIgZXZlbnRzID0gdGhpcy5fZXZlbnRzO1xuXG4gIGlmIChldmVudHMpIHtcbiAgICB2YXIgZXZsaXN0ZW5lciA9IGV2ZW50c1t0eXBlXTtcblxuICAgIGlmICh0eXBlb2YgZXZsaXN0ZW5lciA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgcmV0dXJuIDE7XG4gICAgfSBlbHNlIGlmIChldmxpc3RlbmVyKSB7XG4gICAgICByZXR1cm4gZXZsaXN0ZW5lci5sZW5ndGg7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIDA7XG59XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuZXZlbnROYW1lcyA9IGZ1bmN0aW9uIGV2ZW50TmFtZXMoKSB7XG4gIHJldHVybiB0aGlzLl9ldmVudHNDb3VudCA+IDAgPyBSZWZsZWN0Lm93bktleXModGhpcy5fZXZlbnRzKSA6IFtdO1xufTtcblxuLy8gQWJvdXQgMS41eCBmYXN0ZXIgdGhhbiB0aGUgdHdvLWFyZyB2ZXJzaW9uIG9mIEFycmF5I3NwbGljZSgpLlxuZnVuY3Rpb24gc3BsaWNlT25lKGxpc3QsIGluZGV4KSB7XG4gIGZvciAodmFyIGkgPSBpbmRleCwgayA9IGkgKyAxLCBuID0gbGlzdC5sZW5ndGg7IGsgPCBuOyBpICs9IDEsIGsgKz0gMSlcbiAgICBsaXN0W2ldID0gbGlzdFtrXTtcbiAgbGlzdC5wb3AoKTtcbn1cblxuZnVuY3Rpb24gYXJyYXlDbG9uZShhcnIsIG4pIHtcbiAgdmFyIGNvcHkgPSBuZXcgQXJyYXkobik7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbjsgKytpKVxuICAgIGNvcHlbaV0gPSBhcnJbaV07XG4gIHJldHVybiBjb3B5O1xufVxuXG5mdW5jdGlvbiB1bndyYXBMaXN0ZW5lcnMoYXJyKSB7XG4gIHZhciByZXQgPSBuZXcgQXJyYXkoYXJyLmxlbmd0aCk7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgcmV0Lmxlbmd0aDsgKytpKSB7XG4gICAgcmV0W2ldID0gYXJyW2ldLmxpc3RlbmVyIHx8IGFycltpXTtcbiAgfVxuICByZXR1cm4gcmV0O1xufVxuXG5mdW5jdGlvbiBvYmplY3RDcmVhdGVQb2x5ZmlsbChwcm90bykge1xuICB2YXIgRiA9IGZ1bmN0aW9uKCkge307XG4gIEYucHJvdG90eXBlID0gcHJvdG87XG4gIHJldHVybiBuZXcgRjtcbn1cbmZ1bmN0aW9uIG9iamVjdEtleXNQb2x5ZmlsbChvYmopIHtcbiAgdmFyIGtleXMgPSBbXTtcbiAgZm9yICh2YXIgayBpbiBvYmopIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob2JqLCBrKSkge1xuICAgIGtleXMucHVzaChrKTtcbiAgfVxuICByZXR1cm4gaztcbn1cbmZ1bmN0aW9uIGZ1bmN0aW9uQmluZFBvbHlmaWxsKGNvbnRleHQpIHtcbiAgdmFyIGZuID0gdGhpcztcbiAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gZm4uYXBwbHkoY29udGV4dCwgYXJndW1lbnRzKTtcbiAgfTtcbn1cbiIsImV4cG9ydHMuZW5kaWFubmVzcyA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICdMRScgfTtcblxuZXhwb3J0cy5ob3N0bmFtZSA9IGZ1bmN0aW9uICgpIHtcbiAgICBpZiAodHlwZW9mIGxvY2F0aW9uICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICByZXR1cm4gbG9jYXRpb24uaG9zdG5hbWVcbiAgICB9XG4gICAgZWxzZSByZXR1cm4gJyc7XG59O1xuXG5leHBvcnRzLmxvYWRhdmcgPSBmdW5jdGlvbiAoKSB7IHJldHVybiBbXSB9O1xuXG5leHBvcnRzLnVwdGltZSA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuIDAgfTtcblxuZXhwb3J0cy5mcmVlbWVtID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBOdW1iZXIuTUFYX1ZBTFVFO1xufTtcblxuZXhwb3J0cy50b3RhbG1lbSA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gTnVtYmVyLk1BWF9WQUxVRTtcbn07XG5cbmV4cG9ydHMuY3B1cyA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuIFtdIH07XG5cbmV4cG9ydHMudHlwZSA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICdCcm93c2VyJyB9O1xuXG5leHBvcnRzLnJlbGVhc2UgPSBmdW5jdGlvbiAoKSB7XG4gICAgaWYgKHR5cGVvZiBuYXZpZ2F0b3IgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgIHJldHVybiBuYXZpZ2F0b3IuYXBwVmVyc2lvbjtcbiAgICB9XG4gICAgcmV0dXJuICcnO1xufTtcblxuZXhwb3J0cy5uZXR3b3JrSW50ZXJmYWNlc1xuPSBleHBvcnRzLmdldE5ldHdvcmtJbnRlcmZhY2VzXG49IGZ1bmN0aW9uICgpIHsgcmV0dXJuIHt9IH07XG5cbmV4cG9ydHMuYXJjaCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICdqYXZhc2NyaXB0JyB9O1xuXG5leHBvcnRzLnBsYXRmb3JtID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gJ2Jyb3dzZXInIH07XG5cbmV4cG9ydHMudG1wZGlyID0gZXhwb3J0cy50bXBEaXIgPSBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuICcvdG1wJztcbn07XG5cbmV4cG9ydHMuRU9MID0gJ1xcbic7XG5cbmV4cG9ydHMuaG9tZWRpciA9IGZ1bmN0aW9uICgpIHtcblx0cmV0dXJuICcvJ1xufTtcbiIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG4vLyByZXNvbHZlcyAuIGFuZCAuLiBlbGVtZW50cyBpbiBhIHBhdGggYXJyYXkgd2l0aCBkaXJlY3RvcnkgbmFtZXMgdGhlcmVcbi8vIG11c3QgYmUgbm8gc2xhc2hlcywgZW1wdHkgZWxlbWVudHMsIG9yIGRldmljZSBuYW1lcyAoYzpcXCkgaW4gdGhlIGFycmF5XG4vLyAoc28gYWxzbyBubyBsZWFkaW5nIGFuZCB0cmFpbGluZyBzbGFzaGVzIC0gaXQgZG9lcyBub3QgZGlzdGluZ3Vpc2hcbi8vIHJlbGF0aXZlIGFuZCBhYnNvbHV0ZSBwYXRocylcbmZ1bmN0aW9uIG5vcm1hbGl6ZUFycmF5KHBhcnRzLCBhbGxvd0Fib3ZlUm9vdCkge1xuICAvLyBpZiB0aGUgcGF0aCB0cmllcyB0byBnbyBhYm92ZSB0aGUgcm9vdCwgYHVwYCBlbmRzIHVwID4gMFxuICB2YXIgdXAgPSAwO1xuICBmb3IgKHZhciBpID0gcGFydHMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICB2YXIgbGFzdCA9IHBhcnRzW2ldO1xuICAgIGlmIChsYXN0ID09PSAnLicpIHtcbiAgICAgIHBhcnRzLnNwbGljZShpLCAxKTtcbiAgICB9IGVsc2UgaWYgKGxhc3QgPT09ICcuLicpIHtcbiAgICAgIHBhcnRzLnNwbGljZShpLCAxKTtcbiAgICAgIHVwKys7XG4gICAgfSBlbHNlIGlmICh1cCkge1xuICAgICAgcGFydHMuc3BsaWNlKGksIDEpO1xuICAgICAgdXAtLTtcbiAgICB9XG4gIH1cblxuICAvLyBpZiB0aGUgcGF0aCBpcyBhbGxvd2VkIHRvIGdvIGFib3ZlIHRoZSByb290LCByZXN0b3JlIGxlYWRpbmcgLi5zXG4gIGlmIChhbGxvd0Fib3ZlUm9vdCkge1xuICAgIGZvciAoOyB1cC0tOyB1cCkge1xuICAgICAgcGFydHMudW5zaGlmdCgnLi4nKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcGFydHM7XG59XG5cbi8vIFNwbGl0IGEgZmlsZW5hbWUgaW50byBbcm9vdCwgZGlyLCBiYXNlbmFtZSwgZXh0XSwgdW5peCB2ZXJzaW9uXG4vLyAncm9vdCcgaXMganVzdCBhIHNsYXNoLCBvciBub3RoaW5nLlxudmFyIHNwbGl0UGF0aFJlID1cbiAgICAvXihcXC8/fCkoW1xcc1xcU10qPykoKD86XFwuezEsMn18W15cXC9dKz98KShcXC5bXi5cXC9dKnwpKSg/OltcXC9dKikkLztcbnZhciBzcGxpdFBhdGggPSBmdW5jdGlvbihmaWxlbmFtZSkge1xuICByZXR1cm4gc3BsaXRQYXRoUmUuZXhlYyhmaWxlbmFtZSkuc2xpY2UoMSk7XG59O1xuXG4vLyBwYXRoLnJlc29sdmUoW2Zyb20gLi4uXSwgdG8pXG4vLyBwb3NpeCB2ZXJzaW9uXG5leHBvcnRzLnJlc29sdmUgPSBmdW5jdGlvbigpIHtcbiAgdmFyIHJlc29sdmVkUGF0aCA9ICcnLFxuICAgICAgcmVzb2x2ZWRBYnNvbHV0ZSA9IGZhbHNlO1xuXG4gIGZvciAodmFyIGkgPSBhcmd1bWVudHMubGVuZ3RoIC0gMTsgaSA+PSAtMSAmJiAhcmVzb2x2ZWRBYnNvbHV0ZTsgaS0tKSB7XG4gICAgdmFyIHBhdGggPSAoaSA+PSAwKSA/IGFyZ3VtZW50c1tpXSA6IHByb2Nlc3MuY3dkKCk7XG5cbiAgICAvLyBTa2lwIGVtcHR5IGFuZCBpbnZhbGlkIGVudHJpZXNcbiAgICBpZiAodHlwZW9mIHBhdGggIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdBcmd1bWVudHMgdG8gcGF0aC5yZXNvbHZlIG11c3QgYmUgc3RyaW5ncycpO1xuICAgIH0gZWxzZSBpZiAoIXBhdGgpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIHJlc29sdmVkUGF0aCA9IHBhdGggKyAnLycgKyByZXNvbHZlZFBhdGg7XG4gICAgcmVzb2x2ZWRBYnNvbHV0ZSA9IHBhdGguY2hhckF0KDApID09PSAnLyc7XG4gIH1cblxuICAvLyBBdCB0aGlzIHBvaW50IHRoZSBwYXRoIHNob3VsZCBiZSByZXNvbHZlZCB0byBhIGZ1bGwgYWJzb2x1dGUgcGF0aCwgYnV0XG4gIC8vIGhhbmRsZSByZWxhdGl2ZSBwYXRocyB0byBiZSBzYWZlIChtaWdodCBoYXBwZW4gd2hlbiBwcm9jZXNzLmN3ZCgpIGZhaWxzKVxuXG4gIC8vIE5vcm1hbGl6ZSB0aGUgcGF0aFxuICByZXNvbHZlZFBhdGggPSBub3JtYWxpemVBcnJheShmaWx0ZXIocmVzb2x2ZWRQYXRoLnNwbGl0KCcvJyksIGZ1bmN0aW9uKHApIHtcbiAgICByZXR1cm4gISFwO1xuICB9KSwgIXJlc29sdmVkQWJzb2x1dGUpLmpvaW4oJy8nKTtcblxuICByZXR1cm4gKChyZXNvbHZlZEFic29sdXRlID8gJy8nIDogJycpICsgcmVzb2x2ZWRQYXRoKSB8fCAnLic7XG59O1xuXG4vLyBwYXRoLm5vcm1hbGl6ZShwYXRoKVxuLy8gcG9zaXggdmVyc2lvblxuZXhwb3J0cy5ub3JtYWxpemUgPSBmdW5jdGlvbihwYXRoKSB7XG4gIHZhciBpc0Fic29sdXRlID0gZXhwb3J0cy5pc0Fic29sdXRlKHBhdGgpLFxuICAgICAgdHJhaWxpbmdTbGFzaCA9IHN1YnN0cihwYXRoLCAtMSkgPT09ICcvJztcblxuICAvLyBOb3JtYWxpemUgdGhlIHBhdGhcbiAgcGF0aCA9IG5vcm1hbGl6ZUFycmF5KGZpbHRlcihwYXRoLnNwbGl0KCcvJyksIGZ1bmN0aW9uKHApIHtcbiAgICByZXR1cm4gISFwO1xuICB9KSwgIWlzQWJzb2x1dGUpLmpvaW4oJy8nKTtcblxuICBpZiAoIXBhdGggJiYgIWlzQWJzb2x1dGUpIHtcbiAgICBwYXRoID0gJy4nO1xuICB9XG4gIGlmIChwYXRoICYmIHRyYWlsaW5nU2xhc2gpIHtcbiAgICBwYXRoICs9ICcvJztcbiAgfVxuXG4gIHJldHVybiAoaXNBYnNvbHV0ZSA/ICcvJyA6ICcnKSArIHBhdGg7XG59O1xuXG4vLyBwb3NpeCB2ZXJzaW9uXG5leHBvcnRzLmlzQWJzb2x1dGUgPSBmdW5jdGlvbihwYXRoKSB7XG4gIHJldHVybiBwYXRoLmNoYXJBdCgwKSA9PT0gJy8nO1xufTtcblxuLy8gcG9zaXggdmVyc2lvblxuZXhwb3J0cy5qb2luID0gZnVuY3Rpb24oKSB7XG4gIHZhciBwYXRocyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMCk7XG4gIHJldHVybiBleHBvcnRzLm5vcm1hbGl6ZShmaWx0ZXIocGF0aHMsIGZ1bmN0aW9uKHAsIGluZGV4KSB7XG4gICAgaWYgKHR5cGVvZiBwICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignQXJndW1lbnRzIHRvIHBhdGguam9pbiBtdXN0IGJlIHN0cmluZ3MnKTtcbiAgICB9XG4gICAgcmV0dXJuIHA7XG4gIH0pLmpvaW4oJy8nKSk7XG59O1xuXG5cbi8vIHBhdGgucmVsYXRpdmUoZnJvbSwgdG8pXG4vLyBwb3NpeCB2ZXJzaW9uXG5leHBvcnRzLnJlbGF0aXZlID0gZnVuY3Rpb24oZnJvbSwgdG8pIHtcbiAgZnJvbSA9IGV4cG9ydHMucmVzb2x2ZShmcm9tKS5zdWJzdHIoMSk7XG4gIHRvID0gZXhwb3J0cy5yZXNvbHZlKHRvKS5zdWJzdHIoMSk7XG5cbiAgZnVuY3Rpb24gdHJpbShhcnIpIHtcbiAgICB2YXIgc3RhcnQgPSAwO1xuICAgIGZvciAoOyBzdGFydCA8IGFyci5sZW5ndGg7IHN0YXJ0KyspIHtcbiAgICAgIGlmIChhcnJbc3RhcnRdICE9PSAnJykgYnJlYWs7XG4gICAgfVxuXG4gICAgdmFyIGVuZCA9IGFyci5sZW5ndGggLSAxO1xuICAgIGZvciAoOyBlbmQgPj0gMDsgZW5kLS0pIHtcbiAgICAgIGlmIChhcnJbZW5kXSAhPT0gJycpIGJyZWFrO1xuICAgIH1cblxuICAgIGlmIChzdGFydCA+IGVuZCkgcmV0dXJuIFtdO1xuICAgIHJldHVybiBhcnIuc2xpY2Uoc3RhcnQsIGVuZCAtIHN0YXJ0ICsgMSk7XG4gIH1cblxuICB2YXIgZnJvbVBhcnRzID0gdHJpbShmcm9tLnNwbGl0KCcvJykpO1xuICB2YXIgdG9QYXJ0cyA9IHRyaW0odG8uc3BsaXQoJy8nKSk7XG5cbiAgdmFyIGxlbmd0aCA9IE1hdGgubWluKGZyb21QYXJ0cy5sZW5ndGgsIHRvUGFydHMubGVuZ3RoKTtcbiAgdmFyIHNhbWVQYXJ0c0xlbmd0aCA9IGxlbmd0aDtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGg7IGkrKykge1xuICAgIGlmIChmcm9tUGFydHNbaV0gIT09IHRvUGFydHNbaV0pIHtcbiAgICAgIHNhbWVQYXJ0c0xlbmd0aCA9IGk7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICB2YXIgb3V0cHV0UGFydHMgPSBbXTtcbiAgZm9yICh2YXIgaSA9IHNhbWVQYXJ0c0xlbmd0aDsgaSA8IGZyb21QYXJ0cy5sZW5ndGg7IGkrKykge1xuICAgIG91dHB1dFBhcnRzLnB1c2goJy4uJyk7XG4gIH1cblxuICBvdXRwdXRQYXJ0cyA9IG91dHB1dFBhcnRzLmNvbmNhdCh0b1BhcnRzLnNsaWNlKHNhbWVQYXJ0c0xlbmd0aCkpO1xuXG4gIHJldHVybiBvdXRwdXRQYXJ0cy5qb2luKCcvJyk7XG59O1xuXG5leHBvcnRzLnNlcCA9ICcvJztcbmV4cG9ydHMuZGVsaW1pdGVyID0gJzonO1xuXG5leHBvcnRzLmRpcm5hbWUgPSBmdW5jdGlvbihwYXRoKSB7XG4gIHZhciByZXN1bHQgPSBzcGxpdFBhdGgocGF0aCksXG4gICAgICByb290ID0gcmVzdWx0WzBdLFxuICAgICAgZGlyID0gcmVzdWx0WzFdO1xuXG4gIGlmICghcm9vdCAmJiAhZGlyKSB7XG4gICAgLy8gTm8gZGlybmFtZSB3aGF0c29ldmVyXG4gICAgcmV0dXJuICcuJztcbiAgfVxuXG4gIGlmIChkaXIpIHtcbiAgICAvLyBJdCBoYXMgYSBkaXJuYW1lLCBzdHJpcCB0cmFpbGluZyBzbGFzaFxuICAgIGRpciA9IGRpci5zdWJzdHIoMCwgZGlyLmxlbmd0aCAtIDEpO1xuICB9XG5cbiAgcmV0dXJuIHJvb3QgKyBkaXI7XG59O1xuXG5cbmV4cG9ydHMuYmFzZW5hbWUgPSBmdW5jdGlvbihwYXRoLCBleHQpIHtcbiAgdmFyIGYgPSBzcGxpdFBhdGgocGF0aClbMl07XG4gIC8vIFRPRE86IG1ha2UgdGhpcyBjb21wYXJpc29uIGNhc2UtaW5zZW5zaXRpdmUgb24gd2luZG93cz9cbiAgaWYgKGV4dCAmJiBmLnN1YnN0cigtMSAqIGV4dC5sZW5ndGgpID09PSBleHQpIHtcbiAgICBmID0gZi5zdWJzdHIoMCwgZi5sZW5ndGggLSBleHQubGVuZ3RoKTtcbiAgfVxuICByZXR1cm4gZjtcbn07XG5cblxuZXhwb3J0cy5leHRuYW1lID0gZnVuY3Rpb24ocGF0aCkge1xuICByZXR1cm4gc3BsaXRQYXRoKHBhdGgpWzNdO1xufTtcblxuZnVuY3Rpb24gZmlsdGVyICh4cywgZikge1xuICAgIGlmICh4cy5maWx0ZXIpIHJldHVybiB4cy5maWx0ZXIoZik7XG4gICAgdmFyIHJlcyA9IFtdO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgeHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKGYoeHNbaV0sIGksIHhzKSkgcmVzLnB1c2goeHNbaV0pO1xuICAgIH1cbiAgICByZXR1cm4gcmVzO1xufVxuXG4vLyBTdHJpbmcucHJvdG90eXBlLnN1YnN0ciAtIG5lZ2F0aXZlIGluZGV4IGRvbid0IHdvcmsgaW4gSUU4XG52YXIgc3Vic3RyID0gJ2FiJy5zdWJzdHIoLTEpID09PSAnYidcbiAgICA/IGZ1bmN0aW9uIChzdHIsIHN0YXJ0LCBsZW4pIHsgcmV0dXJuIHN0ci5zdWJzdHIoc3RhcnQsIGxlbikgfVxuICAgIDogZnVuY3Rpb24gKHN0ciwgc3RhcnQsIGxlbikge1xuICAgICAgICBpZiAoc3RhcnQgPCAwKSBzdGFydCA9IHN0ci5sZW5ndGggKyBzdGFydDtcbiAgICAgICAgcmV0dXJuIHN0ci5zdWJzdHIoc3RhcnQsIGxlbik7XG4gICAgfVxuO1xuIiwiLy8gc2hpbSBmb3IgdXNpbmcgcHJvY2VzcyBpbiBicm93c2VyXG52YXIgcHJvY2VzcyA9IG1vZHVsZS5leHBvcnRzID0ge307XG5cbi8vIGNhY2hlZCBmcm9tIHdoYXRldmVyIGdsb2JhbCBpcyBwcmVzZW50IHNvIHRoYXQgdGVzdCBydW5uZXJzIHRoYXQgc3R1YiBpdFxuLy8gZG9uJ3QgYnJlYWsgdGhpbmdzLiAgQnV0IHdlIG5lZWQgdG8gd3JhcCBpdCBpbiBhIHRyeSBjYXRjaCBpbiBjYXNlIGl0IGlzXG4vLyB3cmFwcGVkIGluIHN0cmljdCBtb2RlIGNvZGUgd2hpY2ggZG9lc24ndCBkZWZpbmUgYW55IGdsb2JhbHMuICBJdCdzIGluc2lkZSBhXG4vLyBmdW5jdGlvbiBiZWNhdXNlIHRyeS9jYXRjaGVzIGRlb3B0aW1pemUgaW4gY2VydGFpbiBlbmdpbmVzLlxuXG52YXIgY2FjaGVkU2V0VGltZW91dDtcbnZhciBjYWNoZWRDbGVhclRpbWVvdXQ7XG5cbmZ1bmN0aW9uIGRlZmF1bHRTZXRUaW1vdXQoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdzZXRUaW1lb3V0IGhhcyBub3QgYmVlbiBkZWZpbmVkJyk7XG59XG5mdW5jdGlvbiBkZWZhdWx0Q2xlYXJUaW1lb3V0ICgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ2NsZWFyVGltZW91dCBoYXMgbm90IGJlZW4gZGVmaW5lZCcpO1xufVxuKGZ1bmN0aW9uICgpIHtcbiAgICB0cnkge1xuICAgICAgICBpZiAodHlwZW9mIHNldFRpbWVvdXQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGNhY2hlZFNldFRpbWVvdXQgPSBzZXRUaW1lb3V0O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY2FjaGVkU2V0VGltZW91dCA9IGRlZmF1bHRTZXRUaW1vdXQ7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNhY2hlZFNldFRpbWVvdXQgPSBkZWZhdWx0U2V0VGltb3V0O1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICBpZiAodHlwZW9mIGNsZWFyVGltZW91dCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FjaGVkQ2xlYXJUaW1lb3V0ID0gY2xlYXJUaW1lb3V0O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY2FjaGVkQ2xlYXJUaW1lb3V0ID0gZGVmYXVsdENsZWFyVGltZW91dDtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY2FjaGVkQ2xlYXJUaW1lb3V0ID0gZGVmYXVsdENsZWFyVGltZW91dDtcbiAgICB9XG59ICgpKVxuZnVuY3Rpb24gcnVuVGltZW91dChmdW4pIHtcbiAgICBpZiAoY2FjaGVkU2V0VGltZW91dCA9PT0gc2V0VGltZW91dCkge1xuICAgICAgICAvL25vcm1hbCBlbnZpcm9tZW50cyBpbiBzYW5lIHNpdHVhdGlvbnNcbiAgICAgICAgcmV0dXJuIHNldFRpbWVvdXQoZnVuLCAwKTtcbiAgICB9XG4gICAgLy8gaWYgc2V0VGltZW91dCB3YXNuJ3QgYXZhaWxhYmxlIGJ1dCB3YXMgbGF0dGVyIGRlZmluZWRcbiAgICBpZiAoKGNhY2hlZFNldFRpbWVvdXQgPT09IGRlZmF1bHRTZXRUaW1vdXQgfHwgIWNhY2hlZFNldFRpbWVvdXQpICYmIHNldFRpbWVvdXQpIHtcbiAgICAgICAgY2FjaGVkU2V0VGltZW91dCA9IHNldFRpbWVvdXQ7XG4gICAgICAgIHJldHVybiBzZXRUaW1lb3V0KGZ1biwgMCk7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIC8vIHdoZW4gd2hlbiBzb21lYm9keSBoYXMgc2NyZXdlZCB3aXRoIHNldFRpbWVvdXQgYnV0IG5vIEkuRS4gbWFkZG5lc3NcbiAgICAgICAgcmV0dXJuIGNhY2hlZFNldFRpbWVvdXQoZnVuLCAwKTtcbiAgICB9IGNhdGNoKGUpe1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8gV2hlbiB3ZSBhcmUgaW4gSS5FLiBidXQgdGhlIHNjcmlwdCBoYXMgYmVlbiBldmFsZWQgc28gSS5FLiBkb2Vzbid0IHRydXN0IHRoZSBnbG9iYWwgb2JqZWN0IHdoZW4gY2FsbGVkIG5vcm1hbGx5XG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkU2V0VGltZW91dC5jYWxsKG51bGwsIGZ1biwgMCk7XG4gICAgICAgIH0gY2F0Y2goZSl7XG4gICAgICAgICAgICAvLyBzYW1lIGFzIGFib3ZlIGJ1dCB3aGVuIGl0J3MgYSB2ZXJzaW9uIG9mIEkuRS4gdGhhdCBtdXN0IGhhdmUgdGhlIGdsb2JhbCBvYmplY3QgZm9yICd0aGlzJywgaG9wZnVsbHkgb3VyIGNvbnRleHQgY29ycmVjdCBvdGhlcndpc2UgaXQgd2lsbCB0aHJvdyBhIGdsb2JhbCBlcnJvclxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZFNldFRpbWVvdXQuY2FsbCh0aGlzLCBmdW4sIDApO1xuICAgICAgICB9XG4gICAgfVxuXG5cbn1cbmZ1bmN0aW9uIHJ1bkNsZWFyVGltZW91dChtYXJrZXIpIHtcbiAgICBpZiAoY2FjaGVkQ2xlYXJUaW1lb3V0ID09PSBjbGVhclRpbWVvdXQpIHtcbiAgICAgICAgLy9ub3JtYWwgZW52aXJvbWVudHMgaW4gc2FuZSBzaXR1YXRpb25zXG4gICAgICAgIHJldHVybiBjbGVhclRpbWVvdXQobWFya2VyKTtcbiAgICB9XG4gICAgLy8gaWYgY2xlYXJUaW1lb3V0IHdhc24ndCBhdmFpbGFibGUgYnV0IHdhcyBsYXR0ZXIgZGVmaW5lZFxuICAgIGlmICgoY2FjaGVkQ2xlYXJUaW1lb3V0ID09PSBkZWZhdWx0Q2xlYXJUaW1lb3V0IHx8ICFjYWNoZWRDbGVhclRpbWVvdXQpICYmIGNsZWFyVGltZW91dCkge1xuICAgICAgICBjYWNoZWRDbGVhclRpbWVvdXQgPSBjbGVhclRpbWVvdXQ7XG4gICAgICAgIHJldHVybiBjbGVhclRpbWVvdXQobWFya2VyKTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgLy8gd2hlbiB3aGVuIHNvbWVib2R5IGhhcyBzY3Jld2VkIHdpdGggc2V0VGltZW91dCBidXQgbm8gSS5FLiBtYWRkbmVzc1xuICAgICAgICByZXR1cm4gY2FjaGVkQ2xlYXJUaW1lb3V0KG1hcmtlcik7XG4gICAgfSBjYXRjaCAoZSl7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBXaGVuIHdlIGFyZSBpbiBJLkUuIGJ1dCB0aGUgc2NyaXB0IGhhcyBiZWVuIGV2YWxlZCBzbyBJLkUuIGRvZXNuJ3QgIHRydXN0IHRoZSBnbG9iYWwgb2JqZWN0IHdoZW4gY2FsbGVkIG5vcm1hbGx5XG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkQ2xlYXJUaW1lb3V0LmNhbGwobnVsbCwgbWFya2VyKTtcbiAgICAgICAgfSBjYXRjaCAoZSl7XG4gICAgICAgICAgICAvLyBzYW1lIGFzIGFib3ZlIGJ1dCB3aGVuIGl0J3MgYSB2ZXJzaW9uIG9mIEkuRS4gdGhhdCBtdXN0IGhhdmUgdGhlIGdsb2JhbCBvYmplY3QgZm9yICd0aGlzJywgaG9wZnVsbHkgb3VyIGNvbnRleHQgY29ycmVjdCBvdGhlcndpc2UgaXQgd2lsbCB0aHJvdyBhIGdsb2JhbCBlcnJvci5cbiAgICAgICAgICAgIC8vIFNvbWUgdmVyc2lvbnMgb2YgSS5FLiBoYXZlIGRpZmZlcmVudCBydWxlcyBmb3IgY2xlYXJUaW1lb3V0IHZzIHNldFRpbWVvdXRcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWRDbGVhclRpbWVvdXQuY2FsbCh0aGlzLCBtYXJrZXIpO1xuICAgICAgICB9XG4gICAgfVxuXG5cblxufVxudmFyIHF1ZXVlID0gW107XG52YXIgZHJhaW5pbmcgPSBmYWxzZTtcbnZhciBjdXJyZW50UXVldWU7XG52YXIgcXVldWVJbmRleCA9IC0xO1xuXG5mdW5jdGlvbiBjbGVhblVwTmV4dFRpY2soKSB7XG4gICAgaWYgKCFkcmFpbmluZyB8fCAhY3VycmVudFF1ZXVlKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZHJhaW5pbmcgPSBmYWxzZTtcbiAgICBpZiAoY3VycmVudFF1ZXVlLmxlbmd0aCkge1xuICAgICAgICBxdWV1ZSA9IGN1cnJlbnRRdWV1ZS5jb25jYXQocXVldWUpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHF1ZXVlSW5kZXggPSAtMTtcbiAgICB9XG4gICAgaWYgKHF1ZXVlLmxlbmd0aCkge1xuICAgICAgICBkcmFpblF1ZXVlKCk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBkcmFpblF1ZXVlKCkge1xuICAgIGlmIChkcmFpbmluZykge1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIHZhciB0aW1lb3V0ID0gcnVuVGltZW91dChjbGVhblVwTmV4dFRpY2spO1xuICAgIGRyYWluaW5nID0gdHJ1ZTtcblxuICAgIHZhciBsZW4gPSBxdWV1ZS5sZW5ndGg7XG4gICAgd2hpbGUobGVuKSB7XG4gICAgICAgIGN1cnJlbnRRdWV1ZSA9IHF1ZXVlO1xuICAgICAgICBxdWV1ZSA9IFtdO1xuICAgICAgICB3aGlsZSAoKytxdWV1ZUluZGV4IDwgbGVuKSB7XG4gICAgICAgICAgICBpZiAoY3VycmVudFF1ZXVlKSB7XG4gICAgICAgICAgICAgICAgY3VycmVudFF1ZXVlW3F1ZXVlSW5kZXhdLnJ1bigpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHF1ZXVlSW5kZXggPSAtMTtcbiAgICAgICAgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIH1cbiAgICBjdXJyZW50UXVldWUgPSBudWxsO1xuICAgIGRyYWluaW5nID0gZmFsc2U7XG4gICAgcnVuQ2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xufVxuXG5wcm9jZXNzLm5leHRUaWNrID0gZnVuY3Rpb24gKGZ1bikge1xuICAgIHZhciBhcmdzID0gbmV3IEFycmF5KGFyZ3VtZW50cy5sZW5ndGggLSAxKTtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgZm9yICh2YXIgaSA9IDE7IGkgPCBhcmd1bWVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIGFyZ3NbaSAtIDFdID0gYXJndW1lbnRzW2ldO1xuICAgICAgICB9XG4gICAgfVxuICAgIHF1ZXVlLnB1c2gobmV3IEl0ZW0oZnVuLCBhcmdzKSk7XG4gICAgaWYgKHF1ZXVlLmxlbmd0aCA9PT0gMSAmJiAhZHJhaW5pbmcpIHtcbiAgICAgICAgcnVuVGltZW91dChkcmFpblF1ZXVlKTtcbiAgICB9XG59O1xuXG4vLyB2OCBsaWtlcyBwcmVkaWN0aWJsZSBvYmplY3RzXG5mdW5jdGlvbiBJdGVtKGZ1biwgYXJyYXkpIHtcbiAgICB0aGlzLmZ1biA9IGZ1bjtcbiAgICB0aGlzLmFycmF5ID0gYXJyYXk7XG59XG5JdGVtLnByb3RvdHlwZS5ydW4gPSBmdW5jdGlvbiAoKSB7XG4gICAgdGhpcy5mdW4uYXBwbHkobnVsbCwgdGhpcy5hcnJheSk7XG59O1xucHJvY2Vzcy50aXRsZSA9ICdicm93c2VyJztcbnByb2Nlc3MuYnJvd3NlciA9IHRydWU7XG5wcm9jZXNzLmVudiA9IHt9O1xucHJvY2Vzcy5hcmd2ID0gW107XG5wcm9jZXNzLnZlcnNpb24gPSAnJzsgLy8gZW1wdHkgc3RyaW5nIHRvIGF2b2lkIHJlZ2V4cCBpc3N1ZXNcbnByb2Nlc3MudmVyc2lvbnMgPSB7fTtcblxuZnVuY3Rpb24gbm9vcCgpIHt9XG5cbnByb2Nlc3Mub24gPSBub29wO1xucHJvY2Vzcy5hZGRMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLm9uY2UgPSBub29wO1xucHJvY2Vzcy5vZmYgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUFsbExpc3RlbmVycyA9IG5vb3A7XG5wcm9jZXNzLmVtaXQgPSBub29wO1xucHJvY2Vzcy5wcmVwZW5kTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5wcmVwZW5kT25jZUxpc3RlbmVyID0gbm9vcDtcblxucHJvY2Vzcy5saXN0ZW5lcnMgPSBmdW5jdGlvbiAobmFtZSkgeyByZXR1cm4gW10gfVxuXG5wcm9jZXNzLmJpbmRpbmcgPSBmdW5jdGlvbiAobmFtZSkge1xuICAgIHRocm93IG5ldyBFcnJvcigncHJvY2Vzcy5iaW5kaW5nIGlzIG5vdCBzdXBwb3J0ZWQnKTtcbn07XG5cbnByb2Nlc3MuY3dkID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gJy8nIH07XG5wcm9jZXNzLmNoZGlyID0gZnVuY3Rpb24gKGRpcikge1xuICAgIHRocm93IG5ldyBFcnJvcigncHJvY2Vzcy5jaGRpciBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xucHJvY2Vzcy51bWFzayA9IGZ1bmN0aW9uKCkgeyByZXR1cm4gMDsgfTtcbiIsImlmICh0eXBlb2YgT2JqZWN0LmNyZWF0ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAvLyBpbXBsZW1lbnRhdGlvbiBmcm9tIHN0YW5kYXJkIG5vZGUuanMgJ3V0aWwnIG1vZHVsZVxuICBtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGluaGVyaXRzKGN0b3IsIHN1cGVyQ3Rvcikge1xuICAgIGN0b3Iuc3VwZXJfID0gc3VwZXJDdG9yXG4gICAgY3Rvci5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKHN1cGVyQ3Rvci5wcm90b3R5cGUsIHtcbiAgICAgIGNvbnN0cnVjdG9yOiB7XG4gICAgICAgIHZhbHVlOiBjdG9yLFxuICAgICAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICAgICAgd3JpdGFibGU6IHRydWUsXG4gICAgICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZVxuICAgICAgfVxuICAgIH0pO1xuICB9O1xufSBlbHNlIHtcbiAgLy8gb2xkIHNjaG9vbCBzaGltIGZvciBvbGQgYnJvd3NlcnNcbiAgbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBpbmhlcml0cyhjdG9yLCBzdXBlckN0b3IpIHtcbiAgICBjdG9yLnN1cGVyXyA9IHN1cGVyQ3RvclxuICAgIHZhciBUZW1wQ3RvciA9IGZ1bmN0aW9uICgpIHt9XG4gICAgVGVtcEN0b3IucHJvdG90eXBlID0gc3VwZXJDdG9yLnByb3RvdHlwZVxuICAgIGN0b3IucHJvdG90eXBlID0gbmV3IFRlbXBDdG9yKClcbiAgICBjdG9yLnByb3RvdHlwZS5jb25zdHJ1Y3RvciA9IGN0b3JcbiAgfVxufVxuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBpc0J1ZmZlcihhcmcpIHtcbiAgcmV0dXJuIGFyZyAmJiB0eXBlb2YgYXJnID09PSAnb2JqZWN0J1xuICAgICYmIHR5cGVvZiBhcmcuY29weSA9PT0gJ2Z1bmN0aW9uJ1xuICAgICYmIHR5cGVvZiBhcmcuZmlsbCA9PT0gJ2Z1bmN0aW9uJ1xuICAgICYmIHR5cGVvZiBhcmcucmVhZFVJbnQ4ID09PSAnZnVuY3Rpb24nO1xufSIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG52YXIgZm9ybWF0UmVnRXhwID0gLyVbc2RqJV0vZztcbmV4cG9ydHMuZm9ybWF0ID0gZnVuY3Rpb24oZikge1xuICBpZiAoIWlzU3RyaW5nKGYpKSB7XG4gICAgdmFyIG9iamVjdHMgPSBbXTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgb2JqZWN0cy5wdXNoKGluc3BlY3QoYXJndW1lbnRzW2ldKSk7XG4gICAgfVxuICAgIHJldHVybiBvYmplY3RzLmpvaW4oJyAnKTtcbiAgfVxuXG4gIHZhciBpID0gMTtcbiAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gIHZhciBsZW4gPSBhcmdzLmxlbmd0aDtcbiAgdmFyIHN0ciA9IFN0cmluZyhmKS5yZXBsYWNlKGZvcm1hdFJlZ0V4cCwgZnVuY3Rpb24oeCkge1xuICAgIGlmICh4ID09PSAnJSUnKSByZXR1cm4gJyUnO1xuICAgIGlmIChpID49IGxlbikgcmV0dXJuIHg7XG4gICAgc3dpdGNoICh4KSB7XG4gICAgICBjYXNlICclcyc6IHJldHVybiBTdHJpbmcoYXJnc1tpKytdKTtcbiAgICAgIGNhc2UgJyVkJzogcmV0dXJuIE51bWJlcihhcmdzW2krK10pO1xuICAgICAgY2FzZSAnJWonOlxuICAgICAgICB0cnkge1xuICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShhcmdzW2krK10pO1xuICAgICAgICB9IGNhdGNoIChfKSB7XG4gICAgICAgICAgcmV0dXJuICdbQ2lyY3VsYXJdJztcbiAgICAgICAgfVxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIHg7XG4gICAgfVxuICB9KTtcbiAgZm9yICh2YXIgeCA9IGFyZ3NbaV07IGkgPCBsZW47IHggPSBhcmdzWysraV0pIHtcbiAgICBpZiAoaXNOdWxsKHgpIHx8ICFpc09iamVjdCh4KSkge1xuICAgICAgc3RyICs9ICcgJyArIHg7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0ciArPSAnICcgKyBpbnNwZWN0KHgpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gc3RyO1xufTtcblxuXG4vLyBNYXJrIHRoYXQgYSBtZXRob2Qgc2hvdWxkIG5vdCBiZSB1c2VkLlxuLy8gUmV0dXJucyBhIG1vZGlmaWVkIGZ1bmN0aW9uIHdoaWNoIHdhcm5zIG9uY2UgYnkgZGVmYXVsdC5cbi8vIElmIC0tbm8tZGVwcmVjYXRpb24gaXMgc2V0LCB0aGVuIGl0IGlzIGEgbm8tb3AuXG5leHBvcnRzLmRlcHJlY2F0ZSA9IGZ1bmN0aW9uKGZuLCBtc2cpIHtcbiAgLy8gQWxsb3cgZm9yIGRlcHJlY2F0aW5nIHRoaW5ncyBpbiB0aGUgcHJvY2VzcyBvZiBzdGFydGluZyB1cC5cbiAgaWYgKGlzVW5kZWZpbmVkKGdsb2JhbC5wcm9jZXNzKSkge1xuICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgIHJldHVybiBleHBvcnRzLmRlcHJlY2F0ZShmbiwgbXNnKS5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgIH07XG4gIH1cblxuICBpZiAocHJvY2Vzcy5ub0RlcHJlY2F0aW9uID09PSB0cnVlKSB7XG4gICAgcmV0dXJuIGZuO1xuICB9XG5cbiAgdmFyIHdhcm5lZCA9IGZhbHNlO1xuICBmdW5jdGlvbiBkZXByZWNhdGVkKCkge1xuICAgIGlmICghd2FybmVkKSB7XG4gICAgICBpZiAocHJvY2Vzcy50aHJvd0RlcHJlY2F0aW9uKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihtc2cpO1xuICAgICAgfSBlbHNlIGlmIChwcm9jZXNzLnRyYWNlRGVwcmVjYXRpb24pIHtcbiAgICAgICAgY29uc29sZS50cmFjZShtc2cpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihtc2cpO1xuICAgICAgfVxuICAgICAgd2FybmVkID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gIH1cblxuICByZXR1cm4gZGVwcmVjYXRlZDtcbn07XG5cblxudmFyIGRlYnVncyA9IHt9O1xudmFyIGRlYnVnRW52aXJvbjtcbmV4cG9ydHMuZGVidWdsb2cgPSBmdW5jdGlvbihzZXQpIHtcbiAgaWYgKGlzVW5kZWZpbmVkKGRlYnVnRW52aXJvbikpXG4gICAgZGVidWdFbnZpcm9uID0gcHJvY2Vzcy5lbnYuTk9ERV9ERUJVRyB8fCAnJztcbiAgc2V0ID0gc2V0LnRvVXBwZXJDYXNlKCk7XG4gIGlmICghZGVidWdzW3NldF0pIHtcbiAgICBpZiAobmV3IFJlZ0V4cCgnXFxcXGInICsgc2V0ICsgJ1xcXFxiJywgJ2knKS50ZXN0KGRlYnVnRW52aXJvbikpIHtcbiAgICAgIHZhciBwaWQgPSBwcm9jZXNzLnBpZDtcbiAgICAgIGRlYnVnc1tzZXRdID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIHZhciBtc2cgPSBleHBvcnRzLmZvcm1hdC5hcHBseShleHBvcnRzLCBhcmd1bWVudHMpO1xuICAgICAgICBjb25zb2xlLmVycm9yKCclcyAlZDogJXMnLCBzZXQsIHBpZCwgbXNnKTtcbiAgICAgIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIGRlYnVnc1tzZXRdID0gZnVuY3Rpb24oKSB7fTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGRlYnVnc1tzZXRdO1xufTtcblxuXG4vKipcbiAqIEVjaG9zIHRoZSB2YWx1ZSBvZiBhIHZhbHVlLiBUcnlzIHRvIHByaW50IHRoZSB2YWx1ZSBvdXRcbiAqIGluIHRoZSBiZXN0IHdheSBwb3NzaWJsZSBnaXZlbiB0aGUgZGlmZmVyZW50IHR5cGVzLlxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBvYmogVGhlIG9iamVjdCB0byBwcmludCBvdXQuXG4gKiBAcGFyYW0ge09iamVjdH0gb3B0cyBPcHRpb25hbCBvcHRpb25zIG9iamVjdCB0aGF0IGFsdGVycyB0aGUgb3V0cHV0LlxuICovXG4vKiBsZWdhY3k6IG9iaiwgc2hvd0hpZGRlbiwgZGVwdGgsIGNvbG9ycyovXG5mdW5jdGlvbiBpbnNwZWN0KG9iaiwgb3B0cykge1xuICAvLyBkZWZhdWx0IG9wdGlvbnNcbiAgdmFyIGN0eCA9IHtcbiAgICBzZWVuOiBbXSxcbiAgICBzdHlsaXplOiBzdHlsaXplTm9Db2xvclxuICB9O1xuICAvLyBsZWdhY3kuLi5cbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPj0gMykgY3R4LmRlcHRoID0gYXJndW1lbnRzWzJdO1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+PSA0KSBjdHguY29sb3JzID0gYXJndW1lbnRzWzNdO1xuICBpZiAoaXNCb29sZWFuKG9wdHMpKSB7XG4gICAgLy8gbGVnYWN5Li4uXG4gICAgY3R4LnNob3dIaWRkZW4gPSBvcHRzO1xuICB9IGVsc2UgaWYgKG9wdHMpIHtcbiAgICAvLyBnb3QgYW4gXCJvcHRpb25zXCIgb2JqZWN0XG4gICAgZXhwb3J0cy5fZXh0ZW5kKGN0eCwgb3B0cyk7XG4gIH1cbiAgLy8gc2V0IGRlZmF1bHQgb3B0aW9uc1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LnNob3dIaWRkZW4pKSBjdHguc2hvd0hpZGRlbiA9IGZhbHNlO1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LmRlcHRoKSkgY3R4LmRlcHRoID0gMjtcbiAgaWYgKGlzVW5kZWZpbmVkKGN0eC5jb2xvcnMpKSBjdHguY29sb3JzID0gZmFsc2U7XG4gIGlmIChpc1VuZGVmaW5lZChjdHguY3VzdG9tSW5zcGVjdCkpIGN0eC5jdXN0b21JbnNwZWN0ID0gdHJ1ZTtcbiAgaWYgKGN0eC5jb2xvcnMpIGN0eC5zdHlsaXplID0gc3R5bGl6ZVdpdGhDb2xvcjtcbiAgcmV0dXJuIGZvcm1hdFZhbHVlKGN0eCwgb2JqLCBjdHguZGVwdGgpO1xufVxuZXhwb3J0cy5pbnNwZWN0ID0gaW5zcGVjdDtcblxuXG4vLyBodHRwOi8vZW4ud2lraXBlZGlhLm9yZy93aWtpL0FOU0lfZXNjYXBlX2NvZGUjZ3JhcGhpY3Ncbmluc3BlY3QuY29sb3JzID0ge1xuICAnYm9sZCcgOiBbMSwgMjJdLFxuICAnaXRhbGljJyA6IFszLCAyM10sXG4gICd1bmRlcmxpbmUnIDogWzQsIDI0XSxcbiAgJ2ludmVyc2UnIDogWzcsIDI3XSxcbiAgJ3doaXRlJyA6IFszNywgMzldLFxuICAnZ3JleScgOiBbOTAsIDM5XSxcbiAgJ2JsYWNrJyA6IFszMCwgMzldLFxuICAnYmx1ZScgOiBbMzQsIDM5XSxcbiAgJ2N5YW4nIDogWzM2LCAzOV0sXG4gICdncmVlbicgOiBbMzIsIDM5XSxcbiAgJ21hZ2VudGEnIDogWzM1LCAzOV0sXG4gICdyZWQnIDogWzMxLCAzOV0sXG4gICd5ZWxsb3cnIDogWzMzLCAzOV1cbn07XG5cbi8vIERvbid0IHVzZSAnYmx1ZScgbm90IHZpc2libGUgb24gY21kLmV4ZVxuaW5zcGVjdC5zdHlsZXMgPSB7XG4gICdzcGVjaWFsJzogJ2N5YW4nLFxuICAnbnVtYmVyJzogJ3llbGxvdycsXG4gICdib29sZWFuJzogJ3llbGxvdycsXG4gICd1bmRlZmluZWQnOiAnZ3JleScsXG4gICdudWxsJzogJ2JvbGQnLFxuICAnc3RyaW5nJzogJ2dyZWVuJyxcbiAgJ2RhdGUnOiAnbWFnZW50YScsXG4gIC8vIFwibmFtZVwiOiBpbnRlbnRpb25hbGx5IG5vdCBzdHlsaW5nXG4gICdyZWdleHAnOiAncmVkJ1xufTtcblxuXG5mdW5jdGlvbiBzdHlsaXplV2l0aENvbG9yKHN0ciwgc3R5bGVUeXBlKSB7XG4gIHZhciBzdHlsZSA9IGluc3BlY3Quc3R5bGVzW3N0eWxlVHlwZV07XG5cbiAgaWYgKHN0eWxlKSB7XG4gICAgcmV0dXJuICdcXHUwMDFiWycgKyBpbnNwZWN0LmNvbG9yc1tzdHlsZV1bMF0gKyAnbScgKyBzdHIgK1xuICAgICAgICAgICAnXFx1MDAxYlsnICsgaW5zcGVjdC5jb2xvcnNbc3R5bGVdWzFdICsgJ20nO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBzdHI7XG4gIH1cbn1cblxuXG5mdW5jdGlvbiBzdHlsaXplTm9Db2xvcihzdHIsIHN0eWxlVHlwZSkge1xuICByZXR1cm4gc3RyO1xufVxuXG5cbmZ1bmN0aW9uIGFycmF5VG9IYXNoKGFycmF5KSB7XG4gIHZhciBoYXNoID0ge307XG5cbiAgYXJyYXkuZm9yRWFjaChmdW5jdGlvbih2YWwsIGlkeCkge1xuICAgIGhhc2hbdmFsXSA9IHRydWU7XG4gIH0pO1xuXG4gIHJldHVybiBoYXNoO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdFZhbHVlKGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcykge1xuICAvLyBQcm92aWRlIGEgaG9vayBmb3IgdXNlci1zcGVjaWZpZWQgaW5zcGVjdCBmdW5jdGlvbnMuXG4gIC8vIENoZWNrIHRoYXQgdmFsdWUgaXMgYW4gb2JqZWN0IHdpdGggYW4gaW5zcGVjdCBmdW5jdGlvbiBvbiBpdFxuICBpZiAoY3R4LmN1c3RvbUluc3BlY3QgJiZcbiAgICAgIHZhbHVlICYmXG4gICAgICBpc0Z1bmN0aW9uKHZhbHVlLmluc3BlY3QpICYmXG4gICAgICAvLyBGaWx0ZXIgb3V0IHRoZSB1dGlsIG1vZHVsZSwgaXQncyBpbnNwZWN0IGZ1bmN0aW9uIGlzIHNwZWNpYWxcbiAgICAgIHZhbHVlLmluc3BlY3QgIT09IGV4cG9ydHMuaW5zcGVjdCAmJlxuICAgICAgLy8gQWxzbyBmaWx0ZXIgb3V0IGFueSBwcm90b3R5cGUgb2JqZWN0cyB1c2luZyB0aGUgY2lyY3VsYXIgY2hlY2suXG4gICAgICAhKHZhbHVlLmNvbnN0cnVjdG9yICYmIHZhbHVlLmNvbnN0cnVjdG9yLnByb3RvdHlwZSA9PT0gdmFsdWUpKSB7XG4gICAgdmFyIHJldCA9IHZhbHVlLmluc3BlY3QocmVjdXJzZVRpbWVzLCBjdHgpO1xuICAgIGlmICghaXNTdHJpbmcocmV0KSkge1xuICAgICAgcmV0ID0gZm9ybWF0VmFsdWUoY3R4LCByZXQsIHJlY3Vyc2VUaW1lcyk7XG4gICAgfVxuICAgIHJldHVybiByZXQ7XG4gIH1cblxuICAvLyBQcmltaXRpdmUgdHlwZXMgY2Fubm90IGhhdmUgcHJvcGVydGllc1xuICB2YXIgcHJpbWl0aXZlID0gZm9ybWF0UHJpbWl0aXZlKGN0eCwgdmFsdWUpO1xuICBpZiAocHJpbWl0aXZlKSB7XG4gICAgcmV0dXJuIHByaW1pdGl2ZTtcbiAgfVxuXG4gIC8vIExvb2sgdXAgdGhlIGtleXMgb2YgdGhlIG9iamVjdC5cbiAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyh2YWx1ZSk7XG4gIHZhciB2aXNpYmxlS2V5cyA9IGFycmF5VG9IYXNoKGtleXMpO1xuXG4gIGlmIChjdHguc2hvd0hpZGRlbikge1xuICAgIGtleXMgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlOYW1lcyh2YWx1ZSk7XG4gIH1cblxuICAvLyBJRSBkb2Vzbid0IG1ha2UgZXJyb3IgZmllbGRzIG5vbi1lbnVtZXJhYmxlXG4gIC8vIGh0dHA6Ly9tc2RuLm1pY3Jvc29mdC5jb20vZW4tdXMvbGlicmFyeS9pZS9kd3c1MnNidCh2PXZzLjk0KS5hc3B4XG4gIGlmIChpc0Vycm9yKHZhbHVlKVxuICAgICAgJiYgKGtleXMuaW5kZXhPZignbWVzc2FnZScpID49IDAgfHwga2V5cy5pbmRleE9mKCdkZXNjcmlwdGlvbicpID49IDApKSB7XG4gICAgcmV0dXJuIGZvcm1hdEVycm9yKHZhbHVlKTtcbiAgfVxuXG4gIC8vIFNvbWUgdHlwZSBvZiBvYmplY3Qgd2l0aG91dCBwcm9wZXJ0aWVzIGNhbiBiZSBzaG9ydGN1dHRlZC5cbiAgaWYgKGtleXMubGVuZ3RoID09PSAwKSB7XG4gICAgaWYgKGlzRnVuY3Rpb24odmFsdWUpKSB7XG4gICAgICB2YXIgbmFtZSA9IHZhbHVlLm5hbWUgPyAnOiAnICsgdmFsdWUubmFtZSA6ICcnO1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKCdbRnVuY3Rpb24nICsgbmFtZSArICddJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gICAgaWYgKGlzUmVnRXhwKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKFJlZ0V4cC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSksICdyZWdleHAnKTtcbiAgICB9XG4gICAgaWYgKGlzRGF0ZSh2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZShEYXRlLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKSwgJ2RhdGUnKTtcbiAgICB9XG4gICAgaWYgKGlzRXJyb3IodmFsdWUpKSB7XG4gICAgICByZXR1cm4gZm9ybWF0RXJyb3IodmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIHZhciBiYXNlID0gJycsIGFycmF5ID0gZmFsc2UsIGJyYWNlcyA9IFsneycsICd9J107XG5cbiAgLy8gTWFrZSBBcnJheSBzYXkgdGhhdCB0aGV5IGFyZSBBcnJheVxuICBpZiAoaXNBcnJheSh2YWx1ZSkpIHtcbiAgICBhcnJheSA9IHRydWU7XG4gICAgYnJhY2VzID0gWydbJywgJ10nXTtcbiAgfVxuXG4gIC8vIE1ha2UgZnVuY3Rpb25zIHNheSB0aGF0IHRoZXkgYXJlIGZ1bmN0aW9uc1xuICBpZiAoaXNGdW5jdGlvbih2YWx1ZSkpIHtcbiAgICB2YXIgbiA9IHZhbHVlLm5hbWUgPyAnOiAnICsgdmFsdWUubmFtZSA6ICcnO1xuICAgIGJhc2UgPSAnIFtGdW5jdGlvbicgKyBuICsgJ10nO1xuICB9XG5cbiAgLy8gTWFrZSBSZWdFeHBzIHNheSB0aGF0IHRoZXkgYXJlIFJlZ0V4cHNcbiAgaWYgKGlzUmVnRXhwKHZhbHVlKSkge1xuICAgIGJhc2UgPSAnICcgKyBSZWdFeHAucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpO1xuICB9XG5cbiAgLy8gTWFrZSBkYXRlcyB3aXRoIHByb3BlcnRpZXMgZmlyc3Qgc2F5IHRoZSBkYXRlXG4gIGlmIChpc0RhdGUodmFsdWUpKSB7XG4gICAgYmFzZSA9ICcgJyArIERhdGUucHJvdG90eXBlLnRvVVRDU3RyaW5nLmNhbGwodmFsdWUpO1xuICB9XG5cbiAgLy8gTWFrZSBlcnJvciB3aXRoIG1lc3NhZ2UgZmlyc3Qgc2F5IHRoZSBlcnJvclxuICBpZiAoaXNFcnJvcih2YWx1ZSkpIHtcbiAgICBiYXNlID0gJyAnICsgZm9ybWF0RXJyb3IodmFsdWUpO1xuICB9XG5cbiAgaWYgKGtleXMubGVuZ3RoID09PSAwICYmICghYXJyYXkgfHwgdmFsdWUubGVuZ3RoID09IDApKSB7XG4gICAgcmV0dXJuIGJyYWNlc1swXSArIGJhc2UgKyBicmFjZXNbMV07XG4gIH1cblxuICBpZiAocmVjdXJzZVRpbWVzIDwgMCkge1xuICAgIGlmIChpc1JlZ0V4cCh2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZShSZWdFeHAucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpLCAncmVnZXhwJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZSgnW09iamVjdF0nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgfVxuXG4gIGN0eC5zZWVuLnB1c2godmFsdWUpO1xuXG4gIHZhciBvdXRwdXQ7XG4gIGlmIChhcnJheSkge1xuICAgIG91dHB1dCA9IGZvcm1hdEFycmF5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleXMpO1xuICB9IGVsc2Uge1xuICAgIG91dHB1dCA9IGtleXMubWFwKGZ1bmN0aW9uKGtleSkge1xuICAgICAgcmV0dXJuIGZvcm1hdFByb3BlcnR5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleSwgYXJyYXkpO1xuICAgIH0pO1xuICB9XG5cbiAgY3R4LnNlZW4ucG9wKCk7XG5cbiAgcmV0dXJuIHJlZHVjZVRvU2luZ2xlU3RyaW5nKG91dHB1dCwgYmFzZSwgYnJhY2VzKTtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRQcmltaXRpdmUoY3R4LCB2YWx1ZSkge1xuICBpZiAoaXNVbmRlZmluZWQodmFsdWUpKVxuICAgIHJldHVybiBjdHguc3R5bGl6ZSgndW5kZWZpbmVkJywgJ3VuZGVmaW5lZCcpO1xuICBpZiAoaXNTdHJpbmcodmFsdWUpKSB7XG4gICAgdmFyIHNpbXBsZSA9ICdcXCcnICsgSlNPTi5zdHJpbmdpZnkodmFsdWUpLnJlcGxhY2UoL15cInxcIiQvZywgJycpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFxcXFwiL2csICdcIicpICsgJ1xcJyc7XG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKHNpbXBsZSwgJ3N0cmluZycpO1xuICB9XG4gIGlmIChpc051bWJlcih2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCcnICsgdmFsdWUsICdudW1iZXInKTtcbiAgaWYgKGlzQm9vbGVhbih2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCcnICsgdmFsdWUsICdib29sZWFuJyk7XG4gIC8vIEZvciBzb21lIHJlYXNvbiB0eXBlb2YgbnVsbCBpcyBcIm9iamVjdFwiLCBzbyBzcGVjaWFsIGNhc2UgaGVyZS5cbiAgaWYgKGlzTnVsbCh2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCdudWxsJywgJ251bGwnKTtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRFcnJvcih2YWx1ZSkge1xuICByZXR1cm4gJ1snICsgRXJyb3IucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpICsgJ10nO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdEFycmF5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleXMpIHtcbiAgdmFyIG91dHB1dCA9IFtdO1xuICBmb3IgKHZhciBpID0gMCwgbCA9IHZhbHVlLmxlbmd0aDsgaSA8IGw7ICsraSkge1xuICAgIGlmIChoYXNPd25Qcm9wZXJ0eSh2YWx1ZSwgU3RyaW5nKGkpKSkge1xuICAgICAgb3V0cHV0LnB1c2goZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cyxcbiAgICAgICAgICBTdHJpbmcoaSksIHRydWUpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgb3V0cHV0LnB1c2goJycpO1xuICAgIH1cbiAgfVxuICBrZXlzLmZvckVhY2goZnVuY3Rpb24oa2V5KSB7XG4gICAgaWYgKCFrZXkubWF0Y2goL15cXGQrJC8pKSB7XG4gICAgICBvdXRwdXQucHVzaChmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLFxuICAgICAgICAgIGtleSwgdHJ1ZSkpO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBvdXRwdXQ7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5LCBhcnJheSkge1xuICB2YXIgbmFtZSwgc3RyLCBkZXNjO1xuICBkZXNjID0gT2JqZWN0LmdldE93blByb3BlcnR5RGVzY3JpcHRvcih2YWx1ZSwga2V5KSB8fCB7IHZhbHVlOiB2YWx1ZVtrZXldIH07XG4gIGlmIChkZXNjLmdldCkge1xuICAgIGlmIChkZXNjLnNldCkge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tHZXR0ZXIvU2V0dGVyXScsICdzcGVjaWFsJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0ciA9IGN0eC5zdHlsaXplKCdbR2V0dGVyXScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGlmIChkZXNjLnNldCkge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tTZXR0ZXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH1cbiAgaWYgKCFoYXNPd25Qcm9wZXJ0eSh2aXNpYmxlS2V5cywga2V5KSkge1xuICAgIG5hbWUgPSAnWycgKyBrZXkgKyAnXSc7XG4gIH1cbiAgaWYgKCFzdHIpIHtcbiAgICBpZiAoY3R4LnNlZW4uaW5kZXhPZihkZXNjLnZhbHVlKSA8IDApIHtcbiAgICAgIGlmIChpc051bGwocmVjdXJzZVRpbWVzKSkge1xuICAgICAgICBzdHIgPSBmb3JtYXRWYWx1ZShjdHgsIGRlc2MudmFsdWUsIG51bGwpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc3RyID0gZm9ybWF0VmFsdWUoY3R4LCBkZXNjLnZhbHVlLCByZWN1cnNlVGltZXMgLSAxKTtcbiAgICAgIH1cbiAgICAgIGlmIChzdHIuaW5kZXhPZignXFxuJykgPiAtMSkge1xuICAgICAgICBpZiAoYXJyYXkpIHtcbiAgICAgICAgICBzdHIgPSBzdHIuc3BsaXQoJ1xcbicpLm1hcChmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgICAgICByZXR1cm4gJyAgJyArIGxpbmU7XG4gICAgICAgICAgfSkuam9pbignXFxuJykuc3Vic3RyKDIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHN0ciA9ICdcXG4nICsgc3RyLnNwbGl0KCdcXG4nKS5tYXAoZnVuY3Rpb24obGluZSkge1xuICAgICAgICAgICAgcmV0dXJuICcgICAnICsgbGluZTtcbiAgICAgICAgICB9KS5qb2luKCdcXG4nKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW0NpcmN1bGFyXScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9XG4gIGlmIChpc1VuZGVmaW5lZChuYW1lKSkge1xuICAgIGlmIChhcnJheSAmJiBrZXkubWF0Y2goL15cXGQrJC8pKSB7XG4gICAgICByZXR1cm4gc3RyO1xuICAgIH1cbiAgICBuYW1lID0gSlNPTi5zdHJpbmdpZnkoJycgKyBrZXkpO1xuICAgIGlmIChuYW1lLm1hdGNoKC9eXCIoW2EtekEtWl9dW2EtekEtWl8wLTldKilcIiQvKSkge1xuICAgICAgbmFtZSA9IG5hbWUuc3Vic3RyKDEsIG5hbWUubGVuZ3RoIC0gMik7XG4gICAgICBuYW1lID0gY3R4LnN0eWxpemUobmFtZSwgJ25hbWUnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbmFtZSA9IG5hbWUucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpXG4gICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXFxcXCIvZywgJ1wiJylcbiAgICAgICAgICAgICAgICAgLnJlcGxhY2UoLyheXCJ8XCIkKS9nLCBcIidcIik7XG4gICAgICBuYW1lID0gY3R4LnN0eWxpemUobmFtZSwgJ3N0cmluZycpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBuYW1lICsgJzogJyArIHN0cjtcbn1cblxuXG5mdW5jdGlvbiByZWR1Y2VUb1NpbmdsZVN0cmluZyhvdXRwdXQsIGJhc2UsIGJyYWNlcykge1xuICB2YXIgbnVtTGluZXNFc3QgPSAwO1xuICB2YXIgbGVuZ3RoID0gb3V0cHV0LnJlZHVjZShmdW5jdGlvbihwcmV2LCBjdXIpIHtcbiAgICBudW1MaW5lc0VzdCsrO1xuICAgIGlmIChjdXIuaW5kZXhPZignXFxuJykgPj0gMCkgbnVtTGluZXNFc3QrKztcbiAgICByZXR1cm4gcHJldiArIGN1ci5yZXBsYWNlKC9cXHUwMDFiXFxbXFxkXFxkP20vZywgJycpLmxlbmd0aCArIDE7XG4gIH0sIDApO1xuXG4gIGlmIChsZW5ndGggPiA2MCkge1xuICAgIHJldHVybiBicmFjZXNbMF0gK1xuICAgICAgICAgICAoYmFzZSA9PT0gJycgPyAnJyA6IGJhc2UgKyAnXFxuICcpICtcbiAgICAgICAgICAgJyAnICtcbiAgICAgICAgICAgb3V0cHV0LmpvaW4oJyxcXG4gICcpICtcbiAgICAgICAgICAgJyAnICtcbiAgICAgICAgICAgYnJhY2VzWzFdO1xuICB9XG5cbiAgcmV0dXJuIGJyYWNlc1swXSArIGJhc2UgKyAnICcgKyBvdXRwdXQuam9pbignLCAnKSArICcgJyArIGJyYWNlc1sxXTtcbn1cblxuXG4vLyBOT1RFOiBUaGVzZSB0eXBlIGNoZWNraW5nIGZ1bmN0aW9ucyBpbnRlbnRpb25hbGx5IGRvbid0IHVzZSBgaW5zdGFuY2VvZmBcbi8vIGJlY2F1c2UgaXQgaXMgZnJhZ2lsZSBhbmQgY2FuIGJlIGVhc2lseSBmYWtlZCB3aXRoIGBPYmplY3QuY3JlYXRlKClgLlxuZnVuY3Rpb24gaXNBcnJheShhcikge1xuICByZXR1cm4gQXJyYXkuaXNBcnJheShhcik7XG59XG5leHBvcnRzLmlzQXJyYXkgPSBpc0FycmF5O1xuXG5mdW5jdGlvbiBpc0Jvb2xlYW4oYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnYm9vbGVhbic7XG59XG5leHBvcnRzLmlzQm9vbGVhbiA9IGlzQm9vbGVhbjtcblxuZnVuY3Rpb24gaXNOdWxsKGFyZykge1xuICByZXR1cm4gYXJnID09PSBudWxsO1xufVxuZXhwb3J0cy5pc051bGwgPSBpc051bGw7XG5cbmZ1bmN0aW9uIGlzTnVsbE9yVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09IG51bGw7XG59XG5leHBvcnRzLmlzTnVsbE9yVW5kZWZpbmVkID0gaXNOdWxsT3JVbmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGlzTnVtYmVyKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ251bWJlcic7XG59XG5leHBvcnRzLmlzTnVtYmVyID0gaXNOdW1iZXI7XG5cbmZ1bmN0aW9uIGlzU3RyaW5nKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ3N0cmluZyc7XG59XG5leHBvcnRzLmlzU3RyaW5nID0gaXNTdHJpbmc7XG5cbmZ1bmN0aW9uIGlzU3ltYm9sKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ3N5bWJvbCc7XG59XG5leHBvcnRzLmlzU3ltYm9sID0gaXNTeW1ib2w7XG5cbmZ1bmN0aW9uIGlzVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09PSB2b2lkIDA7XG59XG5leHBvcnRzLmlzVW5kZWZpbmVkID0gaXNVbmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGlzUmVnRXhwKHJlKSB7XG4gIHJldHVybiBpc09iamVjdChyZSkgJiYgb2JqZWN0VG9TdHJpbmcocmUpID09PSAnW29iamVjdCBSZWdFeHBdJztcbn1cbmV4cG9ydHMuaXNSZWdFeHAgPSBpc1JlZ0V4cDtcblxuZnVuY3Rpb24gaXNPYmplY3QoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgIT09IG51bGw7XG59XG5leHBvcnRzLmlzT2JqZWN0ID0gaXNPYmplY3Q7XG5cbmZ1bmN0aW9uIGlzRGF0ZShkKSB7XG4gIHJldHVybiBpc09iamVjdChkKSAmJiBvYmplY3RUb1N0cmluZyhkKSA9PT0gJ1tvYmplY3QgRGF0ZV0nO1xufVxuZXhwb3J0cy5pc0RhdGUgPSBpc0RhdGU7XG5cbmZ1bmN0aW9uIGlzRXJyb3IoZSkge1xuICByZXR1cm4gaXNPYmplY3QoZSkgJiZcbiAgICAgIChvYmplY3RUb1N0cmluZyhlKSA9PT0gJ1tvYmplY3QgRXJyb3JdJyB8fCBlIGluc3RhbmNlb2YgRXJyb3IpO1xufVxuZXhwb3J0cy5pc0Vycm9yID0gaXNFcnJvcjtcblxuZnVuY3Rpb24gaXNGdW5jdGlvbihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdmdW5jdGlvbic7XG59XG5leHBvcnRzLmlzRnVuY3Rpb24gPSBpc0Z1bmN0aW9uO1xuXG5mdW5jdGlvbiBpc1ByaW1pdGl2ZShhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gbnVsbCB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ2Jvb2xlYW4nIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnbnVtYmVyJyB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ3N0cmluZycgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdzeW1ib2wnIHx8ICAvLyBFUzYgc3ltYm9sXG4gICAgICAgICB0eXBlb2YgYXJnID09PSAndW5kZWZpbmVkJztcbn1cbmV4cG9ydHMuaXNQcmltaXRpdmUgPSBpc1ByaW1pdGl2ZTtcblxuZXhwb3J0cy5pc0J1ZmZlciA9IHJlcXVpcmUoJy4vc3VwcG9ydC9pc0J1ZmZlcicpO1xuXG5mdW5jdGlvbiBvYmplY3RUb1N0cmluZyhvKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwobyk7XG59XG5cblxuZnVuY3Rpb24gcGFkKG4pIHtcbiAgcmV0dXJuIG4gPCAxMCA/ICcwJyArIG4udG9TdHJpbmcoMTApIDogbi50b1N0cmluZygxMCk7XG59XG5cblxudmFyIG1vbnRocyA9IFsnSmFuJywgJ0ZlYicsICdNYXInLCAnQXByJywgJ01heScsICdKdW4nLCAnSnVsJywgJ0F1ZycsICdTZXAnLFxuICAgICAgICAgICAgICAnT2N0JywgJ05vdicsICdEZWMnXTtcblxuLy8gMjYgRmViIDE2OjE5OjM0XG5mdW5jdGlvbiB0aW1lc3RhbXAoKSB7XG4gIHZhciBkID0gbmV3IERhdGUoKTtcbiAgdmFyIHRpbWUgPSBbcGFkKGQuZ2V0SG91cnMoKSksXG4gICAgICAgICAgICAgIHBhZChkLmdldE1pbnV0ZXMoKSksXG4gICAgICAgICAgICAgIHBhZChkLmdldFNlY29uZHMoKSldLmpvaW4oJzonKTtcbiAgcmV0dXJuIFtkLmdldERhdGUoKSwgbW9udGhzW2QuZ2V0TW9udGgoKV0sIHRpbWVdLmpvaW4oJyAnKTtcbn1cblxuXG4vLyBsb2cgaXMganVzdCBhIHRoaW4gd3JhcHBlciB0byBjb25zb2xlLmxvZyB0aGF0IHByZXBlbmRzIGEgdGltZXN0YW1wXG5leHBvcnRzLmxvZyA9IGZ1bmN0aW9uKCkge1xuICBjb25zb2xlLmxvZygnJXMgLSAlcycsIHRpbWVzdGFtcCgpLCBleHBvcnRzLmZvcm1hdC5hcHBseShleHBvcnRzLCBhcmd1bWVudHMpKTtcbn07XG5cblxuLyoqXG4gKiBJbmhlcml0IHRoZSBwcm90b3R5cGUgbWV0aG9kcyBmcm9tIG9uZSBjb25zdHJ1Y3RvciBpbnRvIGFub3RoZXIuXG4gKlxuICogVGhlIEZ1bmN0aW9uLnByb3RvdHlwZS5pbmhlcml0cyBmcm9tIGxhbmcuanMgcmV3cml0dGVuIGFzIGEgc3RhbmRhbG9uZVxuICogZnVuY3Rpb24gKG5vdCBvbiBGdW5jdGlvbi5wcm90b3R5cGUpLiBOT1RFOiBJZiB0aGlzIGZpbGUgaXMgdG8gYmUgbG9hZGVkXG4gKiBkdXJpbmcgYm9vdHN0cmFwcGluZyB0aGlzIGZ1bmN0aW9uIG5lZWRzIHRvIGJlIHJld3JpdHRlbiB1c2luZyBzb21lIG5hdGl2ZVxuICogZnVuY3Rpb25zIGFzIHByb3RvdHlwZSBzZXR1cCB1c2luZyBub3JtYWwgSmF2YVNjcmlwdCBkb2VzIG5vdCB3b3JrIGFzXG4gKiBleHBlY3RlZCBkdXJpbmcgYm9vdHN0cmFwcGluZyAoc2VlIG1pcnJvci5qcyBpbiByMTE0OTAzKS5cbiAqXG4gKiBAcGFyYW0ge2Z1bmN0aW9ufSBjdG9yIENvbnN0cnVjdG9yIGZ1bmN0aW9uIHdoaWNoIG5lZWRzIHRvIGluaGVyaXQgdGhlXG4gKiAgICAgcHJvdG90eXBlLlxuICogQHBhcmFtIHtmdW5jdGlvbn0gc3VwZXJDdG9yIENvbnN0cnVjdG9yIGZ1bmN0aW9uIHRvIGluaGVyaXQgcHJvdG90eXBlIGZyb20uXG4gKi9cbmV4cG9ydHMuaW5oZXJpdHMgPSByZXF1aXJlKCdpbmhlcml0cycpO1xuXG5leHBvcnRzLl9leHRlbmQgPSBmdW5jdGlvbihvcmlnaW4sIGFkZCkge1xuICAvLyBEb24ndCBkbyBhbnl0aGluZyBpZiBhZGQgaXNuJ3QgYW4gb2JqZWN0XG4gIGlmICghYWRkIHx8ICFpc09iamVjdChhZGQpKSByZXR1cm4gb3JpZ2luO1xuXG4gIHZhciBrZXlzID0gT2JqZWN0LmtleXMoYWRkKTtcbiAgdmFyIGkgPSBrZXlzLmxlbmd0aDtcbiAgd2hpbGUgKGktLSkge1xuICAgIG9yaWdpbltrZXlzW2ldXSA9IGFkZFtrZXlzW2ldXTtcbiAgfVxuICByZXR1cm4gb3JpZ2luO1xufTtcblxuZnVuY3Rpb24gaGFzT3duUHJvcGVydHkob2JqLCBwcm9wKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob2JqLCBwcm9wKTtcbn1cbiIsIi8qIGdsb2JhbCBkZXNjcmliZSBpdCAqL1xuY29uc3QgYXNzZXJ0ID0gcmVxdWlyZSgnYXNzZXJ0Jyk7XG5jb25zdCBkZXEgPSAoel9leHBlY3QsIHpfYWN0dWFsKSA9PiB7XG5cdGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoel9hY3R1YWwsIHpfZXhwZWN0KTtcbn07XG5jb25zdCBlcSA9ICh6X2V4cGVjdCwgel9hY3R1YWwpID0+IHtcblx0YXNzZXJ0LnN0cmljdEVxdWFsKHpfYWN0dWFsLCB6X2V4cGVjdCk7XG59O1xuY29uc3QgZnMgPSByZXF1aXJlKCdmcycpO1xuXG5jb25zdCB3b3JrZXIgPSByZXF1aXJlKCcuLi8uLi9idWlsZC9tYWluL21vZHVsZS5qcycpLnNjb3BpZnkocmVxdWlyZSwgKCkgPT4ge1xuXHRyZXF1aXJlKCcuL3dvcmtlcnMvYmFzaWMuanMnKTtcbn0sICd1bmRlZmluZWQnICE9PSB0eXBlb2YgYXJndW1lbnRzICYmIGFyZ3VtZW50cyk7XG5cbmNvbnN0IHNwYXduID0gKHNfbmFtZT0nYmFzaWMnKSA9PiB3b3JrZXIuc3Bhd24oYC4vd29ya2Vycy8ke3NfbmFtZX0uanNgKTtcbmNvbnN0IGdyb3VwID0gKG5fd29ya2Vycywgc19uYW1lPSdiYXNpYycpID0+IHdvcmtlci5ncm91cChgLi93b3JrZXJzLyR7c19uYW1lfS5qc2AsIG5fd29ya2Vycyk7XG5cbmNvbnN0IHJ1biA9IGFzeW5jICguLi5hX2FyZ3MpID0+IHtcblx0bGV0IGtfd29ya2VyID0gc3Bhd24oKTtcblx0bGV0IHpfcmVzdWx0ID0gYXdhaXQga193b3JrZXIucnVuKC4uLmFfYXJncyk7XG5cdGF3YWl0IGtfd29ya2VyLmtpbGwoKTtcblx0cmV0dXJuIHpfcmVzdWx0O1xufTtcblxuXG5kZXNjcmliZSgnd29ya2VyJywgKCkgPT4ge1xuXG5cdGl0KCdydW5zJywgYXN5bmMgKCkgPT4ge1xuXHRcdGVxKCd5ZWgnLCBhd2FpdCBydW4oJ3JldmVyc2Vfc3RyaW5nJywgWydoZXknXSkpO1xuXHR9KTtcblxuXHRpdCgndHdpY2UnLCBhc3luYyAoKSA9PiB7XG5cdFx0bGV0IGtfd29ya2VyID0gc3Bhd24oKTtcblx0XHRsZXQgc195ZWggPSBhd2FpdCBrX3dvcmtlci5ydW4oJ3JldmVyc2Vfc3RyaW5nJywgWydoZXknXSk7XG5cdFx0ZXEoJ2hleScsIGF3YWl0IHJ1bigncmV2ZXJzZV9zdHJpbmcnLCBbc195ZWhdKSk7XG5cdFx0YXdhaXQga193b3JrZXIua2lsbCgpO1xuXHR9KTtcblxuXHRpdCgndGVybWluYXRlcycsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBrX3dvcmtlciA9IHNwYXduKCk7XG5cdFx0a193b3JrZXIucnVuKCd3YWl0JywgW1s1MDAwXV0pXG5cdFx0XHQudGhlbigoKSA9PiBma2VfdGVzdCgnd29ya2VyIGRpZCBub3QgdGVybWluYXRlIGJlZm9yZSBmaW5pc2hpbmcgdGFzaycpKVxuXHRcdFx0LmNhdGNoKChlX3J1bikgPT4ge1xuXHRcdFx0XHRma2VfdGVzdChlX3J1bik7XG5cdFx0XHR9KTtcblx0XHRzZXRUaW1lb3V0KGFzeW5jICgpID0+IHtcblx0XHRcdGF3YWl0IGtfd29ya2VyLmtpbGwoKTtcblx0XHRcdGZrZV90ZXN0KCk7XG5cdFx0fSwgMTAwKTtcblx0fSk7XG5cblx0aXQoJ2NhdGNoZXMnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQga193b3JrZXIgPSBzcGF3bigpO1xuXHRcdGtfd29ya2VyLnJ1bignZmFpbCcpXG5cdFx0XHQudGhlbigoKSA9PiBma2VfdGVzdCgnZXJyb3Igbm90IGNhdWdodCBieSBtYXN0ZXInKSlcblx0XHRcdC5jYXRjaChhc3luYyAoZV9ydW4pID0+IHtcblx0XHRcdFx0YXNzZXJ0KGVfcnVuLm1lc3NhZ2UuaW5jbHVkZXMoJ25vIHN1Y2ggdGFzaycpKTtcblx0XHRcdFx0YXdhaXQga193b3JrZXIua2lsbCgpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdldmVudHMnLCBhc3luYyAoKSA9PiB7XG5cdFx0bGV0IGhfY29udm8gPSB7XG5cdFx0XHRncmVldDogJ2hpJyxcblx0XHRcdGNoYXQ6ICdob3cgciB1Jyxcblx0XHRcdHllbGw6ICdhaGghJyxcblx0XHRcdGFwb2xvZ2l6ZTogJ3NvcnJ5Jyxcblx0XHRcdGZvcmdpdmU6ICdtbWsnLFxuXHRcdFx0ZXhpdDogJ2tieWUnLFxuXHRcdH07XG5cblx0XHRsZXQgYV9kYXRhID0gW107XG5cdFx0bGV0IGhfcmVzcG9uc2VzID0ge307XG5cdFx0bGV0IGNfcmVzcG9uc2VzID0gMDtcblx0XHRPYmplY3Qua2V5cyhoX2NvbnZvKS5mb3JFYWNoKChzX2tleSwgaV9rZXkpID0+IHtcblx0XHRcdGFfZGF0YS5wdXNoKHtcblx0XHRcdFx0bmFtZTogc19rZXksXG5cdFx0XHRcdGRhdGE6IGhfY29udm9bc19rZXldLFxuXHRcdFx0XHR3YWl0OiBpX2tleT8gMTAwOiAwLFxuXHRcdFx0fSk7XG5cblx0XHRcdGhfcmVzcG9uc2VzW3Nfa2V5XSA9IChzX21zZykgPT4ge1xuXHRcdFx0XHRlcShoX2NvbnZvW3Nfa2V5XSwgc19tc2cpO1xuXHRcdFx0XHRjX3Jlc3BvbnNlcyArPSAxO1xuXHRcdFx0fTtcblx0XHR9KTtcblxuXHRcdGxldCBrX3dvcmtlciA9IHNwYXduKCk7XG5cdFx0YXdhaXQga193b3JrZXIucnVuKCdldmVudHMnLCBbYV9kYXRhXSwgaF9yZXNwb25zZXMpO1xuXHRcdGF3YWl0IGtfd29ya2VyLmtpbGwoKTtcblx0XHRlcShhX2RhdGEubGVuZ3RoLCBjX3Jlc3BvbnNlcyk7XG5cdH0pO1xuXG5cdGl0KCdzdG9yZScsIGFzeW5jICgpID0+IHtcblx0XHRsZXQga193b3JrZXIgPSBzcGF3bigpO1xuXHRcdGF3YWl0IGtfd29ya2VyLnJ1bignc3RvcmUnLCBbW3t0ZXN0Oid2YWx1ZSd9XV0pO1xuXHRcdGxldCBhX3ZhbHVlcyA9IGF3YWl0IGtfd29ya2VyLnJ1bignZmV0Y2gnLCBbWyd0ZXN0J11dKTtcblx0XHRhd2FpdCBrX3dvcmtlci5raWxsKCk7XG5cdFx0ZXEoJ3ZhbHVlJywgYV92YWx1ZXNbMF0pO1xuXHR9KTtcbn0pO1xuXG5cbmRlc2NyaWJlKCdncm91cCcsICgpID0+IHtcblxuXHRpdCgnbWFwL3RocnUnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQgYV9zZXEgPSBbOCwgMSwgNywgNCwgMywgNSwgMiwgNl07XG5cdFx0bGV0IGtfZ3JvdXAgPSBncm91cChhX3NlcS5sZW5ndGgpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKGFfc2VxKVxuXHRcdFx0Lm1hcCgnbXVsdGlwbHknLCBbMl0pXG5cdFx0XHQudGhydSgnYWRkJywgWzNdKVxuXHRcdFx0LmVhY2goKHhfbiwgaV9uKSA9PiB7XG5cdFx0XHRcdGVxKChhX3NlcVtpX25dKjIpKzMsIHhfblswXSk7XG5cdFx0XHR9LCBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdGF3YWl0IGtfZ3JvdXAua2lsbCgpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdtYXAvZWFjaCcsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBhX3NlcSA9IFs4LCAxLCA3LCA0LCAzLCA1LCAyLCA2XS5tYXAoeCA9PiB4KjEwMCk7XG5cdFx0bGV0IGtfZ3JvdXAgPSBncm91cChhX3NlcS5sZW5ndGgpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKGFfc2VxKVxuXHRcdFx0Lm1hcCgnd2FpdCcpXG5cdFx0XHQuZWFjaCgoeF9uLCBpX24pID0+IHtcblx0XHRcdFx0ZXEoYV9zZXFbaV9uXSwgeF9uKTtcblx0XHRcdH0sIGFzeW5jICgpID0+IHtcblx0XHRcdFx0YXdhaXQga19ncm91cC5raWxsKCk7XG5cdFx0XHRcdGZrZV90ZXN0KCk7XG5cdFx0XHR9KTtcblx0fSk7XG5cblx0aXQoJ21hcC9zZXJpZXMnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQgYV9zZXEgPSBbOCwgMSwgNywgNCwgMywgNSwgMiwgNl0ubWFwKHggPT4geCoxMDApO1xuXHRcdGxldCBhX3JlcyA9IFtdO1xuXHRcdGxldCBrX2dyb3VwID0gZ3JvdXAoYV9zZXEubGVuZ3RoKTtcblx0XHRrX2dyb3VwXG5cdFx0XHQuZGF0YShhX3NlcSlcblx0XHRcdC5tYXAoJ3dhaXQnKVxuXHRcdFx0LnNlcmllcygoeF9uKSA9PiB7XG5cdFx0XHRcdGFfcmVzLnB1c2goeF9uKTtcblx0XHRcdH0sIGFzeW5jICgpID0+IHtcblx0XHRcdFx0YXdhaXQga19ncm91cC5raWxsKCk7XG5cdFx0XHRcdGRlcShhX3NlcSwgYV9yZXMpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdtYXAvcmVkdWNlICM0JywgKGZrZV90ZXN0KSA9PiB7XG5cdFx0bGV0IHNfc3JjID0gJ2FiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6Jztcblx0XHRsZXQga19ncm91cCA9IGdyb3VwKDQpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKHNfc3JjLnNwbGl0KCcnKSlcblx0XHRcdC5tYXAoJ2NvbmNhdCcpXG5cdFx0XHQucmVkdWNlKCdtZXJnZV9jb25jYXQnKS50aGVuKGFzeW5jIChzX2ZpbmFsKSA9PiB7XG5cdFx0XHRcdGF3YWl0IGtfZ3JvdXAua2lsbCgpO1xuXHRcdFx0XHRlcShzX3NyYywgc19maW5hbCk7XG5cdFx0XHRcdGZrZV90ZXN0KCk7XG5cdFx0XHR9KTtcblx0fSk7XG5cblx0aXQoJ21hcC9yZWR1Y2UgIzgnLCAoZmtlX3Rlc3QpID0+IHtcblx0XHRsZXQgc19zcmMgPSAnYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXonO1xuXHRcdGxldCBrX2dyb3VwID0gZ3JvdXAoOCk7XG5cdFx0a19ncm91cFxuXHRcdFx0LmRhdGEoc19zcmMuc3BsaXQoJycpKVxuXHRcdFx0Lm1hcCgnY29uY2F0Jylcblx0XHRcdC5yZWR1Y2UoJ21lcmdlX2NvbmNhdCcpLnRoZW4oYXN5bmMgKHNfZmluYWwpID0+IHtcblx0XHRcdFx0YXdhaXQga19ncm91cC5raWxsKCk7XG5cdFx0XHRcdGVxKHNfc3JjLCBzX2ZpbmFsKTtcblx0XHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxuXHRpdCgnbWFwL3JlZHVjZSBlbXB0eScsIChma2VfdGVzdCkgPT4ge1xuXHRcdGxldCBrX2dyb3VwID0gZ3JvdXAoOCk7XG5cdFx0a19ncm91cFxuXHRcdFx0LmRhdGEoW10pXG5cdFx0XHQubWFwKCdjb25jYXQnKVxuXHRcdFx0LnJlZHVjZSgnbWVyZ2VfY29uY2F0JykudGhlbihhc3luYyAoc19maW5hbD1udWxsKSA9PiB7XG5cdFx0XHRcdGF3YWl0IGtfZ3JvdXAua2lsbCgpO1xuXHRcdFx0XHRlcShudWxsLCBzX2ZpbmFsKTtcblx0XHRcdFx0ZmtlX3Rlc3QoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxuXHRpdCgnZXZlbnRzJywgKGZrZV90ZXN0KSA9PiB7XG5cdFx0bGV0IGhfY29udm8gPSB7XG5cdFx0XHRncmVldDogJ2hpJyxcblx0XHRcdGNoYXQ6ICdob3cgciB1Jyxcblx0XHRcdHllbGw6ICdhaGghJyxcblx0XHRcdGFwb2xvZ2l6ZTogJ3NvcnJ5Jyxcblx0XHRcdGZvcmdpdmU6ICdtbWsnLFxuXHRcdFx0ZXhpdDogJ2tieWUnLFxuXHRcdH07XG5cblx0XHRsZXQgYV9kYXRhID0gW107XG5cdFx0bGV0IGhfcmVzcG9uc2VzID0ge307XG5cdFx0bGV0IGNfcmVzcG9uc2VzID0gMDtcblx0XHRPYmplY3Qua2V5cyhoX2NvbnZvKS5mb3JFYWNoKChzX2tleSwgaV9rZXkpID0+IHtcblx0XHRcdGFfZGF0YS5wdXNoKHtcblx0XHRcdFx0bmFtZTogc19rZXksXG5cdFx0XHRcdGRhdGE6IGhfY29udm9bc19rZXldLFxuXHRcdFx0XHR3YWl0OiBpX2tleT8gNTAwOiAwLFxuXHRcdFx0fSk7XG5cblx0XHRcdGhfcmVzcG9uc2VzW3Nfa2V5XSA9IChpX3N1YnNldCwgc19tc2cpID0+IHtcblx0XHRcdFx0ZXEoaF9jb252b1tzX2tleV0sIHNfbXNnKTtcblx0XHRcdFx0Y19yZXNwb25zZXMgKz0gMTtcblx0XHRcdH07XG5cdFx0fSk7XG5cblx0XHRsZXQga19ncm91cCA9IGdyb3VwKDMpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKGFfZGF0YSlcblx0XHRcdC5tYXAoJ2V2ZW50cycsIFtdLCBoX3Jlc3BvbnNlcylcblx0XHRcdC5lbmQoYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRhd2FpdCBrX2dyb3VwLmtpbGwoKTtcblx0XHRcdFx0ZXEoYV9kYXRhLmxlbmd0aCwgY19yZXNwb25zZXMpO1xuXHRcdFx0XHRma2VfdGVzdCgpO1xuXHRcdFx0fSk7XG5cdH0pO1xuXG5cdGl0KCdzdG9yZScsICgpID0+IHtcblx0XHRsZXQga19ncm91cCA9IGdyb3VwKDIpO1xuXHRcdGtfZ3JvdXBcblx0XHRcdC5kYXRhKFtbMTAwLCAwLCAwLCAwXV0pXG5cdFx0XHQubWFwKCdwYXNzJylcblx0XHRcdC8vIC50aHJ1KCdwYXNzJylcblx0XHRcdC5yZWR1Y2UoJ3N1bScpLnRoZW4oYXN5bmMgKGFfdikgPT4ge1xuXHRcdFx0XHRhd2FpdCBrX2dyb3VwLmtpbGwoKTtcblx0XHRcdH0pO1xuXHR9KTtcblxufSk7XG5cblxuZGVzY3JpYmUoJ2F1eCcsICgpID0+IHtcblxuXHRpZighd29ya2VyLmJyb3dzZXIpIHtcblx0XHRpdCgndHJhbnNmZXJzJywgYXN5bmMgKCkgPT4ge1xuXHRcdFx0bGV0IGttX2FyZ3MgPSB3b3JrZXIubWFuaWZlc3QoW2ZzLnJlYWRGaWxlU3luYygnLi9wYWNrYWdlLmpzb24nKV0pO1xuXHRcdFx0bGV0IG5fbGVuZ3RoID0gYXdhaXQgcnVuKCdjb3VudCcsIGttX2FyZ3MpO1xuXG5cdFx0XHRhc3NlcnQobl9sZW5ndGggPiAwKTtcblx0XHR9KTtcblx0fVxuXG5cdGl0KCd0eXBlZC1hcnJheScsIGFzeW5jICgpID0+IHtcblx0XHRsZXQgYXRfdGVzdCA9IG5ldyBVaW50OEFycmF5KDEwKTtcblx0XHRhdF90ZXN0WzBdID0gNztcblx0XHRhdF90ZXN0WzFdID0gNTtcblx0XHRsZXQga21fYXJncyA9IHdvcmtlci5tYW5pZmVzdChbYXRfdGVzdCwgMV0pO1xuXHRcdGxldCBuX2F0ID0gYXdhaXQgcnVuKCdhdCcsIGttX2FyZ3MpO1xuXHRcdGVxKDUsIG5fYXQpO1xuXHR9KTtcblxuXHQvLyBpdCgnc3RyZWFtcycsIGFzeW5jICgpID0+IHtcblx0Ly8gXHRsZXQgZHNfd29yZHMgPSBmcy5jcmVhdGVSZWFkU3RyZWFtKCcvdXNyL3NoYXJlL2RpY3Qvd29yZHMnLCAndXRmOCcpO1xuXHQvLyBcdGxldCBuX25ld2xpbmVzID0gYXdhaXQgcnVuKCdjb3VudF9zdHInLCBbZHNfd29yZHMsICdcXG4nXSk7XG5cdC8vIFx0Y29uc29sZS5sb2cobl9uZXdsaW5lcyk7XG5cdC8vIFx0Ly8gZXEoJ3dvcmtlcicsIHNfcGFja2FnZV9uYW1lKTtcblx0Ly8gfSk7XG59KTtcblxuXG4vKiBUT0RPOlxuXG4gLSBhd2FpdCBncm91cCNlbmRcbiAtIGF3YWl0IGdyb3VwI3J1blxuIC0gZXZlbnQgZW1pdHRlcnNcbiAtIGNoYW5uZWwgbWVzc2FnaW5nXG5cbltub2RlLmpzXVxuIC0gY2hhbm5lbCBzb2NrZXQgZmlsZSB1bmxpbmtpbmcgKGluY2x1ZGluZyBvbiBhYnJ1YnQgZXhpdClcblxuXG4qL1xuXG5cbiIsImNvbnN0IHdvcmtlciA9IHJlcXVpcmUoJy4uLy4uLy4uL2J1aWxkL21haW4vbW9kdWxlLmpzJyk7XG5cbndvcmtlci5kZWRpY2F0ZWQoe1xuXHRyZXZlcnNlX3N0cmluZzogcyA9PiBzLnNwbGl0KCcnKS5yZXZlcnNlKCkuam9pbignJyksXG5cblx0YXQ6IChhLCBpKSA9PiBhW2ldLFxuXG5cdHdhaXQ6IChhX3dhaXQpID0+IG5ldyBQcm9taXNlKChmX3Jlc29sdmUpID0+IHtcblx0XHRsZXQgdF93YWl0ID0gYV93YWl0WzBdO1xuXG5cdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRmX3Jlc29sdmUodF93YWl0KTtcblx0XHR9LCB0X3dhaXQpO1xuXHR9KSxcblxuXHRjb25jYXQ6IGEgPT4gYS5qb2luKCcnKSxcblxuXHRtZXJnZV9jb25jYXQ6IChzX2EsIHNfYikgPT4gc19hICsgc19iLFxuXG5cdGV2ZW50cyhhX2V2dHMpIHtcblx0XHRyZXR1cm4gUHJvbWlzZS5hbGwoXG5cdFx0XHRhX2V2dHMubWFwKChoX2V2dCkgPT4gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSwgZl9yZWplY3QpID0+IHtcblx0XHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0dGhpcy5lbWl0KGhfZXZ0Lm5hbWUsIGhfZXZ0LmRhdGEpO1xuXHRcdFx0XHRcdGZfcmVzb2x2ZSgpO1xuXHRcdFx0XHR9LCBoX2V2dC53YWl0ICsgNjAwKTtcblx0XHRcdH0pKVxuXHRcdCk7XG5cdH0sXG5cblx0c3RvcmUoYV9zdG9yZSkge1xuXHRcdGFfc3RvcmUuZm9yRWFjaCgoaF9zdG9yZSkgPT4ge1xuXHRcdFx0Zm9yKGxldCBzX2tleSBpbiBoX3N0b3JlKSB7XG5cdFx0XHRcdHRoaXMucHV0KHNfa2V5LCBoX3N0b3JlW3Nfa2V5XSk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cdH0sXG5cblx0ZmV0Y2goYV9rZXlzKSB7XG5cdFx0cmV0dXJuIGFfa2V5cy5tYXAoc19rZXkgPT4gdGhpcy5nZXQoc19rZXkpKTtcblx0fSxcblxuXHRwYXNzKGFfd2FpdCkge1xuXHRcdHJldHVybiBQcm9taXNlLmFsbChhX3dhaXQubWFwKHhfd2FpdCA9PiBuZXcgUHJvbWlzZSgoZl9yZXNvbHZlLCBmX3JlamVjdCkgPT4ge1xuXHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdGxldCBjX3ZhbCA9ICh0aGlzLmdldCgnZGlnJykgfHwgMCkgKyAxO1xuXHRcdFx0XHR0aGlzLnB1dCgnZGlnJywgY192YWwpO1xuXHRcdFx0XHRmX3Jlc29sdmUoY192YWwpO1xuXHRcdFx0fSwgeF93YWl0KTtcblx0XHR9KSkpO1xuXHR9LFxuXG5cdG11bHRpcGx5OiAoYSwgeF9tdWx0aXBsaWVyKSA9PiBhLm1hcCh4ID0+IHggKiB4X211bHRpcGxpZXIpLFxuXG5cdGFkZDogKGEsIHhfYWRkKSA9PiBhLm1hcCh4ID0+IHggKyB4X2FkZCksXG5cblx0Ly8gc3VtOiAoeF9hLCB4X2IpID0+IHhfYSArIHhfYixcblxuXHRzdW06IChhX2EsIGFfYikgPT4gW2FfYS5yZWR1Y2UoKGMsIHgpID0+IGMgKyB4LCAwKSArIGFfYi5yZWR1Y2UoKGMsIHgpID0+IGMgKyB4LCAwKV0sXG5cblx0Y291bnQ6IChhKSA9PiBhLnJlZHVjZSgoYywgeCkgPT4gYyArIHgsIDApLFxuXG5cdGNvdW50X3N0cihkc19pbnB1dCwgc19zdHIpIHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKGZfcmVzb2x2ZSwgZl9yZWplY3QpID0+IHtcblx0XHRcdGxldCBjX29jY3VycmVuY2VzID0gMDtcblx0XHRcdGRzX2lucHV0Lm9uKCdkYXRhJywgKHNfY2h1bmspID0+IHtcblx0XHRcdFx0Y29uc29sZS5sb2coJ29jY3VycmVuY2VzOiAnK2Nfb2NjdXJyZW5jZXMpO1xuXHRcdFx0XHRjX29jY3VycmVuY2VzICs9IHNfY2h1bmsuc3BsaXQoc19zdHIpLmxlbmd0aCAtIDE7XG5cdFx0XHR9KTtcblxuXHRcdFx0ZHNfaW5wdXQub24oJ2VuZCcsICgpID0+IHtcblx0XHRcdFx0Y29uc29sZS5sb2coJ2VuZCcpO1xuXHRcdFx0XHRmX3Jlc29sdmUoY19vY2N1cnJlbmNlcyk7XG5cdFx0XHR9KTtcblxuXHRcdFx0ZHNfaW5wdXQub24oJ2Vycm9yJywgKGVfc3RyZWFtKSA9PiB7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoZV9zdHJlYW0pO1xuXHRcdFx0XHRmX3JlamVjdChlX3N0cmVhbSk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblx0fSxcblxuXHR3cml0ZShkc19vdXQsIGFfcmFuZ2UpIHtcblx0XHRmb3IobGV0IGk9YV9yYW5nZVswXTsgaTxhX3JhbmdlWzFdOyBpKyspIHtcblx0XHRcdGRzX291dC53cml0ZShpKydcXG4nKTtcblx0XHR9XG5cdH0sXG59KTtcbiJdfQ==
