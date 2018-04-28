

const pd_build = 'build';
const pd_build_main = `${pd_build}/main`;

const s_self_dir = '$(dirname $@)';

module.exports = {
	all: 'main',

	main: [
		`${pd_build_main}/module.js`,

		...[
			'dedicated',
			'group',
			'locals',
			'lockable',
			'manifest',
			'pool',
			'result',
			'writable-stream',
		].map(s => `${pd_build_main}/all/${s}.js`),

		...[
			'channel',
			'events',
			'latent-subworker',
			'locals',
			'ports',
			'self',
			'sharing',
			'stream',
			'worker',
		].map(s => `${pd_build_main}/browser/${s}.js`),

		...[
			'channel',
			'ipc',
			'locals',
			'self',
			'sharing',
			'stream',
			'worker',
		].map(s => `${pd_build_main}/node/${s}.js`),

		...[
			'browser',
			'node',
		].map(s => `${pd_build_main}/${s}/typed-arrays.js`),

		`${pd_build_main}/typed-arrays.js`,
	],

	test: {
		deps: [
			'test/main/bundle.js',
		],
		run: /* syntax: bash */ `
			mocha test/main/module.js
		`,
	},

	'test/main/bundle.js': {
		deps: [
			'test/main/module.js',
			'main',
		],
		run: /* syntax: bash */ `
			browserify $1 -d -o $@
		`,
	},

	[`${pd_build_main}/typed-arrays.js`]: {
		case: true,
		deps: [
			'src/main/typed-arrays.js.jmacs',
			s_self_dir,
		],
		run: /* syntax: bash */ `
			jmacs $1 > $@
			eslint --fix --rule 'no-debugger: off' --quiet $@
		`,
	},

	[`${pd_build_main}/:file.js`]: {
		case: true,
		deps: [
			'src/main/$file.js',
			s_self_dir,
		],
		run: /* syntax: bash */ `
			cp $1 $@
		`,
	},

	[`${pd_build_main}/:dir`]: {
		case: true,
		run: /* syntax: bash */ `
			mkdir -p $@
		`,
	},

	// build dir
	[`${pd_build_main}`]: {
		case: true,
		run: /* syntax: bash */ `
			mkdir -p $@
		`,
	},

	[`${pd_build_main}/:sub/typed-arrays.js`]: {
		case: true,
		deps: [
			'src/main/$sub/typed-arrays.js.jmacs',
			'src/main/typed-arrays.js.jmacs',
			s_self_dir,
		],
		run: /* syntax: bash */ `
			jmacs $1 > $@
			eslint --fix --rule 'no-debugger: off' --quiet $@
		`,
	},

	[`${pd_build_main}/:sub/:file.js`]: {
		case: true,
		deps: [
			'src/main/$sub/$file.js',
			s_self_dir,
		],
		run: /* syntax: bash */ `
			cp $1 $@
		`,
	},

};
