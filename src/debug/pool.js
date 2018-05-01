const worker = require('../../build/main/module.js');

let k_pool = worker.pool('./workers/basic.js', 4);

for()
k_pool
	.data([[100, 0, 0, 0]])
	.map('pass')
	.thru('pass')
	.reduce('sum', (a_v) => {
		console.dir(a_v);
		k_group.kill();
	});
