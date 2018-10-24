const fs = require('fs');

const js_file = s => s.endsWith('.js');

module.exports = {
	defs: {
		iso: ['browser', 'node'],

		js_file: [
			...fs.readdirSync('src/main').filter(js_file),
			...fs.readdirSync('src/main/all').filter(js_file).map(s => `all/${s}`),
			...fs.readdirSync('src/main/browser').filter(js_file).map(s => `browser/${s}`),
			...fs.readdirSync('src/main/node').filter(js_file).map(s => `node/${s}`),
		],
	},

	tasks: {
		all: 'build/**',

		test: () => ({
			deps: [
				'test/main/bundle.js',
			],

			run: /* syntax: bash */ `
				mocha test/main/module.js
			`,
		}),
	},

	outputs: {
		build: {
			main: {
				':js_file': h => ({
					copy: `src/main/${h.js_file}`,
				}),

				':iso': [s_iso => ({
					[s_iso]: {
						'typed-arrays.js': () => ({
							deps: [
								`src/main/${s_iso}/typed-arrays.js.jmacs`,
								'src/main/typed-arrays.js.jmacs',
							],

							run: /* syntax: bash */ `
								jmacs $1 > $@ \
								 && eslint --fix --rule 'no-debugger: off' --color $@
							`,
						}),
					},
				})],
			},
		},

		test: {
			main: {
				'bundle.js': () => ({
					deps: [
						'test/main/module.js',
					],

					run: /* syntax: bash */ `
						browserify $1 -d -o $@
					`,
				}),
			},
		},
	},
};
