const worker = require('../../../dist/main/module.js');

const F_SORT_ALPHABETICAL = (s_a, s_b) => s_a.localeCompare(s_b);

worker.dedicated({
	// take a list of words and reverse the letters in each word
	reverse_letters(a_list) {
		return a_list.map(s => s.split('').reverse().join(''));
	},

	// take a list of words and sort them alphabetically
	sort(a_list) {
		return a_list.sort(F_SORT_ALPHABETICAL);
	},

	// take two lists of sorted words and merge in sorted order
	merge(a_list_a, a_list_b) {
		return worker.merge_sorted(a_list_a, a_list_b, F_SORT_ALPHABETICAL);
	},
});
