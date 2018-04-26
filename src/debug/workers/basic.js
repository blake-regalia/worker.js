const worker = require('../../../dist/main/module.js');


worker.dedicated({
	concat: a => a.join(''),

	merge_concat: (s_a, s_b) => s_a + s_b,

	wait(x_wait) {
		return new Promise((f_resolve) => {
			setTimeout(() => {
				f_resolve(x_wait[0]);
			}, x_wait);
		});
	},

	multiply: (a_nums, x_mult) => a_nums.map(x_num => x_num * x_mult),

	add: (a_nums, x_add) => a_nums.map(x_num => x_num + x_add),

	sum: (a_a, a_b) => [a_a.reduce((c, x) => c + x, 0) + a_b.reduce((c, x) => c + x, 0)],

	put(s_val) {
		this.put('test', s_val);
	},

	get() {
		return this.get('test');
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

	events(a_evts) {
		return Promise.all(
			a_evts.map((h_evt) => new Promise((f_resolve, f_reject) => {
				this.emit(h_evt.name, h_evt.data);
				setTimeout(() => {
					f_resolve();
				}, h_evt.wait + 2400);
			}))
		);
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

});
