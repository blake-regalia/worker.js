const fs = require('fs');

const worker = require('../../dist/main/module.js');

/* global Uint8ArrayT */
worker.import(global);

let k_group = worker.group('./workers/data.js');

// load a few hundred thousand words into an array
let db_data = fs.readFileSync('/usr/share/dict/words');

// debugger;
console.time('data');
let at_data = new Uint8ArrayT(db_data);
// let at_data = new Uint8Array(db_data);

// let x_average = 0;

let k_worker = worker.spawn('./workers/data.js');

k_worker.run('average', worker.manifest([at_data]))
	.then((x_average) => {
		console.timeEnd('data');
		console.log(x_average);
	});


// k_group
// 	.data(at_data)
// 	.map('average')
// 	.each((x_result) => {
// 		x_average += x_result;
// 	}, () => {
// 		console.log('average: '+x_average);
// 	});
