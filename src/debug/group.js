const assert = require('assert');
const worker = require('../../dist/main/module.js');

// let k_group = worker.group('./workers/basic.js', 4);

// let s_src = 'abcdefghijklmnopqrstuvwxyz';
// k_group
// 	.data(s_src.split(''))
// 	.map('concat')
// 	.reduce('merge_concat', async (s_res) => {
// 		assert.strictEqual(s_res, s_src);

// 		await k_group.kill();
// 		console.log('dead');
// 	});

let a_seq = [8, 1, 7, 4, 3, 5, 2, 6].map(x => x*100);
let a_res = [];
let k_group = worker.group('./workers/basic.js', a_seq.length);

// k_group
// 	.data(a_seq)
// 	.map('wait')
// 	.sequence((x_n) => {
// 		console.log(x_n);
// 		a_res.push(x_n);
// 	}, () => {
// 		debugger;
// 		console.log('done');
// 		k_group.kill();
// 	});

k_group
	.data([[100, 0, 0, 0]])
	.map('pass')
	.thru('pass')
	.reduce('sum', (a_v) => {
		console.dir(a_v);
		k_group.kill();
	});
