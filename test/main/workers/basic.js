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
