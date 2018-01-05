@include '../std.jmacs'

const {
	N_CORES,
} = require('./locals.js');

module.exports = class pool {
	constructor(p_source, n_workers=N_CORES, h_worker_options={}) {
		// no worker count given; default to number of cores
		if(!n_workers) n_workers = N_CORES;

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
			catch(e_run) {
				return f_reject(e_run);
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
