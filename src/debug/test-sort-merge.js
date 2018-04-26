const fs = require('fs');
const worker = require('../../dist/main/module.js');

// load a few hundred thousand words into an array
let a_words = fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n');

console.time('supersort');

// create a group of workers (defaults to os.cpus().length)
let k_group = worker.group('./workers/sort-merge.js', 2);

// processing pipeline
k_group
	// .data(['apple', 'banana', 'carrot', 'date', 'eggplant', 'mandarin', 'nectarine', 'orange', 'peach'])
	.data(a_words)

	// reverse each word; divide array evenly among workers
	.map('reverse_letters')

	// .each((a_reversed) => {
	// 	debugger;
	// 	console.info(a_reversed);
	// })

	// as soon as each worker finishes previous task, forward its result
	//   to a new task in the same thread
	.thru('sort')

	// .each((a_list) => {
	// 	console.log('sorted: ', a_list.slice(0, 10));
	// })

	// reduce multiple results into a single one
	.reduce('merge').then((a_sorted_words_reversed) => {
		fs.writeFile('out', a_sorted_words_reversed.join('\n'), (e_write) => {
			if(e_write) throw new Error(e_write);

			console.timeEnd('supersort');

			console.log('done');
		});
	});

// fs.createReadStream()
// 	.pipe(k_group.stream()
// 		.map('reverse_letters')
// 		.thru('sort')
// 		.reduce('merge', () => {

// 		})
// 	);
