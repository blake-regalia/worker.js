@include '../std.jmacs'

const {
	N_CORES,
} = require('./locals.js');

let worker;

class pool {
	constructor(p_source, ...a_args) {
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

	async summon() {
		let a_workers = this.workers;

		// each worker
		@{each('a_workers')} {
			let k_worker = a_workers[i_worker];

			// worker not busy
			if(!k_worker.busy) {
				return k_worker;
			}
		}

		// room to grow
		if(a_workers.length < this.limit) {
			// create new worker
			let k_worker = new worker({
				source: this.source,
				id: a_workers.length,
				master: this,
				options: this.options,
			});

			// add to pool
			a_workers.push(k_worker);

			// pretend its not available for synced mapping of run
			k_worker.busy = true;

			// it's actually available though ;)
			return k_worker;
		}

		// queue for notification when workers become available
		return new Promise((fk_worker) => {
			this.wait_list.push((k_worker) => {
				fk_worker(k_worker); 
			});
		});
	}
};

module.exports = function(dc_worker) {
	worker = dc_worker;
	return pool;
};

