const fs = require('fs');

// load a few hundred thousand words into an array
let a_words = fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n');

console.time('sort-reverse');

let a_sorted_words_reversed = a_words
	.map(s => s.split('').reverse().join(''))
	.sort((s_a, s_b) => s_a.localeCompare(s_b));

fs.writeFile('out', a_sorted_words_reversed.join('\n'), (e_write) => {
	if(e_write) throw new Error(e_write);

	console.timeEnd('sort-reverse');

	console.log('done');
});
