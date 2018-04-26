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


