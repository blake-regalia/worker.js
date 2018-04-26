const fs = require('fs');
const assert = require('assert');
const worker = require('../../dist/main/module.js');

// load a few hundred thousand words into an array
let a_words = fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n');

// // create a group of workers (defaults to os.cpus().length)
// let k_worker = worker.spawn('./workers/sort-merge.js');

let f_run = async () => {
	// processing pipeline
	let a_reversed = await k_worker
		// reverse each word; divide array evenly among workers
		.run('reverse_letters', [['hey', 'you', 'mister']])
		.catch((e_run) => {
			throw new Error(e_run);
		});

	console.log(a_reversed);

	let a_normal = await k_worker.run('reverse_letters', [a_reversed]);

	console.log(a_normal);
};

// f_run();

let k_worker = worker.spawn('./workers/basic.js');

let f_store = async () => {
	// await k_worker.run('put', ['test!']);
	// let s_res = await k_worker.run('get');
	// console.log(s_res);

	await k_worker.run('store', [[{test:'value'}]]);
	assert.strictEqual('value', (await k_worker.run('fetch', [['test']]))[0]);
	console.log('k');
};

// f_store();


let f_events = async () => {
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
			assert.strictEqual(h_convo[s_key], s_msg);
			c_responses += 1;
		};
	});

	await k_worker.run('events', [a_data], h_responses);
	assert.strictEqual(a_data.length, c_responses);
	// await k_worker.run('events', [])
};

// f_events();

let a_sequence = [1, 2, 3, 4];
worker.group('./workers/basic.js').data([])
	.map('multiply', [2])
	.thru('add', [1])
	.reduce('sum').then((x_actual) => {
		debugger;
		console.log(x_actual);
		let x_expect = a_sequence.map(x => x*2+1).reduce((c, x) => c + x, 0);
		assert.equal(x_actual, x_expect);
	});
